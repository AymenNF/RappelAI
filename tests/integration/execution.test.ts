import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { withTenant } from '../../src/db/tenant.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { WorkQueue, LeaseLostError } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ExecutionProcessor } from '../../src/modules/processing/execution.js';
import { PlanProcessor, actionKey } from '../../src/modules/processing/plans.js';
import { ModelAdapter } from '../../src/modules/processing/model.js';
import { UsageControl } from '../../src/modules/usage/control.js';
import { addListItem } from '../../src/modules/lists/service.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'transactional action execution under restricted runtime logins',
  { timeout: 30000 },
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
      const reset = () => admin.query('TRUNCATE users,ingress_events,usage_global_periods CASCADE');
      const send = async (sender: string, body: string) => {
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
        return (await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [key]))
          .rows[0].id as string;
      };
      const plan = async (value: unknown = mixed(), sender = 'alice', persist = true) => {
        const at = new Date(Date.now() - 10000);
        const eventId = await send(sender, 'synthetic instruction');
        await admin.query(
          `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('business',$1,$2,$3,false,'America/Toronto',$3) ON CONFLICT DO NOTHING`,
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
      const counts = async () => {
        const result: Record<string, number> = {};
        for (const table of [
          'lists',
          'list_items',
          'reminders',
          'action_receipts',
          'plan_executions',
          'reply_intents',
        ])
          result[table] = (
            await worker.query(`SELECT count(*)::int AS count FROM ${table}`)
          ).rows[0].count;
        return result;
      };
      const execute = () => runner.runOne('execution', executor);
      const claim = async () => {
        const lease = await queue.claim('execution', 'manual');
        assert.ok(lease);
        return lease;
      };
      const retry = () =>
        admin.query(
          "UPDATE work_outbox SET status='pending',lease_until=NULL,lease_token=NULL,lease_owner=NULL,available_at=clock_timestamp(),stage='execution' WHERE stage='execution'",
        );

      await t.test(
        'concurrent workers commit one reminder, item, receipt set and pending reply',
        async () => {
          await reset();
          const item = await plan();
          await Promise.all(Array.from({ length: 8 }, execute));
          assert.deepEqual(await counts(), {
            lists: 1,
            list_items: 1,
            reminders: 1,
            action_receipts: 2,
            plan_executions: 1,
            reply_intents: 1,
          });
          const reminder = (await worker.query('SELECT * FROM reminders')).rows[0];
          assert.equal(reminder.user_id, item.userId);
          assert.equal(reminder.timezone, 'America/Toronto');
          assert.equal(reminder.status, 'pending');
          const reply = (await worker.query('SELECT * FROM reply_intents')).rows[0];
          assert.equal(reply.status, 'pending');
          assert.match(reply.body, /Added “milk”/);
          assert.match(reply.body, /Saved reminder/);
          const control = (
            await worker.query('SELECT * FROM reminder_controls WHERE reminder_id=$1', [
              reminder.id,
            ])
          ).rows[0];
          assert.equal(control.schedule_version, 1);
          assert.match(reply.body, new RegExp(`DONE ${control.reference}`));
          const saved = (
            await worker.query('SELECT result FROM action_receipts WHERE reminder_id=$1', [
              reminder.id,
            ])
          ).rows[0].result;
          assert.equal(saved.reference, control.reference);
          assert.match(reply.body, /delivery is not enabled/);
          const work = (await worker.query('SELECT status FROM work_outbox')).rows[0];
          assert.equal(work.status, 'completed');
          assert.ok(
            (await worker.query('SELECT processed_at FROM ingress_events')).rows[0].processed_at,
          );
          assert.equal(
            (
              await worker.query('SELECT * FROM action_receipts WHERE reminder_id=$1', [
                reminder.id,
              ])
            ).rowCount,
            1,
          );
        },
      );

      await t.test(
        'replay preserves entity IDs, receipts and original reply instead of repeating actions',
        async () => {
          await reset();
          await plan();
          await execute();
          const original = (await worker.query('SELECT * FROM reply_intents')).rows[0];
          const ids = (
            await worker.query(
              'SELECT action_key,result FROM action_receipts ORDER BY action_index',
            )
          ).rows;
          await retry();
          await execute();
          assert.deepEqual((await worker.query('SELECT * FROM reply_intents')).rows[0], original);
          assert.deepEqual(
            (
              await worker.query(
                'SELECT action_key,result FROM action_receipts ORDER BY action_index',
              )
            ).rows,
            ids,
          );
          assert.equal((await counts()).list_items, 1);
          await assert.rejects(worker.query("UPDATE action_receipts SET result='{}'"), {
            code: '42501',
          });
          await assert.rejects(worker.query('DELETE FROM plan_executions'), { code: '42501' });
        },
      );

      await t.test(
        'reply insertion failure rolls back every action and receipt; retry succeeds once',
        async () => {
          await reset();
          await plan();
          await admin.query(
            `CREATE FUNCTION fail_reply() RETURNS trigger LANGUAGE plpgsql AS $body$ BEGIN RAISE EXCEPTION 'injected reply failure'; END $body$`,
          );
          await admin.query(
            'CREATE TRIGGER fail_reply BEFORE INSERT ON reply_intents FOR EACH ROW EXECUTE FUNCTION fail_reply()',
          );
          try {
            await execute();
            assert.ok(Object.values(await counts()).every((n) => n === 0));
            assert.equal(
              (await worker.query('SELECT status FROM work_outbox')).rows[0].status,
              'pending',
            );
          } finally {
            await admin.query('DROP TRIGGER fail_reply ON reply_intents');
            await admin.query('DROP FUNCTION fail_reply()');
          }
          await retry();
          await execute();
          assert.equal((await counts()).action_receipts, 2);
          assert.equal((await counts()).reply_intents, 1);
        },
      );

      await t.test(
        'lease expiry at final acknowledgement rolls back business effects and permits recovery',
        async () => {
          await reset();
          await plan();
          const lease = await claim();
          await assert.rejects(
            queue.commit(lease, async (client) => {
              const result = await executor.apply(client, lease);
              await client.query(
                "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
                [lease.id],
              );
              return result;
            }),
            LeaseLostError,
          );
          assert.ok(Object.values(await counts()).every((n) => n === 0));
          await admin.query(
            "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second'",
          );
          await queue.recoverExpired();
          await execute();
          assert.equal((await counts()).action_receipts, 2);
          await assert.rejects(
            queue.commit(lease, (client) => executor.apply(client, lease)),
            LeaseLostError,
          );
        },
      );

      await t.test(
        'normalized list reuse preserves intentionally repeated additions and sequence positions',
        async () => {
          await reset();
          await plan({
            behavior: 'execute',
            calls: [
              listCall(' Grocery ', 'milk'),
              listCall('ＧＲＯＣＥＲＹ', 'milk'),
              listCall('grocery', 'bread'),
            ],
          });
          await execute();
          assert.equal((await counts()).lists, 1);
          assert.equal((await counts()).list_items, 3);
          const rows = (
            await worker.query('SELECT text,position FROM list_items ORDER BY position')
          ).rows;
          assert.deepEqual(rows, [
            { text: 'milk', position: 1 },
            { text: 'milk', position: 2 },
            { text: 'bread', position: 3 },
          ]);
          await plan({ behavior: 'execute', calls: [listCall('Grocery', 'milk')] }, 'bob');
          await execute();
          assert.equal((await counts()).lists, 2);
        },
      );

      await t.test(
        'list service serializes concurrent appends; executor reuses existing action results',
        async () => {
          await reset();
          const first = await plan({ behavior: 'execute', calls: [listCall('grocery', 'one')] });
          const second = await plan({ behavior: 'execute', calls: [listCall('GROCERY', 'two')] });
          const append = async (item: typeof first) => {
            const row = (
              await worker.query('SELECT * FROM action_plans WHERE event_id=$1', [item.eventId])
            ).rows[0];
            const client = await worker.connect();
            try {
              await client.query('BEGIN');
              await addListItem(
                client,
                { userId: item.userId, eventId: item.eventId, version: 1, key: actionKey(row, 0) },
                row.decision.calls[0].args,
              );
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          };
          await Promise.all([append(first), append(second)]);
          assert.deepEqual(
            (await worker.query('SELECT position FROM list_items ORDER BY position')).rows,
            [{ position: 1 }, { position: 2 }],
          );
          await execute();
          await execute();
          assert.equal((await counts()).list_items, 2);
          assert.equal((await counts()).action_receipts, 2);
        },
      );

      await t.test(
        'expired or digest reminder rejects the whole mixed plan without partial list changes',
        async () => {
          for (const variant of ['expired', 'digest']) {
            await reset();
            await plan({
              behavior: 'execute',
              calls: [
                listCall(),
                variant === 'expired'
                  ? reminderCall('2000-01-01T00:00:00Z')
                  : reminderCall(undefined, 'digest'),
              ],
            });
            await execute();
            assert.equal((await counts()).list_items, 0);
            assert.equal((await counts()).reminders, 0);
            assert.equal((await counts()).action_receipts, 0);
            assert.equal(
              (await worker.query('SELECT outcome FROM plan_executions')).rows[0].outcome,
              variant === 'expired' ? 'expired' : 'unsupported',
            );
            const reply = (await worker.query('SELECT body,status FROM reply_intents')).rows[0];
            assert.equal(reply.status, 'pending');
            assert.match(reply.body, /Nothing from this request was saved/);
          }
        },
      );

      await t.test(
        'changed consent or timezone blocks execution and suppresses its reply',
        async () => {
          for (const change of ['consent', 'timezone']) {
            await reset();
            await plan();
            if (change === 'consent') {
              await send('alice', 'STOP');
              await new IdentityProcessor(worker).processNext();
            } else
              await admin.query(
                "UPDATE users SET timezone='Europe/Paris',timezone_confirmed_at=clock_timestamp()",
              );
            await execute();
            assert.equal((await counts()).reminders, 0);
            assert.equal((await counts()).list_items, 0);
            assert.equal(
              (await worker.query('SELECT outcome FROM plan_executions')).rows[0].outcome,
              'blocked',
            );
            assert.equal(
              (await worker.query('SELECT status FROM reply_intents')).rows[0].status,
              'suppressed',
            );
          }
        },
      );

      await t.test(
        'STOP after execution suppresses queued replies and replay cannot revive them',
        async () => {
          await reset();
          await plan();
          await execute();
          await send('alice', 'STOP');
          await new IdentityProcessor(worker).processNext();
          assert.equal(
            (await worker.query('SELECT status FROM reply_intents')).rows[0].status,
            'suppressed',
          );
          await retry();
          await execute();
          assert.equal(
            (await worker.query('SELECT status FROM reply_intents')).rows[0].status,
            'suppressed',
          );
          assert.equal((await counts()).reminders, 1);
        },
      );

      await t.test(
        'clarify, noop and unsupported decisions create only one truthful reply',
        async () => {
          for (const behavior of ['clarify', 'noop', 'unsupported']) {
            await reset();
            await plan({ behavior, calls: [] });
            await execute();
            assert.deepEqual(await counts(), {
              lists: 0,
              list_items: 0,
              reminders: 0,
              action_receipts: 0,
              plan_executions: 1,
              reply_intents: 1,
            });
            assert.equal(
              (await worker.query('SELECT outcome FROM plan_executions')).rows[0].outcome,
              behavior,
            );
            const body = (await worker.query('SELECT body FROM reply_intents')).rows[0].body;
            assert.doesNotMatch(body, /Added |Saved reminder/);
          }
        },
      );

      await t.test(
        'invalid persisted decisions are dead-lettered without effects or fabricated success',
        async () => {
          await reset();
          await plan({
            behavior: 'execute',
            calls: [
              {
                tool: 'add_list_item',
                args: { list_name: 'grocery', text: 'milk', user_id: randomUUID() },
              },
            ],
          });
          await execute();
          assert.ok(Object.values(await counts()).every((n) => n === 0));
          assert.equal(
            (await worker.query('SELECT status FROM work_outbox')).rows[0].status,
            'dead',
          );
        },
      );

      await t.test(
        'tenant reads and entity references cannot cross owners; tenants cannot forge receipts or replies',
        async () => {
          await reset();
          const alice = await plan();
          const bob = await plan(mixed(), 'bob');
          await execute();
          await execute();
          const tables = [
            'lists',
            'list_items',
            'reminders',
            'action_receipts',
            'plan_executions',
            'reply_intents',
          ];
          const flags = (
            await admin.query(
              `SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[])`,
              [schema, tables],
            )
          ).rows;
          assert.equal(flags.length, 6);
          assert.ok(flags.every((row) => row.relrowsecurity && row.relforcerowsecurity));
          for (const table of tables) {
            assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
            await withTenant(tenant, alice.userId, async (client) => {
              const rows = (await client.query(`SELECT user_id FROM ${table}`)).rows;
              assert.ok(rows.length > 0);
              assert.ok(rows.every((row) => row.user_id === alice.userId));
            });
            await assert.rejects(tenant.query(`DELETE FROM ${table}`), { code: '42501' });
            await assert.rejects(ingress.query(`SELECT * FROM ${table}`), { code: '42501' });
          }
          const list = (await worker.query('SELECT id FROM lists WHERE user_id=$1', [alice.userId]))
            .rows[0];
          await assert.rejects(
            worker.query(
              `INSERT INTO list_items(user_id,list_id,source_event_id,plan_version,action_key,text,position)
        VALUES($1,$2,$3,1,$4,'bad reference',99)`,
              [bob.userId, list.id, bob.eventId, 'f'.repeat(64)],
            ),
            { code: '23503' },
          );
          await assert.rejects(
            worker.query(
              `INSERT INTO action_receipts(action_key,user_id,event_id,plan_version,action_index,tool,list_item_id,result)
        SELECT $1,$2,$3,1,4,'add_list_item',id,'{}' FROM list_items WHERE user_id=$4 LIMIT 1`,
              ['e'.repeat(64), bob.userId, bob.eventId, alice.userId],
            ),
            { code: '23503' },
          );
          await assert.rejects(
            tenant.query(
              "INSERT INTO reply_intents(user_id,event_id,body,status,consent_grant_at,timezone_confirmed_at) VALUES($1,$2,'forged','pending',now(),now())",
              [bob.userId, bob.eventId],
            ),
            { code: '42501' },
          );
        },
      );

      await t.test(
        'metered planning through execution produces durable results without any sender or second model call',
        async () => {
          await reset();
          const control = new UsageControl(admin);
          await control.rate(
            {
              provider: 'fake',
              model: 'test-v1',
              version: 'pipeline',
              inputMicrosPerMillion: '0',
              outputMicrosPerMillion: '0',
              maxInputTokens: 100000,
              maxOutputTokens: 1000,
            },
            'synthetic pipeline',
          );
          await control.switch(true, 'synthetic');
          let calls = 0;
          const planner = new PlanProcessor(
            worker,
            new ModelAdapter({
              provider: 'fake',
              model: 'test-v1',
              generate: async () => {
                calls++;
                return {
                  text: JSON.stringify(mixed()),
                  model: 'test-v1',
                  responseId: null,
                  inputTokens: 10,
                  outputTokens: 20,
                };
              },
            }),
          );
          const item = await plan(mixed(), 'alice', false);
          await runner.runOne('action', planner);
          await execute();
          assert.equal(calls, 1);
          assert.equal((await counts()).action_receipts, 2);
          assert.equal((await counts()).reply_intents, 1);
          assert.equal(
            (await worker.query('SELECT state FROM usage_reservations')).rows[0].state,
            'settled',
          );
          assert.equal(
            (await worker.query('SELECT event_id FROM plan_executions')).rows[0].event_id,
            item.eventId,
          );
          await retry();
          await execute();
          assert.equal(calls, 1);
          assert.equal((await counts()).reminders, 1);
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
