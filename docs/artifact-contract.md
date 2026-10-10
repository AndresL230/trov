# The artifact contract

What an agent (or a person) can do with Trov **artifacts** — versioned pages the team keeps next to
its tickets and sprints: a rendered HTML page, a markdown doc, an SVG, a mermaid diagram, an image, a
PDF or any other file. Issue #52; implementation spec:
`docs/superpowers/specs/2026-09-24-artifacts-implementation.md`. The shared vocabulary and caps live
in `shared/artifacts-core.ts` — if this page and that file disagree, the file wins.

## Kinds and caps

| Kind | Stored | Cap | How you send it |
|---|---|---|---|
| `html` · `markdown` · `svg` · `mermaid` | text, in D1 | 750 KB (UTF-8 bytes) | inline `content` |
| `image` (png / jpeg / gif / webp) · `pdf` · `file` | bytes, in R2 at `artifacts/<sha256>` | 10 MB | a signed upload URL (below) |

A page's kind never changes. A `file` that claims an active type (`text/html`, `image/svg+xml`,
JavaScript, XML …) is stored as `application/octet-stream`, so it can only ever be downloaded.

Every page has a `title` (≤ 200), an `area` (`auth` · `architecture` · `infra` · `api` · `ui` ·
`data`), a `repo` (`owner/repo` or `""`), a `visibility` (`org` or `private`), versions (each with a
`summary` ≤ 500 characters) and links to `ticket` / `sprint` / `pr` / `issue`. The slug is derived from
the title (lowercase, dashes, ≤ 60 characters, `-2`, `-3` … on a collision) and never changes.

## Statuses

```
create                 → v1, status draft
draft ⇄ published      → anyone who can read the page (web)
any new version        → published, and any ratification is cleared
published → ratified   → a PERSON, on the web, only the latest version
```

Only **`ratified`** is team-confirmed. `draft` and `published` are one person's word; `query` flags a
draft as authority `draft` and a published or ratified page as `live`, and an artifact's query body
starts `Status: <status> · v<n>` so you can tell which.

## Who can do what

- **See** a page: everyone in the org when it is `org`; only its author when it is `private`.
- **Write** a page (add a version, draft ⇄ published, title / area / repo, links): anyone who can see it.
- **Make a page private**: its author only.
- **Ratify**: any signed-in person, **on the web only** (a session-cookie route). There is no MCP tool
  for it and no way to reach it from an agent — the same rule as promoting a doc or ratifying an ADR.
- A **missing** slug, a page that is **private to someone else**, and a binary page whose upload has
  **not landed yet** are the same answer — `404 { "error": "not_found" }` over HTTP,
  `{ "error": "not_found", "code": "not_found" }` over MCP. The check is never an existence oracle.

An artifact write is a **direct authored write** (like a ticket), not staged knowledge: it takes effect
immediately and is recorded as you. Nothing marks it agent-made.

## The four MCP tools

Registered for every principal; the author and viewer is always your bearer's person.

**`upload_asset`** `{ destination?, title, kind, area, repo, visibility, content?, links?, summary?, size_bytes?, sha256?, content_type?, filename? }`

`destination` is `"artifact"` (the default — everything below) or `"doc"`, which uploads an image for a
doc instead of creating a page; see "Doc images" at the end. (This tool was `artifact_create`.)

- Text kinds: `content` is required → `{ id, slug, url, version, warnings }`.
- Binary kinds: `size_bytes` + `sha256` are required and `content` is refused →
  `{ id, slug, url, upload_url, expires_at, warnings }`. An `image` needs a `content_type` or a
  `filename` whose extension names the type.
- `links`: `[{ target_type, target_ref }]` — a ticket or sprint id (it must exist), or a PR / issue as
  `#n` (resolved against the page's `repo`), `owner/repo#n` or a GitHub URL.

**`artifact_update`** `{ slug, summary, content? | old_str + new_str, size_bytes?, sha256?, content_type?, filename? }`

- Text pages: the whole new `content`, **or** `old_str` + `new_str` — an exact edit of the latest
  version, where `old_str` must occur **exactly once** → `{ id, slug, url, version, unchanged, warnings }`.
  Content identical to the latest version writes nothing and returns `unchanged: true`.
- Binary pages: `size_bytes` + `sha256` → `{ id, slug, url, upload_url, expires_at, warnings }`.

**`artifact_get`** `{ slug, version?, include_content? }` — `slug` may carry a version (`slug@v3` or
`slug/v3`); default the latest. Returns the page's metadata, versions and links; for text kinds `content`
is that version's text, for binary kinds `content` is `null`. A text version **over 64 KB**
(`ARTIFACT_INLINE_MAX`) is not inlined unless `include_content: true`: `content` is `null` and
`content_omitted` is `true` — fetch `download_url` and grep / read slices of the file instead.
`content_omitted` is `false` on every other result; `warnings` are computed over the full text either way.
`query`'s assembled artifact body follows the same rule (a one-line pointer to `artifact_get`).
For **every** kind it also returns, for the requested version:

- `download_url` — absolute and signed for you: a plain `GET` returns the file (see *Downloading*).
  `download_expires_at` says when it stops working (5 minutes).
- `download_filename` — the name the download carries: the uploaded filename, else `<slug>-v<n>.<ext>`.
- `sha256` (hex) and `size_bytes` — what the downloaded bytes must match. (Top-level `size_bytes` is the
  REQUESTED version's here; `version.sha256` / `version.size_bytes` say the same.)

**`artifact_list`** `{ q?, kind?, area?, author?, status?, ticket?, sprint?, limit? }` — the pages you can
see (every `org` page and your own `private` ones; never a not-yet-uploaded page), newest first, with
the web library's filters: `q` is full text over title / summary / body or a title / slug substring,
`ticket` / `sprint` an id. `limit` defaults to 25, at most 100 →
`{ artifacts: [{ slug, title, kind, status, version, updated_at, url, area, author, visibility }], total,
truncated }`.

`url` is the page in the Trov web app, in the organization the call acted in (`<origin>/<org>/#artifacts/<slug>`) — the link to hand a person;
`upload_url`, `download_url` and `raw_url` are absolute too. **Every result carries `warnings: string[]`** — non-empty when text content calls into
something only claude.ai provides (`window.claude`, `window.storage`, `api.anthropic.com`). That is a
warning, never a rejection: the write has already happened, and the page will not work in Trov's
viewer until you remove the call. It is also non-empty for a **bundled Claude Design export** (the hi-fi
clickable ones, marked by `<script type="__bundler/manifest">`): its loader unpacks its scripts into
`blob:` URLs and its runtime compiles code with `new Function`, and the viewer's CSP allows neither, so
the page renders blank. Flatten it before uploading: every script inline (or from cdnjs / jsdelivr), no eval.

Also: `query` searches artifacts (type `artifact`, id = the slug; private pages only for their author),
`get_ticket` lists the pages linked to a ticket that you can see (`artifacts: [{ slug, title, kind,
status, version }]`), and `record_session` accepts `artifact_links: [{ slug, target_type, target_ref }]`
for the artifacts a session produced — linked after the batch is reconciled, each reported as `linked`
/ `not_found` / `error`.

## Uploading a binary

Two steps: declare the file, then PUT the exact bytes.

```bash
# 1. Hash it
shasum -a 256 threat-model.pdf
#   9f2c…e41a  threat-model.pdf
wc -c < threat-model.pdf
#   482113

# 2. upload_asset (or artifact_update for a new version) with the size and hash
#    { "title": "Threat model", "kind": "pdf", "area": "infra", "repo": "", "visibility": "org",
#      "size_bytes": 482113, "sha256": "9f2c…e41a", "filename": "threat-model.pdf" }
#    → { "slug": "threat-model", "upload_url": "https://trov…/api/artifacts/upload/<token>", "expires_at": "…" }

# 3. PUT the bytes
curl -X PUT --data-binary @threat-model.pdf -H "Content-Type: application/pdf" "<upload_url>"
```

- The URL is the credential: **single use, valid 5 minutes**, bound to your person, the page, the kind,
  the size, the hash, the type, the filename and the summary. No cookie or bearer on the PUT.
- A body whose length or SHA-256 does not match what you declared is refused (400) and the same URL may
  be retried until it expires; an expired or used URL is `410`. Ask for a fresh one with
  `artifact_update` on the same slug (the author may do that even before the first upload landed).
- Until the PUT lands, a new page does not exist to anyone — not even in your own `artifact_get`.
- Re-uploading bytes identical to the latest version writes nothing.

## Downloading (agents)

`artifact_get` hands you a `download_url` for the version you asked for — text and binary alike. Fetch
it with no header, then check the hash:

```bash
# artifact_get { "slug": "checkout-mockup" }
#   → { "download_url": "https://trov…/api/artifacts/download/<token>", "download_filename": "checkout-mockup-v3.html",
#       "sha256": "5d8f…", "size_bytes": 4821, "version": { "version_no": 3, … }, … }
mkdir -p .trov/artifacts/checkout-mockup
curl -fsSL "<download_url>" -o .trov/artifacts/checkout-mockup/v3.html
shasum -a 256 .trov/artifacts/checkout-mockup/v3.html      # must equal "sha256"
# spin an html page up locally:
python3 -m http.server 8000 --bind 127.0.0.1 --directory .trov/artifacts/checkout-mockup
```

- The URL is the credential: **signed for your person, that page and that version, valid 5 minutes, and
  reusable** within them (a download changes nothing). No cookie or bearer. Treat it like a password
  while it lives: don't paste it into a commit, a ticket or a chat — share `url` instead.
- It is **re-checked when you use it**: a page made private (by its author) after the URL was minted is
  `404 {"error":"not_found"}`, the same answer as a forged or malformed token. An expired one is
  `410 {"error":"gone"}` — call `artifact_get` again.
- The body is the **exact stored bytes** (no viewer script injected), served as an attachment with the
  stored content type, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store` and
  `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` — nothing it serves can
  run in Trov's origin. `HEAD` works too.
- The default place for a pulled artifact is `.trov/artifacts/<slug>/v<n>.<ext>` (the `artifacts`
  skill); keep `.trov/` in `.gitignore`.

## The raw route

`GET /api/o/<org>/raw/a/<slug>` (latest), `…/raw/a/<slug>@v<n>` or `…/raw/a/<slug>/v<n>` (the old `/raw/a/…`
without the organization is an alias that answers a person with exactly one organization) serves the bytes with
locked-down headers (a sandboxing CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Cache-Control: private`). `?download=1` forces an attachment named `<slug>-v<n>.<ext>`. It is
**session-cookie only** — it is what the web viewer frames and what `raw_url` points a signed-in browser
at. It does not take an MCP bearer; an agent uses `download_url` (above).

## Doc images

A doc (not an artifact) may embed images, and only ones uploaded to Trov. The same tool, the same PUT:

```bash
sha=$(shasum -a 256 flow.png | cut -d' ' -f1); size=$(wc -c < flow.png)
# upload_asset { destination: "doc", sha256: "$sha", size_bytes: $size, content_type: "image/png" }
#   → { ref: "/img/<sha>", markdown, uploaded: false, upload_url, expires_at }
curl -X PUT --data-binary @flow.png -H "Content-Type: image/png" "$upload_url"
# then, in the doc body you propose:  ![The deploy flow](/img/<sha>)
```

- **Types and size**: `image/png`, `image/jpeg`, `image/gif`, `image/webp`; ≤ 10 MB. Page fields
  (`title`, `area`, …) are refused; `kind` may be omitted (it is always `image`).
- **Content-addressed and immutable**: the sha256 IS the image. `uploaded: true` means those exact bytes
  are already stored — no PUT, no token. A changed picture is a new sha and a new ref, so a promoted doc
  version renders the same forever. Nothing is deleted.
- **The gate**: `propose_doc_update`, `record_session`, `/ingest` and the web's New doc refuse a body
  that references a `/img/<sha>` not uploaded yet, or any other image source (an external URL, a
  `data:` URI, another path) — outcome `refused` with the reason, nothing staged, nothing triaged. Image
  syntax inside code blocks and inline code is not an image and is not checked. In a `record_session`
  batch a refused doc is listed under `refused` and is NOT ledgered: upload, then resend the same batch.
- **Reading**: `GET /img/<sha>` (session cookie — a browser, not your bearer) serves the bytes with
  `Cache-Control: private, immutable`. In the web app a doc image opens in a lightbox; Review's
  Rendered view shows a proposal's images outlined as added or removed.
