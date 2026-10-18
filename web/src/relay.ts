// Relay › Overview (`#relay`, the Relay screen's first tab): what Relay is, its two halves to dive into, and the
// connections that can use them (docs/architecture/handoffs-prompts.md › Relay › Overview).
//   • the lead: one sentence on what Relay does;
//   • two cards — Handoffs (pass a task to whoever picks it up next) and Links (keep two live sessions in step) — each
//     balanced on its middle: its drawing in a tinted band, its name and what it is, its two counts side by side
//     (what waits for me first), then New handoff / Start a link at the left and "Open … →" at the right. The whole
//     card opens its page (a `hitArea`; the New button sits above the hit). Relay has no tab bar (the owner's call):
//     these cards are the way in, and Handoffs and Links each have a back button to Relay in the header;
//   • Your connections: the agents that can send, pick up and join — the person's OAuth connections that act in this
//     organization (Claude Code, Claude.ai…), their access tokens for it, and Ask Trov (built in, on or off for the
//     org). Each says when it was last used; with none, "Connect an agent" opens Settings › MCP access.
// Pure: every count and row comes from the Relay reads main.ts already makes (handoffs, links, grants, tokens, Ask's
// state). Unknown is "—"/a skeleton, never a guessed 0 (CLAUDE.md invariant 7).
import type { HandoffView } from "@shared/handoffs";
import type { OAuthGrantSummary, McpTokenSummary } from "@shared/rows";
import type { AskState } from "@shared/ai-ask-core";
import { handoffsForMe } from "./mywork";
import { clientIcon, liveLinks, type LinkBoxes } from "./links";
import { esc, hitArea, HITBOX, relTime, surface } from "./ui";

type Load<T> = { status: "idle" | "loading" | "ok" | "error" | "unauth"; data: T };

export interface RelayProps {
  me: string;
  orgSlug: string;
  handoffs: Load<HandoffView[]>;
  links: Load<LinkBoxes>;
  grants: Load<OAuthGrantSummary[]>;
  tokens: Load<McpTokenSummary[]>;
  /** Ask's `GET /ask/state` (enabled, eligibility), or null while it is read. */
  ask: Load<Pick<AskState, "enabled" | "eligibility"> | null>;
}

export const RELAY_LEAD = "Relay passes work between agent sessions — to whoever picks it up later, or live while two sessions work at once.";

const settled = (l: Load<unknown>): boolean => l.status === "ok";

/** The counts on each card; null while its read is out (drawn as "—"). */
export function relayCounts(p: Pick<RelayProps, "handoffs" | "links" | "me">): {
  handoffs: { forMe: number; sent: number } | null; links: { live: number; asking: number } | null;
} {
  const me = p.me.toLowerCase();
  return {
    handoffs: settled(p.handoffs)
      ? { forMe: handoffsForMe(p.handoffs.data, p.me).length, sent: p.handoffs.data.filter((h) => h.status === "pending" && h.sender.toLowerCase() === me).length }
      : null,
    // "Live now" is the OPEN links (a draft or a request waiting is not live yet); "asking" the requests sent to me.
    links: settled(p.links) ? { live: liveLinks(p.links.data).filter((l) => l.state === "open").length, asking: p.links.data.waiting.length } : null,
  };
}

/** The OAuth connections that act in this org: a repo-following one (it acts wherever its repository is connected)
 *  or a manual one this org is among. */
export const grantsHere = (grants: readonly OAuthGrantSummary[], orgSlug: string): OAuthGrantSummary[] =>
  grants.filter((g) => g.mode === "repo" || g.orgs.some((o) => o.slug === orgSlug));

// The two drawings: a handoff is a note that waits, then goes on; a link is a line that stays open between two.
const HANDOFF_ART = `<svg class="cnpy-relay-art" viewBox="0 0 120 44" width="120" height="44" aria-hidden="true" focusable="false">
  <circle cx="12" cy="22" r="7" fill="currentColor" opacity=".9"/>
  <path d="M24 22h18" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 3" opacity=".55"/>
  <rect x="46" y="11" width="28" height="22" rx="4" fill="none" stroke="currentColor" stroke-width="1.4"/>
  <path d="M52 18h16M52 23h12M52 28h9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" opacity=".7"/>
  <path d="M78 22h18" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 3" opacity=".55"/>
  <circle cx="108" cy="22" r="7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2.2"/>
</svg>`;
const LINK_ART = `<svg class="cnpy-relay-art" viewBox="0 0 120 44" width="120" height="44" aria-hidden="true" focusable="false">
  <circle cx="12" cy="22" r="7" fill="currentColor" opacity=".9"/>
  <path d="M20 22h80" stroke="currentColor" stroke-width="1.4" opacity=".35"/>
  <circle class="cnpy-relay-dot" cx="38" cy="22" r="2.2" fill="currentColor"/>
  <circle class="cnpy-relay-dot is-b" cx="60" cy="22" r="2.2" fill="currentColor"/>
  <circle class="cnpy-relay-dot is-c" cx="82" cy="22" r="2.2" fill="currentColor"/>
  <circle cx="108" cy="22" r="7" fill="currentColor" opacity=".9"/>
</svg>`;

const stat = (n: number | null, word: string, hot = false): string =>
  `<div class="cnpy-relay-stat"><span class="cnpy-relay-n${hot && n ? " is-hot" : ""}">${n === null ? "—" : n}</span><span class="cnpy-relay-w">${esc(word)}</span></div>`;

function card(o: { key: "handoffs" | "links"; title: string; what: string; art: string; stats: string; openAct: string; newAct: string; newLabel: string }): string {
  return `<article data-relay-card="${o.key}"${surface("", { cls: `cnpy-relay-card ${HITBOX}` })}>
      <div class="cnpy-relay-band">${o.art}</div>
      <div class="cnpy-relay-body">
        <h2 class="cnpy-relay-h">${esc(o.title)}</h2>
        <p class="cnpy-relay-what">${esc(o.what)}</p>
        <div class="cnpy-relay-stats">${o.stats}</div>
      </div>
      <div class="cnpy-relay-foot"><button type="button" data-act="${o.newAct}" class="cnpy-relay-new cnpy-hitctl">${esc(o.newLabel)}</button><span class="cnpy-relay-go" aria-hidden="true">Open ${esc(o.title.toLowerCase())} <span>→</span></span></div>
      ${hitArea(o.openAct, "", `Open ${o.title}`)}
    </article>`;
}

/** One connection row: its icon, its name and how it connects, when it was last used. */
const connRow = (icon: string, name: string, how: string, when: string, state: "on" | "off" = "on"): string =>
  `<li class="cnpy-relay-conn${state === "off" ? " is-off" : ""}"><span class="cnpy-relay-ci">${icon}</span><span class="cnpy-relay-cn"><span class="cnpy-relay-cname">${esc(name)}</span><span class="cnpy-relay-chow">${esc(how)}</span></span><span class="cnpy-relay-cwhen">${esc(when)}</span></li>`;

const used = (at: string | null): string => (at ? `Used ${relTime(at)}` : "Not used yet");
const kindOf = (name: string): "code" | "chat" => (/code/i.test(name) ? "code" : "chat");
const KEY_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"></circle><path d="M10.8 12.2 20 3M16 7l3 3M14 9l2 2"></path></svg>`;

export function connectionsBlock(p: Pick<RelayProps, "grants" | "tokens" | "ask" | "orgSlug">): string {
  const reading = !settled(p.grants) || !settled(p.tokens);
  const grants = settled(p.grants) ? grantsHere(p.grants.data, p.orgSlug) : [];
  const tokens = settled(p.tokens) ? p.tokens.data : [];
  const rows = [
    ...grants.map((g) => connRow(clientIcon(kindOf(g.client_name)), g.client_name, g.mode === "repo" ? "Connected · follows the repository" : "Connected", used(g.last_used_at))),
    ...tokens.map((t) => connRow(KEY_ICON, `Access token${t.hint ? ` ····${t.hint}` : ""}`, "Pasted into an agent", used(t.last_used_at))),
  ];
  const ask = p.ask.data;
  const askRow = !settled(p.ask) || !ask
    ? connRow(clientIcon("ask"), "Ask Trov", "Built in", "—")
    : ask.eligibility === "no_key" ? connRow(clientIcon("ask"), "Ask Trov", "Built in · not set up on this server", "Off", "off")
    : ask.enabled ? connRow(clientIcon("ask"), "Ask Trov", "Built in · asks you before it sends or joins", "On")
    : connRow(clientIcon("ask"), "Ask Trov", "Built in · off for this organization", "Off", "off");
  const none = !reading && rows.length === 0
    ? `<li class="cnpy-relay-conn is-none" data-relay-noconn><span class="cnpy-relay-cn"><span class="cnpy-relay-cname">No agent connected yet</span><span class="cnpy-relay-chow">Connect Claude Code or Claude.ai, and its sessions can send and pick up handoffs and join links.</span></span><button type="button" data-act="goSettings" class="cnpy-relay-connect">Connect an agent</button></li>`
    : "";
  const loading = reading ? `<li class="cnpy-relay-conn is-reading" aria-hidden="true"><span class="cnpy-relay-ci"></span><span class="cnpy-relay-cn"><span class="cnpy-relay-cname">Reading your connections…</span></span></li>` : "";
  return `<section class="cnpy-relay-conns" aria-labelledby="relay-conns-h">
      <div class="cnpy-relay-ch"><h2 id="relay-conns-h">Your connections</h2><button type="button" data-act="goSettings" class="cnpy-link cnpy-relay-manage">Manage in Settings</button></div>
      <ul${surface("", { cls: "cnpy-relay-clist" })}>${loading}${rows.join("")}${none}${askRow}</ul>
      <p class="cnpy-relay-note">Any connected agent can send and pick up handoffs and join links, as you.</p>
    </section>`;
}

export function relayView(p: RelayProps): string {
  const c = relayCounts(p);
  const cards = `<div class="cnpy-relay-cards">
      ${card({ key: "handoffs", title: "Handoffs", art: HANDOFF_ART, openAct: "goHandoffs", newAct: "newHandoff", newLabel: "New handoff",
        what: "Pass a task to whoever picks it up next: what's done, what's left, where to start. It waits until a session claims it.",
        stats: stat(c.handoffs?.forMe ?? null, "waiting for you", true) + stat(c.handoffs?.sent ?? null, "sent, not picked up") })}
      ${card({ key: "links", title: "Links", art: LINK_ART, openAct: "goLinks", newAct: "linkStartOpen", newLabel: "Start a link",
        what: "Keep two live sessions in step while the work overlaps: they leave each other short notes until it lands.",
        stats: stat(c.links?.asking ?? null, "asking to link", true) + stat(c.links?.live ?? null, "live now") })}
    </div>`;
  return `<div data-screen-label="Relay" class="cnpy-relay-shell"><div class="cnpy-relay">
      <p class="cnpy-relay-lead">${esc(RELAY_LEAD)}</p>
      ${cards}
      ${connectionsBlock(p)}
    </div></div>`;
}

