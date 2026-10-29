# M3-02: account export, deletion and retention

This is a local administrator-assisted workflow. User requests come from the same verified business-phone/sender identity used by the assistant. There is no public export URL or new unauthenticated account endpoint. No real account is deleted merely by installing this milestone.

## User commands

| Command                                   | Result                                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `EXPORT DATA`                             | Create one pending export request for this account and return its request ID |
| `DELETE ACCOUNT`                          | Explain deletion and issue a separate 15-minute confirmation                 |
| `CONFIRM DELETE <32-character reference>` | Confirm the matching account's unexpired offer and stop future activity      |

For example, Alice sends `EXPORT DATA`. An administrator produces a JSON file for that request and delivers it through a verified private channel. It contains Alice's lists, reminders, settings, messages still retained, action/delivery records and usage history. Bob's rows are excluded. Dedicated token/credential fields are omitted; historical message text may still contain confirmation strings or other sensitive content supplied by the user. Treat the entire export as private.

Alice can then send `DELETE ACCOUNT`, read the consequences, and confirm using the returned reference. An expired or foreign reference does nothing. Repeating an open request reuses it. Privacy requests are available before onboarding and despite ordinary request quotas or an abuse block; they do not require consenting to model use. Actual reply delivery still obeys send caps and global pause. Export requests must be fulfilled before confirming deletion: new exports are refused once deletion is requested.

## What deletion does

Confirmation marks the account as deleting and paused, cancels pending reminders and recurring series, suppresses pending replies/occurrences/outbound intents, invalidates choices and buttons, and exhausts queued send retries. The normal worker stops claiming that account's business work and cancels its queued/leased work in bounded passes. A late worker cannot commit new business effects. START cannot reactivate a deleting account. The confirmation is stored locally; no further outbound assistant message is sent after the account is marked deleting.

An external call authorized before confirmation may still finish. The system records its result rather than claiming it was recalled. Physical removal requires the administrator command below and is held while any model reservation is reserved/dispatched/unknown, or a send is dispatching/unresolved. Cancellation alone is not evidence that a provider did nothing. Ordinary usage recovery releases unsent reservations after work is cancelled; uncertain model usage needs the existing usage reconciliation command. Unknown sends need the existing delivery reconciliation process. Time passing alone never clears these holds. An explicit operator abandonment of a send permits removal while acknowledging uncertainty.

When holds are clear, one transaction installs a replay-blocking fingerprint, erases the user and owned relational records, removes matched and unmatched receipts for the exact address, removes the account's ingress/work rows and account-specific operator audit entries. Another account's data remains. Global spending and aggregate attempt counts are not refunded or falsified. A small operational record keeps only aggregate removal counts and a timestamp.

The fingerprint is SHA-256 over a secret prefix and the structured business-phone/sender address. It is pseudonymous retained data, not a claim of complete anonymization. Its random database key and table are unavailable to runtime roles; a narrowly scoped function answers whether an address is blocked. The fingerprint remains indefinitely to reject delayed webhooks, fresh messages and late receipts without recreating the account. There is currently no self-service re-registration or fingerprint-removal command. Document and review this tradeoff before a real-user pilot.

## Administrator workflow

Use the migration-administrator `DATABASE_URL`. Worker, ingress and tenant logins cannot export through this service, erase accounts, or run retention. `status` exposes request/user IDs to the administrator only.

```powershell
npm run privacy:control -- status
New-Item -ItemType Directory -Force exports
npm run privacy:control -- export <export-request-uuid> exports/account-export.json
npm run privacy:control -- purge <confirmed-user-uuid>
npm run privacy:control -- retention
npm run privacy:control -- retention --apply
```

The export command writes a new JSON file and refuses to overwrite an existing file, then marks the request exported. It requests private file permissions; on Windows, the containing folder's ACL also matters. The repository ignores `exports/`. Use a private local folder, verify the recipient, deliver through a private channel and remove your delivery copy when no longer needed. If writing succeeds but final request acknowledgement fails, the file remains and the command reports an error; do not assume there is no copy. Exports are not automatically emailed or uploaded.

`purge` requires an already-confirmed deletion. It returns `held`, `purged` or `absent`, plus the number of work rows cancelled by that invocation. A held result commits cancellation but retains the records needed for reconciliation. Inspect the existing usage/delivery controls, resolve outstanding outcomes, then rerun. No operator-supplied user ID bypasses the confirmation requirement.

`retention` is a dry run by default: it reports counts while rolling back changes. `--apply` processes at most 100 rows in each cleanup category. Repeating it drains eligible old data; a no-op does not create another audit row. Larger bounded batches are available through the service, up to 1,000 rows/category. This milestone supplies an explicit maintenance command; deployment scheduling and monitoring remain operational setup, not a background desktop automation.

## Retention policy

| Data                                                                            | Local policy                                                                                  |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Completed raw ingress payloads                                                  | Redact after 30 days, retaining envelope/deduplication metadata and receipt recipient mapping |
| Unfinished raw work or unresolved external outcomes                             | Preserve until no longer needed for processing/reconciliation                                 |
| Per-user and global quota counter windows                                       | Delete after 90 days; current allowances remain intact                                        |
| Expired deletion offers                                                         | Mark expired in bounded passes                                                                |
| Lists, reminders, plans, replies, consent/delivery records and account metadata | Keep for the account lifetime; erase through confirmed account deletion                       |
| Global monetary aggregates and anonymous operation counts                       | Preserve after deletion; no refund of historical spending                                     |
| Replay-blocking fingerprint                                                     | Retain indefinitely as described above                                                        |
| Export files, provider-held copies, backups/WAL                                 | Separate copies; not removed by this database command                                         |

`privacy_retention` holds the administrator-owned day settings. The current defaults are implementation choices for local testing, not a legal retention determination. Raw redaction does not erase saved list/reminder content or all historical copies of message content in replies/plans. A database DELETE is logical removal from the active schema, not a guarantee of disk sanitization. Before production, define provider deletion procedures and backup expiry/restore handling. Restoring an old backup must reapply deletion requests/fingerprints before accepting traffic.

## Architecture and verification

Migration `0018_privacy.sql` adds owner-isolated requests/action receipts, the deletion marker, raw-redaction timestamps and administrator-only fingerprint, retention and aggregate-operation tables. Existing ownership foreign keys cascade during account erasure; runtime DELETE privileges are not expanded. Remaining NO ACTION references stay immediate for ordinary writes and are deferred only during the administrator erase transaction, allowing cyclic account-owned records to disappear atomically.

Runtime transactions acquire a shared privacy advisory lock before their existing work/user/usage/provider lock order. Erasure and retention take the exclusive counterpart. This prevents ingress and receipt persistence from racing past erasure. The fingerprint lookup fixes its search path, including placing temporary objects last. The worker's deletion marker gates planning, execution, scheduling and reply sending; durable attempt records gate physical removal.

Exports use an account-scoped repeatable-read transaction. They include tables with an owner ID plus explicitly scoped ingress, work, unmatched receipts and audit data. Live secrets/configuration and other users' data are excluded. This is an administrator tool, not end-user authorization based on an arbitrary UUID. Future schema changes must maintain ownership foreign keys and review export/retention coverage.

Tests cover scoped exports and role denial, expired/foreign confirmations, cancellation and stale leases, complete owner erasure, recurrence/choice cycles, rollback, requests under quota exhaustion, reserved/unknown model holds, sends finishing during deletion, unknown-send reconciliation, concurrent replay, late receipt rejection, retention preview/bounds/idempotence and forced RLS. All provider responses are synthetic. The full regression suite remains required before release.

Stop old workers, run `npm run db:migrate`, rebuild and restart. Live sending remains disabled. Next is **M3-03: telemetry, reconciliation visibility and alerts**. The beginner PDF remains the historical M1-08 snapshot.
