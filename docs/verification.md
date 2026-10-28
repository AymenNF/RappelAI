# Local setup and M1 verification — 2026-10-27

## Completed

- Located existing Docker Desktop 4.97.0, verified WSL 2, and restarted the stalled engine. Docker Engine 29.9.2 and Compose 5.6.1 respond successfully.
- Started PostgreSQL 16 locally; health check passes on localhost:5432, with a persistent named volume.
- Applied migrations 0001, 0002 and 0003. Re-running applied migrations is a no-op; checksum tracking remains intact.
- Real PostgreSQL tests pass: concurrent webhook deduplication, atomic rollback, isolated identities, ordered onboarding, consent/token handling, revocation, service-window behavior and future-timestamp rejection.
- Local HTTP smoke passes with the actual PostgreSQL store: liveness and readiness return 200; the temporary server closes afterward.
- Built the API Docker image `memorae-local:dev` successfully.
- Unit suite contains 21 tests; 12 evaluation fixtures validate. TypeScript, build and formatting checks pass.
- Exercised the synthetic onboarding chat against local PostgreSQL. No WhatsApp sends or model calls were made.

## Current runtime behavior

The worker handles local onboarding and persists responses. Normal requests passing onboarding remain pending for future feature processing. The chat simulator displays stored responses directly. API/simulator test processes close after verification; Docker and PostgreSQL remain running. Start API/worker with `npm run dev` and `npm run dev:worker`, or run the simulator directly with `npm run onboarding:chat`.

## Remaining limits

This is local testing, not production consent. Real-user onboarding needs a new notice, processor/retention choices, tenant roles/RLS and WhatsApp delivery. Model integration, actual AI accuracy, general job leases, reminder/list services, scheduling, delivery reconciliation, export/deletion and production infrastructure remain roadmap work. No delivery or latency SLO has been established. GitHub Actions is configured but has not run remotely in this task. Changes are local and uncommitted.
