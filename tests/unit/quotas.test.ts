import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quotaPolicy } from '../../src/modules/quotas/control.js';
import { rejectionMessage } from '../../src/modules/quotas/service.js';
test('quota configuration requires a complete bounded integer policy and permits zero', () => {
  const valid = {
    requests_minute: 1,
    requests_day: 2,
    model_minute: 3,
    model_day: 4,
    send_minute: 5,
    send_day: 6,
    global_model_day: 7,
    global_send_day: 8,
    pending_reminders: 9,
    list_items: 10,
  };
  assert.deepEqual(quotaPolicy.parse(valid), valid);
  assert.equal(quotaPolicy.parse({ ...valid, send_day: 0 }).send_day, 0);
  for (const value of [-1, 1.5, Infinity, 1000001, '100'])
    assert.throws(() => quotaPolicy.parse({ ...valid, send_day: value }));
  assert.throws(() => quotaPolicy.parse({ ...valid, enabled: false }));
  assert.throws(() => quotaPolicy.parse({}));
});
test('quota replies distinguish clock resets, blocked accounts and oversized input', () => {
  assert.match(rejectionMessage('requests_day'), /00:00 UTC/);
  assert.match(rejectionMessage('requests_minute'), /next minute/);
  assert.match(rejectionMessage('account_blocked'), /Contact the operator/);
  assert.match(rejectionMessage('input_size'), /4,096/);
  assert.match(rejectionMessage('requests_day'), /Nothing was applied or queued/);
});
