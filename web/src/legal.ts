// ── Legal: the Terms of Service and Privacy Policy pages ────────────────────
// Two PUBLIC static pages, `/terms` and `/privacy` (web/terms.html, web/privacy.html —
// extra Vite inputs, served by the assets binding before the Worker, so no session is
// ever asked for). They are paths, not hash routes, on purpose: the hash is the app's
// route AND the sign-in return-to, and a legal page must open signed out, from the
// landing's footer, from an email or from an OAuth consent screen.
//
// This module is PURE (content + `legalView`), so a render test can read it; the DOM
// boot (theme, toggle, mount) is web/src/legal-page.ts. The landing's footer is shared
// (`siteFooter`, web/src/site-chrome.ts), so both pages end exactly like the product page.
//
// Every statement about data below describes what the code does today — the cookie
// names and lifetimes (src/auth/session.ts, src/auth/routes.ts), the OAuth scopes
// (src/auth/github.ts, src/auth/google.ts), the processors (Cloudflare, Stripe, Google
// Gemini, Resend, Google Fonts), the retention rules (CLAUDE.md "Pruning", the soft
// deletes) and how a paid plan is billed, changed and ended (docs/architecture/billing.md;
// the numbers come from shared/plans.ts and shared/pricing.ts, never typed here).
// Change the code, change this page — and bump `updated`.

import { esc } from "./ui";
import { trovMark } from "@shared/mark";
import { PLANS } from "@shared/plans";
import { PRICING, formatPrice } from "@shared/pricing";
import { SITE_CONTACT, siteFooter, siteMark } from "./site-chrome";

/** Who runs the service (the landing footer's copyright line). */
export const LEGAL_OPERATOR = "TrovLabs, Inc.";
/** Where questions and privacy requests go — the same address Trov sends its mail from. */
export const LEGAL_CONTACT = SITE_CONTACT;

export type LegalKind = "terms" | "privacy";

export interface LegalSection {
  id: string;
  title: string;
  /** Authored HTML (trusted — it is this file's own text), one string per block. */
  body: string[];
}

export interface LegalDoc {
  kind: LegalKind;
  title: string;
  /** ISO date the text last changed. */
  updated: string;
  lede: string;
  /** "In short": a few plain lines, shown beside the contents. A summary, never a substitute for the text. */
  brief: string[];
  sections: LegalSection[];
}

const p = (html: string) => `<p>${html}</p>`;
const ul = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const mail = `<a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a>`;
// The plan's own numbers, so this page can never disagree with the pricing page.
const PRO = PLANS.team.name;
const PRO_PRICE = `${formatPrice(PRICING.team.price ?? 0)} ${PRICING.team.per}`;
const PRO_SEATS = PLANS.team.entitlements.seats;
const FREE_SEATS = PLANS.free.entitlements.seats;

export const TERMS: LegalDoc = {
  kind: "terms",
  title: "Terms of Service",
  updated: "2026-10-09",
  lede: `These terms cover your use of Trov, the shared context store for teams and their coding agents, run by ${LEGAL_OPERATOR} By signing in you agree to them. If you use Trov on behalf of a team or company, you agree for it too.`,
  brief: [
    "Your content stays yours. We host and process it only to run Trov for your team.",
    "An agent you connect acts as you, and its writes are recorded under your name.",
    `Free costs nothing. ${PRO} is billed monthly per seat through Stripe, and you can cancel at any time.`,
    "Cancelling keeps what you paid for until the period ends, then the organization moves to Free. Nothing is deleted.",
  ],
  sections: [
    {
      id: "service",
      title: "1. The service",
      body: [
        p("Trov stores your team's working memory — docs, decisions, a feed of sessions, tickets, sprints, handoffs, prompts and artifacts — and lets people and the coding agents they connect read and propose changes to it. Agents only ever stage changes; a person confirms the consequential ones."),
        p("Anyone can create an account and an organization. Each organization is on a plan — Free, or a paid plan — which sets how many people, repositories and other things it can hold. The current plans and their limits are on the <a href=\"/pricing\">pricing page</a>."),
      ],
    },
    {
      id: "accounts",
      title: "2. Accounts and sign-in",
      body: [
        p("You sign in with GitHub or Google. You must give accurate information, keep your accounts secure, and tell us promptly if you think someone else has used your account or one of your agent connections."),
        p("You are responsible for what happens under your account, <b>including everything an agent does with a connection you authorized</b>. An agent connected to Trov acts as you: its writes are recorded under your name, exactly as if you had made them. Revoke a connection in Settings › MCP access as soon as you no longer trust it."),
        p("You must be at least 16 years old to use Trov."),
      ],
    },
    {
      id: "plans",
      title: "3. Plans, payment and cancellation",
      body: [
        p(`<b>Free.</b> An organization on Free costs nothing and holds up to ${FREE_SEATS} people. Each person can own one Free organization.`),
        p(`<b>${PRO}.</b> ${PRO} costs ${PRO_PRICE}, for up to ${PRO_SEATS} people. It is a subscription: you are charged when you subscribe and again at the start of each month until you cancel. Prices are in US dollars. Any tax that applies is shown at checkout before you pay.`),
        p("<b>Who pays.</b> The person who buys a plan is the organization's owner and its billing contact. Only the owner can change seats, update the payment method, see invoices or cancel. Members never pay and are never asked for a card."),
        p("<b>Seats.</b> A seat is a place for one member or one pending invitation. The owner can add or remove seats at any time; the change takes effect straight away and the charge is adjusted in proportion on the next invoice. Seats cannot be reduced below the number of people already in the organization."),
        p("<b>Payment.</b> Payments are taken by Stripe. Trov never receives or stores your card number. By subscribing you authorize the recurring charge to the payment method you gave Stripe. If a payment fails, Stripe retries it; if the retries run out, the subscription ends."),
        p("<b>Cancelling.</b> The owner can cancel at any time in the organization's settings, under Plan. The organization keeps its paid plan until the end of the period already paid for, and then moves to Free. It can be resumed before that date."),
        p("<b>When a subscription ends.</b> Nothing is deleted. Everyone keeps access and can read everything; tickets, docs, the feed and existing agent connections carry on. Anything over Free's limits — a new member, repository or connection, for example — is refused until the organization is back within them or subscribes again."),
        p(`<b>Refunds.</b> Payments are not refunded for a period that has already started, except where the law requires it. If you were charged by mistake, or something went wrong on our side, write to ${mail} and we will put it right.`),
        p("<b>Price changes.</b> We may change a plan's price or limits. A change to what you pay takes effect no sooner than your next billing period, and we will email the owner at least 30 days before it does. You can cancel before then."),
        p("<b>Gifted plans.</b> We may give an organization a paid plan for a set time at no charge. When that time ends the organization moves to Free unless its owner subscribes. A gift has no cash value."),
      ],
    },
    {
      id: "content",
      title: "4. Your content",
      body: [
        p("You keep every right you have in what you and your agents put into Trov (\"your content\"). You give the operator a limited, worldwide, non-exclusive licence to host, copy, process, index, display and transmit your content only as needed to run, secure and improve the service for you and your team — for example to store it, search it, render it, send digest emails and generate summaries."),
        p("Content you add to a team's workspace is visible to the other members of that team, and team admins can manage it. Make sure you have the right to add what you add, and do not put secrets (passwords, API keys, personal data you are not allowed to share) into docs, tickets, prompts or artifacts."),
        p("Content you connect from GitHub (pull requests, issues, commits, reviews, CI results) stays subject to GitHub's terms and your repository's own permissions."),
      ],
    },
    {
      id: "use",
      title: "5. Acceptable use",
      body: [
        p("Don't use Trov to:"),
        ul(
          "break the law or infringe anyone's rights;",
          "upload malware, or artifacts designed to attack the people who open them;",
          "try to reach data, accounts or teams you have not been given access to, or probe, scan or test the service's security without written permission;",
          "overload the service, or get around its limits, sandboxes or access controls;",
          "harass people, or store content about people that you have no right to hold.",
        ),
        p("We may remove content or suspend access that breaks these rules, and will tell you when we reasonably can."),
      ],
    },
    {
      id: "ai",
      title: "6. AI-generated summaries",
      body: [
        p("Trov uses an AI model to summarize pull requests and issues when they are captured. Summaries can be wrong or incomplete; they are a convenience, not a record. Check the underlying pull request or issue before relying on one."),
      ],
    },
    {
      id: "third-parties",
      title: "7. Third-party services",
      body: [
        p("Trov depends on other services — GitHub and Google for sign-in, GitHub for repository data, Cloudflare for hosting, Stripe for payments, Google Gemini for summaries and Resend for email. Their availability and terms are outside our control, and your use of them is governed by their own terms."),
      ],
    },
    {
      id: "open-source",
      title: "8. Open source",
      body: [
        p("Trov's source code is published under the GNU Affero General Public License v3.0. That licence governs the code. These terms govern your use of this hosted service; nothing in them limits the rights the AGPL gives you in the code."),
      ],
    },
    {
      id: "availability",
      title: "9. Availability and changes",
      body: [
        p("We work to keep Trov running and your content safe, but the service may change, be interrupted, or lose data. Keep your own copies of anything you cannot afford to lose. We may add, change or remove features at any time; if we remove something a paid plan depends on, the owner can cancel and section 3 applies."),
      ],
    },
    {
      id: "disclaimer",
      title: "10. Disclaimer and limitation of liability",
      body: [
        p("Trov is provided <b>\"as is\" and \"as available\"</b>, without warranties of any kind, express or implied — including merchantability, fitness for a particular purpose and non-infringement — to the fullest extent the law allows."),
        p("To the fullest extent the law allows, the operator is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or goodwill, arising from your use of Trov. The operator's total liability for any claim about the service is limited to what your organization paid for Trov in the 12 months before the claim arose. Nothing in these terms limits liability that cannot be limited by law."),
      ],
    },
    {
      id: "ending",
      title: "11. Ending your use",
      body: [
        p(`You can stop using Trov at any time, and ask for your account to be deleted by writing to ${mail}. Deleting an account does not cancel a subscription you own: cancel it first, as described in section 3. We may suspend or end your access if you break these terms or if we stop offering the service; where we can, we will give notice and a chance to export your content first, and if we stop offering the service we will refund the unused part of a period already paid for. Sections 4, 10 and 12 survive the end of your use.`),
      ],
    },
    {
      id: "changes",
      title: "12. Changes to these terms",
      body: [
        p("We may update these terms. The date at the top of this page says when they last changed, and we will tell you in the app or by email before a material change takes effect. If you keep using Trov after that, you accept the new terms."),
      ],
    },
    {
      id: "contact",
      title: "13. Contact",
      body: [p(`Questions about these terms: ${mail}.`)],
    },
  ],
};

export const PRIVACY: LegalDoc = {
  kind: "privacy",
  title: "Privacy Policy",
  updated: "2026-10-09",
  lede: `This policy explains what Trov collects, why, who processes it, how long it is kept and what you can ask for. Trov is run by ${LEGAL_OPERATOR}, which is responsible for the personal data described here.`,
  brief: [
    "We do not sell personal data. Trov shows no ads and uses no tracking or analytics cookies.",
    "What you add to an organization is visible to its members, and to nobody else.",
    "Card details go to Stripe and never reach Trov. We keep the plan, its status and the seat count.",
    "You can change or delete your details, revoke agent connections and stop any email.",
  ],
  sections: [
    {
      id: "collect",
      title: "1. What we collect",
      body: [
        p("<b>Your account.</b> When you sign in with GitHub we receive your GitHub username, display name, profile picture and your primary, verified email address (the <code>read:user</code>, <code>user:email</code> and <code>read:org</code> permissions). With Google we receive your Google account id, name, picture and verified email (<code>openid email profile</code>). We use the provider's access token during sign-in and do not store it. You choose a handle and a color; you may upload a profile photo; an admin may record your role and responsibilities on the team."),
        p("<b>What you and your agents write.</b> Docs and their versions, decisions, feed entries, tickets and comments, sprints, handoffs, prompts, artifacts and the images and files you upload — together with who wrote each one and when."),
        p("<b>Connected repository data.</b> When a team connects a GitHub repository, Trov captures pull requests, issues, pushes, reviews, deployments and CI results from it, including the GitHub usernames of the people involved. That can include people who never signed in to Trov, such as outside contributors; their usernames appear in a list team members can link or discard."),
        p("<b>Agent connections.</b> When you connect an agent we keep a record of the connection (the app's name, when it was created and last used). Access tokens are stored only as one-way hashes."),
        p("<b>Billing.</b> When you buy a plan, Stripe collects your payment details, billing address and any tax information on its own pages. Trov never receives your card number. We send Stripe your email address and receive back, and keep, the Stripe customer and subscription ids, the plan, its status, the number of seats, the end of the current period and whether it is set to cancel."),
        p("<b>Email preferences</b> — which digests you get and how often, and whether you unsubscribed."),
        p("<b>Technical data.</b> Our host, Cloudflare, processes your IP address and request details to serve and protect the service, and keeps operational logs."),
      ],
    },
    {
      id: "use",
      title: "2. How we use it",
      body: [
        ul(
          "to sign you in, keep you signed in and keep accounts secure;",
          "to provide Trov — store, search, show and attribute your team's content, and let connected agents read and propose changes as you;",
          "to take payment for a paid plan, keep an organization on the plan it paid for, and apply that plan's limits;",
          "to summarize captured pull requests and issues;",
          "to send the emails you can control in Settings (digests) and the service emails that go with an account (an invitation, a welcome message);",
          "to run, debug and protect the service.",
        ),
        p("We process this data because it is necessary to provide the service you signed up for and to carry out a purchase you made, for our legitimate interest in keeping it secure and working, and to meet legal duties such as keeping tax and accounting records."),
      ],
    },
    {
      id: "sharing",
      title: "3. Who can see it",
      body: [
        p("<b>Your team.</b> What you add to a team's workspace is visible to its members; an artifact you mark private is visible only to you. Team admins can manage content and members. Members can see which plan the organization is on and its limits; only the owner can open its invoices and payment details, which are shown by Stripe."),
        p("<b>Service providers</b> that process data for us, only to run Trov:"),
        ul(
          "<b>Cloudflare</b> — hosting, database and file storage, and request logs;",
          "<b>Google (Gemini API)</b> — the text of captured pull requests and issues is sent to Google to generate summaries;",
          "<b>Stripe</b> — takes payment, hosts the checkout and billing pages, issues invoices and receipts, and screens for fraud. It receives the buyer's email address, payment details and billing address, and handles them under its own privacy policy;",
          "<b>Resend</b> — delivers email (your address and the message);",
          "<b>GitHub and Google</b> — sign-in, and for GitHub, the repository data a team connects;",
          "<b>Google Fonts</b> — the site's typefaces load from Google, which receives your IP address when they do.",
        ),
        p("We may also disclose data if the law requires it, or to protect the rights and safety of users and the service. We do not sell or rent personal data."),
      ],
    },
    {
      id: "cookies",
      title: "4. Cookies and local storage",
      body: [
        p("Trov uses only cookies it needs to work: <code>session</code> keeps you signed in (30 days), and a few short-lived cookies carry a sign-in in progress (about 10 minutes). Your browser's local storage keeps interface preferences such as the theme and the sidebar's state; they never leave your device. There are no analytics, advertising or third-party tracking cookies. Stripe's checkout and billing pages are on Stripe's own site and set Stripe's cookies there, including ones it uses to prevent fraud."),
      ],
    },
    {
      id: "retention",
      title: "5. How long we keep it",
      body: [
        ul(
          "<b>Account data</b> — while your account exists.",
          "<b>Team content</b> — for as long as the team keeps it. Deleting a ticket or sprint removes it; deleting a prompt or artifact hides it everywhere but keeps it so it can be restored. Uploaded images and files are stored by content and are not removed automatically.",
          "<b>Sessions</b> — expire after 30 days. Agents connected by browser sign-in use access tokens that expire after an hour and are renewed while in use; expired and revoked tokens are cleared on a schedule.",
          "<b>Repository monitoring</b> — health checks are deleted after 45 days and hourly usage figures after 100 days; repository history (pull requests, pushes, deployments) is kept for the life of the team's workspace.",
          "<b>Billing records</b> — the subscription record is kept while the organization exists, including after the subscription ends, so the owner can still reach past invoices. Stripe keeps payment and invoice records for as long as tax and accounting law requires.",
          "<b>Email records</b> — kept to avoid sending the same digest twice.",
        ),
        p(`When an account is deleted on request, we delete or anonymize its personal data unless we must keep it by law; content you wrote in a team's workspace may stay with that team, attributed to your handle.`),
      ],
    },
    {
      id: "rights",
      title: "6. Your choices and rights",
      body: [
        p("You can change your name, handle, color and photo in Settings, unlink a sign-in method, revoke agent connections, and change or stop digest emails — every digest has a one-click unsubscribe. An organization's owner can update the payment method, download invoices and cancel the plan from the organization's settings."),
        p(`Depending on where you live, you may have the right to access, correct, delete, restrict or object to the processing of your personal data, and to receive a copy of it. To use these rights, or to have your account deleted, write to ${mail}. We will answer within 30 days. You can also complain to your local data protection authority.`),
      ],
    },
    {
      id: "security",
      title: "7. Security",
      body: [
        p("Sign-in uses GitHub or Google with PKCE; session cookies are signed, HTTP-only and secure; agent tokens are stored only as hashes; GitHub deliveries are signature-verified; artifact pages run in a sandbox cut off from your session; payment notices from Stripe are signature-verified, and card data never touches Trov's servers; all traffic is encrypted in transit. No system is perfectly secure — if you find a vulnerability, please report it to us privately."),
      ],
    },
    {
      id: "transfers",
      title: "8. International transfers",
      body: [
        p("Our providers operate globally, so your data may be processed outside your country, including in the United States. Where the law requires it, those transfers rely on the providers' standard contractual safeguards."),
      ],
    },
    {
      id: "children",
      title: "9. Children",
      body: [p("Trov is a tool for working teams and is not meant for anyone under 16. We do not knowingly collect their data.")],
    },
    {
      id: "changes",
      title: "10. Changes to this policy",
      body: [
        p("If we change how we handle personal data we will update this page and its date, and tell you in the app or by email before a material change takes effect."),
      ],
    },
    {
      id: "contact",
      title: "11. Contact",
      body: [p(`Privacy questions and requests: ${mail}.`)],
    },
  ],
};

export const LEGAL_DOCS: Record<LegalKind, LegalDoc> = { terms: TERMS, privacy: PRIVACY };

/** "2026-10-06" → "October 6, 2026" (fixed English, independent of the reader's locale and timezone). */
export function legalDate(iso: string): string {
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}` : iso;
}

const SUN = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="4.2"></circle><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"></path></svg>`;
const MOON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"></path></svg>`;

const BANNER_ART = `<span class="site-banner-art" aria-hidden="true">${trovMark(100, "currentColor")}</span>`;

/** "3. Plans, payment and cancellation" → its number and its words, so the heading can set them apart. */
function numbered(title: string): { n: string; text: string } {
  const m = /^(\d+)\.\s+(.*)$/.exec(title);
  return m ? { n: m[1], text: m[2] } : { n: "", text: title };
}

/** The whole page for one document. `dark` picks the toggle's icon, like the landing's nav. The page is the
 *  site's own: the brand banner carries the title (`.site-banner`, the landing hero's), the contents ride
 *  beside the text and follow the reader (web/src/legal-page.ts marks the section in view). */
export function legalView(doc: LegalDoc, dark: boolean): string {
  const other = doc.kind === "terms" ? PRIVACY : TERMS;
  const toc = doc.sections.map((s) => `<li><a href="#${s.id}" data-legal-toc="${s.id}">${esc(s.title)}</a></li>`).join("");
  const sections = doc.sections
    .map((s) => {
      const t = numbered(s.title);
      return `<section id="${s.id}" class="site-legal-sec"><h2>${t.n ? `<span class="site-legal-n" style="border-radius:7px">${t.n}</span>` : ""}${esc(t.text)}</h2>${s.body.join("")}</section>`;
    })
    .join("");
  const tab = (d: LegalDoc): string => d.kind === doc.kind
    ? `<span class="site-legal-tab" aria-current="page" style="border-radius:8px">${esc(d.title)}</span>`
    : `<a href="/${d.kind}" class="site-legal-tab" style="border-radius:8px">${esc(d.title)}</a>`;
  return `<div class="cnpy-site">
    <nav class="site-nav" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
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
          <div class="site-legal-tabs" role="navigation" aria-label="Legal documents">${tab(TERMS)}${tab(PRIVACY)}</div>
          <h1 class="site-legal-h">${esc(doc.title)}</h1>
          <p class="site-legal-lede">${esc(doc.lede)}</p>
          <div class="site-legal-date">Last updated ${legalDate(doc.updated)}</div>
        </div>
      </div>
    </header>
    <main class="site-legal">
      <aside class="site-legal-side">
        <nav aria-label="Contents" class="site-legal-toc"><div class="site-legal-toc-h">Contents</div><ol>${toc}</ol></nav>
      </aside>
      <div class="site-legal-text">
        <div class="site-legal-brief" style="border-radius:12px">
          <div class="site-legal-toc-h">In short</div>
          <ul>${doc.brief.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
          <p>A summary to read first. The sections below are what applies. Also see the <a href="/${other.kind}">${esc(other.title)}</a>.</p>
        </div>
        ${sections}
      </div>
    </main>
    ${siteFooter()}
  </div>`;
}
