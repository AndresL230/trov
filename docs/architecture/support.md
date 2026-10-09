# Support reports — a bug report or a message to the people who run Trov

A signed-in person writes to the platform's operator from inside the app; the operator (a superadmin) reads
the reports in Platform › Support and is mailed each one. Migration `0049_support_reports.sql`; code
`shared/support-core.ts` + `shared/support.ts`, `src/platform/support.ts` (repository),
`src/platform/support-routes.ts`, `src/notifications/support.ts` (the mail), `web/src/support.ts` +
`support-actions.ts` (the dialog), `web/src/platform-support.ts` + `platform-support-actions.ts` (the tab).
Tests: `test/support.routes.test.ts`, `test/render.support.test.ts`.

## What a report is

| Typed by the person | Attached for them, and shown before they send |
|---|---|
| a kind: `bug`, `question` or `feedback` | the screen: the route hash (`#tickets/7`) |
| a subject (optional, 140 characters) | the organization's slug, if they are inside one |
| a message (required, 5,000 characters) | the app version: the top entry of `web/src/releases.ts` |
| | the browser's user agent |

**Nothing else is captured** — no page content, no organization data, no console, no screenshot. The dialog
says so, and the Privacy Policy (`web/src/legal.ts` › What we collect) says the same sentence. Adding a
field means changing all three: the dialog's read-only block, the policy, and this table.

- A report with no subject is filed under its message's first line (`supportSubjectFrom`).
- What the person typed is **refused** past its cap (400; the dialog keeps their text). What was attached is
  **cut** to its cap and flattened to one line, never refused.
- **The reporter is the session's person** (`p.actor`); nothing in the body names one, and unknown keys are
  dropped by the schema.
- **The organization is kept only if the caller is a member of it** (`resolveTenant` — the tenant gate's
  own one statement, so a suspended org reads as none). Another org's slug, or an unknown one, is stored as
  "outside an organization": the form cannot be used to claim a membership or to learn that a slug exists.

## Storage — a GLOBAL table

`support_reports` has no `org_id` (the org it came from is `from_org` + `from_org_slug`, named that way on
purpose: `data-layer.md` › Which tables are which). It is reached only through `src/data/platform-sql.ts`.
`reporter` and `resolved_by` are person handles, both in `HANDLE_COLUMNS`, so a rename rewrites them. The
reporter's e-mail is **not** stored on the row: the reader joins the newest provider-verified address
(`identities.verified_email`) when it shows or mails a report, so a reply always goes to an address a
provider vouched for and never to the editable notification address.

`status` is `open` or `resolved` (`resolved_by`, `resolved_at`); resolving twice keeps the first resolver,
reopening clears both. Nothing resolves a report but a superadmin pressing Resolve. There is no delete.

## Routes — session cookie only, never MCP

| Route | Who | Notes |
|---|---|---|
| `POST /api/support` | any signed-in person, with or without an org | person-level (`isPlatformPath`), so never the alias gate's 409; refuses a request that carries `Authorization`; 201 `{ ok, id, reply_to }` |
| `GET /api/platform/support?status=&kind=&before=&limit=` | superadmin | newest first; `next_before` continues the list; `open` is every open report whatever the filter |
| `GET /api/platform/support/:id` | superadmin | |
| `POST /api/platform/support/:id/resolve`, `…/reopen` | superadmin | |

The four Platform routes are registered on `platformApp`, behind its gate: 404 `not_found` for anyone who is
not a superadmin, the reporter included. **Signed out there is no form** — a public one is a spam and
mail-abuse surface. The site keeps its `mailto:` (`SITE_CONTACT`).

**Rate limit:** `support`, 10 a person a UTC day (`abuse-limits.md`), taken after validation — a refused
body spends nothing. 429 with `Retry-After`, like the others. A superadmin is exempt, as everywhere.

**A superadmin still has no way into an organization.** A report holds what its reporter typed plus a slug
and a route; the read joins `persons`, `identities` and `orgs` (all global) and names no tenant table — the
static data-layer test would fail if it did.

## The mail to the operator

`sendSupportNotice` (`src/notifications/support.ts`), through `platformDeliveryFor` — the platform's own
From, and in local mode the global `platform_outbox_bodies` table. It is the grant notice's shape
(`notifications.md`): `emailBanner`, `emailCardOpen`, `EMAIL_MOBILE_CSS`.

- **Recipient:** the var `SUPPORT_NOTIFY_EMAIL` (`env.md`). Empty or absent → nothing is sent and the
  outcome is `skipped`; the report is stored either way.
- **Subject:** `[Trov bug] <subject>` (`supportMailSubject`), flattened to one line.
- **Reply-To:** the reporter's provider-verified address (`OutboundMessage.replyTo` → Resend's `reply_to`),
  so replying answers them. With no verified address there is no Reply-To and the mail says so.
- **Body:** the message, who sent it (name, handle, address), organization, screen, version, browser, and a
  link to the report: `<origin>/platform/#platform/support/<id>`.
- **Outcome on the row:** `mail_status` `sent` / `failed` / `skipped`, `mail_at`, `mail_error`. The provider
  key is scrubbed out of an error (`scrubbedMessage`) BEFORE it is cut to 500 characters.
- **It can never fail the submission:** the report is written first; the mail, the reads it needs and the
  write of its outcome all sit behind a guard. A failed mail is visible in Platform on the report.

## The dialog (`web/src/support.ts`)

Help has two rows in the sidebar, **Report a bug** and **Contact support**; both open ONE dialog (a
root-level `data-overlay="support"`) on a different kind, and a `segmented()` switch changes it (Bug,
Question, Feedback). The org picker's foot has the same link, for a person with no organization.

- **Typing never repaints the page behind.** The dialog opens over any screen, and most screens are rebuilt
  by `rerender()`; so inside the open dialog `support-actions.ts` `repaint()` patches the overlay element
  alone (`web-ui.md`). For that the form's structure is stable: the error and the counter are always
  emitted and shown by attribute; the sent state is a different body, replaced by `data-morph-key`.
- A draft closed with Escape is kept until it is sent or the page is reloaded.
- States: Send is inert until there is a message; sending disables everything; a failure says why in an
  alert and keeps the text; sent says "Sent. We read every one; replies come to <address>" (or that no
  verified address is on file). ⌘/Ctrl+Enter sends, Escape closes (not mid-send), Tab stays inside.

## Platform › Support (`web/src/platform-support.ts`)

A tab of the Platform page with the count of **open** reports on it (read with the page, so it shows on every
tab). The list: a status switch (`segmented()`: Open, Resolved, All — Open by default), a kind `dropdown()`,
and a table (kind, subject, who, organization, when, status), 50 a page with "Show older reports". A row
opens the report in the tab's panel at `#platform/support/<id>` (the same page as the tab, `pageKey`): the
whole message, the attached context, what became of the mail, **Resolve** / **Reopen**, and **Reply by
email** — a `mailto:` to the reporter's verified address with `Re: [Trov bug] <subject>` prefilled; absent
when there is no address. Loading is a skeleton, a failed read an error line with a retry, an unknown id
says so.

## Owner steps on deploy

1. The migration is additive; a push applies it (`HANDOFF.md`).
2. Set `SUPPORT_NOTIFY_EMAIL` in `wrangler.toml` `[vars]` to the inbox that should get the reports. Until
   then reports are stored and shown in Platform, not mailed.
