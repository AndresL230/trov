---
name: canopy
description: Overview and entry point for working with Canopy, the team's shared context store ("the team brain"). Use when someone asks how Canopy works, how to use it, how to connect an agent, what can be read or written, or wants the whole orient→work→record loop — and as the map to the load-context (orient before work) and record-session (record at the end) skills. Read-only itself; it explains the loop and points to the right tool/skill.
allowed-tools: mcp__canopy__query, mcp__canopy__get_doc, mcp__canopy__list_tickets, mcp__canopy__get_ticket, mcp__canopy__list_sprints, mcp__canopy__get_sprint, mcp__canopy__get_repo_dashboard, mcp__canopy__artifact_list, mcp__canopy__artifact_get
---

# Canopy — the team's shared context store

Canopy holds the team's docs, decisions, roadmap, a ticket queue the whole org files into, and a
running feed of what everyone — people and their coding agents — has done.

The golden rule is about **what an agent may assert on its own**: **proposed knowledge is staged and a
human confirms it.** A doc edit, an ADR, a feed entry — none of it goes live until somebody promotes
it, however many agents are writing.

**Authored work is not knowledge, and is not staged.** A ticket is somebody's request and a sprint is
the team's plan; both take effect immediately, the same as when a person clicks the button. What
bounds those is not a queue but **scope**: a ticket write needs the ticket to be assigned to you
already. So there are two write classes, and it is worth knowing which
one you are in:

| | Staged — a human confirms | Direct — takes effect now |
|---|---|---|
| **What** | docs, ADRs, feed entries (`propose_doc_update`, `append_feed`, `record_session`) | tickets, sprints, the roadmap plan (`update_plan`), artifacts (`upload_asset` / `artifact_update`) |
| **Why** | an agent proposing knowledge can be wrong, and a wrong doc is believed | a request or a plan is an act, not a claim — and it is visibly somebody's |
| **What bounds it** | the gate: vocab, confidence, content-hash dedupe, then Triage | scope: your own lane, or admin |

Read the two sections below in that light.

This skill is the **map**. The actual work is done by two focused skills and a set of MCP tools — they
stay separate on purpose (one must auto-fire, one must never), and this skill ties them together.

## The loop

```
orient (load-context)  →   do the work   →   record (record-session)
   reads, before work                          stages, at session end
```

1. **Orient — the `load-context` skill.** Auto-fires before you work an existing area or propose a doc
   change. It pulls the relevant context (assembled bodies + ranked pointers, each authority-flagged)
   so you build on what exists instead of guessing. Read-only.
2. **Work** as normal.
3. **Record — the `record-session` skill.** Explicit only ("record this session"). At the end it
   batches what changed and stages it through the gate in one `record_session` call. It must never auto-fire.

> Why two skills, not one: a skill carries a single trigger setting. `load-context` **must** be
> model-invocable (auto-orient); `record-session` **must** be explicit-only (never log on its own).
> They can't share one `SKILL.md`. This `canopy` skill is the umbrella that documents both.

Alongside the loop: **`tickets`** (explicit-only) works the ticket queue and, for an admin, the
sprints; **`handoff`** (explicit-only) leaves one handoff for the next session; **`prompts`** finds,
fills and stages Prompt Library prompts; **`artifacts`** finds, pulls (verified download), spins up,
links and — when asked — publishes artifact pages; **`my-work`** reads your own plate; **`read-plan`** / **`update-plan`** read and write the
roadmap plan. Reading tickets, sprints and the roadmap needs no skill — those tools are registered for
every principal.

## Authority is load-bearing

The writer identity behind every read/write is the person's **handle** (the GitHub login, for migrated
engineers). Every read result is flagged. Treat anything that is not `live` as not-yet-settled:

- `live` — settled. Trust it.
- `staged_pending` — a newer version is staged but unpromoted; the body you see is still the live one.
- `unpromoted` — exists only as staged content, never promoted. A draft, not truth.
- `draft` — an unratified decision.

Never present `staged_pending` / `unpromoted` / `draft` content as established fact.

## Reading

- **`query`** — the rich, ranked, full-text read over five types (`doc` / `decision` / `feed` /
  `sprint` / `artifact`; tickets are read with `list_tickets` / `get_ticket`). Whole authoritative bodies for the top hits plus ranked pointers to the rest,
  every result authority-flagged. **See `references/querying.md` for the full parameter set and
  patterns** (filter by type/section/space, browse, fan out via pointers, `include_staged`). This is
  the tool `load-context` wraps; call it directly for ad-hoc exploration.
- **`get_doc <slug>`** — one doc with all its versions (exact fetch).
- **`get_feed`** — the activity feed (author / tags / since / limit filters).
- **`get_roadmap`** — the roadmap plan: an admin-authored narrative + **sprints** (each with `label`,
  `summary`, `phase`, `dates`, `due`, `status`/`active`, `urgency`, `lead`, `domain`) merged with their
  progress (`closed/total/pct` — the sprint's tickets PLUS its cached GitHub issue counts) and
  `members` (the handles assigned to those tickets); no live GitHub at read time.
- **`list_tickets` / `get_ticket`** — the org-wide ticket queue, read-only: `list_tickets` takes
  `seg` (`open` / `closed` / `all`), `assignee` (`anyone` / `me` / `unassigned`) and `category`;
  `get_ticket <id>` is the whole ticket (assignees, links, comments, history, parent + sub-tickets).
- **`list_sprints` / `get_sprint`** — the sprint containers, read-only: `list_sprints` is every
  sprint in roadmap order with its progress and members; `get_sprint <id>` adds the sprint's tickets
  (roots then their sub-tickets) and its merged resource links.
- **`get_my_work`** — your captured-event My Work projection: previous-activity (summarized merged/closed
  PRs from the last 14 days) + to-do (open assigned issues); built from captured GitHub events, no live
  GitHub.
- **`get_events`** — recent captured GitHub events, filterable by type/subject/limit.
- **`get_repo_dashboard`** — the Repo dashboard for the org's main repository, read from Canopy's own
  database (never live GitHub): environments and deploys, CI, code activity, usage (requests, errors,
  hosting, active users), the app's product metrics, and planning. **Use it to orient before work that
  touches deploys, CI health, usage or product metrics.** Optional `tab` (`overview` / `code` / `ci` /
  `usage` / `planning`) returns just that tab's sections; `range` (`24h` / `7d` / `30d`, default `7d`)
  picks the usage, Cloudflare and product-count views; `include_trends` (default off) adds the
  sparkline series AND the full drift breakdown — without it `drift.groups` is the first 20 groups,
  each with a `commitCount` instead of its commits, and `drift.groupCount` is the full number; with it
  every group comes back with its commits. Every section is `ok`, `empty` or `not_connected` —
  **anything not `ok` is unknown, not zero.** The same holds *inside* an `ok` section: a `null` figure
  (`usage[].requests` / `errorRate` / `users`, a `product` value, `contributors[].reviews`,
  `ciFailures.rate`, a `null` or empty delta) is unknown / not captured, **never zero**, and
  `usage[].seen` says whether that source has ever reported. Read-only: polling and Sync GitHub are
  admin actions in the web app, never MCP tools.
- **`list_handoffs` / `get_handoff`** — handoffs left for you (and for `anyone`), pending only by default;
  `box: "sent"` lists your own. `get_handoff <id>` reads one without claiming it.
- **`search_prompts` / `get_prompt`** — the Prompt Library: search by text and tags; `get_prompt { slug,
  vars }` returns the body with `{{vars}}` filled and lists every variable still unfilled — ask for
  those, never guess (the `prompts` skill).

## Writing (agents stage, humans confirm)

Agents stage through the gate via MCP: **`append_feed`**, **`propose_doc_update`**. (A feed entry
is a one-line `summary`, a `brief` — 1–2 plain sentences, ≤ 280 characters, on the problem solved, which
is all people see in the Feed's default "For reading" view — and a `body`, the agent record, in one of
six typed structures — `Shipped:` / `Decision:` / `Triage:` / `Status:` / `Finding:` / `Incident:` —
see the `record-session` skill's "Feed entry format"; it applies to `append_feed` exactly as it does to
`record_session`.) The gate reconciles
every write — it de-duplicates no-op proposals, tags each doc change `new` / `edit` / `rewrite`, and
routes out-of-vocab or low-confidence entries to Triage. A doc may embed **images**, but only ones
uploaded to Canopy: `upload_asset { destination: "doc", sha256, size_bytes, content_type }` → PUT the
bytes to `upload_url` (skip when it says `uploaded: true`) → reference `![alt](/img/<sha256>)`. The gate
refuses a doc whose image is not uploaded yet, or that points anywhere else (an external URL, a
`data:` URI) — outcome `refused`, with the reason. **Confirming** (promote / ratify / reject /
assign / discard) is done by a human in the web Triage desk over session-cookie routes — **never** MCP
tools. The roadmap plan itself is **admin-authored**, not staged by agents: the `update-plan` skill
wraps the `update_plan` MCP tool (direct, non-destructively versioned, promote-class) — agents cannot
propose a sprint at all (the roadmap-proposal queue was retired), and sprint `done` is admin-set.

### Tickets and sprints — writes in your own lane

Ticket writes go **direct**, in the same promote class as the cookie routes: no gate, no staging, no
triage step — a ticket write is org-visible immediately. What bounds them is scope, not staging:

> **You may write only to tickets already assigned to you.** Filing (`create_ticket`) is the one
> unscoped write.

- **`create_ticket`** — file a ticket. The requester is you. Its `assignees` is the **only**
  agent-reachable assignment in Canopy: there is no `toggle_assignee` tool and never will be, because
  assignment is the data the lane rule is built on. After filing, assigning is web-only.
- **`edit_ticket` / `transition_ticket` / `add_ticket_comment` / `add_ticket_link` / `set_ticket_sprint` /
  `set_ticket_parent`** — scoped. Outside your lane you get `{"code": "forbidden"}` and nothing is
  written. `set_ticket_parent` needs the lane on both tickets.
- **Sprint writes are open to everyone**: `create_sprint`, `set_sprint_active`, `complete_sprint`,
  `add_sprint_resource`, `delete_sprint` (hard delete; its tickets move to the backlog). Only the
  whole-plan rewrite `update_plan` is admin-only.
- One admin exception to the lane: an admin may `set_ticket_sprint` on any ticket, because composing
  a sprint is sprint management. It spreads to no other verb.

**`done` / `declined` on a ticket, and `done` on a sprint, are still never INFERRED** — not from a PR
merging, an issue closing, the cron, or every ticket in a sprint resolving. A person asks for them,
through their own token. ONE exception: a ticket MIRRORED from a GitHub issue (`source: "github"`,
ADR-007 as amended — sourced from the issue, never the issue itself) follows that issue's close and
reopen; everything else about it is edited in Canopy, and its source link is locked. The **`tickets`** skill is the explicit-only wrapper for all of this.

### Handoffs and prompts

- **`send_handoff`** — leave one addressed note for the next session (`recipient`: a handle or `anyone`)
  with the fixed context `{ repo, branch, task, done[], next[], files[] }`. Direct, not staged — it is a
  message, not knowledge. One per session; the explicit-only **`handoff`** skill wraps it.
- **`claim_handoff` / `expire_handoff`** — claiming is atomic and happens once; it returns the handoff as
  one markdown block to act on. `load-context` lists pending handoffs at session start and claims only
  the one the person picks — never on its own.
- **`save_prompt`** — stages a new prompt or a new version of one. Always `staged`, whatever you send; a
  human publishes it in the Prompt Library. See the **`prompts`** skill.

Note there is **no provenance**: a write made through your token is recorded as *you*, with nothing
marking it agent-made. Use the `tickets` skill's `comment_prefix` config if your team wants agent
comments recognizable.

### Artifacts — the artifact contract

Artifacts are versioned pages the team keeps next to its tickets and sprints: `html`, `markdown`,
`svg`, `mermaid` (text, ≤ 750 KB, sent inline) and `image`, `pdf`, `file` (≤ 10 MB, uploaded). The
whole contract — kinds, caps, statuses, permissions, the upload flow with a `curl` example, the raw
route — is **`docs/artifact-contract.md`**; read it before your first artifact write. In short:

- **`upload_asset`** `{ destination?, title, kind, area, repo, visibility, content? | size_bytes + sha256, links?, summary? }`
  — ONE tool for both stores. `destination: "doc"` (images for docs) takes only `sha256`, `size_bytes`,
  `content_type` → `{ ref: "/img/<sha256>", markdown, uploaded, upload_url? }` (see Writing above). The
  default, `"artifact"`, creates an artifact page:
  — text kinds take `content` → `{ id, slug, url, version }`; binary kinds take `size_bytes` + `sha256`
  (`shasum -a 256 <file>`) → `{ …, upload_url, expires_at }`, and you then `curl -X PUT --data-binary
  @<file>` the exact bytes to that URL (**single use, 5 minutes**). The page is invisible until the PUT lands.
- **`artifact_update`** `{ slug, summary, content | old_str + new_str }` for text (`old_str` must occur
  exactly once), or `{ slug, summary, size_bytes, sha256 }` for binary. Every new version is `published`.
- **`artifact_get`** `{ slug, version? }` — `slug@v3` / `slug/v3` name a version. Text kinds return
  `content`; **every** kind returns a `download_url` (absolute, signed for you, reusable for 5 minutes,
  no header — `curl -fsSL "$download_url" -o <path>`) plus that version's `sha256` / `size_bytes` to
  verify the file against, and `download_filename`. `raw_url` is the signed-in browser view only.
- **`artifact_list`** `{ q?, kind?, area?, author?, status?, ticket?, sprint?, limit? }` — the pages you
  can see, newest first → `{ artifacts: [{ slug, title, kind, status, version, updated_at, url, … }],
  total, truncated }`.
- The **`artifacts`** skill is the procedure: find → pull into `.canopy/artifacts/<slug>/v<n>.<ext>` and
  verify the hash → spin it up (serve an html page locally) → or just share `url` → publish / update
  only when asked.
- Every result carries **`warnings`** — non-empty when content calls something only claude.ai has
  (`window.claude`, `window.storage`, `api.anthropic.com`). A warning, never a rejection.
- **Direct, not staged**: a create or update takes effect now, as you. Whoever can see a page can write
  it; `private` pages are their author's alone, and a private / missing / not-yet-uploaded slug is the
  same `{ "error": "not_found", "code": "not_found" }`.
- **Ratifying is human-only.** `draft` → `published` → `ratified`; only `ratified` is team-confirmed,
  and a person does it on the web. There is no ratify tool. Never describe a `published` artifact as
  agreed.
- Artifacts show up in **`query`** (type `artifact`, id = slug; the body's first line is
  `Status: <status> · v<n>`) and in **`get_ticket`**'s `artifacts`. `record_session`'s
  `artifact_links` links the artifacts a session produced to their ticket / sprint / PR / issue.

## Connect an agent over MCP

**Recommended — install the plugin** (bundles every skill — canopy, load-context, record-session,
my-work, tickets, read-plan, update-plan, handoff, prompts, artifacts — AND auto-wires the MCP server):

```bash
claude plugin marketplace add SaplingLearn/canopy
claude plugin install canopy@canopy
```

Then run `/mcp` in Claude Code, choose **canopy → Authenticate**, sign in to Canopy in the browser and
click **Allow**. (Headless clients can still use a token from Settings › MCP access.)

**Manual fallback** — wire the MCP server and copy the skills yourself:

```bash
claude mcp add --transport http canopy https://canopy.saplinglearn.com/mcp \
  --header "Authorization: Bearer canopy_mcp_…"
# then copy the skill folders into another repo / your home dir:
cp -r .claude/skills/{canopy,load-context,record-session,my-work,tickets,read-plan,update-plan,handoff,prompts,artifacts} ~/.claude/skills/
```

The skills are bundled in this repo under `plugins/canopy/skills/` (the in-repo `.claude/skills/*`
entries are symlinks into that bundle, so there is a single source of truth).
