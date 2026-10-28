# Work leases and recovery (M1-03)

The PostgreSQL outbox is the queue used by the local worker. Redis is optional and unused. Migration 0005 adds stages, lease ownership, retry limits and a recovery audit. Stop existing API/worker/simulator processes before applying it, then start the updated code; older worker code does not satisfy the new lease constraints.

## Ordering contract

Inbound work is scoped by business phone plus sender. Receipt work is scoped by business phone plus provider message ID. Ingress takes transaction advisory locks for all streams in sorted order **before** allocating sequence numbers, and inserts each batch in input order. A stream's committed order is therefore safe to use for selection. Concurrent requests are ordered by lock acquisition, not wall-clock request start. Delayed provider messages join the end; provider timestamps never reorder already accepted work. Identity checks still reject stale consent/control messages.

There are four stages (migration 0006 adds execution):

| Stage        | Current behavior                                                                     | Ordering                                                                       |
| ------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `onboarding` | Identity, consent, timezone and STOP; handled/blocked items complete                 | Earliest incomplete onboarding item per sender                                 |
| `action`     | Ready identities transition here; optional fixture planner persists a validated plan | Earlier incomplete onboarding, action or execution items block later planning  |
| `execution`  | Consumes immutable plan; commits entities, receipts and unsent reply intent          | Earlier incomplete onboarding, action or execution items block later execution |
| `receipt`    | Consumes receipt evidence and reconciles known send attempts                         | Provider message order within a business phone                                 |

Onboarding can advance past pending actions so STOP does not wait for a model backlog. There can be one onboarding lease and one action lease for a sender at once. A future action handler must recheck current consent/grant and timezone before a model call and inside its final transaction, locking the user row consistently with onboarding. The existing `eligibleForProcessing` read is a preliminary check, not sufficient authorization for an eventual write. A STOP cannot undo an external request already issued.

Pending backoff, active leases and dead work block later items in the same stage. A dead onboarding item also blocks later actions. Other senders/business phones remain independent. There is no automatic skip of dead work; an operator must repair and retry it. This also means a dead onboarding item can delay a later STOP; inspect dead onboarding work promptly. The action stage now supports fixture planning; local execution is enabled; sending is not.

## Lease lifecycle

`WorkQueue.claim` atomically selects a due row with `FOR UPDATE SKIP LOCKED`, increments attempts, and assigns a fresh UUID token, owner and deadline using the database clock. The default lease is 30 seconds. `WorkRunner` renews every third of that interval during preparation. Expired leases cannot be renewed or acknowledged, even before another worker claims them.

Handlers have two phases: `prepare` may perform cancellable slow work outside a transaction; `apply` performs short database effects. The runner stops its heartbeat before `apply` to avoid competing with its own row lock. Commit checks ownership and expiry before and after effects; effects, completion/stage transition and ingress acknowledgement commit together. Failure rolls the whole transaction back. Token checks fence an old process even after recovery and reassignment. Keep external sends out of `apply`: the database cannot roll back a network side effect.

On startup and each polling cycle, the worker recovers up to 100 expired leases. Items return to pending or become dead once attempts reach the per-item maximum (default 5, allowed 1–20). Expiry and operator retries are recorded in `work_recovery_events`. Handler failures store stable codes only, with exponential backoff and jitter from 0.5–1 second up to 2.5–5 minutes. Explicit permanent failures go directly to dead. Completing onboarding and entering action, or saving a plan and entering execution, resets attempts for the new stage.

SIGINT/SIGTERM stops claims and cancels preparation. Even preparation that ignores cancellation cannot later apply its result through the runner. Live owned work is released for immediate retry; an expired/lost lease is left for recovery. Shutdown consumes the claimed attempt, so repeated shutdowns can exhaust a task. Short database effects finish or roll back before the pool closes; runtime queries have a five-second statement timeout. If the process is killed, its last lease expires and another process recovers it.

This provides atomic database effects with retryable preparation. It does not make model calls or provider sends exactly once; persisted plans are implemented in M1-04, while usage reservations are implemented in M1-05; action receipts are implemented in M1-06, while M1-07 durably holds uncertain sends without automatic retry. Audited reconciliation remains later work.

## Operating locally

```powershell
npm run db:migrate
npm run dev:worker
```

`WORKER_POLL_INTERVAL_MS` controls the interval between cycles (default 30 seconds); each cycle claims up to 50 receipt items and 50 onboarding items, then alternates planning/execution. The worker logs recovery counts and backlog grouped by stage/status without message bodies. Pending action counts are expected in disabled model mode; execution and receipt stages have active consumers. See [model plans](model-plans.md) for offline fixture planning.

Inspect dead work using the worker database connection:

```sql
SELECT id, stage, attempts, max_attempts, last_error_code, available_at
FROM work_outbox WHERE status = 'dead' ORDER BY created_at;
```

After repairing the cause, retry one item using an operator label:

```powershell
npm run work:retry -- <dead-work-uuid> <operator-label>
```

This resets attempts, preserves ordering and records the label. The label is an operational annotation, not authenticated human identity; access comes from the restricted worker credentials. Do not manually set a task to completed to unblock a stream.

## Evidence

Real PostgreSQL tests use non-owner ingress/worker logins and disposable schemas. They cover simultaneous claims, independent users/business phones, ordered batches, abandoned lease recovery, stale-token fencing, atomic rollback, retry exhaustion, audited operator retry, stage separation, heartbeat extension, lease loss, cancellation-ignoring preparation, permanent failures and ingress transaction visibility. Identity tests additionally verify that STOP invalidates earlier ready work and old work cannot revive under a new consent grant. These are local correctness checks, not production load or external-delivery tests.

M1-05 adds metered model dispatch. Budget/kill/rate/uncertainty denials defer the work by 60 seconds without consuming its claim attempt. Unknown provider usage retains its reservation until reconciliation. The worker runs usage recovery alongside lease recovery. See [usage controls](usage-controls.md).

M1-06 consumes execution work in both model modes, including while paid planning is paused. Each worker cycle alternates planning and execution to allow later messages to advance after earlier commits. A completed execution means database effects and a reply intent were committed, not that a reply or reminder was delivered. See [action execution](action-execution.md).
