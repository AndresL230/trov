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
  actionGroupView, actionsPart, actionDropdowns, saveFormView, feedbackView, wrongButton, saveButton, editedArgs, doneText, proposedText, listNumbers, toolOf,
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
    expect(text(ticket)).toMatch(/Category bug Priority High Assignee AL Andres Lopez Sprint Hosting Cancel Confirm$/);
    expect(text(handoff)).toMatch(/^New handoff Draft, not created yet Fix the Netlify connect test on main/);
    expect(text(handoff)).toMatch(/AL Andres Lopez to Anyone Any agent session can claim it Cancel Confirm$/);
    expect(text(handoff)).toMatch(/Done .*Traced the failure.* Next .*Update the test to assert on the new marks/);
    expect(handoff).toContain("test/netlify-connect.test.ts");
    expect(text(doc)).toMatch(/^Doc edit Draft, not created yet Hosting connections v4 → v5 Goes to Review before it is live ## Tokens/);
    expect(text(doc)).toContain("## Tokens − Trov refreshes hosting tokens automatically before they expire. + Token refresh is manual for now.");
    expect(text(doc)).toMatch(/Org settings › Integrations\. Cancel Confirm$/);
    for (const [card, id] of [[ticket, 31], [handoff, 32], [doc, 33]] as const) {
      expect(card).toContain(`data-act="askAcConfirm" data-arg="${id}"`);
      expect(card).toContain(`data-act="askAcCancel" data-arg="${id}"`);
      expect(card).not.toContain("askAcUndo");
      // No Edit mode, no footer band, no controls in a row of the card: the frame holds the content alone, and the
      // pair floats after it — outside the frame, inside the wrapper the decision swaps (so it leaves in the one glide).
      expect(card).not.toContain("askAcEdit");
      expect(card).not.toContain("ask-act-foot");
      expect(card).not.toMatch(/ask-act-(end|ghost|break)/);
      expect(card).toMatch(new RegExp(`^<div class="ask-acts" data-ask-tween data-morph-list><div class="ask-act-w" data-morph-key="act:${id}" data-ask-tween>\\s*<div class="ask-act">`));
      const frame = card.slice(card.indexOf('<div class="ask-act">'), card.indexOf('<div class="ask-act-btns"'));
      expect(frame).not.toContain("askAcConfirm");
      expect(frame).not.toContain("askAcCancel");
      expect(card).toMatch(/<\/div>\s*<div class="ask-act-btns" role="group" aria-label="[^"]+: confirm or cancel">\s*<button type="button" class="ask-btn" data-act="askAcCancel"[^>]*>Cancel<\/button>\s*<button type="button" class="ask-btn ask-btn--accent ask-act-confirm" data-act="askAcConfirm"[^>]*>.*Confirm<\/button>\s*<\/div>\s*<\/div><\/div>$/s);
    }
  });

  it("states are marks, never pills: a shape and a sentence-case word, its meaning on data-mtip", () => {
    expect(ticket).toMatch(/class="ask-act-st" data-mtip="Nothing happens until you confirm it."><svg/);
    expect(ticket).not.toMatch(/DRAFT|pill/);
  });

  it("every editable field edits in place — text, a cycle, a dropdown — and nothing else does", () => {
    // Text reads as text (a button) until clicked; the small fixed sets cycle; people are the app's dropdown.
    expect(ticket).toMatch(/<button type="button" class="ask-act-txt ask-act-title" data-act="askAcText" data-arg="31\|title" data-field="askAcT31-title"[^>]*>Reconnect expired hosting tokens from Org settings<\/button>/);
    expect(ticket).toMatch(/class="ask-act-cyc[^"]*" data-act="askAcField" data-arg="31\|category\|request" aria-label="Category: bug\. Change to request"/);
    expect(ticket).toMatch(/class="ask-act-cyc[^"]*" data-act="askAcField" data-arg="31\|priority\|normal" aria-label="Priority: High\. Change to Normal"/);
    expect(ticket).toMatch(/<span class="ask-act-pick" data-morph-key="asg"><button type="button" id="ask-ac-asg-31"[^>]*class="cnpy-dd is-sm"[^>]*aria-label="Assignee: Andres Lopez"/);
    expect(ticket).not.toContain("<select");
    expect(ticket).not.toContain("cnpy-seg");
    expect(handoff).toMatch(/data-act="askAcText" data-arg="32\|task"[^>]*>Fix the Netlify connect test on main</);
    expect(handoff).toMatch(/id="ask-ac-to-32"[^>]*aria-label="Send to: Anyone"/);
    expect(doc).toMatch(/data-act="askAcText" data-arg="33\|hunk:0"[^>]*>Token refresh is manual for now\./);
    // The menus are root overlays: their props come from the same cards.
    const ids = actionDropdowns(s).map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["ask-ac-asg-31", "ask-ac-to-32"]));
    const to = actionDropdowns(s).find((p) => p.id === "ask-ac-to-32")!;
    expect(to.options.map((o) => o.label)).toEqual(["Anyone", "Maya Chen", "Priya Raman"]);        // not the sender
    const asg = actionDropdowns(s).find((p) => p.id === "ask-ac-asg-31")!;
    expect(asg.options[0]).toMatchObject({ value: "~none", label: "Unassigned" });
  });

  it("a click on text opens it as an input that looks the same; Enter keeps the edit, Escape puts it back", () => {
    const s2 = app("actions-ask");
    const { ctx } = ctxOf(s2, {});
    actionsPart.act!(ctx, "askAcText", "31|title", null);
    expect(s2.ask.actions.focusInline).toBe("askAcT31-title");
    let [t] = cards(s2);
    expect(t).toMatch(/<input class="ask-act-input ask-act-title" data-act="askAcField" data-arg="31\|title" data-field="askAcT31-title" data-ask-inline="31" value="Reconnect expired hosting tokens from Org settings"/);
    // The card keeps its key and its body; only the words change (no form opens).
    expect(t.match(/data-morph-key="act:31" data-ask-tween/)).not.toBeNull();
    actionsPart.act!(ctx, "askAcField", "31|title", "Reconnect expired tokens");
    // Escape: the layer above everything else, and it puts back what the text held.
    const layer = actionsPart.escape![0];
    expect(layer.isOpen(ctx)).toBe(true);
    layer.close(ctx);
    expect(s2.ask.actions.inline[31]).toBeUndefined();
    expect(s2.ask.actions.drafts[31]).toEqual({});
    [t] = cards(s2);
    expect(t).toMatch(/class="ask-act-txt ask-act-title"[^>]*>Reconnect expired hosting tokens from Org settings</);
    // Enter keeps it (a key on the input; the shell routes the card's keydown here).
    actionsPart.act!(ctx, "askAcText", "31|title", null);
    actionsPart.act!(ctx, "askAcField", "31|title", "Reconnect expired tokens");
    const input = { tagName: "INPUT", getAttribute: (n: string) => (n === "data-ask-inline" ? "31" : null) } as unknown as HTMLElement;
    const enter = { key: "Enter", isComposing: false, metaKey: false, ctrlKey: false, target: input, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    expect(actionsPart.onKeyDown!(ctx, enter)).toBe(true);
    expect(s2.ask.actions.inline[31]).toBeUndefined();
    expect(s2.ask.actions.drafts[31]).toEqual({ title: "Reconnect expired tokens" });
    [t] = cards(s2);
    expect(t).toMatch(/class="ask-act-txt ask-act-title"[^>]*>Reconnect expired tokens</);
    // A title left empty goes back.
    actionsPart.act!(ctx, "askAcText", "31|title", null);
    actionsPart.act!(ctx, "askAcField", "31|title", "   ");
    expect(actionsPart.onChange!(ctx, { type: "focusout", target: input } as unknown as Event)).toBe(true);
    expect(s2.ask.actions.drafts[31]).toEqual({ title: "Reconnect expired tokens" });
  });

  it("a cycle steps to the next value; a dropdown pick sets the person (Unassigned is null)", () => {
    const s2 = app("actions-ask");
    const { ctx } = ctxOf(s2, {});
    actionsPart.act!(ctx, "askAcField", "31|priority|normal", null);
    let [t] = cards(s2);
    expect(t).toMatch(/aria-label="Priority: Normal\. Change to Low"/);
    actionsPart.act!(ctx, "askAcField", "31|priority|low", null);
    [t] = cards(s2);
    expect(t).toMatch(/data-arg="31\|priority\|high" aria-label="Priority: Low\. Change to High"/);
    actionsPart.act!(ctx, "askAcPick", "31|assignee", "maya");
    [t] = cards(s2);
    expect(t).toMatch(/aria-label="Assignee: Maya Chen"/);
    actionsPart.act!(ctx, "askAcPick", "31|assignee", "~none");
    expect(s2.ask.actions.drafts[31].assignee).toBeNull();
    expect(text(cards(s2)[0])).toMatch(/Assignee Unassigned/);
  });

  it("Confirm sends ONLY the edited editable fields; the server's result collapses the card to its done line", async () => {
    const s2 = app("actions-ask");
    const confirmAction = vi.fn(async (id: number) => ({ results: [result(id, "confirmed", "ticket:30", { id: 30, title: "Reconnect expired tokens" })] } satisfies AskActionAnswer));
    const { ctx, flashes } = ctxOf(s2, { confirmAction });
    actionsPart.act!(ctx, "askAcText", "31|title", null);
    actionsPart.act!(ctx, "askAcField", "31|title", "Reconnect expired tokens");
    actionsPart.act!(ctx, "askAcField", "31|priority|normal", null);
    actionsPart.act!(ctx, "askAcField", "31|category|bug", null);    // unchanged: not sent
    actionsPart.act!(ctx, "askAcPick", "31|assignee", "maya");
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    await flush();
    expect(confirmAction).toHaveBeenCalledTimes(1);
    expect(confirmAction).toHaveBeenCalledWith(31, { args: { title: "Reconnect expired tokens", priority: "normal", assignee: "maya" } });
    const [t] = cards(s2);
    expect(t).not.toContain("askAcConfirm");
    expect(text(t)).toMatch(/^Created ticket #30 Just now Undo$/);
    expect(t).toContain('data-act="askShOpen" data-arg="ticket:30"');
    expect(t).toContain('data-morph-key="ln:31:done"');
    expect(flashes).toEqual(["Created ticket #30"]);
    expect(s2.ask.actions.inline[31]).toBeUndefined();
    expect(s2.ask.actions.drafts[31]).toBeUndefined();
  });

  it("a doc edit's edited hunk goes as { hunks: [{ index, after }] }; an unedited card sends no args", async () => {
    const s2 = app("actions-ask");
    const confirmAction = vi.fn(async (id: number) => ({ results: [result(id, "confirmed", id === 33 ? "doc:hosting-connections" : "handoff:12", id === 32 ? { id: 12, recipient: "anyone" } : null, false)] }));
    const { ctx, flashes } = ctxOf(s2, { confirmAction });
    actionsPart.act!(ctx, "askAcText", "33|hunk:0", null);
    expect(cards(s2)[2]).toMatch(/<textarea class="ask-act-input ask-diff-t" rows="2" data-act="askAcField" data-arg="33\|hunk:0"[^>]*>Token refresh is manual for now\./);
    actionsPart.act!(ctx, "askAcField", "33|hunk:0", "Token refresh is manual.");
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
      expect.stringMatching(/^Publish doc Waiting for you Publishing waits for you, even on Auto\. Release 0\.30 notes Product · v2 Staged, not approved .*Publishing makes v2 live for the org\. Agents read it from then on\. Cancel Confirm$/),
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
    const err = new AskApiError(409, "expired", "This card expired with its turn.");
    const confirmAction = vi.fn(async () => { throw err; });
    const { ctx, flashes } = ctxOf(s, { confirmAction });
    actionsPart.act!(ctx, "askAcConfirm", "31", null);
    await flush();
    const t = cards(s)[0];
    expect(text(t)).toBe("Expired: new ticket This card expired with its turn.");
    expect(t).not.toContain("askAcConfirm");
    expect(flashes).toEqual(["This card expired with its turn."]);
  });
  it("a stored card the server already expired is drawn as its line", () => {
    const s = app("actions-ask");
    answerOf(s).turn.actions[32] = { ...answerOf(s).turn.actions[32], state: "expired" };
    expect(text(cards(s)[1])).toBe("Expired: new handoff This card expired with its turn.");
    // F-AA1: no "Ask again" in words while there is no control for it (the owner: no words that do nothing).
    expect(cards(s)[1]).not.toContain("Ask again");
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

  it("artifact: the form — Kind and Who can see it as compact switches at its head's right, the title with Save at its end, the hint", () => {
    const { html } = formOf(app("artifact"));
    expect(text(html)).toMatch(/^Save as artifact Markdown HTML page Private Org Save Only you can see it\. You can publish it to the org later\.$/);
    // The switches sit in the head (no stacked labels: they name themselves in a tooltip); Save shares the title's row.
    expect(html).toMatch(/<div class="ask-save-head">[\s\S]*<span data-mtip="Kind">[\s\S]*<span data-mtip="Who can see it">[\s\S]*<\/div>\s*<\/div>\s*<div class="ask-save-row">\s*<input[^>]*aria-label="Title" \/>\s*<button type="button" class="ask-btn ask-btn--accent" data-act="askAcSave"/);
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
    expect(text(formOf(s).html)).toMatch(/^Save as artifact Markdown HTML page Private Org Save/);
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
    const esc = actionsPart.escape![1];          // [0] is text edited in place (it closes first)
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
  it.each([".ask-line", ".ask-wrong", ".ask-wrong[data-closing]"])("%s's animation is off under reduced motion", (sel) => {
    expect(block).toContain(sel);
  });
  it("editing in place moves nothing: the text, its input, a cycle and a pick carry no animation", () => {
    for (const sel of [".ask-act-txt", ".ask-act-input", ".ask-act-cyc", ".ask-act-pick"]) {
      const rules = ask.match(new RegExp(`[^}]*\\${sel}[^{]*\\{[^}]*\\}`, "g")) ?? [];
      expect(rules.length).toBeGreaterThan(0);
      for (const rule of rules) expect(rule).not.toMatch(/animation:/);
    }
  });
});

describe("the floating pair, and one control height (the owner)", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, "");
  /** The declarations of the rule whose selector list is exactly `sel`. */
  const rule = (sel: string): string => {
    const i = plain.indexOf(`\n${sel} {`);
    expect(i, `no rule for ${sel}`).toBeGreaterThan(-1);
    return plain.slice(plain.indexOf("{", i) + 1, plain.indexOf("}", i));
  };

  it("Cancel / Confirm float outside the frame: right-aligned under it, no band or background of their own", () => {
    const btns = rule(".ask-act-btns");
    expect(btns).toMatch(/justify-content:flex-end/);
    expect(btns).toMatch(/margin-top:\d+px/);
    expect(btns).not.toMatch(/background|border|padding/);
    // The frame keeps no outer margin: the wrapper (card + pair) spaces the unit, so the pair sits closer to its card
    // than to whatever follows.
    expect(rule(".ask-act")).not.toMatch(/margin/);
    const gap = Number(/margin-top:(\d+)px/.exec(btns)![1]);
    const after = Number(/margin:0 0 (\d+)px/.exec(rule(".ask-act-w"))![1]);
    expect(gap).toBeLessThan(after);
  });

  it("a Publish that cannot publish puts Open in Review in the pair; the pair comes right after the content", () => {
    const s2 = app("actions-auto");
    const a = answerOf(s2);
    a.turn.actions[46] = { ...a.turn.actions[46], preview: { ...a.turn.actions[46].preview!, canPublish: false } };
    const pub = cards(s2)[3];
    const pair = pub.slice(pub.indexOf('<div class="ask-act-btns"'));
    expect(pair).toMatch(/data-act="askAcCancel"[\s\S]*<a class="ask-btn ask-btn--accent" href="#review">Open in Review<\/a>/);
    expect(pub.indexOf("ask-act-btns")).toBeGreaterThan(pub.lastIndexOf("ask-act-body"));
  });

  it("one control height for everything that sits together — the app's small control (`.cnpy-dd.is-sm`)", () => {
    const small = /height:(\d+px)/.exec(rule(".cnpy-dd.is-sm"))![1];
    expect(rule(".ask-acts")).toContain(`--ask-ctl:${small}`);
    for (const sel of [
      ".ask-act-btns > .ask-btn",                                // the floating Cancel / Confirm / Open in Review
      ".ask-save-row > .ask-input-line", ".ask-save-row > .ask-btn",   // the Save form's title and Save
      ".ask-save-opts .cnpy-seg",                                // its Kind / Who can see it switches
      ".ask-act-pick .cnpy-dd.is-sm",                            // a card's person dropdown
      ".ask-act-cyc",                                            // a word a click cycles
      ".ask-undo",                                               // Undo / Open on a line
    ]) {
      expect(rule(sel), sel).toMatch(/(^|;)\s*height:var\(--ask-ctl\)/);
    }
    // A field's value sits on that line too, so a dropdown, a cycled word and plain text share a baseline.
    expect(rule(".ask-act-field .ask-act-iv")).toContain("min-height:var(--ask-ctl)");
    // On a phone the look stays; the 44px comes from the hit area.
    for (const m of plain.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const sel of m[1].split(",").map((x) => x.trim())) {
        if (sel.startsWith('[data-phone="1"]') && /\.ask-(act-btns|save-row|undo|act-pick|act-cyc)/.test(sel) && !sel.endsWith("::after")) {
          expect(m[2], sel).not.toMatch(/(^|;)\s*(min-)?height:/);
        }
      }
    }
    expect(plain).toContain('[data-phone="1"] .ask-col .ask-btn::after');
  });
});

// ── assignments ─────────────────────────────────────────────────────────────
// assign_ticket (and a handoff's claim) read as an ASSIGNMENT: the item with its status mark, the people (avatar +
// name through people.ts), from → to for a replacement, "Adds" beside the people who stay; Edit is the app's
// dropdown; the line says what happened in names.

describe("assignment cards — the item, the people, the change", () => {
  const ITEM = (assignees: string[], num = 87) => ({ ref: `ticket:${num}`, type: "ticket" as const, num, title: "Fix the Railway deploy", href: `#tickets/${num}`,
    status: { mark: "half" as const, tone: "accent" as const, word: "In progress", tip: "Someone is on it." }, extra: { assignees } });
  const asg = (id: number, num: number, login: string, on: boolean, before: string[], extra: Partial<AskActionVm> = {}): AskActionVm => ({
    id, groupId: "g1", tool: "assign_ticket", kind: "ticket", state: "proposed", fields: { id: num, login, on }, editable: ["login"], note: null,
    preview: { title: on ? `Assign @${login} to #${num}` : `Remove @${login} from #${num}`, lines: [{ label: "Assignee", value: `${on ? "Add" : "Remove"} @${login}` }], item: ITEM(before, num) },
    result: null, ref: null, undo: false, at: NOW.toISOString(), ...extra,
  });
  function withCards(vms: AskActionVm[]): AppState {
    const s = app(null);
    const turn = { ...newTurn("smart"), messageId: 9, done: true, parts: vms.map((x) => ({ kind: "action" as const, id: x.id })), actions: Object.fromEntries(vms.map((x) => [x.id, x])) };
    s.ask.page = { uid: "c1", threadId: 1, thread: null, draft: "", title: "", status: "ok", busy: false,
      messages: [{ role: "user", key: "q1", id: null, text: "Q", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn }] };
    return s;
  }

  it("an add beside someone: the ticket (number, title, status mark, a click opens it), \"Adds\" the person, who stays", () => {
    const [h] = cards(withCards([asg(70, 87, "maya", true, ["andres"])]));
    expect(text(h)).toMatch(/^Assignment Draft, not done yet #87 Fix the Railway deploy In progress Adds MC Maya Chen Andres Lopez stays on it Cancel Confirm$/);
    expect(h).toContain('data-act="askShOpen" data-arg="ticket:87"');
    expect(h).toContain('data-mtip="Someone is on it."');          // the status is a mark with its meaning, not a pill
    expect(h).not.toMatch(/<select|text-transform:uppercase/);
  });

  it("an add to an unassigned ticket reads Unassigned → the person; a last removal the person → Unassigned (no Edit: nobody else to pick)", () => {
    expect(text(cards(withCards([asg(71, 90, "priya", true, [])]))[0])).toContain("#90 Fix the Railway deploy In progress Unassigned to PR Priya Raman Cancel");
    const [rm] = cards(withCards([asg(72, 7, "maya", false, ["maya"])]));
    expect(text(rm)).toContain("MC Maya Chen to Unassigned");
    expect(rm).not.toContain("askAcEdit");
    expect(text(cards(withCards([asg(73, 7, "maya", false, ["maya", "andres"])]))[0])).toContain("Removes MC Maya Chen Andres Lopez stays on it");
  });

  it("a replacement (a group of two writes on one ticket) is ONE card: from → to, one Confirm", () => {
    const [h] = cards(withCards([asg(74, 6, "maya", false, ["maya"]), asg(75, 6, "priya", true, ["maya"])]));
    expect(text(h)).toMatch(/#6 Fix the Railway deploy In progress MC Maya Chen to PR Priya Raman Cancel Confirm$/);
    expect(h.match(/data-act="askAcConfirm" data-arg="74,75"/g)).toHaveLength(1);
    // A group's ONE pair floats under the whole frame, after its last write.
    expect(h.match(/class="ask-act-btns"/g)).toHaveLength(1);
    expect(h).toMatch(/<\/div>\s*<div class="ask-act-btns"[^>]*>[\s\S]*<\/div>\s*<\/div><\/div>$/);
  });

  it("the person is the app's dropdown in place (avatars, names; never a native select, no Edit); its menu's props are the trigger's (actionDropdowns)", () => {
    const s = withCards([asg(76, 87, "maya", true, ["andres"])]);
    const [h] = cards(s);
    expect(h).not.toContain("askAcEdit");
    expect(h).toContain('id="ask-ac-asg-76"');
    expect(h).toContain('aria-haspopup="listbox"');
    expect(h).toContain('aria-label="Assign to: Maya Chen"');
    expect(h).not.toContain("<select");
    const [dd] = actionDropdowns(s);
    expect(dd).toMatchObject({ id: "ask-ac-asg-76", act: "askAcPick", arg: "76|login", value: "maya" });
    // Everyone who could take it — not Andres, already on it.
    expect(dd.options.map((o) => o.label)).toEqual(["Maya Chen", "Priya Raman"]);
    expect(dd.options[0].icon).toContain("MC");
  });

  it("a pick changes the person; Confirm sends { login } alone and the line names who it went to, with Undo", async () => {
    const s = withCards([asg(77, 87, "maya", true, ["andres"])]);
    const confirmAction = vi.fn(async (id: number) => ({ results: [result(id, "confirmed", "ticket:87", { assignees: ["andres", "priya"] })] } satisfies AskActionAnswer));
    const { ctx, flashes } = ctxOf(s, { confirmAction });
    actionsPart.act!(ctx, "askAcPick", "77|login", "priya");
    expect(text(cards(s)[0])).toContain("Adds PR Priya Raman");
    actionsPart.act!(ctx, "askAcConfirm", "77", null);
    await flush();
    expect(confirmAction).toHaveBeenCalledWith(77, { args: { login: "priya" } });
    expect(text(cards(s)[0])).toBe("Assigned ticket #87 to Priya Raman Just now Undo");
    expect(flashes).toEqual(["Assigned ticket #87 to Priya Raman"]);
  });

  it("the lines' words: assigned, took off, reassigned, several tickets — and cancelled / undone / failed say the same change", () => {
    const look = { persons: PERSONS };
    expect(doneText([asg(1, 87, "maya", true, [])], look)).toBe("Assigned ticket #87 to Maya Chen");
    expect(doneText([asg(1, 87, "maya", false, ["maya"])], look)).toBe("Took Maya Chen off ticket #87");
    expect(doneText([asg(1, 6, "maya", false, ["maya"]), asg(2, 6, "priya", true, ["maya"])], look)).toBe("Reassigned ticket #6 from Maya Chen to Priya Raman");
    expect(doneText([asg(1, 6, "maya", true, []), asg(2, 7, "maya", true, [])], look)).toBe("Assigned tickets #6 and #7 to Maya Chen");
    expect(doneText([asg(1, 87, "maya", true, [])])).toBe("Assigned ticket #87 to @maya");      // no directory: the handle
    expect(proposedText([asg(1, 87, "maya", true, [])], look)).toBe("Assign ticket #87 to Maya Chen");
    const line = (state: AskActionVm["state"]) => text(cards(withCards([asg(78, 87, "maya", true, [], { state, result: state === "failed" ? { error: "Ticket #87 was closed." } : null })]))[0]);
    expect(line("cancelled")).toBe("Cancelled: assign ticket #87 to Maya Chen");
    expect(line("undone")).toBe("Undone: assigned ticket #87 to Maya Chen");
    // One line: what happened, the reason muted on it (all of it in the tooltip), the item to look at.
    expect(line("failed")).toBe("Didn&#39;t work: assign ticket #87 to Maya Chen Ticket #87 was closed. Open ticket #87");
    expect(cards(withCards([asg(78, 87, "maya", true, [], { state: "failed", result: { error: "Ticket #87 was closed." } })]))[0]).toContain('<span class="ask-line-why" data-mtip="Ticket #87 was closed.">');
  });

  it("a card stored before the fields existed still reads from its preview line", () => {
    const old = asg(79, 87, "maya", true, [], { fields: {}, editable: [] });
    expect(doneText([old], { persons: PERSONS })).toBe("Assigned ticket #87 to Maya Chen");
  });

  it("a handoff's claim is drawn as an assignment: the handoff, its sender → you", () => {
    const vm: AskActionVm = { id: 80, groupId: null, tool: "claim_handoff", kind: "handoff", state: "proposed", fields: {}, editable: [], note: null, result: null, ref: null, undo: false, at: NOW.toISOString(),
      preview: { title: "Claim handoff #17", lines: [{ label: "From", value: "@maya" }], item: { ref: "handoff:17", type: "handoff", num: 17, title: "Quiz agent fails validation", href: "#handoffs/17",
        status: { mark: "ring", tone: "blue", word: "Pending", tip: "Waiting for a session to claim it." }, extra: { from: "maya", to: "andres" } } } };
    expect(text(cards(withCards([vm]))[0])).toMatch(/^Claim handoff Draft, not done yet #17 Quiz agent fails validation Pending MC Maya Chen to AL Andres Lopez No one else can claim it after Cancel Confirm$/);
  });

  // E2E A-14 (docs/testing/agent-links-test-log.md): a link card's "What it does" — what Confirm does — was dropped.
  it("an agent-link card ends on what Confirm does", () => {
    const req: AskActionVm = { id: 81, groupId: null, tool: "request_link", kind: "handoff", state: "proposed", fields: {}, editable: [], note: null, result: null, ref: null, undo: false, at: NOW.toISOString(),
      preview: { title: "Link request to @maya", lines: [{ label: "With", value: "@maya" }, { label: "Reason", value: "Both of us are in the auth middleware this week." },
        { label: "What it does", value: "Confirm sends it. @maya accepts or declines it in Trov; once open, their agent's notes reach this thread." }], item: null } };
    expect(text(cards(withCards([req]))[0])).toMatch(/With @maya Confirm sends it\. @maya accepts or declines it in Trov; once open, their agent(?:'|&#39;)s notes reach this thread\. Cancel Confirm$/);
  });

  it("phone: the picker, the item, Undo and the line's link get the 44px hit area", () => {
    for (const sel of [".ask-act .cnpy-dd::after", "button.ask-asg-item::after", ".ask-undo::after", ".ask-line-link::after"]) expect(css).toContain(`[data-phone="1"] ${sel}`);
  });
});

describe("QA-3: each card of a grouped draft edits on its own", () => {
  const draft = (id: number, title: string): AskEventMap["action"] => ({
    id, groupId: "g-new", tool: "create_ticket", kind: "ticket", state: "proposed", note: null,
    preview: { title, lines: [{ label: "Title", value: title }, { label: "Category", value: "bug" }, { label: "Priority", value: "normal" }, { label: "Assignee", value: "Unassigned" }, { label: "Sprint", value: "Backlog" }], item: null },
    fields: { title, body: "", category: "bug", priority: "normal", assignee: null, sprint_id: null }, editable: ["title", "category", "priority", "assignee"],
  });
  function grouped(): AppState {
    const s = app(null);
    let c: AskConvo = { uid: "c1", threadId: 5, thread: null, draft: "", title: "", status: "ok", busy: false,
      messages: [{ role: "user", key: "q1", id: 1, text: "Q", context: [], attachments: [], command: null }, { role: "assistant", key: "a1", turn: newTurn("smart") }] };
    for (const d of [draft(71, "First draft"), draft(72, "Second draft")]) c = withLastTurn(c, (t) => foldAskEvent(t, { event: "action", data: d }, 0));
    s.ask.page = c;
    return s;
  }
  it("the group is one card (one Confirm) whose every item has its own in-place fields", () => {
    const s = grouped();
    const all = cards(s);
    expect(all).toHaveLength(1);
    const card = all[0];
    expect(card).toContain("2 new tickets");
    expect(card).toMatch(/data-act="askAcText" data-arg="71\|title"[^>]*>First draft</);
    expect(card).toMatch(/data-act="askAcText" data-arg="72\|title"[^>]*>Second draft</);
    expect(card).toMatch(/data-act="askAcField" data-arg="71\|priority\|/);
    expect(card).toMatch(/data-act="askAcField" data-arg="72\|category\|/);
    expect(card.match(/data-act="askAcConfirm"/g)).toHaveLength(1);
  });
  it("Confirm sends each edited card alone with ITS edits, then the rest of the group in one call", async () => {
    const s = grouped();
    const calls: [number, unknown][] = [];
    const confirmAction = vi.fn(async (id: number, body?: unknown): Promise<AskActionAnswer> => {
      calls.push([id, body]);
      return { results: [result(id, "confirmed", `ticket:${id}`)] };
    });
    const { ctx } = ctxOf(s, { confirmAction });
    actionsPart.act!(ctx, "askAcText", "72|title", null);
    actionsPart.act!(ctx, "askAcField", "72|title", "Second, renamed");
    const input = { tagName: "INPUT", getAttribute: (n: string) => (n === "data-ask-inline" ? "72" : null) } as unknown as HTMLElement;
    expect(actionsPart.onKeyDown!(ctx, { key: "Enter", isComposing: false, metaKey: false, ctrlKey: false, target: input, preventDefault: vi.fn() } as unknown as KeyboardEvent)).toBe(true);
    expect(cards(s)[0]).toMatch(/data-arg="72\|title"[^>]*>Second, renamed</);
    expect(cards(s)[0]).toMatch(/data-arg="71\|title"[^>]*>First draft</);
    actionsPart.act!(ctx, "askAcConfirm", "71,72", null);
    await flush();
    expect(calls[0]).toEqual([72, { args: { title: "Second, renamed" } }]);
    expect(calls[1][0]).toBe(71);
    expect(calls[1][1]).toBeUndefined();
  });
});
