import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDecision } from '../../src/contracts/decision.js';

const now = new Date('2026-10-27T12:00:00Z');
const reminder = (due_at: string) => ({
  behavior: 'execute',
  calls: [
    {
      tool: 'create_reminder',
      args: {
        title: 'call dentist',
        due_at,
        delivery_mode: 'immediate',
      },
    },
  ],
});
test('offset-aware future reminder is valid', () => {
  assert.equal(validateDecision(reminder('2026-10-28T08:00:00-04:00'), now).calls.length, 1);
});
test('past, impossible, and unspecified-offset dates are rejected', () => {
  for (const date of [
    'tomorrow',
    '2026-10-28T08:00:00',
    '2026-10-26T12:00:00Z',
    '2026-02-30T12:00:00Z',
  ]) {
    assert.throws(() => validateDecision(reminder(date), now));
  }
});
test('clarification cannot execute actions', () => {
  assert.throws(() =>
    validateDecision({ ...reminder('2026-10-28T08:00:00Z'), behavior: 'clarify' }, now),
  );
  assert.throws(() => validateDecision({ behavior: 'execute', calls: [] }, now));
});
test('unknown fields and third-party tools are rejected', () => {
  assert.throws(() =>
    validateDecision(
      { behavior: 'execute', calls: [{ tool: 'send_message', args: { to: '15555550100' } }] },
      now,
    ),
  );
  assert.throws(() =>
    validateDecision({ behavior: 'noop', calls: [], recipient: '15555550100' }, now),
  );
});
