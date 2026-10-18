// Relay › Overview (web/src/relay.ts; docs/architecture/handoffs-prompts.md › Relay › Overview): the Relay screen's
// landing page — what Relay is, a card per half (its drawing, its counts, the way into its page) and Your connections —
// plus its route (`#relay`), the sidebar's Relay opening it, and no tab bar anywhere in Relay.
import { describe, it, expect } from "vitest";
import type { HandoffView } from "../shared/handoffs";
import type { LinkView, LinkSideView } from "../shared/links";
import type { OAuthGrantSummary } from "../shared/rows";
import { relayView, relayCounts, grantsHere, connectionsBlock, RELAY_LEAD, type RelayProps } from "../web/src/relay";
import { NO_LINK_BOXES } from "../web/src/links";
import { parseHash, hashForRoute } from "../web/src/hash";
import { navKeyOf } from "../web/src/sidebar";
import mainSrc from "../web/src/main.ts?raw";
import cssSrc from "../web/src/trov.css?raw";

const T0 = "2026-10-18T09:00:00Z";
const side = (handle: string): LinkSideView => ({ handle, kind: null, session: null, branch: null, seen_at: null });
const link = (id: number, state: LinkView["state"], from: string, to: string): LinkView => ({
  id, state, repo: null, topic: { kind: "person", ref: to }, reason: "", requester: side(from), recipient: side(to), self: false,
  created_at: T0, sent_at: T0, decided_at: null, closed_at: null, closed_by: null, close_reason: null, expires_at: "2026-10-19T09:00:00Z",
} as LinkView);
const handoff = (id: number, sender: string, recipient: string, status: HandoffView["status"] = "pending"): HandoffView => ({
  id, sender, recipient, status, created_at: T0, claimed_at: null, claimed_by: null, claimed_by_session: null, prompt: null, body: `# Handoff ${id}`, context: {} as HandoffView["context"],
});
const grant = (id: number, client_name: string, over: Partial<OAuthGrantSummary> = {}): OAuthGrantSummary => ({
  id, client_name, created_at: T0, last_used_at: T0, mode: "manual", org: null, orgs: [{ slug: "acme", name: "Acme" }], ...over,
});
const ok = <T,>(data: T) => ({ status: "ok" as const, data });
const props = (over: Partial<RelayProps> = {}): RelayProps => ({
  me: "andres", orgSlug: "acme",
  handoffs: ok([handoff(1, "jose", "andres"), handoff(2, "mei", "anyone"), handoff(3, "andres", "jose"), handoff(4, "andres", "mei", "claimed")]),
  links: ok({ ...NO_LINK_BOXES, waiting: [link(9, "requested", "jose", "andres")], open: [link(7, "open", "andres", "mei")], mine: [link(8, "requested", "andres", "luke")] }),
  grants: ok([grant(1, "Claude Code"), grant(2, "Claude", { orgs: [{ slug: "other", name: "Other" }] }), grant(3, "Claude", { mode: "repo", orgs: [] })]),
  tokens: ok([{ id: 5, hint: "x7Qa", created_at: T0, last_used_at: null }]),
  ask: ok({ enabled: true, eligibility: "eligible" as never }),
  ...over,
});

describe("Relay › Overview", () => {
  it("leads with what Relay is, then a card per half: its drawing, a New button above the hit, the whole card opens its page", () => {
    const html = relayView(props());
    expect(html).toContain(RELAY_LEAD.replace(/'/g, "&#39;"));
    expect(html.indexOf('data-relay-card="handoffs"')).toBeLessThan(html.indexOf('data-relay-card="links"'));
    for (const [key, act, open] of [["handoffs", "newHandoff", "goHandoffs"], ["links", "linkStartOpen", "goLinks"]] as const) {
      const card = html.slice(html.indexOf(`data-relay-card="${key}"`), html.indexOf("</article>", html.indexOf(`data-relay-card="${key}"`)));
      expect(card).toContain('class="cnpy-relay-art"');
      expect(card).toMatch(new RegExp(`data-act="${act}" class="cnpy-relay-new cnpy-hitctl"`));
      expect(card).toContain(`data-act="${open}" data-arg="" class="cnpy-hit"`);
      expect(card.indexOf(`data-act="${act}"`)).toBeLessThan(card.indexOf('class="cnpy-hit"')); // never inside the hit
    }
  });

  it("the counts: handoffs waiting for me and sent-but-not-picked-up; link requests asking me and live links", () => {
    // For me: addressed to me (handoffsForMe — My Work's and the badge's rule); live: the OPEN links only.
    expect(relayCounts(props())).toEqual({ handoffs: { forMe: 1, sent: 1 }, links: { live: 1, asking: 1 } });
    // A read still out is unknown — "—", never a guessed 0.
    const reading = props({ handoffs: { status: "loading", data: [] }, links: { status: "loading", data: NO_LINK_BOXES } });
    expect(relayCounts(reading)).toEqual({ handoffs: null, links: null });
    expect(relayView(reading).match(/<span class="cnpy-relay-n[^"]*">—<\/span>/g)?.length).toBe(4);
  });

  it("Your connections: the OAuth connections that act here (manual for this org, or repo-following), the tokens, then Ask", () => {
    expect(grantsHere(props().grants.data, "acme").map((g) => g.id)).toEqual([1, 3]);
    const html = connectionsBlock(props());
    expect(html).toContain("Claude Code");
    expect(html).toContain("Connected · follows the repository");
    expect(html).toContain("Access token ····x7Qa");
    expect(html).toContain("Not used yet");
    expect(html.indexOf("Access token")).toBeLessThan(html.indexOf("Ask Trov"));
    expect(html).toContain("asks you before it sends or joins");
    expect(html).toContain('data-act="goSettings"');
  });

  it("Ask reads off for the org, or not set up on this server; unknown while its state is read", () => {
    expect(connectionsBlock(props({ ask: ok({ enabled: false, eligibility: "eligible" as never }) }))).toContain("off for this organization");
    expect(connectionsBlock(props({ ask: ok({ enabled: false, eligibility: "no_key" as never }) }))).toContain("not set up on this server");
    expect(connectionsBlock(props({ ask: { status: "loading", data: null } }))).toMatch(/Ask Trov[\s\S]*?cnpy-relay-cwhen">—</);
  });

  it("no connection: the empty row says what connecting gives and offers Connect an agent; while reading, a reading row", () => {
    const none = connectionsBlock(props({ grants: ok([]), tokens: ok([]) }));
    expect(none).toContain("data-relay-noconn");
    expect(none).toContain("Connect an agent");
    const reading = connectionsBlock(props({ grants: { status: "loading", data: [] } }));
    expect(reading).toContain("Reading your connections…");
    expect(reading).not.toContain("data-relay-noconn");
  });

  it("no tab bar: the cards are the way in", () => {
    const html = relayView(props());
    expect(html).not.toContain('role="tablist"');
    expect(html).not.toContain("handoffsTab");
    expect(mainSrc).not.toContain('case "handoffsTab"');
  });

  it("#relay is its route; the sidebar's Relay opens it and stays lit on every Relay screen", () => {
    expect(parseHash("#relay").screen).toBe("relay");
    expect(hashForRoute(parseHash("#relay"))).toBe("#relay");

    expect(navKeyOf("relay")).toBe("handoffs");
    expect(mainSrc).toContain('case "goRelay": state.screen = "relay";');
  });

  it("the drawing's dots stop under reduced motion; two columns fold to one on a phone", () => {
    expect(cssSrc).toMatch(/prefers-reduced-motion: reduce\) \{ \.cnpy-relay-dot \{ animation:none; \}/);
    expect(cssSrc).toMatch(/@media \(max-width:720px\) \{ \.cnpy-relay-cards \{ grid-template-columns:minmax\(0,1fr\); \}/);
  });
});
