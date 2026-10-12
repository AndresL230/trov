// ── /llms.txt and /llms-full.txt (https://llmstxt.org) ───────────────────────
// docs/architecture/web-ui.md › Docs for people and agents. Written by the build (web/site-build.ts,
// through site-prerender.ts `siteFiles`) as static files beside the pages, from the SAME sources as the
// pages: each page's title and description from shared/site-pages.ts, each docs page's Markdown from
// docs-content.ts, the pricing page's from pricing.ts. Nothing here is typed twice.
//   • llms.txt: `# Trov`, a one-line `>` summary, a few lines of context, then sections of links to the
//     Markdown versions, each with its one-line description.
//   • llms-full.txt: the same head, then every Markdown page in full, one after another.
// PURE.

import { DOCS_PAGES, LLMS_FULL_TXT, SITE_NAME, SITE_PAGES, siteUrl, type SitePage } from "@shared/site-pages";
import { docsMarkdown, MCP_URL } from "./docs-content";
import { pricingMarkdown } from "./pricing";
import { TROV_REPO } from "./site-chrome";

/** The one-line summary under the H1. */
export const LLMS_SUMMARY = "Shared memory for a software team and its coding agents: docs, decisions, the roadmap, a ticket queue and a feed of what shipped, which agents read and write over MCP while a person approves what becomes official.";

const byKey = (key: string): SitePage => {
  const p = SITE_PAGES.find((x) => x.key === key);
  if (!p) throw new Error(`llms: no page "${key}"`);
  return p;
};
/** A page's link: its Markdown when it has one, else the page itself. */
const link = (p: SitePage, title = p.title.replace(/ · .*$/, "")): string => `- [${title}](${siteUrl(p.markdown ?? p.path)}): ${p.description}`;

const intro = (): string => [
  `# ${SITE_NAME}`,
  `> ${LLMS_SUMMARY}`,
  `${SITE_NAME} is a hosted service at ${siteUrl("/")}. Agents connect to its remote MCP server at ${MCP_URL} (Streamable HTTP; OAuth sign-in in the browser, or a bearer token), as the person who connected them. Knowledge an agent proposes (doc changes, decisions, feed entries) is staged until a person promotes it in the web app; tickets, sprints and artifacts are direct writes, within what the agent's person may do (an agent changes only tickets already assigned to its person). Every read result says whether it is \`live\` (settled) or only proposed. The source is public under AGPL-3.0: ${TROV_REPO}.`,
].join("\n\n");

export function llmsTxt(): string {
  const docs = (key: string) => link(byKey(key));
  return [
    intro(),
    `## Docs\n\n${[docs("docs-setup"), docs("docs-connect"), docs("docs-concepts"), docs("docs-mcp-tools")].join("\n")}`,
    `## Pricing\n\n${link(byKey("pricing"))}`,
    `## Changelog\n\n${docs("docs-changelog")}`,
    `## Optional\n\n${[
      `- [Everything above in one file](${siteUrl(LLMS_FULL_TXT)}): every page linked here, in full, as Markdown.`,
      link(byKey("terms")),
      link(byKey("privacy")),
      link(byKey("refunds")),
      `- [Source code](${TROV_REPO}): the Cloudflare Worker, the web app and the Claude Code plugin, under AGPL-3.0.`,
    ].join("\n")}`,
  ].join("\n\n") + "\n";
}

/** Every Markdown page, in llms.txt's order. */
export function markdownPages(): { page: SitePage; markdown: string }[] {
  const order = ["docs-setup", "docs-connect", "docs-concepts", "docs-mcp-tools", "pricing", "docs-changelog"];
  return order.map((key) => {
    const page = byKey(key);
    return { page, markdown: page.kind === "docs" ? docsMarkdown(page) : pricingMarkdown() };
  });
}

export function llmsFullTxt(): string {
  const pages = markdownPages().map(({ page, markdown }) => `Source: ${siteUrl(page.path)}\n\n${markdown.trim()}`);
  return [intro(), ...pages].join("\n\n---\n\n") + "\n";
}

/** Every docs page and the pricing page have a Markdown version; nothing else does. */
export const MARKDOWN_KEYS: readonly string[] = [...DOCS_PAGES.map((p) => p.key), "pricing"];
