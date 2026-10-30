# M3-03: telemetry, reconciliation visibility and alerts

M3-02 is committed as `3278e50`. M3-03 adds local operational monitoring. It observes the existing durable records and records alert state; it never retries a message, settles a model reservation, raises a spending limit, or erases an account.

## How it works

The API counts webhook responses and latency in fixed buckets. Every 15 seconds it flushes a bounded in-memory buffer and heartbeat to PostgreSQL. The worker records cycle success/failure, recoveries, cancellations and a heartbeat after each cycle. Flushes retry the same batch ID after a failed or uncertain acknowledgement. They never turn a persisted webhook into a failed acknowledgement or stop business work because telemetry is unavailable. A process crash can lose unflushed counters; these are operational estimates, not the usage ledger. Long outages saturate each buffered counter at one billion.

An independent administrator monitor reads queues, model reservations, send attempts, receipts, deletion markers and spending aggregates. It saves one current snapshot, one alert row per fixed rule, and transition history. It also exposes bounded pages of opaque record IDs so the operator can find the existing recovery command. An account's diagnostic rows disappear when its data is erased; aggregate monitoring history contains no account IDs.

For example, a send times out and stays `unknown`. After five minutes, the monitor opens `send_unknown` with instructions to inspect provider evidence. Repeated checks update the affected count without creating another open event. Acknowledging the alert records that someone has seen it; the send stays unknown. Once the delivery reconciliation command resolves it, the next monitor check resolves the alert. A later unknown send opens a new generation, and an acknowledgement for the old generation cannot hide it.

## Run locally

Apply all migrations and rebuild/restart API and worker. Local commands can use the migration-administrator `DATABASE_URL`; M3-04 staging uses a dedicated `MONITOR_DATABASE_URL_FILE` with the restricted `memorae_monitor` capability. See [staging commands](staging.md). The CLI prefers the monitor URL when present:

```powershell
npm run ops:control -- check
npm run ops:control -- status
npm run ops:control -- expect api on
npm run ops:control -- expect worker on
npm run ops:control -- watch
```

`check` performs one observation and persists any transitions. `watch` runs independently every 15 seconds and prints structured observation/alert events. Ctrl+C exits. It is a process you deploy or run explicitly; this milestone does not install an OS service, desktop automation or external paging integration. Defaults expect neither local process to run continuously. Turn expectations on for a supervised deployment and off for intentional shutdowns. A heartbeat means at least one instance of the component flushed recently, not that every replica is healthy. Worker polling or long cycles exceeding 120 seconds need operational review before enabling that expectation.

`status` shows the most recent persisted snapshot, current alert states and latest 50 transitions. `monitor` is `never_observed`, `current`, or `stale` (over 60 seconds since the last successful check). Reading status does not refresh the observation. A failed check never claims recovery or resolves old alerts. A database outage also prevents durable database alerts: watch emits a fixed `monitor_failed` event on stderr. Deployment must independently watch the monitor process, its freshness and stderr; monitoring cannot prove its own availability.

```powershell
npm run ops:control -- queue work 25
npm run ops:control -- queue model 25
npm run ops:control -- queue send 25
npm run ops:control -- queue receipt 25
npm run ops:control -- queue privacy 25
npm run ops:control -- ack send_unknown 1
```

Each queue page returns `items` and `next`. To continue, append the returned `createdAt` and `id` after the page size. Ordering preserves database microseconds; pages allow 1–200 rows. This is a live queue: records resolved between pages can disappear, and new older records can require a fresh scan. IDs are for trusted operators only, not end-user authorization. Work IDs feed `work:retry`; model reservation IDs feed usage reconciliation; send IDs feed delivery reconciliation; privacy IDs are the confirmed account IDs used by privacy purge. Unmatched receipt IDs require investigation, never guessed linking.

## Initial alert rules

Migration 0023 adds opt-in backup and WAL archive checks to this same alert lifecycle: overdue/failed/stuck backups, disabled/failing/stalled archival, and an unavailable archive probe. Their defaults and administrator controls are documented in [launch-readiness work](launch-readiness.md). They expose aggregate health without filesystem privileges, do not notify an external paging service, and do not establish off-site recovery.

| Condition                               | Trigger                                                                          | Main response                                                         |
| --------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Expected API/worker heartbeat           | Missing or at least 120s old                                                     | Check process, database and flush/cycle health                        |
| Webhook 5xx / overload / slow response  | At least one in the current and previous four minute buckets; slow means over 1s | Inspect persistence, queue capacity or latency                        |
| Worker cycle errors                     | At least one in those five buckets                                               | Inspect worker/database failures                                      |
| Runnable work                           | At least 60s old; pending and available now                                      | Check ordered blockers, disabled planning and recovery                |
| Dead work / expired lease               | Any                                                                              | Repair before intentional retry; let lease recovery fence old workers |
| Reserved/dispatched/unknown model usage | At least 300s old                                                                | Inspect usage evidence and holds                                      |
| Unknown send / overdue dispatch         | Unknown at least 300s old, or dispatch deadline passed                           | Reconcile evidence; no automatic resend                               |
| Terminal rejection/delivery failure     | Attempt created within 24h                                                       | Check template/credential configuration and intentional recovery      |
| Late acceptance conflict                | Any without a later operator acceptance resolution                               | Preserve pause and reconcile provider truth                           |
| Unscheduled reminder / unsent outbound  | At least 60s beyond original due/promised availability                           | Inspect scheduler, activation, templates, quotas and spending         |
| Unmatched receipt                       | At least 300s old                                                                | Inspect address/provider evidence                                     |
| Confirmed deletion                      | Waiting at least one hour                                                        | Resolve usage/send holds and complete administrator removal           |
| Global monthly budget pressure          | Enabled cap >0 and reserved + spent at least 90%                                 | Inspect exact ledger totals; no automatic cap increase                |

These fixed initial thresholds are local policy in `rules.ts` and `snapshot.ts`, not measured production SLOs. Bucket windows span the current partial minute plus four whole minutes. HTTP buckets are exclusive: ≤50ms, (50,200]ms, (200,1000]ms and >1000ms. No percentile or on-time-delivery percentage is fabricated. Provider acceptance, sent, delivered and read remain separate dimensions; totals count attempts, not unique reminders. Snapshot outcome counts reflect retained database rows and can decrease after account deletion. Monetary amounts remain integer microdollar strings, including values beyond JavaScript's exact number range.

Future backoff is excluded from runnable-work alerts. Intentional disabled planning/sending can still produce backlog and missed-promise alerts, since it does not fulfill existing commitments. Outbound lateness excludes intents with accepted/in-flight/unknown attempts; unknown/deadline rules cover those unresolved calls. Unsent identity/plan replies remain inspectable through their existing source/attempt records; the overdue-outbound rule covers materialized reminder intents. Late receipts for an accepted send are visible through delivery state, but this release does not impose a receipt-delivery deadline or calculate a delivery SLO. Broader per-user anomaly, model-quality, database capacity and host-level alarms remain deployment/qualification work.

## Privacy, access and retention

The migration administrator or M3-04's dedicated monitor login can inspect monitoring, acknowledge alerts, change expectations and read diagnostic queues. The monitor has column-limited lifecycle reads and monitoring-only writes, without business content, provider secrets, spending changes or erasure privileges. The ingress and worker logins can call a narrowly scoped definer function for their own telemetry component only. The function validates a fixed numeric counter vocabulary and fixes its search path with temporary objects last. Ingress/worker roles cannot access monitoring tables directly; tenants have no operational access. No public diagnostics HTTP endpoint is added.

Ordinary telemetry contains no bodies, addresses, provider message IDs, user IDs, tokens, request URLs, arbitrary labels or raw error text. HTTP logging uses generated request IDs, safe serializers, fixed framework error responses and a fixed not-found response, including malformed/unsupported-content requests. Operator diagnostics contain only opaque IDs, lifecycle states and timestamps/ages. These IDs still warrant restricted handling.

Each successful check prunes at most 1,000 expired rows per category: counter buckets and batch-deduplication records after seven days, transition history after 30 days. Deduplication is guaranteed while the batch record is retained, not indefinitely across an outage of more than seven days. Only the newest aggregate snapshot and fixed current alert states remain. Acknowledgements have no free-text field. Retention of external stdout/log sinks and backups must be configured separately; this command does not manage those copies. Neither check nor acknowledgement mutates business state.

## Verification and next step

Tests inject webhook/worker failures, stop and revive heartbeats, age queues and provider holds, create unknown/rejected/conflicting sends, distinguish acceptance from delivery, age deletion/receipt work, reconcile held usage, exercise concurrent checks and stale acknowledgements, roll back a failed observation, verify numeric batch deduplication, test fixed-path function isolation and runtime/tenant denial, inspect log privacy, page microsecond ties, and prune history without deleting business data. Transports remain synthetic.

M3-04 runs the API, worker and monitor as separate local containers and verifies backup/PITR recovery. M3-05 now supplies [failure/load tests and launch gates](qualification.md), including observing missing-worker detection and recovery. An external alert destination and independent host, storage, archive-lag and monitor supervision still need hosted configuration.
