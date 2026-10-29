import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeListName } from '../../src/modules/lists/service.js';
import { successReply, type ActionResult } from '../../src/modules/processing/results.js';

test('list names normalize Unicode, case and whitespace without fuzzy merging', () => {
  assert.deepEqual(normalizeListName('  ＧＲＯＣＥＲＹ \t List  '), {
    name: 'GROCERY List',
    key: 'grocery list',
  });
  assert.equal(normalizeListName('Grocery').key, normalizeListName('grocery').key);
  assert.notEqual(normalizeListName('Grocery').key, normalizeListName('Groceries').key);
  assert.throws(() => normalizeListName('   '));
  assert.throws(() => normalizeListName('x'.repeat(201)));
});
test('reply summaries show saved results and explicit delivery limits, bounded below provider text length', () => {
  const reminder: ActionResult = {
    tool: 'create_reminder',
    id: 'test',
    title: 'Call dentist',
    dueAt: '2026-11-01T06:30:00Z',
    timezone: 'America/Toronto',
  };
  const body = successReply([reminder]);
  assert.match(body, /Saved reminder/);
  assert.match(body, /01:30/);
  assert.match(body, /GMT-5/);
  assert.match(body, /delivery is not enabled/);
  assert.doesNotMatch(body, /sent|delivered/i);
  const long = successReply(
    Array.from({ length: 5 }, () => ({
      tool: 'add_list_item' as const,
      id: 'test',
      listId: 'test',
      position: 1,
      text: '😀'.repeat(500),
      listName: 'x'.repeat(200),
    })),
  );
  assert.ok(long.length < 4096);
  assert.ok(!long.includes('\uFFFD'));
  const reminders = successReply(
    Array.from({ length: 5 }, () => ({
      ...reminder,
      title: '😀'.repeat(100),
      reference: '0123456789abcdef',
    })),
  );
  assert.ok(reminders.length < 4096);
  assert.match(reminders, /SNOOZE 0123456789abcdef 10m/);
  assert.match(
    successReply([
      {
        tool: 'add_list_item',
        id: 'test',
        listId: 'test',
        position: 1,
        text: 'milk',
        listName: 'grocery',
      },
    ]),
    /Added “milk” to “grocery”/,
  );
});
