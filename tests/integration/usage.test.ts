import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { withTenant } from '../../src/db/tenant.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { UsageService } from '../../src/modules/usage/service.js';
import { UsageControl } from '../../src/modules/usage/control.js';
import { WorkQueue, type WorkLease } from '../../src/modules/processing/leases.js';
import { WorkRunner, DeferredWorkError } from '../../src/modules/processing/runner.js';
import { ModelAdapter, type ModelTransport } from '../../src/modules/processing/model.js';
import { PlanProcessor } from '../../src/modules/processing/plans.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test('atomic spending reservations and operator controls', { timeout: 30000 }, async (t) => {
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
    const service = new UsageService(worker);
    const control = new UsageControl(admin);
    const queue = new WorkQueue(worker);
    const rate = {
      provider: 'fake',
      model: 'test-v1',
      version: 'v1',
      inputMicrosPerMillion: '1000000',
      outputMicrosPerMillion: '1000000',
      maxInputTokens: 10000,
      maxOutputTokens: 1000,
    };
    const reset = async () => {
      await admin.query(
        'TRUNCATE users,ingress_events,usage_global_periods,model_rate_cards,usage_audit CASCADE',
      );
      await control.limits('1000000', '1000000', 'test limits');
      await control.rate(rate, 'synthetic test prices');
      await control.switch(true, 'test');
    };
    // Activate distinct events directly to exercise the budget gate independently of queue ordering.
    const job = async (sender: string = randomUUID()) => {
      const time = new Date(Date.now() - 10000);
      await admin.query(
        `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('test',$1,$2,$3,false,'UTC',$3) ON CONFLICT DO NOTHING`,
        [sender, CONSENT_VERSION, time],
      );
      const user = (await admin.query('SELECT * FROM users WHERE sender_id=$1', [sender])).rows[0];
      const key = randomUUID();
      const event = (
        await admin.query(
          `INSERT INTO ingress_events(event_key,kind,phone_number_id,provider_message_id,sender_id,payload)
        VALUES($1,'inbound.message','test',$1,$2,$3) RETURNING id`,
          [key, sender, { type: 'text', text: { body: 'Add milk to grocery' } }],
        )
      ).rows[0];
      await admin.query(
        `INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at)
        VALUES($1,$2,'ready',$3,$4)`,
        [event.id, user.id, user.consent_at, user.timezone_confirmed_at],
      );
      const lease = (
        await admin.query(
          `INSERT INTO work_outbox(event_id,topic,stage,status,lease_token,lease_owner,lease_until,attempts)
        VALUES($1,'inbound.message','action','leased',gen_random_uuid(),'test',clock_timestamp()+interval '5 minutes',1) RETURNING *`,
          [event.id],
        )
      ).rows[0] as WorkLease;
      return { lease, userId: user.id as string };
    };
    const reserve = (item: Awaited<ReturnType<typeof job>>) =>
      service.reserve(item.lease, item.userId, 'fake', 'test-v1');
    const totals = async () =>
      (
        await admin.query(
          'SELECT reserved_micros,spent_micros FROM usage_global_periods ORDER BY period DESC LIMIT 1',
        )
      ).rows[0];
    const denied = (code: string) => (error: unknown) =>
      error instanceof DeferredWorkError && error.code === code;
    const fake: ModelTransport = {
      provider: 'fake',
      model: 'test-v1',
      generate: async () => ({
        text: JSON.stringify({ behavior: 'noop', calls: [] }),
        model: 'test-v1',
        responseId: 'fake-response',
        inputTokens: 12,
        outputTokens: 18,
      }),
    };
    const request = () => ({
      system: 'synthetic',
      input: 'synthetic',
      signal: new AbortController().signal,
    });

    await t.test('defaults fail closed and workers cannot enable or raise budgets', async () => {
      assert.equal((await admin.query('SELECT enabled FROM usage_policy')).rows[0].enabled, false);
      const item = await job();
      await assert.rejects(reserve(item), denied('usage_paused'));
      await assert.rejects(worker.query('UPDATE usage_policy SET enabled=true'), { code: '42501' });
      await assert.rejects(worker.query('UPDATE usage_policy SET global_monthly_micros=999999'), {
        code: '42501',
      });
      await assert.rejects(new UsageControl(worker).switch(true, 'unauthorized'), /administrator/);
    });

    await t.test(
      'concurrent global reservations cannot exceed the cap; duplicate attempt is idempotent',
      async () => {
        await reset();
        await control.limits('33000', '1000000', 'cap');
        const items = await Promise.all(Array.from({ length: 10 }, () => job()));
        const results = await Promise.allSettled(items.map(reserve));
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
        for (const result of results)
          if (result.status === 'rejected') assert.ok(denied('budget_exhausted')(result.reason));
        assert.deepEqual(await totals(), { reserved_micros: '33000', spent_micros: '0' });
        const winner = results.findIndex((r) => r.status === 'fulfilled');
        const copies = await Promise.all(Array.from({ length: 8 }, () => reserve(items[winner]!)));
        assert.equal(new Set(copies.map((r) => r.id)).size, 1);
        assert.equal((await totals()).reserved_micros, '33000');
        assert.equal((await worker.query('SELECT * FROM usage_reservations')).rowCount, 3);
      },
    );

    await t.test('per-user defaults and overrides enforce independent caps', async () => {
      await reset();
      await control.limits('1000000', '11000', 'user cap');
      const a = await job('alice');
      const b = await job('alice');
      const c = await job('bob');
      const attempts = await Promise.allSettled([reserve(a), reserve(b)]);
      assert.equal(attempts.filter((r) => r.status === 'fulfilled').length, 1);
      await reserve(c);
      await control.userLimit(a.userId, '22000', 'increase Alice only');
      await reserve(attempts[0]!.status === 'rejected' ? a : b);
      await assert.rejects(reserve(await job('bob')), denied('budget_exhausted'));
      assert.equal((await totals()).reserved_micros, '33000');
    });

    await t.test(
      'one dispatch and one settlement; unused reservation is returned exactly once',
      async () => {
        await reset();
        const item = await job();
        const held = await reserve(item);
        const dispatched = await Promise.all(
          Array.from({ length: 8 }, () => service.dispatch(held.id, item.lease)),
        );
        assert.equal(dispatched.filter(Boolean).length, 1);
        const settled = await Promise.all(
          Array.from({ length: 8 }, () => service.settle(held.id, 12, 18)),
        );
        assert.equal(settled.filter(Boolean).length, 1);
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '30' });
        await assert.rejects(service.settle(held.id, 13, 18), /Conflicting/);
        assert.equal(
          (await admin.query('SELECT enabled FROM usage_policy')).rows[0].enabled,
          false,
        );
        await control.switch(true, 'confirmed original test settlement');
        assert.equal(await service.release(held.id), false);
        const unsent = await reserve(await job());
        assert.equal(await service.release(unsent.id), true);
        assert.equal(await service.release(unsent.id), false);
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '30' });
      },
    );

    await t.test(
      'pause blocks reservations and dispatch but allows in-flight settlement',
      async () => {
        await reset();
        const first = await job();
        const second = await job();
        const sent = await reserve(first);
        const unsent = await reserve(second);
        await service.dispatch(sent.id, first.lease);
        await control.switch(false, 'incident');
        await assert.rejects(reserve(await job()), denied('usage_paused'));
        await assert.rejects(service.dispatch(unsent.id, second.lease), denied('usage_paused'));
        await service.release(unsent.id);
        await service.settle(sent.id, 12, 18);
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '30' });
        await control.switch(true, 'incident resolved');
        await reserve(await job());
        assert.equal(
          (await worker.query("SELECT * FROM usage_audit WHERE action='operator_paused'")).rowCount,
          1,
        );
      },
    );

    await t.test(
      'recovery refunds only unsent work; uncertain calls hold funds until audited reconciliation',
      async () => {
        await reset();
        const a = await job();
        const b = await job();
        const unsent = await reserve(a);
        const sent = await reserve(b);
        await service.dispatch(sent.id, b.lease);
        await admin.query(
          "UPDATE work_outbox SET lease_until=clock_timestamp()-interval '1 second'",
        );
        assert.equal(await service.recover(), 2);
        assert.equal(await service.recover(), 0);
        assert.equal(
          (await worker.query('SELECT state FROM usage_reservations WHERE id=$1', [unsent.id]))
            .rows[0].state,
          'released',
        );
        assert.equal(
          (await worker.query('SELECT state FROM usage_reservations WHERE id=$1', [sent.id]))
            .rows[0].state,
          'unknown',
        );
        assert.equal(await service.release(sent.id), false);
        assert.equal((await totals()).reserved_micros, '11000');
        await assert.rejects(service.reconcile(sent.id, 0, 0, 'worker claim'), /administrator/);
        await new UsageService(admin).reconcile(sent.id, 12, 18, 'Verified synthetic usage');
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '30' });
        assert.equal(
          (await worker.query("SELECT * FROM usage_audit WHERE action='reconciliation_evidence'"))
            .rowCount,
          1,
        );
      },
    );

    await t.test(
      'an actual overrun is recorded honestly and automatically pauses new spending',
      async () => {
        await reset();
        const item = await job();
        const held = await reserve(item);
        await service.dispatch(held.id, item.lease);
        await service.settle(held.id, 12000, 2000);
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '14000' });
        assert.equal(
          (await admin.query('SELECT enabled FROM usage_policy')).rows[0].enabled,
          false,
        );
        assert.equal(
          (await worker.query("SELECT * FROM usage_audit WHERE action='ceiling_exceeded'"))
            .rowCount,
          1,
        );
        await assert.rejects(reserve(await job()), denied('usage_paused'));
      },
    );

    await t.test('new rates never reprice an existing reservation', async () => {
      await reset();
      const item = await job();
      const held = await reserve(item);
      await control.rate(
        { ...rate, version: 'v2', inputMicrosPerMillion: '2000000' },
        'new synthetic rate',
      );
      await service.dispatch(held.id, item.lease);
      await service.settle(held.id, 12, 18);
      assert.equal((await totals()).spent_micros, '30');
      const next = await reserve(await job());
      assert.equal(next.rate_version, 'v2');
      assert.equal(next.reserved_micros, '21000');
    });

    await t.test(
      'late settlement charges the original UTC month, not the current month',
      async () => {
        await reset();
        const item = await job();
        const held = await reserve(item);
        await service.dispatch(held.id, item.lease);
        const prior = (
          await admin.query(
            "SELECT (date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')-interval '1 month')::date::text AS period",
          )
        ).rows[0].period;
        await admin.query(
          'INSERT INTO usage_global_periods(period,reserved_micros) VALUES($1,11000)',
          [prior],
        );
        await admin.query(
          'INSERT INTO usage_user_periods(user_id,period,reserved_micros) VALUES($1,$2,11000)',
          [item.userId, prior],
        );
        await admin.query('UPDATE usage_reservations SET period=$1 WHERE id=$2', [prior, held.id]);
        await admin.query('UPDATE usage_global_periods SET reserved_micros=0 WHERE period=$1', [
          held.period,
        ]);
        await admin.query('UPDATE usage_user_periods SET reserved_micros=0 WHERE period=$1', [
          held.period,
        ]);
        await service.settle(held.id, 12, 18);
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '0' });
        assert.equal(
          (
            await admin.query('SELECT spent_micros FROM usage_global_periods WHERE period=$1', [
              prior,
            ])
          ).rows[0].spent_micros,
          '30',
        );
      },
    );

    await t.test(
      'tenant reads are scoped; policy, counters, rates and audit cannot be edited by tenants',
      async () => {
        await reset();
        const alice = await job('alice');
        const bob = await job('bob');
        await reserve(alice);
        await reserve(bob);
        await assert.rejects(service.reserve(alice.lease, bob.userId, 'fake', 'test-v1'), /lease/);
        const flags = (
          await admin.query(
            `SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname IN ('usage_user_limits','usage_user_periods','usage_reservations')`,
            [schema],
          )
        ).rows;
        assert.equal(flags.length, 3);
        assert.ok(flags.every((row) => row.relrowsecurity && row.relforcerowsecurity));
        assert.equal((await tenant.query('SELECT * FROM usage_reservations')).rowCount, 0);
        await withTenant(tenant, alice.userId, async (client) => {
          const rows = (await client.query('SELECT user_id FROM usage_reservations')).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].user_id, alice.userId);
          assert.equal((await client.query('SELECT * FROM usage_user_periods')).rowCount, 1);
        });
        for (const sql of [
          'UPDATE usage_reservations SET reserved_micros=0',
          'UPDATE usage_user_periods SET spent_micros=0',
          'SELECT * FROM usage_policy',
          'SELECT * FROM model_rate_cards',
          'SELECT * FROM usage_audit',
        ])
          await assert.rejects(tenant.query(sql), { code: '42501' });
        await assert.rejects(ingress.query('SELECT * FROM usage_reservations'), { code: '42501' });
        await assert.rejects(
          worker.query('UPDATE model_rate_cards SET input_micros_per_million=0'),
          { code: '42501' },
        );
        await assert.rejects(worker.query('DELETE FROM usage_audit'), { code: '42501' });
      },
    );

    await t.test(
      'kill and budget denials defer planning without provider calls or consumed attempts',
      async () => {
        await reset();
        const item = await job();
        let calls = 0;
        const planner = new PlanProcessor(
          worker,
          new ModelAdapter({
            ...fake,
            generate: async (req) => {
              calls++;
              return fake.generate(req);
            },
          }),
        );
        const runner = new WorkRunner(queue, 'gated');
        await queue.fail(item.lease, 'handler_failed', 0);
        await admin.query('UPDATE work_outbox SET attempts=0');
        await control.switch(false, 'pause');
        await runner.runOne('action', planner);
        let row = (await worker.query('SELECT * FROM work_outbox')).rows[0];
        assert.equal(row.attempts, 0);
        assert.equal(row.last_error_code, 'usage_paused');
        assert.equal(calls, 0);
        await control.switch(true, 'resume');
        await control.limits('0', '0', 'zero cap');
        await admin.query('UPDATE work_outbox SET available_at=clock_timestamp()');
        await runner.runOne('action', planner);
        row = (await worker.query('SELECT * FROM work_outbox')).rows[0];
        assert.equal(row.attempts, 0);
        assert.equal(row.last_error_code, 'budget_exhausted');
        assert.equal(calls, 0);
        await control.limits('11000', '11000', 'one reservation');
        await admin.query('UPDATE work_outbox SET available_at=clock_timestamp()');
        await runner.runOne('action', planner);
        assert.equal(calls, 1);
        assert.ok(await planner.read(item.lease.event_id));
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '30' });
      },
    );

    await t.test(
      'pre-dispatch payload and output-limit failures release their holds without calling the provider',
      async () => {
        await reset();
        let calls = 0;
        const transport = {
          ...fake,
          generate: async () => {
            calls++;
            return {};
          },
        };
        const first = await job();
        await assert.rejects(
          service.generate(
            first.lease,
            first.userId,
            { ...transport, maxOutputTokens: 2000 },
            request(),
          ),
          denied('rate_unconfigured'),
        );
        const second = await job();
        await assert.rejects(
          service.generate(second.lease, second.userId, transport, {
            ...request(),
            input: 'x'.repeat(10000),
          }),
          /too_large/,
        );
        assert.equal(calls, 0);
        assert.deepEqual(await totals(), { reserved_micros: '0', spent_micros: '0' });
        assert.equal(
          (await worker.query("SELECT id FROM usage_reservations WHERE state='released'")).rowCount,
          2,
        );
      },
    );

    await t.test(
      'unknown rate blocks calls; failed settlement preserves the entire reservation',
      async () => {
        await reset();
        const item = await job();
        await assert.rejects(
          service.reserve(item.lease, item.userId, 'fake', 'missing'),
          denied('rate_unconfigured'),
        );
        await admin.query(`CREATE FUNCTION fail_settlement() RETURNS trigger LANGUAGE plpgsql AS $fn$
        BEGIN IF NEW.spent_micros>OLD.spent_micros THEN RAISE EXCEPTION 'simulated persistence failure'; END IF; RETURN NEW; END $fn$`);
        await admin.query(
          'CREATE TRIGGER fail_settlement BEFORE UPDATE ON usage_global_periods FOR EACH ROW EXECUTE FUNCTION fail_settlement()',
        );
        try {
          await assert.rejects(
            service.generate(item.lease, item.userId, fake, request()),
            /simulated persistence failure/,
          );
          assert.deepEqual(await totals(), { reserved_micros: '11000', spent_micros: '0' });
          assert.equal(
            (await worker.query('SELECT state FROM usage_reservations')).rows[0].state,
            'unknown',
          );
        } finally {
          await admin.query('DROP TRIGGER fail_settlement ON usage_global_periods');
          await admin.query('DROP FUNCTION fail_settlement()');
        }
        const row = (await worker.query('SELECT id FROM usage_reservations')).rows[0];
        await new UsageService(admin).reconcile(row.id, 12, 18, 'Recovered known fake usage');
        assert.equal((await totals()).spent_micros, '30');
      },
    );
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const name of roles) await admin.query(`DROP ROLE ${name}`);
    await admin.end();
  }
});
