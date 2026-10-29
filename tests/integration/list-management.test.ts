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
test('list management under restricted runtime logins', { timeout: 60000 }, async (t) => {
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
      return (await admin.query('SELECT id FROM ingress_events WHERE event_key=$1', [key])).rows[0]
        .id as string;
    };
    const plan = async (value: unknown = mixed(), sender = 'alice', persist = true) => {
      const at = new Date(Date.now() - 10000);
      const eventId = await send(sender, 'synthetic instruction');
      await admin.query(
        `INSERT INTO users(business_phone_id,sender_id,consent_version,consent_at,paused,timezone,timezone_confirmed_at)
        VALUES('business',$1,$2,$3,false,'America/Toronto',$3) ON CONFLICT DO NOTHING`,
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
      assert.notEqual(result?.disposition, 'ready');
      assert.equal(
        (await worker.query('SELECT 1 FROM action_plans WHERE event_id=$1', [eventId])).rowCount,
        0,
      );
      const action = (await worker.query('SELECT * FROM list_actions WHERE event_id=$1', [eventId]))
        .rows[0];
      return { eventId, action };
    };
    const pending = async () =>
      (
        await worker.query(
          "SELECT * FROM list_choices WHERE status='pending' ORDER BY created_at DESC LIMIT 1",
        )
      ).rows[0];
    const choose = async (option = 1, who = 'alice', reference?: string) =>
      run(`CHOOSE LIST ${reference ?? (await pending()).reference} ${option}`, who);
    const item = async (id: string) =>
      (await worker.query('SELECT * FROM list_items WHERE id=$1', [id])).rows[0];

    await t.test(
      'list and item reads include stable numbers, status and bounded keyset pages',
      async () => {
        await reset();
        const a = await add();
        await worker.query(
          `INSERT INTO list_items(user_id,list_id,source_event_id,plan_version,action_key,text,position)
          SELECT $1,$2,$3,1,repeat(md5('page-'||g),2),'item '||g,g+1 FROM generate_series(1,14) g`,
          [a.userId, a.list_id, a.eventId],
        );
        const first = (await run('LIST "  ＧＲＯＣＥＲＹ  "')).action;
        assert.equal(first.outcome, 'read');
        assert.match(first.reply_text, /#1 \[open\] milk/);
        assert.match(first.reply_text, /AFTER 10/);
        assert.doesNotMatch(first.reply_text, /#11 /);
        const second = (await run('LIST "Grocery" AFTER 10')).action;
        assert.match(second.reply_text, /#11 /);
        assert.match(second.reply_text, /#15 /);
        assert.doesNotMatch(second.reply_text, /More:/);
        const reference = (await worker.query('SELECT reference FROM lists')).rows[0].reference;
        assert.match((await run(`ITEM @${reference} #1`)).action.reply_text, /milk/);
        assert.match((await run('LIST "Grocery" AFTER 15')).action.reply_text, /No more items/);
        assert.equal(
          (await worker.query('SELECT revision FROM list_items WHERE id=$1', [a.item_id])).rows[0]
            .revision,
          1,
        );
      },
    );
    await t.test('list catalog pages are complete and references are owner scoped', async () => {
      await reset();
      const a = await add();
      await worker.query(
        "INSERT INTO lists(user_id,name,name_key) SELECT $1,'List '||g,'list '||g FROM generate_series(1,22) g",
        [a.userId],
      );
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let page = 0; page < 3; page++) {
        const text = (await run(cursor ? `LISTS AFTER ${cursor}` : 'LISTS')).action
          .reply_text as string;
        const refs = [...text.matchAll(/LIST @([a-f0-9]{16})/g)].map((m) => m[1]!);
        for (const ref of refs) {
          assert.ok(!seen.has(ref));
          seen.add(ref);
        }
        cursor = /More: LISTS AFTER ([a-f0-9]{16})/.exec(text)?.[1];
      }
      assert.equal(seen.size, 23);
      assert.equal(cursor, undefined);
      await add('Private', 'secret', 'bob');
      const bob = (
        await worker.query(
          "SELECT l.reference FROM lists l JOIN users u ON u.id=l.user_id WHERE u.sender_id='bob'",
        )
      ).rows[0].reference;
      assert.equal((await run(`LISTS AFTER ${bob}`)).action.outcome, 'not_found');
      assert.equal(
        (await run(`LIST @${bob}`)).action.reply_text,
        (await run('LIST @0000000000000000')).action.reply_text,
      );
    });
    await t.test('ambiguous item matches clarify and only the chosen row is edited', async () => {
      await reset();
      const a = await add('Grocery', 'oat milk'),
        b = await add('Grocery', 'almond milk');
      const result = (await run('EDIT ITEM "Grocery" "milk" TO "soy milk"')).action;
      assert.equal(result.outcome, 'clarify');
      assert.match(result.reply_text, /#1 \[open\] oat milk/);
      assert.match(result.reply_text, /#2 \[open\] almond milk/);
      assert.equal((await item(a.item_id)).text, 'oat milk');
      assert.equal((await item(b.item_id)).text, 'almond milk');
      const confirm = (await choose(2)).action;
      assert.equal(confirm.outcome, 'edited');
      assert.equal((await item(a.item_id)).text, 'oat milk');
      assert.equal((await item(b.item_id)).text, 'soy milk');
      assert.equal((await item(b.item_id)).revision, 2);
      assert.deepEqual(confirm.result, {
        before: { text: 'almond milk', completed: false, revision: 1 },
        after: { text: 'soy milk', completed: false, revision: 2 },
      });
      assert.equal(
        (await worker.query('SELECT status FROM reply_intents WHERE event_id=$1', [b.eventId]))
          .rows[0].status,
        'suppressed',
      );
      assert.equal(
        (await worker.query('SELECT result FROM action_receipts WHERE event_id=$1', [b.eventId]))
          .rows[0].result.text,
        'almond milk',
      );
    });
    await t.test(
      'duplicate exact items stay separate; a unique exact match wins over fuzzy alternatives',
      async () => {
        await reset();
        const a = await add(),
          b = await add(),
          c = await add('Grocery', 'oat milk');
        await run('DONE ITEM "Grocery" "milk"');
        assert.equal((await worker.query('SELECT 1 FROM list_choice_options')).rowCount, 2);
        assert.equal((await choose(1)).action.outcome, 'completed');
        assert.equal((await item(a.item_id)).completed, true);
        assert.equal((await item(b.item_id)).completed, false);
        assert.equal((await item(c.item_id)).completed, false);
        await run('DONE ITEM "Grocery" "oat milk"');
        assert.equal((await choose()).action.outcome, 'completed');
      },
    );
    await t.test(
      'fuzzy list selection and item selection are separate explicit steps',
      async () => {
        await reset();
        const a = await add('Grocery', 'milk');
        await add('Groceries', 'milk');
        const first = (await run('DONE ITEM "Groc" "milk"')).action;
        assert.equal(first.outcome, 'clarify');
        assert.match(first.reply_text, /Which list/);
        assert.equal((await pending()).kind, 'lists');
        const selection = (await choose()).action;
        assert.equal(selection.outcome, 'clarify');
        assert.equal((await pending()).kind, 'items');
        assert.equal((await item(a.item_id)).completed, false);
        assert.equal((await choose()).action.outcome, 'completed');
        const typo = (await run('LIST "Grocry"')).action;
        assert.equal(typo.outcome, 'clarify');
        assert.equal((await choose()).action.outcome, 'read');
      },
    );
    await t.test(
      'no matches and too many candidates never guess or mutate; numeric selection resolves them',
      async () => {
        await reset();
        const a = await add();
        await worker.query(
          `INSERT INTO list_items(user_id,list_id,source_event_id,plan_version,action_key,text,position)
          SELECT $1,$2,$3,1,repeat(md5('dup-'||g),2),'milk',g+1 FROM generate_series(1,6) g`,
          [a.userId, a.list_id, a.eventId],
        );
        assert.match(
          (await run('DONE ITEM "Grocery" "milk"')).action.reply_text,
          /More than five matches/,
        );
        assert.equal(await pending(), undefined);
        assert.equal((await run('DONE ITEM "Grocery" "oranges"')).action.outcome, 'not_found');
        await run('DONE ITEM "Grocery" #4');
        assert.equal((await choose()).action.outcome, 'completed');
        assert.equal((await worker.query('SELECT 1 FROM list_items WHERE completed')).rowCount, 1);
        assert.equal((await run('EDIT ITEM "Grocery" #4')).action.outcome, 'invalid');
      },
    );
    await t.test(
      'append and edit invalidate older choices; stable item numbers never retarget',
      async () => {
        for (const change of ['append', 'edit']) {
          await reset();
          const a = await add();
          await run('EDIT ITEM "Grocery" #1 TO "old choice"');
          const old = await pending();
          if (change === 'append') await add('Grocery', 'bread');
          else
            await worker.query('UPDATE list_items SET text=$2 WHERE id=$1', [
              a.item_id,
              'new text',
            ]);
          assert.equal((await choose(1, 'alice', old.reference)).action.outcome, 'stale');
          assert.equal((await item(a.item_id)).text, change === 'append' ? 'milk' : 'new text');
          assert.equal((await item(a.item_id)).position, 1);
        }
      },
    );
    await t.test('expired, superseded and foreign choices cannot change an item', async () => {
      await reset();
      const a = await add();
      await add('Grocery', 'private', 'bob');
      await run('DONE ITEM "Grocery" #1');
      let old = await pending();
      const foreign = (await choose(1, 'bob', old.reference)).action;
      const absent = (await choose(1, 'bob', '0000000000000000')).action;
      assert.equal(foreign.reply_text, absent.reply_text);
      assert.equal(foreign.item_id, null);
      await admin.query(
        "UPDATE list_choices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [old.id],
      );
      assert.equal((await choose(1, 'alice', old.reference)).action.outcome, 'stale');
      await run('DONE ITEM "Grocery" #1');
      old = await pending();
      await run('EDIT ITEM "Grocery" #1 TO "new request"');
      assert.equal((await choose(1, 'alice', old.reference)).action.outcome, 'stale');
      assert.equal((await item(a.item_id)).completed, false);
      assert.equal((await choose()).action.outcome, 'edited');
    });
    await t.test(
      'same-event replay returns its receipt; competing selections apply once',
      async () => {
        await reset();
        const a = await add();
        await run('DONE ITEM "Grocery" #1');
        const choice = await pending();
        const events = [
          await send('alice', `CHOOSE LIST ${choice.reference} 1`),
          await send('alice', `CHOOSE LIST ${choice.reference} 1`),
        ];
        await Promise.all(
          events.map(async (eventId) => {
            const client = await worker.connect();
            try {
              await client.query('BEGIN');
              await applyListCommand(client, eventId, a.userId, {
                kind: 'choose',
                reference: choice.reference,
                option: 1,
              });
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK');
              throw error;
            } finally {
              client.release();
            }
          }),
        );
        const actions = (
          await worker.query('SELECT * FROM list_actions WHERE event_id=ANY($1::uuid[])', [events])
        ).rows;
        assert.deepEqual(actions.map((a) => a.outcome).sort(), ['completed', 'stale']);
        assert.equal((await item(a.item_id)).revision, 2);
        const applied = actions.find((a) => a.outcome === 'completed')!;
        const client = await worker.connect();
        try {
          await client.query('BEGIN');
          assert.equal(
            await applyListCommand(client, applied.event_id, a.userId, {
              kind: 'choose',
              reference: choice.reference,
              option: 1,
            }),
            applied.reply_text,
          );
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        assert.equal((await item(a.item_id)).revision, 2);
      },
    );
    await t.test(
      'completed-item edits preserve completion and repeated completion is a no-op',
      async () => {
        await reset();
        const a = await add();
        await run('DONE ITEM "Grocery" #1');
        await choose();
        await run('DONE ITEM "Grocery" #1');
        assert.equal((await choose()).action.outcome, 'noop');
        assert.equal((await item(a.item_id)).revision, 2);
        await run('EDIT ITEM "Grocery" #1 TO "oat milk"');
        const result = (await choose()).action;
        assert.match(result.reply_text, /remains marked done/);
        assert.equal((await item(a.item_id)).completed, true);
        await run('EDIT ITEM "Grocery" #1 TO "oat milk"');
        assert.equal((await choose()).action.outcome, 'noop');
        assert.equal((await item(a.item_id)).revision, 3);
      },
    );
    await t.test(
      'lease expiry and transaction errors roll back item, revision, choice and audit together',
      async () => {
        for (const expiry of [false, true]) {
          await reset();
          const a = await add();
          await run('EDIT ITEM "Grocery" #1 TO "changed"');
          const choice = await pending();
          const eventId = await send('alice', `CHOOSE LIST ${choice.reference} 1`);
          const lease = await queue.claim('onboarding', 'list-rollback', expiry ? 1000 : 30000);
          assert.ok(lease);
          const revision = (
            await worker.query('SELECT revision FROM lists WHERE id=$1', [a.list_id])
          ).rows[0].revision;
          await assert.rejects(
            queue.commit(lease, async (client) => {
              const result = await new IdentityProcessor(worker).apply(client, eventId);
              if (!expiry) throw new Error('injected rollback');
              await client.query('SELECT pg_sleep(1.1)');
              return result;
            }),
          );
          assert.equal((await item(a.item_id)).text, 'milk');
          assert.equal((await item(a.item_id)).revision, 1);
          assert.equal(
            (await worker.query('SELECT revision FROM lists WHERE id=$1', [a.list_id])).rows[0]
              .revision,
            revision,
          );
          assert.equal(
            (await worker.query('SELECT status FROM list_choices WHERE id=$1', [choice.id])).rows[0]
              .status,
            'pending',
          );
          assert.equal(
            (await worker.query('SELECT 1 FROM list_actions WHERE event_id=$1', [eventId]))
              .rowCount,
            0,
          );
        }
      },
    );
    await t.test(
      'STOP and timezone changes invalidate choices and do not mutate list contents',
      async () => {
        for (const control of ['STOP', 'TIMEZONE Europe/Paris']) {
          await reset();
          const a = await add();
          await run('DONE ITEM "Grocery" #1');
          const choice = await pending();
          await run(control);
          const result = await choose(1, 'alice', choice.reference);
          assert.equal(result.action, undefined);
          assert.equal(
            (await worker.query('SELECT status FROM list_choices WHERE id=$1', [choice.id])).rows[0]
              .status,
            'invalidated',
          );
          assert.equal((await item(a.item_id)).completed, false);
        }
      },
    );
    await t.test(
      'bounded search refuses partial matches beyond the cap; full item reads preserve long text',
      async () => {
        await reset();
        const long = '😀'.repeat(450) + ' tail';
        const a = await add('Grocery', long);
        const reply = (await run('LIST "Grocery"')).action.reply_text;
        assert.ok(reply.length < 4096);
        assert.ok(reply.includes('…'));
        assert.ok(!reply.includes('\uFFFD'));
        assert.ok((await run('ITEM "Grocery" #1')).action.reply_text.endsWith(long));
        await worker.query(
          `INSERT INTO list_items(user_id,list_id,source_event_id,plan_version,action_key,text,position)
          SELECT $1,$2,$3,1,repeat(md5('large-'||g),2),'milk',g+1 FROM generate_series(1,1000) g`,
          [a.userId, a.list_id, a.eventId],
        );
        assert.match((await run('DONE ITEM "Grocery" "milk"')).action.reply_text, /too large/);
        assert.equal(await pending(), undefined);
        await run('DONE ITEM "Grocery" #1001');
        assert.equal((await choose()).action.outcome, 'completed');
      },
    );
    await t.test(
      'a waiting confirmation rechecks expiry and revision after an append holds the list lock',
      async () => {
        for (const scenario of ['append', 'expiry']) {
          await reset();
          const a = await add();
          await run('DONE ITEM "Grocery" #1');
          const choice = await pending();
          const eventId = await send('alice', `CHOOSE LIST ${choice.reference} 1`);
          if (scenario === 'expiry')
            await admin.query(
              "UPDATE list_choices SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1",
              [choice.id],
            );
          const lock = await worker.connect(),
            confirm = await worker.connect();
          let applying: Promise<{ reply?: string; error?: unknown }> | undefined;
          try {
            await lock.query('BEGIN');
            await lock.query('SELECT id FROM lists WHERE id=$1 FOR UPDATE', [a.list_id]);
            const pid = (await confirm.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            await confirm.query('BEGIN');
            const command = listCommand(`CHOOSE LIST ${choice.reference} 1`)!;
            applying = applyListCommand(confirm, eventId, a.userId, command).then(
              (reply) => ({ reply }),
              (error) => ({ error }),
            );
            let waiting = false;
            for (let i = 0; i < 150; i++) {
              if (
                (
                  await admin.query(
                    "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
                    [pid],
                  )
                ).rowCount
              ) {
                waiting = true;
                break;
              }
              await setTimeout(10);
            }
            assert.ok(waiting, 'confirmation should wait on list row');
            if (scenario === 'append')
              await addListItem(
                lock,
                {
                  userId: a.userId,
                  eventId: a.eventId,
                  version: 1,
                  key: randomBytes(32).toString('hex'),
                },
                { list_name: 'Grocery', text: 'bread' },
              );
            else
              await admin.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM(expires_at-clock_timestamp())))+0.05) FROM list_choices WHERE id=$1',
                [choice.id],
              );
            await lock.query('COMMIT');
            const result = await applying;
            assert.equal(result.error, undefined);
            await confirm.query('COMMIT');
            assert.match(result.reply!, /out of date/);
            assert.equal((await item(a.item_id)).completed, false);
            if (scenario === 'append')
              assert.equal(
                (await worker.query('SELECT text FROM list_items WHERE position=2')).rows[0].text,
                'bread',
              );
          } finally {
            await lock.query('ROLLBACK');
            lock.release();
            await applying;
            await confirm.query('ROLLBACK');
            confirm.release();
          }
        }
      },
    );
    await t.test('list mutations cannot overtake earlier queued model/execution work', async () => {
      await reset();
      const a = await add();
      await run('DONE ITEM "Grocery" #1');
      const old = await pending();
      await plan({ behavior: 'execute', calls: [listCall('Grocery', 'bread')] });
      assert.match((await run('LIST "Grocery"')).action.reply_text, /saved items only/);
      assert.equal((await choose(1, 'alice', old.reference)).action.outcome, 'blocked');
      assert.equal((await run('EDIT ITEM "Grocery" #1 TO "oat milk"')).action.outcome, 'blocked');
      assert.equal((await item(a.item_id)).completed, false);
      assert.equal(await runner.runOne('execution', executor), true);
      assert.equal((await choose(1, 'alice', old.reference)).action.outcome, 'stale');
      await run('DONE ITEM "Grocery" #1');
      assert.equal((await choose()).action.outcome, 'completed');
      assert.equal(
        (await worker.query('SELECT text FROM list_items WHERE position=2')).rows[0].text,
        'bread',
      );
    });
    await t.test(
      'new audit/choice tables enforce forced RLS, ownership and narrow runtime grants',
      async () => {
        await reset();
        const a = await add(),
          b = await add('Private', 'secret', 'bob');
        await run('DONE ITEM "Grocery" #1');
        const ac = await pending();
        await run('DONE ITEM "Private" #1', 'bob');
        for (const table of ['list_actions', 'list_choices', 'list_choice_options']) {
          assert.equal((await tenant.query(`SELECT * FROM ${table}`)).rowCount, 0);
          await withTenant(tenant, a.userId, async (client) => {
            const rows = (await client.query(`SELECT user_id FROM ${table}`)).rows;
            assert.ok(rows.length);
            assert.ok(rows.every((r) => r.user_id === a.userId));
          });
          await assert.rejects(ingress.query(`SELECT * FROM ${table}`), /permission denied/);
          await assert.rejects(worker.query(`DELETE FROM ${table}`), /permission denied/);
          const flags = (
            await admin.query(
              'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',
              [`${schema}.${table}`],
            )
          ).rows[0];
          assert.ok(flags.relrowsecurity && flags.relforcerowsecurity);
        }
        await assert.rejects(
          worker.query("UPDATE list_actions SET reply_text='forged'"),
          /permission denied/,
        );
        await assert.rejects(
          worker.query("UPDATE list_choices SET request='{}'"),
          /permission denied/,
        );
        await assert.rejects(
          worker.query('UPDATE list_items SET position=999'),
          /permission denied/,
        );
        await assert.rejects(
          tenant.query("UPDATE list_items SET text='forged'"),
          /permission denied/,
        );
        await assert.rejects(
          worker.query(
            `INSERT INTO list_choice_options(user_id,choice_id,ordinal,list_id,list_revision,item_id,item_revision) VALUES($1,$2,5,$3,1,$4,1)`,
            [a.userId, ac.id, a.list_id, b.item_id],
          ),
          /foreign key/,
        );
        await assert.rejects(
          worker.query(
            `INSERT INTO list_actions(event_id,user_id,outcome,reply_text) VALUES($1,$2,'read','forged')`,
            [a.eventId, b.userId],
          ),
          /owner mismatch/,
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
