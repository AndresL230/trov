/**
 * My Work › Your brief moves with the app's own motion system (owner ruling, 2026-10-15; web-ui.md "Sidebar &
 * motion" and "Loading skeletons"): the tile rises with the bento's `.cnpy-stagger`, its Now / Recently / Next rows
 * (each Next item, then the byline) rise in order (`.cnpy-rise` + `--i`), all ONLY under `[data-enter]` — so a
 * rerender never replays them — and, landing after the entrance, the tile takes the dashboard skeleton's one
 * settle fade (`data-settle-with`, skeleton.ts `syncSkeletons`). Everything is off under reduced motion.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body}</div>`,
  renderMarkdownInline: (text: string) => text,
}));
import css from "../web/src/trov.css?raw";
import { briefTile, ticketsTile, BRIEF_SETTLE_WITH } from "../web/src/mywork";
import { syncSkeletons, SKEL_DELAY_MS, SETTLE_MS } from "../web/src/skeleton";
import { briefFixture } from "@shared/ai-fixtures";

const NOW = new Date("2026-10-15T12:00:00Z");

/** Each `.cnpy-rise` in `html`, in document order: [what it is, its --i]. */
function rises(html: string): [string, number][] {
  const out: [string, number][] = [];
  const re = /<(\w+)[^>]*class="([^"]*\bcnpy-rise\b[^"]*)"[^>]*style="--i:(\d+)[;"]/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const start = html.indexOf(">", m.index + m[0].length) + 1;
    const after = html.slice(start, start + 4000).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push([`${m[1]}${m[2].includes("mw-brief-next") ? ".next" : ""}:${after.slice(0, 40)}`, Number(m[3])]);
  }
  return out;
}

describe("the brief tile's markup carries the entrance hooks", () => {
  it("the tile rises in the bento; Now, Recently and Next rise in order, then each Next item, then the byline", () => {
    const html = briefTile(briefFixture("ready", NOW));
    expect(html).toMatch(/^<section[^>]*class="[^"]*\bmw-tile mw-brief cnpy-rise\b/);
    const r = rises(html);
    // label + its line share one step; Next's items are one step apart, starting with the label's.
    expect(r.map(([, i]) => i)).toEqual([1, 1, 2, 2, 3, 3, 4, 5, 6]);
    expect(r[0][0]).toMatch(/^div:Now/);
    expect(r[2][0]).toMatch(/^div:Recently/);
    expect(r[4][0]).toMatch(/^div:Next/);
    expect(r.slice(5, 8).every(([w]) => w.startsWith("li.next:"))).toBe(true);
    expect(r[8][0]).toMatch(/^div:Written by Trov/);
  });

  it("every brief takes the same steps (the one shape, BR-OWNER-1): an empty part rises in its slot; capped and empty draw no row rises", () => {
    const b = briefFixture("ready", NOW);
    const thin = rises(briefTile({ ...b, now: null, recently: null }));
    expect(thin.map(([, i]) => i)).toEqual([1, 1, 2, 2, 3, 3, 4, 5, 6]);
    expect(thin[1][0]).toMatch(/^div:Nothing new\./);
    // Fewer Next items: the unused rows are kept, empty and still; the byline keeps its step.
    expect(rises(briefTile({ ...b, next: { items: b.next.items.slice(0, 1) } })).map(([, i]) => i)).toEqual([1, 1, 2, 2, 3, 3, 6]);
    for (const st of ["capped", "empty"] as const) {
      const html = briefTile(briefFixture(st, NOW));
      expect(html.match(/<li[^>]*cnpy-rise/g)).toBeNull();
      expect(html).toContain('data-settle-with="mw-tickets"');
    }
  });

  it("names the dashboard read's own skeleton — the one the Tickets tile draws while that read is out", () => {
    const pending = ticketsTile({ load: "pending", rows: [], total: 0, expanded: false }, false, 7);
    expect(pending).toContain(`data-skel="${BRIEF_SETTLE_WITH}"`);
    expect(briefTile(briefFixture("ready", NOW))).toContain(`data-settle-with="${BRIEF_SETTLE_WITH}"`);
  });
});

describe("the CSS plays it once, and never under reduced motion", () => {
  it("rows and tiles animate ONLY under [data-enter] (set per route, so a rerender never replays them)", () => {
    expect(css).toMatch(/\[data-enter\] \.cnpy-rise \{ animation:cnpy-rise/);
    expect(css).toMatch(/\[data-enter\] \.cnpy-stagger > \* \{ animation:cnpy-rise/);
    // Nothing animates a rise or the brief outside the entrance (comments stripped; `animation:none` is fine).
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const loose: string[] = [];
    for (const m of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/animation:(?!none)/.test(m[2])) continue;
      for (const sel of m[1].split(",").map((x) => x.trim())) if (/\.cnpy-rise\b|\.mw-brief\b/.test(sel) && !sel.includes("[data-enter]")) loose.push(sel);
    }
    expect(loose).toEqual([]);
  });
  it("reduced motion turns off the entrance and the settle fade", () => {
    const blocks = css.split("@media (prefers-reduced-motion: reduce) {").slice(1).map((b) => b.slice(0, b.indexOf("\n}")));
    expect(blocks.some((b) => /\[data-enter\] \*, [^{]*\{ animation:none !important; \}/.test(b))).toBe(true);
    expect(css).toMatch(/\.cnpy-skel-in, \.cnpy-sk, \.cnpy-settle \{ animation:none !important; \}/);
  });
});

// ── syncSkeletons over a minimal DOM (the Workers test runtime has none) ─────
class El {
  children: El[] = [];
  parentElement: El | null = null;
  attrs = new Map<string, string>();
  cls = new Set<string>();
  props = new Map<string, string>();
  classList = { add: (c: string) => { this.cls.add(c); } };
  style = { setProperty: (k: string, v: string) => { this.props.set(k, v); } };
  constructor(attrs: Record<string, string> = {}, kids: El[] = []) {
    for (const [k, v] of Object.entries(attrs)) this.attrs.set(k, v);
    for (const k of kids) { k.parentElement = this; this.children.push(k); }
  }
  getAttribute(k: string) { return this.attrs.get(k) ?? null; }
  hasAttribute(k: string) { return this.attrs.has(k); }
  /** Only `[attr]` selectors — all syncSkeletons asks for. */
  querySelectorAll(sel: string): El[] {
    const a = /^\[([\w-]+)\]$/.exec(sel)![1];
    const out: El[] = [];
    const walk = (e: El) => { for (const c of e.children) { if (c.hasAttribute(a)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  closest(sel: string): El | null {
    const a = /^\[([\w-]+)\]$/.exec(sel)![1];
    for (let e: El | null = this; e; e = e.parentElement) if (e.hasAttribute(a)) return e;
    return null;
  }
}
/** My Work loading (the Tickets tile's skeleton) or landed (the brief tile first in a new bento). */
const loadingPaint = () => new El({}, [new El({ "data-mw": "tickets" }, [new El({ head: "" }), new El({ "data-skel": "mw-tickets" })])]);
const landedPaint = () => {
  const brief = new El({ "data-mw": "brief", "data-settle-with": "mw-tickets" });
  const mount = new El({}, [brief, new El({ "data-mw": "review" }), new El({ "data-mw": "tickets" }, [new El({ head: "" }), new El({ rows: "" })])]);
  return { mount, brief };
};

describe("landing after the entrance, the brief takes the dashboard skeleton's one fade", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("the brief tile settles with the read whose skeleton was on screen; the fade's clock is kept, then it ends", () => {
    vi.stubGlobal("HTMLElement", El);
    syncSkeletons(loadingPaint() as unknown as HTMLElement, "mywork-a", 1000);
    const t0 = 1000 + SKEL_DELAY_MS + 250;
    const p1 = landedPaint();
    syncSkeletons(p1.mount as unknown as HTMLElement, "mywork-a", t0);
    expect(p1.brief.cls.has("cnpy-settle")).toBe(true);
    expect(p1.brief.props.get("--settle-t")).toBe("0ms");
    // A rerender mid-fade (a fresh DOM) joins the same fade, never restarts it…
    const p2 = landedPaint();
    syncSkeletons(p2.mount as unknown as HTMLElement, "mywork-a", t0 + 100);
    expect(p2.brief.props.get("--settle-t")).toBe("-100ms");
    // …and once it is over, nothing replays.
    const p3 = landedPaint();
    syncSkeletons(p3.mount as unknown as HTMLElement, "mywork-a", t0 + SETTLE_MS + 1);
    expect(p3.brief.cls.has("cnpy-settle")).toBe(false);
  });

  it("a read that beat the skeleton's delay never showed one: no fade", () => {
    vi.stubGlobal("HTMLElement", El);
    syncSkeletons(loadingPaint() as unknown as HTMLElement, "mywork-b", 5000);
    const p = landedPaint();
    syncSkeletons(p.mount as unknown as HTMLElement, "mywork-b", 5000 + SKEL_DELAY_MS - 50);
    expect(p.brief.cls.has("cnpy-settle")).toBe(false);
  });

  it("a brief already on screen (no skeleton gone in this paint) gets no fade on a rerender", () => {
    vi.stubGlobal("HTMLElement", El);
    const p = landedPaint();
    syncSkeletons(p.mount as unknown as HTMLElement, "mywork-c", 9000);
    syncSkeletons(p.mount as unknown as HTMLElement, "mywork-c", 9500);
    expect(p.brief.cls.has("cnpy-settle")).toBe(false);
  });
});
