---
name: artifacts
description: Use when work involves a Trov artifact — someone names or links one ("the checkout design", "the threat-model PDF", a #artifacts/<slug> link), a ticket you are working has artifacts linked, the person wants a design page / spec / diagram / image from Trov in the repo or running locally, or asks to publish or update one (triggers — "pull the design", "open that artifact", "spin up the mockup", "put this in Trov as an artifact", "upload the diagram"). Finding, pulling and linking are safe; creating or versioning one happens only when the person asks.
allowed-tools: mcp__trov__artifact_list, mcp__trov__artifact_get, mcp__trov__upload_asset, mcp__trov__artifact_update, mcp__trov__query, mcp__trov__get_ticket, Bash(curl -fsSL:*), Bash(curl -X PUT:*), Bash(shasum -a 256:*), Bash(sha256sum:*), Bash(wc -c:*), Bash(mkdir -p .trov/:*), Bash(git check-ignore:*), Bash(python3 -m http.server:*)
---

# Artifacts ↔ Trov

## Overview

An **artifact** is a versioned page the team keeps in Trov next to its tickets and sprints: an
`html` page (a mockup, a prototype), a `markdown` spec, an `svg` or `mermaid` diagram (text kinds,
≤ 750 KB), or an `image`, `pdf` or `file` (binary, ≤ 10 MB). Each has a `slug`, versions `v1…vN`, and a
status: `draft` → `published` → `ratified`. **Only `ratified` is team-confirmed**; `draft` and
`published` are one person's word — say which when you rely on one.

This skill is how an agent **finds** an artifact, **pulls** its exact bytes into the working tree to
code against, **spins it up** locally, **links** to it, and — when asked — **publishes** one. The full
contract (kinds, caps, permissions, the upload and download flows) is `docs/artifact-contract.md`.

Part of the **`trov`** skill set.

## When to use

- Someone references an artifact by name, slug or link, or asks "is there a design / spec for …".
- The ticket you are working has `artifacts` (from `get_ticket`) and the work depends on one — a design
  to implement, a spec to follow, an image to ship.
- The person wants an artifact in the repo, or running in a browser.
- The person asks to put something into Trov as an artifact, or to update one.

## When NOT to use

- A doc, ADR or feed entry — that is knowledge and goes through the gate (`record-session`).
- A file nobody on the team needs to see — keep it in the repo.
- To "ratify" anything. **Ratifying is a person's act on the web; no tool does it.** Never describe a
  `published` artifact as agreed.

## Procedure

### 1. Find it

- **By words:** `mcp__trov__artifact_list { q, kind?, area?, status?, author?, limit? }` — the pages you
  can see, newest first: `{ artifacts: [{ slug, title, kind, status, version, updated_at, url, … }],
  total, truncated }`. `mcp__trov__query { q, types: ["artifact"] }` ranks by relevance and returns
  bodies (id = slug, body starts `Status: <status> · v<n>`).
- **From a ticket or sprint:** `mcp__trov__get_ticket <id>` → `artifacts: [{ slug, title, kind, status,
  version }]`, or `artifact_list { ticket: <id> }` / `{ sprint: <id> }`.
- **From a link:** `…/#artifacts/<slug>` or `…/#artifacts/<slug>/v3` — the slug (and version) are in it.

If several match, list them (title · kind · status · vN) and ask which one.

### 2. Read it

`mcp__trov__artifact_get { slug }` (`slug@v3` or `version` for an older one). Text kinds return
`content` inline — for a markdown spec or a mermaid diagram that is usually all you need. **Over 64 KB
it is not inlined**: `content` is `null` and `content_omitted: true` — pull the file (step 3) and grep /
read slices of it. Pass `include_content: true` only when you genuinely need the whole text in context.
Every kind also returns:

- `download_url` — absolute, **signed for you, reusable for 5 minutes** (`download_expires_at`), no
  header needed. Expired → HTTP 410: call `artifact_get` again for a fresh one.
- `sha256` + `size_bytes` — of THIS version; what the download must match.
- `download_filename` — the name the server gives the file (`<slug>-v<n>.<ext>`, or the uploaded name).
- `url` — the page in the Trov web app (for people). `raw_url` is the browser view; it needs a
  signed-in session and does **not** take your bearer — don't curl it.

### 3. Pull it into the working tree (for coding)

Default path **`.trov/artifacts/<slug>/v<n>.<ext>`** (`<ext>` = the extension of `download_filename`)
unless the person names one — e.g. `web/public/logo.png` for an asset that ships with the code.

```bash
mkdir -p .trov/artifacts/<slug>
curl -fsSL "$download_url" -o .trov/artifacts/<slug>/v<n>.<ext>
shasum -a 256 .trov/artifacts/<slug>/v<n>.<ext>     # or: sha256sum
```

**Compare the hash with `sha256` from `artifact_get`.** A mismatch means you do not have the artifact:
delete the file, fetch a fresh `download_url`, try once more, then stop and say so. Never code against
an unverified download.

**`.trov/` is scratch, not source.** Check it is ignored — `git check-ignore -q .trov/ && echo ignored`
— and if it is not, tell the person and offer to add `.trov/` to `.gitignore` (don't commit pulled
artifacts by accident). A file the person asked to place in the source tree is theirs to commit.

### 4. Spin it up

| Kind | Do |
|---|---|
| `html` | Save it (step 3) and serve that folder: `python3 -m http.server 8000 --bind 127.0.0.1 --directory .trov/artifacts/<slug>`, then give the person `http://127.0.0.1:8000/v<n>.html` (or open the file directly). Stop the server when done. It may load CDN scripts/fonts; offline, those parts won't render. |
| `markdown` | Read `content` (or, if `content_omitted`, the pulled file); render or quote it. Implement against it. |
| `mermaid` | Read `content` (or the pulled file); paste it into a ```` ```mermaid ```` block or a renderer the repo already has. |
| `svg` | Save it and open it, or inline it where it belongs. |
| `image` / `pdf` / `file` | Save it (step 3) and use it as the asset it is — reference the path, read the PDF. |

An artifact whose `warnings` mention `window.claude` / `window.storage` / `api.anthropic.com` calls
something only claude.ai has — say that part will not work locally.

### 5. Or just link it

When the person wants to share or look at it — not code against it — give them **`url`**
(`<trov>/#artifacts/<slug>`). Don't download what nobody will use.

### 6. Publish or update — only when asked

Artifact writes are **direct** (not staged): they take effect now, recorded as the person whose token
you hold. Whoever can see a page can version it; `private` pages are their author's alone.

- **Text kinds** (`html` · `markdown` · `svg` · `mermaid`): `mcp__trov__upload_asset { title, kind,
  area, repo, visibility, content, summary?, links? }` → `{ slug, url, version }`. A new version:
  `mcp__trov__artifact_update { slug, summary, content }` — or `{ slug, summary, old_str, new_str }`
  for an exact edit (`old_str` must occur exactly once). `unchanged: true` = identical, nothing written.
- **Binary kinds** (`image` · `pdf` · `file`) — declare, then PUT the exact bytes:

  ```bash
  shasum -a 256 diagram.png        # → sha256
  wc -c < diagram.png              # → size_bytes
  # upload_asset { title, kind: "image", area, repo, visibility, size_bytes, sha256, filename: "diagram.png" }
  #   (or artifact_update { slug, summary, size_bytes, sha256, filename } for a new version)
  #   → { slug, url, upload_url, expires_at }
  curl -X PUT --data-binary @diagram.png -H "Content-Type: image/png" "$upload_url"
  ```

  The `upload_url` is single use and valid 5 minutes; the page does not exist to anyone until the PUT
  lands. A 400 means the bytes don't match what you declared (re-hash); a 410 means ask for a new URL
  with `artifact_update` on the same slug.
- `area` ∈ `auth` · `architecture` · `infra` · `api` · `ui` · `data`; `repo` is `owner/repo` or `""`;
  `visibility` `org` (default for team work) or `private`. Link it to its ticket / sprint / PR with
  `links` at create time, or at session end through `record-session`'s `artifact_links`.
- Report the `url`, the version, and any `warnings` (a warning, never a rejection).

## Hard rules

- **Verify every download** against `sha256` before using it.
- **Never ratify**, and never call a `published` artifact agreed. A person ratifies on the web.
- **Writes only when asked.** Pulling and linking are yours to do; creating or versioning an artifact
  is the person's call.
- **Never put a secret or token in an artifact**, and never paste a `download_url` or `upload_url` into
  a commit, doc, ticket or chat for others — they are short-lived credentials. Share `url`.
- `.trov/` stays out of git unless the person says otherwise.
