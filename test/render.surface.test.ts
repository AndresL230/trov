/**
 * The surface card — the app's ONE card look (white in light, a lifted tone in dark, a
 * hairline border, a small shadow). It is defined ONCE, as `.cnpy-surface` in
 * web/src/trov.css, and markup opts in through `surface()` in web/src/ui.ts. These tests
 * pin the definition and that the migrated cards render the class instead of an inline copy
 * of the look — and none still carries the old tinted card background.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import css from "../web/src/trov.css?raw";
import { surface, SURFACE } from "../web/src/ui";
import { render, initialState, planNarrativeBlock, profileSection, accountSection, mcpAccessSection } from "../web/src/render";
import { ticketsTile } from "../web/src/mywork";
import { sprintCard } from "../web/src/sprints";
import { roadmapTimeline } from "../web/src/timeline";
import type { SprintView } from "@shared/sprints";
import type { FeedRow } from "@shared/rows";

const OLD_TINT = "color-mix(in srgb,var(--fg) 2.5%";
const LOOK = /background:var\(--surface\);border:1px solid var\(--border\);border-radius:10px;box-shadow:var\(--shadow\)/;
const hasSurface = (html: string) => /class="[^"]*\bcnpy-surface\b/.test(html);

const NOW = Date.parse("2026-09-26T12:00:00Z");
function sprint(o: Partial<SprintView> & { id: number; label: string }): SprintView {
  return {
    summary: "Close out the soak test.", description: null, phase: "Phase 2", dates: "SEP 8 – 19",
    start: null, due: "2026-10-10", status: "upcoming", active: false, urgency: "normal", lead: null,
    domain: null, github_ref: null, created_at: "2026-09-01T00:00:00Z", created_by: "jose-a",
    updated_at: null, progress: { closed: 2, total: 5, pct: 40 }, issues: null, members: [], ...o,
  } as SprintView;
}
function signedIn(): ReturnType<typeof initialState> {
  return {
    ...initialState(),
    view: "app",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [{ provider: "github", label: "alice" }], org: "SaplingLearn", admin: false },
  } as ReturnType<typeof initialState>;
}

describe("the surface card — defined once (web/src/trov.css)", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const design = plain.slice(0, plain.indexOf("--corner-scale:"));

  it("is ONE rule carrying the four properties", () => {
    const rules = [...design.matchAll(/(^|\})\s*\.cnpy-surface\s*\{([^}]*)\}/g)];
    expect(rules).toHaveLength(1);
    const body = rules[0][2];
    expect(body).toContain("background:var(--surface)");
    expect(body).toContain("border:1px solid var(--border)");
    expect(body).toContain("border-radius:10px");
    expect(body).toContain("box-shadow:var(--shadow)");
  });

  it("the tokens it reads are set for both themes (light white, dark a lifted tone)", () => {
    expect(css).toMatch(/\[data-cnpy-theme="light"\][^}]*--surface:#ffffff/);
    expect(css).toMatch(/\[data-cnpy-theme="dark"\][^}]*--surface:#221f1b/);
    expect(css).toMatch(/\[data-cnpy-theme="light"\][^}]*--shadow:/);
    expect(css).toMatch(/\[data-cnpy-theme="dark"\][^}]*--shadow:/);
  });

  it("its radius is scaled by the corners block like every other", () => {
    expect(plain).toMatch(/\[data-cnpy-theme\] \.cnpy-surface,[\s\S]*?\{ border-radius:calc\(10px \* var\(--corner-scale\)\) !important; \}/);
  });

  it("the interactive modifier (.cnpy-card) darkens the hairline on hover", () => {
    expect(design).toMatch(/\.cnpy-card:hover \{ border-color:var\(--border-strong\); \}/);
  });

  it("a surface's attention tint and hover fill mix INTO the surface (the card stays opaque)", () => {
    expect(design).toContain(".cnpy-surface.cnpy-attn { background:color-mix(in srgb,var(--accent) 4%,var(--surface)); }");
    expect(design).toMatch(/\.cnpy-surface\.cnpy-tcard:hover \{[^}]*var\(--surface\)/);
  });
});

describe("surface() — the helper (web/src/ui.ts)", () => {
  it("returns the class and the card's own style, the modifier and extra classes on request", () => {
    expect(SURFACE).toBe("cnpy-surface");
    expect(surface("padding:4px")).toBe(' class="cnpy-surface" style="padding:4px"');
    expect(surface("", { hover: true, cls: "cnpy-rise" })).toBe(' class="cnpy-surface cnpy-card cnpy-rise"');
  });
});

describe("the migrated cards render the shared class — never an inline copy, never the old tint", () => {
  const cases: [string, () => string][] = [
    ["My Work tile", () => ticketsTile({ load: "ok", rows: [] }, false, 0)],
    ["Roadmap narrative card", () => planNarrativeBlock("The plan.", (b) => b)],
    ["sprint card", () => sprintCard(sprint({ id: 1, label: "Sprint 1" }), [])],
    ["Roadmap timeline card", () => roadmapTimeline({ sprints: [sprint({ id: 1, label: "Sprint 1" })], confirmed: {}, persons: [], now: NOW })],
    ["Settings › Profile tile", () => profileSection(signedIn())],
    ["Settings › Account tile", () => accountSection(signedIn())],
    ["Settings › MCP access tile", () => mcpAccessSection(signedIn())],
    ["Feed entry", () => {
      const row: FeedRow = { id: 1, author: "alice", summary: "Shipped it.", brief: null, body: null, artifacts: null, created_at: "2026-09-14T10:00:00Z" };
      return render({ ...signedIn(), screen: "feed", feed: { status: "ok", data: [row] }, feedAuthors: ["alice"] } as ReturnType<typeof initialState>);
    }],
  ];
  for (const [name, html] of cases) {
    it(name, () => {
      const out = html();
      expect(hasSurface(out), `${name} renders no cnpy-surface`).toBe(true);
      expect(out, `${name} still inlines the surface look`).not.toMatch(LOOK);
      expect(out, `${name} still carries the old tinted card background`).not.toContain(OLD_TINT);
    });
  }
});

describe("no template re-declares the look (web/src/*.ts)", () => {
  const sources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

  it("no inline copy of the surface look is left anywhere", () => {
    for (const [file, src] of Object.entries(sources)) {
      expect(src, `${file} inlines the surface look — use surface() / cnpy-surface`).not.toMatch(/background:var\(--surface\);border:1px solid var\(--border\)/);
    }
  });

  it("the old tinted card background survives only on the non-card spots that keep it on purpose", () => {
    // prompt-box: the scroll well inside the surface; artifacts / tickets: inline link chips.
    const allowed: Record<string, number> = { "../web/src/prompt-box.ts": 1, "../web/src/artifacts.ts": 1, "../web/src/tickets.ts": 1 };
    for (const [file, src] of Object.entries(sources)) {
      const n = src.split(OLD_TINT).length - 1;
      expect(n, `${file} still uses the old tinted card background`).toBeLessThanOrEqual(allowed[file] ?? 0);
    }
  });
});
