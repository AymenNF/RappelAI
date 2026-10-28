import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WhatsAppCloudTransport, boundedSend } from '../../src/modules/whatsapp/send.js';
import { reduceDelivery } from '../../src/modules/whatsapp/receipts.js';

const message = {
  phoneNumberId: '12345',
  recipientId: '15555550101',
  body: 'Saved synthetic item.',
};
const ok = () => Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.test' }] });
test('Cloud adapter sends bounded plain text to the fixed Graph origin and records acceptance only', async () => {
  const transport = new WhatsAppCloudTransport('test-secret', 'v23.0', async (url, init) => {
    assert.equal(url, 'https://graph.facebook.com/v23.0/12345/messages');
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-secret');
    assert.deepEqual(JSON.parse(init?.body as string), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.recipientId,
      type: 'text',
      text: { body: message.body, preview_url: false },
    });
    return ok();
  });
  assert.deepEqual(await boundedSend(transport, message, 1000), {
    state: 'accepted',
    providerMessageId: 'wamid.test',
  });
});
test('invalid config, recipients, bodies and cancellation prevent network calls', async () => {
  assert.throws(() => new WhatsAppCloudTransport('secret', '../escape'));
  let calls = 0;
  const transport = new WhatsAppCloudTransport('secret', 'v23.0', async () => {
    calls++;
    return ok();
  });
  for (const input of [
    { ...message, phoneNumberId: '../x' },
    { ...message, recipientId: 'anywhere' },
    { ...message, body: 'x'.repeat(4097) },
  ])
    assert.equal((await transport.send(input, new AbortController().signal)).state, 'rejected');
  await boundedSend(transport, message, 1000, AbortSignal.abort());
  assert.equal(calls, 0);
});
test('known API rejections are distinct from ambiguous HTTP or malformed results; errors omit provider content', async () => {
  const cases: [() => Response, string][] = [
    [
      () => Response.json({ error: { code: 131047, message: 'sensitive' } }, { status: 400 }),
      'rejected',
    ],
    [() => Response.json({ error: { code: 1 } }, { status: 500 }), 'unknown'],
    [() => new Response('secret html', { status: 401 }), 'unknown'],
    [() => Response.json({ messages: [] }), 'unknown'],
    [
      () => Response.json({ messaging_product: 'whatsapp', messages: [{ id: 'a' }, { id: 'b' }] }),
      'unknown',
    ],
    [() => new Response('x'.repeat(33000)), 'unknown'],
  ];
  for (const [response, state] of cases) {
    let calls = 0;
    const transport = new WhatsAppCloudTransport('secret', 'v23.0', async () => {
      calls++;
      return response();
    });
    const result = await boundedSend(transport, message, 1000);
    assert.equal(result.state, state);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|secret html/);
  }
});
test('timeouts bound uncooperative transports and ignore late success', async () => {
  let aborted: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const result = await boundedSend(
    {
      send: async (_message, signal) => {
        aborted = signal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { state: 'accepted', providerMessageId: 'late' };
      },
    },
    message,
    20,
  );
  assert.deepEqual(result, { state: 'unknown', code: 'timeout' });
  assert.equal(aborted?.aborted, true);
  finish?.();
  assert.equal(result.state, 'unknown');
});
test('receipt reduction never regresses read/delivered; failure outranks sent and unknown statuses do nothing', () => {
  assert.equal(reduceDelivery('none', ['read', 'failed', 'sent', 'delivered']), 'read');
  assert.equal(reduceDelivery('sent', ['failed', 'sent']), 'failed');
  assert.equal(reduceDelivery('failed', ['delivered']), 'delivered');
  assert.equal(reduceDelivery('none', ['deleted', 'constructor', 'toString']), 'none');
});
