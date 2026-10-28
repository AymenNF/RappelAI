# Local setup

## 1. Prerequisites

- Node.js 24 and npm. `.nvmrc` records the major version; use a current patched Node 24 release for deployment.
- Git for version control.
- Docker Desktop using Linux containers and Docker Compose v2, or a local PostgreSQL 16 database.
- No WhatsApp, model, Google or hosting credentials are needed for offline checks.

The initial environment had Node/npm and Git available, but no `docker` command. Installing Docker Desktop is the next local prerequisite for running the provided PostgreSQL integration environment. Do not confuse passing unit tests with a verified database deployment.

## 2. Install and configure

From the repository root:

```powershell
npm ci
npm run setup
```

Setup creates `.env` once with random local webhook secrets and preserves existing files. These random values are for local signed fixtures. To receive actual Meta webhooks, replace `WHATSAPP_APP_SECRET` with the app's real secret and register `WHATSAPP_VERIFY_TOKEN` in Meta. Keep `.env` private; it is ignored by Git and excluded from the image.

| Variable                   | Runtime use                                                         |
| -------------------------- | ------------------------------------------------------------------- |
| `DATABASE_URL`             | Required PostgreSQL connection                                      |
| `WHATSAPP_APP_SECRET`      | Required raw-body HMAC verification                                 |
| `WHATSAPP_VERIFY_TOKEN`    | Required GET challenge verification                                 |
| `WHATSAPP_PHONE_NUMBER_ID` | Optional allowlist for a business phone; set before public exposure |
| `HOST`, `PORT`             | Bind address and port; local default is loopback                    |
| `LOG_LEVEL`                | Structured API logging                                              |
| `WORKER_POLL_INTERVAL_MS`  | Diagnostic backlog poll; not a scheduler                            |

Other `.env.example` fields are reserved for future integrations. Model IDs and Graph API version are deliberately unfilled until selected and verified.

## 3. Start infrastructure and migrate

```powershell
npm run infra:up
npm run db:migrate
```

Compose binds PostgreSQL to localhost, persists it in a named volume and checks readiness. The local password is deliberately public and is unsuitable for any shared environment. Migration files are checksummed and applied transactionally under an advisory lock. Never edit an applied migration; add a new file.

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

Run the health commands in a third terminal if the worker occupies the second. Live returns 200 if the API runs. Ready returns 200 only if the ingress and outbox tables can be queried. The worker logs `processingEnabled: false`; pending messages remain pending until M1 implements consumers.

## 5. Validate

```powershell
npm run check
$env:TEST_DATABASE_URL = 'postgresql://memorae:memorae_local_only@localhost:5432/memorae'
npm run test:integration
```

Integration tests use a uniquely named schema, run the ingress migration, test concurrent replay and rollback, then remove only that schema. Use a disposable local/CI database, never production. CI also applies migrations twice to check that migration history is honored.

```powershell
npm run build
npm start
```

The API image builds with `docker build -t memorae-api .`; the worker uses the same image with command `node dist/worker/main.js`. Migrations are a separate release step from a full checkout with development tooling; they are not baked into API startup or copied into the runtime image.

## Troubleshooting

| Symptom                         | Action                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| Docker not recognized           | Install/start Docker Desktop; open a new terminal; verify `docker compose version` |
| Readiness 503                   | Verify PostgreSQL is healthy, URL is correct and migrations ran                    |
| Port 5432 busy                  | Choose another host port and update `DATABASE_URL` together                        |
| Webhook 401                     | Sign exact request bytes with the real app secret; do not stringify parsed JSON    |
| Webhook 400                     | Verify Meta envelope and phone metadata; inspect a redacted fixture locally        |
| Webhook 503                     | Database write failed; allow provider retry; do not force a 200                    |
| Messages never answered         | Expected at foundation stage; consumer/model/sender are not implemented            |
| Evaluation asks for predictions | The scorer needs actual model outputs; fixture validation is a separate command    |

Do not expose this scaffold to real users before the consent, retention, rate-limit, database-role and delivery gates in the roadmap pass.
