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
3. **Connect GitHub** — done by step 1: an installation needs no token and no webhook. Trov reads through
   it with tokens GitHub issues for an hour at a time, and GitHub delivers events itself. Org settings ›
   Integrations shows it as one row — the account, who connected it, *Test connection*, *Manage on GitHub*,
   *Disconnect*. The other integrations are optional: Cloudflare analytics, and per environment the
   Railway token and the app-metrics token; each is **write-only** — once saved only its last four
   characters are ever shown, to anyone [`src/data/secrets.ts`, envelope-encrypted under the deployment's
   `TROV_KEK`].
4. **Invite your team** — next section.

**Who can connect it, and what can go wrong.** An admin or an owner, with the GitHub account linked to
their Trov account, which must be able to read every repository the installation covers. If a GitHub
organization's owner has to approve the App first, Repositories says the request is pending and nothing is
connected until they do. An organization connects one GitHub account at a time; an installation belongs to
one Trov organization. *Disconnect* ends it in Trov and leaves the App installed on GitHub. If the App is
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
| Make or unmake an owner; rotate the organization's encryption key | | | ✓ |

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
| Integrations | the GitHub App's connection (or, by hand, the token and webhook secrets); the other credentials; the encryption key and the history of changes | admin, owner |
| Repositories | Connect with GitHub; connected repositories, one primary; what the App can see to track; a by-hand repository's webhook URL | everyone (read), admin+ (write) |
| Environments | the environments the Repo dashboard reports on, in drift order | everyone (read), admin+ (write) |
| Members | the people directory; for admins also invitations, roles and titles, removal, and **Unmatched logins** — GitHub logins in captured activity to map to a person or discard [`web/src/identity.ts`] | everyone (read), admin+ (write) |
| Notifications | the e-mail digests: which exist and their default cadence, send hour, timezone and sender name, preview, test send, the outbox [`web/src/notifications.ts`] | admin, owner |
| General | the image; the name; the slug, read-only; the **Plan** — what it includes and the org's use of each limit [`web/src/org-plan.ts`] | everyone (read), admin+ (image, rename); nobody changes the plan here |

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
  `GET /org-logo/<sha>` with the person photo's headers. It is person-level, not tenant-gated: an invitee
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
artifact bytes, tokens and connected apps). Platform › an organization shows the same for that one.
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

## Before the first outside organization

`HANDOFF.md` has the deploy runbook. The decisions that are the owner's to make, not the code's, are listed
there under "Decide before a production deploy" and in `abuse-limits.md` › Residual risks — chiefly that
mail goes out from one platform address under names and organization names strangers choose, and that raw
artifacts are still served from the app's own origin.
