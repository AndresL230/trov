# App metrics: contract v3 (self-described groups)

Extends `2026-09-20-sapling-metrics-endpoint.md` (v1, `active_users`) and `2026-09-21-sapling-product-metrics.md`
(v2, `counts` / `totals`). Same endpoint, same auth, same cadence: Trov sends `GET {apiUrl}/api/internal/metrics` with
`Authorization: Bearer <token>` (user-agent `canopy-metrics`, `redirect: "manual"`, an 8-second timeout, https only)
once an hour per environment, from the `:00` usage tick and from an admin's Poll now. **v3 is additive**: a v1 or v2
body (no `version`) parses exactly as before, forever.

Built in repo setups, Phase G (2026-10-15). Trov's own `GET /api/internal/metrics` (below) is the first v3 producer:
scenario B's Product block on the Repo screen.

## 1. Why v3

v2 made Trov generic over KEYS but not over their meaning: a key is labelled and grouped by Trov's registry
(`src/repo/product.ts`), and the Product block's shapes are chosen by group id (`learning` is a ranked list, `ai` one
feature figure, …). A second app would need a Trov change to be drawn well. v3 lets the producer say, per group, what
the numbers are called and how they should be drawn. Trov stores the description and draws whatever arrives.

## 2. The response

```json
{
  "version": 3,
  "part": "trov",
  "label": "trov",
  "active_users": { "24h": 6, "7d": 9, "30d": 11 },
  "groups": [
    { "id": "now", "label": "Right now", "shape": "stats",
      "metrics": [ { "key": "people", "label": "People", "value": 6 },
                   { "key": "live_docs", "label": "Live docs", "value": 184 } ] },
    { "id": "mcp_tools", "label": "MCP tool calls", "shape": "ranked",
      "note": "Counted per UTC day: 24h is today so far.",
      "metrics": [ { "key": "mcp_query", "label": "query", "values": { "24h": 600, "7d": 4210, "30d": 18000 } } ] },
    { "id": "spend", "label": "AI spend", "shape": "figure",
      "metrics": [ { "key": "llm_cost_cents", "label": "LLM cost", "format": "cents", "values": { "24h": 412, "7d": 2961, "30d": 11830 } } ] },
    { "id": "errors", "label": "Errors", "shape": "status",
      "metrics": [ { "key": "errors_5xx", "label": "5xx errors", "values": { "24h": 0, "7d": 2, "30d": 5 } },
                   { "key": "errors_4xx", "label": "4xx errors", "tone": "neutral", "values": { "24h": 10, "7d": 70, "30d": 300 } } ] }
  ]
}
```

- **`version`** — exactly the JSON number `3`. Anything else is a v1 / v2 body.
- **`part`** (optional) — the part (app) of the environment this endpoint describes, `^[a-z0-9_-]{1,32}$` (a part key).
  The Product block says which app it is about. An environment's token and URL stay per environment (Org settings ›
  Hosting, the part editor's app metrics token): one endpoint per environment, naming the part it reports.
- **`label`** (optional) — how the Product block names the app ("Product · trov"); 1–60 printable characters.
- **`active_users`** — OPTIONAL in v3. Absent: nothing is refused. Present: exactly v1 (whole-or-nothing, nesting).
- **`counts` / `totals`** — still accepted beside `groups`, exactly as v2 (registry labels and groups).
- **`groups`** — at most 12, each:
  - `id` — `^[a-z][a-z0-9_]{0,31}$`, unique in the body;
  - `label` — 1–60 printable characters (folded to one line);
  - `shape` — how to draw it, one of:
    - `ranked` — a bar list sorted by the range's figure, each bar scaled to the group's largest;
    - `stats` — figures over labels, three across (a `value` group draws as one "right now" strip);
    - `figure` — the FIRST metric as one large figure, the rest as a quiet line under it;
    - `status` — non-zero metrics listed with a tone mark (`bad` unless the metric says `tone: "neutral"`), every
      measured zero folded into one "N at zero" line, a metric with no recent reading named apart — never a zero;
  - `note` (optional) — one caveat line, ≤ 160 characters;
  - `metrics` — at most 24, ALL windowed or ALL point-in-time (the first metric decides; one of the other kind is
    dropped):
    - `key` — v2's key pattern `^[a-z][a-z0-9_]{0,39}$`, unique in the whole body (across groups, `counts`, `totals`);
    - `label` — 1–60 printable characters;
    - `values` — windowed: exactly `{ "24h", "7d", "30d" }`, JSON integers in 0..1e12, `24h ≤ 7d ≤ 30d` (v2's rule); or
    - `value` — point-in-time: a JSON integer in 0..1e12;
    - `format` (optional) — `"cents"`: integer cents shown as dollars; anything else is an integer;
    - `tone` (optional, `status` groups) — `"neutral"`: a non-zero figure never raises a colour (bot traffic, refusals).

The body caps are v2's, shared: **48 windowed and 24 point-in-time keys** in the body, `counts` and `totals` included.
**No shape requires a key**: a shape never looks for a particular key, so any producer's groups draw.

**Send only what the database can answer honestly** (v2 §1, unchanged): a metric whose source is doubtful is OMITTED,
never approximated and never sent as `0`. A window approximated by whole UTC days must say so in the group's `note`.

## 3. What Trov does with it

`src/repo/poll.ts`:

- `saplingActiveUsers` and `saplingProductMetrics` judge the v1 / v2 halves exactly as before.
- `appMetricsV3` judges `groups` PER GROUP and PER METRIC — one bad metric never costs its group, one bad group never
  the others — and never throws. A group is dropped whole for a bad id (or a repeated one), label or shape, no metric
  list, past the 12th, or when none of its metrics survive. A metric is dropped for a bad or repeated key, a bad label,
  a bad value, the wrong kind for its group, or a full cap. Dropped names (`groups.<id>`, `groups.<id>.<key>`, ≤ 20,
  scrubbed of the token BEFORE they are cut) go to the outcome's `detail` like v2's.
- Values are stored exactly as v2 stores them: a windowed metric as `sap_c_<key>_<24h|7d|30d>`, a point-in-time one as
  `sap_t_<key>` — hourly gauges, `part = ''`, the hour floor, first write of the hour wins, ONE `putMetrics` per
  environment. Pruning is v2's (`sap_*`: 7 days, the 00:00 UTC rows 100 days).
- The DESCRIPTION — part, label, and each group's id, label, shape, note, window and metrics (key, label, format,
  tone), never a value — is the environment's `repo_snapshots` row `app_metrics:<env>`, rewritten by every v3 body.
  A v1 / v2 body DELETES it (a no-op when there is none), so a producer that goes back to v2 is drawn as v2 again.

`src/tools/repo.ts` `projectProduct`: when an environment has a v3 description, its groups come FIRST, in the body's
order, with their own titles, shapes, notes and tones (`RepoProductGroup.shape` / `now` / `note`,
`RepoProductCount.tone`); a point-in-time group is `now: true` (the same figure in every range). Every key a v3 group
names leaves the v2 grouping; the keys it does not name (a v2 `counts` / `totals` beside it) are grouped by the
registry as before. The staleness rule is v2's: a figure only while its latest reading is ≤ 3 hours old, else `null`
("no recent reading"); a key with no row in the read is absent. One more statement: `snapshotsByPrefix`, a key range
over the `app_metrics:` snapshots.

The SPA (`web/src/repo.ts` `productBody`) draws a group that has a `shape` BY THAT SHAPE — ranked bars, stat figures,
one feature figure, a status list — and never by its id or a key; a group with no shape (v2) keeps its id-based shape.

## 4. Trov's own endpoint

`GET /api/internal/metrics` on Trov itself answers v3 for ONE organization — the Product block of scenario B. It is the
**bearer class** (invariant 8: no fourth auth class): the `Authorization: Bearer <token>` header is a Trov MCP
credential (a pasted `trov_mcp_` token, or an OAuth access token in Manual mode), resolved by the one bearer rule
(`src/data/bearer.ts` `resolveBearerTenant`): the token's organization, among its person's LIVE memberships. Anything
else — no header, an unknown / revoked / expired credential, a person who left the org, a connection that follows the
repository (it names no organization without a `repo`) — is a bare `401`. Only `GET` (and `HEAD`); anything else `405`.
`Cache-Control: no-store`. D1 only, never a call out; every statement binds that one org's id.

To point an environment at it: in that org, Org settings › Hosting › the part editor's app metrics token, paste a
`trov_mcp_` token of a member (Settings › MCP access), with the environment's API URL Trov's own origin.

What it reports (`src/data/own-metrics.ts`):

| Group | Shape | Metrics |
| --- | --- | --- |
| `now` "Right now" | stats, point-in-time | People (live members), Live docs (docs with a promoted version), Awaiting review (staged doc proposals), In triage (unresolved triage items), Open tickets, Agents connected (live MCP tokens and OAuth connections that can reach the org) |
| `mcp_tools` "MCP tool calls" | ranked | each tool's calls (`mcp_tool:<name>` meter), top 12 — counted per UTC day (note) |
| `gate` "Agent writes through the gate" | stats | Staged (doc proposals made in the window), Promoted / Rejected (of those, where they stand now), To triage (items sent to triage in the window) — note: "Every agent write goes through the gate; a person promotes or rejects it." |
| `activity` "Activity" | stats | Sessions recorded (`record_session` calls), People active (people with a metered request) — counted per UTC day (note) |

`active_users` is left out (no `/api/internal/metrics` caller needs it from Trov, and People active says it per day).
"No-op (same content)" from the design is NOT sent: only batched `record_session` items reach the replay ledger, so an
honest count of every unchanged write does not exist — omitted, never approximated.
