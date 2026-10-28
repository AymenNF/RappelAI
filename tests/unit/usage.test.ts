import { test } from 'node:test';
import assert from 'node:assert/strict';
import { micros, tokenCost } from '../../src/modules/usage/money.js';

test('costs use exact integer arithmetic and round up once per attempt', () => {
  assert.equal(tokenCost(1, 0, 1n, 0n), 1n);
  assert.equal(tokenCost(1, 1, 500000n, 500000n), 1n);
  assert.equal(tokenCost(3, 2, 1000000n, 2000000n), 7n);
  assert.equal(tokenCost(999999, 1000000, 9000000000n, 9000000000n), 17999991000n);
  assert.equal(tokenCost(100000, 2000, 0n, 0n), 0n);
});
test('money rejects floating point, negative, non-finite and excessive values', () => {
  for (const input of ['1.5', '-1', '1e6', 'NaN', '9000000000000001'])
    assert.throws(() => micros(input));
  assert.equal(micros('1000000'), 1000000n);
  assert.throws(() => tokenCost(NaN, 1, 1n, 1n));
  assert.throws(() => tokenCost(1.5, 1, 1n, 1n));
  assert.throws(() => tokenCost(1, 1, -1n, 1n));
  assert.throws(() => tokenCost(1000000, 1000000, 9000000000000000n, 9000000000000000n));
});
