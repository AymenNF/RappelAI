# Operations, launch gates and cost planning

This combines local implementation and target production procedures. M3-03 implements telemetry, diagnostics and durable alerts; see [telemetry](telemetry.md). M3-04 runs a separate local Docker staging project with scoped secrets, a restricted monitor, verified base backups/WAL and a real restore drill. Follow [staging](staging.md) and [backup/restore](backup-restore.md). Production hosting, encrypted off-site storage, backup scheduling, external paging and live provider activation remain pending.

## Environments and release

Local development: Compose PostgreSQL, optional Redis and fixtures. Current staging: a separate Docker project on this computer, synthetic traffic only, localhost API and private database. Future hosted staging: independently provisioned dependencies and approved provider test recipients. Production: separate credentials, restricted network access, scoped runtime roles and durable off-site backups.

Release order: checks → migration compatibility review → database backup verification → migration job → API/worker rollout → readiness and signed synthetic smoke check → observe delivery/backlog/cost. API and worker images use the same commit. Record model IDs, prompt hash, schema version and rate-card version alongside the deployment. Pin deployed container images by digest after qualification.

Rollback: stop new spending if needed; roll back compatible application image; preserve inbox/outbox and ledger. For data changes, use a reviewed corrective migration or restore drill procedure, not ad hoc deletion. Never replay all outbound messages indiscriminately after restore: reconcile accepted/delivered/unknown attempts first.

## Local work recovery

M1-03 recovers expired leases on each worker cycle, caps retries and preserves per-user order. Inspect dead work, repair its cause and use `npm run work:retry -- <dead-work-uuid> <operator-label>`. See the [work processing runbook](work-processing.md). M3-03 adds detection and durable alert state; M3-04 supplies local Docker restart policies and health checks. External paging and host/backup supervision remain to be configured.

## Spending controls

M1-05 provides `npm run usage:control -- status`, `pause`, `resume`, limit/rate configuration and evidence-based reconciliation. The switch starts off and affects new model dispatch authorizations; already authorized work may finish and settle. Unknown calls retain their reservation. See [usage controls](usage-controls.md) before operating or enabling fixture planning.

## Signals and initial alert proposals

| Signal                               | Initial target / trigger                                         | Response                                                        |
| ------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------- |
| Webhook acknowledgement              | p99 <200 ms; persistence failures alert immediately if sustained | Check database, connection pool and ingress traffic             |
| Oldest pending work                  | Alert beyond 60 seconds for normal text                          | Check worker health, lease recovery, provider latency           |
| Immediate on-time delivery           | Goal 99.5% within 60 seconds                                     | Investigate by due cohort, include missing deliveries           |
| Unknown send attempts                | Any unresolved beyond a short reconciliation window              | Inspect correlated receipts; avoid blind retry                  |
| Dead tasks / permanent send failures | Any new sustained class                                          | Inspect template/credentials/quotas; recover intentionally      |
| Model failures / escalation          | Compare with measured baseline                                   | Roll back prompt/model or constrain paid calls                  |
| Per-user / global spend              | Hard caps plus deviation from baseline                           | Pause new paid work; preserve commitments and alert             |
| DB storage / connections / lag       | Provider-specific headroom thresholds                            | Scale or correct retention/query behavior                       |
| Restore verification                 | Before beta and at a regular operational cadence                 | Restore to isolated instance and exercise pending-work recovery |

Targets are unmeasured until telemetry and traffic exist. Avoid high-cardinality labels containing phone numbers or raw messages. Trace by opaque IDs. Count API acceptance, delivery and read separately. Current digest entries are individual messages at a daily slot. The current monitor reports attempt counts and lateness, not an on-time-delivery SLO; a future cohort calculation must include missing deliveries and deduplicate retries. Use the ledger for cost.

## Failure exercises

M3-05 automates eight local scenarios through `npm run qualify:run`, including real process kills before/after transaction commit, a database outage, and a sender killed after synthetic provider acceptance. It also verifies signed load and complete backlog drain. See the [qualification guide](qualification.md) for the executable scope and [recorded evidence](evidence/m3-05-qualification.json). Scenarios for future Redis/calendar integrations below remain targets, not completed exercises.

| Inject                                         | Expected behavior                                          |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Replay a webhook / eight concurrent duplicates | One inbox event and one work intent                        |
| Fail storage before commit                     | 503; no false acknowledgement                              |
| Stop Redis after inbox commit                  | Webhook stays accepted; database backlog recovers          |
| Kill consumer after action commit              | Retry finds receipt and does not repeat mutation           |
| Run two sweepers                               | One occurrence and one internal intent                     |
| Kill sender around HTTP request                | Uncertain attempt surfaced; not blindly resent             |
| Deliver statuses in reverse order              | Delivered/read evidence never regresses                    |
| Revoke WhatsApp credential / reject template   | Classified failure and actionable alert; no infinite retry |
| Expire calendar refresh token                  | Reconnect state; reminder remains valid                    |
| Force two users through pooled connections     | No leaked tenant context                                   |
| Restore database from backup                   | Reconcile work and external sends before replay            |
| Exceed budget concurrently                     | Atomic reservation prevents paid work beyond policy        |

## Cost model

Vendor rates are inputs with effective dates, recipient markets and categories. The PDF's fixed pricing/allowance claims are unresolved; consult [source review](playbook-review.md).

```text
monthly variable cost =
  sum(delivered billable messages by country/category/window × applicable rate)
  + model input tokens / 1,000,000 × input rate
  + model output tokens / 1,000,000 × output rate
  + embedding tokens / 1,000,000 × embedding rate
  + transcription minutes × rate
  + media/storage/egress costs

cost per active user = variable cost / active users + fixed infrastructure / active users
gross margin = (net revenue - attributable costs) / net revenue
```

Account for provider/BSP fees and taxes separately; do not allocate a free allowance as if every user receives it independently. Compare low/expected/heavy use and provider-rate increases. Track attempted versus delivered sends and reserved versus settled costs. Set account limits and application limits; preserve and report existing commitments if new spend is paused. Choose actual caps only after measuring pilot usage.

## Pre-beta launch checklist

Use `npm run launch:check -- <qualification-report> <expected-image-id> --require-ready` as the executable gate. It combines fresh matching-image local evidence with all reviews in `ops/launch-reviews.json`; missing evidence blocks readiness. Current local success does not satisfy hosted/provider/privacy/rollout approvals. The detailed checklist below remains the project owner's launch review, not an automatic approval.

- [ ] Current platform eligibility, sending limits and template approval verified for the actual account.
- [ ] Real model evals recorded; scope-appropriate accuracy and injection gates pass.
- [ ] Webhook replay, consumer restart, two-sweeper and queue-loss tests pass.
- [ ] Outside-window reminder delivers through an approved template.
- [ ] Unknown attempt and out-of-order receipt behavior demonstrated.
- [ ] User identity, consent, timezone and tenant isolation verified.
- [ ] Export, deletion, cancellation of queued work and retention jobs demonstrated.
- [ ] Raw content/secrets excluded from logs and ordinary traces.
- [ ] Rate limits, quota reservation and global spending stop exercised.
- [ ] Non-owner runtime roles, private DB, secrets and TLS configured.
- [ ] Backup restored into a clean environment; replay reconciliation practiced.
- [ ] Delivery/backlog/unknown-send/cost alerts tested with named operator responsibility.
- [ ] Rate card, processor disclosures and applicable privacy requirements reviewed for intended markets.
- [ ] Staged rollout and support path agreed; sample sizes and limitations reported honestly.
