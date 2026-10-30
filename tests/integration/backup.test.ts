import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import pg from 'pg';
import { migrateTestSchema } from '../helpers/database.js';
import { OperationsControl } from '../../src/modules/telemetry/control.js';
import { BackupControl } from '../../src/modules/recovery/backup-control.js';

if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL required');
test(
  'backup and archive monitoring with restricted database roles',
  { timeout: 90000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', ''),
      schema = `test_${suffix}`;
    const admin = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c search_path=${schema},public`,
    });
    const pools: pg.Pool[] = [],
      roles: string[] = [];
    const login = async (capability: string) => {
      const role = `test_${capability}_${suffix}`,
        password = randomBytes(24).toString('hex');
      roles.push(role);
      await admin.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
      await admin.query(`GRANT memorae_${capability} TO ${role}`);
      const url = new URL(process.env.TEST_DATABASE_URL!);
      url.username = role;
      url.password = password;
      const pool = new pg.Pool({
        connectionString: url.toString(),
        options: `-c search_path=${schema},public`,
        statement_timeout: 5000,
      });
      pools.push(pool);
      return pool;
    };
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await migrateTestSchema(admin);
      const monitor = await login('monitor'),
        worker = await login('worker'),
        ingress = await login('ingress'),
        tenant = await login('tenant');
      const ops = new OperationsControl(monitor),
        control = new BackupControl(admin);
      const healthy = {
        available: true,
        archiveMode: 'on',
        pendingCount: 0,
        oldestPendingSeconds: 0,
        failureOutstanding: false,
      };
      const probe = async (value: Record<string, unknown>) => {
        await admin.query(
          `CREATE OR REPLACE FUNCTION backup_archive_probe() RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $body$ SELECT '${JSON.stringify(value)}'::jsonb $body$`,
        );
      };
      const reset = async () => {
        await admin.query(
          'TRUNCATE backup_runs,backup_policy_audit,monitoring_alerts,monitoring_events CASCADE',
        );
        await control.change({ enabled: true });
        await probe(healthy);
      };
      const run = async (state: 'running' | 'verified' | 'failed', age: number) => {
        const id = randomUUID(),
          name = `base-2026-10-30T00-00-00-000Z-${randomBytes(4).toString('hex')}`;
        await admin.query(
          `INSERT INTO backup_runs(id,backup_name,state,started_at,finished_at,manifest_verified,wal_archived,error_code)
        VALUES($1,$2,$3,clock_timestamp()-($4+10)*interval '1 second',CASE WHEN $3='running' THEN NULL ELSE clock_timestamp()-$4*interval '1 second' END,$3='verified',$3='verified',CASE WHEN $3='failed' THEN 'manifest_failed' ELSE NULL END)`,
          [id, name, state, age],
        );
        return id;
      };
      await t.test(
        'monitor sees real aggregate archive health without file access or backup mutation privileges',
        async () => {
          await control.change({ enabled: true });
          const real = (await monitor.query('SELECT backup_observation() AS data')).rows[0].data;
          assert.equal(real.archive.available, true);
          assert.ok(['on', 'off', 'always'].includes(real.archive.archiveMode));
          assert.equal(real.offsiteVerified, false);
          assert.equal(real.signals.backup_overdue, 1);
          assert.doesNotMatch(JSON.stringify(real), /password|pg_wal|base-2026|backup_name/);
          await assert.rejects(monitor.query('SELECT backup_archive_probe()'), /permission denied/);
          for (const pool of [monitor, worker, ingress, tenant]) {
            await assert.rejects(pool.query('SELECT * FROM backup_runs'), /permission denied/);
            await assert.rejects(
              pool.query('UPDATE backup_monitoring_policy SET enabled=false'),
              /permission denied/,
            );
            await assert.rejects(new BackupControl(pool).change({ enabled: false }));
          }
          for (const pool of [worker, ingress, tenant])
            await assert.rejects(pool.query('SELECT backup_observation()'), /permission denied/);
          await run('verified', 10);
          const c = await monitor.connect();
          try {
            await c.query('BEGIN');
            await c.query('CREATE TEMP TABLE backup_runs(state text,finished_at timestamptz)');
            assert.equal(
              (await c.query('SELECT backup_observation() AS data')).rows[0].data.latestState,
              'verified',
            );
            await c.query('ROLLBACK');
          } finally {
            c.release();
          }
        },
      );
      await t.test(
        'overdue and failed backups open, deduplicate and resolve alerts only with verified evidence',
        async () => {
          await reset();
          let r = await ops.check();
          assert.equal(r.snapshot.signals.backup_overdue, 1);
          assert.equal((await ops.check()).changes.length, 0);
          await run('verified', 172800);
          await run('running', 1);
          assert.equal((await ops.check()).snapshot.signals.backup_overdue, 1);
          await run('verified', 20);
          r = await ops.check();
          assert.equal(r.snapshot.signals.backup_overdue, 0);
          assert.ok(
            r.changes.some((c) => c.key === 'backup_overdue' && c.transition === 'resolved'),
          );
          await run('failed', 5);
          r = await ops.check();
          assert.equal(r.snapshot.signals.backup_failed, 1);
          await ops.acknowledge('backup_failed', 1);
          assert.equal((await ops.check()).snapshot.signals.backup_failed, 1);
          await run('verified', 0);
          assert.equal((await ops.check()).snapshot.signals.backup_failed, 0);
          await assert.rejects(
            admin.query(`UPDATE backup_runs SET manifest_verified=false WHERE state='verified'`),
            /check constraint/,
          );
        },
      );
      await t.test(
        'overdue running backups require explicit administrator reconciliation; policy changes are audited atomically',
        async () => {
          await reset();
          const old = await run('running', 4000),
            fresh = await run('running', 0);
          assert.equal((await ops.check()).snapshot.signals.backup_stalled, 1);
          await assert.rejects(control.change({ abandon: fresh }), /overdue/);
          await assert.rejects(new BackupControl(monitor).change({ abandon: old }));
          await control.change({ abandon: old });
          assert.equal((await ops.check()).snapshot.signals.backup_stalled, 0);
          assert.equal(
            (await admin.query('SELECT error_code FROM backup_runs WHERE id=$1', [old])).rows[0]
              .error_code,
            'interrupted',
          );
          await assert.rejects(control.change({ abandon: old }), /overdue/);
          await admin.query(
            `CREATE FUNCTION fail_backup_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$`,
          );
          await admin.query(
            'CREATE TRIGGER fail_backup_audit BEFORE INSERT ON backup_policy_audit FOR EACH ROW EXECUTE FUNCTION fail_backup_audit()',
          );
          await assert.rejects(control.change({ enabled: false }), /injected/);
          assert.equal(
            (await monitor.query('SELECT backup_observation() AS data')).rows[0].data.enabled,
            true,
          );
          await admin.query('DROP TRIGGER fail_backup_audit ON backup_policy_audit');
          await control.change({ enabled: false });
          const disabled = await ops.check();
          assert.equal(disabled.snapshot.backup.enabled, false);
          assert.equal(disabled.snapshot.backup.archive, null);
          assert.equal(disabled.snapshot.backup.offsiteVerified, false);
          assert.equal(
            (
              await admin.query(
                'SELECT enabled FROM backup_policy_audit ORDER BY created_at DESC LIMIT 1',
              )
            ).rows[0].enabled,
            false,
          );
        },
      );
      await t.test(
        'archive backlog, failures and missing observation stay visible; idle archives do not falsely stall',
        async () => {
          await reset();
          await run('verified', 0);
          assert.equal((await ops.check()).snapshot.signals.archive_stalled, 0);
          await probe({ ...healthy, archiveMode: 'off' });
          assert.equal((await ops.check()).snapshot.signals.archive_disabled, 1);
          await probe({
            ...healthy,
            pendingCount: 3,
            oldestPendingSeconds: 300,
            failureOutstanding: true,
          });
          let r = await ops.check();
          assert.equal(r.snapshot.signals.archive_stalled, 1);
          assert.equal(r.snapshot.signals.archive_failed, 1);
          await probe({ ...healthy, pendingCount: 1, oldestPendingSeconds: 299 });
          r = await ops.check();
          assert.equal(r.snapshot.signals.archive_stalled, 0);
          assert.ok(
            r.changes.some((c) => c.key === 'archive_stalled' && c.transition === 'resolved'),
          );
          await probe({ available: false });
          r = await ops.check();
          assert.equal(r.snapshot.signals.backup_probe_failed, 1);
          await probe(healthy);
          r = await ops.check();
          assert.equal(r.snapshot.signals.backup_probe_failed, 0);
          await probe({ ...healthy, pendingCount: 1, oldestPendingSeconds: 301 });
          r = await ops.check();
          assert.ok(r.changes.some((c) => c.key === 'archive_stalled' && c.generation === 2));
          await assert.rejects(ops.acknowledge('archive_stalled', 1), /not active/);
        },
      );
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      for (const role of roles) await admin.query(`DROP ROLE ${role}`);
      await admin.end();
    }
  },
);
