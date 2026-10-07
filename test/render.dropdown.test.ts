/**
 * The dropdown (web/src/dropdown.ts) — the app's own "pick one of a short list", in place of a
 * native <select> (whose popup is the operating system's: unstyled, and it cannot animate).
 *   • the markup: a trigger at a field's height (`aria-haspopup="listbox"`, `aria-expanded`),
 *     and its menu as a root-level overlay (`role="listbox"` of `.cnpy-menurow` options, the
 *     current one check-marked, a role's one-line description under its name);
 *   • the motion: the entrance plays on the paint that opens it and never again, and EVERY way
 *     out — a pick, Escape, a click outside, Tab — goes through the closing state first;
 *   • Org settings' role controls and the Notifications tab's pickers are this, not a <select>.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
import { dropdown, dropdownMenu, createDropdowns, initialDropdownUi, DD_CLOSE_MS, type DropdownProps, type DropdownUi } from "../web/src/dropdown";
import { orgSettingsView, orgOverlays, orgDropdowns, initialOrgUi, inviteRoleDropdown, memberRoleDropdown, type OrgUi, type OrgSettingsProps } from "../web/src/org-settings";
import { ROLE_HINT } from "../web/src/org-ui";
import { render, initialState, type AppState } from "../web/src/render";
import type { MyOrg, OrgMember, OrgRole } from "@shared/orgs";

const closed = initialDropdownUi;
const ui = (o: Partial<DropdownUi>): DropdownUi => ({ ...closed(), ...o });
const base: DropdownProps = {
  id: "fruit", act: "pickFruit", arg: "bowl", value: "pear", ariaLabel: "Fruit",
  options: [{ value: "apple", label: "Apple", hint: "Crisp." }, { value: "pear", label: "Pear", shown: "A pear" }, { value: "<fig>", label: "Fig & <jam>" }],
};
/** The opening tag of the element carrying `marker`. */
const tag = (html: string, marker: string): string => { const at = html.indexOf(marker); const from = html.lastIndexOf("<", at); return html.slice(from, html.indexOf(">", at) + 1); };

describe("dropdown — the trigger", () => {
  it("is a real button showing the current choice and a caret, named for what it is", () => {
    const html = dropdown(base, closed());
    expect(html).toMatch(/^<button type="button" id="fruit" data-field="fruit" data-dd="fruit" data-act="ddToggle" data-arg="fruit" class="cnpy-dd"/);
    expect(html).toContain('aria-haspopup="listbox" aria-expanded="false" aria-label="Fruit: A pear"');
    expect(html).toContain('<span class="cnpy-dd-v">A pear</span><svg class="cnpy-dd-caret"');
    expect(html).not.toContain("<select");
    expect(html).not.toContain("aria-controls");
  });
  it("named by a visible label, it reads as that label and its own value", () => {
    expect(dropdown({ ...base, ariaLabel: undefined, labelledBy: "fruit-l" }, closed())).toContain('aria-labelledby="fruit-l fruit"');
  });
  it("open, it says so and points at its menu; on its way out it is already at rest", () => {
    const open = dropdown(base, ui({ open: "fruit" }));
    expect(open).toContain('class="cnpy-dd is-open"');
    expect(open).toContain('aria-expanded="true" aria-controls="fruit-menu"');
    const closing = dropdown(base, ui({ open: "fruit", closing: true }));
    expect(closing).toContain('aria-expanded="false"');
    expect(closing).not.toContain("is-open");
    // Another dropdown being open is not this one being open.
    expect(dropdown(base, ui({ open: "other" }))).toContain('aria-expanded="false"');
  });
  it("disabled, it is a disabled button with no act — not a way into a menu, even if state names it", () => {
    const html = dropdown({ ...base, disabled: true }, ui({ open: "fruit" }));
    expect(html).toMatch(/data-dd="fruit" disabled class="cnpy-dd"/);
    expect(html).not.toContain("data-act");
    expect(html).toContain('aria-expanded="false"');
    expect(dropdownMenu([{ ...base, disabled: true }], ui({ open: "fruit" }))).toBe("");
  });
  it("sizes: a form field by default, compact in a row, stretched across a field", () => {
    expect(dropdown({ ...base, size: "sm", fill: true }, closed())).toContain('class="cnpy-dd is-sm is-fill"');
    expect(css).toMatch(/\.cnpy-dd \{[^}]*height:36px;/);
  });
});

describe("dropdown — the menu", () => {
  it("is nothing while closed, and only the open one's among a screen's dropdowns", () => {
    expect(dropdownMenu([base], closed())).toBe("");
    const other = { ...base, id: "veg", act: "pickVeg" };
    const html = dropdownMenu([other, base], ui({ open: "fruit" }));
    expect(html).toContain('data-dd-pop="fruit"');
    expect(html).not.toContain("pickVeg");
  });
  it("is a root-level overlay: a backdrop that closes it, and a listbox of options", () => {
    const html = dropdownMenu([base], ui({ open: "fruit" }));
    expect(html).toMatch(/^<div data-overlay="dd-fruit" class="cnpy-dd-layer">/);
    expect(html).toContain('<div data-act="ddClose" class="cnpy-dd-back" aria-hidden="true"></div>');
    expect(tag(html, 'role="listbox"')).toContain('id="fruit-menu" role="listbox" aria-label="Fruit" tabindex="-1" data-dd-pop="fruit" data-dd-act="pickFruit" data-dd-arg="bowl" data-dd-value="pear"');
    expect(html.match(/role="option"/g)).toHaveLength(3);
    expect(html.match(/class="cnpy-menurow cnpy-dd-opt/g)).toHaveLength(3);
  });
  it("marks the current choice: aria-selected, and the one visible check", () => {
    const html = dropdownMenu([base], ui({ open: "fruit" }));
    expect(html).toContain('aria-selected="true" tabindex="-1" data-act="ddPick" data-arg="pear" data-dd-opt class="cnpy-menurow cnpy-dd-opt is-on"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html.match(/aria-selected="false"/g)).toHaveLength(2);
    expect(css).toContain(".cnpy-dd-check { flex:none; color:var(--accent); visibility:hidden; }");
    expect(css).toContain(".cnpy-dd-opt.is-on .cnpy-dd-check { visibility:visible; }");
  });
  it("a row carries its one-line description; values and labels are escaped", () => {
    const html = dropdownMenu([base], ui({ open: "fruit" }));
    expect(html).toContain('<span class="cnpy-dd-optl">Apple</span><span class="cnpy-dd-opth">Crisp.</span>');
    expect(html).toContain('data-arg="&lt;fig&gt;"');
    expect(html).toContain("Fig &amp; &lt;jam&gt;");
    // The menu shows the option's own name; `shown` is only the trigger's wording.
    expect(html).toContain('<span class="cnpy-dd-optl">Pear</span>');
    expect(html).not.toContain("A pear");
  });
  it("plays its entrance only on the paint that opens it, and its exit while closing", () => {
    expect(tag(dropdownMenu([base], ui({ open: "fruit", opening: true })), "data-dd-pop")).toContain("cnpy-dd-pop cnpy-scroll is-opening");
    expect(dropdownMenu([base], ui({ open: "fruit" }))).not.toContain("is-opening");
    const closing = dropdownMenu([base], ui({ open: "fruit", closing: true }));
    expect(closing).toMatch(/^<div data-overlay="dd-fruit" class="cnpy-dd-layer" data-closing>/);
    expect(closing).not.toContain("is-opening");
  });
});

describe("dropdown — the styles (trov.css)", () => {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const dd = rules.split("\n").filter((l) => l.includes(".cnpy-dd") || l.includes("--menu-shadow")).join("\n");
  it("the entrance is the link menu's pop and the exit its own keyframes, each on its state only", () => {
    expect(dd).toContain(".cnpy-dd-pop.is-opening { animation:cnpy-lkpop .14s cubic-bezier(.2,.9,.3,1.2) both; }");
    expect(dd).toContain(".cnpy-dd-layer[data-closing] .cnpy-dd-pop { animation:cnpy-dd-out .12s cubic-bezier(.4,0,1,1) both; }");
    expect(rules).toMatch(/@keyframes cnpy-dd-out \{ to \{ opacity:0; transform:scale\(\.94\); \} \}/);
    expect(DD_CLOSE_MS).toBe(120);
    // No animation on the popover at rest: a rerender has nothing to replay.
    expect(dd).not.toMatch(/^\.cnpy-dd-pop \{[^}]*animation/m);
  });
  it("it grows from the trigger's corner, wherever it was placed", () => {
    expect(dd).toMatch(/\.cnpy-dd-pop \{[^}]*transform-origin:top left;/);
    expect(dd).toContain('.cnpy-dd-pop[data-side="up"] { transform-origin:bottom left; }');
    expect(dd).toContain('.cnpy-dd-pop[data-align="right"] { transform-origin:top right; }');
  });
  it("prefers-reduced-motion turns both off", () => {
    expect(dd).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[^\n]*\.cnpy-dd-pop\.is-opening, \.cnpy-dd-layer\[data-closing\] \.cnpy-dd-pop \{ animation:none !important; \}/);
  });
  it("overlays the page (fixed, at the root) instead of pushing it, and a closing one lets clicks through", () => {
    expect(dd).toContain(".cnpy-dd-layer { position:fixed; inset:0; z-index:95; }");
    expect(dd).toMatch(/\.cnpy-dd-pop \{ position:fixed;[^}]*max-width:min\(440px, calc\(100vw - 16px\)\);[^}]*overflow-y:auto;/);
    expect(dd).toContain(".cnpy-dd-layer[data-closing] { pointer-events:none; }");
  });
  it("uses the app's tokens only: no raw colour outside the shadow token's own definition", () => {
    const body = dd.split("\n").filter((l) => !l.includes("--menu-shadow:")).join("\n");
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(body).toMatch(/\.cnpy-dd-pop \{[^}]*background:var\(--surface\); border:1px solid var\(--border-strong\); box-shadow:var\(--menu-shadow\);/);
    expect(dd).toMatch(/\[data-cnpy-theme="light"\] \{ --menu-shadow:[^}]+\}\n\[data-cnpy-theme="dark"\] \{ --menu-shadow:[^}]+\}/);
  });
  it("shows where the keyboard is, on the trigger and on a row, and what is disabled", () => {
    expect(dd).toContain(".cnpy-dd:focus-visible { outline:2px solid color-mix(in srgb,var(--accent) 70%,transparent); outline-offset:2px; }");
    expect(dd).toContain(".cnpy-dd-opt:focus-visible { outline:none; background:var(--hover); }");
    expect(dd).toMatch(/\.cnpy-dd:disabled \{ cursor:default;[^}]*opacity:\.7; \}/);
  });
});

// ── the controller, against a fake page ──────────────────────────────────────
type KeyHandler = (e: Record<string, unknown>) => void;
function harness(o: { reducedMotion?: boolean } = {}) {
  const state = { dd: initialDropdownUi() };
  const keys: KeyHandler[] = [];
  vi.stubGlobal("document", { addEventListener: (type: string, fn: KeyHandler) => { if (type === "keydown") keys.push(fn); }, activeElement: null });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: !!o.reducedMotion }), addEventListener() { /* scroll / resize re-place the menu */ } });
  /** What each paint saw: the flags a render would have read. */
  const paints: DropdownUi[] = [];
  const dispatched: [string, string | null, string | null][] = [];
  const focused: string[] = [];
  // The fake page: the open dropdown's trigger and menu exist, with the act its menu carries.
  const pop = { dataset: { ddAct: "pickFruit", ddArg: "bowl", ddValue: "pear" } as Record<string, string>, querySelector: () => null, querySelectorAll: () => [] };
  const mount = {
    querySelector: (sel: string) => (sel.startsWith("[data-dd-pop=") ? pop : sel.startsWith("[data-dd=") ? { focus: () => { focused.push(sel); } } : null),
  } as unknown as HTMLElement;
  const ctl = createDropdowns({ state, mount, rerender: () => { paints.push({ ...state.dd }); }, dispatch: (a, b, c) => { dispatched.push([a, b, c]); } });
  const key = (k: string, target: unknown = null) => { const e = { key: k, target, preventDefault: vi.fn(), stopPropagation: vi.fn() }; for (const fn of keys) fn(e); return e; };
  return { state, ctl, paints, dispatched, focused, key };
}

describe("dropdown — opening and closing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("opening paints ONCE with the opening flag, and the flag is gone for every later paint", () => {
    const h = harness();
    h.ctl.act("ddToggle", "fruit");
    expect(h.paints).toEqual([{ open: "fruit", opening: true, closing: false }]);
    expect(h.state.dd).toEqual({ open: "fruit", opening: false, closing: false });
    // A later, unrelated rerender renders the menu without its entrance.
    expect(dropdownMenu([base], h.state.dd)).not.toContain("is-opening");
    // Toggling the open one's trigger again is not a second opening.
    h.ctl.act("ddToggle", "fruit");
    expect(h.paints.filter((p) => p.opening)).toHaveLength(1);
  });

  const closes: [string, (h: ReturnType<typeof harness>) => void][] = [
    ["its trigger, pressed again", (h) => h.ctl.act("ddToggle", "fruit")],
    ["a click outside (the backdrop)", (h) => h.ctl.act("ddClose", null)],
    ["Escape", (h) => { const e = h.key("Escape"); expect(e.preventDefault).toHaveBeenCalled(); expect(e.stopPropagation).toHaveBeenCalled(); }],
    ["Tab (tabbing away)", (h) => { const e = h.key("Tab"); expect(e.preventDefault).not.toHaveBeenCalled(); }],
    ["picking the current value", (h) => h.ctl.act("ddPick", "pear")],
    ["picking another value", (h) => h.ctl.act("ddPick", "apple")],
  ];
  for (const [name, close] of closes) {
    it(`closes through the closing state — ${name}`, () => {
      const h = harness();
      h.ctl.act("ddToggle", "fruit");
      h.paints.length = 0;
      close(h);
      // Still in the DOM, marked closing (the exit plays), focus back on the trigger…
      expect(h.state.dd).toEqual({ open: "fruit", opening: false, closing: true });
      expect(h.paints.at(-1)).toEqual({ open: "fruit", opening: false, closing: true });
      expect(h.focused).toEqual(['[data-dd="fruit"]']);
      vi.advanceTimersByTime(DD_CLOSE_MS - 1);
      expect(h.state.dd.open).toBe("fruit");
      // …and gone only once the exit is over.
      vi.advanceTimersByTime(1);
      expect(h.state.dd).toEqual(closed());
      expect(h.paints.at(-1)).toEqual(closed());
      expect(h.paints.some((p) => p.opening)).toBe(false);
    });
  }

  it("a pick dispatches the dropdown's own act with the option as the value — once, before the menu is gone", () => {
    const h = harness();
    h.ctl.act("ddToggle", "fruit");
    h.ctl.act("ddPick", "apple");
    expect(h.dispatched).toEqual([["pickFruit", "bowl", "apple"]]);
    h.ctl.act("ddPick", "apple");               // a second click on the way out does nothing
    vi.runAllTimers();
    expect(h.dispatched).toHaveLength(1);
  });
  it("re-picking the current value closes without dispatching anything", () => {
    const h = harness();
    h.ctl.act("ddToggle", "fruit");
    h.ctl.act("ddPick", "pear");
    vi.runAllTimers();
    expect(h.dispatched).toEqual([]);
    expect(h.state.dd.open).toBeNull();
  });
  it("reopened while on its way out, it comes back with its entrance and is not closed under the person", () => {
    const h = harness();
    h.ctl.act("ddToggle", "fruit");
    h.ctl.act("ddClose", null);
    h.ctl.act("ddToggle", "fruit");
    expect(h.paints.at(-1)).toEqual({ open: "fruit", opening: true, closing: false });
    vi.runAllTimers();
    expect(h.state.dd.open).toBe("fruit");
  });
  it("only one is open at a time: opening another replaces it", () => {
    const h = harness();
    h.ctl.act("ddToggle", "fruit");
    h.ctl.act("ddToggle", "veg");
    expect(h.state.dd.open).toBe("veg");
    expect(dropdown(base, h.state.dd)).toContain('aria-expanded="false"');
  });
  it("under prefers-reduced-motion it closes at once (no exit to wait for)", () => {
    const h = harness({ reducedMotion: true });
    h.ctl.act("ddToggle", "fruit");
    h.ctl.act("ddClose", null);
    expect(h.state.dd).toEqual(closed());
  });
  it("↓ / ↑ on a closed trigger open it; on a disabled one, or anywhere else, they do nothing", () => {
    const h = harness();
    const on = (el: unknown) => ({ closest: () => el });
    h.key("ArrowDown", on(null));
    expect(h.state.dd.open).toBeNull();
    const e = h.key("ArrowDown", on({ dataset: { dd: "fruit" } }));
    expect(e.preventDefault).toHaveBeenCalled();
    expect(h.state.dd.open).toBe("fruit");
    expect(h.paints).toEqual([{ open: "fruit", opening: true, closing: false }]);
  });
  it("a menu whose trigger left the screen is dropped at once, without a paint of its own", () => {
    const state = { dd: ui({ open: "gone" }) };
    vi.stubGlobal("document", { addEventListener() {} });
    let paints = 0;
    const ctl = createDropdowns({ state, mount: { querySelector: () => null } as unknown as HTMLElement, rerender: () => { paints++; }, dispatch: () => {} });
    ctl.afterPaint();
    expect(state.dd).toEqual(closed());
    expect(paints).toBe(0);
  });
});

describe("main.ts wires it once", () => {
  it("the three acts go to the controller, and the menu is placed after every paint", () => {
    expect(mainSrc).toContain('case "ddToggle": case "ddPick": case "ddClose": dropdowns.act(act, arg); return;');
    expect(mainSrc).toMatch(/orgCtl\.afterPaint\(\);\s*dropdowns\.afterPaint\(\);/);
    expect(mainSrc).toContain("dispatch: (act, arg, value) => dispatch(act, arg, value)");
  });
});

// ── Org settings: the role controls ──────────────────────────────────────────
const org = (role: OrgRole = "owner"): MyOrg => ({ slug: "acme", name: "Acme", role });
const member = (handle: string, role: OrgRole): OrgMember => ({ handle, name: handle[0].toUpperCase() + handle.slice(1), role, title: null, responsibilities: null, joined_at: "2026-09-01T00:00:00Z" } as unknown as OrgMember);
function orgUi(over: Partial<OrgUi> = {}): OrgUi {
  return { ...initialOrgUi(), tab: "members", members: { status: "ok", data: [member("andres", "owner"), member("mira", "admin"), member("jonas", "member")] }, invites: { status: "ok", data: [] }, ...over };
}
const props = (u: OrgUi, role: OrgRole = "owner", dd: DropdownUi = closed()): OrgSettingsProps => ({ org: org(role), orgsStatus: "ok", me: "andres", ui: u, dd });
const editing = (handle: string, role: OrgRole, saving = false) => ({ handle, role, title: "", responsibilities: "", saving, error: null });

describe("Org settings › Members — the role dropdowns", () => {
  it("no native <select> remains on the tab, with or without an editor open", () => {
    expect(orgSettingsView(props(orgUi()))).not.toContain("<select");
    expect(orgSettingsView(props(orgUi({ memberEdit: editing("mira", "admin") })))).not.toContain("<select");
    expect(orgSettingsView(props(orgUi({ tab: "notifications" })))).not.toContain("<select");
  });
  it("the invite's role: member or admin, said as “As …” on the trigger, each with what it can do", () => {
    const html = orgSettingsView(props(orgUi()));
    expect(html).toMatch(/id="org-invite-role"[^>]*data-act="ddToggle" data-arg="org-invite-role"[^>]*aria-haspopup="listbox" aria-expanded="false" aria-label="Role the invite grants: As member"><span class="cnpy-dd-v">As member<\/span>/);
    expect(orgSettingsView(props(orgUi({ inviteRole: "admin" })))).toContain('<span class="cnpy-dd-v">As admin</span>');
    const d = inviteRoleDropdown(orgUi());
    expect(d).toMatchObject({ act: "orgInviteRole", value: "member" });
    expect(d.options).toEqual([
      { value: "member", label: "Member", shown: "As member", hint: ROLE_HINT.member },
      { value: "admin", label: "Admin", shown: "As admin", hint: ROLE_HINT.admin },
    ]);
  });
  it("each role's description is one short line, and each builds on the one before", () => {
    for (const r of ["member", "admin", "owner"] as const) { expect(ROLE_HINT[r]).not.toContain("\n"); expect(ROLE_HINT[r].length).toBeLessThanOrEqual(72); }
    expect(ROLE_HINT.member).toMatch(/^Reads everything/);
    for (const w of ["people", "repositories", "environments", "integrations", "notifications"]) expect(ROLE_HINT.admin).toContain(w);
    expect(ROLE_HINT.admin).toMatch(/^Also /);
    expect(ROLE_HINT.owner).toMatch(/^Also .*owners.*encryption key/);
  });
  it("the editor's role: an owner may grant Owner, an admin may not; the label names it", () => {
    const u = orgUi({ memberEdit: editing("mira", "admin") });
    const html = orgSettingsView(props(u));
    expect(html).toContain('<div id="org-member-role-l"');
    expect(html).toMatch(/id="org-member-role"[^>]*aria-labelledby="org-member-role-l org-member-role"><span class="cnpy-dd-v">Admin<\/span>/);
    expect(memberRoleDropdown(member("mira", "admin"), u.memberEdit!, "owner")).toMatchObject({ act: "orgMemberRole", value: "admin", disabled: false });
    expect(memberRoleDropdown(member("mira", "admin"), u.memberEdit!, "owner").options.map((o) => o.label)).toEqual(["Owner", "Admin", "Member"]);
    expect(memberRoleDropdown(member("mira", "admin"), u.memberEdit!, "admin").options.map((o) => o.label)).toEqual(["Admin", "Member"]);
  });
  it("locked — an admin editing an owner, or a save in flight — it is disabled and keeps its sentence", () => {
    const locked = orgSettingsView(props(orgUi({ memberEdit: editing("andres", "owner") }), "admin"));
    expect(locked).toMatch(/<button type="button" id="org-member-role" data-field="org-member-role" data-dd="org-member-role" disabled class="cnpy-dd"/);
    expect(locked).toContain("Only an owner can change an owner's role.");
    expect(tag(locked, 'id="org-member-role"')).not.toContain("data-act");
    const saving = orgSettingsView(props(orgUi({ memberEdit: editing("mira", "admin", true) })));
    expect(tag(saving, 'id="org-member-role"')).toContain(" disabled ");
    // State cannot open a locked one.
    const p = props(orgUi({ memberEdit: editing("andres", "owner") }), "admin", ui({ open: "org-member-role" }));
    expect(orgOverlays(p)).toBe("");
    expect(tag(orgSettingsView(p), 'id="org-member-role"')).toContain('aria-expanded="false"');
  });
  it("the open one's menu is a root overlay beside the page, never inside the tab's surfaces", () => {
    const u = orgUi({ memberEdit: editing("jonas", "member") });
    const dd = ui({ open: "org-member-role", opening: true });
    expect(orgSettingsView(props(u, "owner", dd))).not.toContain("cnpy-dd-pop");
    const menu = orgOverlays(props(u, "owner", dd));
    expect(menu).toMatch(/^<div data-overlay="dd-org-member-role" class="cnpy-dd-layer">/);
    expect(tag(menu, 'role="listbox"')).toContain('aria-labelledby="org-member-role-l"');
    expect(tag(menu, 'role="listbox"')).toContain('data-dd-act="orgMemberRole"');
    expect(menu).toContain(`<span class="cnpy-dd-optl">Owner</span><span class="cnpy-dd-opth">${ROLE_HINT.owner}</span>`);
    expect(menu).toMatch(/aria-selected="true"[^>]*data-arg="member"/);
    // The invite's, when it is the open one — and nothing for a member, who has neither control.
    expect(orgOverlays(props(u, "owner", ui({ open: "org-invite-role" })))).toContain('data-dd-act="orgInviteRole"');
    expect(orgDropdowns(props(u, "member"))).toEqual([]);
    expect(orgOverlays(props(u, "member", ui({ open: "org-invite-role" })))).toBe("");
  });
  it("a dropdown of another tab is not on screen, so state cannot open it here", () => {
    const u = orgUi({ tab: "general" });
    expect(orgOverlays(props(u, "owner", ui({ open: "org-invite-role" })))).toBe("");
  });
});

describe("the whole app — opening a dropdown changes the menu and its trigger, nothing else", () => {
  const app = (patch: (s: AppState) => void): string => {
    const s = initialState();
    s.view = "app"; s.screen = "org"; s.orgSlug = "acme"; s.org = orgUi();
    s.myOrgs = { status: "ok", data: { orgs: [org("owner")], invites: [], can_create: true, superadmin: false } as never };
    patch(s);
    return render(s);
  };
  const strip = (html: string) => html.replace(/<div data-overlay="dd-[\s\S]*?<\/div>\s*<\/div>\n?/, "").replace(/<button type="button" id="org-invite-role"[\s\S]*?<\/button>/, "");
  it("the page, its tab bar and its panel are the same markup open or closed (the patcher has nothing to replace)", () => {
    const shut = app(() => {});
    const open = app((s) => { s.dd = ui({ open: "org-invite-role", opening: true }); });
    expect(open).toContain('data-overlay="dd-org-invite-role"');
    expect(shut).not.toContain("cnpy-dd-layer");
    expect(strip(open).replace(/\s+/g, " ")).toBe(strip(shut).replace(/\s+/g, " "));
    const key = (html: string, re: RegExp) => re.exec(html)?.[1];
    expect(key(open, /role="tabpanel"[^>]*data-morph-key="([^"]+)"/)).toBe(key(shut, /role="tabpanel"[^>]*data-morph-key="([^"]+)"/));
    expect(open).toMatch(/<main data-morph="org"/);
  });
  it("the paint after the opening one renders the same menu without its entrance; a closing one keeps its overlay key", () => {
    const opening = app((s) => { s.dd = ui({ open: "org-invite-role", opening: true }); });
    const later = app((s) => { s.dd = ui({ open: "org-invite-role" }); });
    const closing = app((s) => { s.dd = ui({ open: "org-invite-role", closing: true }); });
    expect(opening).toContain("cnpy-dd-pop cnpy-scroll is-opening");
    expect(later).not.toContain("is-opening");
    expect(later.replace(" is-opening", "")).toBe(opening.replace(" is-opening", ""));
    expect(closing).toContain('<div data-overlay="dd-org-invite-role" class="cnpy-dd-layer" data-closing>');
  });
});
