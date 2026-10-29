import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { RuntimeTelemetry, type TelemetryBatch } from '../../src/modules/telemetry/runtime.js';
import { activeRules, rules, type Signals } from '../../src/modules/telemetry/rules.js';
import { buildApp } from '../../src/api/app.js';
import { readConfig } from '../../src/config/env.js';

test('fixed HTTP buckets preserve boundaries and exclude arbitrary labels', async () => {
  const batches: TelemetryBatch[] = [];
  const recorder = new RuntimeTelemetry('api', async (b) => {
    batches.push(b);
  });
  for (const [status, ms] of [
    [200, 50],
    [400, 200],
    [503, 1000],
    [429, 1001],
  ])
    recorder.http(status!, ms!);
  assert.throws(() => recorder.add('phone_15555555555'));
  assert.throws(() => recorder.add('requests', -1));
  await recorder.flush();
  assert.deepEqual(batches[0]!.counts, {
    requests: 4,
    success: 1,
    client_error: 2,
    server_error: 1,
    overload: 1,
    latency_50: 1,
    latency_200: 1,
    latency_1000: 1,
    latency_slow: 1,
  });
});
test('ambiguous and simultaneous flushes retain one batch ID and preserve later counters', async () => {
  const batches: TelemetryBatch[] = [];
  let fail = true;
  const recorder = new RuntimeTelemetry('worker', async (b) => {
    batches.push(b);
    if (fail) throw new Error('private transport detail');
  });
  recorder.add('cycle_failed');
  assert.deepEqual(await Promise.all([recorder.flush(), recorder.flush()]), [false, false]);
  recorder.add('cycles', 2);
  fail = false;
  assert.equal(await recorder.flush(), true);
  assert.equal(batches[0]!.id, batches[1]!.id);
  assert.deepEqual(batches[1]!.counts, { cycle_failed: 1 });
  await recorder.flush();
  assert.deepEqual(batches[2]!.counts, { cycles: 2 });
  assert.notEqual(batches[2]!.id, batches[1]!.id);
});
test('telemetry failures are contained and long outages have bounded buffers', async () => {
  const recorder = new RuntimeTelemetry('worker', () => {
    throw new Error('secret');
  });
  recorder.add('cycles', 1_000_000_000);
  recorder.add('cycles', 1_000_000_000);
  assert.equal(await recorder.flush(), false);
  const batches: TelemetryBatch[] = [];
  const bounded = new RuntimeTelemetry('worker', async (b) => {
    batches.push(b);
  });
  bounded.add('cycles', 1_000_000_000);
  bounded.add('cycles', 1);
  await bounded.flush();
  assert.equal(batches[0]!.counts.cycles, 1_000_000_000);
});
test('alerts require complete valid signals and include a concrete recovery action', () => {
  const signals = Object.fromEntries(Object.keys(rules).map((k) => [k, 0])) as Signals;
  assert.deepEqual(activeRules(signals), []);
  signals.send_unknown = 2;
  assert.deepEqual(activeRules(signals), ['send_unknown']);
  assert.match(rules.send_unknown.action, /never blind retry/);
  signals.work_dead = -1;
  assert.throws(() => activeRules(signals));
  assert.throws(() => activeRules({} as Signals));
});
test('HTTP telemetry and logs exclude content, headers, query secrets and raw failures', async (t) => {
  const secret = 'test-secret-that-must-not-appear';
  const config = readConfig({
    WHATSAPP_APP_SECRET: secret,
    WHATSAPP_VERIFY_TOKEN: secret,
    LOG_LEVEL: 'info',
  });
  let logs = '';
  const batches: TelemetryBatch[] = [];
  const recorder = new RuntimeTelemetry('api', async (b) => {
    batches.push(b);
  });
  const app = buildApp(
    config,
    {
      ready: async () => true,
      persist: async () => {
        throw new Error('database password secret-canary');
      },
    },
    recorder,
    {
      write: (chunk) => {
        logs += chunk;
      },
    },
  );
  t.after(() => app.close());
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'account-canary',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: { phone_number_id: 'phone-canary' },
              messages: [
                {
                  id: 'provider-canary',
                  from: 'sender-canary',
                  type: 'text',
                  timestamp: '1793102400',
                  text: { body: 'message-canary' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const response = await app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp?private=query-canary',
    payload,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer header-canary',
      'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`,
    },
  });
  assert.equal(response.statusCode, 503);
  await app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    payload: 'x',
    headers: { 'content-type': 'private-canary' },
  });
  await app.inject({ url: '/missing?private=route-canary' });
  await recorder.flush();
  assert.equal(batches[0]!.counts.server_error, 1);
  assert.equal(batches[0]!.counts.requests, 2);
  assert.doesNotMatch(logs + JSON.stringify(batches), /canary|test-secret-that-must-not-appear/);
  assert.match(logs, /webhook persistence failed/);
});
