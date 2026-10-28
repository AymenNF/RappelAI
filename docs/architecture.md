# Architecture and system design

Status: target system with implemented ingress, identity, tenant isolation and work leases. Updated 2026-10-27. Assumptions: solo developer, small private beta, WhatsApp first, TypeScript, one region, managed PostgreSQL at launch. Country, hosting, languages and provider choices remain open in [decisions](decisions/README.md).

## Shape and boundaries

Use a **modular monolith in one repository**, deployed as an API and one or more workers. This preserves database transactions and simple debugging while allowing ingress and background load to scale separately. Split services only when measurements or team ownership justify it.

```mermaid
flowchart LR
  U[User on WhatsApp] --> M[Meta Cloud API]
  M --> A[API: verify and normalize]
  A --> DB[(PostgreSQL: inbox + outbox)]
  DB --> W[Leased ordered processing worker]
  DB -. Optional future relay .-> Q[Redis / BullMQ buffer]
  Q -. Optional wakeup .-> W
  W --> AI[Model adapter]
  W --> S[Reminder / list / memory services]
  S --> DB
  DB --> T[Due occurrence scheduler]
  T --> O[Outbound ledger]
  O --> D[Delivery worker]
  D --> M
  M --> A
  UI[Later: dashboard] --> AUTH[Authenticated API]
  AUTH --> S
```

The API-to-inbox/outbox path, local identity/onboarding, tenant isolation and staged leased worker exist today. Onboarding responses are stored without sending them. Redis is provisionable but unused. Model, scheduler, sender, authenticated API and dashboard remain planned. See [onboarding](onboarding.md) and [work processing](work-processing.md).

| Module     | Owns                                                        | Must not own                                  |
| ---------- | ----------------------------------------------------------- | --------------------------------------------- |
| WhatsApp   | Provider payloads, signatures, normalization, send adapter  | Business rules or model prompts               |
| Identity   | Phone identity, timezone confirmation, consent, sessions    | Inferring timezone from phone prefix          |
| Processing | Ordered context, model decision, validated action plan      | Raw provider-specific network code            |
| Reminders  | Schedule intent, lifecycle, occurrences                     | Direct outbound network sends                 |
| Lists      | Lists and normalized items, fuzzy resolution                | Arbitrary cross-user IDs from model output    |
| Delivery   | Send intents, attempts, templates, receipts, reconciliation | Claiming delivered on HTTP acceptance         |
| Memory     | Fact provenance, supersession, retrieval, deletion          | Duplicating reminders as memories             |
| Calendar   | OAuth and idempotent external event tasks                   | Claiming success before provider confirmation |
| Usage      | Atomic reservations, usage events, spend policy             | Guessing fixed vendor prices                  |

Dependencies flow from API/worker to application services, then domain rules and adapter interfaces. Provider adapters implement interfaces. Domain logic should be testable without network calls. SQL migrations are authoritative initially; adding Drizzle later requires one migration owner and no parallel schema sources.

## Durable ingress (implemented)

```mermaid
sequenceDiagram
  participant Meta
  participant API
  participant PG as PostgreSQL
  Meta->>API: POST exact raw bytes + HMAC
  API->>API: Verify signature, parse bounded envelope
  API->>PG: BEGIN
  API->>PG: Insert events ON CONFLICT DO NOTHING
  API->>PG: Insert work intents for new events
  API->>PG: COMMIT
  API-->>Meta: 200
  Note over API,PG: Storage failure returns 503 for retry
```

Keys hash a structured tuple: message + business phone + provider message ID; status + business phone + provider message ID + state + provider timestamp. JSON property order does not change identity. A batch commits all accepted events and work intents together. Unknown non-message change fields are ignored; unknown message types are retained for a future unsupported-type response. Raw message/status JSON is staged internally, so real-user traffic needs a short retention policy and restricted role before launch.

## Queue handoff and recovery (M1)

The outbox is the durable task register and current queue. The worker claims due pending rows atomically using database time and `FOR UPDATE SKIP LOCKED`. Each claim receives a fresh token, owner and expiry; preparation runs outside a transaction while a heartbeat renews the lease. Short database effects and acknowledgement commit together after checking the token and expiry before and after the effects. Each cycle recovers expired claims with bounded attempts. Stable error codes, jittered backoff and audited operator retry make failures recoverable. See [work processing](work-processing.md).

Redis/BullMQ may later provide wakeups, but queue publication must never mark a durable task complete. PostgreSQL remains authoritative after buffer loss. External calls require their own idempotency and uncertainty handling.

## Ordering and action execution (M1)

Ingress acquires transaction advisory locks per business-phone/sender stream before allocating sequence values, in sorted order for batches. Claims select the earliest incomplete item in each stage. Onboarding may advance past action backlog so consent controls remain available. Later actions wait for earlier incomplete onboarding/actions; dead or backing-off predecessors block their stream. Receipt streams use business phone and provider message ID.

The acceptance contract is committed ingress order established by stream-lock acquisition, not perfect sender order. Delayed provider messages join the end and cannot reorder committed effects. There is no coalescing window. Current identity rules reject stale control/consent transitions; ambiguous late reference edits need explicit handling when those features arrive. Action handlers must recheck current consent/timezone before preparation and under the user row lock in their final transaction.

Persist the validated model plan before execution. On retry, reuse it; do not regenerate a potentially different list of actions. Derive action keys from inbound event ID + plan version + action index + kind. Within one transaction, insert the action receipt, apply entity changes, and enqueue reply intent. An existing receipt returns the original result. User identity comes from server context. All references must resolve within the user scope. Model-provided confidence is a routing signal, not authorization or calibrated truth.

## Scheduling and delivery (M2)

PostgreSQL stores `next_due_at`. Every 30 seconds, a sweeper locks due rows with `next_due_at <= now()`, creates the uniquely keyed occurrence and durable outbound intent, and advances recurrence in the **same transaction**. No network send happens under the lock. Never mark an occurrence delivered merely because it was scheduled.

Prefer atomic claim-and-materialize transactions rather than persistent reminder claim flags. Where a longer lease is necessary, exclude active leases, reclaim expired ones, and fence updates. Delivery workers recheck `available_at`, cancellation/version, consent, quota, and the service window at actual send time. Exact-time reminders are not delayed to save cost. Digests and quiet-hour deferrals are explicit user preferences with a separately recorded promised delivery time.

Recurring rules retain IANA zone, local time, start date, supported RRULE and end. Define DST gap/fold behavior: proposed gap policy shifts forward by the gap; fold policy uses the first occurrence, once. Review that policy in UX and test it explicitly. Reject unsupported recurrence rules; never advance a local daily rule with UTC +24 hours.

## Delivery guarantees and unknown outcomes

Internal state changes are idempotent under retries. External exactly-once sending is **not guaranteed** without documented provider idempotency or reconciliation. A request may be accepted by Meta while the response is lost. Persist a send attempt before the request. After a timeout or crash in the uncertain window, mark it `unknown`; do not automatically resend. Reconcile receipts when correlation is possible and surface unresolved attempts for operator action. This chooses a visible uncertainty over silently duplicating reminders.

Store delivery receipts before matching them. A status may arrive before the send response is committed. Merge positive progress monotonically (`accepted → sent → delivered → read`), retain event history, and prevent a late failure from erasing evidence of delivery. Receipt timestamps, not worker receipt time, measure delivery where trustworthy. Provider acceptance and delivery have different metrics.

## Isolation, privacy and spend

The transport staging tables are internal and pre-user; a narrow ingress role may insert/dedupe only. Product tables use tenant-aware foreign keys and forced RLS, with `SET LOCAL app.user_id` inside every application transaction. Runtime roles must not own tables or have superuser/BYPASSRLS privileges. Scheduler access is narrow and explicit. Test cross-user reads, writes, foreign keys and pooled-connection reuse before any user CRUD endpoint ships.

Consent and timezone confirmation precede model processing. Raw content never enters ordinary logs. Model traces use redacted metadata by default. Proposed staging retention is 7 days for unconsented/unprocessed content, 30 days for opted-in raw messages during beta; final policy is an explicit product decision. Secret storage is unsupported in the first version; later encryption must cover inbox, traces, backups and memory, not just a single memory column.

Reserve model/send budget atomically before spending, then settle usage from actual token counts and delivery charges. Rate-limit onboarding and processing separately. Quota exhaustion must be visible; avoid accepting reminders that cannot be delivered under the current plan. A global kill switch pauses new spend while preserving durable work.

## Deployment, measurements and growth

Start with API + worker + managed PostgreSQL/PITR in one region. Add managed Redis when the relay is implemented. Configure external TLS, private DB networking, scoped secrets, readiness probes, migration release step, backups and restore drills. The checked-in Compose file is local-only.

Targets from the playbook remain goals, not measurements: webhook p99 <200 ms, response p50 <3 s / p95 <6 s, and immediate reminder delivery within 60 seconds for 99.5% of eligible occurrences. Track queue age, DB saturation, model latency, correction rate, unknown sends and cost alongside these. Include undelivered eligible occurrences in the SLO denominator; report quiet-hours/digest deferrals and user cancellations separately. See [operations](operations.md).

Scale workers by backlog age and measured provider/DB limits. Tenant locks, bounded connection pools, batch sweeps, query plans and retention come before microservices. Benchmark tenant-filtered vector recall when adding memory; do not assume a global HNSW index guarantees good per-user recall or latency.
