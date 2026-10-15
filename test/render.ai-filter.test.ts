// The plain-language filter's box (#162; web/src/ai-filter.ts) on Tickets, the Feed and Artifacts: drawn only
// when the org's AI is on, applied to the screen's own filters, with Undo — and none of it when AI is off.
import { describe, it, expect } from "vitest";
import { render, initialState, type AppState } from "../web/src/render";
import { aiFilterBox, aiFilterLabels, initialAiFilterUi, type AiFilterUi } from "../web/src/ai-filter";
import { AI_FILTER_MESSAGES, AI_FILTER_PLACEHOLDER } from "@shared/ai-filter-core";

const ME = { handle: "andres", name: "Andres", avatar_url: null, color: "sky" as const, identities: [], orgs: [{ slug: "trov", name: "Trov", role: "admin" as const }], superadmin: false, pending_invites: 0 };
const PERSONS = [
  { handle: "andres", name: "Andres", color: "sky" as const, avatar_url: null, role: null },
  { handle: "meilin", name: "Meilin Zhao", color: "rose" as const, avatar_url: null, role: null },
];
const on = (o: Partial<AiFilterUi> = {}): AiFilterUi => ({ ...initialAiFilterUi(), org: "trov", on: true, ...o });
const app = (o: Partial<AppState>): AppState => ({ ...initialState(), view: "app", me: ME, orgSlug: "trov", persons: { status: "ok", data: PERSONS }, ...o });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&hellip;/g, "…").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const names = { me: "andres", person: (h: string) => PERSONS.find((p) => p.handle === h)?.name ?? h, sprint: (id: string) => (id === "7" ? "Hosting" : `Sprint #${id}`) };

describe("off is no box at all", () => {
  it("aiFilterBox is empty while the org's AI is off (the default)", () => {
    for (const screen of ["tickets", "feed", "artifacts"] as const) expect(aiFilterBox(screen, initialAiFilterUi())).toBe("");
  });

  it("the three screens render exactly as without it", () => {
    for (const screen of ["tickets", "feed", "artifacts"] as const) {
      const off = render(app({ screen }));
      expect(off).not.toContain("data-ai-filter");
      expect(off).not.toContain("aiFilterRun");
    }
  });
});

describe("the box", () => {
  it("a field (Enter applies) and an Apply button, side by side in the search bar's shape — no select, no nested button", () => {
    const html = aiFilterBox("tickets", on({ drafts: { tickets: "my bugs", feed: "", artifacts: "" } }));
    expect(html).toContain('data-act="aiFilterDraft"');
    expect(html).toContain('data-enter="aiFilterRun"');
    expect(html).toContain('data-field="aiFilter:tickets"');
    expect(html).toContain('value="my bugs"');
    expect(html).toContain(`placeholder="${AI_FILTER_PLACEHOLDER.tickets}"`);
    expect(html).toContain('<label class="cnpy-sfbar-q" for="ai-filter-tickets">');
    expect(html).toContain('data-act="aiFilterRun" data-arg="tickets"');
    expect(html).not.toMatch(/<select/);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    expect(html).toContain("cnpy-sfbar");
  });

  it("busy: the button says so and is disabled", () => {
    const html = aiFilterBox("feed", on({ busy: "feed" }));
    expect(html).toMatch(/<button data-act="aiFilterRun" data-arg="feed"[^>]* disabled aria-busy="true">Reading&hellip;<\/button>/);
    expect(aiFilterBox("tickets", on({ busy: "feed" }))).not.toContain("disabled");
  });

  it("a refusal is the field's floating error, read out when it appears", () => {
    const html = aiFilterBox("artifacts", on({ error: { artifacts: AI_FILTER_MESSAGES.unreadable } }));
    expect(html).toContain('<div class="cnpy-field-anchor">');
    expect(html).toContain('role="alert" class="cnpy-field-err"');
    expect(html).toContain('aria-invalid="true" aria-describedby="ai-filter-artifacts-e"');
    expect(text(html)).toContain(AI_FILTER_MESSAGES.unreadable);
  });

  it("applied: what was set in words (no pills), what was not a filter here, and Undo", () => {
    const html = aiFilterBox("tickets", on({ applied: { tickets: { labels: ["Open", "Assigned to you"], unmatched: ["overdue"], undo: {} } } }));
    expect(text(html)).toContain("Filtered: Open · Assigned to you. Not a filter here: “overdue”. Undo");
    expect(html).toContain('data-act="aiFilterUndo"');
    expect(html).toContain('role="status"');
  });

  it("sits above each screen's own toolbar", () => {
    const t = render(app({ screen: "tickets", aiFilter: on() }));
    expect(t.indexOf('data-ai-filter="tickets"')).toBeGreaterThan(-1);
    expect(t.indexOf('data-ai-filter="tickets"')).toBeLessThan(t.indexOf('data-act="queueQ"'));
    const a = render(app({ screen: "artifacts", aiFilter: on() }));
    expect(a.indexOf('data-ai-filter="artifacts"')).toBeGreaterThan(-1);
    expect(a.indexOf('data-ai-filter="artifacts"')).toBeLessThan(a.indexOf('data-act="artQ"'));
    expect(render(app({ screen: "feed", aiFilter: on(), feed: { status: "ok", data: [] } }))).toContain('data-ai-filter="feed"');
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

describe("motion (e2e MO-10 / MO-11; RULES § 8)", () => {
  const applied = (at?: number) => ({ labels: ["Open"], unmatched: [], undo: {}, ...(at === undefined ? {} : { at }) });
  it("the applied line rises in once from when it was applied; a repaint inside the rise joins it; later ones are still", () => {
    const now = 10_000;
    expect(aiFilterBox("tickets", on({ applied: { tickets: applied(now - 80) } }), now)).toMatch(/<div role="status" class="cnpy-flash" style="animation-delay:-80ms;/);
    expect(aiFilterBox("tickets", on({ applied: { tickets: applied(now - 400) } }), now)).not.toContain("cnpy-flash");
    expect(aiFilterBox("tickets", on({ applied: { tickets: applied() } }), now)).not.toContain("cnpy-flash");
  });
  it("Undo: the line leaves with the AI kit's one exit, inert, then is gone", () => {
    const now = 10_000;
    const leaving = (at: number) => on({ leaving: { tickets: { applied: applied(), at } } });
    const mid = aiFilterBox("tickets", leaving(now - 100), now);
    expect(mid).toContain('class="cnpy-ai-leave" data-ai-leaving inert style="--leave-t:-100ms"');
    expect(text(mid)).toContain("Filtered: Open.");
    expect(aiFilterBox("tickets", leaving(now - 400), now)).not.toContain("Filtered:");
  });
});
