// Relay › Links (web/src/links.ts) — the Links tab and a link's page over the real DTOs (shared/links.ts):
// each state as each viewer sees it (only the steps that viewer may take, and no others), each side kind, a
// self-link, who wrote each note, the join hint, the routes, and the sidebar's Relay badge = handoffs + links.
import { describe, it, expect } from "vitest";
import type { LinkDetail, LinkView, LinkSideView, LinkNoteView, LinkState } from "../shared/links";
import type { HandoffView } from "../shared/handoffs";
import {
  linksView, linkDetailView, linkActionsFor, linkCanWrite, linkNeedsJoin, linkCancelModal, handoffsTabBar,
  linkSessionHtml, noteAuthorHtml, askThreadOf, LINKS_EMPTY, NO_LINK_BOXES, type LinkAction, type LinkDetailProps,
} from "../web/src/links";
import { handoffsView } from "../web/src/handoffs";
import { render, initialState, handoffBadge, handoffOnlyBadge, linkBadge, type AppState } from "../web/src/render";
import { parseHash, hashForRoute, pageKey, sameRoute } from "../web/src/hash";
import { navKeyOf } from "../web/src/sidebar";
import { handoffsForMe } from "../web/src/mywork";
import linksSrc from "../web/src/links.ts?raw";
import mainSrc from "../web/src/main.ts?raw";

const persons = [
  { handle: "andres", name: "Andres", color: "moss" as const, avatar_url: null, role: null },
  { handle: "jose", name: "Jose", color: "plum" as const, avatar_url: "https://example.com/jose.png", role: null },
  { handle: "mei", name: "Mei", color: "sky" as const, avatar_url: null, role: null },
];
const T0 = "2026-10-17T10:00:00Z";
const side = (handle: string, over: Partial<LinkSideView> = {}): LinkSideView => ({ handle, kind: null, session: null, branch: null, seen_at: null, ...over });
const link = (over: Partial<LinkDetail> = {}): LinkDetail => ({
  id: 12, state: "open", repo: "acme/api", topic: { kind: "pr", ref: "180" }, reason: "Both of us touch the session store.",
  requester: side("andres", { kind: "code", session: "s-1", branch: "feat/auth" }), recipient: side("jose"),
  self: false, created_at: T0, sent_at: T0, decided_at: T0, closed_at: null, closed_by: null, close_reason: null,
  expires_at: "2026-10-24T10:00:00Z", notes: [], ...over,
});
const note = (over: Partial<LinkNoteView> = {}): LinkNoteView => ({
  id: 1, side: "recipient", author: "jose", author_kind: "agent", body: "Renaming authSession, merging tonight.", created_at: T0, delivered_at: null, ...over,
});
const page = (l: LinkDetail | null, me: string, over: Partial<LinkDetailProps> = {}): string =>
  linkDetailView({ status: "ok", link: l, me, persons, draft: "", busy: false, ...over });
/** The text of some markup: tags dropped, whitespace folded. */
const text = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
/** Whether any <button> opens inside another. */
const nestedButton = (html: string): boolean => {
  let depth = 0;
  for (const m of html.matchAll(/<button\b|<\/button>/g)) {
    depth += m[0] === "</button>" ? -1 : 1;
    if (depth > 1) return true;
  }
  return false;
};
/** Every step button a page offers, by its act. */
const STEP_ACTS = ["linkSend", "linkAccept", "linkDecline", "linkCancel", "linkCancelArm", "linkClose"] as const;
const acts = (html: string): string[] => STEP_ACTS.filter((a) => html.includes(`data-act="${a}"`));

// ── the steps each viewer may take ───────────────────────────────────────────
describe("a link's steps — only the ones this viewer may take", () => {
  const cases: { state: LinkState; me: string; want: string[]; why: string }[] = [
    { state: "draft", me: "andres", want: ["linkSend", "linkCancel"], why: "the requester sends or cancels a draft (at once)" },
    { state: "draft", me: "jose", want: [], why: "a draft is not the recipient's yet" },
    { state: "requested", me: "andres", want: ["linkCancelArm"], why: "the requester may only cancel a sent request, through the confirm" },
    { state: "requested", me: "jose", want: ["linkAccept", "linkDecline"], why: "the recipient accepts or declines" },
    { state: "open", me: "andres", want: ["linkClose"], why: "either side closes" },
    { state: "open", me: "jose", want: ["linkClose"], why: "either side closes" },
    { state: "open", me: "mei", want: [], why: "someone who is neither side" },
    ...(["declined", "cancelled", "closed", "expired"] as const).flatMap((st) => [
      { state: st, me: "andres", want: [], why: `${st} is an end` },
      { state: st, me: "jose", want: [], why: `${st} is an end` },
    ]),
  ];
  for (const c of cases) {
    it(`${c.state} as ${c.me}: ${c.want.join(", ") || "nothing"} (${c.why})`, () => {
      const html = page(link({ state: c.state, recipient: side("jose", c.state === "open" ? { kind: "chat", session: "c-1" } : {}) }), c.me);
      expect(acts(html)).toEqual(c.want);
    });
  }

  it("linkActionsFor is the one rule the buttons read (case-insensitive handles)", () => {
    const of = (state: LinkState, me: string): LinkAction[] => linkActionsFor(link({ state }), me);
    expect(of("draft", "ANDRES")).toEqual(["send", "cancel"]);
    expect(of("requested", "Jose")).toEqual(["accept", "decline"]);
    expect(of("requested", "andres")).toEqual(["cancel"]);
    expect(of("open", "mei")).toEqual([]);
    for (const st of ["declined", "cancelled", "closed", "expired"] as const) expect(of(st, "andres")).toEqual([]);
  });

  it("Cancel on a SENT request goes through confirmModal (an alertdialog at the root), never window.confirm", () => {
    const m = linkCancelModal(link({ state: "requested" }), false);
    expect(m).toContain('role="alertdialog"');
    expect(m).toContain('data-confirm-act="linkCancelConfirm"');
    expect(m).toContain('data-confirm-cancel="linkCancelDismiss"');
    expect(m).toContain("Keep it");
    expect(text(m)).toContain("Cancel link request #12?");
    const me = { handle: "andres", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 };
    const at = (arm: boolean) => render({ ...initialState(), view: "app", screen: "link", linkId: 12, me, orgSlug: "acme", linkDetail: { status: "ok", data: link({ state: "requested" }) }, linkCancelArm: arm } as AppState);
    expect(at(false)).not.toContain('id="link-cancel-confirm"');
    expect(at(true)).toContain('id="link-cancel-confirm"');
    expect(linksSrc).not.toMatch(/window\.confirm|confirm\(/);
    expect(mainSrc).not.toMatch(/window\.confirm\(/);
  });

  it("busy: every step button waits", () => {
    const html = page(link({ state: "requested" }), "jose", { busy: true });
    expect(html).toMatch(/data-act="linkAccept"[^>]*disabled/);
    expect(html).toMatch(/data-act="linkDecline"[^>]*disabled/);
  });
});

// ── the composer, the join hint ──────────────────────────────────────────────
describe("a link's composer and join hint", () => {
  it("the composer shows only on an OPEN link, only for one of its two people", () => {
    expect(page(link(), "andres")).toContain("data-link-composer");
    expect(page(link(), "jose")).toContain("data-link-composer");
    expect(page(link(), "mei")).not.toContain("data-link-composer");
    for (const st of ["draft", "requested", "declined", "cancelled", "closed", "expired"] as const) {
      expect(page(link({ state: st }), "andres"), st).not.toContain("data-link-composer");
      expect(linkCanWrite(link({ state: st }), "andres")).toBe(false);
    }
  });

  it("counts toward 1,000 characters, and Send note waits for a note", () => {
    const empty = page(link(), "andres");
    expect(text(empty)).toContain("0 / 1,000");
    expect(empty).toMatch(/data-act="linkNoteSend"[^>]*disabled/);
    expect(empty).toContain('maxlength="1000"');
    expect(empty).toContain('data-field="link-note"');
    const typed = page(link(), "andres", { draft: "Merging tonight." });
    expect(text(typed)).toContain("16 / 1,000");
    expect(typed).not.toMatch(/data-act="linkNoteSend"[^>]*disabled/);
  });

  it("an open link whose viewer side has no session says what to tell the agent, with a copy button", () => {
    const html = page(link(), "jose"); // the recipient has not joined
    expect(html).toContain("data-link-join");
    expect(text(html)).toContain("Tell your agent: join Trov link #12");
    expect(html).toContain('data-act="linkJoinCopy" data-arg="12"');
    expect(text(html)).toContain("A web chat, such as claude.ai, checks for notes when you ask it to.");
    expect(linkNeedsJoin(link(), "jose")).toBe(true);
    // The requester is bound already; a non-side never joins; nothing before the link is open.
    expect(page(link(), "andres")).not.toContain("data-link-join");
    expect(page(link(), "mei")).not.toContain("data-link-join");
    expect(page(link({ state: "requested" }), "jose")).not.toContain("data-link-join");
  });

  it("the link page is patched in place (data-morph), so the composer keeps its focus and text while the count updates", () => {
    const me = { handle: "andres", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 };
    const html = render({ ...initialState(), view: "app", screen: "link", linkId: 12, me, orgSlug: "acme", linkDetail: { status: "ok", data: link() } } as AppState);
    expect(html).toContain('data-morph="link:12"');
    expect(html).toContain("Link #12"); // the crumb
    expect(html).toContain('data-act="goLinks"'); // back to the Links tab
  });
});

// ── both sides ───────────────────────────────────────────────────────────────
describe("a link's sides — the person, and the session in words", () => {
  it("code: coding session on the branch; chat: web chat; null: waiting for a session", () => {
    expect(text(linkSessionHtml(side("a", { kind: "code", session: "x", branch: "feat/auth" }), true))).toBe("coding session on feat/auth");
    expect(text(linkSessionHtml(side("a", { kind: "code", session: "x" }), true))).toBe("coding session");
    expect(linkSessionHtml(side("a", { kind: "chat", session: "c" }), false)).toBe("web chat");
    expect(linkSessionHtml(side("a"), false)).toBe("waiting for a session");
  });

  it("ask: an Ask thread, linked to the thread on the viewer's own side", () => {
    expect(askThreadOf("ask-thread-7")).toBe(7);
    expect(askThreadOf("ask-thread-x")).toBeNull();
    expect(askThreadOf("s-1")).toBeNull();
    expect(linkSessionHtml(side("a", { kind: "ask", session: "ask-thread-7" }), true)).toContain('href="#ask/7"');
    // The other side's thread is theirs: plain words, no link.
    expect(linkSessionHtml(side("a", { kind: "ask", session: "ask-thread-7" }), false)).toBe("Ask thread");
    const html = page(link({ requester: side("andres", { kind: "ask", session: "ask-thread-7" }), recipient: side("jose", { kind: "chat", session: "c" }) }), "andres");
    expect(html).toContain('href="#ask/7"');
    expect(parseHash("#ask/7")).toMatchObject({ screen: "ask", askThread: 7 });
  });

  it("the page shows both people through people.ts (their card, their photo) and each session", () => {
    const html = page(link({ recipient: side("jose", { kind: "chat", session: "c", seen_at: T0 }) }), "andres");
    expect(html).toContain('data-act="openPerson" data-arg="andres"');
    expect(html).toContain('data-act="openPerson" data-arg="jose"');
    expect(html).toContain('src="https://example.com/jose.png"');
    expect(text(html)).toContain("Andres (you)");
    expect(text(html)).toContain("coding session on feat/auth");
    expect(text(html)).toContain("web chat");
    expect(text(html)).toContain("A web chat checks for notes when you ask it to.");
    expect(text(html)).toContain("Checked for notes");
    expect(text(html)).toContain("Link about PR #180");
    expect(text(html)).toContain("Both of us touch the session store.");
  });

  it("a self-link: one person's two sessions, Send opens it, and once open the composer is theirs", () => {
    const self = link({ self: true, state: "draft", recipient: side("andres") });
    const html = page(self, "andres");
    expect((html.match(/data-link-side=/g) ?? []).length).toBe(2);
    expect(text(html)).toContain("Your first session");
    expect(text(html)).toContain("Your second session");
    expect(acts(html)).toEqual(["linkSend", "linkCancel"]);
    expect(text(html)).toContain("Sending opens it at once");
    const open = page({ ...self, state: "open" }, "andres");
    expect(acts(open)).toEqual(["linkClose"]);
    expect(open).toContain("data-link-composer");
    expect(open).toContain("data-link-join"); // its second session has not joined
    expect(text(open)).toContain("A link to yourself");
  });

  it("a self-link's composer says which of the two sessions a note is from (a segmented switch); no other link has it", () => {
    const self = link({ self: true, state: "open", recipient: side("andres") });
    const html = page(self, "andres");
    expect(html).toContain('data-seg="link-note-side"');
    expect(html).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Your first session/);
    expect(html).toContain('data-act="linkNoteSide" data-arg="recipient"');
    const second = page(self, "andres", { noteSide: "recipient" });
    expect(second).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Your second session/);
    expect(page(link(), "andres")).not.toContain("data-link-note-side");
    expect(mainSrc).toMatch(/addLinkNote\(id, text, self \? state\.linkNoteSide : undefined\)/);
  });
});

// ── the notes ────────────────────────────────────────────────────────────────
describe("a link's notes — each says who wrote it", () => {
  it("@jose's agent, @jose's Ask thread, or @jose", () => {
    expect(text(noteAuthorHtml({ author: "jose", author_kind: "agent" }, persons))).toBe("@jose's agent");
    expect(text(noteAuthorHtml({ author: "jose", author_kind: "ask" }, persons))).toBe("@jose's Ask thread");
    expect(text(noteAuthorHtml({ author: "jose", author_kind: "person" }, persons))).toBe("@jose");
  });

  it("the thread renders each note's words as text, never markup", () => {
    const html = page(link({ notes: [note(), note({ id: 2, author: "andres", author_kind: "person", side: "requester", body: "<b>ok</b>" })] }), "andres");
    expect(html).toContain('data-link-note="1" data-author-kind="agent"');
    expect(html).toContain('data-link-note="2" data-author-kind="person"');
    expect(html).toContain("&lt;b&gt;ok&lt;/b&gt;");
    expect(text(html)).toContain("@jose's agent");
  });

  it("no notes: says so in words that fit the state", () => {
    expect(text(page(link(), "andres"))).toContain("No notes yet.");
    expect(text(page(link({ state: "requested" }), "andres"))).toContain("Notes start once the link is open.");
    expect(text(page(link({ state: "closed", closed_by: "jose", closed_at: T0 }), "andres"))).toContain("No notes were left.");
  });
});

// ── states as marks ──────────────────────────────────────────────────────────
describe("a link's state is a mark, never a pill — and nothing for an open link", () => {
  const words: Record<Exclude<LinkState, "open">, string> = { draft: "Draft", requested: "Requested", declined: "Declined", cancelled: "Cancelled", closed: "Closed", expired: "Expired" };
  for (const [st, word] of Object.entries(words)) {
    it(`${st}: ${word}, with a tooltip`, () => {
      const html = page(link({ state: st as LinkState, closed_at: T0 }), "andres");
      expect(html).toMatch(new RegExp(`<span data-mtip="[^"]+"[^>]*><svg[^>]*>.*?</svg>${word}</span>`));
    });
  }
  it("open: no mark", () => {
    expect(page(link(), "andres")).not.toMatch(/data-mtip="[^"]*"[^>]*><svg[^>]*viewBox="0 0 10 10"/);
  });
  it("no pill, no uppercase transform in the module's own marks", () => {
    expect(linksSrc).not.toMatch(/cnpy-pill|class="[^"]*pill/);
  });
  it("closed / declined / expired say how it ended", () => {
    expect(text(page(link({ state: "closed", closed_by: "jose", closed_at: T0, close_reason: "merged" }), "andres"))).toMatch(/Closed by @jose .*: merged/);
    expect(text(page(link({ state: "declined" }), "andres"))).toContain("Declined by @jose");
    expect(text(page(link({ state: "expired", closed_at: T0 }), "andres"))).toContain("Expired");
  });
});

// ── the Links tab ────────────────────────────────────────────────────────────
describe("the Links tab", () => {
  const bar = handoffsTabBar("links", { handoffs: 0, links: 1 });
  const boxes = {
    waiting: [link({ id: 3, state: "requested", requester: side("jose"), recipient: side("andres") })],
    open: [link({ id: 4 })],
    mine: [link({ id: 5, state: "draft" })],
    closed: [link({ id: 6, state: "closed", closed_at: T0, closed_by: "andres" })],
  };

  it("four sections — Waiting for you, Open, Yours, Closed — each row #n, topic, reason, the other person, a mark", () => {
    const html = linksView({ status: "ok", boxes, me: "andres", persons, bar });
    const at = (s: string) => html.indexOf(s);
    expect(at("WAITING FOR YOU")).toBeLessThan(at(">OPEN<"));
    expect(at(">OPEN<")).toBeLessThan(at("YOURS"));
    expect(at("YOURS")).toBeLessThan(at("CLOSED<"));
    for (const id of [3, 4, 5, 6]) expect(html).toContain(`data-act="openLink" data-arg="${id}"`);
    expect(text(html)).toContain("#3");
    expect(text(html)).toContain("PR #180");
    expect(text(html)).toContain("Both of us touch the session store.");
    expect(html).toContain('data-act="openPerson" data-arg="jose"');
    expect(text(html)).toMatch(/FROM(JO)?Jose/); // a request sent to me names who sent it
    expect(text(html)).toContain("Requested");
    expect(text(html)).toContain("Draft");
    // Rows are hit areas: never a button inside a button.
    expect(nestedButton(html)).toBe(false);
    expect(html).toContain('class="cnpy-hit"');
  });

  it("a branch topic reads in code; a self-link names you", () => {
    const html = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, mine: [link({ id: 8, state: "draft", self: true, topic: { kind: "branch", ref: "feat/x" }, recipient: side("andres") })] }, me: "andres", persons, bar });
    expect(html).toContain('font-family:var(--code)');
    expect(text(html)).toContain("branch feat/x");
    expect(text(html)).toContain("You, two sessions");
  });

  it("empty sections say so in plain words", () => {
    const html = linksView({ status: "ok", boxes: NO_LINK_BOXES, me: "andres", persons, bar });
    for (const s of Object.values(LINKS_EMPTY)) expect(html).toContain(s.replace(/'/g, "&#39;"));
  });

  it("loading draws the skeleton; a failed read says so", () => {
    expect(linksView({ status: "loading", boxes: NO_LINK_BOXES, me: "andres", persons, bar })).toContain("Loading links");
    expect(linksView({ status: "error", boxes: NO_LINK_BOXES, me: "andres", persons, bar })).toContain("Couldn&#39;t load links.");
  });

  it("a tabBar heads the Relay screen: Handoffs and Links, each with its own count", () => {
    const h = handoffsView({ status: "ok", handoffs: [], me: "andres", persons, bar: handoffsTabBar("handoffs", { handoffs: 2, links: 1 }) });
    expect(h).toContain('role="tablist" aria-label="Handoffs sections"');
    expect(h).toContain('data-act="handoffsTab" data-arg="links"');
    expect(h).toMatch(/id="handoffs-tab-handoffs" class="cnpy-tab is-on"/);
    expect(h).toContain('role="tabpanel" id="handoffs-tab-panel" aria-labelledby="handoffs-tab-handoffs"');
    expect(h).toContain('class="cnpy-badge" data-n="2"');
    expect(h).toContain('class="cnpy-badge" data-n="1"');
    const l = linksView({ status: "ok", boxes: NO_LINK_BOXES, me: "andres", persons, bar });
    expect(l).toContain('data-act="handoffsTab" data-arg="handoffs"');
    expect(l).toContain('aria-labelledby="handoffs-tab-links"');
  });
});

// ── routes ───────────────────────────────────────────────────────────────────
describe("routes: #links and #links/<n>", () => {
  const base = { ticketId: null, sprintId: null };
  it("parse, and round-trip", () => {
    expect(parseHash("#links")).toEqual({ screen: "links", ...base });
    expect(parseHash("#links/12")).toEqual({ screen: "link", ...base, linkId: 12 });
    expect(parseHash("#links/0").screen).toBe("mywork");
    expect(parseHash("#links/x").screen).toBe("mywork");
    expect(parseHash("#links/1/2").screen).toBe("mywork");
    for (const h of ["#links", "#links/12"]) expect(hashForRoute(parseHash(h))).toBe(h);
    // Not under #handoffs/: its second segment is a handoff's number.
    expect(parseHash("#handoffs/12")).toEqual({ screen: "handoff", ...base, handoffId: 12 });
  });
  it("Links is the Handoffs page's other tab (one page key); a link is its own page", () => {
    expect(pageKey(parseHash("#links"))).toBe(pageKey(parseHash("#handoffs")));
    expect(pageKey(parseHash("#links/12"))).not.toBe(pageKey(parseHash("#links/13")));
    expect(sameRoute(parseHash("#links/12"), parseHash("#links/13"))).toBe(false);
    expect(navKeyOf("links")).toBe("handoffs");
    expect(navKeyOf("link")).toBe("handoffs");
  });
});

// ── the sidebar badge: handoffs + links ──────────────────────────────────────
describe("the sidebar's Relay badge counts handoffs + link requests waiting for me", () => {
  const me = { handle: "andres", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 };
  const hoff = (id: number): HandoffView => ({
    id, sender: "jose", recipient: "andres", status: "pending", created_at: T0, claimed_at: null, claimed_by: null, claimed_by_session: null,
    prompt: null, body: "x", context: { repo: "", branch: "", task: "", done: [], next: [], files: [] },
  });
  const st = (over: Partial<AppState>): AppState => ({ ...initialState(), view: "app", screen: "mywork", me, orgSlug: "acme", ...over } as AppState);
  /** The number on the sidebar's Handoffs row. */
  const sidebarCount = (html: string): number => {
    const m = html.match(/data-act="goHandoffs"[^]*?class="cnpy-badge[^"]*"[^>]*data-n="(\d+)"/) ?? html.match(/data-act="goHandoffs"[^]*?data-n="(\d+)"/);
    return Number(m?.[1] ?? NaN);
  };

  it("before any list lands: the boot's /badges counts, added", () => {
    const s = st({ badges: { handoffs: 2, links: 3 } });
    expect(handoffBadge(s)).toBe(5);
    expect(sidebarCount(render(s))).toBe(5);
  });

  it("once the lists land: their own counts, added", () => {
    const s = st({
      badges: { handoffs: 9, links: 9 },
      handoffs: { status: "ok", data: [hoff(1)] },
      links: { status: "ok", data: { ...NO_LINK_BOXES, waiting: [link({ state: "requested" }), link({ id: 13, state: "requested" })], open: [link({ id: 14 })] } },
    });
    expect(handoffOnlyBadge(s)).toBe(1);
    expect(linkBadge(s)).toBe(2); // waiting only — an open link waits on nobody
    expect(handoffBadge(s)).toBe(3);
    expect(sidebarCount(render(s))).toBe(3);
  });

  it("links stay OUT of handoffsForMe (My Work counts it): main.ts lists them under their own key", () => {
    expect(handoffsForMe([hoff(1)], "andres")).toHaveLength(1);
    expect(mainSrc).toContain('listed("links", waiting.length)');
    expect(mainSrc).toMatch(/listed\("handoffs", handoffsForMe\(data, state\.me\?\.handle \?\? ""\)\.length\)/);
  });
});
