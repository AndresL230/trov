// Ask Trov's rows (0066_ask; docs/architecture/ask.md). A TENANT module: every statement names `org_id`, bound
// from the caller's context, AND the thread's OWNER — a thread is one person's, so another org's or another
// person's thread, message, card or attachment is the one `null` / not found. The one exception is a thread its owner
// SHARED — with the org (0076_ask_sharing) or with people by name (0077_ask_people_sharing), › sharing below: those
// reads go through `threadFor`, and the routes check what the person may do. Nothing here calls a model.
import { all, batch, first, nowIso, run, stmt, type Stmt, type TenantContext } from "./sql";
import type { AskMode, AskOrigin, AskShareAccess, AskSharePerson, AskWrongReason } from "@shared/ai-ask-core";

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
  /** 1 = the person's hidden holder of pending attachments (0068_ask_pending): never listed, searched or opened. */
  pending: number;
  /** When the owner shared it with the org (0076_ask_sharing): NULL = private. */
  shared_at: string | null;
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
  /** Who asked the turn (0077_ask_people_sharing); NULL = the thread's owner (every row from before it). */
  asked_by: string | null;
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
  /** Who asked the turn that proposed it — the only person who decides or undoes it. NULL = the thread's owner. */
  asked_by: string | null;
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
  return first<ChatThreadRow>(ctx, `SELECT * FROM chat_threads WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE AND pending = 0`, id, ctx.orgId, handle);
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
    `SELECT * FROM chat_threads WHERE org_id = ? AND handle = ? COLLATE NOCASE AND pending = 0 ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`,
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
        WHERE chat_fts MATCH ? AND f.org_id = ? AND t.handle = ? COLLATE NOCASE AND t.pending = 0
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
    `SELECT * FROM chat_threads WHERE org_id = ? AND handle = ? COLLATE NOCASE AND pending = 0 AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?`,
    ctx.orgId, handle, like, limit);
  for (const t of byTitle) if (!out.has(t.id)) out.set(t.id, { thread: t, snippet: null, matchCount: 0 });
  return [...out.values()].slice(0, limit);
}

// ── sharing (0076_ask_sharing, 0077_ask_people_sharing) ──────────────────────
//
// The owner may share a thread with the org they asked it in (`shared_at`: every LIVE member reads it) and with
// people of that org by name (`chat_thread_people`: each `read` or `continue`). A thread whose owner is no longer a
// member of the org is not shared with anyone: they could not stop sharing it any more. Unknown, private, pending,
// another org's, an ex-member's: the one `null` / left out. What each access may DO is the routes' rule
// (src/ai/ask/routes.ts); here is only who reaches what.

/** `t.handle` is still a member of this org (the membership row exists; a removed member's is gone). */
const OWNER_LIVE = `EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = ? AND m.user_id = t.handle)`;

/** What a person may do with a thread: it is theirs, or it is shared with them to continue, or to read. */
export type ThreadAccess = "owner" | AskShareAccess;

export interface ThreadFor {
  thread: ChatThreadRow;
  access: ThreadAccess;
  /** Shared with the person BY NAME (false for the owner, and for a thread they reach through the org only). */
  direct: boolean;
}

type SharedRow = ChatThreadRow & { person_access: AskShareAccess | null };

const sharedOf = (r: SharedRow): ThreadFor => {
  const { person_access, ...thread } = r;
  return { thread, access: person_access ?? "read", direct: person_access !== null };
};

/** The thread as `handle` reaches it — their own, or shared with them by name or with the org — else null. A name's
 *  access wins over the org's (`continue` is only ever given by name). */
export async function threadFor(ctx: TenantContext, handle: string, id: number): Promise<ThreadFor | null> {
  const own = await getThread(ctx, handle, id);
  if (own) return { thread: own, access: "owner", direct: false };
  const r = await first<SharedRow>(ctx,
    `SELECT t.*, p.access AS person_access FROM chat_threads t
       LEFT JOIN chat_thread_people p ON p.org_id = t.org_id AND p.thread_id = t.id AND p.handle = ? COLLATE NOCASE
      WHERE t.id = ? AND t.org_id = ? AND t.pending = 0 AND (t.shared_at IS NOT NULL OR p.handle IS NOT NULL) AND ${OWNER_LIVE}`,
    handle, id, ctx.orgId, ctx.orgId);
  return r ? sharedOf(r) : null;
}

/** OTHER people's threads the person reaches — shared with them by name, or with the org — newest share first
 *  (the person's own, shared or not, are in their own list). */
export async function listSharedThreads(ctx: TenantContext, handle: string, limit = 100): Promise<ThreadFor[]> {
  const rows = await all<SharedRow>(ctx,
    `SELECT t.*, p.access AS person_access FROM chat_threads t
       LEFT JOIN chat_thread_people p ON p.org_id = t.org_id AND p.thread_id = t.id AND p.handle = ? COLLATE NOCASE
      WHERE t.org_id = ? AND t.pending = 0 AND (t.shared_at IS NOT NULL OR p.handle IS NOT NULL) AND t.handle <> ? COLLATE NOCASE AND ${OWNER_LIVE}
      ORDER BY COALESCE(p.shared_at, t.shared_at) DESC, t.id DESC LIMIT ?`,
    handle, ctx.orgId, handle, ctx.orgId, limit);
  return rows.map(sharedOf);
}

/** The people each of these threads is shared with by name (the owner's list and Share dialog), in the order they
 *  were added. Threads with nobody are absent from the map. */
export async function threadPeople(ctx: TenantContext, threadIds: readonly number[]): Promise<Map<number, AskSharePerson[]>> {
  const out = new Map<number, AskSharePerson[]>();
  if (!threadIds.length) return out;
  const rows = await all<{ thread_id: number; handle: string; access: AskShareAccess }>(ctx,
    `SELECT thread_id, handle, access FROM chat_thread_people WHERE org_id = ? AND thread_id IN (${threadIds.map(() => "?").join(", ")})
      ORDER BY shared_at, rowid`, ctx.orgId, ...threadIds);
  for (const r of rows) {
    const list = out.get(r.thread_id) ?? [];
    list.push({ handle: r.handle, access: r.access });
    out.set(r.thread_id, list);
  }
  return out;
}

/** Which of these handles are members of this org, as stored (`persons.handle` spelling). */
export async function memberHandles(ctx: TenantContext, handles: readonly string[]): Promise<string[]> {
  if (!handles.length) return [];
  const rows = await all<{ user_id: string }>(ctx,
    `SELECT user_id FROM memberships WHERE org_id = ? AND user_id COLLATE NOCASE IN (${handles.map(() => "?").join(", ")})`, ctx.orgId, ...handles);
  return rows.map((r) => r.user_id);
}

/** Replace who the owner's thread is shared with by name: each person kept keeps when they were first added (a
 *  change of access is not a new share); the rest go. ONE batch. The caller checked every handle is a member and
 *  none is the owner. False when the thread is not the owner's. */
export async function setThreadPeople(ctx: TenantContext, owner: string, id: number, people: readonly AskSharePerson[], at: string = nowIso()): Promise<boolean> {
  if (!(await getThread(ctx, owner, id))) return false;
  const keep = people.map((x) => x.handle);
  await batch(ctx, [
    stmt(ctx, `DELETE FROM chat_thread_people WHERE org_id = ? AND thread_id = ?${keep.length ? ` AND handle COLLATE NOCASE NOT IN (${keep.map(() => "?").join(", ")})` : ""}`,
      ctx.orgId, id, ...keep),
    ...people.map((x) => stmt(ctx,
      `INSERT INTO chat_thread_people (org_id, thread_id, handle, access, shared_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(org_id, thread_id, handle) DO UPDATE SET access = excluded.access`,
      ctx.orgId, id, x.handle, x.access, at)),
  ]);
  return true;
}

/** Share (keeping the first share's time) or stop sharing — the owner's thread only. False when there is none. */
export async function setThreadShared(ctx: TenantContext, handle: string, id: number, shared: boolean, at: string = nowIso()): Promise<boolean> {
  const res = await run(ctx,
    `UPDATE chat_threads SET shared_at = ${shared ? "COALESCE(shared_at, ?)" : "NULL"} WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE AND pending = 0`,
    ...(shared ? [at] : []), id, ctx.orgId, handle);
  return (res.meta.changes ?? 0) > 0;
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
  const res = await run(ctx, `UPDATE chat_threads SET ${sets.join(", ")} WHERE id = ? AND org_id = ? AND handle = ? COLLATE NOCASE AND pending = 0`, ...vals, id, ctx.orgId, handle);
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
    stmt(ctx, `DELETE FROM chat_thread_people WHERE thread_id = ? AND org_id = ?`, id, ctx.orgId),
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
 * `settings: false` — the turn of a person the thread is shared with (0077): mode and Auto stay the owner's.
 */
export async function startTurn(ctx: TenantContext, threadId: number, mode: AskMode, auto: boolean, at: string = nowIso(), settings = true): Promise<number> {
  await batch(ctx, [
    stmt(ctx, `UPDATE chat_actions SET state = 'expired', decided_at = ? WHERE thread_id = ? AND org_id = ? AND state IN ('proposed', 'waiting')`, at, threadId, ctx.orgId),
    settings
      ? stmt(ctx, `UPDATE chat_threads SET turn = turn + 1, stop_requested = 0, mode = ?, auto_mode = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
        mode, auto ? 1 : 0, at, threadId, ctx.orgId)
      : stmt(ctx, `UPDATE chat_threads SET turn = turn + 1, stop_requested = 0, updated_at = ? WHERE id = ? AND org_id = ?`, at, threadId, ctx.orgId),
  ]);
  return (await first<{ turn: number }>(ctx, `SELECT turn FROM chat_threads WHERE id = ? AND org_id = ?`, threadId, ctx.orgId))?.turn ?? 0;
}

/** Stop: the running turn ends at its next step (the request's own abort covers a connection that is open). The
 *  caller checked the person may continue the thread (its owner, or shared with them to continue). */
export async function requestStop(ctx: TenantContext, id: number): Promise<boolean> {
  const res = await run(ctx, `UPDATE chat_threads SET stop_requested = 1 WHERE id = ? AND org_id = ? AND pending = 0`, id, ctx.orgId);
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
  /** Who asked the turn (the question's and its answer's). */
  askedBy?: string | null;
}

export async function insertMessage(ctx: TenantContext, threadId: number, m: NewMessage, at: string = nowIso()): Promise<number> {
  const res = await run(ctx,
    `INSERT INTO chat_messages (org_id, thread_id, role, mode, content_json, cites_json, attachments_json, model, tokens_in, tokens_out, tokens_cached, units, stopped, created_at, asked_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, threadId, m.role, m.mode, JSON.stringify(m.content ?? {}), JSON.stringify(m.cites ?? []), JSON.stringify(m.attachments ?? []),
    m.model ?? null, m.tokensIn ?? 0, m.tokensOut ?? 0, m.tokensCached ?? 0, m.units ?? 0, m.stopped ? 1 : 0, at, m.askedBy ?? null);
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

/** A live message of this org, whoever's thread it is in — for a route that then checks the person reaches that
 *  thread (`threadFor`) and asked that turn. */
export function messageInOrg(ctx: TenantContext, id: number): Promise<ChatMessageRow | null> {
  return first<ChatMessageRow>(ctx, `SELECT * FROM chat_messages WHERE id = ? AND org_id = ? AND replaced_at IS NULL`, id, ctx.orgId);
}

/** Who asked a turn: its `asked_by`, else (a row from before 0077) the thread's owner. */
export const askerOf = (row: { asked_by: string | null }, thread: Pick<ChatThreadRow, "handle">): string => row.asked_by ?? thread.handle;
export const sameHandle = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

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
  /** Who asked the turn that proposes it. */
  askedBy: string;
}

export async function insertAction(ctx: TenantContext, a: NewAction, at: string = nowIso()): Promise<number> {
  const res = await run(ctx,
    `INSERT INTO chat_actions (org_id, thread_id, turn, tool, kind, group_id, tool_use_id, args_json, preview_json, state, created_at, asked_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, a.threadId, a.turn, a.tool, a.kind, a.groupId, a.toolUseId, JSON.stringify(a.args ?? {}), JSON.stringify(a.preview ?? {}), a.state, at, a.askedBy);
  return Number(res.meta.last_row_id);
}

export type ActionWithTurn = ChatActionRow & { thread_turn: number };

/** A card of this org with its thread's current turn, or null — for a route that then checks the person reaches the
 *  thread (`threadFor`) and asked the card's turn. */
export function actionInOrg(ctx: TenantContext, id: number): Promise<ActionWithTurn | null> {
  return first<ActionWithTurn>(ctx,
    `SELECT a.*, t.turn AS thread_turn FROM chat_actions a JOIN chat_threads t ON t.id = a.thread_id AND t.org_id = a.org_id
      WHERE a.id = ? AND a.org_id = ? AND t.pending = 0`, id, ctx.orgId);
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

/** The thread's attachments named by `ids` that are NOT sent yet AND that `handle` uploaded (another thread's, a sent
 *  one, another person's — the owner's or someone the thread is shared with —, an unknown id: left out). */
export async function pendingAttachments(ctx: TenantContext, threadId: number, handle: string, ids: readonly number[]): Promise<ChatArtifactRow[]> {
  if (!ids.length) return [];
  const rows = await all<ChatArtifactRow>(ctx,
    `SELECT ca.* FROM chat_artifacts ca JOIN artifact_pages p ON p.id = ca.artifact_id AND p.org_id = ca.org_id
      WHERE ca.org_id = ? AND ca.thread_id = ? AND ca.role = 'attachment' AND ca.message_id IS NULL AND p.author_id = ? COLLATE NOCASE`,
    ctx.orgId, threadId, handle);
  return rows.filter((r) => ids.includes(r.id));
}

/** One of THIS thread's attachments (what `read_attachment` may read) with who attached it (its artifact's author):
 *  another thread's or org's is null. */
export function threadAttachment(ctx: TenantContext, threadId: number, id: number): Promise<(ChatArtifactRow & { author_id: string | null }) | null> {
  return first<ChatArtifactRow & { author_id: string | null }>(ctx,
    `SELECT ca.*, p.author_id FROM chat_artifacts ca LEFT JOIN artifact_pages p ON p.id = ca.artifact_id AND p.org_id = ca.org_id
      WHERE ca.id = ? AND ca.org_id = ? AND ca.thread_id = ? AND ca.role = 'attachment'`, id, ctx.orgId, threadId);
}

// ── pending attachments (0068_ask_pending; the owner's ruling Q60) ──────────
//
// A file uploaded before its conversation exists is linked to the person's hidden HOLDER thread (`pending = 1`):
// never listed, searched or opened (every thread read above leaves it out). Sending moves what the question names
// onto the real thread (`bindPendingAttachments`); what is never sent goes after 24 hours (src/deletion/ask.ts).

/** The person's holder thread in this org — made the first time it is needed. Two racing uploads may each make
 *  one; every read below takes all of the person's holders, so that costs nothing. */
export async function pendingHolder(ctx: TenantContext, handle: string, at: string = nowIso()): Promise<number> {
  const had = await first<{ id: number }>(ctx, `SELECT id FROM chat_threads WHERE org_id = ? AND handle = ? COLLATE NOCASE AND pending = 1 ORDER BY id LIMIT 1`, ctx.orgId, handle);
  if (had) return had.id;
  const res = await run(ctx,
    `INSERT INTO chat_threads (org_id, handle, mode, origin, pending, created_at, updated_at) VALUES (?, ?, 'smart', 'page', 1, ?, ?)`,
    ctx.orgId, handle, at, at);
  return Number(res.meta.last_row_id);
}

/** Move the person's PENDING attachments named by `ids` onto `threadId` (still unsent: the question marks them).
 *  Another person's, a sent one, one already on a thread: untouched. */
export async function bindPendingAttachments(ctx: TenantContext, handle: string, threadId: number, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  await run(ctx,
    `UPDATE chat_artifacts SET thread_id = ?
      WHERE org_id = ? AND role = 'attachment' AND message_id IS NULL AND id IN (${ids.map(() => "?").join(", ")})
        AND thread_id IN (SELECT id FROM chat_threads WHERE org_id = ? AND handle = ? COLLATE NOCASE AND pending = 1)`,
    threadId, ctx.orgId, ...ids, ctx.orgId, handle);
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
