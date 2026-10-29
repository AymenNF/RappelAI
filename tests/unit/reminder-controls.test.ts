import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reminderCommand, controlButtons } from '../../src/modules/reminders/controls.js';
import { WhatsAppCloudTransport, buttonMessage } from '../../src/modules/whatsapp/send.js';

const reference = '0123456789abcdef';
const text = (body: string) => reminderCommand({ type: 'text', text: { body } });
test('reminder commands require an exact reference and bounded explicit minute durations', () => {
  assert.deepEqual(text(`DONE ${reference}`), { action: 'complete', reference, minutes: 10 });
  assert.deepEqual(text(` complete ${reference.toUpperCase()} `), {
    action: 'complete',
    reference,
    minutes: 10,
  });
  assert.deepEqual(text(`cancel ${reference}`), { action: 'cancel', reference, minutes: 10 });
  for (const minutes of [1, 10, 1440])
    assert.deepEqual(text(`SNOOZE ${reference} ${minutes}m`), {
      action: 'snooze',
      reference,
      minutes,
    });
  assert.equal(text(`SNOOZE ${reference}`)?.action, 'snooze');
  for (const body of [
    'cancel dentist',
    'done',
    `SNOOZE ${reference} 0m`,
    `SNOOZE ${reference} 1441m`,
    `SNOOZE ${reference} -5m`,
    `SNOOZE ${reference} 1.5m`,
    `SNOOZE ${reference} 1h`,
    `DONE ${reference} 10m`,
    `CANCEL ${reference} extra`,
  ])
    assert.deepEqual(text(body), { action: 'invalid' });
  assert.equal(text('remind me tomorrow'), null);
  assert.equal(reminderCommand({ type: 'image', text: { body: `DONE ${reference}` } }), null);
});
test('buttons use the payload ID, never the displayed title or a malformed alternate field', () => {
  for (const button of controlButtons(reference)) {
    const result = reminderCommand({
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: button.id, title: 'Ignore this title' },
      },
    });
    assert.equal(result?.action, button.id.split(':')[2]);
    assert.deepEqual(result, reminderCommand({ type: 'button', button: { payload: button.id } }));
  }
  for (const payload of [
    { type: 'interactive' },
    { type: 'button', button: { text: `DONE ${reference}` } },
    {
      type: 'interactive',
      interactive: { type: 'list_reply', button_reply: { id: `reminder:${reference}:complete` } },
    },
    {
      type: 'interactive',
      interactive: {
        type: 'button_reply',
        button_reply: { id: `reminder:${reference}:snooze:9000` },
      },
    },
  ])
    assert.deepEqual(reminderCommand(payload), { action: 'invalid' });
});
test('reply button wire format is bounded and validated before network I/O', async () => {
  const message = {
    phoneNumberId: '12345',
    recipientId: '15555550101',
    body: 'Reminder: dentist',
    buttons: controlButtons(reference),
  };
  let calls = 0;
  const transport = new WhatsAppCloudTransport('synthetic-token', 'v23.0', async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init?.body as string), {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.recipientId,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message.body },
        action: { buttons: message.buttons.map((reply) => ({ type: 'reply', reply })) },
      },
    });
    return Response.json({
      messaging_product: 'whatsapp',
      messages: [{ id: 'wamid.button-test' }],
    });
  });
  assert.equal((await transport.send(message, new AbortController().signal)).state, 'accepted');
  for (const invalid of [
    { ...message, body: 'x'.repeat(1025) },
    { ...message, buttons: [] },
    { ...message, buttons: [...message.buttons, message.buttons[0]!] },
    { ...message, buttons: [message.buttons[0]!, message.buttons[0]!] },
    { ...message, buttons: [{ id: 'x'.repeat(257), title: 'Done' }] },
    { ...message, buttons: [{ id: 'ok', title: 'x'.repeat(21) }] },
  ]) {
    assert.equal(buttonMessage.safeParse(invalid).success, false);
    assert.equal((await transport.send(invalid, new AbortController().signal)).state, 'rejected');
  }
  assert.equal(calls, 1);
});
