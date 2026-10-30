import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { docker } from './lib/docker.js';

// Only synthetic traffic to loopback. Never read development or provider credentials.
const port = Number(process.env.STAGING_PORT ?? 33354);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid staging port');
const base = `http://127.0.0.1:${port}`;
const message = `staging-smoke-${randomBytes(12).toString('hex')}`;
const secret = (await readFile('.staging-local/whatsapp_app_secret', 'utf8')).trim();
const body = JSON.stringify({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'staging',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: 'staging-synthetic' },
            messages: [
              {
                id: message,
                from: message,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: 'Hello, synthetic staging test' },
              },
            ],
          },
        },
      ],
    },
  ],
});
for (const path of ['/health/live', '/health/ready'])
  assert.equal((await fetch(base + path, { signal: AbortSignal.timeout(5000) })).status, 200);
const send = (signature: string) =>
  fetch(base + '/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body,
    signal: AbortSignal.timeout(5000),
  });
assert.equal((await send('sha256=' + '0'.repeat(64))).status, 401);
const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
assert.equal((await send(signature)).status, 200);
assert.equal((await send(signature)).status, 200);
let processed = false;
for (let i = 0; i < 60; i++) {
  const result = await docker(
    [
      'compose',
      '-f',
      'compose.staging.yaml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-X',
      '-U',
      'memorae',
      '-d',
      'memorae_staging',
      '-Atq',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    `SELECT count(*) FROM ingress_events e JOIN identity_results i ON i.event_id=e.id
    JOIN work_outbox w ON w.event_id=e.id WHERE e.provider_message_id='${message}' AND w.status='completed';`,
  );
  if (result === '1') {
    processed = true;
    break;
  }
  await setTimeout(1000);
}
assert.equal(
  processed,
  true,
  'Signed event must be deduplicated and processed by the staging worker',
);
console.log(
  'Staging smoke passed: readiness, invalid-signature rejection, signed replay and worker processing. One synthetic onboarding record retained; no external calls.',
);
