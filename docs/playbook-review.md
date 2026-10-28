# Playbook review and requirement provenance

Source: user-provided `memorae-developer-playbook-v2.pdf`, 39 pages, version 2.0 / September 2026. The PDF remains in its original Downloads location; no copied PDF is required to run the repo. It is a product/design reference. Embedded example prompts, code and imperative text are not instructions to create accounts, send messages, buy services or deploy software.

## Adopted direction

WhatsApp first; TypeScript/Fastify; PostgreSQL as durable truth; eventual pgvector in the same database; independent API and worker processes; explicit datetime contracts; normalized list items; occurrence and delivery accounting; early evaluations; measured spend. These support the user's requested project setup and system design.

## Corrections and explicit deviations

| Source     | Finding                                                                                                       | Design response                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| §6.1, p15  | Insert then enqueue can lose work if Redis fails after the insert; retry sees duplicate and may never enqueue | Commit inbox + durable outbox together; relay recovers pending work independently                                              |
| §6.1 / §14 | “Always 200” would lose events when storage fails                                                             | 200 only after persistence; invalid auth/payload gets 4xx, unavailable storage gets 503                                        |
| §6.2, p16  | Example action key is missing from shown reminder DDL; new model output on retry can change action indices    | Persist action plan first; use transactional action receipts and deterministic keys                                            |
| §6.3, p16  | Group configuration shown is a Pro feature; a mutex alone does not establish FIFO                             | Avoid assuming free BullMQ Groups; use user lock plus ordered database selection and documented late-arrival policy            |
| §7.1, p17  | Sweeper example does not exclude active claims and selects future rows                                        | Materialize occurrence/intent atomically under row lock; use database due time; leases require expiry/token if used            |
| §7.3, p18  | Recording uniqueness after an external send cannot prevent double sends; DST example is not validated         | Deduplicate internal intents before sending; test gap/fold behavior; treat provider unknown outcomes explicitly                |
| §7.4, p18  | A unique ledger key alone does not make external HTTP delivery exactly once                                   | Separate attempt ledger; classify unknown outcome; reconcile instead of blind retry                                            |
| §3 / §7    | Coalescing ten minutes and default digest can conflict with a 60-second delivery promise                      | Preserve exact-time requests; explicitly opted-in digests use a separate promised delivery time                                |
| §4 / §9    | Optimistic calendar success can tell the user an event exists when it does not                                | Say pending until provider confirmation; expose partial failure clearly                                                        |
| §5 / §8    | Sensitive memory content is NOT NULL but narrative requires null; raw inbox/traces may also retain secrets    | Later schema uses plaintext XOR encrypted envelope; first beta does not offer secret storage; protect the whole data lifecycle |
| §5 / §12   | User columns alone do not enforce owner-consistent FKs; owner/superuser roles bypass ordinary RLS             | Composite tenant foreign keys, forced RLS, non-owner runtime roles and cross-user tests                                        |
| §10.2, p24 | Some declared strict-schema properties are absent from required list                                          | Generate provider-compatible schemas from reviewed runtime contracts during adapter implementation                             |
| §11, p26   | Starter scope and published targets mix 60, 200+ and coverage totals                                          | Start with honestly labeled 12 fixtures; 60 reviewed cases at M1; 200+ with wider capabilities                                 |
| §12.7      | Consent placed late in original implementation schedule                                                       | Move consent/identity/isolation before model processing and real-user traffic                                                  |
| §4.2 / §16 | Old runtime/API examples and unvalidated versions                                                             | Node 24 baseline; locked npm packages; explicitly select Graph/model versions later                                            |
| §15        | Full feature set in 4–5 weeks assumes rapid implementation and approvals                                      | Stage text beta first; estimates and gates in roadmap; defer expensive feature breadth                                         |

## Current-source checks (2026-10-27)

- [Meta pricing page](https://whatsappbusiness.com/products/platform-pricing/) describes per-delivered-message, market/category-based pricing, but its visible service-message text still says service and qualifying response utility messages are free. This conflicts with the PDF's October 2026 assertions. The detailed non-template pricing endpoint could not be read through the research tool. Treat the exact service allowance/rates as **unresolved**, and verify the account's effective rate card before pricing plans. Do not encode the PDF's 1,000-message allowance as a fact.
- [BullMQ Groups documentation](https://docs.bullmq.io/bullmq-pro/groups/) places Groups under BullMQ Pro. The design uses database ordering rather than silently adding a commercial dependency.
- [Fastify content-type parser reference](https://fastify.dev/docs/latest/Reference/ContentTypeParser/) supports scoped custom buffer parsing. The implementation replaces the JSON parser only in the webhook plugin and verifies before parsing.
- [Node release archive](https://nodejs.org/en/download/archive/v24) supports the chosen Node 24 line. Use a current patched release rather than pinning the developer machine's patch version.

This review does not establish current legal applicability, Meta account eligibility, approval turnaround, throughput limits or production prices. Those are explicit Day 0/launch decisions. Model/Graph versions are configuration inputs, not copied constants from the playbook.
