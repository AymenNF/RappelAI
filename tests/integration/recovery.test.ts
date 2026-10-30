import { RecoveryControl } from '../../src/modules/recovery/control.js';
import { assertRuntimeRole } from '../../src/db/runtime.js';
import { OperationsControl } from '../../src/modules/telemetry/control.js';
import { RuntimeTelemetry, databaseSink } from '../../src/modules/telemetry/runtime.js';
import { PrivacyAdmin } from '../../src/modules/privacy/admin.js';
import { DeliveryRecovery } from '../../src/modules/whatsapp/recovery.js';
import { ReminderScheduler } from '../../src/modules/reminders/scheduler.js';
import { UsageService } from '../../src/modules/usage/service.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { WorkQueue } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ExecutionProcessor } from '../../src/modules/processing/execution.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'staging roles and restore quarantine under restricted runtime logins',
  { timeout: 60000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `test_${suffix}`;
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const pools: pg.Pool[] = [];
    const roles: string[] = [];
    const login = async (capability: string) => {
      const name = `test_${capability}_${suffix}`;
      const password = randomBytes(24).toString('hex');
      await admin.query(
        `CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      roles.push(name);
      await admin.query(`GRANT memorae_${capability} TO ${name}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = name;
      url.password = password;
      const pool = new pg.Pool({
        connectionString: url.toString(),
        max: 12,
        options: `-c search_path=${schema},public`,
        statement_timeout: 5000,
      });
      pools.push(pool);
      return pool;
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrateTestSchema(admin);
      const worker = await login('worker');
      const tenant = await login('tenant');
      const ingress = await login('ingress');
      const store = new PostgresIngressStore(ingress);
      const queue = new WorkQueue(worker);
      const runner = new WorkRunner(queue, 'executor-test');
      const executor = new ExecutionProcessor();
      const listCall = (name = 'Grocery', text = 'milk') => ({
        tool: 'add_list_item',
        args: { list_name: name, text },
      });
      const reminderCall = (
        due = new Date(Date.now() + 3600000).toISOString(),
        mode = 'immediate',
      ) => ({
        tool: 'create_reminder',
        args: { title: 'Call dentist', due_at: due, delivery_mode: mode },
      });
      const mixed = () => ({ behavior: 'execute', calls: [listCall(), reminderCall()] });
      const reset = () =>
        admin.query(
          'TRUNCATE users,ingress_events,usage_global_periods,privacy_tombstones,privacy_operations,model_rate_cards CASCADE',
        );
      const privacy = new PrivacyAdmin(admin);
      const send = async (sender: string, body: string) => {
        const key = randomUUID();
        await store.persist([
          {
            eventKey: key,
            kind: 'inbound.message',
            phoneNumberId: '12345',
            providerMessageId: key,
            senderId: sender,
            payload: {
              type: 'text',
              timestamp: String(Math.floor(Date.now() / 1000)),
              text: { body },
            },
          },
        ]);
        return (await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [key]))
          .rows[0].id as string;
      };
      const plan = async (value: unknown = mixed(), sender = 'alice', persist = true) => {
        const at = new Date(Date.now() - 10000);
        const eventId = await send(sender, 'synthetic instruction');
        await admin.query(
          `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('12345',$1,$2,$3,false,'America/Toronto',$3) ON CONFLICT DO NOTHING`,
          [sender, CONSENT_VERSION, at],
        );
        const user = (await admin.query('SELECT * FROM users WHERE sender_id=$1', [sender]))
          .rows[0];
        await admin.query(
          `INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,'ready',$3,$4)`,
          [eventId, user.id, user.consent_at, user.timezone_confirmed_at],
        );
        if (persist)
          await worker.query(
            `INSERT INTO action_plans(event_id,user_id,schema_version,decision,provider,model,prompt_version,prompt_sha256,input_sha256,
        input_tokens,output_tokens,latency_ms,reference_at,validated_at,consent_grant_at,timezone_confirmed_at,timezone)
        VALUES($1,$2,'decision-v1',$3,'fake','test-v1','intent-v1',$4,$4,0,0,0,clock_timestamp(),clock_timestamp(),$5,$6,$7)`,
            [
              eventId,
              user.id,
              value,
              PROMPT_SHA256,
              user.consent_at,
              user.timezone_confirmed_at,
              user.timezone,
            ],
          );
        await admin.query('UPDATE work_outbox SET stage=$2 WHERE event_id=$1', [
          eventId,
          persist ? 'execution' : 'action',
        ]);
        return { eventId, userId: user.id as string };
      };

      const add = async (name = 'Grocery', text = 'milk', who = 'alice') => {
        const source = await plan({ behavior: 'execute', calls: [listCall(name, text)] }, who);
        assert.equal(await runner.runOne('execution', executor), true);
        return {
          ...source,
          ...(
            await worker.query(
              'SELECT id AS item_id,list_id,position FROM list_items WHERE source_event_id=$1',
              [source.eventId],
            )
          ).rows[0],
        };
      };
      const run = async (body: string, who = 'alice') => {
        const eventId = await send(who, body);
        const result = await new IdentityProcessor(worker).processNext();
        assert.equal(result?.eventId, eventId);

        assert.equal(
          (await worker.query('SELECT 1 FROM action_plans WHERE event_id=$1', [eventId])).rowCount,
          0,
        );
        const action = (
          await worker.query('SELECT * FROM list_actions WHERE event_id=$1', [eventId])
        ).rows[0];
        return {
          eventId,
          action,
          identity: (
            await worker.query('SELECT * FROM identity_results WHERE event_id=$1', [eventId])
          ).rows[0],
        };
      };
      const request = async (kind: string, who = 'alice') => {
        await run(kind === 'delete' ? 'DELETE ACCOUNT' : 'EXPORT DATA', who);
        return (
          await worker.query(
            "SELECT r.* FROM privacy_requests r JOIN users u ON u.id=r.user_id WHERE u.sender_id=$1 AND r.kind=$2 AND r.status IN ('offered','requested')",
            [who, kind],
          )
        ).rows[0];
      };
      const confirm = async (who = 'alice') => {
        const r = await request('delete', who);
        await run(`CONFIRM DELETE ${r.reference}`, who);
        return r;
      };

      const ops = new OperationsControl(admin);
      const clean = async () => {
        await reset();
        await admin.query(
          'TRUNCATE telemetry_runtime,telemetry_counters,telemetry_batches,monitoring_alerts,monitoring_events,monitoring_snapshot CASCADE',
        );
        await admin.query('UPDATE monitoring_policy SET expect_api=false,expect_worker=false');
        await admin.query('UPDATE usage_policy SET enabled=false,global_monthly_micros=0');
      };
      const attempt = async (who: string, state: string) => {
        const a = await plan({ behavior: 'noop', calls: [] }, who);
        const id = randomUUID();
        await admin.query(
          `INSERT INTO whatsapp_attempts(id,user_id,event_id,identity_event_id,phone_number_id,recipient_id,state,provider_message_id)
        VALUES($1,$2,$3,$3,'12345',$4,$5,$6)`,
          [id, a.userId, a.eventId, who, state, state === 'accepted' ? randomUUID() : null],
        );
        return { ...a, id };
      };

      const target = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema},public -c memorae.recovery_target=on -c memorae.recovery_instance=${randomUUID()}`,
      });
      pools.push(target);
      const recovery = new RecoveryControl(target);
      const sourceRecovery = new RecoveryControl(admin);
      const resetRestore = async () => {
        await admin.query(
          'UPDATE recovery_policy SET quarantined=false,session_id=NULL,overlay_at=NULL,released_at=NULL',
        );
        await clean();
      };
      await t.test(
        'monitor can inspect and acknowledge alerts but cannot read content or mutate business state',
        async () => {
          await resetRestore();
          const monitor = await login('monitor');
          await assertRuntimeRole(monitor, 'monitor');
          // Tenant access keeps its existing isolated privileges; only ingress/worker start jobs.
          await assertRuntimeRole(tenant, 'tenant');
          await assert.rejects(tenant.query('SELECT recovery_blocked()'), /permission denied/);
          const operations = new OperationsControl(monitor);
          await operations.expect('worker', true);
          await operations.check();
          assert.equal(await operations.acknowledge('worker_missing', 1), true);
          assert.equal((await operations.queue('work')).items.length, 0);
          for (const sql of [
            'SELECT sender_id FROM users',
            'SELECT payload FROM ingress_events',
            'SELECT body FROM outbound_messages',
            'SELECT secret FROM privacy_key',
            'UPDATE usage_policy SET enabled=true',
            'DELETE FROM users',
            'UPDATE recovery_policy SET quarantined=false',
          ])
            await assert.rejects(monitor.query(sql), /permission denied/);
          await assert.rejects(new RecoveryControl(monitor).overlay());
          await assert.rejects(assertRuntimeRole(admin, 'monitor'));
        },
      );
      await t.test(
        'a marked recovery target fails closed before quarantine and rejects source or mismatched overlays',
        async () => {
          await resetRestore();
          await plan();
          assert.equal(
            (await target.query('SELECT recovery_blocked() AS blocked')).rows[0].blocked,
            true,
          );
          assert.equal(await new WorkQueue(target).claim('execution', 'blocked'), null);
          assert.equal(await new PostgresIngressStore(target).ready(), false);
          const overlay = await sourceRecovery.overlay();
          await assert.rejects(
            sourceRecovery.quarantine(overlay, overlay.systemIdentifier),
            /isolated recovery target/,
          );
          await assert.rejects(
            recovery.quarantine(
              { ...overlay, keyDigest: 'a'.repeat(64) },
              overlay.systemIdentifier,
            ),
          );
          await assert.rejects(recovery.quarantine(overlay, '0'));
          assert.equal(
            (await admin.query('SELECT quarantined FROM recovery_policy')).rows[0].quarantined,
            false,
          );
        },
      );
      await t.test(
        'quarantine fences old leases and uncertain dispatches while preserving accepted sends and pending work',
        async () => {
          await resetRestore();
          await plan(undefined, 'pending-user');
          const lease = (await queue.claim('execution', 'old-worker'))!;
          const accepted = await attempt('15555550101', 'accepted');
          const dispatch = await attempt('15555550102', 'dispatching');
          await admin.query('UPDATE usage_policy SET enabled=true');
          const overlay = await sourceRecovery.overlay();
          const result = await recovery.quarantine(overlay, overlay.systemIdentifier);
          assert.equal(result.leasesFenced, 1);
          assert.equal(result.sendsHeld, 1);
          await assert.rejects(queue.commit(lease, async () => ({ nextStage: null })));
          assert.equal(await queue.claim('execution', 'new-worker'), null);
          assert.deepEqual(await new ReminderScheduler(worker).sweep(), {
            examined: 0,
            materialized: 0,
            suppressed: 0,
          });
          assert.equal(
            (await worker.query('SELECT state FROM whatsapp_attempts WHERE id=$1', [accepted.id]))
              .rows[0].state,
            'accepted',
          );
          assert.equal(
            (await worker.query('SELECT state FROM whatsapp_attempts WHERE id=$1', [dispatch.id]))
              .rows[0].state,
            'unknown',
          );
          await assert.rejects(admin.query('UPDATE usage_policy SET enabled=true'), /quarantine/);
          await assert.rejects(assertRuntimeRole(worker, 'worker'), /quarantined/);
          await assert.rejects(
            recovery.release({
              sessionId: result.sessionId,
              externalOutcomesReviewed: true,
              pendingWorkReviewed: true,
              deletionRecordsReviewed: true,
            }),
            /Resolve/,
          );
        },
      );
      await t.test(
        'fresh deletion overlays reapply after an older restore and require purging before explicit release',
        async () => {
          await resetRestore();
          const a = await add();
          await confirm();
          const overlay = await sourceRecovery.overlay();
          // Model a backup older than the deletion confirmation.
          await admin.query('UPDATE users SET deletion_requested_at=NULL,paused=false');
          const state = await recovery.quarantine(overlay, overlay.systemIdentifier);
          assert.equal(state.usersMarked, 1);
          assert.ok(
            (await worker.query('SELECT deletion_requested_at FROM users WHERE id=$1', [a.userId]))
              .rows[0].deletion_requested_at,
          );
          const review = {
            sessionId: state.sessionId,
            externalOutcomesReviewed: true,
            pendingWorkReviewed: true,
            deletionRecordsReviewed: true,
          };
          await assert.rejects(recovery.release(review), /Resolve/);
          assert.equal((await privacy.purge(a.userId)).status, 'purged');
          await assert.rejects(recovery.release({ ...review, sessionId: randomUUID() }), /session/);
          await recovery.release(review);
          assert.equal((await recovery.status()).blocked, false);
          // A release copied into a subsequent backup cannot authorize a new restore.
          for (const setting of ['', ` -c memorae.recovery_instance=${randomUUID()}`]) {
            const laterTarget = new pg.Pool({
              connectionString: process.env.TEST_DATABASE_URL,
              options: `-c search_path=${schema},public -c memorae.recovery_target=on${setting}`,
            });
            try {
              assert.equal((await new RecoveryControl(laterTarget).status()).blocked, true);
              assert.equal(await new WorkQueue(laterTarget).claim('action', 'later-restore'), null);
              await assert.rejects(new RecoveryControl(laterTarget).release(review), /session/);
            } finally {
              await laterTarget.end();
            }
          }
          assert.equal(
            (await admin.query('SELECT enabled FROM usage_policy')).rows[0].enabled,
            false,
          );
          assert.equal(
            (
              await admin.query('SELECT * FROM recovery_audit WHERE session_id=$1', [
                state.sessionId,
              ])
            ).rowCount,
            2,
          );
        },
      );
      await t.test(
        'a failed quarantine rolls back policy, tombstones, work and audit together',
        async () => {
          await resetRestore();
          await plan();
          const overlay = await sourceRecovery.overlay();
          await admin.query(`CREATE FUNCTION fail_restore_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected failure'; END$$;
          CREATE TRIGGER fail_restore_audit BEFORE INSERT ON recovery_audit FOR EACH ROW EXECUTE FUNCTION fail_restore_audit()`);
          await assert.rejects(
            recovery.quarantine(overlay, overlay.systemIdentifier),
            /injected failure/,
          );
          assert.equal(
            (await admin.query('SELECT quarantined FROM recovery_policy')).rows[0].quarantined,
            false,
          );
          await admin.query(
            'DROP TRIGGER fail_restore_audit ON recovery_audit; DROP FUNCTION fail_restore_audit()',
          );
        },
      );
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const role of roles) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  },
);
