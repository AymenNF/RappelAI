import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import { IdentityProcessor } from '../../src/modules/identity/store.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test('identity: isolated senders, ordered concurrent workers, replay, revocation and window time', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const file of [
      '0001_ingress.sql',
      '0002_identity.sql',
      '0003_consent_offer_version.sql',
    ]) {
      await pool.query(
        await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'),
      );
    }
    const store = new PostgresIngressStore(pool);
    const processor = new IdentityProcessor(pool);
    const user = async (sender = 'alice') =>
      (await pool.query('SELECT * FROM users WHERE sender_id=$1', [sender])).rows[0];
    const send = async (
      body: string,
      sender = 'alice',
      timestamp = Math.floor(Date.now() / 1000),
      business = 'business',
    ) => {
      const key = randomUUID();
      const event = {
        eventKey: key,
        kind: 'inbound.message' as const,
        phoneNumberId: business,
        providerMessageId: key,
        senderId: sender,
        payload: { type: 'text', timestamp: String(timestamp), text: { body } },
      };
      await store.persist([event]);
      await store.persist([event]);
      await Promise.all(Array.from({ length: 5 }, () => processor.processNext()));
      const row = (
        await pool.query(
          `SELECT r.*,e.event_key FROM identity_results r JOIN ingress_events e ON e.id=r.event_id WHERE event_key=$1`,
          [key],
        )
      ).rows[0];
      assert.ok(row);
      return row;
    };
    const first = await send('hello');
    assert.equal(first.disposition, 'handled');
    assert.equal(await processor.eligibleForProcessing(first.event_id), false);
    const aliceToken = (await user()).consent_token;
    await send(`CONSENT ${aliceToken}`, 'bob');
    assert.equal((await user('bob')).consent_at, null);
    await send(`CONSENT ${aliceToken}`);
    assert.ok((await user()).consent_at);
    await send('TIMEZONE EST');
    assert.equal((await user()).timezone, null);
    await send('TIMEZONE America/Toronto');
    const zoneToken = (await user()).timezone_token;
    await send(`CONFIRM TIMEZONE ${zoneToken}`);
    assert.equal((await user()).timezone, 'America/Toronto');
    const ready = await send('Remind me tomorrow at 5');
    assert.equal(ready.disposition, 'ready');
    assert.equal(await processor.eligibleForProcessing(ready.event_id), true);
    const work = (
      await pool.query('SELECT status FROM work_outbox WHERE event_id=$1', [ready.event_id])
    ).rows[0];
    assert.equal(work.status, 'pending');
    const expiry = (await user()).window_expires_at;
    const old = await send('old message', 'alice', Math.floor(Date.now() / 1000) - 86400 * 3);
    assert.equal(old.disposition, 'blocked');
    assert.equal((await user()).window_expires_at.getTime(), expiry.getTime());
    await send('STOP');
    assert.equal(await processor.eligibleForProcessing(ready.event_id), false);
    await send(`CONSENT ${aliceToken}`);
    assert.equal((await user()).consent_at, null);
    await send('START');
    await send(`CONSENT ${(await user()).consent_token}`);
    assert.equal(
      await processor.eligibleForProcessing(ready.event_id),
      false,
      'old work cannot revive under a new consent grant',
    );
    const queued = ['TIMEZONE Europe/Paris', 'TIMEZONE Asia/Tokyo'].map((body) => {
      const key = randomUUID();
      return {
        eventKey: key,
        kind: 'inbound.message' as const,
        phoneNumberId: 'business',
        providerMessageId: key,
        senderId: 'alice',
        payload: { type: 'text', timestamp: String(Math.floor(Date.now() / 1000)), text: { body } },
      };
    });
    await store.persist(queued);
    await Promise.all(Array.from({ length: 8 }, () => processor.processNext()));
    while (await processor.processNext()) {
      /* finish ordered events */
    }
    assert.equal((await user()).pending_timezone, 'Asia/Tokyo');
    await send('hello', 'alice', Math.floor(Date.now() / 1000), 'another-business');
    assert.equal((await pool.query("SELECT * FROM users WHERE sender_id='alice'")).rowCount, 2);
    const future = await send('hello', 'future', Math.floor(Date.now() / 1000) + 86400);
    assert.equal(future.disposition, 'blocked');
    assert.equal((await user('future')).window_expires_at, null);
    assert.equal(
      (await pool.query("SELECT * FROM consent_events WHERE action='accepted'")).rowCount,
      2,
    );
    assert.equal(
      (await pool.query("SELECT * FROM consent_events WHERE action='revoked'")).rowCount,
      1,
    );
    assert.equal(
      (await pool.query('SELECT count(*) FROM identity_results')).rows[0].count,
      (await pool.query('SELECT count(*) FROM ingress_events')).rows[0].count,
    );
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
