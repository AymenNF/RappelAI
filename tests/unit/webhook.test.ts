import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildApp } from '../../src/api/app.js';
import { readConfig } from '../../src/config/env.js';
import { verifySignature } from '../../src/modules/whatsapp/signature.js';
import { extractEvents, type IngressEvent } from '../../src/modules/whatsapp/events.js';
import type { IngressStore } from '../../src/db/ingress-store.js';

const secret = 'local-test-secret-only-32-characters';
const config = readConfig({
  DATABASE_URL: 'postgresql://test:test@localhost/test',
  WHATSAPP_APP_SECRET: secret,
  WHATSAPP_VERIFY_TOKEN: secret,
  LOG_LEVEL: 'silent',
});
function payload(id = 'wamid.test') {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'account',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'business-1' },
              messages: [
                {
                  id,
                  from: '15555550100',
                  timestamp: '1793102400',
                  type: 'text',
                  text: { body: 'hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}
function signed(body: string) {
  return {
    'content-type': 'application/json',
    'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  };
}
class MemoryTestStore implements IngressStore {
  rows = new Map<string, IngressEvent>();
  async ready() {
    return true;
  }
  async persist(events: IngressEvent[]) {
    const before = this.rows.size;
    for (const event of events) this.rows.set(event.eventKey, event);
    return { inserted: this.rows.size - before };
  }
}

test('HMAC uses the original bytes, rejects tampering and malformed signatures', () => {
  const body = JSON.stringify(payload(), null, 2);
  const signature = signed(body)['x-hub-signature-256'];
  assert.equal(verifySignature(Buffer.from(body), signature, secret), true);
  assert.equal(verifySignature(Buffer.from(body + ' '), signature, secret), false);
  for (const header of [undefined, '', 'sha256=abc', ['sha256=abc']]) {
    assert.equal(verifySignature(Buffer.from(body), header, secret), false);
  }
});

test('challenge verifies token and returns plain text', async (t) => {
  const app = buildApp(config, new MemoryTestStore());
  t.after(() => app.close());
  const response = await app.inject(
    `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${secret}&hub.challenge=1234`,
  );
  assert.equal(response.statusCode, 200);
  assert.equal(response.body, '1234');
  assert.equal(
    (
      await app.inject(
        '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1234',
      )
    ).statusCode,
    403,
  );
});

test('valid webhook is stored; replay identifies the same event', async (t) => {
  const store = new MemoryTestStore();
  const app = buildApp(config, store);
  t.after(() => app.close());
  const body = JSON.stringify(payload(), null, 2);
  for (let n = 0; n < 2; n++) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/webhooks/whatsapp',
          headers: signed(body),
          payload: body,
        })
      ).statusCode,
      200,
    );
  }
  assert.equal(store.rows.size, 1);
});

test('unsigned payload never reaches storage', async (t) => {
  const store = new MemoryTestStore();
  const app = buildApp(config, store);
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    payload: payload(),
  });
  assert.equal(response.statusCode, 401);
  assert.equal(store.rows.size, 0);
});

test('invalid signed JSON or envelope is rejected', async (t) => {
  const store = new MemoryTestStore();
  const app = buildApp(config, store);
  t.after(() => app.close());
  for (const body of ['{', '{}']) {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: signed(body),
      payload: body,
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(store.rows.size, 0);
});

test('storage outage is retryable and readiness reflects database availability', async (t) => {
  const app = buildApp(config, {
    ready: async () => false,
    persist: async () => {
      throw new Error('offline');
    },
  });
  t.after(() => app.close());
  const body = JSON.stringify(payload());
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/webhooks/whatsapp',
        headers: signed(body),
        payload: body,
      })
    ).statusCode,
    503,
  );
  assert.equal((await app.inject('/health/ready')).statusCode, 503);
  assert.equal((await app.inject('/health/live')).statusCode, 200);
});

test('mixed batches retain every message and status, scoped by business phone', () => {
  const value = payload().entry[0]!.changes[0]!.value;
  const batch = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'a',
        changes: [
          {
            field: 'messages',
            value: {
              ...value,
              messages: [...value.messages, { ...value.messages[0], id: 'wamid.second' }],
              statuses: [{ id: 'wamid.sent', timestamp: '1793102400', status: 'delivered' }],
            },
          },
        ],
      },
    ],
  };
  const events = extractEvents(batch);
  assert.equal(events.length, 3);
  assert.equal(events[2]!.kind, 'delivery.status');
  assert.throws(() => extractEvents(batch, 'other-business'));
  const other = structuredClone(batch);
  other.entry[0]!.changes[0]!.value.metadata.phone_number_id = 'business-2';
  assert.notEqual(extractEvents(other)[0]!.eventKey, events[0]!.eventKey);
});

test('status dedupe ignores JSON property order but retains progression', () => {
  const make = (status: Record<string, string>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'a',
        changes: [
          { field: 'messages', value: { metadata: { phone_number_id: 'b' }, statuses: [status] } },
        ],
      },
    ],
  });
  const a = extractEvents(make({ id: 'x', timestamp: '100', status: 'sent' }))[0]!;
  const b = extractEvents(make({ status: 'sent', timestamp: '100', id: 'x' }))[0]!;
  const c = extractEvents(make({ id: 'x', timestamp: '101', status: 'delivered' }))[0]!;
  assert.equal(a.eventKey, b.eventKey);
  assert.notEqual(a.eventKey, c.eventKey);
});

test('oversized body is rejected before persistence', async (t) => {
  const store = new MemoryTestStore();
  const app = buildApp(config, store);
  t.after(() => app.close());
  const body = JSON.stringify({ content: 'x'.repeat(1024 * 1024) });
  const result = await app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: signed(body),
    payload: body,
  });
  assert.equal(result.statusCode, 413);
  assert.equal(store.rows.size, 0);
});
