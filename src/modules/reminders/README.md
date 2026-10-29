# Reminders

Saved plans create exact-time reminders. The transactional scheduler materializes occurrences and outbound intents; the injectable sender handles gated dispatch and receipts. Versioned controls support complete/cancel/snooze; finite confirmed daily/weekly series compile to independent reminder rows.

M2-07 adds [digest-slot and quiet-hour preferences](../../../docs/delivery-preferences.md). Preferences never silently move exact reminders: each deferral requires a preview and confirmation, storing original and promised instants separately. Digest entries use individual outbound messages. Live sending remains disabled.
