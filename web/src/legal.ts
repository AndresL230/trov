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
// (src/auth/github.ts, src/auth/google.ts), the processors (Cloudflare, Google Gemini,
// Resend, Google Fonts) and the retention rules (CLAUDE.md "Pruning", the soft deletes).
// Change the code, change this page — and bump `updated`.

import { esc } from "./ui";
import { siteFooter, siteMark } from "./site-chrome";

/** Who runs the service (the landing footer's copyright line). */
export const LEGAL_OPERATOR = "Andres Lopez";
/** Where questions and privacy requests go — the same address Trov sends its mail from. */
export const LEGAL_CONTACT = "hello@trov.dev";

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
  sections: LegalSection[];
}

const p = (html: string) => `<p>${html}</p>`;
const ul = (...items: string[]) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const mail = `<a href="mailto:${LEGAL_CONTACT}">${LEGAL_CONTACT}</a>`;

export const TERMS: LegalDoc = {
  kind: "terms",
  title: "Terms of Service",
  updated: "2026-10-06",
  lede: `These terms cover your use of Trov, the shared context store for teams and their coding agents, run by ${LEGAL_OPERATOR}. By signing in you agree to them. If you use Trov on behalf of a team or company, you agree for it too.`,
  sections: [
    {
      id: "service",
      title: "1. The service",
      body: [
        p("Trov stores your team's working memory — docs, decisions, a feed of sessions, tickets, sprints, handoffs, prompts and artifacts — and lets people and the coding agents they connect read and propose changes to it. Agents only ever stage changes; a person confirms the consequential ones."),
        p("Trov is offered to the teams that have been given access. Access can be limited, changed or withdrawn as the service evolves."),
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
      id: "content",
      title: "3. Your content",
      body: [
        p("You keep every right you have in what you and your agents put into Trov (\"your content\"). You give the operator a limited, worldwide, non-exclusive licence to host, copy, process, index, display and transmit your content only as needed to run, secure and improve the service for you and your team — for example to store it, search it, render it, send digest emails and generate summaries."),
        p("Content you add to a team's workspace is visible to the other members of that team, and team admins can manage it. Make sure you have the right to add what you add, and do not put secrets (passwords, API keys, personal data you are not allowed to share) into docs, tickets, prompts or artifacts."),
        p("Content you connect from GitHub (pull requests, issues, commits, reviews, CI results) stays subject to GitHub's terms and your repository's own permissions."),
      ],
    },
    {
      id: "use",
      title: "4. Acceptable use",
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
      title: "5. AI-generated summaries",
      body: [
        p("Trov uses an AI model to summarize pull requests and issues when they are captured. Summaries can be wrong or incomplete; they are a convenience, not a record. Check the underlying pull request or issue before relying on one."),
      ],
    },
    {
      id: "third-parties",
      title: "6. Third-party services",
      body: [
        p("Trov depends on other services — GitHub and Google for sign-in, GitHub for repository data, Cloudflare for hosting, Google Gemini for summaries and Resend for email. Their availability and terms are outside our control, and your use of them is governed by their own terms."),
      ],
    },
    {
      id: "open-source",
      title: "7. Open source",
      body: [
        p("Trov's source code is published under the GNU Affero General Public License v3.0. That licence governs the code. These terms govern your use of this hosted service; nothing in them limits the rights the AGPL gives you in the code."),
      ],
    },
    {
      id: "availability",
      title: "8. Availability and changes",
      body: [
        p("We work to keep Trov running and your content safe, but the service may change, be interrupted, or lose data. Keep your own copies of anything you cannot afford to lose. We may add, change or remove features at any time."),
      ],
    },
    {
      id: "disclaimer",
      title: "9. Disclaimer and limitation of liability",
      body: [
        p("Trov is provided <b>\"as is\" and \"as available\"</b>, without warranties of any kind, express or implied — including merchantability, fitness for a particular purpose and non-infringement — to the fullest extent the law allows."),
        p("To the fullest extent the law allows, the operator is not liable for indirect, incidental, special, consequential or punitive damages, or for lost profits, revenue, data or goodwill, arising from your use of Trov. Nothing in these terms limits liability that cannot be limited by law."),
      ],
    },
    {
      id: "ending",
      title: "10. Ending your use",
      body: [
        p(`You can stop using Trov at any time, and ask for your account to be deleted by writing to ${mail}. We may suspend or end your access if you break these terms or if we stop offering the service; where we can, we will give notice and a chance to export your content first. Sections 3, 9 and 11 survive the end of your use.`),
      ],
    },
    {
      id: "changes",
      title: "11. Changes to these terms",
      body: [
        p("We may update these terms. The date at the top of this page says when they last changed, and we will tell you in the app or by email before a material change takes effect. If you keep using Trov after that, you accept the new terms."),
      ],
    },
    {
      id: "contact",
      title: "12. Contact",
      body: [p(`Questions about these terms: ${mail}.`)],
    },
  ],
};

export const PRIVACY: LegalDoc = {
  kind: "privacy",
  title: "Privacy Policy",
  updated: "2026-10-06",
  lede: `This policy explains what Trov collects, why, who processes it, how long it is kept and what you can ask for. Trov is run by ${LEGAL_OPERATOR}, who is responsible for the personal data described here. We do not sell personal data, and Trov shows no ads and uses no tracking or analytics cookies.`,
  sections: [
    {
      id: "collect",
      title: "1. What we collect",
      body: [
        p("<b>Your account.</b> When you sign in with GitHub we receive your GitHub username, display name, profile picture and your primary, verified email address (the <code>read:user</code>, <code>user:email</code> and <code>read:org</code> permissions). With Google we receive your Google account id, name, picture and verified email (<code>openid email profile</code>). We use the provider's access token during sign-in and do not store it. You choose a handle and a color; you may upload a profile photo; an admin may record your role and responsibilities on the team."),
        p("<b>What you and your agents write.</b> Docs and their versions, decisions, feed entries, tickets and comments, sprints, handoffs, prompts, artifacts and the images and files you upload — together with who wrote each one and when."),
        p("<b>Connected repository data.</b> When a team connects a GitHub repository, Trov captures pull requests, issues, pushes, reviews, deployments and CI results from it, including the GitHub usernames of the people involved. That can include people who never signed in to Trov, such as outside contributors; their usernames appear in a list team members can link or discard."),
        p("<b>Agent connections.</b> When you connect an agent we keep a record of the connection (the app's name, when it was created and last used). Access tokens are stored only as one-way hashes."),
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
          "to summarize captured pull requests and issues;",
          "to send the emails you can control in Settings (digests) and the service emails that go with an account (an invitation, a welcome message);",
          "to run, debug and protect the service.",
        ),
        p("We process this data because it is necessary to provide the service you signed up for, and for our legitimate interest in keeping it secure and working."),
      ],
    },
    {
      id: "sharing",
      title: "3. Who can see it",
      body: [
        p("<b>Your team.</b> What you add to a team's workspace is visible to its members; an artifact you mark private is visible only to you. Team admins can manage content and members."),
        p("<b>Service providers</b> that process data for us, only to run Trov:"),
        ul(
          "<b>Cloudflare</b> — hosting, database and file storage, and request logs;",
          "<b>Google (Gemini API)</b> — the text of captured pull requests and issues is sent to Google to generate summaries;",
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
        p("Trov uses only cookies it needs to work: <code>session</code> keeps you signed in (30 days), and a few short-lived cookies carry a sign-in in progress (about 10 minutes). Your browser's local storage keeps interface preferences such as the theme and the sidebar's state; they never leave your device. There are no analytics, advertising or third-party tracking cookies."),
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
          "<b>Email records</b> — kept to avoid sending the same digest twice.",
        ),
        p(`When an account is deleted on request, we delete or anonymize its personal data unless we must keep it by law; content you wrote in a team's workspace may stay with that team, attributed to your handle.`),
      ],
    },
    {
      id: "rights",
      title: "6. Your choices and rights",
      body: [
        p("You can change your name, handle, color and photo in Settings, unlink a sign-in method, revoke agent connections, and change or stop digest emails — every digest has a one-click unsubscribe."),
        p(`Depending on where you live, you may have the right to access, correct, delete, restrict or object to the processing of your personal data, and to receive a copy of it. To use these rights, or to have your account deleted, write to ${mail}. We will answer within 30 days. You can also complain to your local data protection authority.`),
      ],
    },
    {
      id: "security",
      title: "7. Security",
      body: [
        p("Sign-in uses GitHub or Google with PKCE; session cookies are signed, HTTP-only and secure; agent tokens are stored only as hashes; GitHub deliveries are signature-verified; artifact pages run in a sandbox cut off from your session; all traffic is encrypted in transit. No system is perfectly secure — if you find a vulnerability, please report it to us privately."),
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

/** The whole page for one document. `dark` picks the toggle's icon, like the landing's nav. */
export function legalView(doc: LegalDoc, dark: boolean): string {
  const other = doc.kind === "terms" ? PRIVACY : TERMS;
  const toc = doc.sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("");
  const sections = doc.sections
    .map((s) => `<section id="${s.id}" class="site-legal-sec"><h2>${esc(s.title)}</h2>${s.body.join("")}</section>`)
    .join("");
  return `<div class="cnpy-site">
    <nav class="site-nav" style="position:sticky;top:0;z-index:50;background:color-mix(in srgb, var(--bg) 86%, transparent);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px)">
      <div class="site-navin" style="max-width:1120px;margin:0 auto;padding:0 24px;height:60px;display:flex;align-items:center;gap:28px">
        <a href="/" style="display:flex;align-items:center;gap:9px;color:var(--fg);text-decoration:none">
          ${siteMark(20)}
          <span style="font-size:16.5px;font-weight:650;letter-spacing:-0.01em">Trov</span>
        </a>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px">
          <a href="/${other.kind}" class="site-navlink">${esc(other.title)}</a>
          <button type="button" data-legal-theme title="Toggle theme" aria-label="Toggle theme" class="site-iconbtn" style="border:1px solid var(--border)">${dark ? MOON : SUN}</button>
        </div>
      </div>
    </nav>
    <main class="site-legal" style="max-width:760px;margin:0 auto;padding:72px 24px 0">
      <div style="font-family:var(--label);font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--accent)">Legal</div>
      <h1 style="margin:12px 0 0;font-size:clamp(32px, 4vw, 44px);font-weight:650;letter-spacing:-0.025em;line-height:1.1">${esc(doc.title)}</h1>
      <div style="margin-top:12px;font-size:13.5px;color:var(--fg-55)">Last updated ${legalDate(doc.updated)}</div>
      <p class="site-legal-lede">${esc(doc.lede)}</p>
      <nav aria-label="Contents" class="site-legal-toc"><div class="site-legal-toc-h">Contents</div><ol>${toc}</ol></nav>
      ${sections}
    </main>
    ${siteFooter()}
  </div>`;
}
