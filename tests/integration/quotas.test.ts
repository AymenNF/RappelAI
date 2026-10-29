import { QuotaControl, quotaPolicy } from '../../src/modules/quotas/control.js';
import { consumeQuota, admitRequest, quotaSummary } from '../../src/modules/quotas/service.js';
import { UsageService } from '../../src/modules/usage/service.js';
import { UsageControl } from '../../src/modules/usage/control.js';
import { ReminderScheduler } from '../../src/modules/reminders/scheduler.js';
import { ReminderSender } from '../../src/modules/delivery/reminder-sender.js';
import { TestReplySender } from '../../src/modules/whatsapp/dispatch.js';
import { IngressCapacityError, IngressBatchError } from '../../src/db/ingress-store.js';
import type { WorkLease } from '../../src/modules/processing/leases.js';
import { applyListCommand } from '../../src/modules/lists/management.js';
import { listCommand } from '../../src/modules/lists/commands.js';
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
import { WorkQueue } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ExecutionProcessor } from '../../src/modules/processing/execution.js';
import { addListItem } from '../../src/modules/lists/service.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'abuse controls and atomic quotas under restricted runtime logins',
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
      const { singleton, ...defaults } = await new QuotaControl(admin).status();
      const reset = async () => {
        await admin.query(
          'TRUNCATE users,ingress_events,usage_global_periods,quota_global_counters,model_rate_cards CASCADE',
        );
        await new QuotaControl(admin).change(defaults, 'reset');
        await admin.query('UPDATE usage_policy SET enabled=false');
      };
      const limits = async (values: Record<string, number>) =>
        new QuotaControl(admin).change({ ...defaults, ...values }, 'test');
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
      const atomic = async <T>(userId: string, fn: (c: pg.PoolClient) => Promise<T>) => {
        const c = await worker.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
          const r = await fn(c);
          await c.query('COMMIT');
          return r;
        } catch (e) {
          await c.query('ROLLBACK');
          throw e;
        } finally {
          c.release();
        }
      };
      const used = async (userId: string, metric: string) =>
        (
          await worker.query(
            'SELECT COALESCE(sum(used),0)::integer AS n FROM quota_counters WHERE user_id=$1 AND metric=$2',
            [userId, metric],
          )
        ).rows[0].n;
      await t.test(
        'incoming limits reject before mutation, report once per minute, and preserve STOP',
        async () => {
          await reset();
          const a = await add();
          await limits({ requests_minute: 1 });
          assert.equal((await run('LISTS')).identity.disposition, 'handled');
          const denied = await run('EDIT ITEM "Grocery" #1 TO "changed"');
          assert.match(denied.identity.reply_text, /Request limit reached/);
          assert.equal((await run('LISTS')).identity.reply_text, null);
          assert.equal((await worker.query('SELECT * FROM list_choices')).rowCount, 0);
          assert.match((await run('QUOTA')).identity.reply_text, /Requests: 1\/1/);
          assert.equal((await run('QUOTA')).identity.reply_text, null);
          assert.match((await run('STOP')).identity.reply_text, /paused|stop|withdraw/i);
          assert.equal(
            (await worker.query('SELECT paused FROM users WHERE id=$1', [a.userId])).rows[0].paused,
            true,
          );
        },
      );
      await t.test(
        'daily denial, oversized input and blocked-account notices have actionable wording',
        async () => {
          await reset();
          const a = await add();
          await limits({ requests_day: 0 });
          assert.match((await run('LISTS')).identity.reply_text, /00:00 UTC/);
          await admin.query('DELETE FROM quota_counters WHERE user_id=$1', [a.userId]);
          assert.match((await run('x'.repeat(4097))).identity.reply_text, /4,096/);
          await admin.query('DELETE FROM quota_counters WHERE user_id=$1', [a.userId]);
          await new QuotaControl(admin).change(null, 'abuse case', a.userId, true);
          assert.match((await run('LISTS')).identity.reply_text, /restricted/);
          await new QuotaControl(admin).change(null, 'review cleared', a.userId, false);
          assert.equal(
            (await worker.query('SELECT blocked FROM quota_accounts WHERE user_id=$1', [a.userId]))
              .rows[0].blocked,
            false,
          );
        },
      );
      await t.test(
        'request admission is replayable and rollback does not spend a slot',
        async () => {
          await reset();
          const a = await add();
          const id = await send('alice', 'LISTS');
          const payload = (
            await worker.query('SELECT payload FROM ingress_events WHERE id=$1', [id])
          ).rows[0].payload;
          await assert.rejects(
            atomic(a.userId, async (c) => {
              await admitRequest(c, id, a.userId, 'LISTS', payload);
              throw new Error('rollback');
            }),
          );
          assert.equal(await used(a.userId, 'requests_day'), 0);
          const replies = await Promise.all(
            Array.from({ length: 5 }, () =>
              atomic(a.userId, (c) => admitRequest(c, id, a.userId, 'LISTS', payload)),
            ),
          );
          assert.ok(replies.every((r) => r.allowed));
          assert.equal(await used(a.userId, 'requests_day'), 1);
          assert.equal(
            (await worker.query('SELECT * FROM request_admissions WHERE event_id=$1', [id]))
              .rowCount,
            1,
          );
        },
      );
      await t.test(
        'same-user and shared limits serialize, while independent users retain their slots',
        async () => {
          await reset();
          const a = await add(),
            b = await add('Other', 'bread', 'bob');
          await limits({ send_minute: 3, send_day: 3, global_send_day: 4 });
          const results = await Promise.all(
            Array.from({ length: 10 }, () =>
              atomic(a.userId, (c) => consumeQuota(c, a.userId, 'send')),
            ),
          );
          assert.equal(results.filter((x) => x === null).length, 3);
          assert.equal(await atomic(b.userId, (c) => consumeQuota(c, b.userId, 'send')), null);
          assert.equal(
            await atomic(b.userId, (c) => consumeQuota(c, b.userId, 'send')),
            'global_send_day',
          );
          assert.equal(await used(b.userId, 'send_day'), 1);
          assert.equal(
            (
              await worker.query(
                "SELECT used FROM quota_global_counters WHERE metric='global_send_day'",
              )
            ).rows[0].used,
            4,
          );
        },
      );
      await t.test(
        'previous UTC windows do not consume current allowance or corrupt status counts',
        async () => {
          await reset();
          const a = await add();
          await admin.query(
            `INSERT INTO quota_counters(user_id,metric,period,used) VALUES
        ($1,'model_day',date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'-interval '1 day',999),
        ($1,'model_minute',date_trunc('minute',clock_timestamp())-interval '1 minute',999)`,
            [a.userId],
          );
          assert.equal(await atomic(a.userId, (c) => consumeQuota(c, a.userId, 'model')), null);
          assert.match(
            await atomic(a.userId, (c) => quotaSummary(c, a.userId)),
            /Model attempts: 1\/20 this minute; 1\/100 today/,
          );
        },
      );
      await t.test(
        'mixed plans exceed inventory atomically and retain a visible quota reply',
        async () => {
          await reset();
          await limits({ pending_reminders: 0 });
          const a = await plan();
          await runner.runOne('execution', executor);
          assert.equal((await worker.query('SELECT * FROM reminders')).rowCount, 0);
          assert.equal((await worker.query('SELECT * FROM list_items')).rowCount, 0);
          const reply = (
            await worker.query('SELECT * FROM reply_intents WHERE event_id=$1', [a.eventId])
          ).rows[0];
          assert.equal(reply.status, 'pending');
          assert.match(reply.body, /Pending reminder limit/);
          await reset();
          await limits({ list_items: 0 });
          const b = await plan();
          await runner.runOne('execution', executor);
          assert.match(
            (await worker.query('SELECT body FROM reply_intents WHERE event_id=$1', [b.eventId]))
              .rows[0].body,
            /Stored list-item limit/,
          );
          assert.equal((await worker.query('SELECT * FROM reminders')).rowCount, 0);
        },
      );
      await t.test(
        'recurrence capacity is checked at preview and again at confirmation',
        async () => {
          await reset();
          const a = await plan({
            behavior: 'execute',
            calls: [reminderCall(new Date(Date.now() + 86400000 * 2).toISOString())],
          });
          await runner.runOne('execution', executor);
          const reference = (await worker.query('SELECT reference FROM reminder_controls')).rows[0]
            .reference;
          const until = new Date(Date.now() + 86400000 * 7).toISOString().slice(0, 10);
          await limits({ pending_reminders: 2 });
          await run(`REPEAT ${reference} DAILY UNTIL ${until}`);
          assert.equal((await worker.query('SELECT * FROM reminder_series')).rowCount, 0);
          await limits({ pending_reminders: 20 });
          await run(`REPEAT ${reference} DAILY UNTIL ${until}`);
          const series = (await worker.query('SELECT * FROM reminder_series')).rows[0];
          assert.ok(series);
          await limits({ pending_reminders: 1 });
          await run(`CONFIRM REPEAT ${series.reference}`);
          assert.equal((await worker.query('SELECT * FROM reminders')).rowCount, 1);
          assert.equal(
            (await worker.query('SELECT status FROM reminder_series')).rows[0].status,
            'proposed',
          );
        },
      );
      await t.test(
        'cancel remains available on blocked accounts and frees reminder inventory',
        async () => {
          await reset();
          const a = await plan();
          await runner.runOne('execution', executor);
          const reference = (await worker.query('SELECT reference FROM reminder_controls')).rows[0]
            .reference;
          await new QuotaControl(admin).change(null, 'abuse', a.userId, true);
          await limits({ requests_minute: 0 });
          assert.match((await run(`CANCEL ${reference}`)).identity.reply_text, /cancelled/);
          assert.equal(
            (await worker.query('SELECT status FROM reminders')).rows[0].status,
            'cancelled',
          );
        },
      );
      await t.test(
        'an expired work lease rolls back request quota, admission and identity reply',
        async () => {
          await reset();
          const a = await add();
          const eventId = await send('alice', 'LISTS');
          const lease = (await queue.claim('onboarding', 'quota-test'))!;
          await assert.rejects(
            queue.commit(lease, async (c) => {
              await new IdentityProcessor(worker).apply(c, eventId);
              await c.query(
                "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
                [lease.id],
              );
              return { nextStage: null };
            }),
            /lease/i,
          );
          assert.equal(await used(a.userId, 'requests_day'), 0);
          assert.equal(
            (await worker.query('SELECT * FROM request_admissions WHERE event_id=$1', [eventId]))
              .rowCount,
            0,
          );
          assert.equal(
            (await worker.query('SELECT * FROM identity_results WHERE event_id=$1', [eventId]))
              .rowCount,
            0,
          );
        },
      );
      await t.test('simultaneous users cannot exceed the shared daily cap', async () => {
        await reset();
        const a = await add(),
          b = await add('Other', 'bread', 'bob');
        await limits({ global_send_day: 1 });
        const results = await Promise.all(
          [a, b].map((x) => atomic(x.userId, (c) => consumeQuota(c, x.userId, 'send'))),
        );
        assert.deepEqual(results.sort(), ['global_send_day', null].sort());
        assert.equal(
          (
            await worker.query(
              "SELECT used FROM quota_global_counters WHERE metric='global_send_day'",
            )
          ).rows[0].used,
          1,
        );
      });
      const activate = async () => {
        const c = new UsageControl(admin);
        await c.limits('1000000', '1000000', 'test');
        await c.rate(
          {
            provider: 'fake',
            model: 'test-v1',
            version: 'v1',
            inputMicrosPerMillion: '1000000',
            outputMicrosPerMillion: '1000000',
            maxInputTokens: 10000,
            maxOutputTokens: 1000,
          },
          'test',
        );
        await c.switch(true, 'test');
      };
      const job = async (who = 'alice') => {
        const a = await plan({ behavior: 'noop', calls: [] }, who, false);
        const lease = (
          await admin.query(
            "UPDATE work_outbox SET status='leased',lease_token=gen_random_uuid(),lease_owner='test',lease_until=clock_timestamp()+interval '5 minutes',attempts=1 WHERE event_id=$1 RETURNING *",
            [a.eventId],
          )
        ).rows[0] as WorkLease;
        return { ...a, lease };
      };
      await t.test(
        'real model dispatch gate prevents calls, releases unused money and counts uncertain attempts',
        async () => {
          await reset();
          await activate();
          await limits({ model_day: 1 });
          const a = await job();
          const svc = new UsageService(worker);
          let calls = 0;
          const transport = {
            provider: 'fake',
            model: 'test-v1',
            async generate() {
              calls++;
              throw new Error('uncertain network');
            },
          };
          const request = { system: 'test', input: 'test', signal: new AbortController().signal };
          await assert.rejects(svc.generate(a.lease, a.userId, transport, request));
          assert.equal(calls, 1);
          assert.equal(
            (await worker.query('SELECT state FROM usage_reservations')).rows[0].state,
            'unknown',
          );
          const b = await job();
          await assert.rejects(
            svc.generate(b.lease, b.userId, transport, request),
            /quota_exhausted/,
          );
          assert.equal(calls, 1);
          assert.equal(await used(a.userId, 'model_day'), 1);
          assert.equal(
            (
              await worker.query('SELECT state FROM usage_reservations WHERE event_id=$1', [
                b.eventId,
              ])
            ).rows[0].state,
            'released',
          );
        },
      );
      await t.test(
        'both send paths share quota; accepted replay and blocked sends spend no extra slots',
        async () => {
          await reset();
          await activate();
          await limits({ send_day: 1 });
          const a = await plan({ behavior: 'execute', calls: [reminderCall()] }, '11111');
          await runner.runOne('execution', executor);
          await admin.query(
            "UPDATE users SET window_expires_at=clock_timestamp()+interval '1 hour'",
          );
          await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 minute'");
          await new ReminderScheduler(worker).sweep();
          let calls = 0;
          const transport = {
            async send() {
              calls++;
              return { state: 'accepted' as const, providerMessageId: 'wamid.quota' };
            },
          };
          const policy = {
            enabled: true,
            phoneNumberId: '12345',
            recipients: ['11111'],
            timeoutMs: 1000,
          };
          const outbound = (await worker.query('SELECT id FROM outbound_messages')).rows[0].id;
          const sender = new ReminderSender(worker, transport, policy);
          assert.equal((await sender.send(outbound)).state, 'accepted');
          assert.equal((await sender.send(outbound)).state, 'accepted');
          const response = await run('QUOTA', '11111');
          await assert.rejects(
            new TestReplySender(worker, transport, policy).send(response.eventId),
            /quota/,
          );
          assert.equal(calls, 1);
          assert.equal(await used(a.userId, 'send_day'), 1);
          assert.equal((await worker.query('SELECT * FROM whatsapp_attempts')).rowCount, 1);
        },
      );
      await t.test(
        'ingress capacity rejects atomically, permits replay/safety and bounds a batch',
        async () => {
          await reset();
          const limited = new PostgresIngressStore(ingress, 1);
          const event = (body: string) => {
            const key = randomUUID();
            return {
              eventKey: key,
              kind: 'inbound.message' as const,
              phoneNumberId: '12345',
              providerMessageId: key,
              senderId: 'alice',
              payload: {
                type: 'text',
                timestamp: String(Math.floor(Date.now() / 1000)),
                text: { body },
              },
            };
          };
          const first = event('hello');
          await limited.persist([first]);
          assert.equal((await limited.persist([first])).inserted, 0);
          const second = event('another');
          await assert.rejects(limited.persist([first, second]), IngressCapacityError);
          assert.equal((await worker.query('SELECT * FROM ingress_events')).rowCount, 1);
          await limited.persist([event('STOP')]);
          await assert.rejects(
            limited.persist(Array.from({ length: 1001 }, () => first)),
            IngressBatchError,
          );
          assert.equal((await worker.query('SELECT * FROM ingress_events')).rowCount, 2);
        },
      );
      await t.test(
        'restricted roles cannot change policy/blocks or forge receipts; operators leave audit',
        async () => {
          await reset();
          const a = await add(),
            b = await add('Other', 'bread', 'bob');
          await run('LISTS');
          await assert.rejects(
            new QuotaControl(worker).change(defaults, 'forged'),
            /administrator/,
          );
          await assert.rejects(
            worker.query('UPDATE quota_policy SET send_day=999'),
            /permission denied/,
          );
          await assert.rejects(
            worker.query('INSERT INTO quota_accounts(user_id,blocked) VALUES($1,true)', [a.userId]),
            /permission denied/,
          );
          await assert.rejects(
            tenant.query('SELECT * FROM quota_global_counters'),
            /permission denied/,
          );
          for (const table of ['quota_accounts', 'quota_counters', 'request_admissions']) {
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
            worker.query('UPDATE request_admissions SET allowed=true'),
            /permission denied/,
          );
          await assert.rejects(
            worker.query(
              "INSERT INTO request_admissions(event_id,user_id,allowed,reason) VALUES($1,$2,true,'forged')",
              [b.eventId, a.userId],
            ),
            /owner mismatch/,
          );
          await new QuotaControl(admin).change(null, 'review evidence', a.userId, true);
          assert.ok(
            (await admin.query("SELECT * FROM quota_operator_audit WHERE note='review evidence'"))
              .rowCount,
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
