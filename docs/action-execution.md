# Reminder/list execution and reply intents (M1-06)

Migration 0008 adds reminders, named lists, list items, action receipts, execution outcomes and reply intents. The worker now consumes the `execution` stage in both model modes. A saved plan can execute while paid planning is disabled or spending is paused: execution is a local database operation and makes no provider call.

Stop old workers before migrating, then run the current build:

```powershell
npm run db:migrate
npm run dev:worker
```

The fixture model still returns a fixed clarification decision. It now produces a stored clarification reply and completes the work instead of leaving execution pending. It does not interpret arbitrary reminder/list requests. Integration tests exercise real reminder/list creation with explicit synthetic model decisions. No authenticated CRUD HTTP API, real model activation, scheduler or WhatsApp sender is added in this milestone.

## Transaction boundary

The existing work queue locks the lease row and fences ownership/expiry. Execution loads the immutable saved plan, locks its user row, and compares current consent/grant, timezone confirmation and timezone against the plan snapshot. Validation uses database time read after acquiring the user lock.

For a supported plan, one transaction performs all entity mutations, inserts an action receipt per call, inserts one execution outcome and one reply intent, marks work completed, and acknowledges ingress. A failure anywhere—including reply insertion or final lease validation—rolls back all these changes. There are no network calls inside the transaction.

The plan is all-or-nothing. If any reminder is already past due, nothing in that plan is applied and a new-date clarification is queued. Digest reminders are outside this milestone; a plan containing one gets an unsupported outcome with no partial list changes. A reminder becoming expired during insertion aborts the transaction; its next retry follows the expired-plan path. Invalid persisted schemas/versions dead-letter for operator repair rather than generating a false success or a replacement model plan.

Each action key derives from event ID, plan version, action index and tool kind. Receipts record the original typed result and reference the created entity using owner/key-aware foreign keys. Duplicate content at different action indices is intentionally separate work. Replayed completed executions reuse the original outcome and reply; they do not create more entities or reopen suppressed replies. Entity action-key constraints and service result reuse also protect a retried action. Runtime roles cannot edit/delete action receipts or execution outcomes.

## Reminders and lists

`create_reminder` saves the title, UTC due instant, confirmed IANA timezone, source plan/action and immediate delivery mode. Status is `pending`. The reply says that the reminder was saved and explicitly states that delivery is not enabled. It does not claim a provider send or promise an operational scheduler. Recurrence, digest scheduling, occurrence materialization, cancellation/completion/snooze and due delivery remain M2 work.

`add_list_item` resolves a list within the authenticated plan owner. Names use Unicode NFKC normalization, collapsed whitespace and lowercase comparison; the first display spelling is retained. There is no fuzzy matching: “Grocery” and “grocery” share a list, while “Groceries” is distinct. Identically named lists belonging to different users remain separate.

Appending locks the list row, assigns the next position and inserts the item under owner-aware foreign keys. Concurrent appends preserve both items with unique positions. Repeated “milk” additions from separate actions create separate items; content is not used as an idempotency key. User-facing edit/delete/reorder and fuzzy clarification remain later work.

## Reply intents and consent

Successful replies are rendered from committed action results, with bounded previews and explicit timezone offsets for reminder times. `clarify`, `noop` and `unsupported` decisions use deterministic text because the current decision contract has no generated question field. There is exactly one reply intent per executed plan event.

The only intent states are `pending` and `suppressed`. They are local durable records, not provider acceptance or delivery evidence. A changed consent or timezone snapshot at execution produces a blocked outcome and a suppressed generic reply with no product mutations. A later STOP, pending timezone change or new confirmation suppresses already pending replies in the onboarding transaction. Re-consent does not revive them.

STOP does not delete previously saved reminders/list items in this milestone. Future scheduling and sending must recheck current eligibility, consent/grant snapshots, cancellation, service window and spending controls before sending. Onboarding responses continue to live in `identity_results`; this milestone's reply intents cover saved-plan outcomes. M1-07 integrates both sources with a test dispatcher and receipt consumer; live sending remains disabled. M2 must add scheduling, templates and audited unknown-send reconciliation.

## Inspection and isolation

All six new tables use forced row-level security. Tenants have SELECT on their own rows only; no tenant write route or grant can bypass the executor. Ingress cannot read the tables. The trusted worker can insert results; only list-name updates needed for row locking and reply-status updates for suppression are granted. Composite foreign keys enforce matching plan, user, action key and entity ownership.

Inspect using an authorized tenant transaction or the local worker connection:

```sql
SELECT id, title, due_at, timezone, status FROM reminders ORDER BY created_at;
SELECT l.name, i.text, i.position FROM lists l
JOIN list_items i ON i.list_id=l.id AND i.user_id=l.user_id
ORDER BY l.created_at,i.position;
SELECT event_id,outcome,reason_code FROM plan_executions ORDER BY created_at;
SELECT event_id,status,body FROM reply_intents ORDER BY created_at;
```

These fields contain user data; ordinary worker logs contain only backlog/recovery metadata. The read examples do not create public endpoints or bypass tenant authentication.

## Evidence and next steps

Restricted-login PostgreSQL tests exercise simultaneous workers, replay, injected reply failure, final lease expiry, normalized list reuse, repeated items, concurrent appends, mixed-plan rejection, consent/timezone invalidation, STOP suppression, non-action replies, malformed plans, RLS/foreign-key isolation and the metered-planning-to-execution path. Unit tests cover normalization, bounded rendering and an ambiguous fall-back local time with an explicit UTC offset.

M1-07 now implements the test-only WhatsApp adapter, dispatcher and receipt handler. See [WhatsApp delivery](whatsapp-delivery.md). M1-08 now provides the evaluation runner and 60 agent-reviewed cases; human review and live model measurement remain pending. See [evaluations](../evals/README.md). Real model selection/qualification, replacement consent, provider setup and template approvals remain external prerequisites. No message was sent and no reminder-delivery SLO was established by these tests.
