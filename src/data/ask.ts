// Ask Trov's rows (0066_ask; docs/architecture/ask.md). A TENANT module: every statement names `org_id`, bound
// from the caller's context, AND the thread's OWNER — a thread is one person's, so another org's or another
// person's thread, message, card or attachment is the one `null` / not found. Nothing here calls a model.
import { all, batch, first, nowIso, run, stmt, type Stmt, type TenantContext } from "./sql";
import type { AskMode, AskOrigin, AskWrongReason } from "@shared/ai-ask-core";

export interface ChatThreadRow {
  id: number;
  handle: string;
  title: string;
  mode: AskMode;
  origin: AskOrigin;
  context_ref: string | null;
  pinned: number;
  auto_mode: number;
  draft: string;
  summary: string;
  summary_through: number;
  turn: number;
  stop_requested: number;
  created_at: string;
  updated_at: string;
}

export interface ChatMessageRow {
  id: number;
  thread_id: number;
  role: "user" | "assistant";
  mode: AskMode;
  content_json: string;
  cites_json: string;
  attachments_json: string;
  model: string | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  units: number;
  stopped: number;
  replaced_at: string | null;
  created_at: string;
}

export interface ChatActionRow {
  id: number;
  thread_id: number;
  message_id: number | null;
  turn: number;
  tool: string;
  kind: string;
  group_id: string | null;
  tool_use_id: string;
  args_json: string;
  preview_json: string;
  state: string;
  result_json: string | null;
  undo_json: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ChatArtifactRow {
  id: number;
  thread_id: number;
  artifact_id: number;
  role: "attachment" | "saved";
  message_id: number | null;
  created_at: string;
}

// ── threads ──────────────────────────────────────────────────────────────────

/** The owner's thread, or null (unknown, another person's, another org's: the same null). */
export function getThread(ctx: TenantContext, handle: string, id: number): Promise<ChatThreadRow | null> {
  return first<ChatThreadRow>(ctx, `SELECT * FROM chat_threads WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE`, id, ctx.orgId, handle);
}

export interface NewThread { mode: AskMode; origin?: AskOrigin; contextRef?: string | null; auto?: boolean }

export async function createThread(ctx: TenantContext, handle: string, t: NewThread, at: string = nowIso()): Promise<number> {
  const res = await run(ctx,
    `INSERT INTO chat_threads (org_id, handle, mode, origin, context_ref, auto_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, handle, t.mode, t.origin ?? "page", t.contextRef ?? null, t.auto ? 1 : 0, at, at);
  return Number(res.meta.last_row_id);
}

/** The owner's threads: pinned first, then the most recently used. */
export function listThreads(ctx: TenantContext, handle: string, limit = 200): Promise<ChatThreadRow[]> {
  return all<ChatThreadRow>(ctx,
    `SELECT * FROM chat_threads WHERE org_id = ? AND handle = ? COLLATE NOCASE ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`,
    ctx.orgId, handle, limit);
}

/**
 * Search the owner's OWN threads (#12 §2.15): a message whose text matches (`chat_fts`; a replaced message is
 * not indexed) — with FTS5's `snippet()` around the best match and how many of the thread's messages matched —
 * or a title that contains `q`. `match` is an FTS5 expression the caller built (src/tools/reads.ts
 * `buildMatch`), null when `q` has no term.
 */
export async function searchThreads(ctx: TenantContext, handle: string, q: string, match: string | null, limit = 50):
  Promise<{ thread: ChatThreadRow; snippet: string | null; matchCount: number }[]> {
  const byText = match
    ? await all<ChatThreadRow & { snippet: string }>(ctx,
      `SELECT t.*, snippet(chat_fts, 2, char(2), char(3), '…', 12) AS snippet
         FROM chat_fts f JOIN chat_threads t ON t.id = CAST(f.thread_id AS INTEGER) AND t.org_id = f.org_id
        WHERE chat_fts MATCH ? AND f.org_id = ? AND t.handle = ? COLLATE NOCASE
        ORDER BY bm25(chat_fts) LIMIT ?`,
      match, ctx.orgId, handle, limit * 4).catch((e) => { console.error("ask search", e instanceof Error ? e.name : "error"); return [] as (ChatThreadRow & { snippet: string })[]; })
    : [];
  // How many of each thread's messages matched (the snippet query keeps only the best per thread).
  const counts = byText.length
    ? await all<{ thread_id: string; n: number }>(ctx,
      `SELECT f.thread_id, COUNT(*) AS n FROM chat_fts f WHERE chat_fts MATCH ? AND f.org_id = ? GROUP BY f.thread_id`, match, ctx.orgId).catch(() => [])
    : [];
  const out = new Map<number, { thread: ChatThreadRow; snippet: string | null; matchCount: number }>();
  for (const r of byText) {
    if (out.has(r.id)) continue;
    const { snippet, ...thread } = r;
    out.set(r.id, { thread, snippet, matchCount: Number(counts.find((x) => Number(x.thread_id) === r.id)?.n ?? 1) });
  }
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const byTitle = await all<ChatThreadRow>(ctx,
    `SELECT * FROM chat_threads WHERE org_id = ? AND handle = ? COLLATE NOCASE AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
    ctx.orgId, handle, like, limit);
  for (const t of byTitle) if (!out.has(t.id)) out.set(t.id, { thread: t, snippet: null, matchCount: 0 });
  return [...out.values()].slice(0, limit);
}

export interface ThreadPatch { title?: string; pinned?: boolean; auto?: boolean; mode?: AskMode; draft?: string }

/** Rename, pin, Auto, mode, draft — the owner's thread only. False when there is no such thread. */
export async function patchThread(ctx: TenantContext, handle: string, id: number, p: ThreadPatch): Promise<boolean> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (p.title !== undefined) { sets.push("title = ?"); vals.push(p.title); }
  if (p.pinned !== undefined) { sets.push("pinned = ?"); vals.push(p.pinned ? 1 : 0); }
  if (p.auto !== undefined) { sets.push("auto_mode = ?"); vals.push(p.auto ? 1 : 0); }
  if (p.mode !== undefined) { sets.push("mode = ?"); vals.push(p.mode); }
  if (p.draft !== undefined) { sets.push("draft = ?"); vals.push(p.draft); }
  if (!sets.length) return !!(await getThread(ctx, handle, id));
  const res = await run(ctx, `UPDATE chat_threads SET ${sets.join(", ")} WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE`, ...vals, id, ctx.orgId, handle);
  return (res.meta.changes ?? 0) > 0;
}

/** Delete one of the owner's threads with everything that hangs off it, in ONE batch (the FTS rows go with
 *  their messages, by trigger). `before` joins the same batch first: the attachments that go with the thread
 *  (src/deletion/ask.ts, the one caller — it decides which go and which a ticket or a doc keeps). */
export async function deleteThread(ctx: TenantContext, handle: string, id: number, before: Stmt[] = []): Promise<boolean> {
  const t = await getThread(ctx, handle, id);
  if (!t) return false;
  await batch(ctx, [
    ...before,
    stmt(ctx, `DELETE FROM chat_actions WHERE thread_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM chat_artifacts WHERE thread_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM chat_messages WHERE thread_id = ? AND org_id = ?`, id, ctx.orgId),
    stmt(ctx, `DELETE FROM chat_threads WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE`, id, ctx.orgId, handle),
  ]);
  return true;
}

/**
 * A new turn starts: the turn number moves on, a Stop pressed before it is forgotten, the thread takes this
 * answer's mode and Auto setting and moves to the top of the list, and every card still PROPOSED or WAITING from
 * an earlier turn EXPIRES (a card lives only as long as its turn). One batch. Returns the new turn number.
 */
export async function startTurn(ctx: TenantContext, threadId: number, mode: AskMode, auto: boolean, at: string = nowIso()): Promise<number> {
  await batch(ctx, [
    stmt(ctx, `UPDATE chat_actions SET state = 'expired', decided_at = ? WHERE thread_id = ? AND org_id = ? AND state IN ('proposed', 'waiting')`, at, threadId, ctx.orgId),
    stmt(ctx, `UPDATE chat_threads SET turn = turn + 1, stop_requested = 0, mode = ?, auto_mode = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
      mode, auto ? 1 : 0, at, threadId, ctx.orgId),
  ]);
  return (await first<{ turn: number }>(ctx, `SELECT turn FROM chat_threads WHERE id = ? AND org_id = ?`, threadId, ctx.orgId))?.turn ?? 0;
}

/** Stop: the running turn ends at its next step (the request's own abort covers a connection that is open). */
export async function requestStop(ctx: TenantContext, handle: string, id: number): Promise<boolean> {
  const res = await run(ctx, `UPDATE chat_threads SET stop_requested = 1 WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE`, id, ctx.orgId, handle);
  return (res.meta.changes ?? 0) > 0;
}

export async function stopRequested(ctx: TenantContext, threadId: number): Promise<boolean> {
  return ((await first<{ s: number }>(ctx, `SELECT stop_requested AS s FROM chat_threads WHERE id = ? AND org_id = ?`, threadId, ctx.orgId))?.s ?? 0) === 1;
}

export async function setThreadTitle(ctx: TenantContext, threadId: number, title: string): Promise<void> {
  await run(ctx, `UPDATE chat_threads SET title = ? WHERE id = ? AND org_id = ? AND title = ''`, title, threadId, ctx.orgId);
}

export async function setThreadSummary(ctx: TenantContext, threadId: number, summary: string, through: number): Promise<void> {
  await run(ctx, `UPDATE chat_threads SET summary = ?, summary_through = ? WHERE id = ? AND org_id = ?`, summary, through, threadId, ctx.orgId);
}

// ── messages ─────────────────────────────────────────────────────────────────

export interface NewMessage {
  role: "user" | "assistant";
  mode: AskMode;
  content: unknown;
  cites?: unknown[];
  attachments?: unknown[];
  model?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  tokensCached?: number;
  units?: number;
  stopped?: boolean;
}

export async function insertMessage(ctx: TenantContext, threadId: number, m: NewMessage, at: string = nowIso()): Promise<number> {
  const res = await run(ctx,
    `INSERT INTO chat_messages (org_id, thread_id, role, mode, content_json, cites_json, attachments_json, model, tokens_in, tokens_out, tokens_cached, units, stopped, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, threadId, m.role, m.mode, JSON.stringify(m.content ?? {}), JSON.stringify(m.cites ?? []), JSON.stringify(m.attachments ?? []),
    m.model ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, m.tokensCached ?? 0, m.units ?? 0, m.stopped ? 1 : 0, at);
  return Number(res.meta.last_row_id);
}

/** A thread's LIVE messages (a replaced one is hidden), oldest first. */
export function listMessages(ctx: TenantContext, threadId: number): Promise<ChatMessageRow[]> {
  return all<ChatMessageRow>(ctx, `SELECT * FROM chat_messages WHERE thread_id = ? AND org_id = ? AND replaced_at IS NULL ORDER BY id`, threadId, ctx.orgId);
}

/** The owner's live message (through its thread), or null. */
export function getMessage(ctx: TenantContext, handle: string, id: number): Promise<ChatMessageRow | null> {
  return first<ChatMessageRow>(ctx,
    `SELECT m.* FROM chat_messages m JOIN chat_threads t ON t.id = m.thread_id AND t.org_id = m.org_id
      WHERE m.id = ? AND m.org_id = ? AND t.handle = ? COLLATE NOCASE AND m.replaced_at IS NULL`, id, ctx.orgId, handle);
}

/** Store one more block on an answer (the Save as artifact form). */
export async function setMessageContent(ctx: TenantContext, id: number, content: unknown): Promise<void> {
  await run(ctx, `UPDATE chat_messages SET content_json = ? WHERE id = ? AND org_id = ?`, JSON.stringify(content), id, ctx.orgId);
}

/** Edit-and-resend and regenerate (#12 §2.16): the messages from `fromId` on are REPLACED — kept, hidden, out of
 *  search — and the cards their answers proposed that nobody decided expire. What already ran stays done. */
export async function replaceMessagesFrom(ctx: TenantContext, threadId: number, fromId: number, at: string = nowIso()): Promise<void> {
  await batch(ctx, [
    stmt(ctx, `UPDATE chat_actions SET state = 'expired', decided_at = ? WHERE thread_id = ? AND org_id = ? AND state IN ('proposed', 'waiting')
                AND (message_id IS NULL OR message_id >= ?)`, at, threadId, ctx.orgId, fromId),
    stmt(ctx, `UPDATE chat_messages SET replaced_at = ? WHERE thread_id = ? AND org_id = ? AND id >= ? AND replaced_at IS NULL`, at, threadId, ctx.orgId, fromId),
  ]);
}

// ── cards ────────────────────────────────────────────────────────────────────

export interface NewAction {
  threadId: number;
  turn: number;
  tool: string;
  kind: string;
  groupId: string | null;
  toolUseId: string;
  args: unknown;
  preview: unknown;
  state: "proposed" | "waiting" | "running";
}

export async function insertAction(ctx: TenantContext, a: NewAction, at: string = nowIso()): Promise<number> {
  const res = await run(ctx,
    `INSERT INTO chat_actions (org_id, thread_id, turn, tool, kind, group_id, tool_use_id, args_json, preview_json, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, a.threadId, a.turn, a.tool, a.kind, a.groupId, a.toolUseId, JSON.stringify(a.args ?? {}), JSON.stringify(a.preview ?? {}), a.state, at);
  return Number(res.meta.last_row_id);
}

export type ActionWithTurn = ChatActionRow & { thread_turn: number };

/** The owner's card (through its thread) with the thread's current turn, or null. */
export function getAction(ctx: TenantContext, handle: string, id: number): Promise<ActionWithTurn | null> {
  return first<ActionWithTurn>(ctx,
    `SELECT a.*, t.turn AS thread_turn FROM chat_actions a JOIN chat_threads t ON t.id = a.thread_id AND t.org_id = a.org_id
      WHERE a.id = ? AND a.org_id = ? AND t.handle = ? COLLATE NOCASE`, id, ctx.orgId, handle);
}

/** Every card of a group, in order (the same thread; the caller already owns one of them). */
export function groupActions(ctx: TenantContext, threadId: number, groupId: string): Promise<ActionWithTurn[]> {
  return all<ActionWithTurn>(ctx,
    `SELECT a.*, t.turn AS thread_turn FROM chat_actions a JOIN chat_threads t ON t.id = a.thread_id AND t.org_id = a.org_id
      WHERE a.thread_id = ? AND a.org_id = ? AND a.group_id = ? ORDER BY a.id`, threadId, ctx.orgId, groupId);
}

/** Move a card from one state to another IF it is still in `from` — the ONE guard that makes Confirm, Cancel
 *  and Undo happen once: a second request finds nothing to move. True when this call moved it. */
export async function moveAction(ctx: TenantContext, id: number, from: string | readonly string[], to: string, at: string = nowIso()): Promise<boolean> {
  const froms = typeof from === "string" ? [from] : [...from];
  const res = await run(ctx, `UPDATE chat_actions SET state = ?, decided_at = ? WHERE id = ? AND org_id = ? AND state IN (${froms.map(() => "?").join(", ")})`,
    to, at, id, ctx.orgId, ...froms);
  return (res.meta.changes ?? 0) > 0;
}

/** Confirm with edited fields: the card's arguments and preview, rebuilt (still `running`, the claim held). */
export async function rewriteAction(ctx: TenantContext, id: number, args: unknown, preview: unknown): Promise<void> {
  await run(ctx, `UPDATE chat_actions SET args_json = ?, preview_json = ? WHERE id = ? AND org_id = ? AND state = 'running'`, JSON.stringify(args), JSON.stringify(preview), id, ctx.orgId);
}

/** Record what a write did (and what Undo would write back) once it ran — `running` → `to`. */
export async function finishAction(ctx: TenantContext, id: number, to: string, result: unknown, undo: unknown | null, at: string = nowIso()): Promise<void> {
  await run(ctx, `UPDATE chat_actions SET state = ?, result_json = ?, undo_json = ?, decided_at = ? WHERE id = ? AND org_id = ? AND state = 'running'`,
    to, JSON.stringify(result ?? null), undo === null ? null : JSON.stringify(undo), at, id, ctx.orgId);
}

/** After Undo: the result keeps what the write did; Undo is spent. */
export async function markUndone(ctx: TenantContext, id: number, at: string = nowIso()): Promise<boolean> {
  const res = await run(ctx, `UPDATE chat_actions SET state = 'undone', undo_json = NULL, decided_at = ? WHERE id = ? AND org_id = ? AND state = 'running'`, at, id, ctx.orgId);
  return (res.meta.changes ?? 0) > 0;
}

export async function attachActionsToMessage(ctx: TenantContext, threadId: number, turn: number, messageId: number): Promise<void> {
  await run(ctx, `UPDATE chat_actions SET message_id = ? WHERE thread_id = ? AND org_id = ? AND turn = ? AND message_id IS NULL`, messageId, threadId, ctx.orgId, turn);
}

export function listActions(ctx: TenantContext, threadId: number): Promise<ChatActionRow[]> {
  return all<ChatActionRow>(ctx, `SELECT * FROM chat_actions WHERE thread_id = ? AND org_id = ? ORDER BY id`, threadId, ctx.orgId);
}

// ── attachments and saved answers ────────────────────────────────────────────

export async function linkArtifact(ctx: TenantContext, threadId: number, artifactId: number, role: "attachment" | "saved", messageId: number | null, at: string = nowIso()): Promise<number> {
  await run(ctx,
    `INSERT INTO chat_artifacts (org_id, thread_id, artifact_id, role, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(org_id, thread_id, artifact_id, role) DO UPDATE SET message_id = COALESCE(chat_artifacts.message_id, excluded.message_id)`,
    ctx.orgId, threadId, artifactId, role, messageId, at);
  const row = await first<{ id: number }>(ctx, `SELECT id FROM chat_artifacts WHERE org_id = ? AND thread_id = ? AND artifact_id = ? AND role = ?`, ctx.orgId, threadId, artifactId, role);
  return row!.id;
}

/** The thread's attachments named by `ids` that are NOT sent yet (another thread's, a sent one, an unknown id: left out). */
export async function pendingAttachments(ctx: TenantContext, threadId: number, ids: readonly number[]): Promise<ChatArtifactRow[]> {
  if (!ids.length) return [];
  const rows = await all<ChatArtifactRow>(ctx,
    `SELECT * FROM chat_artifacts WHERE org_id = ? AND thread_id = ? AND role = 'attachment' AND message_id IS NULL`, ctx.orgId, threadId);
  return rows.filter((r) => ids.includes(r.id));
}

/** One of THIS thread's attachments (what `read_attachment` may read): another thread's or org's is null. */
export function threadAttachment(ctx: TenantContext, threadId: number, id: number): Promise<ChatArtifactRow | null> {
  return first<ChatArtifactRow>(ctx, `SELECT * FROM chat_artifacts WHERE id = ? AND org_id = ? AND thread_id = ? AND role = 'attachment'`, id, ctx.orgId, threadId);
}

export async function markAttachmentsSent(ctx: TenantContext, ids: readonly number[], messageId: number): Promise<void> {
  for (const id of ids) await run(ctx, `UPDATE chat_artifacts SET message_id = ? WHERE id = ? AND org_id = ? AND message_id IS NULL`, messageId, id, ctx.orgId);
}

// ── Settings › Trov ──────────────────────────────────────────────────────────

export interface AskSettingsRow { instructions: string; default_mode: AskMode | null }

export async function getAskSettings(ctx: TenantContext, handle: string): Promise<AskSettingsRow> {
  return (await first<AskSettingsRow>(ctx,
    `SELECT instructions, default_mode FROM person_ask_settings WHERE org_id = ? AND handle = ? COLLATE NOCASE`, ctx.orgId, handle))
    ?? { instructions: "", default_mode: null };
}

export async function putAskSettings(ctx: TenantContext, handle: string, p: { instructions?: string; defaultMode?: AskMode }): Promise<void> {
  const cur = await getAskSettings(ctx, handle);
  await run(ctx,
    `INSERT INTO person_ask_settings (org_id, handle, instructions, default_mode, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(org_id, handle) DO UPDATE SET instructions = excluded.instructions, default_mode = excluded.default_mode, updated_at = excluded.updated_at`,
    ctx.orgId, handle, p.instructions ?? cur.instructions, p.defaultMode ?? cur.default_mode, nowIso());
}

// ── "Wrong?" and Review's "Flagged in Ask" ───────────────────────────────────

/** The system prompt's version, recorded beside "Wrong?" (bump it when src/ai/ask/prompt.ts changes). */
export const ASK_PROMPT_VERSION = "ask-2";

/**
 * "Wrong?" on an answer (#12 §2.14): the person's `ai_feedback` row (item type `ask`, the message id) with its
 * detail — once per person and answer. For "A source is wrong" / "It is out of date", each cited item gets ONE
 * `ask_flags` row carrying the reason only (no handle, no thread, no text): what Review shows. Pressing again
 * writes nothing. True when this press was recorded.
 */
export async function recordAskWrong(ctx: TenantContext, handle: string, messageId: number, model: string | null,
  detail: { reason: AskWrongReason; mode: AskMode; cites: string[] }, flagRefs: readonly string[], at: string = nowIso()): Promise<boolean> {
  const res = await run(ctx,
    `INSERT INTO ai_feedback (org_id, handle, item_type, item_ref, kind, model, prompt_version, detail_json, created_at)
     VALUES (?, ?, 'ask', ?, 'ask', ?, ?, ?, ?) ON CONFLICT(org_id, handle, item_type, item_ref) DO NOTHING`,
    ctx.orgId, handle, String(messageId), model, ASK_PROMPT_VERSION, JSON.stringify({ ...detail, messageId }), at);
  if (!(res.meta.changes ?? 0)) return false;
  if (flagRefs.length && (detail.reason === "source_wrong" || detail.reason === "out_of_date")) {
    await batch(ctx, flagRefs.map((ref) => stmt(ctx, `INSERT INTO ask_flags (org_id, item_ref, reason, created_at) VALUES (?, ?, ?, ?)`, ctx.orgId, ref, detail.reason, at)));
  }
  return true;
}

/** Review's "Flagged in Ask" lines for these items: the reason, how often, and when last — nothing else exists to read. */
export async function askFlagsFor(ctx: TenantContext, refs: readonly string[]): Promise<{ ref: string; reason: AskWrongReason; count: number; lastAt: string }[]> {
  if (!refs.length) return [];
  const rows = await all<{ item_ref: string; reason: AskWrongReason; n: number; last_at: string }>(ctx,
    `SELECT item_ref, reason, COUNT(*) AS n, MAX(created_at) AS last_at FROM ask_flags WHERE org_id = ? GROUP BY item_ref, reason`, ctx.orgId);
  return rows.filter((r) => refs.includes(r.item_ref)).map((r) => ({ ref: r.item_ref, reason: r.reason, count: Number(r.n), lastAt: r.last_at }));
}
