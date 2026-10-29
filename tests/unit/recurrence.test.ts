import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recurrenceSchedule, seriesCommand } from '../../src/modules/reminders/recurrence.js';

test('daily next-five fixture preserves wall time and shifts a spring gap without shifting later days', () => {
  const rows = recurrenceSchedule('2026-03-06T07:30:00Z', 'America/Toronto', 'daily', '2026-03-10');
  assert.deepEqual(
    rows.map((r) => r.instant),
    [
      '2026-03-06T07:30:00Z',
      '2026-03-07T07:30:00Z',
      '2026-03-08T07:30:00Z',
      '2026-03-09T06:30:00Z',
      '2026-03-10T06:30:00Z',
    ],
  );
  assert.match(rows[2]!.local, /03:30:00-04:00/);
  assert.match(rows[3]!.local, /02:30:00-04:00/);
});
test('daily next-five fold fixture chooses the earlier occurrence once, then keeps local time', () => {
  const rows = recurrenceSchedule('2026-10-30T05:30:00Z', 'America/Toronto', 'daily', '2026-11-03');
  assert.deepEqual(
    rows.map((r) => r.instant),
    [
      '2026-10-30T05:30:00Z',
      '2026-10-31T05:30:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-02T06:30:00Z',
      '2026-11-03T06:30:00Z',
    ],
  );
  assert.throws(
    () => recurrenceSchedule('2026-11-01T06:30:00Z', 'America/Toronto', 'daily', '2026-11-05'),
    /second repeated/,
  );
});
test('weekly next-five fixture follows local weekday across DST rather than UTC plus 168 hours', () => {
  assert.deepEqual(
    recurrenceSchedule('2026-02-22T14:00:00Z', 'America/Toronto', 'weekly', '2026-03-22').map(
      (r) => r.instant,
    ),
    [
      '2026-02-22T14:00:00Z',
      '2026-03-01T14:00:00Z',
      '2026-03-08T13:00:00Z',
      '2026-03-15T13:00:00Z',
      '2026-03-22T13:00:00Z',
    ],
  );
});
test('non-hour DST, no-DST zones, leap day and skipped whole dates are explicit', () => {
  const half = recurrenceSchedule(
    '2026-10-02T15:45:00Z',
    'Australia/Lord_Howe',
    'daily',
    '2026-10-05',
  );
  assert.match(half[1]!.local, /02:45:00\+11:00/);
  assert.match(half[2]!.local, /02:15:00\+11:00/);
  const leap = recurrenceSchedule('2028-02-28T09:00:00.123456Z', 'UTC', 'daily', '2028-03-01');
  assert.equal(leap[1]!.instant, '2028-02-29T09:00:00.123456Z');
  assert.equal(
    recurrenceSchedule('2026-03-06T03:15:00Z', 'Asia/Kathmandu', 'daily', '2026-03-10').length,
    5,
  );
  const skip = recurrenceSchedule('2011-12-29T19:00:00Z', 'Pacific/Apia', 'daily', '2012-01-02');
  assert.equal(new Set(skip.map((r) => r.instant)).size, skip.length);
  assert.equal(skip.length, 4);
});
test('rules reject unsupported cadence, invalid dates/zones, empty or unbounded schedules', () => {
  for (const until of ['2026-02-30', '2025-01-01', '2026-01-01', '2027-01-02', 'forever'])
    assert.throws(() => recurrenceSchedule('2026-01-01T09:00:00Z', 'UTC', 'daily', until));
  assert.throws(() => recurrenceSchedule('2026-01-01T09:00:00Z', 'EST', 'daily', '2026-01-03'));
  assert.throws(() =>
    recurrenceSchedule('2026-01-01T09:00:00Z', 'UTC', 'monthly' as 'daily', '2026-03-01'),
  );
  assert.throws(() => recurrenceSchedule('2026-01-01T09:00:00Z', 'UTC', 'weekly', '2026-01-03'));
  assert.equal(
    recurrenceSchedule('2026-01-01T09:00:00Z', 'UTC', 'daily', '2027-01-01').length,
    366,
  );
});
test('repeat commands require explicit cadence/end and distinguish whole-series cancellation', () => {
  const reference = '0123456789abcdef';
  assert.deepEqual(seriesCommand(`REPEAT ${reference} DAILY UNTIL 2026-11-30`), {
    action: 'propose',
    reference,
    cadence: 'daily',
    until: '2026-11-30',
  });
  assert.deepEqual(seriesCommand(`confirm repeat ${reference}`), { action: 'confirm', reference });
  assert.deepEqual(seriesCommand(`CANCEL SERIES ${reference}`), { action: 'cancel', reference });
  for (const text of [
    `REPEAT ${reference} MONTHLY UNTIL 2026-11-30`,
    `REPEAT ${reference} DAILY`,
    `CONFIRM REPEAT`,
    `CANCEL SERIES other`,
  ])
    assert.deepEqual(seriesCommand(text), { action: 'invalid' });
  assert.equal(seriesCommand(`CANCEL ${reference}`), null);
  assert.equal(seriesCommand('remind me daily'), null);
});
