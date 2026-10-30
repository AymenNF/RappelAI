import { createPool } from '../db/pool.js';
import { readSecret } from '../config/secrets.js';
const url = new URL(readSecret('DATABASE_URL') ?? '');
if (url.pathname !== '/memorae_staging' || process.env.STAGING_SYNTHETIC_ONLY !== 'true')
  throw new Error('Synthetic staging database required');
const pool = createPool(url.toString());
const c = await pool.connect();
try {
  await c.query('BEGIN');
  for (const capability of ['ingress', 'worker', 'monitor'] as const) {
    const role = `memorae_stage_${capability}`;
    const value = new URL(readSecret(`${capability.toUpperCase()}_DATABASE_URL`) ?? '');
    const password = decodeURIComponent(value.password);
    if (
      value.username !== role ||
      value.host !== url.host ||
      value.pathname !== url.pathname ||
      !/^[a-f0-9]{64}$/.test(password)
    )
      throw new Error('Unexpected staging login configuration');
    const existing = (
      await c.query(
        `SELECT r.*,ARRAY(SELECT p.rolname::text FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid) AS groups
      FROM pg_roles r WHERE r.rolname=$1`,
        [role],
      )
    ).rows[0];
    if (
      existing &&
      (existing.rolsuper ||
        existing.rolbypassrls ||
        existing.rolcreatedb ||
        existing.rolcreaterole ||
        existing.rolreplication ||
        existing.groups.some((g: string) => g !== `memorae_${capability}`))
    )
      throw new Error('Unsafe existing staging role');
    await c.query(
      `${existing ? 'ALTER' : 'CREATE'} ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
    );
    await c.query(`GRANT memorae_${capability} TO ${role}`);
    await c.query(`GRANT CONNECT ON DATABASE memorae_staging TO ${role}`);
  }
  await c.query('REVOKE CONNECT ON DATABASE memorae_staging FROM PUBLIC');
  await c.query('COMMIT');
  console.log('Provisioned scoped staging logins; no credentials printed.');
} catch {
  await c.query('ROLLBACK');
  console.error('Staging provisioning failed.');
  process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
