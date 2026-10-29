import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

const metrics = {
  api: [
    'requests',
    'success',
    'client_error',
    'server_error',
    'overload',
    'latency_50',
    'latency_200',
    'latency_1000',
    'latency_slow',
  ],
  worker: [
    'cycles',
    'cycle_failed',
    'work_recovered',
    'delivery_recovered',
    'usage_recovered',
    'work_cancelled',
  ],
} as const;
export type Component = keyof typeof metrics;
export type TelemetryBatch = { id: string; component: Component; counts: Record<string, number> };
export type TelemetrySink = (batch: TelemetryBatch) => Promise<void>;
export const databaseSink =
  (pool: Pool): TelemetrySink =>
  async (batch) => {
    await pool.query('SELECT record_telemetry($1,$2,$3)', [
      batch.component,
      batch.id,
      batch.counts,
    ]);
  };

/** Fixed-size, best-effort buffer. A failed/ambiguous flush retries the same idempotency key. */
export class RuntimeTelemetry {
  private counts: Record<string, number> = {};
  private pending: TelemetryBatch | undefined;
  private running: Promise<boolean> | undefined;
  constructor(
    readonly component: Component,
    private readonly sink: TelemetrySink,
  ) {}
  add(metric: string, value = 1) {
    if (
      !(metrics[this.component] as readonly string[]).includes(metric) ||
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 1_000_000_000
    )
      throw new Error('Invalid telemetry counter');
    // Saturation bounds even prolonged database outages; telemetry is not an accounting ledger.
    this.counts[metric] = Math.min(1_000_000_000, (this.counts[metric] ?? 0) + value);
  }
  http(status: number, elapsedMs: number) {
    if (this.component !== 'api' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.add('requests');
    this.add(status >= 500 ? 'server_error' : status >= 400 ? 'client_error' : 'success');
    if (status === 429) this.add('overload');
    this.add(
      elapsedMs <= 50
        ? 'latency_50'
        : elapsedMs <= 200
          ? 'latency_200'
          : elapsedMs <= 1000
            ? 'latency_1000'
            : 'latency_slow',
    );
  }
  flush(): Promise<boolean> {
    if (this.running) return this.running;
    this.pending ??= { id: randomUUID(), component: this.component, counts: this.counts };
    if (this.pending.counts === this.counts) this.counts = {};
    const batch = this.pending;
    this.running = Promise.resolve()
      .then(() => this.sink(batch))
      .then(
        () => {
          this.pending = undefined;
          return true;
        },
        () => false,
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
}
