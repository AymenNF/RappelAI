import { ReminderSender } from '../../src/modules/delivery/reminder-sender.js';
import {
  applyReminderCommand,
  ensureReminderControl,
  controlButtons,
} from '../../src/modules/reminders/controls.js';
import { ReceiptProcessor } from '../../src/modules/whatsapp/receipts.js';
import type { WhatsAppTransport, WhatsAppMessage } from '../../src/modules/whatsapp/send.js';
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
  'reminder delivery and templates under restricted database logins',
  { timeout: 120000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `test_${suffix}`;
    const appName = `reminder_delivery_${suffix}`;
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
      const reset = async () => {
        calls = 0;
        await admin.query('TRUNCATE users,ingress_events,whatsapp_templates CASCADE');
        await admin.query('UPDATE usage_policy SET enabled=true');
      };
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
        sender = '15555550101',
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
        await admin.query(
          "UPDATE users SET window_expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
          [user.id],
        );
        await scheduler.sweep();
        const outboundId = (
          await worker.query(
            'SELECT m.id FROM outbound_messages m JOIN reminder_occurrences o ON o.id=m.occurrence_id WHERE o.reminder_id=$1',
            [reminderId],
          )
        ).rows[0].id as string;
        return { eventId, userId: user.id as string, reminderId, outboundId };
      };

      const phone = '12345',
        alice = '15555550101',
        bob = '15555550102';
      const policy = {
        enabled: true,
        phoneNumberId: phone,
        recipients: [alice, bob],
        timeoutMs: 100,
      };
      let calls = 0;
      const transport: WhatsAppTransport = {
        send: async () => {
          calls++;
          return { state: 'accepted', providerMessageId: `wamid.${randomUUID()}` };
        },
      };
      const sender = (custom = transport) => new ReminderSender(worker, custom, policy);
      const template = async (language = 'en', version = 1, business = phone) =>
        (
          await admin.query(
            `INSERT INTO whatsapp_templates
        (phone_number_id,reply_language,version,name,language_code,body_format,approval_status,approval_reference,verified_at,valid_until)
        VALUES($1,$2,$3,$4,$5,'You asked to be reminded: {{1}}','approved','synthetic-approval',clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day') RETURNING id`,
            [
              business,
              language,
              version,
              `reminder_${language}_v${version}`,
              language === 'en' ? 'en_US' : language,
            ],
          )
        ).rows[0].id as string;
      const closeWindow = () =>
        admin.query("UPDATE users SET window_expires_at=clock_timestamp()-interval '1 second'");
      const attempt = async (id: string) =>
        (await worker.query('SELECT * FROM whatsapp_attempts WHERE outbound_message_id=$1', [id]))
          .rows[0];
      const receipt = async (
        id: string,
        status = 'delivered',
        recipient = alice,
        business = phone,
      ) => {
        await store.persist([
          {
            eventKey: randomUUID(),
            kind: 'delivery.status',
            phoneNumberId: business,
            providerMessageId: id,
            senderId: null,
            payload: {
              id,
              status,
              recipient_id: recipient,
              timestamp: String(Math.floor(Date.now() / 1000)),
            },
          },
        ]);
        const runner = new WorkRunner(new WorkQueue(worker), 'reminder-receipt-test');
        while (await runner.runOne('receipt', new ReceiptProcessor())) {
          /* drain */
        }
      };

      await t.test(
        'competing senders commit one attempt before I/O; restart and replay do not resend',
        async () => {
          await reset();
          const item = await seed();
          const custom: WhatsAppTransport = {
            send: async (message) => {
              calls++;
              const row = await attempt(item.outboundId);
              assert.equal(row.state, 'dispatching');
              assert.deepEqual(row.message_payload, message);
              assert.equal(row.event_id, null);
              assert.equal(row.template_id, null);
              assert.deepEqual(message, {
                phoneNumberId: phone,
                recipientId: alice,
                body: 'Reminder: Call dentist',
                buttons: controlButtons(
                  (await worker.query('SELECT reference FROM reminder_controls')).rows[0].reference,
                ),
              });
              return { state: 'accepted', providerMessageId: 'wamid.single' };
            },
          };
          const results = await Promise.all(
            Array.from({ length: 8 }, () => sender(custom).send(item.outboundId)),
          );
          assert.equal(new Set(results.map((r) => r.id)).size, 1);
          assert.equal(calls, 1);
          assert.equal((await sender().send(item.outboundId)).state, 'accepted');
          assert.equal(calls, 1);
          assert.equal((await attempt(item.outboundId)).delivery_status, 'none');
        },
      );

      await t.test(
        'closed/null/near-boundary windows select the exact locale and latest approved template',
        async () => {
          for (const window of [
            'NULL',
            'clock_timestamp()',
            "clock_timestamp()+interval '1 second'",
          ]) {
            await reset();
            const item = await seed();
            await template('en');
            const fr = await template('fr', 2);
            await admin.query(
              "INSERT INTO user_preferences(user_id,reply_language) VALUES($1,'fr')",
              [item.userId],
            );
            await admin.query(`UPDATE users SET window_expires_at=${window}`);
            let sent: WhatsAppMessage | undefined;
            await sender({
              send: async (message) => {
                sent = message;
                return { state: 'accepted', providerMessageId: 'wamid.template' };
              },
            }).send(item.outboundId);
            assert.deepEqual(sent, {
              phoneNumberId: phone,
              recipientId: alice,
              template: {
                name: 'reminder_fr_v2',
                languageCode: 'fr',
                bodyParameter: 'Reminder: Call dentist',
              },
            });
            assert.equal((await attempt(item.outboundId)).template_id, fr);
          }
          await reset();
          const item = await seed();
          await template();
          await sender().send(item.outboundId);
          assert.equal((await attempt(item.outboundId)).template_id, null); // open window prefers text
        },
      );

      await t.test(
        'unavailable, wrong-phone, wrong-language, stale and unapproved templates block without consuming an intent',
        async () => {
          for (const condition of [
            'missing',
            'wrong-phone',
            'wrong-language',
            'pending',
            'paused',
            'rejected',
            'expired',
            'future',
          ]) {
            await reset();
            const item = await seed();
            await closeWindow();
            if (condition !== 'missing') {
              await template(
                condition === 'wrong-language' ? 'fr' : 'en',
                1,
                condition === 'wrong-phone' ? '99999' : phone,
              );
              if (['pending', 'paused', 'rejected'].includes(condition))
                await admin.query('UPDATE whatsapp_templates SET approval_status=$1', [condition]);
              if (condition === 'expired')
                await admin.query(
                  "UPDATE whatsapp_templates SET valid_until=clock_timestamp()-interval '1 second'",
                );
              if (condition === 'future')
                await admin.query(
                  "UPDATE whatsapp_templates SET verified_at=clock_timestamp()+interval '1 hour'",
                );
            }
            await assert.rejects(sender().send(item.outboundId), /Approved template unavailable/);
            assert.equal(await attempt(item.outboundId), undefined);
            assert.equal(calls, 0);
          }
          await reset();
          const item = await seed();
          await closeWindow();
          await template();
          await template('en', 2);
          await admin.query(
            "UPDATE whatsapp_templates SET approval_status='paused' WHERE version=2",
          );
          await assert.rejects(sender().send(item.outboundId), /Approved template unavailable/); // no fallback to v1
          await admin.query(
            "UPDATE whatsapp_templates SET approval_status='approved' WHERE version=2",
          );
          assert.equal((await sender().send(item.outboundId)).state, 'accepted');
        },
      );

      await t.test(
        'template content is bounded, preserves stored text and cannot be silently truncated or converted to plain text',
        async () => {
          await reset();
          const item = await seed();
          await closeWindow();
          await template();
          await admin.query(
            "UPDATE outbound_messages SET body='Reminder: line'||chr(10)||'break' WHERE id=$1",
            [item.outboundId],
          );
          await assert.rejects(sender().send(item.outboundId), /supported format/);
          await admin.query("UPDATE outbound_messages SET body=repeat('x',1024) WHERE id=$1", [
            item.outboundId,
          ]);
          await assert.rejects(sender().send(item.outboundId), /supported length/);
          assert.equal(calls, 0);
          assert.equal(await attempt(item.outboundId), undefined);
        },
      );

      await t.test(
        'send-time identity, lifecycle and schedule version checks suppress stale work',
        async () => {
          for (const mutation of [
            'UPDATE users SET paused=true',
            'UPDATE users SET consent_at=clock_timestamp()',
            "UPDATE users SET consent_version='obsolete'",
            'UPDATE users SET timezone_confirmed_at=clock_timestamp()',
            "UPDATE users SET pending_timezone='Europe/Paris'",
            "UPDATE users SET timezone='UTC'",
            "UPDATE reminders SET status='cancelled'",
            "UPDATE reminders SET status='completed'",
            'UPDATE reminders SET schedule_version=schedule_version+1',
            "UPDATE reminders SET due_at=due_at+interval '1 hour'",
          ]) {
            await reset();
            const item = await seed();
            await admin.query(mutation);
            const result = await sender().send(item.outboundId);
            assert.equal(result.state, 'suppressed');
            assert.equal(calls, 0);
            assert.equal((await attempt(item.outboundId)).message_payload, null);
            assert.deepEqual(await sender().send(item.outboundId), result);
          }
        },
      );

      await t.test(
        'pause, allowlist, disabled configuration, early availability and cancellation prevent sends',
        async () => {
          await reset();
          const item = await seed();
          await admin.query('UPDATE usage_policy SET enabled=false');
          await assert.rejects(sender().send(item.outboundId), /Global/);
          await admin.query('UPDATE usage_policy SET enabled=true');
          await assert.rejects(
            new ReminderSender(worker, transport, { ...policy, enabled: false }).send(
              item.outboundId,
            ),
            /disabled/,
          );
          await assert.rejects(
            new ReminderSender(worker, transport, { ...policy, recipients: [bob] }).send(
              item.outboundId,
            ),
            /allowlist/,
          );
          await assert.rejects(
            new ReminderSender(worker, transport, { ...policy, phoneNumberId: '99999' }).send(
              item.outboundId,
            ),
            /allowlist/,
          );
          await assert.rejects(sender().send(item.outboundId, AbortSignal.abort()), /disabled/);
          await admin.query(
            "UPDATE outbound_messages SET available_at=clock_timestamp()+interval '1 hour'",
          );
          await assert.rejects(sender().send(item.outboundId), /not due/);
          assert.equal(calls, 0);
          assert.equal(await attempt(item.outboundId), undefined);
        },
      );

      await t.test(
        'early and reordered receipts reconcile; wrong addresses remain unlinked',
        async () => {
          await reset();
          const item = await seed();
          await closeWindow();
          await template();
          await sender({
            send: async () => {
              await receipt('wamid.early', 'read');
              assert.equal(
                (await worker.query('SELECT attempt_id FROM whatsapp_receipts')).rows[0].attempt_id,
                null,
              );
              return { state: 'accepted', providerMessageId: 'wamid.early' };
            },
          }).send(item.outboundId);
          assert.equal((await attempt(item.outboundId)).delivery_status, 'read');
          for (const status of ['failed', 'sent', 'delivered', 'future_status'])
            await receipt('wamid.early', status);
          assert.equal((await attempt(item.outboundId)).delivery_status, 'read');
          await receipt('wamid.early', 'read', bob);
          await receipt('wamid.early', 'read', alice, '99999');
          assert.equal(
            (
              await worker.query(
                'SELECT count(*)::int AS n FROM whatsapp_receipts WHERE attempt_id IS NULL',
              )
            ).rows[0].n,
            2,
          );
          await reset();
          const next = await seed();
          await sender().send(next.outboundId);
          const id = (await attempt(next.outboundId)).provider_message_id;
          for (const [incoming, expected] of [
            ['sent', 'sent'],
            ['failed', 'failed'],
            ['sent', 'failed'],
            ['delivered', 'delivered'],
            ['read', 'read'],
          ]) {
            await receipt(id, incoming);
            assert.equal((await attempt(next.outboundId)).delivery_status, expected);
          }
        },
      );

      await t.test(
        'unknown/rejected results and failed acceptance writes never trigger a blind duplicate',
        async () => {
          for (const state of ['unknown', 'rejected'] as const) {
            await reset();
            const item = await seed();
            assert.equal(
              (
                await sender({
                  send: async () => {
                    calls++;
                    return { state, code: 'synthetic' };
                  },
                }).send(item.outboundId)
              ).state,
              state,
            );
            assert.equal((await sender().send(item.outboundId)).state, state);
            assert.equal(calls, 1);
          }
          await reset();
          const item = await seed();
          await admin.query(`CREATE FUNCTION fail_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic persistence failure'; END $$;
          CREATE TRIGGER fail_accept BEFORE UPDATE ON whatsapp_attempts FOR EACH ROW EXECUTE FUNCTION fail_accept()`);
          try {
            await assert.rejects(sender().send(item.outboundId), /synthetic persistence/);
          } finally {
            await admin.query(
              'DROP TRIGGER fail_accept ON whatsapp_attempts; DROP FUNCTION fail_accept()',
            );
          }
          assert.equal((await attempt(item.outboundId)).state, 'dispatching');
          assert.equal((await sender().send(item.outboundId)).state, 'dispatching');
          assert.equal(calls, 1);
          await receipt('unmatched-lost-response');
          assert.equal(
            (await worker.query('SELECT attempt_id FROM whatsapp_receipts')).rows[0].attempt_id,
            null,
          );
        },
      );

      await t.test(
        'timeout remains unknown even after late success; pre-authorization write failure leaves no attempt',
        async () => {
          await reset();
          const item = await seed();
          let finish!: () => void;
          const result = await sender({
            send: async () => {
              calls++;
              await new Promise<void>((resolve) => {
                finish = resolve;
              });
              return { state: 'accepted', providerMessageId: 'late' };
            },
          }).send(item.outboundId);
          assert.equal(result.state, 'unknown');
          finish();
          await setTimeout(10);
          assert.equal((await sender().send(item.outboundId)).state, 'unknown');
          assert.equal(calls, 1);
          await reset();
          const next = await seed();
          await admin.query(`CREATE FUNCTION fail_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic attempt failure'; END $$;
          CREATE TRIGGER fail_attempt BEFORE INSERT ON whatsapp_attempts FOR EACH ROW EXECUTE FUNCTION fail_attempt()`);
          try {
            await assert.rejects(sender().send(next.outboundId), /synthetic attempt failure/);
          } finally {
            await admin.query(
              'DROP TRIGGER fail_attempt ON whatsapp_attempts; DROP FUNCTION fail_attempt()',
            );
          }
          assert.equal(await attempt(next.outboundId), undefined);
          assert.equal(calls, 0);
          await sender().send(next.outboundId);
          assert.equal(calls, 1);
        },
      );

      await t.test(
        'STOP and pause can commit during network I/O; receipt evidence is still recorded',
        async () => {
          await reset();
          const item = await seed();
          let release!: () => void, started!: () => void;
          const entered = new Promise<void>((resolve) => {
            started = resolve;
          });
          const waiting = new Promise<void>((resolve) => {
            release = resolve;
          });
          const sending = new ReminderSender(
            worker,
            {
              send: async () => {
                started();
                await waiting;
                return { state: 'accepted', providerMessageId: 'inflight' };
              },
            },
            { ...policy, timeoutMs: 10000 },
          ).send(item.outboundId);
          await entered;
          try {
            await inbound(alice, 'STOP');
            await new IdentityProcessor(worker).processNext();
            await admin.query('UPDATE usage_policy SET enabled=false');
            assert.equal(
              (await worker.query('SELECT status FROM outbound_messages')).rows[0].status,
              'suppressed',
            );
          } finally {
            release();
          }
          assert.equal((await sending).state, 'accepted');
          await receipt('inflight');
          assert.equal((await attempt(item.outboundId)).delivery_status, 'delivered');
        },
      );

      await t.test(
        'per-user ordering and bounded passes allow independent users to progress',
        async () => {
          await reset();
          const a = await seed(alice, new Date(Date.now() - 7200000).toISOString());
          const b = await seed(alice),
            c = await seed(bob);
          await assert.rejects(sender().send(b.outboundId), /Earlier delivery/);
          await sender({ send: async () => ({ state: 'unknown', code: 'timeout' }) }).send(
            a.outboundId,
          );
          await assert.rejects(sender().send(b.outboundId), /Earlier delivery/);
          assert.deepEqual(await sender().sendPending(), { examined: 2, attempted: 1, blocked: 1 });
          assert.equal((await attempt(c.outboundId)).state, 'accepted');
          assert.deepEqual(await sender().sendPending(1, AbortSignal.abort()), {
            examined: 0,
            attempted: 0,
            blocked: 0,
          });
          for (const limit of [0, 101, 1.5])
            await assert.rejects(sender().sendPending(limit), /Delivery limit/);
          assert.equal(calls, 1);
        },
      );

      await t.test(
        'window and template approval are rechecked after lock waits; cancellation rolls back before I/O',
        async () => {
          const waitingForTemplate = async () => {
            for (let i = 0; i < 150; i++) {
              if (
                (
                  await admin.query(
                    "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event='advisory'",
                    [appName],
                  )
                ).rowCount
              )
                return;
              await setTimeout(10);
            }
            assert.fail('Sender did not reach template lock');
          };
          for (const scenario of ['expiry', 'pause', 'abort']) {
            await reset();
            const item = await seed();
            await template();
            if (scenario === 'expiry')
              await admin.query(
                "UPDATE users SET window_expires_at=clock_timestamp()+interval '2 seconds'",
              );
            else await closeWindow();
            const lock = await admin.connect();
            const controller = new AbortController();
            await lock.query('BEGIN');
            await lock.query(
              "SELECT pg_advisory_xact_lock(hashtextextended('whatsapp-template:'||$1,0))",
              [phone],
            );
            const sending = sender().send(item.outboundId, controller.signal);
            // Attach rejection handling immediately while waiting on deterministic database evidence.
            const outcome = sending.then(
              (value) => ({ value, error: null }),
              (error) => ({ value: null, error }),
            );
            try {
              await waitingForTemplate();
              if (scenario === 'expiry')
                await admin.query(
                  'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(window_expires_at-clock_timestamp())))) FROM users WHERE id=$1',
                  [item.userId],
                );
              if (scenario === 'pause')
                await lock.query("UPDATE whatsapp_templates SET approval_status='paused'");
              if (scenario === 'abort') controller.abort();
              await lock.query('COMMIT');
            } finally {
              await lock.query('ROLLBACK');
              lock.release();
            }
            const result = await outcome;
            if (scenario === 'expiry') {
              assert.equal(result.error, null);
              assert.equal(result.value?.state, 'accepted');
              assert.ok((await attempt(item.outboundId)).message_payload.template);
            } else {
              assert.match(
                String(result.error),
                scenario === 'pause' ? /Approved template unavailable/ : /cancelled/,
              );
              assert.equal(await attempt(item.outboundId), undefined);
              assert.equal(calls, 0);
            }
          }
        },
      );

      await t.test(
        'restricted roles preserve template configuration, payload immutability, source ownership and tenant isolation',
        async () => {
          await reset();
          const a = await seed(),
            b = await seed(bob);
          const tid = await template();
          await sender().send(a.outboundId);
          await sender().send(b.outboundId);
          assert.equal((await tenant.query('SELECT * FROM whatsapp_attempts')).rowCount, 0);
          await withTenant(tenant, a.userId, async (client) => {
            const rows = await client.query(
              'SELECT user_id,message_payload FROM whatsapp_attempts',
            );
            assert.equal(rows.rowCount, 1);
            assert.equal(rows.rows[0].user_id, a.userId);
          });
          for (const pool of [worker, tenant, ingress]) {
            await assert.rejects(
              pool.query("UPDATE whatsapp_templates SET approval_status='approved'"),
              /permission denied/,
            );
            await assert.rejects(pool.query('DELETE FROM whatsapp_templates'), /permission denied/);
          }
          await assert.rejects(
            worker.query("UPDATE user_preferences SET reply_language='en'"),
            /permission denied/,
          );
          const flags = (
            await admin.query(
              'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
              [`${schema}.whatsapp_templates`],
            )
          ).rows[0];
          assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
          for (const pool of [tenant, ingress])
            await assert.rejects(
              pool.query('SELECT * FROM whatsapp_templates'),
              /permission denied/,
            );
          await assert.rejects(
            worker.query("UPDATE whatsapp_attempts SET message_payload='{}'"),
            /permission denied/,
          );
          await assert.rejects(
            admin.query("UPDATE whatsapp_templates SET name='edited'"),
            /immutable/,
          );
          await assert.rejects(admin.query('DELETE FROM whatsapp_templates'), /cannot be deleted/);
          const fresh = await seed();
          await assert.rejects(
            worker.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state)
          VALUES($1,$2,$3,$4,'suppressed')`,
              [b.userId, fresh.outboundId, phone, bob],
            ),
            /foreign key/,
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,event_id,reply_event_id,phone_number_id,recipient_id,state)
          VALUES($1,$2,$3,$3,$4,$5,'suppressed')`,
              [a.userId, fresh.outboundId, a.eventId, phone, alice],
            ),
            /check constraint/,
          );
          const wrong = await template('en', 1, '99999');
          await assert.rejects(
            worker.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,template_id,message_payload)
          VALUES($1,$2,$3,$4,'dispatching',$5,'{"template":{}}')`,
              [a.userId, fresh.outboundId, phone, alice, wrong],
            ),
            /foreign key/,
          );
          assert.ok(tid);
        },
      );
      const referenceFor = async (item: { userId: string; reminderId: string }) => {
        const client = await worker.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [item.userId]);
          const reference = await ensureReminderControl(client, item.userId, item.reminderId);
          await client.query('COMMIT');
          return reference;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      const commandEvent = async (
        reference: string,
        action = 'complete',
        who = alice,
        minutes?: number,
      ) => {
        const eventId = await inbound(
          who,
          `${action === 'complete' ? 'DONE' : action.toUpperCase()} ${reference}${minutes === undefined ? '' : ` ${minutes}m`}`,
        );
        return eventId;
      };
      const processCommand = async (eventId: string) => {
        const result = await new IdentityProcessor(worker).processNext();
        assert.equal(result?.eventId, eventId);
        assert.equal(result?.disposition, 'handled');
        assert.equal(
          (await worker.query('SELECT status FROM work_outbox WHERE event_id=$1', [eventId]))
            .rows[0].status,
          'completed',
        );
        assert.equal(
          (await worker.query('SELECT 1 FROM action_plans WHERE event_id=$1', [eventId])).rowCount,
          0,
        );
        return (await worker.query('SELECT * FROM reminder_mutations WHERE event_id=$1', [eventId]))
          .rows[0];
      };
      const reminder = async (id: string) =>
        (await worker.query('SELECT * FROM reminders WHERE id=$1', [id])).rows[0];

      await t.test(
        'complete and cancel atomically suppress all queued delivery and reject replayed controls',
        async () => {
          for (const action of ['complete', 'cancel']) {
            await reset();
            const item = await seed();
            const reference = await referenceFor(item);
            const eventId = await commandEvent(reference, action);
            assert.equal((await processCommand(eventId)).outcome, 'applied');
            assert.equal(
              (await reminder(item.reminderId)).status,
              action === 'complete' ? 'completed' : 'cancelled',
            );
            assert.equal((await reminder(item.reminderId)).schedule_version, 2);
            for (const table of ['reminder_occurrences', 'outbound_messages']) {
              const row = (await worker.query(`SELECT status,suppression_reason FROM ${table}`))
                .rows[0];
              assert.deepEqual(row, {
                status: 'suppressed',
                suppression_reason: 'reminder_changed',
              });
            }
            assert.equal((await sender().send(item.outboundId)).state, 'suppressed');
            assert.equal(calls, 0);
            assert.equal(
              (await processCommand(await commandEvent(reference, 'snooze'))).outcome,
              'stale',
            );
            assert.equal((await reminder(item.reminderId)).schedule_version, 2);
            assert.equal((await scheduler.sweep()).examined, 0);
          }
        },
      );
      await t.test(
        'snooze uses database time, rotates controls and schedules exactly one new occurrence',
        async () => {
          await reset();
          const item = await seed();
          const reference = await referenceFor(item);
          const before = (
            await worker.query('SELECT clock_timestamp() AS at')
          ).rows[0].at.getTime();
          const eventId = await commandEvent(reference, 'snooze', alice, 15);
          const result = await processCommand(eventId);
          const current = await reminder(item.reminderId);
          assert.equal(current.status, 'pending');
          assert.equal(current.scheduled_at, null);
          assert.equal(current.schedule_version, 2);
          const after = (await worker.query('SELECT clock_timestamp() AS at')).rows[0].at.getTime();
          assert.ok(
            current.due_at.getTime() >= before + 900000 &&
              current.due_at.getTime() <= after + 900000,
          );
          const fresh = await referenceFor(item);
          assert.notEqual(fresh, reference);
          assert.match(result.reply_text, new RegExp(fresh));
          const replayClient = await worker.connect();
          try {
            await replayClient.query('BEGIN');
            assert.equal(
              await applyReminderCommand(replayClient, eventId, item.userId, {
                action: 'snooze',
                reference,
                minutes: 15,
              }),
              result.reply_text,
            );
            await replayClient.query('COMMIT');
          } finally {
            replayClient.release();
          }
          assert.equal((await reminder(item.reminderId)).schedule_version, 2);
          assert.equal((await scheduler.sweep()).examined, 0);
          assert.equal((await processCommand(await commandEvent(reference))).outcome, 'stale');
          // Advance the scheduled time as a test-clock substitute, retaining the new version.
          await admin.query(
            "UPDATE reminders SET due_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [item.reminderId],
          );
          const sweeps = await Promise.all([scheduler.sweep(), scheduler.sweep()]);
          assert.equal(
            sweeps.reduce((n, r) => n + r.materialized, 0),
            1,
          );
          const rows = (
            await worker.query('SELECT * FROM reminder_occurrences ORDER BY schedule_version')
          ).rows;
          assert.equal(rows.length, 2);
          assert.equal(rows[0].status, 'suppressed');
          assert.equal(rows[1].schedule_version, 2);
          assert.equal(rows[1].status, 'pending');
          assert.equal((await sender().send(item.outboundId)).state, 'suppressed');
          const newOutbound = (
            await worker.query('SELECT id FROM outbound_messages WHERE occurrence_id=$1', [
              rows[1].id,
            ])
          ).rows[0].id;
          let newButtons: unknown;
          assert.equal(
            (
              await sender({
                send: async (message) => {
                  newButtons = 'buttons' in message ? message.buttons : null;
                  return { state: 'accepted', providerMessageId: 'wamid.snoozed' };
                },
              }).send(newOutbound)
            ).state,
            'accepted',
          );
          assert.deepEqual(newButtons, controlButtons(fresh));
          assert.equal((await processCommand(await commandEvent(fresh))).outcome, 'applied');
        },
      );
      await t.test(
        'real inbound button payloads obey owner and version checks; display titles cannot change actions',
        async () => {
          await reset();
          const item = await seed();
          const reference = await referenceFor(item);
          const eventId = await inbound(alice, 'placeholder');
          await admin.query(`UPDATE ingress_events SET payload=$2 WHERE id=$1`, [
            eventId,
            {
              type: 'interactive',
              timestamp: String(Math.floor(Date.now() / 1000)),
              interactive: {
                type: 'button_reply',
                button_reply: { id: `reminder:${reference}:snooze`, title: 'Cancel' },
              },
            },
          ]);
          assert.equal((await processCommand(eventId)).action, 'snooze');
          const stale = await inbound(alice, 'placeholder');
          await admin.query(`UPDATE ingress_events SET payload=$2 WHERE id=$1`, [
            stale,
            {
              type: 'button',
              timestamp: String(Math.floor(Date.now() / 1000)),
              button: { payload: `reminder:${reference}:complete` },
            },
          ]);
          assert.equal((await processCommand(stale)).outcome, 'stale');
          assert.equal((await reminder(item.reminderId)).status, 'pending');
        },
      );
      await t.test(
        'foreign, missing, expired and identity-invalidated controls reveal no target and do not mutate',
        async () => {
          await reset();
          const a = await seed(alice),
            b = await seed(bob);
          const reference = await referenceFor(a);
          const foreign = await processCommand(await commandEvent(reference, 'cancel', bob));
          const missing = await processCommand(
            await commandEvent('0000000000000000', 'cancel', bob),
          );
          assert.equal(foreign.outcome, 'stale');
          assert.equal(foreign.reminder_id, null);
          assert.equal(foreign.reply_text, missing.reply_text);
          await admin.query(
            "UPDATE reminder_controls SET expires_at=clock_timestamp()-interval '1 second' WHERE reference=$1",
            [reference],
          );
          assert.equal((await processCommand(await commandEvent(reference))).outcome, 'stale');
          const bRef = await referenceFor(b);
          await inbound(bob, 'TIMEZONE Europe/Paris');
          await new IdentityProcessor(worker).processNext();
          assert.ok(
            (
              await worker.query(
                'SELECT invalidated_at FROM reminder_controls WHERE reference=$1',
                [bRef],
              )
            ).rows[0].invalidated_at,
          );
          assert.equal((await reminder(a.reminderId)).schedule_version, 1);
          assert.equal((await reminder(b.reminderId)).schedule_version, 1);
          const client = await worker.connect();
          try {
            await client.query('BEGIN');
            await assert.rejects(
              applyReminderCommand(client, a.eventId, b.userId, {
                action: 'cancel',
                reference,
                minutes: 10,
              }),
              /owner mismatch/,
            );
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
        },
      );
      await t.test(
        'malformed duration and invalid provider timestamp cannot trigger model work or mutations',
        async () => {
          await reset();
          const item = await seed(),
            reference = await referenceFor(item);
          assert.equal(
            (await processCommand(await commandEvent(reference, 'snooze', alice, 1441))).outcome,
            'invalid',
          );
          const invalid = await commandEvent(reference);
          await admin.query(
            "UPDATE ingress_events SET payload=jsonb_set(payload,'{timestamp}','\"0\"') WHERE id=$1",
            [invalid],
          );
          assert.equal((await new IdentityProcessor(worker).processNext())?.disposition, 'blocked');
          assert.equal(
            (await worker.query('SELECT 1 FROM reminder_mutations WHERE event_id=$1', [invalid]))
              .rowCount,
            0,
          );
          assert.equal((await reminder(item.reminderId)).schedule_version, 1);
        },
      );
      await t.test(
        'simultaneous controls serialize: one changes the reminder and the other is stale',
        async () => {
          await reset();
          const item = await seed(),
            reference = await referenceFor(item);
          const events = [
            await commandEvent(reference, 'snooze'),
            await commandEvent(reference, 'cancel'),
          ];
          const results = await Promise.all(
            events.map(async (eventId, index) => {
              const client = await worker.connect();
              try {
                await client.query('BEGIN');
                await applyReminderCommand(client, eventId, item.userId, {
                  action: index === 0 ? 'snooze' : 'cancel',
                  reference,
                  minutes: 10,
                });
                await client.query('COMMIT');
              } catch (error) {
                await client.query('ROLLBACK');
                throw error;
              } finally {
                client.release();
              }
              return (
                await worker.query('SELECT outcome FROM reminder_mutations WHERE event_id=$1', [
                  eventId,
                ])
              ).rows[0].outcome;
            }),
          );
          assert.deepEqual(results.sort(), ['applied', 'stale']);
          assert.equal((await reminder(item.reminderId)).schedule_version, 2);
        },
      );
      await t.test(
        'mutation failure and lease expiry roll back reminder, intent, control, and receipt together',
        async () => {
          for (const expire of [false, true]) {
            await reset();
            const item = await seed(),
              reference = await referenceFor(item);
            const eventId = await commandEvent(reference, 'cancel');
            const queue = new WorkQueue(worker);
            const lease = await queue.claim(
              'onboarding',
              'mutation-rollback',
              expire ? 500 : 30000,
            );
            assert.ok(lease);
            await assert.rejects(
              queue.commit(lease, async (client) => {
                const result = await new IdentityProcessor(worker).apply(client, eventId);
                if (!expire) throw new Error('injected transaction failure');
                await client.query('SELECT pg_sleep(0.55)');
                return result;
              }),
            );
            assert.equal((await reminder(item.reminderId)).schedule_version, 1);
            assert.equal(
              (
                await worker.query('SELECT status FROM outbound_messages WHERE id=$1', [
                  item.outboundId,
                ])
              ).rows[0].status,
              'pending',
            );
            assert.equal(
              (
                await worker.query(
                  'SELECT invalidated_at FROM reminder_controls WHERE reference=$1',
                  [reference],
                )
              ).rows[0].invalidated_at,
              null,
            );
            assert.equal((await worker.query('SELECT 1 FROM reminder_mutations')).rowCount, 0);
          }
        },
      );
      await t.test(
        'cancel exhausts queued retries but preserves accepted and unknown delivery evidence',
        async () => {
          for (const state of ['rejected', 'accepted', 'unknown'] as const) {
            await reset();
            const item = await seed(),
              reference = await referenceFor(item);
            const result = await sender({
              send: async () =>
                state === 'accepted'
                  ? { state, providerMessageId: 'wamid.preserved' }
                  : { state, code: 'synthetic', retryable: true },
            }).send(item.outboundId);
            await processCommand(await commandEvent(reference, 'cancel'));
            const row = await attempt(item.outboundId);
            assert.equal(row.state, state);
            assert.equal(row.recovery_state, state === 'rejected' ? 'exhausted' : 'none');
            assert.equal(row.retry_at, null);
            assert.equal((await sender().send(item.outboundId)).id, result.id);
            assert.equal(calls, 0);
          }
        },
      );
      await t.test(
        'late rejection after cancellation cannot requeue; authorized acceptance remains recorded',
        async () => {
          for (const accepted of [false, true]) {
            await reset();
            const item = await seed();
            const reference = await referenceFor(item);
            const result = await new ReminderSender(
              worker,
              {
                send: async () => {
                  await processCommand(await commandEvent(reference, 'cancel'));
                  return accepted
                    ? { state: 'accepted', providerMessageId: 'wamid.inflight' }
                    : { state: 'rejected', code: 'limited', retryable: true };
                },
              },
              { ...policy, timeoutMs: 2000 },
            ).send(item.outboundId);
            assert.equal(result.state, accepted ? 'accepted' : 'rejected');
            const row = await attempt(item.outboundId);
            assert.equal(row.recovery_state, accepted ? 'none' : 'exhausted');
            assert.equal((await reminder(item.reminderId)).status, 'cancelled');
          }
        },
      );
      await t.test(
        'cancel committed while a sender waits prevents authorization; scheduler skips the held user',
        async () => {
          await reset();
          const item = await seed(),
            reference = await referenceFor(item);
          const eventId = await commandEvent(reference, 'cancel');
          const client = await worker.connect();
          let sending: Promise<{ value?: { state: string }; error?: unknown }> | undefined;
          try {
            await client.query('BEGIN');
            await new IdentityProcessor(worker).apply(client, eventId);
            sending = sender()
              .send(item.outboundId)
              .then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
            let waiting = false;
            for (let i = 0; i < 150; i++) {
              if (
                (
                  await admin.query(
                    "SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'",
                    [appName],
                  )
                ).rowCount
              ) {
                waiting = true;
                break;
              }
              await setTimeout(10);
            }
            assert.ok(waiting, 'sender must wait for the same user lock');
            assert.equal((await scheduler.sweep()).examined, 0);
            assert.equal(calls, 0);
            await client.query('COMMIT');
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
          const result = await sending;
          assert.equal(result?.error, undefined);
          assert.equal(result?.value?.state, 'suppressed');
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'STOP invalidates controls and cannot be undone by a delayed reminder button',
        async () => {
          await reset();
          const item = await seed(),
            reference = await referenceFor(item);
          await inbound(alice, 'STOP');
          await new IdentityProcessor(worker).processNext();
          const eventId = await commandEvent(reference, 'snooze');
          assert.equal((await new IdentityProcessor(worker).processNext())?.disposition, 'blocked');
          assert.equal(
            (await worker.query('SELECT 1 FROM reminder_mutations WHERE event_id=$1', [eventId]))
              .rowCount,
            0,
          );
          assert.equal((await reminder(item.reminderId)).schedule_version, 1);
          assert.ok(
            (
              await worker.query(
                'SELECT invalidated_at FROM reminder_controls WHERE reference=$1',
                [reference],
              )
            ).rows[0].invalidated_at,
          );
          assert.equal((await sender().send(item.outboundId)).state, 'suppressed');
          assert.equal(calls, 0);
        },
      );
      await t.test(
        'control and mutation tables enforce tenant isolation, immutable receipts and narrow grants',
        async () => {
          await reset();
          const a = await seed(alice),
            b = await seed(bob);
          const ar = await referenceFor(a),
            br = await referenceFor(b);
          await processCommand(await commandEvent(ar, 'cancel'));
          await processCommand(await commandEvent(br, 'cancel', bob));
          for (const table of ['reminder_controls', 'reminder_mutations']) {
            assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
            await withTenant(tenant, a.userId, async (client) => {
              const rows = (await client.query(`SELECT user_id FROM ${table}`)).rows;
              assert.equal(rows.length, 1);
              assert.equal(rows[0].user_id, a.userId);
              await assert.rejects(client.query(`DELETE FROM ${table}`), /permission denied/);
            });
            await assert.rejects(ingress.query(`SELECT * FROM ${table}`), /permission denied/);
            const flags = (
              await admin.query(
                'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
                [`${schema}.${table}`],
              )
            ).rows[0];
            assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
          }
          await assert.rejects(
            worker.query("UPDATE reminder_mutations SET reply_text='forged'"),
            /permission denied/,
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO reminder_mutations(event_id,user_id,action,outcome,reply_text)
            VALUES($1,$2,'cancel','stale','forged')`,
              [a.eventId, b.userId],
            ),
            /owner mismatch/,
          );
          await assert.rejects(
            worker.query(
              "UPDATE reminder_controls SET expires_at=clock_timestamp()+interval '1 year'",
            ),
            /permission denied/,
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO reminder_controls(user_id,reminder_id,schedule_version,consent_grant_at,timezone_confirmed_at,timezone,expires_at)
          VALUES($1,$2,99,now(),now(),'UTC',now())`,
              [a.userId, b.reminderId],
            ),
            /foreign key/,
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
