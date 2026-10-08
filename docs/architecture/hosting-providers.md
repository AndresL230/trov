# Hosting providers

One interface for every host (#97–#102; `shared/hosting.ts`, `src/hosting/`, `0048_hosting_providers`).

The Repo dashboard was built around one stack (a Cloudflare Worker frontend, a Railway backend). It now reads any
host behind ONE provider interface. Four nouns (`shared/hosting.ts`, zod-free — the SPA imports its vocabularies):

- **Provider** — CODE: `src/hosting/providers/<id>.ts`, registered once in `src/hosting/registry.ts`. Today:
  `cloudflare`, `railway` (the two LEGACY providers), `vercel` (#98), `render` (#99), `netlify` (#100), `fly` (#101),
  and `aws` (#102) described with `status: "later"` — listed, never choosable, never polled. A provider declares its
  roles, its exact `apiHosts`, its connection methods BEST FIRST, its org-wide config fields and per-part settings
  (anchored patterns, checked by `checkFields`), the metrics it can really read, `pollCost` (worst-case fetches of one
  poll), `consoleUrl`, `probe` and `poll`. **`src/hosting/types.ts` states THE RULES** and
  `test/hosting.contract.test.ts` holds every registered provider to them; each provider's own behaviour is
  `test/hosting.provider.<id>.test.ts` against recorded-shape fixtures in `fixtures/hosting/<id>/` (whose README lists
  what is UNCONFIRMED). What each vendor offers, and what is still to verify against a live account:
  `docs/superpowers/specs/2026-10-07-hosting-providers-research.md` (the vendor docs hosts were unreachable from the
  build — facts come from the vendors' own SDK / OpenAPI / CLI source).
- **Connection** — how an org is connected: `install` (Vercel's Integration: projects picked at install, uninstall
  webhook), `oauth` (Netlify — no scopes on Netlify's side), `token` (every provider; the narrowest scope it has,
  said plainly — Render keys have none, Fly's is a READ-ONLY org token, Vercel has no read-only token), `assume_role`
  (AWS, later). The secret is an ordinary write-only `org_secrets` row (kinds `vercel` / `render` / `netlify` / `fly` /
  `aws`; Cloudflare and Railway keep `cloudflare_analytics` / `railway` — `HOSTING_INTEGRATION_KIND`); an install / OAuth
  grant also writes `org_hosting_connections` (method, provider-side installation id, account). An install / OAuth
  method needs Trov-side Worker vars (its `requires`) — absent, it is listed `available: false` and the token method is
  offered. Pasting a token over an install supersedes it (`supersedeConnection`).
- **Part** — one deployable of one environment, with a ROLE: `web` (requests, 5xx errors, latency, bandwidth) or
  `service` (CPU, memory). Stored parts are `org_environment_parts` rows; the LEGACY parts are the environment's own
  columns — the Cloudflare frontend (`worker` / `worker_check`, key `frontend`) and the Railway backend (`railway_env` /
  ids, key `backend`) — read by `legacyParts` and WRITTEN through `putEnvironment` (`src/hosting/part-writes.ts`), so the
  webhook capture, the reconcile and the `:00` usage job read exactly what they read before. `src/hosting/parts.ts` is
  the read side and is reachable from src/mcp.ts (the projection), so it — like `types.ts`, `http.ts`, `registry.ts`
  and `providers/*` — must never import src/data/secrets.ts (`http.ts` carries this layer's own `scrub`).
- **Reading** — normalised: hourly `hx_<metric>` points in `repo_metrics` (env = environment key, part = part key,
  complete hours only, `pollWindow`: the last 3 hours closed ≥ 15 min — first write wins, so a running hour is never
  stored), deploys upserted into `hosting_deploys` (state moves building → ready), the last poll in
  `hosting_poll_state` (outcome, scrubbed detail, the metrics the provider could not read and why, and the contiguous
  COVERED interval — merged like `cf_polled`: inside it, an hour with no point is a true zero).

**Every provider fetch goes through `hostFetch`** (`src/hosting/http.ts`): https only, the hostname exactly one of the
provider's `apiHosts` (refused BEFORE anything is sent), `redirect: "manual"` (a credential never crosses a redirect),
a timeout. A provider throws only `HostingError`, scrubbed at construction; `refuse` / `failureReason` scrub an
upstream body BEFORE cutting it. A metric a provider cannot read (Vercel and Netlify have no public usage API; Render's
HTTP metrics are web-services only) is reported in `unavailable` with a reason — never as a zero.

**Polling** (`src/hosting/poll.ts`): `pollPart` skips a legacy part, a `later` provider, a missing credential (no request
— "an org without it costs no requests") and a missing required setting; otherwise it runs the provider and VALIDATES
what came back before storing (role-matched metrics, complete past hours, finite non-negative values under a cap;
deploys with an id, a known state, sane times, https URLs) — dropped items counted in `detail`. It records the
credential outcome (`recordSecretOutcome`) and never throws. Runs at the repo cron's `:40` tick (below) and as Poll now's
`hosting` arm (after usage, before GitHub; budgeted so GitHub keeps its reservation — `hosting` is in the result only
when the org has stored parts). `hx_*` are pruned at 100 days, `hosting_deploys` at 180.

**The dashboard's `providers` section** (Usage tab; `RepoProviderPart` per part — legacy and stored alike — so ONE
panel can replace the Cloudflare / Railway blocks): deploys (stored: `hosting_deploys`; legacy: the GitHub deploy
strips), `traffic` per range for a web part (the Usage tab's own fill rule; a stored part's covered interval is
evidence for a zero, Cloudflare's `cf_polled` for the legacy frontend; `latency_p95_ms` is the latest point in range;
`traffic: null` for a web part whose provider reads no usage at all), `resources` for a service part (latest ≤ 3 h old,
24 h trend never zero-filled), `seen`, `unavailable`, `status`, `tone`, `last_poll`, `console_url` (org config read
directly — the projection never touches the secrets module). Three extra statements; a failed read costs only this
section (`not_connected`, `degraded: true`). MCP `get_repo_dashboard` collapses `traffic` to the range and, without
`include_trends`, drops trends and keeps the newest 2 deploys per part (+ `deployCount`).

**Setup API** (`src/hosting/routes.ts`, cookie only — an `Authorization` header is a 403; admin unless noted), under
`/api/o/:slug` with NO old-path alias: `GET /hosting` (`HostingSetupDTO`: providers, environments with their parts,
connections — each with `manage_url`, where the grant is managed on the provider (`HostingProvider.manageUrl`) — and a
checklist generated from what the parts use), `GET /hosting/providers` (any member), `PUT|DELETE
/environments/:key/parts/:part` (audited `part.set` / `part.delete` in `org_admin_audit`; deleting an environment
deletes its stored parts, poll state and deploys in the same batch), `POST /hosting/:provider/connect` (→ `{ url }`;
an org already connected — a pasted token, or another install / OAuth grant — is not refused: the callback replaces
it), `POST /hosting/:provider/disconnect` (best-effort provider-side revoke; always succeeds
locally), `POST /hosting/:provider/test` (the integrations `testConnection`, optionally against one part). **An
installed connection has the GitHub App binding's guarantees** (`src/hosting/connections.ts`): the provider is handed
only a RANDOM `state`; what it answers for — `{ o, s, p, h, state, exp }`, HMAC-sealed with `hosting-connect:<COOKIE_SECRET>`
— is the HttpOnly `trov_hx` cookie (Secure, SameSite=Lax, Path `/hosting/`, 10 minutes, spent by the first callback
whatever the outcome). At the ROOT, `GET /hosting/:provider/callback` is a PUBLIC path (`HOSTING_CALLBACK_PATH` in
`src/auth/principal.ts`; `src/data/gate.ts` lets exactly that shape past the one-org alias) that reads the session
cookie itself and ALWAYS redirects — never JSON, never a 500: nobody signed in → `/`; otherwise
`/<slug>/?hosting=<outcome>&provider=<id>#org` (`/?hosting=<outcome>` when the intent cannot be read; `#org` until
the UI adds a Hosting tab), the outcome one of `HOSTING_CONNECT_OUTCOMES` (`shared/hosting.ts`) — never provider text.
It binds only for that browser's intent, that provider, the same person, still an admin (re-checked live), after the
code exchange through `hostFetch`; an installation ANOTHER org holds is `taken` (a platform read,
`connectionsForExternalId` in `src/platform/jobs.ts`, and 0048's partial unique index on the active
`(provider, external_id)` at the write — the row, the credential and the config are ONE batch, so a lost race stores
nothing). **A DIFFERENT live install / OAuth grant is REPLACED** — the GitHub App's rule since #110
(`github-app.md` step 6): `bindConnection(…, replaced)` overwrites the row in the same batch and audits the end
(`hosting.disconnect`, `reason: "superseded"`, `replaced_by`) only while that row is still the one read; then
`dropReplaced` removes the old grant on the provider's side with its OWN credential, read before the write — best
effort, as Disconnect does, never the new token or the new installation. A refused grant is handed back to
the provider (`install.revoke`, best effort — with `externalId: null` for `taken`, so another org's installation is
never removed). An installation id comes from the provider's own answer, never the callback URL (Vercel confirms a
callback `configurationId` with ONE `GET /v1/integrations/configuration/{id}` on the new token, else stores null).
Disconnected from either side: Disconnect here; before the session app, `POST /webhook/hosting/:provider` — the
provider-side uninstall notice, verified with the integration's client secret (a bare 401 that writes nothing
otherwise), ending the connection of the org holding that installation id; or Test connection getting a 401 for an
install / OAuth credential (`HostingError.status`, set by `refuse`). The last two end it as the org's SYSTEM tenant
(`endConnectionAsSystem`: secret deleted through `systemRevocationDeleteStmts`, row revoked by `system` — never a
provider id — audited `hosting.revoked`); a POLL's 401 only stores the fixed "<Provider> refused the token — the grant
may have been removed; Test connection to confirm" in `last_error`. `revoked_reason` is a CHECKed code (`disconnected`
/ `uninstalled` / `superseded` / `refused`); the DTO derives its sentence (`hostingRevokedReasonText`).
Org settings › Integrations lists a hosting kind only once a stored part uses it (the five original slots are unchanged).

**There is no UI yet**: the screens are designed from `docs/design/hosting-providers-claude-design-prompt.md` against
the data stubs `web/src/hosting-sample.ts` (every setup state; its provider catalogue is pinned to the registry by
`test/hosting.sample.test.ts`) and the `providers` section of `web/src/repo-sample.ts`. The SPA's typed client calls
are in `web/src/api.ts`.

## The repo cron's `:40` tick

The `hosting` job (`src/repo/cron.ts`; the cron itself is described in `repo-dashboard.md` › The repo cron): one
unit per (org, environment, STORED part) from `listPartUnits` (`src/platform/jobs.ts`), each costing its provider's
`pollCost` (≤ 6), served by rotation like the other jobs; health keeps half the budget on this tick only when some
org has a stored part. Legacy Cloudflare / Railway parts stay on the `:00` usage job. Background-job tenancy (the
unit runs as its org's system tenant) is in `data-layer.md`.

## Env

The hosting providers' install / OAuth methods (optional — absent, that method reads unavailable and the provider's
token method is offered; never logged): `VERCEL_INTEGRATION_CLIENT_ID` + `VERCEL_INTEGRATION_CLIENT_SECRET` (secrets;
the secret also verifies the uninstall webhook) + `VERCEL_INTEGRATION_SLUG` (the Integration's install URL is
`vercel.com/integrations/<slug>/new`; its Redirect URL `<origin>/hosting/vercel/callback`, Webhook URL
`<origin>/webhook/hosting/vercel`), and `NETLIFY_OAUTH_CLIENT_ID` + `NETLIFY_OAUTH_CLIENT_SECRET` (Redirect URI
`<origin>/hosting/netlify/callback`). Every provider CREDENTIAL is per org (Org settings), never a Worker secret.
