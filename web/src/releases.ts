// What's new (Help › What's new): `#releases` is a grid of every release; each release
// has two pages, `#releases/<v>` (its release notes) and `#releases/<v>/patches` (its
// patch notes), where `<v>` is the version ("0.14") or "unreleased".
//
// Pure data + a pure renderer, no backend: RELEASES below is the whole record, and
// `releasesScreen` turns it into the screen's markup. Every string goes through `esc`.
//
// ── How to add the next release ──────────────────────────────────────────────
// Every PR that ships something adds its lines to the FIRST entry, "Unreleased":
// The RELEASE NOTES (the index cards, `#releases/<v>`) are for Trov's USERS; the PATCH
// NOTES (`#releases/<v>/patches`) are for the people who build and deploy it.
//   • `highlights` — for users: what you can now do, in product words (no files,
//     routes, tables, migrations or PR numbers). 3–6 lines per release.
//   • `headsUp`    — for users: a change they will NOTICE in the product, in plain words
//     (a limit, a removed option). Omit it when there is none.
//   • `ops`        — for whoever deploys: migrations to apply, secrets, triggers, plugin
//     updates. Shown as "Upgrade notes" at the top of the patch notes only.
//   • `patches`    — the granular log, grouped added / changed / fixed / removed. Terse,
//     may name files, routes and migrations; `code` in backticks; end a line with
//     `(#123)` to link that pull request on GitHub (github.com/AndresL230/trov — the repo moved from SaplingLearn/canopy; GitHub redirects old PR links).
//   • `prs`        — the pull requests the release carries (listed on the patch notes).
// A merge to `main` IS a production deploy, so the PR that merges a batch also cuts it:
// set `version` to the next `0.N`, `date` to the merge day (YYYY-MM-DD) and drop
// `unreleased` — main never carries an "Unreleased" entry. A small follow-up with too
// little for its own 3–6 highlights adds its patch lines (and PR) to the newest version
// instead. Newest first; dates never increase down the list
// (test/releases.test.ts checks the order, unique versions, and that every release has
// highlights).
//
// Versioning: `0.N`, one number per feature milestone (the merges that shipped together,
// usually a day or a few days of work), counted from the first deploy in June 2026.
// Every line below is traceable to a merged pull request, a commit on `main`, or — for
// Unreleased — the working tree it describes.

import { esc, attr, surface } from "./ui";
import { segmented } from "./segmented";


export interface ReleasePatches {
  added: string[];
  changed: string[];
  fixed: string[];
  removed: string[];
}

export interface Release {
  /** `0.N`, or "Unreleased" for the batch not yet deployed. */
  version: string;
  /** YYYY-MM-DD — the day it merged (for Unreleased: the day the entry was last updated). */
  date: string;
  /** Not deployed yet: rendered with an "Unreleased" tag instead of a ship date. */
  unreleased?: boolean;
  title: string;
  /** One line under the title. */
  headline: string;
  /** 3–6 bullets for people, in product words. */
  highlights: string[];
  /** For USERS: a change they will notice in the product, in plain words (never a
   *  migration, secret, deploy step or plugin version — those are `ops`). Omit when none. */
  headsUp?: string[];
  /** Upgrade notes for whoever deploys: migrations, secrets, triggers, plugin updates.
   *  Shown only at the top of the release's PATCH notes. */
  ops?: string[];
  patches: ReleasePatches;
  /** Pull requests on AndresL230/trov (formerly SaplingLearn/canopy — PR numbers carried over). */
  prs?: number[];
}

export const TROV_REPO_URL = "https://github.com/AndresL230/trov";
export const prUrl = (n: number): string => `${TROV_REPO_URL}/pull/${n}`;

export const RELEASES: Release[] = [
  // Billing. Built on top of Plans (0.19 below) while the GitHub App branch is also adding a release after
  // 0.18: three entries are in flight, so whichever merges later renumbers — versions must count down
  // without a gap (test/releases.test.ts) — and sets `date` to its merge day.
  {
    version: "0.20",
    date: "2026-10-07",
    title: "Paid plans",
    headline: "You can buy the Personal or Team plan and set your organization up yourself, and its owner manages billing in Org settings.",
    highlights: [
      "You can buy a plan. Choose Personal or Team, sign in, and pay on Stripe's page. When the payment is confirmed you name your organization and you are its owner. Enterprise is still arranged with Trov.",
      "After paying you land on a page that waits for the payment to be confirmed, then takes you to set up your organization. If confirmation is slow it says your payment was received and that your organization will be on your organizations page shortly.",
      "Org settings › General shows how a paid organization pays: when it renews, a payment that is past due, or a cancelled plan and the day it ends.",
      "An owner can open Manage billing to change the card, see invoices or cancel, can move the organization between Personal and Team, and can renew a plan that has ended. Each of these opens Stripe's own pages.",
      "When a plan's limit stops something in an organization that pays, its owner is pointed at Org settings to upgrade, manage billing or renew.",
    ],
    headsUp: [
      "Paid plans are switched on by Trov. Until they are, buying a plan says it is not available yet and nothing else changes.",
      "Organizations that Trov set up or granted are not billed, and their Plan section shows nothing about payment.",
      "A payment that is past due changes nothing while Stripe retries the card. If the retries run out, the plan ends.",
      "When a plan ends, everything in the organization stays and keeps working, and nobody loses access. You can't add people, repositories, environments, artifacts or agent connections until an owner renews it.",
      "Moving from Team to Personal with more than one person removes nobody and deletes nothing, but no one can be invited until the organization is back to one seat. Trov says so before you confirm.",
      "Signing in with Google does not create an account. To buy a plan as someone new, sign in with GitHub.",
    ],
    ops: [
      "Apply migration `0045_billing` (additive: the tables `billing_events`, `billing_checkouts`, `billing_subscriptions`; no column added to an existing table). Safe on live data and with the previous Worker running. Rollback steps are in the file's header.",
      "Billing is OFF until both secrets are set: `wrangler secret put STRIPE_SECRET_KEY` and `wrangler secret put STRIPE_WEBHOOK_SECRET`. While off, every billing route answers 503 `billing_unavailable` and `POST /webhook/stripe` answers a bare 401.",
      "Prices are not in Trov. Create the Products and recurring Prices in Stripe and paste the Price ids into `wrangler.toml` `[vars]`: `STRIPE_PRICE_PERSONAL`, `STRIPE_PRICE_TEAM`, and optionally `STRIPE_PRICE_PERSONAL_YEARLY`, `STRIPE_PRICE_TEAM_YEARLY`. A plan with no id cannot be bought.",
      "Add the webhook endpoint `https://trov.dev/webhook/stripe` in Stripe with `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.",
      "Configure the Stripe Customer Portal (payment methods, invoices, cancel; plan switching with both products) or Upgrade and Switch answer that the plan change could not be opened. Do one purchase in test mode with card 4242 4242 4242 4242 before live keys. The full checklist is in `docs/architecture/billing.md`.",
      "No cron trigger and no plugin change. The daily cron also prunes handled `billing_events` older than 90 days.",
      "Update the Terms and Privacy text for paid plans and Stripe as a processor before taking live payments.",
    ],
    patches: {
      added: [
        "Migration `0045_billing`: `billing_events` (each Stripe event id once), `billing_checkouts` (a Checkout Session bound to the person who started it), `billing_subscriptions` (Stripe's current state of each subscription, and the superadmin's pin)",
        "`src/billing/`: `stripe.ts` (the one fetch client: fixed host, no redirects, timeout, pinned `Stripe-Version`, an `Idempotency-Key` on every POST, every error scrubbed of the key), `config.ts`, `signature.ts`, `store.ts`, `sync.ts`, `webhook.ts`, `routes.ts`, `view.ts`, `pages.ts`; `shared/billing.ts` (the wire)",
        "`GET /billing/start?plan=personal|team[&interval=month|year]` (public: sign in and come back, or a Stripe Checkout Session), `GET /api/billing/config` (public), `GET /api/billing/status?session_id=` (the caller's own checkout)",
        "`POST /webhook/stripe`: `Stripe-Signature` verified over the raw body (several `v1`, a 5-minute tolerance), one bare 401 for every refusal, each event id handled once, every handler re-reads the subscription and converges",
        "Fulfilment calls `grantOrganization` with the subscription id as `external_ref`, so a replayed event and the waiting room's own look at Stripe make one grant; `createOrgFromGrant` links the org to the customer and subscription in the creating batch (`linkPaidOrgStmt`)",
        "`POST /api/o/:slug/billing/portal`, `/billing/change`, `/billing/renew` (owner, cookie only): each answers a URL on Stripe's pages",
        "`src/auth/return-to.ts`: a sealed, allowlisted return path taken by the sign-in tail after `oauth_pending`",
        "SPA: `web/src/billing.ts` (the waiting room at `/billing/done`, then `/?setup=<grant>` opens the picker on that organization's form), `web/src/org-billing-actions.ts`, the Plan block's billing states in `web/src/org-plan.ts`",
        "Platform: an org's row and page say granted or paid, Stripe's status and the period, with a link to the customer in the Stripe dashboard (test or live); Follow subscription",
        "The `checkout` limit: 10 Checkout Sessions per person per day (`src/platform/limits.ts`)",
        "`test/billing.signature.test.ts`, `billing.flow.test.ts`, `billing.lifecycle.test.ts`, `billing.leak.test.ts` (canary key against a Stripe that echoes it), `render.billing.test.ts`; the isolation matrix, the MCP import rule and the API prefix test cover the new routes",
      ],
      changed: [
        "`GET /api/o/:slug/plan` carries `billing` (`OrgBillingView`, null for a granted org) and `period_end` is now written",
        "A plan refusal (402 `plan_limit`) carries `paid: true` for an org that pays; `planRefusalSentence` points its owner at Org settings",
        "`PUT /api/platform/orgs/:slug/plan` on an org with a live subscription keeps it a billing org and pins a plan that differs from the paid one; `{ follow_subscription: true }` lifts the pin. On an ended subscription it takes the org back as granted",
        "`PlatformOrgPlan` carries `billing` for a paid org",
        "The grant notice e-mail has a paid wording, sent to the buyer's provider-verified address",
        "The picker says Paid for, not Granted by, on a grant a payment made",
        "`PlanDef.billing` stays null: a plan's price is deployment config",
      ],
      fixed: [],
      removed: [],
    },
    prs: [],
  },
  // Plans and grants. Another branch (the GitHub App) is also adding the release after 0.18: whichever
  // merges SECOND renumbers its entry to 0.20 and sets `date` to its merge day. This one is meant to be
  // 0.20; it reads 0.19 here only because shipped versions must count down without a gap and main
  // carries no Unreleased entry (test/releases.test.ts).
  {
    version: "0.19",
    date: "2026-10-07",
    title: "Plans",
    headline: "An organization is now on a plan (Personal, Team or Enterprise), and Trov can hand someone an organization to set up themselves.",
    highlights: [
      "Every organization is on a plan. Personal is for one person, Team is for up to 10 people, and Enterprise has limits Trov sets for that organization. Org settings › General shows your plan, what it includes, and how much of each limit you use.",
      "Org settings › Members shows your seats, like 7 of 10 seats used. A seat is a member or a pending invitation. When every seat is in use the invite form gives way to a sentence saying so, and how to free one.",
      "You can be given an organization of your own. When Trov grants you one, the page that lists your organizations says You can set up an organization, with its plan. You choose its name and address and become its owner.",
      "When a plan's limit stops something, Trov says which limit and who can change it, in one sentence, wherever it happens.",
    ],
    headsUp: [
      "Organizations that existed before plans are on Enterprise with no limit on people, so nothing changes for them.",
      "On the Personal plan there are no invitations: Members says the plan is for one person.",
      "If an organization ends up over a limit after its plan changes, nothing is removed and nobody loses access. You can't add more of that kind until it is back under the limit.",
      "A plan also limits connected repositories, environments, stored artifacts and how many agent connections each person has. Removing one you no longer use frees room.",
      "Create organization appears in the switcher's menu only when you have been given an organization to set up.",
    ],
    ops: [
      "Apply migration `0044_plans` (additive: nine columns on `orgs`, the tables `org_grants` and `platform_outbox_bodies`, and one backfill that puts every existing org on `enterprise` with `plan_source = 'granted'`). It is safe on live data and with the previous Worker running. Rollback steps are in the file's header.",
      "No secret, no cron trigger and no plugin change. No prices and no payment code: `src/plans/billing.ts` is the seam a billing integration calls, and `orgs.plan_period_end`, `orgs.billing_customer_id`, `orgs.billing_subscription_id` and `org_grants.external_ref` are reserved for it, written by nothing yet.",
      "Every plan number is a placeholder in `shared/plans.ts` `PLANS`: change a number there and nothing else. The numbers and what counts toward each are in `docs/architecture/plans.md`.",
      "`persons.org_limit` is no longer read and Platform's Organization limit control is gone. To let someone create an organization, grant them one in Platform › Access. Anyone given an allowance by hand before this needs a grant instead.",
      "A grant by e-mail sends a notice through the platform's own sender. `NOTIFICATIONS_MODE` is `local` today, so nothing leaves: the body is written to `platform_outbox_bodies`.",
    ],
    patches: {
      added: [
        "`shared/plans.ts`: the three plans, the five limits (`seats`, `repositories`, `environments`, `artifact_bytes`, `agent_connections`), `resolveEntitlements` (plan + per-org overrides) and `planRefusal`, the one answer to \"may this org add this now\"",
        "Migration `0044_plans`: `orgs.plan`, `plan_overrides`, `plan_source`, `plan_status`, the billing columns; `org_grants`; `platform_outbox_bodies`",
        "`src/plans/`: `state.ts` (the org's plan, the seat gate, `setOrgPlan`, `setOrgPlanStatus`), `gate.ts` (`requirePlan` for the limits counted over tenant tables, `orgPlanView`), `grants.ts`, `billing.ts` (the seam: `grantOrganization`, `setOrgPlan`, `markOrgPastDue`, `cancelOrgPlan`), `routes.ts`",
        "`GET /api/o/:slug/plan` (any member); `GET|POST /api/platform/grants`, `POST /api/platform/grants/:id/revoke`, `PUT /api/platform/orgs/:slug/plan` (superadmin)",
        "A plan refusal is HTTP 402 `{ error: \"plan_limit\", limit, used, cap, plan, status, message }` from every route (one `app.onError` in `src/routes.ts`), and an MCP tool error with `code: \"plan_limit\"`",
        "Enforcement at the write: an invitation created (members + pending) and accepted (members), the superadmin's owner, the legacy invite alias, a repository connected, an environment added, an artifact version stored (and its upload link), an MCP token minted and an app connected",
        "The grant notice e-mail (`src/notifications/grant.ts`, `platformDeliveryFor`): names the granter and the plan, links only to the site root",
        "Audit actions `plan.change`, `plan.overrides`, `plan.status`, `grant.create`, `grant.revoke`, `grant.use`",
        "SPA: `web/src/org-plan.ts` (the Plan block, the seats lead, the invite gate), `web/src/platform-access.ts` and `platform-access-actions.ts` (Platform › Access, the grant dialog, Change plan and its confirmation)",
      ],
      changed: [
        "`POST /api/orgs` creates an org by consuming one of the caller's grants (`grant` = its id, else the oldest) in the creating batch; refused with 403 `no_grant` otherwise, and for a superadmin",
        "`GET /api/orgs` carries `grants` (the usable ones) and `can_create` (holds one); `created` and `limit` are gone",
        "`POST /api/platform/orgs` takes `plan` and `overrides` (default `team`); `PlatformOrgRow` carries `plan` (plan, overrides, status, source, entitlements, seats used)",
        "The repository and environment caps (10 each) are the Enterprise plan's defaults now: `too_many_repos` / `too_many_environments` (409) became the 402 `plan_limit`",
        "Platform: the Organizations list shows each org's plan and seats; Add organization picks a plan; the tab Admins & limits is Admins",
        "The setup checklist leaves out Invite your team on a one-person plan",
        "A dropdown opened inside a dialog that is still sliding in is placed again once it settles (`web/src/dropdown.ts`)",
      ],
      fixed: [],
      removed: [
        "`PUT /api/platform/persons/:handle/org-limit`, `setOrgLimit`, `orgAllowance`, the error code `org_limit` and Platform's Organization limit form. `persons.org_limit` stays as a dead column until the cleanup migration",
      ],
    },
    prs: [],
  },
  {
    version: "0.18",
    date: "2026-10-06",
    title: "Organizations",
    headline: "Trov now runs for any number of teams: each has its own organization, invites its own people, and you switch between the ones you're in.",
    highlights: [
      "Trov now holds more than one organization. Each has its own docs, tickets, roadmap, feed, handoffs, prompts and artifacts, and nothing crosses from one to another. Tickets and handoffs are numbered from #1 in each organization. The switcher at the top of the sidebar shows the one you're in and takes you to the others.",
      "Anyone with a GitHub account can sign in and accept an invitation to an organization. New organizations are added by whoever runs Trov for now. A new page lists your organizations and your invitations when you belong to none, or to several.",
      "Org settings is the one place an organization is run from: Members is the people directory, Notifications holds the email digest settings, and Maintenance is gone (its queue is now Triage › Unplaced). In Members, invite people by GitHub login or email, make them an admin or a member, give them a title, or remove them. An email invitation is sent by Trov, names your organization, and the page shows whether it went out; you can send it again. Owners manage other owners.",
      "Org settings also holds what used to be set by whoever deploys Trov: the repositories an organization tracks, the environments its Repo dashboard reports on, and the credentials Trov uses for it. A credential is write-only: once saved, only its last four characters are ever shown.",
      "Connecting Claude Code is per organization: you pick the organization when you allow the connection, and Settings › MCP access shows which one each connected app reaches.",
      "A new organization's admin gets a short checklist: connect a repository, add an environment, set the GitHub token, invite the team. Each Org settings tab starts with one line saying what is set and what needs attention, and a row opens for its details.",
    ],
    headsUp: [
      "The address of every page now starts with your organization, like /o/your-org/. Old links and links in emails still open, in your organization if you have one, or the last one you used.",
      "Maintenance is split up. Its Unplaced queue is now Triage › Unplaced in the sidebar. People is Org settings › Members, which you open from the switcher at the top of the sidebar: the directory for everyone, and inviting, roles and titles for admins. Identity is there too, as Unmatched logins. The email digest settings are Org settings › Notifications. Old Maintenance links open the new place.",
      "The sidebar's Unplaced count is the queue alone. Logins waiting to be matched are counted on the organization switcher and on the Members tab, for admins only.",
      "Admin now means admin or owner of the organization you're in. If you could sync GitHub, change the email digest or delete other people's prompts and artifacts before and can't now, ask an owner to make you an admin in Org settings › Members.",
      "Signing in with GitHub no longer requires being in a particular GitHub organization. Signing in with Google still needs an invitation.",
      "An organization can have an image, shown beside its name everywhere. An admin uploads one in Org settings › General; without one, Trov uses the GitHub picture of whoever owns the organization's main repository. An uploaded image is never replaced by GitHub's.",
      "A person's title is set per organization.",
      "A ticket or handoff number is its number within your organization. Existing tickets and handoffs keep the numbers they had, so old links still open the same ones.",
      "The email digest's sender is a name now, not an address: every organization's mail is sent from Trov's own address under the name its admin picks.",
      "A few actions have a daily limit per person (invitations, test emails, changing your digest address, photo and organization image uploads). When you reach one, Trov says when you can try again.",
      "Typing a bare issue number like #214 as a link needs a repository connected in Org settings; without one, paste the full link.",
    ],
    ops: [
      "Before applying the multitenancy migration (`0042_organizations`: one file, all-or-nothing; `0041_trov_name` is already applied), take `wrangler d1 export` (data, base tables — see `scripts/mt/verify-migration.mjs`) and note the D1 Time Travel bookmark; run `node scripts/mt/verify-migration.mjs` on the export (it also checks that every existing ticket's and handoff's per-org number equals its id, which is what keeps old `#12` links pointing at the same row); then `npm run db:migrate:remote` (the scripts now name the D1 database `trov`, as `wrangler.toml` does). Rollback: Time Travel + `wrangler rollback`, or by hand `scripts/mt/rollback/0042_organizations.down.sql` (the whole migration, back to the schema before it; it does not undo `0041`'s sender rename and refuses once a second organization exists).",
      "Set the `TROV_KEK` secret before this deploys: 32 random bytes, base64 (`openssl rand -base64 32`, then `wrangler secret put TROV_KEK`). It encrypts every organization's stored credentials; without it Org settings › Integrations answers 503 `secrets_unavailable` and no credential can be saved. Keep a copy: losing it loses every stored credential.",
      "Confirm the Worker is on Workers Paid before a second organization adds environments: the background jobs spend up to 900 subrequests per cron invocation (`CRON_SUBREQUEST_BUDGET`, `src/repo/dispatch.ts`); the free plan's cap is 50.",
      "Enter SaplingLearn's credentials in Org settings › Integrations: the GitHub token, the webhook secret, the Cloudflare analytics token and account id, and each environment's Railway and app metrics tokens. Until each is stored, the Worker secret it replaces still answers for SaplingLearn only (`GITHUB_SERVICE_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `CF_ANALYTICS_TOKEN` + `CF_ANALYTICS_ACCOUNT_ID`, `RAILWAY_TOKEN_<ENV>`, `SAPLING_METRICS_TOKEN`). Then re-point SaplingLearn's GitHub webhook at `/webhook/github/hook_saplinglearn_sapling`; the legacy `/webhook/github` keeps working until then.",
      "Promote SaplingLearn's admins: `0042_organizations` makes andres the owner and everyone else a member, and `ADMIN_LOGINS` no longer grants anything on a signed-in route. Anyone who should keep admin rights is made an admin in Org settings › Members.",
      "`0042_organizations` seeds andres as the one superadmin. The Platform area reads it: inside an organization (the sidebar's Platform entry) and at `/platform/`, which needs no membership. A superadmin has no access to an organization's content. The same migration adds `identities.provider_uid`, which pins a GitHub identity to the account's numeric id at each person's next sign-in.",
      "`0042_organizations` adds four nullable columns to `org_invites` (the invitee's name and the invitation email's outcome). Invitations and the welcome are real mail once `NOTIFICATIONS_MODE` is `resend`: verify trov.dev as a sending domain first, since every organization's mail goes out from `hello@trov.dev`.",
      "`0042_organizations` adds five nullable columns to `orgs` (the organization's image and where it came from); no backfill. Images are stored in the artifacts R2 bucket under `org-logos/`. An organization with a repository and a GitHub token gets its image at the next 6-hourly reconcile; the import asks `api.github.com` and `avatars.githubusercontent.com` only.",
      "The Worker now answers `GET /o/*` and `GET /platform*` with the app shell. `GITHUB_REPO` and `REPO_ENVIRONMENTS` are read only as SaplingLearn's seed (`0042_organizations` copied them into its repository and environment rows); change them in Org settings from now on.",
    ],
    patches: {
      added: [
        "Multitenancy schema (`canopy-multitenancy.md`): ONE migration, `0042_organizations`, in ten sections — orgs (orgs, memberships, org invites, repos, environments, integration-secret tables, per-org attribution map, counters; SaplingLearn seeded as `org_saplinglearn`), tenant columns, tenant rebuilds (20 tables re-keyed by org, ending in a foreign-key guard that fails the whole migration), tenant FTS (every search index org-scoped), then the platform admins, platform orgs, identity uid, abuse limits, invite mail and org logo additions; per-org ticket and handoff numbers; a generated rollback (`scripts/mt/build-rollback.py`) and a production-copy check (`scripts/mt/verify-migration.mjs`); CI on every push (`.github/workflows/ci.yml`). Nothing on screen changes yet",
        "Data layer (`src/data/`): every repository takes a `TenantContext` or a `PlatformContext` and every tenant statement binds its org; D1 is reachable only there, enforced by `test/data-layer.static.test.ts`; cross-org isolation suites `test/isolation.*.test.ts`",
        "Routes: every tenant route is served at `/api/o/:slug/<suffix>` behind a membership gate (404 for a non-member) and, for the cut-over, at its old path for a person in exactly one org (409 `org_required` otherwise); `GET /api/orgs`, `POST /api/orgs`, `POST /api/invites/:id/accept|decline`, `GET /api/o/:slug/me` (role, title, connected repositories); org roles replace `ADMIN_LOGINS` on every session route; `identities.provider_uid` (`0042_organizations`, section 7)",
        "Orgs, members, invites and the superadmin surface (`src/orgs`, `src/platform`, `0042_organizations` sections 5–6): Platform › Organizations (add, suspend / unsuspend, owners), Usage, Admins & limits, Audit — `web/src/platform*.ts`",
        "Per-org integrations (`src/integrations`, `shared/integrations.ts`): envelope-encrypted, write-only secrets under `TROV_KEK`, Test connection, an audit trail, key rotation; Org settings (`web/src/org-settings.ts`, `integrations.ts`, `org-actions.ts`): Integrations, Repositories, Environments, Members, General, and the setup checklist",
        "MCP: a token and an OAuth grant are bound to (person, org); `GET/POST /api/o/:slug/mcp-tokens`, the consent page's org picker, `GET /auth/oauth-grants` rows carry their org",
        "Background work per org: the rotation dispatcher (`src/repo/dispatch.ts`), per-(org, environment) jobs, `POST /webhook/github/:hookId`, one digest per (person, org)",
        "The SPA at `/o/<slug>/` with the hash route after it: `src/index.ts` answers `GET /o/*` with `index.html` from the assets binding; `/` opens the person's only org, the last one opened in the browser (`trov.org`) or the org picker; sign-in returns to the org it started from (`web/src/org-context.ts`)",
        "One API prefix: `web/src/api.ts` `apiUrl` puts every tenant request under `/api/o/<slug>/` and one sender carries them all; a 404 confirmed by the membership gate lands on the picker; `test/api.prefix.test.ts` calls every exported request function and fails on an unprefixed tenant path",
        "The org switcher in the sidebar header, the org picker / first run and the create-organization dialog (`web/src/org-picker.ts`, `org-picker-actions.ts`)",
        "Settings › MCP access: each connected app shows its org; the caller's access tokens for the current org are listed with Revoke",
        "`confirmModal` takes `tone: \"neutral\"` (the accent button); Platform's Unsuspend uses it",
        "Invitation mail from the org routes (`0042_organizations`, section 9): `POST /api/o/:slug/invites` takes an optional `name`, mails an email invite and returns `name` / `mail_status` / `mail_at` / `mail_error` on the row; `POST /api/o/:slug/invites/:id/resend`; the superadmin's owner invite (`POST /api/platform/orgs`, `…/orgs/:slug/admin` with `{ email }`) sends the same mail worded for an owner; the mail names the org, the inviter and the role and links to the site root only (`src/orgs/mail.ts`, `src/notifications/invite.ts`)",
        "The welcome mail names the org, links into it, and is sent on a person's first membership of any org: accepting an invitation, creating an org, or being named its owner",
        "Raw artifact serving per org: `GET /api/o/:slug/raw/a/…` — the same sub-app, headers, sandbox, CSP and access rules as the `/raw/a/…` alias (`test/artifacts.security-raw.test.ts` runs its header table against both)",
        "`/platform/`: the Platform screens in a minimal shell outside any org, for a superadmin with no membership; linked from the org picker and the switcher's menu; `src/index.ts` answers `GET /platform*` with the app shell",
        "`src/tools/org-links.ts`: links in MCP tool results and digest emails carry the org (`<origin>/o/<slug>/#…`, `<origin>/api/o/<slug>/raw/a/…`)",
        "`shared/sender.ts`: the mail sender-name rule, one definition for the Worker and the SPA; `test/numbers.per-org.test.ts`, `test/org-invite-mail.test.ts`",
        "The organization's image (`0042_organizations` section 10, `src/orgs/logo.ts`, `web/src/org-logo.ts`): `POST /api/o/:slug/logo` and `…/logo/remove` (admin+, cookie only, audited, 20 uploads a day per person), `GET /org-logo/<sha>` served like a person's photo, `logo_url` on every org the API returns, and an import of the primary repository owner's GitHub avatar (on connecting a repository, setting the token, the reconcile, and removing an upload) that never replaces an uploaded image; `test/org-logo.test.ts`, `test/render.org-logo.test.ts`",
      ],
      changed: [
        "Admin-only controls (Sync GitHub, Poll now, the email digest settings, deleting someone else's prompt or artifact) read the role in the org on screen (`viewerIsAdmin`); `/auth/me`'s `admin` / `org` / `role` are no longer read by the SPA",
        "Maintenance is consolidated into Org settings: the screen (still `maintenance` in state) is the Unplaced queue alone, titled Unplaced, at `#unplaced`, with no tab bar; `#maintenance` resolves to it and `#maintenance/identity` / `#maintenance/people` to `#org/members` (`web/src/hash.ts`). Identity is Org settings › Members › Unmatched logins (`web/src/identity.ts`, admins only); the admin email-notification sections are the new Org settings › Notifications tab (`notificationsAdminSections`, admin+); the People tab, its pointer and `peopleSection` are gone (Members is the directory). `triageCounts().maintenance` counts unplaced items only; `identityCount` (admins) shows on the org switcher, its Org settings row and the Members tab",
        "Org settings › Members sends and re-sends the invitation email through the org routes, for an admin in any number of orgs, takes the invitee's name, and shows each pending invite's email outcome",
        "A ticket's and a handoff's `id` on every surface is its per-org number (spec §12 Q2): route params and bodies (`/tickets/:id`, `child_id`, `after_id`, `/handoffs/:id`), every MCP ticket / handoff tool, quick search (`#12`), My Work, a sprint's ticket list, an artifact's link to a ticket. The global row id no longer leaves the Worker. `MyWorkTicket.number` is gone (`id` is the number)",
        "`POST …/admin/poll` and `…/admin/poll-usage` results: a source the org has not set up reads \"Not connected — set it up in Org settings › Integrations\"; Sync GitHub's 503 for an org with no repository or token says so and offers Org settings",
        "Org settings, Platform and the org picker share one hierarchy (`web/src/org-ui.ts`): a tab opens with a lead line (`tabLead` — what is there, what needs attention, the tab's one accent action), sections are the uppercase eyebrow (`orgHead`, `.cnpy-sechead`), a row shows a name, a status chip and one quiet action and opens to the rest (`openRow`, `orgRowToggle`, `OrgUi.openRows`), and destructive actions are text (`dangerLink`). Integrations' status chip is one word (the last four move to the row's metadata), its encryption key and history are rows at the foot; the setup checklist is one line; an environment's Delete is in its edit form; Platform's Add organization is the Organizations tab's lead action, not a header button; a Platform organization's page lists members and pending invites together, with Add an owner behind a button (`platOwnerToggle`)",
        "Org settings › Notifications: the sender is a NAME field over the fixed address, checked with the Worker's rule; a 429 `rate_limited` is one sentence with the local time wherever a limited route is called",
        "A sprint's `lead` must be a member of the org (`create_sprint`, the plan write): a non-member is a 400 and nothing is written",
        "A bare issue ref (`#214`) on a ticket link or sprint resource resolves against the org's primary repository only; with none connected it is a 400 that names Org settings › Repositories",
        "`package.json` `db:*` scripts, `scripts/mt/verify-migration.mjs` and the rollback headers name the D1 database `trov`",
        "Issue, pull request and commit links, the new-artifact repo list and a new handoff's default repo come from `GET /api/o/:slug/me` (`web/src/github.ts`); with no repository connected a bare `#12` is plain text and the Repo dashboard, the artifact form and the handoff form link to Org settings › Repositories",
        "The Repo dashboard's not-connected sentences name Org settings › Environments / Integrations instead of Worker variables and secrets",
        "Per-repository webhook URLs are shown as live (`WEBHOOKS_LIVE`); a webhook secret's test is \"Check deliveries\", and no delivery yet reads as waiting, not failed",
        "`GET /api/orgs` is loaded once at boot into `state.myOrgs`; the Platform and Org settings controllers both read it",
        "The landing page, the sign-in dialog, the two refused-sign-in screens and the Get Started guide state the new rules: any GitHub account signs in; Google needs an invitation",
        "The sidebar: Org settings moved into the switcher's menu; below 990px and again below 850px of height the rail tightens so every entry, Platform included, stays on screen at 800px",
        "Sign-in checks no GitHub org; onboarding creates a person with no membership (a live legacy SaplingLearn invite is still consumed as one)",
      ],
      fixed: [
        "Switching tabs in Org settings or Platform replayed the screen's entrance and could flash a loading state: the entrance is keyed on the page without its tab (`pageKey`, `web/src/hash.ts`), both pages are patched in place so the tab bar is the same element and only the panel is replaced (`data-morph` / `data-morph-key`, `web/src/morph.ts`), a loaded slice is refreshed behind what is on screen, and Platform reads every tab when it opens (`test/tabs.instant.test.ts`)",
        "A doc image in Review's Rendered view was requested at `/img/<sha>`; it is the org's, at `/api/o/<slug>/img/<sha>`",
        "HTML, image and PDF artifact previews, thumbnails, Download and Open in new tab work for a person in several orgs (they load the org's raw route)",
        "A superadmin who belongs to no organization can reach Platform",
        "Accepting an owner invitation lands on Org settings, where the setup checklist is; the checklist's \"Invite your team\" step is no longer ticked by the owner's own accepted invitation",
        "Poll now on an organization with no repository connected shows its answer (every source not connected) above the empty state instead of nothing",
        "Settings › Account no longer truncates \"Signed in as …\" at narrow tile widths: the line wraps",
      ],
      removed: [
        "`REPO_URL`, `ARTIFACT_REPOS` and the hardcoded handoff repo in the SPA; the `admin_handle_not_allowlisted` toast (the Worker no longer sends it); the landing dialog's \"Preview the non-member screen\" link",
        "`PUT /api/people/:handle` and every legacy `/invites…` route are no longer called by the SPA (alias-only on the Worker until the cleanup phase)",
        "The artifact viewer's \"This preview can't open here yet\" state; `DEFAULT_TICKET_REPO` (`shared/tickets.ts`); the unused `.cnpy-roleedit*` styles",
      ],
    },
  },
  {
    version: "0.17",
    date: "2026-10-06",
    title: "Canopy is now Trov",
    headline: "Same tool, new name and a new logo — plus public Terms of Service and Privacy Policy pages.",
    highlights: [
      "Canopy is now called Trov — in the app, on the site, in every email and in the Claude Code plugin. Your docs, tickets, sprints, handoffs, prompts and artifacts are exactly where they were.",
      "Your theme and sidebar settings carry over to the new name on their own.",
      "A new logo: the Trov mark replaces the three bars in the app, on the site, in the tab icon and in every email.",
      "Terms of Service and Privacy Policy now have their own pages, linked from the site's footer.",
    ],
    headsUp: [
      "The Claude Code plugin is now called Trov. Remove the old Canopy plugin and install Trov — Settings › MCP access shows the two commands — then sign in again from Claude Code.",
      "If you connected Claude Code without the plugin, connect it again under the new name from Settings › MCP access. Tokens you already use keep working.",
    ],
    ops: [
      "Apply migration `0041_trov_name`: the untouched default sender becomes `Trov <hello@trov.dev>` (digests, invites, welcome mail, the unsubscribe mailto, and the Terms / Privacy contact). BEFORE it deploys, verify trov.dev as a Resend sending domain (SPF / DKIM) and make sure hello@trov.dev receives mail — otherwise every send fails and lands as `failed` in the outbox.",
      "Trov plugin 0.7.0 — the plugin, its marketplace and the auto-wired MCP server are renamed `trov`. Everyone reinstalls: `/plugin uninstall canopy`, `/plugin marketplace add AndresL230/trov`, `/plugin install trov@trov`, then `/mcp` → trov → Authenticate. Agent tools are now `mcp__trov__…`; a by-hand `claude mcp add … canopy` server must be re-added as `trov`.",
      "Unchanged on purpose: the canopy.saplinglearn.com domain the app is served from, the Worker / D1 `canopy` / R2 `canopy-artifacts` names, the `canopy/coverage|bundle-kb|todo` commit statuses Sapling's CI posts, the `canopy-health` / `canopy-metrics` user-agents in the metrics contract, and tickets' stored `source = 'canopy'`.",
    ],
    patches: {
      added: [
        "Terms of Service and Privacy Policy: two public pages at `/terms` and `/privacy` (Vite inputs `web/terms.html` / `web/privacy.html`, content and renderer in `web/src/legal.ts`, boot in `web/src/legal-page.ts`), linked from the landing page's footer (`siteFooter`, now in `web/src/site-chrome.ts` and shared with both pages); readable signed out, following the app's stored theme",
        "The Trov mark (`shared/mark.ts`: one path, brand purple `#616ACB` on light and the dark theme's green `#9aab65` on dark, through a `--mark` token) replaces the three-bar mark in the sidebar, sign-in, landing, legal and OAuth pages; the tab icon (`favicon.svg`, `favicon.ico` in place of `favicon-32.png`, an apple-touch icon); the email banner draws it as table cells",
        "`web/src/storage-migrate.ts`: moves every `canopy.*` browser key (theme, feed / prompt view, rail, open nav groups, sign-in return-to) to `trov.*` once, at boot",
      ],
      changed: [
        "Renamed Canopy → Trov across the app, landing page, legal pages, emails, OAuth consent pages, MCP server name and tool descriptions, skills (the `canopy` skill is now `trov`), plugin and marketplace (`plugins/trov`), README / AGENTS / CLAUDE.md; `canopy.css` → `trov.css`; repo links → AndresL230/trov",
        "New MCP and OAuth tokens are minted `trov_mcp_` / `trov_oat_` / `trov_ort_`; `canopy_*` tokens issued before the rename still resolve",
        "`trov` is a reserved handle (beside `canopy`)",
      ],
      fixed: [
        "The record-session skill and the `query` reference named the doc spaces `sapling` / `canopy`; they are `product` / `technical` (0020)",
      ],
      removed: [],
    },
  },
  {
    version: "0.16",
    date: "2026-09-27",
    title: "Photos, roles and person cards",
    headline: "Click anyone's name to see their photo and role, upload your own photo, and agents can read what each person owns.",
    highlights: [
      "Click anyone's name — on a ticket, in the Feed, in search or in Maintenance › People — to see their card: their photo, name, role, when they joined and their GitHub.",
      "Click your photo in Settings › Profile to upload a new one or remove it. It's cropped to a square and shows everywhere your avatar does; removing it goes back to your GitHub or Google picture.",
      "Everyone has a role, shown on their card. Admins set it, with each person's responsibilities, in Maintenance › People. Responsibilities aren't shown anywhere: agents read them when deciding whom to assign work.",
      "Tickets you filed in Canopy can be deleted from the ticket page (tickets mirrored from GitHub can't), after a confirmation.",
      "In Maintenance › Identity, discard a GitHub login that isn't on the team — outside contributors stop showing up there, even when they open another pull request, and Undo brings one back.",
      "Agents can now assign and unassign people on existing tickets — when the person they work for is an admin, the ticket's requester or already on it. Tickets mirrored from GitHub included.",
    ],
    headsUp: [
      "Opening Settings no longer lights up the account chip at the bottom of the sidebar as if it were a selected row.",
      "Your picture and name no longer change with the way you sign in. If you linked both GitHub and Google, the picture you have now stays — it only updates when that same provider's picture changes — and a name you set in Settings sticks.",
      "Settings no longer mints MCP tokens — connect with the steps on Settings › MCP access and sign in in the browser. Tokens you already use keep working.",
      "Settings' boxes are only as tall as what they hold, and MCP access now walks you through the browser sign-in, with your connected apps right under it.",
      "Canopy now opens in Light mode — the landing page and the app — until you pick a theme. A theme you already chose in Settings › Appearance or with the toggle stays as it is.",
    ],
    ops: [
      "Apply migration `0036_person_profiles` with `npm run db:migrate:remote` before this deploys.",
      "Canopy plugin 0.6.8.",
    ],
    patches: {
      added: [
        "Migration `0036_person_profiles`: `persons.avatar_sha`, `role`, `responsibilities`; `shared/people.ts` — `ROLE_MAX`, `RESPONSIBILITIES_MAX`, `AVATAR_MAX_BYTES`, `AVATAR_TYPES`, `avatarSrc` and the profile DTOs (#89)",
        "`GET /api/people/:handle` / `PUT /api/people/:handle` (admins only), `POST /api/people/me/avatar` and `/avatar/remove`, `GET /avatar/<sha>`; `GET /persons` and `/auth/me` carry `role` and a resolved `avatar_url` (#89)",
        "`web/src/profile.ts` `personCardModal`: the person card a click on a name opens (the confirm modal's shell) — no People screen, no profile page; `GET /api/people/:handle` returns only the card's fields (#89)",
        "Settings › Profile: the avatar is the photo control — a hover veil with a camera, and a click menu with Upload (Change) photo, Remove photo over an uploaded one and the accepted types (`web/src/avatar.ts` centre-crops to a 512px square and encodes WebP, else PNG, before upload) (#89)",
        "Tickets: `POST /tickets/:id/delete` hard-deletes a native ticket (any member, never MCP; a ticket mirrored from GitHub is a 403); Delete ticket in the rail, through the confirmation modal (#89)",
        "Maintenance › Identity: `POST /identity-tasks/:login/discard` / `restore` — a soft, sticky discard (`identity_tasks.status = 'discarded'` + `resolved_at` / `resolved_by`, no migration; the login's PK keeps it from being re-raised, its events are still captured); a Discard on each card, a \"Discarded @login · Undo\" toast, and an \"N discarded\" list with Restore; `GET /identity-tasks` adds `discarded` (#89)",
        "MCP `assign_ticket { id, login, on }` (issue #90): adds or removes one assignee over the web's `toggle_assignee`, scoped to an admin, the ticket's requester or a current assignee (`assertTicketAssignable`); idempotent with no write, never changes status; the `tickets` / `canopy` skills and `create_ticket`'s description say so (#89)",
      ],
      changed: [
        "`personChip` draws the initials under the photo; a photo that fails to load is dropped for the session (one capture-phase `error` listener), so it falls back to initials instead of a broken image (#89)",
        "Quick search: a person hit opens their person card, with their role as the context line (was the queue filtered to them) (#89)",
        "The ticket rail's requester and assignees, the Feed's authors and Maintenance › People's rows open the person card; Maintenance › People shows each role and, for admins, Edit role — the one role + responsibilities editor (#89)",
        "Every name or photo opens the person card — the ticket queue (table rows and board cards), sprints and the Timeline's lead, handoffs, prompts, artifacts, docs, Review, Unplaced, the Repo dashboard's contributors and activity, the Feed's review box and Settings › Account — as one photo + name chip (`personLink`) where both fit; a card or row that opens something else is a container with its own click target laid over it (`ui.ts` `hitArea`), so a person is never a button inside a button (#89)",
        "Repo dashboard: PR authors and contributors show their avatar photo (#89)",
        "The default theme is Light (`initialState().theme`, was Dark), for the landing page and the app alike; a stored `canopy.theme` still wins (#91)",
        "Sidebar: no selected fill on the account chip while Settings is open or on hover — only its gear turns (#89)",
        "Maintenance: Unplaced / Identity / People are an underline tab bar at the top of the page body (`maintTabBar`, each tab with its count badge — the new `tabBar()` in `web/src/tabs.ts`, page-level sections as opposed to `segmented()`'s values: text tabs on a hairline, a 2px accent underline that slides between them via `syncTabBars`, tablist semantics and ←/→ / Home/End) instead of a sub-page list under the sidebar entry, which is now a plain row with its badge; the tabs are peers, so the header drops the \"Maintenance › Identity\" back-button crumb, and a tab switch no longer replays the screen's entrance; `maintenance` leaves `NAV_GROUPS` (#89)",
        "Roadmap: Narrative / Timeline are the same underline tab bar at the top of the page body (`roadmapTabBar`, the Timeline tab carrying the red overdue dot) instead of a `segmented()` switch in the header — both tabs open in one page frame so the underline slides and the bar never moves (`asideColumns` takes an optional `tabs` head for the Narrative's columns), the New sprint panel opens under its line, New sprint stays in the header, and a switch is one rerender (`setRoadmapTab`) that never replays the entrance (#89)",
        "Repo dashboard: Overview / Code / CI & Deploys / Usage / Team & Planning are the same underline tab bar at the top of the page body (`repoTabBar`, in every state of the dashboard — loading, failed, degraded, sample, nothing connected — with the sample / degraded banner, the Poll now strip and the not-connected footer under its line) instead of a sub-page list under the sidebar entry, which is now a plain row — `repo` leaves `NAV_GROUPS`, so only Docs keeps one; a switch (`setRepoTab`) is one rerender with no reload and no replayed entrance, the new tab's content rising in with its bars, fills, sparklines and deploy dots; the header crumb is just the repo slug; quick search's Repo › … entries and `#repo/<tab>` still land on their tab (#89)",
        "Settings: ONE bento grid with even edges — Profile | Account | MCP access (spanning two rows), Appearance under the first two, Email notifications full width — every tile stretched to its grid area, content balanced so a stretch is a few pixels, Profile's color and Account's sign-in methods pinned to the tile's foot (`.cnpy-tile-foot`); MCP access (`mcpAccessSection`) is OAuth only — one line, three browser sign-in steps (`PLUGIN_INSTALL`), Connected apps capped at 3 rows with Show all (no fixed-height scroller), and a Set it up without the plugin link that opens the by-hand `claude mcp add` in a modal (`mcpSetupModal`), so the tile never changes height; the Get Started guide says the same (#89)",
      ],
      fixed: [
        "A person with GitHub and Google linked got the picture (and the name) of whichever they signed in with last: the provider picture now has one owner, `persons.avatar_source` (0036 PART B, backfilled from the picture's host) — only that provider's sign-in refreshes it, and a sign-in never writes the name, so a Settings edit sticks (#89)",
      ],
      removed: [
        "Settings' token UI: Get connection command (`connectModal` / `connectSnippet` / `CONNECT_CLIENTS`, and with it the Codex, `.mcp.json`-with-header and Token only setups), the token list (`tokenListBody`) and the web client's `mintMcpToken` / `listMcpTokens` / `revokeMcpToken`; the guide's `connect` figure. The `/auth/mcp-token*` routes, `canopy_mcp_` bearer resolution and `mcp_tokens` stay, so existing tokens keep working (#89)",
      ],
    },
    prs: [89, 91],
  },
  {
    version: "0.15",
    date: "2026-09-26",
    title: "My Work tiles, a Roadmap timeline, one card look",
    headline: "My Work becomes five tiles, the Roadmap gets a calendar, search answers from the sidebar as you type, and every screen shares one card style.",
    highlights: [
      "My Work is five tiles: Tickets for you, Needs your review, Your sessions (your recent feed entries and handoffs left for you), Repo (PRs, CI and deploys) and Your library (docs you own, artifacts published this week, queued handoffs).",
      "The Roadmap's Narrative sits in two columns with a side panel, and a new Timeline tab draws every sprint on a calendar from its start to its due date. New sprint is in the header, and reloading keeps the tab you were on.",
      "Sprints have real start dates: the New sprint panel uses date pickers, a start can't be after the due date, and a sprint counts as overdue from the day after it is due, the same on every screen.",
      "Beside the Feed: This week (entries per day, who posted and the top tags, each a click to filter) and Waiting on review.",
      "Search everything from the sidebar: results for tickets, docs, decisions, roadmap, artifacts, prompts, handoffs, people, feed and app screens appear in a compact dropdown after a short pause (⌘K opens a palette when the rail is collapsed).",
      "One look: white cards on a light grey background in the new light theme, Geist type everywhere except the sidebar, search and Filter as one box on Tickets, Artifacts and the Prompt Library, and a tab icon that follows the app's theme. You can also delete a prompt or an artifact you made: a confirmation asks first (Enter confirms), and Undo brings it back. Get Started shows the new screens.",
    ],
    headsUp: [
      "The Roadmap's plan narrative is now limited to 800 characters, so it stays a short Now / Next / Later; the detail lives in each sprint.",
      "The Midnight theme is gone. If you had picked it, Canopy now opens in Dark.",
    ],
    ops: [
      "Apply migration `0035_library_and_sprint_dates` (one file) with `npm run db:migrate:remote` before this deploys.",
    ],
    patches: {
      added: [
        "`web/src/mywork.ts`: the My Work bento — Tickets for you, Needs your review, Your sessions, Repo (PRs / CI / Deploys tabs, PRs by default) and the Your library strip",
        "`web/src/timeline.ts`: Roadmap › Timeline as a Gantt graph — In progress / Upcoming / Done lanes, a today line, an Unscheduled list",
        "`GET /feed/stats?days=&tz=` (`src/tools/feed-stats.ts`, `shared/feed-stats.ts`) behind the Feed's This week box; Waiting on review reads the boot-loaded Review queue",
        "`asideColumns` in `web/src/ui.ts`: the two-column page with a sticky 360px aside, shared by Roadmap › Narrative and the Feed",
        "`.cnpy-surface` + `surface()`: the one card look, with `--surface` and `--shadow` theme tokens",
        "`searchFilterBar` in `web/src/filter-menu.ts`: search and Filter as one control on the ticket queue, the Artifacts library and the Prompt Library",
        "Migration `0035_library_and_sprint_dates`, PART A: `docs.owner`, `artifact_pages.published_at`, `prompts.use_count` / `last_used_at` (each backfilled); `prompts_fts_au` narrowed to the indexed columns",
        "`POST /api/prompts/:slug/used` (the web Copy button) and MCP `get_prompt` bump a prompt's use count; `GET /api/prompts?sort=used`",
        "Migration `0035_library_and_sprint_dates`, PART B: `sprints.start_date` (DTO `start`), backfilled only where `dates` gives an unambiguous start",
        "`sprintDatesProblem` (one sprint-date rule: real `YYYY-MM-DD` days, start ≤ due) and `sprintDueState` (one overdue rule) in `shared/sprints-core.ts`",
        "`web/src/favicon.ts`: the tab icon follows the app's resolved theme; `favicon-32.png` for browsers without SVG favicons",
        "`npm run watch:web`, which `npm run dev` now runs beside `wrangler dev`",
        "`GET /search/quick` (`src/tools/quick-search.ts`, `shared/quick-search.ts`): one D1 batch, FTS prefix matching, live-only visibility, a degraded read answers empty, never a 500",
        "`web/src/quicksearch.ts`: the sidebar search dropdown — debounced prefetch, abort, a 40-entry cache, a 1 s show delay, animated open and height, keyboard navigation",
        "Prompt soft delete: `POST /api/prompts/:slug/delete` and `/restore` (author or admin, session cookie, never MCP); the slug stays reserved; `web/src/confirm.ts` in-app confirm and an Undo toast",
        "Migration `0035_library_and_sprint_dates`, PART C: `prompts.deleted_at` / `deleted_by`; the `prompts_fts` triggers index live prompts only",
        "Artifact soft delete: `POST /api/artifacts/:slug/delete` and `/restore` (author or admin, session cookie, never MCP); a deleted page is the one byte-identical not-found on every surface, versions, links and R2 bytes kept; migration 0035 PART D (`artifact_pages.deleted_at` / `deleted_by`)",
        "`confirmModal` in `web/src/confirm.ts`: one confirmation dialog for destructive actions (Delete focused, Enter confirms once, Esc cancels, a bottom sheet on phones)",
        "Get Started and the landing page describe the new screens; screenshots recaptured in dark and light, plus Timeline, search and What's new figures",
      ],
      changed: [
        "My Work's Repo tile: PRs · CI · Deploys, opening on PRs; the environment-named drift tab is gone — drift stays on the Repo dashboard (#85)",
        "Review: a drafted decision's Proposed record card drops its green left edge (#85)",
        "Sidebar (light): the selected row is a white card, not a darker fill, and hover previews it; Tickets has no sub-page list — Board / Table / Submit a ticket are in its header (#86)",
        "My Work: Needs your review always holds its place and reads clear in it; Your sessions shows 2 sessions and 1 handoff; the Repo tile keeps one height across PRs / CI / Deploys (#86)",
        "Tickets table: 20px sides inside its card, no hairline under every row, category and priority as plain text (#86)",
        "My Work: with nothing to review, the clear Needs your review tile sits beside Repo instead of leading the page (#87)",
        "Tickets: every status moves to any other — Done and Declined are no longer terminal, so a resolved ticket drags (or is set) back to an open status; `tickets` skill, plugin 0.6.7 (#88)",
        "Light theme palette from the Claude Design `Canopy Restyled.dc.html` (cool neutral grey, indigo accent)",
        "`--label` is Geist everywhere except the sidebar, which keeps Archivo Narrow",
        "Roadmap: New sprint in the header; `#roadmap/timeline` in the URL; the rail's Narrative / Timeline sub-pages removed",
        "New sprint panel: native Start / Due date inputs instead of a free-text Dates field; `dates` is now a display label only",
        "`update_plan` refuses a narrative over 800 characters (`PLAN_NARRATIVE_MAX`) before its first write; `update-plan` / `read-plan` / `canopy` skills say so; plugin 0.6.6",
        "My Work's `tickets` lists assigned tickets of both sources (native and mirrored from GitHub), capped at 6, plus an uncapped `ticketsTotal`",
        "Repo DTO: `prs` is `{ rows, openCount }` and `ciFailures.total` counts every failure in the window, so My Work's Repo tile shows real counts",
        "Favicon: the original Canopy mark, with an indigo top bar in light and the green one in dark",
      ],
      fixed: [
        "`npm run dev` served stale or missing assets after a web rebuild; the watch keeps old bundles (`--emptyOutDir false`)",
        "A multi-word FTS query whose last word got stem-shortened alternatives came back empty; the terms are now joined with an explicit AND",
        "My Work › Your library: a narrow cell's header link (Queued handoffs' \"Handoffs →\") ran past the tile's edge and was clipped; the header row now wraps the link under its title (#85)",
        "What's new still tagged this release Unreleased after it deployed; it is v0.15, and the merging PR now cuts the version (#85)",
      ],
      removed: [
        "The Midnight theme and its Get Started screenshots",
      ],
    },
    prs: [84, 85, 86, 87, 88],
  },
  {
    version: "0.14",
    date: "2026-09-26",
    title: "Ticket board, feed briefs, New version for artifacts",
    headline: "Tickets open on a board you can drag to order, feed entries get a short brief for people, and artifacts get a New version button.",
    highlights: [
      "Tickets open on the Board. Drag a card to another column or to a new spot in its column; the order is saved for everyone.",
      "A new, optional Testing status sits between In progress and Done, and an open ticket can move to any other open status, Triage straight to Done included. Done and Declined stay final.",
      "The ticket queue has a search box and a Filter menu: assignee (anyone, me, unassigned or one person), category, priority and sprint.",
      "Feed entries carry a one- or two-sentence brief. The Feed opens For reading (title, brief and links); For agents shows the full record.",
      "Artifacts: New version on the viewer (edit the text or upload a replacement file), a green Org / purple Private switch, and text pages up to 750 KB.",
      "Labels, dates and badges use Archivo Narrow instead of Geist Mono; real code keeps a monospace face.",
    ],
    headsUp: [
      "Feed entries written before this release show only their title in For reading until their briefs are filled in.",
    ],
    ops: [
      "Apply migrations 0033 (rebuilds `tickets` and `ticket_events`) and 0034 (`feed.brief`, the artifact text cap) before the deploy.",
      "Fill older feed briefs with `scripts/backfill-feed-briefs.mjs` (dry run with `--limit 10`, then `--apply`).",
    ],
    prs: [77, 78, 79, 80, 81, 82, 83],
    patches: {
      added: [
        "`testing` ticket status and `tickets.board_rank`; `POST /tickets/:id/move {to, after_id}` (`move_ticket`) sets status and position in one batch (#78)",
        "Migration `0033_ticket_testing_rank`: rebuilds `tickets` and `ticket_events` to admit `testing`, carrying both AUTOINCREMENT counters over (#78)",
        "`boardOrder` / `placeInColumn` in `shared/tickets-core.ts`, one definition for the Worker and the optimistic drop (#78)",
        "`feed.brief` (at most 280 characters) on `append_feed`, `record_session` and `/ingest`; `query` leads a feed hit with `Brief:` (#83)",
        "Migration `0034_feed_brief_artifact_cap`: `feed.brief`, and `artifact_versions` rebuilt with a 768000-byte text CHECK (#83)",
        "`scripts/backfill-feed-briefs.mjs`: one-off Gemini backfill, dry run by default, `--apply` writes only `WHERE brief IS NULL` (#83)",
        "Artifact viewer New version dialog over `POST /api/artifacts/:slug/versions`: edit, restore an older version, or upload a same-type file (#82)",
        "`isBundledExport`: a FLATTEN FIRST warning for bundled Claude Design exports, on the web form and in MCP `warnings` (#81)",
        "`web/src/segmented.ts`: one segmented switch with a sliding indicator, used by all 20 pick-one switches (#83)",
        "`--purple` theme token (#79)",
      ],
      changed: [
        "Ticket queue opens on the Board with All selected; the Table is the other view (#78)",
        "Free moves between open statuses (`OPEN_STATUSES`); `done` / `declined` stay terminal (#78)",
        "Queue search and Filter menu (Assignee incl. one person, Category, Priority, Sprint) replace the two dropdowns (#78)",
        "Board drag is pointer-driven: a full-size copy follows the pointer and the other cards slide around a slot (#78)",
        "`tickets` skill for the new rules, plugin 0.6.3 (#78); `record-session` always writes a brief, body soft target ~2,500 characters, plugin 0.6.5 (#83)",
        "Artifact text cap 500 KB → 750 KB; `artifact_get` and `query` inline text only up to 64 KB (`content_omitted`, `include_content`) (#83)",
        "Feed: author, tag and time in one Filter menu; the For reading / For agents choice is saved per browser (#83)",
        "html card previews in the Artifacts library run with `sandbox=\"allow-scripts\"`, so script-rendered pages show (#83)",
        "`--mono` (Geist Mono) → `--label` (Archivo Narrow); new `--code` system monospace for real code; @handles in Geist (#77)",
        "Artifact visibility switch coloured in both states; making a page private shows a toast instead of a standing banner (#79)",
        "Toasts fade out, stay centred, and a newer toast is no longer cleared by an older one's timer (#79)",
        "Settings: the top tiles keep one height whatever the number of tokens; three-column layout (#77)",
      ],
      fixed: [
        "The Feed's time range now filters; the old range dropdown set state nothing read (#83)",
        "A refetch no longer replays the ticket board's entrance (#78)",
        "The prompt detail box runs to the bottom of the screen; Review's header chip and buttons are one height (#77)",
        "Typing deep in a long textarea no longer jumps it back to the top (#82)",
      ],
      removed: [
        "The Geist Mono webfont (#77)",
        "`blob:` scripts in the raw html CSP — added in #80, reverted (#81)",
        "The artifact PRIVATE banner and its Publish button (#79)",
      ],
    },
  },
  {
    version: "0.13",
    date: "2026-09-25",
    title: "GitHub issues become tickets",
    headline: "Every GitHub issue now shows up as a ticket, and any member can create, complete or delete a sprint.",
    highlights: [
      "Each issue in the Sapling repo appears as a ticket linked to its issue. After import the title, description, priority and assignees are Canopy's to edit; closing or reopening the issue on GitHub closes or reopens the ticket.",
      "The link back to the source issue is locked, so it can't be removed by accident.",
      "Any ticket's title and description can now be edited.",
      "Delete a sprint from its page; its tickets move to the backlog.",
      "Agents can create, complete and delete sprints for every member, as on the web. Only the whole-plan rewrite stays admin-only.",
      "The ticket queue's Assignee and Category filters are themed menus instead of the browser's own dropdowns.",
    ],
    ops: [
      "Apply migration 0032 before the deploy, then run Sync GitHub once to mirror the issues that are already open.",
    ],
    prs: [65, 75, 76],
    patches: {
      added: [
        "Migration `0032_ticket_source`: `tickets.source` / `source_ref` (partial UNIQUE) / `source_author` / `source_updated_at`, `ticket_links.locked`, the reserved `github-webhook` person (#75)",
        "`src/tools/ticket-mirror.ts`: `mirrorIssue` on every verified `issues` delivery and in Sync GitHub (open issues only) (#75)",
        "`edit_ticket`: `POST /tickets/:id/edit` and a lane-scoped MCP tool (#75)",
        "`delete_sprint`: `POST /sprints/:id/delete` and an MCP tool — a hard delete in one batch, tickets to the backlog (#65)",
        "`src/tools/issue-gone.ts`: a `deleted` / `transferred` issue counts as no longer open everywhere (#75)",
      ],
      changed: [
        "Sprint MCP writes (`create_sprint`, `set_sprint_active`, `complete_sprint`, `add_sprint_resource`, `delete_sprint`) registered for every principal; `update_plan` stays admin-only (#65)",
        "ADR-007 amended: a ticket may be sourced from a GitHub issue but is never the issue itself; plugin 0.6.1 (#75)",
        "My Work, the ticket badge, the ticketq digest and the Repo Open tickets tile read `source = 'canopy'`, so a mirrored issue is not counted twice (#75)",
        "Sidebar section labels in Archivo Narrow (#75)",
        "Queue Assignee / Category filters are menus (`role=\"listbox\"`) like the ticket screens' status menu (#76)",
      ],
      fixed: [
        "GitHub sends `SaplingLearn/Sapling`: the mirror's repo check ignores case and always keys on the configured spelling, so the webhook and Sync never create duplicates (#75)",
      ],
      removed: [
        "The two native `<select>` filters on the ticket queue (#76)",
      ],
    },
  },
  {
    version: "0.12",
    date: "2026-09-24",
    title: "Browser sign-in for agents, images in docs",
    headline: "Agents connect to Canopy by signing in through the browser, and docs can carry images.",
    highlights: [
      "Claude Code connects by browser sign-in: run /mcp, choose Authenticate and approve on Canopy's consent page. No token to paste.",
      "Settings › MCP access lists the apps you've connected, and you can revoke any of them.",
      "Docs can contain images an agent uploads; click one to open it full size.",
      "Review's Rendered view shows a proposal's images, outlined green when added and dimmed red when removed.",
    ],
    ops: [
      "Apply migrations 0029 (OAuth) and 0031 (doc images) on production.",
      "MCP `artifact_create` is renamed `upload_asset` with no alias: agents update the plugin with `/plugin marketplace update canopy`.",
    ],
    prs: [74],
    patches: {
      added: [
        "MCP OAuth phase 1: RFC 9728 / 8414 metadata, RFC 7591 client registration, authorization code with S256 PKCE, a consent page on every authorization, rotating refresh tokens (migration `0029_oauth`)",
        "`/mcp` accepts `canopy_oat_` access tokens; its 401 carries `WWW-Authenticate` with `resource_metadata`",
        "Settings › Connected apps: `GET /auth/oauth-grants`, `POST /auth/oauth-grants/:id/revoke`",
        "Sign-in and onboarding resume a pending authorize request; `pruneOAuth` on the repo cron's `:30` tick",
        "Migration `0031_doc_images`: `doc_images` and `doc_image_upload_tokens`; bytes in R2 at `doc-images/<sha256>` (#74)",
        "`GET /img/<sha>`: session cookie, `nosniff`, sandbox CSP, immutable cache (#74)",
      ],
      changed: [
        "MCP `artifact_create` renamed `upload_asset`, with `destination: \"artifact\" | \"doc\"` (#74)",
        "`ingestDocProposal` refuses a body whose `/img/` ref is not uploaded or that uses any other image source (outcome `refused`, not ledgered) (#74)",
        "Plugin 0.5.0 signs in by browser; 0.6.0 for `upload_asset` (#74)",
        "The OAuth pages wear the landing page's sign-in dialog",
      ],
      fixed: [],
      removed: [
        "MCP tool `artifact_create`, with no alias (#74)",
      ],
    },
  },
  {
    version: "0.11",
    date: "2026-09-24",
    title: "Artifacts",
    headline: "Canopy stores, versions and shares the pages agents produce: specs, reports, designs, diagrams, images, PDFs and files.",
    highlights: [
      "Knowledge › Artifacts: browse pages, open one, compare two versions and ratify the one you stand behind.",
      "Agents publish, list, read and download artifacts, and link them to the ticket or sprint they came from.",
      "A ticket's page lists its artifacts, and a page can be kept private to its author.",
      "The ticket page is laid out like the sprint page: the title on the left, the properties rail beside it, the requester and opened date in the rail.",
      "Get Started is an onboarding path with an On this page list; every figure opens in a lightbox.",
    ],
    ops: [
      "Apply migration 0030, and create the R2 bucket `canopy-artifacts` (`wrangler r2 bucket create canopy-artifacts`) before the first deploy with the binding.",
    ],
    prs: [71, 72, 73],
    patches: {
      added: [
        "Migration `0030_artifacts`: `artifact_pages`, `artifact_versions`, `artifact_links`, `artifact_upload_tokens`, `artifacts_fts`; R2 binding `ARTIFACTS_BUCKET` (#72)",
        "`/api/artifacts/*` routes, `/raw/a/:slug[@vN]` with a per-kind CSP, the token upload `PUT`, an SSRF-guarded From-URL fetch (#72)",
        "MCP `artifact_list`, `artifact_get` (a signed 5-minute `download_url` + sha256), `artifact_create`, `artifact_update`; `query` type `artifact`; `artifact_links` on `record_session` and `/ingest` (#72)",
        "`artifacts` skill and plugin 0.4.0; `docs/artifact-contract.md` and `AGENTS.md` (#72)",
        "`web/src/lightbox.ts`; Get Started's On this page rail with scrollspy (#73)",
      ],
      changed: [
        "Ticket detail: status is set only from the rail; REQUESTER and OPENED rows (#71)",
        "Prompt Library shows three cards a row on a wide window (#71)",
        "Landing page: Handoffs and Artifacts tour rows, Prompt Library and Repo cards, the updated tool list (#73)",
      ],
      fixed: [
        "html / svg opened in their own tab ran script on Canopy's origin; the raw CSP adds `sandbox allow-scripts` (#72)",
        "A binary 1 byte over 10 MB returned 400 instead of 413 `too_large` (#72)",
      ],
      removed: [],
    },
  },
  {
    version: "0.10",
    date: "2026-09-23",
    title: "Handoffs and the Prompt Library",
    headline: "A session can hand its work to the next one, the team gets a shared library of prompts, and connecting an agent is one button.",
    highlights: [
      "Handoffs: leave where a task stands for the next session, yours or anyone's. The next session claims it and starts from that context. Unclaimed handoffs expire after 7 days.",
      "Prompt Library: versioned, reusable prompts with {{variables}}. An agent can only stage a prompt; a person publishes it.",
      "Settings › Get connection command mints a token and shows the exact setup for Claude Code, Codex, a .mcp.json file or the bare token.",
      "A link can be removed from a ticket: hover it and choose ⋯ › Remove link.",
      "Docs › New doc lets a person propose a new doc from the web, and Maintenance has tabs: Unplaced, Identity and People.",
      "Get Started now covers tickets, sprints and the Repo dashboard.",
    ],
    ops: [
      "Apply migration 0028 before the deploy.",
    ],
    prs: [66, 67, 68, 69],
    patches: {
      added: [
        "Migration `0028_handoffs_prompts`: `handoffs`, `prompts`, `prompt_versions`, `prompts_fts` (#69)",
        "`/api/handoffs*`, `/api/prompts*` and `POST /api/docs/propose` (session cookie) (#69)",
        "MCP `send_handoff`, `list_handoffs`, `get_handoff`, `claim_handoff`, `expire_handoff`, `search_prompts`, `get_prompt`, `save_prompt` (always staged) (#69)",
        "`handoff` and `prompts` skills; `load-context` lists waiting handoffs at session start (#69)",
        "`expireDueHandoffs` on every repo cron tick (#69)",
        "`remove_ticket_link` and `POST /tickets/:id/links/:linkId/remove` (#67)",
        "The Get connection command modal (`connectModal` / `connectSnippet`) (#66)",
      ],
      changed: [
        "The ticket page is centred in a 1120px shell; the sprint page shows its tickets as cards; Enter or a pasted link adds a link (#66)",
        "Settings: Appearance above Email notifications (#66)",
        "`scripts/capture-guide.mjs` moves to Playwright; 15 surfaces in 3 themes (#68)",
      ],
      fixed: [],
      removed: [
        "Settings' Mint new token button and inline token reveal, replaced by Get connection command (#66)",
      ],
    },
  },
  {
    version: "0.9",
    date: "2026-09-21",
    title: "The Repo dashboard",
    headline: "Monitor › Repo shows what the code, CI, deploys and the running app are doing, and says so when a source isn't connected instead of guessing.",
    highlights: [
      "Five tabs, Overview, Code, CI, Usage and Planning: environments and deploys, branch drift, health checks, PRs and commits, CI failures, coverage, bundle size, traffic, hosting and product metrics.",
      "A section with no data reads \"not connected\" and names what it is waiting for, never a made-up zero. Preview with sample data shows the finished design.",
      "Admins can Poll now to refresh health, usage and GitHub on demand, with one line per source saying what answered.",
      "Agents can read the dashboard too.",
      "A new sidebar: Workspace, Monitor, Knowledge, Triage and Help sections, a search box with ⌘K, sub-pages, and a rail that collapses smoothly.",
      "Tighter corners across the app, and feed entries render as formatted text.",
    ],
    ops: [
      "Apply migration 0027 before the deploy.",
      "Subscribe the target repo's webhook to deployment statuses, check runs, workflow runs, pull request reviews and statuses; set each usage source's secrets (`CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`, `SAPLING_METRICS_TOKEN`).",
      "The cron is now `*/10 * * * *`: run `wrangler triggers deploy` after the merge.",
    ],
    prs: [53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63],
    patches: {
      added: [
        "`GET /repo/dashboard` → `getRepoDashboard`: D1-only, never a 500 (#53)",
        "`web/src/morph.ts` patches the `<aside>` in place; `web/src/sidebar.ts` emits a stable element tree (#53)",
        "Migration `0027_repo_capture`: `repo_events`, `repo_snapshots`, `repo_metrics`; the `ingestRepoEvent` gate (#54)",
        "`reconcileRepo`: service-token backfill and self-heal (#54, #55)",
        "Capture for `deployment_status`, `check_run`, `workflow_run`, `pull_request_review`; `fillFailedJob` (#55)",
        "Drift and branches snapshots, health pings and the `*/10` repo cron (#56)",
        "`canopy/coverage`, `canopy/bundle-kb` and `canopy/todo` commit statuses → `repo_metrics` via `metricsFromStatus` (#57)",
        "Hourly pollers `pollCloudflare`, `pollRailway`, `pollSaplingMetrics` (#58)",
        "`POST /admin/poll-usage` (#59), then `POST /admin/poll` → `runRepoRefresh` behind a `refresh_lock` (#62)",
        "Product metrics (contract v2), `putMetrics`, `productReadings` (#60, #61)",
        "MCP `get_repo_dashboard`; `reconcileRepo` `statuses` and `reviews` arms (#62)",
      ],
      changed: [
        "Usage tab: one Product section with an environment switch, headline tiles, a shape per group (#63)",
        "Every radius renders at `--corner-scale` (0.4), pinned by `test/render.corners.test.ts` (#63)",
        "Feed entry bodies render through the sanitised markdown pipeline; `record-session` defines the feed entry types and limits (#62)",
        "The Search nav row became the sidebar search box (⌘K / Ctrl+K) (#53)",
      ],
      fixed: [
        "The test suite called the live Gemini API through `.dev.vars`; the vitest pool now blanks every network secret (#58)",
        "A token could survive in part when a vendor error was cut before scrubbing; scrub first, then cut (#60)",
        "A manual health ping is stamped to the second, so a real DOWN reading is no longer dropped (#62)",
      ],
      removed: [
        "The half-landed Corners preference (#63)",
      ],
    },
  },
  {
    version: "0.8",
    date: "2026-09-19",
    title: "Landing page and a one-screen Settings",
    headline: "Signed-out visitors see a product page, Settings fits on one screen, and you can see and revoke your MCP tokens.",
    highlights: [
      "A landing page replaces the bare sign-in card; Sign in (GitHub or Google) opens as a dialog.",
      "Settings is a bento: Profile, Account and MCP access tokens on top, email notifications and appearance below.",
      "Your MCP tokens are listed by their first characters with minted and last-used times, and each can be revoked.",
      "The sidebar logo reopens the landing page, and its nav takes you back to where you were.",
      "Canopy is licensed under the AGPL v3.",
    ],
    ops: [
      "Apply migration 0026 before the deploy.",
    ],
    prs: [49, 50],
    patches: {
      added: [
        "`web/src/landing.ts` (from `Canopy Site.dc.html`) and `web/src/landing-motion.ts` scroll reveals (#49)",
        "Migration `0026_token_hint`; `GET /auth/mcp-tokens` and `POST /auth/mcp-tokens/:id/revoke` (#50)",
        "The `#site` route (#50)",
        "The AGPL v3 license",
      ],
      changed: [
        "Sign out lands on `/` instead of leaving `/#settings` as a return-to (#50)",
        "The sign-in dialog says Canopy is for the Sapling team and which provider is for whom (#50)",
        "Settings folds on container queries (#50)",
      ],
      fixed: [],
      removed: [],
    },
  },
  {
    version: "0.7",
    date: "2026-09-18",
    title: "Tickets and sprints",
    headline: "One ticket queue the whole team files into, with sprints as the Roadmap's containers.",
    highlights: [
      "File a ticket, assign people, add sub-tickets, link the work (GitHub, Figma, anything) and discuss it in a thread.",
      "The queue shows as a table or a board, and the sidebar counts tickets nobody has picked up.",
      "Milestones became sprints. Each sprint has a page with its tickets, resources and progress, and a person confirms it done.",
      "My Work lists the tickets assigned to you, and there is a Ticket queue email digest.",
      "Agents can file tickets and work the ones assigned to their person: status, comments, links, sprint and parent.",
      "New members land on Get Started and get a welcome email.",
    ],
    ops: [
      "Apply migrations 0024 and 0025 before the deploy; 0025 renames `milestones` to `sprints`, so old and new code each break on the other's schema.",
    ],
    prs: [44, 47, 48],
    patches: {
      added: [
        "Migrations `0024_tickets` (tickets, assignees, links, comments, events, `tickets_fts`) and `0025_sprints` (#44)",
        "Ten `/tickets` and six `/sprints` session-cookie routes; tickets in `/search` (#44)",
        "MCP reads `list_tickets`, `get_ticket`, `list_sprints`, `get_sprint` (#44)",
        "The `ticketq` digest kind (#44)",
        "`src/tools/tickets-agent.ts` (the lane rule) and MCP `create_ticket`, `transition_ticket`, `add_ticket_comment`, `add_ticket_link`, `set_ticket_sprint`, `set_ticket_parent`; admin sprint tools; the `tickets` skill (#48)",
        "Welcome email, `src/notifications/welcome.ts` (#47)",
      ],
      changed: [
        "`milestones` renamed `sprints` in place; `milestone_progress` → `sprint_progress` (#44)",
        "`submitted` displays as Triage; status is set from a status menu; `in_progress → declined` is allowed (#47)",
        "Ticket screens take the full width (`WORK_SHELL`) (#47)",
        "Finishing onboarding lands on `#guide` (#47)",
      ],
      fixed: [
        "A long sprint name pushed the new-ticket form's sprint chip past the card; the form uses the rail's sprint menu (#47)",
      ],
      removed: [
        "`milestone_proposals` and the agent-proposed roadmap surface (#44)",
      ],
    },
  },
  {
    version: "0.6",
    date: "2026-09-16",
    title: "Google sign-in and people",
    headline: "Teammates without GitHub can sign in with Google, and an account is now a person rather than a GitHub login.",
    highlights: [
      "Continue with Google, for teammates an admin has invited by email.",
      "Choose your handle and colour when you first sign in, and rename your handle later in Settings.",
      "Link GitHub and Google to one account from Settings.",
      "Names show in each person's colour across the app.",
      "Every email opens with the same Canopy band, and the invite explains what Canopy is.",
    ],
    headsUp: [
      "Your GitHub login became your handle. You can pick a different one in Settings › Profile.",
    ],
    ops: [
      "Migration 0023 replaces `users` and `people` with `persons` — a one-way cutover: migrate, then deploy.",
    ],
    prs: [41, 42, 43],
    patches: {
      added: [
        "Migration `0023_persons`: `persons`, `identities`, `invites`; `sessions` / `mcp_tokens` repointed to `persons.handle` (#41, #42)",
        "`src/auth/google.ts` (PKCE, JWKS-verified ID token) and `src/auth/onboard.ts` (`completeSignIn`); the `#onboard` screen (#41)",
        "Admin invite routes and the invite email (#41)",
        "`POST /auth/me/handle`, rewriting every `HANDLE_COLUMNS` column in one batch (#41)",
        "Settings › Profile and Maintenance › People (#41)",
      ],
      changed: [
        "`Principal` is `{ handle }`; event subjects resolve to a person through the github identity (#41)",
        "One shared `emailBanner`; emails 680px wide (#43)",
        "The invite link opens Canopy's sign-in screen instead of Google's account chooser (#43)",
      ],
      fixed: [
        "Three notification retry tests failed once their fixed date aged out; the fixture is stamped relative to now (#42)",
      ],
      removed: [
        "The `users` and `people` tables (#41)",
      ],
    },
  },
  {
    version: "0.5",
    date: "2026-09-13",
    title: "Email digests",
    headline: "Canopy emails a daily or weekly digest of your work, the review queue and roadmap changes.",
    highlights: [
      "Digests for My Work, the Review queue and Roadmap plan changes, each daily, weekly or off in Settings › Email notifications.",
      "One-click unsubscribe in every email.",
      "Admins set the defaults and the send hour under Maintenance › Notifications, preview a digest and send a test to themselves.",
      "Emails use Canopy's own look, with a dark version where the mail client supports one.",
      "Clicking a button low on a long screen no longer jumps the page back to the top.",
    ],
    headsUp: [
      "The next time you sign in with GitHub, you'll be asked to let Canopy see your email address, so digests can reach you.",
    ],
    ops: [
      "Apply migrations 0021 and 0022; the OAuth scope adds `user:email`, so existing sessions re-consent on their next sign-in.",
    ],
    prs: [34, 35, 36, 37, 38, 39],
    patches: {
      added: [
        "`src/notifications/`: registry, renderers (`my_work`, `review_queue`, `roadmap_plan`), resolver, run assembler, retry, Resend delivery (#34)",
        "Migrations `0021_notifications` and `0022_notification_bodies` (#34)",
        "Two hourly digest triggers, gated in code on `send_hour` and the org timezone (#34)",
        "`/u/<login.sig>` one-click unsubscribe (#34)",
        "`GET /api/notifications/preview` and `POST /api/notifications/test-send` (#37)",
        "`web/src/scroll.ts` keeps the main pane's scroll across rerenders (#38)",
      ],
      changed: [
        "`NOTIFICATIONS_MODE = \"resend\"` in production (#36)",
        "The digest is styled on the site's theme tokens, with a `prefers-color-scheme: dark` block (#39)",
      ],
      fixed: [
        "The weekly trigger is `0 * * * SUN,MON`; Cloudflare's weekdays are 1–7, never 0 (#35)",
      ],
      removed: [],
    },
  },
  {
    version: "0.4",
    date: "2026-07-10",
    title: "Structured summaries and a new Docs reader",
    headline: "My Work cards get structured summaries, Docs is rebuilt around Technical and Product, and a reload keeps you on the same page.",
    highlights: [
      "Cards on My Work read as labelled rows: what changed, why and the impact for a PR; a summary and the next step for an issue.",
      "Summaries now come from Google Gemini.",
      "Docs has Technical and Product spaces; each page expands to its own headings, and the outline follows your scroll.",
      "The screen you're on is in the URL, so a reload stays there.",
      "Get Started is a tour of every screen with fresh screenshots.",
    ],
    ops: [
      "Apply migrations 0018, 0019 and 0020.",
    ],
    prs: [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33],
    patches: {
      added: [
        "Migrations `0018_structured_summaries`, `0019_drop_pr_summary`, `0020_docs_space_vocab` (#22, #27, #33)",
        "Local dev seed: `npm run seed`, `fixtures/dev/*.json`, `scripts/seed/` (#21)",
        "`web/src/outline.ts` and the Docs reader's heading scrollspy (#25, #29)",
        "`scripts/capture-guide.mjs` (#32)",
      ],
      changed: [
        "Summarizer: Workers AI → Gemini `gemini-2.5-flash-lite` over REST (`GEMINI_API_KEY`), with a timeout (#28)",
        "PR cards are structured-only (What changed / Why / Impact), else \"No summary recorded\" (#27)",
        "Sync GitHub summarizes issues before PRs (#23)",
        "My Work cards in an even 2×3 grid (#24)",
        "Doc `space` is a fixed `{technical, product}` vocabulary; an off-vocab value is rejected at the tool boundary (#33)",
        "The screen is in the URL hash and restored on boot (#29)",
      ],
      fixed: [
        "Sync GitHub reported 0 of 0 on a bad GitHub token; it now fails with the status (#19)",
        "Issue summaries reached the client but never showed on To-do cards (#20)",
        "A hung Workers AI call could wedge Sync GitHub; calls now time out (#26)",
        "Feed chips showed a full PR URL or a 40-character SHA; they show `#321` and 7 characters (#31)",
      ],
      removed: [
        "The prose `pr_summaries.summary` column (#27)",
        "The Workers AI `[ai]` binding (#28)",
      ],
    },
  },
  {
    version: "0.3",
    date: "2026-07-04",
    title: "My Work, Roadmap and Triage rebuilt",
    headline: "My Work and the Roadmap read captured GitHub activity instead of calling GitHub live, and Triage becomes Review and Maintenance.",
    highlights: [
      "My Work shows your open assigned issues and your recently merged PRs, each summarized once when it is captured.",
      "The Roadmap is an admin-written plan: a narrative plus milestones with progress.",
      "Admins get Sync GitHub to backfill PRs and issues, with a progress bar.",
      "Review is one queue for agent proposals and draft decisions, with unified, side-by-side and rendered diffs. Maintenance holds unplaced items and unknown GitHub logins.",
      "Triage items show when they were staged.",
    ],
    ops: [
      "Apply migrations 0012–0017, set the `GITHUB_WEBHOOK_SECRET` and `GITHUB_SERVICE_TOKEN` secrets, and add the GitHub webhook on the Sapling repo (pull requests + issues).",
    ],
    prs: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
    patches: {
      added: [
        "`/webhook/github` (HMAC `X-Hub-Signature-256`) → `ingestEvent` into `events`; capture-time PR summaries; the progress cache and its cron backstop (#8)",
        "Migrations `0012_events_plan`, `0013_roadmap_fts`, `0014_drop_focus`, `0015_drop_user_token` (#8), `0016_identity_tasks` (#14, #16), `0017_issue_summaries` (#18)",
        "MCP `update_plan`, `get_my_work`, `get_events`; the `read-plan`, `update-plan` and `my-work` skills (#8)",
        "`POST /admin/backfill` and `ADMIN_LOGINS`; `update_plan` admin-only (#9)",
        "The issue summarizer (#18)",
        "`GET /identity-tasks` and `POST /identity-tasks/:login/map` (#16)",
        "`web/src/review.ts`, `web/src/maintenance.ts`, `web/src/triage-map.ts` (#15, #17)",
      ],
      changed: [
        "My Work: To-do first, previous activity capped at the 5 latest PRs (#10, #11)",
        "Sync GitHub caps AI summaries per batch and chains batches behind a progress modal (#14)",
      ],
      fixed: [
        "The Workers AI summarizer model had been retired; switched model and response shape (#12)",
      ],
      removed: [
        "`focus`, `set_focus` and `propose_milestone`; the per-user `users.github_token` (#8)",
        "The four-tab Triage screen (#15)",
      ],
    },
  },
  {
    version: "0.2",
    date: "2026-07-01",
    title: "The Canopy plugin",
    headline: "Canopy's skills and MCP connection install together as one Claude Code plugin.",
    highlights: [
      "Install Canopy into Claude Code as one plugin from the SaplingLearn/canopy marketplace: the skills arrive and the connection to Canopy is set up for you.",
      "Milestone proposals get their own Triage queue with Promote and Reject.",
      "Searching from an agent works again.",
    ],
    ops: [
      "Apply migration 0011.",
    ],
    prs: [5, 6, 7],
    patches: {
      added: [
        "`plugins/canopy/` and `.claude-plugin/marketplace.json` — `/plugin marketplace add SaplingLearn/canopy`, `/plugin install canopy@canopy`; `.claude/skills/*` symlink into the plugin (#5)",
        "`POST /milestone-proposals/:id/reject` and a Milestones Triage queue (#6)",
        "Migration `0011_fts_recreate` (#7)",
      ],
      changed: [],
      fixed: [
        "`query` failed in production with `no such table: docs_fts` (#7)",
      ],
      removed: [],
    },
  },
  {
    version: "0.1",
    date: "2026-06-29",
    title: "The shared context store",
    headline: "The first Canopy: agents propose context through a gate, people confirm it, and all of it is searchable.",
    highlights: [
      "Sign in with GitHub, for members of the Sapling org.",
      "Feed, Docs, Roadmap, Search, Triage and a first My Work screen.",
      "Agents connect over MCP with a personal token: they search, propose doc changes, add to the feed, and record a whole session in one call.",
      "An agent's proposal waits in Triage until a person promotes, ratifies or rejects it.",
      "Light and dark themes, a Midnight theme, and a Get Started page.",
    ],
    prs: [1, 2, 3, 4],
    patches: {
      added: [
        "The Worker: Hono routes, the `/ingest` gate (`consume()`), a stateless MCP server at `/mcp` (bearer only)",
        "GitHub OAuth with PKCE, D1 sessions, hashed MCP tokens",
        "The web SPA wired to the real routes (#1)",
        "FTS5 `query` engine with authority flags (`0008_fts`); the `load-context` skill (#2)",
        "Replay ledger, content-hash dedupe, `change_kind` / `base_version` (`0009_reconcile`) (#2)",
        "Triage write-back — reject, discard, assign — and `GET /proposals` (`0010_triage_resolve`) (#2)",
        "MCP `record_session` over the same gate as `/ingest` (#3)",
      ],
      changed: [
        "The `record-session` skill calls the `record_session` tool instead of `POST /ingest` (#3, #4)",
      ],
      fixed: [
        "Stored XSS through an agent-controlled doc slug in Triage (#2)",
      ],
      removed: [],
    },
  },
];

// ── rendering ────────────────────────────────────────────────────────────────
// Three pages, all the `releases` screen:
//   #releases                  → the index: a grid of release cards, newest first
//   #releases/<v>              → one release's notes (highlights, Heads-up)
//   #releases/<v>/patches      → the same release's patch notes (Added / Changed / …)
// `<v>` is `releaseSlug`: the version ("0.14"), or "unreleased". Cards, the back link
// and the newer/older links are real `<a href="#…">` (the hash is the route, so Back
// works); the page's Release notes / Patch notes switch is a `segmented()`.

export type ReleasePage = "notes" | "patches";

/** A release's URL segment: its version, or "unreleased". */
export const releaseSlug = (r: Pick<Release, "version" | "unreleased">): string =>
  r.unreleased ? "unreleased" : r.version.toLowerCase();

/** The release a URL segment names, or null. */
export function findRelease(slug: string, releases: readonly Release[] = RELEASES): Release | null {
  const s = slug.toLowerCase();
  return releases.find((r) => releaseSlug(r) === s) ?? null;
}

/** The hash of a releases page (the index when `slug` is null). */
export function releaseHash(slug: string | null, page: ReleasePage = "notes"): string {
  if (!slug) return "#releases";
  return `#releases/${encodeURIComponent(slug)}${page === "patches" ? "/patches" : ""}`;
}

/** The anchor id of a release (kept for links into a card). */
export const releaseAnchor = (r: Pick<Release, "version">): string =>
  `rel-${r.version.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-09-26" → "Sep 26, 2026" (no Date parsing, so no timezone drift). */
export function releaseDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const mo = MONTHS[Number(m[2]) - 1];
  return mo ? `${mo} ${Number(m[3])}, ${m[1]}` : iso;
}

const prLink = (n: number): string =>
  `<a href="${attr(prUrl(n))}" target="_blank" rel="noopener noreferrer" class="cnpy-rel-pr">#${n}</a>`;

/** One line of text: escaped, `code` in backticks as <code>, and a `(#123)` /
 *  `(#1, #2)` group as links to those pull requests (a bare `#12` stays text). */
export function releaseLine(text: string): string {
  return esc(text)
    // A short token (a name, a flag) never breaks mid-way; a long path may wrap.
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code${c.length <= 28 ? ' class="is-short"' : ""}>${c}</code>`)
    .replace(/\((#\d+(?:, #\d+)*)\)/g, (_m, refs: string) =>
      `(${refs.split(", ").map((r) => prLink(Number(r.slice(1)))).join(", ")})`);
}

const GROUPS: { key: keyof ReleasePatches; label: string; tone: string }[] = [
  { key: "added", label: "Added", tone: "var(--green)" },
  { key: "changed", label: "Changed", tone: "var(--blue)" },
  { key: "fixed", label: "Fixed", tone: "var(--amber)" },
  { key: "removed", label: "Removed", tone: "var(--red)" },
];

const patchCount = (r: Release): number =>
  r.patches.added.length + r.patches.changed.length + r.patches.fixed.length + r.patches.removed.length;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "v0.14 · Sep 26, 2026", or the Unreleased tag. */
function metaRow(r: Release): string {
  const inner = r.unreleased
    ? `<span class="cnpy-rel-tag">Unreleased</span><span>Not deployed yet</span>`
    : `<span class="cnpy-rel-ver">v${esc(r.version)}</span><span aria-hidden="true">·</span><time datetime="${attr(r.date)}">${esc(releaseDate(r.date))}</time>`;
  return `<div class="cnpy-rel-meta">${inner}</div>`;
}

const ARROW_L = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>`;
const ARROW_R = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"></path></svg>`;

// ── the index ────────────────────────────────────────────────────────────────

function indexCard(r: Release, i: number): string {
  // Release notes are for users: no PR count here (the patch notes carry the PRs).
  const counts = `${plural(r.highlights.length, "highlight")} · ${plural(patchCount(r), "patch line")}`;
  return `<a href="${attr(releaseHash(releaseSlug(r)))}" aria-label="${attr(`${r.unreleased ? "Unreleased" : `v${r.version}`}: ${r.title}`)}"${surface(`--i:${Math.min(i, 8)}`, { hover: true, cls: `cnpy-relcard cnpy-rise${r.unreleased ? " is-next" : ""}` })}>
    ${metaRow(r)}
    <h2 class="cnpy-relcard-title">${esc(r.title)}</h2>
    <p class="cnpy-relcard-headline">${esc(r.headline)}</p>
    <div class="cnpy-relcard-foot"><span>${counts}</span><span class="cnpy-relcard-go" aria-hidden="true">${ARROW_R}</span></div>
  </a>`;
}

/** `#releases`: every release as a card, newest first. */
export function releasesIndex(releases: readonly Release[] = RELEASES): string {
  return `<div class="cnpy-relidx">
    <div class="cnpy-relidx-head">
      <h1 class="cnpy-relidx-title">What's new in Trov</h1>
      <p class="cnpy-relidx-intro">Every release, newest first. Open one for its notes, and switch to Patch notes for the full list of changes with links to the pull requests on <a href="${attr(TROV_REPO_URL)}" target="_blank" rel="noopener noreferrer" class="cnpy-rel-pr">GitHub</a>.</p>
    </div>
    <div class="cnpy-relgrid">${releases.map(indexCard).join("")}</div>
  </div>`;
}

// ── one release ──────────────────────────────────────────────────────────────
// A release's two pages are ONE wide document: the header (back link, version /
// date / tag, title, lede, the Release notes / Patch notes switch) on the page
// background, then the whole body in a SINGLE full-width surface card — two columns
// for the notes (highlights | Heads-up + at a glance), the four patch groups side by
// side — with hairlines between sections and no box inside it. Newer / older links
// sit under the card. Everything stacks to one column on a narrow page.

/** A release page's Release notes / Patch notes switch — on the page header's back-link row. */
export function releasePageSwitch(page: ReleasePage): string {
  return segmented({
    id: "release-page", ariaLabel: "Release page", act: "releasePage", value: page, inertOn: true,
    options: [{ value: "notes", label: "Release notes" }, { value: "patches", label: "Patch notes" }],
  });
}

const dot = (tone: string): string =>
  `<span style="width:7px;height:7px;border-radius:50%;background:${tone};flex:none"></span>`;

function docHead(r: Release, page: ReleasePage): string {
  // The PR count shows on the patch notes only (release notes are for users).
  const facts = `${plural(r.highlights.length, "highlight")} · ${plural(patchCount(r), "patch line")}${page === "patches" && r.prs?.length ? ` · ${plural(r.prs.length, "pull request")}` : ""}`;
  // The page's note sits in the header, to the right of the title block: the Heads-up on the
  // release notes, the Upgrade notes on the patch notes. Below ~900px of page it drops under
  // the lede (trov.css, a container query). The Release notes / Patch notes switch sits on
  // the back link's row, right-aligned — its right edge on the note's.
  const note = page === "notes" ? headsUp(r) : upgradeNotes(r);
  return `<header class="cnpy-reldoc-head cnpy-rise${note ? " has-heads" : ""}">
    <div class="cnpy-reldoc-toprow">
      <a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a>
      ${releasePageSwitch(page)}
    </div>
    <div class="cnpy-reldoc-head-main">
      ${metaRow(r)}
      <h1 class="cnpy-reldoc-title">${esc(r.title)}</h1>
      <p class="cnpy-reldoc-lede">${releaseLine(r.headline)}</p>
      <span class="cnpy-reldoc-facts">${facts}</span>
    </div>
    ${note}
  </header>`;
}

const INFO = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 7.5v.5"></path></svg>`;
const WRENCH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;

/** A note in the page header, right of the title block: a small icon + label over a short list
 *  (one item is one paragraph) — compact and calm. Omitted when there are no lines. */
function headerNote(label: string, icon: string, lines: readonly string[]): string {
  if (!lines.length) return "";
  const body = lines.length === 1
    ? `<p class="cnpy-relheads-one">${releaseLine(lines[0])}</p>`
    : `<ul class="cnpy-relheads-list">${lines.map((h) => `<li>${releaseLine(h)}</li>`).join("")}</ul>`;
  return `<aside class="cnpy-relheads" aria-label="${attr(label)}" style="border-radius:6px"><span class="cnpy-relheads-l">${icon}${esc(label)}</span>${body}</aside>`;
}

/** The release notes' Heads-up (user-facing changes). */
const headsUp = (r: Release): string => headerNote("Heads-up", INFO, r.headsUp ?? []);

/** The patch notes' Upgrade notes (`ops`): what whoever deploys must do. */
const upgradeNotes = (r: Release): string => headerNote("Upgrade notes", WRENCH, r.ops ?? []);

/** The patch notes' PR line: one quiet chip per pull request. */
function prChips(r: Release): string {
  return r.prs?.length
    ? r.prs.map((n) => `<a href="${attr(prUrl(n))}" target="_blank" rel="noopener noreferrer" class="cnpy-relpr-chip" style="border-radius:5px">#${n}</a>`).join("")
    : `<span style="color:var(--fg-40)">None recorded</span>`;
}

/** Release notes, one column in one card: the "At a glance" strip (version, date, and the
 *  change counts as large figures — each opens that group on the patch notes), then the
 *  highlights (the Heads-up lives in the page header, `docHead`) —
 *  in two balanced columns when there are LONG_HIGHLIGHTS or more and the card is very
 *  wide (trov.css, a container query). */
const LONG_HIGHLIGHTS = 5;
function notesDoc(r: Release): string {
  const slug = releaseSlug(r);
  const fact = (label: string, value: string) =>
    `<div class="cnpy-relglance-fact"><span class="cnpy-relglance-lab">${label}</span><span class="cnpy-relglance-val">${value}</span></div>`;
  const stats = GROUPS.filter((g) => r.patches[g.key].length).map((g) =>
    `<button type="button" data-act="releaseGroup" data-arg="${g.key}" class="cnpy-relstat" style="border-radius:6px" title="${attr(`${g.label} — open on the patch notes`)}">
      <span class="cnpy-relstat-n">${r.patches[g.key].length}</span>
      <span class="cnpy-relstat-l">${dot(g.tone)}${g.label}</span>
    </button>`).join("");
  const glance = `<section class="cnpy-relglance" aria-label="At a glance">
      ${fact("Version", r.unreleased ? "Unreleased" : `v${esc(r.version)}`)}
      ${fact(r.unreleased ? "Last updated" : "Released", esc(releaseDate(r.date)))}
      <div class="cnpy-relglance-stats">${stats}</div>
      <a href="${attr(releaseHash(slug, "patches"))}" class="cnpy-rel-pr cnpy-relglance-all">All ${plural(patchCount(r), "patch line")}${ARROW_R}</a>
    </section>`;
  return `${glance}
    <section class="cnpy-reldoc-main">
      <h2 class="cnpy-rel-h3">Highlights</h2>
      <ul class="cnpy-rel-list cnpy-reldoc-hl${r.highlights.length >= LONG_HIGHLIGHTS ? " is-long" : ""}">${r.highlights.map((h) => `<li>${releaseLine(h)}</li>`).join("")}</ul>
    </section>`;
}

/** Patch notes (the Upgrade notes live in the page header, `docHead`): each non-empty group as a STACKED
 *  full-width section (Added, Changed, Fixed, Removed) — one row per line, a quiet heading
 *  (dot, label, count), hairlines only between groups — then the PRs as one line of chips.
 *  A long group (LONG_GROUP lines or more) may flow into two balanced columns on a very
 *  wide card (trov.css, a container query); never more. */
const LONG_GROUP = 8;
function patchesDoc(r: Release): string {
  const present = GROUPS.filter((g) => r.patches[g.key].length);
  const groups = present.map((g) => {
    const lines = r.patches[g.key];
    return `<section class="cnpy-relpatch-group" id="relgroup-${g.key}">
      <h2 class="cnpy-relpatch-h">${dot(g.tone)}<span>${g.label}</span><span class="cnpy-relpatch-n">${lines.length}</span></h2>
      <ul class="cnpy-relpatch-list${lines.length >= LONG_GROUP ? " is-long" : ""}">${lines.map((l) => `<li>${releaseLine(l)}</li>`).join("")}</ul>
    </section>`;
  }).join("");
  return `${present.length
      ? `<div class="cnpy-relpatch">${groups}</div>`
      : `<p class="cnpy-rel-empty cnpy-reldoc-pad">No patch notes recorded for this release.</p>`}
    <footer class="cnpy-relpatch-prs"><span class="cnpy-relpatch-prs-l">Pull requests</span><span class="cnpy-relpatch-chips">${prChips(r)}</span></footer>`;
}

/** Newer / older links under the card (plain links on the page, no boxes). */
function pager(r: Release, page: ReleasePage, releases: readonly Release[]): string {
  const i = releases.indexOf(r);
  const newer = i > 0 ? releases[i - 1] : null;
  const older = i >= 0 && i < releases.length - 1 ? releases[i + 1] : null;
  const name = (x: Release) => `${x.unreleased ? "Unreleased" : `v${esc(x.version)}`} · ${esc(x.title)}`;
  const link = (x: Release | null, dir: "newer" | "older") => x
    ? `<a href="${attr(releaseHash(releaseSlug(x), page))}" class="cnpy-relpager-i is-${dir}">
        <span class="cnpy-relpager-dir">${dir === "newer" ? `${ARROW_L}Newer` : `Older${ARROW_R}`}</span>
        <span class="cnpy-relpager-name">${name(x)}</span>
      </a>`
    : `<span class="cnpy-relpager-i is-${dir} is-none" aria-hidden="true"></span>`;
  return `<nav class="cnpy-relpager" aria-label="Other releases">${link(newer, "newer")}${link(older, "older")}</nav>`;
}

/** `#releases/<v>` and `#releases/<v>/patches`. */
export function releasePageView(slug: string, page: ReleasePage, releases: readonly Release[] = RELEASES): string {
  const r = findRelease(slug, releases);
  if (!r) {
    return `<div class="cnpy-reldoc">
      <header class="cnpy-reldoc-head">
        <a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a>
        <h1 class="cnpy-reldoc-title">No release called “${esc(slug)}”</h1>
        <p class="cnpy-reldoc-lede">It may have been renamed when it shipped. Every release is listed on the <a href="#releases" class="cnpy-rel-pr">All releases</a> page.</p>
      </header>
    </div>`;
  }
  return `<div class="cnpy-reldoc">
    ${docHead(r, page)}
    <article${surface("--i:1", { cls: "cnpy-reldoc-card cnpy-rise" })} aria-label="${attr(page === "patches" ? "Patch notes" : "Release notes")}">
      ${page === "patches" ? patchesDoc(r) : notesDoc(r)}
    </article>
    ${pager(r, page, releases)}
  </div>`;
}

/** The whole `releases` screen: the index, or one release's page. */
export function releasesScreen(slug: string | null, page: ReleasePage, releases: readonly Release[] = RELEASES): string {
  return slug ? releasePageView(slug, page, releases) : releasesIndex(releases);
}
