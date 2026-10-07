# Abuse limits — what a stranger with a GitHub account cannot do

Since Phase 4 anyone with a GitHub account can sign in. Creating an org takes a superadmin, or a grant from one (`plans.md` › Grants; `DEFAULT_ORG_LIMIT = 0`) until self-serve creation is opened (issue tracked on GitHub). This is everything that stands
between that and Trov being used to send mail, fill storage or look people up. Code: `src/platform/limits.ts`
(every number), `src/notifications/resend.ts` (the From header). Tests: `test/abuse-limits.test.ts`.

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
| `checkout` | 10 / person / UTC day | a Stripe Checkout Session started: `GET /billing/start` and `POST /api/o/:slug/billing/renew` (`billing.md`). A refusal creates nothing at Stripe and charges nothing |
| `handle_check` | 60 / caller / UTC hour | `GET /auth/handle-check` — the signed-in person, or `onboard:<provider>:<subject>` while onboarding (a fresh onboard cookie does not reset it) |

- A refusal is **429** `{ "error": "rate_limited", "retry_after": <seconds> }` with a `Retry-After` header, and
  writes nothing. `retry_after` runs to the end of the UTC day / hour.
- The subject is the PERSON, never the org: creating orgs (already capped at 3 per person,
  `DEFAULT_ORG_LIMIT`) multiplies nothing. A rename carries the counters (`renamePerson`).
- A superadmin (`platform_admins`) is exempt and not counted.
- The role gate runs first: a refused non-admin spends nothing.
- The daily cron deletes counters older than `LIMIT_RETENTION_DAYS` (2).
- Also capped, elsewhere, PER ORG by its plan (`plans.md`): people, repositories, environments, stored
  artifact bytes, and each person's agent connections. The grant notice e-mail spends the granter's `invite`
  allowance.

To add a limit: a key in `LIMITS`, `const refused = await rateLimited(c, "<key>"); if (refused) return refused;`
in the route after its validation and role gate, a row in this table.

## Mail: an org contributes a display name, nothing else

One Resend account and one verified domain send every org's mail, and any org admin can edit
`notification_settings.from_address`. So:

- **`deliveryFor` is the only way mail leaves the Worker** (digest, retry, test send, invite, welcome), and it
  builds the From header itself: `platformFrom(stored value)` = `<name> <hello@trov.dev>`. Whatever address
  the stored value carries is dropped.
- **The name** (`senderNameProblem`): 1–64 characters of ASCII letters, digits, space and `. & ' + _ -`. No
  quote, angle bracket, comma, colon, semicolon, `@`, control character (CR / LF) or non-ASCII letter; and no
  name that contains "trov" once punctuation is removed, except exactly `Trov` (the default every org starts
  with). A stored name that fails is sent as `Trov`.
- **`PUT …/notifications/settings`** takes `from_address` as `Name` or `Name <hello@trov.dev>` and stores
  `Name <hello@trov.dev>`. Any other address, or a name that fails the rule, is 400 `invalid payload`.
- Every subject is flattened to one line (`oneLine`) — an inviter's display name is part of the invite's.

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
   `GEMINI_API_KEY`; the repo cron's 900-subrequest budget is shared by rotation, so many orgs with 10
   environments each slow everyone's health pings; `/mcp` and the tenant routes are metered
   (`org_usage_daily`) but not limited; there is no per-org storage quota in D1 or R2.
