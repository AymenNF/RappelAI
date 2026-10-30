# M3-05: failure exercises, load and launch readiness

This milestone tests how the system behaves when processes or the database fail. It also measures a small synthetic load and records the remaining launch gates. Passing these local exercises does not enable real WhatsApp sends, paid models, or a public beta.

M3-04 is committed and pushed as `b63d913`. M3-05 changes remain local until separately committed. No database migration is required for M3-05.

## Run the disposable environment

From the repository root, with Node.js 24 and Docker Desktop/Linux containers:

```powershell
npm run check
node scripts/docker.mjs build --build-arg APP_REVISION=local-qualification -t memorae-qualification:local .
$env:MEMORAE_IMAGE = 'memorae-qualification:local'
npm run qualify:run
```

The runner creates fresh resources named `memorae-qual-<random-id>`, generates new secret files, applies migrations, provisions restricted database roles, and runs the compiled API and worker. PostgreSQL has no host port. Only the API publishes a randomly selected loopback port; the runner discovers it again after restart. A local fake provider runs solely on the private network.

This does not stop or alter the existing development or staging services. New containers, networks and data volumes carry a unique label. Cleanup removes only resources with the expected names and matching label, then checks that no labelled resources remain. A failed exercise or failed cleanup cannot produce a passing functional report. If Docker is interrupted, inspect the exact run label before removing anything; never use a broad Docker prune.

The ignored `.qualification/<id>/` directory retains private generated credentials and failure diagnostics. Share only its `report.json`, which contains measurements, image identity and fixed scenario names. Never copy the whole folder into Git or an artifact upload.

## What the exercises establish

| Exercise            | Injection and required evidence                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed replay       | Eight concurrent identical signed webhooks produce one ingress record and one work record.                                                                                                                                  |
| Database outage     | Stop the disposable database; readiness and webhook persistence return 503. Restart it and retry: the event appears once.                                                                                                   |
| API restart         | Kill the API after acknowledged persistence, restart it and replay: no duplicate ingress.                                                                                                                                   |
| Monitor recovery    | Expect a worker before starting it, observe a missing-worker alert, then start the real worker and observe resolution. This checks missing startup, not a timed 120-second stale-heartbeat outage.                          |
| Crash before commit | The real execution service writes a list item and action receipt inside an open transaction. Kill that process before commit. No item remains; the ordinary worker recovers the expired lease and commits one item/receipt. |
| Crash after commit  | Kill the fixture process after the transaction commits. Restart processing; the item and action receipt remain singular.                                                                                                    |
| Unknown-send crash  | A local fake provider counts acceptance but withholds its response. Kill the sender, wait for the real dispatch deadline, recover the attempt to `unknown`, and try again. The provider's acceptance count stays one.       |
| Load and drain      | Send two profiles of unique signed events, then verify every event and onboarding result exists once and every work item completes. Spending ends paused.                                                                   |

The crash fixtures invoke existing `WorkQueue`, `ExecutionProcessor` and `TestReplySender` services under restricted worker credentials. Only fixture seeding uses administrator access. There are no runtime HTTP switches for injecting faults. Fixture commands reject a database outside their freshly named lab. The normal worker still has sending and model processing disabled.

The existing integration suite separately covers stale lease tokens, concurrent sweepers, per-user ordering, reversed receipts, exact-time promises, tenant isolation, spending races, privacy and restore gates. The previous physical PITR exercise remains in `restore:drill`. Redis/calendar failures are not claimed: neither is part of the current execution path.

## How to read the load report

Two fixed, bounded profiles run: **60 requests at concurrency 1**, then **240 requests at concurrency 8**. Each request uses a distinct synthetic sender and triggers onboarding. This measures signed ingress, durable persistence, identity work and database contention. It does not measure model inference, reminder delivery, provider latency, hot-account traffic, large existing data volumes or sustained production capacity.

The runner records all HTTP status codes and transport failures without retries. Failures stay in the sample denominator. It reports total elapsed time, attempted requests per second and nearest-rank p50/p95/p99/max latency. A 60-sample p99 is the largest sample; it is not a reliable estimate of rare-tail production behavior. Drain time starts **after** the HTTP profile finishes and measures remaining onboarding backlog, not end-to-end message delivery.

The initial repository target is **webhook p99 below 200 ms** and residual backlog drain at most **60 seconds** for each profile. These are acceptance targets, not promises. Functional integrity and performance are separate report outcomes: a run may preserve every message while missing the latency target. `qualify:run` fails on correctness/cleanup failures; latency failures remain explicit and block launch readiness without making hardware-dependent CI timings mandatory.

The generator uses closed-loop concurrency: it starts the next request when an earlier one finishes. It slows its offered load when the service slows, so this does not establish a fixed arrival-rate capacity. Before choosing beta limits, run a longer arrival-rate and soak test on the actual host, record CPU/memory/DB connection and storage headroom, test a realistic database size and user mix, and repeat. See [Grafana's explanation of open versus closed workload models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/).

## Launch-readiness check

Use the report path printed by the runner and the **expected candidate image ID**, obtained independently:

```powershell
node scripts/docker.mjs image inspect memorae-qualification:local --format '{{.Id}}'
npm run launch:check -- .qualification/<run-id>/report.json sha256:<candidate-image-id>
# A release gate must also fail its command when readiness is false:
npm run launch:check -- .qualification/<run-id>/report.json sha256:<candidate-image-id> --require-ready
```

The check requires all eight scenarios exactly once, both complete load profiles with sufficient requests/concurrency, consistent counts, successful cleanup, and the latency/drain target. Evidence must match the expected image and be no more than seven days old; timestamps more than five minutes in the future are rejected. Seven days is an initial local review policy, not a provider rule. Changing the candidate image invalidates earlier review attestations.

`ops/launch-reviews.json` records the remaining gates. A verified entry needs a named reviewer/owner, an evidence reference, review time and exact image ID. Missing, duplicated, pending, empty, stale or wrong-image reviews keep readiness false. The CLI displays blockers by default; `--require-ready` exits nonzero while blocked. Malformed evidence always exits nonzero.

| Review gate                | Evidence needed                                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Regression suite           | Current type/unit/integration/evaluation-fixture/build checks and results for the candidate.                                              |
| Real model evaluation      | Human-reviewed cases and a real versioned prediction report meeting the applicable accuracy/injection gates.                              |
| Provider/template delivery | Actual account eligibility, approved templates, outside-window test delivery, receipts and provider uncertainty exercise.                 |
| Production privacy         | Real consent notice, export authorization/delivery, erasure/retention procedures and processor review for intended users.                 |
| Hosted security            | Chosen region, TLS, private database, scoped hosted secrets, rotation, image qualification and restricted access.                         |
| Off-site restore           | Scheduled encrypted off-site backups/WAL, tested retention, independent deletion evidence and restore/rollback evidence on the candidate. |
| Paging and ownership       | External paging, named incident owner, monitor/host/storage/archive-lag failure tests and response procedures.                            |
| Beta rollout               | Audience, conservative quotas, measured capacity, support path, rollout/rollback plan and approval by the project owner.                  |

Review entries are operator attestations with supporting references, not cryptographically verified facts. A JSON edit cannot establish provider delivery or compliance. The readiness command does not change runtime settings, deploy, send messages, or grant approval on the owner's behalf. Keep unsupported gates pending.

## CI and next work

CI runs the physical restore and qualification exercises in an ephemeral Linux runner. It uploads only `report.json` files from those runs for 14 days, including failed-run reports; secret and diagnostic files are excluded by the exact paths. This change has not run remotely while M3-05 is uncommitted. See [GitHub's workflow artifact documentation](https://docs.github.com/en/actions/tutorials/store-and-share-data).

After reviewing local results, address any failed performance gate and the pending hosted/provider checks. **M3-06 private beta stays gated** until all relevant evidence exists. A local pass is a useful rehearsal, not a substitute for hosted soak tests or real delivery verification.
