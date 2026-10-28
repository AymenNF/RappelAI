# Local setup and M1-07 verification — 2026-10-27

## Completed

- Located existing Docker Desktop 4.97.0, verified WSL 2, and restarted the stalled engine. Docker Engine 29.9.2 and Compose 5.6.1 respond successfully.
- Started PostgreSQL 16 locally; health check passes on localhost:5432, with a persistent named volume.
- Applied migrations 0001, 0002 and 0003. Re-running applied migrations is a no-op; checksum tracking remains intact.
- Applied migration 0004 and provisioned separate ingress/worker/tenant local logins. API readiness succeeds under the restricted ingress login; credential provisioning also passes on rerun.
- All 71 integration tests/subtests pass, including actual non-owner logins, forced RLS on a non-superuser owner, tenant CRUD isolation, denied transport/audit mutation, cross-owner references, and transaction/pool cleanup.
- Real PostgreSQL tests pass: concurrent webhook deduplication, atomic rollback, isolated identities, ordered onboarding, consent/token handling, revocation, service-window behavior and future-timestamp rejection.
- Local HTTP smoke passes with the actual PostgreSQL store: liveness and readiness return 200; the temporary server closes afterward.
- Built the API Docker image `memorae-local:dev` during initial setup. It has not been rebuilt for M1-02 through M1-07; the current TypeScript production build passes.
- Unit suite contains 38 tests; 12 evaluation fixtures validate. TypeScript, build and formatting checks pass.
- Exercised the synthetic onboarding chat against local PostgreSQL. No WhatsApp sends or model calls were made.

- Applied migration 0005; rerun is a no-op. Verified the production TypeScript worker build starts against the restricted local worker login and exits through its SIGTERM handler.
- Work-queue tests cover competing claims, independent users/business phones, abandoned-lease recovery, stale tokens, transaction rollback, bounded retries/dead work, audited operator retry, stage ordering, heartbeat renewal, lease loss, synchronous handler failure, shutdown during preparation/claim and ingress commit visibility. Tests simulate an abandoned owner; they do not kill an OS worker or establish a production recovery SLO.

- Applied migration 0006; rerun is a no-op. Model tests cover bounded requests, invalid/refused/incomplete output, cancellation, provider metadata, immutable plan replay, stale leases, atomic stage transitions, STOP/timezone races, expired reminders and forced tenant isolation. All provider responses were mocked; no paid calls were made.
- The production TypeScript worker build starts and stops cleanly in both disabled and offline fixture modes against the local database. No worker process was left running.

- Applied migration 0007; rerun is a no-op. The operator status command confirms paused spending, zero global/default user caps, and no live rate configuration.
- Usage tests exercise simultaneous reservations, per-user/global caps, idempotent dispatch/settlement, exact integer costs, kill-switch enforcement, overrun/conflict stop, uncertain-call holds, reconciliation, rate snapshots, prior-month settlement, pre-dispatch release, failed persistence and tenant/role isolation. Only synthetic rate cards and mocked provider usage were used.

- Applied migration 0008; rerun is a no-op. Execution tests cover concurrent workers, immutable receipt replay, atomic rollback after reply failure or lease expiry, list normalization and ordered appends, expired/digest rejection, consent/timezone changes, STOP suppression, invalid persisted plans, forced tenant isolation, and the metered planning-to-execution pipeline.
- The compiled worker starts and stops in disabled and offline fixture modes with execution enabled. Local API liveness/readiness return 200. Spending remains paused with zero caps; no paid calls or WhatsApp sends were made.

- Applied migration 0009; rerun is a no-op. Test dispatch and receipt tests cover competing senders, provider acceptance, replay, early/reordered/duplicate receipts, transaction rollback, failed result persistence, ambiguous timeout holds, pause/allowlist/window/identity gates, STOP before and during sends, ordering, tenant isolation and mismatched receipt addresses. All sends use mocked transports.
- Verified the compiled worker starts and stops in both local model modes with receipt handling enabled and WhatsApp sending disabled. API readiness/liveness remain 200. The global spending policy remains paused with zero caps. No live Meta credentials or network sends were used.

## Current runtime behavior

The worker leases local onboarding work, renews ownership during preparation, recovers expired leases and persists responses atomically. Normal requests passing onboarding transition to the pending action stage. The default model mode leaves them pending. Optional fixture mode saves a fixed clarification plan after installing the free fixture rate and explicitly resuming usage controls; it performs no inference. Execution then persists a clarification reply intent and completes the work. Valid saved action plans atomically create reminders/list items, immutable action receipts and one reply intent. Local execution continues while paid planning is paused. STOP or changed identity settings suppress queued replies. See [action execution](action-execution.md).

The OpenAI adapter is implemented and contract-tested, but remote calls remain disabled pending replacement consent and model/rate qualification. Usage reservations and spending controls gate the planning path; unknown calls retain their budget until reconciliation. See [usage controls](usage-controls.md) and [model plans](model-plans.md). Receipt reconciliation is active. The send adapter and test dispatcher are implemented but live WhatsApp sending remains disabled. See [WhatsApp delivery](whatsapp-delivery.md). Dead items block their stage until an operator repairs and retries them; see [work processing](work-processing.md). The chat simulator displays stored onboarding responses directly. API/simulator test processes close after verification; Docker and PostgreSQL remain running. Start API/worker with `npm run dev` and `npm run dev:worker`, or run the simulator directly with `npm run onboarding:chat`.

## Remaining limits

This is local testing, not production consent. Real-user onboarding needs a new notice, processor/retention choices, session authentication and WhatsApp delivery. RLS is implemented for current tenant tables; future tables must add their own policies/grants/tests. Tenant IDs are trusted server context, not a database-authenticated end-user identity. Live provider activation, actual AI accuracy, reminder/list editing, recurrence, scheduling, templates, unknown-send reconciliation, export/deletion and production infrastructure remain roadmap work. Saved reminders do not fire yet; reply intents remain unsent. No delivery or latency SLO has been established. Previous local setup/onboarding was committed and pushed as `36a88ac`; M1-02 was committed and pushed as `cf2d96d`. M1-03 was committed and pushed as `8d6938a`. M1-04 was committed and pushed as `0729680`. M1-05 was committed and pushed as `55a465f`. M1-06 was committed and pushed as `3951624`. M1-07 changes remain local and uncommitted. No remote CI result is claimed for M1-07.
