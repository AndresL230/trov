// ── Legal: the Terms of Service, the Privacy Policy and the Refund and Cancellation Policy ─────────────
// Three PUBLIC static pages, `/terms`, `/privacy` and `/refunds` (`legal` pages of shared/site-pages.ts,
// whose HTML the build writes and prerenders — served by the assets binding before the Worker, so no
// session is ever asked for; a new document here is one entry there and one in `LEGAL_DOCS`). They are
// paths, not hash routes, on purpose: the hash is the app's route AND the sign-in return-to, and a legal
// page must open signed out, from the site's footer, from an email, from the sign-in dialog, from the app's
// Settings › Help, or from the OAuth pages the Worker renders.
//
// This module is PURE (content + `legalView`), so a render test can read it; the DOM boot (theme, toggle,
// mount) is web/src/legal-page.ts. The footer is shared (`siteFooter`, web/src/site-chrome.ts).
//
// Every statement about data below describes what the code does today (the compliance inventory of
// 2026-10-12, re-checked against this tree): the cookie names and lifetimes (src/auth/session.ts, tx.ts,
// onboard.ts, oauth-routes.ts, return-to.ts, src/github-app/connect.ts), the OAuth scopes
// (src/auth/github.ts, src/auth/google.ts) and the GitHub App's read-only permissions
// (docs/architecture/github-app.md), the processors (Cloudflare, GitHub, Google, Anthropic, Stripe, Resend — no font
// or script CDN: the fonts and Mermaid are self-hosted), the retention rules (the sweeps in src/index.ts and
// src/repo/cron.ts, the soft deletes), deletion (docs/architecture/organizations.md §8, which this text
// follows), the e-mails (docs/architecture/notifications.md › Who gets what) and how a paid plan is billed,
// changed and ended (docs/architecture/billing.md; the numbers come from shared/plans.ts and
// shared/pricing.ts, never typed here). Who runs Trov and the consent sentence are shared/legal-core.ts.
// Change the code, change this page — and bump `updated`. This text is not legal advice: a lawyer should
// review it (the open questions are in the compliance pass's report and docs/architecture/web-ui.md).

import { esc } from "./ui";
import { trovMark } from "@shared/mark";
import { PLANS } from "@shared/plans";
import { PRICING, formatPrice } from "@shared/pricing";
import {
  AI_LEGAL_DRAFT, LEGAL_EMAIL, LEGAL_ENTITY, LEGAL_STATE, MIN_AGE, NOTICES_PATH, PRIVACY_PATH, REFUNDS_PATH, SOURCE_PATH, TERMS_PATH, TROV_SOURCE_REPO,
} from "@shared/legal-core";
import { ASK_AUTO_WRITES_MAX } from "@shared/ai-ask-core";
import { siteFooter, siteMark, skipLink } from "./site-chrome";

/** Who runs the service. */
export const LEGAL_OPERATOR = LEGAL_ENTITY;
/** Where questions and privacy, deletion and refund requests go — the same address Trov sends its mail from. */
export const LEGAL_CONTACT = LEGAL_EMAIL;

export type LegalKind = "terms" | "privacy" | "refunds";

export interface LegalSection {
  id: string;
  title: string;
  /** Authored HTML (trusted — it is this file's own text), one string per block. */
  body: string[];
}

export interface LegalDoc {
  kind: LegalKind;
  title: string;
  /** The tab's short name in the row over the title. */
  tab: string;
  /** ISO date the text last changed (its effective date). */
  updated: string;
  lede: string;
  /** "In short": a few plain lines, shown beside the contents. A summary, never a substitute for the text. */
  brief: string[];
  sections: LegalSection[];
}

const p = (html: string) => `<p>${html}</p>`;
const ul = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
/** A table in the docs' own frame (`.site-docs-table`), focusable so a keyboard can scroll it on a phone. */
const table = (label: string, head: string[], rows: string[][]) =>
  `<div class="site-docs-table" role="region" aria-label="${esc(label)}" tabindex="0"><table><thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
const mail = `<a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a>`;
const link = (href: string, text: string) => `<a href="${href}">${text}</a>`;
const code = (s: string) => `<code>${s}</code>`;
// The plan's own numbers, so these pages can never disagree with the pricing page.
const PRO = PLANS.team.name;
const PRO_PRICE = `${formatPrice(PRICING.team.price ?? 0)} ${PRICING.team.per}`;
const PRO_SEAT_PRICE = formatPrice(PRICING.team.price ?? 0);
const PRO_SEATS = PLANS.team.entitlements.seats;
const FREE = PLANS.free.name;
const FREE_SEATS = PLANS.free.entitlements.seats;

/** The effective date of all three documents (they were rewritten together). */
const EFFECTIVE = "2026-10-12";
/** Terms and Privacy: summaries moved from Google Gemini to Anthropic Claude, and automatic tagging (Sift, on a
 *  TypeSafe AI model) was added — both approved by the owner on 2026-10-14; the server-side AI build's passages
 *  (Ask Trov, the typed filter, notes, briefs and suggestions, the widened provider rows) approved on 2026-10-16. */
const PROVIDERS_UPDATED = "2026-10-16";

// APPROVED by Andres on 2026-10-16 (AI_LEGAL_DRAFT is false, so `${DRAFT}` renders nothing). Was: awaiting approval (#178 Phase G). Every passage below that starts with `${DRAFT}` is new text for
// the server-side AI build — Ask Trov, the plain-language filter, the AI pass's notes, briefs and suggestions, the
// weekly email's "This week", and the widened Anthropic and TypeSafe AI lists — and shows a visible "DRAFT —" so
// nothing reads as final. The approved passages (summaries, Sift) are unchanged. The marker is ONE flag,
// `AI_LEGAL_DRAFT` (shared/legal-core.ts), which ALSO holds Org settings › AI › "What is sent" (`AI_SENDS`,
// shared/ai-core.ts) to the approved lines (summaries, Sift): the screen repeats the Privacy rows' claims, so the
// two ship together (owner ruling, 2026-10-16 — "approve once, ship both", pinned in test/render.legal.test.ts).
// On approval: set `AI_LEGAL_DRAFT` to false — every marker below goes and the full "What is sent" list ships —
// and bump `updated` (PROVIDERS_UPDATED, and the date test/render.legal.test.ts pins). Dropping each `${DRAFT}`
// and this constant can follow as a cleanup; it changes nothing on the page. Ask Trov and the filter are written from the code (src/ai/ask/, src/ai/filter.ts,
// docs/architecture/ask.md); the pass's producers, Sift on new docs and the emails from the decided build
// (docs/superpowers/specs/2026-10-15-server-ai-build.md › Phases C–E) — re-check those against the merged code
// before the markers come off.
// Revised 2026-10-15 to the owner's rulings on the Phase G questions (trov-ai-master STATE.md › Owner rulings, Legal
// 1–6): Terms §10 is "AI features" (its id stays `ai`, so `/terms#ai` links still land); the AI switch covers PR and
// issue summaries (ai/summaries-switch, merged into #178 before this branch); Ask attachments go with the
// conversation and the account; "Only when something needs me" has its line (Phase E). The markers stay until the
// owner OKs this revised text.
// TypeSafe AI (owner, 2026-10-15): Jev comes straight from TypeSafe's console — "TypeSafe's flagship model". Per
// TypeSafe's privacy policy (typesafe.ai/legal/privacy-policy) its Services are hosted in the United States and it
// does not train or fine-tune models on Input; its DPA lists its subprocessors at trust.typesafe.ai/subprocessors,
// which Privacy › 4 links (DRAFT) instead of naming any itself.
// Revised 2026-10-16 to the owner's rulings on the open list (Legal #2–#4): Ask Trov's changes are cards to confirm
// UNLESS Auto is on (src/ai/ask/turn.ts, actions.ts: at most ASK_AUTO_WRITES_MAX per answer, only some with an Undo,
// update_plan / complete_sprint / publish_doc Confirm-only); Sift's own tags (FIT_APPLY, 0.85, src/tools/tag-fit.ts)
// are carved out of "suggestions"; the switch line was verified against the capture paths
// (test/summaries.switch.test.ts › every capture entry point). Still DRAFT: the owner is not approving; the lines
// get checked — and TypeSafe AI's hosting and no-training line (Privacy › 4) against TypeSafe's own terms.
const DRAFT = AI_LEGAL_DRAFT ? "<b>DRAFT —</b> " : "";

// ── Terms of Service ─────────────────────────────────────────────────────────

export const TERMS: LegalDoc = {
  kind: "terms",
  title: "Terms of Service",
  tab: "Terms",
  updated: PROVIDERS_UPDATED,
  lede: `These terms cover your use of Trov, the shared context store for teams and their coding agents, and are the agreement between you and ${LEGAL_OPERATOR}. You accept them when you create an account, and by using Trov.`,
  brief: [
    "Your content stays yours. We host and process it only to run Trov for you and your team.",
    "An agent you connect acts as you, and what it writes is recorded under your name.",
    `${FREE} costs nothing. ${PRO} is ${PRO_PRICE} plus tax, renews monthly until you cancel, and you can cancel any time from Billing.`,
    "Cancelling keeps Pro until the paid period ends; there are no refunds for partial periods, except where the law requires one.",
  ],
  sections: [
    {
      id: "about",
      title: "1. Who we are and these terms",
      body: [
        p(`Trov is run by <b>${LEGAL_OPERATOR}</b>, a ${LEGAL_STATE} corporation ("${LEGAL_OPERATOR}", "we", "us"). You can reach us at ${mail}.`),
        p(`These terms, the ${link(PRIVACY_PATH, "Privacy Policy")} and the ${link(REFUNDS_PATH, "Refund and Cancellation Policy")} are the whole agreement between you and us about Trov. When you create an account you are asked to confirm that you agree to them. If you use Trov for a company or a team, you confirm that you may accept them for it, and they bind it too.`),
      ],
    },
    {
      id: "service",
      title: "2. The service",
      body: [
        p("Trov stores a team's working memory — docs and their versions, decisions, a feed of what shipped, tickets, sprints and the roadmap, handoffs, prompts and artifacts — and lets people, and the coding agents they connect, read it and propose changes to it. Agents stage changes; a person confirms the consequential ones in the web app."),
        p(`Everything in Trov belongs to an organization. Anyone with an account can create one, or be invited to one. Each organization is on a plan — ${FREE}, ${PRO} or Enterprise — which sets how many people, repositories and other things it can hold. The plans and their limits are on the ${link("/pricing", "pricing page")}.`),
        p("Within an organization, owners and admins manage its members, settings and content, and an owner manages its plan and billing."),
      ],
    },
    {
      id: "accounts",
      title: "3. Eligibility and accounts",
      body: [
        p(`You must be at least ${MIN_AGE} years old to use Trov. You confirm this when you create an account; we do not verify it.`),
        p("You sign in with GitHub or Google. Give accurate information, keep the accounts you sign in with secure, and tell us promptly if you think someone else has used your Trov account or one of your agent connections. You are responsible for what happens under your account."),
      ],
    },
    {
      id: "agents",
      title: "4. Agents you connect",
      body: [
        p("An agent you connect to Trov (over its MCP server, by signing in in your browser or with a token) <b>acts as you</b>: it can read what you can read in the organizations you allow, and what it writes is recorded under your name, exactly as if you had written it. You are responsible for what it does with the connection."),
        p("Agents cannot approve, promote, reject or delete on anyone's behalf: those are a person's actions in the web app. Revoke a connection in Settings › MCP access as soon as you no longer trust it."),
      ],
    },
    {
      id: "plans",
      title: "5. Plans, payment and renewal",
      body: [
        p(`<b>${FREE}.</b> An organization on ${FREE} costs nothing and holds up to ${FREE_SEATS} people, within the limits on the pricing page. Each person can own one ${FREE} organization. We may change ${FREE}'s limits; an organization a change leaves over a limit keeps everything it has (section 6).`),
        p(`<b>${PRO}.</b> ${PRO} costs ${PRO_PRICE} — ${PRO_SEAT_PRICE} for each seat, each month — for up to ${PRO_SEATS} seats. A seat is a place for one member or one pending invitation. Prices are in US dollars and do not include tax: where tax applies, Stripe calculates it at checkout and shows it before you pay.`),
        p(`<b>Automatic renewal.</b> ${PRO} is a monthly subscription. You are charged when you subscribe, and then again each month on the same day of the month (the subscription's anniversary), for the seats you have then, <b>until you cancel</b>. By subscribing you authorize these recurring charges to the payment method you gave Stripe. Cancel any time from Billing (section 7).`),
        p("<b>Who pays.</b> The person who buys a plan is the organization's owner and its billing contact. Only an owner can change seats, update the payment method, see invoices or cancel. Members never pay and are never asked for a card."),
        p("<b>Seats.</b> An owner changes the number of seats on Stripe's billing page, opened from Billing; Stripe shows what the change costs, or credits to future invoices, before it is confirmed. If an organization has fewer seats than people, nobody is removed: adding people waits until there is room."),
        p("<b>Payment.</b> Payments are taken by Stripe; Trov never receives or stores your card number. If a payment fails, Stripe retries it and the organization keeps working; if the retries run out, the subscription ends and the organization moves to Free (section 6)."),
        p("<b>Price changes.</b> We may change a plan's price. A change to what you pay takes effect no sooner than your next billing period, and we will email the owner at least 30 days before it does; you can cancel before then."),
        p(`<b>Gifted plans.</b> We may give an organization a paid plan for a set time at no charge. When that time ends it moves to ${FREE} unless its owner subscribes. A gift has no cash value.`),
      ],
    },
    {
      id: "limits",
      title: "6. Limits, and when a paid plan ends",
      body: [
        p(`When an organization is over a limit — because a paid plan ended, its seats were lowered, or ${FREE}'s limits changed — <b>nothing is deleted</b> and nobody loses access. Everyone can still read everything; tickets, docs, the feed and existing agent connections carry on. Adding more of what is over the limit (a member, a repository, a connection, for example) is refused until the organization is back within it or subscribes again.`),
      ],
    },
    {
      id: "cancel",
      title: "7. Cancellation and refunds",
      body: [
        p(`An owner can cancel ${PRO} at any time, as easily as subscribing: Org settings › General › Plan › <b>Cancel plan</b> (Stripe's cancel page, which brings you back to Trov), or Manage billing. ${PRO} stays active until the end of the period already paid, and the organization then moves to ${FREE}.`),
        p(`<b>No refunds for partial periods</b>, except where the law requires one. Those, and any charge made by mistake, are handled by hand: write to ${mail}. Deleting an organization that pays for ${PRO} cancels its subscription at once, with no refund for the rest of the period. The full policy is the ${link(REFUNDS_PATH, "Refund and Cancellation Policy")}, which is part of these terms.`),
      ],
    },
    {
      id: "content",
      title: "8. Your content",
      body: [
        p("You keep every right you have in what you and your agents put into Trov (\"your content\"). You give us a limited, worldwide, non-exclusive licence to host, copy, process, index, display and transmit your content <b>only as needed to provide, secure and support Trov</b> for you and your team — for example to store and search it, show it to your team, send digest emails and generate summaries. The licence ends when your content is deleted, except for copies kept for a limited time as the Privacy Policy describes."),
        p("Content you add to an organization is visible to its other members and the agents they connect, and its owners and admins can manage it. Make sure you have the right to add what you add. Do not put secrets (passwords, API keys) or personal data you are not allowed to share into docs, tickets, prompts or artifacts."),
        p("Content Trov captures from a GitHub repository your organization connects (pull requests, issues, commits, reviews, CI results) stays subject to GitHub's terms and the repository's own permissions."),
      ],
    },
    {
      id: "use",
      title: "9. Acceptable use",
      body: [
        p("Don't use Trov to:"),
        ul(
          "break the law or infringe anyone's rights;",
          "upload malware, or artifacts designed to attack the people who open them;",
          "try to reach data, accounts or organizations you have not been given access to, or probe, scan or test the service's security without our written permission;",
          "overload the service, or get around its limits, sandboxes or access controls;",
          "send unwanted email through it, or harass people;",
          "store content about people that you have no right to hold.",
        ),
        p("We may remove content, or suspend an account or organization, that breaks these rules, and will tell you when we reasonably can."),
      ],
    },
    {
      id: "ai",
      // Owner ruling 2026-10-15 (Legal 2): renamed from "AI-generated summaries". The id stays `ai` (the anchor).
      title: "10. AI features",
      body: [
        p("Trov uses an AI model (Anthropic Claude) to summarize pull requests and issues when they are captured. Summaries can be wrong or incomplete: they are a convenience, not a record. Check the pull request or issue before relying on one."),
        p("If an admin of your organization turns on automatic tagging in Org settings › Tags, then whenever an admin adds a tag or asks Trov to find items for one, Trov's automatic tagging, Sift, uses a decision model from TypeSafe AI to judge which of the organization's existing feed entries, docs and decisions fit that tag, and adds the tag to each item it judges a fit with high confidence (85% or more); an item it is less sure about (60% to 85%) is only suggested, for a person in the organization to add or dismiss. No person reviews a tag Sift adds on its own before it is added, and a judgement can be wrong. It only ever adds that one tag; it never removes or changes anything else. An admin can undo a run, which takes the tag off exactly the items that run tagged, and anyone can take a tag off an item; Trov does not add it to that item again. An admin can turn it off at any time, and nothing is sent while it is off."),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — Sift on new docs (Phase C, `tag.fit` in the pass).
        p(`${DRAFT}While both switches are on, Sift also checks each doc against the organization's tags when the doc is approved, by the same rules.`),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — Ask Trov (src/ai/ask/, docs/architecture/ask.md).
        p(`${DRAFT}<b>Ask Trov.</b> Ask Trov answers a person's questions about their organization, using Anthropic Claude (Claude Haiku, Sonnet or Opus, by the mode the person picks where their plan offers a choice). It reads only what that person can see in that organization. It never reads secrets, integrations, billing, other organizations or other people's private items, nor source code unless the person attaches a file of it, and it does not browse the web. Its answers can be wrong or incomplete: check the items it cites before relying on one. It acts as the person who asks, and what it changes is recorded under their name. A change it proposes is a card the person confirms or cancels, unless they turn on Auto for the conversation (an admin can turn Auto off for the organization). In Auto, up to ${ASK_AUTO_WRITES_MAX} changes in each answer run at once, with no card to confirm first, and some of them can be undone from the conversation; changing the roadmap plan, completing a sprint and publishing a doc still wait for the person to confirm. It never publishes a doc unless the person confirms it. It cannot reject or delete anything: undoing a change only takes back what that change did, so undoing a sprint it created removes that sprint while it is still empty. Each question counts against the organization's monthly allowance for Ask Trov.`),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — the plain-language filter (src/ai/filter.ts) and the AI
        // pass's producers (Phases C–D: session notes, repo state, the brief, themes, sprint notes and plan drift,
        // the weekly recap, doc drift; Jev's cards and gates).
        p(`${DRAFT}<b>Notes, briefs and suggestions.</b> When a person types a filter in plain words on Tickets, the Feed or Artifacts, Trov uses Anthropic Claude to set the screen's own filters from it. While an organization's AI switch is on, Trov also uses Anthropic Claude to write short texts from what the organization already holds in Trov: a note on what a burst of work in a connected repository shipped, where a repository stands, each person's brief (on My Work, for the agents they connect, and in their email), the themes of the work merged, notes on sprints and on drift from the plan, the weekly email's "This week" highlights, and changes to a doc that seems out of date. It uses a decision model from TypeSafe AI to sort and check items: a ticket's category and priority, a likely duplicate, how much a change matters, what a proposal changes, where an unplaced item belongs, which theme a pull request is part of, and whether something is worth writing about at all. These can be wrong: they are a convenience, not a record. They are shown as written by Trov, or as suggestions a person accepts or dismisses — except a tag Sift judges a fit with 85% confidence or more, which, where an admin has turned Sift on, is added to the item at once, with no person reviewing it first, as described above; anyone in the organization can take it off. Apart from adding those tags, none of them approves, promotes, rejects, resolves or closes anything, and a doc change Trov writes is staged for a person to approve, like an agent's.`),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — the org switch (orgs.ai_automation) covers every feature
        // in this section, PR and issue summaries included (owner ruling, Legal 1; ai/summaries-switch: off = no call,
        // no new summary row, and a summary already written is kept as it is — docs/architecture/ai.md).
        p(`${DRAFT}An admin can turn the organization's AI switch off at any time. While it is off, nothing is sent to Anthropic or TypeSafe AI for any feature in this section, the summaries of pull requests and issues included. Summaries already written stay readable.`),
      ],
    },
    {
      id: "third-parties",
      title: "11. Third-party services",
      body: [
        p("Trov depends on other services: GitHub and Google for sign-in, GitHub for repository data, Cloudflare for hosting, Stripe for payments, Anthropic Claude for summaries, TypeSafe AI for automatic tagging where an organization turns it on, and Resend for email. An organization can also connect Railway, Cloudflare Analytics and its own metrics endpoint, with tokens its admins provide. The agent clients you connect (Claude Code, Cursor and others) are yours, not ours. Each of these is governed by its own terms, and its availability is outside our control."),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — the widened provider list.
        p(`${DRAFT}Anthropic Claude also answers Ask Trov and writes Trov's other AI features, and TypeSafe AI also sorts and checks items for them, while an organization's AI switch is on (section 10, AI features).`),
      ],
    },
    {
      id: "ending",
      title: "12. Deleting your account, and ending your use",
      body: [
        p(`You can stop using Trov at any time. You can delete your account yourself in Settings › Delete account, and an owner can delete an organization in Org settings › General; you can also ask us to delete either by writing to ${mail}. What is deleted, what is kept and why is in the ${link(`${PRIVACY_PATH}#deletion`, "Privacy Policy")}. If you pay for an organization that others keep using, cancel its plan first (section 7).`),
        p("We may suspend or end your access, or an organization's, if you break these terms, if the law requires it, or to protect the service or other people. Where we reasonably can, we will tell you first and give you a chance to export your content. If we stop offering Trov, or end your access for a reason other than a breach of these terms, we will refund the unused part of a period already paid."),
        p("Sections 8, 13, 14, 15 and 16 survive the end of your use."),
      ],
    },
    {
      id: "open-source",
      title: "13. Open source",
      body: [
        p(`Trov's source code is published under the GNU Affero General Public License v3.0. You can get the source of the version this service runs at ${link(SOURCE_PATH, `trov.dev${SOURCE_PATH}`)} (the repository is ${link(TROV_SOURCE_REPO, "AndresL230/trov on GitHub")}), and the licences of the third-party software and fonts it includes are in the ${link(NOTICES_PATH, "third-party notices")}. The AGPL governs the code; these terms govern your use of this hosted service, and nothing in them limits the rights the AGPL gives you.`),
      ],
    },
    {
      id: "disclaimer",
      title: "14. Disclaimers",
      body: [
        p("We work to keep Trov running and your content safe, but the service may change, be interrupted, or lose data: keep your own copies of anything you cannot afford to lose. We may add, change or remove features; if we remove something a paid plan depends on, the owner can cancel, and section 7 applies."),
        p("To the fullest extent the law allows, Trov is provided <b>\"as is\" and \"as available\"</b>, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose and non-infringement."),
      ],
    },
    {
      id: "liability",
      title: "15. Limitation of liability",
      body: [
        p(`To the fullest extent the law allows, ${LEGAL_OPERATOR} is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or goodwill, arising from your use of Trov; and our total liability for any claim about the service is limited to what your organization paid us for Trov in the 12 months before the claim arose. Nothing in these terms limits liability that the law does not allow to be limited, or takes away rights you have as a consumer that cannot be waived.`),
      ],
    },
    {
      id: "law",
      title: "16. Governing law",
      body: [
        p(`These terms are governed by the laws of the State of ${LEGAL_STATE}, United States, without regard to its conflict-of-law rules, and disputes about them are for the state and federal courts located in ${LEGAL_STATE}. If you are a consumer, you also keep the protection of the mandatory laws of the country where you live, and may bring a claim in its courts.`),
      ],
    },
    {
      id: "changes",
      title: "17. Changes to these terms",
      body: [
        p("We may update these terms. The date at the top says when they last changed. Before a material change takes effect we will tell you in the app or by email; if you keep using Trov after it does, you accept the new terms. If you do not agree, stop using Trov and, if you pay, cancel."),
      ],
    },
    {
      id: "contact",
      title: "18. Contact",
      body: [p(`${LEGAL_OPERATOR}, ${LEGAL_STATE}, United States. Questions about these terms: ${mail}.`)],
    },
  ],
};

// ── Privacy Policy ───────────────────────────────────────────────────────────

const COOKIES: string[][] = [
  [code("session"), "Keeps you signed in. Holds a sealed random id that points at your session.", "30 days"],
  [code("oauth_tx"), "Carries a GitHub or Google sign-in while it happens (its state and PKCE check).", "10 minutes"],
  [code("onboard"), "Holds what GitHub or Google told us about you until you choose your handle.", "10 minutes"],
  [code("oauth_pending"), "Remembers an agent's connection request while you sign in.", "10 minutes"],
  [code("return_to"), "Remembers a purchase you started while you sign in.", "10 minutes"],
  [code("gh_install"), "Carries an admin's \"Connect with GitHub\" to GitHub and back (sent only to <code>/auth</code>).", "15 minutes"],
];

const STORAGE: string[][] = [
  [`${code("trov.theme")}, ${code("trov.collapsed")}, ${code("trov.navOpen")}, ${code("trov.feedView")}, ${code("trov.promptView")}`, "Local storage", "Your theme, how you left the sidebar, the feed and the prompt library."],
  // DRAFT: awaiting Andres's approval (#178 Phase G) — `AI_NOTE_KEY` (web/src/ai-ui.ts): the handles that pressed
  // "Got it" on the Feed's note, on this browser.
  [`${DRAFT}${code("trov.aiFeedNote")}`, "Local storage", "The handles of the people who dismissed the Feed's note about entries written by Trov on this browser."],
  [code("trov.org"), "Local storage", "The organization you last opened, so Trov opens it next time."],
  [`${code("trov.returnHash")}, ${code("trov.returnOrg")}, ${code("trov.welcomeReturn")}, ${code("trov:first-run")}`, "Session storage (gone when you close the tab)", "Where to bring you back after signing in or connecting GitHub, and the setup's step counter."],
];

const RETENTION: string[][] = [
  ["Your account and profile", "Until you delete your account."],
  ["Sign-in sessions", "Each expires after 30 days. Signing out deletes that browser's session; an expired one is kept until your account is deleted."],
  ["Agent connections", "Browser sign-in tokens expire after an hour and are renewed while in use; expired tokens and unused sign-in codes are deleted automatically. A connection you revoke, and a revoked pasted token (stored only as a hash), stay on record, marked revoked, until your account is deleted."],
  ["Content in an organization", "Until the organization deletes it, or is deleted. Deleting a ticket or sprint removes it; rejecting a doc or decision, discarding from triage and deleting a prompt or artifact hide it but keep it so it can be restored."],
  ["Uploaded files, images and photos", "Until nothing in Trov refers to them any more: deleting an organization or an account removes the files only it used."],
  ["Repository activity", "Pull requests, issues, their summaries and mirrored tickets: for the life of the organization. Check results and health checks: 45 days. Hourly usage figures: 7 to 100 days. Sync runs: 90 days."],
  // DRAFT: awaiting Andres's approval (#178 Phase G) — Ask Trov (src/data/ask.ts deleteThread, src/deletion/person.ts;
  // ai_feedback.handle is in HANDLE_COLUMNS) and the AI pass's computed rows (Phase D: the last 5 briefs, 20 repo
  // states, 10 insights per key — the spec's numbers, to re-check). Attachments per the owner's ruling (Legal 4,
  // being built on ai/ask-backend-rulings): deleting a conversation deletes its attachments except a file a ticket or
  // doc still refers to; deleting the account deletes the person's private Ask attachments.
  [`${DRAFT}Ask Trov conversations, the files attached in them, and what you told it about how to answer you`, "Until you delete the conversation or your account, or the organization is deleted. Deleting a conversation also deletes the files attached in it, except a file a ticket or doc still refers to or one you published to the organization. Deleting your account deletes the files you attached in Ask Trov and did not publish."],
  [`${DRAFT}"Wrong?" reports on what Trov's AI wrote`, "Until the organization is deleted. If you delete your account, they stay credited to \"Deleted user\"."],
  [`${DRAFT}What Trov's AI writes (briefs, notes, repository state, themes, highlights, suggestions)`, "While the organization exists; only the latest few versions of each are kept."],
  ["Usage counts (per person, per day)", "400 days."],
  ["Rate-limit counters (including the hashed address of a signed-out Contact form)", "2 days."],
  ["Invitations and an organization's admin history", "Until the organization is deleted. A short record of each deletion is kept indefinitely."],
  ["Records of a plan given or sold to someone (with the address it was for)", "Kept; removed with the organization made from it, or when the person deletes their account before using it."],
  ["Bug reports and support messages", "Until you delete your account, or the organization you sent them from is deleted."],
  ["Email send log (who was sent which digest, and whether it was delivered)", "Until your account or the organization is deleted. The emails themselves are not stored."],
  ["Billing records in Trov", "While the organization exists. Stripe's notification ids: 90 days."],
  ["Billing records at Stripe", "As long as Stripe keeps them for tax and accounting law."],
  ["Server logs at Cloudflare", "A few days, under Cloudflare's log retention."],
  ["Database history at Cloudflare", "Up to 30 days of point-in-time history, which can bring back deleted data until it ages out."],
];

export const PRIVACY: LegalDoc = {
  kind: "privacy",
  title: "Privacy Policy",
  tab: "Privacy",
  updated: PROVIDERS_UPDATED,
  lede: `This policy explains what Trov collects, why, who processes it, how long it is kept and what you can ask for. Trov is run by ${LEGAL_OPERATOR}, which is responsible for the personal data described here.`,
  brief: [
    "We don't sell personal data, show ads, or use analytics or tracking cookies.",
    "What you add to an organization is visible to its members and the agents they connect. Trov's operators see names, members and usage, and step in only for support, security or legal reasons.",
    "Card details go to Stripe and never reach Trov.",
    "You can delete your account in Settings, and ask us for a copy of your data or anything else at hello@trov.dev.",
  ],
  sections: [
    {
      id: "who",
      title: "1. Who we are",
      body: [
        p(`Trov is a service of ${LEGAL_OPERATOR}, a ${LEGAL_STATE} corporation in the United States. For the personal data in this policy, ${LEGAL_OPERATOR} is responsible ("controller"). Questions and requests: ${mail}.`),
      ],
    },
    {
      id: "collect",
      title: "2. What we collect",
      body: [
        p("<b>Your account.</b> When you sign in with GitHub (through Trov's GitHub App), Trov reads your GitHub username, display name, profile picture, GitHub account id and your primary, verified email address, and nothing else. With Google we receive your Google account id, name, picture and verified email address (<code>openid email profile</code>). We use the provider's access token only during sign-in and do not store it. You choose a handle, a display name and a color; you may upload a photo and change the address digests go to."),
        p("<b>What your organization records about you.</b> Your role (owner, admin, member), and optionally a title and a note on what you are responsible for, set by an admin. Your title is shown to your team; the responsibilities note is readable by the organization's admins and by the agents its members connect, which use it to assign work."),
        p("<b>What you and your agents write.</b> Docs and their versions, decisions, feed entries, tickets and comments, sprints and the roadmap, handoffs, prompts, artifacts and the files and images you upload — with who wrote each one and when."),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — Ask Trov's rows (0066_ask: chat_threads / chat_messages,
        // person_ask_settings, ai_feedback, ask_flags — the reason only, no handle).
        p(`${DRAFT}<b>Ask Trov.</b> The questions you ask and its answers, the files you attach (kept as your private artifacts), what you tell it about how to answer you, and the "Wrong?" reports you send. Your conversations are visible only to you. When you report that an item an answer cited is wrong or out of date, people in the organization see the report on that item in Review, as a reason only, without your name or the conversation.`),
        p("<b>Connected repository data.</b> When an admin connects a GitHub repository, Trov's GitHub App reads it with read-only permissions (metadata, contents, pull requests, issues, Actions, checks, deployments and commit statuses) and captures pull requests and issues (titles and descriptions), pushes, reviews, deployments and CI results, including the GitHub usernames of the people involved — also people who never signed in to Trov, such as outside contributors. It does not store commit authors' email addresses. The repository owner's GitHub picture becomes the organization's image. While connecting, Trov uses a short-lived GitHub token to list the installations you can reach, then revokes it."),
        p("<b>Integrations an organization adds.</b> Tokens for Railway, Cloudflare Analytics or its own metrics endpoint, stored encrypted and used only to read figures (requests, errors, CPU, memory, active users) from those services; and the website addresses it asks Trov to health-check."),
        p("<b>Agent connections.</b> The app's name and return address, the organizations it may use, and when it was created and last used. Tokens are stored only as one-way hashes."),
        p("<b>Billing.</b> When an owner buys a plan, Stripe collects the payment details, billing address and any tax id on its own page. We send Stripe the buyer's verified email address, their handle and, for an upgrade, the organization's address, and keep what Stripe sends back: the Stripe customer and subscription ids, the plan, its status, the number of seats, the current period's end, and whether it is set to cancel."),
        p("<b>Bug reports and support messages.</b> What you write, with the screen you were on, your organization, the app version and your browser's user agent; signed out (the Contact form), the page, your browser and the email address you type, which we use only to reply. No screenshot, page content or IP address is stored with a report."),
        p("<b>Email.</b> Your email preferences, whether you unsubscribed, and a log of the digests sent to you (when, which, and whether delivery worked)."),
        p("<b>Usage and security.</b> Counts of what each person does in an organization each day (reads, writes, agent requests by tool), which Trov's operators see as totals, to understand how Trov is used; rate-limit counters, which for the signed-out Contact form use a keyed hash of your IP address, never the address itself."),
        p("<b>Technical data.</b> Our host, Cloudflare, processes your IP address and request details to serve and protect Trov. Its logs keep the addresses Trov was asked for (which can contain a handle or an organization's address) and Trov's own log lines, which are scrubbed of secrets."),
      ],
    },
    {
      id: "use",
      title: "3. How we use it, and why we may",
      body: [
        ul(
          "to sign you in, keep you signed in and keep accounts secure;",
          "to provide Trov — store, search, show and attribute your team's content, and let connected agents read and propose changes as you;",
          "to take payment for a paid plan, keep an organization on the plan it paid for, and apply each plan's limits;",
          "to summarize captured pull requests and issues;",
          // DRAFT: awaiting Andres's approval (#178 Phase G) — Ask Trov, the filter, the AI pass.
          `${DRAFT}where an organization's AI switch is on, to answer the questions a person asks Ask Trov, to set a screen's filters from words a person types, to write notes, briefs, the weekly email's highlights and suggestions from the organization's own content, and to sort and check its items (${link(`${TERMS_PATH}#ai`, "Terms, section 10, AI features")});`,
          "where an admin of an organization turns it on, to add one of the organization's tags to its feed entries, docs and decisions that Sift, using a TypeSafe AI model, judges fit it (or to suggest it, for a person to decide, where Sift is less sure), when an admin adds that tag or asks for it;",
          "to send the emails described in section 7;",
          "to answer support messages, and to run, debug and protect the service.",
        ),
        p("We do this because it is necessary to provide the service you signed up for and to carry out a purchase (contract); for our legitimate interest in keeping Trov secure, working and supported; and to meet legal duties such as keeping tax records. We do not use your content to train AI models, and we do not use it for advertising."),
      ],
    },
    {
      id: "sharing",
      title: "4. Who can see it, and who processes it",
      body: [
        p("<b>Your team.</b> What you add to an organization is visible to its members and the agents they connect; an artifact you keep private is visible only to you. Owners and admins manage content and members. Members can see the organization's plan and limits; only owners open its invoices and payment details, which Stripe shows."),
        p("<b>Trov's operators.</b> The people at TrovLabs who run Trov can see each organization's name, address, plan and status, its members' names, handles, roles and titles, pending invitations, usage counts and sizes, its admin history, and the support messages people send. Their tools do not show an organization's content. They can act on an account or organization — for example add themselves as an owner, suspend it or delete it — and may access stored data, only for support, security or legal reasons. Adding themselves to an organization is recorded in its history."),
        p("<b>Service providers</b> that process data for us, to run Trov:"),
        table("Service providers", ["Provider", "What it does", "What it receives"], [
          ["Cloudflare", "Hosting, the database, file storage, logs", "Every request (with your IP address) and everything stored in Trov"],
          ["GitHub", "Sign-in; the repository data an organization connects", "Your sign-in; Trov's read-only requests for the connected repositories"],
          ["Google", "Sign-in", "Your sign-in"],
          ["Anthropic", "Summaries (Claude API)", "The title and description (up to 8,000 characters) of each captured pull request and issue"],
          // DRAFT: awaiting Andres's approval (#178 Phase G) — the widened Anthropic list: Ask Trov (src/ai/ask/prompt.ts
          // contextBlock, turn.ts, history.ts compaction, attachments.ts), the filter (src/ai/filter.ts), the AI pass.
          ["Anthropic", `${DRAFT}Ask Trov (Claude API), when a person asks`, "The question; the conversation so far (a long one partly as a summary of its older turns); the person's handle and role, the organization's name, the date, and what the person said about how to answer them; the items Ask Trov reads from the organization to answer, only ones that person can see; and the files they attach, whole in the turn they are attached and again only when an answer reads one"],
          ["Anthropic", `${DRAFT}Filters typed in plain words (Claude API), when a person asks`, "What the person typed, and the organization's members' handles and names, with its sprints' titles or its tags"],
          ["Anthropic", `${DRAFT}Notes, briefs, the weekly email's highlights and suggestions (Claude API), while the organization's AI switch is on`, "The organization's name, tags, active themes and sprints, and its plan; and, for what is being written, the summaries Trov already made of pull requests and issues, commit messages and pull request titles, check and deploy results, tickets, handoffs and feed entries, the people they concern (by handle), and a doc with the entries that may disagree with it"],
          ["TypeSafe AI", "Automatic tagging (Sift), where an organization turns it on", "The tag's name and description and, for each of the organization's feed entries, docs and decisions that may fit it, its title and up to 400 characters of its text, with code and anything that looks like a password or key removed"],
          // DRAFT: awaiting Andres's approval (#178 Phase G) — the widened TypeSafe AI list (Phase C's cards and gates).
          // TypeSafe AI's own model (never named on a public page: it is Sift there); its subprocessors are its own
          // list, linked under the table (DRAFT).
          ["TypeSafe AI", `${DRAFT}Sorting and checking items, while the organization's AI switch is on`, "One item at a time — a ticket, feed entry, pull request summary, doc proposal or unplaced item — as its title and a short excerpt, with code and anything that looks like a password or key removed, and the choices it is judged against (categories, priorities, a few possible duplicates, sections or docs, themes); and, to decide whether something is worth writing about, commit messages and pull request titles, what changed in a repository, and a doc with the entries that may disagree with it"],
          ["Stripe", "Payments, invoices and receipts, fraud checks, tax calculation", "The buyer's email, handle, payment details and billing address, and the organization's address for an upgrade"],
          ["Resend", "Delivers Trov's email", "Each email's recipient, subject and body (a digest contains your organization's content: ticket titles, summaries)"],
        ]),
        // DRAFT: awaiting Andres's approval — TypeSafe AI's own model, where it is hosted, no training, its subprocessors.
        p(`${DRAFT}The model that sorts and checks items is TypeSafe AI's own, on services hosted in the United States, and TypeSafe AI does not train or fine-tune any model on what Trov sends it. TypeSafe AI's own subprocessors are listed at ${link("https://trust.typesafe.ai/subprocessors", "trust.typesafe.ai/subprocessors")}.`),
        p("Anthropic handles the text sent for summaries under Anthropic's Commercial Terms of Service, which apply to Trov's API account. Railway, Cloudflare Analytics and an organization's own endpoint receive only Trov's requests with the token its admins saved, and send back figures. The agent clients you connect (Claude Code, Cursor and others) receive what they read on your behalf; they are your tools, under their own terms, not our processors."),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — one platform key (ANTHROPIC_API_KEY) for every Anthropic
        // call; what is never sent is AI_NEVER_SENT (shared/ai-core.ts), which says "unless you attach a file to Ask"
        // (owner ruling, Legal 3) — keep the two in step.
        p(`${DRAFT}Everything else Trov sends Anthropic, for Ask Trov and the features in section 3, goes through the same API account, under the same terms. Neither Anthropic nor TypeSafe AI is sent a connected repository's source code or diffs, secrets, integration keys, or anything from another organization. Source code reaches Anthropic only when you attach a file of it to a question in Ask Trov, and the file is sent as it is.`),
        p("We may also disclose data if the law requires it, or to protect the rights and safety of people and the service. If TrovLabs is part of a merger or acquisition, personal data may pass to the new owner under this policy. <b>We do not sell or rent personal data</b>, and we do not share it for advertising."),
      ],
    },
    {
      id: "browser",
      title: "5. What your browser loads from others",
      body: [
        p("Trov's pages, typefaces and diagram renderer are all served from trov.dev, so opening the site or the app sends nothing to Google Fonts or a script CDN. A few things do load from elsewhere, and send your IP address to whoever serves them:"),
        ul(
          "<b>Profile pictures</b> from GitHub or Google, unless the person uploaded a photo to Trov: they load from GitHub's and Google's servers wherever that person is shown.",
          "<b>Images a doc links from another website</b> load from that website.",
          "<b>HTML artifacts</b> a team uploads run in a sandbox, cut off from your session, and may load scripts from the cdnjs and jsDelivr code CDNs, and styles and fonts from Google Fonts, if their author used them.",
          "<b>Payment</b> happens on Stripe's own page, under Stripe's privacy policy. When Trov shows Stripe's payment form on its own payment page instead, Stripe's script (Stripe.js) runs on that page, and only there, and sets Stripe's own cookies, including ones Stripe uses to prevent fraud.",
        ),
      ],
    },
    {
      id: "cookies",
      title: "6. Cookies and browser storage",
      body: [
        p("Trov sets only the cookies it needs to work. They are first-party, sealed, sent only over HTTPS and not readable by scripts. There are no analytics, advertising or tracking cookies, so there is nothing to ask your consent for and no cookie banner. The one other party that sets cookies is Stripe, on its own pages and on Trov's payment page when that shows Stripe's form, to take the payment and prevent fraud (section 5)."),
        table("Cookies", ["Cookie", "What it is for", "Lasts"], COOKIES),
        p("Your browser's storage keeps only preferences and where to bring you back after signing in. It never leaves your device:"),
        table("Browser storage", ["Key", "Where", "What it holds"], STORAGE),
      ],
    },
    {
      id: "email",
      title: "7. Email",
      body: [
        p("Trov sends no marketing email. What it sends:"),
        ul(
          "<b>Digests</b>, on by default: a daily one on weekdays and a weekly one on Mondays, at your organization's send hour, and only when there is something for you. Change or stop them in Settings › Email notifications.",
          "<b>A welcome email</b> when you first join an organization.",
          "<b>One-off emails that answer something someone did</b>: an invitation, word that an organization you were given or paid for is ready (with your plan's renewal and cancellation terms), and a test digest you send yourself.",
          "<b>Stripe's own receipts and invoices</b>, sent by Stripe.",
        ),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — Phase E's emails: the brief leads (the stored brief, or
        // the assigned items with AI off) and the weekly recap (one Haiku call per org per week, shared by members).
        p(`${DRAFT}A digest leads with your brief, the same one My Work shows: while your organization's AI switch is on, Trov writes it with Anthropic Claude; while it is off, the digest lists your assigned items instead. While the switch is on, the weekly digest also has "This week": up to 3 highlights of the organization's week, written by Anthropic Claude once a week for the whole organization and the same for every member who gets it.`),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — "Only when something needs me" (owner ruling, Legal 5: a
        // line only if it uses AI to decide). It does: Phase E's `needsMe` (ai/phase-e-emails,
        // src/notifications/renderers/my-work.ts; 0067 notification_person_prefs) sends only when the stored brief
        // (Claude, `brief.person`) has a Next item or Sift's importance (Jev, `feed.importance`, 0060) rated something
        // notable or breaking that touched the person's work; with no brief, assigned tickets stand in. It reads
        // stored results and calls no model; the stored ratings count even while the switch is off (confirmed by the
        // coordinator against ai/phase-e-emails 23e72f4e). Ship this line with Phase E, not before.
        p(`${DRAFT}If you choose "Only when something needs me" in Settings › Email notifications, Trov sends you a digest only when your brief has something next for you, or when something Sift rated notable or breaking touched your work. Both are judgements Trov's AI made earlier, so the AI decides whether that email is sent; deciding sends nothing more to Anthropic or TypeSafe AI. When there is no brief, for example while your organization's AI switch is off, a ticket assigned to you counts instead, and the ratings Sift made earlier still count, so whether that email is sent can still depend on them.`),
        p("Every digest and welcome email has an Unsubscribe link at the bottom that works without signing in, a one-click unsubscribe your mail app can use, and a switch in Settings. Unsubscribing stops digests and the welcome email from every organization; the one-off emails above still arrive, because each answers something someone did. An unsubscribe link names your handle and does not expire."),
        p("Our emails load nothing remote — no web fonts, images or scripts. They are delivered by Resend, which receives the recipient, the subject and the body. We keep a log of the digests sent (not their text)."),
      ],
    },
    {
      id: "retention",
      title: "8. How long we keep it",
      body: [
        table("How long data is kept", ["Data", "How long"], RETENTION),
      ],
    },
    {
      id: "deletion",
      title: "9. Deleting your account or an organization",
      body: [
        p(`You can delete your account in <b>Settings › Delete account</b>, and an owner can delete an organization in <b>Org settings › General › Delete organization</b>. You can also ask us at ${mail}, and our operators can delete accounts and organizations too. Deletion is immediate and cannot be undone.`),
        p("<b>Deleting an organization</b> removes everything in it: its content and every version, what was captured from GitHub, its settings, credentials and integrations, its members' memberships and agent connections to it, its email settings and send log, its usage counts, admin history and support messages, its billing records, and the files only it used. A paid subscription is cancelled at Stripe first, with no refund for the rest of the period."),
        p("<b>Deleting your account</b> removes your profile, photo, sign-ins, sessions, agent connections and tokens, email settings and send log, memberships, support messages, and any organization nobody else is in. If you are the only owner of an organization others are in, or pay for one that carries on, Trov asks you to hand it over, cancel or delete it first."),
        // DRAFT: awaiting Andres's approval (#178 Phase G) — src/deletion/person.ts deletes chat_* and
        // person_ask_settings; the person's private Ask attachments go too (owner ruling, Legal 4; being built on
        // ai/ask-backend-rulings — until it ships, docs/architecture/ask.md › Deletion and renames keeps them).
        p(`${DRAFT}It also removes your Ask Trov conversations, the files you attached in Ask Trov and did not publish to the organization, and what you told it about how to answer you.`),
        p("<b>What is kept, and why:</b>"),
        ul(
          "What you wrote in organizations that carry on — docs, tickets, comments, history — stays for the people you worked with, credited to \"Deleted user\" (a placeholder with no personal data) instead of your handle. Text other people typed that mentions you is not rewritten.",
          "Your GitHub username in repository activity Trov captured, because it is a copy of that repository's history on GitHub.",
          "One record of each deletion: who asked, when, and for an organization its address, member count and Stripe ids (for billing disputes). For an account it holds a one-way code, not your handle.",
          "Stripe keeps its records of payments and invoices for tax and accounting law; Resend keeps its delivery logs; Anthropic, and Google for summaries made before October 14, 2026, may have the text sent earlier for summaries — each under its own terms.",
          // DRAFT: awaiting Andres's approval (#178 Phase G) — the widened provider list.
          `${DRAFT}Anthropic and TypeSafe AI may have the text sent earlier for Ask Trov and Trov's other AI features, each under its own terms.`,
          "Cloudflare's database history (up to 30 days) and logs (a few days) keep deleted data until they age out.",
        ),
      ],
    },
    {
      id: "rights",
      title: "10. Your rights and choices",
      body: [
        p("In Trov you can change your name, handle, color, photo and email address in Settings, unlink a sign-in method, revoke agent connections, stop email, and delete your account. An organization's owner can update its payment method, download invoices and cancel its plan."),
        p(`Depending on where you live, you may have the right to <b>access</b> your personal data and get a <b>copy</b> of it (in a portable format), to <b>correct</b> it, to have it <b>deleted</b>, and to <b>restrict</b> or <b>object</b> to how we use it — under the GDPR and UK GDPR, for example, and under US state privacy laws such as California's. To use any of them, write to ${mail} from the address on your account (or tell us how to confirm it is you). We will answer within 30 days, and will not treat you differently for asking. If we decline a request, we will say why, and you can ask us to reconsider. You can also complain to your local data protection authority.`),
        p("We do not sell personal data or share it for targeted advertising, and we do not use it to make decisions about you that have legal or similar effects."),
      ],
    },
    {
      id: "transfers",
      title: "11. International transfers",
      body: [
        p("Trov is run from the United States and hosted on Cloudflare's network, and our providers process data mostly in the United States. If you use Trov from elsewhere, your data is transferred there. Where the law requires it, those transfers rely on the safeguards our providers offer, such as the European Commission's Standard Contractual Clauses."),
      ],
    },
    {
      id: "children",
      title: "12. Children",
      body: [p(`Trov is a tool for working teams and is not for anyone under ${MIN_AGE}. Everyone confirms they are ${MIN_AGE} or older when they sign up. If you believe someone younger has given us personal data, write to ${mail} and we will delete it.`)],
    },
    {
      id: "security",
      title: "13. Security",
      body: [
        p("What we do: sign-in goes through GitHub or Google; session cookies are sealed, HTTP-only and secure; agent tokens are stored only as hashes; integration credentials are stored encrypted and never shown again; GitHub and Stripe notifications are signature-checked; artifact pages run in a sandbox cut off from your session; card data never touches Trov's servers; traffic is encrypted in transit; and secrets are scrubbed from our logs."),
        p(`No system is perfectly secure, and we cannot promise that data will never be accessed without permission. If something happens that puts your personal data at risk, we will tell you as the law requires. If you find a vulnerability, please report it privately to ${mail}.`),
      ],
    },
    {
      id: "changes",
      title: "14. Changes to this policy",
      body: [
        p("If we change how we handle personal data we will update this page and its date, and tell you in the app or by email before a material change takes effect."),
      ],
    },
    {
      id: "contact",
      title: "15. Contact",
      body: [p(`${LEGAL_OPERATOR}, ${LEGAL_STATE}, United States. Privacy questions and requests: ${mail}.`)],
    },
  ],
};

// ── Refund and Cancellation Policy ──────────────────────────────────────────

export const REFUNDS: LegalDoc = {
  kind: "refunds",
  title: "Refund and Cancellation Policy",
  tab: "Refunds",
  updated: EFFECTIVE,
  lede: `This policy explains how to cancel a paid Trov plan, what happens when you do, and when a payment is refunded. It is part of the Terms of Service.`,
  brief: [
    "Cancel any time from Billing, as easily as you subscribed.",
    `${PRO} stays active until the end of the period you already paid for, then the organization moves to ${FREE}. Nothing is deleted.`,
    "No refunds for partial periods, except where the law requires one: write to us.",
    "Deleting an organization that pays for Pro cancels it at once, with no refund.",
  ],
  sections: [
    {
      id: "billing",
      title: "1. How a paid plan is billed",
      body: [
        p(`${FREE} is never charged. ${PRO} costs ${PRO_PRICE} (for example, 3 seats × ${PRO_SEAT_PRICE} = ${formatPrice((PRICING.team.price ?? 0) * 3)} a month), plus any tax Stripe calculates at checkout. It is charged when you subscribe and then automatically each month, on the day of the month you subscribed, until you cancel. Payments are taken by Stripe.`),
      ],
    },
    {
      id: "cancel",
      title: "2. How to cancel",
      body: [
        p(`An owner of the organization cancels in Trov: <b>Org settings › General › Plan › Cancel plan</b>. It opens Stripe's cancel page and brings you back to Trov when you are done. <b>Manage billing</b>, in the same place, also lets you cancel. Nothing else is needed — no call, no email. If you cannot get to it, write to ${mail} and we will cancel for you.`),
      ],
    },
    {
      id: "after",
      title: "3. What happens when you cancel",
      body: [
        p(`${PRO} stays active until the end of the period already paid, and nothing changes until then; Trov shows the date in Org settings › General › Plan. Until that date you can undo the cancellation in Manage billing. On that date the organization moves to ${FREE}: <b>nothing is deleted</b> and nobody loses access, but adding more of anything over ${FREE}'s limits waits until it is back within them or subscribes again (${link(`${TERMS_PATH}#limits`, "Terms, section 6")}).`),
      ],
    },
    {
      id: "refunds",
      title: "4. Refunds",
      body: [
        p("<b>No refunds for partial periods.</b> A period that has started is not refunded when you cancel, lower your seats, or stop using Trov — <b>except where the law requires a refund</b>. Those are handled by hand: write to " + mail + " with your organization's name."),
        p("<b>Charged by mistake?</b> If you were charged twice, after cancelling, or because of an error on our side, write to " + mail + " and we will refund it."),
        p("<b>Changing seats.</b> Stripe's billing page shows what adding or removing seats costs, or credits to future invoices, before you confirm it. A credit is used against later invoices; it is not paid out."),
        p(`<b>If we end the service.</b> If we stop offering Trov, or end your access for a reason other than a breach of the ${link(TERMS_PATH, "Terms")}, we refund the unused part of the period already paid.`),
      ],
    },
    {
      id: "delete",
      title: "5. Deleting an organization or an account",
      body: [
        p(`Deleting an organization that pays for ${PRO} cancels its subscription at Stripe <b>immediately</b>, with no refund for the rest of the period: there is nothing left for it to pay for. Trov asks you to confirm this before anything is deleted.`),
        p("If you pay for an organization that other people keep using, Trov will not delete your account while that subscription still renews, so your card is not charged for a team you left. Cancel the plan first (it runs to the end of the paid period), or ask us to move the billing to another owner."),
      ],
    },
    {
      id: "failed",
      title: "6. Failed payments",
      body: [
        p(`If a payment fails, Stripe tries the card again and the organization keeps working while it does. Update the card in Manage billing. If the retries run out, the subscription ends and the organization moves to ${FREE}, as in section 3.`),
      ],
    },
    {
      id: "changes",
      title: "7. Price changes",
      body: [
        p("We email the owner at least 30 days before a change to what they pay takes effect, and it applies no sooner than the next billing period. You can cancel before then."),
      ],
    },
    {
      id: "receipts",
      title: "8. Receipts and invoices",
      body: [
        p("Stripe emails receipts. An owner finds every invoice in Manage billing. After a new purchase Trov also emails the buyer that their organization is ready, with these renewal and cancellation terms."),
      ],
    },
    {
      id: "contact",
      title: "9. Contact",
      body: [p(`${LEGAL_OPERATOR}, ${LEGAL_STATE}, United States. Billing, cancellation and refund questions: ${mail}.`)],
    },
  ],
};

/** Every legal document, in the order of the tab row over each one. */
export const LEGAL_DOCS: Record<LegalKind, LegalDoc> = { terms: TERMS, privacy: PRIVACY, refunds: REFUNDS };
export const LEGAL_ORDER: readonly LegalKind[] = ["terms", "privacy", "refunds"];

/** "2026-10-06" → "October 6, 2026" (fixed English, independent of the reader's locale and timezone). */
export function legalDate(iso: string): string {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
}

const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`;

const BANNER_ART = `<span class="site-banner-art" aria-hidden="true">${trovMark(100, "currentColor")}</span>`;

/** "3. Plans, payment and cancellation" → its number and its words, so the heading can set them apart. */
function numbered(title: string): { n: string; text: string } {
  const m = /^(\d+)\.\s+(.*)$/.exec(title);
  return m ? { n: m[1], text: m[2] } : { n: "", text: title };
}

const CHEV = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>`;

/** The tab row over each document: every legal document, the current one marked (a link to each other). */
export function legalTabs(current: LegalKind): string {
  const tab = (d: LegalDoc): string => d.kind === current
    ? `<span class="site-legal-tab" aria-current="page" style="border-radius:8px">${esc(d.tab)}</span>`
    : `<a href="/${d.kind}" class="site-legal-tab" style="border-radius:8px">${esc(d.tab)}</a>`;
  return `<nav class="site-legal-tabs" aria-label="Legal documents">${LEGAL_ORDER.map((k) => tab(LEGAL_DOCS[k])).join("")}</nav>`;
}

/** "the Privacy Policy and the Refund and Cancellation Policy" — the other documents, linked. */
function others(kind: LegalKind): string {
  const rest = LEGAL_ORDER.filter((k) => k !== kind).map((k) => `the <a href="/${k}">${esc(LEGAL_DOCS[k].title)}</a>`);
  return rest.length < 2 ? rest.join("") : `${rest.slice(0, -1).join(", ")} and ${rest[rest.length - 1]}`;
}

/** The whole page for one document. `dark` picks the toggle's icon, like the landing's nav. The page is the
 *  site's own: the brand banner carries the title (`.site-banner`, the landing hero's), the contents ride
 *  beside the text and follow the reader (web/src/legal-page.ts marks the section in view).
 *  Under 900px the contents are a box above the text, folded behind a "Contents" disclosure (up to 18 links
 *  would otherwise stand between the title and the first paragraph): `tocOpen` is its state, the button
 *  and the wrapper round the list are what trov.css folds, and a wide screen shows neither. */
export function legalView(doc: LegalDoc, dark: boolean, tocOpen = false): string {
  const toc = doc.sections.map((s) => {
    const t = numbered(s.title);
    return `<li><a href="#${s.id}" data-legal-toc="${s.id}">${t.n ? `<span class="site-legal-toc-n">${t.n}</span>` : ""}<span>${esc(t.text)}</span></a></li>`;
  }).join("");
  const sections = doc.sections
    .map((s) => {
      const t = numbered(s.title);
      return `<section id="${s.id}" class="site-legal-sec"><h2>${t.n ? `<span class="site-legal-n">${t.n}.</span>` : ""}${esc(t.text)}</h2>${s.body.join("")}</section>`;
    })
    .join("");
  return `<div class="cnpy-site">
    ${skipLink()}
    <nav class="site-nav" aria-label="Site" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
      <div class="site-navin" style="max-width:1120px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px">
        <a href="/" aria-label="Trov home" style="display:flex;align-items:center;gap:9px;color:var(--fg);text-decoration:none">
          ${siteMark(20)}
          <span style="font-size:16.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
        </a>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
          <a href="/pricing" class="site-navlink site-hide-sm">Pricing</a>
          <button type="button" data-legal-theme title="Toggle theme" aria-label="Toggle theme" class="site-iconbtn" style="border:1px solid var(--border)">${dark ? MOON : SUN}</button>
          <a href="/" class="cnpy-accentbtn" style="padding:7px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:13.5px;font-weight:600;white-space:nowrap;text-decoration:none">Open Trov</a>
        </div>
      </div>
    </nav>
    <header class="site-hero">
      <div class="site-banner site-legal-band" style="border-radius:16px">
        ${BANNER_ART}
        <div class="site-legal-band-in">
          ${legalTabs(doc.kind)}
          <h1 class="site-legal-h">${esc(doc.title)}</h1>
          <p class="site-legal-lede">${esc(doc.lede)}</p>
          <div class="site-legal-date">Effective and last updated ${legalDate(doc.updated)}</div>
        </div>
      </div>
    </header>
    <main id="site-main" tabindex="-1" class="site-legal">
      <aside class="site-legal-side">
        <nav aria-label="Contents" class="site-legal-toc" data-open="${tocOpen ? 1 : 0}"><div class="site-legal-toc-h">Contents</div><button type="button" data-legal-tocb aria-expanded="${tocOpen}" aria-controls="site-legal-toc-list" class="site-legal-tocb"><span class="site-legal-toc-h">Contents</span><span class="site-legal-tocb-n">${doc.sections.length} sections</span>${CHEV}</button><div class="site-legal-tocw"><ol id="site-legal-toc-list">${toc}</ol></div></nav>
      </aside>
      <div class="site-legal-text">
        <div class="site-legal-brief" style="border-radius:12px">
          <div class="site-legal-toc-h">In short</div>
          <ul>${doc.brief.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
          <p>A summary to read first. The sections below are what applies. Also see ${others(doc.kind)}.</p>
        </div>
        ${sections}
      </div>
    </main>
    ${siteFooter()}
  </div>`;
}
