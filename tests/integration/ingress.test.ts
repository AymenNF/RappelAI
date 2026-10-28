import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { PostgresIngressStore } from '../../src/db/ingress-store.js';
import type { IngressEvent } from '../../src/modules/whatsapp/events.js';

if (!process.env.TEST_DATABASE_URL)
  throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL database. See docs/setup.md.');

test('real PostgreSQL: atomic inbox/outbox, concurrent replay, rollback, readiness', async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    options: `-c search_path=${schema},public`,
  });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(
      await readFile(new URL('../../migrations/0001_ingress.sql', import.meta.url), 'utf8'),
    );
    const store = new PostgresIngressStore(pool);
    assert.equal(await store.ready(), true);
    const event: IngressEvent = {
      eventKey: 'unique',
      kind: 'inbound.message',
      phoneNumberId: 'business',
      providerMessageId: 'wamid.x',
      senderId: '15555550100',
      payload: { type: 'text' },
    };
    const results = await Promise.all(Array.from({ length: 8 }, () => store.persist([event])));
    assert.equal(
      results.reduce((sum, result) => sum + result.inserted, 0),
      1,
    );
    assert.equal((await pool.query('SELECT * FROM ingress_events')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM work_outbox')).rowCount, 1);
    await assert.rejects(
      store.persist([
        { ...event, eventKey: 'new-valid' },
        { ...event, eventKey: 'invalid', senderId: null },
      ]),
    );
    assert.equal((await pool.query('SELECT * FROM ingress_events')).rowCount, 1);
    assert.equal((await pool.query('SELECT * FROM work_outbox')).rowCount, 1);
  } finally {
    await pool.end();
    // Only this generated test schema is removed, never the public schema or user's data.
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
