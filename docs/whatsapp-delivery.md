# WhatsApp send adapter and receipts (M1-07)

M1-07 implements a Cloud API text adapter, test-only durable reply dispatch, and the worker's receipt consumer. Migration 0009 adds `whatsapp_attempts` and `whatsapp_receipts`, both with forced tenant RLS. Stop old workers before running `npm run db:migrate` and restarting the current build.

## What runs locally

The regular worker consumes signed `delivery.status` events through the existing leased `receipt` stage. Receipt persistence, reconciliation and ingress acknowledgement commit together. It logs `receiptHandlingEnabled: true` and `whatsappSendingEnabled: false` at startup. No environment setting enables outbound WhatsApp traffic in this milestone.

`WhatsAppCloudTransport` accepts an explicit access token and Graph version, validates a plain-text message, and posts only to the fixed Graph origin. It disables redirects and link previews and bounds response size. `boundedSend` adds cancellation and a deadline even for an uncooperative transport. Provider content and credentials are excluded from returned error codes. Tests inject transport responses; they never call Meta.

`TestReplySender` is an injectable test service, deliberately not constructed by the worker or exposed through an HTTP endpoint/CLI. It consumes persisted reply content from either an executed plan's `reply_intents` or an onboarding `identity_results` row. It requires explicit enablement, one configured business phone, at most five recipient identifiers, and an enabled global usage policy. This is an application allowlist; it does not verify Meta test-number eligibility. No WhatsApp pricing or budget reservation is implemented, so this service must not be enabled for billable production traffic.

## Authorization and attempt state

Under the global policy and user locks, dispatch checks ownership, current consent/timezone snapshots and the customer-service window, with a safety margin covering the configured request timeout. Plan replies also require current onboarding eligibility and pending intent status. Onboarding replies can precede consent or confirm STOP, but only the latest processed onboarding response is eligible. A changed snapshot or expired window produces a durable suppressed attempt with no call. Missing configuration, a global pause or an unresolved earlier plan reply blocks dispatch without consuming the event.

A unique attempt is committed **before** network I/O. Concurrent/repeated callers reuse it. The transaction ends before calling the provider, so STOP and other database work are not held behind a network request. Authorization is the ordering boundary: STOP/pause committed before authorization blocks the call; a send already authorized may finish after STOP. It cannot be recalled. Suppression of the reply intent does not erase actual send/delivery evidence.

The attempt states are:

| State         | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `dispatching` | Authorization committed; a call may have started. A crash or failed result write leaves this state unresolved. |
| `accepted`    | A valid provider response supplied a message ID; delivery is not implied.                                      |
| `rejected`    | A structured 4xx response or local validation rejected the request.                                            |
| `unknown`     | Timeout, cancellation, network error, ambiguous HTTP response or malformed success.                            |
| `suppressed`  | Identity/window checks prevented dispatch.                                                                     |

There is one attempt per source event in M1-07. None of these states automatically redispatch, including rejection. `dispatching` and `unknown` block later plan replies for that user. Undispatched earlier pending plan replies also preserve reply order. Onboarding control replies may bypass plan backlog so STOP can be confirmed. Retry classification, audited reconciliation, and additional attempts belong to M2-03. Do not clear attempt rows to force a resend.

## Receipt evidence

The API verifies webhook signatures before storing ingress. The receipt consumer validates the provider ID, recipient and timestamp, then retains the status evidence even when no attempt is known yet. Matching requires **business phone + provider message ID + recipient**. Unknown receipts have no tenant owner and are invisible to tenant sessions.

Send-result persistence and receipt processing use the same per-provider-message transaction lock. An early receipt is linked when the accepted response is saved; a later receipt links during normal processing. This closes the race between storing acceptance and reading unmatched evidence. A receipt without a corresponding saved provider ID remains unmatched; callbacks cannot resolve a lost response in this milestone.

Delivery is a separate projection: `none`, `sent`, `failed`, `delivered`, `read`. Read/delivered evidence never regresses when older statuses arrive. Failure supersedes sent, while delivered/read evidence supersedes failure. All evidence remains available for inspection; unsupported future statuses are retained without upgrading delivery. Duplicate ingress replay cannot duplicate receipt rows. Malformed receipts dead-letter through the existing bounded work system.

The pending/suppressed state on `reply_intents` expresses eligibility, not delivery. Inspect `whatsapp_attempts.state`, its provider ID, and `delivery_status` for transport outcomes. Action receipts continue to prove local business effects only.

## Verification and remaining activation work

M2-01 scheduling and M2-02 reminder dispatch/template selection are now implemented locally; see [reminder delivery](reminder-delivery.md). Both reply and reminder paths share the transport, acceptance persistence and receipt reducer. Actual template approval, billable send reservations, live activation, automatic retries and unknown-send reconciliation remain pending.

Unit tests cover the wire request, validation, error classification, bounded responses, timeouts and status reduction. Restricted-login PostgreSQL tests cover competing senders, replay, early/reordered receipts, rollback, uncertain sends, persistence failure, pause/allowlist/window/consent gates, onboarding and STOP, in-flight revocation, ordered replies, tenant isolation and mismatched addresses.

Before an actual Meta test send, complete EXT-01: obtain a test phone and verified recipient, confirm account access and supported Graph version, configure secrets privately, and replace the local-only consent notice. Then add an explicitly enabled test runtime entry point with an appropriate WhatsApp spending policy. No real send, account eligibility, delivery latency, or production pricing has been verified here. Reminder scheduling and template selection are now implemented locally. Actual template approval, billable send reservations, automatic retries and unknown-send reconciliation remain later work. The M1-08 evaluation runner is now available while those external prerequisites are prepared; human dataset review and live model measurement remain pending.

Contract references: [Meta's text-message example](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/text/) (archived SDK documentation; no SDK dependency was added) and [Meta's status-notification reference](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications). The latter explicitly notes that notification arrival order can differ from event order. The Graph version remains a required caller input instead of an assumed current version.
