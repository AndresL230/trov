// Handoffs + Prompt Library + New doc — the ported views over the real API shapes
// (numeric handoff ids rendered `#12`, the write affordances each screen offers).
import { describe, it, expect } from "vitest";
import { handoffsView, handoffDetailView, handoffAsPrompt, docDraftFromHandoff } from "../web/src/handoffs";
import { promptDetailView, promptLibraryView, filterPrompts } from "../web/src/prompts";
import { newDocView, blankDoc } from "../web/src/newdoc";
import type { HandoffView, PromptSummary, PromptDetail, PromptVersion } from "../shared/handoffs";

const persons = [
  { handle: "AndresL230", name: "Andres", color: "moss" as const, avatar_url: null },
  { handle: "Darkest-Teddy", name: "Jack", color: "plum" as const, avatar_url: null },
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
  const detail: PromptDetail = { slug: "lint", title: "Lint", description: "", tags: ["ui"], author: "Darkest-Teddy", version: 3, status: "staged", updated_at: "2026-09-23T10:00:00Z", body: "Lint {{path}}." };
  const v = (version: number, status: PromptVersion["status"]): PromptVersion => ({ version, status, author: "Darkest-Teddy", created_at: "2026-09-20T10:00:00Z", summary: "s", body: "b" });
  const props = { status: "ok" as const, prompt: detail, persons, knownTags: [], diffVersion: null, tagMenu: false, tagDraft: "", promptView: "raw" as const };

  it("offers Publish vN only while a staged version exists", () => {
    expect(promptDetailView({ ...props, versions: [v(3, "staged"), v(2, "published")] })).toContain('data-act="promptPublish" data-arg="3"');
    expect(promptDetailView({ ...props, versions: [v(2, "published")] })).not.toContain("promptPublish");
  });

  it("shows its body in the SAME prompt box a handoff's prompt uses", () => {
    const page = promptDetailView({ ...props, versions: [v(3, "staged")] });
    const handoff = handoffDetailView({ status: "ok", handoff: h({ body: "Quiz agent still fails.", prompt: { title: "Fix it", body: "Step 1." } }), me: "AndresL230", persons, expireArm: false, promptView: "raw" });
    // One component: same class, same copy + expand icon buttons, same raw mono body.
    for (const html of [page, handoff]) {
      expect(html).toContain('class="cnpy-promptbox"');
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

  it("the library's filter is the shared filter menu, with Tag AND Sort", () => {
    const s = (slug: string, tags: string[]): PromptSummary => ({ slug, title: slug, tags, author: "a", version: 1, status: "published", updated_at: "2026-09-01T00:00:00Z", excerpt: "x" });
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
    const s = (slug: string, tags: string[]): PromptSummary => ({ slug, title: slug, tags, author: "a", version: 1, status: "published", updated_at: "2026-09-01T00:00:00Z", excerpt: "x" });
    const list = [s("sse-review", ["api"]), s("mdx-lint", ["ui"])];
    expect(filterPrompts(list, "sse", null, "updated_desc").map((p) => p.slug)).toEqual(["sse-review"]);
    expect(filterPrompts(list, "", "ui", "updated_desc").map((p) => p.slug)).toEqual(["mdx-lint"]);
  });
});
