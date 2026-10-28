# Ordered implementation backlog

Statuses are local planning status, not remotely created issues. “Ready” means architecture is sufficiently specified; implementation still requires the listed prerequisites. Follow the order within each milestone.

| ID     | Priority / status | Work                                                            | Depends on      | Acceptance evidence                                                                                  |
| ------ | ----------------- | --------------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------- |
| M0-01  | P0 / Done         | Repository, signed ingress and durable work registration        | —               | Unit checks and source scaffold                                                                      |
| M0-02  | P0 / Done         | Install/start Docker, run migration twice and integration tests | Docker          | Docker healthy; migrations, integration tests and API smoke pass                                     |
| M0-03  | P1 / Ready        | Initial commit, remote choice and issue board                   | Review scaffold | Versioned baseline; board has next 3 tasks                                                           |
| EXT-01 | P0 / Ready        | Meta test setup, current eligibility/limits                     | Target audience | Test-number access and documented policy review                                                      |
| EXT-02 | P0 / Ready        | Reminder templates and samples                                  | EXT-01          | Approved name + locale + successful test send                                                        |
| M1-01  | P0 / Local done   | User mapping, consent and timezone                              | M0-02           | Synthetic onboarding, replay, revocation and confirmation tested; production notice/sender pending   |
| M1-02  | P0 / Done         | Tenant roles, transaction context and isolation                 | M1-01           | Restricted-login RLS/grant/FK/pool/owner tests pass; migration and local credentials applied         |
| M1-03  | P0 / Done         | Work lease, recovery and per-user ordered consumer              | M1-02           | Restricted-login claim/recovery/fencing/ordering/shutdown tests; action handler remains M1-04        |
| M1-04  | P0 / Local done   | Model adapter and persisted validated plan                      | M1-03           | OpenAI adapter, immutable plans and retry/consent/RLS tests; live provider calls disabled            |
| M1-05  | P0 / Local done   | Cost reservations and kill switch                               | M1-02           | Concurrent cap, settlement, kill-switch, recovery and RLS tests pass; live rates remain unconfigured |
| M1-06  | P0 / Local done   | Reminder and list-add services with action receipt              | M1-04, M1-05    | Restricted-login execution/replay/rollback/consent tests; reply intents remain unsent                |
| M1-07  | P0 / Ready        | Test-only WhatsApp send adapter and receipt handling            | EXT-01, M1-06   | Truthful confirmation; provider IDs recorded                                                         |
| M1-08  | P0 / Ready        | Real eval runner; 60 reviewed cases                             | M1-04           | Versioned prediction report, no leaked labels                                                        |
| M2-01  | P0 / Planned      | Occurrence schema and transactional due sweeper                 | M1-06           | Two sweepers produce one occurrence/intent                                                           |
| M2-02  | P0 / Planned      | Delivery attempts, template fallback and status reducer         | EXT-02, M1-07   | Window boundary, early receipt, reordered receipt tests                                              |
| M2-03  | P0 / Planned      | Unknown-send state, bounded retry and reconciliation            | M2-02           | Lost response does not trigger blind duplicate send                                                  |
| M2-04  | P0 / Planned      | Complete/cancel/snooze and stale-intent invalidation            | M2-01           | Canceled intent cannot send; stale button rejected                                                   |
| M2-05  | P1 / Planned      | Daily/weekly recurrence and DST policy                          | M2-01           | Gap/fold/zone-change/five-occurrence fixtures                                                        |
| M2-06  | P1 / Planned      | List read/edit/complete with fuzzy clarification                | M1-06           | Parallel adds preserved; ambiguous item asks                                                         |
| M2-07  | P1 / Planned      | Digest/quiet hours and explicit delivery promise                | M2-02           | Exact-time requests not silently delayed                                                             |
| M3-01  | P0 / Planned      | Abuse/rate/plan limits and quota UX                             | M1-05, M2-03    | No unbounded calls/sends; visible exhaustion                                                         |
| M3-02  | P0 / Planned      | Export, deletion and retention                                  | M1-02           | Export ownership; delete cancels work and removes data                                               |
| M3-03  | P0 / Planned      | Telemetry, reconciliation and alerts                            | M2-03           | Injected failures generate actionable alerts                                                         |
| M3-04  | P0 / Planned      | Staging deployment, roles/secrets/PITR, restore                 | M3-02           | Restore to clean DB and reconcile pending work                                                       |
| M3-05  | P0 / Planned      | Failure/load tests and launch checklist                         | M3-01..04       | Gate checklist with evidence and residual risks                                                      |
| M3-06  | P1 / Planned      | Small private beta and feedback loop                            | M3-05           | Daily cost/delivery/correction review                                                                |
| M4-01  | P1 / Deferred     | pgvector + provenance + retrieval benchmark                     | Stable beta     | No tenant leakage; measured recall/latency                                                           |
| M4-02  | P1 / Deferred     | Extraction, deduplication and supersession                      | M4-01           | Corrected fact supersedes; deletion removes retrieval                                                |
| M5-01  | P2 / Deferred     | Voice and secure media pipeline                                 | Stable beta     | Size/type/timeout/retention and language tests                                                       |
| M5-02  | P2 / Deferred     | Tool-free image extraction                                      | M5-01           | Adversarial media cannot authorize actions                                                           |
| M5-03  | P2 / Deferred     | Google OAuth/token encryption/event sync                        | M3-02           | Revoke/refresh/duplicate-event recovery tests                                                        |
| M5-04  | P2 / Deferred     | Multilingual templates, 200+ evals, briefing                    | M4, M5-01..03   | Localized delivery and real eval gate                                                                |
| M6-01  | P2 / Deferred     | Minimal authenticated dashboard                                 | Stable API      | User can inspect/correct/delete own state only                                                       |
| M6-02  | P2 / Deferred     | Plans/billing and additional channels                           | Usage evidence  | Measured demand and viable margins                                                                   |

P0 protects the core product promise or unblocks it. P1 completes a useful beta. P2 expands the product. Move one issue into Doing at a time; keep everything else visible rather than partially implemented.
