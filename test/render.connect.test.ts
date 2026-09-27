/**
 * Settings › MCP access — OAuth only — and the Settings bento around it.
 *
 *  • mcpAccessSection — one line, the three browser sign-in steps, Connected apps, and
 *    the by-hand command folded away; nothing mints or shows a token
 *  • grantListBody — the OAuth connections, capped with "Show all", two-click revoke
 *  • the Get Started guide says the same thing, browser sign-in first
 *  • the bento — tiles sized to their content, nothing stretched to the MCP tile
 */
import { describe, it, expect } from "vitest";
import { grantListBody, mcpAccessSection, MCP_LIST_CAP, PLUGIN_INSTALL, browserConnectCommand, render, initialState } from "../web/src/render";
import css from "../web/src/canopy.css?raw";

const URL = "https://canopy.example.com/mcp";
const ME = { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], org: "SaplingLearn", admin: false };

describe("browserConnectCommand", () => {
  it("adds the server with no header — Claude Code signs in through the browser", () => {
    expect(browserConnectCommand(URL)).toBe(`claude mcp add --transport http --scope user canopy ${URL}`);
  });
});

describe("Get Started guide — Connect your agent", () => {
  const guideState = () => ({ ...initialState(), view: "app" as const, screen: "guide" as const, me: ME });

  it("leads with the plugin and the browser sign-in, the same three steps as Settings", () => {
    const html = render(guideState());
    const install = html.indexOf("/plugin install canopy@canopy");
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
    expect(html).not.toContain("export CANOPY_MCP_TOKEN");
    expect(html).not.toContain("set -Ux CANOPY_MCP_TOKEN");
  });
});

describe("grantListBody", () => {
  const grant = { id: 7, client_name: "Claude <Code>", created_at: "2026-09-20T00:00:00.000Z", last_used_at: null };
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
  // The old list was a fixed-height scroller so the stretched bento never moved. Now no
  // tile stretches to a neighbour, so the invariant is the opposite one: no fixed height, no
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
  const base = { grants: { status: "ok" as const, data: [] }, grantRevokeArm: null, grantsAll: false, mcpManual: false };

  it("reads top to bottom: what it is, the three numbered steps, Connected apps, then the folded by-hand setup", () => {
    const html = mcpAccessSection(base);
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, `missing ${needle}`).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at(">MCP access<"),
      at("Sign Claude Code in with your browser"),
      at("Install the Canopy plugin"),
      at("/mcp"),
      at("Click <strong"),
      at('data-list="grants"'),
      at('data-act="mcpManual"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect([...html.matchAll(/<li /g)]).toHaveLength(3);
    expect(html).toContain('data-act="copyPluginInstall"');
    for (const line of PLUGIN_INSTALL.split("\n")) expect(html).toContain(line);
  });

  it("the by-hand command is folded: only its toggle until opened, never a primary button", () => {
    const shut = mcpAccessSection(base);
    expect(shut).toContain('data-act="mcpManual" aria-expanded="false"');
    expect(shut).not.toContain("claude mcp add");
    expect(shut).not.toContain('data-act="copyBrowserConnect"');
    const open = mcpAccessSection({ ...base, mcpManual: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("claude mcp add --transport http --scope user canopy ");
    expect(open).toContain('data-act="copyBrowserConnect"');
    // No filled accent button anywhere in the tile: the steps are the content.
    expect(open).not.toMatch(/background:var\(--accent\);color:var\(--accent-fg\)/);
  });

  it("mints nothing and shows no token: no connection command, no token list, no bearer header", () => {
    const html = mcpAccessSection({ ...base, mcpManual: true });
    for (const gone of ["connectOpen", "Get connection command", "revokeToken", "canopy_mcp_", "Authorization", "Tokens<"]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("Settings bento — tiles sized to their content, nothing stretched to the MCP tile", () => {
  const settings = () => render({ ...initialState(), view: "app" as const, screen: "settings" as const, me: ME });
  const rule = (sel: string) => css.match(new RegExp(`\\n${sel.replace(/[.]/g, "\\.")} \\{[^}]*\\}`))?.[0] ?? "";

  it("Profile, Account and Appearance are their own grid, beside MCP access; Email notifications after both", () => {
    const html = settings();
    const you = html.indexOf('class="cnpy-set-you"');
    const mcp = html.indexOf("cnpy-set-mcp");
    const email = html.indexOf("cnpy-set-email");
    const block = html.slice(you, mcp);
    for (const t of [">Profile<", ">Account<", ">Appearance<"]) expect(block).toContain(t);
    expect(block).not.toContain(">MCP access<");
    expect(you).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(mcp);
  });

  it("a three-column bento whose grids align to the start — no tile stretches to a neighbour's height", () => {
    const set = rule(".cnpy-set");
    expect(set).toContain("grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,1.3fr)");
    expect(set).toContain("align-items:start");
    expect(rule(".cnpy-set-you")).toContain("grid-column:span 2");
    expect(rule(".cnpy-set-you")).toContain("align-items:start");
    expect(css).not.toMatch(/\.cnpy-set(-you)? \{[^}]*align-items:stretch/);
    // The old bento let MCP access span two rows of the outer grid, so its height set theirs.
    expect(css).not.toMatch(/\.cnpy-set-mcp \{[^}]*grid-row:span/);
    // The Account tile no longer pushes its sign-in methods to the bottom of a stretched box.
    expect(settings()).not.toContain("margin-top:auto;padding-top:20px");
  });

  it("folds: MCP access under the small tiles below a 1000px page, one column on a phone", () => {
    expect(css).toMatch(/@container cnpy-set \(max-width:999px\) \{\s*\.cnpy-set \{ grid-template-columns:minmax\(0,1fr\); \}/);
    expect(css).toMatch(/@container cnpy-set \(max-width:759px\) \{[^}]*\}\s*\.cnpy-set-you \{ grid-template-columns:minmax\(0,1fr\); \}/);
  });
});
describe("Settings › Appearance — three theme cards in one row", () => {
  const settingsState = (theme: "light" | "dark" | "system") => ({
    ...initialState(),
    view: "app" as const,
    screen: "settings" as const,
    theme,
    me: { handle: "alice", name: null, avatar_url: null, color: "moss" as const, identities: [], org: "SaplingLearn", admin: false },
  });
  const appearance = (html: string) => html.match(/<section class="[^"]*cnpy-set-appear[\s\S]*?<\/section>/)?.[0] ?? "";

  it("renders exactly Light, Dark and System, the picked one pressed, then the hint below them", () => {
    const tile = appearance(render(settingsState("dark")));
    const cards = [...tile.matchAll(/<button data-act="setTheme" data-arg="(\w+)" class="cnpy-themecard" aria-pressed="(\w+)"/g)];
    expect(cards.map((m) => m[1])).toEqual(["light", "dark", "system"]);
    expect(cards.map((m) => m[2])).toEqual(["false", "true", "false"]);
    expect(tile).toMatch(/<div class="cnpy-set-themes">(<button[^]*?<\/button>){3}<\/div>\s*<div[^>]*>System follows/);
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
