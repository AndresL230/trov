// Handoffs + Prompt Library + New doc — the ported views over the real API shapes
// (numeric handoff ids rendered `#12`, the write affordances each screen offers).
import { describe, it, expect } from "vitest";
import { handoffsView, handoffDetailView, handoffAsPrompt, docDraftFromHandoff, newHandoffView, blankHandoff } from "../web/src/handoffs";
import { promptDetailView, promptLibraryView, filterPrompts, promptEditorView, blankPromptDraft } from "../web/src/prompts";
import { newDocView, blankDoc } from "../web/src/newdoc";
import type { HandoffView, PromptSummary, PromptDetail, PromptVersion } from "../shared/handoffs";
import { canDeletePrompt, render, initialState } from "../web/src/render";
import confirmSrc from "../web/src/confirm.ts?raw";
import { confirmKeyAction } from "../web/src/confirm";
import promptsSrc from "../web/src/prompts.ts?raw";
import mainSrc from "../web/src/main.ts?raw";

/** The one `.cnpy-sfbar` (search + Filter) element in `html`, balanced by its divs — or null. */
function sfbar(html: string): string | null {
  const start = html.indexOf('<div class="cnpy-sfbar"');
  if (start < 0 || html.indexOf('<div class="cnpy-sfbar"', start + 1) >= 0) return null;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + 6);
  }
  return null;
}

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null, role: null },
  { handle: "Darkest-Teddy", name: "Jack", color: "plum" as const, avatar_url: null, role: null },
];
const h = (over: Partial<HandoffView> = {}): HandoffView => ({
  id: 12, sender: "Darkest-Teddy", recipient: "AndresL230", status: "pending",
  created_at: "2026-09-23T10:00:00Z", claimed_at: null, claimed_by: null, claimed_by_session: null,
  prompt: null, body: "Quiz agent still fails.\n\nMore detail.",
  context: { repo: "SaplingLearn/sapling", branch: "fix/quiz", task: "Get failures under 1%", done: ["Parser"], next: ["Prompt", "Eval"], files: ["a.py"] },
  ...over,
});

describe("handoffs — numeric ids", () => {
  it("list rows carry the numeric id as data-arg and render #12", () => {
    const html = handoffsView({ status: "ok", handoffs: [h()], me: "AndresL230", persons });
    expect(html).toContain('data-act="openHandoff" data-arg="12"');
    expect(html).toContain("#12");
  });

  // A one-line body: the rest would go through marked + DOMPurify, which needs a DOM.
  it("a pending handoff offers Claim, Promote to doc and Expire; a claimed one offers Copy instead", () => {
    const pending = handoffDetailView({ status: "ok", handoff: h({ body: "Quiz agent still fails." }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    expect(pending).toContain('data-act="handoffClaim" data-arg="12"');
    expect(pending).toContain('data-act="handoffPromote" data-arg="12"');
    expect(pending).toContain('data-act="handoffExpire" data-arg="12"');
    const claimed = handoffDetailView({ status: "ok", handoff: h({ body: "Quiz agent still fails.", status: "claimed", claimed_by: "AndresL230", claimed_at: "2026-09-23T11:00:00Z" }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    expect(claimed).toContain('data-act="handoffCopy" data-arg="12"');
    expect(claimed).not.toContain('data-act="handoffClaim"');
    expect(claimed).not.toContain('data-act="handoffExpire"');
  });

  it("copy-as-prompt names the handoff #12", () => {
    expect(handoffAsPrompt(h()).split("\n")[0]).toBe("HANDOFF #12 · from @Darkest-Teddy · to @AndresL230");
  });

  it("Promote to doc prefills the design's shape", () => {
    const d = docDraftFromHandoff(h());
    expect(d.title).toBe("Get failures under 1%");
    expect(d.summary).toBe("Promoted from handoff #12");
    expect(d.body).toContain("## What's done\n\n- Parser");
    expect(d.body).toContain("## Files\n\n- `a.py`");
    expect(docDraftFromHandoff(h({ context: { ...h().context, task: "" } })).title).toBe("Quiz agent still fails.");
  });
});

describe("new doc — the FROM HANDOFF banner", () => {
  const spaces = [{ key: "technical", label: "Technical" }];
  it("shows only when promoted from a handoff, linking back to it", () => {
    expect(newDocView({ draft: blankDoc("technical", ""), spaces, sections: ["reference"] })).not.toContain("FROM HANDOFF");
    const html = newDocView({ draft: { ...blankDoc("technical", ""), from: 12 }, spaces, sections: ["reference"] });
    expect(html).toContain("FROM HANDOFF");
    expect(html).toContain('data-act="openHandoff" data-arg="12"');
  });
});

describe("prompts", () => {
  const detail: PromptDetail = { slug: "lint", title: "Lint", description: "", tags: ["ui"], author: "Darkest-Teddy", version: 3, status: "staged", updated_at: "2026-09-23T10:00:00Z", body: "Lint {{path}}.", use_count: 0, last_used_at: null };
  const v = (version: number, status: PromptVersion["status"]): PromptVersion => ({ version, status, author: "Darkest-Teddy", created_at: "2026-09-20T10:00:00Z", summary: "s", body: "b" });
  const props = { status: "ok" as const, prompt: detail, persons, knownTags: [], diffVersion: null, tagMenu: false, tagDraft: "", promptView: "raw" as const, canDelete: false, deleteArm: false };

  it("offers Publish vN only while a staged version exists", () => {
    expect(promptDetailView({ ...props, versions: [v(3, "staged"), v(2, "published")] })).toContain('data-act="promptPublish" data-arg="3"');
    expect(promptDetailView({ ...props, versions: [v(2, "published")] })).not.toContain("promptPublish");
  });

  it("shows its body in the SAME prompt box a handoff's prompt uses", () => {
    const page = promptDetailView({ ...props, versions: [v(3, "staged")] });
    const handoff = handoffDetailView({ status: "ok", handoff: h({ body: "Quiz agent still fails.", prompt: { title: "Fix it", body: "Step 1." } }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    // One component: same class, same copy + expand icon buttons, same raw mono body.
    for (const html of [page, handoff]) {
      expect(html).toContain('class="cnpy-promptbox cnpy-surface"');
      expect(html).toContain('title="Copy prompt"');
      expect(html).toContain('title="Expand"');
    }
    expect(page).toContain('data-act="promptCopy"');
    expect(page).toContain('data-act="promptExpand"');
    expect(page).toContain("Lint {{path}}."); // the raw body — the old accent-highlighted variables are gone
    expect(page).not.toContain("background:var(--accent-soft);border-radius:4px;padding:0 3px");
  });

  it("the prompt box carries a Raw / Rendered switch; Raw shows the markdown source", () => {
    // (The Rendered branch runs DOMPurify, which needs a DOM this suite lacks — it is
    // exercised in the browser instead.)
    const body = "## Steps\n\n- read `src/mcp.ts`";
    const raw = promptDetailView({ ...props, prompt: { ...detail, body }, versions: [v(3, "staged")] });
    expect(raw).toContain('<button type="button" class="cnpy-seg-btn is-on" data-act="promptBoxView" data-arg="raw" aria-pressed="true"');
    expect(raw).toContain('<button type="button" class="cnpy-seg-btn" data-act="promptBoxView" data-arg="rendered" aria-pressed="false"');
    expect(raw).toContain('data-seg="prompt-view"');
    expect(raw).toContain("## Steps"); // the source, escaped, in the mono block
    expect(handoffDetailView({ status: "ok", handoff: h({ body: "x", prompt: { title: "t", body } }), me: "AndresL230", persons, expireArm: false, promptView: "raw" }))
      .toContain('data-act="promptBoxView" data-arg="rendered"');
  });

  it("the library's search and Filter are ONE combined control (.cnpy-sfbar)", () => {
    const lib = { status: "ok" as const, prompts: [], q: "sse", tag: null, sort: "updated_desc" as const, persons, filterCat: "tag" as const, fmOpening: null, filterOpen: false };
    const bar = sfbar(promptLibraryView(lib));
    expect(bar).not.toBeNull();
    expect(bar).toContain('data-act="promptQuery" data-field="promptQuery"');
    expect(bar).toContain('placeholder="Search titles, slugs and bodies"');
    expect(bar).toContain('value="sse"');
    expect(bar).toContain('data-act="fmToggle" data-arg="prompt"');
    expect(bar).not.toContain("data-hover-blur");
    // The open popover hangs from the bar too; its backdrop sits outside the hover wrapper.
    const open = sfbar(promptLibraryView({ ...lib, filterOpen: true }))!;
    expect(open).toContain('data-fm-pop="prompt"');
    expect(open.indexOf('data-act="fmClose" data-arg="prompt" style="position:fixed')).toBeLessThan(open.indexOf('data-hover-menu="prompt"'));
  });

  it("the library's filter is the shared filter menu, with Tag AND Sort", () => {
    const s = (slug: string, tags: string[]): PromptSummary => ({ slug, title: slug, tags, author: "a", version: 1, status: "published", updated_at: "2026-09-01T00:00:00Z", excerpt: "x", use_count: 0, last_used_at: null });
    const lib = { status: "ok" as const, prompts: [s("a", ["api"]), s("b", ["ui"])], q: "", tag: null, sort: "updated_desc" as const, persons, filterCat: "tag" as const, fmOpening: null };
    const closed = promptLibraryView({ ...lib, filterOpen: false });
    expect(closed).toContain('data-hover-menu="prompt"');
    expect(closed).toContain('data-act="fmToggle" data-arg="prompt"');
    const open = promptLibraryView({ ...lib, filterOpen: true, sort: "updated_asc" });
    expect(open).toContain('data-arg="prompt:tag"');
    expect(open).toContain('data-arg="prompt:sort"');
    // Sort keeps both orders; a non-default sort counts as an active filter (the badge).
    expect(open).toContain('data-act="promptSort" data-arg="updated_desc"');
    expect(open).toContain('data-act="promptSort" data-arg="updated_asc"');
    expect(open).toContain(">Least recently updated<");
    expect(open).toMatch(/Filter\s*<span[^>]*>1<\/span>/);
    expect(open).toContain('data-act="promptResetFilters"');
  });

  it("filters the library by text and tag without a description field", () => {
    const s = (slug: string, tags: string[]): PromptSummary => ({ slug, title: slug, tags, author: "a", version: 1, status: "published", updated_at: "2026-09-01T00:00:00Z", excerpt: "x", use_count: 0, last_used_at: null });
    const list = [s("sse-review", ["api"]), s("mdx-lint", ["ui"])];
    expect(filterPrompts(list, "sse", null, "updated_desc").map((p) => p.slug)).toEqual(["sse-review"]);
    expect(filterPrompts(list, "", "ui", "updated_desc").map((p) => p.slug)).toEqual(["mdx-lint"]);
  });
});

// The surface card (trov.css `.cnpy-surface`) replaced each screen's hand-rolled bordered,
// 2.5%-tinted card: the class owns background, hairline, radius and shadow.
describe("surface cards — handoffs, prompts, new doc", () => {
  const OLD_TINT = "color-mix(in srgb,var(--fg) 2.5%";
  const OLD_CARD = /border:1px solid var\(--border\);border-radius:1[1-3]px/;
  const summary = (slug: string): PromptSummary => ({ slug, title: slug, tags: [], author: "a", version: 1, status: "published", updated_at: "2026-09-01T00:00:00Z", excerpt: "x", use_count: 0, last_used_at: null });

  it("the handoff inbox's row container and the detail's Where-it-stands panel are surfaces", () => {
    const list = handoffsView({ status: "ok", handoffs: [h()], me: "AndresL230", persons });
    expect(list).toContain('class="cnpy-surface" style="overflow:hidden;margin-top:10px"');
    expect(list).not.toMatch(OLD_CARD);
    const detail = handoffDetailView({ status: "ok", handoff: h({ body: "Quiz agent still fails." }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    expect(detail).toContain('class="cnpy-surface" style="flex:1 1 290px;min-width:0;padding:18px 20px"');
    expect(detail).not.toContain(OLD_TINT);
    expect(detail).not.toMatch(OLD_CARD);
  });

  it("the prompt box is a surface; its body keeps the faint text well inside", () => {
    const detail = handoffDetailView({ status: "ok", handoff: h({ body: "x", prompt: { title: "t", body: "b" } }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    expect(detail).toMatch(/class="cnpy-promptbox cnpy-surface" style="position:relative;flex:1;display:flex;flex-direction:column;margin-top:0px;overflow:hidden"/);
    // The one remaining 2.5% tint is the scroll well under the header, not a card background.
    expect(detail.split(OLD_TINT).length - 1).toBe(1);
    expect(detail).toContain(`class="cnpy-scroll" style="flex:1 1 0;min-height:180px;min-width:0;overflow:auto;background:${OLD_TINT},transparent)"`);
  });

  it("the prompt library's cards are clickable surfaces", () => {
    const lib = promptLibraryView({ status: "ok", prompts: [summary("a"), summary("b")], q: "", tag: null, sort: "updated_desc", persons, filterCat: "tag", fmOpening: null, filterOpen: false });
    expect((lib.match(/<div class="cnpy-surface cnpy-card cnpy-hitbox"/g) ?? []).length).toBe(2);
    expect((lib.match(/<button data-act="openPrompt" data-arg="[ab]" class="cnpy-hit"/g) ?? []).length).toBe(2);
    expect(lib).not.toMatch(OLD_CARD);
  });

  it("the three form cards (prompt editor, new handoff, new doc) are surfaces", () => {
    const FORM = 'class="cnpy-surface" style="padding:26px 28px;display:flex;flex-direction:column;min-height:calc(100vh - 210px)"';
    const editor = promptEditorView({ draft: blankPromptDraft(), takenSlugs: [] });
    const handoff = newHandoffView({ draft: blankHandoff(), me: "AndresL230", persons });
    const doc = newDocView({ draft: { ...blankDoc("technical", ""), from: 12 }, spaces: [{ key: "technical", label: "Technical" }], sections: ["reference"] });
    for (const html of [editor, handoff, doc]) {
      expect(html).toContain(FORM);
      expect(html).not.toMatch(OLD_CARD);
      expect(html).not.toContain(OLD_TINT);
    }
    // The FROM HANDOFF banner is a surface that keeps its accent edge.
    expect(doc).toContain('class="cnpy-surface" style="border-left:2px solid var(--accent);padding:11px 15px;');
  });
});

// ── Delete prompt (0035 PART C): author / admin only, an IN-APP confirm, an Undo toast ──
describe("prompt delete", () => {
  const detail: PromptDetail = { slug: "lint", title: "Lint", description: "", tags: [], author: "Darkest-Teddy", version: 2, status: "published", updated_at: "2026-09-23T10:00:00Z", body: "Lint.", use_count: 0, last_used_at: null };
  const versions: PromptVersion[] = [2, 1].map((n) => ({ version: n, status: "published" as const, author: "Darkest-Teddy", created_at: "2026-09-20T10:00:00Z", summary: "s", body: "b" }));
  const props = { status: "ok" as const, prompt: detail, versions, persons, knownTags: [], diffVersion: null, tagMenu: false, tagDraft: "", promptView: "raw" as const };
  const me = (handle: string, admin: boolean) => ({ handle, name: null, avatar_url: null, color: "moss" as const, identities: [], org: "SaplingLearn", admin });

  it("offers Delete prompt only to its author or an admin (canDeletePrompt, case-insensitive)", () => {
    const state = (m: ReturnType<typeof me>) => ({ me: m, promptDetail: { status: "ok" as const, data: { prompt: detail, versions } } });
    expect(canDeletePrompt(state(me("darkest-teddy", false)))).toBe(true);
    expect(canDeletePrompt(state(me("someone", true)))).toBe(true);
    expect(canDeletePrompt(state(me("someone", false)))).toBe(false);
    expect(promptDetailView({ ...props, canDelete: false, deleteArm: false })).not.toContain("promptDeleteArm");
    const html = promptDetailView({ ...props, canDelete: true, deleteArm: false });
    expect(html).toContain('data-act="promptDeleteArm"');
    expect(html).toContain("Delete prompt");
    expect(html).toContain('class="cnpy-dangerbtn" aria-haspopup="dialog" aria-expanded="false"');
    expect(html).not.toContain('role="alertdialog"'); // the confirm opens only when armed
  });

  it("confirms in a MODAL at the app root — an alertdialog, Delete focused so Enter confirms — never window.confirm", () => {
    const at = (arm: boolean, busy = false, vs = versions) => render({
      ...initialState(), view: "app", screen: "prompt", me: me("Darkest-Teddy", false),
      promptDetail: { status: "ok", data: { prompt: detail, versions: vs } }, promptDeleteArm: arm, promptDeleteBusy: busy,
    });
    expect(at(false)).not.toContain('role="alertdialog"'); // the modal opens only when armed
    const html = at(true);
    // The trigger stays a trigger (it only opens); the page shows it expanded.
    expect(html).toMatch(/data-act="promptDeleteArm" data-confirm-trigger class="cnpy-dangerbtn" aria-haspopup="dialog" aria-expanded="true" aria-controls="prompt-delete-confirm"/);
    // One root-level overlay: backdrop (a click cancels) + the centered surface dialog.
    const modal = html.slice(html.indexOf('data-overlay="confirm-prompt-delete-confirm"'));
    expect(modal).toContain('class="cnpy-cmodal"');
    expect(modal).toMatch(/<div data-act="promptDeleteCancel" class="cnpy-cmodal-back" aria-hidden="true">/);
    expect(modal).toContain('id="prompt-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="prompt-delete-confirm-t" aria-describedby="prompt-delete-confirm-d" tabindex="-1" data-confirm-dialog data-confirm-act="promptDelete" data-confirm-cancel="promptDeleteCancel" class="cnpy-surface cnpy-cmodal-box"');
    expect(modal).toContain('<div id="prompt-delete-confirm-t"');
    expect(modal).toContain("Delete “Lint”?");
    expect(modal).toContain("All 2 versions are kept");
    expect(at(true, false, versions.slice(1))).toContain("Its one version is kept");
    // Cancel, then the red Delete — the one focused on open (data-confirm-focus), so Enter / Space press it.
    expect(modal).toMatch(/data-act="promptDeleteCancel" class="cnpy-outlinebtn"[^>]*>Cancel</);
    expect(modal).toMatch(/data-act="promptDelete" data-confirm-focus class="cnpy-confirm-go"[^>]*>Delete</);
    expect((modal.match(/data-confirm-focus/g) ?? []).length).toBe(1);
    // Busy: both buttons disabled, the dialog marked, the label says so.
    const busy = at(true, true);
    expect(busy).toContain("Deleting…");
    expect(busy).toMatch(/data-confirm-dialog [^>]*data-busy/);
    expect((busy.match(/ disabled/g) ?? []).length).toBeGreaterThanOrEqual(2);
    for (const src of [confirmSrc, promptsSrc, mainSrc]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments may NAME it
      expect(code).not.toMatch(/window\.confirm|\bconfirm\(|\balert\(/);
    }
  });

  it("the keyboard contract: Enter confirms ONCE, Escape cancels, Tab is trapped (confirmKeyAction)", () => {
    const k = (key: string, o: Partial<{ onDialogButton: boolean; busy: boolean; repeat: boolean }> = {}) =>
      confirmKeyAction(key, { onDialogButton: false, busy: false, repeat: false, ...o });
    expect(k("Enter", { onDialogButton: true })).toBe("native"); // the focused Delete's own click
    expect(k("Enter")).toBe("confirm");                           // Enter on the dialog / the page
    expect(k("Enter", { repeat: true })).toBe("swallow");         // a held key never repeats the delete
    expect(k("Enter", { busy: true })).toBe("swallow");           // nor does a second press while it runs
    expect(k("Enter", { busy: true, onDialogButton: true })).toBe("swallow");
    expect(k("Escape")).toBe("cancel");
    expect(k("Escape", { busy: true })).toBe("swallow");
    expect(k("Tab")).toBe("trap");
    expect(k("a")).toBeNull();
    // main.ts wires it once, in the capture phase, for every [data-confirm-dialog].
    expect(mainSrc).toMatch(/confirmKeyAction\(e\.key/);
    expect(mainSrc).toMatch(/querySelector<HTMLElement>\("\[data-confirm-dialog\]"\)/);
  });

  it("the toast carries the Undo button that restores it", () => {
    const html = render({
      ...initialState(), view: "app", me: me("alice", false),
      toast: "Deleted “Lint”", toastAction: { label: "Undo", act: "promptRestore", arg: "lint" }, toastAt: Date.now(), toastMs: 8000,
    });
    expect(html).toContain('class="cnpy-toast" role="status" aria-live="polite"');
    expect(html).toContain("Deleted “Lint”");
    expect(html).toContain('data-act="promptRestore" data-arg="lint" class="cnpy-toast-act"');
    expect(render({ ...initialState(), view: "app", me: me("alice", false), toast: "Saved", toastAt: Date.now(), toastMs: 2000 })).not.toContain("cnpy-toast-act");
  });
});

describe("handoffs and prompts — people open their person card", () => {
  it("an inbox row's other party is one photo + name chip over the row's hit area; Anyone stays plain", () => {
    const html = handoffsView({ status: "ok", handoffs: [h(), h({ id: 13, sender: "AndresL230", recipient: "anyone" })], me: "AndresL230", persons });
    expect(html).toMatch(/<button data-act="openPerson" data-arg="Darkest-Teddy" class="cnpy-personchip"/);
    expect(html).toContain('<button data-act="openHandoff" data-arg="12" class="cnpy-hit" aria-label="#12 Quiz agent still fails."></button>');
    expect(html).not.toMatch(/<button[^>]*class="cnpy-trow/);
    expect(html).not.toContain('data-arg="anyone"');
  });

  it("the detail's sender → recipient and the claimer are name buttons (You opens your own card)", () => {
    const html = handoffDetailView({ status: "ok", handoff: h({ body: "x", status: "claimed", claimed_by: "Darkest-Teddy", claimed_at: "2026-09-23T11:00:00Z" }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    expect(html).toMatch(/<button data-act="openPerson" data-arg="Darkest-Teddy" class="cnpy-personlink"[^>]*>Jack<\/button> → <button data-act="openPerson" data-arg="AndresL230" class="cnpy-personlink"[^>]*>You<\/button>/);
    expect(html).toMatch(/Claimed by <button data-act="openPerson" data-arg="Darkest-Teddy"/);
  });

  it("a prompt card's author and the prompt page's Author rail are chips; an unknown author is plain", () => {
    const card = (author: string): PromptSummary => ({ slug: "p", title: "P", tags: [], author, version: 1, status: "published", updated_at: "2026-09-01T00:00:00Z", excerpt: "x", use_count: 0, last_used_at: null });
    const lib = promptLibraryView({ status: "ok", prompts: [card("Darkest-Teddy")], q: "", tag: null, sort: "updated_desc", persons, filterCat: "tag", fmOpening: null, filterOpen: false });
    expect(lib).toMatch(/<button data-act="openPerson" data-arg="Darkest-Teddy" class="cnpy-personchip"/);
    expect(lib).toContain('<button data-act="openPrompt" data-arg="p" class="cnpy-hit" aria-label="P"></button>');
    const stranger = promptLibraryView({ status: "ok", prompts: [card("ghost")], q: "", tag: null, sort: "updated_desc", persons, filterCat: "tag", fmOpening: null, filterOpen: false });
    expect(stranger).not.toContain('data-act="openPerson"');
    const detail: PromptDetail = { slug: "p", title: "P", description: "", tags: [], author: "Darkest-Teddy", version: 1, status: "published", updated_at: "2026-09-23T10:00:00Z", body: "b", use_count: 0, last_used_at: null };
    const page = promptDetailView({ status: "ok", prompt: detail, versions: [], persons, knownTags: [], diffVersion: null, tagMenu: false, tagDraft: "", promptView: "raw", canDelete: false, deleteArm: false });
    expect(page).toMatch(/<button data-act="openPerson" data-arg="Darkest-Teddy" class="cnpy-personchip"[^>]*>.*Jack<\/span>.*@Darkest-Teddy/s);
  });
});
