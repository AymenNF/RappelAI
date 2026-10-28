# AI evaluation

This is the evaluation foundation, not a connected model harness. The 12 cases cover only the first text-based slice; they are not the playbook's full 60–200 case suite. No model has been called or scored.

`npm run eval:validate` checks fixtures, IDs, zones, schemas, and future timestamps. It runs offline in CI. `npm run eval -- predictions.jsonl` scores externally supplied model predictions and fails if cases are missing, duplicated, unexpected, below 90% exact match, or any injection case fails.

Each prediction line has this form:

```json
{ "id": "amb-001", "actual": { "behavior": "clarify", "calls": [] } }
```

The current scorer compares the entire decision, including arguments and timestamp spelling. It does not evaluate prose quality, retrieval recall, recurrence expansion, latency, cost, or escalation. Equivalent UTC/offset timestamps currently differ; add instant-normalized datetime metrics alongside exact matching before broadening the suite. Never manufacture predictions from expected labels and report them as model performance.

Next: implement a provider adapter that receives input, fixed time, zone and context but never expected labels. Generate real predictions, capture model and prompt hashes, token usage, latency, and provider errors. Add 60 reviewed cases before the first feature milestone, then 200+ before broader beta. Keep a holdout set. Run a credentialed evaluation gate for prompt/model/schema changes on trusted branches; do not expose credentials to forked pull requests. Injection tests also need executor authorization tests: a prompt alone cannot enforce permissions.
