// The Feed's importance mark (`feed.importance`, 0060; web/src/marks.ts `importanceMark`): a quiet mark for a
// notable or breaking entry — a shape and a sentence-case word, never a pill — and NOTHING for a routine or unrated
// one: a row without a rating renders byte for byte what it did before the column existed. Pure render, no D1.
import { describe, it, expect, vi } from "vitest";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { render, initialState } from "../web/src/render";
import { IMPORTANCE_MARK, importanceMark } from "../web/src/marks";
import type { FeedRow } from "@shared/rows";
import { feedFixtures, feedImportanceFixtures, aiPreviewFixtures } from "@shared/ai-fixtures";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function row(o: Partial<FeedRow> = {}): FeedRow {
  return { id: 1, author: "AndresL230", summary: "Shipped a thing.", brief: null, body: null, artifacts: null, created_at: "2026-10-15T10:00:00Z", tags: ["ui"], ...o };
}
function state(rows: FeedRow[]): ReturnType<typeof initialState> {
  const s = initialState();
  return {
    ...s, view: "app", screen: "feed", feedView: "agents",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
    persons: { status: "ok", data: [{ handle: "AndresL230", name: "Andres", color: "moss", avatar_url: null, role: null }] },
    feed: { status: "ok", data: rows },
    feedAuthors: [...new Set(rows.map((r) => r.author))],
  };
}

describe("the Feed's importance mark", () => {
  it("FIELD-ABSENT: an unrated row and a routine row render exactly what a row without the field renders", () => {
    const plain = render(state([row()]));
    expect(render(state([row({ importance: "routine" })]))).toBe(plain);
    expect(plain).not.toContain("data-importance");
    expect(plain).not.toContain("Breaking");
  });

  it("notable and breaking draw the mark with its word and its tooltip, in the byline", () => {
    for (const imp of ["notable", "breaking"] as const) {
      const html = render(state([row({ importance: imp })]));
      expect(html).toContain(`data-importance="${imp}"`);
      expect(html).toContain(IMPORTANCE_MARK[imp].word);
      expect(html).toContain(IMPORTANCE_MARK[imp].hint);
    }
  });

  it("a mark, never a pill: an SVG shape and a sentence-case word, no border, no uppercase", () => {
    const m = importanceMark("breaking");
    expect(m).toContain("<svg");
    expect(m).toContain(">Breaking<");
    expect(m).not.toMatch(/text-transform|border:|uppercase/i);
    expect(importanceMark("routine")).toBe("");
    expect(importanceMark(undefined)).toBe("");
    expect(importanceMark(null)).toBe("");
  });

  it("an entry written by Trov carries it too, and is unchanged without it", () => {
    const [trov] = feedFixtures(NOW);
    const plain = render(state([trov]));
    expect(plain).not.toContain("data-importance");
    expect(render(state([{ ...trov, importance: "notable" }]))).toContain('data-importance="notable"');
  });

  it("LOCAL_AI_PREVIEW's sample entries show both marks on the Feed", () => {
    const fx = feedImportanceFixtures(NOW);
    expect(fx.map((r) => r.importance).sort()).toEqual(["breaking", "notable"]);
    expect(aiPreviewFixtures("ready", NOW).feedImportance).toEqual(fx);
    const html = render(state([...feedFixtures(NOW), ...fx]));
    expect(html).toContain('data-importance="breaking"');
    expect(html).toContain('data-importance="notable"');
  });
});
