import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { WorkQueue, LeaseLostError, type WorkLease } from '../../src/modules/processing/leases.js';
import { WorkRunner, PermanentWorkError } from '../../src/modules/processing/runner.js';
import { assertRuntimeRole } from '../../src/db/runtime.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

test('durable work under real restricted logins', { timeout: 30000 }, async (t) => {
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
    await assertRuntimeRole(pool, capability as 'worker' | 'ingress');
    return pool;
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateTestSchema(admin);
    // A concrete effect ledger lets us observe rollback and duplicate execution.
    await admin.query(
      'CREATE TABLE effects(event_id uuid PRIMARY KEY REFERENCES ingress_events(id), value text NOT NULL)',
    );
    await admin.query('GRANT SELECT,INSERT ON effects TO memorae_worker');
    const worker = await login('worker');
    const ingress = await login('ingress');
    const queue = new WorkQueue(worker);
    const store = new PostgresIngressStore(ingress);
    const event = (
      sender = 'alice',
      business = 'business',
      kind: 'inbound.message' | 'delivery.status' = 'inbound.message',
    ) => {
      const key = randomUUID();
      return {
        eventKey: key,
        kind,
        phoneNumberId: business,
        providerMessageId: key,
        senderId: kind === 'inbound.message' ? sender : null,
        payload: { type: 'text' },
      };
    };
    const reset = () => admin.query('TRUNCATE ingress_events CASCADE');
    const claim = async (
      stage: 'onboarding' | 'action' | 'receipt' = 'onboarding',
      duration = 30000,
    ) => {
      const lease = await queue.claim(stage, randomUUID(), duration);
      assert.ok(lease);
      return lease;
    };
    const finish = (lease: WorkLease) =>
      queue.commit(lease, async (client) => {
        await client.query('INSERT INTO effects(event_id,value) VALUES($1,$2)', [
          lease.event_id,
          lease.lease_token,
        ]);
        return { nextStage: null };
      });
    const expire = (lease: WorkLease) =>
      admin.query(
        "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
        [lease.id],
      );

    await t.test(
      'one claimant per user, independent users/businesses progress, batch order preserved',
      async () => {
        await reset();
        const events = [event(), event(), event('bob'), event('alice', 'other-business')];
        await store.persist(events);
        const claims = (
          await Promise.all(
            Array.from({ length: 12 }, (_, i) => queue.claim('onboarding', `worker-${i}`)),
          )
        ).filter((x) => x !== null);
        assert.equal(claims.length, 3);
        assert.equal(new Set(claims.map((x) => x.id)).size, 3);
        const ordered = (
          await admin.query('SELECT id,event_key FROM ingress_events ORDER BY sequence_no')
        ).rows;
        assert.deepEqual(
          ordered.map((x) => x.event_key),
          events.map((x) => x.eventKey),
        );
        assert.ok(claims.some((x) => x.event_id === ordered[0].id));
        assert.ok(!claims.some((x) => x.event_id === ordered[1].id));
        assert.equal(await queue.claim('onboarding', 'blocked'), null);
        await Promise.all(claims.map(finish));
        const second = await claim();
        assert.equal(second.event_id, ordered[1].id);
        await finish(second);
        assert.equal((await admin.query('SELECT * FROM effects')).rowCount, 4);
        await assert.rejects(finish(second), LeaseLostError);
      },
    );

    await t.test(
      'expired worker cannot renew, fail or commit after recovery and reassignment',
      async () => {
        await reset();
        await store.persist([event()]);
        const abandoned = await claim();
        await expire(abandoned);
        assert.equal(await queue.renew(abandoned, 30000), false);
        assert.equal(await queue.fail(abandoned, 'handler_failed', 0), false);
        assert.equal(await queue.recoverExpired(), 1);
        assert.equal(await queue.recoverExpired(), 0);
        const replacement = await claim();
        assert.notEqual(replacement.lease_token, abandoned.lease_token);
        assert.equal(replacement.attempts, 2);
        await assert.rejects(finish(abandoned), LeaseLostError);
        assert.equal(await queue.fail(abandoned, 'handler_failed', 0), false);
        await finish(replacement);
        assert.equal((await admin.query('SELECT * FROM effects')).rowCount, 1);
        assert.equal(
          (await worker.query('SELECT action FROM work_recovery_events')).rows[0].action,
          'expired_retry',
        );
        await assert.rejects(ingress.query('SELECT * FROM work_recovery_events'), {
          code: '42501',
        });
      },
    );

    await t.test(
      'effects and acknowledgement roll back together on exception or lease expiry',
      async () => {
        await reset();
        await store.persist([event()]);
        const lease = await claim();
        await assert.rejects(
          queue.commit(lease, async (client) => {
            await client.query('INSERT INTO effects VALUES($1,$2)', [lease.event_id, 'rollback']);
            throw new Error('transaction failure');
          }),
          /transaction failure/,
        );
        assert.equal((await admin.query('SELECT * FROM effects')).rowCount, 0);
        await assert.rejects(
          queue.commit(lease, async (client) => {
            await client.query('INSERT INTO effects VALUES($1,$2)', [lease.event_id, 'expired']);
            // Move the held lease past its deadline inside the effect transaction.
            await client.query(
              "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
              [lease.id],
            );
            return { nextStage: null };
          }),
          LeaseLostError,
        );
        assert.equal((await admin.query('SELECT * FROM effects')).rowCount, 0);
        assert.equal(
          (await admin.query('SELECT processed_at FROM ingress_events')).rows[0].processed_at,
          null,
        );
        await finish(lease);
      },
    );

    await t.test(
      'backoff and dead work block later messages; explicit audited retry restores order',
      async () => {
        await reset();
        await store.persist([event(), event()]);
        const lease = await claim();
        await admin.query('UPDATE work_outbox SET max_attempts=2 WHERE id=$1', [lease.id]);
        assert.equal(await queue.fail(lease, 'handler_failed', 300000), true);
        assert.equal(await queue.claim('onboarding', 'blocked'), null);
        await admin.query('UPDATE work_outbox SET available_at=clock_timestamp() WHERE id=$1', [
          lease.id,
        ]);
        const retry = await claim();
        assert.equal(retry.id, lease.id);
        await expire(retry);
        await queue.recoverExpired();
        assert.equal(
          (await admin.query('SELECT status FROM work_outbox WHERE id=$1', [lease.id])).rows[0]
            .status,
          'dead',
        );
        assert.equal(await queue.claim('onboarding', 'blocked'), null);
        assert.equal(await queue.requeueDead(lease.id, 'test-operator'), true);
        assert.equal(await queue.requeueDead(lease.id, 'test-operator'), false);
        const restarted = await claim();
        assert.equal(restarted.attempts, 1);
        await finish(restarted);
        await finish(await claim());
        assert.deepEqual(
          (
            await worker.query('SELECT action FROM work_recovery_events ORDER BY created_at')
          ).rows.map((x) => x.action),
          ['attempts_exhausted', 'operator_retry'],
        );
      },
    );

    await t.test(
      'onboarding advances past queued actions; actions remain ordered and receipts separate',
      async () => {
        await reset();
        await store.persist([event(), event(), event('unused', 'business', 'delivery.status')]);
        const first = await claim();
        await queue.commit(first, async () => ({ nextStage: 'action' }));
        const second = await claim();
        const action = await claim('action');
        assert.equal(action.id, first.id);
        assert.equal(action.attempts, 1);
        await queue.commit(second, async () => ({ nextStage: 'action' }));
        assert.equal(await queue.claim('action', 'blocked'), null);
        await finish(await claim('receipt'));
        await finish(action);
        assert.equal((await claim('action')).id, second.id);
        assert.equal(await queue.claim('onboarding', 'empty'), null);
      },
    );

    await t.test(
      'heartbeat preserves a lease during preparation longer than its original deadline',
      async () => {
        await reset();
        await store.persist([event(), event()]);
        const runner = new WorkRunner(queue, 'heartbeat-worker', 1200);
        assert.equal(
          await runner.runOne('onboarding', {
            prepare: async (lease) => {
              await setTimeout(1800);
              const held = (
                await admin.query('SELECT lease_until FROM work_outbox WHERE id=$1', [lease.id])
              ).rows[0];
              assert.ok(held.lease_until.getTime() > lease.lease_until.getTime());
              assert.equal(await queue.recoverExpired(), 0);
              assert.equal(await queue.claim('onboarding', 'competitor'), null);
              return 'prepared';
            },
            apply: async (client, lease, value) => {
              await client.query('INSERT INTO effects VALUES($1,$2)', [lease.event_id, value]);
              return { nextStage: null };
            },
          }),
          true,
        );
        assert.equal((await admin.query('SELECT value FROM effects')).rows[0]?.value, 'prepared');
        await finish(await claim());
      },
    );

    await t.test('lost lease aborts preparation and fences a late result', async () => {
      await reset();
      await store.persist([event()]);
      let applied = false;
      const runner = new WorkRunner(queue, 'lost-worker', 600);
      await runner.runOne('onboarding', {
        prepare: async (lease, signal) => {
          const aborted = new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          await expire(lease);
          await queue.recoverExpired();
          await aborted;
          return null;
        },
        apply: async () => {
          applied = true;
          return { nextStage: null };
        },
      });
      assert.equal(applied, false);
      await finish(await claim());
    });

    await t.test(
      'shutdown releases work even if preparation ignores cancellation; late results cannot apply',
      async () => {
        await reset();
        await store.persist([event()]);
        const shutdown = new AbortController();
        let release!: (value: null) => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const pending = new Promise<null>((resolve) => {
          release = resolve;
        });
        let applied = false;
        const running = new WorkRunner(queue, 'shutdown-worker').runOne(
          'onboarding',
          {
            prepare: async () => {
              entered();
              return pending;
            },
            apply: async () => {
              applied = true;
              return { nextStage: null };
            },
          },
          shutdown.signal,
        );
        await started;
        shutdown.abort();
        await running;
        release(null);
        await setTimeout(0);
        assert.equal(applied, false);
        const state = (await admin.query('SELECT status,last_error_code FROM work_outbox')).rows[0];
        assert.deepEqual(state, { status: 'pending', last_error_code: 'shutdown' });
        await finish(await claim());
        assert.equal(
          await new WorkRunner(queue, 'stopped').runOne(
            'onboarding',
            {
              prepare: async () => null,
              apply: async () => ({ nextStage: null }),
            },
            shutdown.signal,
          ),
          false,
        );
      },
    );

    await t.test(
      'handler errors retry without leaking error messages; permanent errors dead-letter',
      async () => {
        await reset();
        await store.persist([event()]);
        const runner = new WorkRunner(queue, 'failure-worker');
        await runner.runOne('onboarding', {
          prepare: () => {
            throw new Error('private message');
          },
          apply: async () => ({ nextStage: null }),
        });
        let state = (await admin.query('SELECT * FROM work_outbox')).rows[0];
        assert.equal(state.status, 'pending');
        assert.equal(state.last_error_code, 'handler_failed');
        await admin.query('UPDATE work_outbox SET available_at=clock_timestamp()');
        await runner.runOne('onboarding', {
          prepare: async () => {
            throw new PermanentWorkError('private message');
          },
          apply: async () => ({ nextStage: null }),
        });
        state = (await admin.query('SELECT * FROM work_outbox')).rows[0];
        assert.equal(state.status, 'dead');
        assert.equal(state.last_error_code, 'permanent_failure');
        assert.equal(await queue.claim('onboarding', 'blocked'), null);
      },
    );

    await t.test('shutdown during claim does not start preparation', async () => {
      await reset();
      await store.persist([event()]);
      const shutdown = new AbortController();
      class StopAfterClaim extends WorkQueue {
        override async claim(...args: Parameters<WorkQueue['claim']>) {
          const lease = await super.claim(...args);
          shutdown.abort();
          return lease;
        }
      }
      let prepared = false;
      await new WorkRunner(new StopAfterClaim(worker), 'stopping-worker').runOne(
        'onboarding',
        {
          prepare: async () => {
            prepared = true;
            return null;
          },
          apply: async () => ({ nextStage: null }),
        },
        shutdown.signal,
      );
      assert.equal(prepared, false);
      await finish(await claim());
    });

    await t.test(
      'ingress stream lock prevents allocating sequence numbers before earlier commits',
      async () => {
        await reset();
        const client = await admin.connect();
        const first = event();
        const second = event();
        let pending: Promise<unknown> | undefined;
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
            JSON.stringify(['business', 'inbound.message', 'alice']),
          ]);
          // Simulate the first ingress transaction retaining its stream lock before commit.
          await client.query(
            `WITH e AS (INSERT INTO ingress_events(event_key,kind,phone_number_id,provider_message_id,sender_id,payload)
          VALUES($1,'inbound.message','business',$1,'alice','{}') RETURNING id)
          INSERT INTO work_outbox(event_id,topic,stage) SELECT id,'inbound.message','onboarding' FROM e`,
            [first.eventKey],
          );
          pending = store.persist([second]);
          // Another user remains available while the first transaction is still invisible.
          await store.persist([event('bob')]);
          const bob = await claim();
          await finish(bob);
          assert.equal(await queue.claim('onboarding', 'waiting'), null);
          await client.query('COMMIT');
          await pending;
          const firstLease = await claim();
          assert.equal(
            (
              await admin.query('SELECT event_key FROM ingress_events WHERE id=$1', [
                firstLease.event_id,
              ])
            ).rows[0].event_key,
            first.eventKey,
          );
          await finish(firstLease);
          await finish(await claim());
        } finally {
          await client.query('ROLLBACK');
          client.release();
          await pending;
        }
      },
    );
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});
