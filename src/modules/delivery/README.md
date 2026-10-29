# Delivery boundary

M2-01 creates one durable `outbound_messages` reminder intent per occurrence. No consumer sends these yet. M1-07's WhatsApp module separately implements test reply attempts and receipt reconciliation. M2-02 connects reminder intents to attempts, template/window checks and qualified send budgets; M2-03 adds audited unknown-outcome recovery. SQL uniqueness protects internal intents, not exactly-once network delivery. See [scheduling](../../../docs/reminder-scheduling.md).
