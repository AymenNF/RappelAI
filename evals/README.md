# AI evaluation (M1-08)

The runner uses the same `ModelAdapter` and OpenAI Responses transport as the application. The versioned `m1-v1` suite contains **60 agent-reviewed synthetic cases** with a rationale on every case. Human review and a credentialed model evaluation remain pending. No live accuracy result is claimed.

## Run it

Offline harness smoke, with no credentials or network:

```powershell
npm run eval:validate
npm run eval:run
```

The default transport returns a constant `noop`, independently of labels. It tests report generation; its match rate is not AI accuracy. The command succeeds when the harness completes, but the report's `gatePassed` is always false for mock runs.

For a deliberately authorized paid run, set `OPENAI_API_KEY` privately in your environment and supply the exact model you want to qualify:

```powershell
npm run eval:run -- --provider openai --allow-paid --model YOUR_MODEL_ID --split development --max-calls 48 --max-output-tokens 2000 --timeout-ms 20000
```

Use `--split holdout --max-calls 12` only after prompt choices are fixed, and `--split all --max-calls 60` for the full gate. Do not treat repeated holdout tuning as independent validation. These are repository-visible cases, not a secret benchmark. No model ID or current price is assumed. The runtime worker's remote-model switch is unchanged.

The runner sends sequential requests, at most the requested call limit (1–60), with bounded output (128–8000 tokens per request) and a deadline. It never automatically retries. Rate limits, unavailable/rejected calls, timeout and cancellation stop the run and retain partial results. Invalid/refused model answers remain failed predictions. Unknown usage remains explicitly unknown; it is never silently represented as measured zero usage.

This is a standalone synthetic benchmark. It does not access the application database, spend reservations, production consent, or the database kill switch. The paid opt-in and call/output bounds are not a dollar budget. Use a separate provider project with account spend controls, check its pricing before a paid run, and stop the process with Ctrl+C if needed. Do not put real messages or personal information into this suite. CI runs offline validation/tests only and needs no provider secrets.

## Dataset and review

`datasets/m1-v1.jsonl` is the active suite; `starter.jsonl` is archived historical material. The [case review table](datasets/m1-v1-review.md) provides a readable view of all 60 expectations and rationales. The manifest binds a normalized-LF SHA-256, version and case count. A changed label/input requires a deliberate dataset version and manifest update rather than silent replacement. The current loader selects `m1-v1` explicitly.

| Category     | Cases | Review focus                                                     |
| ------------ | ----- | ---------------------------------------------------------------- |
| Reminder     | 10    | Future dates, elapsed time, noon/midnight, leap year             |
| Timezone     | 8     | Date boundaries, fractional offsets, spring/fall transitions     |
| List         | 10    | Explicit names, single quoted items, Unicode                     |
| Ambiguity    | 8     | Missing fields, past dates, gap/fold, delayed processing         |
| Scope        | 8     | Recurrence, calendar, media, secrets, third parties              |
| Injection    | 8     | Role/format spoofing, identity injection, quoted imperative data |
| No-op        | 4     | Greetings and acknowledgements                                   |
| Multi-action | 4     | Order, intentional duplicates, five-call boundary                |

There are 48 development and 12 fixed holdout cases. Review metadata identifies Codex, the date and the reasoning; it does **not** imply independent human review. Cases use the current decision contract and canonical prompt. One label convention is preserving quoted title/item text and action order. Timezone offsets and all future expected dates have automated checks. Gap/fold ambiguity expectations require clarification; explicit offsets disambiguate folds.

The model boundary is an explicit allowlist of message, confirmed timezone, reference time and processing time. Case IDs, split, categories, labels and review notes do not enter requests. Expected decisions are consumed only by the scorer. Unit tests inspect the actual OpenAI request body for this separation.

## Reports and scoring

Every invocation creates a unique UUID directory under `evals/results/` (or `--out`). It never overwrites or resumes another run. The directory contains:

- `manifest.json`: dataset/version/hash/split/IDs, requested model/provider, prompt/schema hashes and versions, scorer version, Git revision/dirty flag, Node version, start time and request limits.
- `prompt.txt` and `schema.json`: exact prompt/schema snapshots.
- `predictions.jsonl`: flushed per-case validated decision or sanitized error, resolved model, response ID, input hash, usage and latency.
- `report.json`: the manifest plus completion time, stop reason, prediction-file hash, metrics, missing/errors/failures and gate outcome.

A hard kill or storage failure may leave only a manifest and partial prediction log; absence of a final report is not success. Do not blindly resume after uncertain requests. Generated reports are ignored by Git because future datasets could contain sensitive inputs. Explicitly archive a reviewed run when promoting a model. Hashes detect accidental mismatch/tampering; they are not cryptographic proof that a provider was called. A dirty Git flag explicitly means the recorded commit does not contain the whole running source.

Verify artifacts and recompute a completed or gracefully interrupted run:

```powershell
npm run eval -- evals/results/RUN_UUID
```

Verification checks artifact hashes, manifest consistency and metrics. It exits 1 for a failed, partial or mock live gate. Legacy external JSONL `{ "id": "rem-001", "actual": { ... } }` can still be scored with the same command; it is labeled imported, has unknown provenance/usage, and cannot pass the live gate even if its diagnostic quality check succeeds.

Metrics include schema-valid count, behavior matches, exact decision matches, instant-normalized matches, per-category results, all failed/missing IDs, known token totals and unknown-usage count. Equivalent ISO timestamps normalize to the same instant; titles, names, item text, delivery modes and call order remain exact. There is no fuzzy prose judge. A wrong argument cannot pass on behavior alone. Every selected case stays in the denominator, including errors and missing predictions.

The full live gate requires 60 cases, complete real-provider output, at least 90% instant-normalized decision matches, and 100% on both injection and unsupported-scope cases. Subset reports are diagnostic. Passing this gate does not establish production safety, independent benchmark validity, useful reminder delivery, or a latency/cost SLO. Executor authorization tests remain separate.
