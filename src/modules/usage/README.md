# Usage boundary

Implemented in M1-05: atomic global/per-user UTC-month reservations, integer USD-micro accounting, versioned rate snapshots, idempotent settlement, uncertain-call holds, recovery and a global dispatch stop. The planner invokes this gate before each new provider attempt. Operator changes and reconciliation are audited.

See [usage controls](../../../docs/usage-controls.md). Live model pricing/qualification, paid sending, billing integration, user-facing quota responses and production operator provisioning remain future work.
