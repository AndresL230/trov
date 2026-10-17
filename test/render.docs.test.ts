/**
 * Docs screen render tests — the reader (`#doc/<slug>`, the screen `docs`) in the Docs Library: its tree lists
 * the docs of the open doc's space, and a space is one of the ORG's own (the Library's read), never a fixed
 * Technical / Product pair. The sidebar's Library group is the switcher (render.sidebar.test.ts holds its rows).
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

import { render, initialState, spaceName } from "../web/src/render";
import { newDocView, blankDoc, NEW_DOC_SPACE_SWITCH_MAX } from "../web/src/newdoc";
import type { DocRow } from "@shared/rows";
import type { SpaceDTO } from "@shared/docs-core";

function doc(overrides: Partial<DocRow> = {}): DocRow {
  return {
    slug: "a-doc",
    section: "reference",
    title: "A Doc",
    body: "body",
    current_version: 1,
    updated_at: "2026-07-01T00:00:00Z",
    updated_by: "agent",
    space: "engineering",
    owner: "agent",
    parent_slug: null,
    tree_rank: null,
    ...overrides,
  } as DocRow;
}

const space = (slug: string, name: string, over: Partial<SpaceDTO> = {}): SpaceDTO => ({
  slug, name, icon: "braces", color: "#525cc3", description: "", sort_rank: 1024, created_at: "2026-10-01T00:00:00Z", created_by: "system",
  archived: false, archived_at: null, owners: [], pages: 0, waiting: 0, ...over,
});
const SPACES = [space("engineering", "Engineering"), space("product", "Product", { icon: "compass", color: "#2f7d57" }), space("security", "Security", { icon: "shield", color: "#b4562c" })];

function docsState(docs: DocRow[], spaces: SpaceDTO[] = SPACES): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s,
    view: "app",
    screen: "docs",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
    library: { status: "ok", data: { spaces, archived: [], recent: [], waiting: 0, can_admin: false } },
    // GET /docs carries each doc's outline, never its body.
    docsList: { status: "ok", data: docs.map(({ body: _body, ...meta }) => ({ ...meta, outline: [] })) },
  };
}

describe("Docs spaces — the org's own, from the Library read", () => {
  it("the sidebar's Library group lists every live space the read has, in its order — none is fixed", () => {
    const html = render(docsState([doc()]));
    const aside = html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
    expect([...aside.matchAll(/data-act="navSub" data-arg="library:([^"]+)"/g)].map((m) => m[1])).toEqual(["engineering", "product", "security"]);
    expect(aside).not.toContain("docs:technical");
    expect(html).not.toContain('data-act="setDocSpace"');
    expect(html).toContain('data-act="newDoc"');
  });

  it("a doc with a space the Library does not list never adds a row", () => {
    const html = render(docsState([doc({ slug: "stray", space: "sapling" })]));
    expect(html).not.toContain('data-arg="library:sapling"');
    expect((html.match(/data-arg="library:/g) ?? []).length).toBe(3);
  });

  it("the tree lists the open doc's space only; the breadcrumb and the header crumb name the space", () => {
    const s = { ...docsState([doc(), doc({ slug: "brief", title: "Pricing brief", space: "product" })]), docSlug: "a-doc", docSpace: "engineering",
      docDetail: { status: "ok" as const, data: { doc: doc(), versions: [] } } };
    const html = render(s);
    expect(html).toContain('data-act="openDoc" data-arg="a-doc"');
    expect(html).not.toContain('data-act="openDoc" data-arg="brief"');
    expect(html).toContain('data-act="libOpenSpace" data-arg="engineering"');
    expect(html).toContain(">Engineering</button> <span");
    // Header: "Library › Engineering", the title the way back to Library home.
    expect(html).toContain('<button data-act="goLibrary"');
    expect(html).toMatch(/›<\/span><span[^>]*>Engineering<\/span>/);
  });

  it("a space the read does not list is named by its slug, never guessed", () => {
    expect(spaceName({ library: { status: "ok", data: { spaces: [], archived: [], recent: [], waiting: 0, can_admin: false } } }, "ops")).toBe("Ops");
    expect(spaceName({ library: { status: "ok", data: { spaces: SPACES, archived: [], recent: [], waiting: 0, can_admin: false } } }, "security")).toBe("Security");
  });
});

describe("New page — the Space picker is the org's live spaces", () => {
  const props = (n: number) => ({ draft: blankDoc("s1", ""), spaces: Array.from({ length: n }, (_, i) => ({ key: `s${i + 1}`, label: `Space ${i + 1}` })), sections: ["reference", "context", "decisions"] });
  it(`a switch up to ${NEW_DOC_SPACE_SWITCH_MAX} spaces, preset to where it was opened`, () => {
    const html = newDocView(props(NEW_DOC_SPACE_SWITCH_MAX));
    expect(html).toContain('data-seg="nd-space"');
    expect(html).toContain("Space 4");
    expect(html).not.toContain('data-dd="nd-space"');
  });
  it("a dropdown past that — never a native <select>", () => {
    const html = newDocView(props(NEW_DOC_SPACE_SWITCH_MAX + 1));
    expect(html).toContain('data-dd="nd-space"');
    expect(html).not.toContain("<select");
    expect(html).toContain('<span class="cnpy-dd-v">Space 1</span>');
  });
  it("render() offers the Library's spaces, and Cancel goes back to the space", () => {
    const s = { ...docsState([]), screen: "newdoc" as const, nd: blankDoc("product", "") };
    const html = render(s);
    expect(html).toContain(">Engineering<");
    expect(html).toContain(">Security<");
    expect(html).toContain('data-act="ndCancel"');
    expect(html).toMatch(/›<\/span><span[^>]*>New page<\/span>/);
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

describe("Docs tree — each page's outline is the one GET /docs sent", () => {
  it("draws the server's outline (no body needed), and no chevron for a doc without headings", () => {
    const s = docsState([doc(), doc({ slug: "plain", title: "Plain" })]);
    s.docsList = { status: "ok", data: [
      { ...s.docsList.data[0], outline: [{ level: 2, text: "Setup", id: "setup" }, { level: 3, text: "Keys", id: "keys" }] },
      s.docsList.data[1],
    ] };
    const html = render(s);
    expect(html).toContain('data-act="scrollToHeading" data-arg="a-doc::setup" class="cnpy-outline-item"');
    expect(html).toContain('data-act="scrollToHeading" data-arg="a-doc::keys" class="cnpy-outline-item lvl3"');
    expect(html).toContain('data-act="toggleOutline" data-arg="a-doc"');
    expect(html).not.toContain('data-act="toggleOutline" data-arg="plain"');
  });
});
