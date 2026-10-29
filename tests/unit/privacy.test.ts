import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privacyCommand } from '../../src/modules/privacy/commands.js';
import { sanitizeExport } from '../../src/modules/privacy/admin.js';
test('privacy commands require separate exact account-deletion confirmation', () => {
  assert.deepEqual(privacyCommand('delete account'), { action: 'offer' });
  assert.deepEqual(privacyCommand('EXPORT DATA'), { action: 'export' });
  assert.deepEqual(privacyCommand('CONFIRM DELETE ' + 'a'.repeat(32)), {
    action: 'confirm',
    reference: 'a'.repeat(32),
  });
  for (const s of ['DELETE ACCOUNT NOW', 'CONFIRM DELETE abc', 'EXPORT OTHER USER'])
    assert.equal(privacyCommand(s)?.action, 'invalid');
  assert.equal(privacyCommand('delete milk'), null);
});
test('export sanitization removes live credentials/control tokens recursively and preserves user content', () => {
  assert.deepEqual(
    sanitizeExport({
      consent_token: 'secret',
      reference: 'button',
      rows: [
        {
          lease_token: 'secret',
          lease_owner: 'host',
          text: 'milk',
          created_at: new Date('2026-10-29T00:00:00Z'),
        },
      ],
    }),
    { rows: [{ text: 'milk', created_at: '2026-10-29T00:00:00.000Z' }] },
  );
});
