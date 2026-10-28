# Processing boundary

Implemented in M1-03: renewable work leases, stage-aware per-user ordering, stale-worker fencing, expiry recovery, bounded retry, operator recovery audit and cancellation-aware execution. The worker runs onboarding; action and receipt handlers remain disabled.

Handlers prepare outside a SQL transaction and apply short database effects through the fenced commit. Context assembly, provider adapter, persisted plans and action receipts remain later M1 work. See [work processing](../../../docs/work-processing.md) for the ordering contract and extension requirements.
