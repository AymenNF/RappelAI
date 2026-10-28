# Organizing your work

Use this repository as the source for design, code, prompts and evaluations. Use one issue board for execution; GitHub Issues/Projects is a natural fit, but a simple local task list works until a remote repository exists. No remote repository or issues have been created by this scaffold.

## Board

Columns: **Backlog → Ready → Doing → Review → Verify → Done**, plus **Blocked**. Keep one implementation issue in Doing, with at most one external-dependency issue being tracked alongside it. A task enters Ready only when acceptance criteria and dependencies are clear.

Each issue needs a backlog ID, milestone, outcome, owner, estimate, dependencies, acceptance criteria and evidence links. Size ordinary issues to half a day–two days. Split larger work by a working behavior, such as “persist inbound with replay safety,” rather than by a broad layer such as “do all database work.” Use labels for module, bug/feature/chore, priority and blocked reason. The checked-in issue form helps capture the basics.

## Daily loop

1. Read the current milestone's exit gate and choose the highest-priority Ready item.
2. Write down the intended behavior and failure case before coding.
3. Implement the smallest complete path; add tests that demonstrate meaningful failure behavior.
4. Run `npm run check`, plus relevant database/provider/eval checks.
5. Review your diff for secrets, accidental changes and misleading success claims.
6. Commit the working slice and record what changed, evidence and next action in the issue.

Keep a short developer log if useful: date, issue ID, result, blocker, next step. Do not replace code or tests with long progress notes.

## Weekly loop

- **Planning, 30 minutes:** pick one visible outcome and at most 3–5 issues. Reserve about 25% of capacity for defects and uncertainty.
- **Midweek, 15 minutes:** review blockers, approval status and the oldest pending work. Cut scope early if the milestone is slipping.
- **Demo, 30 minutes:** show the behavior over a test WhatsApp conversation or deterministic fixture. Include a failure/recovery scenario.
- **Review, 30 minutes:** inspect corrections, delivery evidence, eval regressions and costs. Turn each real defect into a regression case. Re-estimate remaining work from observed throughput.

## Git and review

The repository now has an initial commit on main and an origin remote. Review the current local onboarding changes before committing them. Use short-lived branches such as `codex/m1-consent` and `codex/m1-outbox-consumer`. Prefix work with the backlog ID in commit or PR text. Do not combine an unrelated dependency upgrade, a schema change and a new product feature into one large review.

Before merging, describe the problem, resulting behavior, validation and rollout concerns. Applied migration files are immutable. Prompt and model changes require the same review discipline as code. Record architecture changes as small ADRs in `docs/decisions/`.

## Definition of ready

- One observable outcome; scope and exclusions are clear.
- Acceptance criteria cover the happy path and relevant failure/abuse path.
- Required decisions/dependencies are resolved or explicitly mocked for local work.
- Estimate fits two focused days, or the issue is split.

## Definition of done

- Acceptance criteria are demonstrated with evidence.
- Typecheck, relevant tests and build pass; formatting is consistent.
- Real model evaluation is attached when model behavior changed; dataset validation is not substituted for it.
- Database migrations and ownership tests cover new data paths.
- No secrets/raw user content in logs or fixtures; errors are visible and retry behavior is deliberate.
- Documentation matches the implementation, including known limitations.
- Release/migration/rollback implications are understood; staging validation is complete when needed.

## Decision log and external tracker

Use ADRs for choices that are expensive to reverse: storage, tenancy, delivery guarantees, model contract and retention. Use issues for routine implementation choices. Do not wait for perfect architecture to implement the first safe slice.

Track external setup separately:

| Item                                     | Owner | State           | Next action / due                       |
| ---------------------------------------- | ----- | --------------- | --------------------------------------- |
| Meta business/app and policy eligibility | You   | Not started     | Confirm target use case and test access |
| Dedicated phone/test recipients          | You   | Not started     | Provision test setup                    |
| Reminder template approval               | You   | Not started     | Draft samples and submit                |
| Model provider + budget                  | You   | Not started     | Pick candidate and set limits           |
| Hosting/PostgreSQL region                | You   | Decision needed | Compare operational requirements        |
| Privacy text, retention and processors   | You   | Decision needed | Review before personal-data beta        |

Update this table or copy it into your issue tracker; avoid maintaining two conflicting status sources.
