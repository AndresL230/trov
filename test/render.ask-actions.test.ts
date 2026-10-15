/**
 * Ask Trov's ACTIONS part (web/src/ask-actions.ts), rendered from the design's recorded transcripts
 * (shared/ai-fixtures.ts › Ask Trov): the write cards of `actions-ask`, the done lines, the group and the waiting
 * Publish card of `actions-auto`, the Save form of `artifact` / `artifact-saved`, and "Wrong?". The acts run
 * through a fake `AskCtx` whose API answers the way the routes do (src/ai/ask/routes.ts; the same answers are
 * proven against the REAL routes in test/ask.actions-hookup.test.ts). The §4 guard proofs on the screen's side:
 * a Publish confirms only for someone who may promote, it never runs by itself in Auto, Undo refused when the item
 * changed since, and a card whose turn was replaced expires.
 */
import { describe, it, expect, vi, afterAll } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { initialState, type AppState } from "../web/src/render";
import { askView, type AskCtx, type AskView } from "../web/src/ask-state";
import {
  actionGroupView, actionsPart, saveFormView, feedbackView, wrongButton, saveButton, editedArgs, doneText, proposedText, listNumbers, toolOf,
  replayPriorExchange,
} from "../web/src/ask-actions";
import { foldAskEvent, foldThreadEvent, newTurn, shownParts, withLastTurn, type AskAnswer, type AskConvo, type AskActionVm } from "../web/src/ask-stream";
import { AskApiError, type AskApi } from "../web/src/ask-api";
import { replayPlan } from "../web/src/ask-replay";
import { askRefFixtures, askStateFixture, askTranscript, type AskScenario } from "@shared/ai-fixtures";
import type { AskActionAnswer, AskEventMap } from "@shared/ai-ask-core";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
// The lines' times ("Just now") are read against the clock: hold it at the fixtures' moment (Date only, so the
// awaited answers still settle on real timers).
vi.useFakeTimers({ toFake: ["Date"] });
vi.setSystemTime(NOW);
afterAll(() => { vi.useRealTimers(); });
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };
const PERSONS = [
  { handle: "andres", name: "Andres Lopez", color: "moss" as const, avatar_url: null, role: null },
  { handle: "maya", name: "Maya Chen", color: "sky" as const, avatar_url: null, role: null },
  { handle: "priya", name: "Priya Raman", color: "rose" as const, avatar_url: null, role: null },
];

/** The conversation after a scenario's transcript streamed (its question, then the folded answer). */
function convoOf(scenario: AskScenario): AskConvo {
  let c: AskConvo = { uid: "c1", threadId: null, thread: null, draft: "", title: "", status: "ok", busy: false,
    messages: [{ role: "user", key: "q1", id: null, text: "Q", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn: newTurn("smart") }] };
  for (const s of askTranscript(scenario, NOW)) {
    const e = s.event;
    c = e.event === "thread" ? foldThreadEvent(c, e.data) : withLastTurn(c, (t) => foldAskEvent(t, e, 0));
  }
  return c;
}

function app(scenario: AskScenario | null): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.persons = { status: "ok", data: PERSONS } as AppState["persons"];
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  if (scenario) s.ask.page = convoOf(scenario);
  return s;
}

/** A fake ctx over the state: the API is the caller's (answers shaped like the routes'). */
function ctxOf(s: AppState, api: Partial<AskApi>) {
  const flashes: string[] = [];
  const ctx: AskCtx = {
    get app() { return s; }, get ui() { return s.ask; }, api: api as AskApi, replay: false,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }),
    paint: () => undefined, flash: (m) => { flashes.push(m); },
    fail: (e, fallback) => { flashes.push(e instanceof AskApiError && e.message !== e.code ? e.message : fallback); },
    want: () => undefined, send: () => undefined, stop: () => undefined, openRef: () => undefined, closeInspector: () => undefined,
    newThread: () => undefined, openThread: () => undefined, reloadThreads: () => undefined,
    exit: (_k, apply) => { apply(); }, cancelExit: () => undefined,
  };
  return { ctx, flashes };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

const answerOf = (s: AppState): AskAnswer => s.ask.page.messages.filter((m): m is AskAnswer => m.role === "assistant").pop()!;
/** Every actions entry of the last answer, rendered. */
function cards(s: AppState, v: AskView = askView(s)): string[] {
  const a = answerOf(s);
  return shownParts(a.turn).flatMap((p) => (p.kind === "actions" ? [actionGroupView(v, a, p.ids)] : []));
}
const result = (id: number, state: AskEventMap["action_result"]["state"], ref: string | null, res: unknown = null, undo = state === "confirmed", groupId: string | null = null): AskEventMap["action_result"] =>
  ({ id, groupId, tool: "", kind: "other", preview: { title: "", lines: [], item: null }, state, result: res, ref, undo, at: NOW.toISOString() });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ── actions-ask ─────────────────────────────────────────────────────────────

describe("actions-ask — draft cards for a ticket, a handoff and a doc edit", () => {
  const s = app("actions-ask");
  const [ticket, handoff, doc] = cards(s);

  it("each card: its eyebrow, the draft mark, the body per kind, Cancel and Confirm — nothing runs before Confirm", () => {
    expect(text(ticket)).toMatch(/^New ticket Draft, not created yet/);
    expect(ticket).toContain("Reconnect expired hosting tokens from Org settings");
    expect(text(ticket)).toMatch(/Category bug Priority High Assignee AL Andres Lopez Sprint Hosting/);
    expect(text(handoff)).toMatch(/^New handoff Draft, not created yet/);
    expect(text(handoff)).toContain("Andres Lopez Anyone · any agent session can claim it".replace("Andres", "AL Andres"));
    expect(text(handoff)).toContain("Fix the Netlify connect test on main");
    expect(text(handoff)).toMatch(/Done .*Traced the failure.* Next .*Update the test to assert on the new marks/);
    expect(handoff).toContain("test/netlify-connect.test.ts");
    expect(text(doc)).toMatch(/^Doc edit Draft, not created yet/);
    expect(text(doc)).toContain("Hosting connections v4 → v5 Goes to Review before it is live");
    expect(text(doc)).toContain("## Tokens − Trov refreshes hosting tokens automatically before they expire. + Token refresh is manual for now.");
    for (const [card, id] of [[ticket, 31], [handoff, 32], [doc, 33]] as const) {
      expect(card).toContain(`data-act="askAcConfirm" data-arg="${id}"`);
      expect(card).toContain(`data-act="askAcCancel" data-arg="${id}"`);
      expect(card).toContain(`data-act="askAcEdit" data-arg="${id}" aria-expanded="false"`);
      expect(card).not.toContain("askAcUndo");
    }
  });

  it("states are marks, never pills: a shape and a sentence-case word, its meaning on data-mtip", () => {
    expect(ticket).toMatch(/class="ask-act-st" data-mtip="Nothing happens until you confirm it."><svg/);
    expect(ticket).not.toMatch(/DRAFT|pill/);
  });

  it("Edit opens ONLY the fields the tool's input takes, as real inputs and segmented switches", () => {
    const s2 = app("actions-ask");
    s2.ask.actions.editing = { 31: true, 32: true, 33: true };
    const [t, h, d] = cards(s2);
    expect(t).toContain('aria-expanded="true"');
    expect(t).toContain("Done editing");
    expect(t).toMatch(/<input class="ask-input-line" data-act="askAcField" data-arg="31\|title"[^>]*value="Reconnect expired hosting tokens from Org settings"/);
    expect(t).toContain('aria-label="Category"');
    expect(t).toContain('data-arg="31|category|request"');
    expect(t).toContain('aria-label="Priority"');
    expect(t).toContain('data-arg="31|priority|low"');
    expect(t).toContain('aria-label="Assignee"');
    expect(t).toContain('data-arg="31|assignee|maya"');
    expect(t).not.toContain("<select");
    expect(h).toContain('aria-label="Send to"');
    expect(h).toContain('data-arg="32|recipient|anyone"');
    expect(h).toMatch(/data-arg="32\|task"[^>]*value="Fix the Netlify connect test on main"/);
    expect(d).toMatch(/<textarea[^>]*data-act="askAcHunk" data-arg="33\|0"[^>]*>Token refresh is manual for now\./);
    // The form is a new key where the text was (it fades in once); the card keeps its key (its height glides).
    expect(t).toContain('data-morph-key="edit"');
    expect(ticket).toContain('data-morph-key="view"');
    expect(t.match(/data-morph-key="act:31" data-ask-tween/)).not.toBeNull();
  });

  it("Confirm sends ONLY the edited editable fields; the server's result collapses the card to its done line", async () => {
    const s2 = app("actions-ask");
    const confirmAction = vi.fn(async (id: number) => ({ results: [result(id, "confirmed", "ticket:30", { id: 30, title: "Reconnect expired tokens" })] } satisfies AskActionAnswer));
    const { ctx, flashes } = ctxOf(s2, { confirmAction });
    actionsPart.act!(ctx, "askAcEdit", "31", null);
    actionsPart.act!(ctx, "askAcField", "31|title", "Reconnect expired tokens");
    actionsPart.act!(ctx, "askAcField", "31|priority|normal", null);
    actionsPart.act!(ctx, "askAcField", "31|category|bug", null);    // unchanged: not sent
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    await flush();
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(confirmAction).toHaveBeenCalledWith(31, { args: { title: "Reconnect expired tokens", priority: "normal" } });
    const [t] = cards(s2);
    expect(t).not.toContain("askAcConfirm");
    expect(text(t)).toMatch(/^Created ticket #30 Just now Undo$/);
    expect(t).toContain('data-act="askShOpen" data-arg="ticket:30"');
    expect(t).toContain('data-morph-key="ln:31:done"');
    expect(flashes).toEqual(["Created ticket #30"]);
    expect(s2.ask.actions.editing[31]).toBeUndefined();
    expect(s2.ask.actions.drafts[31]).toBeUndefined();
  });

  it("a doc edit's edited hunk goes as { hunks: [{ index, after }] }; an unedited card sends no args", async () => {
    const s2 = app("actions-ask");
    const confirmAction = vi.fn(async (id: number) => ({ results: [result(id, "confirmed", id === 33 ? "doc:hosting-connections" : "handoff:12", id === 32 ? { id: 12, recipient: "anyone" } : null, false)] }));
    const { ctx, flashes } = ctxOf(s2, { confirmAction });
    actionsPart.act!(ctx, "askAcHunk", "33|0", "Token refresh is manual.");
    actionsPart.act!(ctx, "askAcConfirm", "33", null);
    actionsPart.act!(ctx, "askAcConfirm", "32", null);
    await flush();
    expect(confirmAction).toHaveBeenCalledWith(33, { args: { hunks: [{ index: 0, after: "Token refresh is manual." }] } });
    expect(confirmAction).toHaveBeenCalledWith(32);
    const [, h, d] = cards(s2);
    expect(text(h)).toMatch(/^Sent handoff #12 to anyone/);
    expect(text(d)).toMatch(/^Proposed an edit to Hosting connections\. It waits in Review\./);
    expect(d).not.toContain("askAcUndo");             // a doc proposal has no withdraw path: no Undo
    expect(flashes).toContain("Sent handoff #12 to anyone");
  });

  it("Cancel → \"Cancelled: new ticket\"; Undo → \"Undone: created ticket #30\"", async () => {
    const s2 = app("actions-ask");
    const api = {
      cancelAction: vi.fn(async (id: number) => ({ results: [result(id, "cancelled", null)] })),
      confirmAction: vi.fn(async (id: number) => ({ results: [result(id, "confirmed", "ticket:30", { id: 30 })] })),
      undoAction: vi.fn(async (id: number) => ({ results: [result(id, "undone", null, null, false)] })),
    };
    const { ctx, flashes } = ctxOf(s2, api);
    actionsPart.act!(ctx, "askAcCancel", "32", null);
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    await flush();
    actionsPart.act!(ctx, "askAcUndo", "31", null);
    await flush();
    const [t, h] = cards(s2);
    expect(text(h)).toBe("Cancelled: new handoff");
    expect(text(t)).toBe("Undone: created ticket #30");
    expect(t).toContain("is-off");
    expect(flashes).toContain("Undone");
  });

  it("a second Confirm while one is in flight sends nothing (busy)", async () => {
    const s2 = app("actions-ask");
    let release: (v: AskActionAnswer) => void = () => undefined;
    const confirmAction = vi.fn(() => new Promise<AskActionAnswer>((r) => { release = r; }));
    const { ctx } = ctxOf(s2, { confirmAction });
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    expect(cards(s2)[0]).toMatch(/aria-busy="true"/);
    expect(cards(s2)[0]).toContain("Working…");
    release({ results: [result(31, "confirmed", "ticket:30", { id: 30 })] });
    await flush();
    expect(confirmAction).toHaveBeenCalledTimes(1);
  });
});

// ── actions-auto ────────────────────────────────────────────────────────────

describe("actions-auto — done lines with Undo and a time, one grouped line, one waiting Publish card", () => {
  const s = app("actions-auto");
  const all = cards(s);

  it("draws the design's lines from the stream's results (no card came before them)", () => {
    expect(all.map((h) => text(h))).toEqual([
      "Sent handoff #11 to anyone Just now Undo",
      "Moved ticket #14 to In progress Just now Undo",
      "Filed tickets #30, #31 and #32 Just now Undo",
      expect.stringMatching(/^Publish doc Waiting for you Release 0\.30 notes Product · v2 Staged, not approved Publishing makes v2 live for the org\. Agents read it from then on\./),
    ]);
  });

  it("the group is ONE line with ONE Undo for the three tickets", () => {
    expect(all[2].match(/askAcUndo/g)).toHaveLength(1);
    expect(all[2]).toContain('data-act="askAcUndo" data-arg="43,44,45"');
    expect(all[2]).toContain('data-arg="ticket:30"');
  });

  it("one Undo reverses the whole group (the server answers for every card of it)", async () => {
    const s2 = app("actions-auto");
    const undoAction = vi.fn(async () => ({ results: [45, 44, 43].map((id) => result(id, "undone", null, null, false, "1-6-3")) }));
    const { ctx } = ctxOf(s2, { undoAction });
    const refreshTickets = vi.fn();
    ctx.refreshTickets = refreshTickets;
    actionsPart.act!(ctx, "askAcUndo", "43,44,45", null);
    await flush();
    expect(undoAction).toHaveBeenCalledTimes(1);
    expect(text(cards(s2)[2])).toBe("Undone: filed tickets #30, #31 and #32");
    // The declined tickets leave the queue's default views: an open Tickets board refetches (once).
    expect(refreshTickets).toHaveBeenCalledTimes(1);
  });

  it("undoing a handoff leaves the Tickets queue alone", async () => {
    const s2 = app("actions-auto");
    const { ctx } = ctxOf(s2, { undoAction: vi.fn(async () => ({ results: [result(41, "undone", null, null, false, "1-6-1")] })) });
    const refreshTickets = vi.fn();
    ctx.refreshTickets = refreshTickets;
    actionsPart.act!(ctx, "askAcUndo", "41", null);
    await flush();
    expect(text(cards(s2)[0])).toBe("Undone: sent handoff #11 to anyone");
    expect(refreshTickets).not.toHaveBeenCalled();
  });

  it("the waiting Publish card says why it waits — \"Publishing waits for you, even on Auto.\" — and offers Confirm to someone who may promote", () => {
    const pub = all[3];
    expect(pub).toContain("Publishing waits for you, even on Auto.");
    expect(pub).toMatch(/class="ask-act-st" data-mtip="Publishing waits for you, even on Auto\."/);
    expect(pub).toContain('data-act="askAcConfirm" data-arg="46"');
    expect(pub).not.toContain("Open in Review");
    expect(pub).not.toContain("askAcEdit");
  });

  it("GUARD — Publish never runs by itself in Auto: the whole Auto stream, through the part's own event hook, decides nothing", async () => {
    const s2 = app(null);
    s2.ask.page = { ...convoOf("actions-auto"), messages: [convoOf("actions-auto").messages[0], { role: "assistant", key: "a1", turn: newTurn("smart") }] };
    const api = {
      confirmAction: vi.fn(async () => ({ results: [] })), cancelAction: vi.fn(async () => ({ results: [] })), undoAction: vi.fn(async () => ({ results: [] })),
      getThread: vi.fn(async () => ({ thread: {} as never, messages: [] })),
    };
    const { ctx } = ctxOf(s2, api);
    for (const st of askTranscript("actions-auto", NOW)) {
      const e = st.event;
      s2.ask.page = e.event === "thread" ? foldThreadEvent(s2.ask.page, e.data) : withLastTurn(s2.ask.page, (t) => foldAskEvent(t, e, 0));
      actionsPart.onEvent?.(ctx, "page", e);
    }
    await flush();
    expect(answerOf(s2).turn.actions[46]).toMatchObject({ tool: "publish_doc", state: "waiting" });
    expect(api.confirmAction).not.toHaveBeenCalled();
    expect(api.cancelAction).not.toHaveBeenCalled();
    expect(api.undoAction).not.toHaveBeenCalled();
    // No read at all: every Auto result names its own write (tool, kind, preview).
    expect(api.getThread).not.toHaveBeenCalled();
    expect(answerOf(s2).turn.actions[43]).toMatchObject({ tool: "create_ticket", kind: "ticket" });
  });

  it("an Auto result names its write from the stream itself — a create is \"Created\", a move \"Moved\" — with no re-read", () => {
    const s2 = app(null);
    let t = newTurn("smart");
    t = foldAskEvent(t, { event: "action_result", data: { ...result(60, "auto", "ticket:40", { id: 40, title: "T", status: "submitted" }, true), tool: "create_ticket", kind: "ticket", preview: { title: "T", lines: [], item: null } } }, 0);
    t = foldAskEvent(t, { event: "action_result", data: { ...result(61, "auto", "ticket:41", { id: 41, title: "U", status: "in_progress" }, true), tool: "transition_ticket", kind: "move", preview: { title: "Move ticket #41", lines: [], item: null } } }, 0);
    s2.ask.page = { ...s2.ask.page, threadId: 9, messages: [{ role: "assistant", key: "a9", turn: t }] };
    expect(text(cards(s2)[0])).toBe("Created ticket #40 Just now Undo");
    expect(text(cards(s2)[1])).toMatch(/^Moved ticket #41 to In progress/);
  });

  it("GUARD — Publish confirms only for someone who may promote: canPublish false shows \"Open in Review\" and no Confirm", () => {
    const s2 = app("actions-auto");
    const a = answerOf(s2);
    a.turn.actions[46] = { ...a.turn.actions[46], preview: { ...a.turn.actions[46].preview!, canPublish: false } };
    const pub = cards(s2)[3];
    expect(pub).toContain('<a class="ask-btn ask-btn--accent" href="#review">Open in Review</a>');
    expect(pub).not.toContain("askAcConfirm");
    expect(pub).toContain("askAcCancel");
  });

  it("GUARD — Undo refused because the item changed since: \"Changed since. Undo it by hand.\" with a link, no Undo, the line kept", async () => {
    const s2 = app("actions-auto");
    const err = new AskApiError(409, "changed", "Changed since. Undo it by hand.");
    err.ref = "ticket:14";
    err.body = { error: "changed", message: err.message, ref: "ticket:14", results: [] };
    const undoAction = vi.fn(async () => { throw err; });
    const { ctx, flashes } = ctxOf(s2, { undoAction });
    actionsPart.act!(ctx, "askAcUndo", "42", null);
    await flush();
    const line = cards(s2)[1];
    expect(text(line)).toBe("Moved ticket #14 to In progress Changed since. Undo it by hand. Open ticket #14");
    expect(line).toContain('data-act="askShOpen" data-arg="ticket:14">Open ticket #14');
    expect(line).not.toContain("askAcUndo");
    expect(answerOf(s2).turn.actions[42].state).toBe("auto");
    expect(flashes).toEqual([]);
  });

  it("a partial group Undo applies what the server did undo before it refused", async () => {
    const s2 = app("actions-auto");
    const err = new AskApiError(409, "changed", "Changed since. Undo it by hand.");
    err.ref = "ticket:31";
    err.body = { error: "changed", results: [result(45, "undone", null, null, false, "1-6-3")] };
    const { ctx } = ctxOf(s2, { undoAction: vi.fn(async () => { throw err; }) });
    actionsPart.act!(ctx, "askAcUndo", "43,44,45", null);
    await flush();
    const t = answerOf(s2).turn;
    expect(t.actions[45].state).toBe("undone");
    expect(t.actions[44].state).toBe("auto");
    const [done, undone] = cards(s2)[2].split('<div class="ask-line is-off"');
    expect(text(done)).toContain("Filed tickets #30 and #31 Changed since. Undo it by hand. Open ticket #31");
    expect(text(undone)).toContain("Undone: created ticket #32");
  });
});

describe("GUARD — a replaced answer's actions expire", () => {
  it("Confirm on a card whose turn was replaced: the server's 409 expired collapses it to its line, with nothing left to press", async () => {
    const s = app("actions-ask");
    const err = new AskApiError(409, "expired", "This card expired with its turn. Ask again.");
    const confirmAction = vi.fn(async () => { throw err; });
    const { ctx, flashes } = ctxOf(s, { confirmAction });
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    await flush();
    const t = cards(s)[0];
    expect(text(t)).toBe("Expired: new ticket This card expired with its turn. Ask again.");
    expect(t).not.toContain("askAcConfirm");
    expect(flashes).toEqual(["This card expired with its turn. Ask again."]);
  });
  it("a stored card the server already expired is drawn as its line", () => {
    const s = app("actions-ask");
    answerOf(s).turn.actions[32] = { ...answerOf(s).turn.actions[32], state: "expired" };
    expect(text(cards(s)[1])).toBe("Expired: new handoff This card expired with its turn. Ask again.");
  });
});

// ── the earlier exchange (the replay sets it up as the design shows it) ──────

describe("the replay's earlier exchange", () => {
  it("actions-ask: a confirmed line and a cancelled one; actions-auto: an undone one", () => {
    const view = (msgs: ReturnType<typeof replayPriorExchange>) => {
      const s = app(null);
      s.ask.page = { ...s.ask.page, messages: msgs };
      return cards(s).map(text);
    };
    expect(view(replayPriorExchange(false, NOW.toISOString()))).toEqual(["Created ticket #29 Just now", "Cancelled: move ticket #14 to Testing"]);
    expect(view(replayPriorExchange(true, NOW.toISOString()))).toEqual(["Undone: moved ticket #14 to Done"]);
  });
  it("replayPlan seeds it before the transcript plays", () => {
    const s = app(null);
    const { ctx } = ctxOf(s, {});
    replayPlan("actions-ask").setup!(ctx);
    expect(s.ask.page.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(replayPlan("actions-auto").play).toEqual(["actions-auto"]);
  });
});

// ── words ───────────────────────────────────────────────────────────────────

describe("the lines' words", () => {
  const vm = (o: Partial<AskActionVm>): AskActionVm => ({ id: 1, groupId: null, tool: null, kind: null, state: "auto", preview: null, fields: {}, editable: [], note: null, result: null, ref: null, undo: false, at: null, ...o });
  it("lists numbers as the design writes them", () => {
    expect(listNumbers(["30"])).toBe("#30");
    expect(listNumbers(["30", "31"])).toBe("#30 and #31");
    expect(listNumbers(["30", "31", "32"])).toBe("#30, #31 and #32");
  });
  it("names a write from its tool, or (an Auto result has none) from its result", () => {
    expect(toolOf(vm({ ref: "handoff:11", result: { recipient: "anyone" } }))).toBe("send_handoff");
    expect(toolOf(vm({ ref: "artifact:x" }))).toBe("save_artifact");
    expect(doneText([vm({ tool: "transition_ticket", ref: "ticket:14", result: { status: "testing" } })])).toBe("Moved ticket #14 to Testing");
    expect(doneText([vm({ tool: "send_handoff", ref: "handoff:3", result: { recipient: "maya" } })])).toBe("Sent handoff #3 to @maya");
    expect(doneText([vm({ tool: "publish_doc", preview: { title: "Publish x", lines: [], item: null }, fields: { slug: "release-notes" } })])).toBe("Published release-notes to the org");
    expect(proposedText([vm({ kind: "move", preview: { title: "Move #14 to Testing", lines: [], item: null } })])).toBe("Move ticket #14 to Testing");
  });
  // e2e AU-9: decided cards whose item number is unknown (no `ref`, a result without the item) drew "Moved ticket
  // #null to Testing" / "Commented on ticket #null". Unknown is never printed (CLAUDE.md invariant 7): "the ticket".
  it("never writes #null: a write whose number is unknown names the item without one", () => {
    for (const tool of ["transition_ticket", "add_ticket_comment", "edit_ticket", "add_ticket_link", "set_ticket_sprint", "set_ticket_parent", "assign_ticket", "send_handoff", "claim_handoff", "expire_handoff"]) {
      const line = doneText([vm({ tool, ref: null, result: { ok: true }, fields: { to: "testing" } })]);
      expect(line, tool).not.toMatch(/null|undefined|#\s/);
    }
    expect(doneText([vm({ tool: "transition_ticket", ref: null, result: { ok: true }, fields: { to: "testing" } })])).toBe("Moved the ticket to Testing");
    expect(doneText([vm({ tool: "add_ticket_comment", ref: null, result: { ok: true } })])).toBe("Commented on the ticket");
  });
  it("editedArgs: only editable fields that changed (trimmed); hunks by index", () => {
    const card = vm({ editable: ["title", "priority"], fields: { title: "A", priority: "high", body: "b" }, preview: { title: "", lines: [], item: null } });
    expect(editedArgs(card, { title: " A ", priority: "high", body: "sneaky" })).toBeNull();
    expect(editedArgs(card, { title: "B" })).toEqual({ title: "B" });
    const doc = vm({ editable: ["hunks"], preview: { title: "", lines: [], item: null, hunks: [{ index: 2, heading: null, before: "x", after: "y" }] } });
    expect(editedArgs(doc, { hunks: { 2: "y" } })).toBeNull();
    expect(editedArgs(doc, { hunks: { 2: "z", 9: "nope" } })).toEqual({ hunks: [{ index: 2, after: "z" }] });
  });
});

// ── Save as artifact ────────────────────────────────────────────────────────

describe("artifact / artifact-saved — the Save form, then its saved line", () => {
  const formOf = (s: AppState) => {
    const a = answerOf(s);
    const p = shownParts(a.turn).find((x) => x.kind === "block" && x.block.kind === "save_form");
    if (!p || p.kind !== "block" || p.block.kind !== "save_form") throw new Error("no form");
    return { a, block: p.block, index: p.index, html: saveFormView(askView(s), a, p.block, p.index) };
  };

  it("artifact: the form — Title, Kind and Who can see it as segmented switches, the hint, Save", () => {
    const { html } = formOf(app("artifact"));
    expect(text(html)).toMatch(/^Save as artifact Title Kind Markdown HTML page Who can see it Private Org Only you can see it\. You can publish it to the org later\. Save$/);
    expect(html).toMatch(/data-act="askAcSaveTitle" data-arg="a1\|0"[^>]*value="Hosting status, Oct 15"/);
    expect(html).toMatch(/class="cnpy-seg-btn is-on"[^>]*data-arg="a1\|0\|html"|class="cnpy-seg-btn is-on" data-act="askAcSaveKind" data-arg="a1\|0\|html"/);
    expect(html).toContain('aria-label="Who can see it"');
    expect(html).toContain('data-act="askAcSave" data-arg="a1|0"');
    expect(html).toContain('data-ask-tween');
  });

  it("Org says who can open it; Save sends the picks and the form becomes \"Saved as artifact: <title> · Org\" with Open", async () => {
    const s = app("artifact");
    s.ask.page = { ...s.ask.page, threadId: 1 };
    const saveThread = vi.fn(async (_t: number, body: { title?: string; visibility?: "private" | "org" }) => ({ slug: "hosting-oct", title: body.title!, visibility: body.visibility!, url: "#artifacts/hosting-oct" }));
    const { ctx, flashes } = ctxOf(s, { saveThread });
    actionsPart.act!(ctx, "askAcSaveVis", "a1|0|org", null);
    expect(text(formOf(s).html)).toContain("Everyone in SaplingLearn can open it from Artifacts.");
    actionsPart.act!(ctx, "askAcSaveTitle", "a1|0", "Hosting, Oct 15");
    actionsPart.act!(ctx, "askAcSave", "a1|0", null);
    await flush();
    expect(saveThread).toHaveBeenCalledWith(1, { messageId: 8, title: "Hosting, Oct 15", kind: "html", visibility: "org" });
    const { html } = formOf(s);
    expect(text(html)).toBe("Saved as artifact: Hosting, Oct 15 · Org Open");
    expect(html).toContain('data-act="askShOpen" data-arg="artifact:hosting-oct"');
    expect(flashes).toEqual(["Saved to Artifacts"]);
  });

  it("an empty title cannot be saved", () => {
    const s = app("artifact");
    const { ctx } = ctxOf(s, {});
    actionsPart.act!(ctx, "askAcSaveTitle", "a1|0", "  ");
    expect(formOf(s).html).toMatch(/data-act="askAcSave" data-arg="a1\|0" disabled/);
  });

  it("artifact-saved: the stream's artifact_saved turns the form into the saved line", () => {
    const { html } = formOf(app("artifact-saved"));
    expect(text(html)).toBe("Saved as artifact: Hosting status, Oct 15 · Private Open");
    expect(html).toContain('data-arg="artifact:hosting-status-oct-15"');
  });

  it("the footer's / a block's Save as artifact adds the server's form under that answer (no model call)", async () => {
    const s = app("actions-ask");
    const a = answerOf(s);
    expect(saveButton(a)).toContain('data-act="askAcSaveForm" data-arg="a1"');
    expect(saveButton(a, 2)).toContain('data-arg="a1|2"');
    const saveForm = vi.fn(async (messageId: number, block?: number) => ({ block: { kind: "save_form" as const, form: { messageId, block: block ?? null, title: "Hosting status, Oct 15", kind: "markdown" as const, visibility: "private" as const, saved: null } }, index: 0 }));
    const { ctx } = ctxOf(s, { saveForm });
    actionsPart.act!(ctx, "askAcSaveForm", "a1", null);
    await flush();
    expect(saveForm).toHaveBeenCalledWith(4, undefined);
    expect(text(formOf(s).html)).toMatch(/^Save as artifact Title Kind Markdown HTML page/);
    // Asking again while that form is open does not stack a second one.
    actionsPart.act!(ctx, "askAcSaveForm", "4", null);
    await flush();
    expect(saveForm).toHaveBeenCalledTimes(1);
  });

  it("Auto: save_artifact saves as private at once — its result draws the saved line, with Open and Undo", () => {
    const s = app(null);
    let t = newTurn("smart");
    t = foldAskEvent(t, { event: "action_result", data: result(50, "auto", "artifact:hosting-oct", { slug: "hosting-oct", title: "Hosting, Oct 15", visibility: "private", url: "#artifacts/hosting-oct" }, true, "1-7-save") }, 0);
    s.ask.page = { ...s.ask.page, messages: [{ role: "assistant", key: "a9", turn: t }] };
    const [line] = cards(s);
    expect(text(line)).toBe("Saved as artifact: Hosting, Oct 15 · Private Just now Open Undo");
    expect(line).toContain('data-arg="artifact:hosting-oct"');
  });
});

// ── Wrong? ──────────────────────────────────────────────────────────────────

describe("Wrong? — three reasons, posted with the answer; the toast says the team can see it in Review", () => {
  it("opens the row, posts the picked reason for that message, closes it and says so", async () => {
    const s = app("actions-ask");
    const a = answerOf(s);
    const markWrong = vi.fn(async () => undefined);
    const { ctx, flashes } = ctxOf(s, { markWrong });
    expect(wrongButton(askView(s), a)).toContain('data-act="askAcWrong" data-arg="a1" aria-expanded="false"');
    expect(feedbackView(askView(s), a)).toBe("");
    actionsPart.act!(ctx, "askAcWrong", "a1", null);
    expect(wrongButton(askView(s), a)).toContain('aria-expanded="true"');
    const row = feedbackView(askView(s), a);
    expect(text(row)).toBe("What was wrong? A source is wrong It is out of date It missed something");
    expect(row).toContain('role="group" aria-label="What was wrong?"');
    expect(row).toContain('data-act="askAcWrongReason" data-arg="a1|out_of_date"');
    actionsPart.act!(ctx, "askAcWrongReason", "a1|out_of_date", null);
    await flush();
    expect(markWrong).toHaveBeenCalledWith(4, "out_of_date");
    expect(flashes).toEqual(["Thanks. The team can see this in Review."]);
    expect(feedbackView(askView(s), a)).toBe("");
  });

  it("the row pops out through state (data-closing) and Escape closes it as a menu", () => {
    const s = app("actions-ask");
    const a = answerOf(s);
    s.ask.actions.wrongOpen = { a1: true };
    s.ask.closing = { "wrong:a1": true };
    expect(feedbackView(askView(s), a)).toContain('data-closing="1"');
    s.ask.closing = {};
    const { ctx } = ctxOf(s, {});
    const esc = actionsPart.escape![0];
    expect(esc.layer).toBe("menu");
    expect(esc.isOpen(ctx)).toBe(true);
    esc.close(ctx);
    expect(esc.isOpen(ctx)).toBe(false);
  });

  it("an answer still streaming (no message id) offers neither Wrong? nor Save", () => {
    const a: AskAnswer = { role: "assistant", key: "a2", turn: newTurn("smart") };
    expect(wrongButton(askView(app(null)), a)).toBe("");
    expect(saveButton(a)).toBe("");
  });
});

// ── motion ──────────────────────────────────────────────────────────────────

describe("motion — collapses glide, entrances play once, all off under reduced motion", () => {
  it("every card, line and form sits in a data-ask-tween wrapper; a card and its line are different keys", () => {
    const s = app("actions-auto");
    for (const h of cards(s)) expect(h.startsWith('<div class="ask-acts" data-ask-tween data-morph-list>')).toBe(true);
    expect(cards(s)[3]).toContain('data-morph-key="act:46"');
    expect(cards(s)[0]).toContain('data-morph-key="ln:41:done"');
  });
  it("a rerender with nothing new renders the same markup (morph patches it: nothing replays)", () => {
    const s = app("actions-ask");
    expect(cards(s)).toEqual(cards(s));
  });
  const ask = css.slice(css.indexOf("/* ══ Ask Trov"), css.indexOf("/* ── the site on a phone")).replace(/\/\*[\s\S]*?\*\//g, "");
  const reduce = ask.slice(ask.indexOf("@media (prefers-reduced-motion: reduce)"));
  const block = reduce.slice(0, reduce.indexOf("\n}\n"));
  it.each([".ask-act-form", ".ask-diff textarea", ".ask-line", ".ask-wrong", ".ask-wrong[data-closing]"])("%s's animation is off under reduced motion", (sel) => {
    expect(block).toContain(sel);
  });
});
