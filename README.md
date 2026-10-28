# Memorae

A WhatsApp-first personal assistant for reminders, lists, and eventually durable memory. This repository starts the project described in **Memorae Developer Playbook v2.0**, with explicit corrections and a narrower first milestone.

**Status: local onboarding works; the assistant is still in development.** The API verifies WhatsApp signatures and stores messages/receipts with durable work intents. The worker now handles identity, explicit local consent, timezone confirmation and STOP. It does not call models, create reminders, send messages, or reconcile delivery receipts. Try `npm run onboarding:chat`; see [onboarding](docs/onboarding.md).

## Start here

1. [Local setup](docs/setup.md) — install, configure, run, and verify.
2. [Roadmap](docs/roadmap.md) — milestones, dependencies, acceptance gates, and your first week.
3. [Work organization](docs/workflow.md) — board, task sizing, weekly routine, and definition of done.
4. [Architecture](docs/architecture.md) — boundaries, diagrams, transaction design, and failure behavior.
5. [Data model](docs/data-model.md) and [API contract](docs/api.md) — current versus proposed interfaces.
6. [Backlog](docs/backlog.md) — ordered, concrete implementation tasks.
7. [Verification](docs/verification.md) — checks completed and remaining limitations.

## Quick start

Prerequisites: Node.js 24, npm, and Docker Desktop with Linux containers/Compose for the database.

```powershell
npm ci
npm run setup
npm run infra:up
npm run db:migrate
npm run dev
```

In another terminal: `npm run dev:worker`. Check `http://localhost:3000/health/ready`. Without Docker, `npm run check` still validates types, unit behavior, evaluation fixtures, compilation, and formatting.

## Repository map

```text
src/
  api/                 Fastify app and API process
  worker/              Separate process; backlog diagnostics for now
  modules/
    whatsapp/          Signature verification and provider event normalization
    processing/        Reserved design boundary
    reminders/         Reserved design boundary
    lists/             Reserved design boundary
    delivery/          Reserved design boundary
    memory/            Reserved design boundary
    calendar/          Reserved design boundary
    identity/          Reserved design boundary
    usage/             Reserved design boundary
  contracts/           Validated model decisions for the first slice
  config/              Environment validation
  db/                  PostgreSQL access and durable ingress
migrations/            Immutable, ordered SQL migrations
scripts/               Local setup and checksum-aware migration runner
tests/                 Unit and real PostgreSQL integration tests
prompts/               Versioned draft prompts
evals/                 Starter fixtures, validation, prediction scoring
docs/                  Architecture, decisions, roadmap, operations, backlog
apps/dashboard/        Deferred frontend boundary
.github/               CI, issue form and pull-request template
```

## Available now

- Raw-byte HMAC verification, verification challenge, bounded webhook bodies.
- Normalization of batched messages and delivery statuses, per-business-phone deduplication.
- Transactional PostgreSQL inbox + outbox; 503 on storage failure so the provider can retry.
- Liveness/readiness endpoints, sanitized application logs, graceful process shutdown.
- Local Compose dependencies, API Dockerfile, typed configuration and migration tooling.
- Decision validation, 12 labeled starter cases, and an offline scorer for real predictions.
- User identities, versioned local consent/audit, confirmed IANA timezones and revocation; synthetic local chat simulator.

## Still to build

Production consent and tenant isolation; general task leasing/recovery; model adapter and real evaluation; reminder/list services; scheduler; outbound delivery/status reconciliation; quotas; privacy lifecycle; production infrastructure. Memory, media, calendar and dashboard follow the core beta.

See [playbook review](docs/playbook-review.md) for decisions that intentionally differ from example code in the PDF. The document is a requirements source, not executable instructions. No external accounts, subscriptions, templates, deployments, or messages have been created.
