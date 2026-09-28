# Canopy

Shared context store. One Cloudflare Worker on one origin serves the HTTP API,
a stateless MCP endpoint at `/mcp`, and a full single-page app (TypeScript + Vite,
served via the ASSETS binding). Live at `canopy.saplinglearn.com`.

- `shared/` — Zod contract, vocabulary, D1 row types (imported by `src/` and `web/`)
- `src/` — Worker: `index.ts` (router), `routes.ts` (Hono HTTP), `mcp.ts` (MCP tools),
  `consumer.ts` (the gate — replay-safe, hash-deduped, change-typed), `db.ts`, `tools/`
- `web/` — Full SPA with screens: My Work (default dashboard), Feed, Docs, Roadmap,
  Triage, Search, Settings, and a Get Started guide. Built to `web/dist`.
- `migrations/` — D1 SQL (`0001_init` … `0010_triage_resolve`)
- `plugins/canopy/` + `.claude-plugin/marketplace.json` — the Canopy **plugin** and the marketplace
  that distributes it (see **Install the Canopy plugin**). Bundles the three skills — `canopy`
  (umbrella + `query` reference), `load-context` (read/orient), `record-session` (session-end batch
  writer) — under `plugins/canopy/skills/`, plus the auto-wired MCP server.
- `.claude/skills/` — symlinks into `plugins/canopy/skills/` so this repo's own sessions load the
  bundled skills directly (single source of truth; nothing to keep in sync)

## Read side

FTS5 full-text search: `query()` ranks by bm25 + authority flag, assembles full bodies for
top hits, and returns ranked pointers for the rest. Backs `GET /search` and MCP `query`.
`get_doc` fetches a single doc with all its versions; `get_feed` streams the activity feed;
`get_roadmap` merges live GitHub progress at read time (degrades gracefully if token absent).
`get_repo_dashboard` is the Repo dashboard's read (deploys, CI, code activity, usage, product metrics,
planning) from Canopy's own database — optional `tab` / `range` / `include_trends`; every section is
`ok`, `empty` or `not_connected`, and anything not `ok` is unknown, never zero.

## Write side (agents stage, humans confirm)

Every agent write flows through the gate in `src/consumer.ts` — replay ledger
(`processed_items`), content-hash dedupe, change-typing (new/edit/rewrite), and
out-of-vocab or low-confidence entries route to `needs_triage`. HTTP confirm routes
(promote, ratify, reject, assign, discard) are session-cookie-only — never MCP tools.

MCP write tools: `append_feed`, `propose_doc_update`, and `record_session` (the session-end batch
writer — a whole `IngestPayload` through the same gate), plus the admin-only `update_plan` (the
roadmap plan write: direct and promote-class, NOT the gate). Sprint and ticket writes are cookie
routes only — MCP never gets one.

## The living loop (the skills)

Canopy stays current because agents continuously feed it and humans curate it. Three skills under
`.claude/skills/` drive that loop — **this is the root of how the context system stays alive**, not a
side feature:

1. **Orient — `load-context`** (auto-fires, read-only). Before an agent works an existing area it pulls
   the relevant context via `query` (assembled bodies + ranked pointers, each authority-flagged), so it
   builds on what's already there instead of guessing.
2. **Work** — the agent does the task.
3. **Record — `record-session`** (explicit: "record this session"). At the end it observes what actually
   shipped (`git`/`gh`), reads the affected docs back from Canopy for a true base, and stages **one**
   reconciled batch through the `record_session` MCP tool (same gate as `POST /ingest`, reachable over
   the agent's bearer).

The gate reconciles every write — drops no-ops (content-hash), tags each doc change `new`/`edit`/`rewrite`,
and routes out-of-vocab or low-confidence entries to Triage. A human then promotes / ratifies / rejects /
assigns / discards. **Staging + confirmation is what keeps the store trustworthy as it grows**: nothing
goes live unreviewed, and nothing rots, because every session writes back what it learned.

`canopy` is the umbrella skill (the map, plus the full `query` reference in `references/querying.md`);
`load-context` and `record-session` are the two halves it composes — kept separate because one must
auto-fire and the other must never. They live in this repo so they version with the tools they wrap.
To use them from another machine or repo, install the **Canopy plugin** (below) — it bundles all three
skills and auto-wires the MCP server in one step, so there's nothing to copy by hand.

## Develop

- `npm test` — Vitest against a real Miniflare D1
- `npm run typecheck` — type-check worker + web
- `npm run dev` — build web, then `wrangler dev`
- `npm run deploy` — build web, then `wrangler deploy`
- `npm run db:create` / `db:migrate:local` / `db:migrate:remote` — D1 provisioning + migrations

## Auth & secrets

Auth gates all data routes (session cookie) and `/mcp` (per-person bearer token), allowing
only active members of the `SaplingLearn` GitHub org. Set these Wrangler secrets:

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — a GitHub OAuth App whose callback is
  `https://<host>/auth/callback`.
- `COOKIE_SECRET` — a long random string used to sign the session cookie.

Production: `wrangler secret put GITHUB_CLIENT_ID` (and the others).
Local dev: copy `.dev.vars.example` to `.dev.vars` (git-ignored) and fill it in.

Mint an MCP token from a logged-in session: `POST /auth/mcp-token` → `{ "token": "canopy_mcp_..." }`
(shown once). The web app no longer mints tokens — Settings › MCP access connects agents by browser sign-in (OAuth) —
but the route and any token already minted keep working.

## Install the Canopy plugin (skills + MCP in one step)

The three skills and the MCP wiring ship as a Claude Code **plugin**, distributed from this repo as a
marketplace. Anyone on the team gets both in two commands inside Claude Code:

```text
/plugin marketplace add SaplingLearn/canopy
/plugin install canopy@canopy
```

The plugin connects by **browser sign-in** — no token to export. In Claude Code, run `/mcp`, pick
`canopy`, and choose **Authenticate**; your browser opens Canopy, sign in if asked, then click
**Allow**.

That auto-wires the `canopy` MCP server (`query` / `get_doc` / `record_session` …) and loads the
`canopy`, `load-context`, and `record-session` skills — no manual `claude mcp add`, no copying skill
folders. (Not using the plugin, or connecting a headless client like Codex or CI? The pasted-token
path still works: `claude mcp add --transport http canopy https://canopy.saplinglearn.com/mcp --header "Authorization: Bearer canopy_mcp_..."`.)

> **Maintainers:** the plugin is at `plugins/canopy/`; the marketplace manifest at
> `.claude-plugin/marketplace.json`. Validate either with `claude plugin validate <path>`. The real
> skill files live under `plugins/canopy/skills/`; the in-repo `.claude/skills/*` entries are symlinks
> into that bundle, so there is a single source of truth and the two can never drift — edit the files
> under `plugins/canopy/skills/`.

## License

Copyright (C) 2026 Andres Lopez. Canopy is licensed under the GNU Affero General Public License
v3.0 (`AGPL-3.0-only`); see [`LICENSE`](LICENSE).
