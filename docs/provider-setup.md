# Account setup before live qualification

Confirmed by the project owner: the initial language is **English**; country, hosting and domain are undecided; neither an OpenAI API project nor a Meta WhatsApp test number is ready. This checklist prepares those prerequisites. It does not authorize charges, send messages, approve platform eligibility or enable beta.

## OpenAI preparation

1. Open the [official API quickstart](https://developers.openai.com/api/docs/quickstart) and prepare a dedicated project for Memorae testing in the API dashboard. Keep development/evaluation credentials separate from eventual production credentials.
2. Review the project's available billing/usage controls and choose the maximum authorized evaluation spend before any paid request. A call/token limit alone is not a dollar cap; do not treat an alert budget as a guaranteed spending stop.
3. Create an application API key when ready and keep it in protected server configuration. OpenAI documents API keys as secrets loaded from environment variables or a key-management service; never put them in browser code, Git or chat. See [API authentication](https://developers.openai.com/api/reference/overview#authentication).
4. Review the repository's [60-case expectation table](../evals/datasets/m1-v1-review.md) as a human. Record any disputed labels before running/tuning a model. English is confirmed; country-specific date assumptions still need review.
5. Choose the exact model and verify its supported request shape and current price. Then authorize a bounded evaluation. Follow [the evaluation runbook](../evals/README.md), including artifact verification and separate treatment of the holdout cases.

The existing runner reads `OPENAI_API_KEY`; the reserved `MODEL_API_KEY` entry in the application environment does not enable the worker. `npm run eval:run` without paid-provider flags remains an offline mock harness. No live accuracy result or provider budget is assumed.

## Meta WhatsApp preparation

Start with Meta's [Cloud API getting-started documentation](https://developers.facebook.com/docs/whatsapp/cloud-api/get-started). Automated retrieval of that page returned HTTP 429 during this review, so current dashboard labels, eligibility, limits and pricing were **not** verified. Check the actual account documentation before configuration or any live integration commitment.

Prepare this information privately once the account setup is available:

- Whether the proposed assistant use case is eligible for that account and intended market, with a dated source/account review.
- The test business/phone identifiers and the explicitly approved test recipients.
- Secret storage for the app secret, verification token and access token; record only secret references in operational notes.
- The supported Graph API version, approved reminder template name/version/English locale and account-specific limits/rates.
- The webhook destination and signature/receipt verification plan after hosting is chosen.

Then plan an explicitly authorized test-number exercise covering inside/outside-window delivery, duplicate/out-of-order receipts, failed sends and uncertain outcomes. Preserve provider evidence; acceptance alone is not delivery. No invitation or test message has been sent by this preparation work.

## Hosting and launch decisions

Choose the first tester country before deciding residency/privacy obligations and the deployment region. Select a host/domain, private PostgreSQL/PITR arrangement, encrypted independent backup destination, key custody, private support path and incident owner. Use [LR-02 through LR-08](launch-readiness.md) to record evidence and acceptance criteria. Selecting a provider alone does not complete its launch gate.

All seven external reviews remain pending. The runtime still rejects production activation, the ordinary worker has no live sender, and model spending stays paused. A setup checklist or newly created account cannot change those settings.
