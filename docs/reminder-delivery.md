# Reminder delivery and templates (M2-02)

M2-01 puts a due reminder in an outgoing mailbox. M2-02 provides the delivery service that takes a stored message from that mailbox, records an attempt, and sends it through the WhatsApp transport. A provider response means the provider accepted it; a delivery receipt is separate evidence that it arrived.

This path is implemented and exercised with synthetic data and mocked transports. `ReminderSender` is injectable, with `send(outboundId)` and bounded `sendPending(limit)` methods. It is **not constructed by the regular worker or exposed through a live CLI/API**. The regular worker still schedules due reminders and consumes receipts, with `whatsappSendingEnabled: false`. No real Meta send or template approval is claimed. M2-02 does not add WhatsApp pricing/reservations; billable traffic must remain disabled pending qualification.

## A concrete example

Suppose Alice saved “Call dentist” for 3 pm. When it becomes due, the scheduler creates an occurrence and an outbound message containing `Reminder: Call dentist`.

1. The sender checks Alice's current consent, timezone and reminder status, plus the global pause and explicit test recipient allowlist.
2. Inside the customer-service window, it selects the stored plain text. Near or outside the boundary, it requires a verified, approved reminder template for Alice's preferred language and this business phone.
3. It saves the selected message and a `dispatching` attempt in PostgreSQL, then commits before contacting WhatsApp. Concurrent callers find that same attempt and do not send again.
4. A successful provider response changes the attempt to `accepted` and saves the provider message ID. Receipts may later project `sent`, `delivered`, or `read`.
5. If the network times out, the outcome is `unknown`. A restart does not resend it. If the process fails to save the response, the durable state remains `dispatching`, also held for reconciliation.

## Database additions

Migration `0011_reminder_delivery.sql` adds:

- `whatsapp_templates`: deployment-owned configuration containing business phone, reply language, increasing version, exact provider template name/locale, fixed body format, approval status/reference, verification time and validity deadline. No templates are seeded.
- `whatsapp_attempts.outbound_message_id`: a unique, owner-checked link to the reminder outbound message. A reminder attempt has no inbound event ID; identity/reply attempts keep their previous source rules.
- `whatsapp_attempts.template_id`: the selected template version, constrained to the same business phone.
- `whatsapp_attempts.message_payload`: the immutable selected transport message, including exact template parameters when applicable. Suppressed attempts have no send payload.

`whatsapp_attempts` remains the shared ledger for onboarding replies, plan replies and reminders. The existing forced RLS, address ownership and receipt matching remain in force. Tenant sessions can read their own attempts; runtime roles cannot rewrite message payloads or template definitions. Workers gain read-only access to locale preferences. Templates force RLS and are readable only by the worker and privileged deployment administration, not tenant or ingress sessions.

Template definitions cannot be edited or deleted; insert a new version to change the name, locale or fixed text. Approval/verification fields can change through deployment administration. The database trigger serializes template updates/inserts with sender selection using the business-phone advisory lock. This lets an approval pause committed before selection block dispatch. History is retained.

## Service window and template selection

The sender uses PostgreSQL time after waiting for authorization locks. Plain text requires the window to remain open beyond the configured request timeout plus a 1-second margin. Equality, null and expired windows all require a template. No local clock or stored scheduling-time window decides the send type.

The template lookup uses the user's stored `reply_language`, defaulting to `en` only when no preference row exists. The latest version for that business phone and language must be `approved`, already verified, and valid beyond the same timeout margin. An explicit mapping permits a user preference such as `en` to select the exact approved provider locale `en_US`. There is no fallback to another language or an older approved version when the latest is pending, paused, rejected or expired.

The supported contract is deliberately small: one positional BODY text parameter, no header, buttons, media or additional parameters. The parameter is the immutable outbound body. The approved `body_format` must contain exactly one `{{1}}` placeholder; the rendered body is bounded to 1,024 characters. Parameters cannot contain newlines, tabs, or more than four consecutive spaces. Unsupported content remains queued; it is not truncated, translated or sent as plain text outside the window.

Missing/unusable templates block without creating an attempt or consuming the message. Fixing template configuration or receiving a later inbound message that reopens the window allows a future pass to try authorization again. No provider call has happened at that point. M2-03 now permits bounded additional attempts after qualified rejections or an audited operator decision. Unknown sends remain held. See [delivery recovery](delivery-recovery.md).

## Authorization, ordering and failure boundaries

The sender locks global usage policy, user and reminder/occurrence/outbound rows, then the business-phone template selection lock. It checks:

- Explicit test enablement, one configured business phone and at most five allowlisted recipients.
- Enabled global usage policy. This is the existing kill switch, not a WhatsApp budget reservation.
- Current local consent version, consent grant, confirmed timezone and no pending timezone change.
- Matching snapshots, pending occurrence/outbound status, pending reminder lifecycle, unchanged schedule version and original due instant.
- Due availability, earlier queued reminders and any unresolved `dispatching`/`unknown` WhatsApp attempt for that user.

Invalid identity or stale reminder state creates a durable `suppressed` attempt without network I/O. Configuration, budget-pause, ordering, format and template blocks leave the intent unconsumed. Suppressed evidence never becomes eligible again through replay.

Reminder order is `(available_at, id)` within a user. The default bounded queue pass inspects one oldest unattempted due reminder per configured recipient, so one user's backlog does not occupy the whole default batch. Replies and reminders do not share a total order, but uncertain attempts in either path block later reminder sends; existing plan-reply dispatch also checks all unresolved attempts. Onboarding control replies retain their existing bypass for STOP confirmations.

Locks are released before network I/O. STOP/pause committed before authorization prevents a call. A send authorized before STOP/pause may complete afterward and cannot be recalled. Delivery evidence is still saved even if the outbound intent is subsequently suppressed. Cancellation observed before committing authorization rolls it back; cancellation after commit is conservatively recorded as unknown. A crash after authorization, even before I/O, leaves a held `dispatching` attempt.

Receipt matching uses business phone + provider message ID + recipient. Acceptance persistence and receipt reconciliation share a provider-message lock. An early receipt links when acceptance is saved; later/reordered receipts cannot regress delivered/read evidence. A callback without a saved provider ID remains unmatched. The outbound and reminder `pending` fields describe eligibility/lifecycle, not delivery; inspect the attempt ledger for transport outcomes.

## Local setup and inspection

Stop older workers, run `npm run db:migrate`, then rebuild with `npm run build`. The migration runner is checksum-aware; never edit an applied migration. Regular worker startup does not enable outbound sending.

Deployment administration can prepare a **pending** template record after choosing the approved contract. For illustration only:

```sql
INSERT INTO whatsapp_templates
  (phone_number_id, reply_language, version, name, language_code, body_format)
VALUES
  ('12345', 'en', 1, 'reminder_en_v1', 'en_US', 'You asked to be reminded: {{1}}');
```

Those identifiers and wording are examples, not Meta-approved values. Before approving a real registry entry, obtain the exact name/locale/body and account approval evidence, then record `approval_reference`, `verified_at` and an explicit `valid_until`. Approval freshness must be maintained operationally; this code does not synchronize Meta's template status. Runtime credentials cannot approve templates.

Inspect with an authorized operator connection or an owner-scoped tenant transaction where permitted:

```sql
SELECT m.id, m.available_at, m.status AS eligibility,
       a.id AS attempt_id, a.state, a.delivery_status, a.template_id, a.error_code
FROM outbound_messages m
LEFT JOIN whatsapp_attempts a ON a.outbound_message_id = m.id
ORDER BY m.available_at, m.id;
```

Do not delete attempts to force another send. No WhatsApp secrets, live runtime switch, billing qualification or automatic retry were added in this milestone.

## Verification and next work

Unit tests validate template wire JSON and reject unsupported shapes before HTTP. Restricted-login PostgreSQL tests cover concurrent/replayed dispatch, durable pre-I/O payloads, exact locale/version selection, missing/stale/paused approvals, window expiry during lock waits, lifecycle/consent changes, STOP during I/O, early/reordered receipts, unknown and rejected outcomes, failed persistence, rollback, ordering, bounded passes and tenant/role/source constraints. Transports are mocked; these tests do not measure delivery latency or actual Meta acceptance.

M2-03 now implements audited reconciliation, retry classification and bounded additional attempts; see [delivery recovery](delivery-recovery.md). Next is M2-04 complete/cancel/snooze. External prerequisites still include Meta account/test-number setup, actual template approval, replacement consent, a qualified WhatsApp spend policy and explicit live-runtime integration. The beginner PDF remains the M1-08 snapshot; this runbook documents the newer delivery work.

Contract references checked during implementation: [Meta messaging policy](https://whatsappbusiness.com/policy/), [Meta Messages API collection](https://www.postman.com/meta/whatsapp-business-platform/folder/o48mro7/messages), and [Meta's archived template wire example](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/messages/template/). These inform the window/template boundary and request shape; account eligibility and approval are not established by code tests.
