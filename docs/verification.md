# Local setup and M1-03 verification — 2026-10-27

## Completed

- Located existing Docker Desktop 4.97.0, verified WSL 2, and restarted the stalled engine. Docker Engine 29.9.2 and Compose 5.6.1 respond successfully.
- Started PostgreSQL 16 locally; health check passes on localhost:5432, with a persistent named volume.
- Applied migrations 0001, 0002 and 0003. Re-running applied migrations is a no-op; checksum tracking remains intact.
- Applied migration 0004 and provisioned separate ingress/worker/tenant local logins. API readiness succeeds under the restricted ingress login; credential provisioning also passes on rerun.
- All 21 integration tests/subtests pass, including actual non-owner logins, forced RLS on a non-superuser owner, tenant CRUD isolation, denied transport/audit mutation, cross-owner references, and transaction/pool cleanup.
- Real PostgreSQL tests pass: concurrent webhook deduplication, atomic rollback, isolated identities, ordered onboarding, consent/token handling, revocation, service-window behavior and future-timestamp rejection.
- Local HTTP smoke passes with the actual PostgreSQL store: liveness and readiness return 200; the temporary server closes afterward.
- Built the API Docker image `memorae-local:dev` during initial setup. It has not been rebuilt for M1-02/M1-03; the current TypeScript production build passes.
- Unit suite contains 22 tests; 12 evaluation fixtures validate. TypeScript, build and formatting checks pass.
- Exercised the synthetic onboarding chat against local PostgreSQL. No WhatsApp sends or model calls were made.

- Applied migration 0005; rerun is a no-op. Verified the production TypeScript worker build starts against the restricted local worker login and exits through its SIGTERM handler.
- Work-queue tests cover competing claims, independent users/business phones, abandoned-lease recovery, stale tokens, transaction rollback, bounded retries/dead work, audited operator retry, stage ordering, heartbeat renewal, lease loss, synchronous handler failure, shutdown during preparation/claim and ingress commit visibility. Tests simulate an abandoned owner; they do not kill an OS worker or establish a production recovery SLO.

## Current runtime behavior

The worker leases local onboarding work, renews ownership during preparation, recovers expired leases and persists responses atomically. Normal requests passing onboarding transition to the pending action stage for future feature processing. Receipt reconciliation also remains pending. Dead items block their stage until an operator repairs and retries them; see [work processing](work-processing.md). The chat simulator displays stored responses directly. API/simulator test processes close after verification; Docker and PostgreSQL remain running. Start API/worker with `npm run dev` and `npm run dev:worker`, or run the simulator directly with `npm run onboarding:chat`.

## Remaining limits

This is local testing, not production consent. Real-user onboarding needs a new notice, processor/retention choices, session authentication and WhatsApp delivery. RLS is implemented for current tenant tables; future tables must add their own policies/grants/tests. Tenant IDs are trusted server context, not a database-authenticated end-user identity. Model integration, actual AI accuracy, reminder/list services, scheduling, delivery reconciliation, export/deletion and production infrastructure remain roadmap work. No delivery or latency SLO has been established. Previous local setup/onboarding was committed and pushed as `36a88ac`; M1-02 was committed and pushed as `cf2d96d`. M1-03 changes remain local and uncommitted. No remote CI result is claimed for M1-03.
