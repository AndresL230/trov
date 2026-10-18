// Relay › Links (web/src/links.ts) — the Links tab and a link's page over the real DTOs (shared/links.ts):
// each state as each viewer sees it (only the steps that viewer may take, and no others), each side kind, a
// self-link, who wrote each note, the join hint, the routes, and the sidebar's Relay badge = handoffs + links.
import { describe, it, expect } from "vitest";
import type { LinkDetail, LinkView, LinkSideView, LinkNoteView, LinkState, LinkPreview } from "../shared/links";
import type { HandoffView } from "../shared/handoffs";
import {
  linksView, linkDetailView, linkActionsFor, linkCanWrite, linkNeedsJoin, linkCancelModal,
  linkSessionHtml, noteAuthorHtml, askThreadOf, LINKS_EMPTY, NO_LINK_BOXES, type LinkAction, type LinkDetailProps,
  linkStartCard, blankLinkStart, linkStartTarget, linkStartReady, linkStartRefusal, linkStartSpec, type LinkStart,
  linksHero, liveLinks, linkGlyph, linkCard, liveCardOrder, linkEndWords, LINKS_PAST_SHOWN, heroModel, heroCanvasData, linkAboutHtml, LINKS_LEAD, STATION_X, PERSON_MAX, HERO_BASE_Y, HERO_HUB_X, HERO_PERSON_Y,
} from "../web/src/links";
import docsSrc from "../web/src/docs-content.ts?raw";
import routesSrc from "../src/routes.ts?raw";
import { linkLineState, linkLine, LINE_W, LINE_H, parseHero, arcHeight } from "../web/src/link-line";
import linkLineSrc from "../web/src/link-line.ts?raw";
import orbSrc from "../web/src/thinking-orb.ts?raw";
import cssSrc from "../web/src/trov.css?raw";
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
  const boxes = {
    waiting: [link({ id: 3, state: "requested", requester: side("jose"), recipient: side("andres") })],
    open: [link({ id: 4 })],
    mine: [link({ id: 5, state: "draft" })],
    closed: [link({ id: 6, state: "closed", closed_at: T0, closed_by: "andres" })],
  };

  it("live links are CARDS (waiting for you first, then open, then yours); ended ones a PAST history below", () => {
    const html = linksView({ status: "ok", boxes, me: "andres", persons });
    const at = (s: string) => html.indexOf(s);
    expect(at('data-link-card="3"')).toBeLessThan(at('data-link-card="4"'));
    expect(at('data-link-card="4"')).toBeLessThan(at('data-link-card="5"'));
    expect(at('data-link-card="5"')).toBeLessThan(at(">PAST<"));
    expect(at(">PAST<")).toBeLessThan(at('data-link-row="6"'));
    for (const id of [3, 4, 5, 6]) expect(html).toContain(`data-act="openLink" data-arg="${id}"`);
    expect(text(html)).toContain("PR #180");
    expect(text(html)).toContain("Both of us touch the session store.");
    expect(text(html)).toContain("Requested");
    expect(text(html)).toContain("Draft");
    expect(html).not.toContain("WAITING FOR YOU");
    // Cards are hit areas: never a button inside a button.
    expect(nestedButton(html)).toBe(false);
    expect(html).toContain('class="cnpy-hit"');
  });

  it("a branch topic reads in code on its card", () => {
    const html = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, mine: [link({ id: 8, state: "draft", self: true, topic: { kind: "branch", ref: "feat/x" }, recipient: side("andres") })] }, me: "andres", persons });
    expect(html).toContain('font-family:var(--code)');
    expect(text(html)).toContain("branch feat/x");
  });

  it("no past links: says so in plain words", () => {
    const html = linksView({ status: "ok", boxes: NO_LINK_BOXES, me: "andres", persons });
    expect(html).toContain(LINKS_EMPTY.past.replace(/'/g, "&#39;"));
  });

  it("loading draws the skeleton; a failed read says so", () => {
    expect(linksView({ status: "loading", boxes: NO_LINK_BOXES, me: "andres", persons })).toContain("Loading links");
    expect(linksView({ status: "error", boxes: NO_LINK_BOXES, me: "andres", persons })).toContain("Couldn&#39;t load links.");
  });

  it("no tab bar: Handoffs and Links are Relay's pages, each with a back button to Relay (the owner's call)", () => {
    const h = handoffsView({ status: "ok", handoffs: [], me: "andres", persons });
    const l = linksView({ status: "ok", boxes: NO_LINK_BOXES, me: "andres", persons });
    for (const html of [h, l]) { expect(html).not.toContain('role="tablist"'); expect(html).not.toContain("handoffsTab"); }
    for (const screen of ["handoffs", "links"] as const) {
      const page = render({ ...initialState(), view: "app", screen, orgSlug: "acme" } as AppState);
      expect(page).toMatch(/data-act="goRelay"[^>]*>[\s\S]*?Relay/);
    }
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
  it("Relay, Handoffs and Links are pages of their own now (no tabs); a link is its own page; all light Relay", () => {
    expect(pageKey(parseHash("#links"))).not.toBe(pageKey(parseHash("#handoffs")));
    expect(pageKey(parseHash("#relay"))).not.toBe(pageKey(parseHash("#handoffs")));
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
    const m = html.match(/data-act="goRelay"[^]*?class="cnpy-badge[^"]*"[^>]*data-n="(\d+)"/) ?? html.match(/data-act="goRelay"[^]*?data-n="(\d+)"/);
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

// ── the link line: two orbs and the particles between them (link-line.ts) ──────
describe("the link line — the visual follows the state; the words still carry it", () => {
  const attrs = (html: string) => ({
    left: html.match(/data-ll-left="([^"]+)"/)?.[1], right: html.match(/data-ll-right="([^"]+)"/)?.[1],
    flow: html.match(/<canvas[^>]*data-ll-flow="([^"]+)"/)?.[1],
  });

  it("draft: a flicker from the requester, the recipient asleep; requested: a one-way trickle to a listening orb", () => {
    expect(linkLineState(link({ state: "draft" }))).toMatchObject({ left: "awake", right: "asleep", flow: "flicker" });
    expect(linkLineState(link({ state: "requested", requester: side("andres") }))).toMatchObject({ left: "hollow", right: "calling", flow: "trickle" });
  });

  it("open: flowing both ways; a side with no session yet is a hollow ring", () => {
    expect(linkLineState(link())).toMatchObject({ left: "awake", right: "hollow", flow: "flow" });
    expect(linkLineState(link({ recipient: side("jose", { kind: "chat", session: "c" }) }))).toMatchObject({ left: "awake", right: "awake", flow: "flow" });
  });

  it("ended: the particles stop and both orbs dim (a still frame)", () => {
    for (const st of ["declined", "cancelled", "expired", "closed"] as const) {
      expect(linkLineState(link({ state: st, closed_at: T0 }))).toMatchObject({ left: "dim", right: "dimhollow", flow: "stopped" });
    }
  });

  it("a note: the count and whose side wrote the last one (a growing count sends a pulse from that side)", () => {
    const l = link({ notes: [note({ id: 1, side: "recipient" }), note({ id: 2, side: "requester", author: "andres" })] });
    expect(linkLineState(l)).toMatchObject({ notes: 2, last: "requester" });
    const html = page(l, "andres");
    expect(html).toContain('data-ll-notes="2"');
    expect(html).toContain('data-ll-last="requester"');
  });

  it("the page head draws it: an aria-hidden canvas sized in the template, the mode in data attributes, the words kept", () => {
    const html = page(link({ state: "requested" }), "jose");
    expect(html).toMatch(/<canvas class="cnpy-ll-cv" data-linkline [^>]*width="\d+" height="\d+" aria-hidden="true">/);
    expect(attrs(html)).toEqual({ left: "awake", right: "calling", flow: "trickle" });
    expect(html).toContain('data-link-line data-flow="trickle"');
    // The words under the orbs carry every meaning: who, which side, which session; the state's mark stays.
    expect(text(html)).toContain("coding session on feat/auth");
    expect(text(html)).toContain("waiting for a session");
    expect(text(html)).toContain("Requested");
    const ended = page(link({ state: "declined", decided_at: T0 }), "andres");
    expect(attrs(ended)).toEqual({ left: "dim", right: "dimhollow", flow: "stopped" });
    expect(text(ended)).toContain("Declined");
  });

  it("the canvas never changes size on a repaint: its width / height are the template's, the CSS keeps its aspect", () => {
    const a = linkLine({ left: "awake", right: "hollow", flow: "flow" });
    const b = linkLine({ left: "dim", right: "dim", flow: "stopped" });
    const size = (h: string) => h.match(/width="(\d+)" height="(\d+)"/)?.slice(1);
    expect(size(a)).toEqual(size(b));
    expect(size(a)).toEqual([String(LINE_W), String(LINE_H)]); // 1× outside a browser
    expect(cssSrc).toContain(`aspect-ratio:${LINE_W} / ${LINE_H}`);
  });

  it("one loop: it paints on the thinking orb's rAF loop and clock, and reduced motion is one still frame", () => {
    expect(linkLineSrc).toContain('addOrbPainter({ selector: "canvas[data-linkline]"');
    expect(linkLineSrc).not.toMatch(/requestAnimationFrame\(|setInterval\(/);
    expect(orbSrc).toMatch(/if \(more && !still\) raf = requestAnimationFrame\(tick\)/);
    // A still paint draws the fixed scatter and asks for no more frames.
    expect(linkLineSrc).toMatch(/if \(still\) ps = stillParticles/);
    expect(linkLineSrc).toContain("const moving = !still &&");
    expect(cssSrc).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-ll-face > \.cnpy-av, \[data-link-start\] \{ animation:none; \} \}/);
    // The ink is the theme's --accent; no colour of its own.
    expect(linkLineSrc).toContain("inkOf(c)");
    expect(linkLineSrc).not.toMatch(/#[0-9a-f]{6}\b/i);
  });
});

// ── Start a link (the card at the top of the Links tab) ──────────────────────────
describe("Start a link — the card", () => {
  // Most of these are the "With a teammate" option; "Between my sessions" (the default) has its own tests below.
  const blank = (): LinkStart => ({ ...blankLinkStart(), mode: "team" });
  const card = (d: Partial<LinkStart> = {}, me = "andres") => linkStartCard({ draft: { ...blank(), ...d }, me, persons });
  const sendBtn = (html: string) => html.match(/<button type="button" data-act="linkStartSend"[^>]*>[^<]*<\/button>/)?.[0] ?? "";

  it("the header's Start a link opens it on the Links tab, which is patched in place (the form keeps its focus)", () => {
    const me = { handle: "andres", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 };
    const base = { ...initialState(), view: "app", screen: "links", me, orgSlug: "acme", persons: { status: "ok", data: persons } } as AppState;
    const closed = render(base);
    expect(closed).toContain('data-morph="links"');
    expect(closed).toContain('data-act="linkStartOpen"');
    expect(closed).toContain("data-link-start-slot></div>");
    const open = render({ ...base, linkStart: blankLinkStart() } as AppState);
    expect(open).toContain("data-link-start ");
    expect(open).toContain(">Start a link</h3>");
  });

  it("you on the left, them on the right, one line between; a segmented About and the reason with its count", () => {
    const html = card();
    expect(html.match(/<canvas[^>]*data-linkline/g)).toHaveLength(1);
    expect(html).toContain('data-seg="link-start-kind"');
    for (const w of ["Person", "Pull request", "Branch", "Ticket"]) expect(text(html)).toContain(w);
    expect(html).toContain('maxlength="280"');
    expect(text(html)).toContain("0 / 280");
    expect(text(html)).toContain("You");
    expect(text(html)).toContain("Who is it with?");
    expect(html).not.toContain("<select");
    expect(nestedButton(html)).toBe(false);
  });

  it("their orb wakes as it is filled in: asleep → named (their photo inside) → the line reaches further with a reason", () => {
    expect(linkStartSpec(blank(), "andres")).toMatchObject({ left: "awake", right: "asleep", flow: "preview", rate: 0 });
    const named = { ...blank(), person: "jose" };
    expect(linkStartSpec(named, "andres")).toMatchObject({ right: "named", flow: "preview" });
    expect(linkStartSpec({ ...named, reason: "x".repeat(40) }, "andres").rate).toBe(1);
    const html = card({ person: "jose" });
    expect(html).toMatch(/data-ll-face="right"><div class="cnpy-av"[^>]*>JO<img[^>]*src="https:\/\/example.com\/jose.png"/);
    expect(text(html)).toContain("@jose");
    expect(html).toMatch(/data-act="linkStartPerson" data-arg="jose"[^>]*aria-pressed="true"/);
    // Nothing picked: the right photo slot is there but hidden (the structure never changes).
    expect(card()).toContain('data-ll-face="right" hidden>');
  });

  it("a PR, branch or ticket: Trov's searching globe and what it will look up, in words", () => {
    const pr = { ...blank(), kind: "pr" as const, ref: "180" };
    expect(linkStartSpec(pr, "andres").right).toBe("seeking");
    const html = card(pr);
    expect(html).toContain('inputmode="numeric"');
    expect(text(html)).toContain("PR #180&#39;s author");
    expect(text(card({ kind: "branch", ref: "feat/x" }))).toContain("Whoever pushed feat/x");
    expect(text(card({ kind: "ticket", ref: "#12" }))).toContain("Ticket #12&#39;s assignee");
  });

  it("the target: exactly one of person, pr, branch, ticket — or nothing while it is not valid", () => {
    expect(linkStartTarget({ kind: "person", person: "jose", ref: "" })).toEqual({ person: "jose" });
    expect(linkStartTarget({ kind: "person", person: "", ref: "" })).toBeNull();
    expect(linkStartTarget({ kind: "pr", person: "jose", ref: "#180" })).toEqual({ pr: 180 });
    expect(linkStartTarget({ kind: "ticket", person: "", ref: "12" })).toEqual({ ticket: 12 });
    expect(linkStartTarget({ kind: "ticket", person: "", ref: "twelve" })).toBeNull();
    expect(linkStartTarget({ kind: "branch", person: "", ref: " feat/x " })).toEqual({ branch: "feat/x" });
  });

  it("Send waits for a target only (the why is optional); a link with yourself says it opens at once", () => {
    expect(sendBtn(card({ person: "" }))).toContain("disabled");
    expect(sendBtn(card({ person: "jose" }))).not.toContain("disabled");
    expect(text(card({ person: "jose" }))).toContain("Optional · 0 / 280");
    expect(sendBtn(card({ person: "jose", reason: "x".repeat(281) }))).toContain("disabled");
    expect(linkStartReady({ ...blank(), person: "jose", reason: "Both in the session store." })).toBe(true);
    const ready = sendBtn(card({ person: "jose", reason: "Both in the session store." }));
    expect(ready).not.toContain("disabled");
    expect(ready).toContain("Send request");
    const self = card({ person: "andres", reason: "Two of my sessions." });
    expect(sendBtn(self)).toContain("Open link");
    expect(text(self)).toContain("Both sides are yours, so it opens at once.");
    expect(sendBtn(card({ person: "jose", reason: "x", phase: "sending" }))).toContain("Sending…");
  });

  it("Send streams the particles across (a burst); sent lights their orb and says what happens next", () => {
    expect(linkStartSpec({ ...blank(), person: "jose", reason: "x", phase: "sending" }, "andres").flow).toBe("burst");
    const sent = link({ id: 22, state: "requested", requester: side("andres"), recipient: side("jose") });
    const d = { ...blank(), person: "jose", reason: "x", phase: "sent" as const, sent };
    expect(linkStartSpec(d, "andres")).toMatchObject({ left: "awake", right: "calling", flow: "trickle" });
    const html = card(d);
    expect(text(html)).toContain("Sent to Jose. They accept it in Relay");
    expect(text(html)).toContain("join Trov link #22");
    expect(html).toContain('data-act="openLink" data-arg="22"');
    const self = card({ ...d, sent: { ...sent, state: "open", self: true, recipient: side("andres") } });
    expect(text(self)).toContain("Link #22 is open: both sides are yours.");
    expect(linkStartSpec({ ...d, sent: { ...sent, state: "open", self: true } }, "andres").flow).toBe("flow");
  });

  it("a refusal shows in place, in plain words, and both orbs dim", () => {
    expect(linkStartRefusal("limit", "at most 5 open or requested links per person: close one first")).toBe("You already have 5 open or requested links. Close or cancel one below, then send this one.");
    expect(linkStartRefusal("not_member", "jose is not a member of this organization")).toBe("Jose is not a member of this organization.");
    expect(linkStartRefusal("not_found", "Trov has no PR #185")).toBe("Trov has no PR #185. Check the number or the branch's name, or pick the person instead.");
    expect(linkStartRefusal(null, null)).toBe("Couldn't start this link. Try again in a moment.");
    const d = { ...blank(), person: "jose", reason: "x", phase: "refused" as const, error: "You already have 5 open or requested links." };
    expect(linkStartSpec(d, "andres")).toMatchObject({ left: "dim", flow: "none" });
    const html = card(d);
    expect(html).toMatch(/<div data-link-start-error role="alert" style="[^"]*">You already have 5/);
    // While nothing is refused the error slot is there, hidden.
    expect(card({ person: "jose" })).toMatch(/data-link-start-error role="alert" hidden/);
  });

  it("main.ts posts the card's target and reason, and says a refusal in place (never a toast)", () => {
    expect(mainSrc).toContain("startLink(target, d.reason.trim())");
    expect(mainSrc).toContain('phase: "refused", error: linkStartRefusal(');
  });

  it("the default is BETWEEN MY SESSIONS: target yourself, two client orbs, opens at once", () => {
    expect(blankLinkStart().mode).toBe("self");
    const d = { ...blankLinkStart(), reason: "The terminal and the chat share the export." };
    expect(linkStartTarget(d, "andres")).toEqual({ person: "andres" });
    expect(linkStartReady(d, "andres")).toBe(true);
    expect(linkStartSpec(d, "andres")).toMatchObject({ left: "awake", right: "hollow", flow: "preview" });
    const html = linkStartCard({ draft: d, me: "andres", persons });
    expect(html).toMatch(/data-seg="link-start-mode"[\s\S]*?Between my sessions[\s\S]*?With a teammate/);
    expect(html).toMatch(/aria-pressed="true"[^>]*>Between my sessions</);
    expect(html).not.toContain('data-seg="link-start-kind"'); // no "about" picker between your own sessions
    expect(html).toMatch(/data-ll-face="left"><span class="cnpy-lh-ico"/);
    expect(text(html)).toContain("One session of yours");
    expect(text(html)).toContain("Another session of yours");
    expect(sendBtn(html)).toContain("Open link");
    expect(text(html)).toContain("Both sides are yours, so it opens at once.");
  });

  it("With a teammate is the second option: the person / PR / branch / ticket picker, no 'You' chip", () => {
    const html = card();
    expect(html).toMatch(/aria-pressed="true"[^>]*>With a teammate</);
    expect(html).toContain('data-seg="link-start-kind"');
    expect(html).not.toContain("You, two sessions");
    expect(mainSrc).toContain('case "linkStartMode"');
  });

  it("after a link between your sessions opens: its number and how each client joins (copy, or Open in Ask)", () => {
    const sent = link({ id: 30, state: "open", self: true, requester: side("andres"), recipient: side("andres") });
    const html = linkStartCard({ draft: { ...blankLinkStart(), reason: "x", phase: "sent", sent }, me: "andres", persons });
    expect(text(html)).toContain("Link #30 opened");
    expect(text(html)).toContain("Join it from two sessions");
    expect(text(html)).toContain("join Trov link #30");
    expect(html).toContain('data-act="linkJoinCopy" data-arg="30"');
    expect(html).toContain('data-act="linkJoinAsk" data-arg="30"');
    // Open in Ask: a new thread with the phrase typed in its composer.
    expect(mainSrc).toMatch(/case "linkJoinAsk"[\s\S]*?askCtl\.act\("askShNew"[\s\S]*?text: linkJoinPhrase\(id\)/);
  });
});

describe("the Links tab's arc diagram — your client kinds as stations, teammates below", () => {
  const L = (over: Partial<LinkDetail>) => link({ notes: [], ...over });
  const boxesOf = (over: Partial<typeof NO_LINK_BOXES> = {}) => ({ ...NO_LINK_BOXES, ...over });
  const hero = (b = boxesOf(), busy = false) => linksHero({ boxes: b, me: "andres", persons, busy, status: "ok" });
  const code = (session: string, branch: string) => ({ kind: "code" as const, session, branch });
  const spread = boxesOf({
    waiting: [L({ id: 2, state: "requested", requester: side("jose"), recipient: side("andres"), topic: { kind: "person", ref: "andres" } })],
    open: [
      L({ id: 1, requester: side("jose", code("j-1", "feat/api")), recipient: side("andres", code("a-export", "feat/export")) }),
      L({ id: 12, self: true, requester: side("andres"), recipient: side("andres") }), // neither side joined
      L({ id: 13, self: true, requester: side("andres", { kind: "ask", session: "ask-thread-9" }), recipient: side("andres") }), // one side joined
      L({ id: 14, requester: side("mei", { kind: "chat", session: "m-c" }), recipient: side("andres") }),
      L({ id: 15, self: true, requester: side("andres", code("a-export", "feat/export")), recipient: side("andres", { kind: "chat", session: "a-chat" }) }),
      L({ id: 16, self: true, requester: side("andres", code("a-export", "feat/export")), recipient: side("andres", { kind: "ask", session: "ask-thread-7" }) }),
      L({ id: 17, self: true, requester: side("andres", code("a-export", "feat/export")), recipient: side("andres", code("a-ocr", "fix/ocr")) }),
    ],
    mine: [L({ id: 11, state: "draft", requester: side("andres", code("a-export", "feat/export")), recipient: side("jose") })],
  });

  it("ONE station per client kind, at most three, left to right: Claude Code, Web chat, Ask thread", () => {
    const m = heroModel(spread, "andres");
    expect(m.kinds.map((k) => k.kind)).toEqual(["code", "chat", "ask"]);
    expect(m.kinds[0].sessions.map((s) => s.session)).toEqual(["a-export", "a-ocr"]); // two Claude Code sessions fold
    expect(m.kinds.map((k) => k.x)).toEqual([...STATION_X[3]]);
    expect(m.kinds.every((k) => k.y === HERO_BASE_Y)).toBe(true);
    const html = hero(spread);
    expect(html.match(/data-lh-kind="/g)).toHaveLength(3);
    expect(html).toMatch(/data-lh-kind="code" data-sessions="2"[\s\S]*?cnpy-lh-name" aria-hidden="true">Claude Code<span class="cnpy-lh-count"> · 2<\/span>/);
    expect(html).toMatch(/data-lh-kind="chat" data-sessions="1"[\s\S]*?>Web chat<\/span>/);
    expect(html).not.toMatch(/Web chat<span class="cnpy-lh-count">/); // a count only when > 1
  });

  it("an Ask station opens Ask (the thread when there is one); its card and label list what each session holds", () => {
    const html = hero(spread);
    expect(html).toMatch(/data-lh-kind="ask"[\s\S]*?href="#ask"/); // two threads: Ask itself
    const one = hero(boxesOf({ open: [L({ id: 16, self: true, requester: side("andres", code("a", "b")), recipient: side("andres", { kind: "ask", session: "ask-thread-7" }) })] }));
    expect(one).toMatch(/data-lh-kind="ask"[\s\S]*?href="#ask\/7"/);
    expect(html).toMatch(/data-lh-kind="code"[\s\S]*?aria-label="Claude Code, 2 sessions: on feat\/export \(link #1 with Jose; link #11 with Jose; link #15 with your web chat; link #16 with your Ask thread; link #17 with another Claude Code session\); on fix\/ocr \(link #17 with another Claude Code session\)\."/);
  });

  it("links between your sessions: one arc ABOVE the line per pair of kinds, a loop for the same kind; unjoined sides draw nothing", () => {
    const m = heroModel(spread, "andres");
    const self = m.lines.filter((x) => !x.quiet);
    expect(self.map((x) => [x.links.map((l) => l.id), x.shape])).toEqual([[[15], "u"], [[16], "u"], [[17], "o"]]);
    for (const id of [12, 13]) expect(m.lines.some((x) => x.links.some((l) => l.id === id))).toBe(false); // only in the rows
    expect(hero(spread)).not.toMatch(/Not joined|socket/);
    // Two links between the same two kinds are ONE arc, denser.
    const twice = heroModel(boxesOf({ open: [spread.open[4], L({ id: 18, self: true, requester: side("andres", code("a-export", "feat/export")), recipient: side("andres", { kind: "chat", session: "b-chat" }) })] }), "andres");
    expect(twice.lines).toHaveLength(1);
    const { segs } = heroCanvasData(twice, "andres");
    expect(segs[0]).toMatchObject({ n: 2, shape: "u", quiet: false, flow: "flow" });
  });

  it("teammates sit BELOW the line, one per person, an arc dropping from the station that holds the link — or from you", () => {
    const m = heroModel(spread, "andres");
    expect(m.people.map((p) => p.handle)).toEqual(["jose", "mei"]);
    expect(m.people.every((p) => p.y === HERO_PERSON_Y && p.y > HERO_BASE_Y)).toBe(true);
    const { orbs, segs } = heroCanvasData(m, "andres");
    const jose = segs.filter((g) => g.id === 1);
    expect(jose).toHaveLength(1); // #1 and #11 leave the same station for the same person: one arc
    expect(jose[0]).toMatchObject({ shape: "d", quiet: true, n: 2 });
    expect(orbs[jose[0].b].look).toBe("awake"); // my end: the Claude Code station
    const mei = segs.find((g) => g.id === 14)!;
    expect(mei.b).toBe(0); // my side not joined: from my photo
    const ask = segs.find((g) => g.id === 2)!;
    expect(ask).toMatchObject({ flow: "pulse", b: 0, shape: "d" }); // the request travels up to me
    expect(orbs[0]).toMatchObject({ look: "hub", x: HERO_HUB_X, y: HERO_BASE_Y });
    const html = hero(spread);
    expect(html).toMatch(/<canvas class="cnpy-lh-cv" data-linkhero data-lh-base="\d+,\d+,\d+" data-lh-orbs="[^"]+" data-lh-segs="[^"]+"[^>]*aria-hidden="true">/);
    const back = parseHero(html.match(/data-lh-orbs="([^"]*)"/)![1], html.match(/data-lh-segs="([^"]*)"/)![1]);
    expect(back.segs.map((g) => g.shape).sort()).toEqual(["d", "d", "d", "o", "u", "u"]);
  });

  it("a request waiting for you: Jose's orb is marked asking; its Accept / Decline live on its card (no callout here)", () => {
    const html = hero(spread);
    expect(html).toMatch(/class="cnpy-lh-node is-person is-asking" data-lh-person="jose"/);
    expect(html).not.toContain('data-act="linkAccept"');
    expect(html).not.toContain("data-lh-ask");
  });

  it("one kind: that station and the teammates; nothing linked: you alone, the lead sentence and Link two of your sessions", () => {
    const solo = heroModel(boxesOf({ open: [spread.open[0]] }), "andres");
    expect(solo.kinds.map((k) => k.x)).toEqual([...STATION_X[1]]);
    const html = hero();
    expect(html).toContain('data-lh-count="0"');
    expect(html).toContain('data-lh-kinds=""');
    expect(html).toContain("data-lh-empty");
    expect(text(html)).toContain("Connect your own sessions");
    expect(html).toContain('data-act="linkStartOpen"');
    expect(linksHero({ boxes: boxesOf(), me: "andres", persons, busy: false, status: "loading" })).not.toContain("data-lh-empty");
  });

  it(`at most ${PERSON_MAX} people, spaced so their names never touch; the rest are "+N more"`, () => {
    const many = boxesOf({ open: ["jose", "mei", "a", "b", "c", "d", "e", "f"].map((h, i) => L({ id: i + 1, requester: side("andres", code("x", "y")), recipient: side(h) })) });
    const m = heroModel(many, "andres");
    expect(m.people).toHaveLength(PERSON_MAX);
    const xs = m.people.map((p) => p.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(90);
    expect(text(hero(many))).toContain("+2 more in the list below");
  });

  it("the arcs over the line clear the canvas top, and a station's words sit under it (the arcs leave from its top)", () => {
    const span = STATION_X[3][2] - STATION_X[3][0];
    expect(HERO_BASE_Y - 39 - arcHeight(span) * 0.75).toBeGreaterThan(0);
    expect(cssSrc).toMatch(/\.cnpy-lh-name \{ top:calc\(100% - 2px\)/);
  });

  it("it heads the Links tab, above the lead sentence and the list", () => {
    const html = linksView({ status: "ok", boxes: spread, me: "andres", persons });
    expect(html.indexOf('class="cnpy-lh"')).toBeLessThan(html.indexOf("data-links-intro"));
    expect(html).toContain(LINKS_LEAD.replace(/'/g, "&#39;"));
    expect(html.indexOf("data-links-intro")).toBeLessThan(html.indexOf("data-link-cards"));
    // The unjoined self-links are in the cards, where the join hint lives.
    expect(html).toMatch(/data-link-card="12"[\s\S]*?data-link-card-join/);
    expect(html).toMatch(/data-link-card="13"[\s\S]*?data-link-card-join/);
  });

  it("with no live link the lead sentence is said once — in the diagram's empty block, beside its button", () => {
    const lead = LINKS_LEAD.replace(/'/g, "&#39;");
    const html = linksView({ status: "ok", boxes: boxesOf(), me: "andres", persons });
    expect(html.split(lead).length - 1).toBe(1);
    expect(html).toContain("data-lh-empty");
    expect(html).not.toContain("data-links-intro");
  });
});

describe("a link about a person reads WITH them", () => {
  it("rows and the page title: 'With Jose' / 'Link with Jose', never '@you'", () => {
    const l = link({ id: 2, state: "requested", requester: side("jose"), recipient: side("andres"), topic: { kind: "person", ref: "andres" } });
    expect(linkAboutHtml(l, "andres", persons)).toBe("with Jose");
    expect(linkAboutHtml({ ...l, self: true, requester: side("andres") }, "andres", persons)).toBe("between your sessions");
    expect(text(page(l, "andres"))).toContain("Link with Jose");
    const list = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, waiting: [l] }, me: "andres", persons });
    expect(text(list.slice(list.indexOf('data-link-card="2"')))).toContain("Jose asks to link with you");
    const past = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, closed: [{ ...l, state: "declined" }] }, me: "andres", persons });
    expect(text(past.slice(past.indexOf('data-link-row="2"')))).toContain("#2With Jose");
    expect(text(page(link(), "andres"))).toContain("Link about PR #180"); // other topics unchanged
  });

  it("the public docs lead with your own sessions", () => {
    expect(docsSrc).toContain("Connect your own sessions — a coding agent, a web chat, an Ask thread");
  });
});

describe("the Links tab's cards and past links", () => {
  const cp = { me: "andres", persons, busy: false };
  const pv = (over: Partial<LinkPreview> = {}): LinkPreview => ({ last: { side: "recipient", author: "jose", author_kind: "agent", excerpt: "Renaming authSession tonight.", created_at: T0 }, notes: 3, waiting: 2, ...over });
  const card = (l: LinkView, me = "andres") => linkCard(l, { ...cp, me });

  it("the order: waiting for you, then open by newest activity, then your requests and drafts", () => {
    const old = link({ id: 4, preview: pv({ last: { ...pv().last!, created_at: "2026-10-16T10:00:00Z" } }) });
    const fresh = link({ id: 9, preview: pv() });
    const b = { ...NO_LINK_BOXES, waiting: [link({ id: 3, state: "requested", requester: side("jose"), recipient: side("andres") })], open: [old, fresh], mine: [link({ id: 5, state: "draft" }), link({ id: 6, state: "requested" })] };
    expect(liveCardOrder(b, "andres").map((l) => l.id)).toEqual([3, 9, 4, 6, 5]);
  });

  it("a card's strip shows each side as a client on ONE line: an icon + 'Claude Code feat/auth', a teammate's photo and client, 'not joined'", () => {
    const html = card(link({ recipient: side("jose", { kind: "chat", session: "c" }) }));
    expect(html).toMatch(/class="cnpy-lcard-strip" data-row="strip" title="Claude Code · feat\/auth ⟷ Jose, web chat">/);
    expect(html).toMatch(/data-row="strip"[^>]*><span class="cnpy-lcard-side"><span class="cnpy-lcard-ico"[^>]*><svg/);
    expect(html).toMatch(/<div class="cnpy-av"[^>]*>JO<img/);
    expect(text(card(link()))).toContain("Jose, not joined");
    expect(text(card(link({ requester: side("andres") })))).toContain("not joined");
  });

  it("no canvas on a card (the diagram carries the motion); the strip's dots are full only while open", () => {
    expect(card(link())).not.toContain("<canvas");
    expect(card(link())).toMatch(/cnpy-lcard-dots[^>]*opacity:0\.9/);
    for (const st of ["requested", "draft"] as const) expect(card(link({ state: st }))).toMatch(/cnpy-lcard-dots[^>]*opacity:0\.35/);
  });

  it("the SAME five rows in the same order on every card, whatever its state — an empty row keeps its place", () => {
    const states = [
      link({ id: 3, state: "requested", requester: side("jose"), recipient: side("andres") }),
      link({ preview: pv() }),
      link({ requester: side("andres"), preview: { last: null, notes: 0, waiting: 0 } }),
      link({ state: "requested" }), link({ state: "draft" }), link({ self: true, recipient: side("andres") }),
    ];
    for (const l of states) {
      const rows = [...card(l).matchAll(/data-row="(\w+)"/g)].map((m) => m[1]);
      expect(rows).toEqual(["strip", "title", "why", "note", "foot"]);
    }
    expect(cssSrc).toMatch(/\.cnpy-lcard-foot \{ height:28px; margin-top:auto; \}/);
    expect(cssSrc).toMatch(/\.cnpy-lcard-why \{ height:18px;[^}]*white-space:nowrap; \}/);
  });

  it("the newest note on one line (who, excerpt, when) with 'N new' at the right — or a placeholder of the same row", () => {
    const html = card(link({ preview: pv() }));
    expect(text(html)).toContain("Jose&#39;s agent");
    expect(text(html)).toContain("Renaming authSession tonight.");
    expect(html).toMatch(/data-link-card-waiting[^>]*>2 new</);
    expect(card(link({ preview: pv({ waiting: 0 }) }))).not.toContain("data-link-card-waiting");
    expect(card(link({ preview: { last: null, notes: 0, waiting: 0 } }))).toMatch(/data-link-card-placeholder[^>]*>No notes yet</);
    expect(card(link({ state: "requested" }))).toMatch(/data-link-card-placeholder[^>]*>Notes start once it&#39;s open</);
  });

  it("each card's own steps: Accept / Decline, Close (+ join when your side has no session), Cancel request, Send / Cancel", () => {
    const asking = card(link({ id: 3, state: "requested", requester: side("jose"), recipient: side("andres") }));
    expect(asking).toMatch(/class="[^"]*cnpy-lcard cnpy-hitbox is-asking"/);
    expect(asking).toContain('data-act="linkAccept" data-arg="3"');
    expect(asking).toContain('data-act="linkDecline" data-arg="3"');
    expect(text(asking)).toContain("Jose asks to link about PR #180");
    const open = card(link({ requester: side("andres"), recipient: side("jose", { kind: "code", session: "x" }) }));
    expect(open).toContain('data-act="linkClose" data-arg="12"');
    expect(open).toMatch(/data-row="foot"><span data-link-card-join[^>]*><span[^>]*>join #12<\/span><button[^>]*data-act="linkJoinCopy" data-arg="12"[^>]*class="cnpy-iconbtn"/);
    expect(open).toMatch(/data-act="linkJoinAsk" data-arg="12" title="Open Ask with &quot;join Trov link #12&quot;"[^>]*class="cnpy-iconbtn"/);
    expect(card(link())).not.toContain("data-link-card-join"); // my side has a session
    const sent = card(link({ state: "requested" }));
    expect(sent).toMatch(/data-act="linkCancelArm" data-arg="12" data-confirm-trigger aria-haspopup="dialog"/);
    const drafted = card(link({ state: "draft" }));
    expect(drafted).toContain('data-act="linkSend" data-arg="12"');
    expect(drafted).toContain('data-act="linkCancel" data-arg="12"');
    for (const h of [asking, open, sent, drafted]) expect(nestedButton(h)).toBe(false);
    expect(linkCard(link({ state: "requested" }), { ...cp, busy: true })).toMatch(/data-act="linkCancelArm"[^>]*disabled/);
  });

  it("Cancel request from a card asks first (confirmModal at the root, by the card's link)", () => {
    const me = { handle: "andres", name: null, avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "member" as const }], superadmin: false, pending_invites: 0 };
    const html = render({ ...initialState(), view: "app", screen: "links", me, orgSlug: "acme", linkCancelArm: true, linkCancelId: 12, links: { status: "ok", data: { ...NO_LINK_BOXES, mine: [link({ state: "requested" })] } } } as AppState);
    expect(html).toContain('id="link-cancel-confirm"');
    expect(mainSrc).toContain("state.linkCancelId = Number(arg) || null;");
  });

  it("a person topic waiting for you reads 'Jose asks to link with you'", () => {
    expect(text(card(link({ id: 2, state: "requested", requester: side("jose"), recipient: side("andres"), topic: { kind: "person", ref: "andres" } })))).toContain("Jose asks to link with you");
  });

  it("the past: one line each — the dim glyph, the topic, who, how it ended in words, when, N notes", () => {
    const H = 3_600_000, t = (ms: number) => new Date(Date.parse(T0) + ms).toISOString();
    const closed = link({ id: 30, state: "closed", closed_at: T0, closed_by: "andres", close_reason: "The work landed.", preview: pv({ notes: 4 }) });
    const declined = link({ id: 31, state: "declined", decided_at: T0, closed_at: T0, requester: side("andres"), recipient: side("jose") });
    const idle = link({ id: 32, state: "expired", sent_at: T0, decided_at: T0, closed_at: t(12 * H) });
    const unanswered = link({ id: 33, state: "expired", sent_at: T0, decided_at: null, closed_at: t(24 * H) });
    const cancelled = link({ id: 34, state: "cancelled", closed_at: T0 });
    expect(linkEndWords(closed, "andres", persons)).toBe("Closed by you: The work landed");
    expect(linkEndWords(declined, "andres", persons)).toBe("Declined by Jose");
    expect(linkEndWords(idle, "andres", persons)).toBe("Expired after 12 h idle");
    expect(linkEndWords(unanswered, "andres", persons)).toBe("Expired: not answered in 24 h");
    expect(linkEndWords(cancelled, "andres", persons)).toBe("Cancelled by you");
    const html = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, closed: [closed, declined, idle, unanswered, cancelled] }, me: "andres", persons });
    expect(html.match(/data-link-row="\d+" data-past/g)).toHaveLength(5);
    expect(text(html)).toContain("4 notes");
    expect(html).toMatch(/data-link-row="30" data-past[\s\S]*?data-glyph="stopped"/);
    expect(html).toContain('data-act="openLink" data-arg="34"');
    expect(nestedButton(html)).toBe(false);
  });

  it(`always visible: the latest ${LINKS_PAST_SHOWN}, then "Show all N"`, () => {
    const many = Array.from({ length: 14 }, (_, i) => link({ id: 40 + i, state: "closed", closed_at: new Date(Date.parse(T0) - i * 60_000).toISOString() }));
    const html = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, closed: many }, me: "andres", persons });
    expect(html.match(/data-past/g)).toHaveLength(LINKS_PAST_SHOWN);
    expect(html).toMatch(/data-act="linksPastAll" aria-expanded="false"[^>]*>Show all 14</);
    expect(html).not.toContain("<details");
    const all = linksView({ status: "ok", boxes: { ...NO_LINK_BOXES, closed: many }, me: "andres", persons, pastAll: true });
    expect(all.match(/data-past/g)).toHaveLength(14);
    expect(mainSrc).toContain('case "linksPastAll": state.linksPastAll = !state.linksPastAll;');
  });

  it("each card's waiting count and preview come from the list read (the routes add `preview`)", () => {
    expect(routesSrc).toContain("linkPreviews(c.var.ctx, me, links.map((l) => l.id))");
  });
});

