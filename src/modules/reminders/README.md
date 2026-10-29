# Reminders boundary

M1-06 implements transactional one-time reminder creation from validated saved plans, scoped by owner/action key. The service uses the executor's transaction/user lock and checks due time at insertion. See [action execution](../../../docs/action-execution.md).

M2-01 adds a bounded, transactional due sweeper: occurrence, outbound intent and scheduling marker commit together. Identity changes suppress stale work. No provider send is performed. Recurrence, digest delivery, user CRUD, cancel/complete/snooze and actual sends remain later work. See [scheduling](../../../docs/reminder-scheduling.md).
