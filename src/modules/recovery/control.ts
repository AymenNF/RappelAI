import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { assertUsageOperator } from '../usage/control.js';
import { cancelActivity } from '../privacy/commands.js';

export const deletionOverlay = z
  .object({
    version: z.literal('deletion-overlay-v1'),
    database: z.string().min(1),
    systemIdentifier: z.string().regex(/^\d+$/),
    capturedAt: z.iso.datetime({ offset: true }),
    keyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    fingerprints: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(1000000),
  })
  .strict();
export const releaseReview = z
  .object({
    sessionId: z.uuid(),
    externalOutcomesReviewed: z.literal(true),
    pendingWorkReviewed: z.literal(true),
    deletionRecordsReviewed: z.literal(true),
  })
  .strict();
export class RecoveryControl {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.pool.connect();
    let discard = false;
    try {
      await c.query('BEGIN');
      await assertUsageOperator(c);
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':privacy',0))",
      );
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        discard = true;
      }
      throw e;
    } finally {
      c.release(discard);
    }
  }
  private async identity(c: PoolClient) {
    return (
      await c.query(`SELECT current_database() AS database,system_identifier::text AS "systemIdentifier",
      encode(sha256(convert_to(secret,'UTF8')),'hex') AS "keyDigest",clock_timestamp() AS now,
      COALESCE(current_setting('memorae.recovery_target',true),'')='on' AS target,
      current_setting('memorae.recovery_instance',true) AS instance
      FROM pg_control_system(),privacy_key WHERE singleton`)
    ).rows[0];
  }
  async overlay() {
    return this.transaction(async (c) => {
      const identity = await this.identity(c);
      const rows = await c.query(`SELECT fingerprint FROM privacy_tombstones UNION
        SELECT encode(sha256(convert_to(k.secret||jsonb_build_array(u.business_phone_id,u.sender_id)::text,'UTF8')),'hex')
        FROM users u CROSS JOIN privacy_key k WHERE u.deletion_requested_at IS NOT NULL ORDER BY 1`);
      return deletionOverlay.parse({
        version: 'deletion-overlay-v1',
        database: identity.database,
        systemIdentifier: identity.systemIdentifier,
        capturedAt: identity.now.toISOString(),
        keyDigest: identity.keyDigest,
        fingerprints: rows.rows.map((r) => r.fingerprint),
      });
    });
  }
  async quarantine(input: unknown, expectedSystemIdentifier: string) {
    const overlay = deletionOverlay.parse(input);
    return this.transaction(async (c) => {
      const identity = await this.identity(c);
      if (
        !identity.target ||
        !z.uuid().safeParse(identity.instance).success ||
        identity.systemIdentifier !== expectedSystemIdentifier ||
        overlay.systemIdentifier !== identity.systemIdentifier ||
        overlay.database !== identity.database ||
        overlay.keyDigest !== identity.keyDigest ||
        identity.now.getTime() - Date.parse(overlay.capturedAt) > 86400000 ||
        Date.parse(overlay.capturedAt) > identity.now.getTime() + 300000
      )
        throw new Error(
          'Restore identity or deletion overlay mismatch; require a fresh overlay and an isolated recovery target',
        );
      await c.query('SELECT singleton FROM usage_policy FOR UPDATE');
      await c.query('UPDATE usage_policy SET enabled=false,updated_at=clock_timestamp()');
      const state = (
        await c.query(
          `UPDATE recovery_policy SET quarantined=true,session_id=gen_random_uuid(),overlay_at=$1,
        quarantined_at=clock_timestamp(),released_at=NULL,target_instance=$2 RETURNING session_id`,
          [overlay.capturedAt, identity.instance],
        )
      ).rows[0];
      await c.query(
        'INSERT INTO privacy_tombstones(fingerprint) SELECT DISTINCT unnest($1::text[]) ON CONFLICT DO NOTHING',
        [overlay.fingerprints],
      );
      const users =
        await c.query(`UPDATE users SET deletion_requested_at=COALESCE(deletion_requested_at,clock_timestamp()),paused=true
        WHERE privacy_address_blocked(business_phone_id,sender_id) RETURNING id`);
      for (const user of users.rows) await cancelActivity(c, user.id);
      // A restored lease is never evidence that its old owner remains valid.
      const leases =
        await c.query(`UPDATE work_outbox SET status='pending',available_at=clock_timestamp(),lease_token=NULL,lease_owner=NULL,lease_until=NULL,
        last_error_code='restore_quarantine' WHERE status='leased' RETURNING id`);
      const sends = await c.query(
        "UPDATE whatsapp_attempts SET state='unknown',error_code='restore_requires_reconciliation',updated_at=clock_timestamp() WHERE state='dispatching' RETURNING id",
      );
      await c.query(
        "UPDATE whatsapp_attempts SET recovery_state='exhausted',retry_at=NULL WHERE recovery_state='retry_wait'",
      );
      await c.query("UPDATE usage_reservations SET state='unknown' WHERE state='dispatched'");
      await c.query("INSERT INTO recovery_audit(session_id,action) VALUES($1,'quarantined')", [
        state.session_id,
      ]);
      return {
        sessionId: state.session_id as string,
        usersMarked: users.rowCount,
        leasesFenced: leases.rowCount,
        sendsHeld: sends.rowCount,
      };
    });
  }
  async release(input: unknown) {
    const review = releaseReview.parse(input);
    await this.transaction(async (c) => {
      const identity = await this.identity(c);
      const state = (await c.query('SELECT * FROM recovery_policy FOR UPDATE')).rows[0];
      if (
        !identity.target ||
        !state.quarantined ||
        state.session_id !== review.sessionId ||
        !state.overlay_at ||
        state.target_instance !== identity.instance ||
        identity.now.getTime() - state.overlay_at.getTime() > 86400000
      )
        throw new Error('Restore session is not quarantined');
      const holds = (
        await c.query(`SELECT (SELECT enabled FROM usage_policy) OR
        EXISTS(SELECT 1 FROM usage_reservations WHERE state IN ('reserved','dispatched','unknown')) OR
        EXISTS(SELECT 1 FROM whatsapp_attempts WHERE state='dispatching' OR (state='unknown' AND recovery_state<>'abandoned')) OR
        EXISTS(SELECT 1 FROM delivery_recovery_audit a WHERE action='late_acceptance_conflict' AND NOT EXISTS(
          SELECT 1 FROM delivery_recovery_audit r WHERE r.attempt_id=a.attempt_id AND r.action='operator_accepted' AND r.created_at>a.created_at)) OR
        EXISTS(SELECT 1 FROM users WHERE deletion_requested_at IS NOT NULL) AS held`)
      ).rows[0].held;
      if (holds)
        throw new Error(
          'Resolve external outcomes and pending deletions while spending stays paused before release',
        );
      await c.query('UPDATE recovery_policy SET quarantined=false,released_at=clock_timestamp()');
      await c.query("INSERT INTO recovery_audit(session_id,action) VALUES($1,'released')", [
        review.sessionId,
      ]);
    });
  }
  async status() {
    return this.transaction(
      async (c) =>
        (await c.query('SELECT *,recovery_blocked() AS blocked FROM recovery_policy')).rows[0],
    );
  }
}
