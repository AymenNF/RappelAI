import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifiedBackup } from '../../scripts/lib/verified-backup.js';

test('backup verification failures never report success or run later verification steps', async () => {
  for (const [failure, reason] of [
    ['create', 'backup_failed'],
    ['verifyManifest', 'manifest_failed'],
    ['archiveWal', 'archive_timeout'],
    ['saveEvidence', 'evidence_failed'],
  ] as const) {
    const calls: string[] = [];
    const step = (name: string) => async () => {
      calls.push(name);
      if (name === failure) throw new Error('private diagnostic');
    };
    await assert.rejects(
      verifiedBackup({
        start: step('start'),
        create: step('create'),
        verifyManifest: step('verifyManifest'),
        archiveWal: step('archiveWal'),
        saveEvidence: step('saveEvidence'),
        finish: async (state, code) => {
          calls.push(`${state}:${code}`);
        },
      }),
      new RegExp(reason),
    );
    assert.equal(calls.at(-1), `failed:${reason}`);
    assert.ok(!calls.some((c) => c.startsWith('verified')));
    assert.equal(
      calls.length,
      ['create', 'verifyManifest', 'archiveWal', 'saveEvidence'].indexOf(failure) + 3,
    );
  }
});
test('backup registration and final acknowledgement failures cannot look successful', async () => {
  const calls: string[] = [];
  const noop = async () => {};
  const steps = {
    start: noop,
    create: async () => {
      calls.push('created');
    },
    verifyManifest: noop,
    archiveWal: noop,
    saveEvidence: noop,
    finish: async (state: string) => {
      calls.push(state);
      throw new Error('database unavailable');
    },
  };
  await assert.rejects(
    verifiedBackup({
      ...steps,
      start: async () => {
        throw new Error('registration unavailable');
      },
    }),
  );
  assert.deepEqual(calls, []);
  await assert.rejects(verifiedBackup(steps), /evidence_failed/);
  assert.deepEqual(calls, ['created', 'verified', 'failed']);
});
test('backup success follows manifest verification, WAL archival and saved evidence', async () => {
  const calls: string[] = [];
  const step = (name: string) => async () => {
    calls.push(name);
  };
  await verifiedBackup({
    start: step('start'),
    create: step('create'),
    verifyManifest: step('manifest'),
    archiveWal: step('archive'),
    saveEvidence: step('evidence'),
    finish: async (state, reason) => {
      assert.equal(reason, null);
      calls.push(state);
    },
  });
  assert.deepEqual(calls, ['start', 'create', 'manifest', 'archive', 'evidence', 'verified']);
});
