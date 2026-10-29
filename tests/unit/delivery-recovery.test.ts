import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryRetryDelay, MAX_DELIVERY_ATTEMPTS } from '../../src/modules/whatsapp/retry.js';
import { reconciliation } from '../../src/modules/whatsapp/recovery.js';
import { WhatsAppCloudTransport, retryAfterSeconds } from '../../src/modules/whatsapp/send.js';

test('delivery retries are finite with increasing delay; operator decisions require evidence and exact addresses', () => {
  assert.equal(MAX_DELIVERY_ATTEMPTS, 3);
  assert.equal(deliveryRetryDelay(1), 60);
  assert.equal(deliveryRetryDelay(2), 240);
  for (const n of [0, 4, 1.5, NaN]) assert.throws(() => deliveryRetryDelay(n));
  for (const input of [
    { action: 'not_sent', note: '' },
    { action: 'accepted', note: 'proof' },
    { action: 'retry', note: 'proof', force: true },
  ])
    assert.equal(reconciliation.safeParse(input).success, false);
  assert.equal(
    reconciliation.safeParse({
      action: 'not_sent',
      senderStopped: true,
      note: 'Provider confirms no message created',
    }).success,
    true,
  );
});
test('only a structured HTTP 429 rejection carries an automatic retry hint; ambiguous errors remain unknown', async () => {
  for (const [status, structured, retryable, state] of [
    [429, true, true, 'rejected'],
    [400, true, false, 'rejected'],
    [503, true, false, 'unknown'],
    [429, false, false, 'unknown'],
  ] as const) {
    const transport = new WhatsAppCloudTransport('fake', 'v23.0', async () =>
      structured
        ? Response.json({ error: { code: 130429 } }, { status })
        : new Response('bad gateway', { status }),
    );
    const result = await transport.send(
      { phoneNumberId: '12345', recipientId: '15555550101', body: 'synthetic' },
      new AbortController().signal,
    );
    assert.equal(result.state, state);
    assert.equal('retryable' in result && result.retryable === true, retryable);
  }
});

test('Retry-After accepts delay seconds and dates without shortening provider waits', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  assert.equal(retryAfterSeconds('3600', now), 3600);
  assert.equal(retryAfterSeconds('Thu, 29 Oct 2026 01:00:00 GMT', now), 3600);
  for (const input of [null, 'invalid', '0']) assert.equal(retryAfterSeconds(input, now), 0);
  assert.equal(retryAfterSeconds('99999999999999999999999', now), 2147483647);
});
