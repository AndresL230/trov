/**
 * Docs screen render tests — the space toggle is a FIXED {Technical, Product}
 * two-tab set. The tabs must NOT be derived from the data: exactly two tabs
 * render, always, and a doc carrying a foreign `space` can never add a third tab.
 *
 * Pure (no D1 / Miniflare); assertions are HTML-string based. markdown is mocked
 * for the same reason as the other render tests (DOMPurify needs DOM globals).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdownInline: (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>"),
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body}</div>`,
}));

import { render, initialState, DOC_SPACES } from "../web/src/render";
import type { DocRow } from "@shared/rows";

function doc(overrides: Partial<DocRow> = {}): DocRow {
  return {
    slug: "a-doc",
    section: "reference",
    title: "A Doc",
    body: "body",
    current_version: 1,
    updated_at: "2026-07-01T00:00:00Z",
    updated_by: "agent",
    space: "technical",
    owner: "agent",
    ...overrides,
  };
}

function docsState(docs: DocRow[]): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "docs",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
    docsList: { status: "ok", data: docs },
  };
}

describe("Docs spaces — picked from the sidebar, a fixed two-tab set", () => {
  it("DOC_SPACES is exactly ['technical', 'product'] in order", () => {
    expect([...DOC_SPACES]).toEqual(["technical", "product"]);
  });

  it("the sidebar's Docs sub-pages are the switcher; the header has none", () => {
    const html = render(docsState([doc()]));
    expect(html).toContain('data-act="navSub" data-arg="docs:technical"');
    expect(html).toContain('data-act="navSub" data-arg="docs:product"');
    expect(html).not.toContain('data-act="setDocSpace"');
    expect(html).toContain('data-act="newDoc"');
  });

  it("both sub-pages render even when the data has only one space present", () => {
    const html = render(docsState([doc({ space: "technical" })]));
    expect(html).toContain('data-arg="docs:technical"');
    expect(html).toContain('data-arg="docs:product"');
  });

  it("a doc with a foreign space never adds a third sub-page", () => {
    const html = render(docsState([doc({ slug: "stray", space: "sapling" })]));
    expect(html).not.toContain('data-arg="docs:sapling"');
    expect((html.match(/data-arg="docs:/g) ?? []).length).toBe(2);
  });
});

describe("Docs — a doc's people open their person card", () => {
  it("the header's photo and @handle and each version row's chip are buttons; an unknown handle stays plain", async () => {
    const { docReaderHtml } = await import("../web/src/render");
    const v = (version: number, by: string) => ({ id: version, slug: "a-doc", version, body: "b", summary: `v${version}`, status: "promoted" as const, confidence: null, created_at: "2026-07-01T00:00:00Z", created_by: by, content_hash: null, base_version: null, change_kind: null, low_confidence: 0 });
    const s = {
      ...docsState([doc()]), docSlug: "a-doc", showHistory: true,
      persons: { status: "ok" as const, data: [{ handle: "meilin", name: "Meilin Zhao", color: "rose" as const, avatar_url: null, role: null }] },
      docDetail: { status: "ok" as const, data: { doc: doc({ updated_by: "meilin" }), versions: [v(2, "meilin"), v(1, "ghost")] } },
    };
    const html = docReaderHtml(s);
    expect(html).toMatch(/<button data-act="openPerson" data-arg="meilin" class="cnpy-personav"/);
    expect(html).toMatch(/Updated by <button data-act="openPerson" data-arg="meilin" class="cnpy-personlink"/);
    expect(html).toMatch(/<button data-act="openPerson" data-arg="meilin" class="cnpy-personchip"/);
    expect(html).not.toContain('data-act="openPerson" data-arg="ghost"');
    expect(html).toContain("@ghost");
  });
});
