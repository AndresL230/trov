// Ask Trov — the conversation state model (FOUNDATION). Pure: no DOM, no fetch.
//
// One assistant answer is an `AskTurn`, folded event by event from the SSE stream (`foldAskEvent`) or built
// whole from a stored message (`turnFromMessage`). Every part of the screen renders from it:
//   • activity  — the steps, in order, `run` → `done` (results + resultLine)
//   • thinking  — `run` (the CLIENT counts the seconds from `startedAt`) → `done` { seconds, summary }
//   • parts     — what the answer SHOWS, in the order it arrived: markdown text (deltas merged), blocks
//                 (items / chart / themes / diagram / not_found / save_form) and write cards (by action id)
//   • actions   — the write cards by id: `action` (proposed | waiting) then `action_result` (the decision; an
//                 Auto write arrives as a result with no card before it)
//   • followups, cites (the linked RefViews), tokens, stopped, error
// The thread-level `thread` event is not the turn's: `foldThreadEvent` applies it to the conversation.
// test/render.ask-stream.test.ts folds EVERY recorded transcript (docs/superpowers/specs/ask-transcripts/) —
// the client's contract tests for the event shapes.

import type {
  AskAction, AskActionKind, AskActionPreview, AskActivityIcon, AskBlock, AskEvent, AskEventMap, AskMessage, AskMode, AskTokens,
  AskThreadSummary, RefView,
} from "@shared/ai-ask-core";

export interface AskStep {
  step: number;
  tool: string;
  icon: AskActivityIcon;
  label: string;
  state: "run" | "done";
  results: string[];
  resultLine: string | null;
}

export type AskThinking =
  | { state: "run"; startedAt: number }
  | { state: "done"; seconds: number; summary: string };

/** A write card as the screen holds it: the `action` event's card, then its decision. An Auto write (a result
 *  with no card before it) has `tool` / `kind` / `preview` null — the result alone says what was done. */
export interface AskActionVm {
  id: number;
  groupId: string | null;
  tool: string | null;
  kind: AskActionKind | null;
  state: AskAction["state"];
  preview: AskActionPreview | null;
  fields: Record<string, unknown>;
  editable: string[];
  note: string | null;
  result: unknown;
  ref: string | null;
  undo: boolean;
  at: string | null;
}

export type AskPartVm =
  | { kind: "text"; md: string }
  | { kind: "block"; block: AskBlock }
  | { kind: "action"; id: number };

export interface AskTurn {
  /** The stored message id, once `done` names it (null while streaming). */
  messageId: number | null;
  mode: AskMode;
  activity: AskStep[];
  thinking: AskThinking | null;
  parts: AskPartVm[];
  actions: Record<number, AskActionVm>;
  followups: string[];
  cites: RefView[];
  tokens: AskTokens | null;
  saved: AskEventMap["artifact_saved"][];
  /** `done` arrived (stopped or not). */
  done: boolean;
  stopped: boolean;
  error: { code: string; message: string } | null;
}

export function newTurn(mode: AskMode): AskTurn {
  return { messageId: null, mode, activity: [], thinking: null, parts: [], actions: {}, followups: [], cites: [], tokens: null, saved: [], done: false, stopped: false, error: null };
}

/** Where the answer stands, for the screen: nothing yet, reading (steps running), thinking, writing, or over. */
export type AskTurnPhase = "waiting" | "working" | "thinking" | "writing" | "done" | "stopped" | "error";
export function turnPhase(t: AskTurn): AskTurnPhase {
  if (t.error) return "error";
  if (t.stopped) return "stopped";
  if (t.done) return "done";
  if (t.parts.length) return "writing";
  if (t.thinking?.state === "run") return "thinking";
  if (t.activity.some((s) => s.state === "run")) return "working";
  return t.activity.length || t.thinking ? "working" : "waiting";
}
/** The answer is still coming (Send is Stop, the cursor blinks). */
export const turnLive = (t: AskTurn): boolean => !t.done && !t.stopped && !t.error;

/** Fold ONE event into the turn. Pure: returns a new turn (the input is not changed); `now` is Date.now(). */
export function foldAskEvent(t: AskTurn, e: AskEvent, now: number): AskTurn {
  switch (e.event) {
    case "thread": return t;
    case "thinking": {
      const d = e.data;
      return { ...t, thinking: d.state === "run" ? { state: "run", startedAt: now } : { state: "done", seconds: d.seconds, summary: d.summary } };
    }
    case "activity": {
      const d = e.data;
      if (d.state === "run") {
        const step: AskStep = { step: d.step, tool: d.tool, icon: d.icon, label: d.label, state: "run", results: [], resultLine: null };
        return { ...t, activity: [...t.activity.filter((s) => s.step !== d.step), step] };
      }
      return { ...t, activity: t.activity.map((s) => s.step === d.step ? { ...s, state: "done", results: d.results ?? [], resultLine: d.resultLine ?? null } : s) };
    }
    case "text": {
      const last = t.parts[t.parts.length - 1];
      const parts = last?.kind === "text"
        ? [...t.parts.slice(0, -1), { kind: "text" as const, md: last.md + e.data.delta }]
        : [...t.parts, { kind: "text" as const, md: e.data.delta }];
      return { ...t, parts };
    }
    case "block": return { ...t, parts: [...t.parts, { kind: "block", block: e.data }] };
    case "action": {
      const d = e.data;
      const vm: AskActionVm = { id: d.id, groupId: d.groupId, tool: d.tool, kind: d.kind, state: d.state, preview: d.preview, fields: d.fields,
        editable: d.editable, note: d.note, result: null, ref: null, undo: false, at: null };
      const seen = t.parts.some((p) => p.kind === "action" && p.id === d.id);
      return { ...t, actions: { ...t.actions, [d.id]: vm }, parts: seen ? t.parts : [...t.parts, { kind: "action", id: d.id }] };
    }
    case "action_result": return applyActionResult(t, e.data);
    case "artifact_saved": {
      const saved = e.data;
      // The form it came from shows the saved line: the LAST save_form still waiting.
      let hit = false;
      const parts = [...t.parts].reverse().map((p) => {
        if (hit || p.kind !== "block" || p.block.kind !== "save_form" || p.block.form.saved) return p;
        hit = true;
        return { kind: "block" as const, block: { kind: "save_form" as const, form: { ...p.block.form, title: saved.title, visibility: saved.visibility, saved } } };
      }).reverse();
      return { ...t, parts, saved: [...t.saved, saved] };
    }
    case "followups": return { ...t, followups: e.data.items };
    case "done": {
      const d = e.data;
      return { ...t, messageId: d.messageId, cites: d.cites, tokens: d.tokens, done: true, stopped: d.stopped === true,
        activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s) };
    }
    case "error": return { ...t, error: { code: e.data.code, message: e.data.message }, activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s) };
  }
}

/** A decision on a card — from the stream (Auto) or from Confirm / Cancel / Undo's answer. Also how the
 *  controller applies `AskActionAnswer.results`. */
export function applyActionResult(t: AskTurn, d: AskEventMap["action_result"]): AskTurn {
  const prev = t.actions[d.id];
  const vm: AskActionVm = prev
    ? { ...prev, state: d.state, result: d.result, ref: d.ref, undo: d.undo, at: d.at, groupId: d.groupId ?? prev.groupId }
    // An Auto write: the result names the write itself (tool, kind, the card's preview).
    : { id: d.id, groupId: d.groupId, tool: d.tool ?? null, kind: d.kind ?? null, state: d.state, preview: d.preview ?? null, fields: {}, editable: [], note: null, result: d.result, ref: d.ref, undo: d.undo, at: d.at };
  const seen = t.parts.some((p) => p.kind === "action" && p.id === d.id);
  return { ...t, actions: { ...t.actions, [d.id]: vm }, parts: seen ? t.parts : [...t.parts, { kind: "action", id: d.id }] };
}

/** The client stopped the stream (Stop, or the request went away): what ran stays done, the rest is partial. */
export function stopTurn(t: AskTurn): AskTurn {
  if (!turnLive(t)) return t;
  return { ...t, stopped: true, activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s),
    thinking: t.thinking?.state === "run" ? null : t.thinking };
}

/** The stream closed with no `done` and no `error` (the connection dropped). */
export function failTurn(t: AskTurn, message = "The answer stopped before it finished."): AskTurn {
  return turnLive(t) ? { ...t, error: { code: "failed", message }, activity: t.activity.map((s) => s.state === "run" ? { ...s, state: "done" } : s) } : t;
}

/** What the screen draws from `parts`: consecutive cards of ONE group (`groupId`) become one entry
 *  ("Filed tickets #30, #31 and #32" — one Confirm, one Undo). */
export type AskShownPart =
  | { kind: "text"; md: string }
  | { kind: "block"; block: AskBlock; index: number }
  | { kind: "actions"; groupId: string | null; ids: number[] };
export function shownParts(t: AskTurn): AskShownPart[] {
  const out: AskShownPart[] = [];
  let blockIndex = 0;
  for (const p of t.parts) {
    if (p.kind === "text") { out.push(p); continue; }
    if (p.kind === "block") { out.push({ kind: "block", block: p.block, index: blockIndex++ }); continue; }
    const g = t.actions[p.id]?.groupId ?? null;
    const last = out[out.length - 1];
    if (last?.kind === "actions" && g !== null && last.groupId === g) last.ids.push(p.id);
    else out.push({ kind: "actions", groupId: g, ids: [p.id] });
  }
  return out;
}

/** The answer's text alone (Copy, the stub view): every text part, joined. */
export const turnText = (t: AskTurn): string => t.parts.filter((p): p is { kind: "text"; md: string } => p.kind === "text").map((p) => p.md).join("");

/** A stored answer (`GET /ask/threads/:id` › messages) as a turn. NOTE (contract gap, reported): a stored
 *  message keeps `text` and `blocks` apart, so where a block sat in the text is lost — blocks are shown
 *  after the text until the server stores their position. */
/** A stored answer's parts: in the order they STREAMED when the row has them (`AskMessage.parts`), then anything
 *  added since (a Save as artifact form, a card linked later) in its own order; an older row: text, blocks, cards. */
export function storedParts(m: Pick<AskMessage, "text" | "blocks" | "actions" | "parts">): AskPartVm[] {
  if (!m.parts?.length) {
    return [
      ...(m.text ? [{ kind: "text" as const, md: m.text }] : []),
      ...m.blocks.map((block) => ({ kind: "block" as const, block })),
      ...m.actions.map((a) => ({ kind: "action" as const, id: a.id })),
    ];
  }
  const usedBlocks = new Set<number>();
  const usedCards = new Set<number>();
  const known = new Set(m.actions.map((a) => a.id));
  const out: AskPartVm[] = [];
  for (const p of m.parts) {
    if (p.kind === "text") { if (p.md) out.push({ kind: "text", md: p.md }); continue; }
    if (p.kind === "block") { const b = m.blocks[p.index]; if (b && !usedBlocks.has(p.index)) { usedBlocks.add(p.index); out.push({ kind: "block", block: b }); } continue; }
    if (known.has(p.id) && !usedCards.has(p.id)) { usedCards.add(p.id); out.push({ kind: "action", id: p.id }); }
  }
  m.blocks.forEach((block, i) => { if (!usedBlocks.has(i)) out.push({ kind: "block", block }); });
  for (const a of m.actions) if (!usedCards.has(a.id)) out.push({ kind: "action", id: a.id });
  return out;
}

export function turnFromMessage(m: AskMessage): AskTurn {
  const t = newTurn(m.mode);
  const actions: Record<number, AskActionVm> = {};
  for (const a of m.actions) {
    actions[a.id] = { id: a.id, groupId: a.groupId, tool: a.tool, kind: a.kind, state: a.state, preview: a.preview, fields: a.fields, editable: a.editable,
      note: a.note, result: a.result, ref: a.ref, undo: a.undo, at: a.decidedAt ?? a.createdAt };
  }
  return {
    ...t,
    messageId: m.id,
    activity: m.activity.map((s) => ({ step: s.step, tool: s.tool, icon: s.icon, label: s.label, state: "done" as const, results: s.results, resultLine: s.resultLine })),
    thinking: m.thinking ? { state: "done", seconds: m.thinking.seconds, summary: m.thinking.summary } : null,
    parts: storedParts(m),
    actions,
    followups: m.followups,
    cites: m.cites,
    done: true,
    stopped: m.stopped,
  };
}

// ── the conversation (a thread's messages, page or ⌘J panel) ─────────────────

export interface AskQuestion {
  role: "user";
  /** Stable client key (`q1`, …) — the stored id is not streamed back (contract gap, reported). */
  key: string;
  id: number | null;
  text: string;
  context: string[];
  attachments: AskMessage["attachments"];
  command: AskMessage["command"];
  /** Who asked it (`AskMessage.askedBy`; 0077_ask_people_sharing) — absent = the thread's owner. */
  askedBy?: string;
}
/** `askedBy`: who asked the question this answers — absent = the thread's owner. */
export interface AskAnswer { role: "assistant"; key: string; turn: AskTurn; askedBy?: string }
export type AskMsg = AskQuestion | AskAnswer;

export interface AskConvo {
  /** The conversation's own key (ask-motion.ts rule 1): it stays when a new thread is named or a stored thread's
   *  history lands, so the column never re-enters mid-conversation; a new conversation gets a new one. */
  uid: string;
  /** The thread on screen; null for a new one until its `thread` event arrives. */
  threadId: number | null;
  thread: AskThreadSummary | null;
  /** The thread's unsent words as the server kept them (`AskThreadDetail.thread.draft`; "" for a new thread). Read
   *  from the detail explicitly — the composer brings them back into its box on opening the thread. */
  draft: string;
  /** The thread's title as the `thread` event names it ("" until the first exchange is named). */
  title: string;
  messages: AskMsg[];
  /** Reading the thread's history. */
  status: "idle" | "loading" | "ok" | "error";
  /** A stream is in flight (Send is Stop). */
  busy: boolean;
}
let convoSeq = 0;
export const emptyConvo = (): AskConvo => ({ uid: `c${++convoSeq}`, threadId: null, thread: null, draft: "", title: "", messages: [], status: "idle", busy: false });

/** The conversation from a stored thread. */
export function convoFromDetail(d: { thread: AskThreadSummary & { draft?: string }; messages: AskMessage[] }): AskConvo {
  const { draft, ...thread } = d.thread;
  return {
    uid: `t${d.thread.id}`, threadId: d.thread.id, thread, draft: typeof draft === "string" ? draft : "", title: d.thread.title, status: "ok", busy: false,
    messages: d.messages.map((m): AskMsg => m.role === "user"
      ? { role: "user", key: `m${m.id}`, id: m.id, text: m.text, context: m.context, attachments: m.attachments, command: m.command, ...(m.askedBy ? { askedBy: m.askedBy } : {}) }
      : { role: "assistant", key: `m${m.id}`, turn: turnFromMessage(m), ...(m.askedBy ? { askedBy: m.askedBy } : {}) }),
  };
}

/** The `thread` event, applied to the conversation: its id (a new thread), title, mode and switch. A turn has started,
 *  and a turn takes the notes waiting on the thread's Trov links (the server delivers them into it), so the line
 *  that announced them goes (`thread.links`; the next read of the thread says what is still waiting). */
export function foldThreadEvent(c: AskConvo, d: AskEventMap["thread"]): AskConvo {
  const { links: _delivered, ...known } = c.thread ?? ({} as Partial<AskThreadSummary>);
  const base: AskThreadSummary = c.thread ? (known as AskThreadSummary) : { id: d.id, title: d.title, pinned: false, mode: d.mode, auto: d.auto, origin: d.origin, contextRef: d.contextRef,
    hasDraft: false, group: "today", createdAt: "", updatedAt: "" };
  return { ...c, threadId: d.id, title: d.title || c.title, thread: { ...base, id: d.id, title: d.title || base.title, mode: d.mode, auto: d.auto, origin: d.origin, contextRef: d.contextRef } };
}

/** The last answer of the conversation (the one a stream folds into). */
export function lastAnswer(c: AskConvo): AskAnswer | null {
  for (let i = c.messages.length - 1; i >= 0; i--) { const m = c.messages[i]; if (m.role === "assistant") return m; }
  return null;
}
/** Replace the last answer's turn. */
/** `done.questionId`: the question this answer answers gets its stored id (Edit on it needs no read first). */
export function withQuestionId(c: AskConvo, id: number | undefined): AskConvo {
  if (id === undefined) return c;
  const i = c.messages.map((m) => m.role).lastIndexOf("user");
  if (i < 0) return c;
  const q = c.messages[i] as AskQuestion;
  return q.id === id ? c : { ...c, messages: [...c.messages.slice(0, i), { ...q, id }, ...c.messages.slice(i + 1)] };
}
export function withLastTurn(c: AskConvo, f: (t: AskTurn) => AskTurn): AskConvo {
  const i = c.messages.map((m) => m.role).lastIndexOf("assistant");
  if (i < 0) return c;
  const m = c.messages[i] as AskAnswer;
  return { ...c, messages: [...c.messages.slice(0, i), { ...m, turn: f(m.turn) }, ...c.messages.slice(i + 1)] };
}
/** Replace the turn holding action `id` (Confirm / Cancel / Undo land on an older answer too). */
export function withTurnOfAction(c: AskConvo, id: number, f: (t: AskTurn) => AskTurn): AskConvo {
  return { ...c, messages: c.messages.map((m) => m.role === "assistant" && m.turn.actions[id] ? { ...m, turn: f(m.turn) } : m) };
}
