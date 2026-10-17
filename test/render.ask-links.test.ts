/**
 * An Ask thread as a side of an agent link, on screen (docs/architecture/ask.md › Agent links): a thread with notes
 * waiting shows a MARK in the thread list (marks.ts's shape with its tooltip — never a pill) and ONE line at the top
 * of the thread ("Link #12 with @jose: 2 new notes"); a turn starting drops the line (nothing arrives mid-turn); the
 * link cards' lines and a `[[link:12]]` chip's words.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { initialState, type AppState } from "../web/src/render";
import { askView } from "../web/src/ask-state";
import { threadLinkMark, threadLinkNotes, threadsView } from "../web/src/ask-threads";
import { conversationView, linkNotesLine } from "../web/src/ask-conversation";
import { emptyConvo, foldThreadEvent } from "../web/src/ask-stream";
import { refFallbackText, refShort } from "../web/src/ask-refs";
import { doneText, proposedText } from "../web/src/ask-actions";
import type { AskThreadSummary, RefView } from "@shared/ai-ask-core";

const NOW = new Date().toISOString();
const thread = (id: number, links?: AskThreadSummary["links"]): AskThreadSummary => ({
  id, title: `Thread ${id}`, pinned: false, mode: "smart", auto: false, origin: "page", contextRef: null, hasDraft: false, group: "today",
  createdAt: NOW, updatedAt: NOW, ...(links ? { links } : {}),
});
const JOSE = [{ id: 12, with: "jose", self: false, notes: 2 }];

function state(over: (s: AppState) => void = () => undefined): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  s.ask.vw = 1440;
  s.ask.threads = { status: "ok", data: [thread(1, JOSE), thread(2)] };
  over(s);
  return s;
}

describe("the thread list's mark", () => {
  it("a thread with notes waiting carries a mark (a shape with its tooltip, no pill); one without carries none", () => {
    const html = threadsView(askView(state()));
    const row1 = html.slice(html.indexOf('data-morph-key="th:1"'), html.indexOf('data-morph-key="th:2"'));
    const row2 = html.slice(html.indexOf('data-morph-key="th:2"'));
    expect(row1).toContain('data-ask-th-link="2"');
    expect(row1).toContain('data-mtip="2 new notes on a Trov link. They reach this thread with your next question."');
    expect(row1).toMatch(/aria-label="2 new notes on a Trov link/);
    expect(row1).toContain("<svg");
    expect(row2).not.toContain("data-ask-th-link");
    // A mark, never a pill: no bordered or tinted chip, no uppercase word.
    const mark = threadLinkMark(thread(1, JOSE));
    expect(mark).not.toMatch(/border|background|text-transform|NOTES|NEW/);
  });

  it("counts every link's notes; none or an empty list is no mark", () => {
    expect(threadLinkNotes(thread(1, [...JOSE, { id: 13, with: "luke", self: false, notes: 1 }]))).toBe(3);
    expect(threadLinkMark(thread(1, [{ id: 13, with: "luke", self: false, notes: 1 }]))).toContain("1 new note on a Trov link. It reaches this thread");
    expect(threadLinkMark(thread(2))).toBe("");
    expect(threadLinkMark(thread(2, []))).toBe("");
  });
});

describe("the line at the top of the thread", () => {
  const open = (links?: AskThreadSummary["links"]) => state((s) => {
    s.ask.page = { ...emptyConvo(), threadId: 1, thread: thread(1, links), title: "Thread 1", status: "ok",
      messages: [{ role: "user", key: "m1", id: 1, text: "hi", context: [], attachments: [], command: null }] };
  });

  it("says which link, with whom and how many, links to the link's page, and comes before the messages", () => {
    const html = conversationView(askView(open(JOSE)));
    expect(html).toContain('data-ask-links');
    expect(html).toContain('<a class="ask-links-a" href="#links/12">Link #12</a> with @jose: 2 new notes');
    expect(html).toContain("They reach Trov with your next question.");
    expect(html.indexOf("data-ask-links")).toBeLessThan(html.indexOf('data-morph-key="msgs"'));
  });

  it("a link with oneself names the other session; one note is singular; no links, no line", () => {
    expect(linkNotesLine(askView(open([{ id: 3, with: "andres", self: true, notes: 1 }])))).toContain("Link #3</a> with your other session: 1 new note");
    expect(linkNotesLine(askView(open()))).toBe("");
    expect(conversationView(askView(open()))).not.toContain("data-ask-links");
  });

  it("a turn starting takes the notes, so the line goes (nothing arrives mid-turn)", () => {
    const c = open(JOSE).ask.page;
    const after = foldThreadEvent(c, { id: 1, title: "Thread 1", mode: "smart", auto: false, origin: "page", contextRef: null });
    expect(after.thread?.links).toBeUndefined();
    expect(after.thread?.title).toBe("Thread 1");
  });
});

describe("link refs and the link cards' lines", () => {
  const view: RefView = { ref: "link:12", type: "link", num: 12, title: "Link with @jose on PR #180", status: null, href: "#links/12", extra: { with: "jose" } };
  it("a link chip says `Link #12`; an unlinked token reads `link #12`", () => {
    expect(refShort(view)).toBe("Link #12");
    expect(refFallbackText("link:12")).toBe("link #12");
  });

  it("each link card's done line says what happened", () => {
    const vm = (tool: string, result: unknown, ref: string | null = "link:12") =>
      ({ id: 1, tool, kind: "handoff", state: "confirmed", preview: { title: "x", lines: [], item: null }, fields: {}, editable: [], note: null, result, ref, undo: false }) as never;
    expect(doneText([vm("request_link", { id: 12, state: "requested", with: "jose", self: false })])).toBe("Sent a link request to @jose (link #12)");
    expect(doneText([vm("request_link", { id: 12, state: "open", with: "andres", self: true })])).toBe("Opened link #12");
    expect(doneText([vm("join_link", { id: 12 })])).toBe("This thread joined link #12");
    expect(doneText([vm("send_link_note", { link: 12 })])).toBe("Left a note on link #12");
    expect(doneText([vm("close_link", { id: 12 })])).toBe("Closed link #12");
    expect(proposedText([vm("request_link", null, null)])).toBe("x");
  });
});
