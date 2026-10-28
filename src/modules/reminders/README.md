# Reminders boundary

M1-06 implements transactional one-time reminder creation from validated saved plans, scoped by owner and action key. The service requires the executor's transaction/user lock and checks due time at insertion. Replies distinguish saving a reminder from delivering it. See [action execution](../../../docs/action-execution.md).

Occurrence scheduling, recurrence, digest delivery, user CRUD, cancel/complete/snooze and actual sends remain later work. This service never calls WhatsApp.
