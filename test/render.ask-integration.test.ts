/**
 * Ask Trov — where the parts meet (the integrator's tests): the conversation draws the actions part's buttons with
 * the actions part's argument format, so a footer Save, a block's Save and Wrong? reach the right answer and block.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { actionsPart } from "../web/src/ask-actions";
import { SseParser, askEventOf } from "../web/src/ask-sse";
import { emptyConvo, foldAskEvent, foldThreadEvent, newTurn, withLastTurn, type AskConvo } from "../web/src/ask-stream";
import type { AskApi } from "../web/src/ask-api";
import type { AskCtx } from "../web/src/ask-state";
import { askRefFixtures, askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import answerSse from "../docs/superpowers/specs/ask-transcripts/answer.sse?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };

function answered(): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  const p = new SseParser();
  let c: AskConvo = { ...emptyConvo(), messages: [{ role: "user", key: "q1", id: 4, text: "What's blocking the hosting work?", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn: newTurn("smart") }] };
  for (const m of [...p.push(answerSse), ...p.flush()]) {
    const e = askEventOf(m)!;
    c = e.event === "thread" ? foldThreadEvent(c, e.data) : withLastTurn(c, (t) => foldAskEvent(t, e, 0));
  }
  s.ask.page = c;
  return s;
}

function ctxOf(s: AppState, api: Partial<AskApi>): AskCtx {
  return {
    get app() { return s; }, get ui() { return s.ask; }, api: api as AskApi, replay: false,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }), paint: () => undefined, flash: () => undefined, fail: () => undefined,
    want: () => undefined, send: () => undefined, stop: () => undefined, openRef: () => undefined, closeInspector: () => undefined,
    newThread: () => undefined, openThread: () => undefined, reloadThreads: () => undefined, exit: (_k, apply) => { apply(); }, cancelExit: () => undefined,
  } as AskCtx;
}
const argsOf = (html: string, act: string): string[] => [...html.matchAll(new RegExp(`data-act="${act}" data-arg="([^"]*)"`, "g"))].map((m) => m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'));

describe("Save as artifact and Wrong? — the conversation speaks the actions part's format", () => {
  it("the footer's Save asks for the whole answer's form, a block's Save for that block's", async () => {
    const s = answered();
    const messageId = s.ask.page.messages[1].role === "assistant" ? s.ask.page.messages[1].turn.messageId : null;
    expect(messageId).not.toBeNull();
    const saves = argsOf(render(s), "askAcSaveForm");
    // One per rich block, then the footer's.
    expect(saves).toContain("a1");
    const blocks = saves.filter((a) => a.startsWith("a1|"));
    expect(blocks.length).toBeGreaterThan(0);
    const asked: [number, number | undefined][] = [];
    const api = { saveForm: async (id: number, block?: number) => { asked.push([id, block]); return { block: { kind: "save_form" as const, form: { messageId: id, block: block ?? null, title: "T", kind: "html" as const, visibility: "private" as const, saved: null } }, index: 0 }; } };
    actionsPart.act!(ctxOf(s, api), "askAcSaveForm", "a1", null);
    await new Promise((r) => setTimeout(r, 0));
    const t = answered();
    actionsPart.act!(ctxOf(t, api), "askAcSaveForm", blocks[0], null);
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([[messageId, undefined], [messageId, Number(blocks[0].split("|")[1])]]);
  });

  it("Wrong? toggles the answer's reasons row, and the footer button says it is open", () => {
    const s = answered();
    const [arg] = argsOf(render(s), "askAcWrong");
    expect(arg).toBe("a1");
    actionsPart.act!(ctxOf(s, {}), "askAcWrong", arg, null);
    expect(s.ask.actions.wrongOpen.a1).toBe(true);
    expect(render(s)).toMatch(/data-act="askAcWrong" data-arg="a1" aria-expanded="true"/);
  });
});
