# WhatsApp boundary

Signed ingress and event normalization, Cloud API text transport, test-only durable reply dispatch, and leased receipt reconciliation. The regular worker handles receipts but never constructs a live sender. See [delivery runbook](../../../docs/whatsapp-delivery.md) for state semantics, activation prerequisites and test coverage.
