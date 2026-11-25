# Sandboxes

An organization's agents can create and drive **sandboxes** over MCP: cloud Linux VMs (Daytona) to clone a repo
into, install, run tests, start a dev server and open it in a browser. Trov does the deciding (who is calling,
which org, whether the org has sandboxes on, whether a sandbox is the org's); a separate Worker, **trov-sandbox**,
does the running. It holds the Daytona API key, so no MCP path in Trov reads a secret (canopy-multitenancy.md D14,
`test/secrets.mcp.test.ts` unchanged).

Code: `src/tools/sandboxes.ts` (the switch, ownership, the rows, the runner call), the `sandbox_*` tools in
`src/mcp.ts` (`registerSandboxTools`), the `sandboxes` limit in `shared/plans.ts` and `src/plans/gate.ts`
(`limitCap`). Migration: `0089_sandboxes.sql`. Test: `test/sandboxes.test.ts`. The runner is its own repository
(`trov-sandbox`), with its own tests against a fake Daytona.

## The switch: the `sandboxes` limit

Sandboxes run on Trov's Daytona account, so no plan includes them: `sandboxes` is **0 on every plan** and NOT
LISTED (`plans.md`). A superadmin turns them on for one organization by giving it a `sandboxes` override in
Platform (the limit fields every org has): N is how many sandboxes it may have at once, empty-for-unlimited is
unlimited. The limit is also the on/off switch — `sandboxesEnabled` (src/tools/sandboxes.ts) is true only when

- the `SANDBOX` binding exists (env.md › Bindings),
- the org is not a Sample workspace (`orgs.sample`), and
- the org's resolved cap is above 0 (`limitCap`; a canceled plan reads 0).

Off, **every** sandbox tool is refused `not_enabled` before anything is asked of the runner — taking the override
away cuts off the org's existing sandboxes too (they then stop and delete on their own: below).

## Listing

The tools are listed only when the binding exists AND an organization the connection can reach has sandboxes on
(`connectionHasSandboxes` in `handleMcp`, remembered per org for a minute per isolate, so a superadmin's change
shows within a minute). So the public tool reference (`mcp-catalog.ts`, built with no binding), the Sample
workspace and the connector directory's reviewers never see them. A call that lands in an org without them is
refused `not_enabled`, like `update_plan` for a non-admin. The five that only read are `readOnlyHint`
(`SANDBOX_READ_ONLY_TOOLS`).

| Tool | Runner op |
|---|---|
| `sandbox_list` | `list` — also returns the org's `limit` |
| `sandbox_create` | `create` — `requirePlan(ctx, "sandboxes", 1)` first |
| `sandbox_get`, `sandbox_start`, `sandbox_stop`, `sandbox_delete` | `get`, `start`, `stop`, `delete` |
| `sandbox_configure` | `configure` — auto-stop minutes, public previews |
| `sandbox_exec` | `exec` — waits, ≤ 600 s, last 60,000 chars of output |
| `sandbox_run_background`, `sandbox_logs` | `run_background`, `logs` — a session command and its output |
| `sandbox_list_files`, `sandbox_read_file`, `sandbox_write_file` | `list_files`, `read_file`, `write_file` |
| `sandbox_preview_url` | `preview_url` — signed (1 h default) unless public |

## Ownership, twice

`org_sandboxes` (0089) holds one row per sandbox created through Trov: `(org_id, sandbox_id)`, `created_by`, and
`deleted_at` / `deleted_by` (both handles, `HANDLE_COLUMNS`; in `ORG_TABLES`). Every tool that names a sandbox
looks it up there **first** (`ownedId`): not the org's live row → `not_found`, and the runner is never asked.
The runner then checks again: it labels every sandbox it creates `trov_org=<org id>` and `trov_created_by=<handle>`
(set last, so nothing passed in overrides them) and answers `not_found` for any sandbox whose label is not the
org it was told — so a wrong id from Trov still cannot reach another org's VM. Sandboxes are shared within the
org: any member may use any of the org's sandboxes.

The actor sent with each op is the bearer's handle (`ctx.userId`, invariant 3); nothing the agent passes names it.

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

**Deleting an organization** deletes its `org_sandboxes` rows with everything else (`src/deletion/`); the VMs
themselves are not called — they auto-stop after their idle minutes (60 by default) and are deleted by Daytona a
week after stopping.

## The runner (trov-sandbox)

A Worker with no public URL (`workers_dev = false`, no routes): the only way in is Trov's Service Binding. One
endpoint, `POST /op` `{ org, actor, op, args }` → `200 { ok: true, result }` or `{ ok: false, code, error }` with
`not_found` 404, `bad_request` 400, `conflict` 409 (e.g. the sandbox is stopped), `upstream` 502. It calls
Daytona's REST API with `fetch` (no SDK) and its own secret `DAYTONA_API_KEY`. Defaults it sets on create:
private, auto-stop 60 minutes, auto-delete 7 days after stopping.

**Unreachable runner** (binding there, Worker down): `unavailable`, never a 500. **No binding**: no tools.

## Owner checklist

1. Deploy trov-sandbox first and set its `DAYTONA_API_KEY` secret.
2. Uncomment the `[[services]]` block in Trov's `wrangler.toml` (binding `SANDBOX`, service `trov-sandbox`) — a
   binding to a Worker that does not exist fails the deploy.
3. Merge (applies `0089_sandboxes`).
4. Platform › the org › limits: set Sandboxes to how many it may have at once.
