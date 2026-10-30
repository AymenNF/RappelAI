import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { withTenant } from '../../src/db/tenant.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { WorkQueue } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ExecutionProcessor } from '../../src/modules/processing/execution.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';
import { TestReplySender } from '../../src/modules/whatsapp/dispatch.js';
import { ReceiptProcessor } from '../../src/modules/whatsapp/receipts.js';
import type { WhatsAppTransport } from '../../src/modules/whatsapp/send.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'WhatsApp test dispatch and receipts under restricted logins',
  { timeout: 60000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '');
    const schema = `test_${suffix}`;
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
        queue = new WorkQueue(worker);
      const runner = new WorkRunner(queue, 'delivery-tests'),
        receipts = new ReceiptProcessor();
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
      const sender = (custom = transport) => new TestReplySender(worker, custom, policy);
      const reset = async () => {
        calls = 0;
        await admin.query('TRUNCATE users,ingress_events CASCADE');
        await admin.query('UPDATE usage_policy SET enabled=true');
      };
      const inbound = async (recipient = alice, body = 'synthetic request') => {
        const key = randomUUID();
        await store.persist([
          {
            eventKey: key,
            kind: 'inbound.message',
            phoneNumberId: phone,
            providerMessageId: key,
            senderId: recipient,
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
      const plan = async (recipient = alice) => {
        const at = new Date(Date.now() - 10000);
        await admin.query(
          `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,timezone,timezone_confirmed_at,window_expires_at)
        VALUES($1,$2,$3,$4,'UTC',$4,clock_timestamp()+interval '1 hour') ON CONFLICT DO NOTHING`,
          [phone, recipient, CONSENT_VERSION, at],
        );
        const eventId = await inbound(recipient);
        const user = (await worker.query('SELECT * FROM users WHERE sender_id=$1', [recipient]))
          .rows[0];
        await worker.query(
          `INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,'ready',$3,$4)`,
          [eventId, user.id, user.consent_at, user.timezone_confirmed_at],
        );
        await worker.query(
          `INSERT INTO action_plans(event_id,user_id,schema_version,decision,provider,model,prompt_version,prompt_sha256,input_sha256,
        input_tokens,output_tokens,latency_ms,reference_at,validated_at,consent_grant_at,timezone_confirmed_at,timezone)
        VALUES($1,$2,'decision-v1',$3,'fake','test-v1','intent-v1',$4,$4,0,0,0,clock_timestamp(),clock_timestamp(),$5,$6,'UTC')`,
          [
            eventId,
            user.id,
            {
              behavior: 'execute',
              calls: [
                { tool: 'add_list_item', args: { list_name: 'Test', text: 'synthetic item' } },
              ],
            },
            PROMPT_SHA256,
            user.consent_at,
            user.timezone_confirmed_at,
          ],
        );
        await admin.query("UPDATE work_outbox SET stage='execution' WHERE event_id=$1", [eventId]);
        assert.equal(await runner.runOne('execution', new ExecutionProcessor()), true);
        return { eventId, userId: user.id as string };
      };
      const receipt = async (
        id: string,
        status = 'delivered',
        recipient = alice,
        business = phone,
      ) => {
        const key = randomUUID();
        await store.persist([
          {
            eventKey: key,
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
        return (await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [key]))
          .rows[0].id as string;
      };
      const drain = async () => {
        while (await runner.runOne('receipt', receipts)) {
          /* drain */
        }
      };
      const attempt = async () =>
        (await worker.query('SELECT * FROM whatsapp_attempts ORDER BY created_at')).rows[0];

      await t.test(
        'concurrent dispatch and replay make one call; acceptance is not delivery',
        async () => {
          await reset();
          const item = await plan();
          await Promise.all(Array.from({ length: 8 }, () => sender().send(item.eventId)));
          assert.equal(calls, 1);
          assert.equal((await attempt()).state, 'accepted');
          assert.equal((await attempt()).delivery_status, 'none');
          await sender().send(item.eventId);
          assert.equal(calls, 1);
        },
      );
      await t.test(
        'early, duplicated and reordered receipts converge without changing accepted state',
        async () => {
          await reset();
          const item = await plan();
          await sender({
            send: async () => {
              await receipt('wamid.early', 'read');
              await drain();
              assert.equal(
                (await worker.query('SELECT attempt_id FROM whatsapp_receipts')).rows[0].attempt_id,
                null,
              );
              return { state: 'accepted', providerMessageId: 'wamid.early' };
            },
          }).send(item.eventId);
          assert.equal((await attempt()).delivery_status, 'read');
          const event = await receipt('wamid.early', 'sent');
          await receipt('wamid.early', 'failed');
          await drain();
          await admin.query("UPDATE work_outbox SET status='pending' WHERE event_id=$1", [event]);
          await drain();
          assert.equal((await attempt()).state, 'accepted');
          assert.equal((await attempt()).delivery_status, 'read');
          assert.equal(
            (await worker.query('SELECT count(*)::int AS n FROM whatsapp_receipts')).rows[0].n,
            3,
          );
        },
      );
      await t.test(
        'receipt transaction rollback leaves work retryable with no partial receipt',
        async () => {
          await reset();
          const item = await plan();
          await sender().send(item.eventId);
          const original = await attempt();
          const event = await receipt(original.provider_message_id);
          const lease = await queue.claim('receipt', 'manual');
          assert.ok(lease);
          await assert.rejects(
            queue.commit(lease, async (client) => {
              await receipts.apply(client, lease);
              throw new Error('injected');
            }),
          );
          assert.equal(
            (await worker.query('SELECT count(*)::int AS n FROM whatsapp_receipts')).rows[0].n,
            0,
          );
          await queue.fail(lease, 'handler_failed', 0);
          await drain();
          assert.equal((await attempt()).delivery_status, 'delivered');
          assert.ok(
            (await worker.query('SELECT processed_at FROM ingress_events WHERE id=$1', [event]))
              .rows[0].processed_at,
          );
        },
      );
      await t.test(
        'timeouts and rejected sends never blindly retry; unknown blocks later replies',
        async () => {
          await reset();
          const first = await plan();
          let network = 0;
          const stuck = sender({
            send: async () => {
              network++;
              return new Promise(() => {});
            },
          });
          assert.equal((await stuck.send(first.eventId)).state, 'unknown');
          await stuck.send(first.eventId);
          assert.equal(network, 1);
          const later = await plan();
          await assert.rejects(sender().send(later.eventId), /Earlier reply/);
          await reset();
          const rejected = await plan();
          const deny = sender({
            send: async () => {
              network++;
              return { state: 'rejected', code: 'meta_131047' };
            },
          });
          await deny.send(rejected.eventId);
          await deny.send(rejected.eventId);
          assert.equal(network, 2);
        },
      );
      await t.test(
        'failed result persistence retains dispatching and blocks redispatch',
        async () => {
          await reset();
          const item = await plan();
          await admin.query(`CREATE FUNCTION fail_send_finish() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$;
        CREATE TRIGGER fail_finish BEFORE UPDATE ON whatsapp_attempts FOR EACH ROW EXECUTE FUNCTION fail_send_finish()`);
          try {
            await assert.rejects(sender().send(item.eventId), /injected/);
          } finally {
            await admin.query(
              'DROP TRIGGER fail_finish ON whatsapp_attempts; DROP FUNCTION fail_send_finish()',
            );
          }
          assert.equal((await attempt()).state, 'dispatching');
          await sender().send(item.eventId);
          assert.equal(calls, 1);
        },
      );
      await t.test(
        'disabled, global pause, allowlist, window, revoked consent and changed timezone fence sends',
        async () => {
          await reset();
          let item = await plan();
          await assert.rejects(
            new TestReplySender(worker, transport, { ...policy, enabled: false }).send(
              item.eventId,
            ),
            /disabled/,
          );
          await assert.rejects(
            new TestReplySender(worker, transport, { ...policy, recipients: [bob] }).send(
              item.eventId,
            ),
            /allowlist/,
          );
          await admin.query('UPDATE usage_policy SET enabled=false');
          await assert.rejects(sender().send(item.eventId), /Global/);
          assert.equal(calls, 0);
          for (const mutation of [
            'window_expires_at=clock_timestamp()',
            'paused=true,consent_at=NULL,consent_version=NULL',
            'timezone_confirmed_at=clock_timestamp()',
          ]) {
            await reset();
            item = await plan();
            await admin.query(`UPDATE users SET ${mutation}`);
            assert.equal((await sender().send(item.eventId)).state, 'suppressed');
            assert.equal(calls, 0);
          }
        },
      );
      await t.test(
        'only latest onboarding response sends; STOP confirmation can send while assistant is paused',
        async () => {
          await reset();
          const identity = new IdentityProcessor(worker);
          const first = await inbound(alice, 'hello');
          await identity.processNext();
          const stop = await inbound(alice, 'STOP');
          await identity.processNext();
          assert.equal((await sender().send(first)).state, 'suppressed');
          let body = '';
          await sender({
            send: async (message) => {
              assert.ok('body' in message);
              body = message.body;
              return { state: 'accepted', providerMessageId: 'wamid.stop' };
            },
          }).send(stop);
          assert.match(body, /Consent withdrawn/);
          assert.equal((await worker.query('SELECT paused FROM users')).rows[0].paused, true);
        },
      );
      await t.test(
        'pending replies remain ordered and STOP suppresses an unsent plan reply',
        async () => {
          await reset();
          const first = await plan(),
            second = await plan();
          await assert.rejects(sender().send(second.eventId), /Earlier reply/);
          await sender().send(first.eventId);
          await sender().send(second.eventId);
          assert.equal(calls, 2);
          const third = await plan();
          await inbound(alice, 'STOP');
          await new IdentityProcessor(worker).processNext();
          assert.equal((await sender().send(third.eventId)).state, 'suppressed');
          assert.equal(calls, 2);
        },
      );
      await t.test(
        'STOP commits during network I/O; an already authorized send is recorded truthfully',
        async () => {
          await reset();
          const item = await plan();
          let started!: () => void, release!: () => void;
          const entered = new Promise<void>((resolve) => {
            started = resolve;
          });
          const waiting = new Promise<void>((resolve) => {
            release = resolve;
          });
          const sending = new TestReplySender(
            worker,
            {
              send: async () => {
                started();
                await waiting;
                return { state: 'accepted', providerMessageId: 'wamid.inflight' };
              },
            },
            { ...policy, timeoutMs: 10000 },
          ).send(item.eventId);
          await entered;
          try {
            await inbound(alice, 'STOP');
            await new IdentityProcessor(worker).processNext();
            assert.equal(
              (await worker.query('SELECT status FROM reply_intents')).rows[0].status,
              'suppressed',
            );
          } finally {
            release();
          }
          assert.equal((await sending).state, 'accepted');
          await receipt('wamid.inflight');
          await drain();
          assert.equal((await attempt()).delivery_status, 'delivered');
        },
      );
      await t.test(
        'wrong business or recipient cannot attach receipts; tenant isolation and ownership constraints hold',
        async () => {
          await reset();
          const a = await plan(),
            b = await plan(bob);
          await sender().send(a.eventId);
          await sender().send(b.eventId);
          const sent = await attempt();
          await receipt(sent.provider_message_id, 'read', bob);
          await receipt(sent.provider_message_id, 'read', alice, '99999');
          await drain();
          assert.equal((await attempt()).delivery_status, 'none');
          await receipt(sent.provider_message_id, 'delivered');
          await drain();
          for (const table of ['whatsapp_attempts', 'whatsapp_receipts']) {
            const flags = (
              await admin.query(
                'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
                [`${schema}.${table}`],
              )
            ).rows[0];
            assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
            await withTenant(tenant, a.userId, async (client) => {
              const rows = await client.query(`SELECT user_id FROM ${table}`);
              assert.equal(rows.rowCount, 1);
              assert.ok(rows.rows.every((row) => row.user_id === a.userId));
            });
            await assert.rejects(
              withTenant(tenant, a.userId, (client) => client.query(`DELETE FROM ${table}`)),
              /permission denied/,
            );
            await assert.rejects(ingress.query(`SELECT * FROM ${table}`), /permission denied/);
          }
          await assert.rejects(
            worker.query('UPDATE whatsapp_receipts SET status=$1', ['read']),
            /permission denied/,
          );
          await assert.rejects(
            worker.query('UPDATE whatsapp_attempts SET recipient_id=$1', [bob]),
            /permission denied/,
          );
          const c = await plan();
          await assert.rejects(
            worker.query(
              `INSERT INTO whatsapp_attempts(user_id,event_id,reply_event_id,phone_number_id,recipient_id,state)
        VALUES($1,$2,$2,$3,$4,'dispatching')`,
              [b.userId, c.eventId, phone, bob],
            ),
            /foreign key/,
          );
        },
      );
      await t.test(
        'unknown statuses are retained without claiming delivery; malformed receipts dead-letter',
        async () => {
          await reset();
          const item = await plan();
          await sender().send(item.eventId);
          const sent = await attempt();
          await receipt(sent.provider_message_id, 'future_status');
          await drain();
          assert.equal((await attempt()).delivery_status, 'none');
          const event = await receipt('bad');
          await admin.query(
            "UPDATE ingress_events SET payload=payload-'recipient_id' WHERE id=$1",
            [event],
          );
          await drain();
          assert.equal(
            (await worker.query('SELECT status FROM work_outbox WHERE event_id=$1', [event]))
              .rows[0].status,
            'dead',
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
