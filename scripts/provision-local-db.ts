import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createPool } from '../src/db/pool.js';

// Local-only bootstrap. Production login provisioning belongs in your secrets/IaC workflow.
if (process.env.NODE_ENV === 'production')
  throw new Error('Local provisioning cannot run in production');
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/memorae') {
  throw new Error('Local provisioning requires the memorae database on localhost');
}
const file = new URL('../.env', import.meta.url);
let contents = await readFile(file, 'utf8');
const pool = createPool(url.toString());
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('memorae:local-logins'))");
  for (const capability of ['ingress', 'worker', 'tenant'] as const) {
    const role = `memorae_local_${capability}`;
    const group = `memorae_${capability}`;
    const key = `${capability.toUpperCase()}_DATABASE_URL`;
    const previous = process.env[key] ? new URL(process.env[key]!) : null;
    if (
      previous &&
      (previous.username !== role ||
        previous.host !== url.host ||
        previous.pathname !== url.pathname)
    ) {
      throw new Error(`Refusing to overwrite customized ${key}`);
    }
    const password = previous
      ? decodeURIComponent(previous.password)
      : randomBytes(32).toString('hex');
    // Generated passwords are hex; an edited password requires manual provisioning.
    if (!/^[a-f0-9]{64}$/.test(password))
      throw new Error(`Unexpected local password format for ${key}`);
    const existing = await client.query(
      `SELECT r.*,
      ARRAY(SELECT p.rolname::text FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid) AS memberships
      FROM pg_roles r WHERE r.rolname=$1`,
      [role],
    );
    if (existing.rows[0]) {
      const r = existing.rows[0];
      if (
        r.rolsuper ||
        r.rolcreatedb ||
        r.rolcreaterole ||
        r.rolbypassrls ||
        r.rolreplication ||
        r.memberships.some((name: string) => name !== group)
      )
        throw new Error(`Unsafe existing local role ${role}`);
      await client.query(`ALTER ROLE ${role} LOGIN PASSWORD '${password}'`);
    } else {
      await client.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
      );
    }
    await client.query(`GRANT ${group} TO ${role}`);
    const runtime = new URL(url);
    runtime.username = role;
    runtime.password = password;
    const line = `${key}=${runtime.toString()}`;
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    contents = pattern.test(contents)
      ? contents.replace(pattern, line)
      : `${contents.trimEnd()}\n${line}\n`;
  }
  await client.query('COMMIT');
  await writeFile(file, contents, { mode: 0o600 });
  console.log(
    'Provisioned three local runtime logins and saved URLs to ignored .env. No credentials printed.',
  );
} catch {
  await client.query('ROLLBACK');
  throw new Error(
    'Local role provisioning failed; verify migrations, local credentials and role configuration',
  );
} finally {
  client.release();
  await pool.end();
}
