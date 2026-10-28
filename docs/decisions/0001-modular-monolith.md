# ADR 0001: modular monolith with two processes

Status: accepted, 2026-10-27.

Context: one developer needs transactional correctness and a manageable operational footprint. Ingress must remain fast while models and external APIs may be slow.

Decision: one TypeScript/npm project with Fastify API and separate worker entry points. Use PostgreSQL and parameterized SQL for the implemented foundation. Keep migrations authoritative; evaluate Drizzle when typed product queries justify it. Redis/BullMQ is an optional later work buffer. Put dashboard in its own future app boundary without adding a frontend build today.

Alternatives: microservices introduce distributed ownership/transactions prematurely; a full monorepo toolchain adds coordination without current independent packages; processing synchronously in the webhook couples acknowledgement to model latency.

Consequences: code is easy to navigate and transactions remain local. Module boundaries require discipline. One release artifact can start different processes. Split services only after measured scaling or team boundaries justify the cost.
