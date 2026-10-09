/**
 * A tab switch is not a navigation. On every tabbed page — and above all on the two that were
 * built last, Org settings and Platform — clicking a tab must swap the tab's body in place:
 *   • no screen entrance (trov.css `[data-enter]`): main.ts keys the entrance on `pageKey`,
 *     the route WITHOUT its tab, so two tabs of one page share a key;
 *   • nothing loaded goes back to "loading": Org settings' tab act asks the network nothing,
 *     and re-entering the page (or Platform re-reading a tab) REFRESHES a slice — it stays
 *     "ok" with the rows it has until the fresh ones land;
 *   • the tab bar is the same element: the page is patched in place (`data-morph`), and only
 *     the panel — keyed by its tab (`data-morph-key`) — is replaced.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { pageKey, parseHash, hashForRoute, type Route } from "../web/src/hash";
import { createOrgController } from "../web/src/org-actions";
import { createPlatform } from "../web/src/platform-actions";
import { ORG_TABS, orgTabsFor } from "../web/src/org-settings";
import { PLAT_TABS } from "../web/src/platform";
import { render, initialState, type AppState } from "../web/src/render";
import { tabBar, tabPanelAttrs } from "../web/src/tabs";
import { segmented } from "../web/src/segmented";
import { setApiOrg } from "../web/src/api";
import mainSrc from "../web/src/main.ts?raw";
import morphSrc from "../web/src/morph.ts?raw";

const route = (hash: string): Route => parseHash(hash);

describe("pageKey — the page a route is on, without its tab", () => {
  it("is one key for every tab of Org settings", () => {
    const keys = new Set(ORG_TABS.map((t) => pageKey({ screen: "org", ticketId: null, sprintId: null, orgTab: t })));
    expect([...keys]).toEqual(["#org"]);
  });
  it("is one key for every tab of Platform, and another for an organization's page", () => {
    const keys = new Set(PLAT_TABS.map((t) => pageKey({ screen: "platform", ticketId: null, sprintId: null, platTab: t })));
    expect([...keys]).toEqual(["#platform"]);
    expect(pageKey(route("#platform/orgs/acme"))).toBe("#platform/orgs/acme");
  });
  it("is one key for the tabs and switches the older pages have", () => {
    expect(pageKey(route("#roadmap/timeline"))).toBe(pageKey(route("#roadmap")));
    expect(pageKey(route("#repo/ci"))).toBe(pageKey(route("#repo")));
    expect(pageKey(route("#releases/0.14/patches"))).toBe(pageKey(route("#releases/0.14")));
  });
  it("still tells two pages apart", () => {
    expect(pageKey(route("#tickets/3"))).not.toBe(pageKey(route("#tickets/4")));
    expect(pageKey(route("#org"))).not.toBe(pageKey(route("#platform")));
    expect(pageKey(route("#releases/0.14"))).not.toBe(pageKey(route("#releases")));
  });
  it("never changes where a route points: the tab stays in the hash", () => {
    expect(hashForRoute(route("#org/members"))).toBe("#org/members");
    expect(hashForRoute(route("#platform/usage"))).toBe("#platform/usage");
  });
});

describe("main.ts — the entrance and Back / Forward", () => {
  it("an old spelling of the place already on screen is rewritten in the address bar, with no reload", () => {
    expect(mainSrc).toMatch(/if \(sameRoute\(r, cur\)\) \{[\s\S]{0,260}const want = hashForRoute\(cur\);\s*if \(location\.hash !== want\) history\.replaceState\(null, "", want\);\s*return;/);
  });
  it("keys the screen entrance on pageKey, so a tab switch never replays it", () => {
    expect(mainSrc).toMatch(/const key = `\$\{pageKey\(currentRoute\(\)\)\}\|/);
    // No hand-written list of tabs to forget one from.
    expect(mainSrc).not.toMatch(/hashForRoute\(\{ \.\.\.currentRoute\(\), [^}]*Tab: undefined/);
  });
  it("Back / Forward between two Org settings tabs is the tab's own act, not a reload of the page", () => {
    expect(mainSrc).toMatch(/if \(r\.screen === "org" && cur\.screen === "org"\) \{ orgCtl\.act\("orgTab", r\.orgTab \?\? "integrations", null\); return; \}/);
  });
});

// ── the controllers, against a fetch that never answers ──────────────────────
let asked: string[] = [];
let pending: ((r: Response) => void)[] = [];
const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  asked = []; pending = [];
  vi.stubGlobal("document", { addEventListener() { /* the controllers' keyboard handlers */ } });
  vi.stubGlobal("fetch", (input: unknown) => { asked.push(String(input)); return new Promise<Response>((res) => { pending.push(res); }); });
  setApiOrg("acme");
});
afterEach(() => { vi.unstubAllGlobals(); setApiOrg(null); });

const mount = { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement;

function orgHarness(role: "owner" | "member" = "owner") {
  const state: AppState = initialState();
  state.view = "app"; state.screen = "org"; state.orgSlug = "acme";
  state.myOrgs = { status: "ok", data: { orgs: [{ slug: "acme", name: "Acme", role }], invites: [], can_create: true, superadmin: false } as never };
  let paints = 0;
  const ctl = createOrgController({
    state, mount, rerender: () => { paints++; }, flash: () => {}, unauth: () => {}, confirmOut: (then) => then(),
    reloadOrgs: () => Promise.resolve(null), leaveOrg: () => {},
  });
  const slices = () => { const u = state.org; return { settings: u.settings.status, members: u.members.status, invites: u.invites.status, repos: u.repos.status, envs: u.envs.status, integrations: u.integrations.status, audit: u.audit.status }; };
  /** Mark every slice loaded, as after the page's first reads landed. */
  const settle = () => {
    const u = state.org;
    u.settings = { status: "ok", data: null }; u.members = { status: "ok", data: [] }; u.invites = { status: "ok", data: [] };
    u.repos = { status: "ok", data: [] }; u.envs = { status: "ok", data: [] }; u.integrations = { status: "ok", data: null }; u.audit = { status: "ok", data: [] };
  };
  return { state, ctl, slices, settle, paints: () => paints };
}

describe("Org settings — switching tabs", () => {
  it("asks the network nothing and leaves every loaded slice loaded", () => {
    const h = orgHarness();
    h.ctl.load();
    expect(asked.length).toBeGreaterThan(0);          // the page's first reads
    h.settle();
    asked = [];
    for (const tab of orgTabsFor("owner")) {
      const before = h.paints();
      h.ctl.act("orgTab", tab, null);
      expect(h.state.org.tab).toBe(tab);
      expect(h.paints()).toBe(before + 1);            // ONE paint: the panel swaps, nothing else
      expect(Object.values(h.slices()).every((s) => s === "ok")).toBe(true);
    }
    expect(asked).toEqual([]);
  });

  it("coming back to the page refreshes what it holds without putting it back into loading", () => {
    const h = orgHarness();
    h.ctl.load();
    h.settle();
    asked = [];
    h.ctl.act("orgGo", "members", null);
    expect(asked.length).toBeGreaterThan(0);          // it does refresh…
    expect(Object.values(h.slices()).every((s) => s === "ok")).toBe(true);   // …behind what is on screen
  });

  it("a first read is still a loading state", () => {
    const h = orgHarness();
    h.ctl.load();
    expect(h.slices().members).toBe("loading");
    expect(h.slices().repos).toBe("loading");
  });

  it("opening a row's details is one paint and no request", () => {
    const h = orgHarness();
    h.ctl.load(); h.settle(); asked = [];
    const before = h.paints();
    h.ctl.act("orgRowToggle", "github_token:", null);
    h.ctl.act("orgRowToggle", "history", null);
    expect(h.state.org.openRows).toEqual(["github_token:", "history"]);
    h.ctl.act("orgRowToggle", "github_token:", null);
    expect(h.state.org.openRows).toEqual(["history"]);
    expect(h.paints()).toBe(before + 3);
    expect(asked).toEqual([]);
  });

  it("a member's tab switch is just as quiet (no admin-only read is ever asked)", () => {
    const h = orgHarness("member");
    h.ctl.load();
    expect(asked.some((u) => /integrations|invites|audit/.test(u))).toBe(false);
    h.settle();
    asked = [];
    for (const tab of orgTabsFor("member")) h.ctl.act("orgTab", tab, null);
    expect(asked).toEqual([]);
  });
});

function platHarness() {
  const state = initialState();
  state.view = "app"; state.screen = "platform"; state.plat.superadmin = true;
  let paints = 0;
  const ctl = createPlatform({
    state, mount, rerender: () => { paints++; }, flash: () => {}, unauth: () => {}, confirmOut: (then) => then(),
    leave: () => {}, reloadOrgs: () => Promise.resolve(null),
  });
  return { state, ctl, paints: () => paints };
}

describe("Platform — switching tabs", () => {
  it("entering the page reads every tab once, so a tab opens with its rows already there", () => {
    const h = platHarness();
    h.ctl.load();
    expect(asked.some((u) => u.includes("/api/platform/orgs"))).toBe(true);
    expect(asked.some((u) => u.includes("/api/platform/usage"))).toBe(true);
    expect(asked.some((u) => u.includes("/api/platform/admins"))).toBe(true);
    expect(asked.some((u) => u.includes("/api/platform/audit"))).toBe(true);
    expect(asked.some((u) => u.includes("/api/platform/grants"))).toBe(true); // the Access tab (0044_plans)
    expect(asked.some((u) => u.includes("/api/platform/support"))).toBe(true); // Support (0049): its rows, and the count the tab bar shows on every tab
    expect(asked.length).toBe(6);                     // each exactly once
  });

  it("a tab that is loaded stays loaded: no status flip, no emptied rows", () => {
    const h = platHarness();
    const p = h.state.plat;
    const row = { id: 1, at: "2026-10-01T00:00:00Z", actor: "a", action: "org.create", target: "acme", org: "acme", detail: {} };
    p.orgs = { status: "ok", data: [] }; p.admins = { status: "ok", data: [] };
    p.usage = { status: "ok", data: { days: 30 } as never }; p.audit = { status: "ok", data: [row as never] };
    for (const tab of PLAT_TABS) {
      h.ctl.act("platTab", tab, null);
      expect(p.tab).toBe(tab);
      expect([p.orgs.status, p.usage.status, p.admins.status, p.audit.status]).toEqual(["ok", "ok", "ok", "ok"]);
      expect(p.audit.data).toHaveLength(1);
      expect(p.usage.data).not.toBeNull();
    }
  });

  it("a new usage window keeps the old figures on screen while its own load", () => {
    const h = platHarness();
    const p = h.state.plat;
    p.tab = "usage"; p.usage = { status: "ok", data: { days: 30 } as never };
    h.ctl.act("platUsageDays", "7", null);
    expect(p.usageDays).toBe(7);
    expect(p.usage.status).toBe("loading");           // said by dimming (`plat-busy`), never by blanking
    expect(p.usage.data).not.toBeNull();
    void json;
  });
});

describe("the page is patched in place, and only the panel is replaced", () => {
  const app = (screen: AppState["screen"], patch: (s: AppState) => void = () => {}): string => {
    const s = initialState();
    s.view = "app"; s.screen = screen; s.orgSlug = "acme"; s.plat.superadmin = true;
    s.myOrgs = { status: "ok", data: { orgs: [{ slug: "acme", name: "Acme", role: "owner" }], invites: [], can_create: true, superadmin: true } as never };
    patch(s);
    return render(s);
  };
  it("Org settings and Platform name themselves to the patcher; a page swapped whole does not", () => {
    expect(app("org")).toMatch(/<main data-morph="org"/);
    expect(app("platform")).toMatch(/<main data-morph="platform"/);
    expect(app("platformorg")).toMatch(/<main data-morph="platformorg"/);
    expect(app("review")).toMatch(/<main data-morph="review"/);   // its list is keyed (web-ui.md › A row leaving a list)
    expect(app("feed")).not.toMatch(/<main data-morph=/);
  });
  it("the standalone Platform page does too", () => {
    const s = initialState();
    s.view = "platform"; s.screen = "platform"; s.plat.superadmin = true;
    expect(render(s)).toMatch(/class="cnpy-platpage plat" data-morph="platform"/);
  });
  it("two tabs render the SAME bar key and DIFFERENT panel keys", () => {
    const key = (html: string, re: RegExp) => re.exec(html)?.[1];
    const a = app("org", (s) => { s.org.tab = "repos"; }), b = app("org", (s) => { s.org.tab = "members"; });
    expect(key(a, /class="cnpy-tabs"[^>]*data-morph-key="([^"]+)"/)).toBe("tabs:org-tab");
    expect(key(a, /class="cnpy-tabs"[^>]*data-morph-key="([^"]+)"/)).toBe(key(b, /class="cnpy-tabs"[^>]*data-morph-key="([^"]+)"/));
    expect(key(a, /role="tabpanel"[^>]*data-morph-key="([^"]+)"/)).toBe("org-tab-panel:repos");
    expect(key(b, /role="tabpanel"[^>]*data-morph-key="([^"]+)"/)).toBe("org-tab-panel:members");
  });
  it("what sits above the tab bar keeps its place whether or not it has anything to show", () => {
    expect(app("org")).toMatch(/<div data-setup-slot>[\s\S]*?<\/div>\s*<div class="cnpy-tabs"/);
  });
  it("the sliding indicators are left to their own script (data-keep), keyed by their control", () => {
    expect(tabBar({ id: "x", ariaLabel: "X", act: "a", value: "1", tabs: [{ value: "1", label: "One" }] })).toContain('<span class="cnpy-tabs-ind" aria-hidden="true" data-keep></span>');
    expect(segmented({ id: "y", ariaLabel: "Y", act: "a", value: "1", options: [{ value: "1", label: "One" }] })).toMatch(/data-seg="y" data-morph-key="seg:y"[^>]*><span class="cnpy-seg-ind" aria-hidden="true" data-keep><\/span>/);
    expect(tabPanelAttrs("x", "1")).toContain('data-morph-key="x-panel:1"');
  });
  it("the patcher replaces a node whose key changed, and leaves a data-keep node alone", () => {
    expect(morphSrc).toMatch(/from\.getAttribute\("data-morph-key"\) !== \(to as Element\)\.getAttribute\("data-morph-key"\)\) \{ live\.replaceChild\(to, from\); continue; \}/);
    expect(morphSrc).toMatch(/if \(live\.hasAttribute\("data-keep"\)\) return;/);
  });
});
