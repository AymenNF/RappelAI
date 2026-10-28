# API contract

## Implemented

| Method and route          | Authentication                        | Behavior                                                |
| ------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `GET /health/live`        | None                                  | 200 when API process can respond                        |
| `GET /health/ready`       | None                                  | 200 when transport tables are queryable; otherwise 503  |
| `GET /webhooks/whatsapp`  | Verify token in provider query        | Return challenge as plain text; 403 otherwise           |
| `POST /webhooks/whatsapp` | `X-Hub-Signature-256`, exact raw body | Persist message/status events + work in one transaction |

POST accepts `application/json` up to 1 MiB. Responses: 200 durable acceptance/no new events; 400 malformed or unsupported envelope/phone metadata; 401 signature failure; 413 too large; 415 unsupported content type; 503 storage unavailable. A 200 does not imply an action, model call or outbound send occurred. Malformed accepted-format batches fail together rather than partially disappearing.

Challenge example:

```text
GET /webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<configured-token>&hub.challenge=123
200 text/plain
123
```

## Proposed authenticated API

These routes do not exist yet; unknown routes currently return 404. Prefix user APIs with `/v1`, and add them only alongside authentication, ownership and rate-limit tests.

| Milestone | Routes                                                              | Contract                                                            |
| --------- | ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| M1/M3     | `/v1/auth/*`, `GET/PATCH /v1/me`                                    | Chosen session mechanism, consent, confirmed zone                   |
| M1/M2     | `GET/POST /v1/reminders`, `GET/PATCH/DELETE /v1/reminders/:id`      | User-scoped IDs; version checks for competing edits                 |
| M2        | `POST /v1/reminders/:id/complete`, `/snooze`; `GET .../occurrences` | Retry-safe mutations; reject stale schedule version                 |
| M1/M2     | `/v1/lists`, `/v1/lists/:id/items`                                  | Normalized items; per-list transaction for reorder                  |
| M3        | `GET /v1/me/usage`, `POST /v1/me/exports`, `DELETE /v1/me`          | Async export/deletion jobs with status, confirmation for deletion   |
| M4        | `/v1/memories`, `/v1/memories/search`, `/:id/history`               | Tenant-scoped retrieval, pagination, supersession                   |
| M5        | `/v1/calendar/connections`, `/connect`, `/callback`                 | OAuth state bound to signed-in user; asynchronous external mutation |
| M3        | `/ops/deliveries`, `/ops/costs`, `/ops/tasks`                       | Separate restricted operator authorization                          |

Mutations use an `Idempotency-Key` scoped to authenticated user + operation; store request hash and original response. Same key/different payload returns 409. Use `If-Match` or explicit version for destructive/competing edits. Paginate using opaque cursors. Return stable error codes and a request ID, never stack traces or provider secrets.

The current model contracts support only `create_reminder` and `add_list_item`. These are proposed internal action commands, not public REST routes. Executor checks go beyond schema: consent, tenant ownership, future instant, timezone interpretation, quotas, capability availability and any required confirmation.
