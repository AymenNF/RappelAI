# Architecture decisions

Accepted here means a working scaffold/design choice, open to revision with evidence. It does not mean a feature is implemented.

| ADR                                | Status   | Decision                                                            |
| ---------------------------------- | -------- | ------------------------------------------------------------------- |
| [0001](0001-modular-monolith.md)   | Accepted | One TypeScript repository, API + worker, incremental SQL migrations |
| [0002](0002-durable-processing.md) | Accepted | PostgreSQL inbox/outbox and idempotent internal effects             |
| [0003](0003-delivery-semantics.md) | Accepted | Truthful delivery states and explicit unknown outcomes              |

## Open product and deployment choices

| Question                                             | Working assumption                                                 | Resolve by                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------ |
| First audience/country/languages                     | Small private beta; English fixtures, Toronto dates for tests only | Day 0                                      |
| Local development capacity                           | Solo developer                                                     | First weekly planning                      |
| Provider eligibility for personal-assistant use case | Unverified; must check current account/policy                      | Before live integration commitment         |
| Model provider and models                            | Unselected, behind adapter                                         | M1 evaluation                              |
| Region/hosting/data residency                        | One region, managed Postgres with PITR                             | Before real-data staging                   |
| User authentication                                  | Select a bounded session/OTP or managed flow                       | Before user API                            |
| Digest and time defaults                             | Exact times immediate; ambiguous date/time asks                    | M1 product fixtures                        |
| DST gaps/folds                                       | Shift gap forward, first fold occurrence once                      | M2 tests and UX review                     |
| Retention                                            | Propose 7-day unconsented staging, 30-day beta raw history         | Before real users                          |
| Secret storage                                       | Unsupported in first release                                       | Only revisit with explicit product need    |
| Pricing/allowances/tiers                             | No fixed vendor rates assumed                                      | Before plans or paid launch                |
| ORM                                                  | Direct parameterized SQL for foundation                            | Add only with clear migration/type benefit |

Use one new ADR for a material change. Record context, decision, alternatives considered, consequences and evidence. Do not silently rewrite an accepted decision to erase why it was chosen.
