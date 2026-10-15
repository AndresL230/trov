# Organizations — the operator's guide

For the person who runs a Trov deployment (the **superadmin**) and for an organization's **owner**. It
follows one organization from the day it is added to the day its team is working in it. The code behind
each step is named in brackets; the rules those modules obey are in `data-layer.md` and `abuse-limits.md`.

## Who is who

| | Scope | Becomes one by |
|---|---|---|
| **Superadmin** | the platform: the list of organizations, who owns each, suspension, usage, the audit trail | a row in `platform_admins` (0042_organizations seeds andres); another superadmin adds more in Platform › Admins & limits |
| **Owner** | one organization, everything in it | creating a Free organization (§1d) or one with a grant (§1b), accepting a superadmin's owner invitation, or being made one by another owner |
| **Admin** | one organization, everything but owners and the encryption key | an invitation "as admin", or a role change by an admin or owner |
| **Member** | one organization: reads and the everyday writes | an invitation "as member" |

A person is one account (GitHub or Google sign-in) and may belong to any number of organizations, with a
different role in each. Being a superadmin is **not** a membership: it grants nothing inside an organization.

## 1. The superadmin adds an organization and names its admin

Platform › Organizations › **Add organization** [`web/src/platform.ts`, `POST /api/platform/orgs`,
`src/platform/repo.ts` `createOrgWithAdmin`]. Platform lives at **`/platform/`**, a page outside every
organization — so a superadmin who belongs to none still reaches it; the org switcher's menu and the org
picker link to it.

An organization comes to exist in one of four ways: the superadmin creates it for someone (this section),
grants someone the right to create their own (§1b), someone buys Pro and sets theirs up with nobody at Trov
involved (§1c), or someone signed in creates a Free one of their own (§1d).

Give the organization a name, a slug (its address: `/<slug>/`, not editable later; a name the app itself answers on — `api`, `feed`, `pricing`, … `RESERVED_ORG_SLUGS` — is refused), the **plan** it starts
on (Free, Pro or Enterprise — `plans.md`; Pro unless you pick another) and its first owner:

- **An existing person** (their Trov handle): they are the owner at once. If it is their first organization
  they get the welcome e-mail.
- **An e-mail address**: Trov mails "You have been made the owner of <org> on Trov" and records the
  outcome on the invitation (Platform shows `email sent` / `email not sent`). The person signs in with that
  address — GitHub's verified e-mail, or Google — and accepts.
- **A GitHub login**: no e-mail is sent (Trov knows a login, not an address). Tell them it is waiting; they
  see it when they sign in with that account.

The superadmin is **not** made a member. To rescue an organization whose owner left, open it in Platform and
use **Add another owner** [`POST /api/platform/orgs/:slug/admin`].

### 1b. …or grants someone an organization of their own

Platform › Access › **Grant an organization** [`web/src/platform-access.ts`, `POST /api/platform/grants`,
`src/plans/grants.ts`]: name the person — by Trov handle, GitHub login or e-mail, the same three ways — and
the plan (for Enterprise, its limits; optionally a note and an expiry). They do not need an account yet. An
e-mail grant is told by mail; for a GitHub login, tell them yourself.

When they sign in, the org picker says **You can set up an organization — <Plan>**. They choose its name
and slug and become its owner, on that plan, and land on the guided setup (§2) [`POST /api/orgs`]. One grant
makes one organization; until it is used you can **Revoke** it, and afterwards the Access tab shows which
organization it became.

A grant is the way anyone but a superadmin gets an organization on any plan but Free; a Free one needs no
grant (§1d). The per-person allowance that used to be set in Platform is gone.

### The organization's plan

Open the organization in Platform: its **Plan** section shows the plan, each limit and the seats in use.
**Change plan** sets the plan and, per organization, any of its limits [`PUT /api/platform/orgs/:slug/plan`].
The confirmation says what happens if the organization is over the new limits: nothing is removed and nobody
loses access; it cannot add more of that kind until it is back under. Everyone in the organization reads its
plan in Org settings › General; only you change it. The limits, what counts toward each and the seam for
billing: `plans.md`.

**Gift a plan** gives the organization a plan for free until a date: pick the plan (Pro or Enterprise),
optionally its seats, and 1 / 2 / 3 / 6 / 12 months or a date [`PUT …/plan { gift }`]. The confirmation says
what happens at the end: the organization moves to Free by itself, nothing is deleted, and anything over a
Free limit waits. The section then reads "Gifted until <date>" with **Extend** [`POST …/gift/extend`] and
**End now** [`POST …/gift/end`]; **Change plan** on a gifted organization clears the gift (the plan you set
there has no end). The organization's people see "Free until <date>, a gift from Trov…" on their Plan tile,
and its owner can start paying before then. It is not offered for an organization on a live subscription.
In Platform › Access, **Grant an organization** has an optional **Free for**: the organization that grant
becomes is free for that long from the day it is created. All of it: `plans.md` › Gifts.

### 1c. …or someone buys Pro

A person presses "Choose Pro" on the pricing page [`GET /billing/start`, `src/billing/routes.ts`], signs in
if they have not, chooses how many seats and pays on Stripe's page ($10 per seat per month; one seat is
fine), and comes back to a waiting room. Stripe's webhook gives them the same grant as §1b, made by `billing`
instead of a superadmin and carrying the seats paid for; they name the organization and own it. It appears
in Platform › Organizations as **paid**, with Stripe's status, its seats and a link to the customer in the
Stripe dashboard, and its owner manages payment in Org settings › General (Manage billing, Change seats).
The seats paid for are the seats it has; at the cap, Members offers its owner **Add a seat**. If the
subscription is cancelled, the organization moves to Free when the paid period ends — nothing is deleted.
You can still change its plan by hand — what that does is in `billing.md` › Decisions. The whole flow, the
events and the owner checklist: `billing.md`. Enterprise is never bought: it is §1 or §1b.

### 1d. …or someone creates a Free one

Anyone signed in (not a superadmin) can create a **Free** organization from the org picker or the switcher's
menu (the dialog asks for a name and a **handle** — the slug, checked for availability as it is typed:
`GET /api/orgs/slug-check`) — no grant, no payment [`POST /api/orgs`, `src/plans/free.ts`]: up to 3 people, 1 repository, 2
environments. A person can OWN one Free organization at a time (`DEFAULT_ORG_LIMIT = 1`, `shared/orgs.ts`).
Its owner upgrades it to Pro from Org settings › General (**Upgrade to Pro**, or the button Members shows at
the seat cap): a Stripe checkout for that organization, starting at one seat per member and pending
invitation. It appears in Platform as **free**; you can change its plan like any granted org's. What bounds
open creation: `abuse-limits.md`.

## 2. The owner signs in, accepts, and lands on the guided setup

The mail links to the site root — never to a token; the invitation is matched to the person's
provider-verified address (or GitHub login) at sign-in [`src/orgs/repo.ts` `MINE`]. A person with no
organization lands on the **org picker**, which lists their invitations; **Accept** makes them a member
[`POST /api/invites/:id/accept`].

### The guided setup (`#welcome`)

Creating an organization (Free, granted or paid) and accepting an invitation both land on the **guided
setup** [`web/src/welcome.ts`, `welcome-actions.ts`; the landing targets are `createLanding` and
`acceptLanding` in `web/src/org-picker.ts`]: a full page without the sidebar, one step at a time, each
skippable, with Back, a step indicator and *Skip setup*.

| Who | Steps |
|---|---|
| an **owner** or **admin** | 1 connect a repository · 2 connect your coding agent · 3 invite your team · 4 done |
| a **member** | 1 connect your coding agent · 2 done |

- **It is a route, not server state.** `#welcome` is the first step; `#welcome/agent`, `/team` and `/done`
  the others, so a reload stays put. Nothing records that a person has seen it, and there is no migration.
  It is reopened from Org settings' checklist (*Open the guided setup*), from Help › Guide and from
  quick search.
- **Every step's state is derived, never stored and never guessed** — from the reads Org settings already
  makes (repositories, the GitHub App's connection, members, invitations, the plan) and from the person's
  own agent connections (`GET /auth/oauth-grants` — the ones that may use this organization or follow the repository — plus their MCP tokens for
  it: the two reads Settings › MCP access makes). A read that is out, or failed, is *not known yet*: the
  indicator keeps the step's number, and the closing step says so rather than "done" or "skipped". Nothing
  on the page calls GitHub; the repository list is Org settings' own read.
- **Step 1** is Repositories' flow in place: *Connect with GitHub*, then the installation's repositories to
  **Track**. A person with **no GitHub account linked** (they signed in with Google) is shown *Link your
  GitHub account first* instead — the connect route accepts GitHub's approval only from the GitHub identity
  linked to that Trov person (`wrong_account`, `github-app.md`). Where the App is not configured, or for a
  repository it cannot see, the by-name path in Org settings is one quiet link away.
- **Step 2** shows the same commands and sign-in steps as Settings › MCP access [`web/src/mcp-connect.ts`]
  and a live line: *Not connected yet* / *Your agent is connected*. While it waits, the page re-reads the
  person's connections every 5 seconds (and when the tab regains focus), so approving in the browser shows
  up without a reload. It is per PERSON: every admin and member connects their own.
- **Step 3** is Members' own invite form [`inviteSection`]: the same call, the same seat gate — at a Free
  organization's cap the same sentence and, for the owner, **Upgrade to Pro**. A one-person plan has no
  such step.
- **The last step** recaps what is done and what was skipped (each with the way back), says where the
  Feed, Docs, Tickets and Roadmap are, and opens My Work.
- **Coming back from GitHub.** Linking a GitHub account and connecting the App both leave the app, and the
  server returns them to Settings and to Org settings › Repositories. When they were started from the
  setup, a note in the browser's session storage brings that one return back to step 1 instead
  [`welcomeReturnHash`]; what GitHub answered is shown there.

Org settings' checklist is unchanged and has no "connect your coding agent" item: it is the
ORGANIZATION's list (*n of 4 done*, gone when all four are), and an agent connection is each person's own.

### The checklist in Org settings

For the steps skipped, **Org settings** opens with
*Finish setting up <org>* [`web/src/org-settings.ts` `setupChecklist`]:

1. **Connect a repository** — Org settings › Repositories › **Connect with GitHub** [`github-app.md`,
   `GET /api/o/:slug/github/install`]. GitHub asks which account to install the Trov App on and which
   repositories it may read, then returns to Repositories, which now lists them: **Track** the one the
   team ships from. The first is the primary; a bare `#214` anywhere in the app resolves against it.
2. **Add an environment** — Org settings › Environments: a key (`staging`, `production`), the branch it
   deploys from, its web and API URLs. The Repo dashboard reports on each.
3. **Invite your team** — next section.

There is **no GitHub or token step**, on any Trov: step 1 is connecting GitHub, done only once a repository is
connected AND GitHub can be read. Where the App is offered (`GithubAppStatusDTO.configured`) that is the
installation — no token and no webhook — or a stored token, the fallback. Trov reads through the
installation with tokens GitHub issues for an hour at a time, and GitHub delivers events itself. Org settings ›
Integrations shows it as one row — the account, who connected it, *Test connection*, *Manage on GitHub*,
*Disconnect*. The other integrations are optional: Cloudflare analytics, and per environment the Railway token
and the app-metrics token; each is **write-only** — once saved only its last four characters are ever shown, to
anyone [`src/data/secrets.ts`, envelope-encrypted under the deployment's `TROV_KEK`]. On a Trov with NO App (a
self-hosted copy) the same step needs the token: its tooltip says so, and once a repository is added without
one, the step leads to Integrations to set it.

**Who can connect it, and what can go wrong.** An admin or an owner, with the GitHub account linked to
their Trov account, which must be able to read at least one repository the installation covers: the
organization can then use exactly the repositories that person can read (all of them, for an owner of the
GitHub account). If a GitHub
organization's owner has to approve the App first, Repositories says the request is pending and nothing is
connected until they do. An organization connects one GitHub account at a time; several Trov organizations may
connect the same GitHub account, and track the same repository. *Disconnect* ends it in Trov and leaves the App installed on GitHub. If the App is
suspended or uninstalled on GitHub, or stops seeing a tracked repository, Org settings says so. Events are
captured for the **primary** repository only.

**By hand, instead** (a Trov with no App configured, or a repository the App cannot see) — Repositories ›
*Add a repository by name*, then in Integrations › *Manual connection* a GitHub token (fine-grained,
read-only: Metadata, Contents, Pull requests, Issues, Actions, Checks, Deployments, Commit statuses) and,
per repository, a webhook: each repository row shows its own delivery URL, `/webhook/github/<id>`, and a
webhook secret (*Set* generates one). In the repository's GitHub settings add a webhook to that URL with
that secret, content type JSON; pull requests, issues, pushes, reviews, deployments, checks, workflow runs
and commit statuses are what Trov reads. *Check deliveries* reports the last one received. Until it is set
up, Sync GitHub and the hourly reconcile still fill the dashboard from the token.

Until a source is set up the Repo dashboard and *Poll now* say **Not connected** and link back to
Integrations; nothing is requested on the organization's behalf.

## 3. Inviting the team

Org settings › Members › **Invite someone** [`POST /api/o/:slug/invites`, `src/orgs/mail.ts`]:

- **By e-mail** (optionally with the person's name): Trov sends the invitation — it names the organization,
  the inviter and the role — and the pending row shows **Email sent** / **Email not sent** with the time and,
  on a failure, the provider's reason. **Resend email** sends it again. The person signs in with GitHub or Google;
  the invitation is matched to the address that provider verified.
- **By GitHub login**: no e-mail; the person sees the invitation the next time they sign in with that
  account.

An invitation takes a **seat** (a seat is a member or a pending invitation): Members shows "2 of 3 seats
used", and when none is free the form gives way to a sentence saying so — with, for the owner, **Add a seat**
(a paid Pro organization) or **Upgrade to Pro** (a Free one). A legacy Personal organization has no
invitations at all [`plans.md` › Seats].

An invitation is as **member** or **admin**; only the superadmin's invitation makes an owner. Pending
invitations can be revoked. A person joining their first organization gets a welcome e-mail that links
into it. Every organization's mail is sent from the platform's one address, under the sender **name** its
admin sets in Org settings › Notifications.

Each person may send 50 invitations (including resends) a day across all their organizations; the app says
when the limit turns over [`abuse-limits.md`].

## 4. What each role can do

| | Member | Admin | Owner |
|---|:-:|:-:|:-:|
| Read everything in the organization; file and work tickets, sprints, handoffs, docs proposals, artifacts, prompts | ✓ | ✓ | ✓ |
| Confirm staged content (promote a doc, ratify a decision) | ✓ | ✓ | ✓ |
| Connect Claude Code to this organization (their own tokens and connected apps) | ✓ | ✓ | ✓ |
| Invite and remove people; set roles (member / admin) and titles | | ✓ | ✓ |
| Repositories, environments, integrations (set / rotate / delete a credential) | | ✓ | ✓ |
| Sync GitHub, Poll now; map a GitHub login to a person; the e-mail digest policy, schedule and sender name; rewrite the plan over MCP | | ✓ | ✓ |
| Delete another person's prompt or artifact; rename the organization | | ✓ | ✓ |
| Turn the organization's AI on or off (Org settings › AI, `ai.md`) | | ✓ | ✓ |
| Dismiss a suggestion Trov made, or press "Wrong?" on what it wrote; accept a suggestion whose kind is a member's call (an admin's kind needs admin+) | ✓ | ✓ | ✓ |
| Make or unmake an owner; rotate the organization's encryption key | | | ✓ |
| Delete the organization (§8) | | | ✓ |

The last owner can neither leave nor be demoted. Removing a member ends their agents' reach into that
organization at once — their tokens for it are revoked, and every connected app of theirs stops being able to
act there (one that could act nowhere else is revoked) — and what they wrote stays. An agent acts as the
person whose connection it holds, in ONE of that person's organizations per call (`data-layer.md` § Bearer:
the connection's current organization, or the one that has the repository it is working in connected), and
may only write to tickets assigned to that person
[`src/tools/tickets-agent.ts`].

Tickets and handoffs are numbered **per organization**: a new organization's first ticket is `#1`. That
number is the id everywhere — the address bar, a link, an agent's tool call [`src/tools/tickets.ts`].

### Where an organization is administered

One place: **Org settings**, opened from the switcher at the top of the sidebar (`#org[/<tab>]`,
`web/src/org-settings.ts`). There is no separate Maintenance area any more.

| Tab | What it holds | Who sees it |
|---|---|---|
| Integrations | the GitHub App's connection (or, by hand, the token and webhook secrets) and every NON-hosting integration; the encryption key and the history of changes. No hosting credential (`cloudflare_analytics`, `railway`, `vercel`, `render`, `netlify`, `fly`, `aws`) and no app metrics token: one line links to Hosting (`onIntegrationsTab`, `web/src/integrations.ts`) | admin, owner |
| Hosting | each provider's connection — ONE card per provider (connect, test, rotate, disconnect, its leftover per-environment tokens and "Remove old tokens"), what uses it; Detected; and, until Repositories › a repo › Apps (repo-setups Phase D), a compact read-only list of each environment's parts with Edit — the part editor, which also holds the environment's app metrics token — `hosting-providers.md` › The screens | admin, owner |
| Repositories | Connect with GitHub; connected repositories, one primary; what the App can see to track; a by-hand repository's webhook URL | everyone (read), admin+ (write) |
| Environments | the environments the Repo dashboard reports on, in drift order: name, branch, URLs, health path. Not their parts (Hosting) | everyone (read), admin+ (write) |
| Members | the people directory; for admins also invitations, roles and titles, removal, and **Unmatched logins** — GitHub logins in captured activity to map to a person or discard [`web/src/identity.ts`] | everyone (read), admin+ (write) |
| Notifications | the e-mail digests: which exist and their default cadence, send hour, timezone and sender name, preview, test send, the outbox [`web/src/notifications.ts`] | admin, owner |
| AI (the screen is the frontend's next PR; the routes exist) | the AI switch (`orgs.ai_automation`, 0055 — on by default), this month's AI runs against the plan's `ai_runs`, what is sent to Anthropic and what never is: `GET` / `PUT /api/o/:slug/ai/settings`, cookie only, the change audited `org.ai` (`ai.md`) | everyone (read), admin+ (the switch) |
| General | the image; the name; the slug, read-only; the **Plan** — what it includes and the org's use of each limit [`web/src/org-plan.ts`]; for an owner, **Delete organization** (§8) | everyone (read), admin+ (image, rename); nobody changes the plan here; owner (delete) |

General is a **bento** inside the tab's width (`.cnpy-org-gen` in `trov.css`, Settings' `.cnpy-tile`s on 12 columns; `generalTab` and `planBlock`), so its outer edges are the tab bar's and every other tab's: image + name is the tall tile on the left, Plan (name, billing, who changes it) and Slug the two short ones beside it, and the plan's **Limits** a tile across the page under them, three to a line. A read-only member has no field to make the first tile tall, so the three sit in one row (`.cnpy-org-gen--read`). It folds by the room the TAB has (a container query, as Settings does): under 900px the limits go two to a line, under 760px image + name takes a row and Slug | Plan the next, under 520px one column in DOM order. No tab narrows its own blocks (`test/render.org-settings.test.ts` walks them); a control inside a tile keeps its own measure.

A person's own digest preferences stay in their Settings. The daily queue of things an agent could not
place is not administration: it is **Triage › Unplaced** in the sidebar (`#unplaced`). Old links —
`#maintenance`, `#maintenance/identity`, `#maintenance/people` — still open the right place
[`web/src/hash.ts`]. Logins waiting to be matched are counted, for admins only, on the switcher, on its
Org settings row and on the Members tab.

Every tab is laid out the same way [`web/src/org-ui.ts`]: one lead sentence saying what is there and
what needs attention, with the tab's one primary action beside it; sections under an uppercase eyebrow;
rows that show a name, a status and one action, and open to the rest. Platform's tabs follow the same
rules.

### The organization's image

An organization shows one image beside its name — the sidebar switcher and its menu, the org picker, an
invitation, Platform. Without one the SPA draws the first letter of the name [`web/src/org-logo.ts`
`orgTile`]. Migration `0042_organizations.sql` (section 10); code `src/orgs/logo.ts`; tests `test/org-logo.test.ts`.

- **Who changes it**: an admin or an owner, in Org settings › General — the tile is the control, like the
  profile photo: Upload image / Change image, and Remove image over an uploaded one
  [`POST /api/o/:slug/logo`, `…/logo/remove`; cookie only; audited as `org.logo.set` / `org.logo.remove`].
  The image is checked exactly like a person's photo (PNG, JPEG, WebP or GIF — never SVG — confirmed by
  its bytes, at most 2 MB; the browser crops it to a square first) and each person may upload 20 a day
  [`abuse-limits.md`]. Everyone else sees the image and where it came from.
- **Where it is stored and served**: R2, content-addressed at `org-logos/<sha256>`, served by
  `GET /org-logo/<sha>` with the person photo's headers. The bytes go only when the organization is deleted
  (§8), and then only if no other organization shows the same image. It is person-level, not tenant-gated: an invitee
  and the superadmin see an organization's name without being members, so they see its image too. The
  browser never loads anything from GitHub.
- **The import from GitHub**: the avatar of the OWNER of the organization's primary repository (the user or
  organization in `owner/repo`), fetched by the Worker and stored like an upload. It runs when a repository
  is connected or made primary, when the GitHub App is connected and when the GitHub token is set or
  rotated (after the response), in the 6-hourly reconcile, and when an uploaded image is removed. It uses
  the organization's GitHub credential when it has one (its App installation's token, else its GitHub
  token) and asks unauthenticated otherwise — except in the reconcile, which asks nothing for an
  organization with neither.
- **The rule** [`importOrgLogo`]: **an uploaded image is never replaced by an import.** An import writes
  only when the organization has no image or its image was itself imported (so it follows a changed avatar,
  or a new primary repository's owner). Removing an upload re-enables the import, which is tried at once:
  the organization gets GitHub's image back if it has a repository, else the initial. An imported image has
  no Remove — upload one to replace it. Disconnecting the repository keeps the image already imported.
- **What the import will fetch**: `api.github.com/users/<owner>`, then that profile's `avatar_url` only if
  it is `https` on `avatars.githubusercontent.com`; no redirect is followed, each request times out after
  5 seconds, the answer must be an image of at most 2 MB by its bytes. Any failure changes nothing and is
  logged without the token. The token is never sent to the avatar host.

## 5. Suspension

Platform › the organization › **Suspend** [`POST /api/platform/orgs/:slug/suspend`]. From that moment, for
that organization only: every page and API route answers its members as if the organization did not exist
(404), every agent token and connected app stops working (401), webhook deliveries are refused, and the
background jobs and digests skip it. **Nothing is deleted** and no other organization is affected.
**Unsuspend** restores all of it as it was. Members see "You don't have access to …" on the org picker.

## 6. Usage

Platform › **Usage** [`src/platform/usage.ts`, `org_usage_daily`]: per organization, API requests and MCP
tool calls by day, active people, what was created in the window (feed entries, tickets, doc versions,
sprints, prompts, handoffs, artifacts), e-mails sent, the most-called tools, and sizes now (rows per kind,
artifact bytes, tokens and connected apps) — and, when the deployment has an Anthropic key, AI runs (attempted,
failed, capped) and tokens (`OrgUsage.ai`, `ai.md`). Platform › an organization shows the same for that one.
Requests are metered, not limited. What IS limited per organization — people, repositories, environments,
stored artifacts, agent connections per person — is its plan's (`plans.md`).

## 6b. Support reports

Platform › **Support** [`web/src/platform-support.ts`, `GET /api/platform/support`]: the bug reports and
messages people send — signed in, from the bug button in the app header and Settings › Contact support;
signed out, from the site's Contact form — with a count of the open ones on the tab.
Each is also mailed to `SUPPORT_NOTIFY_EMAIL`; replying to that mail, or **Reply by email** on the report,
answers the person at their verified address (signed out: at the address they typed, which nobody
verified and which is labelled so). **Resolve** takes it off the open list; **Reopen** puts it
back. A report holds what its reporter wrote plus the screen, the organization's slug, the app version and
the browser — nothing read from the organization. All of it: `support.md`.

## 7. What the superadmin can and cannot see

**Can:** every organization's name, slug, status, creation date and creator; the GitHub account its App
installation is on, if any; its owners; its members'
handles, names, roles and titles; its pending invitations (the address or login, and whether the e-mail
went out); the usage **counts and sizes** above; and the audit trail — who created the organization, added
or removed whom, changed a role, set or rotated which integration (never a value: at most a credential's
last four characters and key version); and the support reports people sent (§6b): their own words and
where they were when they wrote them.

**Cannot:** open an organization, or read any of its content — docs, tickets, feed, handoffs, prompts,
artifacts, the Repo dashboard, e-mail bodies — or any stored credential. The Platform routes read no tenant
content at all, and an organization's own routes answer a superadmin who is not a member exactly as they
answer a stranger: 404. To see inside an organization a superadmin has to be invited like anyone else — or
make themselves an owner through *Add another owner*, which is written to the audit trail under their name.

**Can also delete** any organization, and any account but a superadmin's or their own (§8). Doing so shows
them what the owner or the person would see before deleting — counts, the organizations' names and slugs,
the guard rails — and nothing of the content; each deletion is recorded in the audit trail under their name.

## 8. Deleting an account or an organization

Self-serve, and irreversible (the owner's decision, 2026-10-12, which made CLAUDE.md invariant 11 name it).
Code: `src/deletion/` — `org.ts` (an organization), `person.ts` (an account), `tables.ts` (`ORG_TABLES`,
every table with an `org_id`), `r2.ts` (the bytes); `src/billing/cancel.ts` (Stripe); the words in
`shared/deletion-core.ts`; the screens in `web/src/deletion.ts` + `deletion-actions.ts`. Tests:
`test/deletion.org.test.ts`, `test/deletion.account.test.ts`, `test/deletion.platform.test.ts`,
`test/render.deletion.test.ts`.

Every way in is a **session-cookie route that refuses a request carrying an `Authorization` header**, and
nothing reachable from `src/mcp.ts` imports `src/deletion/` (`test/secrets.mcp.test.ts`): an agent can never
delete an account or an organization (invariant 2). Each is the SAME core whoever asks; the routes are thin.

| Who | Where | Route |
|---|---|---|
| anyone signed in, their own account | Settings › Delete account | `GET /auth/me/deletion` (what it would do), `POST /auth/me/delete { confirm: <handle> }` |
| an **owner**, their organization | Org settings › General › Delete organization | `GET /api/o/:slug/deletion`, `POST /api/o/:slug/delete { confirm: <slug> }` |
| a superadmin, any organization (no membership needed) | Platform › the organization › Delete… | `GET /api/platform/orgs/:slug/deletion`, `POST /api/platform/orgs/:slug/delete { confirm }` |
| a superadmin, any account but a superadmin's or their own | Platform › Admins › Accounts | `GET /api/platform/persons/:handle/deletion`, `POST /api/platform/persons/:handle/delete { confirm }` |

The confirmation is the one confirmation modal (`web/src/confirm.ts`) with the handle or the slug TYPED (case
and surrounding spaces aside; the server checks it too: 400 `confirm_mismatch`). It says what is deleted, what
is kept, which organizations go with an account, and what a paid plan means. A refusal is a sentence in it:
`blocked` (409, with the guard rails), `billing_failed` (502), `billing_unavailable` (503), `forbidden` (403).

**Why an owner, not an admin.** Deleting ends the organization for its owners too and cancels what it pays
for; an admin can neither remove an owner nor manage billing, so an admin cannot do the larger thing either
(403, and the tile is not shown to them).

**The order, for both.** (1) **Stripe** — every subscription that could still charge for what is going is
cancelled NOW (`DELETE /v1/subscriptions/:id`, Stripe's defaults: no proration credit, no final invoice — the
owner's policy is no refund for a period already started, except where the law requires, done by hand in
Stripe), and every open Checkout Session for it is expired, so nobody can pay for it afterwards. A Stripe
failure deletes NOTHING (502, "nothing was deleted"); a live subscription on a deployment with no Stripe keys
is refused (503). (2) **One D1 batch** with foreign keys deferred: all of it lands or none of it. (3) **R2**,
after the commit (`sweepR2`): an object is deleted only when no row anywhere — any org's, any person's — and no
unexpired upload token still points at its sha. A failure there leaves an orphaned object; never a row pointing
at bytes that are gone.

### Deleting an organization

Everything with its `org_id` goes (`ORG_TABLES`, children first; a test fails when a migration adds a table
with an `org_id` column that is not listed), then the global rows that point at it and the `orgs` row. A MANUAL
agent connection whose current organization this was, but which may also act in another, keeps working there
(its current organization moves to the one it was allowed first); any other connection into it goes, with its
tokens. Its members keep their accounts and their other organizations; a member left with none lands on the
org picker. Its owner lands on the app with "The organization has been deleted." The slug is free again.

### Deleting an account — the guard rails

The same for the person and for a superadmin; they protect the OTHER people (`accountDeletionPreview`):

| Code | When | The way past it |
|---|---|---|
| `last_owner` | the only owner of an organization other people are in | make one of them an owner (Org settings › Members; a superadmin: Add another owner), or delete the organization first |
| `billing_buyer` | the buyer of a subscription that still RENEWS for an organization that carries on — it would go on charging their card | cancel the plan (Org settings › General › Cancel plan: it then runs to the end of the period already paid and stops, so it no longer blocks), or ask Trov to move the billing; or delete the organization |
| `last_superadmin` | the platform's only superadmin, deleting themselves | make someone else a superadmin first |
| `superadmin` / `self` | Platform only: the account is a superadmin's, or the caller's own | that person deletes it in their own Settings |

An organization **nobody else is in** (the person is its only member, and its owner) is deleted WITH the
account, through the organization core; the confirmation names each one. Pending invitations do not count
as people. A plan **paid for but never set up** (an unused paid grant) has its subscription cancelled, and the
grant is revoked.

The account's own rows are deleted and every other column that holds the handle is rewritten, in one batch, to
a **tombstone** — `deleted-<10 random characters>` — through the same `HANDLE_COLUMNS` list a rename uses.
The `persons` row becomes that tombstone (name "Deleted user", no e-mail, photo, picture, role or
responsibilities, dates reset to the deletion): it stays only because content must point at a person row (a
ticket's requester is a foreign key). The tombstone is in no organization, so no screen lists it; the
`deleted-` prefix is reserved, so nobody can sign up as one and inherit its work. Signing in again with the
same GitHub or Google account finds no identity and no verified address, and starts a new, empty account; the
old handle is free.

### What deletion removes and what it keeps (and why)

Turned into the Privacy Policy's text (`web/src/legal.ts` › 9. Deleting your account or an organization, and the retention table in 8; 2026-10-12): change one, change the other. "Removed" means hard-deleted from Trov's database (or R2)
at once; "kept" says why.

**An organization**

| | Removed |
|---|---|
| Content | docs and every version (staged, rejected and older ones included), decisions (ADRs), the feed and its tags, the org's tag list and what agents suggested for it (`org_tags`, `org_tag_suggestions`), the triage queue, the agent-ingest ledger, the roadmap plan and its versions, sprints (resources, progress), tickets (assignees, links, comments, status history — mirrored ones too), handoffs, prompts and versions, artifacts (pages, versions, links, pending uploads — soft-deleted ones too), doc images, and every search index over them |
| Captured from GitHub | pull request and issue events and their AI summaries, unmatched-login tasks, the Repo dashboard's events, snapshots and metrics, Sync runs |
| What Trov suggested | its suggestions (`ai_suggestions`) and every "Wrong?" pressed (`ai_feedback`) |
| Configuration and credentials | repositories, environments, every integration secret (encrypted) and the keys that sealed them, integration settings and their change history, the GitHub App binding and its repository list, the login-to-person attribution map |
| People and access | memberships, invitations (any status), MCP tokens for it, OAuth codes and connections that could act only there (with their access and refresh tokens; a connection that can act elsewhere only loses this organization), each member's e-mail preferences for it |
| E-mail | the digest outbox for it (and the rendered bodies kept in local/dev mode), its digest policy and schedule |
| The platform's records of it | its counters, its usage metering (per day, per person), its admin audit trail, support reports sent from it |
| Billing | Trov's mirror of its Stripe subscriptions, its checkouts, the grant it was created from |
| The `orgs` row | its name, slug, image reference, plan, plan state and Stripe ids |
| R2 | its artifact files, doc images and image — each unless another organization stored the same bytes |

| Kept | Why |
|---|---|
| Members' accounts, sign-ins and other organizations | they are people, not the organization's; each can delete their own account |
| ONE audit row, `org.delete` (a platform row): who deleted it, when, the slug, how many members it had, and its Stripe customer and subscription ids | accountability for an irreversible act, and the ids are what a billing dispute or a refund is looked up by; nothing of its content or people. Never pruned today (a retention bound is the owner's decision) |
| At Stripe: the customer, invoices, payments and the cancelled subscription | Stripe's records, kept for tax and accounting law; Trov cannot delete them. An operator can delete a Stripe customer in Stripe's dashboard on request, where the law allows |
| `billing_events` (Stripe event id, type, outcome — no payload, no org or person) | webhook idempotency; pruned after 90 days |
| R2 objects another organization (or person) also references | content-addressed: the same bytes are one object, still in use |
| The GitHub App on the GitHub account | Trov cannot uninstall it; uninstall it on GitHub if no other organization uses it |
| SaplingLearn's legacy `invites` table | pre-organization invitations for that one org; removed by the Phase 7 cleanup |

**An account**

| | Removed |
|---|---|
| Profile | name, e-mail (notification address), uploaded photo, provider picture URL, role and responsibilities, account dates — the row becomes the tombstone |
| Sign-ins | the GitHub and Google identities: login, Google subject and e-mail, every verified address, the GitHub account id |
| Sessions and agents | every session (all browsers), every MCP token in every organization, every OAuth connection with its organizations, codes and tokens |
| E-mail | digest preferences, every digest outbox row addressed to them (and local/dev rendered bodies to their addresses) |
| Memberships | every one (each organization's trail gets `member.leave` by the tombstone); the superadmin role |
| Attribution | every organization's map of a GitHub login to them |
| Invitations | the ones they accepted or declined, and SaplingLearn legacy invitations to their addresses |
| Support | the reports and messages they sent, signed in or signed out from one of their addresses |
| Grants | an unused one is revoked (a paid one's subscription cancelled); none keeps their handle, login or address |
| Rate limits | their counters (two days at most anyway) |
| Organizations nobody else is in | deleted whole, as above |
| R2 | their photo, unless someone else's is the same bytes |
| At Stripe | open checkouts they started are expired |

| Kept | Why |
|---|---|
| What they wrote or did in organizations that carry on — docs and versions, decisions, feed entries, tickets (as requester or assignee), comments, ticket history, sprints, handoffs (sent or addressed to them), prompts, artifacts, links, plan versions, triage decisions, settings they changed, integration history, Sync runs, per-person usage counts, the admin audit trail | the team's shared record, which the other members rely on. Every handle column names the tombstone instead (`HANDLE_COLUMNS`), as does the one sentence Trov writes with a handle in it (a handoff's feed line). The tombstone carries no personal data |
| The admin audit trail's entries about them | as above: their handle as actor or target, and their handle, GitHub logins and e-mail addresses inside an entry's details, are replaced by the tombstone (exact spellings) |
| ONE audit row, `person.delete`: the tombstone, who asked (themselves, or the superadmin), the organizations deleted with it, and `ref` — a keyed hash (HMAC under `COOKIE_SECRET`) of the old handle | accountability; the hash cannot be turned back into the handle, but lets the operator find the account again in a database restored from before the deletion and delete it again (below) |
| Trov's billing mirror for a continuing organization's subscription they bought (cancelled to the period's end) | the organization's billing record; its buyer is the tombstone |
| At Stripe: their customer record for any purchase (name, e-mail, address, tax id, card fingerprint, invoices) | Stripe's, for tax and accounting law; deletable in Stripe on request where the law allows |
| Text people typed that mentions them — "@alice" in a comment, their name in a doc | other people's words (and their own prose) are never rewritten |
| Their GitHub login in activity captured from an organization's repositories (pull requests, issues, commits, checks, mirrored issues' authors) | a copy of that repository's history on GitHub, naming a GitHub account, not the Trov account; it follows GitHub (remove it there) |
| Invitations another organization sent to their address or login and they never answered | that organization's record of whom it invited; it can revoke them. If they sign up again, they see them |
| E-mails already delivered | in recipients' mailboxes and Resend's delivery logs (Resend's retention) |

**Outside the database, for both — the operator must know and the Privacy Policy should say:**

- **D1 Time Travel.** Cloudflare keeps point-in-time history of the database (documented as 30 days on
  Workers Paid, 7 on Free — **verify in the Cloudflare dashboard** for this account). Deleted rows can be
  brought back by a whole-database restore until that window passes; after it, they are gone. Trov keeps no
  other backup (HANDOFF.md). R2 has no versioning configured by Trov (verify in the dashboard): a deleted
  object is gone.
- **Cloudflare Workers Logs** (`[observability] enabled`): request URLs (which can hold a handle or a slug,
  e.g. `/api/platform/persons/<handle>/delete`) and the Worker's scrubbed log lines, kept for the plan's log
  retention (verify in the dashboard). Not deletable per person from code.
- **Stripe, Resend, Anthropic (and Google, for summaries made before 2026-10-14)** keep what they were sent under their own terms: Stripe's records above;
  Resend's sent-mail logs; PR and issue text sent for summaries earlier.
- **Elsewhere**: agents' local copies (MCP clients, `.trov/` artifact pulls), and the person's own browser
  (the last organization's slug and display preferences in local storage).

### After a restore

A Time Travel restore to a point BEFORE a deletion brings that account or organization back, and loses the
audit row that recorded it. So, before restoring:

1. Save the deletions the restore will undo: `npx wrangler d1 execute trov --remote --json --command "SELECT
   action, target, detail FROM org_admin_audit WHERE action IN ('org.delete','person.delete') AND at > '<the
   bookmark's time>'"`.
2. Restore. Delete each `org.delete` target again by slug (Platform › the organization › Delete…).
3. For `person.delete`, list every handle (`SELECT handle FROM persons`) and run
   `COOKIE_SECRET=<production secret> node scripts/deletion-refs.mjs <deletions.json> <handles.json>`: it
   prints the handles whose `ref` matches; delete each again (Platform › Admins › Accounts). It only matches
   while `COOKIE_SECRET` is the one in use when they were deleted.

**Known limits.** A write already in flight at the instant an organization's batch commits can leave an
orphaned row with that `org_id` (nothing reads it — every read is scoped to an org that no longer exists). An
upload of the SAME bytes by another organization in the few milliseconds between `sweepR2`'s check and its
delete would find its object gone (an artifact or doc image upload registers a token first, which counts as a
reference, so this needs a photo or an org image). A very large organization is one D1 batch; past D1's
per-batch limits it would be refused whole (nothing deleted) and needs deleting in parts by hand.

## Before the first outside organization

`HANDOFF.md` has the deploy runbook. The decisions that are the owner's to make, not the code's, are listed
in `abuse-limits.md` › Residual risks (mail) and `data-layer.md` › Routes and gates (raw artifacts) — chiefly that
mail goes out from one platform address under names and organization names strangers choose, and that raw
artifacts are still served from the app's own origin.
