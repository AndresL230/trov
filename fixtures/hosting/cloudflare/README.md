Cloudflare API responses in their recorded shape, for test/hosting.provider.cloudflare.test.ts and as local design stubs (window: 2026-10-07 09:00–12:00 UTC).

- `deployments.json` — Workers Deployments API `GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/deployments` (documented; needs Workers Scripts Read). "The first deployment in the list is the latest deployment actively serving traffic."
- `analytics.json` — GraphQL Analytics API `POST https://api.cloudflare.com/client/v4/graphql`, `workersInvocationsAdaptive` summed per `datetimeHour` (the old usage poller's query). The `12:00` row is the inclusive `datetime_leq` end and is dropped; `11:00` has no row — a quiet hour, a true zero inside the covered window.
- `analytics-no-account.json` — the same query for an account the token cannot see: an empty `accounts` list (a failure, never "quiet").
- `analytics-error.json` — a GraphQL refusal beside a 200.
- `account.json` — `GET https://api.cloudflare.com/client/v4/accounts/{account_id}` (documented; Workers Scripts Read is among the permissions it accepts) — the probe without a part.
- `script-not-found.json` — the REST envelope of a 404 for an unknown Worker (code 10007).
- UNCONFIRMED: the exact spelling and nesting of a deployment's fields (`created_on`, `author_email`, `annotations["workers/message"]`) beyond the API reference; that every deployment on this route has served (no build or failed state — all mapped `ready`); the dashboard path `…/workers/services/view/<worker>/production/deployments` used as the inspect link.
