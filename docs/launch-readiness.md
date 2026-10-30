# Remaining launch work

M3-06 is committed and pushed as `34edc99`. Its [GitHub CI run](https://github.com/AymenNF/RappelAI/actions/runs/40990794235) passed. Work after that commit is local until separately committed. **Beta access, live model processing and ordinary-worker sending remain disabled.**

The next delivery is launch preparation, not the memory/dashboard milestone. Local tests cannot complete the external reviews in `ops/launch-reviews.json`. A new application image needs new qualification and review evidence; never copy an old image ID into a report or mark a pending review verified to bypass a blocker.

The owner confirmed **English** for the initial language. Country, hosting provider and domain remain undecided; OpenAI project and Meta test-number setup are not ready. Follow the [account setup checklist](provider-setup.md) before live qualification. No provider purchases, credentials or approvals are assumed.

## Work in order

| Task                          | Current progress                                                                                                                                       | Next work and evidence required                                                                                                                                                                                 | Input needed                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| LR-01: recovery monitoring    | Implemented locally: backup lifecycle records, overdue/failed/stuck backup alerts, restricted archive probe, archive failure/backlog/recovery exercise | Validate on the chosen host, add disk/WAL/archive-capacity monitoring and independent monitor/host checks                                                                                                       | Hosting provider and region                                                       |
| LR-02: hosted security        | Local scoped Docker services and synthetic smoke already work; production startup stays blocked                                                        | Select host/region, configure TLS and private DB, pin images, use independently scoped secrets, exercise rotation and failure behavior; record evidence for that deployment                                     | Host account, domain, residency requirements                                      |
| LR-03: independent recovery   | Physical local PITR and deletion-overlay replay already work; local monitoring now detects missing backup evidence                                     | Configure scheduled encrypted independent backups/WAL and deletion evidence; define retention/expiry; restore after losing access to the source host; test missing-key/expired-chain failures                   | Storage destination, key custody, retention and recovery objectives               |
| LR-04: model qualification    | OpenAI adapter, 60 synthetic cases and versioned runner exist                                                                                          | Human-review every expected result, select a model/rate card and bounded paid-evaluation budget, run the full suite and verify its artifacts; review failures before promotion                                  | OpenAI project readiness, model/budget choice, reviewer, target language          |
| LR-05: WhatsApp qualification | Adapter/template/receipt/recovery tests pass with synthetic providers                                                                                  | Verify actual account/use-case eligibility, approved template names/locales, explicit test recipients, outside-window delivery and receipts; investigate uncertainty using provider evidence                    | Meta test-number status and approved recipients/templates                         |
| LR-06: privacy and access     | Scoped exports, confirmed erasure, retention and feedback deletion are tested locally                                                                  | Approve the real notice/processor/retention choices for intended users; implement and test authenticated export delivery and recipient admission/revocation before live wiring                                  | First country/language, operator identity, private support path, privacy reviewer |
| LR-07: paging                 | Persistent local alerts and health checks exist; new backup/archive signals join the same lifecycle                                                    | Choose a paging destination, send an explicitly authorized synthetic test, verify receipt/acknowledgement/escalation and monitor/DB/host failure detection from outside the host                                | Named incident owner and paging service/contact                                   |
| LR-08: controlled rollout     | Five-person initial plan, maximum twenty, draft invitation/signoff packet, daily UTC reviews                                                           | Test live model/send wiring and recipient restriction while activation remains off; obtain capacity/cost/delivery evidence and explicit owner approval for the candidate; only then consider initial enrollment | Audience, conservative quotas, consented cohort, owner approval                   |

LR-01 reduces the recovery/paging gaps; it does not complete either external gate. No host, storage account, provider configuration, paid run or contact is invented. Supply setup status and choices only; secrets belong in protected configuration, not chat, Git, reports or public issues.

## What was added for LR-01

Migration `0023_backup_monitoring.sql` stores administrator-owned backup runs and monitoring policy. `staging:backup` records a running attempt, verifies the physical manifest and WAL archival, saves private evidence, and only then marks the database record verified. A failed step records its fixed failure category. If the process or database disappears, the remaining running record becomes overdue; it cannot masquerade as a verified backup.

Deploy the migration before starting the new monitor. Review monitor compatibility before rolling back across added alert keys; old monitor versions do not understand the new backup alerts. API/worker rollback also remains subject to the existing schema-compatibility review.

The monitor receives a fixed aggregate function, not general filesystem access or backup administration. Archive delays use the age of **waiting** archive status files, so an idle database does not fail merely because the last successful archive is old. Archive failures and unavailable probe permissions are visible separately. A recent successful archive alone cannot prove that the entire chain is complete. See PostgreSQL's [archive statistics](https://www.postgresql.org/docs/16/monitoring-stats.html#MONITORING-PG-STAT-ARCHIVER-VIEW) and [restricted archive-status function](https://www.postgresql.org/docs/16/functions-admin.html#FUNCTIONS-ADMIN-GENFILE).

The existing restore drill now deliberately blocks archival in its own disposable source, waits for a real sixty-second backlog, observes failure/delay, restores archival and checks recovery before continuing PITR. This never changes the archive command on development or the standing staging stack.

## Operate the new checks

The initial repository thresholds are 25 hours since the last verified backup, one hour for a running backup and five minutes for waiting WAL. These are local alert thresholds, not production RPO/RTO commitments or an installed schedule. Pick hosted objectives and automate backups before relying on them.

```powershell
# Development administrator connection only; staging uses its separate admin mount.
npm run backup:control -- expect on
npm run ops:control -- check
npm run ops:control -- status

# Inspect an overdue process before recording that it was interrupted.
npm run backup:control -- abandon <overdue-run-uuid>
```

For staging, use the migration service's scoped administrator mount for policy changes and the monitor for observation:

```powershell
node scripts/docker.mjs compose -f compose.staging.yaml run --rm migrate node dist/ops/backup.js expect on
npm run staging:backup
node scripts/docker.mjs compose -f compose.staging.yaml exec -T monitor node dist/ops/main.js check
```

Monitoring is disabled by default in a new schema because development/test databases may not archive WAL. The report explicitly shows `enabled: false` and no archive observation in that state; it is not recovery approval. Enable it deliberately in staging after installing migration 0023. Missing first backup evidence then produces an alert. Policy changes are audited. `expect off` stops these checks and must not be used to turn a failing launch review green.

Before migration 0023, `staging:backup` remains usable for the pre-migration safety backup and labels its report `recordedInDatabase: false`. After migration, only newly recorded backups count toward freshness; old report files are not silently trusted or backfilled. Backups do not expire automatically, and a metadata record does not prove its files are still retrievable. Continue verification and independent restore drills.

A physical verification report can exist even if the final database acknowledgement fails. Inspect the command outcome and database run state; `recordedInDatabase` indicates that registration was available, not an independent proof of the final acknowledgement. No automatic retry, file deletion or metadata backfill is performed after an uncertain outcome.

The observation always reports `storageScope: local_only` and `offsiteVerified: false`. The current probe is designed for this PostgreSQL deployment; managed-service permissions or storage APIs may require a provider-specific implementation. Missing probe access raises an alert. PostgreSQL statistics do not cover every possible archive process failure, so backlog, host availability and disk monitoring are also necessary. See [continuous archiving](https://www.postgresql.org/docs/16/continuous-archiving.html).

## Release remains blocked

The current local candidate has [qualification evidence](evidence/launch-qualification.json), an [extended restore report](evidence/launch-recovery-monitoring.json), and a [scoped monitor snapshot](evidence/launch-monitoring-snapshot.json). Its [preparation result](evidence/launch-blockers.json) still blocks launch. These documents identify the tested image; they are historical observations, not permanently fresh approval.

Use the actual candidate image ID with `launch:check` and `beta:prepare`, including `--require-ready`. Keep all seven external reviews pending until their evidence exists. After an image/configuration change, rerun checks and refresh relevant reviews. Monitoring controls only change monitoring; they cannot resume spending, enable providers, enroll recipients or lift restore quarantine.

Record daily reviews using the [private beta guide](private-beta.md). Invitation drafts are still drafts. M4 memory work follows a justified core beta, rather than bypassing these launch tasks.
