import type { Pool, PoolClient } from 'pg';
import { decision, validateDecision, type Decision } from '../../contracts/decision.js';
import { hasOnboarded, type IdentityState } from '../identity/onboarding.js';
import { type WorkHandler, PermanentWorkError } from './runner.js';
import { ModelAdapter, ModelError, type ValidatedPlan } from './model.js';
import { LeaseLostError, type WorkLease, type WorkTransition } from './leases.js';
import { hashText, SCHEMA_VERSION } from './prompt.js';
import { UsageService } from '../usage/service.js';

interface Context extends IdentityState {
  id: string;
  timezone: string;
  consent_at: Date;
  timezone_confirmed_at: Date;
  message: string;
  received_at: Date;
  db_now: Date;
}
export interface StoredPlan {
  event_id: string;
  user_id: string;
  version: number;
  schema_version: string;
  decision: Decision;
}
type Prepared =
  | { kind: 'blocked' }
  | { kind: 'existing' }
  | { kind: 'new'; context: Context; plan: ValidatedPlan };

export function actionKey(plan: StoredPlan, index: number): string {
  const call = plan.decision.calls[index];
  if (!Number.isInteger(index) || !call) throw new Error('Invalid action index');
  return hashText(JSON.stringify([plan.event_id, plan.version, index, call.tool]));
}

export class PlanProcessor implements WorkHandler<Prepared> {
  private readonly usage: UsageService;
  constructor(
    private readonly pool: Pool,
    private readonly adapter: ModelAdapter,
  ) {
    this.usage = new UsageService(pool);
  }

  private async context(
    db: Pool | PoolClient,
    eventId: string,
    lock = false,
  ): Promise<Context | null> {
    const result = await db.query(
      `SELECT u.*,e.payload->'text'->>'body' AS message,e.received_at,clock_timestamp() AS db_now
      FROM users u JOIN identity_results r ON r.user_id=u.id JOIN ingress_events e ON e.id=r.event_id
      WHERE r.event_id=$1 AND r.disposition='ready' AND e.payload->>'type'='text'
        AND r.consent_grant_at=u.consent_at AND r.timezone_confirmed_at=u.timezone_confirmed_at
      ${lock ? 'FOR UPDATE OF u' : ''}`,
      [eventId],
    );
    const row = result.rows[0] as Context | undefined;
    return row && hasOnboarded(row) && typeof row.message === 'string' ? row : null;
  }

  async read(eventId: string, db: Pool | PoolClient = this.pool): Promise<StoredPlan | null> {
    const row = (await db.query('SELECT * FROM action_plans WHERE event_id=$1', [eventId])).rows[0];
    if (!row) return null;
    if (row.schema_version !== SCHEMA_VERSION || row.version !== 1)
      throw new PermanentWorkError('Unsupported persisted plan version');
    // Do not regenerate old reminders because time has advanced; execution rechecks due time.
    return { ...row, decision: decision.parse(row.decision) };
  }

  async prepare(lease: WorkLease, signal: AbortSignal): Promise<Prepared> {
    if (lease.stage !== 'action') throw new PermanentWorkError('Planning requires action stage');
    if (signal.aborted) throw new LeaseLostError();
    const live = await this.pool.query(
      `SELECT id FROM work_outbox WHERE id=$1 AND lease_token=$2
      AND status='leased' AND lease_until>clock_timestamp()`,
      [lease.id, lease.lease_token],
    );
    if (!live.rowCount) throw new LeaseLostError();
    const context = await this.context(this.pool, lease.event_id);
    if (!context) return { kind: 'blocked' };
    if (await this.read(lease.event_id)) return { kind: 'existing' };
    try {
      const plan = await this.adapter.plan(
        {
          message: context.message,
          timezone: context.timezone,
          referenceTime: context.received_at,
          processingTime: context.db_now,
        },
        signal,
        (transport, request) => this.usage.generate(lease, context.id, transport, request),
      );
      return { kind: 'new', context, plan };
    } catch (error) {
      if (error instanceof ModelError && ['refused', 'rejected', 'too_large'].includes(error.code))
        throw new PermanentWorkError(error.message);
      throw error;
    }
  }

  async apply(client: PoolClient, lease: WorkLease, prepared: Prepared): Promise<WorkTransition> {
    // The work row is already locked by WorkQueue.commit; serialize consent changes on the user row.
    const current = await this.context(client, lease.event_id, true);
    if (!current || prepared.kind === 'blocked') return { nextStage: null };
    if (await this.read(lease.event_id, client)) return { nextStage: 'execution' };
    if (prepared.kind !== 'new') throw new PermanentWorkError('Persisted plan missing');
    const { context, plan } = prepared;
    if (
      context.consent_at.getTime() !== current.consent_at.getTime() ||
      context.timezone_confirmed_at.getTime() !== current.timezone_confirmed_at.getTime() ||
      context.timezone !== current.timezone
    )
      return { nextStage: null };
    // Validate against database time again: a slow model cannot save an already-expired reminder.
    const validated = validateDecision(plan.decision, current.db_now);
    await client.query(
      `INSERT INTO action_plans(event_id,user_id,version,schema_version,decision,provider,model,
      prompt_version,prompt_sha256,input_sha256,provider_response_id,input_tokens,output_tokens,latency_ms,
      reference_at,validated_at,consent_grant_at,timezone_confirmed_at,timezone)
      VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        lease.event_id,
        current.id,
        SCHEMA_VERSION,
        validated,
        plan.provider,
        plan.model,
        plan.promptVersion,
        plan.promptHash,
        plan.inputHash,
        plan.responseId,
        plan.inputTokens,
        plan.outputTokens,
        plan.latencyMs,
        context.received_at,
        current.db_now,
        current.consent_at,
        current.timezone_confirmed_at,
        current.timezone,
      ],
    );
    return { nextStage: 'execution' };
  }
}
