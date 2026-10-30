import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';
import { CONSENT_VERSION } from '../../src/modules/identity/onboarding.js';
import { BetaFeedbackControl } from '../../src/modules/beta/control.js';
import { BetaDailyReview } from '../../src/modules/beta/review.js';
import { PrivacyAdmin } from '../../src/modules/privacy/admin.js';
import { withTenant } from '../../src/db/tenant.js';
import { PROMPT_SHA256 } from '../../src/modules/processing/prompt.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'beta feedback, daily reviews and durable daily model totals',
  { timeout: 90000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', ''),
      schema = `test_${suffix}`;
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const pools: pg.Pool[] = [],
      roles: string[] = [];
    const login = async (capability: string) => {
      const role = `test_${capability}_${suffix}`,
        password = randomBytes(24).toString('hex');
      roles.push(role);
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(`GRANT memorae_${capability} TO ${role}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      const pool = new pg.Pool({
        connectionString: url.toString(),
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
        monitor = await login('monitor'),
        tenant = await login('tenant');
      const store = new PostgresIngressStore(ingress),
        identity = new IdentityProcessor(worker),
        feedback = new BetaFeedbackControl(admin),
        review = new BetaDailyReview(monitor);
      const today = (
        await admin.query(
          "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
        )
      ).rows[0].day as string;
      const yesterday = new Date(Date.parse(today + 'T00:00:00Z') - 86400000)
        .toISOString()
        .slice(0, 10);
      const reset = async () => {
        await admin.query(
          'TRUNCATE users,ingress_events,usage_global_periods,usage_daily_costs,privacy_tombstones CASCADE',
        );
        await admin.query("UPDATE beta_review_tracking SET started_at='2020-01-01Z'");
      };
      const user = async (sender: string) => {
        const at = new Date(Date.now() - 10000);
        return (
          await admin.query(
            `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at) VALUES('12345',$1,$2,$3,false,'UTC',$3) RETURNING id`,
            [sender, CONSENT_VERSION, at],
          )
        ).rows[0].id as string;
      };
      const send = async (sender: string, body: string, key = randomUUID()) => {
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
      const planned = async (sender: string) => {
        const uid = await user(sender),
          event = await send(sender, 'Synthetic plan');
        await admin.query(
          `INSERT INTO identity_results(event_id,user_id,disposition,consent_grant_at,timezone_confirmed_at) SELECT $1,id,'ready',consent_at,timezone_confirmed_at FROM users WHERE id=$2`,
          [event, uid],
        );
        await admin.query(
          `INSERT INTO action_plans(event_id,user_id,schema_version,decision,provider,model,prompt_version,prompt_sha256,input_sha256,input_tokens,output_tokens,latency_ms,reference_at,validated_at,consent_grant_at,timezone_confirmed_at,timezone)
        SELECT $1,id,'decision-v1','{"behavior":"noop","calls":[]}','fake','test','intent-v1',$3,$3,0,0,0,clock_timestamp(),clock_timestamp(),consent_at,timezone_confirmed_at,'UTC' FROM users WHERE id=$2`,
          [event, uid, PROMPT_SHA256],
        );
        await admin.query("UPDATE work_outbox SET stage='action' WHERE event_id=$1", [event]);
        return { uid, event };
      };
      await t.test(
        'feedback is handled once without a model; invalid, paused and deleting accounts do not record it',
        async () => {
          await reset();
          await user('alice');
          const key = randomUUID();
          await send('alice', 'FEEDBACK LATE', key);
          await identity.processNext();
          await send('alice', 'FEEDBACK LATE', key);
          assert.equal(await identity.processNext(), null);
          assert.equal((await worker.query('SELECT * FROM beta_feedback')).rowCount, 1);
          assert.equal((await worker.query('SELECT * FROM action_plans')).rowCount, 0);
          assert.match(
            (await worker.query('SELECT reply_text FROM identity_results')).rows[0].reply_text,
            /does not change a reminder/,
          );
          for (const text of ['FEEDBACK WRONG private details', 'STOP', 'FEEDBACK GOOD']) {
            await send('alice', text);
            await identity.processNext();
          }
          assert.equal((await worker.query('SELECT * FROM beta_feedback')).rowCount, 1);
          await admin.query(
            "UPDATE users SET deletion_requested_at=clock_timestamp() WHERE sender_id='alice'",
          );
          await send('alice', 'FEEDBACK MISSING');
          assert.equal(await identity.processNext(), null);
        },
      );
      await t.test(
        'tenant ownership, narrow monitor columns and operator-only revision-fenced triage',
        async () => {
          await reset();
          const alice = await user('alice'),
            bob = await user('bob');
          await send('alice', 'FEEDBACK WRONG');
          await identity.processNext();
          await send('bob', 'FEEDBACK GOOD');
          await identity.processNext();
          const a = (await feedback.list()).find((r) => r.category === 'wrong')!;
          await withTenant(tenant, alice, async (c) =>
            assert.equal((await c.query('SELECT * FROM beta_feedback')).rowCount, 1),
          );
          await withTenant(tenant, bob, async (c) =>
            assert.equal(
              (await c.query('SELECT * FROM beta_feedback WHERE id=$1', [a.id])).rowCount,
              0,
            ),
          );
          for (const role of [worker, tenant, monitor]) {
            await assert.rejects(
              new BetaFeedbackControl(role).triage(a.id, 1, 'resolved', 'fixed'),
            );
            await assert.rejects(
              role.query("UPDATE beta_feedback SET status='investigating'"),
              /permission denied/,
            );
          }
          await assert.rejects(
            monitor.query('SELECT user_id FROM beta_feedback'),
            /permission denied/,
          );
          const bEvent = (
            await admin.query("SELECT e.id FROM ingress_events e WHERE sender_id='bob' LIMIT 1")
          ).rows[0].id;
          await assert.rejects(
            worker.query(
              "INSERT INTO beta_feedback(user_id,event_id,category) VALUES($1,$2,'late')",
              [alice, bEvent],
            ),
            /owner mismatch/,
          );
          const results = await Promise.allSettled([
            feedback.triage(a.id, 1, 'investigating'),
            feedback.triage(a.id, 1, 'resolved', 'fixed'),
          ]);
          assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
          assert.equal((await admin.query('SELECT * FROM beta_feedback_audit')).rowCount, 1);
        },
      );
      await t.test(
        'triage failure rolls back status and audit; feedback and audit export and erase with the owner',
        async () => {
          await reset();
          const uid = await user('alice');
          await send('alice', 'FEEDBACK CONFUSING');
          await identity.processNext();
          const a = (await feedback.list())[0]!;
          await admin.query(
            "CREATE FUNCTION fail_feedback_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'injected'; END$$; CREATE TRIGGER fail_feedback BEFORE INSERT ON beta_feedback_audit FOR EACH ROW EXECUTE FUNCTION fail_feedback_audit()",
          );
          await assert.rejects(feedback.triage(a.id, 1, 'investigating'), /injected/);
          assert.equal((await feedback.list())[0].revision, 1);
          await admin.query(
            'DROP TRIGGER fail_feedback ON beta_feedback_audit; DROP FUNCTION fail_feedback_audit()',
          );
          await feedback.triage(a.id, 1, 'resolved', 'fixed');
          const req = (
            await admin.query(
              "INSERT INTO privacy_requests(user_id,kind,status) VALUES($1,'export','requested') RETURNING id",
              [uid],
            )
          ).rows[0].id;
          const exported = (await new PrivacyAdmin(admin).exportRequest(req)) as {
            data: Record<string, unknown[]>;
          };
          assert.ok(JSON.stringify(exported).includes('beta_feedback_audit'));
          await admin.query(
            'UPDATE users SET deletion_requested_at=clock_timestamp() WHERE id=$1',
            [uid],
          );
          assert.equal((await new PrivacyAdmin(admin).purge(uid)).status, 'purged');
          assert.equal((await admin.query('SELECT * FROM beta_feedback')).rowCount, 0);
          assert.equal((await admin.query('SELECT * FROM beta_feedback_audit')).rowCount, 0);
        },
      );
      await t.test(
        'daily model totals are exact, transactional, replay-safe and survive account erasure',
        async () => {
          await reset();
          const { uid, event } = await planned('cost');
          await admin.query(
            "INSERT INTO usage_global_periods(period) VALUES(date_trunc('month',clock_timestamp())::date)",
          );
          await admin.query(
            'INSERT INTO usage_user_periods(user_id,period) SELECT $1,period FROM usage_global_periods',
            [uid],
          );
          const insert = (connection: pg.Pool | pg.PoolClient = worker) =>
            connection.query(
              `INSERT INTO usage_reservations(work_id,event_id,user_id,lease_token,period,provider,model,rate_version,input_rate,output_rate,max_input_tokens,max_output_tokens,reserved_micros,state,actual_micros)
        SELECT q.id,q.event_id,$2,gen_random_uuid(),p.period,'fake','test','test',0,0,1,1,0,'settled',9007199254740993 FROM work_outbox q CROSS JOIN usage_global_periods p WHERE q.event_id=$1 RETURNING id`,
              [event, uid],
            );
          const first = (await insert()).rows[0].id;
          await worker.query(
            'UPDATE usage_reservations SET actual_micros=actual_micros WHERE id=$1',
            [first],
          );
          await assert.rejects(
            worker.query('UPDATE usage_reservations SET actual_micros=0 WHERE id=$1', [first]),
            /immutable/,
          );
          const c = await worker.connect();
          try {
            await c.query('BEGIN');
            await c.query(
              'CREATE TEMP TABLE usage_daily_costs(day date,settled_micros numeric,settled_calls bigint)',
            );
            await insert(c);
            assert.equal((await c.query('SELECT * FROM pg_temp.usage_daily_costs')).rowCount, 0);
            await c.query('ROLLBACK');
          } finally {
            c.release();
          }
          const report = await review.run(today, '0');
          assert.equal(report.modelCosts.settledMicros, '9007199254740993');
          assert.equal(report.modelCosts.settledCalls, '1');
          assert.ok(report.attention.includes('model_cost_review_threshold'));
          await Promise.all([insert(), insert()]);
          assert.equal(
            (await review.run(today, '0')).modelCosts.settledMicros,
            '27021597764222979',
          );
          assert.equal((await review.run(today, '0')).modelCosts.settledCalls, '3');
          for (const p of [worker, ingress, tenant, monitor])
            await assert.rejects(
              p.query('UPDATE usage_daily_costs SET settled_micros=0'),
              /permission denied/,
            );
          for (const p of [worker, ingress, tenant])
            await assert.rejects(new BetaDailyReview(p).run(today, '0'));
          await admin.query(
            'UPDATE users SET deletion_requested_at=clock_timestamp() WHERE id=$1',
            [uid],
          );
          assert.equal((await new PrivacyAdmin(admin).purge(uid)).status, 'purged');
          assert.equal(
            (await review.run(today, '0')).modelCosts.settledMicros,
            '27021597764222979',
          );
          await admin.query('UPDATE beta_review_tracking SET started_at=clock_timestamp()');
          assert.equal((await review.run(today, '0')).modelCosts.fullDayCoverage, false);
        },
      );
      await t.test(
        'daily delivery keeps missing intents in the denominator and separates acceptance from receipt evidence',
        async () => {
          await reset();
          const { uid, event } = await planned('delivery');
          const due = `${yesterday}T12:00:00Z`;
          const create = async (suppressed = false, materialize = true) => {
            const reminder = (
              await admin.query(
                `INSERT INTO reminders(user_id,source_event_id,plan_version,action_key,title,due_at,timezone,delivery_mode) VALUES($1,$2,1,$3,'Synthetic',$4,'UTC','immediate') RETURNING id`,
                [uid, event, randomBytes(32).toString('hex'), due],
              )
            ).rows[0].id;
            if (!materialize) return null;
            const occurrence = (
              await admin.query(
                `INSERT INTO reminder_occurrences(user_id,reminder_id,schedule_version,original_due_at,promised_due_at,status,suppression_reason) VALUES($1,$2,1,$3,$3,$4,$5) RETURNING id`,
                [
                  uid,
                  reminder,
                  due,
                  suppressed ? 'suppressed' : 'pending',
                  suppressed ? 'identity_changed' : null,
                ],
              )
            ).rows[0].id;
            const out = (
              await admin.query(
                `INSERT INTO outbound_messages(user_id,occurrence_id,body,available_at,consent_grant_at,timezone_confirmed_at,timezone,status,suppression_reason) SELECT id,$2,'Synthetic',$3,consent_at,timezone_confirmed_at,'UTC',$4,$5 FROM users WHERE id=$1 RETURNING id`,
                [
                  uid,
                  occurrence,
                  due,
                  suppressed ? 'suppressed' : 'pending',
                  suppressed ? 'identity_changed' : null,
                ],
              )
            ).rows[0].id;
            await admin.query('UPDATE reminders SET scheduled_at=clock_timestamp() WHERE id=$1', [
              reminder,
            ]);
            return out;
          };
          const a = await create(),
            b = await create();
          await create(true);
          await create(false, false);
          const predecessor = (
            await admin.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,message_payload,recovery_state,retry_at)
            VALUES($1,$2,'12345','delivery','rejected','{}','retry_wait',clock_timestamp()-interval '1 second') RETURNING id`,
              [uid, a],
            )
          ).rows[0].id;
          const attempt = (
            await admin.query(
              `INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,provider_message_id,message_payload,attempt_no,previous_attempt_id,retry_until)
        SELECT $1,$2,'12345','delivery','accepted','synthetic-provider','{}',2,$3,retry_until FROM whatsapp_attempts WHERE id=$3 RETURNING id`,
              [uid, a, predecessor],
            )
          ).rows[0].id;
          await admin.query(
            "INSERT INTO whatsapp_attempts(user_id,outbound_message_id,phone_number_id,recipient_id,state,message_payload) VALUES($1,$2,'12345','delivery','unknown','{}')",
            [uid, b],
          );
          let result = await review.run(yesterday, '0');
          assert.equal(result.delivery.accepted, 1);
          assert.equal(result.delivery.confirmed, 0);
          assert.deepEqual(result.delivery.onTimeEvidence, { numerator: 0, denominator: 3 });
          for (const status of ['delivered', 'read']) {
            const id = randomUUID();
            await store.persist([
              {
                eventKey: id,
                kind: 'delivery.status',
                phoneNumberId: '12345',
                providerMessageId: 'synthetic-provider',
                senderId: null,
                payload: { recipient_id: 'delivery' },
              },
            ]);
            const receiptEvent = (
              await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [id])
            ).rows[0].id;
            await admin.query(
              "INSERT INTO whatsapp_receipts(event_id,phone_number_id,provider_message_id,recipient_id,status,occurred_at,attempt_id,user_id) VALUES($1,'12345','synthetic-provider','delivery',$2,$3,$4,$5)",
              [receiptEvent, status, `${yesterday}T12:00:30Z`, attempt, uid],
            );
          }
          result = await review.run(yesterday, '0');
          assert.equal(result.delivery.confirmed, 1);
          assert.deepEqual(result.delivery.onTimeEvidence, { numerator: 1, denominator: 3 });
          assert.equal(result.delivery.uncertain, 1);
          assert.equal(result.delivery.suppressed, 1);
          assert.equal(result.otherCosts.whatsapp, 'not_tracked');
          assert.equal(result.launchEnabled, false);
          await admin.query(
            "UPDATE whatsapp_receipts SET occurred_at=$1 WHERE status='delivered'",
            [`${yesterday}T11:59:59Z`],
          );
          const anomaly = await review.run(yesterday, '0');
          assert.equal(anomaly.delivery.timingAnomalies, 1);
          assert.equal(anomaly.delivery.onTime, 0);
          assert.ok(!JSON.stringify(result).includes(uid));
          assert.ok(!JSON.stringify(result).includes('synthetic-provider'));
          await assert.rejects(review.run('2099-01-01', '0'), /future/);
          const empty = await review.run('2020-01-01', '0');
          assert.ok(empty.attention.includes('no_delivery_sample'));
          assert.equal(empty.delivery.onTimeEvidence.denominator, 0);
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
