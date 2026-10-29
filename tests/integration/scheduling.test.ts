import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { withTenant } from '../../src/db/tenant.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { ReminderScheduler } from '../../src/modules/reminders/scheduler.js';
import { WorkQueue } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ExecutionProcessor } from '../../src/modules/processing/execution.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'one-time occurrence scheduling under restricted database logins',
  { timeout: 60000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `test_${suffix}`;
    const appName = `scheduler_${suffix}`;
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const pools: pg.Pool[] = [],
      roles: string[] = [];
    const login = async (capability: string) => {
      const name = `test_${capability}_${suffix}`,
        password = randomBytes(24).toString('hex');
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
        application_name: appName,
      });
      pools.push(pool);
      return pool;
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrateTestSchema(admin);
      const worker = await login('worker'),
        ingress = await login('ingress'),
        tenant = await login('tenant');
      const store = new PostgresIngressStore(ingress),
        scheduler = new ReminderScheduler(worker);
      const reset = () => admin.query('TRUNCATE users,ingress_events CASCADE');
      const inbound = async (sender: string, body: string) => {
        const key = randomUUID();
        await store.persist([
          {
            eventKey: key,
            kind: 'inbound.message',
            phoneNumberId: 'business',
            providerMessageId: key,
            senderId: sender,
            payload: {
              type: 'text',
              timestamp: String(Math.floor(Date.now() / 1000)),
              text: { body },
            },
          },
        ]);
        return (await worker.query('SELECT id FROM ingress_events WHERE event_key=$1', [key]))
          .rows[0].id as string;
      };
      // Seed a historical saved plan/reminder. Its due time was future at its reference/validation time.
      const seed = async (
        sender = 'alice',
        due = new Date(Date.now() - 3600000).toISOString(),
        execute = false,
      ) => {
        const at = new Date(Date.now() - 86400000);
        const eventId = await inbound(sender, 'synthetic reminder');
        await worker.query(
          `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,timezone,timezone_confirmed_at)
        VALUES('business',$1,$2,$3,'America/Toronto',$3) ON CONFLICT DO NOTHING`,
          [sender, CONSENT_VERSION, at],
        );
        const user = (await worker.query('SELECT * FROM users WHERE sender_id=$1', [sender]))
          .rows[0];
        await worker.query(
          `INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,'ready',$3,$4)`,
          [eventId, user.id, user.consent_at, user.timezone_confirmed_at],
        );
        await worker.query(
          `INSERT INTO action_plans(event_id,user_id,schema_version,decision,provider,model,prompt_version,prompt_sha256,input_sha256,
        input_tokens,output_tokens,latency_ms,reference_at,validated_at,consent_grant_at,timezone_confirmed_at,timezone)
        VALUES($1,$2,'decision-v1',$3,'fake','test-v1','intent-v1',$4,$4,0,0,0,$5,$5,$6,$7,'America/Toronto')`,
          [
            eventId,
            user.id,
            {
              behavior: 'execute',
              calls: [
                {
                  tool: 'create_reminder',
                  args: { title: 'Call dentist', due_at: due, delivery_mode: 'immediate' },
                },
              ],
            },
            PROMPT_SHA256,
            at,
            user.consent_at,
            user.timezone_confirmed_at,
          ],
        );
        let reminderId: string;
        if (execute) {
          await admin.query("UPDATE work_outbox SET stage='execution' WHERE event_id=$1", [
            eventId,
          ]);
          assert.equal(
            await new WorkRunner(new WorkQueue(worker), 'test-executor').runOne(
              'execution',
              new ExecutionProcessor(),
            ),
            true,
          );
          reminderId = (
            await worker.query('SELECT id FROM reminders WHERE source_event_id=$1', [eventId])
          ).rows[0].id;
        } else {
          reminderId = (
            await worker.query(
              `INSERT INTO reminders(user_id,source_event_id,plan_version,action_key,title,due_at,timezone,delivery_mode)
          VALUES($1,$2,1,$3,'Call dentist',$4,'America/Toronto','immediate') RETURNING id`,
              [user.id, eventId, randomBytes(32).toString('hex'), due],
            )
          ).rows[0].id;
          await admin.query(
            "UPDATE work_outbox SET status='completed',completed_at=clock_timestamp() WHERE event_id=$1",
            [eventId],
          );
        }
        return { eventId, userId: user.id as string, reminderId };
      };
      const counts = async () => {
        const result = (
          await worker.query(`SELECT
        (SELECT count(*)::int FROM reminder_occurrences) AS occurrences,
        (SELECT count(*)::int FROM outbound_messages) AS outbound,
        (SELECT count(*)::int FROM reminders WHERE scheduled_at IS NOT NULL) AS marked`)
        ).rows[0];
        return result as { occurrences: number; outbound: number; marked: number };
      };
      const statuses = async () =>
        (
          await worker.query(`SELECT o.status AS occurrence,m.status AS message
      FROM reminder_occurrences o JOIN outbound_messages m ON m.occurrence_id=o.id`)
        ).rows;

      await t.test(
        'competing schedulers create one occurrence and intent; restart/replay preserve IDs',
        async () => {
          await reset();
          const item = await seed();
          const results = await Promise.all(Array.from({ length: 8 }, () => scheduler.sweep()));
          assert.equal(
            results.reduce((n, r) => n + r.materialized, 0),
            1,
          );
          assert.deepEqual(await counts(), { occurrences: 1, outbound: 1, marked: 1 });
          const original = (await worker.query('SELECT id,body,status FROM outbound_messages'))
            .rows[0];
          assert.equal(original.body, 'Reminder: Call dentist');
          assert.equal(original.status, 'pending');
          assert.deepEqual(await new ReminderScheduler(worker).sweep(), {
            examined: 0,
            materialized: 0,
            suppressed: 0,
          });
          await admin.query('UPDATE reminders SET scheduled_at=NULL WHERE id=$1', [
            item.reminderId,
          ]);
          assert.equal((await scheduler.sweep()).materialized, 0);
          assert.equal(
            (await worker.query('SELECT id FROM outbound_messages')).rows[0].id,
            original.id,
          );
          assert.equal(
            (await worker.query('SELECT status FROM reminders')).rows[0].status,
            'pending',
          );
          await admin.query("UPDATE users SET consent_version='obsolete'");
          await admin.query('UPDATE reminders SET scheduled_at=NULL');
          await scheduler.sweep();
          assert.deepEqual(await statuses(), [{ occurrence: 'suppressed', message: 'suppressed' }]);
        },
      );
      await t.test('future, canceled and completed reminders are not materialized', async () => {
        await reset();
        await seed('future', new Date(Date.now() + 3600000).toISOString());
        const cancelled = await seed('cancelled'),
          completed = await seed('completed');
        await admin.query("UPDATE reminders SET status='cancelled' WHERE id=$1", [
          cancelled.reminderId,
        ]);
        await admin.query("UPDATE reminders SET status='completed' WHERE id=$1", [
          completed.reminderId,
        ]);
        assert.deepEqual(await scheduler.sweep(), { examined: 0, materialized: 0, suppressed: 0 });
        assert.deepEqual(await counts(), { occurrences: 0, outbound: 0, marked: 0 });
      });
      await t.test(
        'original and promised due times retain PostgreSQL precision despite late processing',
        async () => {
          await reset();
          const item = await seed();
          await admin.query(
            "UPDATE reminders SET due_at=date_trunc('second',clock_timestamp())-interval '1 hour'+interval '123456 microseconds' WHERE id=$1",
            [item.reminderId],
          );
          await scheduler.sweep();
          const row = (
            await worker.query(`SELECT r.due_at=o.original_due_at AS original,
        o.promised_due_at=r.due_at AS promised,m.available_at=r.due_at AS available,
        o.created_at>o.original_due_at AS late FROM reminders r JOIN reminder_occurrences o ON o.reminder_id=r.id
        JOIN outbound_messages m ON m.occurrence_id=o.id`)
          ).rows[0];
          assert.deepEqual(row, { original: true, promised: true, available: true, late: true });
        },
      );
      await t.test(
        'failure in outbound creation or final marker rolls back the entire sweep',
        async () => {
          for (const [table, operation] of [
            ['outbound_messages', 'INSERT'],
            ['reminders', 'UPDATE'],
          ]) {
            await reset();
            await seed();
            await admin.query(`CREATE FUNCTION fail_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
          CREATE TRIGGER fail_schedule BEFORE ${operation} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_schedule()`);
            try {
              await assert.rejects(scheduler.sweep(), /injected/);
            } finally {
              await admin.query(
                `DROP TRIGGER fail_schedule ON ${table}; DROP FUNCTION fail_schedule()`,
              );
            }
            assert.deepEqual(await counts(), { occurrences: 0, outbound: 0, marked: 0 });
            assert.equal((await new ReminderScheduler(worker).sweep()).materialized, 1);
          }
        },
      );
      await t.test(
        'batch size is globally bounded; busy users do not block other users',
        async () => {
          await reset();
          const locked = await seed();
          await seed('bob');
          await seed('carol');
          const held = await admin.connect();
          try {
            await held.query('BEGIN');
            await held.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [locked.userId]);
            assert.equal((await scheduler.sweep(1)).materialized, 1);
            assert.equal((await scheduler.sweep(1)).materialized, 1);
            assert.equal((await scheduler.sweep(1)).examined, 0);
            // Cancellation committed before the next sweep excludes this reminder.
            await held.query("UPDATE reminders SET status='cancelled' WHERE id=$1", [
              locked.reminderId,
            ]);
            await held.query('COMMIT');
          } finally {
            await held.query('ROLLBACK');
            held.release();
          }
          assert.equal((await scheduler.sweep()).examined, 0);
          await seed('bob');
          await seed('bob');
          await seed('bob');
          assert.equal((await scheduler.sweep(2)).examined, 2);
          assert.equal((await scheduler.sweep(2)).examined, 1);
          for (const limit of [0, -1, 501, 1.5, NaN])
            await assert.rejects(scheduler.sweep(limit), /limit/);
        },
      );
      await t.test(
        'revoked/replaced consent and changed/unconfirmed timezones suppress stale work',
        async () => {
          for (const mutation of [
            'paused=true,consent_at=NULL,consent_version=NULL',
            'consent_at=clock_timestamp()',
            "consent_version='obsolete'",
            "timezone='UTC',timezone_confirmed_at=clock_timestamp()",
            "pending_timezone='UTC'",
            'timezone=NULL,timezone_confirmed_at=NULL',
          ]) {
            await reset();
            await seed();
            await admin.query(`UPDATE users SET ${mutation}`);
            assert.deepEqual(await scheduler.sweep(), {
              examined: 1,
              materialized: 1,
              suppressed: 1,
            });
            assert.deepEqual(await statuses(), [
              { occurrence: 'suppressed', message: 'suppressed' },
            ]);
            assert.equal(
              (await worker.query('SELECT suppression_reason FROM outbound_messages')).rows[0]
                .suppression_reason,
              'identity_changed',
            );
          }
        },
      );
      await t.test(
        'STOP after scheduling suppresses both rows and re-consent/replay cannot revive them',
        async () => {
          await reset();
          const item = await seed();
          await scheduler.sweep();
          await inbound('alice', 'STOP');
          await new IdentityProcessor(worker).processNext();
          assert.deepEqual(await statuses(), [{ occurrence: 'suppressed', message: 'suppressed' }]);
          await admin.query(
            'UPDATE users SET paused=false,consent_version=$1,consent_at=clock_timestamp()',
            [CONSENT_VERSION],
          );
          await admin.query('UPDATE reminders SET scheduled_at=NULL WHERE id=$1', [
            item.reminderId,
          ]);
          await scheduler.sweep();
          assert.deepEqual(await statuses(), [{ occurrence: 'suppressed', message: 'suppressed' }]);
          assert.deepEqual(await counts(), { occurrences: 1, outbound: 1, marked: 1 });
        },
      );
      await t.test(
        'pending timezone change invalidates queued reminders in the onboarding transaction',
        async () => {
          await reset();
          await seed();
          await scheduler.sweep();
          await inbound('alice', 'TIMEZONE UTC');
          await new IdentityProcessor(worker).processNext();
          assert.deepEqual(await statuses(), [{ occurrence: 'suppressed', message: 'suppressed' }]);
        },
      );
      await t.test(
        'STOP and scheduling serialize without a network transaction or a stale queued reminder',
        async () => {
          await reset();
          await seed();
          const gate = await admin.connect(),
            gateName = `gate_${suffix}`;
          await gate.query('SELECT pg_advisory_lock(hashtext($1))', [gateName]);
          await admin.query(`CREATE FUNCTION hold_schedule() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('${gateName}')); RETURN NEW; END $$;
        CREATE TRIGGER hold_schedule BEFORE INSERT ON outbound_messages FOR EACH ROW EXECUTE FUNCTION hold_schedule()`);
          const sweeping = scheduler.sweep();
          let stopping: Promise<unknown> | undefined;
          try {
            let blocked = false;
            for (let i = 0; i < 100; i++) {
              blocked = !!(
                await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
                  [appName],
                )
              ).rowCount;
              if (blocked) break;
              await setTimeout(10);
            }
            assert.equal(
              blocked,
              true,
              'sweeper reached controlled insert while holding user lock',
            );
            await inbound('alice', 'STOP');
            stopping = new IdentityProcessor(worker).processNext();
          } finally {
            await gate.query('SELECT pg_advisory_unlock(hashtext($1))', [gateName]);
            gate.release();
            await sweeping;
            await stopping;
            await admin.query(
              'DROP TRIGGER hold_schedule ON outbound_messages; DROP FUNCTION hold_schedule()',
            );
          }
          assert.deepEqual(await statuses(), [{ occurrence: 'suppressed', message: 'suppressed' }]);
        },
      );
      await t.test(
        'scheduling is local: paused spend and closed messaging window do not drop due work',
        async () => {
          await reset();
          await seed();
          await admin.query('UPDATE usage_policy SET enabled=false');
          await admin.query(
            "UPDATE users SET window_expires_at=clock_timestamp()-interval '1 hour'",
          );
          assert.equal((await scheduler.sweep()).materialized, 1);
          assert.deepEqual(await statuses(), [{ occurrence: 'pending', message: 'pending' }]);
          assert.equal(
            (await worker.query('SELECT count(*)::int AS n FROM whatsapp_attempts')).rows[0].n,
            0,
          );
          assert.equal(
            (await worker.query('SELECT count(*)::int AS n FROM usage_reservations')).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'shutdown during materialization rolls back both records and the scheduling marker',
        async () => {
          await reset();
          await seed();
          const gate = await admin.connect(),
            gateName = `abort_${suffix}`;
          const controller = new AbortController();
          await gate.query('SELECT pg_advisory_lock(hashtext($1))', [gateName]);
          await admin.query(`CREATE FUNCTION hold_abort() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('${gateName}')); RETURN NEW; END $$;
        CREATE TRIGGER hold_abort BEFORE INSERT ON outbound_messages FOR EACH ROW EXECUTE FUNCTION hold_abort()`);
          const sweeping = scheduler.sweep(100, controller.signal);
          // Attach rejection handling immediately; shutdown is expected to roll back, not finish.
          const rejected = assert.rejects(sweeping, /cancelled/);
          try {
            let blocked = false;
            for (let i = 0; i < 100; i++) {
              blocked = !!(
                await admin.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
                  [appName],
                )
              ).rowCount;
              if (blocked) break;
              await setTimeout(10);
            }
            assert.equal(blocked, true);
            controller.abort();
          } finally {
            controller.abort();
            await gate.query('SELECT pg_advisory_unlock(hashtext($1))', [gateName]);
            gate.release();
            await rejected;
            await admin.query(
              'DROP TRIGGER hold_abort ON outbound_messages; DROP FUNCTION hold_abort()',
            );
          }
          assert.deepEqual(await counts(), { occurrences: 0, outbound: 0, marked: 0 });
          assert.equal((await scheduler.sweep()).materialized, 1);
        },
      );
      await t.test(
        'new rows use forced RLS and matching owner references; tenants cannot enqueue or mutate',
        async () => {
          await reset();
          const alice = await seed(),
            bob = await seed('bob');
          await scheduler.sweep();
          for (const table of ['reminder_occurrences', 'outbound_messages']) {
            const flags = (
              await admin.query(
                'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
                [`${schema}.${table}`],
              )
            ).rows[0];
            assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
            await withTenant(tenant, alice.userId, async (client) => {
              const rows = await client.query(`SELECT user_id FROM ${table}`);
              assert.equal(rows.rowCount, 1);
              assert.equal(rows.rows[0].user_id, alice.userId);
            });
            assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
            await assert.rejects(
              withTenant(tenant, alice.userId, (client) =>
                client.query(`UPDATE ${table} SET status='pending'`),
              ),
              /permission denied/,
            );
            await assert.rejects(ingress.query(`SELECT * FROM ${table}`), /permission denied/);
            await assert.rejects(worker.query(`DELETE FROM ${table}`), /permission denied/);
          }
          await assert.rejects(
            worker.query(
              `INSERT INTO reminder_occurrences(user_id,reminder_id,schedule_version,original_due_at,promised_due_at,status)
        VALUES($1,$2,2,now(),now(),'pending')`,
              [alice.userId, bob.reminderId],
            ),
            /foreign key/,
          );
          const occurrence = (
            await worker.query(
              `INSERT INTO reminder_occurrences(user_id,reminder_id,schedule_version,original_due_at,promised_due_at,status)
        VALUES($1,$2,2,now(),now(),'pending') RETURNING id`,
              [bob.userId, bob.reminderId],
            )
          ).rows[0].id;
          await assert.rejects(
            worker.query(
              `INSERT INTO outbound_messages(user_id,occurrence_id,body,available_at,consent_grant_at,timezone_confirmed_at,timezone,status)
        VALUES($1,$2,'forged',now(),now(),now(),'UTC','pending')`,
              [alice.userId, occurrence],
            ),
            /foreign key/,
          );
          await assert.rejects(
            worker.query('UPDATE reminders SET due_at=now()'),
            /permission denied/,
          );
          await assert.rejects(
            worker.query("UPDATE outbound_messages SET body='forged'"),
            /permission denied/,
          );
        },
      );
      await t.test(
        'pre-cancelled sweep opens no work and the execution-to-scheduling path becomes due once',
        async () => {
          await reset();
          await seed();
          assert.deepEqual(await scheduler.sweep(100, AbortSignal.abort()), {
            examined: 0,
            materialized: 0,
            suppressed: 0,
          });
          assert.deepEqual(await counts(), { occurrences: 0, outbound: 0, marked: 0 });
          await reset();
          const due = new Date(Date.now() + 2000).toISOString();
          await seed('alice', due, true);
          assert.equal((await scheduler.sweep()).materialized, 0);
          await setTimeout(Math.max(0, Date.parse(due) - Date.now()) + 50);
          assert.equal((await scheduler.sweep()).materialized, 1);
          assert.equal((await scheduler.sweep()).materialized, 0);
          assert.equal(
            (await worker.query('SELECT count(*)::int AS n FROM action_receipts')).rows[0].n,
            1,
          );
          assert.equal(
            (await worker.query('SELECT count(*)::int AS n FROM reply_intents')).rows[0].n,
            1,
          );
        },
      );
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const role of roles) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  },
);
