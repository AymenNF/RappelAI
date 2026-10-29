# One-time reminder scheduling (M2-01)

The worker now turns due, saved reminders into durable delivery work. It checks the clock, creates a record saying “this reminder is due,” and files the message that a future sender should deliver. It does **not** call WhatsApp or mark anything delivered.

Stop older workers, run `npm run db:migrate`, then start the current worker with `npm run dev:worker`. Migration 0010 adds the scheduling fields and tables. Existing one-time reminders are considered when due; the migration itself does not enqueue or send them.

## Records and transaction

`reminders.schedule_version` starts at 1. `scheduled_at` records that this version has been materialized; it does not mean delivered or completed. The reminder's lifecycle status is unchanged.

`reminder_occurrences` records owner, reminder, schedule version, original and promised due instants, and pending/suppressed state. Its unique key is `(reminder_id, schedule_version, original_due_at)`. Owner-aware foreign keys prevent cross-user references. Original and promised instants must be equal in this immediate-only scope.

`outbound_messages` stores one reminder body per occurrence, the original availability time, consent/timezone snapshots and pending/suppressed state. A unique occurrence reference prevents duplicate local intents. This is separate from M1-06 reply intents and M1-07 test reply attempts; M2-02 must connect reminder intents to delivery attempts/templates. These new tables have no accepted/delivered states yet.

One transaction locks candidate users, selects due reminders, creates occurrences and outbound records, and marks reminders scheduled. No network call or billing reservation occurs. Failure rolls back the entire batch, including scheduling markers. A restart finds the same unmaterialized work. A rerun after successful commit does not duplicate it. An administrative replay that clears a marker preserves existing IDs; it can suppress newly ineligible work but never revive suppressed records.

## Clock, bounds and ordering

A sweep takes a fixed database-clock cutoff, preserving PostgreSQL microseconds. It selects only `status='pending'`, `scheduled_at IS NULL`, `due_at <= cutoff`. Future, canceled and completed reminders are excluded. The normal worker batch is 100 reminders; controlled service calls accept 1–500.

The lock order is user, reminder, then occurrence/outbound records. Identity processing and execution share the user lock. `SKIP LOCKED` lets other users progress while one is busy. Candidate users are ordered by their earliest due reminder; each user's reminders are ordered by due time and ID. This is bounded work selection, not a globally strict dispatch-order promise or a measured fairness/latency SLO.

Overdue work keeps its original due/availability time. It is not silently rescheduled to “now” or dropped by an arbitrary grace period. A future sender needs an explicit stale-delivery policy. Timezone and DST are not recalculated here: the saved plan already resolved a UTC instant. Recurrence, DST recurrence rules, snooze/rescheduling and digest/quiet-hour policies remain later milestones. Version-change/reset APIs are not implemented in M2-01.

The sweep runs after onboarding and planning/execution batches, in both model modes. `WORKER_POLL_INTERVAL_MS` controls the delay between complete cycles (default 30 seconds). Processing adds time; this is not a guaranteed 30-second delivery interval. Startup logs `reminderSchedulingEnabled: true`. Sweep logs include only aggregate examined, materialized and suppressed counts; suppressed counts describe newly materialized suppressed occurrences.

## Consent and delivery gates

Current onboarding eligibility and exact consent/timezone snapshots must match the saved plan. Otherwise the due reminder is recorded once as a suppressed occurrence and suppressed outbound record with `identity_changed`; it is not placed in the pending delivery queue. A timezone change awaiting confirmation also suppresses due work. Re-consent does not authorize old schedules again.

STOP and identity changes suppress already queued pending reminder messages and their occurrences in the onboarding transaction. If a sweep commits first, STOP suppresses its result next. If STOP commits first, the sweep sees changed identity and creates only suppressed records. They serialize on the user row. Shutdown observed before commit rolls back the sweep; committed work stays durable.

Canceled/completed states are respected before selection. M2-04 now supplies cancel/complete/snooze commands, increments schedule versions and invalidates stale controls/intents; see [reminder controls](reminder-controls.md). M2-02 reminder dispatch rechecks reminder lifecycle/version, consent/grant/timezone, outbound state, service window, template availability and the global usage pause before dispatch. WhatsApp budget qualification remains a live-activation prerequisite. A queued record is not permanent authorization to send.

Closed messaging windows and paused spending do not prevent local materialization. Those are send-time gates; missing templates or budgets must not make due work disappear. A sweep creates no WhatsApp attempts or model reservations. Live sending remains disabled.

## Inspection and tests

Use an authorized tenant transaction or trusted local operator connection, not a public endpoint:

```sql
SELECT id, title, due_at, schedule_version, scheduled_at, status
FROM reminders ORDER BY due_at;
SELECT reminder_id, original_due_at, promised_due_at, status, suppression_reason
FROM reminder_occurrences ORDER BY original_due_at;
SELECT occurrence_id, available_at, status, suppression_reason
FROM outbound_messages ORDER BY available_at;
```

Both new tables force RLS. Tenants can read only their own rows; ingress has no access. Workers can materialize/suppress work but cannot edit outbound bodies or delete evidence. M2-04 adds column-level worker updates for reminder status, due time and schedule version through the mutation handler. Missing tenant context is default-deny.

Restricted-login tests cover competing schedulers, restart/replay, future/canceled/completed exclusion, microsecond precision, rollback at insertion/final marker, batch bounds, busy-user skipping, stale identity snapshots, STOP before/after and during scheduling, shutdown rollback, spending/window independence, ownership constraints and a saved-plan-to-due-occurrence path. Controlled transaction failures do not demonstrate an operating-system crash recovery SLO or live delivery.

M2-02 connects this queue to attempts and template/window rules through an injectable test service; see [reminder delivery](reminder-delivery.md). M2-03 supplies recovery and M2-04 supplies lifecycle controls. Next is M2-05 recurrence and DST rules. EXT-01/02, replacement consent, qualified rates and live model evaluation remain external/product prerequisites. The 33-page PDF is an M1-08 snapshot; this runbook describes the subsequent scheduling addition.
