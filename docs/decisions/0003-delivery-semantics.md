# ADR 0003: honest scheduling and delivery guarantees

Status: accepted, 2026-10-27. Design only.

Context: a reminder is a commitment. A successful HTTP response is not proof of delivery; a lost HTTP response is not proof of failure. Coalescing may conflict with a requested time.

Decision: distinguish occurrence creation, outbound intent, attempt, provider acceptance, delivery and read evidence. Track an explicit unknown attempt outcome. Do not blindly resend an ambiguous attempt without documented idempotency/reconciliation support. Keep original occurrence instant and promised delivery instant separate. Immediate delivery honors explicit requested time; digest and quiet-hour policies are visible choices.

Alternatives: claiming exactly-once network delivery from a unique SQL row overstates the guarantee; retrying every timeout may duplicate reminders; defaulting all items to a digest silently changes user intent.

Consequences: operators need a reconciliation queue and clear user-facing failure states. Some uncertain deliveries may require manual resolution. SLOs include missing eligible deliveries in their denominator, and separately report explicit user-requested deferrals.
