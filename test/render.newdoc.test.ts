/**
 * Library › New page (web/src/newdoc.ts, web/src/newdoc-actions.ts; design spec §6): the templates, their preview,
 * "Goes in" (a space switch or dropdown, then the space's tree), the section switch and the busy state. Pure:
 * assertions on the markup; the controller is driven with a stub host (no request is made).
 */
import { describe, it, expect, vi } from "vitest";
import { newDocView, blankDoc, whereLabel, newDocSpaceDropdown, NEW_DOC_SPACE_SWITCH_MAX, NEW_DOC_NO_SPACE, type NewDocDraft, type NewDocProps } from "../web/src/newdoc";
import { createNewDocController } from "../web/src/newdoc-actions";
import { initialDropdownUi } from "../web/src/dropdown";
import { DOC_TEMPLATES, templateBody } from "@shared/docs-templates-core";
import type { LibraryPageDTO, SpaceDTO } from "@shared/docs-core";
import type { AppState } from "../web/src/render";

const space = (slug: string, name: string): SpaceDTO => ({
  slug, name, icon: "braces", color: "#525cc3", description: "", sort_rank: 1024, created_at: "2026-10-01T00:00:00Z", created_by: "system",
  archived: false, archived_at: null, owners: [], pages: 0, waiting: 0,
});
const page = (slug: string, title: string, parent: string | null, rank: number, authority: LibraryPageDTO["authority"] = "live"): LibraryPageDTO => ({
  slug, title, space: "engineering", section: "reference", parent_slug: parent, tree_rank: rank, path: [], authority, current_version: 1,
  updated_at: null, updated_by: null, owner: null,
});
const SPACES = [space("engineering", "Engineering"), space("product", "Product")];
const PAGES = [page("runbooks", "Runbooks", null, 1), page("deploys", "Deploys", "runbooks", 1), page("rollback", "Rolling back", "deploys", 1), page("arch", "Architecture", null, 2, "unpromoted")];
const props = (draft: Partial<NewDocDraft> = {}, over: Partial<NewDocProps> = {}): NewDocProps => ({
  draft: { ...blankDoc("engineering"), ...draft }, spaces: SPACES, pages: PAGES, sections: ["reference", "context", "decisions"], dd: initialDropdownUi(), ...over,
});

describe("New page — templates and their preview", () => {
  it("the nine templates, in order, as radio cards; Runbook is picked by default with its body and section", () => {
    const d = blankDoc("engineering");
    expect(d.template).toBe("runbook");
    expect(d.section).toBe("reference");
    expect(d.body).toBe(templateBody("runbook"));
    const html = newDocView(props());
    expect([...html.matchAll(/data-tpl="([^"]+)"/g)].map((m) => m[1])).toEqual(DOC_TEMPLATES.map((t) => t.id));
    expect(html).toContain('role="radiogroup"');
    expect(html).toMatch(/aria-checked="true" data-act="ndTemplate" data-arg="runbook"/);
    expect(html).toContain('class="cnpy-nd-tpl is-blank"');
    expect(html).toContain("Pick a template");
  });

  it("the preview lists the picked template's sections; Blank says it is empty", () => {
    const html = newDocView(props());
    for (const s of ["When to use this", "Check first", "Fix it", "Roll back", "Who to tell"]) expect(html).toContain(`<div class="cnpy-nd-msl">${s}</div>`);
    const blank = newDocView(props({ template: "blank" }));
    expect(blank).toContain("An empty page, ready for you.");
    expect(blank).not.toContain("cnpy-nd-msl");
  });

  it("the title's placeholder is “Untitled ‹template›”; the section is a switch; Create page is never off for an empty title", () => {
    const html = newDocView(props());
    expect(html).toContain('placeholder="Untitled runbook"');
    expect(html).toContain('data-seg="nd-section"');
    expect(html).not.toContain("cnpy-pickchip");
    expect(html).not.toContain("<select");
    expect(html).toMatch(/data-act="ndSubmit" class="cnpy-accentbtn"[^>]*>Create page</);
    const busy = newDocView(props({ busy: true }));
    expect(busy).toContain("Creating…");
    expect(busy).toMatch(/data-act="ndSubmit"[^>]* disabled/);
    expect(newDocView(props({ error: "Couldn't create the page." }))).toContain('role="alert"');
  });
});

describe("New page — Goes in", () => {
  it("the location names the space and the parent's path", () => {
    expect(whereLabel(blankDoc("engineering"), SPACES, PAGES)).toBe("Engineering");
    expect(whereLabel({ ...blankDoc("engineering"), parent: "rollback" }, SPACES, PAGES)).toBe("Engineering › Runbooks › Deploys › Rolling back");
    expect(newDocView(props({ parent: "deploys" }))).toContain("Engineering › Runbooks › Deploys");
  });

  it("the picker: the spaces as a switch, “Top level of ‹Space›” first, the tree indented, the pick checked", () => {
    const html = newDocView(props({ where: true, parent: "deploys", whereOpen: { runbooks: true } }));
    expect(html).toContain('data-seg="nd-space"');
    const rows = [...html.matchAll(/class="cnpy-nd-wrow[^"]*" style="padding-left:(\d+)px[^>]*>[\s\S]*?data-arg="([^"]*)"[^>]*class="cnpy-nd-wpick"><span class="cnpy-nd-wt">([^<]+)</g)]
      .map((m) => [m[3], Number(m[1])]);
    expect(rows).toEqual([["Top level of Engineering", 10], ["Runbooks", 26], ["Deploys", 42], ["Architecture", 26]]);
    expect(html).toMatch(/class="cnpy-nd-wrow is-on"[^>]*>[\s\S]*?data-arg="deploys"/);
    expect(html).toContain('data-act="ndWhereToggle" data-arg="runbooks" class="cnpy-nd-wchev is-open"');
    expect(html).toContain("Not yet approved");
    expect(html).toContain('data-act="ndWhereDone"');
  });

  it("a dropdown past four spaces — never a native <select>; skeleton rows while the space's pages are out", () => {
    const many = Array.from({ length: NEW_DOC_SPACE_SWITCH_MAX + 1 }, (_, i) => space(`s${i}`, `Space ${i}`));
    const html = newDocView(props({ where: true, space: "s0" }, { spaces: many, pages: null }));
    expect(html).toContain('data-dd="nd-space"');
    expect(html).not.toContain("<select");
    expect(html).toContain("Top level of Space 0");
    expect(html).toContain("cnpy-sk");
    expect(newDocSpaceDropdown(blankDoc("s0"), many).options).toHaveLength(NEW_DOC_SPACE_SWITCH_MAX + 1);
  });

  it("no space at all (owner ruling NP19): the empty layout; New space for an admin, no action for a member", () => {
    const html = newDocView(props({}, { spaces: [] }));
    expect(html).toContain('data-empty="newdoc"');
    expect(html).toContain(NEW_DOC_NO_SPACE);
    expect(html).not.toContain("cnpy-empty-act");
    const admin = newDocView(props({}, { spaces: [], admin: true }));
    expect(admin).toMatch(/data-act="libNew"[^>]*class="cnpy-empty-act"|class="cnpy-empty-act"[^>]*data-act="libNew"/);
    expect(admin).toContain(">New space<");
  });
});

describe("New page — the controller", () => {
  function host() {
    const state = { nd: blankDoc("engineering"), library: { status: "ok", data: { spaces: SPACES } } } as unknown as AppState;
    const ensured: string[] = [];
    const ctl = createNewDocController({
      state, mount: {} as HTMLElement, rerender: () => {}, flash: () => {}, unauth: () => {},
      ensureSpace: (s) => ensured.push(s), staged: () => {}, cancel: () => {},
    });
    return { state, ctl, ensured };
  }

  it("a template switch replaces an untouched body and sets its section; an edited body is kept", () => {
    const { state, ctl } = host();
    expect(ctl.act("ndTemplate", "decision", null)).toBe(true);
    expect(state.nd.body).toBe(templateBody("decision"));
    expect(state.nd.section).toBe("decisions");
    ctl.act("ndField", "body", "my words");
    ctl.act("ndTemplate", "spec", null);
    expect(state.nd.body).toBe("my words");
    expect(state.nd.section).toBe("context");
  });

  it("picking a space clears the parent and reads that space; a row picks the parent; other acts are not its", () => {
    const { state, ctl, ensured } = host();
    ctl.start("engineering", "deploys");
    expect(state.nd.parent).toBe("deploys");
    ctl.act("ndWhereSpace", "product", null);
    expect(state.nd).toMatchObject({ space: "product", parent: null });
    expect(ensured).toEqual(["engineering", "product"]);
    ctl.act("ndWhereParent", "x", null);
    expect(state.nd.parent).toBe("x");
    ctl.act("ndWhereParent", "", null);
    expect(state.nd.parent).toBeNull();
    expect(ctl.act("libTab", null, null)).toBe(false);
  });
});

describe("New page — Create page (owner ruling NP9)", () => {
  it("stages the page, toasts \"Page created in ‹Space›\" and hands the new page's slug on so the app opens it", async () => {
    const api = await import("../web/src/api");
    const spy = vi.spyOn(api, "proposeDoc").mockResolvedValue({ ok: true, slug: "test-np9", version: 1 } as never);
    const state = { nd: { ...blankDoc("engineering"), title: "Test NP9" }, library: { status: "ok", data: { spaces: SPACES } } } as unknown as AppState;
    const flashes: string[] = [];
    const staged: string[][] = [];
    const ctl = createNewDocController({
      state, mount: {} as HTMLElement, rerender: () => {}, flash: (m) => flashes.push(m), unauth: () => {},
      ensureSpace: () => {}, staged: (s, slug) => staged.push([s, slug]), cancel: () => {},
    });
    ctl.act("ndSubmit", null, null);
    await vi.waitFor(() => expect(staged).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ title: "Test NP9", space: "engineering" }));
    expect(staged[0]).toEqual(["engineering", "test-np9"]);
    expect(flashes).toEqual(["Page created in Engineering"]);
    spy.mockRestore();
  });
});
