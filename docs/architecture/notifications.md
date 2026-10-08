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
  (`render(db, login, window)` → `Section | null`; null = nothing to say, dropped). Adding a kind = one entry +
  one renderer; `notification_policy` is seeded from the registry per isolate (`policy.ts`, INSERT OR IGNORE,
  never overwrites).
- **Cadences are `daily` / `weekly` / `off` — there is NO immediate tier.** Resolution (`resolve.ts`): user pref
  → policy `default_cadence` → registry default; `policy.enabled = 0` short-circuits to `off` before the user
  layer. A pref must be in the kind's `allowedCadences` (validated at write time).
- **Runs** (`run.ts`): per eligible user (address on file, `email_unsubscribed = 0`) the outbox row is claimed
  FIRST by `INSERT OR IGNORE` on `user:cadence:window_id` — a conflict skips the user, so a double fire is
  harmless. Then render, drop nulls, `skipped` on zero sections, else one message → `sent` (with `resend_id`)
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
- **Invite email** (`src/notifications/invite.ts`): one transactional message per invite/resend through
  `deliveryFor`; not a kind — no cadence, prefs, or window. Outcome lands on `invites.email_*`. No
  `List-Unsubscribe` headers (they are optional on `OutboundMessage` now, omitted for invites).
- **Welcome email** (`src/notifications/welcome.ts`): the second transactional message — sent from
  `POST /auth/onboard` once the person row and session exist, linking the guided setup (`/<org>/#welcome`; it was Get Started, `/#guide`, where a
  fresh sign-in lands). Also not a kind. It fires THERE and not when someone joins the GitHub org
  because the address comes from the person's OWN OAuth token (`getPrimaryEmail`), which does not
  exist until they sign in — nothing Trov holds can reach a new org member before that. No outcome
  column and the result is ignored at the call site: `sendWelcome` never throws, and a mailer problem
  must never cost somebody their sign-up. No address from the provider = no mail.
- **Deferred:** the digest's ledger layout (`EMAIL_CARD.item`) has no avatar chips today, so a person's
  color does not appear in email yet. When a chip is added there, take the color from `persons.color`
  via the light hex set documented in §7 of the identity design doc.
- Tests assert on outbox/bodies rows, never mocks (`test/notifications.*.test.ts`, `test/render.notifications.test.ts`).
