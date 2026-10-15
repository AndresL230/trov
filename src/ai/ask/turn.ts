// ONE turn of Ask Trov (docs/architecture/ask.md › The turn): stream an answer from the mode's model, run the tools
// it asks for between iterations, and hand every event to `emit` as it happens. The route (./routes.ts) does
// everything around it — the gate, the thread, the person's message, metering, and storing the answer.
//
//   • The mode (ASK_MODES): its model, its tools (Fast: the index only), its call limit (3 / 8 / 8) — past it the
//     model is asked to answer with what it has (`tool_choice: none`) — and its deadline, which aborts the stream.
//   • Reads run at once and their results go back FENCED (./prompt.ts `fence`). Show tools build a block the
//     server reads every value of. A write becomes a card (./actions.ts) — or, in Auto mode and within its rules,
//     runs at once as the person. Consecutive calls to the same write share a group (one card, one Undo).
//   • Caching: the tools (last definition), the system rules and the older thread (./history.ts) each carry a
//     breakpoint; inside the turn the newest tool results are re-marked so each iteration reads the last.
//   • Stop: the request's abort (the client went away) or the person's Stop flag ends the turn; what was written
//     so far is kept, and tools that already ran stay done.
//   • Never on a render path, never reachable from src/mcp.ts. A failure logs its error NAME and status only.
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../../env";
import type { TenantContext } from "../../data/sql";
import { insertAction, finishAction, stopRequested } from "../../data/ask";
import {
  ASK_AUTO_WRITES_MAX, askMode, type AskActivityIcon, type AskBlock, type AskEventMap, type AskEventName, type AskMode,
} from "@shared/ai-ask-core";
import { askChatClient } from "../client";
import { ASK_TOOLS, WRITE_ICON, activityLabel, offeredTools, type ToolSpec } from "./tools";
import { autoAllowedFor, cardFields, ChangedSince } from "./actions";
import type { AskToolCtx } from "./context";
import { refsFromResult, normalRef } from "./refs";
import { ASK_SYSTEM_RULES, MetaSplitter, fence } from "./prompt";
import { TicketError } from "../../tools/tickets";
import { SprintError } from "../../tools/sprints";
import { ArtifactError } from "../../tools/artifacts";
import { HandoffError } from "../../tools/handoffs";
import { PromptError } from "../../tools/prompts";
import { PersonError } from "../../auth/persons";
import { PlanFeatureError, PlanLimitError } from "../../plans/state";
import { ChartError } from "./charts";
import type { AttachmentNotice } from "./attachments";

export type Emit = <K extends AskEventName>(event: K, data: AskEventMap[K]) => Promise<void>;

/** How hard each mode works. Fast and Smart keep their thinking to themselves; Thinking shows its SUMMARY. */
const EFFORT: Record<AskMode, "low" | "medium" | "high"> = { fast: "low", smart: "medium", thinking: "high" };
const MAX_TOKENS: Record<AskMode, number> = { fast: 8_000, smart: 16_000, thinking: 32_000 };

export interface TurnInput {
  env: Env;
  ctx: TenantContext;
  tool: AskToolCtx;
  mode: AskMode;
  turn: number;
  system: string;
  history: Anthropic.MessageParam[];
  user: Anthropic.ContentBlockParam[];
  /** Refs the thread has seen (tools in earlier turns, the person's attachments). Grows as tools return. */
  seen: Set<string>;
  autoMode: boolean;
  /** The org lets Auto mode run (`orgs.ai_chat_auto`), read when the turn started. */
  autoAllowed: boolean;
  nonce: string;
  emit: Emit;
  /** The request's own signal: the client went away (Stop). */
  signal: AbortSignal;
  /** Attachments the model could not take (src/ai/ask/attachments.ts): each is the turn's first activity line, so the
   *  person sees it before the answer. Tool steps number on after them. */
  notices?: readonly AttachmentNotice[];
  fetchImpl?: typeof fetch;
  now: () => number;
}

export interface TurnActivity { step: number; tool: string; icon: AskActivityIcon; label: string; results: string[]; resultLine: string | null }

export interface TurnResult {
  text: string;
  title: string | null;
  followups: string[];
  blocks: AskBlock[];
  activity: TurnActivity[];
  thinking: { seconds: number; summary: string } | null;
  model: string;
  tokens: { in: number; out: number; cached: number };
  /** Why the answer ended: done, Stop, the deadline, a refusal or an API failure. */
  ended: "done" | "stopped" | "timeout" | "failed" | "refused";
  /** The model was reached (the question counts). */
  called: boolean;
  /** `save_artifact` asked for, in Auto: the route saves the stored answer as private. */
  autosave: { title: string | null; kind: "markdown" | "html"; scope: "answer" | "thread"; groupId: string } | null;
}

/** A domain refusal's code (what a tool error carries to the model); anything else is a plain failure. */
export function errorBody(err: unknown): { error: string; code?: string } {
  const known = err instanceof TicketError || err instanceof SprintError || err instanceof ArtifactError || err instanceof HandoffError
    || err instanceof PromptError || err instanceof PersonError || err instanceof PlanLimitError || err instanceof PlanFeatureError
    || err instanceof ChartError || err instanceof ChangedSince;
  if (known) return { error: (err as Error).message, code: (err as { code?: string }).code };
  // Anything else (a D1 error, a bug) says nothing about its insides.
  console.error("ask tool", err instanceof Error ? err.name : "error");
  return { error: "That did not work.", code: "failed" };
}

const json = (v: unknown, max = 40_000): string => {
  const s = JSON.stringify(v ?? null);
  return s.length > max ? `${s.slice(0, max)}… (truncated)` : s;
};
const resultLine = (n: number): string => (n === 0 ? "No results" : n === 1 ? "1 result" : `${n} results`);

/** What the turn tracks across its tool calls. */
interface TurnState {
  calls: number;
  /** Activity steps taken before any tool ran (the attachment notices): a tool call's step is `calls + firstStep`. */
  firstStep: number;
  autoWrites: number;
  /** The previous tool call, when it was a write (consecutive calls to the same write share a group). */
  lastWrite: { tool: string; groupId: string } | null;
  groups: number;
}

export async function runTurn(t: TurnInput): Promise<TurnResult> {
  const def = askMode(t.mode);
  const chat = askChatClient(t.mode, { apiKey: t.env.ANTHROPIC_API_KEY, fetchImpl: t.fetchImpl });
  const result: TurnResult = {
    text: "", title: null, followups: [], blocks: [], activity: [], thinking: null, model: chat?.model ?? def.model,
    tokens: { in: 0, out: 0, cached: 0 }, ended: "done", called: false, autosave: null,
  };
  if (!chat) return { ...result, ended: "failed" };

  const offered = offeredTools(t.ctx, t.mode);
  const offeredNames = new Set(offered.map((o) => o.name));
  const tools: Anthropic.Tool[] = offered.map((d, i) => ({
    name: d.name, description: d.description, input_schema: d.input_schema as Anthropic.Tool.InputSchema,
    ...(i === offered.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
  const system: Anthropic.TextBlockParam[] = [
    { type: "text", text: ASK_SYSTEM_RULES, cache_control: { type: "ephemeral" } },
    { type: "text", text: t.system },
  ];
  const messages: Anthropic.MessageParam[] = [...t.history, { role: "user", content: t.user }];

  const abort = new AbortController();
  let why: "stopped" | "timeout" | null = null;
  const stop = (reason: "stopped" | "timeout") => { if (!why) { why = reason; abort.abort(); } };
  const onClientGone = () => stop("stopped");
  t.signal.addEventListener("abort", onClientGone);
  if (t.signal.aborted) stop("stopped");
  const deadline = t.now() + def.timeoutMs;
  const timer = setTimeout(() => stop("timeout"), def.timeoutMs);

  const splitter = new MetaSplitter();
  const notices = t.notices ?? [];
  const st: TurnState = { calls: 0, firstStep: notices.length, autoWrites: 0, lastWrite: null, groups: 0 };
  let thinkingMs = 0;
  const thinkingParts: string[] = [];

  // An attachment the model could not take: the person is told first, as a finished activity line (and it is kept
  // with the answer, so the thread shows it again).
  for (const [i, n] of notices.entries()) {
    const step = i + 1;
    result.activity.push({ step, tool: "read_attachment", icon: "read", label: n.label, results: [], resultLine: "Not read" });
    await t.emit("activity", { step, tool: "read_attachment", icon: "read", label: n.label, state: "run" });
    await t.emit("activity", { step, state: "done", resultLine: "Not read" });
  }

  try {
    for (let iter = 0; iter < def.maxCalls + 3 && !why; iter++) {
      if (await stopRequested(t.ctx, t.tool.threadId)) { stop("stopped"); break; }
      const stream = chat.client.messages.stream({
        model: chat.model,
        max_tokens: MAX_TOKENS[t.mode],
        system,
        tools,
        ...(st.calls >= def.maxCalls ? { tool_choice: { type: "none" as const } } : {}),
        messages,
        ...(def.thinking ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
        output_config: { effort: EFFORT[t.mode] },
      }, { signal: abort.signal, timeout: Math.max(1_000, deadline - t.now()) });
      result.called = true;

      let blockType: string | null = null;
      let thinkingStart = 0;
      let thinkingText = "";
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          blockType = ev.content_block.type;
          if (blockType === "thinking" && def.thinking) {
            thinkingStart = t.now();
            thinkingText = "";
            await t.emit("thinking", { state: "run" });
          }
        } else if (ev.type === "content_block_delta") {
          if (ev.delta.type === "text_delta") {
            const out = splitter.push(ev.delta.text);
            if (out) await t.emit("text", { delta: out });
          } else if (ev.delta.type === "thinking_delta") {
            thinkingText += ev.delta.thinking;
          }
        } else if (ev.type === "content_block_stop") {
          if (blockType === "thinking" && def.thinking) {
            thinkingMs += t.now() - thinkingStart;
            if (thinkingText.trim()) thinkingParts.push(thinkingText.trim());
            result.thinking = { seconds: Math.max(1, Math.round(thinkingMs / 1000)), summary: thinkingParts.join("\n\n") };
            await t.emit("thinking", { state: "done", ...result.thinking });
          }
          blockType = null;
        }
      }
      const msg = await stream.finalMessage();
      const u = msg.usage;
      result.tokens.in += (u?.input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
      result.tokens.out += u?.output_tokens ?? 0;
      result.tokens.cached += u?.cache_read_input_tokens ?? 0;

      if (msg.stop_reason === "refusal") { result.ended = "refused"; break; }
      if (msg.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: msg.content }); continue; }
      const uses = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      if (msg.stop_reason !== "tool_use" || !uses.length) break;

      messages.push({ role: "assistant", content: msg.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        if (why || (await stopRequested(t.ctx, t.tool.threadId))) {
          stop("stopped");
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: "Stopped by the person." });
          continue;
        }
        st.calls++;
        results.push(await runTool(t, use, def.maxCalls, offeredNames, st, result));
      }
      // The newest tool results are the next iteration's cache point (the earlier one moves with it).
      for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result" && "cache_control" in b) delete b.cache_control;
      if (results.length) results[results.length - 1].cache_control = { type: "ephemeral" };
      messages.push({ role: "user", content: results });
    }
  } catch (err) {
    if (!why) {
      const status = err instanceof Anthropic.APIError && err.status ? ` status=${err.status}` : "";
      console.error(`ask (${t.mode}) failed: ${err instanceof Error ? err.name : "error"}${status}`);
      result.ended = "failed";
    }
  } finally {
    clearTimeout(timer);
    t.signal.removeEventListener("abort", onClientGone);
  }
  if (why) result.ended = why;

  const end = splitter.end();
  if (end.tail && result.ended !== "failed") await t.emit("text", { delta: end.tail }).catch(() => undefined);
  result.text = end.text;
  result.title = end.title;
  result.followups = end.followups;
  return result;
}

/** Run one tool call: validate, then read / show / propose-or-run a write. Returns the tool_result block. */
async function runTool(
  t: TurnInput, use: Anthropic.ToolUseBlock, maxCalls: number, offered: Set<string>, st: TurnState, result: TurnResult,
): Promise<Anthropic.ToolResultBlockParam> {
  const err = (body: { error: string; code?: string }): Anthropic.ToolResultBlockParam =>
    ({ type: "tool_result", tool_use_id: use.id, is_error: true, content: JSON.stringify(body) });
  const step = st.calls + st.firstStep;
  if (st.calls > maxCalls) return err({ error: `The tool limit for this answer (${maxCalls}) is reached. Answer with what you have.`, code: "limit" });
  const spec: ToolSpec | undefined = ASK_TOOLS[use.name];
  if (!spec || !offered.has(use.name)) return err({ error: `There is no tool ${use.name} for you here.`, code: "unknown_tool" });
  const parsed = spec.input.safeParse(use.input ?? {});
  if (!parsed.success) return err({ error: `Invalid input: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`, code: "bad_request" });
  const args = parsed.data as Record<string, unknown>;

  // An activity line: `run` now, `done` with what it found.
  const icon: AskActivityIcon = spec.kind === "write" ? WRITE_ICON[spec.card] ?? "read" : spec.icon;
  const begin = async (label: string, ic: AskActivityIcon) => {
    result.activity.push({ step, tool: use.name, icon: ic, label, results: [], resultLine: null });
    await t.emit("activity", { step, tool: use.name, icon: ic, label, state: "run" });
  };
  const finish = async (refs?: string[], line?: string) => {
    const a = result.activity.find((x) => x.step === step);
    if (a) { a.results = refs ?? []; a.resultLine = line ?? null; }
    await t.emit("activity", { step, state: "done", ...(refs?.length ? { results: refs.slice(0, 20) } : {}), ...(line ? { resultLine: line } : {}) });
  };
  if (spec.kind !== "write") st.lastWrite = null;

  try {
    if (spec.kind === "read") {
      await begin(activityLabel(use.name, args), icon);
      for (const [area, since] of spec.searches?.(args) ?? []) {
        const prev = t.tool.searched.get(area);
        t.tool.searched.set(area, prev === undefined ? since : prev && since ? (since < prev ? since : prev) : prev ?? since);
      }
      const out = await spec.run(t.tool, args);
      // read_attachment answers with the file itself (image / PDF blocks, or fenced text).
      if (out && typeof out === "object" && "__blocks" in out) {
        await finish();
        return { type: "tool_result", tool_use_id: use.id, content: (out as { __blocks: Anthropic.ToolResultBlockParam["content"] }).__blocks };
      }
      const refs = refsFromResult(use.name, out, args);
      for (const r of refs) t.seen.add(r);
      await finish(refs, spec.searches ? resultLine(refs.length) : refs.length > 1 ? resultLine(refs.length) : undefined);
      return { type: "tool_result", tool_use_id: use.id, content: fence(t.nonce, `Result of ${use.name}`, json(out)) };
    }
    if (use.name === "save_artifact") {
      // The answer is saved by the SERVER from what it says — in Auto at once (as private), else a Save form.
      await begin(activityLabel(use.name, args), "read");
      const kind = (args.kind as "markdown" | "html" | undefined) ?? "markdown";
      const scope = (args.scope as "answer" | "thread" | undefined) ?? "answer";
      if (t.autoMode && t.autoAllowed && st.autoWrites < ASK_AUTO_WRITES_MAX) {
        st.autoWrites++;
        result.autosave = { title: (args.title as string | undefined) ?? null, kind, scope, groupId: `${t.tool.threadId}-${t.turn}-save` };
        await finish();
        return { type: "tool_result", tool_use_id: use.id, content: "Auto mode: your answer will be saved as a private artifact when it is complete. Say so in one line." };
      }
      const block: AskBlock = { kind: "save_form", form: { messageId: null, block: null, title: (args.title as string | undefined) ?? "", kind, visibility: "private", saved: null } };
      result.blocks.push(block);
      await t.emit("block", block);
      await finish();
      return { type: "tool_result", tool_use_id: use.id, content: "A Save form is shown under your answer: the person picks the title, the kind and who can see it, then saves. Nothing is saved yet." };
    }
    if (spec.kind === "show") {
      await begin(activityLabel(use.name, args), icon);
      const s = await spec.show(t.tool, args);
      result.blocks.push(s.block);
      for (const r of s.shown) t.seen.add(normalRef(r));
      await t.emit("block", s.block);
      await finish(s.shown.length ? s.shown : undefined);
      return { type: "tool_result", tool_use_id: use.id, content: s.note };
    }

    // A WRITE. The card is built from Trov's rows first: a write that cannot apply is refused here, with no card.
    const preview = await spec.preview(t.tool, args);
    const { fields, editable } = cardFields(use.name, args);
    const groupId = st.lastWrite?.tool === use.name ? st.lastWrite.groupId : `${t.tool.threadId}-${t.turn}-${++st.groups}`;
    st.lastWrite = { tool: use.name, groupId };
    const canAuto = autoAllowedFor(use.name);
    const underCap = st.autoWrites < ASK_AUTO_WRITES_MAX;
    const auto = t.autoMode && t.autoAllowed && canAuto && underCap;
    // In Auto, a card that cannot run says why it waits: Confirm-only, or past the cap.
    const waitNote = t.autoMode && t.autoAllowed ? (!canAuto ? spec.confirmOnly ?? null : !underCap ? `Auto runs up to ${ASK_AUTO_WRITES_MAX} changes per answer.` : null) : null;
    if (!auto) {
      const state = waitNote ? "waiting" : "proposed";
      const id = await insertAction(t.ctx, { threadId: t.tool.threadId, turn: t.turn, tool: use.name, kind: spec.card, groupId, toolUseId: use.id, args, preview, state });
      await t.emit("action", { id, groupId, tool: use.name, kind: spec.card, preview, fields, editable, note: waitNote, state });
      return {
        type: "tool_result", tool_use_id: use.id,
        content: `NOT run. It is card #${id}, waiting for the person: it runs only if they press Confirm${waitNote ? ` (${waitNote})` : ""}. Tell them what it will do; never say it is done.`,
      };
    }
    // Auto mode: it runs now, as the person, still recorded as a chat_actions row (state `auto`).
    if (!spec.outsideCap) st.autoWrites++;
    const id = await insertAction(t.ctx, { threadId: t.tool.threadId, turn: t.turn, tool: use.name, kind: spec.card, groupId, toolUseId: use.id, args, preview, state: "running" });
    try {
      const ran = await spec.run(t.tool, args);
      await finishAction(t.ctx, id, "auto", ran.result, ran.undo);
      for (const r of refsFromResult(use.name, ran.result, args)) t.seen.add(r);
      if (ran.ref) t.seen.add(normalRef(ran.ref));
      await t.emit("action_result", { id, groupId, state: "auto", result: ran.result, ref: ran.ref, undo: ran.undo !== null, at: new Date(t.now()).toISOString() });
      return { type: "tool_result", tool_use_id: use.id, content: `Ran (Auto mode) as card #${id}; the person can undo it.\n${fence(t.nonce, `Result of ${use.name}`, json(ran.result))}` };
    } catch (e) {
      const body = errorBody(e);
      await finishAction(t.ctx, id, "failed", body, null);
      await t.emit("action_result", { id, groupId, state: "failed", result: body, ref: null, undo: false, at: new Date(t.now()).toISOString() });
      return err(body);
    }
  } catch (e) {
    if (result.activity.some((a) => a.step === step)) await finish(undefined, "Did not work").catch(() => undefined);
    return err(errorBody(e));
  }
}
