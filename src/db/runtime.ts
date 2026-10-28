import type { Pool } from 'pg';

export type DatabaseCapability = 'ingress' | 'worker' | 'tenant';
const roleFor = {
  ingress: 'memorae_ingress',
  worker: 'memorae_worker',
  tenant: 'memorae_tenant',
} as const;

/** Fail closed if a runtime was accidentally configured with owner/admin credentials. */
export async function assertRuntimeRole(pool: Pool, capability: DatabaseCapability): Promise<void> {
  const result = await pool.query(
    `SELECT r.rolsuper,r.rolbypassrls,r.rolcreatedb,r.rolcreaterole,r.rolreplication,
    pg_has_role(current_user,$1,'MEMBER') AS expected,
    EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=current_schema() AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns_objects,
    EXISTS(SELECT 1 FROM pg_roles elevated WHERE
      (elevated.rolsuper OR elevated.rolbypassrls OR elevated.rolcreatedb OR elevated.rolcreaterole OR elevated.rolreplication)
      AND pg_has_role(current_user,elevated.oid,'MEMBER')) AS elevated_membership,
    ARRAY(SELECT rolname::text FROM pg_roles WHERE rolname IN ('memorae_ingress','memorae_worker','memorae_tenant')
      AND pg_has_role(current_user,oid,'MEMBER')) AS capabilities
    FROM pg_roles r WHERE r.rolname=current_user`,
    [roleFor[capability]],
  );
  const role = result.rows[0];
  if (
    !role ||
    role.rolsuper ||
    role.rolbypassrls ||
    role.rolcreatedb ||
    role.rolcreaterole ||
    role.rolreplication ||
    role.owns_objects ||
    role.elevated_membership ||
    !role.expected ||
    role.capabilities.length !== 1
  ) {
    throw new Error(
      `Unsafe ${capability} database role; run migrations and provision separate runtime credentials`,
    );
  }
}

export function runtimeDatabaseUrl(
  capability: DatabaseCapability,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const key = `${capability.toUpperCase()}_DATABASE_URL`;
  const value = env[key];
  if (!value)
    throw new Error(`${key} is required; administrator DATABASE_URL is for migrations only`);
  return value;
}
