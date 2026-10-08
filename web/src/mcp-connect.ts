// Connecting a coding agent to Trov — the ONE copy of the commands and the three sign-in steps.
// Settings › MCP access (render.ts `mcpAccessSection`), the Get Started guide and the first-run
// wizard (welcome.ts) all show exactly this, so the instructions cannot drift apart.
// Pure markup; the Copy buttons' acts (`copyPluginInstall`, `copyBrowserConnect`) are main.ts's.

import { esc } from "./ui";

/** This Trov's own MCP endpoint — the origin the SPA is served from, so a local
 *  `wrangler dev` hands out a local URL and prod hands out prod's. */
export const mcpEndpoint = (): string =>
  `${typeof location !== "undefined" && location.origin ? location.origin : "https://trov.dev"}/mcp`;

/** The two Claude Code commands that install the Trov plugin — Settings › MCP access,
 *  the Get Started guide and the first-run wizard all show exactly this. */
export const PLUGIN_INSTALL = `/plugin marketplace add AndresL230/trov
/plugin install trov@trov`;

/** The by-hand setup: the server with no header — Claude Code then signs in through the
 *  browser on `/mcp` → Authenticate, exactly as the plugin does. Mints nothing. */
export function browserConnectCommand(url: string = mcpEndpoint()): string {
  return `claude mcp add --transport http --scope user trov ${url}`;
}

export const mcpCode = (t: string) => `<code style="font-family:var(--code);font-size:11.5px;color:var(--fg)">${t}</code>`;
export const mcpStrong = (t: string) => `<strong style="font-weight:600;color:var(--fg)">${t}</strong>`;
/** A command with a small Copy icon in its corner, so the text keeps the box's full width —
 *  the MCP tile's install commands and the by-hand setup's `claude mcp add`. */
export function copyBox(text: string, act: string, label: string): string {
  return `<div style="position:relative;margin-top:7px;background:var(--hover);border:1px solid var(--border);border-radius:8px;padding:7px 36px 7px 11px">
        <pre style="margin:0;font-family:var(--code);font-size:11.5px;line-height:1.6;color:var(--fg);white-space:pre-wrap;overflow-wrap:anywhere">${esc(text)}</pre>
        <button data-act="${act}" class="cnpy-copybtn" title="Copy" aria-label="${label}" style="position:absolute;top:5px;right:5px;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;border:1px solid var(--border-strong);background:var(--bg);color:var(--fg-55)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15V5a2 2 0 0 1 2-2h10"></path></svg></button>
      </div>`;
}

/** The browser sign-in as three steps: install the plugin, `/mcp` → Authenticate, approve in the
 *  browser. `orgName` = the org on screen (the consent page asks which one); `lands` = where the
 *  connection shows up once allowed, in the words of the screen showing these steps. */
export function connectSteps(orgName = "", lands = "it shows up under Connected apps"): string {
  // The steps read in order on their own — no number badges (the owner's call, 2026-09-27).
  const step = (body: string) => `<li style="min-width:0;font-size:13px;line-height:1.55;color:var(--fg-70)">${body}</li>`;
  return `<ol aria-label="Connect Claude Code" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px;min-width:0">
        ${step(`Install the Trov plugin in Claude Code:${copyBox(PLUGIN_INSTALL, "copyPluginInstall", "Copy the install commands")}`)}
        ${step(`Run ${mcpCode("/mcp")}, choose ${mcpStrong("trov")}, then ${mcpStrong("Authenticate")}.`)}
        ${step(`Your browser opens Trov. ${orgName ? `Pick the organization to connect (you're in ${mcpStrong(esc(orgName))} now)` : "Pick the organization to connect"}, then click ${mcpStrong("Allow")} &mdash; ${lands}.`)}
      </ol>`;
}
/** What a connection reaches — said under the steps wherever they are shown. */
export const ONE_ORG_NOTE = "A connection reaches one organization: the one you pick when you allow it. To use Trov with another organization, connect again and pick that one.";
