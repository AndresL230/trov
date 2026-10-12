/**
 * The compliance pass (2026-10-12), the Worker's side: the pages it renders itself (the MCP OAuth sign-in and
 * consent pages, the billing notices) carry the consent sentence where an account can be made and the legal
 * and source links on every one; the paid confirmation mail carries the renewal and cancellation terms; the
 * MCP server says where the source is; `/source` answers even without the build's redirect; the sitemap
 * lists the refund policy. The site and the app: legal.compliance.test.ts.
 */
import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { SOURCE_PATH, TROV_SOURCE_REPO, consentHtml, copyrightLine } from "../shared/legal-core";
import { sitemapXml } from "../src/site";
import { signInPage, consentPage, errorPage, noOrgPage, shell } from "../src/auth/oauth-pages";
import { unavailablePage, enterprisePage } from "../src/billing/pages";
import { renderGrantEmail } from "../src/notifications/grant";
import { mcpInstructions } from "../src/mcp";

describe("the Worker's own pages", () => {
  it("the MCP OAuth sign-in page, where a new person can be created, says what continuing agrees to", () => {
    expect(signInPage("Claude Code")).toContain(`<p class="consent" data-consent>${consentHtml()}</p>`);
  });

  it("every one ends with the legal pages, the source of the running version and who runs Trov", () => {
    const pages = [
      signInPage("Claude Code"), errorPage("nope"), noOrgPage("C", "kim"), unavailablePage(), enterprisePage(), shell("x", "<p>y</p>"),
      consentPage({ clientName: "C", redirectHost: "localhost", handle: "kim", orgs: [{ slug: "a", name: "A" }], hidden: {}, csrf: "t" }),
    ];
    for (const html of pages) {
      expect(html).toContain('<nav class="legal" aria-label="Legal and source">');
      for (const [path, label] of [["/terms", "Terms"], ["/privacy", "Privacy"], ["/refunds", "Refunds"], [SOURCE_PATH, "Source code (AGPL-3.0)"]]) {
        expect(html).toContain(`<a href="${path}">${label}</a>`);
      }
      expect(html).toContain(copyrightLine());
    }
  });
});

describe("the paid confirmation mail", () => {
  it("carries the renewal and cancellation terms and the policy; a gift's does not", () => {
    const grant = { granterName: null, planName: "Pro", planDescription: "d", email: "g@x.io", signInUrl: "https://trov.test/", host: "trov.test" };
    const paid = renderGrantEmail({ ...grant, paid: true });
    expect(paid.text).toContain("Pro renews automatically each month, on the day of the month you subscribed, at $10 per seat plus any applicable tax, until you cancel.");
    expect(paid.text).toContain("Cancel plan, or Manage billing");
    expect(paid.text).toContain("no refunds for partial periods, except where the law requires one");
    expect(paid.text).toContain("Refund and cancellation policy: https://trov.test/refunds");
    expect(paid.html).toContain('href="https://trov.test/refunds"');
    expect(paid.html).toContain('href="https://trov.test/terms"');
    expect(paid.html).not.toMatch(/unsubscribe/i); // transactional
    expect(renderGrantEmail(grant).text).not.toContain("renews automatically");
  });
});

describe("AGPL-3.0 §13 on the Worker", () => {
  it("the MCP server tells a connecting client where the source is, and the terms", () => {
    const text = mcpInstructions("https://trov.dev");
    expect(text).toContain("https://trov.dev/source");
    expect(text).toContain("AGPL-3.0");
    expect(text).toContain("https://trov.dev/terms");
    expect(text).toContain("https://trov.dev/privacy");
  });

  it("/source still goes somewhere true when the assets binding's rule is missing: the repository, never cached", async () => {
    const res = await worker.fetch(new Request(`https://trov.test${SOURCE_PATH}`), env, createExecutionContext());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(TROV_SOURCE_REPO);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("the sitemap lists the refund policy", () => {
    expect(sitemapXml()).toContain("<loc>https://trov.dev/refunds</loc>");
  });
});
