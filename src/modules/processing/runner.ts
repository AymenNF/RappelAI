import { setTimeout } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import {
  WorkQueue,
  LeaseLostError,
  type WorkLease,
  type WorkStage,
  type WorkTransition,
} from './leases.js';

export class PermanentWorkError extends Error {}
export interface WorkHandler<T> {
  prepare(lease: WorkLease, signal: AbortSignal): Promise<T>;
  apply(client: PoolClient, lease: WorkLease, prepared: T): Promise<WorkTransition>;
}

export class WorkRunner {
  constructor(
    private readonly queue: WorkQueue,
    private readonly owner: string,
    private readonly leaseMs = 30000,
  ) {}

  async runOne<T>(
    stage: WorkStage,
    handler: WorkHandler<T>,
    shutdown?: AbortSignal,
  ): Promise<boolean> {
    if (shutdown?.aborted) return false;
    const lease = await this.queue.claim(stage, this.owner, this.leaseMs);
    if (!lease) return false;
    const cancellation = new AbortController();
    const heartbeatStop = new AbortController();
    let lost = false;
    const cancel = () => cancellation.abort();
    shutdown?.addEventListener('abort', cancel, { once: true });
    if (shutdown?.aborted) cancel();
    const heartbeat = (async () => {
      while (!heartbeatStop.signal.aborted) {
        try {
          await setTimeout(Math.floor(this.leaseMs / 3), undefined, {
            signal: heartbeatStop.signal,
          });
          if (heartbeatStop.signal.aborted) break;
          if (!(await this.queue.renew(lease, this.leaseMs))) {
            lost = true;
            cancel();
            break;
          }
        } catch {
          if (!heartbeatStop.signal.aborted) {
            lost = true;
            cancel();
          }
          break;
        }
      }
    })();
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new LeaseLostError());
        cancellation.signal.addEventListener('abort', abortListener, { once: true });
        if (cancellation.signal.aborted) abortListener();
      });
      const preparation = Promise.resolve().then(() => {
        if (cancellation.signal.aborted) throw new LeaseLostError();
        return handler.prepare(lease, cancellation.signal);
      });
      const prepared = await Promise.race([preparation, aborted]);
      if (cancellation.signal.aborted || lost) throw new LeaseLostError();
      // Stop/await heartbeat before the final short transaction to avoid self-contention.
      heartbeatStop.abort();
      await heartbeat;
      if (cancellation.signal.aborted || lost) throw new LeaseLostError();
      await this.queue.commit(lease, async (client) => {
        if (cancellation.signal.aborted) throw new LeaseLostError();
        const result = await handler.apply(client, lease, prepared);
        if (cancellation.signal.aborted) throw new LeaseLostError();
        return result;
      });
    } catch (error) {
      // Token/expiry checks make this a no-op if another worker has taken over.
      if (!lost)
        await this.queue.fail(
          lease,
          shutdown?.aborted
            ? 'shutdown'
            : error instanceof PermanentWorkError
              ? 'permanent_failure'
              : 'handler_failed',
          shutdown?.aborted ? 0 : undefined,
        );
    } finally {
      heartbeatStop.abort();
      await heartbeat;
      shutdown?.removeEventListener('abort', cancel);
      if (abortListener) cancellation.signal.removeEventListener('abort', abortListener);
    }
    return true;
  }
}
