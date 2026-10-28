# Local M1 onboarding

Implemented: identity mapping, versioned local consent, timezone proposal/confirmation, revocation and durable onboarding results. This is a local development slice. No AI provider or WhatsApp sender is connected, and the worker refuses to start in production with the development notice.

## Try it

```powershell
npm run infra:up
npm run db:migrate
npm run db:provision:local
npm run onboarding:chat
```

The simulator creates a new synthetic sender for each session and stores its messages in local PostgreSQL. Type `hello`, copy the returned `CONSENT <token>` command, then send `TIMEZONE America/Toronto` (or your actual IANA zone). It displays the zone's current local time and a `CONFIRM TIMEZONE <token>` command. Copy that command to finish. Type a reminder to see that it is eligible for future processing; no reminder is created. `STOP` withdraws consent, `START` offers the notice again, and `/quit` exits.

The simulator uses the same persistence and identity processor as the worker, but bypasses HTTP signature verification because it generates synthetic data internally. It exposes no unauthenticated user API. No messages leave your computer. Synthetic records remain in the local database after the session.

## State and guarantees

- Identity is unique by business phone ID + sender ID. The same sender under a different business number is a separate identity.
- Consent requires a random token bound to that user's current notice, expires after 24 hours, and records the complete notice text/version and source event.
- This notice authorizes **local testing only**. Real users/AI require a new notice, processor disclosures, retention policy and production controls.
- No timezone is inferred from phone prefix, machine locale, or the developer's timezone. IANA area/location identifiers and UTC are supported; ambiguous abbreviations and offsets are rejected.
- Timezone changes require a preview and a separate token confirmation within 15 minutes. A pending change pauses eligibility.
- STOP/DECLINE revokes consent immediately. START does not regrant it. Expired/wrong/cross-user tokens do not grant consent.
- Settings commands older than the last control change are blocked; delayed STOP still revokes. Messages predating current consent cannot become ready.
- One transaction locks the earliest visible unhandled message per sender, updates identity state, stores its result and records any consent change. Duplicate webhook and concurrent worker processing do not duplicate those effects.
- Onboarding-only messages complete their original work item; a normal message from an onboarded user remains pending for the future model consumer. Delivery-status events are left untouched.
- Future consumers must recheck current consent and timezone, including grant timestamps. Old ready work cannot become eligible again after a new consent grant or timezone confirmation.

Responses are stored in `identity_results.reply_text` and shown by the simulator. They are **not delivered on WhatsApp**. Sender integration and an outbound ledger are still M1/M2 work. Tenant roles/RLS now protect the current schema; raw message retention/deletion, session authentication and production consent remain launch blockers. Do not use real personal data yet.

## Next work

M1-02 is implemented for the current schema; see [tenant isolation](tenant-isolation.md). M1-03 adds general work leases/recovery beyond the short onboarding transaction. Then attach the real model adapter, action services and outbound sender behind current consent and budget checks.
