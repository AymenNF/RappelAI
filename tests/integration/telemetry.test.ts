import { OperationsControl } from '../../src/modules/telemetry/control.js';
import { RuntimeTelemetry, databaseSink } from '../../src/modules/telemetry/runtime.js';
import { PrivacyAdmin } from '../../src/modules/privacy/admin.js';
import { DeliveryRecovery } from '../../src/modules/whatsapp/recovery.js';
import { ReminderScheduler } from '../../src/modules/reminders/scheduler.js';
import { UsageService } from '../../src/modules/usage/service.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { WorkQueue } from '../../src/modules/processing/leases.js';
import { WorkRunner } from '../../src/modules/processing/runner.js';
import { ExecutionProcessor } from '../../src/modules/processing/execution.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'operational telemetry and alerts under restricted runtime logins',
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
      const reset = () =>
        admin.query(
          'TRUNCATE users,ingress_events,usage_global_periods,privacy_tombstones,privacy_operations,model_rate_cards CASCADE',
        );
      const privacy = new PrivacyAdmin(admin);
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
      const request = async (kind: string, who = 'alice') => {
        await run(kind === 'delete' ? 'DELETE ACCOUNT' : 'EXPORT DATA', who);
        return (
          await worker.query(
            "SELECT r.* FROM privacy_requests r JOIN users u ON u.id=r.user_id WHERE u.sender_id=$1 AND r.kind=$2 AND r.status IN ('offered','requested')",
            [who, kind],
          )
        ).rows[0];
      };
      const confirm = async (who = 'alice') => {
        const r = await request('delete', who);
        await run(`CONFIRM DELETE ${r.reference}`, who);
        return r;
      };

      const ops = new OperationsControl(admin);
      const clean = async () => {
        await reset();
        await admin.query(
          'TRUNCATE telemetry_runtime,telemetry_counters,telemetry_batches,monitoring_alerts,monitoring_events,monitoring_snapshot CASCADE',
        );
        await admin.query('UPDATE monitoring_policy SET expect_api=false,expect_worker=false');
        await admin.query('UPDATE usage_policy SET enabled=false,global_monthly_micros=0');
      };
      const attempt = async (who: string, state: string) => {
        const a = await plan({ behavior: 'noop', calls: [] }, who);
        const id = randomUUID();
        await admin.query(
          `INSERT INTO whatsapp_attempts(id,user_id,event_id,identity_event_id,phone_number_id,recipient_id,state,provider_message_id)
        VALUES($1,$2,$3,$3,'12345',$4,$5,$6)`,
          [id, a.userId, a.eventId, who, state, state === 'accepted' ? randomUUID() : null],
        );
        return { ...a, id };
      };
      await t.test(
        'component-scoped numeric batches are idempotent and all operational reads require administrator access',
        async () => {
          await clean();
          const id = randomUUID();
          await Promise.all(
            [1, 2, 3].map(() =>
              ingress.query('SELECT record_telemetry($1,$2,$3)', [
                'api',
                id,
                { requests: 4, server_error: 1 },
              ]),
            ),
          );
          assert.equal(
            (await admin.query("SELECT value FROM telemetry_counters WHERE metric='requests'"))
              .rows[0].value,
            '4',
          );
          await assert.rejects(
            worker.query("SELECT record_telemetry('api',$1,'{}')", [randomUUID()]),
            /denied/,
          );
          await assert.rejects(
            ingress.query("SELECT record_telemetry('worker',$1,'{}')", [randomUUID()]),
            /denied/,
          );
          for (const counts of [
            { phone: 'secret' },
            { requests: -1 },
            { requests: 1.5 },
            { requests: 1000000001 },
            [],
          ])
            await assert.rejects(
              ingress.query("SELECT record_telemetry('api',$1,$2)", [
                randomUUID(),
                JSON.stringify(counts),
              ]),
            );
          for (const role of [worker, ingress, tenant]) {
            for (const table of [
              'monitoring_alerts',
              'monitoring_events',
              'monitoring_snapshot',
              'monitoring_policy',
              'telemetry_counters',
              'telemetry_batches',
              'telemetry_runtime',
            ])
              await assert.rejects(role.query(`SELECT * FROM ${table}`), /permission denied/);
            await assert.rejects(new OperationsControl(role).check());
            await assert.rejects(new OperationsControl(role).queue('work'));
            await assert.rejects(new OperationsControl(role).expect('api', true));
          }
          await assert.rejects(
            tenant.query("SELECT record_telemetry('api',$1,'{}')", [randomUUID()]),
          );
          // A temp relation must not shadow the definer's real tables.
          const c = await ingress.connect();
          try {
            await c.query(
              'CREATE TEMP TABLE telemetry_runtime(component text,heartbeat_at timestamptz)',
            );
            await c.query("SELECT record_telemetry('api',$1,'{}')", [randomUUID()]);
            assert.equal((await c.query('SELECT * FROM pg_temp.telemetry_runtime')).rowCount, 0);
          } finally {
            c.release();
          }
        },
      );
      await t.test(
        'injected webhook and cycle failures open actionable alerts; repeated checks do not duplicate transitions',
        async () => {
          await clean();
          const api = new RuntimeTelemetry('api', databaseSink(ingress));
          api.http(503, 1001);
          api.http(429, 10);
          await api.flush();
          const wr = new RuntimeTelemetry('worker', databaseSink(worker));
          wr.add('cycle_failed');
          await wr.flush();
          const results = await Promise.all([ops.check(), ops.check(), ops.check()]);
          assert.equal(
            results.flatMap((r) => r.changes).filter((r) => r.key === 'api_errors').length,
            1,
          );
          assert.ok(
            results
              .flatMap((r) => r.changes)
              .some((r) => r.key === 'worker_errors' && r.action.includes('database')),
          );
          const state = await ops.status();
          assert.equal(state.events.filter((e) => e.key === 'api_errors').length, 1);
          assert.equal(results[0]!.snapshot.http.server_error, 1);
          assert.equal(results[0]!.snapshot.http.overload, 1);
          await admin.query("UPDATE telemetry_counters SET minute=minute-interval '6 minutes'");
          const recovered = await ops.check();
          assert.ok(
            recovered.changes.some((a) => a.key === 'api_errors' && a.transition === 'resolved'),
          );
        },
      );
      await t.test(
        'expected heartbeats detect stopped processes and stale acknowledgements cannot hide a new incident',
        async () => {
          await clean();
          assert.deepEqual((await ops.check()).changes, []);
          assert.equal((await ops.status()).monitor, 'current');
          await admin.query(
            "UPDATE monitoring_snapshot SET observed_at=clock_timestamp()-interval '61 seconds'",
          );
          assert.equal((await ops.status()).monitor, 'stale');
          await ops.expect('api', true);
          await ops.expect('worker', true);
          assert.equal((await ops.check()).changes.length, 2);
          assert.equal(await ops.acknowledge('api_missing', 1), true);
          assert.equal(await ops.acknowledge('api_missing', 1), false);
          assert.equal(
            (await ops.status()).alerts.find((a) => a.key === 'api_missing').status,
            'active',
          );
          await new RuntimeTelemetry('api', databaseSink(ingress)).flush();
          await new RuntimeTelemetry('worker', databaseSink(worker)).flush();
          assert.equal(
            (await ops.check()).changes.filter((a) => a.transition === 'resolved').length,
            2,
          );
          await admin.query(
            "UPDATE telemetry_runtime SET heartbeat_at=clock_timestamp()-interval '121 seconds'",
          );
          assert.ok((await ops.check()).changes.every((a) => a.generation === 2));
          await assert.rejects(ops.acknowledge('api_missing', 1), /not active/);
          assert.equal(
            (await ops.status()).alerts.find((a) => a.key === 'api_missing').acknowledged_at,
            null,
          );
        },
      );
      await t.test(
        'runnable, dead and expired work appear without raw identifiers; delayed retry is not runnable',
        async () => {
          await clean();
          const a = await plan(undefined, 'private-sender-canary');
          await admin.query(
            "UPDATE work_outbox SET created_at=clock_timestamp()-interval '2 minutes',available_at=clock_timestamp()+interval '1 hour'",
          );
          assert.equal((await ops.check()).snapshot.signals.work_stalled, 0);
          await admin.query('UPDATE work_outbox SET available_at=clock_timestamp()');
          assert.equal((await ops.check()).snapshot.signals.work_stalled, 1);
          await admin.query("UPDATE work_outbox SET status='dead'");
          const result = await ops.check();
          assert.equal(result.snapshot.signals.work_dead, 1);
          const visible = await ops.queue('work');
          assert.equal(visible.items.length, 1);
          assert.doesNotMatch(
            JSON.stringify(result) + JSON.stringify(visible),
            /private-sender-canary|synthetic instruction/,
          );
          assert.ok(!JSON.stringify(result).includes(a.userId));
          await admin.query(
            "UPDATE work_outbox SET status='leased',lease_token=gen_random_uuid(),lease_owner='private-worker-canary',lease_until=clock_timestamp()-interval '1 second'",
          );
          assert.equal((await ops.check()).snapshot.signals.lease_expired, 1);
          await queue.recoverExpired();
          assert.equal((await ops.check()).snapshot.signals.lease_expired, 0);
        },
      );
      await t.test(
        'unknown model usage and exact monetary totals stay visible until reconciliation',
        async () => {
          await clean();
          const a = await plan(undefined, '15555550101', false);
          const work = (
            await admin.query('SELECT id FROM work_outbox WHERE event_id=$1', [a.eventId])
          ).rows[0];
          await admin.query(
            "INSERT INTO usage_global_periods(period,reserved_micros,spent_micros) VALUES(date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,9000000000000001,0)",
          );
          await admin.query(
            'INSERT INTO usage_user_periods(user_id,period,reserved_micros) SELECT $1,period,9000000000000001 FROM usage_global_periods',
            [a.userId],
          );
          const id = (
            await admin.query(
              `INSERT INTO usage_reservations(work_id,event_id,user_id,lease_token,period,provider,model,rate_version,input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_micros,state,created_at)
        SELECT $1,$2,$3,gen_random_uuid(),period,'fake','model','v1',0,0,10,10,9000000000000001,'unknown',clock_timestamp()-interval '6 minutes' FROM usage_global_periods RETURNING id`,
              [work.id, a.eventId, a.userId],
            )
          ).rows[0].id;
          await admin.query(
            'UPDATE usage_policy SET enabled=true,global_monthly_micros=10000000000000000',
          );
          const result = await ops.check();
          assert.equal(result.snapshot.signals.model_unresolved, 1);
          assert.equal(result.snapshot.signals.spend_near_cap, 1);
          assert.equal(result.snapshot.spending.reservedMicros, '9000000000000001');
          assert.equal((await ops.queue('model')).items[0].id, id);
          await ops.acknowledge('model_unresolved', 1);
          assert.equal(
            (await admin.query('SELECT state FROM usage_reservations WHERE id=$1', [id])).rows[0]
              .state,
            'unknown',
          );
          await new UsageService(admin).reconcile(id, 0, 0, 'synthetic no usage evidence');
          assert.equal((await ops.check()).snapshot.signals.model_unresolved, 0);
        },
      );
      await t.test(
        'send deadlines, unknowns, failures and conflicts are separate from provider acceptance and delivery',
        async () => {
          await clean();
          const unknown = await attempt('15555550101', 'unknown');
          await attempt('15555550102', 'dispatching');
          const accepted = await attempt('15555550103', 'accepted');
          const rejected = await attempt('15555550104', 'rejected');
          await admin.query(
            "UPDATE whatsapp_attempts SET created_at=clock_timestamp()-interval '6 minutes',dispatch_deadline=clock_timestamp()-interval '1 second'",
          );
          await admin.query(
            "INSERT INTO delivery_recovery_audit(user_id,attempt_id,action) VALUES($1,$2,'late_acceptance_conflict')",
            [rejected.userId, rejected.id],
          );
          const result = await ops.check();
          assert.equal(result.snapshot.signals.send_unknown, 1);
          assert.equal(result.snapshot.signals.send_expired, 1);
          assert.equal(result.snapshot.signals.send_failed, 1);
          assert.equal(result.snapshot.signals.send_conflict, 1);
          assert.ok(
            result.snapshot.delivery.some(
              (d) => d.state === 'accepted' && d.deliveryStatus === 'none',
            ),
          );
          assert.ok(!result.snapshot.delivery.some((d) => d.deliveryStatus === 'delivered'));
          await admin.query(
            "UPDATE whatsapp_attempts SET delivery_status='delivered' WHERE id=$1",
            [accepted.id],
          );
          assert.ok(
            (await ops.check()).snapshot.delivery.some((d) => d.deliveryStatus === 'delivered'),
          );
          assert.ok((await ops.queue('send')).items.some((a) => a.id === unknown.id));
          await new DeliveryRecovery(admin).reconcile(unknown.id, {
            action: 'abandon',
            note: 'synthetic unresolved evidence',
          });
          assert.equal((await ops.check()).snapshot.signals.send_unknown, 0);
          // Even an abandoned attempt remains visible if conflicting late acceptance needs reconciliation.
          await admin.query(
            "INSERT INTO delivery_recovery_audit(user_id,attempt_id,action) VALUES($1,$2,'late_acceptance_conflict')",
            [unknown.userId, unknown.id],
          );
          assert.ok((await ops.queue('send')).items.some((a) => a.id === unknown.id));
        },
      );
      await t.test(
        'scheduler and promised outbound delays are measured independently, including intentionally disabled sends',
        async () => {
          await clean();
          await plan();
          await runner.runOne('execution', executor);
          await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '2 minutes'");
          assert.equal((await ops.check()).snapshot.signals.reminders_late, 1);
          await new ReminderScheduler(worker).sweep();
          const result = await ops.check();
          assert.equal(result.snapshot.signals.reminders_late, 0);
          assert.equal(result.snapshot.signals.outbound_late, 1);
          await admin.query(
            "UPDATE outbound_messages SET status='suppressed',suppression_reason='identity_changed'",
          );
          assert.equal((await ops.check()).snapshot.signals.outbound_late, 0);
        },
      );
      await t.test(
        'aged unmatched receipts and deletion holds surface; privacy erasure removes diagnostic references',
        async () => {
          await clean();
          const a = await add();
          const key = randomUUID();
          await store.persist([
            {
              eventKey: key,
              kind: 'delivery.status',
              phoneNumberId: '12345',
              providerMessageId: key,
              senderId: null,
              payload: { recipient_id: 'alice' },
            },
          ]);
          await admin.query(
            `INSERT INTO whatsapp_receipts(event_id,phone_number_id,provider_message_id,recipient_id,status,occurred_at,created_at)
        SELECT id,'12345',provider_message_id,'alice','sent',clock_timestamp(),clock_timestamp()-interval '6 minutes' FROM ingress_events WHERE event_key=$1`,
            [key],
          );
          await confirm();
          await admin.query(
            "UPDATE users SET deletion_requested_at=clock_timestamp()-interval '2 hours'",
          );
          const before = await ops.check();
          assert.equal(before.snapshot.signals.privacy_waiting, 1);
          assert.equal(before.snapshot.signals.receipts_unmatched, 1);
          assert.equal((await ops.queue('privacy')).items[0].id, a.userId);
          assert.equal((await privacy.purge(a.userId)).status, 'purged');
          assert.equal((await ops.queue('privacy')).items.length, 0);
          assert.equal((await ops.queue('receipt')).items.length, 0);
          assert.equal((await ops.check()).snapshot.signals.privacy_waiting, 0);
          assert.ok(!JSON.stringify(await ops.status()).includes(a.userId));
        },
      );
      await t.test(
        'keyset diagnostic pagination preserves sub-millisecond timestamps without duplicates',
        async () => {
          await clean();
          for (let i = 0; i < 5; i++) await plan(undefined, `sender-${i}`);
          await admin.query("UPDATE work_outbox SET created_at='2026-01-01T00:00:00.123456Z'");
          const ids: string[] = [];
          let cursor: { createdAt: string; id: string } | undefined;
          do {
            const page = await ops.queue('work', 2, cursor);
            ids.push(...page.items.map((i) => i.id));
            cursor = page.next ?? undefined;
          } while (cursor);
          assert.equal(ids.length, 5);
          assert.equal(new Set(ids).size, 5);
          await assert.rejects(ops.queue('work', 201));
          await assert.rejects(ops.queue('work', 1, { createdAt: 'bad', id: randomUUID() }));
        },
      );
      await t.test(
        'snapshot and transition writes roll back together; failed observation does not resolve alerts',
        async () => {
          await clean();
          await ops.expect('worker', true);
          await ops.check();
          const before = await ops.status();
          await new RuntimeTelemetry('worker', databaseSink(worker)).flush();
          await admin.query(`CREATE FUNCTION fail_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected snapshot failure'; END$$;
        CREATE TRIGGER fail_snapshot BEFORE UPDATE ON monitoring_snapshot FOR EACH ROW EXECUTE FUNCTION fail_snapshot()`);
          await assert.rejects(ops.check(), /injected snapshot/);
          const after = await ops.status();
          assert.equal(after.events.length, before.events.length);
          assert.equal(after.alerts[0].status, 'active');
          assert.deepEqual(after.latest, before.latest);
          await admin.query(
            'DROP TRIGGER fail_snapshot ON monitoring_snapshot; DROP FUNCTION fail_snapshot()',
          );
          assert.equal((await ops.check()).changes[0]!.transition, 'resolved');
        },
      );
      await t.test(
        'history cleanup is bounded and retains live alert state and business records',
        async () => {
          await clean();
          const a = await add();
          await admin.query(
            "INSERT INTO telemetry_batches(id,component,created_at) SELECT gen_random_uuid(),'api',clock_timestamp()-interval '8 days' FROM generate_series(1,1002)",
          );
          await ops.expect('api', true);
          await ops.check();
          assert.equal((await admin.query('SELECT * FROM telemetry_batches')).rowCount, 2);
          await admin.query(
            "UPDATE monitoring_events SET created_at=clock_timestamp()-interval '31 days'",
          );
          await ops.check();
          assert.equal((await admin.query('SELECT * FROM monitoring_events')).rowCount, 0);
          assert.equal((await ops.status()).alerts[0].status, 'active');
          assert.equal(
            (await worker.query('SELECT * FROM list_items WHERE user_id=$1', [a.userId])).rowCount,
            1,
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
