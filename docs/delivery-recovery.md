# Delivery recovery and bounded retries (M2-03)

If a courier stops answering, you do not know whether the parcel arrived. Sending a second parcel immediately can create a duplicate. Memorae now treats that uncertainty explicitly: it keeps the attempt on hold, records operator evidence, and retries only when there is a defensible reason to believe the original send was rejected or did not happen.

This milestone extends both reminder delivery and the test reply sender. The ordinary worker runs database recovery automatically, including while spending is paused. It still does not send WhatsApp messages. All verification uses synthetic data and mocked providers; real account activation, templates and WhatsApp budget qualification remain pending.

## What happens after a send

| Outcome                                                                            | Behavior                                                                                                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Accepted with provider ID                                                          | Keep acceptance and reduce receipts; no automatic resend, including after a failed delivery receipt.                 |
| Structured HTTP 429 rejection                                                      | Schedule a bounded retry with backoff and honor a longer `Retry-After` value.                                        |
| Other definite rejection                                                           | Keep the rejection. An administrator may authorize a retry after correcting the cause.                               |
| Timeout, cancellation, malformed result, network error or ambiguous server failure | Keep `unknown`; do not automatically retry.                                                                          |
| Process dies or result persistence fails                                           | Keep `dispatching` until its deadline; recovery then records `unknown` with `dispatch_expired`.                      |
| Contradictory late acceptance after a resolution or retry                          | Preserve the new provider ID in audit evidence and pause the global usage policy. Do not silently overwrite history. |

Automatic classification intentionally covers only a structured HTTP 429 response from the adapter. It does not infer retryability from an unverified list of provider error codes or a generic 5xx. HTTP 429 and its optional `Retry-After` header are described in [RFC 6585, section 4](https://www.rfc-editor.org/rfc/rfc6585#section-4). Broader Meta-specific classifications need provider qualification before enabling live traffic.

## Attempt and recovery records

Migration `0012_delivery_recovery.sql` changes one attempt per source into an ordered chain:

- `attempt_no` is 1, 2 or 3; `(event_id, attempt_no)` and `(outbound_message_id, attempt_no)` are unique.
- `previous_attempt_id` identifies the immediately preceding attempt and can have only one successor. A database trigger checks the owner, source, due retry, sequence and shared deadline, then consumes the retry authorization atomically.
- `dispatch_deadline` is the configured transport timeout plus 30 seconds of grace after authorization. Existing attempts receive a conservative one-minute deadline from creation.
- `retry_until` is 24 hours after the first attempt's authorization and is inherited unchanged by successors. It is not extended by a restart or operator action.
- `retry_at` is the next allowed authorization time. Default delays are 60 seconds after attempt 1 and 240 seconds after attempt 2. A longer provider wait wins; a wait beyond the horizon ends retries.
- `recovery_state` is `none`, `retry_wait`, `retried`, `exhausted` or `abandoned`. `resolution` records an administrator's acceptance, non-send confirmation or abandonment.
- `delivery_recovery_audit` records authorization, results, recovery, retries, operator evidence and conflicts. It is append-only for runtime roles, has forced tenant RLS and owner-aware references, and records the actual database actor. Workers cannot forge operator audit actions or resolution fields.

The existing attempt state remains transport evidence. For example, abandonment keeps `state=unknown`: closing the investigation does not prove that delivery failed. Acceptance and read/delivery receipts remain separate facts.

## Recovery and retry boundaries

`DeliveryRecovery.recover()` runs once per ordinary worker cycle, up to 100 records by default. Concurrent workers lock and skip busy rows. Expired dispatches become unknown exactly once; expired retry windows become exhausted. Each change and its audit record commit together. Recovery has no provider transport and makes no network request.

Every retry passes through the normal sender again. It rechecks the pause, allowlist, identity/consent/timezone, reminder lifecycle/version, service window and latest template approval. A reminder that now needs a template waits for one. A STOP or canceled reminder suppresses a new attempt without sending. Template and message snapshots belong to each individual attempt.

The sender serializes authorization under the user lock. A pending earlier retry blocks later messages in the same reminder or plan-reply stream even while the retry's delay is running. Unknown attempts block later ordinary sends for that user until resolved or abandoned. Independent recipients can progress. Onboarding control replies retain their existing bypass so STOP can be confirmed.

The three-attempt limit includes the original attempt, and suppressed successors consume a slot. Neither operators nor restarts reset the count or horizon. Failed authorization transactions roll back both the new attempt and consumption of its predecessor. A request deadline or shutdown is not evidence of non-delivery.

## Operator workflow

The CLI uses the migration administrator's `DATABASE_URL` from the ignored local environment. Runtime worker/tenant/ingress logins cannot perform reconciliation. Notes are evidence references, not authentication; the database login supplies authority. Keep real evidence files private and out of Git.

Inspect the oldest held, retrying, exhausted or conflicting attempts:

```powershell
npm run delivery:control -- status
```

Decisions are supplied as a JSON file so names, notes and provider IDs do not need shell escaping:

```powershell
npm run delivery:control -- reconcile <attempt-uuid> <private-decision-json-path>
```

Choose one of these decisions:

**Acceptance evidence.** Confirm the exact attempt, business phone, recipient and provider message ID using provider records. The supplied address must match the attempt; provider-ID uniqueness and known receipt addresses are checked. Saved early receipts are reconciled immediately. Never guess the attempt from a nearby timestamp or recipient alone.

```json
{
  "action": "accepted",
  "phoneNumberId": "12345",
  "recipientId": "15555550101",
  "providerMessageId": "wamid.synthetic-proof",
  "note": "Synthetic example: provider log associates this ID with this exact attempt."
}
```

**Confirmed non-send.** This requires affirmative evidence that the original send did not occur, plus stopping the original sender so it cannot resume an already-authorized request. A missing callback, expired deadline or absence from a dashboard is insufficient. The API requires `senderStopped: true` as an explicit operator attestation; it does not independently inspect processes or query Meta. The attempt must have passed its dispatch deadline. This decision changes it to a definite rejection and schedules a delayed retry if the count and horizon permit.

```json
{
  "action": "not_sent",
  "senderStopped": true,
  "note": "Synthetic example: original sender stopped; provider evidence definitively confirms no send."
}
```

**Abandon without retry.** When certainty cannot be obtained, close the hold and allow later messages to proceed. The original remains unknown and is never resent. A later administrator-confirmed acceptance can still be attached to an abandoned attempt when there is no successor.

```json
{
  "action": "abandon",
  "note": "Synthetic example: close this investigation without asserting non-delivery."
}
```

**Retry a definite rejection after repair.** This cannot authorize an unknown or accepted attempt and cannot overtake a newer send already authorized for the user. It cannot bypass limits, eligibility or the global pause.

```json
{
  "action": "retry",
  "note": "Synthetic example: corrected the rejected template configuration and verified the repair."
}
```

Semantic replays do not create duplicate resolutions or audits. Conflicting provider evidence and superseded attempts are rejected. Operator resolution works while sending is paused and never resumes the usage policy automatically.

## Late results and conflicts

Real acceptance arriving after crash recovery can resolve an otherwise unresolved unknown, with receipts linked normally. Once an operator has closed or reclassified it, conflicting late acceptance is retained in audit and the global kill switch is paused. The status command flags unresolved conflicts even when a newer attempt already exists.

Inspect `delivery_recovery_audit` for the original and late provider IDs. If an abandoned attempt has confirmed acceptance, use the acceptance decision to attach it. If it was already retried, keep both attempts' historical evidence and investigate potential duplicate delivery; the CLI deliberately refuses to rewrite an earlier retry chain. This case requires operator incident review, not another send. Resume usage only after reviewing the conflict through the existing audited usage-control process. No external provider lookup or automated incident resolution is claimed here.

## Verification and next step

Tests cover concurrent retry claims, fixed attempt limits and horizons, provider delays, interrupted dispatch recovery, early receipts during reconciliation, evidence/address validation, late results, pause/STOP/template gates, ordering, transaction rollback, reply retries, runtime permissions and tenant isolation. Expiration and failure are injected in disposable PostgreSQL schemas; this is correctness evidence, not a production recovery-time guarantee.

Next is **M2-04**: complete, cancel and snooze commands, including stale-intent and stale-button invalidation. Actual Meta eligibility/approval, replacement consent, billable WhatsApp reservations and explicit live sender activation remain separate prerequisites. The PDF guide remains an M1-08 snapshot; this runbook documents the newer recovery work.
