# Abuse limits — what a stranger with a GitHub or Google account cannot do

Since Phase 4 anyone with a GitHub account can sign in — and since open sign-up, anyone with a Google account whose address is verified — and (issue #94) anyone signed in can create ONE Free organization they own (`plans.md` › Free; `DEFAULT_ORG_LIMIT = 1`) — anything more takes a superadmin, a grant, or a payment. This is everything that stands
between that and Trov being used to send mail, fill storage or look people up. Code: `src/platform/limits.ts`
(every number), `src/notifications/resend.ts` (the From header). Tests: `test/abuse-limits.test.ts`.
The one thing a visitor with NO account can write — the site's Contact form — has its own section below.

## Per-person rate limits

Migration `0042_organizations.sql` (section 8) adds one GLOBAL table, `abuse_counters (subject, action, bucket, count,
last_at)`. One unit is taken by ONE statement — an upsert that only counts while the window has room — so two
racing requests cannot both take the last unit. D1 only: no Durable Object, no Queue.

| `LIMITS` key | Limit | Counted on |
|---|---|---|
| `invite` | 50 / person / UTC day | `POST /api/o/:slug/invites`, `POST /api/o/:slug/invites/:id/resend`, and the aliases `POST /invites`, `POST /invites/:email/resend` — ONE allowance across every org and all four. The superadmin's owner invite (`POST /api/platform/orgs`, `…/admin`) asks the same limit; a superadmin is exempt |
| `test_send` | 20 / person / UTC day | `POST …/notifications/test-send` |
| `email_change` | 5 / person / UTC day | `PUT …/notifications/prefs` and `PUT …/notifications/persons/:handle`, only when the address CHANGES to a non-empty one (the admin route spends the admin's) |
| `avatar_upload` | 20 / person / UTC day | `POST …/people/me/avatar`, before the body is read |
| `org_logo_upload` | 20 / person / UTC day | `POST /api/o/:slug/logo` (admin+), before the body is read — across every org the person administers |
| `checkout` | 10 / person / UTC day | a Stripe Checkout Session started: `GET /billing/start` and `POST /api/o/:slug/billing/upgrade` (`billing.md`). A refusal creates nothing at Stripe and charges nothing |
| `support` | 10 / person / UTC day | `POST /api/support` — a bug report or support message (`support.md`): one stored row and one mail to the operator's fixed address. Taken after validation, so a refused body spends nothing. The recipient is never the caller's choice, so it cannot be aimed at a third party |
| `support_anon_ip` | 3 / client address / UTC day | `POST /api/support/public`, signed out. The subject is `ip:<HMAC-SHA256 of the address under COOKIE_SECRET>` — a keyed hash, never the address itself |
| `support_anon_all` | 50 / UTC day, everyone | the same route: ONE subject (`anonymous`) for every signed-out report, so a flood from many addresses cannot fill the table or the operator's inbox. Past it: 429 `support_closed`, and the form says to write to the contact address |
| `handle_check` | 60 / caller / UTC hour | `GET /api/orgs/slug-check` (is an organization's handle free; the signed-in person) and `GET /auth/handle-check` — the signed-in person, or `onboard:<provider>:<subject>` while onboarding (a fresh onboard cookie does not reset it) |

- A refusal is **429** `{ "error": "rate_limited", "retry_after": <seconds> }` with a `Retry-After` header, and
  writes nothing. `retry_after` runs to the end of the UTC day / hour.
- The subject is the PERSON, never the org: creating orgs (one owned Free org per person, `DEFAULT_ORG_LIMIT`;
  more only by grant or payment) multiplies nothing. A rename carries the counters (`renamePerson`).
- A superadmin (`platform_admins`) is exempt and not counted.
- The role gate runs first: a refused non-admin spends nothing.
- The daily cron deletes counters older than `LIMIT_RETENTION_DAYS` (2).
- Also capped, elsewhere, PER ORG by its plan (`plans.md`): people, repositories, environments, stored
  artifact bytes, each person's agent connections, and AI summaries per month. A Free org — what open sign-up
  can make — gets 3 seats, 1 repository, 2 environments, 250 MB and 300 summaries a month. The grant notice
  e-mail spends the granter's `invite` allowance.

To add a limit: a key in `LIMITS`, `const refused = await rateLimited(c, "<key>"); if (refused) return refused;`
in the route after its validation and role gate, a row in this table.

## Mail: an org contributes a display name, nothing else

One Resend account and one verified domain send every org's mail, and any org admin can edit
`notification_settings.from_address`. So:

- **`deliveryFor` is the only way an ORG's mail leaves the Worker** (digest, retry, test send, invite, welcome; the platform's own — the grant notice and the support notice — leave through `platformDeliveryFor`, whose From is the platform's whole), and it
  builds the From header itself: `platformFrom(stored value)` = `<name> <hello@trov.dev>`. Whatever address
  the stored value carries is dropped.
- **The name** (`senderNameProblem`): 1–64 characters of ASCII letters, digits, space and `. & ' + _ -`. No
  quote, angle bracket, comma, colon, semicolon, `@`, control character (CR / LF) or non-ASCII letter; and no
  name that contains "trov" once punctuation is removed, except exactly `Trov` (the default every org starts
  with). A stored name that fails is sent as `Trov`.
- **`PUT …/notifications/settings`** takes `from_address` as `Name` or `Name <hello@trov.dev>` and stores
  `Name <hello@trov.dev>`. Any other address, or a name that fails the rule, is 400 `invalid payload`.
- Every subject is flattened to one line (`oneLine`) — an inviter's display name is part of the invite's.

## The signed-out contact form — what a stranger with NO account can do

`POST /api/support/public` (`support.md`) is the one write a visitor can make without signing in: it stores
a row in `support_reports` and mails the operator. It is an unauthenticated public route, admitted like the
other public paths (`PUBLIC_PATHS`), not a new kind of credential. Everything that bounds it:

- **It cannot be used to send mail to a third party.** Trov sends NOTHING to the address typed — no
  confirmation, no copy, no auto-reply. The only message is the notice to the operator's fixed address
  (`SUPPORT_NOTIFY_EMAIL`), and the typed address is that notice's `Reply-To`: it is used when, and only
  when, the operator chooses to answer by hand. (`test/support.routes.test.ts` asserts the one recipient.)
- **Per client address:** `support_anon_ip`, 3 a UTC day. The limiter never sees the IP: the subject is a
  keyed hash of `CF-Connecting-IP` under `COOKIE_SECRET`, so a counter row cannot be turned back into an
  address, and no IP is stored on the report either.
- **A global cap:** `support_anon_all`, 50 signed-out reports a UTC day in total. A distributed flood stops
  there; the form then tells people to write to `hello@trov.dev`. Signed-in reports are not behind this
  cap (theirs is `support`, per person).
- **A honeypot and a minimum time on the form.** A filled honeypot is answered 201 like a success and
  dropped (nothing stored, counted or mailed); a form sent under 3 seconds after it opened is refused.
  Neither stops a determined script — the two limits do — but they keep the cheap ones out of the table.
- **Strict shape:** JSON only; every field capped (`SupportPublicSubmit`); the address must be ONE plain
  address, so it cannot carry a second recipient or a header; the User-Agent header and the page are cut to
  their caps and flattened to one line before they are stored.
- **The notice treats what was typed as hostile:** every value is HTML-escaped, the subject is one line of
  bounded length, and the mail's only links are Trov's own.
- **The address is unverified and stays that way:** `support_reports.contact_email`, shown labelled
  "unverified, as typed"; never written to `persons` or `identities`, so it cannot become an identity,
  match an invitation or receive a digest.
- **With a session cookie** the route is the signed-in path: the principal is the reporter and the typed
  address is ignored.
- **No third-party script.** If spam shows up despite the above, Cloudflare Turnstile on this form is the
  next step (it was left out on purpose: no visitor's browser talks to a third party to send a message).

Residual: an operator's inbox can still receive up to 50 unwanted notices a day, each with attacker-chosen
(escaped) text and an attacker-chosen Reply-To — so a reply written without looking at the address goes
where the sender chose. The notice and Platform both label the address unverified for that reason.

## The notification address is not an oracle

`persons.email` is where a person's digests go. It is NOT an identity: sign-in and invites match on
`identities.verified_email` (what a provider asserted), never on it. So it is not unique, and
`PUT …/notifications/prefs` / `PUT …/notifications/persons/:handle` no longer answer 409 `email_in_use`: an
address that is on someone else's row is saved exactly like one that is on nobody's, with the same response.
(The alternative — refuse silently — would still show in the returned `email`.) Nobody's row but the target's
changes. The cost is that an address can be on two people's rows; nothing reads it as a key.

## Residual risks (not addressed — decide before inviting the public)

1. **Notification addresses are unverified.** A person can point their address at someone else and send them
   a test send (20 a day, 5 address changes a day) or a daily digest whose content their own org wrote, from
   `<their org's name> <hello@trov.dev>`. The fix is to mail only a provider-verified address
   (`identities.verified_email`) or to confirm a typed one by mail; it was not done here because existing
   SaplingLearn people have hand-set addresses and `verified_email` is only filled at each person's next
   sign-in.
2. **GitHub identities are pinned on first use.** `identities.provider_uid` (0042_organizations) is NULL for every existing
   row and is bound at that identity's next GitHub sign-in — to whichever account presents the login. If a
   member's GitHub login was renamed away and re-registered before they next sign in, the new holder signs in
   as them. Check `SELECT subject, person FROM identities WHERE provider = 'github' AND provider_uid IS NULL`
   after deploy and have each of those people sign in once.
3. **An invite by GitHub login names a login, not an account.** Whoever holds the login when they sign in may
   accept it (`MINE`, `src/orgs/repo.ts`). Requiring the identity to be pinned would not help: a re-registered
   login that signs up fresh is pinned at once, to the new account. The real fix is to resolve the login to
   GitHub's numeric id when the invite is created and match on that — a change to invites, left for Phase 7.
   Until then: invite by login only someone about to sign in, and revoke stale invites. The same holds for a
   person who renamed their GitHub login: their old identity row still matches invites to the OLD login, and a
   new holder of that login is refused at sign-in (`/?denied=1`) until the old row is unlinked.
4. **`org_login_map` attributes by login.** An org admin maps a GitHub login to a member for My Work; a login
   that changes hands mis-attributes that login's events inside that org. It grants no access.
5. **The invite mail carries text a stranger chooses**, to any address, from the platform address, 50 a day
   per person: the ORG's name (up to its cap, in the subject and the headline), the inviter's display name and
   the invitee's name as the inviter typed it (each up to 120 characters). All are HTML-escaped, the subject is
   one line, and the only link is the site root — but the words are theirs. Every org's e-mail invite is mailed
   now (0042_organizations), not only SaplingLearn's, so this is live for any org anyone creates. The WELCOME goes only to a
   provider-verified address of the person who just joined, so it cannot be aimed at a third party.
6. **Shared platform resources.** Summaries for every org's Sync GitHub and webhook use the Worker's one
   `GEMINI_API_KEY` — capped per org per month by its plan (Free 300) and per call (8,000 characters of a
   description); the repo cron's 900-subrequest budget is shared by rotation, so many orgs with environments
   slow everyone's health pings (a Free org has at most 2); `/mcp` and the tenant routes are metered
   (`org_usage_daily`) but not limited; artifact storage is capped per org by plan, but D1 rows are not.
7. **Open Free organizations.** One owned Free org per GitHub account; GitHub accounts are free to make, so a
   determined person can make many — each bounded by Free's limits and by the per-person rate limits above.
   Risks 1, 3 and 5 apply to every Free org.
