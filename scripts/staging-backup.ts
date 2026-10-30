import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { docker } from './lib/docker.js';
import { verifiedBackup } from './lib/verified-backup.js';
const name = `base-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(4).toString('hex')}`;
const container = await docker(['compose', '-f', 'compose.staging.yaml', 'ps', '-q', 'postgres']);
if (!/^[a-f0-9]{12,64}$/.test(container))
  throw new Error('Exactly one staging PostgreSQL container must be running');
const label = await docker([
  'inspect',
  '--format',
  '{{index .Config.Labels "com.docker.compose.project"}}',
  container,
]);
if (label !== 'memorae-staging') throw new Error('Staging project identity mismatch');
const query = (sql: string) =>
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
      '-Atq',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    sql,
  );
const runId = randomUUID();
const recorded = (await query("SELECT to_regclass('backup_runs') IS NOT NULL")) === 't';
if (!recorded)
  console.error(
    'Backup monitoring migration is not installed; this backup has file evidence only.',
  );
const report = {
  version: 'staging-backup-v2',
  runId,
  name,
  verified: true,
  walArchived: true,
  recordedInDatabase: recorded,
  createdAt: '',
  storage: 'Local Docker base_backups and wal_archive volumes; not an off-site backup',
};
await verifiedBackup({
  start: async () => {
    if (recorded)
      await query(`INSERT INTO backup_runs(id,backup_name) VALUES('${runId}','${name}')`);
  },
  create: async () => {
    if ((await query('SHOW archive_mode')) !== 'on')
      throw new Error('Continuous archiving required');
    await docker([
      'exec',
      '-u',
      'postgres',
      container,
      'pg_basebackup',
      '-U',
      'memorae',
      '-D',
      `/basebackups/${name}`,
      '-X',
      'stream',
      '-c',
      'fast',
    ]);
  },
  verifyManifest: async () => {
    await docker(['exec', '-u', 'postgres', container, 'pg_verifybackup', `/basebackups/${name}`]);
  },
  archiveWal: async () => {
    const wal = await query('SELECT pg_walfile_name(pg_switch_wal())');
    if (!/^[0-9A-F]{24}$/.test(wal)) throw new Error('Unexpected WAL segment name');
    let archived = false;
    for (let i = 0; i < 60; i++) {
      try {
        await docker(['exec', container, 'test', '-f', `/wal-archive/${wal}`]);
        archived = true;
        break;
      } catch {
        await setTimeout(1000);
      }
    }
    if (!archived) throw new Error('Backup exists but WAL archival verification failed');
  },
  saveEvidence: async () => {
    report.createdAt = new Date().toISOString();
    await writeFile(
      resolve('.staging-local', `${name}.json`),
      JSON.stringify(report, null, 2) + '\n',
      {
        flag: 'wx',
        mode: 0o600,
      },
    );
  },
  finish: async (state, reason) => {
    if (recorded) {
      const result =
        await query(`UPDATE backup_runs SET state='${state}',finished_at=clock_timestamp(),
        manifest_verified=${state === 'verified'},wal_archived=${state === 'verified'},error_code=${reason ? `'${reason}'` : 'NULL'}
        WHERE id='${runId}' AND state='running' RETURNING id`);
      if (result !== runId) throw new Error('Backup registration changed; inspect the run');
    }
  },
});
console.log(JSON.stringify(report, null, 2));
