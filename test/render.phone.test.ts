/**
 * Phone and tablet layout — the structural pieces the mobile pass added.
 *
 * At phone width (main.ts `state.phone`, ≤ 640px) the rail leaves the layout and opens as a
 * drawer from the header's menu button. The drawer is the SAME <aside> the sidebar tree test
 * pins (web/src/morph.ts patches it in place), so the phone state may only flip attributes on
 * the root — never change the sidebar's element tree. The rest of the pass is CSS keyed on
 * classes the templates carry (header wrap, board scroll, table cards, review / docs panes,
 * sheets); these tests pin that the hooks exist and the CSS that uses them is there.
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/canopy.css?raw";
import { render, initialState, railCollapsed, type AppState } from "../web/src/render";
import { reviewView, type ReviewItem, type ReviewProps } from "../web/src/review";

const app = (over: Partial<AppState> = {}): AppState => ({ ...initialState(), view: "app", ...over });
const skeleton = (html: string): string => (html.match(/<\/?[a-z][a-z0-9]*/gi) ?? []).join(" ");
const asideOf = (html: string): string => html.slice(html.indexOf('<aside class="cnpy-aside"'), html.indexOf("</aside>") + 8);
/** The CSS with comments stripped, whitespace collapsed. */
const rules = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

describe("phone drawer — attributes on the root, never a different tree", () => {
  it("marks the root data-phone / data-drawer; the drawer only counts on a phone", () => {
    expect(render(app())).toContain('data-phone="0" data-drawer="0"');
    expect(render(app({ phone: true, narrow: true }))).toContain('data-phone="1" data-drawer="0"');
    expect(render(app({ phone: true, narrow: true, drawer: true }))).toContain('data-phone="1" data-drawer="1"');
    // A stale open drawer never shows once the viewport is wide again.
    expect(render(app({ phone: false, drawer: true }))).toContain('data-phone="0" data-drawer="0"');
  });

  it("the drawer is the FULL rail: a phone renders it expanded, whatever the preference", () => {
    const s = app({ phone: true, narrow: true, collapsed: true });
    expect(railCollapsed(s)).toBe(false);
    expect(render(s)).toContain('data-collapsed="0"');
    // Between phone and 900px the rail stays the collapsed 64px one.
    expect(railCollapsed(app({ phone: false, narrow: true }))).toBe(true);
  });

  it("keeps the sidebar's element tree identical on a phone, drawer open or shut", () => {
    const base = skeleton(asideOf(render(app())));
    expect(skeleton(asideOf(render(app({ phone: true, narrow: true }))))).toBe(base);
    expect(skeleton(asideOf(render(app({ phone: true, narrow: true, drawer: true }))))).toBe(base);
  });

  it("always emits the menu button (header) and the scrim (shell), wired to the drawer acts", () => {
    const shut = render(app());
    expect(shut).toContain('data-act="openDrawer" class="cnpy-menubtn cnpy-iconbtn" aria-label="Open navigation" aria-expanded="false"');
    expect(shut).toContain('<div class="cnpy-scrim" data-act="closeDrawer" aria-hidden="true"></div>');
    expect(render(app({ phone: true, drawer: true }))).toContain('aria-expanded="true"');
    // The scrim sits in the shell, beside <main> — outside what paint() swaps.
    expect(shut.indexOf('class="cnpy-scrim"')).toBeGreaterThan(shut.indexOf("</main>"));
  });

  it("CSS: hidden off a phone; on a phone the rail is fixed off-canvas and slides in when open", () => {
    expect(rules).toContain(".cnpy-menubtn, .cnpy-scrim { display:none; }");
    expect(rules).toMatch(/\[data-phone="1"\] \.cnpy-aside \{[^}]*position:fixed;[^}]*transform:translateX\(-100%\);[^}]*visibility:hidden;/);
    expect(rules).toMatch(/\[data-phone="1"\]\[data-drawer="1"\] \.cnpy-aside \{[^}]*transform:none; visibility:visible;/);
    expect(rules).toMatch(/\[data-phone="1"\]\[data-drawer="1"\] \.cnpy-scrim \{ opacity:1; pointer-events:auto; \}/);
    // Finger-sized rows in the drawer.
    expect(rules).toMatch(/\[data-phone="1"\] \.cnpy-nav-i \{ padding-top:11px; padding-bottom:11px;/);
  });
});

describe("header at phone width — wraps, never overflows", () => {
  it("carries the hooks the phone rules key on", () => {
    const html = render(app({ screen: "tickets" }));
    expect(html).toContain('<header class="cnpy-hdr"');
    expect(html).toContain('class="cnpy-hdr-l"');
    expect(html).toContain('class="cnpy-hdr-r"');
  });
  it("wraps its controls under the title and lets a crumb claim no width of its own", () => {
    expect(rules).toMatch(/\[data-phone="1"\] \.cnpy-hdr \{ flex-wrap:wrap;/);
    expect(rules).toContain('[data-phone="1"] .cnpy-hdr-l > span { contain:inline-size;');
    // The Feed's right-anchored Filter menu becomes a bottom sheet.
    expect(rules).toMatch(/\[data-phone="1"\] \.fm-pop\.is-right \{ position:fixed !important;/);
  });
});

describe("narrow layouts — the hooks exist and their rules are there", () => {
  it("the ticket board scrolls sideways with a snap per column", () => {
    expect(rules).toMatch(/@media \(max-width:900px\) \{ \.cnpy-board \{[^}]*overflow-x:auto;[^}]*scroll-snap-type:x mandatory;/);
    expect(rules).toContain(".cnpy-board > .cnpy-tcol { scroll-snap-align:start; }");
  });

  it("the ticket table reflows into cards by its OWN width", () => {
    expect(rules).toContain(".cnpy-ttable { container:ttable / inline-size; }");
    expect(rules).toMatch(/@container ttable \(max-width: 640px\) \{ \.cnpy-thead \{ display:none !important; \}/);
  });

  it("Review: the list and the detail take turns, with a back button", () => {
    const item: ReviewItem = { id: "doc:x:2", kind: "proposal", eyebrow: "", badge: "STAGED", badgeColor: "var(--amber)", title: "T", summary: "", agent: "a", agentInitials: "A", time: "1d", diff: [] };
    const base: Omit<ReviewProps, "selectedId"> = { items: [item], filter: "all", diffView: "unified" };
    expect(reviewView({ ...base, selectedId: null })).toContain('class="cnpy-rv" data-pane="list"');
    const picked = reviewView({ ...base, selectedId: "doc:x:2" });
    expect(picked).toContain('class="cnpy-rv" data-pane="detail"');
    expect(picked).toContain('data-act="reviewBack" class="cnpy-rv-back"');
    expect(rules).toContain(".cnpy-rv-back { display:none; }");
  });

  it("Docs: the page list and the reader take turns behind a Pages button", () => {
    const html = render(app({ screen: "docs" }));
    expect(html).toContain('class="cnpy-docs" data-tree="0"');
    expect(html).toContain('data-act="docsTree"');
    expect(render(app({ screen: "docs", docsTree: true }))).toContain('class="cnpy-docs" data-tree="1"');
    expect(rules).toContain(".cnpy-docs-bar { display:none; }");
  });

  it("a modal is a bottom sheet on a phone, clear of the home indicator", () => {
    expect(rules).toMatch(/\[data-cnpy-theme\] \[role="dialog"\]\[aria-modal="true"\] \{ width:100% !important;[^}]*env\(safe-area-inset-bottom/);
    // The confirmation modal (web/src/confirm.ts) is an alertdialog — the same sheet.
    expect(rules).toMatch(/\[data-cnpy-theme\] \[role="alertdialog"\]\[aria-modal="true"\],\s*\[data-cnpy-theme\] \[role="dialog"\]\[aria-modal="true"\] \{ width:100% !important;/);
    expect(rules).toContain('[data-cnpy-theme] :has(> [role="alertdialog"][aria-modal="true"])');
  });

  it("text fields are 16px on a phone (no zoom-on-focus in iOS Safari)", () => {
    expect(rules).toMatch(/@media \(max-width:640px\) \{ input:not\(\[type="checkbox"\]\)[^{]*, textarea, select \{ font-size:16px !important; \}/);
  });

  it("the app shell fills the visible viewport", () => {
    expect(rules).toContain("@supports (height:100dvh) { .cnpy-shell { height:100dvh !important; } }");
  });
});
