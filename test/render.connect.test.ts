/**
 * Settings › MCP access — OAuth only — and the Settings bento around it.
 *
 *  • mcpAccessSection — one line, the three browser sign-in steps, Connected apps, and a
 *    quiet link to the by-hand command; nothing mints or shows a token
 *  • mcpSetupModal — that command in a root-level modal, so the tile never grows
 *  • grantListBody — the OAuth connections, capped with "Show all", two-click revoke
 *  • the Get Started guide says the same thing, browser sign-in first
 *  • the bento — one twelve-column grid, tiles sized to their content, Sign out in its own tile
 */
import { describe, it, expect } from "vitest";
import { grantListBody, mcpAccessSection, mcpSetupModal, MCP_LIST_CAP, PLUGIN_INSTALL, browserConnectCommand, render, initialState } from "../web/src/render";
import { esc } from "../web/src/ui";
import css from "../web/src/trov.css?raw";

const URL = "https://trov.example.com/mcp";
const ME = { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 };

describe("browserConnectCommand", () => {
  it("adds the server with no header — Claude Code signs in through the browser", () => {
    expect(browserConnectCommand(URL)).toBe(`claude mcp add --transport http --scope user trov ${URL}`);
  });
});

describe("Get Started guide — Connect your agent", () => {
  const guideState = () => ({ ...initialState(), view: "app" as const, screen: "guide" as const, me: ME });

  it("leads with the plugin and the browser sign-in, the same three steps as Settings", () => {
    const html = render(guideState());
    const install = html.indexOf("/plugin install trov@trov");
    const auth = html.indexOf("Authenticate", install);
    const allow = html.indexOf("Allow", auth);
    expect(install).toBeGreaterThan(-1);
    expect(auth).toBeGreaterThan(install);
    expect(allow).toBeGreaterThan(auth);
    expect(html).toContain("Set it up without the plugin");
  });

  it("never sends anyone to mint a token in Settings, or to the retired connection command", () => {
    const html = render(guideState());
    expect(html).not.toContain("Get connection command");
    expect(html).not.toContain("mint a new token");
    expect(html).not.toContain("MCP access tokens");
    expect(html).not.toContain("/guide/connect-");
    // The variable may be named for an agent still on an older token (troubleshooting),
    // but the setup never asks anyone to export it.
    expect(html).not.toContain("export TROV_MCP_TOKEN");
    expect(html).not.toContain("set -Ux TROV_MCP_TOKEN");
  });
});

describe("grantListBody", () => {
  const grant = { id: 7, client_name: "Claude <Code>", created_at: "2026-09-20T00:00:00.000Z", last_used_at: null, mode: "manual" as const, org: { slug: "saplinglearn", name: "SaplingLearn" }, orgs: [{ slug: "saplinglearn", name: "SaplingLearn" }] };
  it("empty, loading and error states", () => {
    expect(grantListBody({ grants: { status: "ok", data: [] }, grantRevokeArm: null })).toContain("No apps connected");
    expect(grantListBody({ grants: { status: "loading", data: [] }, grantRevokeArm: null })).toContain("Loading");
    expect(grantListBody({ grants: { status: "error", data: [], error: "boom" }, grantRevokeArm: null })).toContain("boom");
  });
  it("one escaped row per grant with a two-click revoke", () => {
    const idle = grantListBody({ grants: { status: "ok", data: [grant] }, grantRevokeArm: null });
    expect(idle).toContain("Claude &lt;Code&gt;");
    expect(idle).toContain("never used");
    expect(idle).toContain(`data-act="revokeGrantArm" data-arg="7"`);
    const armed = grantListBody({ grants: { status: "ok", data: [grant] }, grantRevokeArm: 7 });
    expect(armed).toContain(`data-act="revokeGrant" data-arg="7"`);
    expect(armed).toContain(`data-act="revokeGrantCancel"`);
  });
  // The old list was a fixed-height scroller so the stretched bento never moved. The bento
  // balances by content instead, so the invariant is the opposite one: no fixed height, no
  // inner scroller — at most MCP_LIST_CAP rows, and only "Show all" grows the list.
  it("many apps show the first MCP_LIST_CAP, a count and a Show all N — never an inner scroller", () => {
    const many = { status: "ok" as const, data: [7, 8, 9, 10].map((id) => ({ ...grant, id })) };
    const shut = grantListBody({ grants: many, grantRevokeArm: null });
    expect(shut).toMatch(/^<div class="cnpy-mcp-list" data-list="grants">[\s\S]*<\/div>$/);
    expect(shut).not.toContain("cnpy-scroll");
    expect(shut).toMatch(/>Connected apps<\/span><span[^>]*>4<\/span>/);
    expect(shut.match(/data-act="revokeGrantArm"/g)).toHaveLength(MCP_LIST_CAP);
    expect(shut).toContain('data-act="mcpShowAll" aria-expanded="false"');
    expect(shut).toContain(">Show all 4<");
    const open = grantListBody({ grants: many, grantRevokeArm: null, grantsAll: true });
    expect(open.match(/data-act="revokeGrantArm"/g)).toHaveLength(4);
    expect(open).toContain(">Show fewer<");
    expect(grantListBody({ grants: { status: "ok", data: many.data.slice(0, MCP_LIST_CAP) }, grantRevokeArm: null })).not.toContain("mcpShowAll");
  });
});

describe("Settings › MCP access — the browser sign-in, then Connected apps", () => {
  const base = { grants: { status: "ok" as const, data: [] }, grantRevokeArm: null, grantsAll: false };

  it("reads top to bottom: the heading with the by-hand link, what it is, the three numbered steps, Connected apps", () => {
    const html = mcpAccessSection(base);
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, `missing ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at(">MCP access<"),
      at('data-act="mcpSetupOpen"'),
      at("Sign Claude Code in with your browser"),
      at("Install the Trov plugin"),
      at("/mcp"),
      at("Choose how the connection picks an organization"),
      at("One connection covers all your organizations"),
      at('data-list="grants"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect([...html.matchAll(/<li /g)]).toHaveLength(3);
    expect(html).toContain('data-act="copyPluginInstall"');
    for (const line of PLUGIN_INSTALL.split("\n")) expect(html).toContain(line);
  });

  it("the heading sits as far above the content as every other tile's (14px), and the steps 20px under the intro", () => {
    const html = mcpAccessSection(base);
    // The heading row (label + the by-hand link) carries the 14px the other tiles' labels do.
    expect(html).toMatch(/<div style="display:flex;align-items:baseline;[^"]*margin-bottom:14px">\s*<div style="[^"]*margin-bottom:14px;margin-bottom:0">MCP access</);
    const settings = render({ ...initialState(), view: "app" as const, screen: "settings" as const, me: ME });
    for (const t of ["Profile", "Account", "Appearance"]) expect(settings).toMatch(new RegExp(`margin-bottom:14px">${t}<`));
    expect(css).toMatch(/\.cnpy-mcp-body \{[^}]*margin-top:20px;/);
  });

  it("the by-hand setup is a MODAL: the tile carries only a quiet link that opens a dialog, never the command", () => {
    const tile = mcpAccessSection(base);
    expect(tile).toMatch(/<button data-act="mcpSetupOpen" data-mcp-setup-trigger aria-haspopup="dialog" class="cnpy-mutelink"[^>]*>Set it up without the plugin/);
    // No inline disclosure left: no toggle state, no command, no copy button in the tile.
    expect(tile).not.toContain("aria-expanded=\"false\" aria-controls");
    expect(tile).not.toContain('data-act="mcpManual"');
    expect(tile).not.toContain("claude mcp add");
    expect(tile).not.toContain('data-act="copyBrowserConnect"');
    // No filled accent button anywhere in the tile: the steps are the content.
    expect(tile).not.toMatch(/background:var\(--accent\);color:var\(--accent-fg\)/);
  });

  it("the modal: the confirmation modal's shell, a labelled dialog, the command with Copy, the /mcp follow-up, and two ways out", () => {
    const html = mcpSetupModal(URL);
    expect(html).toMatch(/^<div data-overlay="mcp-setup" class="cnpy-cmodal">/);
    expect(html).toContain('<div data-act="mcpSetupClose" class="cnpy-cmodal-back" aria-hidden="true"></div>');
    expect(html).toContain('class="cnpy-cmodal-wrap"');
    // role="dialog" + aria-modal is also what makes it a bottom sheet at phone width (trov.css).
    expect(html).toMatch(/role="dialog" aria-modal="true" aria-labelledby="mcp-setup-t" aria-describedby="mcp-setup-d" tabindex="-1" data-mcp-setup class="cnpy-surface cnpy-cmodal-box"/);
    expect(html).toContain('id="mcp-setup-t"');
    expect(html).toContain(">Set it up without the plugin<");
    expect(html).toContain(esc(browserConnectCommand(URL)));
    expect(html).toContain('data-act="copyBrowserConnect"');
    const follow = html.indexOf("Then run ");
    expect(follow).toBeGreaterThan(html.indexOf("claude mcp add"));
    expect(html.slice(follow)).toMatch(/\/mcp[\s\S]*trov[\s\S]*Authenticate/);
    // The backdrop and the × both close it (Escape is main.ts's).
    expect(html.match(/data-act="mcpSetupClose"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Close"');
  });

  it("mints nothing and shows no token: no connection command, no token list, no bearer header", () => {
    const html = mcpAccessSection(base) + mcpSetupModal(URL);
    for (const gone of ["connectOpen", "Get connection command", "revokeToken", "canopy_mcp_", "Authorization", "Tokens<"]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("Settings › MCP access — the modal opens at the app root and never grows the tile", () => {
  const settings = (mcpSetup: boolean, screen: "settings" | "mywork" = "settings") =>
    render({ ...initialState(), view: "app" as const, screen, me: ME, mcpSetup });
  const tile = (html: string) => html.match(/<section class="cnpy-tile cnpy-surface cnpy-set-mcp">[\s\S]*?<\/section>/)?.[0] ?? "";

  it("closed: no dialog anywhere; open: ONE root-level data-overlay after the app, outside <main>", () => {
    expect(settings(false)).not.toContain('data-overlay="mcp-setup"');
    const open = settings(true);
    expect(open.match(/data-overlay="mcp-setup"/g)).toHaveLength(1);
    expect(open.indexOf('data-overlay="mcp-setup"')).toBeGreaterThan(open.lastIndexOf("</main>"));
    // Only on Settings — a stale flag never opens it over another screen.
    expect(settings(true, "mywork")).not.toContain('data-overlay="mcp-setup"');
  });

  it("opening it adds nothing to the tile: the MCP tile renders byte-for-byte the same", () => {
    const shut = tile(settings(false));
    expect(shut).toContain(">MCP access<");
    expect(tile(settings(true))).toBe(shut);
    expect(shut).not.toContain("claude mcp add");
  });
});

describe("Settings bento — one twelve-column grid, each tile about as tall as what it holds", () => {
  const settings = () => render({ ...initialState(), view: "app" as const, screen: "settings" as const, me: ME });
  const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{[^}]*\\}`))?.[0] ?? "";
  const TILES = ["cnpy-set-profile", "cnpy-set-account", "cnpy-set-plan", "cnpy-set-limits", "cnpy-set-orgs-tile", "cnpy-set-mcp", "cnpy-set-appear", "cnpy-set-email", "cnpy-set-help", "cnpy-set-session"];

  it("the ten tiles are direct children of ONE grid, in the folded order — who I am, the plan, the rest, Sign out last", () => {
    const html = settings();
    const grid = html.slice(html.indexOf('<div class="cnpy-set">'));
    const at = (needle: string) => {
      const i = grid.indexOf(`cnpy-tile cnpy-surface ${needle}"`);
      expect(i, `missing ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const order = TILES.map(at);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Nothing wraps the tiles between the grid and them, and every tile names its place.
    const inner = grid.slice('<div class="cnpy-set">'.length);
    expect(inner.trimStart().startsWith('<section class="cnpy-tile cnpy-surface cnpy-set-profile">')).toBe(true);
    expect(inner.match(/<section class="cnpy-tile cnpy-surface[^"]*"/g)).toHaveLength(TILES.length);
  });

  it("twelve columns, each tile placed by name: Profile | Account | Session over Appearance, Plan | Limits, then full-width rows", () => {
    expect(rule(".cnpy-set")).toContain("grid-template-columns:repeat(12,minmax(0,1fr))");
    expect(rule(".cnpy-set-profile")).toContain("grid-column:1 / span 4; grid-row:1 / span 2;");
    expect(rule(".cnpy-set-account")).toContain("grid-column:5 / span 4; grid-row:1 / span 2;");
    expect(rule(".cnpy-set-session")).toContain("grid-column:9 / -1; grid-row:1;");
    expect(rule(".cnpy-set-appear")).toContain("grid-column:9 / -1; grid-row:2;");
    expect(rule(".cnpy-set-plan")).toContain("grid-column:1 / span 5; grid-row:3;");
    expect(rule(".cnpy-set-limits")).toContain("grid-column:6 / -1; grid-row:3;");
    for (const full of [".cnpy-set-orgs-tile", ".cnpy-set-mcp", ".cnpy-set-email", ".cnpy-set-help"]) expect(rule(full), full).toContain("grid-column:1 / -1;");
    // Stretch stays the default (every edge lines up); what keeps a tile from looking stretched is
    // that its row partners hold as much as it does — never aligning tiles to their start.
    expect(css).not.toMatch(/\.cnpy-set[\w-]* \{[^}]*align-(items|self):(start|flex-start)/);
    expect(css).not.toMatch(/\.cnpy-tile \{[^}]*align-self/);
  });

  it("a tile keeps its content on top and its closing line at the bottom; a field never runs the width of a wide tile", () => {
    expect(rule(".cnpy-tile")).toContain("display:flex; flex-direction:column;");
    expect(rule(".cnpy-tile-foot")).toContain("margin-top:auto;");
    const html = settings();
    const section = (cls: string) => html.slice(html.indexOf(`cnpy-surface ${cls}"`), html.indexOf("</section>", html.indexOf(`cnpy-surface ${cls}"`)));
    expect(section("cnpy-set-profile")).toMatch(/<div class="cnpy-tile-foot"[^>]*><label[^>]*>Your color</);
    expect(section("cnpy-set-profile")).toMatch(/<div class="cnpy-set-name"[^>]*>\s*<input data-act="setDisplayName"/);
    expect(rule(".cnpy-set-profile .cnpy-set-name")).toContain("max-width:420px;");
    // Account is the sign-in methods, top-down; who is signed in and Sign out are the Session tile's.
    expect(section("cnpy-set-account")).toMatch(/Sign-in methods[\s\S]*data-provider="github"[\s\S]*data-provider="google"[\s\S]*cnpy-tile-foot/);
    expect(section("cnpy-set-account")).not.toContain('data-act="signOut"');
  });

  it("Sign out is a labelled button with its icon, in a Session tile of its own — once on the page", () => {
    const html = settings();
    expect(html.match(/data-act="signOut"/g)).toHaveLength(1);
    const tile = html.slice(html.indexOf('cnpy-surface cnpy-set-session"'));
    expect(tile).toMatch(/>Session<\/div>[\s\S]*Signed in as[\s\S]*<button data-act="signOut" class="cnpy-signout"[^>]*>\s*<svg[\s\S]*?<\/svg>Sign out<\/button>/);
    expect(tile).toMatch(/data-act="signOut"[^>]*height:36px[^>]*font-weight:600/);
  });

  it("the last sign-in method can't be unlinked, and says why; with two, either can be", () => {
    const one = render({ ...initialState(), view: "app" as const, screen: "settings" as const, me: { ...ME, identities: [{ provider: "github" as const, label: "alice", linked_at: "t" }] } });
    expect(one).toMatch(/data-act="unlinkProvider" data-arg="github" class="cnpy-ghostbtn" disabled title="Link another sign-in method before unlinking this one"/);
    expect(one).toContain('data-act="linkProvider" data-arg="google"');
    expect(one).toContain("Your only way in. Link the other one before unlinking it.");
    const two = render({ ...initialState(), view: "app" as const, screen: "settings" as const, me: { ...ME, identities: [{ provider: "github" as const, label: "alice", linked_at: "t" }, { provider: "google" as const, label: "alice@example.com", linked_at: "t" }] } });
    expect(two.match(/data-act="unlinkProvider"/g)).toHaveLength(2);
    expect(two).not.toMatch(/data-act="unlinkProvider"[^>]*disabled/);
    expect(two).toContain("Either one signs you in to the same account.");
  });

  it("folds: two columns below a 1000px page (Profile | Account, every other tile full width), one on a phone", () => {
    expect(css).toMatch(/@container cnpy-set \(max-width:999px\) \{\s*\.cnpy-set \{ grid-template-columns:repeat\(2,minmax\(0,1fr\)\); \}\s*\.cnpy-set-profile, \.cnpy-set-account \{ grid-column:auto; grid-row:auto; \}\s*\.cnpy-set-session, \.cnpy-set-appear, \.cnpy-set-plan, \.cnpy-set-limits, \.cnpy-set-mcp, \.cnpy-set-orgs-tile, \.cnpy-set-email \{ grid-column:1 \/ -1; grid-row:auto; \}/);
    expect(css).toMatch(/@container cnpy-set \(max-width:759px\) \{\s*\.cnpy-set \{[^}]*grid-template-columns:minmax\(0,1fr\); \}/);
  });

  it("the page is patched in place, not rebuilt, while it stays up: it holds forms (web-ui.md › A repaint REBUILDS a page)", () => {
    expect(settings()).toMatch(/<main data-morph="settings"/);
  });
});
describe("Settings › Appearance — three theme cards in one row", () => {
  const settingsState = (theme: "light" | "dark" | "system") => ({
    ...initialState(),
    view: "app" as const,
    screen: "settings" as const,
    theme,
    me: { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
  });
  const appearance = (html: string) => html.match(/<section class="[^"]*cnpy-set-appear[\s\S]*?<\/section>/)?.[0] ?? "";

  it("renders exactly Light, Dark and System, the picked one pressed", () => {
    const tile = appearance(render(settingsState("dark")));
    const cards = [...tile.matchAll(/<button data-act="setTheme" data-arg="(\w+)" class="cnpy-themecard" aria-pressed="(\w+)"/g)];
    expect(cards.map((m) => m[1])).toEqual(["light", "dark", "system"]);
    expect(cards.map((m) => m[2])).toEqual(["false", "true", "false"]);
    // Nothing under the cards: the tile is as tall as they are, and "System" explains itself on hover.
    expect(tile).toMatch(/<div class="cnpy-set-themes">(<button[^]*?<\/button>){3}<\/div>\s*<\/section>/);
    expect(tile).toMatch(/data-arg="system" class="cnpy-themecard" aria-pressed="false" title="Follows your operating system's appearance"/);
    // Layout is the class's, so the container query can restack it — never inline.
    expect(tile).not.toMatch(/cnpy-themecard"[^>]*style="[^"]*display:flex/);
  });

  it("the row is three equal columns at every width — no four-card template or 2-up override left", () => {
    expect(css).toMatch(/\.cnpy-set-themes \{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    expect(css).not.toMatch(/\.cnpy-set-themes \{[^}]*repeat\([^3]/);
    // Narrow cards stack icon over label, still three across.
    expect(css).toMatch(/@container cnpy-themes \(max-width:\d+px\) \{\s*\.cnpy-themecard \{[^}]*flex-direction:column/);
  });
});
