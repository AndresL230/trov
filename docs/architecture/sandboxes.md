# Sandboxes

An organization's agents can create and drive **sandboxes** over MCP: cloud Linux VMs (Daytona) to clone a repo
into, install, run tests, start a dev server and open it in a browser. Trov does the deciding (who is calling,
which org, whether the org has sandboxes on, whether a sandbox is the org's); a second Worker in this repo,
**trov-sandbox** (`workers/sandbox/`), does the running. It holds the Daytona API key, so no MCP path in Trov reads a secret (canopy-multitenancy.md D14,
`test/secrets.mcp.test.ts` unchanged).

Code: `src/tools/sandboxes.ts` (the switch, ownership, names, the record, the runner call, reading boots), the
`sandbox_*` tools in `src/mcp.ts` (`registerSandboxTools`), the `sandboxes` limit in `shared/plans.ts` and
`src/plans/gate.ts` (`sandboxAccess`), `src/sandboxes/` (`routes.ts` the cookie routes, `boot.ts` starting profile
boots, `pending.ts` the note between them), `shared/sandboxes-core.ts` (DTOs, profile validation, the story rule).
Migrations: `0089_sandboxes.sql`, `0090_sandbox_monitor.sql`. The runner: `workers/sandbox/` (`src/index.ts` the endpoint,
`src/ops.ts` each op and the org label, `src/daytona.ts` the REST client, its own `wrangler.toml`). Tests:
`test/sandboxes.test.ts` and `test/sandbox-monitor.test.ts` (Trov's half), `test/sandbox-runner.test.ts` (the runner against a fake Daytona) — both in
`pnpm test`, both typechecked by `tsconfig.worker.json`.

## The switch: the `sandboxes` limit

Sandboxes run on Trov's Daytona account, so they are a plan limit, LISTED on the pricing page (`plans.md`):
**Free none, Pro (`team`) 3 at once, Enterprise no limit** (the legacy `personal` plan none). A superadmin can still
give one organization its own number in Platform, and an override of **0 turns sandboxes off** for that org whatever
its plan. `sandboxAccess` (src/plans/gate.ts) answers the three cases the screens tell apart: `on` (with the cap),
`not_included` (the plan's number is 0, or the plan is canceled) and `off` (the override is 0). `sandboxesEnabled`
(src/tools/sandboxes.ts) is true only when

- the `SANDBOX` binding exists (env.md › Bindings),
- the org is not a Sample workspace (`orgs.sample`), and
- `sandboxAccess` reads `on`.

Otherwise **every** sandbox tool is refused `not_enabled` before anything is asked of the runner, its message naming
the plan when that is why — turning them off cuts off the org's existing sandboxes too (they then stop and delete on
their own: below).

## Listing

The tools are listed only when the binding exists AND an organization the connection can reach has sandboxes on
(`connectionHasSandboxes` in `handleMcp`, remembered per org for a minute per isolate, so a superadmin's change
shows within a minute). So the public tool reference (`mcp-catalog.ts`, built with no binding), the Sample
workspace and the connector directory's reviewers never see them. A call that lands in an org without them is
refused `not_enabled`, like `update_plan` for a non-admin. The six that only read are `readOnlyHint`
(`SANDBOX_READ_ONLY_TOOLS`).

| Tool | Runner op |
|---|---|
| `sandbox_list` | `list` — also returns the org's `limit` |
| `sandbox_list_profiles` | none — D1 only: the org's profiles, env var NAMES never values |
| `sandbox_create` | `create` — `requirePlan(ctx, "sandboxes", 1)` first; `name`, `profile`, `branch` (below) |
| `sandbox_get`, `sandbox_start`, `sandbox_stop`, `sandbox_delete` | `get`, `start`, `stop`, `delete` |
| `sandbox_configure` | `configure` — auto-stop minutes, public previews |
| `sandbox_exec` | `exec` — waits, ≤ 600 s, last 60,000 chars of output |
| `sandbox_run_background`, `sandbox_logs` | `run_background`, `logs` — a session command and its output |
| `sandbox_list_files`, `sandbox_read_file`, `sandbox_write_file` | `list_files`, `read_file`, `write_file` |
| `sandbox_preview_url` | `preview_url` — signed (1 h default) unless public |

## Ownership, twice

`org_sandboxes` (0089) holds one row per sandbox created through Trov: `(org_id, sandbox_id)`, `created_by`, and
`deleted_at` / `deleted_by` (both handles, `HANDLE_COLUMNS`; in `ORG_TABLES`). Every tool that names a sandbox
looks it up there **first** (`ownedRow`, by id or by name): not the org's live row → `not_found`, and the runner is never asked.
The runner then checks again: it labels every sandbox it creates `trov_org=<org id>` and `trov_created_by=<handle>`
(set last, so nothing passed in overrides them) and answers `not_found` for any sandbox whose label is not the
org it was told — so a wrong id from Trov still cannot reach another org's VM. Sandboxes are shared within the
org: any member may use any of the org's sandboxes.

The actor sent with each op is the bearer's handle (`ctx.userId`, invariant 3); nothing the agent passes names it.

## Names

A sandbox has a Trov name (`org_sandboxes.name`, 0090): what people see on Monitor › Sandboxes and what an agent may
pass instead of the id. `sandbox_create`'s `name` (lowercase letters, digits and dashes, at most 40,
`SANDBOX_NAME_RE`) must be unique among the org's LIVE sandboxes (`conflict` otherwise); without one Trov picks the
profile's key (or `sandbox`) and four random hex characters. A row from before 0090, or one reconcile added, is named
the first time it is listed. Daytona's own name is left alone: it is unique across Trov's whole account, not per org.

## The record: `sandbox_events`

Every operation on a sandbox writes ONE row (`recordEvent`): `tool`, a `subject` (the command, the path, the port),
a short `result`, `exit_code`, `ms`, `failed`, and for a failure only a scrubbed `output` tail (1,500 characters,
`scrubOutput`: the call's own env values and anything shaped like a GitHub, Trov, OpenAI-style or Bearer token are
replaced BEFORE the cut). `source` is `agent` for an MCP call (`ctx.via === "bearer"`), `person` for the web app's
cookie routes, `boot` for a profile's boot steps. `actor` is the principal's handle (a boot step's is the person who
created the sandbox). Rows are kept after the sandbox is gone; they go with the org (`ORG_TABLES`), and `actor` is in
`HANDLE_COLUMNS`. Reads that only answer from the runner without touching a sandbox (`sandbox_list`, `sandbox_get`)
record nothing.

**Stories.** Monitor › Sandboxes tells a sandbox's events as lines, and the rule is mechanical so a line never says
more than the record (`sandboxStories`, shared/sandboxes-core.ts): the boot steps are one story; each lifecycle call
(create, start, stop, delete, settings, a preview link) is its own; a background command and the `sandbox_logs` reads
of it (matched by command id) are one; everything else — commands, file reads and writes — runs together until a
lifecycle or background line or a pause over 15 minutes. Titles are counted, not written: "Ran 3 commands, touched 1
file; 1 failure". No model is called.

## The org's rules

Two columns on `orgs` (0090), set by an admin in Org settings › Sandboxes (`PUT /sandbox-settings/rules`, audited
`sandbox.rules`):

- `sandbox_members_act` (default 1): anyone in the org may stop, start or delete a sandbox from the web app; 0 keeps
  that to admins and owners. It does not touch MCP: an agent may always stop or delete the org's sandboxes.
- `sandbox_public` (default 0): agents may make a sandbox's previews public. Off, `sandbox_create` and
  `sandbox_configure` refuse `public: true` (`forbidden`) before the runner is asked; a signed link is always there.

## Profiles

`sandbox_profiles` (0090): what an agent boots from by `key` — repository and branch, size (`small` 1 CPU/1 GB,
`medium` 2/4, `large` 4/8, `SANDBOX_SIZES`), image, setup steps, a start command and the port it serves, plain env
vars, idle minutes before auto-stop and days before Daytona deletes it once stopped. Admins write them
(`PUT /sandbox-profiles/:key`, `checkSandboxProfile`, audited `sandbox.profile_set`); delete is soft and the key stays
reserved (`sandbox.profile_delete`, invariant 11). Env values are NOT secrets: they are stored in D1 in the clear and
shown to admins; `sandbox_list_profiles` gives agents the names only. Secrets for profiles are a later step.

**Boot.** `sandbox_create { profile }` sends the profile's size, image, env and lifetime with the create, then writes
the row `boot_state = 'pending'` with the step labels in `boot_detail`. Cloning a PRIVATE repository needs a GitHub
token, and nothing reachable from src/mcp.ts may mint one (invariant 12), so the create only notes the sandbox in
`src/sandboxes/pending.ts`; after the MCP request `src/index.ts` runs `drainBoots` (`src/sandboxes/boot.ts`) in
`waitUntil`. It claims each pending row (`booting`, so two drains start it once), mints a token scoped to that one
repository with `resolveGithubCredential` as the org's system tenant (none: a public clone), and asks the runner's
`boot` op to start ONE script in the `trov-boot` session. The script deletes itself first, clones and resets the
remote to the clean URL (so the token is not left on the disk), runs each step, starts the start command in the
background and waits up to 3 minutes for its port, writing `~/.trov/boot.tsv` (step, exit, ms) and `boot.done`. It
stops at the first failing step. A lost note is not lost work: Refresh on the Monitor and the repo cron drain too.

How a boot is going is read on `sandbox_get`, `sandbox_list` and Refresh (`pollBoots` → the runner's `boot_status`):
each step not yet recorded becomes a `boot` event, and the row settles `ready` or `failed` (with the failing step's
scrubbed output). `sandbox_get` returns `boot`, `boot_steps`, `boot_done` and `boot_failed_step`.

## The screens' routes (cookie only)

`src/sandboxes/routes.ts`, under `/api/o/:slug`, every one `cookieOnly`:

| Route | Who | What |
|---|---|---|
| `GET /sandboxes` | any member | access, rules, live sandboxes and those gone this week with their stories and a 6-hour activity line — **D1 only** (invariant 7) |
| `POST /sandboxes/refresh` | any member | the explicit Refresh: the runner's `inspect` (state, size, disk used, listening ports, processes), reconcile, `pollBoots`, `drainBoots`; 503 `{ degraded: true }` when the runner cannot answer |
| `POST /sandboxes/:id/start\|stop`, `DELETE /sandboxes/:id` | `sandbox_members_act` or admin | recorded `person` |
| `POST /sandboxes/:id/preview` | any member | a signed preview link for `{ port }`, one hour |
| `GET /sandbox-settings` | any member | rules, profiles with their last five boots, the org's repositories |
| `PUT /sandbox-settings/rules`, `PUT`/`DELETE /sandbox-profiles/:key` | admin | audited |

## Keeping the count honest

A live row counts toward the limit. Daytona deletes sandboxes on its own (auto-delete a week after stopping, the
runner's default), so `sandbox_list` and `sandbox_create` first ask the runner for the org's sandboxes and
`reconcile`: a live row Daytona no longer has gets `deleted_at` with `deleted_by` NULL; a sandbox carrying the
org's label with no row (a create whose row write failed) gets one. A tool on one sandbox that the runner
answers `not_found` marks its row the same way. Two creates at the same instant can pass the limit by one, as
any `requirePlan` check followed by an outside call can.

## Deleting

`sandbox_delete` is an MCP delete, and invariant 2 keeps deletes off MCP. That rule is about Trov's **records**; a
sandbox is compute on Trov's bill, and an agent that started one must be able to remove it. Its row is soft
(`deleted_at`, `deleted_by`), so the history of who created and removed what stays.

**Deleting an organization** deletes its `org_sandboxes`, `sandbox_events` and `sandbox_profiles` rows with everything else (`src/deletion/`); the VMs
themselves are not called — they auto-stop after their idle minutes (60 by default) and are deleted by Daytona a
week after stopping.

## The runner (trov-sandbox, `workers/sandbox/`)

A second Worker in this repo with its own `wrangler.toml` and no dependencies of its own (it uses the root
`node_modules`; nothing in `src/` imports it, nor it `src/`). A merge to `main` deploys **only Trov**: the runner is
deployed with `pnpm run deploy:sandbox` (or by a second Workers Builds project on this repo whose deploy command is
that script, watching `workers/sandbox/**`). It has no public URL (`workers_dev = false`, no routes): the only way in is Trov's Service Binding. One
endpoint, `POST /op` `{ org, actor, op, args }` → `200 { ok: true, result }` or `{ ok: false, code, error }` with
`not_found` 404, `bad_request` 400, `conflict` 409 (e.g. the sandbox is stopped), `upstream` 502. Besides the
one-op-per-tool ops it has `boot` / `boot_status` (above; `bootScript`, `parseBootTsv`) and `inspect` (`parseInspect`:
`df`, `ss -ltn` without the toolbox's own ports, `ps`). It calls
Daytona's REST API with `fetch` (no SDK) and its own secret `DAYTONA_API_KEY`. Defaults it sets on create:
private, auto-stop 60 minutes, auto-delete 7 days after stopping.

**Unreachable runner** (binding there, Worker down): `unavailable`, never a 500. **No binding**: no tools.

## Owner checklist

1. Deploy trov-sandbox first — `pnpm run deploy:sandbox` — and set its secret:
   `pnpm exec wrangler secret put DAYTONA_API_KEY -c workers/sandbox/wrangler.toml`.
2. The `[[services]]` block in Trov's `wrangler.toml` (binding `SANDBOX`, service `trov-sandbox`) is on: a fresh
   environment must deploy trov-sandbox BEFORE Trov, or Trov's deploy fails on the missing Worker.
3. `0089_sandboxes` and `0090_sandbox_monitor` are applied by the deploy.
4. Redeploy trov-sandbox (`pnpm run deploy:sandbox`) for the `boot`, `boot_status` and `inspect` ops: an older runner
   answers them `bad_request`, so profile boots fail and Refresh is degraded until it is redeployed.
5. Pro has 3 and Enterprise no limit from the plan; Platform › the org › limits overrides it (0 = off).
