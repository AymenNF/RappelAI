# Local setup

## 1. Prerequisites

- Node.js 24 and npm. `.nvmrc` records the major version; use a current patched Node 24 release for deployment.
- Git for version control.
- Docker Desktop using Linux containers and Docker Compose v2, or a local PostgreSQL 16 database.
- No WhatsApp, model, Google or hosting credentials are needed for offline checks.

Docker Desktop 4.97.0 is installed for the Windows user and its WSL 2 engine is running. A restart cleared a stale “WSL not installed” error. PostgreSQL is running in `memorae-postgres-1`, with data in the `memorae_postgres_data` volume. The npm infrastructure commands locate Docker's executable and credential helper even in terminals with an old PATH. Open a new terminal to use `docker` directly.

## 2. Install and configure

From the repository root:

```powershell
npm ci
npm run setup
```

Setup creates `.env` once with random local webhook secrets and preserves existing files. These random values are for local signed fixtures. To receive actual Meta webhooks, replace `WHATSAPP_APP_SECRET` with the app's real secret and register `WHATSAPP_VERIFY_TOKEN` in Meta. Keep `.env` private; it is ignored by Git and excluded from the image.

| Variable                   | Runtime use                                                                     |
| -------------------------- | ------------------------------------------------------------------------------- |
| `DATABASE_URL`             | Migration/bootstrap administrator only; not used by runtime processes           |
| `INGRESS_DATABASE_URL`     | Restricted webhook API login; populated by local provisioning                   |
| `WORKER_DATABASE_URL`      | Restricted trusted onboarding worker login                                      |
| `TENANT_DATABASE_URL`      | Tenant-scoped application login; never use worker credentials for user requests |
| `WHATSAPP_APP_SECRET`      | Required raw-body HMAC verification                                             |
| `WHATSAPP_VERIFY_TOKEN`    | Required GET challenge verification                                             |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional allowlist for a business phone; set before public exposure             |
| `HOST`, `PORT`             | Bind address and port; local default is loopback                                |
| `LOG_LEVEL`                | Structured API logging                                                          |
| `WORKER_POLL_INTERVAL_MS`  | Delay between worker cycles, including due-reminder sweeps                      |

Other `.env.example` fields are reserved for future integrations. Model IDs and Graph API version are deliberately unfilled until selected and verified.

## 3. Start infrastructure and migrate

```powershell
npm run infra:up
npm run db:migrate
npm run db:provision:local
```

Compose binds PostgreSQL to localhost, persists it in a named volume and checks readiness. Its administrator password is deliberately public and unsuitable for shared environments. Local provisioning creates separate non-owner runtime logins with random passwords in ignored `.env`; reruns preserve generated credentials. The API and worker refuse administrator credentials. See [tenant isolation](tenant-isolation.md). Migration files are checksummed and applied transactionally under an advisory lock. Never edit an applied migration; add a new file.

Redis is optional and unused in this foundation. When implementing the relay:

```powershell
docker compose --profile queue up -d --wait
```

`npm run infra:down` stops containers while preserving data. Do not remove volumes unless you intend to delete local database contents.

## 4. Run the processes

```powershell
npm run dev
```

In another terminal:

```powershell
npm run dev:worker
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
```

Run the health commands in a third terminal if the worker occupies the second. Live returns 200 if the API runs. Ready returns 200 only if the ingress and outbox tables can be queried. The worker handles local onboarding, logs `remoteModelEnabled: false`, and defaults to leaving ready requests pending. `MODEL_MODE=fixture` exercises offline planning without making provider calls. Onboarding responses are stored locally, not sent on WhatsApp. Try `npm run onboarding:chat`; see [onboarding](onboarding.md).

The worker now uses renewable leases and ordered stages. Pending actions do not block onboarding. See [work processing](work-processing.md) for recovery, shutdown, ordering and the `work:retry` command.

Saved plans now execute locally into reminders/list items and pending reply intents; the M2-01 scheduler creates due occurrences/outbound intents, while sending remains unavailable. See [scheduling](reminder-scheduling.md). See [action execution](action-execution.md). See [model plans](model-plans.md) for optional fixture mode, adapter limits and persisted-plan behavior. `MODEL_TIMEOUT_MS` defaults to 20000; live provider calls remain unavailable through worker configuration until the replacement consent notice and model/rate qualification are complete. M1-05 controls now default to paused; fixture mode additionally requires the zero-cost rate and explicit resume described in [usage controls](usage-controls.md).

## 5. Validate

```powershell
npm run check
$env:TEST_DATABASE_URL = 'postgresql://memorae:memorae_local_only@localhost:5432/memorae'
npm run test:integration
npm run smoke
```

Integration tests apply all migrations in uniquely named schemas and exercise replay, identity, restricted-role isolation and work lease recovery. Temporary schemas and login roles are removed afterward. Use a disposable local/CI database, never production. CI also applies migrations twice to check that migration history is honored.

```powershell
npm run build
npm start
```

The API image builds with `docker build -t memorae-api .`; the worker uses the same image with command `node dist/worker/main.js`. Migrations are a separate release step from a full checkout with development tooling; they are not baked into API startup or copied into the runtime image.

## Troubleshooting

M2-02 adds migration 0011 for the versioned template registry and reminder attempt snapshots. Stop older workers before migrating, then rebuild/restart. The ordinary worker still cannot send WhatsApp messages; reminder dispatch is an injectable test service. See [reminder delivery](reminder-delivery.md) for its gates, template administration and inspection queries.

| Symptom                         | Action                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| Docker not recognized           | Install/start Docker Desktop; open a new terminal; verify `docker compose version`   |
| Readiness 503                   | Verify PostgreSQL is healthy, URL is correct and migrations ran                      |
| Port 5432 busy                  | Choose another host port and update administrator and runtime URLs together          |
| Webhook 401                     | Sign exact request bytes with the real app secret; do not stringify parsed JSON      |
| Webhook 400                     | Verify Meta envelope and phone metadata; inspect a redacted fixture locally          |
| Webhook 503                     | Database write failed; allow provider retry; do not force a 200                      |
| Messages never answered         | WhatsApp sender/model are not connected; view onboarding through the local simulator |
| Evaluation asks for predictions | The scorer needs actual model outputs; fixture validation is a separate command      |

Do not expose this scaffold to real users before the consent, retention, rate-limit, database-role and delivery gates in the roadmap pass.
