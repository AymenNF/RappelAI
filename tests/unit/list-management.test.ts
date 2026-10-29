import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCommand, matching, preview } from '../../src/modules/lists/commands.js';

test('list commands parse quoted names, item positions, escaped text and reference pagination', () => {
  const ref = '0123456789abcdef';
  assert.deepEqual(listCommand('LISTS'), { kind: 'catalog' });
  assert.deepEqual(listCommand(`LISTS AFTER ${ref}`), { kind: 'catalog', after: ref });
  assert.deepEqual(listCommand('LIST "Grocery" AFTER 10'), {
    kind: 'request',
    request: { operation: 'read', list: 'Grocery', byReference: false, after: 10 },
  });
  assert.deepEqual(listCommand(`ITEM @${ref} #2`), {
    kind: 'request',
    request: { operation: 'item', list: `@${ref}`, byReference: true, selector: 2, after: 0 },
  });
  assert.deepEqual(
    listCommand('EDIT ITEM "Grocery" "milk" TO "oat \\"milk\\""'.replaceAll('\\\\', '\\')),
    {
      kind: 'request',
      request: {
        operation: 'edit',
        list: 'Grocery',
        byReference: false,
        selector: 'milk',
        after: 0,
        text: 'oat "milk"',
      },
    },
  );
  assert.deepEqual(listCommand('DONE ITEM "Grocery" #2'), {
    kind: 'request',
    request: { operation: 'complete', list: 'Grocery', byReference: false, selector: 2, after: 0 },
  });
  assert.deepEqual(listCommand(`CHOOSE LIST ${ref} 2`), {
    kind: 'choose',
    reference: ref,
    option: 2,
  });
  const literal = listCommand(`LIST "@${ref}"`);
  assert.ok(literal?.kind === 'request');
  assert.equal(literal.request.byReference, false);
});
test('malformed and oversized reserved commands never become executable requests', () => {
  for (const text of [
    'LIST Grocery',
    'LIST "Grocery" AFTER -1',
    'ITEM "Grocery" #0',
    'ITEM "Grocery" #2147483648',
    'DONE ITEM "Grocery" #1 TO "new"',
    'EDIT ITEM "Grocery" #1',
    'EDIT ITEM "Grocery" "milk" TO "   "',
    'CHOOSE LIST 0123456789abcdef 6',
    `EDIT ITEM "Grocery" #1 TO "${'x'.repeat(1001)}"`,
    'LIST "unterminated',
    'LIST "a"; DROP TABLE users',
  ])
    assert.deepEqual(listCommand(text), { kind: 'invalid' }, text);
  assert.equal(listCommand('add milk to grocery'), null);
  assert.equal(listCommand('DONE 0123456789abcdef'), null);
  assert.equal(listCommand(null), null);
});
test('matching normalizes Unicode/case/space, preserves duplicates and prefers exact matches', () => {
  const values = ['Milk', 'milk', 'oat milk', 'almond milk'];
  assert.deepEqual(
    matching(values, '  ＭＩＬＫ  ', (s) => s),
    ['Milk', 'milk'],
  );
  assert.deepEqual(
    matching(['oat milk', 'almond milk'], 'milk', (s) => s),
    ['oat milk', 'almond milk'],
  );
  assert.deepEqual(
    matching(['Grocery', 'Groceries', 'Travel'], 'Grocry', (s) => s),
    ['Grocery'],
  );
  assert.deepEqual(
    matching(['apples', 'milk'], 'newspaper', (s) => s),
    [],
  );
  assert.deepEqual(
    matching(['a'.repeat(1000)], 'b'.repeat(1000), (s) => s),
    [],
  );
  assert.deepEqual(
    matching(['milk'], '   ', (s) => s),
    [],
  );
});
test('long candidate previews are bounded and do not split Unicode characters', () => {
  const text = preview('😀'.repeat(200));
  assert.equal(Array.from(text).length, 140);
  assert.ok(text.endsWith('…'));
  assert.ok(!text.includes('\uFFFD'));
});
