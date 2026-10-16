// The Feed's importance mark (`feed.importance`, 0060; web/src/marks.ts `importanceMark`): a quiet mark for a
// notable or breaking entry — a shape and a sentence-case word, never a pill — and NOTHING for a routine or unrated
// one: a row without a rating renders byte for byte what it did before the column existed. Pure render, no D1.
import { describe, it, expect, vi } from "vitest";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sent = vi.hoisted(() => ({ bodies: [] as unknown[] }));
vi.mock("../web/src/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web/src/api")>()),
  sendAiFeedback: (b: unknown) => { sent.bodies.push(b); return Promise.resolve({ ok: true }); },
}));
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { render, initialState } from "../web/src/render";
import { createAiController } from "../web/src/ai-actions";
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

  it("MOTION: the mark enters with its row (the Feed's `.cnpy-stagger` entrance) and has no motion of its own to replay", () => {
    // The app's one motion system: `markEnter` sets `[data-enter]` only when the ROUTE changes, and
    // `[data-enter] .cnpy-stagger > *` rises each row in (off under prefers-reduced-motion, trov.css). The mark lives
    // inside a row of that list, so it arrives with it — and a rerender (a new read, a keystroke) draws the same
    // markup, so nothing replays.
    const s = state([row({ id: 1, importance: "breaking" }), row({ id: 2, importance: "notable" })]);
    const html = render(s);
    const list = html.indexOf('<div class="cnpy-stagger">');
    expect(list).toBeGreaterThan(-1);
    expect(html.indexOf('data-importance="breaking"')).toBeGreaterThan(list);
    expect(html.indexOf('data-importance="notable"')).toBeGreaterThan(list);
    for (const imp of ["notable", "breaking"] as const) expect(importanceMark(imp)).not.toMatch(/animation|transition|cnpy-rise|cnpy-flash/);
    expect(render(s)).toBe(html);
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

describe("Wrong? on a rating — feedback for the evals only (Q34)", () => {
  it("a notable or breaking mark carries a small Wrong? (no Dismiss, nothing to edit); routine and unrated carry none", () => {
    for (const imp of ["notable", "breaking"] as const) {
      const html = render(state([row({ id: 7, importance: imp })]));
      const mark = html.slice(html.indexOf(`data-importance="${imp}"`));
      const btn = mark.match(/<button type="button" data-act="aiRatingWrong" data-arg="([^"]+)"[^>]*aria-pressed="false"/);
      expect(btn).not.toBeNull();
      expect(JSON.parse(btn![1].replace(/&quot;/g, '"'))).toEqual({ itemType: "importance", itemRef: "feed:7", kind: "feed.importance", model: null, promptVersion: null });
      expect(mark.slice(0, mark.indexOf("</span></span>"))).not.toMatch(/aiDismiss|aiAccept|Dismiss/);
    }
    expect(render(state([row({ importance: "routine" })]))).not.toContain("aiRatingWrong");
  });
  it("pressing it sends ai_feedback and keeps the rating on screen, pressed — nothing is hidden", async () => {
    const s = state([row({ id: 7, importance: "breaking" })]);
    const flashes: string[] = [];
    const ctl = createAiController({ state: s, mount: {} as HTMLElement, rerender: () => {}, flash: (m) => flashes.push(m), unauth: () => {} });
    const arg = JSON.stringify({ itemType: "importance", itemRef: "feed:7", kind: "feed.importance", model: null, promptVersion: null });
    ctl.act("aiRatingWrong", arg, null);
    ctl.act("aiRatingWrong", arg, null); // once
    await Promise.resolve(); await Promise.resolve();
    expect(sent.bodies).toHaveLength(1);
    expect(s.ai.hidden).toEqual([]);
    expect(s.ai.leaving).toEqual([]);
    const html = render(s);
    expect(html).toContain('data-importance="breaking"');
    expect(html).toMatch(/data-act="aiRatingWrong"[^>]*aria-pressed="true"/);
    expect(flashes).toEqual(["Thanks: Trov is told this rating looks wrong. It stays as rated."]);
  });
});
