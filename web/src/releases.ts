// What's new (Help › What's new): `#releases` is a grid of every release; each release
// has two pages, `#releases/<v>` (its release notes) and `#releases/<v>/patches` (its
// patch notes), where `<v>` is the version ("0.7") or "unreleased".
//
// Pure data + a pure renderer, no backend: RELEASES below is the whole record, and
// `releasesScreen` turns it into the screen's markup. Every string goes through `esc`.
// The app loads this file as its own chunk when the screen opens (releases-lazy.ts) — never
// import it as a value from an app module; the newest version is release-latest.ts.
//
// ── How to add the next release ──────────────────────────────────────────────
// Every PR that ships something adds ONE patch line to the FIRST entry, "Unreleased" — a
// sentence in product words ending `(#N)` — and its number to `prs`. That is all most PRs
// do. The RELEASE NOTES (the index cards, `#releases/<v>`) are for Trov's USERS; the PATCH
// NOTES (`#releases/<v>/patches`) are a short list of what changed, with links to the PRs.
//   • `highlights` — for users: what you can now do, in product words (no files, routes,
//     tables, migrations or PR numbers). At most 4, one sentence each. A PR big enough to
//     be one of the batch's headlines edits this list; most don't touch it.
//   • `headsUp`    — for users: a change they will NOTICE (a limit, a removed option), in
//     plain words. Omit it when there is none.
//   • `ops`        — for whoever deploys, and only what they must DO: migrations to apply,
//     secrets / vars, `wrangler triggers deploy`, plugin versions. Shown as "Upgrade notes"
//     at the top of the patch notes only. No schema tours or measurements.
//   • `patches`    — grouped added / changed / fixed / removed: one line per user-visible
//     change or fix, ending `(#123)` (links that PR on github.com/AndresL230/trov — the repo
//     moved from SaplingLearn/canopy; GitHub redirects old PR links). Not an engineering
//     log: no file paths, function names, tables, tests or numbers from a profiler; a purely
//     internal PR adds no line, only its number to `prs`. `code` in backticks is rare.
//   • `prs`        — every pull request the release carries (chips on the patch notes).
//   • `formerly`   — every number the entry answered to before the October 2026 renumbering
//     (its own old version first, then the ones folded into it, newest first). Old links
//     resolve through it (`findRelease`); a new release never sets it.
// RELEASE_CAPS below holds the limits and test/releases.test.ts enforces them (per line
// and per release). A merge to `main` IS a production deploy, so the PR that merges a batch
// also cuts it: set `version` to the next `0.N`, `date` to the merge day (YYYY-MM-DD) and
// drop `unreleased` — main never carries an "Unreleased" entry. Keep `LATEST_VERSION` in
// release-latest.ts equal to the first entry's version ("Unreleased" while there is one,
// then the `0.N` it is cut into); test/releases.test.ts fails until it is. A small follow-up
// adds its one line (and PR) to the newest version instead of a version of its own.
// Newest first; dates never increase down the list.
//
// Versioning: one `0.N` per milestone (the merges that shipped together), numbered in order
// from the first deploy (0.1, June 2026) — no gaps, newest first. In October 2026 (#190) the
// 35 releases up to 0.34 were folded into fewer entries — by milestone, same-day versions
// together — and cut to what people read (the full old log is in git history); then the
// entries were renumbered 0.1 … 0.11. The old numbers (which ran to 0.34) live in each
// entry's `formerly`, so an old link still lands: `findRelease` matches the CURRENT versions
// first, then `formerly` — `#releases/0.25` opens 0.7, `#releases/0.34/patches` opens 0.11's
// patch notes, while an old number that is now a current one (0.1–0.11) opens the release
// that has that number today (current numbers win). The next batch is 0.12. Every line below
// is traceable to a merged pull request, or — for Unreleased — the working tree it describes.

import { esc, attr, surface } from "./ui";
import { segmented } from "./segmented";
import { stateMark } from "./marks";
import { SOURCE_PATH, TROV_SOURCE_REPO } from "@shared/legal-core";

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
  /** The numbers this entry answered to before the October 2026 renumbering: its own old
   *  version first, then the older ones folded into it, newest first (["0.29", "0.28", …]).
   *  Old links resolve here unless the number is a current version (`findRelease`). Only the
   *  renumbered entries have it; a new release never does. */
  formerly?: string[];
  /** Not deployed yet: rendered with an "Unreleased" tag instead of a ship date. */
  unreleased?: boolean;
  title: string;
  /** One line under the title. */
  headline: string;
  /** 3–4 sentences for people, in product words (RELEASE_CAPS). */
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

/** The limits test/releases.test.ts holds every release to: lines per release, characters per line. */
export const RELEASE_CAPS = {
  titleChars: 60,
  headlineChars: 160,
  highlights: { min: 3, max: 4, chars: 220 },
  headsUp: { max: 3, chars: 240 },
  ops: { max: 8, chars: 300 },
  patches: { max: 20, chars: 160 },
} as const;

export const TROV_REPO_URL = TROV_SOURCE_REPO;
export const prUrl = (n: number): string => `${TROV_REPO_URL}/pull/${n}`;

export const RELEASES: Release[] = [
  // Ask sharing (#193) and handoff prompts by upload (#194), merged together through epic/10-17-staging (#195) with
  // Ask's GitHub lookups, the Prompt Library's copy-slug button, the narrower artifact panel in Ask, the purple dark
  // accent and the big-monitor layout: one deploy, one version.
  {
    version: "0.12",
    date: "2026-10-17",
    title: "Share an Ask conversation",
    headline: "Share an Ask conversation with your organization or with chosen people, and an agent sends a long handoff as a file in seconds.",
    highlights: [
      "Share an Ask conversation with your whole organization to read, or with chosen people: for each, pick Can read or Can continue.",
      "Conversations shared with you by name are under Shared with you; the ones shared with everyone are under Organization.",
      "Someone who can continue asks follow-ups as themselves. Each question stays its asker's: only they can edit it, regenerate it or confirm its changes.",
      "An agent working in a terminal sends a long handoff prompt as a file instead of typing it out; the handoff appears only once the whole prompt has arrived.",
    ],
    headsUp: [
      "Files attached to a shared Ask conversation stay private to whoever attached them: others see each file's name and size, and what Trov quoted from it, never the file.",
      "Deleting a shared conversation deletes it for everyone it is shared with, and the confirmation says so.",
      "Ask Trov and agents in a chat on the web send handoffs as before, with the prompt written in.",
    ],
    ops: [
      "Apply migration `0076_10_17_staging` (one file for Ask sharing, handoff uploads and the switch for Ask's GitHub lookups, off for every organization; merging to main applies it; `0077`–`0079` are left to the PRs in flight beside it). All additive; each part's header has its rollback.",
      "No new secret, var or GitHub App permission: Ask's GitHub lookups read through the org's existing GitHub connection.",
      "Publish the Trov plugin 0.10.0 (the handoff skill uploads long prompts): `claude plugin marketplace update trov`, then `claude plugin update trov@trov`. An older plugin keeps working.",
    ],
    patches: {
      added: [
        "Ask: share a conversation with your organization or with chosen people, each able to read or continue it (#193)",
        "Handoffs: an agent with a shell uploads a long prompt as a file instead of typing it; the handoff is created when the file lands (#194)",
        "Ask Trov reads your connected repositories on GitHub when a question needs it, as far as your own GitHub access goes; an admin turns it on (#195)",
        "Prompt Library: a copy button on each card copies its slug for an agent; cards that open something show the pointer on hover (#195)",
      ],
      changed: [
        "Ask Trov: an artifact opens in a narrower side panel; a width you drag to is kept (#195)",
        "Dark mode uses the same purple accent as light mode, lifted to read on dark, in place of the green; the logo, tab icon and site banners follow (#195)",
        "On a big monitor, lists, the board, My Work, the Repo dashboard and Review use the wider window; laptops look the same (#195)",
      ],
      fixed: [],
      removed: [],
    },
    prs: [193, 194, 195],
  },
  // Trov writes for you (#178) cut together with Repo setups (#186), the performance pass (#187), What's new
  // (#188, #190), the dev seed (#189) and the keyboard fixes (#192): one deploy, one version.
  {
    version: "0.11",
    date: "2026-10-16",
    formerly: ["0.34"],
    title: "Trov writes for you, and the Repo screen fits every setup",
    headline: "Trov reads what your team captures and writes the short version, the Repo screen takes the shape of your repository, and every page loads faster.",
    highlights: [
      "Ask Trov: ask about your organization in plain words and get an answer built from what Trov holds, every source linked, with drafts of tickets, handoffs and doc changes for you to confirm.",
      "Trov writes the short version for you: your brief on My Work, where each repository stands on Repo › Summary, and a Feed record of what each session shipped, each with its sources.",
      "The Repo screen takes the shape of your repository, its apps and environments, opens with what needs attention, and shows the commit every deploy shipped.",
      "Digest e-mails are shorter and lead with your brief, and with your organization's AI on, Trov suggests a ticket's category and priority and sets filters from words you type.",
    ],
    headsUp: [
      "Org settings › AI says whether Trov's AI is on, each provider's key and this month's use; turning it off also stops Sift and new pull request and issue summaries.",
      "Hosting tokens moved from Integrations to Hosting, and each environment's app metrics token to its part's editor (Org settings › Repositories › a repository › Apps). Nothing was reset.",
      "Tickets no longer shows declined tickets in All, on the board or in the table; pick Closed to see them.",
    ],
    ops: [
      "Apply migration `0058_server_ai` (one file for the whole AI build; merging to main applies it; `0070`–`0075` already shipped with #186 and #187). All additive; each part's header has its rollback.",
      "No new secret, var or trigger: Ask, briefs, digests and Roadmap notes run on `ANTHROPIC_API_KEY`, ratings and card suggestions on `TYPESAFE_API_KEY`; unsent Ask files are swept on the existing hourly trigger.",
      "Publish the Trov plugin 0.9.0 (skill text only): `claude plugin marketplace update trov`, then `claude plugin update trov@trov`. An older plugin keeps working.",
      "Subscribe the GitHub App to the deployment, release, create and workflow_job events (Developer settings › GitHub Apps › trov-by-trovlabs › Permissions & events). Installations need not re-approve.",
      "Optional, for Cloudflare deploys' commits: give the Cloudflare user API token Account › Workers CI › Read as well. Without it the commit is matched from GitHub when it can be.",
      "Optional, Trov's own Product block: set the Production environment's API URL to Trov's origin and paste a member's `trov_mcp_` token as its app metrics token in that part's editor.",
      "Smart Placement, a minified Worker and uploaded source maps (`wrangler.toml`) ship with the normal deploy; the extra GitHub and host requests fit the `:20` and `:40` budgets.",
      "After the deploy, check that a hashed script is served `public, max-age=31536000, immutable` and HTML is not, and compare Workers Observability wall time for the Repo dashboard and `/auth/me`.",
    ],
    patches: {
      added: [
        "Ask Trov (⌘J on any org page): answers with linked sources, charts and diagrams, file attachments, saved conversations and Save as artifact (#178)",
        "Ask's write cards: confirm, edit, cancel or undo the tickets, handoffs and doc changes it drafts; Auto mode makes them at once, with Undo (#178)",
        "My Work › Your brief and Repo › Summary: what you're in the middle of and where each repository stands, with sources and Wrong? (#178)",
        "Suggestions on tickets, Unplaced docs and risky Review items; the Feed marks notable and breaking changes (#178)",
        "Describe a filter on Tickets, the Feed and Artifacts: type what you want and Trov sets the filters, with Undo (#178)",
        "The Roadmap: a sprint forecast, a note on each active sprint, a drift line, and themes for where the work went (#178)",
        "Org settings › AI and Settings › Trov: the switch, each provider's key, this month's use, and how Trov answers you (#178)",
        "Repo › Overview from your apps and environments: what needs attention first, each environment's state, a release view (#186)",
        "An App menu and a repository menu narrow the Repo screen; Org settings › Repositories › Apps accepts the apps Trov detects (#186)",
        "GitHub deployments as a host; Render, Railway and Fly.io detected from GitHub; Repo › Usage has a card per app (#186)",
      ],
      changed: [
        "Digests lead with your brief, the weekly adds This week, and you can get them only when something needs you (#178)",
        "Every deploy shows its commit or says it doesn't know, a failed one says why, and a rollback is marked as one (#186)",
        "Faster pages and a smaller first download: far fewer database round trips, and less used screens load when opened (#187)",
        "Help › What's new: 35 releases folded into 12, each with a few highlights and a short list of changes (#190)",
        "Terms and Privacy cover Ask Trov and the AI features, and say exactly what each AI provider receives (#178)",
        "Trov plugin 0.9.0: record-session records decisions, findings and incidents; load-context reads the repository's state first (#178)",
      ],
      fixed: [
        "What's new: a release's notes run beside the whole page, so its changes start right under the title (#188)",
        "Deploys reported by GitHub, and a GitHub-hosted app's earlier deploys, now show on the Repo dashboard (#186)",
        "On a phone the navigation button is a full 44×44 target, and a switch keeps keyboard focus on the picked option (#192)",
      ],
      removed: [
        "The digest's per-PR What / Why / Impact cards, its assigned-issue rows and the Roadmap's plan diff (#178)",
      ],
    },
    prs: [178, 186, 187, 188, 189, 190, 192],
  },
  // Hosting providers (#185): Org settings › Hosting and the Repo dashboard's Hosting section.
  {
    version: "0.10",
    date: "2026-10-15",
    formerly: ["0.33"],
    title: "Hosting providers",
    headline: "Connect Vercel, Netlify, Render or Fly.io, and the Repo dashboard shows every part of every environment, whoever hosts it.",
    highlights: [
      "Org settings has a Hosting tab: say which host runs each part of each environment and connect it once, whether Cloudflare, Railway, Vercel, Netlify, Render or Fly.io.",
      "Connect with Vercel and Connect with Netlify take one click; other hosts take a pasted token, and Trov says what it can do and where it is sent.",
      "Repo › Usage has one Hosting section for every part: its recent deploys, then traffic for a web part or CPU and memory for a service, and a dash with its reason when a host can't say.",
      "Trov looks for your host on your repository and suggests it when you add a part, and Vercel deploys show up as they happen.",
    ],
    ops: [
      "Migration `0057_hosting_providers` rebuilds `org_secrets`, moves the Cloudflare and Railway columns into parts and drops them; rollback is `scripts/hosting/0057_hosting_providers.down.sql`, run before 0042's.",
      "Connect Railway once on Org settings › Hosting with a workspace token, then remove the `RAILWAY_TOKEN_*` secrets; give the Cloudflare token Account › Workers Scripts › Read too, for its deploys.",
      "Optional, Connect with Vercel: a Vercel Integration (Redirect `<origin>/hosting/vercel/callback`, Configuration `<origin>/hosting/vercel/configure`, Webhook `<origin>/webhook/hosting/vercel`) and `VERCEL_INTEGRATION_CLIENT_ID`, `VERCEL_INTEGRATION_CLIENT_SECRET`, `VERCEL_INTEGRATION_SLUG`.",
      "Optional, Connect with Netlify: an OAuth application (Redirect `<origin>/hosting/netlify/callback`) and `NETLIFY_OAUTH_CLIENT_ID` / `NETLIFY_OAUTH_CLIENT_SECRET`. No trigger change: the hosting job runs on the `:40` tick.",
    ],
    patches: {
      added: [
        "Org settings › Hosting: a card per host with Connect or Manage (Test connection, Rotate, Disconnect) and a part editor per environment (#185)",
        "Vercel, Netlify, Render and Fly.io join Cloudflare and Railway as hosts; AWS is listed as coming later (#185)",
        "Repo › Usage › Hosting: every part's recent deploys and its traffic, or its CPU and memory, from any host (#185)",
        "Detected: Trov names the host your repository's checks and deploys show, and says where its search stands (#185)",
        "Vercel deploy events refresh that project straight away (#185)",
        "Preview with sample data on Org settings › Hosting (#185)",
      ],
      changed: [
        "Cloudflare and Railway are ordinary hosts, each connected once for the whole organization (#185)",
        "Form errors float in a box under their input, and every Where to get it is numbered steps (#185)",
        "Deleting an environment also deletes its parts and their deploy history (#185)",
      ],
      fixed: [],
      removed: [],
    },
    prs: [185],
  },
  // Tags of your own, sorted by Sift (#179–#184), with the old 0.31 folded in: states drawn as marks, summaries by Claude, the AI base (#173–#177).
  {
    version: "0.9",
    date: "2026-10-14",
    formerly: ["0.32", "0.31"],
    title: "Your own tags, sorted by Sift, and calmer status",
    headline: "Each organization keeps its own tag list that Sift helps fill, and every state is a small shape and a plain word instead of a coloured tag.",
    highlights: [
      "Tags are your organization's own list in Org settings › Tags: an admin can add, rename, merge or retire a tag and give it a description and a colour.",
      "With Sift turned on, Trov tags the feed entries, docs and decisions that fit a new tag, suggests the ones it is less sure of, and an admin can undo a run.",
      "Click a tag to open its page: every item that carries it, who writes about it, what it is often seen with, and what Sift added or suggests.",
      "A state is now a small shape and a plain word, such as a ticket's filling circle or a priority's signal bars, and hovering one says what it means.",
    ],
    headsUp: [
      "A feed entry with a tag that is not on your list is posted without it; the tag waits in Org settings › Tags for an admin to add, map or dismiss.",
      "A tag list holds up to 30 tags on Free and 50 on Pro, and states read in sentence case, for example \"In progress\" instead of \"IN PROGRESS\".",
      "Pull request and issue summaries are now written by Anthropic's Claude, and the Terms and Privacy Policy name Anthropic in place of Google.",
    ],
    ops: [
      "Migrations `0055_ai` and `0056_org_tags` (applied on merge). Before `0056`, check every stored tag is one of the six starter tags; the rollback is in its header.",
      "Set the new secrets `ANTHROPIC_API_KEY` (summaries) and `TYPESAFE_API_KEY` (Sift); delete `GEMINI_API_KEY` once summaries land with the Claude model.",
      "Trov plugin 0.8.2 (skill text only): feed tags come from the organization's list. Update it from the marketplace.",
    ],
    patches: {
      added: [
        "Org settings › Tags: the organization's own tag list, with New tag, Rename, Merge into… and Retire (#179)",
        "A tag's page, a doc's Tags row, and a To review tab for the tags Sift suggests (#179)",
        "Sift, automatic tagging, off until an admin turns it on, with a live progress bar and Undo for a run (#179)",
        "Agents can read the organization's tags through the new list_tags tool (#179)",
        "Docs for Claude on the web: add Trov as a custom connector, and use it in a chat with no repository (#174)",
        "Every state shows what it means in a tooltip when you hover it (#173)",
      ],
      changed: [
        "A feed entry's unknown tag becomes a suggestion for an admin instead of sending the entry to Unplaced (#179)",
        "Tickets, Review, Search, the Roadmap, handoffs, artifacts, the Repo screen, Settings and the digests draw states as marks, not pills (#173)",
        "Roles, \"(you)\", a plan's name and other plain facts are plain text instead of coloured chips (#173)",
        "Pull request and issue summaries are written by Anthropic's Claude instead of Google's Gemini (#176)",
      ],
      fixed: [
        "A tag page's people and related-tag bars now take each one's own colour (#180)",
        "The header's breadcrumb no longer sets the page you are on smaller and lighter than the title before it (#180)",
        "To review: adding or dismissing a suggestion moves only that row, at once, and confirms it like every other write (#182, #184)",
        "The public docs' page tabs no longer reload the whole page (#174)",
        "Email digests coloured ticket statuses differently from the app (#173)",
      ],
      removed: [],
    },
    prs: [179, 180, 182, 184, 173, 174, 175, 176, 177],
  },
  // The public site readable by search engines and agents, public docs, self-serve deletion, and the compliance pass (#172).
  {
    version: "0.8",
    date: "2026-10-12",
    formerly: ["0.30"],
    title: "Public docs, deleting your data, and plain terms",
    headline: "The public site and new docs are readable by search engines and AI assistants, and you can delete your account or organization yourself.",
    highlights: [
      "New public docs at trov.dev/docs cover setup, connecting each agent, how Trov decides what is settled and every MCP tool, each also as plain Markdown.",
      "You can delete your account in Settings, and an organization's owner can delete it in Org settings, without writing to us.",
      "Trov loads nothing from anyone else: its fonts and diagrams come from trov.dev, and text and focus rings meet WCAG AA contrast in both themes.",
      "New Terms of Service and Privacy Policy, and a Refund and Cancellation Policy, say plainly who runs Trov, what is kept and how Pro renews.",
    ],
    headsUp: [
      "Creating an account asks you to agree to the Terms and the Privacy Policy and to confirm you are 16 or older.",
      "Before you pay for Pro, Trov shows the per-seat total, that tax is added at checkout, and that Pro renews monthly until you cancel.",
      "A deletion can't be undone; signing in again afterwards starts a new, empty account, and what you wrote in other organizations stays as \"Deleted user\".",
    ],
    ops: [
      "No migration and no new secret. Before deploying, check no organization uses a newly reserved slug: `og`, `404`, `fonts`, `source`, `refunds`.",
      "One-time in Cloudflare: Always Use HTTPS on, a www → apex redirect, and AI Crawl Control and the managed robots.txt off for the search and assistant crawlers (`HANDOFF.md` › 10).",
      "Stripe dashboard, test and live: set the Terms, Privacy and refund policy URLs, cancel at the end of the period in the Customer Portal, and turn on payment receipts.",
      "After a dependency change, run `node scripts/licenses/notices.mjs` and commit `THIRD-PARTY-NOTICES.txt`.",
    ],
    patches: {
      added: [
        "The public pages open with their words already there, with one canonical address, share cards, a sitemap and robots.txt (#172)",
        "Public docs at /docs, each page also as Markdown, plus llms.txt for AI assistants and a generated MCP tools reference (#172)",
        "Errors an agent gets now carry a hint saying what to do next (#172)",
        "Settings › Delete account, Org settings › Delete organization (owners), and deletion from Platform (#172)",
        "A Refund and Cancellation Policy at /refunds, and a link to the source code of the version you are using (#172)",
        "The email Unsubscribe link opens a page that says whose mail it stops, and changes nothing until you confirm (#172)",
        "A Skip to content link on every page, labelled form fields, and screenshots that describe themselves (#172)",
      ],
      changed: [
        "Fonts and the diagram renderer are served from trov.dev instead of Google Fonts and a CDN; emails use your device's fonts (#172)",
        "Quiet text, links and the status colours are a little deeper to meet WCAG AA; every control shows keyboard focus (#172)",
        "Rewritten Terms and Privacy Policy, consent at sign-up, and Pro's billing terms shown before checkout (#172)",
        "The welcome email says digests are on from the start and has an Unsubscribe link (#172)",
        "Every footer names TrovLabs, Inc. and links the Terms, Privacy, Refunds, the source and the licences (#172)",
      ],
      fixed: [
        "A digest's Unsubscribe link needed a sign-in and then stopped mail for whoever was signed in (#172)",
        "An address that does not exist shows Page not found instead of asking you to sign in (#172)",
        "The dark theme no longer flashes white, and the home page no longer shows \"Signing you in…\" when signed out (#172)",
        "The landing's sign-in dialog now keeps the keyboard inside it (#172)",
      ],
      removed: [
        "The in-app unsubscribe screen: the old address now opens Settings and changes nothing (#172)",
      ],
    },
    prs: [172],
  },
  // A new front page, the site on a phone, Review for a long queue, pay inside Trov, one GitHub account for several orgs (formerly 0.25–0.29).
  {
    version: "0.7",
    date: "2026-10-11",
    formerly: ["0.29", "0.28", "0.27", "0.26", "0.25"],
    title: "A new front page, and one account across organizations",
    headline: "A new site that works on a phone, a faster Review, and GitHub and Claude Code connections shared across your organizations.",
    highlights: [
      "Several organizations can connect the same GitHub account and track the same repository, each with its own copy, connecting exactly the repositories you can read.",
      "One Claude Code connection now covers every organization you belong to: it follows the repository you are in, or works in the organizations you tick.",
      "A new front page, laid out for a phone, with a tour where every screen opens at full size, and a bug button and Contact form that show exactly what they send.",
      "Review shows a proposed doc as it will read, with what changed marked in the text, and a card you decide folds away as the next one opens.",
    ],
    headsUp: [
      "The Terms of Service and Privacy Policy changed on October 9, 2026: they now cover paid plans, billing, cancelling and refunds, and what a bug report stores.",
      "Existing Claude Code connections keep working in their one organization; add organizations, or make one follow the repository, in Settings › MCP access.",
      "What an organization can read on GitHub is checked when its admin connects; to drop access someone no longer has, disconnect and connect again.",
    ],
    ops: [
      "Migrations `0049_support_reports`, `0051_mcp_connection_orgs` (before the Worker that reads it) and `0053_installation_repos`.",
      "Vars: `SUPPORT_NOTIFY_EMAIL` (the inbox for bug reports; mail only with `NOTIFICATIONS_MODE = \"resend\"`) and `STRIPE_TAX = \"on\"`.",
      "Embedded checkout is off until `STRIPE_PUBLISHABLE_KEY` (var) is set to the publishable key of the same mode as `STRIPE_SECRET_KEY`; empty it to turn it off.",
      "Trov plugin 0.8.0 (needed for a connection that follows the repository), then 0.8.1 (skill text only).",
    ],
    patches: {
      added: [
        "A bug button in the top bar, Contact support in Settings and Contact on the site open one report form; Platform › Support lists the reports (#134)",
        "The front page opens on Trov's banner with a live Review screen, and every tour screen opens full size with Previous and Next (#134)",
        "Empty screens draw their own layout with one sentence and one action; ?preview=empty and ?preview=loading show every screen's empty or loading state (#134)",
        "A Claude Code connection follows the repository or works in the organizations you tick; change it in Settings › MCP access (#134)",
        "The site on a phone: a Menu sheet, forms that rise from the bottom and stay above the keyboard, swipe through the tour (#139)",
        "Pay for Pro on a Trov page, in the same card as signing up; if the form cannot load, Stripe's own page is offered (#136)",
        "Agents with no shell can open and add image, PDF and file artifacts up to 1 MB (#171)",
      ],
      changed: [
        "Sign in and Get started are one dialog; Get started opens on a choice of plan, and choosing Pro carries on to payment (#134)",
        "Terms and Privacy: a new section on plans, payment and cancellation, and pages with an In short box and contents beside the text (#134)",
        "Review › Rendered shows the doc as it will read in Docs, with additions and removals marked inside paragraphs, list items and table cells (#138)",
        "Review: a decided card shows its verdict and folds away, the counts drop with it, and the list keeps its scroll position (#138)",
        "Several organizations can connect one GitHub account and track one repository; disconnecting in one leaves the others connected (#171)",
        "Connecting GitHub takes the repositories you can read instead of refusing; Repositories says whose access it is, and Connect again adds more (#171)",
        "Connecting from claude.ai preselects Manual, and handoffs, prompts and artifacts no longer assume a code repository (#171)",
      ],
      fixed: [
        "A new account that signed up to buy Pro went through setup and never reached checkout (#168)",
        "The first-run card snapped from a short loading card to full height when moving to the organization picker (#134)",
        "On a phone, the front page's Review picture was cut off and the tour's Tickets board overflowed its cards (#139)",
        "Picking a card in Review rebuilt the screen and jumped a long list back to the top (#138)",
      ],
      removed: [],
    },
    prs: [171, 136, 139, 138, 134, 137, 168],
  },
  // Formerly 0.19–0.24 (2026-10-07 – 08): the GitHub App, plans and billing, Sync you can see, Free and Pro per seat, the guided setup.
  {
    version: "0.6",
    date: "2026-10-08",
    formerly: ["0.24", "0.23", "0.22", "0.21", "0.20", "0.19"],
    title: "Plans, the GitHub App and a guided setup",
    headline: "Connect GitHub by installing the Trov App, start Free or pay per seat for Pro, and a new organization opens on a guided setup.",
    highlights: [
      "Connect your repositories by installing the Trov App on GitHub from Org settings › Repositories: no token to paste, no webhook to set up, and a repository is tracked with one click.",
      "Anyone can sign in with GitHub or Google and start a Free organization; Pro is $10 per seat a month with no minimum, bought and managed by its owner from Org settings.",
      "Sync GitHub opens a panel that says what it will do, shows its progress while it runs, and leaves a result everyone in the organization can read.",
      "A new organization opens on a guided setup: connect the repository, connect your coding agent, invite your team, one skippable step at a time.",
    ],
    headsUp: [
      "An organization's address is shorter: trov.dev/your-org/ instead of trov.dev/o/your-org/. Old links and bookmarks still work and take you to the new address.",
      "AI summaries of pull requests and issues come with a monthly allowance on each plan; once it is used, new items show a short excerpt until the next month.",
      "If a Pro subscription ends, the organization moves to Free when the paid period ends: nothing is deleted, but adding more over a Free limit is refused.",
    ],
    ops: [
      "Migrations `0043_github_app`, `0044_plans`, `0045_billing`, `0046_sync_runs`, `0047_billing_seats`, `0048_plan_gifts` (all additive; the merge applies them).",
      "GitHub App: secrets `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, var `GITHUB_APP_SLUG`; the App's webhook at `https://trov.dev/webhook/github/app` (checklist in `docs/architecture/github-app.md`).",
      "Billing: secrets `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, var `STRIPE_PRICE_TEAM` (one per-seat Pro price; optional `STRIPE_PRICE_TEAM_YEARLY`), webhook `https://trov.dev/webhook/stripe`, portal quantities 1–50 (`docs/architecture/billing.md`).",
      "Secrets `GEMINI_API_KEY` (AI summaries) and `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Google sign-in). Trov plugin 0.7.1 points at `https://trov.dev/mcp`. No trigger change.",
    ],
    patches: {
      added: [
        "Connect with GitHub on Org settings › Repositories: install the Trov App, then track the repositories it can see with one click (#103)",
        "Plans: Org settings › General shows the plan, its limits and what you use, and Members shows the seats in use (#104)",
        "A public pricing page at /pricing, and a pricing section on the landing page (#105)",
        "Buy a plan on Stripe's page and set the organization up yourself; Manage billing opens Stripe's portal (#106)",
        "The Sync panel: what a sync will do, its progress while it runs, and a result everyone can read (#109)",
        "Free organizations for anyone signed in; Pro (was Team) is sold per seat and Personal is no longer offered (#117)",
        "While a screen loads it shows the outline of what is coming, so pages no longer jump when the data lands (#119)",
        "The guided setup at first run: repository, coding agent, team, each step skippable, with Back always there (#121, #124)",
        "Trov can gift an organization a plan for a set time; it moves to Free when the gift ends, with nothing deleted (#123)",
        "Personal Settings shows the organization's plan and limits, your organizations, and a Session tile (#126)",
        "Cancel plan opens Stripe's cancel flow directly and comes back to Trov (#134)",
      ],
      changed: [
        "Google sign-up is open: any verified Google account can create an account, no invitation needed (#120)",
        "An organization's address is /your-org/ (was /o/your-org/); old links redirect (#111)",
        "Connecting a different GitHub App installation replaces the current one, with no Disconnect first (#110)",
        "Help › Get Started is now Help › Guide, a reference on how Trov works (#124)",
        "Emails take the shape of the app's first-run card, and Org settings › Members is a table (#127, #128)",
      ],
      fixed: [
        "Emails fit a phone's width instead of staying 680px wide (#130)",
        "The app behind the guided setup no longer flashes or replays its entrance on each step (#124)",
        "A GitHub App on an account that does not own the repository is named, with a Connect link, instead of failing silently (#110)",
        "Tracking a repository past the plan's limit says which limit, instead of an internal error (#106)",
      ],
      removed: [],
    },
    prs: [121, 122, 123, 124, 125, 126, 127, 128, 130, 134, 117, 119, 120, 109, 110, 111, 105, 106, 104, 103],
  },
  // Formerly 0.17–0.18 (2026-10-06): Canopy is renamed Trov, and Trov holds any number of organizations.
  {
    version: "0.5",
    date: "2026-10-06",
    formerly: ["0.18", "0.17"],
    title: "Trov, with organizations",
    headline: "Canopy is now Trov, and it runs for any number of teams: each has its own organization, invites its own people, and you switch between them.",
    highlights: [
      "Canopy is now called Trov, with a new logo, in the app, on the site, in every email and in the Claude Code plugin; everything you had is where it was.",
      "Trov holds more than one organization, each with its own docs, tickets, roadmap, feed and the rest; the switcher at the top of the sidebar moves between them.",
      "Org settings is where an organization is run: invite people by GitHub login or email, set roles and titles, and set its repositories, environments and credentials.",
      "Connecting Claude Code is per organization: you pick the organization when you allow the connection, and Settings › MCP access shows which one each app reaches.",
    ],
    headsUp: [
      "The Claude Code plugin is now called Trov: remove the old Canopy plugin, install Trov with the commands in Settings › MCP access, then sign in again.",
      "Page addresses start with your organization, and old links still open. Maintenance is split: Unplaced is in Triage, people and digest settings are in Org settings.",
      "Admin now means admin or owner of the organization you're in; if you lost an action you had, ask an owner to make you an admin in Org settings › Members.",
    ],
    ops: [
      "Migrations `0041_trov_name` and `0042_organizations` (one all-or-nothing file): export the database and run `node scripts/mt/verify-migration.mjs` first; rollback is `scripts/mt/rollback/0042_organizations.down.sql`.",
      "Set the `TROV_KEK` secret (32 random bytes, base64) before deploying: it encrypts every stored credential, so keep a copy. Then re-enter the old Worker secrets per org in Org settings › Integrations.",
      "Verify trov.dev as a Resend sending domain before `0041_trov_name`: all mail goes from `hello@trov.dev`. Run the Worker on Workers Paid (the cron spends up to 900 subrequests).",
      "Trov plugin 0.7.0 renames the plugin and its MCP server to `trov`: everyone reinstalls (`/plugin install trov@trov`) and authenticates again.",
    ],
    patches: {
      added: [
        "Organizations, each with its own content and its own ticket and handoff numbers, and the switcher in the sidebar",
        "Org settings: Members, Repositories, Environments, Integrations, Notifications, General and a setup checklist",
        "Invitations by GitHub login or email, sent by Trov and naming the organization, with Resend in Members",
        "Write-only credentials per organization: once saved, only the last four characters show",
        "An organization image, uploaded in Org settings › General or taken from the main repository owner's GitHub picture",
        "Platform, for whoever runs Trov: add, suspend and audit organizations",
        "Terms of Service and Privacy Policy pages, linked from the site's footer",
        "The Trov mark in the app, on the site, in the tab icon and in emails",
      ],
      changed: [
        "Canopy is renamed Trov everywhere; your theme and sidebar settings carry over, and tokens already issued keep working",
        "Page addresses start with the organization; old links open in your organization",
        "Maintenance is split: Unplaced moves to Triage, People to Org settings › Members, digest settings to Notifications",
        "Admin is a role in the organization you're in, set by an owner in Members",
        "Signing in with GitHub no longer requires being in a particular GitHub organization",
        "Connecting Claude Code picks an organization, and Settings › MCP access shows each app's",
        "The digest's sender is a name your admin picks; mail goes out from Trov's own address",
        "A few actions have a daily limit per person, and Trov says when you can try again",
      ],
      fixed: [
        "Switching tabs in Org settings or Platform no longer replays the screen's entrance",
        "Artifact previews and downloads work for a person in several organizations",
        "Settings › Account no longer cuts off \"Signed in as …\" on a narrow tile",
      ],
      removed: [],
    },
  },
  // The board, feed briefs, My Work tiles and person cards (formerly 0.14–0.16, Sep 26–27).
  {
    version: "0.4",
    date: "2026-09-27",
    formerly: ["0.16", "0.15", "0.14"],
    title: "The board, My Work tiles and person cards",
    headline: "Tickets open on a board, My Work becomes tiles, the Roadmap gets a timeline, and every name opens that person's card.",
    highlights: [
      "Tickets open on a board: drag a card to another column or a new spot in its column, and the order is saved for everyone.",
      "My Work is a set of tiles (tickets for you, what needs your review, your sessions, the repo, your library), and the Roadmap gains a Timeline of every sprint.",
      "Search everything from the sidebar as you type, and feed entries carry a short brief, so the Feed reads as a list for people.",
      "Click anyone's name to see their card with photo, role and GitHub, and upload your own photo in Settings › Profile.",
    ],
    headsUp: [
      "The Roadmap's plan narrative is limited to 800 characters, so it stays a short Now / Next / Later; the detail lives in each sprint.",
      "Trov opens in the Light theme until you pick one, and the Midnight theme is gone (if you had picked it, you get Dark).",
      "Settings no longer makes MCP tokens: agents connect by signing in in the browser. Tokens you already use keep working.",
    ],
    ops: [
      "Migrations `0033_ticket_testing_rank`, `0034_feed_brief_artifact_cap`, `0035_library_and_sprint_dates` and `0036_person_profiles`.",
      "Plugin 0.6.3 → 0.6.8 over these versions (0.6.8 is the last).",
    ],
    patches: {
      added: [
        "A ticket board with saved drag order, and an optional Testing status between In progress and Done (#78)",
        "Search and a Filter menu on the ticket queue: assignee, category, priority and sprint (#78)",
        "A short brief on every feed entry; the Feed opens For reading, with For agents for the full record (#83)",
        "New version on an artifact's page: edit its text or upload a replacement file (#82)",
        "My Work's tiles, and This week and Waiting on review beside the Feed (#84)",
        "Roadmap › Timeline, and real sprint start dates picked from a calendar (#84)",
        "Search from the sidebar, with results grouped by kind as you type (#84)",
        "Delete a prompt or an artifact you made, after a confirmation, with Undo (#84)",
        "Person cards, photo upload, and roles that admins set in Maintenance › People (#89)",
        "Delete a ticket filed in Trov, and discard a GitHub login that isn't on the team (#89)",
        "Agents can add or remove a ticket's assignees (#89)",
      ],
      changed: [
        "Tickets move freely between statuses, so a done or declined ticket can be reopened (#88)",
        "One card look across the app, a new light theme, and Geist type outside the sidebar (#84, #86)",
        "Maintenance, Roadmap and Repo sections are tab bars at the top of the page (#89)",
        "Settings is one even grid, and MCP access walks you through the browser sign-in (#89)",
      ],
      fixed: [
        "The Feed's time range now filters (#83)",
        "Your picture and name no longer change with the way you signed in (#89)",
      ],
      removed: [],
    },
    prs: [89, 91, 84, 85, 86, 87, 88, 77, 78, 79, 80, 81, 82, 83],
  },
  // Artifacts, browser sign-in for agents and GitHub issues as tickets (formerly 0.11–0.13, Sep 24–25).
  {
    version: "0.3",
    date: "2026-09-25",
    formerly: ["0.13", "0.12", "0.11"],
    title: "Artifacts, browser sign-in and GitHub issues",
    headline: "Agents keep their pages as artifacts, connect by signing in through the browser, and every GitHub issue becomes a ticket.",
    highlights: [
      "Artifacts: Trov stores, versions and shares the pages agents produce, and you can compare two versions and ratify the one you stand behind.",
      "Agents connect by signing in through the browser, with no token to paste, and you can revoke any connected app.",
      "Docs can carry images, shown in Review as added or removed.",
      "Every GitHub issue shows up as a ticket that follows its issue's close and reopen, and any member can create, complete or delete a sprint.",
    ],
    ops: [
      "Migrations `0029_oauth`, `0030_artifacts`, `0031_doc_images` and `0032_ticket_source`; create the R2 bucket `canopy-artifacts` before the first deploy with its binding.",
      "After 0032, run Sync GitHub once to mirror the issues already open.",
      "Plugin 0.4.0 → 0.6.1; `artifact_create` is renamed `upload_asset` with no alias, so agents must update the plugin.",
    ],
    patches: {
      added: [
        "Knowledge › Artifacts: browse, open, compare and ratify pages; agents publish and link them to tickets and sprints (#72)",
        "A ticket's page lists its artifacts, and a page can be kept private to its author (#72)",
        "Get Started as an onboarding path with an On this page list, and figures that open full size (#73)",
        "Browser sign-in for agents, and Connected apps in Settings with Revoke",
        "Images in docs, uploaded by agents, opening full size on a click (#74)",
        "GitHub issues mirrored as tickets, with a locked link back to the issue (#75)",
        "Edit any ticket's title and description (#75)",
        "Delete a sprint from its page; its tickets move to the backlog (#65)",
      ],
      changed: [
        "The ticket page is laid out like the sprint page, with the properties rail beside the title (#71)",
        "Agents can create, complete and delete sprints for every member; only the plan rewrite stays admin-only (#65)",
        "The ticket queue's filters are themed menus, not the browser's dropdowns (#76)",
      ],
      fixed: [
        "A page or SVG opened in its own tab could run script on Trov's address (#72)",
        "A mirrored issue is never created twice, whatever case GitHub spells the repository in (#75)",
      ],
      removed: [],
    },
    prs: [65, 75, 76, 74, 71, 72, 73],
  },
  // Formerly 0.5–0.10 (Sep 13–23): email digests, Google sign-in, tickets and sprints, the landing page, the Repo dashboard, handoffs.
  {
    version: "0.2",
    date: "2026-09-23",
    formerly: ["0.10", "0.9", "0.8", "0.7", "0.6", "0.5"],
    title: "Tickets, the Repo dashboard and handoffs",
    headline: "Tickets and sprints, a Repo dashboard, handoffs between sessions, Google sign-in and email digests.",
    highlights: [
      "Tickets: file, assign, link and discuss work in one queue, as a table or a board, grouped into sprints a person confirms done.",
      "Monitor › Repo shows code, CI, deploys and usage, and says \"not connected\" instead of guessing when a source is missing.",
      "Handoffs pass a task's context to the next session, and the Prompt Library keeps reusable prompts a person publishes.",
      "Sign in with Google or GitHub, pick your handle, and get daily or weekly email digests you can turn off in one click.",
    ],
    headsUp: [
      "Your GitHub login became your handle; you can pick a different one in Settings › Profile.",
      "Milestones became sprints, and agents can no longer propose roadmap items.",
    ],
    ops: [
      "Migrations `0021_notifications`, `0022_notification_bodies`, `0023_persons` (one-way: migrate, then deploy), `0024_tickets`, `0025_sprints` (renames milestones; migrate and deploy together).",
      "Migrations `0026_token_hint`, `0027_repo_capture`, `0028_handoffs_prompts`; the GitHub OAuth scope adds `user:email`.",
      "Usage source secrets `CF_ANALYTICS_*`, `RAILWAY_TOKEN_*`, `SAPLING_METRICS_TOKEN`; subscribe the repo webhook to deployment statuses, check runs, workflow runs, reviews and statuses.",
      "Crons: two hourly digest triggers and the `*/10 * * * *` repo cron — run `wrangler triggers deploy` after the merge.",
    ],
    patches: {
      added: [
        "Handoffs and the Prompt Library, on the web and for agents; unclaimed handoffs expire after 7 days (#69)",
        "Settings › Get connection command: a token plus the exact setup for Claude Code, Codex or .mcp.json (#66)",
        "Remove a link from a ticket, and propose a new doc from Docs › New doc (#67, #69)",
        "The Repo dashboard: Overview, Code, CI, Usage and Planning tabs, with Poll now for admins (#53, #56, #62, #63)",
        "Agents can read the Repo dashboard (#62)",
        "A new sidebar with sections, a ⌘K search box and a collapsing rail (#53)",
        "A landing page for signed-out visitors, with sign-in as a dialog (#49)",
        "Settings lists your MCP tokens with last-used times, and each can be revoked (#50)",
        "Tickets and sprints, and the Ticket queue email digest (#44)",
        "Agents can file tickets and work the ones assigned to their person (#48)",
        "A welcome email and a Get Started landing for new members (#47)",
        "Sign in with Google for invited teammates; link GitHub and Google to one account (#41)",
        "Email digests for My Work, Review and roadmap changes, with one-click unsubscribe and admin previews (#34, #37)",
      ],
      changed: [
        "Settings is one bento screen; emails share one banner and support dark mode (#43, #50, #39)",
        "Tighter corners across the app, and feed entries render as formatted text (#62, #63)",
      ],
      fixed: [
        "Clicking a button low on a long screen no longer jumps the page to the top (#38)",
        "The weekly digest trigger used weekday 0, which Cloudflare rejects (#35)",
        "A real DOWN health reading from a manual ping is no longer dropped (#62)",
      ],
      removed: [
        "The agent-proposed roadmap (milestone proposals) (#44)",
      ],
    },
    prs: [66, 67, 68, 69, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 49, 50, 44, 47, 48, 41, 42, 43, 34, 35, 36, 37, 38, 39],
  },
  // Formerly 0.1–0.4 (Jun 29 – Jul 10): the gate, the plugin, My Work / Roadmap / Review, summaries and the Docs reader.
  {
    version: "0.1",
    date: "2026-07-10",
    formerly: ["0.4", "0.3", "0.2", "0.1"],
    title: "Foundations",
    headline: "The first Canopy: agents propose context through a gate, people confirm it, and the team reads it on My Work, Docs and the Roadmap.",
    highlights: [
      "Agents connect over MCP to search, add to the feed, propose doc changes and record a whole session; a person promotes or rejects.",
      "Install Canopy into Claude Code as one plugin: the skills arrive and the connection is set up for you.",
      "My Work shows your assigned issues and merged pull requests as short summaries; the Roadmap is an admin-written plan.",
      "Review is one queue for proposals and draft decisions, and Docs has Technical and Product spaces with an outline.",
    ],
    ops: [
      "Migrations `0008_fts` through `0020_docs_space_vocab`.",
      "Secrets `GITHUB_WEBHOOK_SECRET`, `GITHUB_SERVICE_TOKEN` and `GEMINI_API_KEY`; add the GitHub webhook (pull requests and issues).",
    ],
    patches: {
      added: [
        "Feed, Docs, Roadmap, Search and Triage, with GitHub sign-in and light, dark and Midnight themes (#1)",
        "Search with authority flags, and Triage to reject, discard or assign what agents staged (#2)",
        "Agents record a whole session in one call (#3)",
        "The Canopy plugin for Claude Code (#5)",
        "Admins sync PRs and issues from GitHub, with a progress bar (#9, #14)",
        "Review with unified, side-by-side and rendered diffs; Maintenance for unplaced items and unknown logins (#15, #16, #17)",
        "Issue summaries on My Work (#18)",
        "Get Started is a tour of every screen (#32)",
      ],
      changed: [
        "My Work and the Roadmap read captured GitHub activity instead of calling GitHub live (#8)",
        "PR cards read as What changed / Why / Impact, summarized by Gemini (#27, #28)",
        "Docs pages expand to their headings, and the outline follows your scroll (#25, #29)",
        "The screen you are on is in the URL, so a reload stays there (#29)",
      ],
      fixed: [
        "A stored XSS through an agent-controlled doc slug in Triage (#2)",
        "Searching from an agent failed in production (#7)",
        "Sync GitHub could hang or report 0 of 0 on a bad token (#19, #26)",
        "Feed chips show `#321` and a short SHA instead of a full URL (#31)",
      ],
      removed: [
        "The four-tab Triage screen, replaced by Review and Maintenance (#15)",
      ],
    },
    prs: [19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 31, 32, 33, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 5, 6, 7, 1, 2, 3, 4],
  },
];

// ── rendering ────────────────────────────────────────────────────────────────
// Three pages, all the `releases` screen:
//   #releases                  → the index: a grid of release cards, newest first
//   #releases/<v>              → one release's notes (highlights, Heads-up)
//   #releases/<v>/patches      → the same release's patch notes (Added / Changed / …)
// `<v>` is `releaseSlug`: the version ("0.7"), or "unreleased". Cards, the back link
// and the newer/older links are real `<a href="#…">` (the hash is the route, so Back
// works); the page's Release notes / Patch notes switch is a `segmented()`.

export type ReleasePage = "notes" | "patches";

/** A release's URL segment: its version, or "unreleased". */
export const releaseSlug = (r: Pick<Release, "version" | "unreleased">): string =>
  r.unreleased ? "unreleased" : r.version.toLowerCase();

/** The release a URL segment names, or null. Current versions win; then an old number
 *  from before the renumbering (`formerly`), so an old `#releases/0.25` link still lands on
 *  the entry that holds it. An old number that is now a current version opens the current one. */
export function findRelease(slug: string, releases: readonly Release[] = RELEASES): Release | null {
  const s = slug.toLowerCase();
  return releases.find((r) => releaseSlug(r) === s)
    ?? releases.find((r) => r.formerly?.some((v) => v.toLowerCase() === s))
    ?? null;
}

/** How a release is named: "Unreleased" or "v0.7". */
export function releaseName(r: Pick<Release, "version" | "unreleased">): string {
  return r.unreleased ? "Unreleased" : `v${r.version}`;
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

/** "v0.7 · Oct 11, 2026", or the Unreleased tag. */
function metaRow(r: Release): string {
  const inner = r.unreleased
    ? `${stateMark("Unreleased", "var(--accent)", "ring", 12, "Merged, not deployed yet.")}<span aria-hidden="true">·</span><span>Not deployed yet</span>`
    : `<span class="cnpy-rel-ver">${esc(releaseName(r))}</span><span aria-hidden="true">·</span><time datetime="${attr(r.date)}">${esc(releaseDate(r.date))}</time>`;
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
      <p class="cnpy-relidx-intro">Every release, newest first. Open one for its notes, and switch to Patch notes for the full list of changes with links to the pull requests on <a href="${attr(TROV_REPO_URL)}" target="_blank" rel="noopener noreferrer" class="cnpy-rel-pr">GitHub</a>. Trov is open source under AGPL-3.0: <a href="${SOURCE_PATH}" target="_blank" rel="noopener" class="cnpy-rel-pr" data-source-link>the source code of the version you are using</a>.</p>
    </div>
    <div class="cnpy-relgrid">${releases.map(indexCard).join("")}</div>
  </div>`;
}

// ── one release ──────────────────────────────────────────────────────────────
// A release's two pages are ONE two-column grid (`releasePageView`, #188): the back link
// and the Release notes / Patch notes switch across the top; down the left column the
// header (version / date / tag, title, lede) on the page background, the whole body in a
// SINGLE surface card (hairlines between sections, no box inside it), then the newer /
// older links; down the right column the page's note (Heads-up / Upgrade notes), beside
// the title and the body. Everything stacks to one column on a narrow page.

/** A release page's Release notes / Patch notes switch — on the page's back-link row. */
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
  return `<header class="cnpy-reldoc-head cnpy-rise">
    <div class="cnpy-reldoc-head-main">
      ${metaRow(r)}
      <h1 class="cnpy-reldoc-title">${esc(r.title)}</h1>
      <p class="cnpy-reldoc-lede">${releaseLine(r.headline)}</p>
      <span class="cnpy-reldoc-facts">${facts}</span>
    </div>
  </header>`;
}

/** The back link and, right-aligned on the same row, the Release notes / Patch notes switch. */
const docTopRow = (page: ReleasePage): string => `<div class="cnpy-reldoc-toprow cnpy-rise">
      <a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a>
      ${releasePageSwitch(page)}
    </div>`;

const INFO = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 7.5v.5"></path></svg>`;
const WRENCH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true" style="flex:none"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;

/** The page's note, in the right column beside the title block and the body: a small icon + label
 *  over a short list (one item is one paragraph) — compact and calm. Omitted when there are no lines. */
function headerNote(label: string, icon: string, lines: readonly string[]): string {
  if (!lines.length) return "";
  const body = lines.length === 1
    ? `<p class="cnpy-relheads-one">${releaseLine(lines[0])}</p>`
    : `<ul class="cnpy-relheads-list">${lines.map((h) => `<li>${releaseLine(h)}</li>`).join("")}</ul>`;
  return `<aside class="cnpy-relheads cnpy-rise" aria-label="${attr(label)}" style="border-radius:6px"><span class="cnpy-relheads-l">${icon}${esc(label)}</span>${body}</aside>`;
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
 *  highlights (the Heads-up is in the right column, `releasePageView`) —
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

/** Patch notes (the Upgrade notes are in the right column, `releasePageView`): each non-empty group as a STACKED
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
  // ONE grid (#188): the back-link row across the top; then the title block, the body card and
  // the newer / older links down the LEFT column, and the page's note (the Heads-up on the release
  // notes, the Upgrade notes on the patch notes) down the RIGHT one, top-aligned with the title.
  // The note is a sibling of the body, never part of the header, so a long note runs beside the
  // body instead of pushing it down. Under 900px of page it is one column in source order:
  // title, note, body (trov.css).
  const note = page === "notes" ? headsUp(r) : upgradeNotes(r);
  return `<div class="cnpy-reldoc">
    <div class="cnpy-reldoc-grid${note ? " has-heads" : ""}">
    ${docTopRow(page)}
    ${docHead(r, page)}
    ${note}
    <article${surface("--i:1", { cls: "cnpy-reldoc-card cnpy-rise" })} aria-label="${attr(page === "patches" ? "Patch notes" : "Release notes")}">
      ${page === "patches" ? patchesDoc(r) : notesDoc(r)}
    </article>
    ${pager(r, page, releases)}
    </div>
  </div>`;
}

/** The whole `releases` screen: the index, or one release's page. */
export function releasesScreen(slug: string | null, page: ReleasePage, releases: readonly Release[] = RELEASES): string {
  return slug ? releasePageView(slug, page, releases) : releasesIndex(releases);
}
