import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliveryTime, preferenceCommand } from '../../src/modules/reminders/delivery-time.js';

const prefs = { digest_minute: 540, quiet_start: 1320, quiet_end: 480 };
test('preference commands require explicit clocks, ranges and exact references', () => {
  assert.deepEqual(preferenceCommand('digest at 09:00'), { action: 'digest', minute: 540 });
  assert.deepEqual(preferenceCommand('QUIET 22:00-08:00'), {
    action: 'quiet',
    start: 1320,
    end: 480,
  });
  assert.deepEqual(preferenceCommand('DELIVER abcdef0123456789 EXACT'), {
    action: 'propose',
    reference: 'abcdef0123456789',
    mode: 'exact',
  });
  for (const s of [
    'DIGEST AT 24:00',
    'QUIET 08:00-08:00',
    'QUIET 8:00-09:00',
    'DELIVER abc DIGEST',
    'CONFIRM DELIVERY abc',
    'DIGEST ON',
  ])
    assert.equal(preferenceCommand(s)?.action, 'invalid');
  assert.equal(preferenceCommand('buy milk'), null);
});
test('exact-time promise preserves microseconds even during overnight quiet hours', () => {
  assert.equal(
    deliveryTime('2026-11-04T04:00:00.123456Z', 'America/Toronto', 'exact', prefs),
    '2026-11-04T04:00:00.123456Z',
  );
});
test('quiet boundaries are start-inclusive/end-exclusive for daytime and overnight intervals', () => {
  assert.equal(
    deliveryTime('2026-10-29T02:00:00Z', 'America/Toronto', 'quiet', prefs),
    '2026-10-29T12:00:00Z',
  );
  assert.equal(
    deliveryTime('2026-10-29T12:00:00.000001Z', 'America/Toronto', 'quiet', prefs),
    '2026-10-29T12:00:00.000001Z',
  );
  assert.equal(
    deliveryTime('2026-10-29T16:00Z', 'America/Toronto', 'quiet', {
      ...prefs,
      quiet_start: 720,
      quiet_end: 780,
    }),
    '2026-10-29T17:00:00Z',
  );
});
test('digest uses the next slot without rounding early and can defer through quiet hours', () => {
  assert.equal(
    deliveryTime('2026-10-29T13:00:00Z', 'America/Toronto', 'digest', prefs),
    '2026-10-29T13:00:00Z',
  );
  assert.equal(
    deliveryTime('2026-10-29T13:00:00.000001Z', 'America/Toronto', 'digest', prefs),
    '2026-10-30T13:00:00Z',
  );
  assert.equal(
    deliveryTime('2026-10-29T12:00Z', 'America/Toronto', 'digest', {
      ...prefs,
      quiet_start: 480,
      quiet_end: 600,
    }),
    '2026-10-29T14:00:00Z',
  );
});
test('DST gaps shift forward and folds use the first digest slot once', () => {
  const p = { digest_minute: 150, quiet_start: null, quiet_end: null };
  assert.equal(
    deliveryTime('2026-03-08T06:00Z', 'America/Toronto', 'digest', p),
    '2026-03-08T07:30:00Z',
  );
  assert.equal(
    deliveryTime('2026-11-01T06:15Z', 'America/Toronto', 'digest', { ...p, digest_minute: 90 }),
    '2026-11-02T06:30:00Z',
  );
  assert.equal(
    deliveryTime('2026-11-01T06:15Z', 'America/Toronto', 'quiet', {
      ...p,
      quiet_start: 60,
      quiet_end: 90,
    }),
    '2026-11-01T06:30:00Z',
  );
});
test('non-hour offsets, skipped dates and leap days produce bounded future slots', () => {
  const p = { digest_minute: 540, quiet_start: null, quiet_end: null };
  assert.equal(
    deliveryTime('2028-02-29T01:00Z', 'Asia/Kathmandu', 'digest', p),
    '2028-02-29T03:15:00Z',
  );
  assert.equal(
    deliveryTime('2011-12-30T08:00Z', 'Pacific/Apia', 'digest', p),
    '2011-12-30T19:00:00Z',
  );
});
test('disabled and invalid preferences cannot authorize a deferred promise', () => {
  assert.throws(() =>
    deliveryTime('2026-10-29T13:00Z', 'UTC', 'digest', { ...prefs, digest_minute: null }),
  );
  assert.throws(() =>
    deliveryTime('2026-10-29T13:00Z', 'UTC', 'quiet', {
      ...prefs,
      quiet_start: null,
      quiet_end: null,
    }),
  );
  assert.throws(() =>
    deliveryTime('2026-10-29T13:00Z', 'UTC', 'quiet', { ...prefs, quiet_end: 1320 }),
  );
});
