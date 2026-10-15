// The plain-language filter (#162; web/src/ai-filter.ts) — a typed filter INSIDE the Filter menu of Tickets, the
// Feed and Artifacts: its "Describe a filter" row at the popover's top, the field it opens, the answer applied to the
// screen's own filters with the "Filtered: …" line and Undo (leaving by the AI kit's one exit), a refusal shown in
// the menu — and none of it when the org's AI is off.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, initialState, type AppState } from "../web/src/render";
import { aiFilterLabels, aiFilterLeaveKey, aiFilterLine, aiFilterMenuTop, initialAiFilterUi, type AiFilterUi } from "../web/src/ai-filter";
import { createAiFilterController, type AiFilterHost } from "../web/src/ai-filter-actions";
import { AI_EXIT_MS, initialAiUi } from "../web/src/ai-ui";
import { AI_FILTER_MESSAGES, AI_FILTER_PLACEHOLDER, type AiFilterScreen } from "@shared/ai-filter-core";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";

const ME = { handle: "andres", name: "Andres", avatar_url: null, color: "sky" as const, identities: [], orgs: [{ slug: "trov", name: "Trov", role: "admin" as const }], superadmin: false, pending_invites: 0 };
const PERSONS = [
  { handle: "andres", name: "Andres", color: "sky" as const, avatar_url: null, role: null },
  { handle: "meilin", name: "Meilin Zhao", color: "rose" as const, avatar_url: null, role: null },
];
const SCREENS = ["tickets", "feed", "artifacts"] as const;
const on = (o: Partial<AiFilterUi> = {}): AiFilterUi => ({ ...initialAiFilterUi(), org: "trov", on: true, ...o });
const app = (o: Partial<AppState>): AppState => ({ ...initialState(), view: "app", me: ME, orgSlug: "trov", persons: { status: "ok", data: PERSONS }, feed: { status: "ok", data: [] }, ...o });
/** A screen with its Filter menu open. */
const menuOpen = (screen: AiFilterScreen, ai: AiFilterUi): AppState => {
  const s = app({ screen, aiFilter: ai });
  if (screen === "tickets") s.qFilterOpen = true;
  else if (screen === "feed") s.feedFilterOpen = true;
  else s.art = { ...s.art, filterOpen: true };
  return s;
};
/** The open popover's markup. */
const pop = (html: string): string => {
  const at = html.indexOf("data-fm-pop=");
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("Clear all", at));
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&hellip;/g, "…").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const names = { me: "andres", person: (h: string) => PERSONS.find((p) => p.handle === h)?.name ?? h, sprint: (id: string) => (id === "7" ? "Hosting" : `Sprint #${id}`) };

describe("off is no row at all", () => {
  it("the menu's row and the line are empty while the org's AI is off (the default)", () => {
    for (const screen of SCREENS) {
      expect(aiFilterMenuTop(screen, initialAiFilterUi())).toBe("");
      expect(aiFilterLine(screen, { ...initialAiFilterUi(), applied: { [screen]: { labels: ["Open"], unmatched: [], undo: {} } } }, initialAiUi())).toBe("");
    }
  });

  it("each screen's open Filter menu is exactly what it was: no row, no field", () => {
    for (const screen of SCREENS) {
      const html = render(menuOpen(screen, initialAiFilterUi()));
      expect(pop(html)).not.toContain("aiFilterReveal");
      expect(html).not.toContain("data-ai-filter");
      expect(html).not.toContain("aiFilterRun");
      // The menu still opens with its options first.
      expect(pop(html).indexOf("fm-opt")).toBeGreaterThan(-1);
    }
  });
});

describe("no standalone bar any more", () => {
  it("with AI on and the menu shut, no screen draws a filter field above its toolbar", () => {
    for (const screen of SCREENS) {
      const html = render(app({ screen, aiFilter: on() }));
      expect(html).not.toContain('data-act="aiFilterDraft"');
      expect(html).not.toContain("cnpy-aifilter-row");
      expect(html).not.toContain("Describe a filter");
    }
  });
});

describe("the option in the menu", () => {
  it("each screen's Filter menu opens on \"Describe a filter\", with the AI mark, above the options — field shut", () => {
    for (const screen of SCREENS) {
      const p = pop(render(menuOpen(screen, on())));
      const row = p.indexOf('data-act="aiFilterReveal"');
      expect(row).toBeGreaterThan(-1);
      expect(row).toBeLessThan(p.indexOf("fm-opt"));
      expect(row).toBeLessThan(p.indexOf("fm-cat"));
      expect(p).toContain(`data-ai-filter="${screen}" data-open="0"`);
      expect(p).toMatch(new RegExp(`data-arg="${screen}" data-field="aiFilterOpt:${screen}" class="cnpy-menurow fm-ai-opt" aria-expanded="false" aria-controls="ai-filter-${screen}-box"`));
      expect(p).toContain(`id="ai-filter-${screen}-box" inert`);   // shut: nothing in it takes focus
      expect(text(p)).toContain("Describe a filter");
      expect(p).toContain("<svg");                                  // the AI kit's mark
    }
  });

  it("a menu row like the others (`cnpy-menurow`, which the arrow keys walk); no select, no button in a button", () => {
    const html = aiFilterMenuTop("feed", on({ reveal: "feed" }));
    expect(html).not.toMatch(/<select/);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    expect(mainSrc).toContain('querySelectorAll<HTMLElement>(".fm-pop .cnpy-menurow")');
  });
});

describe("the field revealed", () => {
  it("choosing it opens the field in place: Enter runs it, Apply beside it", () => {
    for (const screen of SCREENS) {
      const p = pop(render(menuOpen(screen, on({ reveal: screen, drafts: { tickets: "", feed: "", artifacts: "", [screen]: "my bugs" } }))));
      expect(p).toContain(`data-ai-filter="${screen}" data-open="1"`);
      expect(p).toContain('aria-expanded="true"');
      expect(p).not.toContain(`id="ai-filter-${screen}-box" inert`);
      expect(p).toContain('data-act="aiFilterDraft"');
      expect(p).toContain('data-enter="aiFilterRun"');
      expect(p).toContain(`data-field="aiFilter:${screen}"`);
      expect(p).toContain('value="my bugs"');
      expect(p).toContain(`placeholder="${AI_FILTER_PLACEHOLDER[screen]}"`);
      expect(p).toContain(`data-act="aiFilterRun" data-arg="${screen}"`);
    }
  });

  it("only the screen it was chosen on: another screen's menu opens shut", () => {
    expect(pop(render(menuOpen("tickets", on({ reveal: "feed" }))))).toContain('data-ai-filter="tickets" data-open="0"');
  });

  it("busy: Apply says so and is disabled", () => {
    const html = aiFilterMenuTop("feed", on({ reveal: "feed", busy: "feed" }));
    expect(html).toMatch(/<button data-act="aiFilterRun" data-arg="feed"[^>]* disabled aria-busy="true">Reading&hellip;<\/button>/);
    expect(aiFilterMenuTop("tickets", on({ busy: "feed" }))).not.toContain("disabled");
  });

  it("the field grows open on the app's clock, the menu's entrance carries the row, and reduced motion stops both", () => {
    expect(css).toMatch(/\.fm-ai-box \{[^}]*grid-template-rows:0fr;[^}]*transition:grid-template-rows var\(--fx-base\) var\(--fx-ease\)/);
    expect(css).toMatch(/\.fm-ai\[data-open="1"\] \.fm-ai-box \{ grid-template-rows:1fr; opacity:1; \}/);
    expect(css).toMatch(/\.fm-pop\.is-opening \.fm-ai-opt \{ animation:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.fm-pop, \.fm-pop \*, \.fm-panel, \.fm-panel \* \{ animation:none !important; transition:none !important; \}/);
  });
});

describe("an error", () => {
  it("a refusal shows inside the menu, under the field, read out when it appears", () => {
    for (const screen of SCREENS) {
      const p = pop(render(menuOpen(screen, on({ reveal: screen, error: { [screen]: AI_FILTER_MESSAGES.unreadable } }))));
      expect(p).toContain(`id="ai-filter-${screen}-e" role="alert" class="fm-ai-err"`);
      expect(p).toContain(`aria-invalid="true" aria-describedby="ai-filter-${screen}-e"`);
      expect(text(p)).toContain(AI_FILTER_MESSAGES.unreadable);
    }
  });
});

describe("applied, and Undo", () => {
  const applied = { labels: ["Open", "Assigned to you"], unmatched: ["overdue"], undo: {} };

  it("applied: what was set in words (no pills), what was not a filter here, and Undo — above each screen's toolbar", () => {
    const html = aiFilterLine("tickets", on({ applied: { tickets: applied } }), initialAiUi());
    expect(text(html)).toContain("Filtered: Open · Assigned to you. Not a filter here: “overdue”. Undo");
    expect(html).toContain('data-act="aiFilterUndo" data-arg="tickets"');
    expect(html).toContain('role="status"');
    const t = render(app({ screen: "tickets", aiFilter: on({ applied: { tickets: applied } }) }));
    expect(t.indexOf('data-ai-filter-line="tickets"')).toBeGreaterThan(-1);
    expect(t.indexOf('data-ai-filter-line="tickets"')).toBeLessThan(t.indexOf('data-act="queueQ"'));
    const a = render(app({ screen: "artifacts", aiFilter: on({ applied: { artifacts: applied } }) }));
    expect(a.indexOf('data-ai-filter-line="artifacts"')).toBeGreaterThan(-1);
    expect(a.indexOf('data-ai-filter-line="artifacts"')).toBeLessThan(a.indexOf('data-act="artQ"'));
    expect(render(app({ screen: "feed", aiFilter: on({ applied: { feed: applied } }) }))).toContain('data-ai-filter-line="feed"');
  });

  it("after Undo the line leaves by the AI kit's one exit, then is gone", () => {
    const ui = on({ undone: { feed: applied } });
    const at = 1_000_000;
    const ai = { ...initialAiUi(), leaving: [{ key: aiFilterLeaveKey("feed"), at }] };
    const mid = aiFilterLine("feed", ui, ai, at + 100);
    expect(mid).toContain('class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-100ms"');
    expect(mid).toContain("Filtered: Open");
    expect(aiFilterLine("feed", ui, ai, at + AI_EXIT_MS)).toBe("");
    // Not leaving (reduced motion records no exit): gone at once.
    expect(aiFilterLine("feed", ui, initialAiUi())).toBe("");
  });
});

describe("the controller", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  function host(screen: AiFilterScreen, o: Partial<AiFilterUi> = {}) {
    const state = app({ screen, aiFilter: on(o) });
    const calls: string[] = [];
    const h: AiFilterHost = {
      state, rerender: () => calls.push("rerender"), unauth: () => calls.push("unauth"), role: () => "admin",
      snapshot: () => ({ before: true }), apply: (s, f) => calls.push(`apply:${s}:${JSON.stringify(f)}`),
      restore: (s, snap) => calls.push(`restore:${s}:${JSON.stringify(snap)}`), names: () => names,
      closeMenu: (s) => calls.push(`close:${s}`), leave: (k) => { calls.push(`leave:${k}`); return 1; },
    };
    return { state, calls, ctl: createAiFilterController(h) };
  }

  it("Describe a filter opens the field (and shuts it again)", () => {
    const { state, ctl } = host("feed");
    ctl.act("aiFilterReveal", "feed", null);
    expect(state.aiFilter.reveal).toBe("feed");
    ctl.act("aiFilterReveal", "feed", null);
    expect(state.aiFilter.reveal).toBe(null);
  });

  it("typing keeps the draft without a repaint and clears a refusal", () => {
    const { state, calls, ctl } = host("tickets", { reveal: "tickets", error: { tickets: AI_FILTER_MESSAGES.invalid } });
    ctl.act("aiFilterDraft", "tickets", "my bugs");
    expect(state.aiFilter.drafts.tickets).toBe("my bugs");
    expect(state.aiFilter.error.tickets).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it("Enter runs POST /ai/filter, applies the answer to the screen's own filters, writes the line and closes the menu", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ filter: { author: "andres", range: "7d" }, unmatched: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { state, calls, ctl } = host("feed", { reveal: "feed", drafts: { tickets: "", feed: "my entries from the last 7 days", artifacts: "" } });
    ctl.act("aiFilterRun", null, null);
    await vi.waitFor(() => expect(calls).toContain("close:feed"));
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("/ai/filter");
    expect(calls).toContain('apply:feed:{"author":"andres","range":"7d"}');
    expect(state.aiFilter.applied.feed?.labels).toEqual(["By you", "Last 7 days"]);
    expect(state.aiFilter.applied.feed?.undo).toEqual({ before: true });
  });

  it("a refusal lands in the menu's field, not a toast", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unreadable", message: AI_FILTER_MESSAGES.unreadable }), { status: 422, headers: { "content-type": "application/json" } })));
    const { state, calls, ctl } = host("artifacts", { reveal: "artifacts", drafts: { tickets: "", feed: "", artifacts: "overdue" } });
    ctl.act("aiFilterRun", "artifacts", null);
    await vi.waitFor(() => expect(state.aiFilter.error.artifacts).toBeTruthy());
    expect(calls).not.toContain("close:artifacts");
  });

  it("an empty field is refused before any request", () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { state, ctl } = host("tickets", { reveal: "tickets" });
    ctl.act("aiFilterRun", "tickets", null);
    expect(state.aiFilter.error.tickets).toBe(AI_FILTER_MESSAGES.invalid);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Undo puts the filters back and starts the line's exit", () => {
    const applied = { labels: ["Open"], unmatched: [], undo: { qSeg: "open" } };
    const { state, calls, ctl } = host("tickets", { applied: { tickets: applied } });
    ctl.act("aiFilterUndo", "tickets", null);
    expect(calls).toEqual([`leave:${aiFilterLeaveKey("tickets")}`, 'restore:tickets:{"qSeg":"open"}', "rerender"]);
    expect(state.aiFilter.applied.tickets).toBeUndefined();
    expect(state.aiFilter.undone.tickets).toEqual(applied);
  });
});

describe("main.ts wires the menus", () => {
  it("a menu opens with the field shut; Escape hands focus back to the Filter button; the field holds a hover menu open", () => {
    expect(mainSrc).toContain("state.aiFilter.reveal = null;");
    expect(mainSrc).toContain('[data-act="fmToggle"][data-arg="${id}"]');
    expect(mainSrc).toContain('if (menu?.querySelector(".fm-ai")?.contains(document.activeElement)) return;');
    expect(mainSrc).toContain('const AI_FILTER_MENU: Record<AiFilterScreen, string> = { tickets: "queue", feed: "feed", artifacts: "art" };');
  });
});

describe("the words of an applied filter", () => {
  it("tickets, in the controls' order", () => {
    expect(aiFilterLabels("tickets", { status: "open", assignee: "me", category: "bug", priority: "high", sprint: "7", text: "login" }, names))
      .toEqual(["Open", "Assigned to you", "Bug", "High priority", "Hosting", "search “login”"]);
    expect(aiFilterLabels("tickets", { person: "meilin", sprint: "backlog", status: "all" }, names)).toEqual(["Open and closed", "Assigned to Meilin Zhao", "Backlog"]);
  });
  it("the feed and artifacts", () => {
    expect(aiFilterLabels("feed", { author: "andres", tag: "auth", range: "7d" }, names)).toEqual(["By you", "Tagged auth", "Last 7 days"]);
    expect(aiFilterLabels("artifacts", { area: "ui", kind: "html", author: "meilin", status: "published", sprint: "9" }, names))
      .toEqual(["Area ui", "HTML", "By Meilin Zhao", "Published", "Sprint #9"]);
  });
});

describe("motion (e2e MO-10 / MO-11; RULES § 8): the applied line rises in once (its exit is the kit's, above)", () => {
  const applied = (at?: number) => ({ labels: ["Open"], unmatched: [], undo: {}, ...(at === undefined ? {} : { at }) });
  it("it rises in once from when it was applied; a repaint inside the rise joins it; later ones are still", () => {
    const now = 10_000;
    const line = (at?: number) => aiFilterLine("tickets", on({ applied: { tickets: applied(at) } }), initialAiUi(), now);
    expect(line(now - 80)).toMatch(/<div class="cnpy-aifilter-line cnpy-flash" data-ai-filter-line="tickets" role="status" style="animation-delay:-80ms;/);
    expect(line(now - 400)).not.toContain("cnpy-flash");
    expect(line()).not.toContain("cnpy-flash");
    // The line on its way out never rises.
    const ai = { ...initialAiUi(), leaving: [{ key: aiFilterLeaveKey("tickets"), at: now - 50 }] };
    expect(aiFilterLine("tickets", on({ undone: { tickets: applied(now - 60) } }), ai, now)).not.toContain("cnpy-flash");
  });
});
