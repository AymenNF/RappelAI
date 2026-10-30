import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { docker } from './lib/docker.js';
const id = randomBytes(6).toString('hex'),
  prefix = `memorae-drill-${id}`;
const directory = resolve('.restore-drills', id),
  source = `${prefix}-source`,
  target = `${prefix}-restore`;
const image = process.env.MEMORAE_IMAGE ?? 'memorae-staging:local';
const volumes = ['source', 'wal', 'base', 'restore'].map((n) => `${prefix}-${n}`);
const label = `memorae.drill=${id}`;
const began = Date.now();
let phase = 'prepare';
await mkdir(directory, { recursive: true, mode: 0o700 });
const password = randomBytes(32).toString('hex');
await writeFile(resolve(directory, 'password'), password, { flag: 'wx', mode: 0o444 });
for (const name of [source, target])
  await writeFile(
    resolve(directory, name),
    `postgresql://memorae:${password}@${name}:5432/memorae_staging`,
    { flag: 'wx', mode: 0o444 },
  );
const mount = (src: string, dest: string, readonly = false) => [
  '--mount',
  `type=bind,source=${src},target=${dest}${readonly ? ',readonly' : ''}`,
];
const volume = (src: string, dest: string, readonly = false) => [
  '--mount',
  `type=volume,source=${src},target=${dest}${readonly ? ',readonly' : ''}`,
];
const sql = (container: string, text: string) =>
  docker(
    [
      'exec',
      '-i',
      container,
      'psql',
      '-X',
      '-U',
      'memorae',
      '-d',
      'memorae_staging',
      '-v',
      'ON_ERROR_STOP=1',
      '-Atq',
    ],
    text,
  );
const app = (host: string, script: string, ...args: string[]) =>
  docker([
    'run',
    '--rm',
    '--network',
    prefix,
    '--label',
    label,
    '--read-only',
    '--tmpfs',
    '/tmp',
    '--cap-drop',
    'ALL',
    ...mount(resolve(directory, host), '/run/secrets/db', true),
    ...(args[0] === 'verify'
      ? mount(resolve(directory, 'deletions.json'), '/evidence/deletions.json', true)
      : []),
    '-e',
    'DATABASE_URL_FILE=/run/secrets/db',
    '-e',
    'STAGING_SYNTHETIC_ONLY=true',
    image,
    'node',
    `dist/ops/${script}.js`,
    ...args,
  ]);
const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 90; i++) {
    if (await fn().catch(() => false)) return;
    await setTimeout(1000);
  }
  throw new Error('Timed out waiting for PostgreSQL/archive');
};
try {
  await docker(['network', 'create', '--internal', '--label', label, prefix]);
  for (const name of volumes) await docker(['volume', 'create', '--label', label, name]);
  await docker([
    'run',
    '--rm',
    ...volume(volumes[1]!, '/wal-archive'),
    ...volume(volumes[2]!, '/basebackup'),
    'pgvector/pgvector:pg16',
    'sh',
    '-c',
    'chown postgres:postgres /wal-archive /basebackup',
  ]);
  phase = 'source';
  console.log('Starting isolated synthetic restore source.');
  await docker([
    'run',
    '-d',
    '--name',
    source,
    '--label',
    label,
    '--network',
    prefix,
    ...volume(volumes[0]!, '/var/lib/postgresql/data'),
    ...volume(volumes[1]!, '/wal-archive'),
    ...volume(volumes[2]!, '/basebackup'),
    ...mount(resolve(directory, 'password'), '/run/secrets/db', true),
    ...mount(resolve('deploy/backup/archive-wal.sh'), '/archive-wal.sh', true),
    '-e',
    'POSTGRES_USER=memorae',
    '-e',
    'POSTGRES_DB=memorae_staging',
    '-e',
    'POSTGRES_PASSWORD_FILE=/run/secrets/db',
    'pgvector/pgvector:pg16',
    'postgres',
    '-c',
    'wal_level=replica',
    '-c',
    'archive_mode=on',
    '-c',
    'archive_command=sh /archive-wal.sh %p %f',
  ]);
  await waitFor(async () => (await sql(source, 'SELECT 1')) === '1');
  await app(source, 'migrate');
  await app(source, 'restore-fixture', 'seed');
  phase = 'base-backup';
  console.log('Taking and verifying a physical base backup.');
  await docker([
    'exec',
    '-u',
    'postgres',
    source,
    'pg_basebackup',
    '-U',
    'memorae',
    '-D',
    '/basebackup',
    '-X',
    'stream',
    '-c',
    'fast',
  ]);
  await docker(['exec', '-u', 'postgres', source, 'pg_verifybackup', '/basebackup']);
  await sql(source, "INSERT INTO drill_markers VALUES('after-base')");
  const restorePoint = `memorae_target_${id}`;
  const wal = await sql(
    source,
    `SELECT pg_walfile_name(pg_create_restore_point('${restorePoint}'));`,
  );
  await sql(source, "INSERT INTO drill_markers VALUES('after-target'); SELECT pg_switch_wal();");
  await waitFor(async () => {
    await docker(['exec', source, 'test', '-f', `/wal-archive/${wal}`]);
    return true;
  });
  const overlay = JSON.parse(await app(source, 'restore-fixture', 'delete-overlay'));
  await writeFile(resolve(directory, 'deletions.json'), JSON.stringify(overlay), {
    flag: 'wx',
    mode: 0o444,
  });
  phase = 'restore';
  const restoreBegan = Date.now();
  console.log('Recovering a separate PostgreSQL volume to the named restore point.');
  await docker([
    'run',
    '--rm',
    ...volume(volumes[2]!, '/backup', true),
    ...volume(volumes[3]!, '/restore'),
    'pgvector/pgvector:pg16',
    'sh',
    '-c',
    'test ! -f /restore/PG_VERSION && cp -a /backup/. /restore/ && touch /restore/recovery.signal && chown postgres:postgres /restore/recovery.signal && chmod 700 /restore',
  ]);
  await docker([
    'run',
    '-d',
    '--name',
    target,
    '--label',
    label,
    '--network',
    prefix,
    ...volume(volumes[3]!, '/var/lib/postgresql/data'),
    ...volume(volumes[1]!, '/wal-archive', true),
    'pgvector/pgvector:pg16',
    'postgres',
    '-c',
    'archive_mode=off',
    '-c',
    'restore_command=cp /wal-archive/%f %p',
    '-c',
    `recovery_target_name=${restorePoint}`,
    '-c',
    'recovery_target_action=pause',
    '-c',
    'memorae.recovery_target=on',
    '-c',
    `memorae.recovery_instance=${randomUUID()}`,
  ]);
  await waitFor(
    async () => (await sql(target, 'SELECT pg_get_wal_replay_pause_state()')) === 'paused',
  );
  assert.equal(
    await sql(target, "SELECT string_agg(name,',' ORDER BY name) FROM drill_markers"),
    'after-base',
  );
  assert.equal(await sql(target, 'SELECT pg_is_in_recovery()'), 't');
  await sql(target, 'SELECT pg_promote(true,30)');
  phase = 'quarantine-and-review';
  const verification = JSON.parse(await app(target, 'restore-fixture', 'verify'));
  assert.equal(
    await sql(source, "SELECT count(*) FROM drill_markers WHERE name='after-target'"),
    '1',
  );
  const report = {
    version: 'restore-drill-v1',
    id,
    passed: true,
    imageId: await docker(['image', 'inspect', image, '--format', '{{.Id}}']),
    restorePoint,
    systemIdentifier: overlay.systemIdentifier,
    restoreSeconds: (Date.now() - restoreBegan) / 1000,
    totalSeconds: (Date.now() - began) / 1000,
    verification,
    limits: [
      'Local same-host exercise; no off-site backup or production RPO/RTO guarantee',
      'Synthetic provider evidence only; no external sends',
    ],
  };
  await writeFile(resolve(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(resolve(directory, 'failure.json'), JSON.stringify({ phase, passed: false }), {
    mode: 0o600,
  });
  // Docker output here is only from newly created synthetic containers; no real app secrets are used.
  console.error(
    `Restore drill failed at ${phase}: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
} finally {
  // Exact generated names and labels only. Never touch the development or staging volumes.
  for (const name of [source, target]) {
    const owned = await docker([
      'inspect',
      '--format',
      '{{index .Config.Labels "memorae.drill"}}',
      name,
    ]).catch(() => null);
    if (owned === id) await docker(['rm', '-f', name]);
  }
  for (const name of volumes) {
    const owned = await docker([
      'volume',
      'inspect',
      '--format',
      '{{index .Labels "memorae.drill"}}',
      name,
    ]).catch(() => null);
    if (owned === id) await docker(['volume', 'rm', name]);
  }
  const owned = await docker([
    'network',
    'inspect',
    '--format',
    '{{index .Labels "memorae.drill"}}',
    prefix,
  ]).catch(() => null);
  if (owned === id) await docker(['network', 'rm', prefix]);
}
