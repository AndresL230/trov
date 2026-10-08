# Auth, identity and people profiles

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Auth — three classes, two providers in the session class (fully built — don't add a class)

Anyone with a GitHub account can sign in (no org gate since multitenancy — what that person can then do is
`abuse-limits.md` and `organizations.md`); a Google account needs a pending invite. Three auth classes, kept
separate:

- **Session cookie** (humans, the Hono app): signed cookie; every route except the public auth paths
  passes `sessionGate`. The principal is `{ handle }`. Two providers feed ONE fork (`src/auth/onboard.ts`
  `completeSignIn`): **GitHub** (OAuth + PKCE, no gate) and **Google**
  (OAuth + PKCE, ID token verified against Google's JWKS, gated to admin **invites**). The fork: known
  identity → session; verified email matches a person → link + session; invited (or any GitHub account) →
  onboarding (a sealed 10-minute `onboard` cookie; the person row is created only on `POST /auth/onboard`
  with handle + color); else denied. Link mode (`?link=1` with a session) attaches a second provider in
  Settings; the last identity can't be unlinked.
- **Bearer token** (agents, `/mcp`): either a pasted per-person `canopy_mcp_` token (stored hashed) or an
  OAuth access token (`canopy_oat_`) obtained through Trov's own OAuth server — both resolve to the same
  (person, org) in `resolveBearerTenant` (`src/data/bearer.ts`), so OAuth is how a bearer is OBTAINED, not a
  fourth class. **A bearer is bound to ONE org** — the org on its token row / OAuth grant, never a request
  value — through a live membership check: removed member, suspended org → 401 (`docs/architecture/data-layer.md`).
  **The Settings UI is OAuth-only** (the owner's call, 2026-09-27): nothing in the SPA mints, lists or revokes a
  `canopy_mcp_` token any more — the Get connection command modal, the token list and their web client calls are
  gone. The token routes REMAIN, so a token already in use keeps working: `POST /auth/mcp-token` still mints,
  `GET /auth/mcp-tokens` lists the caller's live tokens by `token_hint` (the first 4 characters of the random
  part), and `POST /auth/mcp-tokens/:id/revoke` soft-revokes the caller's OWN token — someone else's id is the
  same 404 as an unknown one. All three are session-cookie routes, never MCP tools, with no screen in front of
  them. Settings › MCP access (`mcpAccessSection` in `web/src/render.ts`) has, beside its heading, a quiet
  "Set it up without the plugin" link that opens a MODAL (`mcpSetupModal`, `state.mcpSetup`: the confirmation
  modal's `.cnpy-cmodal` shell as a root-level `data-overlay`, focus in on open and back to the link on close,
  the backdrop / × / Escape close it, a bottom sheet on a phone) holding the by-hand
  `claude mcp add --transport http --scope user trov <origin>/mcp` (`browserConnectCommand`, no header) with a
  Copy button and the `/mcp` → Authenticate follow-up — so using it never changes the tile's height. The tile
  then reads top to bottom: one line of what it is; the browser sign-in as three steps — install the
  plugin (`PLUGIN_INSTALL`, the same two commands the Get Started guide shows), `/mcp` → trov → Authenticate,
  click Allow in the browser; then **Connected apps** (the OAuth grants — below the steps, or beside them once
  the tile is ≥ 620px, the `cnpy-mcp` container — with a count, its own empty state, a two-click Revoke per row
  and its first `MCP_LIST_CAP` (3) rows until "Show all N"; no fixed height, no inner scroller).
  The Settings screen is ONE bento grid with even edges (`.cnpy-set`, three columns): Profile | Account | MCP
  access (spanning rows 1–2 of a slightly wider third column), Appearance under the first two, Email
  notifications at full width. Every tile STRETCHES to its grid area, so tiles in a row share a top and a bottom
  and the left block ends where MCP access does; the stretch is kept small by balancing CONTENT (≤ ~30px at
  common widths with two connected apps), and a `.cnpy-tile` is a flex column whose `.cnpy-tile-foot` (Profile's
  color, Account's sign-in methods) is pinned to the bottom edge. Below a 1000px page it is two columns (Profile
  | Account, then Appearance and MCP access at full width), and a phone is one column. `/mcp` is **bearer-only**; its `401` carries
  `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource"` (plus
  `error="invalid_token"` when a token was presented), which is how Claude Code and claude.ai discover
  sign-in. A fresh `McpServer` is constructed per request
  (SDK ≥1.26 guards against reuse); `createMcpHandler` is stateless (no Durable Object / McpAgent).
- **MCP OAuth** (`src/auth/oauth.ts` core, `oauth-routes.ts` HTTP, `oauth-pages.ts` pages; spec
  `docs/superpowers/specs/2026-09-24-mcp-oauth-design.md`; migration `0029_oauth`): RFC 9728/8414 metadata,
  RFC 7591 registration (public clients, loopback redirects match on any port), authorization code + S256
  PKCE, a server-rendered consent page shown on EVERY authorization (CSRF = HMAC over session + request),
  access 1 h; refresh tokens rotate with a 60 s reuse interval — a reuse past that window revokes the
  whole grant — and a rotated refresh token is kept until its OWN expiry (90 days idle), so a late reuse
  is still caught. Sign-in from
  an authorize link survives GitHub/Google and onboarding via the sealed `oauth_pending` cookie. Settings ›
  MCP access lists connections (`GET /auth/oauth-grants`, `POST /auth/oauth-grants/:id/revoke` —
  cookie-only, never MCP). `pruneOAuth` rides the repo cron's `:30` tick and deletes spent or expired
  codes, access tokens a day past expiry, refresh tokens past expiry, and client registrations that never
  got a grant after 90 days (`UNGRANTED_CLIENT_TTL_MS` — long enough that a person denied at authorize,
  e.g. not yet invited, still finds their registration on a retry days later) — grants themselves are never
  deleted. An unknown `client_id` at authorize is an error PAGE naming the Claude Code fix (`/mcp` → trov
  → Clear authentication → Authenticate again), never a silent redirect. Every OAuth endpoint answers an unexpected error
  with `503 { error: "temporarily_unavailable" }` (the authorize pages with a 503 error page), never a 500.
- **GitHub webhook** (`POST /webhook/github/:hookId`, `src/github-hook.ts` → `src/webhook.ts`): `hookId` is
  the repo's `org_repos.id`; a delivery authenticates by an HMAC-SHA256 `X-Hub-Signature-256` over the raw
  body against THAT repo's `github_webhook` secret (NOT `COOKIE_SECRET`), must name that repo (else 202,
  ignored), and is captured as that org's system tenant. The legacy `POST /webhook/github` delivers only to
  the `legacy_hook` repo (SaplingLearn's, on `GITHUB_WEBHOOK_SECRET` until its admin stores a secret). HMAC is
  verified in the branch BEFORE the gate; a bad/absent signature (or no secret) is a bare `401` that writes
  nothing — and an unknown or suspended hook id is that SAME bare `401` (hook ids cannot be probed). The
  writer principal is the fixed string `"github-webhook"`; the delivery's own `subject_login` is trusted
  only post-verify. This branch never touches `sessionGate`.
- **The GitHub App** (`src/github-app/`, `0043_github_app`; the whole of it — the connect flow and why a
  forged `installation_id` cannot bind, tokens, the webhook, permissions, the owner checklist — is
  `docs/architecture/github-app.md`; keep the detail THERE). An org connects GitHub by installing the App:
  `GET /api/o/:slug/github/install` → GitHub → `/auth/callback` (the install return, recognised by
  `installation_id` / `setup_action`). Every GitHub read resolves its credential with
  `resolveGithubCredential` — the org's installation token, then its stored `github_token`, then
  SaplingLearn's legacy secret — never with a bare `resolveCredential(…, "github_token", …)`. The App's ONE
  webhook is `POST /webhook/github/app` (`GITHUB_APP_WEBHOOK_SECRET`; the same bare 401). Nothing reachable
  from `src/mcp.ts` may import `src/github-app/` (`test/secrets.mcp.test.ts`).

## Identity — persons, not logins

`persons` (handle PK; name, color, email) is the root — the handle is chosen at first sign-in, prefilled
with the GitHub login, and renameable from Settings (`renamePerson` rewrites every stored handle
atomically via `HANDLE_COLUMNS`, in one D1 batch with FK checks deferred for the transaction).
`identities(provider, subject) → person` holds the GitHub login and Google `sub`. Event subjects
(`events.subject_login`) resolve to a person through the github identity row at read time
(`resolvePersonForLogin`); an unmapped login raises an `identity_tasks` row and Org settings › Members
(its Unmatched logins section, `web/src/identity.ts`) links it to an existing handle. Mapping a login there calls the same `linkIdentity` as sign-in linking, so
it also grants that GitHub account sign-in as the mapped person, not just attribution — there is no undo
route yet; fix a wrong mapping by deleting the `identities` row with `wrangler d1 execute`. A login that will
never be a person (an outside contributor's PR) is DISCARDED instead: `POST /identity-tasks/:login/discard`
(session cookie, like map; 404 unknown, 409 on a mapped task, idempotent) sets `status = 'discarded'` + the
`resolved_at` / `resolved_by` audit columns — soft, and STICKY for free: the row keeps the login's PK, so
`ensure_identity_task`'s `INSERT OR IGNORE` never re-raises it, while its events are captured as before.
`POST /identity-tasks/:login/restore` puts it back to `pending` (409 once the login has been linked some other
way); `GET /identity-tasks` returns `{ tasks, discarded }` (discarded minus since-linked logins). On screen:
Discard on each card (no confirm), a "Discarded @login · Undo" toast, and an "N discarded" list with Restore. Admin is the org role on
the membership, which a rename carries — there is no allowlist of handles.
Every `recorded_by` / `created_by` / `user_id` is a handle. Migrated GitHub users kept their login as handle.
`docs.owner` (0035) is one too — the proposer of a doc's FIRST version, set once at creation and never
overwritten by edits or promotions (`updated_by` is the last promoter) — listed in `HANDLE_COLUMNS`; there is no
route to change it yet.

## People profiles — an avatar, a role, responsibilities (`0036_person_profiles`; contract `shared/people.ts`)

Three nullable person fields, written directly (no gate, no staging) by `src/tools/people.ts`:

- **The avatar rule is ONE function, `avatarSrc`** (`shared/people.ts`): an UPLOADED avatar (`persons.avatar_sha`
  → `/avatar/<sha>`) outranks the provider picture (`persons.avatar_url`), else null (initials). **The provider
  picture has ONE owner, `persons.avatar_source`** (0036 PART B): onboarding records it, a NULL picture is claimed by
  the first sign-in that brings one, only a sign-in with THAT provider refreshes it (`recordSignIn`), and one with the
  other provider — or linking it in Settings — never touches it, so a person's picture never flips with how they
  signed in; unlinking the owning provider sets `avatar_source` NULL so the remaining one takes over. A sign-in
  never writes `persons.name` either (onboarding seeds it, Settings edits it) and never touches `avatar_sha`.
  Every DTO that sends a person's picture to
  the SPA sends it RESOLVED — `GET /persons` (`listPersons`, now `PersonSummary` with `role`), `GET /auth/me`
  (+ `role`), the profile, `/search/quick`'s person hits — so a new surface must go through `avatarSrc` too.
- **Upload** (`POST /api/people/me/avatar`, multipart `file`; the viewer's OWN only — there is no upload for
  someone else): the declared type must be in `AVATAR_TYPES` (png / jpeg / webp / gif) AND the magic bytes must say
  the same type (`sniffAvatarType` — the declared type is never trusted), ≤ `AVATAR_MAX_BYTES` (2 MB, else 413),
  sha256 via Web Crypto, bytes in R2 (`ARTIFACTS_BUCKET`) at `avatars/<sha256>` with R2's own sha256 check and the
  SNIFFED type as `httpMetadata.contentType` — skipped when that object already exists. Returns `{ ok, avatar_url }`.
  `POST /api/people/me/avatar/remove` only clears `avatar_sha` (returns the picture that now shows); the bytes are
  immutable and never deleted, like doc images. There is no avatars table: the R2 object's metadata is the type.
- **Serving** `GET /avatar/<sha>` (session-gated, beside `/img/<sha>` and exactly like it): `nosniff`,
  `default-src 'none'; sandbox`, `Cache-Control: private, max-age=31536000, immutable`; 404 for a malformed sha,
  no object, or a stored type outside `AVATAR_TYPES`.
- **Person card read** `GET /api/people/:handle` (session cookie; `me` = the viewer; an unknown or RESERVED handle
  is 404): `PersonProfile` — role, GitHub login, joined, `admin`, `editable` (the VIEWER is an admin), `self`, and
  nothing else (no tickets, sessions or docs — there is no profile page) — the person and their GitHub login in ONE
  `db.batch`. A D1 failure is 503 `{ error }`, never a 500.
- **`responsibilities` is never rendered.** It travels only to admins (Org settings › Members' editor
  fills from it) and to MCP `list_people` — not even to the person themselves.
- **Role and responsibilities are ADMIN-set** (the owner's call, 2026-09-27): a person changes only their own photo
  (and name / color / handle, as before). **Write** `PUT /api/people/:handle` (`PersonProfileWrite`): an admin
  (the org role) only — anyone else, the person themselves included, is 403 with nothing written. Trimmed; absent = untouched, `""` / null / whitespace clears; over
  `ROLE_MAX` (80) / `RESPONSIBILITIES_MAX` (2000) is 400 and writes NOTHING (every field is validated before the
  one UPDATE). Returns the fresh profile. Name and color stay on `PUT /auth/me`.
- **MCP gets ONE read, `list_people`** (every principal): `{ people: [{ handle, name, role, responsibilities }] }`
  for every non-reserved person — nothing else about a person (no avatar, no load, no profile), and NO people
  write of any kind. Its description, `create_ticket`'s and the `tickets` / `trov` skills tell an agent to read
  it before choosing `assignees`, and that a null is unknown, never to be guessed.
- `scripts/seed/reset.mjs` seeds a role + responsibilities for the six dev/test persons.
- **On screen there is NO People screen and no profile page** (the owner's call, 2026-09-27): a click on anyone's
  name — the ticket rail's people, Feed authors, quick search's person hits, Org settings › Members' rows — opens the
  **person card** (`personCardModal`, `web/src/profile.ts`): a modal in the confirm modal's `.cnpy-cmodal` shell,
  rendered at the app root (`state.personCard`), with the large avatar, name, handle and role painted at once from
  `GET /persons`, then joined / GitHub / the admin badge when `GET /api/people/:handle` lands; the backdrop, × and
  Escape close it, and one's OWN card links to Settings (photo, name). Role + responsibilities are edited in ONE place: Org settings › Members, where
  an admin's "Edit" opens `memberEditor` (`web/src/org-settings.ts`) under that row. Settings › Profile uploads a photo (center-cropped, ≤ 512px, WebP/PNG in the browser before
  the POST — so a GIF loses its animation) and removes one (shown only for an `/avatar/` URL) — both from a small
  menu the AVATAR opens (`.cnpy-avbtn`: a camera veil on hover / focus, a spinner while a write is in flight, when
  it won't open; Escape closes, ↑/↓ move); it has no role or responsibilities field. A `personChip` whose image fails to load shows the initials under it. **Every name or
  avatar opens the card** (`web/src/people.ts`): photo + name as ONE chip where both fit (`personLink`), a photo alone
  (`personAvatarLink`, and `avatarStack(…, linked)`), a name or `@handle` in a line of text (`personNameLink` /
  `handleLink`) — each resolved through `GET /persons` case-insensitively, so an unknown handle, a bot, the GitHub
  mirror's `github-webhook` and Repo sample data stay plain. A card or row that opens something else (queue rows and
  board cards, sprint ticket boxes, handoff rows, prompt and artifact cards, the Feed's review rows) is a plain
  container whose own target is an empty button laid over it (`ui.ts` `hitArea` + `HITBOX`), with the people above it
  — never a button inside a button. Left plain on purpose: pickers and filter menus (a click there selects), the
  Review and Unplaced list rows (select buttons; their detail pane links the person), menu rows, anything inside a
  link (a Repo PR row, a ticket's artifact chip), tooltips, the ratify dialog's "Recorded as", the sidebar's account
  chip (it opens Settings), the onboarding preview and the landing page.
