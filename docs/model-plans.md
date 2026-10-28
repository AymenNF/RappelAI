# Model adapter and persisted plans (M1-04)

M1-04 implements a provider-independent adapter, an OpenAI Responses transport, a versioned prompt and an immutable plan store. Local tests use fake provider responses; no paid API call or real AI quality evaluation has been run. No model ID is selected automatically.

## Current local behavior

The default `MODEL_MODE=disabled` preserves pending action work. Set `MODEL_MODE=fixture` to exercise plan persistence entirely offline:

Stop existing workers before migration 0006 and restart them with this version. Older workers do not recognize execution-stage predecessors and must not run alongside the new planner.

```powershell
npm run db:migrate
$env:MODEL_MODE = 'fixture'
npm run dev:worker
```

The fixture always returns `clarify` with no calls, labeled `fixture / fixed-clarify-v1`; it does not understand the message. Use synthetic inputs. It saves a plan for the first ready message per user and leaves it in `execution`. Later messages from that user wait for execution; onboarding, including STOP, continues. No reminder, list item or reply is created. Stop the worker and remove the shell override with `Remove-Item Env:MODEL_MODE` to restore the default.

The OpenAI transport takes an explicit API key and model ID through its constructor. It is tested with an injected HTTP transport, but is not selectable from worker configuration yet. The current consent notice explicitly says no provider calls; M1-05 also still needs spending reservations and a kill switch. Enabling real-user calls requires those changes plus a reviewed provider/model choice and real evaluations. Secrets are not read or transmitted by fixture mode. The old reserved `MODEL_API_KEY` and model fields remain unused by the worker.

## Provider boundary

`ModelAdapter` sends only the current text, confirmed timezone, ingress receipt time and current database processing time. It does not send phone numbers, consent tokens, internal user IDs, other users' messages or retrieved history. Relative dates anchor to receipt time, so retrying tomorrow cannot reinterpret “tomorrow” from a later day. Arbitrarily late provider webhooks remain subject to the receipt-order policy.

The adapter caps input length, bounds execution time (default 20 seconds, configurable through `MODEL_TIMEOUT_MS`), propagates cancellation and ignores late results from an uncooperative provider. It validates JSON with the existing strict decision schema and checks future reminder dates. Provider errors and raw output never become error messages or ordinary logs. Retryable failures use the existing bounded work retry policy. Refusal, request rejection and oversize payloads become permanent failures; operators can repair and retry dead work.

The OpenAI transport uses the [Responses API structured-output format](https://developers.openai.com/api/docs/guides/structured-outputs), with a schema derived from the runtime contract. Disjoint Zod union branches are converted from `oneOf` to supported `anyOf`. Application validation still enforces semantic constraints. The request specifies `store: false`, an output-token cap and no tools. The transport rejects incomplete/refused output, unexpected output types, missing usage and bodies over 128 KiB. Automatic HTTP retries are disabled by design; work attempts own retry accounting. `store: false` is not a claim about all provider retention or logging policies.

This version has no conversation history, existing-list context or clarification text in its decision contract. Ambiguous references produce a clarification decision; rendering the question/reply belongs to later response handling. Schema validation does not prove the model interpreted intent or timezone correctly. Reviewed real evaluations remain M1-08.

## Persistence and execution handoff

Migration 0006 adds `action_plans` and the `execution` work stage. One immutable version-1 plan is allowed per ingress event. It records the validated decision, provider/model, response ID, prompt version/hash, input hash, schema version, token usage, latency, reference/validation times, and consent/timezone snapshots. Token counts are metadata, not cost reservations or a billing ledger. Failed calls and crashes before persistence may still incur unrecorded provider cost; M1-05 must account for attempts before activating paid work.

Planning checks the live lease and current onboarding eligibility before a provider call. In the final fenced transaction it locks the user row, rechecks consent/grant and timezone, and checks reminder dates against database time again. A STOP or timezone change committed before that check discards the generated plan. A STOP cannot retract an external request already issued. The plan insert and stage transition to `execution` are atomic; ingress remains incomplete until later execution/reply handling.

Runtime roles cannot update or delete plans. Replayed planning reuses an existing plan rather than calling the provider again, even if configuration or output has changed. Invalid or obsolete plans require an explicit future migration/reconciliation path, never silent regeneration. A crash **before** persistence may cause another provider call; only persisted decisions are stable. An expired reminder in a saved plan remains unchanged and must be rejected or clarified by the future executor.

`actionKey(plan, index)` derives a stable SHA-256 key from event ID, plan version, action index and tool kind. M1-06 will use those keys for transactional action receipts, entity changes and reply intents. The execution stage currently has no consumer. Earlier pending, leased or dead execution work blocks later planning/execution for that user; other users proceed independently.

Plans have forced row security, a composite owner/event foreign key, tenant-scoped SELECT and explicit worker SELECT/INSERT grants. Ingress cannot access them. Future execution must recheck current eligibility under the user lock; reading a saved plan is not authorization to execute it.

## Tests and next work

Unit tests cover adapter request separation, schema/semantic validation, provenance, synchronous failures, timeout/cancellation, refusal/truncation, HTTP status handling, response bounds and disabled-by-default configuration. PostgreSQL tests use actual restricted ingress/worker/tenant logins for competing workers, atomic rollback, replay reuse, stable keys, invalid-output/timeout recovery, STOP/timezone races, expired reminders, stale leases, per-user ordering, immutable grants and tenant ownership.

Next: M1-05 usage reservations and global spending stop, then M1-06 transactional reminder/list actions and replies. Provider/model qualification and the replacement consent notice can be developed alongside those tasks. Live provider compatibility, measured cost, model accuracy and external delivery remain unverified.
