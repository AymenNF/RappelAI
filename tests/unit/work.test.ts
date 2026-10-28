import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../../src/modules/processing/leases.js';

test('retry delay grows exponentially, jitters and caps at five minutes', () => {
  assert.equal(
    retryDelay(1, () => 0),
    500,
  );
  assert.equal(
    retryDelay(1, () => 1),
    1000,
  );
  assert.equal(
    retryDelay(4, () => 1),
    8000,
  );
  assert.equal(
    retryDelay(1000, () => 1),
    300000,
  );
  assert.equal(
    retryDelay(1000, () => 0),
    150000,
  );
});
