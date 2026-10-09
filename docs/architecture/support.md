# Support reports — a bug report or a message to the people who run Trov

A person writes to the platform's operator from inside the app, or — signed out — from the site's Contact
form; the operator (a superadmin) reads the reports in Platform › Support and is mailed each one. Migration
`0049_support_reports.sql`; code `shared/support-core.ts` + `shared/support.ts`, `src/platform/support.ts`
(repository), `src/platform/support-routes.ts`, `src/notifications/support.ts` (the mail),
`web/src/support.ts` + `support-actions.ts` (the dialog), `web/src/platform-support.ts` +
`platform-support-actions.ts` (the tab). Tests: `test/support.routes.test.ts`, `test/render.support.test.ts`.

## Where it is opened

| Who | Entry | Opens on |
|---|---|---|
| signed in | the **bug icon button** in the app header, top right, beside the theme toggle (every screen the header shows on) | Bug |
| signed in | **Settings › Help › Contact support** (a tile of the personal Settings bento) | Question |
| signed in, no organization | **Contact support** in the org picker's footer (the picker has no header and no way to Settings) | Question |
| signed out | **Contact** in the site footer: on the landing page it opens the dialog; on `/pricing`, `/terms`, `/privacy` (static pages) it is a link to `/?contact=1`, which opens it on the landing page | Question |

The sidebar has no entry: its Help section is Guide and What's new. A signed-in person who follows
`/?contact=1` gets the signed-in dialog when boot lands them in place.

## What a report is

| Typed by the person | Attached for them, and shown before they send |
|---|---|
| a kind: `bug`, `question` or `feedback` | **signed in:** the screen (the route hash, `#tickets/7`), the organization's slug if they are inside one, the app version (the top entry of `web/src/releases.ts`), the browser's user agent |
| a subject (optional, 140 characters) | **signed out:** the page (its path and hash, `/pricing`) and the browser — the request's own `User-Agent` header |
| a message (required, 5,000 characters) | |
| **signed out only:** an email address to reply to (required, 254 characters, one plain address) | |

**Nothing else is captured** — no page content, no organization data, no console, no screenshot, no IP
address. The dialog says so, and the Privacy Policy (`web/src/legal.ts` › What we collect) says the same.
Adding a field means changing all three: the dialog's read-only block, the policy, and this table.

- A report with no subject is filed under its message's first line (`supportSubjectFrom`).
- What the person typed is **refused** past its cap (400; the dialog keeps their text). What was attached —
  and anything read from a header — is **cut** to its cap and flattened to one line, never refused.
- **Signed in, the reporter is the session's person**; nothing in the body names one, and unknown keys are
  dropped by the schema.
- **The organization is kept only if the caller is a member of it** (`resolveTenant` — the tenant gate's
  own one statement, so a suspended org reads as none). Another org's slug, or an unknown one, is stored as
  "outside an organization".

## Storage — a GLOBAL table

`support_reports` has no `org_id` (the org it came from is `from_org` + `from_org_slug`, named that way on
purpose: `data-layer.md` › Which tables are which). It is reached only through `src/data/platform-sql.ts`.

- `reporter` and `resolved_by` are person handles, both in `HANDLE_COLUMNS`, so a rename rewrites them.
- A row has **exactly one** of `reporter` (signed in) and `contact_email` (signed out) — a CHECK.
- A signed-in reporter's e-mail is **not** stored: the reader joins the newest provider-verified address
  (`identities.verified_email`), so a reply goes to an address a provider vouched for and never to the
  editable notification address.
- `contact_email` is **unverified, as typed**. It is shown labelled so everywhere (Platform, the notice),
  is never written to `persons` or `identities`, and never becomes an identity or matches an invitation.

`status` is `open` or `resolved` (`resolved_by`, `resolved_at`); resolving twice keeps the first resolver,
reopening clears both. Nothing resolves a report but a superadmin pressing Resolve. There is no delete.

## Routes — never MCP

| Route | Who | Notes |
|---|---|---|
| `POST /api/support` | session: any signed-in person, with or without an org | person-level (`isPlatformPath`), so never the alias gate's 409; 201 `{ ok, id, reply_to }` |
| `POST /api/support/public` | **public** (no session) | the Contact form; 201 `{ ok, reply_to }` — no id. With a session cookie it is the signed-in path: the principal is the reporter, the typed address is ignored, the `support` limit applies |
| `GET /api/platform/support?status=&kind=&before=&limit=` | superadmin | newest first; `next_before` continues the list; `open` is every open report whatever the filter |
| `GET /api/platform/support/:id` | superadmin | |
| `POST /api/platform/support/:id/resolve`, `…/reopen` | superadmin | |

Both `POST`s refuse a request that carries `Authorization`. The four Platform routes are registered on
`platformApp`, behind its gate: 404 `not_found` for anyone who is not a superadmin, the reporter included.

**The public route is not a fourth auth class.** It is an unauthenticated public route, admitted like the
other public paths (`PUBLIC_PATHS` in `src/auth/principal.ts`, beside `/api/billing/config`), and it reads
the session itself (`resolveSessionPrincipal`) to tell a signed-in sender. What bounds it is the whole of
`abuse-limits.md` › The signed-out contact form:

- **No mail is ever sent to the address typed.** The only mail is the notice to `SUPPORT_NOTIFY_EMAIL`; the
  typed address is its `Reply-To`.
- **Limits** (`LIMITS`): `support_anon_ip` 3 a client address a UTC day — the subject is
  `ip:<HMAC-SHA256 of the address under COOKIE_SECRET>`, never the address — then `support_anon_all` 50 a
  UTC day for every signed-out report together. Past the first: 429 `rate_limited` with `Retry-After`. Past
  the second: 429 `support_closed` with `contact`, and the form says to write to `hello@trov.dev` instead.
- **Honeypot** (`website`): a field off screen, `tabindex="-1"`, `autocomplete="off"`, hidden from assistive
  technology. A body that fills it is answered 201 exactly like a success; nothing is stored, counted or mailed.
- **Time on the form:** `elapsed_ms` under 3,000 (or absent) is 400 `too_fast`; the dialog says to send again.
- **Shape:** the body must be `application/json`; every field is capped by zod (`SupportPublicSubmit`); the
  address is one plain address (no space, comma, semicolon, colon, quote, angle bracket or backslash).
- **No third-party script.** If spam shows up, Cloudflare Turnstile on this one form is the next step.

**Rate limit, signed in:** `support`, 10 a person a UTC day, taken after validation. A superadmin is exempt.

**A superadmin still has no way into an organization.** A report holds what its reporter typed plus a slug
and a route; the read joins `persons`, `identities` and `orgs` (all global) and names no tenant table — the
static data-layer test would fail if it did.

## The mail to the operator

`sendSupportNotice` (`src/notifications/support.ts`), through `platformDeliveryFor` — the platform's own
From, and in local mode the global `platform_outbox_bodies` table. It is the grant notice's shape
(`notifications.md`): `emailBanner`, `emailCardOpen`, `EMAIL_MOBILE_CSS`.

- **Recipient:** the var `SUPPORT_NOTIFY_EMAIL` (`env.md`), and nobody else. Empty or absent → nothing is
  sent and the outcome is `skipped`; the report is stored either way.
- **Subject:** `[Trov bug] <subject>` (`supportMailSubject`): the subject is at most 140 characters and the
  whole line is flattened (no CR / LF), so a typed subject cannot add a header.
- **Reply-To:** signed in, the reporter's provider-verified address; signed out, the address typed
  (`OutboundMessage.replyTo` → Resend's `reply_to`). With neither there is no Reply-To and the mail says so.
- **Body:** the message, who sent it — name, handle, address, or "Signed out · <address> (unverified, as
  typed)" — organization, screen or page, version, browser, and a link to the report:
  `<origin>/platform/#platform/support/<id>`. **Everything typed is HTML-escaped** — signed out it is a
  stranger's text rendered as HTML — and the only links in the mail are Trov's own.
- **Outcome on the row:** `mail_status` `sent` / `failed` / `skipped`, `mail_at`, `mail_error`. The provider
  key is scrubbed out of an error (`scrubbedMessage`) BEFORE it is cut to 500 characters.
- **It can never fail the submission:** the report is written first; the mail, the reads it needs and the
  write of its outcome all sit behind a guard. A failed mail is visible in Platform on the report.

## The dialog (`web/src/support.ts`)

ONE dialog, a root-level `data-overlay="support"`, with a `segmented()` switch for the kind (Bug, Question,
Feedback). Signed in it is the app's modal (`.cnpy-cmodal`). Signed out (`anonymous`) it is the same form
in the sign-in dialog's plain card (`.site-signin-back` / `-wrap` / `-card`, wider as `.site-contact-card`),
over the landing page — which is `data-morph="landing"` — with the email field first and the honeypot.

- **Typing never repaints the page behind.** The dialog opens over any screen, and most screens are rebuilt
  by `rerender()`; so inside the open dialog `support-actions.ts` `repaint()` patches the overlay element
  alone (`web-ui.md`). For that the form's structure is stable: the error and the counter are always
  emitted and shown by attribute; the sent state is a different body, replaced by `data-morph-key`.
- A draft closed with Escape is kept until it is sent or the page is reloaded.
- States: Send is inert until there is a message (and, signed out, an address); sending disables
  everything; a failure says why in an alert and keeps the text; sent says "Sent. We read every one;
  replies come to <address>" — signed out, "Sent. We'll reply to <address>." ⌘/Ctrl+Enter sends, Escape
  closes (not mid-send), Tab stays inside (the honeypot is never a stop).
- Focus returns to the control that opened it (`data-support-trigger`).

## Platform › Support (`web/src/platform-support.ts`)

A tab of the Platform page with the count of **open** reports on it (read with the page, so it shows on every
tab). The list: a status switch (`segmented()`: Open, Resolved, All — Open by default), a kind `dropdown()`,
and a table (kind, subject, who, organization, when, status), 50 a page with "Show older reports". A row
opens the report in the tab's panel at `#platform/support/<id>` (the same page as the tab, `pageKey`): the
whole message, the attached context, what became of the mail, **Resolve** / **Reopen**, and **Reply by
email** — a `mailto:` with `Re: [Trov bug] <subject>` prefilled; absent when there is no address. Loading is
a skeleton, a failed read an error line with a retry, an unknown id says so.

**A report sent signed out** carries a `SIGNED OUT` badge in the list and on the report, shows the typed
address where the person would be — labelled `(unverified, as typed)` on the report — and Reply by email
uses it. Its context is the page and the browser; there is no organization and no version.

## Owner steps on deploy

1. The migration is additive; a push applies it (`HANDOFF.md`).
2. Set `SUPPORT_NOTIFY_EMAIL` in `wrangler.toml` `[vars]` to the inbox that should get the reports. Until
   then reports are stored and shown in Platform, not mailed.
