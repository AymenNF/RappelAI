import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { migrateTestSchema } from '../helpers/database.js';
import pg from 'pg';
import { withTenant } from '../../src/db/tenant.js';
import { assertRuntimeRole } from '../../src/db/runtime.js';
import { TenantProfiles } from '../../src/modules/identity/profile.js';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');

test('real non-owner logins enforce tenant RLS, grants, FKs and pool cleanup', async (t) => {
  const suffix = randomUUID().replaceAll('-', '');
  const schema = `test_${suffix}`;
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  const pools: pg.Pool[] = [];
  const roles: string[] = [];
  const makeLogin = async (capability: string) => {
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
      max: 1,
      options: `-c search_path=${schema},public`,
    });
    pools.push(pool);
    return pool;
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrateTestSchema(admin);
    const ingress = await makeLogin('ingress');
    const worker = await makeLogin('worker');
    const tenant = await makeLogin('tenant');
    await assertRuntimeRole(ingress, 'ingress');
    await assertRuntimeRole(worker, 'worker');
    await assertRuntimeRole(tenant, 'tenant');
    await assert.rejects(assertRuntimeRole(admin, 'tenant'));
    await assert.rejects(withTenant(worker, randomUUID(), async () => null));
    const ingestion = new PostgresIngressStore(ingress);
    const processor = new IdentityProcessor(worker);
    const event = async (sender: string, body = 'hello') => {
      const key = randomUUID();
      await ingestion.persist([
        {
          eventKey: key,
          kind: 'inbound.message',
          phoneNumberId: 'test-business',
          providerMessageId: key,
          senderId: sender,
          payload: {
            type: 'text',
            timestamp: String(Math.floor(Date.now() / 1000)),
            text: { body },
          },
        },
      ]);
      await processor.processNext();
      return (
        await worker.query(
          `SELECT r.user_id,r.event_id FROM identity_results r JOIN ingress_events e ON e.id=r.event_id WHERE e.event_key=$1`,
          [key],
        )
      ).rows[0];
    };
    const alice = await event('alice');
    const bob = await event('bob');
    for (const sender of ['alice', 'bob']) {
      const token = (
        await worker.query('SELECT consent_token FROM users WHERE sender_id=$1', [sender])
      ).rows[0].consent_token;
      await event(sender, `CONSENT ${token}`);
    }
    const profiles = new TenantProfiles(tenant);

    await t.test('forced RLS is enabled and missing context is default-deny', async () => {
      const flags = await admin.query(
        `SELECT relrowsecurity,relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname IN ('users','identity_results','consent_events','user_preferences')`,
        [schema],
      );
      assert.equal(flags.rowCount, 4);
      assert.ok(flags.rows.every((r) => r.relrowsecurity && r.relforcerowsecurity));
      assert.equal((await tenant.query('SELECT * FROM users')).rowCount, 0);
      await assert.rejects(
        tenant.query('INSERT INTO user_preferences(user_id) VALUES($1)', [alice.user_id]),
        { code: '42501' },
      );
    });
    await t.test(
      'reads, inserts, updates and deletes stay within the authenticated tenant',
      async () => {
        await profiles.setReplyLanguage(alice.user_id, 'fr');
        await profiles.setReplyLanguage(bob.user_id, 'es');
        assert.equal((await profiles.get(alice.user_id)).reply_language, 'fr');
        await withTenant(tenant, alice.user_id, async (c) => {
          assert.deepEqual(
            (await c.query('SELECT id FROM users')).rows.map((r) => r.id),
            [alice.user_id],
          );
          assert.equal(
            (await c.query('SELECT * FROM users WHERE id=$1', [bob.user_id])).rowCount,
            0,
          );
          assert.equal((await c.query('SELECT * FROM identity_results')).rowCount, 2);
          assert.deepEqual(
            (await c.query('SELECT user_id FROM consent_events')).rows.map((r) => r.user_id),
            [alice.user_id],
          );
          assert.equal(
            (
              await c.query("UPDATE user_preferences SET reply_language='en' WHERE user_id=$1", [
                bob.user_id,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (await c.query('DELETE FROM user_preferences WHERE user_id=$1', [bob.user_id]))
              .rowCount,
            0,
          );
        });
        await assert.rejects(
          withTenant(tenant, alice.user_id, (c) =>
            c.query('INSERT INTO user_preferences(user_id) VALUES($1)', [bob.user_id]),
          ),
          { code: '42501' },
        );
        await assert.rejects(
          withTenant(tenant, alice.user_id, (c) =>
            c.query('UPDATE user_preferences SET user_id=$1', [bob.user_id]),
          ),
          { code: '42501' },
        );
        await withTenant(tenant, alice.user_id, async (c) => {
          assert.equal((await c.query('DELETE FROM user_preferences')).rowCount, 1);
        });
        assert.equal((await profiles.get(bob.user_id)).reply_language, 'es');
      },
    );
    await t.test(
      'sensitive state and transport cannot be modified through tenant access',
      async () => {
        for (const sql of [
          'UPDATE users SET paused=false',
          'DELETE FROM consent_events',
          'TRUNCATE user_preferences',
          'SELECT * FROM ingress_events',
          'SELECT * FROM work_outbox',
          'ALTER TABLE users DISABLE ROW LEVEL SECURITY',
          'SET ROLE memorae_worker',
        ]) {
          await assert.rejects(
            withTenant(tenant, alice.user_id, (c) => c.query(sql)),
            { code: '42501' },
          );
        }
        await assert.rejects(ingress.query('SELECT * FROM users'), { code: '42501' });
        await assert.rejects(ingress.query('UPDATE ingress_events SET processed_at=now()'), {
          code: '42501',
        });
        await assert.rejects(worker.query('DELETE FROM consent_events'), { code: '42501' });
        await assert.rejects(worker.query('TRUNCATE ingress_events'), { code: '42501' });
      },
    );
    await t.test('cross-owner audit references and sender bindings are rejected', async () => {
      await assert.rejects(
        worker.query(
          `INSERT INTO consent_events(user_id,event_id,action,notice_version,notice_text)
        VALUES($1,$2,'accepted','test','test')`,
          [alice.user_id, bob.event_id],
        ),
        { code: '23503' },
      );
      const key = randomUUID();
      await ingestion.persist([
        {
          eventKey: key,
          kind: 'inbound.message',
          phoneNumberId: 'test-business',
          providerMessageId: key,
          senderId: 'bob',
          payload: {},
        },
      ]);
      const id = (await worker.query('SELECT id FROM ingress_events WHERE event_key=$1', [key]))
        .rows[0].id;
      await assert.rejects(
        worker.query(
          "INSERT INTO identity_results(event_id,user_id,disposition) VALUES($1,$2,'handled')",
          [id, alice.user_id],
        ),
        { code: '23503' },
      );
    });
    await t.test(
      'pooled connections clear context after commit, callback error and SQL abort',
      async () => {
        const pid = (await tenant.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        await profiles.setReplyLanguage(alice.user_id, 'fr');
        assert.equal((await tenant.query('SELECT * FROM users')).rowCount, 0);
        await assert.rejects(
          withTenant(tenant, alice.user_id, async (c) => {
            await c.query("UPDATE user_preferences SET reply_language='es'");
            throw new Error('intentional rollback');
          }),
          /intentional rollback/,
        );
        assert.equal((await profiles.get(alice.user_id)).reply_language, 'fr');
        await assert.rejects(
          withTenant(tenant, bob.user_id, (c) => c.query('SELECT 1/0')),
          { code: '22012' },
        );
        assert.equal((await tenant.query('SELECT * FROM users')).rowCount, 0);
        assert.equal((await tenant.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
        await tenant.query("SELECT set_config('app.user_id',$1,false)", [alice.user_id]);
        assert.equal((await profiles.get(bob.user_id)).id, bob.user_id);
        assert.equal((await tenant.query('SELECT * FROM users')).rowCount, 0);
        const results = await Promise.all([profiles.get(alice.user_id), profiles.get(bob.user_id)]);
        assert.deepEqual(
          results.map((r) => r.id),
          [alice.user_id, bob.user_id],
        );
        await assert.rejects(
          withTenant(tenant, 'not-a-uuid', async () => null),
          /Invalid authenticated/,
        );
        await tenant.query("SELECT set_config('app.user_id','malformed',false)");
        await assert.rejects(tenant.query('SELECT * FROM users'), { code: '22P02' });
        await tenant.query("SELECT set_config('app.user_id','',false)");
      },
    );
    await t.test('forced RLS also constrains a non-superuser table owner', async () => {
      const owner = `test_owner_${suffix}`;
      await admin.query(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
      roles.push(owner);
      await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${owner}`);
      await admin.query(`ALTER TABLE user_preferences OWNER TO ${owner}`);
      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE ${owner}`);
        assert.equal((await client.query('SELECT * FROM user_preferences')).rowCount, 0);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  } finally {
    for (const pool of pools) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    for (const role of roles) await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
});
