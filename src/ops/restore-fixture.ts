// Synthetic drill only; no real sender or provider is contacted.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readSecret } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
import { PostgresIngressStore } from '../db/ingress-store.js';
import { CONSENT_VERSION } from '../modules/identity/onboarding.js';
import { RecoveryControl } from '../modules/recovery/control.js';
import { PrivacyAdmin } from '../modules/privacy/admin.js';
import { UsageService } from '../modules/usage/service.js';
import { DeliveryRecovery } from '../modules/whatsapp/recovery.js';
import { WorkQueue } from '../modules/processing/leases.js';
const url = new URL(readSecret('DATABASE_URL') ?? '');
if (
  process.env.STAGING_SYNTHETIC_ONLY !== 'true' ||
  url.pathname !== '/memorae_staging' ||
  !/^memorae-drill-[a-f0-9]{12}-(source|restore)$/.test(url.hostname)
)
  throw new Error('Disposable synthetic drill target required');
const pool = createPool(url.toString());
const recovery = new RecoveryControl(pool);
try {
  const phase = process.argv[2];
  if (phase === 'seed') {
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);
    await pool.query('CREATE TABLE drill_markers(name text PRIMARY KEY)');
    const store = new PostgresIngressStore(pool);
    for (const kind of ['pending', 'leased', 'accepted', 'dispatching', 'delete-later']) {
      const sender = `synthetic-${kind}`;
      await store.persist([
        {
          eventKey: kind,
          kind: 'inbound.message',
          phoneNumberId: 'staging-synthetic',
          providerMessageId: kind,
          senderId: sender,
          payload: {
            type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body: 'Synthetic restore drill' },
          },
        },
      ]);
      const event = (await pool.query('SELECT id FROM ingress_events WHERE event_key=$1', [kind]))
        .rows[0].id;
      const user = (
        await pool.query(
          `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('staging-synthetic',$1,$2,clock_timestamp(),false,'UTC',clock_timestamp()) RETURNING id`,
          [sender, CONSENT_VERSION],
        )
      ).rows[0].id;
      await pool.query(
        "INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at) SELECT $1,id,'ready',consent_at,timezone_confirmed_at FROM users WHERE id=$2",
        [event, user],
      );
      await pool.query("UPDATE work_outbox SET stage='action' WHERE event_id=$1", [event]);
      if (kind === 'leased') {
        const lease = randomUUID();
        const work = (
          await pool.query(
            "UPDATE work_outbox SET status='leased',lease_owner='lost-drill-worker',lease_token=$2,lease_until=clock_timestamp()+interval '1 day' WHERE event_id=$1 RETURNING id",
            [event, lease],
          )
        ).rows[0].id;
        await pool.query(
          "INSERT INTO usage_global_periods(period,reserved_micros) VALUES(date_trunc('month',clock_timestamp())::date,10)",
        );
        await pool.query(
          'INSERT INTO usage_user_periods(user_id,period,reserved_micros) SELECT $1,period,10 FROM usage_global_periods',
          [user],
        );
        await pool.query(
          `INSERT INTO usage_reservations(work_id,event_id,user_id,lease_token,period,provider,model,rate_version,input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_micros,state)
          SELECT $1,$2,$3,$4,period,'synthetic','synthetic','drill',0,0,1,1,10,'dispatched' FROM usage_global_periods`,
          [work, event, user, lease],
        );
      }
      if (kind === 'accepted' || kind === 'dispatching') {
        await pool.query(
          "UPDATE work_outbox SET status='completed',completed_at=clock_timestamp() WHERE event_id=$1",
          [event],
        );
        await pool.query(
          `INSERT INTO whatsapp_attempts(user_id,event_id,identity_event_id,phone_number_id,recipient_id,state,provider_message_id)
          VALUES($1,$2,$2,'staging-synthetic',$3,$4,$5)`,
          [user, event, sender, kind, kind === 'accepted' ? 'synthetic-provider-accepted' : null],
        );
        if (kind === 'dispatching')
          await pool.query(
            "UPDATE whatsapp_attempts SET created_at=clock_timestamp()-interval '10 minutes',dispatch_deadline=clock_timestamp()-interval '1 minute' WHERE event_id=$1",
            [event],
          );
      }
    }
    await pool.query('UPDATE usage_policy SET enabled=true');
    console.log(JSON.stringify({ seeded: true }));
  } else if (phase === 'delete-overlay') {
    const user = (
      await pool.query(
        "UPDATE users SET deletion_requested_at=clock_timestamp(),paused=true WHERE sender_id='synthetic-delete-later' RETURNING id",
      )
    ).rows[0].id;
    assert.equal((await new PrivacyAdmin(pool).purge(user)).status, 'purged');
    console.log(JSON.stringify(await recovery.overlay()));
  } else if (phase === 'verify') {
    const overlay = JSON.parse(await readFile('/evidence/deletions.json', 'utf8'));
    assert.equal((await pool.query('SELECT recovery_blocked() AS blocked')).rows[0].blocked, true);
    assert.equal(await new WorkQueue(pool).claim('action', 'must-not-run'), null);
    assert.equal(await new PostgresIngressStore(pool).ready(), false);
    const markers = (await pool.query('SELECT name FROM drill_markers ORDER BY name')).rows.map(
      (r) => r.name,
    );
    assert.deepEqual(markers, ['after-base']);
    const result = await recovery.quarantine(overlay, overlay.systemIdentifier);
    assert.equal(result.leasesFenced, 1);
    assert.equal(result.sendsHeld, 1);
    assert.equal(result.usersMarked, 1);
    const review = {
      sessionId: result.sessionId,
      externalOutcomesReviewed: true,
      pendingWorkReviewed: true,
      deletionRecordsReviewed: true,
    };
    await assert.rejects(recovery.release(review));
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM whatsapp_attempts WHERE state='accepted' AND provider_message_id='synthetic-provider-accepted'",
        )
      ).rows[0].n,
      1,
    );
    const usage = new UsageService(pool);
    await usage.recover();
    for (const r of (await pool.query("SELECT id FROM usage_reservations WHERE state='unknown'"))
      .rows)
      await usage.reconcile(r.id, 0, 0, 'Synthetic drill confirms no billable usage');
    for (const a of (await pool.query("SELECT id FROM whatsapp_attempts WHERE state='unknown'"))
      .rows)
      await new DeliveryRecovery(pool).reconcile(a.id, {
        action: 'abandon',
        note: 'Synthetic drill: retain uncertainty and do not resend',
      });
    for (const u of (
      await pool.query('SELECT id FROM users WHERE deletion_requested_at IS NOT NULL')
    ).rows)
      assert.equal((await new PrivacyAdmin(pool).purge(u.id)).status, 'purged');
    await recovery.release(review);
    assert.equal((await pool.query('SELECT enabled FROM usage_policy')).rows[0].enabled, false);
    assert.ok(await new WorkQueue(pool).claim('action', 'reviewed-drill-worker'));
    assert.equal(
      (await pool.query('SELECT count(*)::int AS n FROM whatsapp_attempts')).rows[0].n,
      2,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM users WHERE sender_id='synthetic-delete-later'",
        )
      ).rows[0].n,
      0,
    );
    console.log(
      JSON.stringify({
        pointInTimeVerified: true,
        oldLeaseFenced: true,
        unknownOutcomesHeld: true,
        acceptedSendPreserved: true,
        deletionReapplied: true,
        pendingWorkRecoverable: true,
        spendingPaused: true,
        externalCalls: 0,
      }),
    );
  } else throw new Error('Unknown drill phase');
} finally {
  await pool.end();
}
