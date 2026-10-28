# M1-02: tenant access and database isolation

Implemented for the existing identity schema. The migration is `0004_tenant_isolation.sql`; previous migrations remain unchanged. No user-facing HTTP endpoint has been added before session authentication exists.

## Access boundaries

| Capability                        | Credentials                                | Permitted access                                                                                                                               |
| --------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration/bootstrap administrator | `DATABASE_URL`                             | Schema changes and local login provisioning; never used by API/worker                                                                          |
| Webhook ingress                   | `INGRESS_DATABASE_URL` / `memorae_ingress` | Read/insert transport events and work intents; sequence usage; no user tables or updates                                                       |
| Trusted onboarding worker         | `WORKER_DATABASE_URL` / `memorae_worker`   | Read/update transport; read/insert/update identities; read/insert onboarding results and consent history; no audit deletion or table ownership |
| Tenant application                | `TENANT_DATABASE_URL` / `memorae_tenant`   | Read own identity, results and consent history; CRUD own reply-language preferences; no transport or consent-state mutation                    |

Group roles are NOLOGIN and have no superuser, BYPASSRLS, role creation, database creation or replication privileges. Local login roles each belong to one capability group and own no schema objects. API/worker startup rejects elevated credentials, object ownership, elevated role membership, a wrong capability or mixed capabilities. The tenant transaction helper applies the same check.

The worker has deliberate cross-user policies on its three necessary identity tables. It does not use BYPASSRLS. This worker is a privileged, trusted component; it is not a tenant request handler. Do not reuse its pool in tenant services.

## Row and relationship enforcement

`users`, `identity_results`, `consent_events`, and `user_preferences` have both ENABLE and FORCE ROW LEVEL SECURITY. Tenant policies use matching `app.user_id` in both USING and WITH CHECK. Missing/empty context sees zero rows and cannot insert. A malformed context fails rather than broadening access. SQL grants additionally prevent changes to consent, identifiers, timestamps and audit history through the tenant role.

`consent_events(user_id,event_id)` references the matching composite key in `identity_results`. A worker cannot accidentally attribute another user's event to an audit entry. A trigger also checks that an identity result's ingress sender and business number match the assigned user. Transport is pre-user staging, so it is protected by separate internal grants rather than a fabricated tenant identity.

`user_preferences` currently stores an explicit reply-language preference (`en`, `fr`, `es`). This is preference storage only, not a claim that multilingual model responses are implemented. It provides the first tenant-owned writable resource without granting direct writes to onboarding authority.

## Application transaction contract

`withTenant(pool, authenticatedUserId, callback)` validates the UUID, verifies the tenant-only database capability, clears any session-level tenant setting, starts a transaction, and installs `app.user_id` with transaction-local `set_config`. It commits/rolls back and clears context before returning the connection. A connection whose cleanup fails is discarded. `TenantProfiles` demonstrates scoped reads and a preference upsert; it projects a limited profile without consent challenge tokens.

The authenticated user ID must come from trusted server session identity. It must never come directly from a query parameter, request body, model tool argument or client-selected header. Session authentication is not yet implemented, so these services have no public HTTP routes.

**Trust limit:** a PostgreSQL custom setting is not cryptographic authentication. Code or a person holding tenant database credentials can execute SQL to change it. These controls defend against missing tenant predicates and unintended operations in trusted application code; they do not isolate tenants from a compromised shared application login or arbitrary SQL execution. Parameterized SQL, trusted session binding, private database access and credential protection remain necessary. A worker/database administrator also remains privileged by design. [PostgreSQL row-security documentation](https://www.postgresql.org/docs/16/ddl-rowsecurity.html) describes owner/superuser exceptions and why table privileges must accompany RLS.

## Local setup

```powershell
npm run db:migrate
npm run db:provision:local
npm run smoke
npm run onboarding:chat
```

Provisioning is intentionally restricted to the `memorae` database on localhost. It creates three non-owner login roles, stores random passwords only in ignored `.env`, and preserves generated passwords on rerun. It refuses customized runtime URLs or unsafe pre-existing roles. Nothing prints the credentials. Restart running API/worker processes after switching credentials.

In staging/production, provision capability group roles through an administrator with CREATEROLE and provision login passwords through your secret-management/deployment workflow. Supply each process only its relevant runtime URL. Do not provide the administrator URL to runtime containers. If your provider disallows CREATEROLE for migrations, a database administrator must pre-provision the safe group roles before applying the migration. No default privileges are granted on future tables; every new table requires explicit grants, tenant policies and tests.

## Tests

The integration suite creates an isolated schema and actual temporary non-superuser login roles. It tests missing context; cross-user reads/inserts/updates/deletes; own CRUD; read-only consent state; forbidden role switching, DDL and TRUNCATE; transport separation; mismatched audit/message ownership; callback/SQL rollback; concurrent users sharing a one-connection pool; intentional session contamination; malformed IDs/context; and FORCE RLS with a non-superuser table owner. Temporary schemas and login roles are removed afterward. Shared NOLOGIN capability roles remain because they are part of the migration design.

Run against local disposable development data:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://memorae:memorae_local_only@127.0.0.1:5432/memorae'
npm run test:integration
```

The migration administrator is used only to create/drop test objects. Isolation assertions run under restricted logins or an explicitly selected non-superuser owner. Existing onboarding and ingress tests remain regression coverage.
