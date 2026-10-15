# Hosting providers

One interface for every host (#97–#102; `shared/hosting.ts`, `src/hosting/`, `0057_hosting_providers`).

The Repo dashboard was built around one stack (a Cloudflare Worker frontend, a Railway backend). It now reads any
host behind ONE provider interface. Four nouns (`shared/hosting.ts`, zod-free — the SPA imports its vocabularies):

- **Provider** — CODE: `src/hosting/providers/<id>.ts`, registered once in `src/hosting/registry.ts`. Today:
  `cloudflare`, `railway`, `vercel` (#98), `render` (#99), `netlify` (#100), `fly` (#101),
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
  said plainly — Render keys have none, Fly's is a READ-ONLY org token, Vercel has no read-only token, Railway's is a
  workspace token sent as Bearer, Cloudflare's needs Account Analytics Read + Workers Scripts Read), `assume_role`
  (AWS, later). The secret is an ordinary write-only `org_secrets` row (kinds `vercel` / `render` / `netlify` / `fly` /
  `aws`; Cloudflare and Railway keep `cloudflare_analytics` / `railway` — `HOSTING_INTEGRATION_KIND`); an install / OAuth
  grant also writes `org_hosting_connections` (method, provider-side installation id, account). EVERY provider is
  connected ONCE for the org (scope ""; the per-environment Railway project token is gone — a project token reads
  one environment only, so it cannot serve the org-wide connection). An install / OAuth
  method needs Trov-side Worker vars (its `requires`) — absent, it is listed `available: false` and the token method is
  offered. Pasting a token over an install supersedes it (`supersedeConnection`).
- **Part** — one deployable of one environment, with a ROLE: `web` (requests, 5xx errors, latency, bandwidth) or
  `service` (CPU, memory). EVERY part, whoever hosts it, is an `org_environment_parts` row — Cloudflare and Railway
  exactly like the rest (0057 moved the environment's old `worker` / `railway_*` columns into parts keyed `frontend` /
  `backend`, renamed their `cf_*` / `rw_*` history to `hx_*`, and dropped the columns). `src/hosting/parts.ts` is
  the read side and is reachable from src/mcp.ts (the projection), so it — like `types.ts`, `http.ts`, `registry.ts`
  and `providers/*` — must never import src/data/secrets.ts (`http.ts` carries this layer's own `scrub`).
- **Reading** — normalised: hourly `hx_<metric>` points in `repo_metrics` (env = environment key, part = part key,
  complete hours only, `pollWindow`: the last 3 hours closed ≥ 15 min — first write wins, so a running hour is never
  stored), deploys upserted into `hosting_deploys` (state moves building → ready), the last poll in
  `hosting_poll_state` (outcome, scrubbed detail, the metrics the provider could not read and why, and the contiguous
  COVERED interval: inside it, an hour with no point is a true zero).

**Every provider fetch goes through `hostFetch`** (`src/hosting/http.ts`): https only, the hostname exactly one of the
provider's `apiHosts` (refused BEFORE anything is sent), `redirect: "manual"` (a credential never crosses a redirect),
a timeout. A provider throws only `HostingError`, scrubbed at construction; `refuse` / `failureReason` scrub an
upstream body BEFORE cutting it. A metric a provider cannot read (Vercel and Netlify have no public usage API; Render's
HTTP metrics are web-services only) is reported in `unavailable` with a reason — never as a zero.

**Polling** (`src/hosting/poll.ts`): `pollPart` skips a `later` provider, a missing credential (no request
— "an org without it costs no requests") and a missing required setting; otherwise it runs the provider and VALIDATES
what came back before storing (role-matched metrics, complete past hours, finite non-negative values under a cap;
deploys with an id, a known state, sane times, https URLs) — dropped items counted in `detail`. It records the
credential outcome (`recordSecretOutcome`) and never throws. Runs at the repo cron's `:40` tick (below) and as Poll now's
`hosting` arm (after usage, before GitHub; budgeted so GitHub keeps its reservation — `hosting` is in the result only
when the org has stored parts). `hx_*` are pruned at 100 days, `hosting_deploys` at 180.

**The dashboard reads hosting data only** (`src/tools/repo.ts`, `repo-dashboard.md`). The `providers` section
(Usage tab; `RepoProviderPart` per part, any provider): deploys (`hosting_deploys`, the part's current provider's),
`traffic` per range for a web part (the Usage tab's own fill rule; the part's covered interval is evidence for a
zero for a metric its provider reads; `latency_p95_ms` is the latest point in range; `traffic: null` for a web part
whose provider reads no usage at all), `resources` for a service part (latest ≤ 3 h old, 24 h trend never
zero-filled), `seen`, `unavailable`, `status`, `tone`, `last_poll`, `console_url` (org config read directly — the
projection never touches the secrets module). The SAME reads feed the environment cards (each part's newest deploy),
the CI tab's deploy strips (each part's settled deploys) and the Usage compare (requests / error rate summed over
each environment's web parts) — nothing on the dashboard reads `cf_*`, `rw_*`, `cf_polled` or GitHub deployments any
more. Three extra statements; a failed read costs what it feeds (`providers` and `deploys` `not_connected`, no parts
on the cards, `degraded: true`). MCP `get_repo_dashboard` collapses `traffic` to the range and, without
`include_trends`, drops trends and keeps the newest 2 deploys per part (+ `deployCount`).

**Setup API** (`src/hosting/routes.ts`, cookie only — an `Authorization` header is a 403; admin unless noted), under
`/api/o/:slug` with NO old-path alias: `GET /hosting` (`HostingSetupDTO`: providers, environments with their parts,
connections — each with `manage_url`, where the grant is managed on the provider (`HostingProvider.manageUrl`) —, a
checklist generated from what the parts use, and `detected`, below), `GET /hosting/providers` (any member), `PUT|DELETE
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
`/<slug>/?hosting=<outcome>&provider=<id>#org/hosting` (`/?hosting=<outcome>` when the intent cannot be read), the outcome one of `HOSTING_CONNECT_OUTCOMES` (`shared/hosting.ts`) — never provider text.
It binds only for that browser's intent, that provider, the same person, still an admin (re-checked live), after the
code exchange through `hostFetch`; an installation ANOTHER org holds is `taken` (a platform read,
`connectionsForExternalId` in `src/platform/jobs.ts`, and 0057's partial unique index on the active
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

**Deployment and project events, and the Configuration URL** (Vercel). The same `POST /webhook/hosting/vercel`
that takes the uninstall notice takes `deployment.created` / `ready` / `succeeded` / `error` / `canceled` / `promoted` /
`rollback` and `project.removed` / `project.renamed` (`VERCEL_REFRESH_EVENTS`; `ready` is the "finished" event for an
integration with no checks of its own — Vercel sends `succeeded` only once one is registered; the provider's
`install.webhook.changedProject`). A verified one is a NUDGE, never a record: the active org(s) whose install /
OAuth connection is on that provider-side account (`connectionsForAccount`, a platform read) have their stored
parts on that project — matched by id or name against the part's FIRST setting — polled again now (`pollPart`, as
each org's system tenant, at most `HOSTING_WEBHOOK_MAX_REFRESH` = 6 parts a delivery, after the response through
`waitUntil`). Nothing from the delivery is stored: a removed project then reads as a failed poll with Vercel's own
404, a renamed one still answers to its id (a part that names it by its OLD name fails its next poll and says so).
An unknown event type is `200 { ok: true, revoked: 0 }` and ignored; an unverified delivery is the same bare 401
and polls nothing. `GET /hosting/<provider>/configure?configurationId=<installation>` is the provider's
"Configuration URL" (a public path like the callback — `HOSTING_CALLBACK_PATH`): for a signed-in admin of the org
that holds that installation it redirects to `/<slug>/#org/hosting` (`adminOrgForInstallation`, ONE platform
statement); nobody signed in, an unknown or malformed id, another org's installation, a member who is not an admin,
a suspended org and an unknown provider are ALL the same redirect to `/` — it never says whether an installation
exists, and never answers JSON or a 500. In Vercel's Integration console set Configuration URL to
`<origin>/hosting/vercel/configure`.

## Detection ("Detected: Vercel")

`HostingSetupDTO.detected` (`src/hosting/detect.ts`): the providers the org's repository ALREADY shows signs of,
read from what the GitHub capture stored — ONE tenant statement over `repo_events` (the last 90 days, grouped), no
call to GitHub or to a provider (invariant 7), and a failed read is simply no suggestion. Two kinds of sign, each
matched narrowly (a false "Detected" is worse than none):

- **check runs** — every check run is captured (`fromCheckRun`) with its name, its details URL and, in `raw.app`,
  the slug of the GitHub App that posted it: `vercel`, `netlify`, `cloudflare-workers-and-pages` (also a details
  link to the host, or a name only that host uses — `netlify/…`, `Workers Builds: …`, `Vercel …`);
- **deployments** — GitHub `deployment_status` deliveries are NOT captured any more (an environment's deploys come
  from its provider); rows captured before 0057, with the creator's login (`railway-app[bot]`, `render[bot]`,
  `vercel[bot]`) and log link, still count while inside the window.

So it is exactly as good as that capture: Vercel, Netlify and Cloudflare Workers Builds are seen as soon as GitHub
is connected and a check run arrives; Render, Railway and Fly.io report to GitHub through deployments (or not at
all), which are not captured — they are NOT detected. Closing that gap needs NEW capture, none of it built: (a)
capture `deployment_status` deliveries again, untagged (creator login + environment name, no env key — and a
retention for them); (b) keep commit `status` contexts other than `canopy/*` (`Vercel`,
`netlify/…`, `Render`); (c) a root-file probe in the reconcile (`vercel.json`, `netlify.toml`, `fly.toml`,
`render.yaml`, `wrangler.toml` — one contents read each, in the cron, never on a render path). The screen shows a
suggestion only for an `available` provider no part uses yet (`shownDetections`); it preselects the provider in
the part editor and connects nothing — the credential is still the admin's to give. A dismissal is per browser
(`localStorage` `trov.hosting.dismissed.<slug>`).

**Where detection stands** (`HostingSetupDTO.detection`, `readDetectionStatus`): so a new org sees what Trov is doing
instead of nothing. `no_repo` (no repository connected) → `no_environment` (a repository, but no environment names a
branch — the reconcile reads each environment branch head's check runs, so it needs one) → `looking` (a sync is
running, or no reconcile has run since: no `prs_reconciled` snapshot) → `none` (read, no host Trov knows) or `found`
(`detected` is not empty). Three reads of the org's own rows; a failed read is `looking`. The screen draws it in the
Detected slot when there is no suggestion (`detectionStatus`, web/src/hosting.ts), each with its next step — Connect a
repository, Add an environment, Sync GitHub now (the Sync panel, which an admin may open from any screen); while
`looking` the tab re-reads itself every 20 s (hosting-actions.ts `afterPaint`).

**The sample preview's two switchers** (web/src/hosting-keys.ts, `hostingScenario` in web/src/hosting-sample.ts):
a FLOW — New org, Looking, Found, Parts added, Connecting, Live, Broken, Locked — × a STACK — Vercel + Render,
Netlify + Fly.io, Cloudflare + Railway, All on Render, All on Railway, Vercel only, Five hosts. Every combination is
a whole `HostingSetupDTO` built from the real catalogue; detection follows what Trov can see (a stack of only Render
/ Railway / Fly.io finds nothing). `test/hosting.sample.test.ts` holds every combination to the providers' own checks.

## The screens

**Org settings › Hosting** (`#org/hosting`, admins only — `ADMIN_TABS`; `web/src/hosting.ts` pure views,
`web/src/hosting-actions.ts` the controller, every act `orgHx…` handed over by `org-actions.ts`). One read into
`state.org.hosting.setup`, drawn in Org settings' one idiom (`org-ui.ts`), top to bottom: the return notice
(`?hosting=<outcome>&provider=<id>`, read ONCE in `main.ts` `enterOrg`, which also opens the tab — a non-admin gets
a toast instead; one title + body per outcome in `hostingNoticeCopy`, tone ok / amber / red); the lost banner
(a connection ended on the PROVIDER's side — `lostOnProvider` compares `revoked_reason` with
`hostingRevokedReasonText("uninstalled" | "refused")`; an admin's own Disconnect reads "Not connected", never a
banner); the "credentials can't be saved" banner (`secrets_available: false` — connect / rotate / paste are
disabled with the reason; parts stay editable, since a part is not a credential); the LEAD, whose one accent action
is the checklist's next step; the checklist the server generated (steps to do listed, done ones folded); "Detected";
**Environments** — a tile per environment side by side (`.cnpy-hx-envs`), its parts as `openRow`s (the ORG's tile
— a part is the org's own app; the host is named in the metadata — label, role as plain text, a status mark; host · identifying setting as metadata; Edit as the one action; a failed last poll
and a test's answer always visible; key, settings, last poll, the provider's "not available" reasons, Open in
<provider>, Test this part and Remove behind the row); **Providers** — ONE grid of cards (`.cnpy-hx-cards`, two a row, one at
phone width, every card the same height) in registry order (Cloudflare, Railway, Vercel, Render, Netlify, Fly.io), then
**Later** — AWS. A card is
NOT a dropdown: it shows its logo (`web/src/host-logos.ts`, Simple Icons, CC0), name and status, the metadata (how it is
connected, how many parts use it), the provider's one-line summary (every summary reads "A <thing> on <host>. Trov
reads its …"), what Trov reads (`capabilityChips`), a last error or a test's answer — and ONE button at its top right,
one width on every card: **Connect** (the provider's own dialog: its install / OAuth confirmation, or the token form)
or **Manage** once connected. The plan note ("Vercel has no public usage API…") is in the Manage dialog and the part
editor. Nothing on a card says how a host connects (no "Recommended" / "Paste a…" hint): which method a host
offers is not a reason to pick it. **Manage** opens a dialog (`manageModal`, `h.manage`) with everything else: when and
by whom it was connected, what uses it, its settings, what it can do (`grants`), "Sent only to <api_hosts>", Test
connection, Manage on <provider>, Connect a different account, Rotate / Edit settings, Disconnect as quiet text (it
closes the dialog under the page's confirmation), and — for an install / OAuth connection — a quiet "Manual connection"
block with the paste-a-token form (the GitHub App's pattern). Saving a token returns to the Manage dialog, on Test
connection.

Three dialogs, each a root-level `data-overlay` (so a keystroke patches it — Org settings is `data-morph`), one at
a time, Escape closes, Tab stays inside, focus returns to the control that opened it:
- **the part editor** (`partEditorModal`) — host (`dropdown()`, with the provider's summary, capability chips and
  plan note under it; AWS is not an option), role (`segmented()` only where the provider serves both), key + label
  and a form generated from `part_settings` — a setting whose pattern is a short
  list of words (`^(?:production|preview)$`, `fieldOptions`) is a `segmented()`, anything else a text field checked
  against its pattern (`partDraftProblems`, the server's own rules; the server's refusal lands beside its field).
  Not connected yet → "Save and connect". Save is `PUT …/environments/:env/parts/:part`.
- **connect** (`connectModal`) — for the provider's best AVAILABLE method when that is an install / OAuth: what the
  provider will ask (`grants`), its `how_to`, "This replaces …" when something is connected, then
  `POST …/hosting/:provider/connect` and a full navigation to its `url`.
- **the token form** (`tokenModal`) — `set` / `rotate` / `config`: where to get it, WHAT IT CAN DO in the
  provider's own words, the org config fields, "Sent only to …". The password input has NO `value` in any state;
  the draft lives in a private variable of `hosting-actions.ts` (the rule of `integrations.ts`). It writes through
  the Integrations API (`PUT /integrations/<kind>[/<scope>]`, `…/rotate`, `…/config`); a `set` that meets
  `already_configured` falls back to the same rotate. Then focus goes to Test connection.
Disconnect and Remove go through the shared `confirmModal` (`OrgConfirm` `hosting` / `part`; `orgConfirmCopy`).
After Disconnect the toast says what is left to do upstream (`upstream`: `failed` / `none`).

**Skeleton, empty layouts and the state preview** (`web-ui.md` › Empty layouts). ONE set of shape builders per
screen is behind both its loading skeleton and its empty layouts, so the two cannot drift: the tab's
`envTilesShape` / `partRowsShape` (`hosting.ts`), the dashboard section's `hostingShapes` (`repo-hosting.ts`). The
tab's read being out is `skeleton("org-hosting", …)`; no environment is `emptyLayout("org-hosting-envs", …)` — one
sentence (`HOSTING_ENVS_EMPTY`), Open Environments, the tiles drawn empty; an environment with no part is a plain
layout inside its tile (`HOSTING_PARTS_EMPTY`; the tile's Add part is the action). On the dashboard,
`not_connected` and `empty` are `emptyLayout("repo-hosting", …)` (`HOSTING_NOT_CONNECTED`, with Open Org settings ›
Hosting for an admin; `HOSTING_EMPTY`), and with no repository at all the section is `emptyShapes` under the
dashboard's own sentence. `?preview=empty|loading` covers both: the tab's read lives one level down
(`state.org.hosting.setup`), so `previewState` (`web/src/preview.ts`) projects it by hand — loading: still out;
empty: answered for a new organization, with Trov's provider catalogue kept and no environment, connection or
suggestion. Its dialogs and return notice are not drawn under a preview, and no write is sent (api.ts refuses it).

"Preview with sample data" (the tab's footer) — still the way to see a FULL screen, and it keeps working under the
state preview — loads `web/src/hosting-sample.ts` by dynamic import — never in the
main bundle — and shows any of its five states (mid-setup, no parts, new org, removed, locked) with a switch; while
it is on NOTHING is sent (a save, a connect, a test and a disconnect each answer from the sample and say so). The
sample's provider catalogue is pinned to the registry by `test/hosting.sample.test.ts`.

**Repo dashboard › Usage › Hosting** (`web/src/repo-hosting.ts`, called from `repo.ts` `usageTab`): ONE section
from `providers` (the old `cloudflare` / `hosting` sections are gone from the payload and from MCP).
Environments side by side on the `.repo-cells` lattice, parts stacked: a tone dot, the label, the provider's glyph
and name, the role, Open in <provider>; the last deploy (state pill — in flight pulses —, short sha when there is
one, branch, the message's first line, who, when, "ready in 1m 42s", Open / Log) and a strip of the last ≤ 10 as
dots (newest right; green landed, red failed, hollow canceled); then traffic for a web part — requests, error rate
(amber ≥ 1 %, red ≥ 5 %), p95 latency, bandwidth and a requests sparkline with a red tick per bucket that had
errors, following the range switch (`repo-swap`) — or resources for a service (CPU, memory, a 24-hour line each
whose missing hours are GAPS, `gapPath`). **A figure the payload does not carry is "—" with one of three calm
reasons, never 0** (`absentHint`): "not available from <provider>: <its reason>" (`unavailable[]`), "no recent
reading" (`seen`), "not connected"; a web part whose provider reads no usage at all (`traffic: null`) is ONE line
with the reason instead of an empty grid. `not_connected` and `empty` are empty layouts (below; the footer keeps
"Preview with sample data"). Links out are https
only. Render tests: `test/render.hosting.test.ts`, `test/render.repo-hosting.test.ts`.

## The repo cron's `:40` tick

The `hosting` job (`src/repo/cron.ts`; the cron itself is described in `repo-dashboard.md` › The repo cron): one
unit per (org, environment, STORED part) from `listPartUnits` (`src/platform/jobs.ts`), each costing its provider's
`pollCost` (≤ 6), served by rotation like the other jobs; health keeps half the budget on this tick only when some
org has a stored part. Cloudflare and Railway are polled here like every other provider; the `:00` usage job reads
only the app-metrics endpoint. Background-job tenancy (the
unit runs as its org's system tenant) is in `data-layer.md`.

## Env

The hosting providers' install / OAuth methods (optional — absent, that method reads unavailable and the provider's
token method is offered; never logged): `VERCEL_INTEGRATION_CLIENT_ID` + `VERCEL_INTEGRATION_CLIENT_SECRET` (secrets;
the secret also verifies the uninstall webhook) + `VERCEL_INTEGRATION_SLUG` (the Integration's install URL is
`vercel.com/integrations/<slug>/new`; its Redirect URL `<origin>/hosting/vercel/callback`, Webhook URL
`<origin>/webhook/hosting/vercel`), and `NETLIFY_OAUTH_CLIENT_ID` + `NETLIFY_OAUTH_CLIENT_SECRET` (Redirect URI
`<origin>/hosting/netlify/callback`). Every provider CREDENTIAL is per org (Org settings), never a Worker secret.
