# M3-06: prepare a private beta while launch stays blocked

M3-05 is committed and pushed as `2d3eba8`, and M3-06 as `34edc99`. M3-06 adds preparation and review tools, a user feedback command and daily operational reports. **No beta has launched, no participants have been invited, and provider activation remains disabled.** Continue with the [remaining launch work](launch-readiness.md).

The plan starts with up to five proposed testers, with an absolute planning ceiling of twenty. That ceiling is a planning constraint, not evidence that the system can serve twenty real users. Grow only after real delivery, cost and support results justify it.

## Prepare the plan and check the gates

`ops/beta-plan.json` is the current draft. Fill the operator, incident owner and private support channel; use aliases such as `beta-01` for proposed participants. Store the name/address/account mapping in a separately protected location, never in Git. The plan deliberately starts with an empty cohort, blank responsibilities and no owner approval.

```powershell
npm run beta:prepare -- docs/evidence/launch-qualification.json sha256:<expected-candidate-image-id>
npm run beta:prepare -- docs/evidence/launch-qualification.json sha256:<expected-candidate-image-id> --require-ready
```

The preparation check runs the existing launch-readiness checks, then checks responsibilities, a bounded/unique alias list and fresh owner approval for the same image. Missing/stale/mismatched evidence blocks it. Strict mode exits nonzero while blocked. Even a fully reviewed result says `launchEnabled: false`: this command cannot invite users, activate providers, deploy or change spending. It only says whether the plan is ready for the owner's launch review.

M3-06 changes the candidate image. Refresh qualification, regression evidence and all applicable reviews for that image before treating prior M3-05 results as launch evidence. Do not mark the external gates verified merely to make the checker green.

The [local qualification report](evidence/m3-06-qualification.json) and [zero-volume daily report](evidence/m3-06-daily-review.json) demonstrate the tooling. Their limitations and the initial failed qualification attempt are recorded in [verification](verification.md). They do not establish real-user delivery, complete costs or launch approval.

Before real enrollment, finish hosted security, off-site restore/paging, production consent and export delivery, live model evaluation and approved template/test-number delivery. Implement and test the eventual live runtime wiring and recipient access restriction as a separate reviewed change. The alias plan is not an authentication or runtime allowlist. Current production startup remains blocked.

## Preparation packet

Use the drafts in `ops/templates/`:

- `beta-invitation.md`: invitation text to adapt **after** readiness and owner approval. It has not been sent.
- `beta-cohort.example.json`: private tracking fields for proposed enrollment and withdrawal. Save filled copies under ignored `.beta-private/` with a private filesystem ACL.
- `beta-daily-signoff.example.json`: reviewer decision, evidence and follow-up references after reading a report. It is a human review record, not an executable permission to launch.

For the initial wave, choose people willing to report mistakes and explain the supported scope: reminders, named lists, explicit controls and the tested recurrence/preferences subset. Do not ask them to rely on the beta for critical reminders. Verify the approved consent flow and each person's timezone before any live test. Record invitation, opt-in and withdrawal separately; a proposed alias is not consent.

## Collect feedback

An onboarded user can send one of:

```text
FEEDBACK LATE
FEEDBACK MISSING
FEEDBACK WRONG
FEEDBACK CONFUSING
FEEDBACK GOOD
FEEDBACK OTHER
```

The normal ordered worker handles these without a model call. It returns a feedback reference and makes no promise that a reminder was changed or delivered. Request quotas still apply. Paused, unconsented, unconfirmed-timezone or deleting accounts cannot create feedback through this command. A duplicate event produces one record. Invalid or appended free text prompts the category list rather than reaching the model.

The feedback table stores the category, account/event relation, timestamps and triage state. It does not copy message text into a new feedback field. The original inbound message remains subject to existing ingress retention, so this is not a claim that free text never reaches storage. Collect any follow-up detail through the approved private support channel, with a clear retention policy; do not put raw conversations into public issues.

With administrator credentials:

```powershell
npm run beta:control -- feedback list
npm run beta:control -- feedback list investigating
npm run beta:control -- feedback triage <feedback-uuid> <current-revision> investigating
npm run beta:control -- feedback triage <feedback-uuid> <current-revision> resolved fixed
```

Other resolution codes are `duplicate`, `expected`, and `not_reproducible`. Resolve only after inspecting evidence. Updates require the latest revision; competing/stale reviews cannot silently overwrite each other. Status and audit commit atomically. Reload the current status list if a revision changed. Lists return at most 100 records; work through them by status rather than exposing an unbounded public feed.

The API/worker/tenant/monitor cannot perform operator triage. Tenants can only read their own feedback and audit. Feedback and audit are included in account export and erased through confirmed account deletion. The monitor only sees category/status/timing columns for aggregate reviews.

## Daily review routine

The draft proposes **14:00 UTC** as the review time (10:00 Toronto during daylight time; 09:00 during standard time). No scheduler or desktop automation has been installed. Choose the actual operator/time before launch. At that time, review the **previous complete UTC day** so costs use the same financial day across users' timezones. Reminder promises still use their saved user-specific timezone/instant; this reporting choice does not move reminders.

1. Run the readiness/preparation check for the candidate and inspect any new blockers.
2. Generate a new daily report. Review unresolved model reservations, cost totals, current monthly budget, reminder delivery evidence and feedback.
3. Investigate gaps using the existing `ops:control`, `usage:control` and `delivery:control` commands. Never retry an uncertain send merely because a receipt is missing.
4. Triage feedback, create a sanitized regression case for each reproducible defect, and record issue references.
5. Save a signoff with `hold`, `continue_existing_scope` or `pause_and_investigate`, reviewer and evidence reference. Expanding the cohort needs a separate owner decision. A report or signoff never changes the kill switch automatically.

For the local development database (administrator fallback) or a protected monitor connection:

```powershell
# Create .beta-private with permissions limited to your account first.
npm run beta:control -- review 2026-10-29 .beta-private/review-2026-10-29-initial.json ops/beta-plan.json
```

The command requires a new filename and refuses to overwrite a previous observation. Today is allowed but labelled provisional; future dates and invalid calendar dates are rejected. For a later receipt reconciliation, produce a second version rather than silently replacing yesterday's report.

For running Docker staging, the monitor receives the non-secret beta plan as a read-only mount:

```powershell
node scripts/docker.mjs compose -f compose.staging.yaml exec -T monitor node dist/ops/beta.js review 2026-10-29 /tmp/review-2026-10-29-initial.json /app/ops/beta-plan.json
node scripts/docker.mjs compose -f compose.staging.yaml exec -T monitor cat /tmp/review-2026-10-29-initial.json | Out-File -Encoding utf8 -NoClobber .beta-private/review-2026-10-29-initial.json
```

Use `MONITOR_DATABASE_URL_FILE` for hosted reviews; the staging monitor never receives administrator credentials. Exported report files and signoffs are separate operational copies: protect their directory, define expiry and remove copies when no longer needed. Copy the report out of `/tmp` before recreating the container.

## Read costs correctly

Migration 0022 records each new model settlement into a global UTC daily total in the same transaction. Settlements are immutable and counted once; rollback removes both the charge and its aggregate increment. Totals contain no account/reservation IDs and remain after account erasure, like the existing global monthly totals.

Amounts are integer **USD microdollars**, represented as strings to preserve exact values: `1000000` means USD 1.00. The financial day is the settlement day, which can differ from the original request/accounting month. Unresolved reservations remain visible separately and are not assumed free. The current monthly budget snapshot is labelled separately from the historical review day.

Tracking starts when migration 0022 is installed. It does not invent history from previously erased reservations. Reports label any day whose start predates tracking as incomplete, including the first installation day. Historical daily zeros are not proof that nothing was spent.

`dailyModelReviewMicros` is a **review threshold**, not a new spending authorization or cap. Its initial value `0` calls attention to any nonzero model cost. Actual paid dispatch remains controlled by the existing usage policy and kill switch. WhatsApp charges, hosting and other invoices are explicitly `not_tracked`; do not present this as a complete business-cost report.

## Read delivery evidence correctly

The review cohort uses saved promised availability in the UTC window. It counts a materialized reminder once across attempts and duplicate delivered/read receipts. Suppressed intents are shown separately. Still-pending promises not yet materialized are included in the on-time evidence denominator, so an absent scheduler does not create a misleading perfect result.

`accepted` means the provider accepted an attempt. `confirmed` requires a correlated delivered/read receipt. `onTime` requires its earliest observed delivery timestamp to fall from the promised instant through 60 seconds afterward. Early timestamps are flagged as clock anomalies; future receipt timestamps are excluded until observed time reaches them. Missing receipts are a gap in evidence, not proof of provider failure. Uncertain sends stay visible.

The report gives the on-time numerator and denominator rather than claiming a production SLO from a tiny sample. It describes retained current promises at observation time: snoozes, cancellation, deletion and late receipts can change a later report. It does not reconstruct an immutable historical promise ledger, and it covers reminder intents rather than all onboarding/list reply messages. Preserve signed-off observations and qualify production measurement before making delivery guarantees.

## Stop and expand rules

Keep launch on hold for any readiness blocker. During an eventual authorized beta, investigate any suspected tenant/privacy leak, duplicate external action, unexplained charge, unresolved send or missing promise. Pause paid dispatch when warranted using the established usage command, preserve evidence, and have the incident owner review before resuming. Do not reinterpret an exact-time reminder as deferred to hide a missed promise.

Expansion beyond the initial wave requires several reviewed days of real results, understood costs, resolved serious feedback and renewed owner approval. Local zero-volume reports cannot meet this requirement. M3-06 preparation is complete only as local tooling; the actual participant beta remains gated.
