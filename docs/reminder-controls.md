# M2-04: complete, cancel and snooze

One-time reminders now support deterministic commands and versioned WhatsApp reply buttons. The ordinary worker processes these commands during onboarding, without a model call or a spending reservation. Live WhatsApp sending remains disabled; the send adapter is exercised with mocked transports.

## Example

A new reminder confirmation includes its reference and commands. Suppose the current reference is `0123456789abcdef`:

```text
DONE 0123456789abcdef
CANCEL 0123456789abcdef
SNOOZE 0123456789abcdef 15m
```

`DONE` (or `COMPLETE`) marks it completed. `CANCEL` marks it cancelled. Neither deletes the reminder or its history. `SNOOZE` schedules it from the database's current time, accepting whole minutes from 1 to 1440; omitting the duration means 10 minutes. These are elapsed minutes, so a daylight-saving transition does not alter the length of the delay. This milestone does not infer a reminder from its title or interpret phrases such as “tomorrow morning.” Malformed reserved commands return help and never reach the model.

Snoozing returns a **new reference**. Use that reference for subsequent changes. For example, after snoozing the dentist reminder, tapping Done on the earlier delivery does nothing: that button describes an older version. The user receives a stale-control response instead of accidentally completing the new schedule.

In the injectable test sender, reminders sent within an open WhatsApp service window carry Done, Snooze 10 min, and Cancel buttons. Only the button ID is interpreted; its displayed title cannot authorize a different action. Outside the window the existing approved one-body-parameter template path remains unchanged. Use the reference from the latest creation/snooze confirmation for text commands; template buttons are not added without a separately approved contract. Historical reminders obtain controls lazily when an in-window delivery is prepared.

## Transaction and delivery behavior

The worker derives the user from the signed ingress event's business phone and sender. A reference is a selector, not a bearer credential. The handler locks that user and the reminder, then checks consent, confirmed timezone, ownership, pending lifecycle, current schedule version, control expiry and invalidation. Unknown, foreign and stale references receive the same response without exposing the target. Controls expire 30 days after the later of their issue time and reminder due time. Expired references are never silently renewed.

One transaction performs all of the following:

1. Increment the schedule version and update the lifecycle or snooze instant.
2. Invalidate old controls and suppress existing pending occurrences/outbound intents with `reminder_changed`.
3. Exhaust queued retries for those intents, retaining their original results and adding recovery audit records.
4. Suppress a queued creation confirmation describing the superseded schedule.
5. Save an immutable mutation receipt, the confirmation text and the work acknowledgement. Snooze also creates the new control and clears the scheduling marker.

The existing work lease fences the commit. A lost lease or transaction error rolls everything back. Reprocessing the same event returns its saved mutation result; a different event using an old control is stale. Simultaneous commands serialize on the user lock and only one can consume a version. The scheduler subsequently materializes one occurrence for the snoozed version when due, retaining the earlier occurrence as history.

The sender shares the same user lock and rechecks lifecycle/version before authorizing I/O. A cancellation committed first prevents the send. A send already authorized can finish afterward and cannot be recalled. Accepted and unknown attempts remain intact, including later receipts; cancelling does not mean a message was recalled or definitely not delivered. A late retryable rejection or operator reconciliation cannot requeue an invalidated outbound intent. Unknown sends still need the M2-03 reconciliation workflow and can continue to block later sends.

STOP, a pending timezone change or changed identity snapshots invalidate controls. Re-consent does not revive an old schedule. Control commands run in the ordered onboarding stage, so they can invalidate existing reminders even while earlier model work remains queued. The frozen `decision-v1` model tools and 60 evaluation cases are unchanged; fuzzy reminder selection belongs in a future model contract and evaluation update.

## Database and local workflow

Migration `0013_reminder_controls.sql` adds:

| Table                | Purpose                                                                                | Protection                                                                                                             |
| -------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `reminder_controls`  | Opaque reference, owner, reminder/version, identity snapshots, expiry and invalidation | One reference per reminder version; owner-aware FK; forced tenant RLS; workers may invalidate but cannot extend expiry |
| `reminder_mutations` | Event, owner, action/outcome, old/new version and saved reply                          | One receipt per event; verified event-owner trigger; owner-aware reminder FK; forced RLS; no runtime update/delete     |

Workers gain column-level permission to update reminder status, due time and schedule version, in addition to the existing scheduling marker. Tenants retain read-only reminder/control access; ingress cannot read these tables. The runtime worker remains trusted across tenants, as documented in [tenant isolation](tenant-isolation.md).

Stop older workers, then run:

```powershell
npm run db:migrate
npm run build
npm run onboarding:chat
```

The simulator displays stored command confirmations for its own synthetic identity. Use a reference belonging to that identity from an existing reminder confirmation or an authorized operator query; fixture model mode only generates clarification and does not create arbitrary reminders. Do not copy another user's reference or edit database state as a substitute for the command handler. The [execution tests](../tests/integration/execution.test.ts) exercise creation and its references; the [delivery integration tests](../tests/integration/reminder-delivery.test.ts) exercise the full command lifecycle.

For local disposable PostgreSQL tests:

```powershell
$env:TEST_DATABASE_URL = 'postgresql://memorae:memorae_local_only@127.0.0.1:5432/memorae'
npm run test:integration
npm run check
```

Tests cover current/old buttons, malformed commands, event replay, cross-user ownership, expiry, STOP/settings invalidation, exact snooze duration, competing mutations/sweepers, sender lock waits, transaction/lease rollback, late results, retry exhaustion, evidence preservation, and restricted grants/RLS. These are synthetic tests, not live delivery evidence.

The interactive wire shape follows [Meta's archived reply-button reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/types/InteractiveObject/#reply-button). The current Meta documentation endpoint returned HTTP 429 during verification. Live qualification must still verify the selected Graph version, account eligibility and real test-number behavior before enabling sends.

M2-05 now implements finite daily/weekly recurrence with explicit DST policy, previews and whole-series cancellation; see [recurring reminders](recurring-reminders.md). Next is **M2-06 list reading/editing/completion and ambiguous-match clarification**. External activation still needs replacement consent, Meta test setup, approved templates, qualified send budgets and a real model evaluation. The beginner PDF remains the M1-08 snapshot; this runbook documents M2-04.
