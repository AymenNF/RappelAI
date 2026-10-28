import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { micros, tokenCost } from './money.js';

export async function assertUsageOperator(client: PoolClient): Promise<void> {
  const result = await client.query(
    "SELECT pg_has_role(current_user,relowner,'MEMBER') AS allowed FROM pg_class WHERE oid='usage_policy'::regclass",
  );
  if (!result.rows[0]?.allowed)
    throw new Error('Usage controls require the migration administrator');
}
const amount = z.string().refine((value) => {
  try {
    micros(value);
    return true;
  } catch {
    return false;
  }
}, 'Expected bounded integer USD micros');
export const rateCard = z
  .object({
    provider: z.string().min(1).max(100),
    model: z.string().min(1).max(200),
    version: z.string().min(1).max(100),
    inputMicrosPerMillion: amount,
    outputMicrosPerMillion: amount,
    maxInputTokens: z.number().int().min(1).max(1000000),
    maxOutputTokens: z.number().int().min(1).max(1000000),
  })
  .strict();
export class UsageControl {
  constructor(private readonly pool: Pool) {}
  private async change(
    action: string,
    note: string,
    apply: (client: PoolClient) => Promise<void>,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (!note.trim() || note.length > 500)
      throw new Error('Operator note required (1-500 characters)');
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await assertUsageOperator(client);
      const before = (await client.query('SELECT * FROM usage_policy WHERE singleton FOR UPDATE'))
        .rows[0];
      await apply(client);
      const after = (await client.query('SELECT * FROM usage_policy WHERE singleton')).rows[0];
      await client.query(
        'INSERT INTO usage_audit(action,actor,details) VALUES($1,current_user,$2)',
        [action, { note, ...details, before, after }],
      );
      await client.query('COMMIT');
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
  async switch(enabled: boolean, note: string): Promise<void> {
    await this.change(enabled ? 'operator_enabled' : 'operator_paused', note, async (client) => {
      await client.query(
        'UPDATE usage_policy SET enabled=$1,updated_at=clock_timestamp() WHERE singleton',
        [enabled],
      );
    });
  }
  async limits(global: string, userDefault: string, note: string): Promise<void> {
    micros(global);
    micros(userDefault);
    await this.change('operator_limits', note, async (client) => {
      await client.query(
        'UPDATE usage_policy SET global_monthly_micros=$1,default_user_monthly_micros=$2,updated_at=clock_timestamp() WHERE singleton',
        [global, userDefault],
      );
    });
  }
  async userLimit(userId: string, limit: string, note: string): Promise<void> {
    z.uuid().parse(userId);
    micros(limit);
    await this.change(
      'operator_user_limit',
      note,
      async (client) => {
        await client.query(
          'INSERT INTO usage_user_limits(user_id,monthly_micros) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET monthly_micros=EXCLUDED.monthly_micros',
          [userId, limit],
        );
      },
      { userId, monthlyMicros: limit },
    );
  }
  async rate(input: unknown, note: string): Promise<void> {
    const rate = rateCard.parse(input);
    tokenCost(
      rate.maxInputTokens,
      rate.maxOutputTokens,
      micros(rate.inputMicrosPerMillion),
      micros(rate.outputMicrosPerMillion),
    );
    await this.change(
      'operator_rate',
      note,
      async (client) => {
        await client.query(
          'UPDATE model_rate_cards SET active=false WHERE provider=$1 AND model=$2 AND active',
          [rate.provider, rate.model],
        );
        await client.query(
          `INSERT INTO model_rate_cards(provider,model,version,input_micros_per_million,output_micros_per_million,max_input_tokens,max_output_tokens)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
          [
            rate.provider,
            rate.model,
            rate.version,
            rate.inputMicrosPerMillion,
            rate.outputMicrosPerMillion,
            rate.maxInputTokens,
            rate.maxOutputTokens,
          ],
        );
      },
      { rate },
    );
  }
  async status(): Promise<unknown> {
    const client = await this.pool.connect();
    try {
      await assertUsageOperator(client);
      return {
        policy: (await client.query('SELECT * FROM usage_policy')).rows[0],
        periods: (
          await client.query('SELECT * FROM usage_global_periods ORDER BY period DESC LIMIT 12')
        ).rows,
        unresolved: (
          await client.query(
            "SELECT state,count(*)::int AS count,sum(reserved_micros)::text AS reserved_micros FROM usage_reservations WHERE state IN ('reserved','dispatched','unknown') GROUP BY state",
          )
        ).rows,
      };
    } finally {
      client.release();
    }
  }
}
