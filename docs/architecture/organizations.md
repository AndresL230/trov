# Organizations — the operator's guide

For the person who runs a Trov deployment (the **superadmin**) and for an organization's **owner**. It
follows one organization from the day it is added to the day its team is working in it. The code behind
each step is named in brackets; the rules those modules obey are in `data-layer.md` and `abuse-limits.md`.

## Who is who

| | Scope | Becomes one by |
|---|---|---|
| **Superadmin** | the platform: the list of organizations, who owns each, suspension, usage, the audit trail | a row in `platform_admins` (0042 seeds andres); another superadmin adds more in Platform › Admins & limits |
| **Owner** | one organization, everything in it | creating the organization, accepting a superadmin's owner invitation, or being made one by another owner |
| **Admin** | one organization, everything but owners and the encryption key | an invitation "as admin", or a role change by an admin or owner |
| **Member** | one organization: reads and the everyday writes | an invitation "as member" |

A person is one account (GitHub or Google sign-in) and may belong to any number of organizations, with a
different role in each. Being a superadmin is **not** a membership: it grants nothing inside an organization.

## 1. The superadmin adds an organization and names its admin

Platform › Organizations › **Add organization** [`web/src/platform.ts`, `POST /api/platform/orgs`,
`src/platform/repo.ts` `createOrgWithAdmin`]. Platform is reachable two ways: the sidebar's Platform entry
inside any organization the superadmin belongs to, and **`/platform/`**, a page outside every organization —
so a superadmin who belongs to none still reaches it (the org picker and the switcher's menu link to it).

Give the organization a name, a slug (its address: `/o/<slug>/`, not editable later) and its first owner:

- **An existing person** (their Trov handle): they are the owner at once. If it is their first organization
  they get the welcome e-mail.
- **An e-mail address**: Trov mails "You have been made the owner of <org> on Trov" and records the
  outcome on the invitation (Platform shows `email sent` / `email not sent`). The person signs in with that
  address — GitHub's verified e-mail, or Google — and accepts.
- **A GitHub login**: no e-mail is sent (Trov knows a login, not an address). Tell them it is waiting; they
  see it when they sign in with that account.

The superadmin is **not** made a member. To rescue an organization whose owner left, open it in Platform and
use **Add another owner** [`POST /api/platform/orgs/:slug/admin`].

Anyone can also create an organization for themselves from the org picker (three per person by default;
Platform › Admins & limits changes one person's cap).

## 2. The owner signs in, accepts, and lands on the setup checklist

The mail links to the site root — never to a token; the invitation is matched to the person's
provider-verified address (or GitHub login) at sign-in [`src/orgs/repo.ts` `MINE`]. A person with no
organization lands on the **org picker**, which lists their invitations; **Accept** makes them a member
[`POST /api/invites/:id/accept`]. A new owner lands on **Org settings**, which opens with
*Finish setting up <org>* [`web/src/org-settings.ts` `setupChecklist`]:

1. **Connect a repository** — Org settings › Repositories: `owner/repo`. The first one is the primary; a bare
   `#214` anywhere in the app resolves against it.
2. **Add an environment** — Org settings › Environments: a key (`staging`, `production`), the branch it
   deploys from, its web and API URLs. The Repo dashboard reports on each.
3. **Set the GitHub token** — Org settings › Integrations. Credentials are **write-only**: once saved only
   the last four characters are ever shown, to anyone [`src/data/secrets.ts`, envelope-encrypted under the
   deployment's `TROV_KEK`]. *Test connection* checks it. The other integrations are optional: Cloudflare
   analytics, and per environment the Railway token and the app-metrics token.
4. **Invite your team** — next section.

**The GitHub webhook.** Each repository row shows its own delivery URL, `/webhook/github/<id>`, and a
webhook secret (Integrations › *Set* generates one). In the repository's GitHub settings add a webhook to
that URL with that secret, content type JSON; pull requests, issues, pushes, reviews, deployments, checks,
workflow runs and commit statuses are what Trov reads. *Check deliveries* reports the last one received. Until it is set up,
Sync GitHub and the hourly reconcile still fill the dashboard from the token.

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

An invitation is as **member** or **admin**; only the superadmin's invitation makes an owner. Pending
invitations can be revoked. A person joining their first organization gets a welcome e-mail that links
into it. Every organization's mail is sent from the platform's one address, under the sender **name** its
admin sets in Maintenance › Notifications.

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
Requests are metered, not limited: there is no per-organization quota yet.

## 7. What the superadmin can and cannot see

**Can:** every organization's name, slug, status, creation date and creator; its owners; its members'
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
