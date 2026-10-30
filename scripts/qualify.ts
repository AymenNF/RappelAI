import assert from 'node:assert/strict';
import { randomBytes, createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { docker } from './lib/docker.js';
import { measure } from './lib/load.js';
import {
  assessQualification,
  type QualificationReport,
} from '../src/modules/qualification/report.js';

// All targets are generated here. No arbitrary URL, existing database or staging secrets accepted.
const id = randomBytes(6).toString('hex'),
  prefix = `memorae-qual-${id}`;
const directory = resolve('.qualification', id),
  image = process.env.MEMORAE_IMAGE ?? 'memorae-staging:local';
const privateNet = `${prefix}-private`,
  edgeNet = `${prefix}-edge`,
  volume = `${prefix}-data`;
const db = `${prefix}-postgres`,
  label = `memorae.qualification=${id}`;
const containers = new Set<string>();
const secret = randomBytes(32).toString('hex'),
  password = randomBytes(32).toString('hex');
await mkdir(directory, { recursive: true, mode: 0o700 });
const secrets: Record<string, string> = {
  postgres_password: password,
  admin_database_url: `postgresql://memorae:${password}@${db}:5432/memorae_staging`,
  whatsapp_app_secret: secret,
  whatsapp_verify_token: randomBytes(32).toString('hex'),
};
for (const role of ['ingress', 'worker', 'monitor'])
  secrets[`${role}_database_url`] =
    `postgresql://memorae_stage_${role}:${randomBytes(32).toString('hex')}@${db}:5432/memorae_staging`;
for (const [name, value] of Object.entries(secrets))
  await writeFile(resolve(directory, name), value, { flag: 'wx', mode: 0o444 });
const report: QualificationReport = {
  version: 'qualification-v1',
  id,
  createdAt: new Date().toISOString(),
  imageId: await docker(['image', 'inspect', image, '--format', '{{.Id}}']),
  revision: await docker([
    'image',
    'inspect',
    image,
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
  ]),
  syntheticOnly: true,
  externalProviderCalls: 0,
  scenarios: [],
  profiles: [],
  cleanupPassed: false,
};
const mounts = (keys: string[]) =>
  keys.flatMap((key) => [
    '--mount',
    `type=bind,source=${resolve(directory, key)},target=/run/secrets/${key},readonly`,
  ]);
const environment = [
  'NODE_ENV=production',
  'DEPLOYMENT_ENV=staging',
  'STAGING_SYNTHETIC_ONLY=true',
  'MODEL_MODE=disabled',
  `QUALIFICATION_RUN=${id}`,
];
const appArgs = (keys: string[], env: string[] = []) => [
  '--network',
  privateNet,
  '--label',
  label,
  '--read-only',
  '--tmpfs',
  '/tmp',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  ...mounts(keys),
  ...[...environment, ...env].flatMap((value) => ['-e', value]),
];
const start = async (
  name: string,
  script: string,
  args: string[],
  keys: string[],
  env: string[],
  publish = false,
) => {
  const full = `${prefix}-${name}`;
  containers.add(full);
  await docker([
    'create',
    '--name',
    full,
    ...appArgs(keys, env),
    ...(publish ? ['-p', '127.0.0.1::3000'] : []),
    image,
    'node',
    `dist/${script}.js`,
    ...args,
  ]);
  if (publish) await docker(['network', 'connect', edgeNet, full]);
  await docker(['start', full]);
  return full;
};
const once = (script: string, args: string[], keys: string[], env: string[]) =>
  docker(['run', '--rm', ...appArgs(keys, env), image, 'node', `dist/${script}.js`, ...args]);
const adminEnv = ['DATABASE_URL_FILE=/run/secrets/admin_database_url'];
const workerEnv = [
  'WORKER_DATABASE_URL_FILE=/run/secrets/worker_database_url',
  'WORKER_POLL_INTERVAL_MS=1000',
];
const fixture = (args: string[], admin = false) =>
  once(
    'ops/qualification-fixture',
    args,
    [admin ? 'admin_database_url' : 'worker_database_url'],
    admin ? adminEnv : workerEnv,
  );
const monitor = async (...args: string[]) =>
  JSON.parse(
    await once(
      'ops/main',
      args,
      ['monitor_database_url'],
      ['MONITOR_DATABASE_URL_FILE=/run/secrets/monitor_database_url'],
    ),
  );
const sql = (query: string) =>
  docker(
    [
      'exec',
      '-i',
      db,
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
    query,
  );
const waitFor = async (fn: () => Promise<boolean>, timeout = 60000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn().catch(() => false)) return;
    await setTimeout(500);
  }
  throw new Error('Qualification condition timed out');
};
let base = '',
  phase = 'setup';
const send = async (key: string) => {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'synthetic',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: 'staging-synthetic' },
              messages: [
                {
                  id: key,
                  from: key,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: 'Synthetic qualification hello' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const response = await fetch(base + '/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', secret).update(body).digest('hex'),
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  await response.arrayBuffer();
  return response.status;
};
const healthy = async () => {
  const r = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(6000) });
  await r.arrayBuffer();
  return r.status === 200;
};
const exercise = async (
  name: QualificationReport['scenarios'][number]['id'],
  operation: () => Promise<void>,
) => {
  phase = name;
  console.log(`Exercise: ${name}`);
  const began = performance.now();
  try {
    await operation();
    report.scenarios.push({ id: name, passed: true, milliseconds: performance.now() - began });
  } catch (e) {
    report.scenarios.push({ id: name, passed: false, milliseconds: performance.now() - began });
    throw e;
  }
};
try {
  console.log('Creating a disposable qualification environment.');
  await docker(['network', 'create', '--internal', '--label', label, privateNet]);
  await docker(['network', 'create', '--label', label, edgeNet]);
  await docker(['volume', 'create', '--label', label, volume]);
  containers.add(db);
  await docker([
    'run',
    '-d',
    '--name',
    db,
    '--label',
    label,
    '--network',
    privateNet,
    '--mount',
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    ...mounts(['postgres_password']),
    '-e',
    'POSTGRES_USER=memorae',
    '-e',
    'POSTGRES_DB=memorae_staging',
    '-e',
    'POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password',
    'pgvector/pgvector:pg16',
  ]);
  await waitFor(async () => (await sql('SELECT 1')) === '1');
  await once('ops/migrate', [], ['admin_database_url'], adminEnv);
  await once(
    'ops/provision-staging',
    [],
    ['admin_database_url', 'ingress_database_url', 'worker_database_url', 'monitor_database_url'],
    [
      ...adminEnv,
      ...['ingress', 'worker', 'monitor'].map(
        (role) => `${role.toUpperCase()}_DATABASE_URL_FILE=/run/secrets/${role}_database_url`,
      ),
    ],
  );
  const api = await start(
    'api',
    'api/main',
    [],
    ['ingress_database_url', 'whatsapp_app_secret', 'whatsapp_verify_token'],
    [
      'INGRESS_DATABASE_URL_FILE=/run/secrets/ingress_database_url',
      'WHATSAPP_APP_SECRET_FILE=/run/secrets/whatsapp_app_secret',
      'WHATSAPP_VERIFY_TOKEN_FILE=/run/secrets/whatsapp_verify_token',
      'WHATSAPP_PHONE_NUMBER_ID=staging-synthetic',
    ],
    true,
  );
  const binding = await docker(['port', api, '3000/tcp']);
  if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Loopback binding required');
  base = `http://${binding}`;
  await waitFor(healthy);
  await exercise('signed_replay', async () => {
    assert.deepEqual(
      await Promise.all(Array.from({ length: 8 }, () => send('qual-replay'))),
      Array(8).fill(200),
    );
    assert.equal(
      await sql("SELECT count(*) FROM ingress_events WHERE provider_message_id='qual-replay'"),
      '1',
    );
    assert.equal(
      await sql(
        "SELECT count(*) FROM work_outbox w JOIN ingress_events e ON e.id=w.event_id WHERE e.provider_message_id='qual-replay'",
      ),
      '1',
    );
  });
  await exercise('database_outage', async () => {
    await docker(['stop', '-t', '5', db]);
    const r = await fetch(base + '/health/ready', { signal: AbortSignal.timeout(6000) });
    await r.arrayBuffer();
    assert.equal(r.status, 503);
    assert.equal(await send('qual-db-outage'), 503);
    await docker(['start', db]);
    await waitFor(healthy);
    assert.equal(await send('qual-db-outage'), 200);
    assert.equal(
      await sql("SELECT count(*) FROM ingress_events WHERE provider_message_id='qual-db-outage'"),
      '1',
    );
  });
  await exercise('api_restart', async () => {
    await docker(['kill', '--signal', 'KILL', api]);
    await docker(['start', api]);
    // Docker may allocate a different ephemeral host port when restarting a container.
    const restartedBinding = await docker(['port', api, '3000/tcp']);
    if (!/^127\.0\.0\.1:\d+$/.test(restartedBinding)) throw new Error('Loopback binding required');
    base = `http://${restartedBinding}`;
    await waitFor(healthy);
    assert.equal(await send('qual-replay'), 200);
    assert.equal(
      await sql("SELECT count(*) FROM ingress_events WHERE provider_message_id='qual-replay'"),
      '1',
    );
  });
  let worker = '';
  await exercise('monitor_recovery', async () => {
    await monitor('expect', 'api', 'on');
    await monitor('expect', 'worker', 'on');
    assert.equal((await monitor('check')).snapshot.signals.worker_missing, 1);
    worker = await start('worker', 'worker/main', [], ['worker_database_url'], workerEnv);
    await waitFor(
      async () => (await sql("SELECT count(*) FROM work_outbox WHERE status<>'completed'")) === '0',
    );
    assert.equal((await monitor('check')).snapshot.signals.worker_missing, 0);
    await docker(['stop', '-t', '10', worker]);
  });
  for (const when of ['before', 'after'] as const)
    await exercise(when === 'before' ? 'transaction_crash' : 'post_commit_crash', async () => {
      await fixture(['seed', when], true);
      const crash = await start(
        `crash-${when}`,
        'ops/qualification-fixture',
        [when],
        ['worker_database_url'],
        workerEnv,
      );
      await waitFor(async () =>
        (await docker(['logs', crash])).includes(
          when === 'before' ? 'effects_uncommitted' : 'effects_committed',
        ),
      );
      await docker(['kill', '--signal', 'KILL', crash]);
      assert.equal(
        await sql(`SELECT count(*) FROM list_items WHERE text='item-${when}'`),
        when === 'before' ? '0' : '1',
      );
      await docker(['start', worker]);
      await waitFor(
        async () =>
          (await sql("SELECT count(*) FROM work_outbox WHERE status<>'completed'")) === '0',
      );
      assert.equal(await sql(`SELECT count(*) FROM list_items WHERE text='item-${when}'`), '1');
      assert.equal(
        await sql(
          `SELECT count(*) FROM action_receipts a JOIN ingress_events e ON e.id=a.event_id WHERE e.event_key='qual-${when}'`,
        ),
        '1',
      );
      await docker(['stop', '-t', '10', worker]);
    });
  await docker(['start', worker]);
  await exercise('unknown_send_crash', async () => {
    await fixture(['seed', 'send'], true);
    const provider = await start('provider', 'ops/qualification-fixture', ['provider'], [], []);
    const count = () =>
      docker([
        'exec',
        provider,
        'node',
        '-e',
        "fetch('http://127.0.0.1:3001/count').then(r=>r.text()).then(console.log)",
      ]);
    await waitFor(async () => (await count()) === '0');
    const sender = await start(
      'sender',
      'ops/qualification-fixture',
      ['send'],
      ['worker_database_url'],
      workerEnv,
    );
    await waitFor(async () => (await count()) === '1');
    await docker(['kill', '--signal', 'KILL', sender]);
    assert.equal(JSON.parse(await fixture(['recover-send'])).state, 'dispatching');
    await waitFor(
      async () => (await sql('SELECT state FROM whatsapp_attempts')) === 'unknown',
      70000,
    );
    assert.equal(JSON.parse(await fixture(['recover-send'])).state, 'unknown');
    assert.equal(await count(), '1');
    assert.equal(await sql('SELECT count(*) FROM whatsapp_attempts'), '1');
    assert.ok(
      (await monitor('queue', 'send', '10')).items.some((r: { state: string }) =>
        r.state.startsWith('unknown'),
      ),
    );
    await sql('UPDATE usage_policy SET enabled=false');
  });
  await exercise('load_drain', async () => {
    for (const profile of [
      { name: 'serial' as const, requests: 60, concurrency: 1 },
      { name: 'concurrent' as const, requests: 240, concurrency: 8 },
    ]) {
      const key = `load-${profile.name}-`;
      console.log(
        `Load: ${profile.requests} signed unique events, concurrency ${profile.concurrency}`,
      );
      const measured = await measure(profile.requests, profile.concurrency, (i) =>
        send(`${key}${i}`),
      );
      const drainStart = performance.now();
      const completed = () =>
        sql(
          `SELECT count(*) FROM ingress_events e JOIN work_outbox w ON w.event_id=e.id JOIN identity_results i ON i.event_id=e.id WHERE e.provider_message_id LIKE '${key}%' AND w.status='completed'`,
        );
      const observation = {
        name: profile.name,
        concurrency: profile.concurrency,
        ...measured,
        persisted: 0,
        completed: 0,
        drainMs: 0,
      };
      report.profiles.push(observation);
      try {
        await waitFor(async () => (await completed()) === String(profile.requests));
      } finally {
        // Keep failed request timings even when the drain deadline or database check fails.
        observation.drainMs = performance.now() - drainStart;
        observation.persisted = Number(
          await sql(
            `SELECT count(*) FROM ingress_events WHERE provider_message_id LIKE '${key}%'`,
          ).catch(() => '0'),
        );
        observation.completed = Number(await completed().catch(() => '0'));
      }
      assert.equal(measured.successes, profile.requests);
    }
    assert.equal(await sql('SELECT enabled FROM usage_policy'), 'f');
  });
} catch (error) {
  await writeFile(
    resolve(directory, 'failure.json'),
    JSON.stringify({ phase, error: error instanceof Error ? error.message : 'Unknown error' }),
    { mode: 0o600 },
  );
  console.error(
    `Qualification failed during ${phase}; inspect the sanitized report. No success is asserted for missing scenarios.`,
  );
  process.exitCode = 1;
} finally {
  let cleaned = true;
  for (const name of containers) {
    try {
      const owner = await docker([
        'inspect',
        '--format',
        '{{index .Config.Labels "memorae.qualification"}}',
        name,
      ]).catch(() => null);
      if (owner === id) await docker(['rm', '-f', name]);
      else if (owner !== null) cleaned = false;
    } catch {
      cleaned = false;
    }
  }
  for (const [kind, name] of [
    ['volume', volume],
    ['network', privateNet],
    ['network', edgeNet],
  ]) {
    try {
      const owner = await docker([
        kind!,
        'inspect',
        '--format',
        '{{index .Labels "memorae.qualification"}}',
        name!,
      ]).catch(() => null);
      if (owner === id) await docker([kind!, 'rm', name!]);
      else if (owner !== null) cleaned = false;
    } catch {
      cleaned = false;
    }
  }
  // An unavailable Docker daemon is not proof that cleanup succeeded.
  try {
    for (const args of [
      ['ps', '-aq'],
      ['volume', 'ls', '-q'],
      ['network', 'ls', '-q'],
    ])
      if (await docker([...args, '--filter', `label=${label}`])) cleaned = false;
  } catch {
    cleaned = false;
  }
  report.cleanupPassed = cleaned;
  report.createdAt = new Date().toISOString();
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  const assessment = assessQualification(report);
  if (!assessment.functionalPassed) process.exitCode = 1;
  console.log(
    JSON.stringify(
      { report: resolve(directory, 'report.json'), ...assessment, profiles: report.profiles },
      null,
      2,
    ),
  );
}
