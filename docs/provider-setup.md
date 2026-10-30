# Account setup before live qualification

Confirmed by the project owner: the initial language is **English**; country, hosting and domain are undecided; neither an OpenAI API project nor a Meta WhatsApp test number is ready. This checklist prepares those prerequisites. It does not authorize charges, send messages, approve platform eligibility or enable beta.

## Guided setup checkpoint — 2026-10-29 (Toronto)

Launch-readiness changes were committed and pushed as `a88a072`. The OpenAI Platform and Meta developer login pages are open for the owner to sign in. No project, API key, Meta app, test number or recipient has been created or verified in this setup session. The OpenAI Developers plugin was suggested but was not installed at the last check.

Think of the OpenAI project as a separate folder for Memorae's AI usage and permissions. An API key is a password that lets software use that project. The Meta app is the connection between Memorae and WhatsApp; its test sender is separate from the owner's phone that will eventually receive an approved test message.

The next account steps are:

1. Sign in to [OpenAI Platform](https://platform.openai.com/). Complete any account verification directly on the site. Use a dedicated project named **Memorae Development**; check for an existing project before creating a duplicate. If more than one organization is available, choose the organization that will own Memorae.
2. Review the project's billing and limits without buying credits or enabling automatic recharge. No evaluation spend or model has been selected yet. A project budget alert is not a substitute for Memorae's spending stop.
3. When ready, create a project-scoped application key through the [OpenAI Developers plugin](https://developers.openai.com/learn/developers-codex-plugin) or the platform's key setup. Review the actual permissions before creation and give it only what the evaluation adapter requires. Store the key privately; never paste it into chat or documentation. This session has not created or stored one.
4. Sign in to the [Meta developer dashboard](https://developers.facebook.com/apps/), completing developer registration if requested. Use **Memorae Development** as the proposed app name and select **Connect with customers through WhatsApp**. Choose the real business portfolio; do not invent business details to complete registration.
5. Open **Customize use case > Connect on WhatsApp > Quickstart**, then **Start using the API**. In **API Setup**, verify the Messaging account connection and inspect the available test sender. Record the displayed account/phone identifiers privately. If no test number is offered, resolve account eligibility before registering or moving a real phone number.
6. Stop before **Send message**. Adding a recipient requires the owner's intended WhatsApp number and any verification requested by Meta. Tokens, recipient verification, a public webhook and the first test message remain separate unfinished steps. Leave the app unpublished and the local synthetic phone configuration intact.

The Meta navigation above was checked against its current [Cloud API getting-started guide](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started), accessed through the browser during this session. Actual account availability and eligibility still need inspection after login. Passwords, verification codes, API keys and access tokens belong only in the relevant account screens or protected secret storage.

The local staging database was checked: spending is disabled and both global/default-user caps are zero. `beta:prepare --require-ready` returned exit code 1 with `launchEnabled: false`, as expected. No account setup step completes a launch review automatically.

## OpenAI preparation

1. Open the [official API quickstart](https://developers.openai.com/api/docs/quickstart) and prepare a dedicated project for Memorae testing in the API dashboard. Keep development/evaluation credentials separate from eventual production credentials.
2. Review the project's available billing/usage controls and choose the maximum authorized evaluation spend before any paid request. A call/token limit alone is not a dollar cap; do not treat an alert budget as a guaranteed spending stop.
3. Create an application API key when ready and keep it in protected server configuration. OpenAI documents API keys as secrets loaded from environment variables or a key-management service; never put them in browser code, Git or chat. See [API authentication](https://developers.openai.com/api/reference/overview#authentication).
4. Review the repository's [60-case expectation table](../evals/datasets/m1-v1-review.md) as a human. Record any disputed labels before running/tuning a model. English is confirmed; country-specific date assumptions still need review.
5. Choose the exact model and verify its supported request shape and current price. Then authorize a bounded evaluation. Follow [the evaluation runbook](../evals/README.md), including artifact verification and separate treatment of the holdout cases.

The existing runner reads `OPENAI_API_KEY`; the reserved `MODEL_API_KEY` entry in the application environment does not enable the worker. `npm run eval:run` without paid-provider flags remains an offline mock harness. No live accuracy result or provider budget is assumed.

## Meta WhatsApp preparation

Start with Meta's [Cloud API getting-started documentation](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started). The older documentation URL returned HTTP 429 through automated retrieval, but the browser successfully opened the current guide. It documents the WhatsApp use case, Messaging account connection, API Setup, test sender/recipient and webhook flow. Account eligibility, limits, pricing and the actual test-number provision remain **unverified** until the signed-in account is inspected.

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
