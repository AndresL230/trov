// The Ask controller's stream ends (web/src/ask-controller.ts `run`, web/src/ask-sse.ts), driven through the real
// client over a stubbed transport — the owner's rulings of 2026-10-16:
//   • POST /ask ERR_ABORTED: a connection that drops AFTER the last event (`done`) is never read as a Stop: the
//     answer stays done, not stopped, with no error — whatever the browser reports for the closed request.
//   • QA-4: after Stop the footer draws at once, and the stored answer's id is read back for Regenerate / Save / Wrong?.
//   • Q-F2: an answer that wrote nothing says so, with Try again, and no Copy / Save.
//   • Q52: a `thread` event with `autoOff` turns the composer's switch to "Asks first".
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
const transport: { handler: Handler; calls: string[] } = { handler: () => Response.json({}), calls: [] };
vi.mock("../web/src/api", async (orig) => {
  const real = await orig<typeof import("../web/src/api")>();
  return { ...real, apiFetch: async (path: string, init: RequestInit = {}) => { transport.calls.push(`${init.method ?? "GET"} ${path}`); return transport.handler(path, init); } };
});

import { initialState, type AppState } from "../web/src/render";
import { createAskController } from "../web/src/ask-controller";
import { conversationView } from "../web/src/ask-conversation";
import { askView } from "../web/src/ask-state";
import { askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import type { AskMessage, AskThreadDetail } from "@shared/ai-ask-core";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };

function app(): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  return s;
}
const controller = (s: AppState) => createAskController({ state: s, mount: { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement, rerender: () => undefined, flash: () => undefined, unauth: () => undefined, search: () => "" });
const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const THREAD = { id: 31, title: "", mode: "smart", auto: false, origin: "page", contextRef: null };
const DONE = { messageId: 62, questionId: 61, cites: [], tokens: { in: 1, out: 1, cached: 0 } };
const enc = new TextEncoder();
/** A streamed body: `chunks` go out, then the stream ends as `end` says (closed, or errored with that error). */
function body(chunks: string[], end: "close" | Error | "open"): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(enc.encode(x));
      if (end === "close") c.close();
      else if (end !== "open") setTimeout(() => c.error(end), 5);
    },
  });
}
const lastTurn = (s: AppState) => {
  const m = s.ask.page.messages.at(-1);
  if (!m || m.role !== "assistant") throw new Error("no answer");
  return m.turn;
};
const view = (s: AppState) => conversationView(askView(s, "page"));

beforeEach(() => { transport.calls = []; });

describe("POST /ask ERR_ABORTED: a close after the last event is never a Stop", () => {
  for (const [name, err] of [
    ["a network error (TypeError)", new TypeError("network error")],
    ["an abort the page did not ask for (AbortError)", new DOMException("The user aborted a request.", "AbortError")],
  ] as const) {
    it(`${name} after \`done\`: the answer stays done — not stopped, no error — with its footer`, async () => {
      const s = app();
      const ctl = controller(s);
      transport.handler = (path) => path === "/ask"
        ? new Response(body([sse("thread", THREAD), sse("text", { delta: "All of it arrived." }), sse("done", DONE)], err), { headers: { "content-type": "text/event-stream" } })
        : Response.json({ error: "not_found" }, { status: 404 });
      ctl.ctx.send({ text: "q", where: "page" });
      await vi.waitFor(() => expect(s.ask.page.busy).toBe(false), { timeout: 3000 });
      const t = lastTurn(s);
      expect(t).toMatchObject({ done: true, stopped: false, error: null, messageId: 62 });
      expect(view(s)).toContain(`data-act="askAcWrong"`);
      expect(view(s)).not.toContain("Stopped. The answer above is partial.");
      // Nothing asked the server to stop.
      expect(transport.calls.some((c) => c.includes("/stop"))).toBe(false);
    });
  }

  it("a clean end stays done too (the baseline)", async () => {
    const s = app();
    const ctl = controller(s);
    transport.handler = () => new Response(body([sse("thread", THREAD), sse("text", { delta: "Fine." }), sse("done", DONE)], "close"), { headers: { "content-type": "text/event-stream" } });
    ctl.ctx.send({ text: "q", where: "page" });
    await vi.waitFor(() => expect(s.ask.page.busy).toBe(false), { timeout: 3000 });
    expect(lastTurn(s)).toMatchObject({ done: true, stopped: false, error: null });
  });
});

describe("QA-4: the footer draws right after Stop; the stored id is read back", () => {
  it("Copy at once; Regenerate, Save and Wrong? once the thread read names the stored partial answer", async () => {
    const s = app();
    const ctl = controller(s);
    const stored: AskThreadDetail = {
      thread: { ...askThreadsFixture(NOW)[0], id: 31, draft: "" },
      messages: [
        { id: 61, role: "user", mode: "smart", text: "q", command: null, context: [], blocks: [], activity: [], followups: [], thinking: null, cites: [], attachments: [], actions: [], stopped: false, model: null, units: 0, createdAt: NOW.toISOString() } as unknown as AskMessage,
        { id: 62, role: "assistant", mode: "smart", text: "Half an ans", command: null, context: [], blocks: [], activity: [], followups: [], thinking: null, cites: [], attachments: [], actions: [], stopped: true, model: "m", units: 1, createdAt: NOW.toISOString() } as unknown as AskMessage,
      ],
    };
    transport.handler = (path) => path === "/ask"
      ? new Response(body([sse("thread", THREAD), sse("text", { delta: "Half an ans" })], "open"), { headers: { "content-type": "text/event-stream" } })
      : path === "/ask/threads/31" ? Response.json(stored)
      : Response.json({ ok: true });
    ctl.ctx.send({ text: "q", where: "page" });
    await vi.waitFor(() => expect(s.ask.page.threadId).toBe(31), { timeout: 3000 });
    await vi.waitFor(() => expect(view(s)).toContain("Half an ans"), { timeout: 3000 });
    ctl.ctx.stop("page");
    await vi.waitFor(() => expect(s.ask.page.busy).toBe(false), { timeout: 3000 });
    // At once: Stopped, and the footer with Copy (what is on screen).
    expect(lastTurn(s)).toMatchObject({ stopped: true, messageId: null });
    let h = view(s);
    expect(h).toContain("Stopped. The answer above is partial.");
    expect(h).toContain(`data-act="askCvCopy"`);
    expect(h).not.toContain(`data-act="askAcWrong"`);
    // Then the stored id: the rest of the footer.
    await vi.waitFor(() => expect(lastTurn(s).messageId).toBe(62), { timeout: 3000 });
    h = view(s);
    expect(h).toContain(`data-act="askAcWrong"`);
    expect(h).toContain(`data-act="askAcSaveForm"`);
    expect(h).toContain(`data-act="askCvRegen"`);
    const q = s.ask.page.messages.at(-2);
    expect(q?.role === "user" && q.id).toBe(61);
  });
});

describe("Q-F2: an answer that wrote nothing", () => {
  it("says Trov didn't write an answer, with Try again — no Copy, no Save", async () => {
    const s = app();
    const ctl = controller(s);
    transport.handler = () => new Response(body([sse("thread", THREAD), sse("activity", { step: 1, tool: "get_ticket", icon: "read", label: "Read ticket #4", state: "run" }), sse("activity", { step: 1, state: "done" }), sse("done", DONE)], "close"), { headers: { "content-type": "text/event-stream" } });
    ctl.ctx.send({ text: "q", where: "page" });
    await vi.waitFor(() => expect(s.ask.page.busy).toBe(false), { timeout: 3000 });
    const h = view(s);
    expect(h).toContain("Trov didn't write an answer.");
    expect(h).toMatch(/data-act="askCvRetry" data-arg="page:a[^"]+">Try again</);
    expect(h).not.toContain(`data-act="askCvCopy"`);
    expect(h).not.toContain(`data-act="askAcSaveForm"`);
  });
});

describe("Q52: a thread event with autoOff", () => {
  it("turns Auto off in the composer (Asks first), even though the state said it was allowed", async () => {
    const s = app();
    const ctl = controller(s);
    expect(s.ask.state.data?.autoAllowed).toBe(true);
    s.ask.composer.page.auto = true;
    transport.handler = () => new Response(body([sse("thread", { ...THREAD, autoOff: true }), sse("text", { delta: "Asked first." }), sse("done", DONE)], "close"), { headers: { "content-type": "text/event-stream" } });
    ctl.ctx.send({ text: "q", where: "page", auto: true });
    await vi.waitFor(() => expect(s.ask.page.busy).toBe(false), { timeout: 3000 });
    expect(s.ask.state.data?.autoAllowed).toBe(false);
    expect(s.ask.composer.page.auto).toBeNull();
  });
});
