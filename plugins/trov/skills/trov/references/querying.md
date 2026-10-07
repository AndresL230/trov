# Querying Trov — the `query` tool in full

`query` is Trov's one ranked, full-text read engine (FTS5 + bm25). It assembles the **whole
authoritative body** of the top hits and returns **ranked pointers** to the rest, each result
authority-flagged. Use it to orient, to search, and to explore — there is no second search path.

## Parameters

| param | type | default | what it does |
|---|---|---|---|
| `q` | string | `""` | the search text. **Empty `q` → browse mode** (recency-ordered, filtered by the params below). |
| `types` | `("doc"\|"decision"\|"feed"\|"sprint"\|"artifact")[]` | all five | restrict to one or more record types. `sprint` covers the roadmap plan narrative + sprints; `artifact` the artifact pages (see below). Tickets are not a query type — use `list_tickets` / `get_ticket`. |
| `section` | string | — | restrict docs to a section (docs only). |
| `space` | `"technical"\|"product"` | both | restrict docs to a space (docs only). |
| `include_staged` | boolean | **true via MCP**, **false via `/search`** | whether staged / unpromoted / draft content is returned. Agents see it (flagged); the human Search UI hides it. |
| `limit` | number | 6 | how many **full-body** primary hits to assemble. |
| `pointer_limit` | number | 20 | how many ranked **snippet** pointers to return beyond the primaries. |

## What comes back

```
{
  primary:  [ { type, id, title, section, space, body /* FULL */, authority,
                current_version, pending_version, staged_body, confidence,
                updated_at, updated_by, score } ],
  pointers: [ { type, id, title, snippet, authority, score } ],
  meta:     { engine: "fts5", total }
}
```

- **`primary`** carries the full current authoritative `body` — read these.
- **`pointers`** carry a `snippet` only — scan them, then open anything worth reading with
  `get_doc <slug>` (or a follow-up `query`).
- **`score`** is normalized so higher = better. Title/summary terms are weighted above body terms.
- **`authority`** is on every item — see the loop skill; never treat non-`live` as settled. When
  `include_staged` is true and a doc has a pending version, `pending_version` and `staged_body` are
  populated so you can inspect the proposed change without it being live.

### Artifacts in `query`

- An `artifact` result's `id` is its **slug** — open it with `artifact_get <slug>` (the raw markup,
  every version, its links). `current_version` is the latest version number.
- `authority` is `draft` for a draft page and `live` for a `published` **or** `ratified` one — so read
  the body's first line, `Status: <draft|published|ratified> · v<n>`: only `ratified` is
  team-confirmed. Then `Kind / Area / Repo`, the latest version's summary, and the content (markdown
  and mermaid raw, html and svg as their visible text, a one-line description for binary files).
- **Private artifacts reach only their author**: your query sees your own private pages and nobody
  else's. The human `/search` (include_staged false) hides drafts, like draft decisions.
- `section` / `space` are doc-only filters, so setting either drops artifacts out.
- The full artifact contract is `docs/artifact-contract.md`.

## Patterns

- **Orient before work** (what `load-context` does): a *tight* `q` (the subsystem/concept) + `types`
  + `section`. A focused query assembles better bodies than a broad one. Read the `primary` bodies;
  note a doc's `current_version` if you're about to propose a change (it's the writer's `base`).
- **Ad-hoc search**: a natural-language `q`, no type filter, let `primary` + `pointers` show
  depth-and-breadth. Raise `pointer_limit` to fan wider.
- **Browse a space/section**: empty `q` + `space`/`section`/`types` → recency-ordered listing.
- **Cross-space check**: query with `space:"product"` then `space:"technical"` (or omit `space` for both)
  when the same concept may live in either.
- **Inspect a pending change**: query with `include_staged: true` and read `staged_body` vs `body`.

## When to use which read tool

- **`query`** — you're searching/exploring/orienting by concept. Default choice.
- **`get_doc <slug>`** — you already know the exact slug and want all its versions.
- **`get_feed`** — you want the activity timeline (filter by author/tags/since).
- **`get_roadmap`** — you want the roadmap plan: admin-authored narrative + sprints with their
  progress (no live GitHub).
- **`list_sprints` / `get_sprint <id>`** — you want the sprints themselves: `list_sprints` is the
  same sprint list `get_roadmap` carries, without the narrative; `get_sprint` adds that sprint's
  tickets (roots then sub-tickets) and its merged resource links.
- **`list_tickets` / `get_ticket <id>`** — you want the ticket queue by filter (`seg`, `assignee`,
  `category`) or one whole ticket (`get_ticket` also lists the artifacts linked to it that you can
  see). Tickets are not a `query` type; use `list_tickets` to enumerate by state. Both reads are
  unscoped — you see the whole org's queue.
  The ticket WRITE tools are scoped to tickets already assigned to you, with THREE exceptions:
  `create_ticket` is unscoped (filing is how work enters the queue), `assign_ticket` may be called by
  an admin, the ticket's requester or a current assignee (assignment is how a ticket gets into a lane),
  and an **admin** may call `set_ticket_sprint` on any ticket (composing a sprint is sprint management —
  it spreads to no other verb). Sprint writes are open to every principal. See the `trov` skill, or the `tickets` skill to drive them.
- **`artifact_get <slug>`** — you know the artifact's slug (from a `query` hit or `get_ticket`'s
  `artifacts`) and want its content, versions and links; `slug@v3` reads an older version.
- **`get_my_work`** — you want your own previous-activity + to-do projection from captured GitHub events.

`query` is read-only and safe to call freely.
