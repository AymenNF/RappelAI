# Foundation verification — 2026-10-27

## Completed locally

- Dependencies installed with exact versions and a generated `package-lock.json`.
- Local `.env` generated once using random webhook secrets; ignored by Git.
- `npm run check` passes: strict TypeScript, 13 unit tests, 12 evaluation fixture validations, production TypeScript build, and formatting.
- Compiled API passed a localhost HTTP smoke test: liveness 200, readiness 503 with an intentionally unavailable test store; server closed afterward.
- All 17 local links checked across the README and design documents resolve. Git ignores the environment file, dependency cache, dependencies and build output.
- Unit coverage includes original-byte signature verification, verification challenge, replay identity, unsigned/malformed/oversized bodies, storage failure, readiness, mixed batches, status identity, future timestamps and restricted tool decisions.
- npm reported zero known dependency vulnerabilities after updating Zod to the patched release. This is a point-in-time dependency report, not a security certification.

## Included but not executed here

- Real PostgreSQL integration test for concurrent deduplication and transaction rollback.
- Migration application/re-run against PostgreSQL.
- Docker Compose and image builds.
- GitHub Actions workflow execution on a remote repository.

Docker/PostgreSQL was not available through the local command environment. These checks remain M0-02, with commands in [setup](setup.md). No live database correctness, throughput or delivery SLO has been claimed.

## Intentionally not implemented or measured

The worker does not consume tasks. Model calls, actual AI accuracy, reminder/list mutations, scheduling, WhatsApp sends, receipt reconciliation, user authentication, consent, tenant RLS, export/deletion and production deployment are roadmap work. The evaluation scorer accepts real prediction files; validating fixtures does not establish model performance. No external messages were sent.
