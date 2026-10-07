# Organizations — the operator's guide

For the person who runs a Trov deployment (the **superadmin**) and for an organization's **owner**. It
follows one organization from the day it is added to the day its team is working in it. The code behind
each step is named in brackets; the rules those modules obey are in `data-layer.md` and `abuse-limits.md`.

## Who is who

| | Scope | Becomes one by |
|---|---|---|
| **Superadmin** | the platform: the list of organizations, who owns each, suspension, usage, the audit trail | a row in `platform_admins` (0042_organizations seeds andres); another superadmin adds more in Platform › Admins & limits |
| **Owner** | one organization, everything in it | creating the organization with a grant (§1b), accepting a superadmin's owner invitation, or being made one by another owner |
| **Admin** | one organization, everything but owners and the encryption key | an invitation "as admin", or a role change by an admin or owner |
| **Member** | one organization: reads and the everyday writes | an invitation "as member" |

A person is one account (GitHub or Google sign-in) and may belong to any number of organizations, with a
different role in each. Being a superadmin is **not** a membership: it grants nothing inside an organization.

## 1. The superadmin adds an organization and names its admin

Platform › Organizations › **Add organization** [`web/src/platform.ts`, `POST /api/platform/orgs`,
`src/platform/repo.ts` `createOrgWithAdmin`]. Platform lives at **`/platform/`**, a page outside every
organization — so a superadmin who belongs to none still reaches it; the org switcher's menu and the org
picker link to it.

An organization comes to exist in one of two ways: the superadmin creates it for someone (this section), or
grants someone the right to create their own (§1b). Nobody else can create one.

Give the organization a name, a slug (its address: `/o/<slug>/`, not editable later), the **plan** it starts
on (Personal, Team or Enterprise — `plans.md`; Team unless you pick another) and its first owner:

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
and slug and become its owner, on that plan, and land on the setup checklist [`POST /api/orgs`]. One grant
makes one organization; until it is used you can **Revoke** it, and afterwards the Access tab shows which
organization it became.

That is the only way anyone but a superadmin creates an organization (`DEFAULT_ORG_LIMIT = 0`,
`shared/orgs.ts`). The per-person allowance that used to be set in Platform is gone.

### The organization's plan

Open the organization in Platform: its **Plan** section shows the plan, each limit and the seats in use.
**Change plan** sets the plan and, per organization, any of its limits [`PUT /api/platform/orgs/:slug/plan`].
The confirmation says what happens if the organization is over the new limits: nothing is removed and nobody
loses access; it cannot add more of that kind until it is back under. Everyone in the organization reads its
plan in Org settings › General; only you change it. The limits, what counts toward each and the seam for
billing: `plans.md`.

## 2. The owner signs in, accepts, and lands on the setup checklist

The mail links to the site root — never to a token; the invitation is matched to the person's
provider-verified address (or GitHub login) at sign-in [`src/orgs/repo.ts` `MINE`]. A person with no
organization lands on the **org picker**, which lists their invitations; **Accept** makes them a member
[`POST /api/invites/:id/accept`]. A new owner lands on **Org settings**, which opens with
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
  on a failure, the provider's reason. **Resend email** sends it again. A Google account can only sign in
  once it is invited.
- **By GitHub login**: no e-mail; the person sees the invitation the next time they sign in with that
  account.

An invitation takes a **seat** (a seat is a member or a pending invitation): Members shows "7 of 10 seats
used", and when none is free the form gives way to a sentence saying so. A Personal organization has no
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

The last owner can neither leave nor be demoted. Removing a member revokes their tokens and connected apps
for that organization at once; what they wrote stays. An agent acts as the person whose token it holds, in
the one organization that token was made for, and may only write to tickets assigned to that person
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

## 7. What the superadmin can and cannot see

**Can:** every organization's name, slug, status, creation date and creator; the GitHub account its App
installation is on, if any; its owners; its members'
handles, names, roles and titles; its pending invitations (the address or login, and whether the e-mail
went out); the usage **counts and sizes** above; and the audit trail — who created the organization, added
or removed whom, changed a role, set or rotated which integration (never a value: at most a credential's
last four characters and key version).

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
