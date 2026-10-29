import { ensureReminderControl } from '../../src/modules/reminders/controls.js';
import { applyPreferenceCommand } from '../../src/modules/reminders/preferences.js';
import { preferenceCommand } from '../../src/modules/reminders/delivery-time.js';
import { ReminderSender } from '../../src/modules/delivery/reminder-sender.js';
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
  'delivery preferences and promises under restricted database logins',
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
        VALUES('12345',$1,$2,$3,'America/Toronto',$3) ON CONFLICT DO NOTHING`,
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

      const future = new Date(Date.now() + 86400000 * 3);
      future.setUTCHours(14, 0, 0, 0);
      const until = new Date(future.getTime() + 86400000 * 28).toISOString().slice(0, 10);
      const make = async (who = 'alice') => {
        const item = await seed(who, future.toISOString());
        const client = await worker.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [item.userId]);
          const reference = await ensureReminderControl(client, item.userId, item.reminderId);
          await client.query('COMMIT');
          return { ...item, reference };
        } finally {
          client.release();
        }
      };
      const run = async (body: string, who = 'alice') => {
        const eventId = await inbound(who, body);
        assert.equal((await new IdentityProcessor(worker).processNext())?.eventId, eventId);
        return {
          eventId,
          ...(
            await worker.query('SELECT * FROM delivery_preference_actions WHERE event_id=$1', [
              eventId,
            ])
          ).rows[0],
          identity: (
            await worker.query('SELECT * FROM identity_results WHERE event_id=$1', [eventId])
          ).rows[0],
        };
      };
      const current = async (id: string) =>
        (await worker.query('SELECT * FROM reminders WHERE id=$1', [id])).rows[0];
      const latest = async () =>
        (
          await worker.query(
            "SELECT * FROM delivery_choices WHERE status='pending' ORDER BY expires_at DESC LIMIT 1",
          )
        ).rows[0];
      const ref = async (id: string) =>
        (
          await worker.query(
            'SELECT c.reference FROM reminder_controls c JOIN reminders r ON r.id=c.reminder_id AND r.schedule_version=c.schedule_version WHERE r.id=$1',
            [id],
          )
        ).rows[0].reference;
      const propose = async (reference: string, mode = 'DIGEST') => {
        assert.equal((await run(`DELIVER ${reference} ${mode}`)).outcome, 'proposed');
        return latest();
      };
      const setup = async () => {
        const a = await make();
        await run('DIGEST AT 09:00');
        await run('QUIET 22:00-08:00');
        return a;
      };
      const confirm = async (reference: string) => run(`CONFIRM DELIVERY ${reference}`);

      await t.test(
        'preferences are explicit, validated, readable and never modify exact reminders',
        async () => {
          await reset();
          const a = await make();
          const before = await current(a.reminderId);
          assert.match((await run('PREFERENCES')).reply_text, /digest off; quiet hours off/);
          assert.equal((await run('DIGEST AT 24:00')).outcome, 'invalid');
          assert.equal((await run('QUIET 00:00-00:00')).outcome, 'invalid');
          assert.match((await run('DIGEST AT 09:00')).reply_text, /Exact-time reminders bypass/);
          assert.match((await run('QUIET 22:00-08:00')).reply_text, /22:00-08:00/);
          assert.deepEqual(await current(a.reminderId), before);
          assert.equal((await worker.query('SELECT * FROM delivery_choices')).rowCount, 0);
          await run('DIGEST OFF');
          await run('QUIET OFF');
          assert.match((await run('PREFERENCES')).reply_text, /digest off; quiet hours off/);
          assert.equal((await run(`DELIVER ${a.reference} DIGEST`)).outcome, 'invalid');
        },
      );
      await t.test(
        'preview and confirmation retain original due, immutable promise and refreshed controls',
        async () => {
          await reset();
          const a = await setup();
          const before = await current(a.reminderId);
          const p = await propose(a.reference);
          assert.equal((await current(a.reminderId)).delivery_mode, 'immediate');
          const confirmed = await confirm(p.reference);
          assert.equal(confirmed.outcome, 'confirmed');
          const r = await current(a.reminderId);
          assert.equal(r.delivery_mode, 'digest');
          assert.deepEqual(r.due_at, before.due_at);
          assert.deepEqual(r.promised_due_at, p.promised_due_at);
          assert.equal(r.schedule_version, 2);
          assert.notEqual(await ref(a.reminderId), a.reference);
          assert.match(confirmed.reply_text, /Future preference edits will not move/);
          await run('DIGEST OFF');
          await run('QUIET OFF');
          assert.deepEqual(await current(a.reminderId), r);
          assert.equal((await confirm(p.reference)).outcome, 'stale');
          const exact = await propose(await ref(a.reminderId), 'EXACT');
          assert.equal((await confirm(exact.reference)).outcome, 'confirmed');
          assert.equal((await current(a.reminderId)).promised_due_at, null);
        },
      );
      await t.test(
        'changed preferences, superseded, expired and foreign previews cannot apply',
        async () => {
          await reset();
          const a = await setup();
          await make('bob');
          let p = await propose(a.reference);
          assert.equal((await run(`CONFIRM DELIVERY ${p.reference}`, 'bob')).outcome, 'stale');
          await run('DIGEST AT 10:00');
          assert.equal((await confirm(p.reference)).outcome, 'stale');
          p = await propose(a.reference);
          const next = await propose(a.reference, 'QUIET');
          assert.equal((await confirm(p.reference)).outcome, 'stale');
          await admin.query(
            "UPDATE delivery_choices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [next.id],
          );
          assert.equal((await confirm(next.reference)).outcome, 'stale');
          assert.equal((await current(a.reminderId)).delivery_mode, 'immediate');
        },
      );
      await t.test(
        'competing confirmations consume once and event replay returns the same receipt',
        async () => {
          await reset();
          const a = await setup();
          const p = await propose(a.reference);
          const events = await Promise.all([
            inbound('alice', 'confirm'),
            inbound('alice', 'confirm'),
          ]);
          const apply = async (eventId: string) => {
            const c = await worker.connect();
            try {
              await c.query('BEGIN');
              const reply = await applyPreferenceCommand(c, eventId, a.userId, {
                action: 'confirm',
                reference: p.reference,
              });
              await c.query('COMMIT');
              return reply;
            } finally {
              c.release();
            }
          };
          const replies = await Promise.all(events.map(apply));
          assert.equal(replies.filter((x) => x.startsWith('Confirmed')).length, 1);
          assert.equal((await current(a.reminderId)).schedule_version, 2);
          assert.equal(await apply(events[0]!), replies[0]);
          assert.equal(
            (
              await worker.query(
                "SELECT * FROM delivery_preference_actions WHERE outcome='confirmed'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'lease failure rolls back promise, choice, control invalidation and receipt',
        async () => {
          await reset();
          const a = await setup();
          const p = await propose(a.reference);
          const eventId = await inbound('alice', `CONFIRM DELIVERY ${p.reference}`);
          const queue = new WorkQueue(worker);
          const lease = (await queue.claim('onboarding', 'test'))!;
          await assert.rejects(
            queue.commit(lease, async (client) => {
              await new IdentityProcessor(worker).apply(client, eventId);
              await admin.query(
                "UPDATE work_outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",
                [eventId],
              );
              return { nextStage: null };
            }),
          );
          assert.equal((await current(a.reminderId)).delivery_mode, 'immediate');
          assert.equal((await latest()).id, p.id);
          assert.equal(
            (
              await worker.query('SELECT 1 FROM delivery_preference_actions WHERE event_id=$1', [
                eventId,
              ])
            ).rowCount,
            0,
          );
          assert.equal(await ref(a.reminderId), a.reference);
        },
      );
      await t.test(
        'STOP and pending timezone changes invalidate preferences and previews',
        async () => {
          for (const control of ['STOP', 'TIMEZONE Europe/Paris']) {
            await reset();
            const a = await setup();
            const p = await propose(a.reference);
            await run(control);
            assert.equal(
              (
                await worker.query('SELECT active FROM delivery_preferences WHERE user_id=$1', [
                  a.userId,
                ])
              ).rows[0].active,
              false,
            );
            assert.equal(
              (await worker.query('SELECT status FROM delivery_choices WHERE id=$1', [p.id]))
                .rows[0].status,
              'invalidated',
            );
            const result = await confirm(p.reference);
            assert.equal(result.outcome, undefined);
            assert.equal((await current(a.reminderId)).delivery_mode, 'immediate');
          }
        },
      );
      await t.test(
        'cancel and snooze invalidate previews; snooze resets a deferred promise to exact time',
        async () => {
          await reset();
          const a = await setup();
          let p = await propose(a.reference);
          await run(`SNOOZE ${a.reference} 10m`);
          assert.equal((await confirm(p.reference)).outcome, 'stale');
          p = await propose(await ref(a.reminderId));
          await confirm(p.reference);
          const snooze = await run(`SNOOZE ${await ref(a.reminderId)} 20m`);
          assert.match(snooze.identity.reply_text, /exact-time delivery/);
          const r = await current(a.reminderId);
          assert.equal(r.delivery_mode, 'immediate');
          assert.equal(r.promised_due_at, null);
          assert.equal(r.delivery_choice_id, null);
          p = await propose(await ref(a.reminderId));
          await run(`CANCEL ${await ref(a.reminderId)}`);
          assert.equal((await confirm(p.reference)).outcome, 'stale');
        },
      );
      await t.test(
        'recurrence cannot silently inherit or overwrite a deferred delivery promise',
        async () => {
          await reset();
          const a = await setup();
          const repeat = await run(`REPEAT ${a.reference} DAILY UNTIL ${until}`);
          const series = (await worker.query('SELECT * FROM reminder_series')).rows[0];
          assert.ok(series);
          const p = await propose(a.reference);
          await confirm(p.reference);
          await run(`CONFIRM REPEAT ${series.reference}`);
          assert.equal((await current(a.reminderId)).series_id, null);
          await run(`REPEAT ${await ref(a.reminderId)} DAILY UNTIL ${until}`);
          assert.equal((await worker.query('SELECT * FROM reminder_series')).rowCount, 1);
        },
      );
      await t.test(
        'confirmation rechecks expiry and original due after waiting for a reminder lock',
        async () => {
          for (const boundary of ['expiry', 'due']) {
            await reset();
            const a = await setup();
            if (boundary === 'due')
              await admin.query(
                "UPDATE reminders SET due_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
                [a.reminderId],
              );
            const p = await propose(a.reference);
            if (boundary === 'expiry')
              await admin.query(
                "UPDATE delivery_choices SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
                [p.id],
              );
            const eventId = await inbound('alice', 'confirmation');
            const holder = await admin.connect(),
              waiter = await worker.connect();
            let pending: Promise<string> | undefined;
            try {
              await holder.query('BEGIN');
              await holder.query('SELECT id FROM reminders WHERE id=$1 FOR UPDATE', [a.reminderId]);
              await waiter.query('BEGIN');
              const pid = (await waiter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
              pending = applyPreferenceCommand(waiter, eventId, a.userId, {
                action: 'confirm',
                reference: p.reference,
              });
              let waiting = false;
              for (let i = 0; i < 100; i++) {
                waiting = (
                  await admin.query(
                    "SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1",
                    [pid],
                  )
                ).rows[0]?.waiting;
                if (waiting) break;
                await setTimeout(10);
              }
              assert.equal(waiting, true);
              await setTimeout(2100);
              await holder.query('COMMIT');
              assert.match(await pending, /stale/);
              await waiter.query('COMMIT');
              assert.equal((await current(a.reminderId)).delivery_mode, 'immediate');
            } finally {
              await holder.query('ROLLBACK');
              await pending?.catch(() => {});
              await waiter.query('ROLLBACK');
              holder.release();
              waiter.release();
            }
          }
        },
      );
      await t.test(
        'confirmed new timezone resets preferences instead of transplanting wall-clock settings',
        async () => {
          await reset();
          const a = await setup();
          await run('TIMEZONE Europe/Paris');
          const u = (await worker.query('SELECT * FROM users WHERE id=$1', [a.userId])).rows[0];
          await run(`CONFIRM TIMEZONE ${u.timezone_token}`);
          const shown = await run('PREFERENCES');
          assert.match(shown.reply_text, /Europe\/Paris: daily digest off; quiet hours off/);
        },
      );
      await t.test(
        'quiet-only confirmation defers overnight and retains the exact original instant',
        async () => {
          await reset();
          const a = await setup();
          const due = new Date(future);
          due.setUTCHours(4, 0, 0, 0);
          await admin.query('UPDATE reminders SET due_at=$2 WHERE id=$1', [
            a.reminderId,
            due.toISOString(),
          ]);
          const p = await propose(a.reference, 'QUIET');
          assert.ok(p.promised_due_at > p.original_due_at);
          assert.equal((await confirm(p.reference)).outcome, 'confirmed');
          const r = await current(a.reminderId);
          assert.equal(r.delivery_mode, 'quiet');
          assert.deepEqual(r.due_at, due);
          assert.deepEqual(r.promised_due_at, p.promised_due_at);
          assert.equal(
            new Intl.DateTimeFormat('en-CA', {
              timeZone: 'America/Toronto',
              hour: '2-digit',
              hourCycle: 'h23',
            }).format(r.promised_due_at),
            '08',
          );
        },
      );
      // Simulate historical confirmed work without sleeps. This administrative fixture shifts both
      // original and promised instants together; production workers cannot rewrite the choice.
      const historical = async (id: string, promiseFuture = true) => {
        await admin.query(
          `UPDATE reminders SET due_at=clock_timestamp()-interval '1 hour',promised_due_at=clock_timestamp()+$2*interval '1 hour' WHERE id=$1`,
          [id, promiseFuture ? 1 : -0.5],
        );
      };
      await t.test(
        'scheduler persists promised availability, exact bypass and replay without duplicate intents',
        async () => {
          await reset();
          const a = await setup();
          const p = await propose(a.reference);
          await confirm(p.reference);
          await historical(a.reminderId);
          await Promise.all([scheduler.sweep(), scheduler.sweep()]);
          const deferred = (await worker.query('SELECT * FROM outbound_messages')).rows[0];
          const occurrence = (await worker.query('SELECT * FROM reminder_occurrences')).rows[0];
          assert.equal(occurrence.delivery_mode, 'digest');
          assert.ok(occurrence.promised_due_at > occurrence.original_due_at);
          assert.deepEqual(deferred.available_at, occurrence.promised_due_at);
          assert.match(deferred.body, /Digest entry:/);
          assert.equal((await worker.query('SELECT * FROM outbound_messages')).rowCount, 1);
          const exact = await seed('alice');
          await scheduler.sweep();
          const immediate = (
            await worker.query('SELECT * FROM reminder_occurrences WHERE reminder_id=$1', [
              exact.reminderId,
            ])
          ).rows[0];
          assert.deepEqual(immediate.promised_due_at, immediate.original_due_at);
          const currentRef = await ref(a.reminderId);
          assert.equal((await run(`DELIVER ${currentRef} EXACT`)).outcome, 'stale');
        },
      );
      await t.test(
        'sender refuses early digest, lets due exact reminder pass, and later sends the frozen entry',
        async () => {
          await reset();
          const a = await make('11111');
          await run('DIGEST AT 09:00', '11111');
          await run(`DELIVER ${a.reference} DIGEST`, '11111');
          const p = await latest();
          await run(`CONFIRM DELIVERY ${p.reference}`, '11111');
          await historical(a.reminderId);
          const b = await seed('11111');
          await scheduler.sweep();
          await admin.query('UPDATE usage_policy SET enabled=true');
          await admin.query(
            "UPDATE users SET window_expires_at=clock_timestamp()+interval '1 hour'",
          );
          let calls = 0;
          const sender = new ReminderSender(
            worker,
            {
              async send() {
                calls++;
                return { state: 'accepted' as const, providerMessageId: `wamid.test.${calls}` };
              },
            },
            { enabled: true, phoneNumberId: '12345', recipients: ['11111'], timeoutMs: 1000 },
          );
          const outbound = async (id: string) =>
            (
              await worker.query(
                'SELECT m.* FROM outbound_messages m JOIN reminder_occurrences o ON o.id=m.occurrence_id WHERE o.reminder_id=$1',
                [id],
              )
            ).rows[0];
          const deferred = await outbound(a.reminderId),
            exact = await outbound(b.reminderId);
          await assert.rejects(sender.send(deferred.id));
          assert.equal(calls, 0);
          assert.equal((await sender.send(exact.id)).state, 'accepted');
          assert.equal(calls, 1);
          await admin.query(
            "UPDATE outbound_messages SET available_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [deferred.id],
          );
          assert.equal((await sender.send(deferred.id)).state, 'accepted');
          assert.equal(calls, 2);
          assert.equal((await sender.send(deferred.id)).state, 'accepted');
          assert.equal(calls, 2);
        },
      );
      await t.test(
        'STOP suppresses materialized deferred delivery and cannot revive it',
        async () => {
          await reset();
          const a = await setup();
          const p = await propose(a.reference);
          await confirm(p.reference);
          await historical(a.reminderId);
          await scheduler.sweep();
          await run('STOP');
          await scheduler.sweep();
          assert.equal(
            (await worker.query('SELECT status FROM outbound_messages')).rows[0].status,
            'suppressed',
          );
          assert.equal(
            (await worker.query('SELECT status FROM reminder_occurrences')).rows[0].status,
            'suppressed',
          );
        },
      );
      await t.test(
        'new tables enforce owner isolation, immutable previews/receipts and promise constraints',
        async () => {
          await reset();
          const a = await setup();
          const p = await propose(a.reference);
          const b = await make('bob');
          for (const table of [
            'delivery_preferences',
            'delivery_choices',
            'delivery_preference_actions',
          ]) {
            const flags = (
              await admin.query(
                'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
                [table],
              )
            ).rows[0];
            assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
            assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
            assert.equal(
              await withTenant(
                tenant,
                b.userId,
                async (c) => (await c.query(`SELECT * FROM ${table}`)).rowCount,
              ),
              0,
            );
            await assert.rejects(ingress.query(`SELECT * FROM ${table}`), /permission denied/);
          }
          await assert.rejects(
            worker.query('UPDATE delivery_choices SET promised_due_at=clock_timestamp()'),
            /permission denied/,
          );
          await assert.rejects(
            worker.query("UPDATE delivery_preference_actions SET reply_text='forged'"),
            /permission denied/,
          );
          await assert.rejects(
            tenant.query('UPDATE delivery_preferences SET digest_minute=0'),
            /permission denied/,
          );
          await assert.rejects(
            worker.query(
              "UPDATE reminders SET delivery_mode='digest',promised_due_at=due_at+interval '1 hour',delivery_choice_id=$1 WHERE id=$2",
              [p.id, b.reminderId],
            ),
            /foreign key/,
          );
          await assert.rejects(
            worker.query(
              "UPDATE reminders SET promised_due_at=due_at+interval '1 hour' WHERE id=$1",
              [a.reminderId],
            ),
            /check constraint/,
          );
          await assert.rejects(
            worker.query(
              "INSERT INTO delivery_preference_actions(event_id,user_id,outcome,reply_text) VALUES($1,$2,'shown','forged')",
              [b.eventId, a.userId],
            ),
            /owner mismatch/,
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
