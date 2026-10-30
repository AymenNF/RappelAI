import { consumeQuota } from '../quotas/service.js';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { CONSENT_VERSION } from '../identity/onboarding.js';
import { LeaseLostError, type WorkLease } from '../processing/leases.js';
import { DeferredWorkError } from '../processing/runner.js';
import { ModelError, type ModelRequest, type ModelTransport } from '../processing/model.js';
import { tokenCost } from './money.js';
import { assertUsageOperator } from './control.js';

interface Reservation {
  id: string;
  work_id: string;
  event_id: string;
  user_id: string;
  lease_token: string;
  period: string;
  provider: string;
  model: string;
  rate_version: string;
  input_rate: string;
  output_rate: string;
  max_input_tokens: number;
  max_output_tokens: number;
  reserved_micros: string;
  actual_micros: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  state: string;
}
const usage = z.object({
  model: z.string(),
  inputTokens: z.number().int().min(0).max(2147483647),
  outputTokens: z.number().int().min(0).max(2147483647),
});
interface Policy {
  enabled: boolean;
  global_monthly_micros: string;
  default_user_monthly_micros: string;
}

export class UsageService {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(
    operation: (client: PoolClient, policy: Policy) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtextextended(current_schema()||':privacy',0))",
      );
      // One short global mutex orders checks, counter changes, dispatch and operator changes.
      const policy = (await client.query('SELECT * FROM usage_policy WHERE singleton FOR UPDATE'))
        .rows[0];
      if (!policy) throw new Error('Usage policy missing');
      const result = await operation(client, policy);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }
  private async audit(
    client: PoolClient,
    id: string | null,
    action: string,
    details: Record<string, unknown> = {},
  ) {
    await client.query(
      'INSERT INTO usage_audit(reservation_id,action,actor,details) VALUES($1,$2,current_user,$3)',
      [id, action, details],
    );
  }
  private async live(client: PoolClient, lease: WorkLease, userId: string): Promise<void> {
    const result = await client.query(
      `SELECT q.id FROM work_outbox q
      JOIN identity_results r ON r.event_id=q.event_id JOIN users u ON u.id=r.user_id
      WHERE NOT recovery_blocked() AND q.id=$1 AND q.event_id=$2 AND q.lease_token=$3 AND q.status='leased' AND q.stage='action'
        AND q.lease_until>clock_timestamp() AND r.user_id=$4 AND r.disposition='ready'
        AND r.consent_grant_at=u.consent_at AND r.timezone_confirmed_at=u.timezone_confirmed_at
        AND u.deletion_requested_at IS NULL AND u.consent_version=$5 AND NOT u.paused AND u.pending_timezone IS NULL AND u.timezone IS NOT NULL
      FOR UPDATE OF q,u`,
      [lease.id, lease.event_id, lease.lease_token, userId, CONSENT_VERSION],
    );
    if (!result.rowCount) throw new LeaseLostError();
  }
  async reserve(
    lease: WorkLease,
    userId: string,
    provider: string,
    model: string,
  ): Promise<Reservation> {
    return this.transaction(async (client, policy) => {
      if (!policy.enabled) throw new DeferredWorkError('usage_paused');
      await this.live(client, lease, userId);
      const existing = (
        await client.query(
          'SELECT *,period::text AS period FROM usage_reservations WHERE work_id=$1 AND lease_token=$2',
          [lease.id, lease.lease_token],
        )
      ).rows[0] as Reservation | undefined;
      if (existing) {
        if (
          existing.user_id !== userId ||
          existing.provider !== provider ||
          existing.model !== model
        )
          throw new Error('Reservation identity mismatch');
        return existing;
      }
      if (
        (
          await client.query(
            "SELECT id FROM usage_reservations WHERE event_id=$1 AND state IN ('reserved','dispatched','unknown')",
            [lease.event_id],
          )
        ).rowCount
      )
        throw new DeferredWorkError('usage_unresolved');
      const rate = (
        await client.query(
          `SELECT * FROM model_rate_cards WHERE provider=$1 AND model=$2 AND active AND effective_at<=clock_timestamp()`,
          [provider, model],
        )
      ).rows[0];
      if (!rate) throw new DeferredWorkError('rate_unconfigured');
      const amount = tokenCost(
        rate.max_input_tokens,
        rate.max_output_tokens,
        BigInt(rate.input_micros_per_million),
        BigInt(rate.output_micros_per_million),
      );
      const period = (
        await client.query(
          "SELECT to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS period",
        )
      ).rows[0].period;
      await client.query(
        'INSERT INTO usage_global_periods(period) VALUES($1) ON CONFLICT DO NOTHING',
        [period],
      );
      await client.query(
        'INSERT INTO usage_user_periods(user_id,period) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [userId, period],
      );
      const global = (
        await client.query('SELECT * FROM usage_global_periods WHERE period=$1', [period])
      ).rows[0];
      const user = (
        await client.query('SELECT * FROM usage_user_periods WHERE user_id=$1 AND period=$2', [
          userId,
          period,
        ])
      ).rows[0];
      const limit =
        (
          await client.query('SELECT monthly_micros FROM usage_user_limits WHERE user_id=$1', [
            userId,
          ])
        ).rows[0]?.monthly_micros ?? policy.default_user_monthly_micros;
      if (
        BigInt(global.spent_micros) + BigInt(global.reserved_micros) + amount >
          BigInt(policy.global_monthly_micros) ||
        BigInt(user.spent_micros) + BigInt(user.reserved_micros) + amount > BigInt(limit)
      )
        throw new DeferredWorkError('budget_exhausted');
      await client.query(
        'UPDATE usage_global_periods SET reserved_micros=reserved_micros+$2 WHERE period=$1',
        [period, amount.toString()],
      );
      await client.query(
        'UPDATE usage_user_periods SET reserved_micros=reserved_micros+$3 WHERE user_id=$1 AND period=$2',
        [userId, period, amount.toString()],
      );
      const row = (
        await client.query(
          `INSERT INTO usage_reservations(work_id,event_id,user_id,lease_token,period,provider,model,rate_version,
        input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_micros,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved') RETURNING *,period::text AS period`,
          [
            lease.id,
            lease.event_id,
            userId,
            lease.lease_token,
            period,
            provider,
            model,
            rate.version,
            rate.input_micros_per_million,
            rate.output_micros_per_million,
            rate.max_input_tokens,
            rate.max_output_tokens,
            amount.toString(),
          ],
        )
      ).rows[0] as Reservation;
      await this.audit(client, row.id, 'reserved');
      const live = (
        await client.query(
          "SELECT id FROM work_outbox WHERE id=$1 AND lease_token=$2 AND lease_until>clock_timestamp() AND status='leased'",
          [lease.id, lease.lease_token],
        )
      ).rowCount;
      if (!live) throw new LeaseLostError();
      return row;
    });
  }
  async dispatch(id: string, lease: WorkLease): Promise<boolean> {
    return this.transaction(async (client, policy) => {
      if (!policy.enabled) throw new DeferredWorkError('usage_paused');
      const row = (
        await client.query(
          'SELECT *,period::text AS period FROM usage_reservations WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0] as Reservation | undefined;
      if (!row || row.work_id !== lease.id || row.lease_token !== lease.lease_token)
        throw new LeaseLostError();
      await this.live(client, lease, row.user_id);
      if (row.state !== 'reserved') return false;
      const period = (
        await client.query(
          "SELECT to_char(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC'),'YYYY-MM-DD') AS period",
        )
      ).rows[0].period;
      if (row.period !== period) throw new DeferredWorkError('budget_exhausted');
      if (await consumeQuota(client, row.user_id, 'model'))
        throw new DeferredWorkError('quota_exhausted');
      const changed = await client.query(
        `UPDATE usage_reservations SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=$1
        AND EXISTS(SELECT 1 FROM work_outbox WHERE id=$2 AND lease_token=$3 AND lease_until>clock_timestamp() AND status='leased') RETURNING id`,
        [id, lease.id, lease.lease_token],
      );
      if (!changed.rowCount) throw new LeaseLostError();
      await this.audit(client, id, 'dispatched');
      return true;
    });
  }
  private async finalize(
    client: PoolClient,
    row: Reservation,
    actual: bigint | null,
    input: number | null,
    output: number | null,
    action: string,
  ): Promise<void> {
    const spent = actual ?? 0n;
    await client.query(
      'UPDATE usage_global_periods SET reserved_micros=reserved_micros-$2,spent_micros=spent_micros+$3 WHERE period=$1',
      [row.period, row.reserved_micros, spent.toString()],
    );
    await client.query(
      'UPDATE usage_user_periods SET reserved_micros=reserved_micros-$3,spent_micros=spent_micros+$4 WHERE user_id=$1 AND period=$2',
      [row.user_id, row.period, row.reserved_micros, spent.toString()],
    );
    await client.query(
      `UPDATE usage_reservations SET state=$2,actual_micros=$3,input_tokens=$4,output_tokens=$5,finalized_at=clock_timestamp() WHERE id=$1`,
      [row.id, actual === null ? 'released' : 'settled', actual?.toString() ?? null, input, output],
    );
    await this.audit(client, row.id, action);
    if (
      actual !== null &&
      (actual > BigInt(row.reserved_micros) ||
        (input ?? 0) > row.max_input_tokens ||
        (output ?? 0) > row.max_output_tokens)
    ) {
      await client.query(
        'UPDATE usage_policy SET enabled=false,updated_at=clock_timestamp() WHERE singleton',
      );
      await this.audit(client, row.id, 'ceiling_exceeded', { actualMicros: actual.toString() });
    }
  }
  async settle(id: string, input: number, output: number): Promise<boolean> {
    if (
      !Number.isInteger(input) ||
      input < 0 ||
      input > 2147483647 ||
      !Number.isInteger(output) ||
      output < 0 ||
      output > 2147483647
    )
      throw new Error('Invalid token counts');
    const result = await this.transaction(async (client) => {
      const row = (
        await client.query(
          'SELECT *,period::text AS period FROM usage_reservations WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0] as Reservation | undefined;
      if (!row) throw new Error('Reservation missing');
      if (row.state === 'settled') {
        if (row.input_tokens !== input || row.output_tokens !== output) {
          await client.query(
            'UPDATE usage_policy SET enabled=false,updated_at=clock_timestamp() WHERE singleton',
          );
          await this.audit(client, id, 'conflicting_settlement', {
            inputTokens: input,
            outputTokens: output,
          });
          return 'conflict' as const;
        }
        return false;
      }
      if (!['dispatched', 'unknown'].includes(row.state))
        throw new Error('Reservation was not dispatched');
      let actual: bigint;
      try {
        actual = tokenCost(input, output, BigInt(row.input_rate), BigInt(row.output_rate));
      } catch {
        await client.query(
          'UPDATE usage_policy SET enabled=false,updated_at=clock_timestamp() WHERE singleton',
        );
        await client.query("UPDATE usage_reservations SET state='unknown' WHERE id=$1", [id]);
        await this.audit(client, id, 'unrepresentable_cost', {
          inputTokens: input,
          outputTokens: output,
        });
        return 'overflow' as const;
      }
      await this.finalize(client, row, actual, input, output, 'settled');
      return true;
    });
    if (result === 'conflict') throw new Error('Conflicting usage settlement; spending paused');
    if (result === 'overflow') throw new Error('Unrepresentable usage cost; spending paused');
    return result;
  }
  async release(id: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const row = (
        await client.query(
          'SELECT *,period::text AS period FROM usage_reservations WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0] as Reservation | undefined;
      if (!row || row.state !== 'reserved') return false;
      await this.finalize(client, row, null, null, null, 'released');
      return true;
    });
  }
  async reconcile(id: string, input: number, output: number, note: string): Promise<void> {
    if (!note.trim() || note.length > 500) throw new Error('Reconciliation evidence note required');
    await this.transaction(async (client) => {
      await assertUsageOperator(client);
      const row = (
        await client.query(
          'SELECT *,period::text AS period FROM usage_reservations WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0] as Reservation | undefined;
      if (!row || row.state !== 'unknown') throw new Error('Only unknown usage can be reconciled');
      const actual = tokenCost(input, output, BigInt(row.input_rate), BigInt(row.output_rate));
      await this.finalize(client, row, actual, input, output, 'operator_reconciled');
      await this.audit(client, id, 'reconciliation_evidence', {
        note,
        inputTokens: input,
        outputTokens: output,
      });
    });
  }
  async unknown(id: string): Promise<void> {
    await this.transaction(async (client) => {
      const result = await client.query(
        "UPDATE usage_reservations SET state='unknown' WHERE id=$1 AND state='dispatched' RETURNING id",
        [id],
      );
      if (result.rowCount) await this.audit(client, id, 'unknown');
    });
  }
  async recover(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Invalid recovery limit');
    return this.transaction(async (client) => {
      const rows = (
        await client.query(
          `SELECT r.*,r.period::text AS period FROM usage_reservations r JOIN work_outbox q ON q.id=r.work_id
        WHERE r.state IN ('reserved','dispatched') AND (q.status<>'leased' OR q.lease_token<>r.lease_token OR q.lease_until<=clock_timestamp())
        ORDER BY r.created_at LIMIT $1 FOR UPDATE OF r`,
          [limit],
        )
      ).rows as Reservation[];
      for (const row of rows) {
        if (row.state === 'reserved')
          await this.finalize(client, row, null, null, null, 'recovered_unsent');
        else {
          await client.query("UPDATE usage_reservations SET state='unknown' WHERE id=$1", [row.id]);
          await this.audit(client, row.id, 'recovered_unknown');
        }
      }
      return rows.length;
    });
  }
  async generate(
    lease: WorkLease,
    userId: string,
    transport: ModelTransport,
    request: ModelRequest,
  ): Promise<unknown> {
    if (request.signal.aborted) throw new ModelError('cancelled');
    const reservation = await this.reserve(lease, userId, transport.provider, transport.model);
    if (reservation.state !== 'reserved') throw new DeferredWorkError('usage_unresolved');
    let sent = false;
    try {
      if (
        transport.maxOutputTokens !== undefined &&
        transport.maxOutputTokens > reservation.max_output_tokens
      )
        throw new DeferredWorkError('rate_unconfigured');
      // A conservative payload-size preflight, not a substitute for qualifying the model's token ceiling.
      if (
        Buffer.byteLength(request.system) + Buffer.byteLength(request.input) + 1024 >
        reservation.max_input_tokens
      )
        throw new ModelError('too_large');
      if (request.signal.aborted) throw new ModelError('cancelled');
      if (!(await this.dispatch(reservation.id, lease)))
        throw new DeferredWorkError('usage_unresolved');
      sent = true;
      // Dispatch is the authorization point; after it, even cancellation is potentially billable.
      if (request.signal.aborted) throw new ModelError('cancelled');
      const result = await transport.generate(request);
      const metered = usage.safeParse(result);
      if (!metered.success || metered.data.model !== transport.model)
        throw new ModelError('invalid_output');
      await this.settle(reservation.id, metered.data.inputTokens, metered.data.outputTokens);
      return result;
    } catch (error) {
      if (sent) await this.unknown(reservation.id);
      else await this.release(reservation.id);
      throw error;
    }
  }
}
