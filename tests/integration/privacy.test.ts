import { PrivacyAdmin } from '../../src/modules/privacy/admin.js';
import { DeliveryRecovery } from '../../src/modules/whatsapp/recovery.js';
import { applyPrivacyCommand } from '../../src/modules/privacy/commands.js';
import { ReminderScheduler } from '../../src/modules/reminders/scheduler.js';
import { ReminderSender } from '../../src/modules/delivery/reminder-sender.js';
import { TestReplySender } from '../../src/modules/whatsapp/dispatch.js';
import { UsageService } from '../../src/modules/usage/service.js';
import { UsageControl } from '../../src/modules/usage/control.js';
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
test('account privacy under restricted runtime logins', { timeout: 60000 }, async (t) => {
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
      return (await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [key])).rows[0]
        .id as string;
    };
    const plan = async (value: unknown = mixed(), sender = 'alice', persist = true) => {
      const at = new Date(Date.now() - 10000);
      const eventId = await send(sender, 'synthetic instruction');
      await admin.query(
        `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('12345',$1,$2,$3,false,'America/Toronto',$3) ON CONFLICT DO NOTHING`,
        [sender, CONSENT_VERSION, at],
      );
      const user = (await admin.query('SELECT * FROM users WHERE sender_id=$1', [sender])).rows[0];
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
      const action = (await worker.query('SELECT * FROM list_actions WHERE event_id=$1', [eventId]))
        .rows[0];
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
    await t.test(
      'export includes only the owner across lists, messages, preferences and receipts; tokens are omitted',
      async () => {
        await reset();
        const a = await add('Grocery', 'alice private'),
          b = await add('Secret', 'bob private', 'bob');
        await run('QUIET 22:00-08:00');
        for (const recipient of ['alice', 'bob']) {
          const key = randomUUID();
          await store.persist([
            {
              eventKey: key,
              kind: 'delivery.status',
              phoneNumberId: '12345',
              providerMessageId: key,
              senderId: null,
              payload: {
                id: key,
                recipient_id: recipient,
                status: 'delivered',
                timestamp: String(Math.floor(Date.now() / 1000)),
              },
            },
          ]);
          await admin.query(
            `INSERT INTO work_recovery_events(work_id,action,actor)
            SELECT q.id,'operator_retry',$2 FROM work_outbox q JOIN ingress_events e ON e.id=q.event_id WHERE e.event_key=$1`,
            [key, `${recipient} recovery`],
          );
          await admin.query(
            `INSERT INTO whatsapp_receipts(event_id,phone_number_id,provider_message_id,recipient_id,status,occurred_at)
            SELECT id,phone_number_id,provider_message_id,$2,'delivered',clock_timestamp() FROM ingress_events WHERE event_key=$1`,
            [key, recipient],
          );
        }
        const r = await request('export');
        const output = (await privacy.exportRequest(r.id)) as {
          format: string;
          data: Record<string, any[]>;
        };
        assert.equal(output.format, 'memorae-export-v1');
        assert.equal(output.data.users![0].id, a.userId);
        assert.equal(output.data.list_items![0].text, 'alice private');
        assert.ok(output.data.delivery_preferences!.length);
        assert.deepEqual(
          output.data.whatsapp_receipts!.map((row) => row.recipient_id),
          ['alice'],
        );
        assert.deepEqual(
          output.data.work_recovery_events!.map((row) => row.actor),
          ['alice recovery'],
        );
        const serialized = JSON.stringify(output);
        assert.doesNotMatch(serialized, /bob private|consent_token|lease_token|timezone_token/);
        assert.ok(!serialized.includes(b.userId));
        assert.equal(
          await withTenant(
            tenant,
            b.userId,
            async (c) => (await c.query('SELECT * FROM privacy_requests')).rowCount,
          ),
          0,
        );
        await assert.rejects(new PrivacyAdmin(worker).exportRequest(r.id), /administrator/);
        await assert.rejects(new PrivacyAdmin(tenant).exportRequest(r.id));
        await privacy.markExported(r.id);
        await assert.rejects(privacy.exportRequest(r.id), /unavailable/);
      },
    );
    await t.test(
      'deletion requires an unexpired owner confirmation and replay creates no second request',
      async () => {
        await reset();
        const a = await add();
        await add('Other', 'bread', 'bob');
        const r = await request('delete');
        await run('DELETE ACCOUNT');
        assert.equal(
          (
            await worker.query(
              "SELECT * FROM privacy_requests WHERE user_id=$1 AND kind='delete'",
              [a.userId],
            )
          ).rowCount,
          1,
        );
        assert.match(
          (await run(`CONFIRM DELETE ${r.reference}`, 'bob')).identity.reply_text,
          /unavailable/,
        );
        assert.equal(
          (await worker.query('SELECT deletion_requested_at FROM users WHERE id=$1', [a.userId]))
            .rows[0].deletion_requested_at,
          null,
        );
        await admin.query(
          "UPDATE privacy_requests SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [r.id],
        );
        assert.match((await run(`CONFIRM DELETE ${r.reference}`)).identity.reply_text, /expired/);
        await assert.rejects(privacy.purge(a.userId), /Confirmed/);
      },
    );
    await t.test(
      'confirmation cancels reminders, replies, occurrences, choices and pending work; a stale lease cannot execute',
      async () => {
        await reset();
        const a = await plan();
        await runner.runOne('execution', executor);
        await run('LIST "Grocery"');
        await run('EDIT ITEM "Grocery" #1 TO "other"');
        await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 minute'");
        await new ReminderScheduler(worker).sweep();
        const pending = await plan();
        const lease = (await queue.claim('execution', 'stale'))!;
        await confirm();
        assert.equal(
          (await worker.query('SELECT status FROM reminders')).rows[0].status,
          'cancelled',
        );
        for (const table of ['reply_intents', 'outbound_messages', 'reminder_occurrences'])
          assert.equal(
            (await worker.query(`SELECT * FROM ${table} WHERE status='pending'`)).rowCount,
            0,
          );
        assert.equal(
          (await worker.query("SELECT * FROM list_choices WHERE status='pending'")).rowCount,
          0,
        );
        assert.ok(await queue.cancelDeleted());
        await assert.rejects(
          queue.commit(lease, (c) => executor.apply(c, lease)),
          /lease/i,
        );
        assert.equal(await queue.claim('execution', 'new'), null);
        assert.equal(
          (await worker.query('SELECT * FROM plan_executions WHERE event_id=$1', [pending.eventId]))
            .rowCount,
          0,
        );
        assert.equal((await privacy.purge(a.userId)).status, 'purged');
      },
    );
    await t.test(
      'physical erase removes all owned relational data and ingress while preserving another account',
      async () => {
        await reset();
        const a = await add('Grocery', 'private-A'),
          b = await add('Other', 'private-B', 'bob');
        await run('DIGEST AT 09:00');
        await run('LISTS');
        await request('export');
        await confirm();
        assert.equal((await privacy.purge(a.userId)).status, 'purged');
        const tables = (
          await admin.query(
            `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attname='user_id' AND NOT a.attisdropped WHERE n.nspname=current_schema() AND c.relkind='r'`,
          )
        ).rows;
        for (const { relname } of tables)
          assert.equal(
            (await admin.query(`SELECT * FROM ${relname} WHERE user_id=$1`, [a.userId])).rowCount,
            0,
            relname,
          );
        assert.equal(
          (await worker.query("SELECT * FROM ingress_events WHERE sender_id='alice'")).rowCount,
          0,
        );
        assert.equal(
          (await worker.query('SELECT text FROM list_items WHERE user_id=$1', [b.userId])).rows[0]
            .text,
          'private-B',
        );
        assert.equal((await privacy.purge(a.userId)).status, 'absent');
        const tomb = (await admin.query('SELECT * FROM privacy_tombstones')).rows[0];
        assert.equal(tomb.fingerprint.length, 64);
        assert.ok(!JSON.stringify(tomb).includes('alice'));
      },
    );
    await t.test(
      'tombstones reject replay, fresh messages and late receipts without recreating an identity',
      async () => {
        await reset();
        const a = await add();
        const event = (await worker.query('SELECT * FROM ingress_events WHERE id=$1', [a.eventId]))
          .rows[0];
        await confirm();
        await privacy.purge(a.userId);
        const result = await store.persist([
          {
            eventKey: event.event_key,
            kind: 'inbound.message',
            phoneNumberId: '12345',
            providerMessageId: event.provider_message_id,
            senderId: 'alice',
            payload: event.payload,
          },
          {
            eventKey: randomUUID(),
            kind: 'delivery.status',
            phoneNumberId: '12345',
            providerMessageId: 'late',
            senderId: null,
            payload: {
              id: 'late',
              recipient_id: 'alice',
              status: 'delivered',
              timestamp: String(Math.floor(Date.now() / 1000)),
            },
          },
        ]);
        assert.equal(result.inserted, 0);
        assert.equal((await worker.query('SELECT * FROM users')).rowCount, 0);
        assert.equal((await worker.query('SELECT * FROM ingress_events')).rowCount, 0);
        await assert.rejects(worker.query('SELECT * FROM privacy_key'), /permission denied/);
        await assert.rejects(
          ingress.query('SELECT * FROM privacy_tombstones'),
          /permission denied/,
        );
      },
    );
    await t.test('confirmation and erasure roll back atomically on failures', async () => {
      await reset();
      const a = await add();
      const r = await request('delete');
      const eventId = await send('alice', 'confirm');
      const c = await worker.connect();
      try {
        await c.query('BEGIN');
        await applyPrivacyCommand(c, eventId, a.userId, {
          action: 'confirm',
          reference: r.reference,
        });
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      assert.equal(
        (await worker.query('SELECT deletion_requested_at FROM users WHERE id=$1', [a.userId]))
          .rows[0].deletion_requested_at,
        null,
      );
      // Finish the queued synthetic event, then confirm normally.
      await new IdentityProcessor(worker).processNext();
      await run(`CONFIRM DELETE ${r.reference}`);
      await admin.query(
        `CREATE FUNCTION fail_erase() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic erase failure'; END$$; CREATE TRIGGER fail_erase BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fail_erase()`,
      );
      await assert.rejects(privacy.purge(a.userId), /synthetic erase/);
      assert.equal((await admin.query('SELECT * FROM privacy_tombstones')).rowCount, 0);
      assert.equal(
        (await worker.query('SELECT * FROM list_items WHERE user_id=$1', [a.userId])).rowCount,
        1,
      );
      await admin.query('DROP TRIGGER fail_erase ON users; DROP FUNCTION fail_erase()');
      assert.equal((await privacy.purge(a.userId)).status, 'purged');
    });
    await t.test(
      'privacy commands remain available without onboarding and under exhausted request quotas',
      async () => {
        await reset();
        await admin.query('UPDATE quota_policy SET requests_minute=0');
        const malformed = await run('EXPORT arbitrary text', 'new-user');
        assert.equal(malformed.identity.disposition, 'blocked');
        assert.equal((await worker.query('SELECT * FROM privacy_requests')).rowCount, 0);
        const offer = await run('DELETE ACCOUNT', 'new-user');
        assert.match(offer.identity.reply_text, /Nothing has been deleted/);
        const r = (await worker.query('SELECT * FROM privacy_requests')).rows[0];
        await run(`CONFIRM DELETE ${r.reference}`, 'new-user');
        assert.equal((await privacy.purge(r.user_id)).status, 'purged');
        await admin.query('UPDATE quota_policy SET requests_minute=60');
      },
    );
    const activate = async () => {
      const ctl = new UsageControl(admin);
      await ctl.limits('1000000', '1000000', 'test');
      await ctl.rate(
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
      await ctl.switch(true, 'test');
    };
    await t.test(
      'reserved/unknown model usage holds deletion until recovery or reconciliation; totals stay truthful',
      async () => {
        for (const dispatched of [false, true]) {
          await reset();
          await activate();
          const a = await plan({ behavior: 'noop', calls: [] }, 'alice', false);
          const lease = (await queue.claim('action', 'model'))!;
          const usage = new UsageService(worker);
          const reservation = await usage.reserve(lease, a.userId, 'fake', 'test-v1');
          if (dispatched) {
            await usage.dispatch(reservation.id, lease);
            await usage.unknown(reservation.id);
          }
          await confirm();
          assert.equal((await privacy.purge(a.userId)).status, 'held');
          await admin.query(
            "UPDATE ingress_events SET received_at=clock_timestamp()-interval '40 days'",
          );
          await privacy.retain(100, true);
          assert.equal(
            (await worker.query('SELECT redacted_at FROM ingress_events WHERE id=$1', [a.eventId]))
              .rows[0].redacted_at,
            null,
          );
          if (dispatched)
            await new UsageService(admin).reconcile(
              reservation.id,
              12,
              18,
              'synthetic provider evidence',
            );
          else await usage.recover();
          assert.equal((await privacy.purge(a.userId)).status, 'purged');
          const totals = (await admin.query('SELECT * FROM usage_global_periods')).rows[0];
          assert.equal(totals.reserved_micros, '0');
          assert.equal(totals.spent_micros, dispatched ? '30' : '0');
        }
      },
    );
    await t.test(
      'a send authorized before confirmation can finish; physical erase waits and prevents all new sends',
      async () => {
        await reset();
        await activate();
        const a = await plan({ behavior: 'execute', calls: [reminderCall()] }, '11111');
        await runner.runOne('execution', executor);
        await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 minute'");
        await new ReminderScheduler(worker).sweep();
        await admin.query("UPDATE users SET window_expires_at=clock_timestamp()+interval '1 hour'");
        let started!: () => void, finish!: () => void;
        const began = new Promise<void>((r) => (started = r)),
          end = new Promise<void>((r) => (finish = r));
        let calls = 0;
        const transport = {
          async send() {
            calls++;
            started();
            await end;
            return { state: 'accepted' as const, providerMessageId: 'wamid.finished' };
          },
        };
        const policy = {
          enabled: true,
          phoneNumberId: '12345',
          recipients: ['11111'],
          timeoutMs: 10000,
        };
        const outbound = (await worker.query('SELECT id FROM outbound_messages')).rows[0].id;
        const pending = new ReminderSender(worker, transport, policy).send(outbound);
        await began;
        try {
          await confirm('11111');
          assert.equal((await privacy.purge(a.userId)).status, 'held');
        } finally {
          finish();
        }
        assert.equal((await pending).state, 'accepted');
        assert.equal(calls, 1);
        const reply = (
          await worker.query(
            'SELECT event_id FROM privacy_actions ORDER BY created_at DESC LIMIT 1',
          )
        ).rows[0];
        assert.equal(
          (await new TestReplySender(worker, transport, policy).send(reply.event_id)).state,
          'suppressed',
        );
        assert.equal(calls, 1);
        assert.equal((await privacy.purge(a.userId)).status, 'purged');
      },
    );
    await t.test(
      'unknown sends require explicit reconciliation; no timeout automatically erases their evidence',
      async () => {
        await reset();
        await activate();
        const a = await plan({ behavior: 'execute', calls: [reminderCall()] }, '11111');
        await runner.runOne('execution', executor);
        await admin.query("UPDATE reminders SET due_at=clock_timestamp()-interval '1 minute'");
        await new ReminderScheduler(worker).sweep();
        await admin.query("UPDATE users SET window_expires_at=clock_timestamp()+interval '1 hour'");
        const outbound = (await worker.query('SELECT id FROM outbound_messages')).rows[0].id;
        const sent = await new ReminderSender(
          worker,
          {
            async send() {
              return { state: 'unknown' as const, code: 'timeout' };
            },
          },
          { enabled: true, phoneNumberId: '12345', recipients: ['11111'], timeoutMs: 1000 },
        ).send(outbound);
        await confirm('11111');
        assert.equal((await privacy.purge(a.userId)).status, 'held');
        await admin.query(
          "UPDATE whatsapp_attempts SET dispatch_deadline=clock_timestamp()-interval '1 day' WHERE id=$1",
          [sent.id],
        );
        assert.equal((await privacy.purge(a.userId)).status, 'held');
        await new DeliveryRecovery(admin).reconcile(sent.id, {
          action: 'abandon',
          note: 'Synthetic provider uncertainty accepted by operator',
        });
        assert.equal((await privacy.purge(a.userId)).status, 'purged');
      },
    );
    await t.test(
      'erase follows recurrence and delivery-choice cycles without deleting another owner',
      async () => {
        await reset();
        const a = await plan({
          behavior: 'execute',
          calls: [reminderCall(new Date(Date.now() + 86400000 * 2).toISOString())],
        });
        await runner.runOne('execution', executor);
        let ref = (await worker.query('SELECT reference FROM reminder_controls')).rows[0].reference;
        await run(
          `REPEAT ${ref} DAILY UNTIL ${new Date(Date.now() + 86400000 * 5).toISOString().slice(0, 10)}`,
        );
        const series = (await worker.query('SELECT * FROM reminder_series')).rows[0];
        await run(`CONFIRM REPEAT ${series.reference}`);
        ref = (
          await worker.query(
            'SELECT c.reference FROM reminder_controls c JOIN reminders r ON r.id=c.reminder_id AND r.schedule_version=c.schedule_version ORDER BY r.due_at LIMIT 1',
          )
        ).rows[0].reference;
        await run('DIGEST AT 09:00');
        await run(`DELIVER ${ref} DIGEST`);
        const choice = (await worker.query('SELECT * FROM delivery_choices')).rows[0];
        await run(`CONFIRM DELIVERY ${choice.reference}`);
        await confirm();
        assert.equal((await privacy.purge(a.userId)).status, 'purged');
        for (const table of [
          'reminders',
          'reminder_series',
          'delivery_choices',
          'reminder_controls',
        ])
          assert.equal((await worker.query(`SELECT * FROM ${table}`)).rowCount, 0);
      },
    );
    await t.test(
      'a concurrent inbound replay waits for erasure and cannot resurrect the deleted account',
      async () => {
        await reset();
        const a = await add();
        await confirm();
        await admin.query(
          `CREATE FUNCTION slow_privacy_erase() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(0.5); RETURN OLD; END$$; CREATE TRIGGER slow_privacy_erase BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION slow_privacy_erase()`,
        );
        const purge = privacy.purge(a.userId);
        try {
          let sleeping = false;
          for (let i = 0; i < 100; i++) {
            sleeping = !!(
              await admin.query(
                "SELECT 1 FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE 'DELETE FROM users%'",
              )
            ).rowCount;
            if (sleeping) break;
            await setTimeout(10);
          }
          assert.equal(sleeping, true);
          const key = randomUUID();
          const incoming = store.persist([
            {
              eventKey: key,
              kind: 'inbound.message',
              phoneNumberId: '12345',
              providerMessageId: key,
              senderId: 'alice',
              payload: {
                type: 'text',
                text: { body: 'START' },
                timestamp: String(Math.floor(Date.now() / 1000)),
              },
            },
          ]);
          assert.equal((await purge).status, 'purged');
          assert.equal((await incoming).inserted, 0);
        } finally {
          await purge.catch(() => {});
          await admin.query(
            'DROP TRIGGER slow_privacy_erase ON users; DROP FUNCTION slow_privacy_erase()',
          );
        }
        assert.equal((await worker.query('SELECT * FROM users')).rowCount, 0);
      },
    );
    await t.test(
      'retention preview is reversible; apply is bounded, idempotent and keeps unfinished raw work',
      async () => {
        await reset();
        const a = await add();
        const pending = await plan({ behavior: 'noop', calls: [] }, 'alice', false);
        await admin.query(
          "UPDATE ingress_events SET received_at=clock_timestamp()-interval '40 days'",
        );
        await admin.query(
          "INSERT INTO quota_counters(user_id,metric,period,used) VALUES($1,'requests_day',clock_timestamp()-interval '100 days',4)",
          [a.userId],
        );
        assert.equal((await privacy.retain(1)).rawRedacted, 1);
        assert.equal(
          (await worker.query('SELECT * FROM ingress_events WHERE redacted_at IS NOT NULL'))
            .rowCount,
          0,
        );
        const applied = await privacy.retain(1, true);
        assert.equal(applied.rawRedacted, 1);
        assert.equal(applied.userCountersDeleted, 1);
        const old = (await worker.query('SELECT * FROM ingress_events WHERE id=$1', [a.eventId]))
          .rows[0];
        assert.equal(old.payload.redacted, true);
        assert.equal(
          (await worker.query('SELECT * FROM ingress_events WHERE id=$1', [pending.eventId]))
            .rows[0].redacted_at,
          null,
        );
        assert.equal((await privacy.retain(1, true)).rawRedacted, 0);
        assert.equal((await worker.query('SELECT text FROM list_items')).rows[0].text, 'milk');
        assert.equal(
          (await worker.query('SELECT * FROM quota_counters WHERE user_id=$1', [a.userId]))
            .rowCount,
          0,
        );
      },
    );
    await t.test(
      'privacy mutation/export/purge rights are restricted and cross-owner receipts fail',
      async () => {
        await reset();
        const a = await add(),
          b = await add('Other', 'bread', 'bob');
        await request('export');
        await assert.rejects(new PrivacyAdmin(worker).purge(a.userId), /administrator/);
        await assert.rejects(new PrivacyAdmin(worker).retain(100, true), /administrator/);
        await assert.rejects(
          worker.query('DELETE FROM users WHERE id=$1', [a.userId]),
          /permission denied/,
        );
        await assert.rejects(
          tenant.query("UPDATE privacy_requests SET status='requested'"),
          /permission denied/,
        );
        await assert.rejects(
          worker.query(
            "INSERT INTO privacy_actions(event_id,user_id,reply_text) VALUES($1,$2,'forged')",
            [b.eventId, a.userId],
          ),
          /owner mismatch/,
        );
        for (const table of ['privacy_requests', 'privacy_actions']) {
          const flags = (
            await admin.query(
              'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
              [table],
            )
          ).rows[0];
          assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
          assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
        }
        await assert.rejects(worker.query('SELECT * FROM privacy_key'), /permission denied/);
      },
    );
  } finally {
    await Promise.all(pools.map((p) => p.end()));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});
