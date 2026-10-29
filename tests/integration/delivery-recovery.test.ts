import { DeliveryRecovery } from '../../src/modules/whatsapp/recovery.js';
import { persistSendResult } from '../../src/modules/whatsapp/attempts.js';
import { TestReplySender } from '../../src/modules/whatsapp/dispatch.js';
import { ReminderSender } from '../../src/modules/delivery/reminder-sender.js';
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
  'delivery recovery and bounded retries under restricted database logins',
  { timeout: 60000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `test_${suffix}`;
    const appName = `delivery_recovery_${suffix}`;
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
        (
          await worker.query(
            'SELECT * FROM whatsapp_attempts WHERE outbound_message_id=$1 ORDER BY attempt_no DESC',
            [id],
          )
        ).rows[0];
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

      const recovery = new DeliveryRecovery(worker),
        control = new DeliveryRecovery(admin);
      const makeDue = (id: string) =>
        admin.query(
          "UPDATE whatsapp_attempts SET retry_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [id],
        );
      const expireDispatch = (id: string) =>
        admin.query(
          "UPDATE whatsapp_attempts SET dispatch_deadline=clock_timestamp()-interval '1 second' WHERE id=$1",
          [id],
        );
      const retryTransport: WhatsAppTransport = {
        send: async () => {
          calls++;
          return { state: 'rejected', code: 'meta_130429', retryable: true };
        },
      };
      const unknownTransport: WhatsAppTransport = {
        send: async () => {
          calls++;
          return { state: 'unknown', code: 'timeout' };
        },
      };
      const decision = {
        action: 'not_sent',
        senderStopped: true,
        note: 'Synthetic provider evidence confirms no message was created; old sender stopped',
      };

      await t.test(
        'retryable rejection backs off, concurrent retry claims produce one successor and stop at three',
        async () => {
          await reset();
          const item = await seed();
          await sender(retryTransport).send(item.outboundId);
          let first = await attempt(item.outboundId);
          assert.equal(first.recovery_state, 'retry_wait');
          assert.ok(first.retry_at.getTime() - first.updated_at.getTime() >= 59000);
          await assert.rejects(sender().send(item.outboundId), /retry not due/);
          assert.equal(calls, 1);
          await makeDue(first.id);
          const outcomes = await Promise.allSettled(
            Array.from({ length: 8 }, () => sender(retryTransport).send(item.outboundId)),
          );
          assert.ok(outcomes.some((r) => r.status === 'fulfilled'));
          let second = await attempt(item.outboundId);
          assert.equal(second.attempt_no, 2);
          assert.equal(second.previous_attempt_id, first.id);
          assert.ok(second.retry_at.getTime() - second.updated_at.getTime() >= 239000);
          assert.equal(
            (
              await worker.query('SELECT recovery_state FROM whatsapp_attempts WHERE id=$1', [
                first.id,
              ])
            ).rows[0].recovery_state,
            'retried',
          );
          assert.equal(second.retry_until.toISOString(), first.retry_until.toISOString());
          await makeDue(second.id);
          await sender(retryTransport).send(item.outboundId);
          const third = await attempt(item.outboundId);
          assert.equal(third.attempt_no, 3);
          assert.equal(third.recovery_state, 'exhausted');
          assert.equal(third.retry_at, null);
          await sender().send(item.outboundId);
          assert.equal(calls, 3);
          await assert.rejects(
            control.reconcile(third.id, { action: 'retry', note: 'try again' }),
            /definite rejection/,
          );
          assert.equal(
            (await worker.query('SELECT count(*)::int n FROM whatsapp_attempts')).rows[0].n,
            3,
          );
        },
      );

      await t.test(
        'expired dispatches recover once to unknown, stay held, and bound each recovery pass',
        async () => {
          await reset();
          const item = await seed();
          await sender(unknownTransport).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await admin.query("UPDATE whatsapp_attempts SET state='dispatching'");
          assert.equal(await recovery.recover(), 0);
          await expireDispatch(old.id);
          const recovered = await Promise.all(Array.from({ length: 8 }, () => recovery.recover(1)));
          assert.equal(
            recovered.reduce((a, b) => a + b, 0),
            1,
          );
          assert.equal((await attempt(item.outboundId)).state, 'unknown');
          assert.equal(await recovery.recover(), 0);
          await sender().send(item.outboundId);
          assert.equal(calls, 1);
          assert.equal(
            (
              await worker.query(
                "SELECT count(*)::int n FROM delivery_recovery_audit WHERE action='dispatch_expired'",
              )
            ).rows[0].n,
            1,
          );
          for (const limit of [0, 501, 1.5])
            await assert.rejects(recovery.recover(limit), /Recovery limit/);
          const other = await seed(bob);
          await sender(unknownTransport).send(other.outboundId);
          await admin.query(
            "UPDATE whatsapp_attempts SET state='dispatching',dispatch_deadline=clock_timestamp()-interval '1 second'",
          );
          assert.equal(await recovery.recover(1), 1);
          assert.equal(await recovery.recover(1), 1);
        },
      );

      await t.test(
        'operator acceptance links early receipts, is idempotent, and rejects conflicting addresses or provider IDs',
        async () => {
          await reset();
          const item = await seed();
          await sender(unknownTransport).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await receipt('wamid.proof', 'read');
          const accepted = {
            action: 'accepted',
            note: 'Synthetic provider log identifies this attempt',
            phoneNumberId: phone,
            recipientId: alice,
            providerMessageId: 'wamid.proof',
          };
          await assert.rejects(
            control.reconcile(old.id, { ...accepted, recipientId: bob }),
            /address mismatch/,
          );
          await assert.rejects(
            control.reconcile(old.id, { ...accepted, phoneNumberId: '99999' }),
            /address mismatch/,
          );
          await Promise.all([
            control.reconcile(old.id, accepted),
            control.reconcile(old.id, accepted),
          ]);
          assert.equal((await attempt(item.outboundId)).state, 'accepted');
          assert.equal((await attempt(item.outboundId)).delivery_status, 'read');
          await receipt('wamid.proof', 'sent');
          assert.equal((await attempt(item.outboundId)).delivery_status, 'read');
          await assert.rejects(
            control.reconcile(old.id, { ...accepted, providerMessageId: 'conflict' }),
            /Conflicting/,
          );
          await assert.rejects(control.reconcile(old.id, decision), /Unresolved/);
          assert.equal(
            (
              await worker.query(
                "SELECT count(*)::int n FROM delivery_recovery_audit WHERE action='operator_accepted'",
              )
            ).rows[0].n,
            1,
          );
          await sender().send(item.outboundId);
          assert.equal(calls, 1);
        },
      );

      await t.test(
        'unknown retry requires evidence after the deadline; successor rechecks template/window and STOP',
        async () => {
          await reset();
          const item = await seed();
          await sender(unknownTransport).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await assert.rejects(control.reconcile(old.id, decision), /deadline/);
          await expireDispatch(old.id);
          await control.reconcile(old.id, decision);
          await control.reconcile(old.id, decision);
          assert.equal((await attempt(item.outboundId)).resolution, 'not_sent');
          await makeDue(old.id);
          await closeWindow();
          await assert.rejects(sender().send(item.outboundId), /template unavailable/);
          assert.equal((await attempt(item.outboundId)).attempt_no, 1);
          await template();
          await sender().send(item.outboundId);
          const sent = await attempt(item.outboundId);
          assert.equal(sent.attempt_no, 2);
          assert.ok(sent.message_payload.template);
          await reset();
          const stopped = await seed();
          await sender(retryTransport).send(stopped.outboundId);
          await makeDue((await attempt(stopped.outboundId)).id);
          await inbound(alice, 'STOP');
          await new IdentityProcessor(worker).processNext();
          assert.equal((await sender().send(stopped.outboundId)).state, 'suppressed');
          assert.equal(calls, 1);
        },
      );

      await t.test(
        'abandon preserves uncertainty but releases ordering; late contradictory acceptance pauses sends',
        async () => {
          await reset();
          const first = await seed(alice, new Date(Date.now() - 7200000).toISOString());
          const second = await seed();
          await sender(unknownTransport).send(first.outboundId);
          const old = await attempt(first.outboundId);
          await assert.rejects(sender().send(second.outboundId), /Earlier delivery/);
          await expireDispatch(old.id);
          await control.reconcile(old.id, {
            action: 'abandon',
            note: 'Close without claiming non-delivery or resending',
          });
          await control.reconcile(old.id, { action: 'abandon', note: 'Replay' });
          assert.equal((await attempt(first.outboundId)).state, 'unknown');
          assert.equal((await attempt(first.outboundId)).recovery_state, 'abandoned');
          await sender().send(second.outboundId);
          assert.equal(calls, 2);
          await persistSendResult(worker, old.id, {
            state: 'accepted',
            providerMessageId: 'late.contradiction',
          });
          assert.equal(
            (await worker.query('SELECT enabled FROM usage_policy')).rows[0].enabled,
            false,
          );
          assert.equal((await attempt(first.outboundId)).state, 'unknown');
          const audit = (
            await worker.query(
              "SELECT details FROM delivery_recovery_audit WHERE action='late_acceptance_conflict'",
            )
          ).rows[0];
          assert.equal(audit.details.providerMessageId, 'late.contradiction');
          const status = (await control.status()) as { id: string; unresolved_conflict: boolean }[];
          assert.ok(status.some((row) => row.id === old.id && row.unresolved_conflict));
          await control.reconcile(old.id, {
            action: 'accepted',
            note: 'Verified late evidence',
            phoneNumberId: phone,
            recipientId: alice,
            providerMessageId: 'late.contradiction',
          });
          await receipt('late.contradiction');
          assert.equal((await attempt(first.outboundId)).delivery_status, 'delivered');
          assert.equal(
            (await worker.query('SELECT enabled FROM usage_policy')).rows[0].enabled,
            false,
          );
        },
      );

      await t.test(
        'late real results can resolve a recovered unknown but cannot overwrite a newer retry',
        async () => {
          await reset();
          const item = await seed();
          await sender(unknownTransport).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await admin.query("UPDATE whatsapp_attempts SET state='dispatching'");
          await expireDispatch(old.id);
          await recovery.recover();
          await persistSendResult(worker, old.id, {
            state: 'accepted',
            providerMessageId: 'late.known',
          });
          await receipt('late.known');
          assert.equal((await attempt(item.outboundId)).delivery_status, 'delivered');
          await reset();
          const retry = await seed();
          await sender(unknownTransport).send(retry.outboundId);
          const prior = await attempt(retry.outboundId);
          await expireDispatch(prior.id);
          await control.reconcile(prior.id, decision);
          await makeDue(prior.id);
          await sender().send(retry.outboundId);
          await persistSendResult(worker, prior.id, { state: 'unknown', code: 'late.timeout' });
          assert.equal((await attempt(retry.outboundId)).state, 'accepted');
          await persistSendResult(worker, prior.id, {
            state: 'accepted',
            providerMessageId: 'contradicts.not_sent',
          });
          assert.equal(
            (await worker.query('SELECT enabled FROM usage_policy')).rows[0].enabled,
            false,
          );
          assert.equal(
            (await worker.query('SELECT state FROM whatsapp_attempts WHERE id=$1', [prior.id]))
              .rows[0].state,
            'rejected',
          );
        },
      );

      await t.test(
        'retry horizon expires durably; paused policy blocks retries while recovery still works',
        async () => {
          await reset();
          const item = await seed();
          await sender(retryTransport).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await makeDue(old.id);
          await admin.query('UPDATE usage_policy SET enabled=false');
          await assert.rejects(sender().send(item.outboundId), /Global/);
          await admin.query(
            "UPDATE whatsapp_attempts SET retry_until=clock_timestamp()-interval '1 second'",
          );
          assert.equal(await recovery.recover(), 1);
          assert.equal((await attempt(item.outboundId)).recovery_state, 'exhausted');
          await admin.query('UPDATE usage_policy SET enabled=true');
          await sender().send(item.outboundId);
          assert.equal(calls, 1);
        },
      );

      await t.test(
        'provider Retry-After extends backoff and a wait past the horizon exhausts without sending',
        async () => {
          for (const delay of [3600, 172800]) {
            await reset();
            const item = await seed();
            await sender({
              send: async () => ({
                state: 'rejected',
                code: 'meta_130429',
                retryable: true,
                retryAfterSeconds: delay,
              }),
            }).send(item.outboundId);
            const row = await attempt(item.outboundId);
            if (delay === 3600) {
              assert.equal(row.recovery_state, 'retry_wait');
              assert.ok(row.retry_at.getTime() - row.updated_at.getTime() >= 3599000);
            } else {
              assert.equal(row.recovery_state, 'exhausted');
              assert.equal(row.retry_at, null);
            }
            assert.equal(calls, 0);
          }
        },
      );

      await t.test(
        'queued retry preserves ordering and one blocked user does not prevent independent delivery',
        async () => {
          await reset();
          const first = await seed(alice, new Date(Date.now() - 7200000).toISOString());
          const second = await seed();
          const other = await seed(bob);
          await sender(retryTransport).send(first.outboundId);
          await assert.rejects(sender().send(second.outboundId), /Earlier delivery/);
          assert.deepEqual(await sender().sendPending(), { examined: 2, attempted: 1, blocked: 1 });
          assert.equal((await attempt(other.outboundId)).state, 'accepted');
          await makeDue((await attempt(first.outboundId)).id);
          await sender().sendPending();
          await sender().sendPending();
          assert.equal((await attempt(second.outboundId)).state, 'accepted');
          assert.equal(calls, 4);
        },
      );

      await t.test(
        'recovery and reconciliation audits commit atomically, including failed retry authorization',
        async () => {
          await reset();
          const item = await seed();
          await sender(unknownTransport).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await expireDispatch(old.id);
          await admin.query(`CREATE FUNCTION fail_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;
          CREATE TRIGGER fail_recovery_audit BEFORE INSERT ON delivery_recovery_audit FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()`);
          try {
            await assert.rejects(control.reconcile(old.id, decision), /synthetic audit failure/);
          } finally {
            await admin.query(
              'DROP TRIGGER fail_recovery_audit ON delivery_recovery_audit; DROP FUNCTION fail_recovery_audit()',
            );
          }
          assert.equal((await attempt(item.outboundId)).state, 'unknown');
          assert.equal((await attempt(item.outboundId)).resolution, null);
          await control.reconcile(old.id, decision);
          await makeDue(old.id);
          await admin.query(`CREATE FUNCTION fail_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.attempt_no=2 THEN RAISE EXCEPTION 'synthetic retry failure'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER fail_retry AFTER INSERT ON whatsapp_attempts FOR EACH ROW EXECUTE FUNCTION fail_retry()`);
          try {
            await assert.rejects(sender().send(item.outboundId), /synthetic retry failure/);
          } finally {
            await admin.query(
              'DROP TRIGGER fail_retry ON whatsapp_attempts; DROP FUNCTION fail_retry()',
            );
          }
          assert.equal((await attempt(item.outboundId)).recovery_state, 'retry_wait');
          assert.equal((await attempt(item.outboundId)).attempt_no, 1);
          await sender().send(item.outboundId);
          assert.equal(calls, 2);
        },
      );

      await t.test(
        'onboarding replies use bounded retries and stale control replies are suppressed',
        async () => {
          await reset();
          const identity = new IdentityProcessor(worker);
          const event = await inbound(alice, 'hello');
          await identity.processNext();
          const sendReply = (custom = transport) =>
            new TestReplySender(worker, custom, policy).send(event);
          await sendReply(retryTransport);
          const old = (await worker.query('SELECT * FROM whatsapp_attempts')).rows[0];
          await makeDue(old.id);
          await sendReply();
          assert.equal(calls, 2);
          assert.equal(
            (await worker.query('SELECT max(attempt_no) AS n FROM whatsapp_attempts')).rows[0].n,
            2,
          );
          await reset();
          const stale = await inbound(alice, 'hello');
          await identity.processNext();
          await new TestReplySender(worker, retryTransport, policy).send(stale);
          await makeDue((await worker.query('SELECT id FROM whatsapp_attempts')).rows[0].id);
          await inbound(alice, 'STOP');
          await identity.processNext();
          assert.equal(
            (await new TestReplySender(worker, transport, policy).send(stale)).state,
            'suppressed',
          );
          assert.equal(calls, 1);
        },
      );

      await t.test(
        'permanent rejections require operator retry; accepted or overtaken messages cannot be retried',
        async () => {
          await reset();
          const item = await seed();
          await sender({
            send: async () => {
              calls++;
              return { state: 'rejected', code: 'meta_132001' };
            },
          }).send(item.outboundId);
          const old = await attempt(item.outboundId);
          await sender().send(item.outboundId);
          assert.equal(calls, 1);
          await control.reconcile(old.id, {
            action: 'retry',
            note: 'Synthetic template configuration corrected',
          });
          await makeDue(old.id);
          await sender().send(item.outboundId);
          await assert.rejects(
            control.reconcile((await attempt(item.outboundId)).id, {
              action: 'retry',
              note: 'retry accepted',
            }),
            /definite rejection/,
          );
          await reset();
          const earlier = await seed(alice, new Date(Date.now() - 7200000).toISOString());
          const later = await seed();
          await sender({ send: async () => ({ state: 'rejected', code: 'invalid_message' }) }).send(
            earlier.outboundId,
          );
          await sender().send(later.outboundId);
          await assert.rejects(
            control.reconcile((await attempt(earlier.outboundId)).id, {
              action: 'retry',
              note: 'Too late',
            }),
            /later send/,
          );
        },
      );

      await t.test(
        'operator controls and audit isolation reject runtime forgery and invalid retry chains',
        async () => {
          await reset();
          const a = await seed(),
            b = await seed(bob);
          await sender(unknownTransport).send(a.outboundId);
          await sender(unknownTransport).send(b.outboundId);
          const old = await attempt(a.outboundId);
          await expireDispatch(old.id);
          for (const pool of [worker, tenant, ingress])
            await assert.rejects(
              new DeliveryRecovery(pool).reconcile(old.id, decision),
              /administrator/,
            );
          await assert.rejects(
            worker.query("UPDATE whatsapp_attempts SET resolution='not_sent' WHERE id=$1", [
              old.id,
            ]),
            /administrator/,
          );
          await assert.rejects(
            worker.query("UPDATE whatsapp_attempts SET recovery_state='abandoned' WHERE id=$1", [
              old.id,
            ]),
            /administrator/,
          );
          await assert.rejects(
            worker.query(
              "INSERT INTO delivery_recovery_audit(user_id,attempt_id,action,actor) VALUES($1,$2,'operator_not_sent','forged')",
              [a.userId, old.id],
            ),
            /administrator/,
          );
          assert.equal((await tenant.query('SELECT * FROM delivery_recovery_audit')).rowCount, 0);
          await withTenant(tenant, a.userId, async (client) => {
            const rows = await client.query('SELECT user_id FROM delivery_recovery_audit');
            assert.ok(rows.rowCount);
            assert.ok(rows.rows.every((row) => row.user_id === a.userId));
          });
          for (const pool of [worker, tenant, ingress])
            await assert.rejects(
              pool.query('DELETE FROM delivery_recovery_audit'),
              /permission denied/,
            );
          await assert.rejects(
            ingress.query('SELECT * FROM delivery_recovery_audit'),
            /permission denied/,
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,attempt_no,previous_attempt_id,retry_until)
          VALUES($1,$2,$3,$4,'suppressed',2,$5,$6)`,
              [a.userId, a.outboundId, phone, alice, old.id, old.retry_until],
            ),
            /ineligible/,
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,attempt_no,previous_attempt_id,retry_until)
          VALUES($1,$2,$3,$4,'suppressed',2,$5,$6)`,
              [b.userId, b.outboundId, phone, bob, old.id, old.retry_until],
            ),
            /ineligible/,
          );
          const flags = (
            await admin.query(
              'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
              [`${schema}.delivery_recovery_audit`],
            )
          ).rows[0];
          assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
          assert.ok(Array.isArray(await control.status()));
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
