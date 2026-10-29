# M3-01: abuse controls, rate limits and quota messages

This milestone bounds incoming work, model/send attempts, and saved inventory. These count limits complement the existing monetary spending reservations, global pause, finite recurrence and bounded delivery retries. Live sending and paid model calls remain disabled.

## What a user sees

Send `QUOTA` to see current request/model/send usage, pending reminder and stored item counts, reset rules and global pause status. The reply does not expose another account's usage or internal budget amounts.

For example, after using a minute's request allowance, an edit receives: “Request limit reached. Nothing was applied or queued for later. Retry after the next minute begins.” The edit is not delayed and applied unexpectedly. The user can resend it after the reset. A daily limit points to 00:00 UTC. An oversized message asks for a shorter message, and an operator-blocked account asks for review.

Only the first rejection notice per user per minute has reply text; subsequent rejections are stored without replies. `QUOTA` is available outside the ordinary request allowance, with at most one status reply per minute. These replies still pass through send limits, account blocking, consent/window gates and the global pause. Blocked-account notices are stored but cannot be sent while the operator block is active. A send-limit warning cannot itself bypass a send cap. The local chat simulator can show stored replies while live sending is disabled.

STOP and syntactically valid reminder DONE/COMPLETE/CANCEL controls bypass incoming request limits and account blocking. Their normal identity, ownership and stale-reference checks still apply. Processing these controls remains possible when outbound acknowledgements are capped. Snooze, edits, new reminders, list commands and preferences use the ordinary allowance. Delivery receipts remain processable under request exhaustion.

## Default limits

| Limit                            |                 Default | What counts                                                         |
| -------------------------------- | ----------------------: | ------------------------------------------------------------------- |
| Requests per user/minute         |                      60 | Admitted messages, including onboarding and commands                |
| Requests per user/UTC day        |                   1,000 | Same; rejected requests do not consume another slot                 |
| Model attempts per user/minute   |                      20 | Durable dispatch authorization, including retries                   |
| Model attempts per user/UTC day  |                     100 | Same, including failed/uncertain calls                              |
| Send attempts per user/minute    |                      30 | Shared across reminder and reply senders                            |
| Send attempts per user/UTC day   |                     200 | Same, including retries and uncertain sends                         |
| Model attempts globally/UTC day  |                  10,000 | Across accounts                                                     |
| Send attempts globally/UTC day   |                  20,000 | Across accounts and both send paths                                 |
| Pending reminders per user       |                     500 | One-time reminders and all pending recurring children               |
| Stored list items per user       |                   5,000 | Includes completed items; completion does not free storage          |
| Text length                      | 4,096 UTF-16 code units | Oversized ordinary commands/messages are rejected before processing |
| Events per webhook batch         |                   1,000 | Oversize batches return HTTP 413 without partial persistence        |
| Unfinished ordinary inbound work |                  10,000 | Capacity shared across API processes; includes blocked/dead stages  |

Minute limits use fixed clock-minute windows. Daily limits use UTC midnight, independently of user timezone. Fixed windows permit traffic on both sides of a boundary; these are not rolling-window or smooth-throughput guarantees. Defaults are initial local policy, not measured production capacity or provider limits. Zero disables that operation; other limits remain independent.

Inventory checks reject the entire saved plan before any reminder/item is created and store a quota reply. Recurrence checks capacity at preview and again at confirmation. Completing/cancelling reminders frees pending capacity. List deletion and retention are M3-02 work; for now an operator must review a full list-item account. Existing data is not deleted when a limit is lowered.

Model work that was already admitted waits when its attempt limit is exhausted; the work runner defers it without spending a retry attempt. Unused monetary reservations are released. Sending likewise leaves the outbound intent pending and makes no provider call. `QUOTA` explains that already-queued work waits, whereas rejected incoming requests are not queued for later execution.

## Exact-time reminders and limits

Quota checks never rewrite original or promised due times. A future digest intent still cannot delay an earlier exact-time intent merely because of its delivery mode. However, exhausted send limits, global pause, provider errors or unresolved sends can prevent timely delivery. The stored promise stays unchanged, so lateness remains observable rather than silently reclassified as a new promise. No delivery SLO or live delivery claim is made.

## Operator commands

Use the existing migration-administrator `DATABASE_URL`; worker and tenant credentials cannot change policies or block accounts. The CLI validates the complete policy, requires an evidence note, and records changes in `quota_operator_audit`.

```powershell
npm run quota:control -- status
npm run quota:control -- limits config/quota-policy.example.json "Reviewed local capacity"
npm run quota:control -- block <user-uuid> "Abuse investigation reference"
npm run quota:control -- unblock <user-uuid> "Review completed"
```

Copy/edit the [example policy](../config/quota-policy.example.json) before applying different limits. Policy changes do not erase counters or refund attempts. Blocking prevents new ordinary requests, model dispatch, execution and sends; STOP and reminder cancellation/completion remain possible. An already authorized external call may still finish and its result must be recorded honestly. Unblocking permits pending work to proceed under its original consent, schedule, budget and quota checks.

## Architecture and persistence

Migration `0017_quotas.sql` adds administrator-owned `quota_policy`, owner-scoped `quota_accounts`, `quota_counters` and immutable `request_admissions`, shared `quota_global_counters`, and administrator-only `quota_operator_audit`. Tenant tables force RLS. Ingress cannot inspect quota/account tables. Workers can consume counters and append admission receipts but cannot alter policy, block flags, receipts or operator audit. Event-owner triggers prevent cross-user admission receipts. Runtime workers remain trusted services across tenants, as in the existing architecture.

Admission runs after verified sender mapping and before onboarding/business changes, under the user lock. Admission, counters, identity reply and work acknowledgement share a transaction. Replay uses the stored receipt; rollback or lease expiry restores the slot. Rejection notices and quota-status replies have separate bounded counters.

Model dispatch consumes quota in the monetary dispatch transaction. Both senders consume the same send counters in their authorization transactions. Validation, consent, policy and timing gates run before dispatch. An accepted replay does not consume another slot; retries require a new authorization. Counters are never refunded after authorization because a timeout may still have caused a billable call or delivered message. Shared global counters serialize across users; the database clock is read after waiting for the global lock. Policy edits take an exclusive advisory lock, while authorizations hold its shared counterpart; workers have no policy-update privilege.

The ingress store uses a database advisory lock to check unfinished capacity and persist a batch atomically across API processes. Replay needs no new capacity. When full, ordinary work returns HTTP 429 with `Retry-After: 60`; the request is not acknowledged as saved. Receipts and STOP/reminder completion/cancellation bypass this backlog gate to allow recovery, but still obey the batch/body bounds. A mixed batch containing excess ordinary work is retried as a whole; no part of it is acknowledged or silently dropped. Existing 1 MiB body, signature validation and request timeout gates remain in place.

## Verification and limits

Tests cover request denial before mutation, notice throttling, STOP/control exceptions, account blocking, replay/rollback/lease fencing, concurrent owner/shared counters, UTC windows, atomic mixed-plan rejection, recurrence limits, uncertain model attempts and reservation release, shared sender gates, webhook capacity/replay, policy validation and role/RLS/audit protection. Provider transports are mocked.

This is application-level abuse control. A deployment still needs edge connection/IP protections, trusted proxy configuration and load testing. Safety controls and receipts intentionally bypass ordinary backlog capacity; this is not a hard ceiling on all database rows or transport work. Completed events, audit records and old counter windows remain stored until the M3-02 retention/deletion implementation. No ban classifier, payment plans, billing or per-user numeric overrides are added here.

Stop old workers, run `npm run db:migrate`, rebuild and restart. Next is **M3-02: export, deletion and retention**, including cancellation of associated pending work and provider-safe cleanup.
