# Usage reservations and spending controls (M1-05)

Migration 0007 adds global and per-user monthly budgets, versioned rate cards, reservation/settlement accounting, recovery and operator audit. The planner meters every new provider attempt; saved plans are reused without another reservation. The global switch starts **off**, with zero limits and no active rate cards. Remote provider calls remain disabled in worker configuration.

Stop existing workers before migration and restart the updated build. Older workers do not use the spending gate.

## Accounting contract

All amounts are integer USD microdollars: 1,000,000 micros = USD 1. Rate-card prices are micros per million tokens. Cost uses integer arithmetic and rounds upward once per attempt:

```text
ceil((input_tokens × input_rate + output_tokens × output_rate) / 1,000,000)
```

The accounting period is the UTC calendar month, independent of a user's reminder timezone. Admission reserves the rate card's configured maximum input/output token cost in both global and user counters. A short database transaction locks the singleton policy row, verifies the live work lease and current consent, and checks `spent + reserved + new reservation <= limit` in both scopes. That lock orders concurrent reservations, settlements, dispatch authorizations and operator changes. It favors correctness at current scale; production throughput has not been benchmarked.

An override in `usage_user_limits` replaces the default user cap. Zero limits allow only zero-cost reservations. Lowering a limit does not erase spent amounts or existing reservations; it blocks further admissions that do not fit. Missing/inactive rate cards fail closed. A new rate version becomes effective when installed; existing reservations retain their original rates and token ceilings.

The tuple `(work_id, lease_token)` identifies one attempt. Duplicate reservation requests return the same reservation; only one transition from reserved to dispatched succeeds. A retry with a new lease receives a new reservation after any older uncertain attempt is reconciled. This avoids treating retries as free requests.

## Dispatch, settlement and recovery

| State        | Meaning                                           | Recovery                                                                   |
| ------------ | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `reserved`   | Budget held; no external request authorized yet   | Release if cancelled or its work lease is lost                             |
| `dispatched` | A request was authorized and may have been sent   | If abandoned, move to unknown and retain the full hold                     |
| `unknown`    | Usage cannot yet be established                   | Keep the hold and block new attempts for that event until evidence arrives |
| `settled`    | Actual token usage recorded; unused hold returned | Duplicate identical settlement is a no-op                                  |
| `released`   | Definitely unsent reservation returned            | Terminal; a new attempt needs a new lease                                  |

The switch, lease and consent are checked again in the dispatch transaction. Its commit is the authorization boundary. A pause prevents authorizations after that boundary; it cannot retract a request already authorized or in flight. No SQL transaction stays open across a provider request. There is an unavoidable gap between committing dispatch and issuing HTTP; a crash in that gap is conservatively treated as uncertain rather than automatically refunded.

Provider token usage is settled before decision validation or plan persistence. Thus malformed decisions, a later STOP, and plan-transaction rollback do not erase a potentially billed call. Model errors without trustworthy usage—including timeouts and some refusals/HTTP errors—keep the full reservation. If an old request eventually returns valid usage, it can settle its own attempt even after losing its work lease; its plan result still cannot commit through a stale lease.

Settlement is idempotent and uses the reservation's original UTC month. A reservation from a previous month cannot newly dispatch; it must be released and retried under the current month. Recovery runs each worker cycle and releases only definitely unsent holds. Unresolved calls never expire into free budget.

If actual usage exceeds a configured ceiling, the ledger records the actual amount and automatically pauses spending. It does not clamp the charge to the estimate. Conflicting settlements or amounts outside the supported range also pause spending and create an audit event. This is a reservation cap, not a guarantee against an incorrectly priced or misconfigured external provider. In-flight overruns can exceed a cap; qualifying rates, input ceilings, output limits and provider billing rules is required before live activation.

Budget, kill-switch, rate-configuration and unresolved-usage blocks postpone work for 60 seconds without consuming an attempt. Onboarding and STOP continue. Work remains durable and visible through `last_error_code`; there is no user-facing quota response or WhatsApp sender yet.

## Operator commands

Commands use local administrator `DATABASE_URL`, never credentials exposed to clients. The operator must own the usage policy table (or be its administrator); the current local setup uses the migration administrator. A production operator role with suitable RLS policies remains a deployment task. Notes are saved with the database actor and configuration changes in `usage_audit`.

```powershell
npm run usage:control -- status
npm run usage:control -- pause "Investigating unexpected usage"
```

Amounts below are illustrative application limits, not provider prices or a recommended budget:

```powershell
# USD 10 global and USD 1 per user, per UTC month
npm run usage:control -- limits 10000000 1000000 "Local budget experiment"
npm run usage:control -- user-limit <user-uuid> 2000000 "Approved local override"
npm run usage:control -- resume "Limits and rates reviewed"
```

Install a JSON rate card using `usage:control -- rate <path> <note>`. The schema requires provider, model, a new version, integer-string input/output prices, and maximum input/output tokens. Only one version per provider/model is active. The reservation snapshots all values. The model name in the response must match the qualified model ID; changing aliases/pricing requires explicit review. The byte-size preflight and provider output-token limit are additional checks, not a tokenizer or model-pricing certification.

For offline fixture mode only, a checked-in zero-price card is available:

```powershell
npm run db:migrate
npm run usage:control -- rate config/rates/fixture.json "Install offline fixture rate"
npm run usage:control -- resume "Enable offline fixture planning"
$env:MODEL_MODE = 'fixture'
npm run dev:worker
```

No real provider rate or monetary budget is configured automatically. Reinstalling the same version is rejected rather than overwriting historical configuration. The zero-price fixture works with zero caps after explicit resume.

## Reconciling unknown calls

Inspect only opaque IDs and accounting metadata:

```sql
SELECT id, event_id, provider, model, rate_version, reserved_micros, dispatched_at
FROM usage_reservations WHERE state='unknown' ORDER BY created_at;
```

After obtaining authoritative token usage (or evidence that no billable request occurred):

```powershell
npm run usage:control -- reconcile <reservation-uuid> <input-tokens> <output-tokens> "Evidence reference"
```

Use zero tokens only with evidence of no charge. This command settles the original rate snapshot and records the note atomically; it cannot alter active requests or silently delete history. Deferred work retries on its next due cycle. If the work is already dead, repair the cause and use the existing `work:retry` command. Investigate `ceiling_exceeded`, `conflicting_settlement` and `unrepresentable_cost` audit entries before resuming a paused system. Corrections to a disputed settled entry require a reviewed administrative ledger correction; there is no automatic overwrite.

## Boundaries and evidence

Tenants can read only their own limits, counters and reservations under forced RLS. They cannot modify them or inspect global controls, rates or audit. Ingress has no usage access. The trusted worker can maintain counters/reservations and append audit entries but cannot raise limits, edit rates, enable spending or delete audit rows. As with the existing worker role, compromised worker SQL credentials are outside the application invariant; this is not a protection against arbitrary administrator or trusted-worker SQL.

Current integration covers model planning only. Future sends and other paid adapters must use an appropriate reservation gate before activation. The current price model does not include external tools, audio, caching discounts, taxes or provider-specific billing adjustments. No live prices, spend, AI accuracy or production load results are claimed. No new paid request was made during implementation.

Tests cover competing reservations, global/user caps and overrides, idempotent dispatch/settlement, pause/resume, recovery of unsent versus uncertain work, audited reconciliation, rate snapshots, UTC-month accounting, automatic overrun stop, failed settlement, zero-call deferral and tenant/role isolation. M1-06 now performs transactional reminder/list mutations and creates reply intents from saved plans without new paid calls. The spend pause does not prevent that local execution. M1-07 test dispatch checks the same global pause, but does not implement WhatsApp price reservations and is not wired to live sending. Billable delivery requires separate rate/budget qualification. See [WhatsApp delivery](whatsapp-delivery.md).
