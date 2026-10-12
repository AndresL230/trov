# Email notifications

<!-- Moved verbatim out of CLAUDE.md (2026-10-07). This is the detailed reference; CLAUDE.md keeps only what applies to every change. Keep it current when you change the area. A reference to another section ("see Core invariant", "the Repo dashboard section below") now means another file in this folder — see the table at the bottom of CLAUDE.md. -->

## Email notifications — a read-side projection, never a writer (spec: `docs/superpowers/specs/2026-09-11-canopy-email.md`)

Digests are assembled from D1 and sent via Resend; the pipeline never writes to the store (only to its own
`notification_*` tables). Everything lives in `src/notifications/`:

- **Registry in code, not D1** (`registry.ts` + `shared/notifications.ts`): one `NotificationKind` per digest
  section — `my_work` (event spine: merged PRs in the window + open assigned issues, summarized exactly as My
  Work does), `review_queue` (open Proposals + draft Decisions), `roadmap_plan` (diffs `plan_versions` in the
  window against the last pre-window version; progress rows never surface), `ticketq` (the ticket queue, not
  window-scoped: `submitted` tickets with no assignees org-wide + the recipient's own open assigned tickets via
  `listAssignedTickets`, the same read My Work uses). A renderer is a **pure read**
  (`render(ctx, userId, window)` → `Section | null` — `ctx` is the org's tenant context; null = nothing to say, dropped). Adding a kind = one entry +
  one renderer; `notification_policy` rows are PER ORG, seeded from the registry: `createOrg` writes one row
  per kind for a new org, and the digest cron tops each org up with any kind it has no row for
  (`ensureNotificationPolicySeeded` in `policy.ts`, called by `runOrgNotifications`: INSERT OR IGNORE, never
  overwrites, memoized per org for the isolate's lifetime). There is no seed at Worker start-up any more.
- **Cadences are `daily` / `weekly` / `off` — there is NO immediate tier.** Resolution (`resolve.ts`): user pref
  → policy `default_cadence` → registry default; `policy.enabled = 0` short-circuits to `off` before the user
  layer. A pref must be in the kind's `allowedCadences` (validated at write time).
- **Runs** (`run.ts`): one digest per (person, org). Per eligible user (a MEMBER of the org, address on file,
  `email_unsubscribed = 0`) the outbox row is claimed FIRST by `INSERT OR IGNORE` on `outboxKey`,
  `org:user:cadence:window_id` — a conflict skips the user, so a double fire is harmless. (A row written
  under the pre-organizations key `user:cadence:window_id` in the same org counts as the same send:
  `preOrgOutboxKey`, cut-over code.) Then render, drop nulls, `skipped` on zero sections, else one message → `sent` (with `resend_id`)
  or `failed` (with the error). `retry.ts` re-attempts `failed` rows only. Windows (`window.ts`) are computed
  in the org timezone: daily = previous 24h (72h on Monday), weekly = previous 7 days.
- **Cron** (`cron.ts`, `wrangler.toml [triggers]`): two hourly triggers (`0 * * * *` daily candidate,
  `0 * * * SUN,MON` weekly candidate) dispatched by expression in `scheduled()`, gated in code on
  `notification_settings.send_hour` + `timezone` at fire time (static crons cannot read D1 or follow DST).
- **Delivery gate** (`resend.ts`): `NOTIFICATIONS_MODE` absent/`local` → bodies go to the dev-only
  `notification_outbox_bodies` table and Resend is NEVER called; `resend` requires `RESEND_API_KEY` (a config
  error otherwise, never a silent fallback). A message with an `unsubscribeUrl` (a NOTIFICATION — see Who
  gets what) gets `List-Unsubscribe: <https://…/u/<token>>` and `List-Unsubscribe-Post:
  List-Unsubscribe=One-Click` (`unsubscribeHeaders`): RFC 8058 one-click, the https link ALONE. There is no
  `mailto:` alternative on purpose — nothing reads the sending mailbox for unsubscribe requests, and an
  advertised way out must work by itself. (Re-adding one needs inbound processing or a mailbox runbook.)
- **Unsubscribe** (`unsubscribe.ts`, page `unsubscribe-page.ts`): `/u/<handle.sig>` (HMAC over the handle with
  `COOKIE_SECRET`, namespaced `unsub:`) is the single signed-token exception for mail — handled in
  `src/index.ts` (`handleUnsubscribe`) outside `sessionGate`. The token is the whole authority: it names ONE
  person and can ONLY set their `email_unsubscribed = 1`, whoever is signed in in that browser (a session is
  never read). It is both the footer link and the `List-Unsubscribe` target of every notification.
  - **GET / HEAD changes nothing** — mail scanners and link previews fetch every link. It is a server page
    (no SPA, no sign-in): who the link is for (name, `@handle`, the digest address masked `u•••@domain`),
    what unsubscribing stops and what still arrives (`shared/email-unsubscribe.ts`, the same words as
    Settings), and a button — a form POSTing to `/u/<token>?confirm=1`. Already unsubscribed: says so, no
    button, and points at Settings to turn email back on. Every state links Settings (`/#settings`, behind
    sign-in) for finer control. The page loads NOTHING (system fonts, no script, image or stylesheet);
    headers: CSP `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors
    'none'`, `Referrer-Policy: no-referrer` (the token is in the URL), `Cache-Control: no-store`,
    `X-Robots-Tag: noindex` plus a `robots` meta.
  - **POST `?confirm=1`** (the page's button): sets the flag, then `303` back to `/u/<token>`.
  - **POST without it** is a mail client's RFC 8058 one-click: sets the flag, `200 { ok: true }` (unchanged).
  - A token that does not verify (another key, a session-style seal, a swapped handle, garbage) writes
    nothing: GET is a "This link doesn't work" page (404), either POST is `401`. A genuine token for a handle
    nobody holds any more (renamed since) is the same 404 page. Other methods `405`. A D1 failure is a 503
    (page or `{ error }`), never a 500, logged scrubbed.
  - Prefs and the address survive unsubscribe; Settings › Email notifications' switch turns it back on.
    The in-app `#unsubscribe` screen is gone (it turned the SIGNED-IN person's mail off on arrival, so a
    link to it unsubscribed whoever clicked): the old address now just opens Settings (`web/src/hash.ts`).
  - Known edge: handles are renameable and a freed handle can be taken, so an OLD mail's token names
    whoever holds that handle now. The page shows who it names; the one-click cannot. Binding tokens to
    something stabler than the handle would need a new token format (old links must keep working).
- **HTTP** (`routes.ts`, mounted at `/api/notifications`, session-cookie only, NEVER MCP): `prefs` (GET/PUT,
  own row only), admin-only `policy`, `settings`, `outbox`, `persons/:handle`.
- **Address**: seeded at first sign-in, per provider — GitHub from `GET /user/emails` (primary +
  verified; scope `user:email`), Google from the verified `email` claim on the ID token (unverified
  emails are denied before the fork) — both through `recordSignIn`'s `COALESCE(email, …)` write, which
  never overwrites a user/admin-edited value.
- **Invite email** (`src/notifications/invite.ts`, sent by `mailInvite` in `src/orgs/mail.ts`): one
  transactional message per e-mail invite/resend through `deliveryFor`, as the inviting org; not a kind — no
  cadence, prefs, or window. Outcome lands on the invite's own row: `org_invites.mail_status` / `mail_at` /
  `mail_error`. No
  `List-Unsubscribe` headers (they are optional on `OutboundMessage` now, omitted for invites). It goes
  whatever the address's flag says, and its footer says why it came ("…invited this address to <org>: a
  one-off email, not a mailing list").
- **Welcome email** (`src/notifications/welcome.ts`): a NOTIFICATION, not transactional mail — it carries the
  person's unsubscribe link (footer + headers), and `welcomeFirstJoin` sends none to a person whose
  `email_unsubscribed = 1`. It is where a new member learns digests are ON, so it says so, as the joined org
  has them (`welcomeDigests`: every registry kind resolved through the org's policy with no prefs — a new
  member has none — plus its send hour and timezone; `digestSentence`): "Email digests are on: Trov emails you
  one each weekday at 08:00 (America/New_York) when there is something for you, and a weekly one on
  Mondays", or "off in <org> for now" when the policy turns every kind off. (It used to say digests were
  off until you picked a cadence; they never were.) Sent on a person's
  FIRST membership of any organization, not at sign-up (onboarding creates a person, never a membership).
  `welcomeFirstJoin` (`src/orgs/mail.ts`) is called by every path that writes a membership — creating an org
  (`POST /api/orgs`), accepting an invite (`/api/invites`), the superadmin naming an existing person owner, and
  `POST /auth/onboard` ONLY when it consumed a live legacy invite — with `firstJoin` from `neverJoined`
  (`src/orgs/repo.ts`), asked BEFORE the join is written. It links the guided setup of the org joined
  (`/<org>/#welcome`). Also not a kind. The address is the person's newest provider-VERIFIED one
  (`welcomeRecipient` → `identities.verified_email`), never the editable `persons.email`; none on file = no
  mail. No outcome column and the result is ignored at the call site: `sendWelcome` never throws, and a mailer
  problem must never cost somebody the join.
- **Support notice** (`src/notifications/support.ts`, `support.md`): a transactional message, and the
  only one addressed to the OPERATOR — one per bug report or support message, to the var `SUPPORT_NOTIFY_EMAIL`
  (unset → not sent, outcome `skipped`). It belongs to no org, so it goes through `platformDeliveryFor` like the
  grant notice (`src/notifications/grant.ts`); its outcome lands on `support_reports.mail_*`, scrubbed of the
  provider key before the cut. It is the one mail with a `Reply-To` (`OutboundMessage.replyTo` → Resend's
  `reply_to`): the reporter's provider-verified address — or, for a report sent signed out, the address typed,
  which is the ONLY use of it (nothing is ever sent to it) — so a reply answers them. Never throws.
- **Deferred:** the digest's ledger layout (`EMAIL_CARD.item`) has no avatar chips today, so a person's
  color does not appear in email yet. When a chip is added there, take the color from `persons.color`
  via the light hex set documented in §7 of the identity design doc.
- **Deletion** (`organizations.md` §8): an organization's deletion removes its policy, settings, every member's
  prefs for it and its outbox (with the dev-only bodies); an account's deletion removes that person's prefs in
  every org and every outbox row addressed to them (and local/dev bodies sent to their addresses). Nothing is
  mailed about either. A mail already delivered stays where it was delivered (and in Resend's logs).
- Tests assert on outbox/bodies rows, never mocks (`test/notifications.*.test.ts`, `test/render.notifications.test.ts`).

## Who gets what — notification or transactional

`persons.email_unsubscribed` ("Unsubscribe from Trov email", Settings › Email notifications; the `/u/` page)
is ONE flag per person, across every org. A NOTIFICATION respects it and carries the person's signed link
twice — the footer's Unsubscribe and the `List-Unsubscribe` / `List-Unsubscribe-Post` headers. TRANSACTIONAL
mail is a one-off that answers something a person did: it goes whatever the flag says, carries no unsubscribe,
and its footer says why it came. Nothing Trov sends is marketing; keep it that way — a new kind of mail picks
a row here, and the user-facing words of what still arrives live in ONE place, `shared/email-unsubscribe.ts`
(`STILL_SENT`), shown by Settings and by the `/u/` page. `test/notifications.email-kinds.test.ts` pins every row.

| Mail | Class | Respects the flag | Unsubscribe link / header |
| --- | --- | --- | --- |
| Daily digest (`run.ts`) | notification | yes — eligibility gate | footer + headers |
| Weekly digest | notification | yes | footer + headers |
| Digest retry (`retry.ts`) | notification | yes — re-checked per row | footer + headers |
| Welcome (`welcome.ts`, `welcomeFirstJoin`) | notification | yes — none sent | footer + headers |
| Test send (`POST …/notifications/test-send`) | transactional: the admin's own request, to their own address | no | footer + headers (it is a digest) |
| Invitation / owner invitation (`invite.ts`) | transactional: an admin invited this address | no | none; footer says why |
| Grant notice / paid confirmation (`grant.ts`) | transactional: a grant or a purchase | no | none; footer says why |
| Support notice (`support.ts`) | internal, to the operator | n/a | none |

Stripe's own receipts and invoices are Stripe's mail, under Stripe's settings. There is no Trov mail about
an OAuth connection (an agent connecting): Settings › MCP access lists connections, nothing is mailed.

## No web font, nothing remote

No mail links a web font, a stylesheet, a script or a remote image: a mail client that fetched one (Google
Fonts, say) would hand that third party the reader's IP address and the moment they opened the mail. Every
mail is set in the reader's own system fonts (`EMAIL_FONT_STACK` in `assemble.ts`: `-apple-system`,
`BlinkMacSystemFont`, `Segoe UI`, Roboto, Helvetica, Arial; labels share it). The non-digest mails take their
`<head>` from `emailHead` and their last row from `emailFooter` (why it came, the Unsubscribe link for a
notification, `Sent by Trov · host`), so none can grow a `<link>` on its own.
`test/notifications.email-kinds.test.ts` renders every template and variant, and what went through the
delivery gate, and fails on `fonts.googleapis.com`, `fonts.gstatic.com`, `<link`, `@import`, `@font-face`,
`<script` or `<img`. The `/u/` page loads nothing either.

## The banner

`emailBanner` (`assemble.ts`) is the one banner of every mail, in the shape of the app's first-run card: brand top
left, an optional label top right (`eyebrow`), the mail's headline (`title`) and a quiet line (`lede`; a digest's
"Daily digest · date") reversed out of the accent band. Over the solid `background-color` sits a
`background-image` gradient, and at the right a large faint mark built from `rgba()` table cells — a client
without gradients keeps the solid band, one without `rgba` paints no faint mark. On-band ink stays literal
(`BAND`), never a THEME token, so the dark swap cannot sink it into the purple.

## The card is fluid

`emailCardOpen()` / `EMAIL_CARD_CLOSE` (`assemble.ts`) wrap every mail: `width="100%"` with `max-width:680px`, never a
fixed pixel width (a `width="680"` table cannot shrink, so a phone showed the mail 680px wide). Outlook ignores
`max-width` and gets a fixed-width wrapper through a conditional comment. `EMAIL_MOBILE_CSS` (in each mail's
`<style>`) tightens the gutter, hides the banner's faint mark and steps the headline down under 520px; a client
that drops `<style>` still gets a card that fits.
