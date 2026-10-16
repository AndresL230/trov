// Who runs Trov, where its legal pages and source are, and the one sentence a person agrees to when they
// sign up — the ONE copy the site, the app, the Worker's own pages (OAuth, billing notices), the MCP
// server and the mail all read (docs/architecture/web-ui.md › Legal pages, consent and the source).
// Zod-free and pure: the browser bundle imports it as values, and so does the Worker.
//
// The documents themselves are web/src/legal.ts (`LEGAL_DOCS`), each a page of shared/site-pages.ts.

import { PLATFORM_FROM_ADDRESS } from "./sender";

/** The company that runs the hosted service and sells its plans. */
export const LEGAL_ENTITY = "TrovLabs, Inc.";
/** Where it is incorporated (the footer, the Terms). */
export const LEGAL_STATE = "New Jersey";
/** Where questions, privacy requests, deletion requests and refund requests go — the address Trov sends from. */
export const LEGAL_EMAIL = PLATFORM_FROM_ADDRESS;
/** The youngest a person may be to use Trov (Terms › Eligibility, Privacy › Children). Nothing verifies it:
 *  a person confirms it when they sign up. */
export const MIN_AGE = 16;

/**
 * The server-side AI build's legal text (#178 Phase G) is NOT approved yet. While this is true, every such passage
 * of web/src/legal.ts shows a visible "DRAFT —", AND Org settings › AI › "What is sent" (`AI_SENDS`,
 * shared/ai-core.ts) lists only the lines whose Privacy rows are approved — the same claim is never final on the
 * screen while it is a draft in the policy (owner ruling, 2026-10-16). Approval is ONE change: set it to false
 * (and bump `PROVIDERS_UPDATED` in web/src/legal.ts and the date test/render.legal.test.ts pins) — the markers drop
 * and the full list ships, together. test/render.legal.test.ts › "approve once, ship both" holds the two to it.
 */
export const AI_LEGAL_DRAFT: boolean = true;

/** The legal pages, as paths (static pages of shared/site-pages.ts, readable signed out). */
export const TERMS_PATH = "/terms";
export const PRIVACY_PATH = "/privacy";
export const REFUNDS_PATH = "/refunds";

/** The repository the hosted service is built from (AGPL-3.0). */
export const TROV_SOURCE_REPO = "https://github.com/AndresL230/trov";
/**
 * THE source link (AGPL-3.0 §13): a path on Trov's own origin that the assets binding redirects to the
 * deployed commit's tree on GitHub (`_redirects`, written by the build from Workers Builds'
 * `WORKERS_CI_COMMIT_SHA` — `sourceRedirect` in shared/site-pages.ts), or to the repository when the build
 * did not know the commit. Every surface links this path, so none needs to know the commit, and nothing on
 * a render path asks GitHub anything. The Worker answers it too (src/site.ts), should the rule be missing.
 */
export const SOURCE_PATH = "/source";
/** The bundled third-party software and fonts, with their licences (THIRD-PARTY-NOTICES.txt at the
 *  repository's root, copied beside the pages by the build). */
export const NOTICES_PATH = "/third-party-notices.txt";

/** A commit id as Workers Builds gives it: 7 to 40 hex characters. Anything else is ignored. */
const COMMIT_RE = /^[0-9a-f]{7,40}$/i;
/** Where the source of THIS deployment is: its commit's tree when the build knew it, else the repository. */
export function sourceUrl(commit?: string | null): string {
  return commit && COMMIT_RE.test(commit) ? `${TROV_SOURCE_REPO}/tree/${commit.toLowerCase()}` : TROV_SOURCE_REPO;
}

/** "© 2026 TrovLabs, Inc. · New Jersey" — the footer's line (the year is the render's). */
export function copyrightLine(year: number = new Date().getUTCFullYear()): string {
  return `© ${year} ${LEGAL_ENTITY} · ${LEGAL_STATE}`;
}

/** The consent sentence, as plain text (an aria description, a test). */
export const CONSENT_TEXT = `By continuing you agree to the Terms of Service and Privacy Policy, and confirm you are ${MIN_AGE} or older.`;

/** The consent sentence with its two links, as HTML. `origin` makes the links absolute (a page the Worker
 *  renders on another path, or mail); the site's own pages pass nothing. `attrs` go on each link. */
export function consentHtml(origin = "", attrs = ""): string {
  const a = (path: string, text: string) => `<a href="${origin}${path}"${attrs ? ` ${attrs}` : ""}>${text}</a>`;
  return `By continuing you agree to the ${a(TERMS_PATH, "Terms of Service")} and ${a(PRIVACY_PATH, "Privacy Policy")}, and confirm you are ${MIN_AGE} or older.`;
}

/** The onboarding checkbox's label (the one place a new account is created, web/src/people.ts). */
export function agreeHtml(attrs = ""): string {
  const a = (path: string, text: string) => `<a href="${path}" target="_blank" rel="noopener"${attrs ? ` ${attrs}` : ""}>${text}</a>`;
  return `I agree to the ${a(TERMS_PATH, "Terms of Service")} and ${a(PRIVACY_PATH, "Privacy Policy")}, and I am ${MIN_AGE} or older.`;
}

/** The legal links a page that is not the site (the app's Settings › Help, the Worker's own pages) shows:
 *  label and path, in this order. */
export const LEGAL_LINKS: readonly { label: string; path: string }[] = [
  { label: "Terms", path: TERMS_PATH },
  { label: "Privacy", path: PRIVACY_PATH },
  { label: "Refunds", path: REFUNDS_PATH },
  { label: "Source code (AGPL-3.0)", path: SOURCE_PATH },
];
