// The landing's Questions: what people ask about the product, before the pricing questions (pricing.ts
// `pricingQuestions`, which /pricing shows on its own). The landing shows the whole list in one accordion
// (`pricingSection`'s `lead`), and the SAME list is its FAQPage structured data (site-prerender.ts →
// shared/site-pages.ts `faqPageLd`) — the one page that shows every question, so the one that marks
// them up (test/site-pages.test.ts holds the two together).
//
// Each answer is TRUE to the code: the MCP endpoint is SITE_ORIGIN's, the sign-in is the OAuth server
// in src/auth/oauth.ts (RFC 9728 metadata, RFC 7591 registration, https or loopback redirects only),
// and a client named here is one whose sign-in that server accepts (docs-content.ts, Connect).
// Each thing is said once (landing.ts): sign-up, prices and the source are said elsewhere and linked.

import { SITE_ORIGIN, pagePath } from "@shared/site-pages";
import { OFFERED_PLAN_IDS, PLANS } from "@shared/plans";
import { PRICING } from "@shared/pricing";
import { pricingQuestions, type PricingQuestion } from "./pricing";

export function productQuestions(): PricingQuestion[] {
  return [
    {
      q: "What is Trov?",
      a: "Trov is shared memory for a software team and its coding agents: the team's docs, decisions, roadmap, ticket queue and a feed of what shipped, in one place. People use it in the browser; agents read and write it over MCP. Agents propose changes, and a person approves what becomes official.",
    },
    {
      q: "How is it different from a README or a wiki?",
      a: `A README or a wiki is text someone has to remember to update, and an agent reading it cannot tell a settled page from a stale one. In Trov, agents load what the team already decided before they work and write back what actually shipped when they finish. Every result tells an agent whether it is settled or only proposed, every version is kept, and nothing becomes official until a person approves it. <a href="${pagePath("docs-concepts")}">How that works</a>.`,
    },
    {
      q: "Does it work with Claude Code, Cursor and other MCP clients?",
      a: `Yes. Trov is a remote MCP server at ${SITE_ORIGIN}/mcp, over Streamable HTTP. A client that supports MCP's OAuth sign-in finds everything it needs on its own and opens Trov in your browser: Claude Code, Claude Desktop and claude.ai, VS Code, Codex, and recent versions of Cursor. A client that cannot sign in can send a Trov token you already have as a header. Claude Code also has a plugin with the skills that run the loop. <a href="${pagePath("docs-connect")}">Setup for each client</a>.`,
    },
  ];
}

/** Every question the landing shows, in its order: the product's, then the pricing ones. */
export function landingQuestions(): PricingQuestion[] {
  return [...productQuestions(), ...pricingQuestions(OFFERED_PLAN_IDS.map((id) => PLANS[id]), PRICING)];
}
