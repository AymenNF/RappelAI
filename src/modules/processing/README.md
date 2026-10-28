# Processing boundary

Implemented in M1-03: renewable work leases, stage-aware per-user ordering, stale-worker fencing, expiry recovery, bounded retry, operator recovery audit and cancellation-aware execution. The worker runs onboarding and optional offline plan generation. Execution and receipt handlers remain disabled.

Handlers prepare outside a SQL transaction and apply short database effects through the fenced commit. M1-04 adds bounded model requests, an OpenAI Responses transport and immutable validated plans with tenant isolation. Live model calls, conversational context and action receipts remain later work. See [model plans](../../../docs/model-plans.md). See [work processing](../../../docs/work-processing.md) for the ordering contract and extension requirements.
