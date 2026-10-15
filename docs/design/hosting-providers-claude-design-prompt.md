# Claude Design prompt — Hosting providers (issues #97–#102)

> Paste everything below the line into Claude Design. It is self-contained: what Trov is, what to design, every
> flow and state, the exact data each screen receives, and the house rules the result must follow. The backend
> for all of it is built and tested (branch `claude/beautiful-pascal-sj0fk0`); the UI is what is missing.
> Sample payloads for every state: `web/src/hosting-sample.ts` (Org settings › Hosting) and the `providers`
> section of `web/src/repo-sample.ts` (Repo dashboard › Usage). Field-by-field contract: `shared/hosting.ts`.

---

## What you are designing

**Trov** is a team's working memory: one web app (My Work, Feed, Docs, Roadmap, Tickets, a Repo dashboard, Org
settings…). Its **Repo dashboard** shows, per environment (e.g. *Staging* deploying from `main`, *Production*
from `production`), what is deployed, whether it is healthy, and how much it is used. Until now that dashboard only
understood one stack: a **Cloudflare Worker** frontend (requests + error rate) and a **Railway** backend (CPU +
memory). Any other host showed "Not connected".

Trov now supports **hosting providers** behind one interface: **Cloudflare Workers, Railway, Vercel, Render,
Netlify, Fly.io**, and **AWS** (listed as *coming later*). You are designing two things:

1. **Org settings › Hosting** — a new admin tab where an organization says *which host runs each part of each
   environment* and *connects Trov to those hosts*.
2. **Repo dashboard › Usage › Hosting** — one provider-neutral panel that shows every part's deploys, traffic and
   resources, whoever hosts it — replacing today's two hard-coded blocks ("Cloudflare — frontend Workers" and
   "Hosting — Railway backend").

Plus small touches elsewhere (listed at the end).

### The model, in four nouns (use these words in the UI)

- **Provider** — a host Trov can read: its name, what it can show (deploys, requests, errors, latency,
  bandwidth, CPU, memory), the hosts its credential is sent to, and the ways to connect it.
- **Connection** — how the organization is connected to a provider: **installed** (one-click integration),
  **OAuth** (sign in with the provider), or a **pasted token**. One per provider per org (Railway is the
  exception: one token *per environment*).
- **Part** — one deployable of one environment (*Web*, *API*, *Worker*…), pointing at a provider and that
  provider's settings (a Vercel project, a Render service id, a Netlify site id, a Fly app name). A part has a
  **role**: **web** (serves HTTP to people → requests, errors, latency, bandwidth) or **service** (a long-running
  process → CPU, memory).
- **Reading** — what a poll brought back: deploys and hourly figures. Polls run every hour; an admin can also
  press **Poll now** on the Repo dashboard.

### What each provider really offers (design for the differences, don't hide them)

| Provider | Best way to connect | Roles | Deploys | Usage Trov can read |
| --- | --- | --- | --- | --- |
| Cloudflare Workers | Paste an API token (+ Account ID) | web | yes (Workers Builds check) | requests, errors |
| Railway | Paste a project token **per environment** | service | yes (GitHub deployments) | CPU, memory |
| Vercel | **Connect with Vercel** (install, pick projects) — or paste a token | web | yes, with commit, branch, URL | **none** — Vercel has no public usage API |
| Render | Paste an API key (no scopes exist) | web, service | yes, with commit | requests, errors, p95 latency, bandwidth, CPU, memory |
| Netlify | **Connect with Netlify** (OAuth) — or paste a token | web | yes, with commit, branch, URL | **none** — dashboard-only |
| Fly.io | Paste a **read-only** org token | web, service | releases (no commit) | requests, errors, p95 latency, bandwidth, CPU, memory |
| AWS | *Coming later* — a read-only IAM role Trov assumes | web, service | — | (CloudWatch, later) |

So the UI must gracefully show **"not available from this provider"** (with the provider's reason) as a calm,
informative state — never as an error, never as a zero.

---

## Flow 1 — Org settings › Hosting (new tab, admins only)

Org settings is one screen with an underline tab bar: *Integrations · Repositories · Environments · Members ·
Notifications · General*. Add **Hosting** after *Environments* (route `#org/hosting`). Non-admins don't see it.
Above the tabs an admin of a new org already gets a small "Finish setting up <org>" checklist (4 steps, gone when
done) — Hosting has its **own** checklist inside the tab (below).

The tab loads ONE payload, `GET /api/o/:slug/hosting` → `HostingSetupDTO`:
`{ providers, environments, connections, checklist, secrets_available }`.

**Build it the way Org settings is already built — and the way "Connect with GitHub" already works.** Org settings
has ONE hierarchy (`web/src/org-ui.ts`, its header comment): the page title; the tab bar; a tab's **lead** — one 13px
sentence saying what is here and what needs attention, with the tab's ONE accent action at its right (`tabLead`);
**sections** with an uppercase eyebrow, a count and a quiet aside (`orgHead`) — the only heading level in a tab;
**rows inside one surface per section**: name 13.5px / 600 and a status chip first, quiet 12px metadata after, ONE
quiet action, and everything else (what it is, how to get it, less-used and destructive actions) BEHIND the row
(`openRow`) or in its dialog. Destructive actions are text (`dangerLink`), last in their cluster, never beside the
primary. The GitHub App (Org settings › Repositories and Integrations, `web/src/github-app.ts`) is the precedent for
everything in 1c — a provider connection must look and behave like it: the same return notice, the same connection
row, the same "Manual connection" fold, the same lost banner. Study it before designing these.

### 1a. The layout

Design a page with three regions (desktop ≥ 1000px; on a phone everything stacks in this order):

1. **Setup checklist** (only while any item is not done) — from `checklist[]`. Each item has a `title`, an
   optional `detail`, `done`, and an `action` whose `kind` decides its button: `add_environment` ("Add an
   environment" → Environments tab), `add_part` ("Add a part" → opens the part editor for `env`), `connect`
   ("Connect Vercel" → the connect flow for `provider`), `configure` ("Set the team id"), `edit_part`, `test`
   ("Test connection"), `none`. Show progress ("3 of 5 done"). Collapsible once mostly done.

2. **Environments and their parts** — the heart of the page. Environments arrive in *drift order* (the first is
   the one deploying from `main`, the last is production). For each environment (`label`, `branch`), its
   `parts[]` (`EnvironmentPartDTO`), each showing:
   - the part's **label** and **key** (`Web` · `web`), its **role** (web / service — a small quiet badge),
   - the **provider** (name + a simple monochrome glyph; no brand colors), and the part's identifying setting
     (the project / service / site / app — the value of the provider's FIRST `part_settings` field),
   - **connection status** for that provider (`connection`: connected / not_connected / error / revoked — a dot +
     word, color meaning only: green / grey / red / amber),
   - **last poll** (`last_poll`: "Polled 12 min ago", or "✗ Last poll failed 2 h ago — <detail>", or nothing yet),
     and `last_poll.unavailable` as a quiet line ("Usage not available from Vercel"),
   - an **Open in <provider>** link when `console_url` is not null,
   - actions: **Edit**, **Remove** (confirmation modal), and on the environment: **Add part** (disabled at 6).
   - **Legacy parts** (`legacy: true`): an environment's Cloudflare frontend (key `frontend`) and Railway backend
     (key `backend`) live in the environment's own fields. They render exactly like any other part (that's the
     point) — but their key is fixed and a small note says "Also editable under Environments".
   - Empty environment: "No parts yet — add the web app, API or worker this environment runs."
   - No environments at all: an empty state pointing to the Environments tab.

   Pick the shape that reads best: a column per environment (compare staging vs production side by side, like the
   Repo dashboard does) or a row per environment with parts as cards. It must work for 1–10 environments and
   0–6 parts each.

3. **Connections** — a section ("Connections", with a count) holding ONE ROW per `connections[]` entry
   (`HostingConnectionDTO`), modelled on the GitHub App's row (`githubAppRow`, `web/src/github-app.ts`):
   - **head**: "<Provider> · <account.label>" (e.g. "Vercel · Acme"; Railway's per-environment tokens read
     "Railway · Staging" from `scope_label`) and a status chip — Connected (green) / Error (red, when `last_error`)
     / Not connected (grey) / Removed (amber, `revoked`);
   - **meta** (quiet, 12px): how it is connected — "Installed", "Connected with OAuth", or "Token ••••a1b2" from
     `hint_last4` — · "used by N parts" (`used_by`) · "connected by @handle";
   - **its one always-visible action**: a quiet **Test connection** button; the result appears INLINE under the row
     as a green "Connection works. <detail>" or red "Test failed. <detail>" box (`role="status"`), and a stored
     `last_error` shows as a red "Last error. <text>" box — both always visible, not behind the row;
   - **behind the row** (it opens): one paragraph of what the connection is and what Trov reads with it, "Connected
     by X <relative> · last used <relative>" (`connected_at`, `last_used_at`), the parts that use it, and the
     actions: **Manage on <Provider>** (a ghost external link, new tab, from `manage_url` — the provider's own page
     for the installation / grant / token), **Rotate** (tokens only), and **Disconnect** as quiet red text that
     opens the shared confirmation modal;
   - `legacy_fallback`: a quiet line "Using the platform's old secret — save your own to take over".
   - **Not connected yet**: the row offers the provider's best available method as its action (an accent
     "Connect with Vercel" only when it is the tab's one primary action, else quiet), with the head chip "Not
     connected" and the meta "Recommended: no token to paste" for install / OAuth methods.
   - **Manual connection**: once a provider is connected by install / OAuth, its paste-a-token form is NOT offered
     beside it; it folds into a quiet "Manual connection" row under it ("Not needed while Vercel is connected"),
     exactly like GitHub's token and webhook rows fold under the App (`web/src/integrations.ts`, `githubGroup`).
   - **Lost banner**: when a connection was removed on the PROVIDER's side (`status: "revoked"` with a
     provider-side reason — uninstalled, or the provider refused the grant) and nothing replaced it, an amber banner
     at the top of the tab says so and what still works ("The Vercel integration was removed on Vercel 2 h ago.
     Deploys for Staging › Web app stop updating. Connect again to resume.") — modelled on `lostBanner`. Never after
     a Disconnect the admin asked for.

### 1b. Add / edit a part (the part editor)

A modal (bottom sheet on a phone) or an inline panel under the environment — your call; it must keep the page's
place. Steps, all on one surface:

1. **Pick a provider** — a grid of `providers[]` (`HostingProviderDTO`): label, `summary`, what it can show
   (`capabilities.deploys` + `capabilities.metrics` as small chips: Deploys · Requests · Errors · Latency ·
   Bandwidth · CPU · Memory — metrics the provider can't read are simply absent), `plan_note` if any, and
   `roles`. `status: "later"` (AWS) is visible but disabled with "Coming later". A provider already connected
   gets a subtle "Connected" tick.
2. **Role** — a two-option segmented switch *Web / Service* shown only when the provider supports both
   (`roles.length === 2`); otherwise implied and stated.
3. **Key and label** — key: 1–32 of `a–z 0–9 _ -` (validated live with `PART_KEY_RE`), label free text ≤ 60.
   Legacy providers: key and label fixed (`legacy_part_key`; "Frontend" / "Backend"), shown read-only.
4. **Provider settings** — a form generated from `part_settings[]` (`HostingFieldDTO`: `label`, `description`,
   `required`, `placeholder`, `pattern` — a regex source, validate on blur and before submit). Examples: Vercel
   *Project* (id or name), *Deploys to show* (production / preview), *Branch*; Render *Service ID*
   (`srv-…`); Netlify *Site ID*, *Context*, *Branch*, *Site name (for links)*; Fly *App*.
5. **Connection hint** — if this provider is not connected yet, say so right in the editor with a **Connect**
   button (flow 1c) — saving the part is allowed before connecting; the checklist will remind.

Save → `PUT /api/o/:slug/environments/:env/parts/:part` with `{ provider, role?, label?, settings }`. Errors come
back as `{ error, field?, message }` — show `message` beside `field` (`settings.project_id`, `key`, …). Remove →
`DELETE …/parts/:part` behind the shared confirmation modal ("Remove Staging › Web? Its deploy history and poll
state go with it; past figures stay until they age out.").

### 1c. Connect a provider (three methods, one flow)

Each provider lists `connection_methods[]` **best first** (`ConnectionMethodDTO`: `method`, `label`,
`available`, `unavailable_reason`, `how_to`, `grants[]`). Offer the **first available** method as the primary
action and the rest as "Other ways to connect". When the best method is unavailable on this Trov deployment
(`unavailable_reason`: "this Trov deployment has no Vercel integration configured"), say so quietly and fall
back.

- **Install / OAuth** ("Connect with Vercel", "Connect with Netlify"): before leaving Trov, show a short
  confirmation — what the provider's screen will ask (`grants[]`, e.g. "Projects: read, Deployments: read on the
  projects you pick"), and `how_to` (e.g. Netlify: "Netlify OAuth has no scopes: approve with an account that
  belongs only to the team you want Trov to see"). Then `POST /api/o/:slug/hosting/:provider/connect` →
  `{ url, method, expires_at }` and the browser navigates to `url` (a full navigation — it leaves Trov). An org
  that is ALREADY connected is not refused: like the GitHub App since #110, connecting again REPLACES the current
  connection (no Disconnect first — the old grant is ended and removed on the provider's side). So a connected
  row keeps a quiet "Connect a different account" action; its confirmation says the current account (`account`)
  will be replaced.
  **The return** mirrors GitHub's exactly (`connectNotice` / `connectNoticeCopy` in `web/src/github-app.ts`): the
  provider sends the admin back to `/<org-slug>/?hosting=<outcome>&provider=<id>#org…`; the SPA reads
  `?hosting=` ONCE on entering the org, shows a dismissible NOTICE at the top of the Hosting tab (tone ok / amber /
  red with its icon, `role="alert"` for red and `"status"` otherwise, a Dismiss ×), then strips the query from the
  address bar. One title + one body per outcome (the vocabulary is `HOSTING_CONNECT_OUTCOMES` in
  `shared/hosting.ts`): `connected` (ok — "Vercel is connected." + what Trov now reads), `expired` (amber — "That
  took too long, or was not started here." start again), `wrong_person` (red — the person signed in when the
  provider returned is not the one who started), `not_admin` (red — only an admin or owner can connect a host),
  `denied` (amber — "You cancelled on Vercel — nothing was connected"), `taken` (red — that installation is
  already connected to another Trov organization; disconnect it there first), `not_configured` (amber — this Trov can't
  connect Vercel yet; paste a token instead), `exchange_failed` (red — Vercel refused the connection; try again or
  paste a token), `secrets_unavailable` (red — credentials can't be saved right now), `unknown_provider` /
  `failed` (red — something went wrong; try again). Nothing about the provider's own error text ever reaches the
  URL or the notice.
- **Paste a token** (every provider has one except AWS): a modal form — the provider's `how_to` (where to create
  the token and the **narrowest permission** that works, stated plainly, e.g. "Render API keys have no scopes…"),
  the secret field (masked, paste-friendly, never shown again — "Trov never shows it again; to change it, rotate
  it"), the provider's `org_config_fields` (Cloudflare *Account ID*, Vercel *Team ID*, Fly *Organization*), and
  under the form: **"Sent only to api.vercel.com"** from `api_hosts`. Submit → the existing Integrations API
  (`PUT /api/o/:slug/integrations/<kind>` with `{ secret, config }`; Railway's is per environment). Then offer
  **Test connection** right away.
- **Grant a role** (AWS, later): show the card disabled with what it will need.

**Test connection** → `POST /api/o/:slug/hosting/:provider/test` (optionally for one part) → `{ ok, detail,
connection }`: inline result under the card — a green "✓ Vercel answered for project web (team Acme)." or the red
`detail` — it is already safe to show (credentials are scrubbed server-side).

**Disconnect** → the shared confirmation modal (as GitHub's Disconnect uses), naming what stops ("Deploys and
usage of Staging › Web and Production › Web stop updating") and what happens upstream, then `POST …/hosting/:provider/disconnect` → `{ connection, upstream }`: the card shows *not
connected*. `upstream` says whether the provider-side installation was removed too: `revoked` (say nothing extra),
`failed` ("Trov forgot the credential, but Vercel did not confirm removing the integration — remove it under
Vercel › Integrations"), `none` (a pasted token: "Also delete the token on Netlify if you no longer need it").
A connection the provider removed from ITS side arrives as *revoked* with `revoked_reason` ("removed on Vercel").

### 1d. States to draw for Org settings › Hosting
Fresh org (no environments) · environments but no parts · parts on unconnected providers · everything connected and
polling · a connection in **error** (401 last_error) · a **revoked** install · a part whose last poll failed · a
part with metrics unavailable (Vercel, Netlify) · secrets unavailable (`secrets_available: false`: every save is
disabled with "Credentials can't be saved right now — the platform key is missing") · the return notice for every
outcome (ok / amber / red) · the lost banner · a connected install with its "Manual connection" fold · loading
(skeleton) · load failed (retry) · phone width · dark and light.

---

## Flow 2 — Repo dashboard › Usage › **Hosting** (provider-neutral)

The Repo dashboard has tabs *Overview · Code · CI & Deploys · Usage · Team & Planning* and a range switch
**24h / 7d / 30d** on the Usage tab. Today the Usage tab is: *App usage* (per-environment compare cards) →
*Product* → two infrastructure blocks. Replace the two infrastructure blocks with ONE **Hosting** section built
from `dashboard.providers` (`RepoSection<RepoProviderPart[]>`):

- `status: "not_connected"` → a quiet one-liner: "No hosting provider is connected — add your environments' parts
  in Org settings › Hosting." (+ a link for admins).
- `status: "empty"` → "Parts are set up, but no provider has reported yet."
- `status: "ok"` → `data[]`, one entry per part, grouped by environment (`env`, `env_label`) — environments side
  by side like *App usage* (comparing environments is the point), parts stacked inside.

Each part card (`RepoProviderPart`):
- header: `label` · provider name + glyph · role badge · an **Open in <provider>** link (`console_url`), and a
  tone dot (`tone`: good / warn / bad / neutral — color carries meaning only).
- **Last deploy** line from `deploys[0]` (`ProviderDeployDTO`): a state pill (`state`: queued / building — with a
  subtle live animation, off under reduced motion — / ready / error / canceled), short `sha` (7 chars, mono) —
  absent for Fly releases, so the line must read well without it —, `branch`, the commit `message`'s first line,
  `by`, relative time (`at`; "ready in 1m 42s" from `ready_at − at`), links to the deploy (`url`) and its log
  (`inspect_url`). Then a strip of the last ≤10 deploys as dots (newest right), each with a tooltip — the same
  dot language as *CI & Deploys* (ok green, fail red, canceled hollow/grey, in-flight pulsing).
- **Traffic** (role `web`, `traffic[range]` — `ProviderTrafficRange`; `traffic` is `null` for a web part whose
  provider reads no usage at all — Vercel, Netlify — and `unavailable[]` then carries the reason, so the card shows
  deploys plus one calm "Usage isn't available from Vercel — <reason>" line instead of an empty grid): Requests (compact: 12.4K), Error rate
  (`error_rate` %, two decimals; amber ≥ 1 %, red ≥ 5 %), p95 latency (ms), Bandwidth (bytes → KB/MB/GB), and a
  sparkline from `trend[]` (requests, with errors as a second, red series or as red ticks). **`null` is never 0**:
  a null figure renders "—" with a hint — use `seen.traffic` to choose the words: seen → "no recent reading";
  never seen → "not connected". If the metric is in `unavailable[]`, render the provider's `reason` instead,
  calmly ("Vercel exposes no public usage API").
- **Resources** (role `service`, `resources` — `ProviderResources`): CPU (vCPU, 2 decimals), Memory (MB / GB), a
  24 h sparkline each (`trend[]`, gaps are gaps — never zero-filled). `null` → "—" + "no recent reading" (the
  latest reading is over 3 hours old).
- **Last poll problem**: `last_poll.status === "failed"` → a small amber note with `last_poll.detail` and when.
- Range switch changes only the traffic figures/trends (resources are "right now").

The section's figures count up and the range switch cross-fades like the rest of the Usage tab (reduced motion:
no animation).

Also design how **Poll now** reports hosting: the existing dismissible strip at the top of the Repo dashboard
gets lines per provider from `result.hosting` (`HostingPollOutcome[]`: `env`, `part`, `provider`, `status` ok /
failed / skipped, `written`, `detail`), e.g. "Vercel — 2 parts ok · Render — staging api ✗ 401 the credential
is not valid · Netlify — skipped: not connected".

### States to draw for the Hosting section
Not connected · empty · SaplingLearn's real setup (legacy Cloudflare frontend with traffic + Railway backend with
CPU/memory, two environments) · a mixed org (Vercel web with deploys but usage unavailable, Render API with
traffic and resources, Fly worker with releases without commits, Netlify docs site) · a deploy building · a
failed deploy · a failed last poll · a stale resource reading · all three ranges · phone width · dark and light ·
sample-data mode (the dashboard's "Preview with sample data" toggle uses `web/src/repo-sample.ts`).

---

## Smaller touches

- **Org settings › Integrations**: hosting providers now appear there too (kinds `vercel`, `render`, `netlify`,
  `fly`, `aws`) but only once a part uses them — grouped like the GitHub group there (`githubGroup`): a provider
  connected by install / OAuth is ONE row ("Connected with Vercel — manage in Hosting") with its token row folded
  under "Manual connection", never a second paste form beside it. Keep the two tabs consistent.
- **Org settings › Environments**: the existing advanced fields "Cloudflare Worker / Workers Builds check /
  Railway environment ID…" stay (legacy parts), with a pointer "Parts on other hosts: Hosting tab".
- **Overview environment cards** (stretch, optional): today each card shows two halves "Backend · Railway" and
  "Frontend · Cloudflare". A future version can list the environment's parts from `providers` instead — sketch it
  if it falls out naturally, but it is not required.

---

## The data, field by field (the contract — `shared/hosting.ts`)

```ts
type HostingProviderId = "cloudflare" | "railway" | "vercel" | "render" | "netlify" | "fly" | "aws";
type PartRole = "web" | "service";
type ConnectionMethod = "install" | "oauth" | "token" | "assume_role";
type HostingMetric = "requests" | "errors" | "latency_p50_ms" | "latency_p95_ms" | "bandwidth_bytes" | "cpu" | "mem_mb";
type DeployState = "queued" | "building" | "ready" | "error" | "canceled";
type ConnectionStatus = "connected" | "not_connected" | "error" | "revoked";

interface HostingSetupDTO { providers: HostingProviderDTO[]; environments: HostingEnvironmentDTO[];
  connections: HostingConnectionDTO[]; checklist: HostingChecklistItem[]; secrets_available: boolean }

interface HostingProviderDTO {
  id; label; status: "available" | "later"; summary; roles: PartRole[];
  capabilities: { deploys: boolean; metrics: HostingMetric[] }; plan_note: string | null;
  api_hosts: string[];                 // "Sent only to …"
  credential_scope: "org" | "environment";
  connection_methods: ConnectionMethodDTO[];   // best first
  org_config_fields: HostingFieldDTO[]; part_settings: HostingFieldDTO[];
  docs_url: string; legacy_part_key: string | null }

interface ConnectionMethodDTO { method; label; available: boolean; unavailable_reason: string | null; how_to: string; grants: string[] }
interface HostingFieldDTO { key; label; description; required: boolean; placeholder: string | null; pattern: string | null }

interface HostingEnvironmentDTO { key; label; branch; parts: EnvironmentPartDTO[] }
interface EnvironmentPartDTO {
  env; key; label; role: PartRole; provider: HostingProviderId; settings: Record<string, string>; position;
  legacy: boolean; connection: ConnectionStatus; console_url: string | null;
  last_poll: PartPollStateDTO | null; updated_at: string | null; updated_by: string | null }
interface PartPollStateDTO { at; status: "ok" | "failed" | "skipped"; detail: string | null; last_ok_at: string | null;
  covered: { from; to } | null; unavailable: { metric: HostingMetric; reason: string }[] }

interface HostingConnectionDTO {
  provider; scope; scope_label: string | null; status: ConnectionStatus; method: ConnectionMethod | null;
  account: { id: string | null; label: string | null } | null; external_id: string | null;
  config: Record<string, string>; hint_last4: string; connected_by: string | null; connected_at: string | null;
  last_used_at: string | null; last_error: string | null; legacy_fallback: boolean; revoked_reason: string | null;
  used_by: { env: string; part: string }[] }

interface HostingChecklistItem { id; title; detail: string | null; done: boolean;
  action: { kind: "add_environment" } | { kind: "add_part"; env } | { kind: "connect"; provider; scope }
        | { kind: "configure"; provider; scope } | { kind: "edit_part"; env; part } | { kind: "test"; provider; scope } | { kind: "none" } }

// Repo dashboard › Usage
interface RepoProviderPart {
  env; env_label; part; label; role: PartRole; provider: HostingProviderId; provider_label; console_url: string | null;
  deploys: ProviderDeployDTO[];                                  // newest first, ≤ 10
  traffic: Record<"24h" | "7d" | "30d", ProviderTrafficRange> | null;   // web parts; null when the provider reads no usage
  resources: ProviderResources | null;                          // service parts
  seen: { traffic: boolean; resources: boolean; deploys: boolean };
  unavailable: { metric: HostingMetric; reason: string }[];
  status: "ok" | "empty" | "not_connected"; tone: "neutral" | "good" | "warn" | "bad";
  last_poll: { at; status: "ok" | "failed" | "skipped"; detail: string | null } | null }
interface ProviderDeployDTO { id; state: DeployState; target: "production" | "preview" | null; sha: string | null;
  branch: string | null; message: string | null; by: string | null; at; ready_at: string | null; url: string | null; inspect_url: string | null }
interface ProviderTrafficRange { requests: number | null; errors: number | null; error_rate: number | null;
  latency_p95_ms: number | null; bandwidth_bytes: number | null; trend: { at; requests: number; errors: number }[] }
interface ProviderResources { cpu: number | null; mem_mb: number | null; at: string | null;
  trend: { at; cpu: number | null; mem_mb: number | null }[] }
interface HostingPollOutcome { env; part; provider: HostingProviderId; status: "ok" | "failed" | "skipped"; written: number; detail?: string }
```

### Routes the UI calls (all session-cookie; admin unless noted)

| Route | Body → Response |
| --- | --- |
| `GET /api/o/:slug/hosting` | → `HostingSetupDTO` |
| `GET /api/o/:slug/hosting/providers` (any member) | → `{ providers: HostingProviderDTO[] }` |
| `PUT /api/o/:slug/environments/:env/parts/:part` | `{ provider, role?, label?, settings }` → `{ part, created }` (201 new) |
| `DELETE /api/o/:slug/environments/:env/parts/:part` | → `{ ok, removed: { env, part, provider, legacy } }` |
| `POST /api/o/:slug/hosting/:provider/connect` | → `{ url, method, expires_at }` — then navigate to `url`; an org already connected is replaced at the callback (no 409) |
| `GET /hosting/:provider/callback` (the provider redirects here) | → 302 to `/<slug>/?hosting=<outcome>&provider=<id>#org` (`HOSTING_CONNECT_OUTCOMES`); `/?hosting=<outcome>` when the intent can't be read; `/` when signed out |
| `POST /api/o/:slug/hosting/:provider/test` | `{ scope?, env?, part? }` → `{ ok, detail, connection }` |
| `POST /api/o/:slug/hosting/:provider/disconnect` | `{ scope? }` → `{ connection, upstream: "revoked" \| "failed" \| "none" }` |
| `PUT /api/o/:slug/integrations/:kind[/:scope]` | `{ secret, config? }` — paste a token (existing API) |
| `POST /api/o/:slug/integrations/:kind[/:scope]/rotate` | `{ secret }` — rotate (existing API) |
| `GET /repo/dashboard` (any member) | → `RepoDashboard` incl. `providers` |
| `POST /admin/poll` | → `RepoRefreshResult` incl. optional `hosting` |

Errors are `{ error, field?, message? }`; `message` is safe to show, `field` names the input it is about
(`provider`, `key`, `label`, `settings.<key>`). Codes: `invalid` (400), `not_found` (404), `too_many_parts` and
`part_conflict` (409 — e.g. a part keyed `frontend` while the environment has a Cloudflare frontend), and for
Connect `not_available` / `not_installable` / `not_configured` (409). A 403 means "admins only"; a 503
`secrets_unavailable` means credentials can't be saved right now. Legacy parts keep their fixed labels
("Frontend", "Backend").

---

## Where each state's data is (the stubs)

| State | Stub |
| --- | --- |
| Org settings › Hosting — a mixed org mid-setup (legacy Cloudflare + Railway on Staging; Vercel installed; Render token refused with a 401; Fly.io connected; Netlify not connected; a 7-item checklist) | `HOSTING_SAMPLE_MIXED` in `web/src/hosting-sample.ts` |
| A new org with no environment | `HOSTING_SAMPLE_FRESH` |
| Environments but no parts | `HOSTING_SAMPLE_NO_PARTS` |
| A Vercel install removed on Vercel's side | `HOSTING_SAMPLE_REVOKED` |
| Credentials can't be saved (platform key missing) | `HOSTING_SAMPLE_SECRETS_LOCKED` |
| The provider catalogue (the picker) — the real one | `HOSTING_SAMPLE_PROVIDERS` |
| Connect start / test passed / test failed / Poll-now lines | `HOSTING_SAMPLE_CONNECT_START`, `HOSTING_SAMPLE_TEST_OK`, `HOSTING_SAMPLE_TEST_FAILED`, `HOSTING_SAMPLE_POLL` |
| Return outcomes (`?hosting=`) | `HOSTING_CONNECT_OUTCOMES` (`shared/hosting.ts`; re-exported by the sample as `HOSTING_CONNECT_ERROR_CODES`) |
| Repo dashboard › Usage › Hosting — two environments, every provider: legacy Cloudflare (traffic) + Railway (resources), Vercel (a deploy building, one failed; usage unavailable), Netlify, Render web (all three ranges) + service, Fly.io web + service (releases without commits), one failed last poll, one `empty` part | `repoSample().providers` in `web/src/repo-sample.ts` (the dashboard's existing "Preview with sample data" toggle loads it) |

Recorded-shape API responses for each provider (what the backend parses, useful for realistic copy and ids) are in
`fixtures/hosting/<provider>/`.

## House rules (non-negotiable — match the existing app)

- **It is Trov's design system**: Geist; tokens `--bg --surface --fg --fg-70 --fg-55 --fg-40 --border
  --border-strong --hover --accent --accent-soft --green --amber --red --blue --purple`; light theme accent
  `#5e6ad2`, dark theme accent `#9aab65` on warm near-black. Reuse the app's idioms: the **underline tab bar**
  for page sections, the **segmented** switch for picking a value (Web/Service, 24h/7d/30d, production/preview),
  the **dropdown** (never a native `<select>`), the shared **confirmation modal** for destructive actions
  (focused red button, Enter confirms, Escape cancels; bottom sheet on a phone), toasts that may carry one Undo.
- **Corners are tight**: every radius renders at 0.4× its authored value; dots and avatars are small rounded
  squares, not circles (a status dot is an element, never a "●" character).
- **Color carries meaning only**: green good, amber warning, red bad, grey unknown/quiet. Provider glyphs are
  monochrome (`currentColor`), no brand colors, no logos you don't have rights to — a simple letterform or
  generic glyph per provider is fine.
- **Never guess**: `null` is "unknown", never "0". "Not connected", "no recent reading" and "not available from
  this provider" are three different, calm states. Don't invent figures, don't compute derived ones the payload
  doesn't carry (no cost-per-request, no uptime %).
- **Secrets**: a credential is write-only. The UI never shows one after saving — only `hint_last4` ("••••a1b2").
  Paste fields are masked, single-line, and trimmed. Always show where it will be sent (`api_hosts`).
- **Motion**: entrances rise in, figures count up, range switches cross-fade, building deploys pulse — all off
  under `prefers-reduced-motion`.
- **Responsive**: works from 360px to wide desktop; 16px side gutters on a phone; no horizontal page scroll;
  modals become bottom sheets ≤ 640px.
- **Accessible**: real buttons and links, labels on every field, errors announced and placed beside their field,
  focus returns to the trigger when a modal closes, ≥ 4.5:1 text contrast in both themes.
- **Copy**: plain product words, sentence case, short. Say what happens and what to do next. Name the provider.

## Deliverables

1. Org settings › Hosting — desktop and phone, light and dark, every state in 1d, the part editor (provider
   picker → settings form), the three connect variants (install/OAuth confirmation, paste-token modal, AWS
   later), test result, disconnect confirmation, callback toast and error banner.
2. Repo dashboard › Usage › Hosting — every state in Flow 2, all three ranges, the Poll-now strip lines.
3. The Integrations-tab and Environments-tab touches.
4. A short component inventory (part card, connection card, provider tile, deploy pill + dot strip, metric
   figure with its three null states, sparkline) so the build can map each to code.
