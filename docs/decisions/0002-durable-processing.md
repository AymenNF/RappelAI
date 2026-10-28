# ADR 0002: database-backed work and persisted plans

Status: accepted, 2026-10-27. Inbox/outbox implemented; relay, consumer, plans and receipts planned.

Context: database insert followed by queue publish is a dual write. Queue retries and model nondeterminism can duplicate or alter actions.

Decision: persist ingress event and work intent in the same transaction. Queue publication is a retryable optimization; pending/incomplete work remains recoverable from PostgreSQL. Persist validated model plans before executing them. Commit action receipt, entity mutation and reply intent together. Serialize user work using a lock and ordered selection, with an explicit late-arrival policy.

Alternatives: Redis-only scheduling loses the authoritative commitment on data loss; a unique queue job ID cannot substitute for database correctness; regenerating an action plan on every retry makes positional idempotency keys unstable.

Consequences: outbox and lease recovery add code and tests. Internal effects become replay-safe. External calls still require separate uncertainty handling. Never mark a durable task complete merely because it was published to a queue.
