import { ensureReminderControl } from '../../src/modules/reminders/controls.js';
import { applySeriesCommand } from '../../src/modules/reminders/series.js';
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
  'finite recurring reminders under restricted database logins',
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
        const result = await new IdentityProcessor(worker).processNext();
        assert.equal(result?.eventId, eventId);
        assert.notEqual(result?.disposition, 'ready');
        const action = (
          await worker.query('SELECT * FROM reminder_series_actions WHERE event_id=$1', [eventId])
        ).rows[0];
        const identity = (
          await worker.query('SELECT * FROM identity_results WHERE event_id=$1', [eventId])
        ).rows[0];
        assert.equal(
          (await worker.query('SELECT 1 FROM action_plans WHERE event_id=$1', [eventId])).rowCount,
          0,
        );
        return { eventId, action, identity };
      };
      const propose = async (reference: string, who = 'alice', cadence = 'DAILY') => {
        const result = await run(`REPEAT ${reference} ${cadence} UNTIL ${until}`, who);
        assert.equal(result.action.outcome, 'proposed');
        return (
          await worker.query(
            'SELECT *,until_date::text AS until_date FROM reminder_series WHERE id=$1',
            [result.action.series_id],
          )
        ).rows[0];
      };
      const activate = async (who = 'alice', cadence = 'DAILY') => {
        const item = await make(who),
          series = await propose(item.reference, who, cadence);
        const result = await run(`CONFIRM REPEAT ${series.reference}`, who);
        assert.equal(result.action.outcome, 'confirmed');
        return { ...item, series, event: result.eventId };
      };

      await t.test(
        'preview has five exact dates and DST policy; confirmation saves one finite schedule atomically',
        async () => {
          await reset();
          const item = await make(),
            series = await propose(item.reference);
          assert.equal((await worker.query('SELECT 1 FROM reminders')).rowCount, 1);
          const proposal = (
            await worker.query(
              "SELECT reply_text FROM reminder_series_actions WHERE outcome='proposed'",
            )
          ).rows[0].reply_text;
          assert.match(proposal, /Clock gaps shift forward/);
          assert.match(proposal, /Next 5:/);
          assert.match(proposal, /CONFIRM REPEAT/);
          assert.ok(series.tzdb_version);
          const result = await run(`CONFIRM REPEAT ${series.reference}`);
          assert.equal(result.action.outcome, 'confirmed');
          assert.match(result.identity.reply_text, new RegExp(until));
          const rows = (
            await worker.query(
              'SELECT *,series_local_date::text AS local_date FROM reminders ORDER BY due_at',
            )
          ).rows;
          assert.equal(rows.length, series.schedule.length);
          assert.equal(rows[0].id, item.reminderId);
          assert.equal(rows[0].schedule_version, 2);
          assert.deepEqual(
            rows.map((r) => r.due_at.toISOString()),
            series.schedule.map((s: { instant: string }) => new Date(s.instant).toISOString()),
          );
          assert.deepEqual(
            rows.map((r) => r.local_date),
            series.schedule.map((s: { localDate: string }) => s.localDate),
          );
          assert.ok(rows.every((r) => r.series_id === series.id && r.user_id === item.userId));
          assert.equal(new Set(rows.map((r) => r.action_key)).size, rows.length);
          assert.ok(
            (
              await worker.query(
                'SELECT invalidated_at FROM reminder_controls WHERE reference=$1',
                [item.reference],
              )
            ).rows[0].invalidated_at,
          );
          await run(`CANCEL ${item.reference}`);
          assert.equal(
            (await worker.query('SELECT status FROM reminders WHERE id=$1', [item.reminderId]))
              .rows[0].status,
            'pending',
          );
        },
      );
      await t.test(
        'weekly preview and confirmation use the same five dates; original plus children survive replay',
        async () => {
          await reset();
          const item = await activate('alice', 'WEEKLY');
          const before = (
            await worker.query('SELECT id,due_at,series_local_date FROM reminders ORDER BY due_at')
          ).rows;
          assert.equal(before.length, 5);
          const client = await worker.connect();
          try {
            await client.query('BEGIN');
            const reply = await applySeriesCommand(client, item.event, item.userId, {
              action: 'confirm',
              reference: item.series.reference,
            });
            assert.match(reply, /Saved 5 weekly occurrences/);
            await client.query('COMMIT');
          } finally {
            client.release();
          }
          assert.equal(
            (await run(`CONFIRM REPEAT ${item.series.reference}`)).action.outcome,
            'stale',
          );
          assert.deepEqual(
            (
              await worker.query(
                'SELECT id,due_at,series_local_date FROM reminders ORDER BY due_at',
              )
            ).rows,
            before,
          );
          await assert.rejects(
            worker.query('UPDATE reminder_series SET schedule=$1', [[]]),
            /permission denied/,
          );
        },
      );
      await t.test('competing proposals can activate the source only once', async () => {
        await reset();
        const item = await make(),
          a = await propose(item.reference),
          b = await propose(item.reference, 'alice', 'WEEKLY');
        const events = [
          await inbound('alice', `CONFIRM REPEAT ${a.reference}`),
          await inbound('alice', `CONFIRM REPEAT ${b.reference}`),
        ];
        await Promise.all(
          [a, b].map(async (series, i) => {
            const client = await worker.connect();
            try {
              await client.query('BEGIN');
              await applySeriesCommand(client, events[i]!, item.userId, {
                action: 'confirm',
                reference: series.reference,
              });
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          }),
        );
        assert.equal(
          (await worker.query("SELECT 1 FROM reminder_series WHERE status='active'")).rowCount,
          1,
        );
        assert.deepEqual(
          (
            await worker.query(
              'SELECT outcome FROM reminder_series_actions WHERE event_id=ANY($1::uuid[]) ORDER BY outcome',
              [events],
            )
          ).rows.map((r) => r.outcome),
          ['confirmed', 'stale'],
        );
      });
      await t.test(
        'expired, changed, already due and foreign proposals never activate',
        async () => {
          for (const scenario of ['expired', 'snoozed', 'cancelled', 'due', 'foreign']) {
            await reset();
            const item = await make(),
              series = await propose(item.reference);
            if (scenario === 'expired')
              await admin.query(
                "UPDATE reminder_series SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
                [series.id],
              );
            if (scenario === 'snoozed') await run(`SNOOZE ${item.reference} 10m`);
            if (scenario === 'cancelled') await run(`CANCEL ${item.reference}`);
            if (scenario === 'due')
              await admin.query(
                "UPDATE reminders SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
                [item.reminderId],
              );
            if (scenario === 'foreign') await make('bob');
            const result = await run(
              `CONFIRM REPEAT ${series.reference}`,
              scenario === 'foreign' ? 'bob' : 'alice',
            );
            assert.equal(result.action.outcome, 'stale');
            assert.equal(result.action.series_id, null);
            assert.equal(
              (await worker.query('SELECT 1 FROM reminders WHERE series_id IS NOT NULL')).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'bad rules are handled without a model and proposal cancellation preserves the original reminder',
        async () => {
          await reset();
          const item = await make();
          for (const body of [
            `REPEAT ${item.reference} MONTHLY UNTIL ${until}`,
            `REPEAT ${item.reference} DAILY UNTIL 2030-02-30`,
            `REPEAT ${item.reference} DAILY UNTIL 9999-12-31`,
          ])
            assert.equal((await run(body)).action.outcome, 'invalid');
          const series = await propose(item.reference);
          assert.equal(
            (await run(`CANCEL SERIES ${series.reference}`)).action.outcome,
            'cancelled',
          );
          assert.equal(
            (await worker.query('SELECT status FROM reminders WHERE id=$1', [item.reminderId]))
              .rows[0].status,
            'pending',
          );
          assert.equal((await run(`CONFIRM REPEAT ${series.reference}`)).action.outcome, 'stale');
        },
      );
      await t.test(
        'confirm failure and lost lease roll back children, linkage, controls and series receipt',
        async () => {
          for (const expired of [false, true]) {
            await reset();
            const item = await make(),
              series = await propose(item.reference);
            const eventId = await inbound('alice', `CONFIRM REPEAT ${series.reference}`);
            const queue = new WorkQueue(worker),
              lease = await queue.claim('onboarding', 'series-test', expired ? 1000 : 30000);
            assert.ok(lease);
            await assert.rejects(
              queue.commit(lease, async (client) => {
                const result = await new IdentityProcessor(worker).apply(client, eventId);
                if (!expired) throw new Error('injected rollback');
                await client.query('SELECT pg_sleep(1.1)');
                return result;
              }),
            );
            assert.equal((await worker.query('SELECT 1 FROM reminders')).rowCount, 1);
            const root = (await worker.query('SELECT * FROM reminders')).rows[0];
            assert.equal(root.series_id, null);
            assert.equal(root.schedule_version, 1);
            assert.equal(
              (await worker.query('SELECT status FROM reminder_series')).rows[0].status,
              'proposed',
            );
            assert.equal(
              (await worker.query('SELECT invalidated_at FROM reminder_controls')).rows[0]
                .invalidated_at,
              null,
            );
            assert.equal(
              (
                await worker.query('SELECT 1 FROM reminder_series_actions WHERE event_id=$1', [
                  eventId,
                ])
              ).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'concurrent sweeps materialize each overdue child once with series-aware controls',
        async () => {
          await reset();
          const item = await activate('alice', 'WEEKLY');
          await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 day'");
          await Promise.all([scheduler.sweep(), scheduler.sweep(), scheduler.sweep()]);
          assert.equal((await worker.query('SELECT 1 FROM reminder_occurrences')).rowCount, 5);
          assert.equal((await worker.query('SELECT 1 FROM outbound_messages')).rowCount, 5);
          assert.equal(
            (await worker.query('SELECT 1 FROM reminder_controls WHERE invalidated_at IS NULL'))
              .rowCount,
            5,
          );
          const bodies = (
            await worker.query(`SELECT m.body,c.reference FROM outbound_messages m
          JOIN reminder_occurrences o ON o.id=m.occurrence_id
          JOIN reminder_controls c ON c.reminder_id=o.reminder_id AND c.schedule_version=o.schedule_version`)
          ).rows;
          assert.ok(
            bodies.every((r) => r.body.includes(`DONE ${r.reference}`) && r.body.length < 1024),
          );
          assert.ok(
            (await worker.query('SELECT body FROM outbound_messages')).rows.every((r) =>
              r.body.includes(`CANCEL SERIES ${item.series.reference}`),
            ),
          );
          assert.equal((await scheduler.sweep()).examined, 0);
        },
      );
      await t.test(
        'one occurrence can be snoozed or completed without moving its siblings; series cancel stops the rest',
        async () => {
          await reset();
          const item = await activate('alice', 'WEEKLY');
          const before = (
            await worker.query('SELECT id,due_at FROM reminders WHERE id<>$1 ORDER BY due_at', [
              item.reminderId,
            ])
          ).rows;
          const reference = (
            await worker.query(
              'SELECT reference FROM reminder_controls WHERE reminder_id=$1 AND invalidated_at IS NULL',
              [item.reminderId],
            )
          ).rows[0].reference;
          await run(`SNOOZE ${reference} 15m`);
          assert.deepEqual(
            (
              await worker.query('SELECT id,due_at FROM reminders WHERE id<>$1 ORDER BY due_at', [
                item.reminderId,
              ])
            ).rows,
            before,
          );
          const fresh = (
            await worker.query(
              'SELECT reference FROM reminder_controls WHERE reminder_id=$1 AND invalidated_at IS NULL',
              [item.reminderId],
            )
          ).rows[0].reference;
          await run(`DONE ${fresh}`);
          await admin.query(
            "UPDATE reminders SET due_at=clock_timestamp()-interval '1 second' WHERE status='pending'",
          );
          await scheduler.sweep();
          assert.equal(
            (await run(`CANCEL SERIES ${item.series.reference}`)).action.outcome,
            'cancelled',
          );
          assert.equal(
            (await worker.query("SELECT 1 FROM reminders WHERE status='cancelled'")).rowCount,
            4,
          );
          assert.equal(
            (await worker.query("SELECT 1 FROM reminders WHERE status='completed'")).rowCount,
            1,
          );
          assert.ok(
            (await worker.query('SELECT status FROM outbound_messages')).rows.every(
              (r) => r.status === 'suppressed',
            ),
          );
          assert.equal((await scheduler.sweep()).examined, 0);
        },
      );
      await t.test(
        'timezone proposals and STOP suppress the series; restored settings cannot revive old work',
        async () => {
          for (const control of ['TIMEZONE Europe/Paris', 'STOP']) {
            await reset();
            const item = await activate('alice', 'WEEKLY');
            const original = (
              await worker.query('SELECT consent_at,timezone_confirmed_at FROM users WHERE id=$1', [
                item.userId,
              ])
            ).rows[0];
            await run(control);
            assert.equal(
              (await worker.query('SELECT status FROM reminder_series')).rows[0].status,
              'suppressed',
            );
            // Even restoring the same zone with a NEW grant/confirmation must not authorize old plans.
            await admin.query(
              `UPDATE users SET paused=false,consent_version=$2,consent_at=$3,timezone='America/Toronto',pending_timezone=NULL,timezone_confirmed_at=clock_timestamp() WHERE id=$1`,
              [item.userId, CONSENT_VERSION, original.consent_at],
            );
            assert.equal(
              (await run(`CONFIRM REPEAT ${item.series.reference}`)).action.outcome,
              'stale',
            );
            await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 second'");
            assert.equal((await scheduler.sweep()).suppressed, 5);
            assert.ok(
              (await worker.query('SELECT status FROM outbound_messages')).rows.every(
                (r) => r.status === 'suppressed',
              ),
            );
          }
        },
      );
      await t.test('series cancellation and its audit roll back as one transaction', async () => {
        await reset();
        const item = await activate('alice', 'WEEKLY');
        await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 second'");
        await scheduler.sweep();
        const eventId = await inbound('alice', `CANCEL SERIES ${item.series.reference}`);
        const client = await worker.connect();
        try {
          await client.query('BEGIN');
          await new IdentityProcessor(worker).apply(client, eventId);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        assert.equal(
          (await worker.query('SELECT status FROM reminder_series')).rows[0].status,
          'active',
        );
        assert.equal(
          (await worker.query("SELECT 1 FROM reminders WHERE status='pending'")).rowCount,
          5,
        );
        assert.equal(
          (await worker.query("SELECT 1 FROM outbound_messages WHERE status='pending'")).rowCount,
          5,
        );
        assert.equal(
          (await worker.query('SELECT 1 FROM reminder_series_actions WHERE event_id=$1', [eventId]))
            .rowCount,
          0,
        );
      });
      await t.test(
        'maximum finite series commits 366 occurrences within the ordinary work lease',
        async () => {
          await reset();
          const item = await make();
          const last = new Date(future.getTime() + 365 * 86400000).toISOString().slice(0, 10);
          const proposal = await run(`REPEAT ${item.reference} DAILY UNTIL ${last}`);
          const series = (
            await worker.query('SELECT * FROM reminder_series WHERE id=$1', [
              proposal.action.series_id,
            ])
          ).rows[0];
          assert.equal(
            (await run(`CONFIRM REPEAT ${series.reference}`)).action.outcome,
            'confirmed',
          );
          assert.equal(
            (await worker.query('SELECT 1 FROM reminders WHERE series_id=$1', [series.id]))
              .rowCount,
            366,
          );
        },
      );
      await t.test(
        'series cancel exhausts retries, audits them, and retains unresolved delivery evidence',
        async () => {
          await reset();
          const item = await activate('alice', 'WEEKLY');
          await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 second'");
          await scheduler.sweep();
          const messages = (
            await worker.query('SELECT id FROM outbound_messages ORDER BY id LIMIT 3')
          ).rows;
          for (const [i, state] of ['rejected', 'accepted', 'unknown'].entries())
            await worker.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,provider_message_id,message_payload,recovery_state,retry_at)
          VALUES($1,$2,'12345','alice',$3,$4,'{}',$5,CASE WHEN $3='rejected' THEN clock_timestamp()+interval '1 minute' ELSE NULL END)`,
              [
                item.userId,
                messages[i]!.id,
                state,
                state === 'accepted' ? 'wamid.series-history' : null,
                state === 'rejected' ? 'retry_wait' : 'none',
              ],
            );
          await run(`CANCEL SERIES ${item.series.reference}`);
          const attempts = (
            await worker.query('SELECT state,recovery_state FROM whatsapp_attempts ORDER BY state')
          ).rows;
          assert.deepEqual(attempts, [
            { state: 'accepted', recovery_state: 'none' },
            { state: 'rejected', recovery_state: 'exhausted' },
            { state: 'unknown', recovery_state: 'none' },
          ]);
          assert.equal(
            (
              await worker.query(
                "SELECT 1 FROM delivery_recovery_audit WHERE action='series_cancelled'",
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'closed-window series delivery carries an occurrence reference; cancellation during I/O preserves acceptance',
        async () => {
          await reset();
          const who = '15555550101',
            item = await activate(who, 'WEEKLY');
          await admin.query('UPDATE usage_policy SET enabled=true');
          await admin.query(
            "UPDATE users SET window_expires_at=clock_timestamp()-interval '1 second'",
          );
          await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 second'");
          await scheduler.sweep();
          const row = (
            await worker.query(`SELECT m.id,c.reference FROM outbound_messages m JOIN reminder_occurrences o ON o.id=m.occurrence_id
          JOIN reminder_controls c ON c.reminder_id=o.reminder_id AND c.schedule_version=o.schedule_version ORDER BY m.available_at,m.id LIMIT 1`)
          ).rows[0];
          await admin.query(`INSERT INTO whatsapp_templates(phone_number_id,reply_language,version,name,language_code,body_format,approval_status,approval_reference,verified_at,valid_until)
          VALUES('12345','en',1,'series_test','en_US','You asked: {{1}}','approved','synthetic',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day')`);
          let calls = 0;
          const sender = new ReminderSender(
            worker,
            {
              send: async (message) => {
                calls++;
                assert.ok('template' in message);
                assert.match(message.template.bodyParameter, new RegExp(`DONE ${row.reference}`));
                await run(`CANCEL SERIES ${item.series.reference}`, who);
                return { state: 'accepted', providerMessageId: 'wamid.series-inflight' };
              },
            },
            { enabled: true, phoneNumberId: '12345', recipients: [who], timeoutMs: 3000 },
          );
          assert.equal((await sender.send(row.id)).state, 'accepted');
          assert.equal((await sender.sendPending()).examined, 0);
          assert.equal(
            (await worker.query('SELECT state FROM whatsapp_attempts')).rows[0].state,
            'accepted',
          );
          assert.equal(calls, 1);
        },
      );
      await t.test(
        'series and command receipts enforce owner references, event binding, RLS and immutable rules',
        async () => {
          await reset();
          const a = await activate(),
            b = await activate('bob', 'WEEKLY');
          const foreign = await run(`CANCEL SERIES ${a.series.reference}`, 'bob');
          const absent = await run('CANCEL SERIES 0000000000000000', 'bob');
          assert.equal(foreign.action.reply_text, absent.action.reply_text);
          for (const table of ['reminder_series', 'reminder_series_actions']) {
            assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
            await withTenant(tenant, a.userId, async (client) => {
              const rows = (await client.query(`SELECT user_id FROM ${table}`)).rows;
              assert.ok(rows.length);
              assert.ok(rows.every((r) => r.user_id === a.userId));
            });
            await assert.rejects(ingress.query(`SELECT * FROM ${table}`), /permission denied/);
            await assert.rejects(worker.query(`DELETE FROM ${table}`), /permission denied/);
            const flags = (
              await admin.query(
                'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
                [`${schema}.${table}`],
              )
            ).rows[0];
            assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
          }
          await assert.rejects(
            worker.query("UPDATE reminder_series SET timezone='UTC'"),
            /permission denied/,
          );
          await assert.rejects(
            worker.query("UPDATE reminder_series_actions SET reply_text='forged'"),
            /permission denied/,
          );
          await assert.rejects(
            worker.query(
              `UPDATE reminders SET series_id=$1,series_local_date='2000-01-01' WHERE id=$2`,
              [b.series.id, a.reminderId],
            ),
            /foreign key/,
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO reminder_series_actions(event_id,user_id,outcome,reply_text) VALUES($1,$2,'stale','forged')`,
              [a.eventId, b.userId],
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
