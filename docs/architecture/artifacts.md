# Artifacts and doc images

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Artifacts — stored, versioned pages; direct writers, human ratify (spec: `docs/superpowers/specs/2026-09-24-artifacts-implementation.md`, issue #52)

An artifact is one self-contained page an agent or person produced (a design page, spec, report, diagram, image,
PDF, file), stored and versioned in Trov and linked to the work it came from. Knowledge › **Artifacts** in the
SPA (`#artifacts`, `#artifacts/new`, `#artifacts/<slug>[/v<n>|@v<n>]`, `#artifacts/<slug>/diff/<a>..<b>` —
`web/src/artifacts.ts`, ported from the Claude Design `Canopy Artifacts.dc.html`, decoded copy in
`docs/superpowers/specs/artifacts-prototype/`), plus an Artifacts block on the ticket detail. The viewer's
**New version** dialog (`newVersionDialog`, over `POST /api/artifacts/:slug/versions`) edits the SHOWN version's
text (text kinds; from an older version that is a restore) or uploads a replacement file on the page's own side
(text / binary — `artAcceptNvFile` refuses the other), with the create form's size / claude.ai / flatten checks
(`contentChecks`); an unchanged save is the API's `unchanged` no-op. The contract for
agents is `docs/artifact-contract.md` (referenced by `AGENTS.md` and the `trov` / `artifacts` skills).

- **Kinds and storage**: text kinds `html` / `markdown` / `svg` / `mermaid` (≤ 750 KB of UTF-8, the `content`
  column in D1) and binary kinds `image` (png/jpeg/gif/webp only) / `pdf` / `file` (≤ 10 MB, R2 bucket
  `ARTIFACTS_BUCKET` at `artifacts/<sha256>`, put with R2's own `sha256` check). `0030_artifacts`:
  `artifact_pages` / `artifact_versions` (exactly one of `content` / `r2_key`) / `artifact_links` /
  `artifact_upload_tokens` / `artifacts_fts` (kept in sync by the repository, not triggers; bm25 like docs).
  The vocabulary, caps, status rules and wire DTOs live ONCE in `shared/artifacts-core.ts` (zod-free — the SPA
  imports it); `shared/artifacts.ts` adds the zod request schemas. The repository is `src/tools/artifacts.ts`
  (`ArtifactError` codes → 404/403/400/409/413/410); every surface calls it, none re-implements a rule.
- **Rules**: create = v1 `draft`; draft ⇄ published by anyone who can READ the page; a later version →
  `published` and clears `ratified_*`; → draft clears `ratified_*`; an identical sha256 to the current version is
  a no-op (`unchanged`). Only the AUTHOR may set `private`; a private page is readable (and writable) only by its
  author; a binary page whose upload has not landed (`current_version = 0`) exists to NO reader. Those three and
  a missing slug are ONE byte-identical not-found on every surface (HTTP, raw, MCP, query, list) — pinned by
  `test/artifacts.security-access.test.ts`. Slugs are one namespace, so allocating `<slug>-2` does reveal that a
  hidden page with that title exists (never its content or author) — a known, accepted leak.
- **`published_at`** (0035, on both DTOs) is when the CURRENT published content went live: stamped on draft →
  published (PATCH or private → org) and by every later version (it auto-publishes), kept by a PATCH that leaves
  the page published, cleared to NULL on → draft, untouched by ratify; pre-0035 pages carry their current
  version's `created_at` (a v1 published by PATCH never recorded when, so that is a lower bound).
- **Delete is SOFT** (0035 PART D; `deletePage` / `restorePage` in `src/tools/artifacts.ts`):
  `POST /api/artifacts/:slug/delete` stamps `deleted_at` / `deleted_by` and drops the page's `artifacts_fts` row in
  ONE batch — every version, every `artifact_links` row and the R2 bytes stay, so restore is lossless. Only the
  page's AUTHOR (case-insensitive) or an org ADMIN / owner, and only on a page they can SEE (an admin gets the plain
  404 on someone's private page); anyone else is 403 with nothing written. `VISIBLE_SQL` carries `p.deleted_at IS
  NULL`, so a deleted page is the ONE byte-identical not-found on EVERY surface — library, detail, diff, raw, MCP
  `artifact_get` / `artifact_list` / `artifact_update` / `upload_asset` targeting it, `query` (its hydration repeats
  the rule), `/search`, `/search/quick`, a ticket's / sprint's artifacts, My Work's "published this week", a
  record_session `artifact_links` entry (`not_found`), a signed download minted BEFORE the delete (the re-check at
  download) and an upload token minted before it (the consume re-check) — for its own author too.
  `POST /api/artifacts/:slug/restore` (same people; for anyone else a deleted page stays the one 404; a LIVE page is
  409 `artifact is not deleted`) clears both columns and re-inserts the FTS row. **The slug stays RESERVED**:
  `uniqueSlug` counts every row, so a new page with the same title gets `<slug>-2` (there is no explicit-slug
  create to 409). Both routes are session-cookie only and refuse an `Authorization` header, like ratify — there is
  NO MCP delete. On screen: "Delete artifact" at the bottom of the viewer's `…` menu (author / admins only;
  `canDeleteArtifact`), the confirmation modal, then the library with "Deleted “<title>” · Undo" (Undo →
  `artRestore` → "Restored “<title>”"). There is no list of deleted artifacts.
- **The confirmation modal** (`web/src/confirm.ts` `confirmModal`, shared by the prompt and artifact deletes; never
  `window.confirm`): a root-level `data-overlay` (so morph keeps it, and its focus, across rerenders) — a dimmed
  backdrop whose click cancels, and a centered `.cnpy-surface` `role="alertdialog"` `aria-modal="true"` labelled by
  its title and described by its explanation, with Cancel and a red Delete. Delete is FOCUSED on open, so Enter /
  Space press it; ONE capture-phase keydown listener in `main.ts` drives every `[data-confirm-dialog]` through the
  pure `confirmKeyAction`: Enter elsewhere confirms (never on a key repeat), Escape cancels and focus returns to
  `[data-confirm-trigger]`, Tab is trapped; while the write runs the button reads "Deleting…", both buttons are
  disabled and `data-busy` swallows every key (the reducers' busy guards agree — one delete, ever). Fade/scale in,
  `data-closing` plays the exit (`confirmOut`), none under reduced motion; at ≤ 640px it is a bottom sheet (the
  modal/sheet rule names `role="alertdialog"` too) with safe-area padding.
- **Ratify is the human confirm gate**: `POST /api/artifacts/:slug/ratify {version}`, session cookie only, only
  the LATEST version of a `published` page, and it refuses any request carrying an `Authorization` header. There
  is NO MCP ratify tool.
- **HTTP** (`src/artifacts/routes.ts`, mounted at `/api/artifacts`, session cookie): list (filters area, kind,
  author, status, sprint, ticket, q), get `?v=`, create (JSON text / multipart binary), PATCH, add version
  (content or `old_str`/`new_str`, which must match exactly once; multipart for binary), links add/remove,
  diff, ratify, delete / restore (`POST /:slug/delete|restore`), `upload-url`, and `POST /api/artifacts/fetch` (the From-URL tab: `src/artifacts/fetch-url.ts`,
  https only, private/loopback/link-local literals refused, every redirect hop re-checked, 5 s, 750 KB, text
  only, nothing stored — a Worker cannot resolve DNS first, so rebinding is out of its reach).
- **Two token-authenticated routes sit in `src/index.ts` BEFORE the session-gated app** (like `/u/`): the upload
  `PUT /api/artifacts/upload/:token` (`src/artifacts/upload.ts`: single use, 5 minutes, bound to principal /
  page / kind / size / sha256; stored only as a hash; a length or hash mismatch leaves it retryable) and the
  agent download `GET /api/artifacts/download/:token` (`src/artifacts/download.ts`: stateless HMAC over
  {handle, page, version, exp} keyed from COOKIE_SECRET with its own purpose label, 5 minutes, reusable, the
  page's visibility RE-CHECKED at download, exact stored bytes as an attachment with `sandbox` CSP).
- **Raw route** `GET /raw/a/:slug[@v<n>|/v<n>]` (`src/artifacts/raw.ts`, session cookie) is what the SPA frames:
  html/svg get the active CSP (inline scripts + the two CDNs, `connect-src 'none'`) PLUS `sandbox allow-scripts`,
  so an artifact opened in its own tab still runs at an opaque origin; image/pdf/file get
  `default-src 'none'; frame-ancestors 'self'`; always nosniff, `X-Frame-Options: SAMEORIGIN`,
  `Cache-Control: private`; html alone gets the injected `trov:height` postMessage script (never on
  `?download=1`). The SPA frames html as `<iframe src="/raw/…" sandbox="allow-scripts">` — never `srcdoc`, never
  `allow-same-origin` — and inlines svg ONLY through `sanitizeSvg` (DOMPurify, `web/src/markdown.ts`).
- **MCP** (every principal, `src/tools/artifacts-agent.ts`): `artifact_list`, `artifact_get` (text content inline
  up to `ARTIFACT_INLINE_MAX` = 64 KB — over it `content: null` + `content_omitted: true` unless
  `include_content: true`, and `query`'s assembled body is a one-line pointer instead; `warnings` still see
  the full text; for every kind a `download_url` + `sha256` + `size_bytes` to verify), `upload_asset` / `artifact_update`
  (text inline; binary returns an absolute `upload_url` the agent PUTs to). All carry `warnings` (never a
  rejection) for `window.claude` / `window.storage` / `api.anthropic.com`, and for a bundled Claude Design
  export (`isBundledExport` — its `blob:` scripts and `new Function` are refused by the raw CSP, so it must be
  flattened; the web create screen shows the same warning as FLATTEN FIRST). `query` has an `artifact` type
  (draft → `draft`, published/ratified → `live`; private only to the author — `query()` takes a viewer);
  `get_ticket` lists the ticket's visible artifacts; `record_session` and `/ingest` accept `artifact_links`,
  applied after the batch as direct writes (`recordBatch` in `src/consumer.ts`).
- **Skills**: `artifacts` (find / pull into `.trov/artifacts/<slug>/v<n>.<ext>` and verify the sha256 / serve an
  html one locally / link / publish), plus `trov`, `load-context` and `record-session`. `.trov/` is gitignored.
  End-to-end check against a live `wrangler dev`: `scripts/e2e/artifacts-agent.mjs` (start dev with
  `--var PUBLIC_ORIGIN:<its URL>`, or the script refuses the production-origin upload/download URLs).
- **Deferred on purpose**: external share links, per-person sharing, a raw-content subdomain, PDF text extraction
  for search.

## Doc images — uploaded, content-addressed, gate-checked (spec: `docs/superpowers/specs/2026-09-24-doc-images-design.md`)

A doc embeds an image as `![alt](/img/<sha256>)`. `0031_doc_images`: one `doc_images` row per sha256 (png /
jpeg / gif / webp, ≤ 10 MB), bytes in R2 (`ARTIFACTS_BUCKET`) at `doc-images/<sha256>` — immutable, never
deleted, so a promoted version renders the same forever. The reference format and the body scan live ONCE
in `shared/doc-images.ts` (`scanDocImages`, zod-free); the repository is `src/tools/doc-images.ts`.

- **Upload is the artifact upload's twin, through ONE tool**: MCP `upload_asset` (was `artifact_create`)
  takes `destination: "artifact"` (default, unchanged) or `"doc"` → `{ ref, markdown, sha256, uploaded }`
  plus `upload_url` / `expires_at` when the bytes are not stored yet (`uploaded: true` = no PUT, no token).
  The PUT is the SAME route, `PUT /api/artifacts/upload/<token>`: `consumeDocImageToken` claims a
  `doc_image_upload_tokens` token (single use, 5 minutes, hash-only, bound to principal + sha + size + type)
  and returns `null` for any other token, which then goes to artifacts. R2's own sha256 check; a mismatch
  releases the claim for a retry.
- **The gate** (`docImageProblems`, first in `ingestDocProposal`) — see Core invariant. `/api/docs/propose`
  answers a refusal with 400; triage assign throws it.
- **Serving**: `GET /img/<sha>` on the session-gated app — `nosniff`, `default-src 'none'; sandbox`,
  `Cache-Control: private, max-age=31536000, immutable`; 404 unknown. Agents cannot read it with a bearer
  (deferred: a signed download like `artifact_get`'s).
- **Web**: `markdown.ts` `enhance()` wraps each `/img/` image in a `.cnpy-md-img` zoom button (`docImgZoom`
  → `web/src/lightbox.ts`, the lightbox the guide uses); Review's Rendered view (`renderedPreview`) shows a
  line's images outlined green (added) / red and dimmed (removed); unified and split diffs show the text.
- There is no web upload yet (agents only, by decision) and no garbage collection.
