import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSecret, assertSecretScope } from '../../src/config/secrets.js';
import { readConfig, readWorkerConfig } from '../../src/config/env.js';
import { deletionOverlay, releaseReview } from '../../src/modules/recovery/control.js';

test('mounted secrets reject ambiguous, malformed and oversized sources without exposing their content', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'memorae-secret-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'secret');
  await writeFile(file, 'secret-canary\n');
  assert.equal(readSecret('KEY', { KEY_FILE: file }), 'secret-canary');
  assert.throws(
    () => readSecret('KEY', { KEY: 'direct-canary', KEY_FILE: file }),
    /Ambiguous secret: KEY/,
  );
  await writeFile(file, 'secret-canary\nbad');
  assert.throws(
    () => readSecret('KEY', { KEY_FILE: file }),
    (error) => error instanceof Error && error.message === 'Cannot read secret: KEY',
  );
  await writeFile(file, 'x'.repeat(16385));
  assert.throws(() => readSecret('KEY', { KEY_FILE: file }));
  assert.throws(() => readSecret('KEY', { KEY_FILE: 'relative-private-path' }));
});
test('staging process scopes reject administrator and other component credentials', () => {
  const worker = { DEPLOYMENT_ENV: 'staging', WORKER_DATABASE_URL_FILE: '/run/secrets/worker' };
  assert.doesNotThrow(() => assertSecretScope('worker', worker));
  for (const key of [
    'DATABASE_URL',
    'INGRESS_DATABASE_URL',
    'MONITOR_DATABASE_URL',
    'WHATSAPP_APP_SECRET',
    'MODEL_API_KEY',
  ])
    assert.throws(() => assertSecretScope('worker', { ...worker, [`${key}_FILE`]: '/secret' }));
  assert.throws(() => assertSecretScope('worker', { ...worker, WORKER_DATABASE_URL: 'bad' }));
  assert.throws(() => assertSecretScope('api', worker));
});
test('synthetic staging keeps paid models and production activation closed; worker needs no webhook secrets', () => {
  const mode = {
    NODE_ENV: 'production',
    DEPLOYMENT_ENV: 'staging',
    STAGING_SYNTHETIC_ONLY: 'true',
  };
  assert.equal(readWorkerConfig(mode).MODEL_MODE, 'disabled');
  assert.throws(() => readWorkerConfig({ ...mode, STAGING_SYNTHETIC_ONLY: 'false' }));
  assert.throws(() => readWorkerConfig({ ...mode, MODEL_MODE: 'fixture' }));
  assert.throws(() => readWorkerConfig({ NODE_ENV: 'production' }));
  assert.throws(() => readWorkerConfig({ ...mode, DEPLOYMENT_ENV: 'production' }));
  const api = {
    ...mode,
    WHATSAPP_APP_SECRET: 'synthetic-secret-long',
    WHATSAPP_VERIFY_TOKEN: 'synthetic-token-long',
  };
  assert.throws(() => readConfig(api), /synthetic business phone/);
  assert.equal(
    readConfig({ ...api, WHATSAPP_PHONE_NUMBER_ID: 'staging-synthetic' }).DEPLOYMENT_ENV,
    'staging',
  );
});
test('restore evidence requires an exact schema and explicit review for the current session', () => {
  assert.equal(deletionOverlay.safeParse({ version: 'anything', fingerprints: [] }).success, false);
  assert.equal(
    releaseReview.safeParse({
      sessionId: 'e4df1e3d-640c-4d06-b77a-d31811cf784e',
      externalOutcomesReviewed: true,
      pendingWorkReviewed: true,
      deletionRecordsReviewed: false,
    }).success,
    false,
  );
  assert.equal(
    releaseReview.safeParse({
      sessionId: 'e4df1e3d-640c-4d06-b77a-d31811cf784e',
      externalOutcomesReviewed: true,
      pendingWorkReviewed: true,
      deletionRecordsReviewed: true,
    }).success,
    true,
  );
});
