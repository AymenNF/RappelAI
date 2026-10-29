# M2-07: digest slots, quiet hours and explicit delivery promises

Exact-time reminders keep their scheduled instant. A preference never silently moves an existing reminder or changes a newly created exact-time reminder. Deferral requires a separate preview and confirmation for that reminder, before its original due time.

## Example

Suppose “Take the bins out” is due at 23:00 and you set quiet hours from 22:00 to 08:00. It still targets 23:00. To move it, send `DELIVER <reminder reference> QUIET`. The preview shows the original time, current delivery time and proposed 08:00 delivery with the date, timezone and UTC offset. Nothing changes until you send `CONFIRM DELIVERY <preview reference>`.

If that reminder is important at exactly 23:00, leave it alone. Quiet preferences are permission to offer a deferred time, not permission to change every reminder. Interactive replies are not muted by these settings.

## Commands

| Command                                | Meaning                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `PREFERENCES`                          | Show current settings and the exact-time exception                                 |
| `DIGEST AT 09:00`                      | Set a daily local digest slot for future previews                                  |
| `DIGEST OFF`                           | Disable new digest previews                                                        |
| `QUIET 22:00-08:00`                    | Set an overnight quiet interval for future previews                                |
| `QUIET 12:00-13:00`                    | Set a daytime quiet interval                                                       |
| `QUIET OFF`                            | Disable quiet-hour deferral in new previews                                        |
| `DELIVER <reminder reference> DIGEST`  | Preview the next daily slot at or after the due time, adjusted through quiet hours |
| `DELIVER <reminder reference> QUIET`   | Preview quiet-hour deferral only; otherwise retain the due time                    |
| `DELIVER <reminder reference> EXACT`   | Preview restoration of the original due time                                       |
| `CONFIRM DELIVERY <preview reference>` | Apply the displayed promise, if still valid                                        |

Times require 24-hour `HH:MM`. Equal start/end times are rejected, avoiding an ambiguous all-day interval. Settings use the confirmed IANA timezone. Digest and quiet settings start off. Disabling or editing a setting invalidates unconfirmed previews but does not move previously confirmed promises. Use a fresh `DELIVER ... EXACT` before the original due time to restore one, or cancel/snooze with its latest reminder control.

**Digest scope:** entries are scheduled at a daily slot and sent individually, each with its existing receipt, retry history and controls. This milestone does not combine entries into one summary message, create an automatic daily overview, or reduce the number of sends. Those require a batch-delivery design covering membership changes, cancellation and partial results. This limitation is also stated in preference replies.

## Time and confirmation rules

- Quiet start is inclusive and end is exclusive. Overnight intervals cross the local date boundary.
- A digest slot is at or after the original due instant. A due time one microsecond after the slot uses the next date. Quiet hours can move the slot to their end.
- Missing clock times shift forward by the DST gap. A repeated digest time uses the first occurrence once; if it has already passed, use the next day's slot. During the second repeated hour, a quiet end uses the remaining valid boundary instead of moving backward.
- Each preview saves exact UTC instants, timezone, timezone-data version, preference values/revision and identity snapshots. Confirmation uses the stored instant, not a recalculation under newer settings.
- Previews expire after 15 minutes or at the original due time. Only future, pending, not-yet-materialized reminders can change delivery mode. Confirmation checks again after acquiring the reminder lock.
- A newer preview or preference edit invalidates old previews. Cancel, snooze, recurrence activation and competing confirmations change the reminder version, making old references stale.
- Snooze explicitly creates an exact-time promise at the requested new time, bypassing digest/quiet preferences. Done and Cancel work on deferred reminders too.
- Each recurring occurrence can be opted in separately. Creating a recurring series requires an exact-time source; a deferred source is rejected so a whole series cannot accidentally inherit a deferral.
- STOP and timezone changes invalidate preferences and pending previews. After onboarding is confirmed again, settings start off in the current timezone. Old reminders still require their original identity snapshots; re-consent does not revive them.

## Architecture and database

Migration `0016_delivery_preferences.sql` adds forced-RLS `delivery_preferences`, immutable `delivery_choices` (except status), and immutable per-event `delivery_preference_actions`. Owner-aware references and an event-owner trigger prevent cross-user associations. Tenants can read their own rows; ingress cannot access these tables; only the trusted worker can apply settings or consume choices.

The onboarding worker handles commands without model calls. It locks the user, preference, choice and reminder, then commits the new schedule version, choice consumption, control invalidation, action receipt, identity reply and lease acknowledgement together. Failure or an expired lease rolls everything back. Replaying an event returns its receipt; a new event cannot reuse a consumed choice. Queued original creation replies are suppressed when their schedule changes.

`reminders.due_at` remains the original instant. Deferred rows have a separate `promised_due_at` and owner-bound `delivery_choice_id`. Immediate rows have neither. Constraints forbid promises earlier than the original time. The scheduler materializes at the original due time and copies both instants and the delivery mode into `reminder_occurrences`; outbound `available_at` uses the promise. The sender therefore cannot send early. A future digest intent sorts after an earlier exact-time intent, preserving eligibility for that exact reminder. Existing consent, cancellation, global pause, template, receipt and bounded retry gates remain in force.

“Exact-time” describes the scheduling promise, not a claim of guaranteed network delivery. Provider failures, outages, unknown sends and existing per-user ordering may still prevent timely delivery. No delivery SLO has been established.

The frozen model contract and 60 evaluation cases are unchanged. A model-produced digest request remains unsupported and creates no partial effects; its response now directs the user to this explicit confirmation flow. This prevents a model prediction from silently authorizing a time change.

## Local use and verification

Stop older workers, run `npm run db:migrate`, rebuild and restart. No new credentials or environment variables are needed. `npm run onboarding:chat` can show the command responses for its own synthetic user. Live WhatsApp sending and paid model calls remain disabled.

Seven new unit tests cover syntax, precision, daytime/overnight boundaries, DST folds/gaps, non-hour offsets, leap days and skipped dates. Fifteen new database scenarios cover settings/readback, immutable previews and promises, replay, competing confirmation, stale/expired/foreign choices, lease rollback, STOP/timezone reset, snooze/recurrence interactions, expiry while waiting for locks, scheduler replay, mocked sender timing and tenant/grant/FK isolation.

Next is **M3-01: abuse, rate and plan limits with clear quota messages**. External Meta eligibility/template setup, replacement consent and live model qualification are still prerequisites to a real-user pilot. The beginner PDF remains the historical M1-08 snapshot.
