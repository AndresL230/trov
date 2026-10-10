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
  error otherwise, never a silent fallback). Headers: `List-Unsubscribe` (mailto + https) and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`.
- **Unsubscribe** (`unsubscribe.ts`): `/u/<login.sig>` (HMAC over the login with `COOKIE_SECRET`) is the
  single signed-token exception — handled in `src/index.ts` outside `sessionGate`; POST can ONLY set
  `email_unsubscribed = 1`; GET redirects to the cookie-gated `#unsubscribe` screen. Prefs survive unsubscribe.
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
  `List-Unsubscribe` headers (they are optional on `OutboundMessage` now, omitted for invites).
- **Welcome email** (`src/notifications/welcome.ts`): the second transactional message — sent on a person's
  FIRST membership of any organization, not at sign-up (onboarding creates a person, never a membership).
  `welcomeFirstJoin` (`src/orgs/mail.ts`) is called by every path that writes a membership — creating an org
  (`POST /api/orgs`), accepting an invite (`/api/invites`), the superadmin naming an existing person owner, and
  `POST /auth/onboard` ONLY when it consumed a live legacy invite — with `firstJoin` from `neverJoined`
  (`src/orgs/repo.ts`), asked BEFORE the join is written. It links the guided setup of the org joined
  (`/<org>/#welcome`). Also not a kind. The address is the person's newest provider-VERIFIED one
  (`welcomeRecipient` → `identities.verified_email`), never the editable `persons.email`; none on file = no
  mail. No outcome column and the result is ignored at the call site: `sendWelcome` never throws, and a mailer
  problem must never cost somebody the join.
- **Support notice** (`src/notifications/support.ts`, `support.md`): the third transactional message, and the
  only one addressed to the OPERATOR — one per bug report or support message, to the var `SUPPORT_NOTIFY_EMAIL`
  (unset → not sent, outcome `skipped`). It belongs to no org, so it goes through `platformDeliveryFor` like the
  grant notice (`src/notifications/grant.ts`); its outcome lands on `support_reports.mail_*`, scrubbed of the
  provider key before the cut. It is the one mail with a `Reply-To` (`OutboundMessage.replyTo` → Resend's
  `reply_to`): the reporter's provider-verified address — or, for a report sent signed out, the address typed,
  which is the ONLY use of it (nothing is ever sent to it) — so a reply answers them. Never throws.
- **Deferred:** the digest's ledger layout (`EMAIL_CARD.item`) has no avatar chips today, so a person's
  color does not appear in email yet. When a chip is added there, take the color from `persons.color`
  via the light hex set documented in §7 of the identity design doc.
- Tests assert on outbox/bodies rows, never mocks (`test/notifications.*.test.ts`, `test/render.notifications.test.ts`).

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
