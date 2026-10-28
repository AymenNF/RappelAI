import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { migrateTestSchema } from '../helpers/database.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { withTenant } from '../../src/db/tenant.js';
import { assertRuntimeRole } from '../../src/db/runtime.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { WorkQueue, LeaseLostError } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ModelAdapter, type ModelTransport } from '../../src/modules/processing/model.js';
import { PlanProcessor, actionKey } from '../../src/modules/processing/plans.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test('persisted model plans with restricted runtime logins', { timeout: 30000 }, async (t) => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `test_${suffix}`;
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  const pools: pg.Pool[] = [];
  const roles: string[] = [];
  const login = async (capability: 'worker' | 'tenant' | 'ingress') => {
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
      max: 8,
      options: `-c search_path=${schema},public`,
      statement_timeout: 5000,
    });
    pools.push(pool);
    await assertRuntimeRole(pool, capability);
    return pool;
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateTestSchema(admin);
    const worker = await login('worker');
    const ingress = await login('ingress');
    const tenant = await login('tenant');
    const queue = new WorkQueue(worker);
    const store = new PostgresIngressStore(ingress);
    let calls = 0;
    const choice = {
      behavior: 'execute',
      calls: [{ tool: 'add_list_item', args: { list_name: 'grocery', text: 'milk' } }],
    };
    let generate: ModelTransport['generate'] = async () => ({
      text: JSON.stringify(choice),
      model: 'fake-v1',
      responseId: 'r1',
      inputTokens: 12,
      outputTokens: 18,
    });
    const adapter = new ModelAdapter(
      {
        provider: 'fake',
        model: 'fake-v1',
        generate: (request) => {
          calls++;
          return generate(request);
        },
      },
      100,
    );
    const planner = new PlanProcessor(worker, adapter);
    const runner = new WorkRunner(queue, 'planner-test');
    const reset = async () => {
      calls = 0;
      await admin.query('TRUNCATE users,ingress_events CASCADE');
      generate = async () => ({
        text: JSON.stringify(choice),
        model: 'fake-v1',
        responseId: 'r1',
        inputTokens: 12,
        outputTokens: 18,
      });
    };
    const send = async (sender = 'alice', body = 'Add milk to grocery') => {
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
      return (await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [key])).rows[0]
        .id as string;
    };
    const ready = async (sender = 'alice') => {
      const at = new Date(Date.now() - 10000);
      const eventId = await send(sender);
      await admin.query(
        `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('business',$1,$2,$3,false,'America/Toronto',$3) ON CONFLICT(business_phone_id,sender_id) DO NOTHING`,
        [sender, CONSENT_VERSION, at],
      );
      const user = (await admin.query('SELECT * FROM users WHERE sender_id=$1', [sender])).rows[0];
      await admin.query(
        `INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,'ready',$3,$4)`,
        [eventId, user.id, user.consent_at, user.timezone_confirmed_at],
      );
      await admin.query("UPDATE work_outbox SET stage='action' WHERE event_id=$1", [eventId]);
      return { eventId, userId: user.id as string };
    };
    const claim = async () => {
      const lease = await queue.claim('action', 'manual-test');
      assert.ok(lease);
      return lease;
    };
    const work = async (eventId: string) =>
      (await admin.query('SELECT * FROM work_outbox WHERE event_id=$1', [eventId])).rows[0];

    await t.test(
      'one concurrent generation persists metadata and leaves execution pending',
      async () => {
        await reset();
        const item = await ready();
        await Promise.all(Array.from({ length: 8 }, () => runner.runOne('action', planner)));
        assert.equal(calls, 1);
        const plan = await planner.read(item.eventId);
        assert.ok(plan);
        assert.deepEqual(plan.decision, choice);
        assert.equal(plan.user_id, item.userId);
        const row = (await worker.query('SELECT * FROM action_plans')).rows[0];
        assert.equal(row.provider, 'fake');
        assert.equal(row.model, 'fake-v1');
        assert.equal(row.input_tokens, 12);
        assert.equal(row.output_tokens, 18);
        assert.equal(row.schema_version, 'decision-v1');
        assert.match(row.prompt_sha256, /^[a-f0-9]{64}$/);
        assert.equal(row.timezone, 'America/Toronto');
        const state = await work(item.eventId);
        assert.equal(state.stage, 'execution');
        assert.equal(state.status, 'pending');
        assert.equal(
          (await admin.query('SELECT processed_at FROM ingress_events')).rows[0].processed_at,
          null,
        );
        assert.equal(await queue.claim('action', 'duplicate'), null);
      },
    );

    await t.test('replay reuses the immutable plan even if adapter output changes', async () => {
      await reset();
      const item = await ready();
      await runner.runOne('action', planner);
      const original = await planner.read(item.eventId);
      assert.ok(original);
      const originalKey = actionKey(original, 0);
      // Simulate replay of planning after a persisted stage transition.
      await admin.query("UPDATE work_outbox SET stage='action' WHERE event_id=$1", [item.eventId]);
      generate = async () => {
        throw new Error('must never regenerate');
      };
      await runner.runOne('action', planner);
      assert.equal(calls, 1);
      assert.deepEqual(await planner.read(item.eventId), original);
      assert.equal(actionKey((await planner.read(item.eventId))!, 0), originalKey);
      const duplicate = {
        ...original,
        decision: {
          ...original.decision,
          calls: [...original.decision.calls, ...original.decision.calls],
        },
      };
      assert.notEqual(actionKey(duplicate, 0), actionKey(duplicate, 1));
      await assert.rejects(
        worker.query("UPDATE action_plans SET decision='{}' WHERE event_id=$1", [item.eventId]),
        { code: '42501' },
      );
      await assert.rejects(
        worker.query('DELETE FROM action_plans WHERE event_id=$1', [item.eventId]),
        { code: '42501' },
      );
    });

    await t.test(
      'plan and stage update roll back together; retry before persistence may regenerate',
      async () => {
        await reset();
        const item = await ready();
        const lease = await claim();
        const prepared = await planner.prepare(lease, new AbortController().signal);
        await assert.rejects(
          queue.commit(lease, async (client) => {
            await planner.apply(client, lease, prepared);
            throw new Error('crash before commit');
          }),
          /crash before commit/,
        );
        assert.equal(await planner.read(item.eventId), null);
        assert.equal((await work(item.eventId)).stage, 'action');
        await queue.fail(lease, 'handler_failed', 0);
        await runner.runOne('action', planner);
        assert.equal(calls, 2);
        assert.ok(await planner.read(item.eventId));
      },
    );

    await t.test(
      'invalid output and timeout remain retryable without persisting a partial plan',
      async () => {
        for (const fail of ['json', 'timeout']) {
          await reset();
          const item = await ready();
          generate =
            fail === 'json'
              ? async () => ({
                  text: 'private malformed output',
                  model: 'fake-v1',
                  responseId: null,
                  inputTokens: 1,
                  outputTokens: 1,
                })
              : () => new Promise(() => {});
          await runner.runOne('action', planner);
          assert.equal(await planner.read(item.eventId), null);
          assert.equal((await work(item.eventId)).status, 'pending');
          assert.equal((await work(item.eventId)).last_error_code, 'handler_failed');
          generate = async () => ({
            text: JSON.stringify(choice),
            model: 'fake-v1',
            responseId: null,
            inputTokens: 1,
            outputTokens: 1,
          });
          await admin.query('UPDATE work_outbox SET available_at=clock_timestamp()');
          await runner.runOne('action', planner);
          assert.equal(calls, 2);
          assert.ok(await planner.read(item.eventId));
        }
      },
    );

    await t.test(
      'STOP before generation makes no call; STOP during generation discards output',
      async () => {
        for (const timing of ['before', 'during']) {
          await reset();
          const item = await ready();
          const stop = async () => {
            await send('alice', 'STOP');
            await new IdentityProcessor(worker).processNext();
          };
          if (timing === 'before') await stop();
          else
            generate = async () => {
              await stop();
              return {
                text: JSON.stringify(choice),
                model: 'fake-v1',
                responseId: null,
                inputTokens: 1,
                outputTokens: 1,
              };
            };
          await runner.runOne('action', planner);
          assert.equal(calls, timing === 'before' ? 0 : 1);
          assert.equal(await planner.read(item.eventId), null);
          assert.equal((await work(item.eventId)).status, 'completed');
        }
      },
    );

    await t.test(
      'timezone changes during generation and stale worker tokens cannot persist',
      async () => {
        await reset();
        const item = await ready();
        generate = async () => {
          await admin.query(
            "UPDATE users SET timezone='Europe/Paris',timezone_confirmed_at=clock_timestamp()",
          );
          return {
            text: JSON.stringify(choice),
            model: 'fake-v1',
            responseId: null,
            inputTokens: 1,
            outputTokens: 1,
          };
        };
        await runner.runOne('action', planner);
        assert.equal(await planner.read(item.eventId), null);
        await reset();
        const next = await ready();
        const lease = await claim();
        const prepared = await planner.prepare(lease, new AbortController().signal);
        await admin.query(
          "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second'",
        );
        await queue.recoverExpired();
        const replacement = await claim();
        await assert.rejects(
          queue.commit(lease, (client) => planner.apply(client, lease, prepared)),
          LeaseLostError,
        );
        assert.equal(await planner.read(next.eventId), null);
        const retry = await planner.prepare(replacement, new AbortController().signal);
        await queue.commit(replacement, (client) => planner.apply(client, replacement, retry));
        assert.ok(await planner.read(next.eventId));
      },
    );

    await t.test(
      'expired reminder is rejected at commit; a persisted plan never regenerates as time advances',
      async () => {
        await reset();
        const item = await ready();
        const reminder = {
          behavior: 'execute',
          calls: [
            {
              tool: 'create_reminder',
              args: {
                title: 'test',
                due_at: new Date(Date.now() + 1500).toISOString(),
                delivery_mode: 'immediate',
              },
            },
          ],
        };
        generate = async () => ({
          text: JSON.stringify(reminder),
          model: 'fake-v1',
          responseId: null,
          inputTokens: 1,
          outputTokens: 1,
        });
        const lease = await claim();
        const prepared = await planner.prepare(lease, new AbortController().signal);
        await setTimeout(1700);
        await assert.rejects(
          queue.commit(lease, (client) => planner.apply(client, lease, prepared)),
          /future/,
        );
        assert.equal(await planner.read(item.eventId), null);
        await queue.fail(lease, 'handler_failed', 0);
        reminder.calls[0]!.args.due_at = new Date(Date.now() + 60000).toISOString();
        await runner.runOne('action', planner);
        assert.ok(await planner.read(item.eventId));
        // A migration administrator simulates a historical plan whose due time has passed.
        await admin.query(
          `UPDATE action_plans SET decision=jsonb_set(decision,'{calls,0,args,due_at}','"2000-01-01T00:00:00Z"') WHERE event_id=$1`,
          [item.eventId],
        );
        await admin.query("UPDATE work_outbox SET stage='action' WHERE event_id=$1", [
          item.eventId,
        ]);
        generate = async () => {
          throw new Error('never regenerate persisted decisions');
        };
        await runner.runOne('action', planner);
        assert.equal(calls, 2);
        assert.equal((await work(item.eventId)).stage, 'execution');
        assert.ok(await planner.read(item.eventId));
      },
    );

    await t.test(
      'unexecuted earlier plans block later planning for that user, not another user',
      async () => {
        await reset();
        const first = await ready();
        const second = await ready();
        const bob = await ready('bob');
        await runner.runOne('action', planner);
        await runner.runOne('action', planner);
        assert.ok(await planner.read(first.eventId));
        assert.ok(await planner.read(bob.eventId));
        assert.equal(await planner.read(second.eventId), null);
        assert.equal(await queue.claim('action', 'blocked'), null);
        const execution = await queue.claim('execution', 'future-executor');
        assert.ok(execution);
        assert.equal(execution.event_id, first.eventId);
        // Stand-in for the future transactional action service; no model regeneration.
        await queue.commit(execution, async () => ({ nextStage: null }));
        await runner.runOne('action', planner);
        assert.ok(await planner.read(second.eventId));
      },
    );

    await t.test(
      'plans have forced tenant isolation and cannot reference another owner',
      async () => {
        await reset();
        const alice = await ready();
        const bob = await ready('bob');
        await runner.runOne('action', planner);
        const flags = (
          await admin.query(
            `SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='action_plans'`,
            [schema],
          )
        ).rows[0];
        assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
        assert.equal((await tenant.query('SELECT * FROM action_plans')).rowCount, 0);
        await withTenant(tenant, alice.userId, async (client) => {
          assert.ok(await planner.read(alice.eventId, client));
          assert.equal(await planner.read(bob.eventId, client), null);
        });
        await withTenant(tenant, bob.userId, async (client) => {
          assert.equal(await planner.read(alice.eventId, client), null);
        });
        await assert.rejects(
          tenant.query('INSERT INTO action_plans(event_id,user_id) VALUES($1,$2)', [
            bob.eventId,
            bob.userId,
          ]),
          { code: '42501' },
        );
        await assert.rejects(ingress.query('SELECT * FROM action_plans'), { code: '42501' });
        await assert.rejects(
          worker.query(
            `INSERT INTO action_plans SELECT $1,user_id,version,schema_version,decision,provider,model,
        prompt_version,prompt_sha256,input_sha256,provider_response_id,input_tokens,output_tokens,latency_ms,reference_at,
        validated_at,consent_grant_at,timezone_confirmed_at,timezone,created_at FROM action_plans WHERE event_id=$2`,
            [bob.eventId, alice.eventId],
          ),
          { code: '23503' },
        );
      },
    );
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});
