# ADR 0002: database-backed work and persisted plans

Status: accepted, 2026-10-27. Inbox/outbox, leased PostgreSQL consumer and immutable plans implemented; optional relay and action receipts planned.

Context: database insert followed by queue publish is a dual write. Queue retries and model nondeterminism can duplicate or alter actions.

Decision: persist ingress event and work intent in the same transaction. Queue publication is a retryable optimization; pending/incomplete work remains recoverable from PostgreSQL. Persist validated model plans before executing them. Commit action receipt, entity mutation and reply intent together. Serialize user work using a lock and ordered selection, with an explicit late-arrival policy.

Alternatives: Redis-only scheduling loses the authoritative commitment on data loss; a unique queue job ID cannot substitute for database correctness; regenerating an action plan on every retry makes positional idempotency keys unstable.

Consequences: outbox and lease recovery add code and tests. Internal effects become replay-safe. External calls still require separate uncertainty handling. Never mark a durable task complete merely because it was published to a queue.

M1-03 implementation: use PostgreSQL directly without Redis until measurements justify a buffer. Per-stream ingress transaction locks establish committed sequence order; staged ordered claims plus expiring ownership tokens serialize consumers. Onboarding advances past action backlog for consent controls. See [work processing](../work-processing.md) for the exact ordering and recovery contract.

M1-04 adds an atomic planning-to-execution transition with immutable tenant-scoped plans. Runtime replay reuses saved decisions; a pre-persistence crash can still repeat a provider call. The executor and usage reservations are separate milestones. See [model plans](../model-plans.md).
