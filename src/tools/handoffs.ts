// Handoffs — addressed messages from one session to the next (0028).
//
// NOT the ingestion gate: a handoff is not knowledge, so it carries no vocab or
// confidence and is never staged. Its writers are direct, like the ticket
// writers, with three rules of their own:
//   · the SENDER is always the authenticated principal, never the body's;
//   · a claim is ONE conditional UPDATE (`… WHERE status = 'pending' AND <may
//     claim>`), so two sessions racing on an `anyone` handoff cannot both win;
//   · a create that carries a session id is replay-safe through processed_items,
//     keyed exactly like /ingest and record_session (session id + item index).
//
// A handoff is still addressed by its row id, always inside the caller's org (another
// org's id reads as not found). The per-org `number` (0038, Q2) is allocated by the
// insert trigger on every row; nothing here reads it yet.

import { z } from "zod";
import { all, first, run, nowIso, type TenantContext } from "../data/sql";
import { legacyDb } from "../data/legacy";
import { append_feed } from "./writes";
import { legacyCtx } from "../data/legacy-bridge";
import { getPerson } from "../auth/persons";
import {
  EMPTY_CONTEXT, firstLine,
  type HandoffBox, type HandoffContext, type HandoffStatus, type HandoffView,
} from "@shared/handoffs";

export class HandoffError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request" | "forbidden", message: string) {
    super(message);
    this.name = "HandoffError";
  }
}
export const HANDOFF_ERROR_STATUS = { not_found: 404, conflict: 409, bad_request: 400, forbidden: 403 } as const;

/** 32 KB of UTF-8 — a summary, not a transcript (long instructions go in the prompt). */
export const HANDOFF_BODY_MAX = 32 * 1024;
/** A pending handoff expires this long after it was sent (the cron flips it). */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const Strings = z.array(z.string().max(2000)).max(200);
export const HandoffCreateInput = z.object({
  recipient: z.string().trim().min(1).max(64).optional(),
  body: z.string().refine((b) => b.trim().length > 0, "body required")
    .refine((b) => new TextEncoder().encode(b).length <= HANDOFF_BODY_MAX, "body over 32KB"),
  context: z.object({
    repo: z.string().max(200).optional(),
    branch: z.string().max(200).optional(),
    task: z.string().max(500).optional(),
    done: Strings.optional(),
    next: Strings.optional(),
    files: Strings.optional(),
  }).optional(),
  // Both or neither: an empty prompt is `null` (or absent).
  prompt: z.object({ title: z.string().trim().min(1).max(200), body: z.string().min(1).max(HANDOFF_BODY_MAX) }).nullable().optional(),
});
export type HandoffCreateInput = z.infer<typeof HandoffCreateInput>;

interface HandoffRow {
  id: number; sender: string; recipient: string; status: HandoffStatus; body: string; context: string;
  prompt_title: string | null; prompt_body: string | null;
  created_at: string; claimed_at: string | null; claimed_by: string | null; claimed_by_session: string | null;
  expires_at: string;
}

function parseContext(json: string): HandoffContext {
  let v: Record<string, unknown> = {};
  try { const p: unknown = JSON.parse(json); if (p && typeof p === "object" && !Array.isArray(p)) v = p as Record<string, unknown>; } catch { /* malformed → empty */ }
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  return { repo: str("repo"), branch: str("branch"), task: str("task"), done: list("done"), next: list("next"), files: list("files") };
}

export function toHandoffView(r: HandoffRow): HandoffView {
  return {
    id: r.id, sender: r.sender, recipient: r.recipient, status: r.status,
    created_at: r.created_at, claimed_at: r.claimed_at, claimed_by: r.claimed_by, claimed_by_session: r.claimed_by_session,
    prompt: r.prompt_title !== null && r.prompt_body !== null ? { title: r.prompt_title, body: r.prompt_body } : null,
    body: r.body, context: parseContext(r.context),
  };
}

// `?1` is the caller; the org predicate follows it in the statement, so its `?` binds second.
const BOX_WHERE: Record<HandoffBox, string> = {
  mine: "(recipient = ?1 COLLATE NOCASE OR sender = ?1 COLLATE NOCASE)",
  me: "recipient = ?1 COLLATE NOCASE",
  anyone: "recipient = 'anyone' AND sender <> ?1 COLLATE NOCASE",
  sent: "sender = ?1 COLLATE NOCASE",
};

/** The caller's handoffs in one box, newest first. `statuses` narrows (the MCP list reads pending only). */
export async function listHandoffs(ctx: TenantContext, me: string, box: HandoffBox, statuses?: HandoffStatus[]): Promise<HandoffView[]> {
  const st = statuses && statuses.length ? ` AND status IN (${statuses.map((s) => `'${s}'`).join(", ")})` : "";
  const rows = await all<HandoffRow>(ctx, `SELECT * FROM handoffs WHERE ${BOX_WHERE[box]} AND org_id = ?${st} ORDER BY created_at DESC, id DESC`, me, ctx.orgId);
  return rows.map(toHandoffView);
}

/** One handoff of the org; another org's id reads as absent. */
export async function getHandoff(ctx: TenantContext, id: number): Promise<HandoffView | null> {
  const r = await first<HandoffRow>(ctx, `SELECT * FROM handoffs WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  return r ? toHandoffView(r) : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Leave a handoff. `ledger` (an agent's session id + item index) makes a retried
 * call return the FIRST call's handoff instead of writing a second row.
 */
export async function createHandoff(
  ctx: TenantContext, sender: string, input: HandoffCreateInput, ledger?: { sessionId: string; itemIndex: number },
): Promise<{ handoff: HandoffView; replayed: boolean }> {
  if (ledger) {
    const hit = await first<{ ref: string | null }>(ctx, `SELECT ref FROM processed_items WHERE org_id = ? AND session_id = ? AND item_index = ?`, ctx.orgId, ledger.sessionId, ledger.itemIndex);
    if (hit) {
      const prior = hit.ref ? await getHandoff(ctx, Number(hit.ref)) : null;
      if (prior) return { handoff: prior, replayed: true };
      throw new HandoffError("conflict", "this session item was already recorded");
    }
  }
  let recipient = input.recipient ?? "anyone";
  if (recipient.toLowerCase() === "anyone") recipient = "anyone";
  else {
    const p = await getPerson(legacyDb(ctx), recipient.replace(/^@/, ""));
    if (!p) throw new HandoffError("bad_request", `unknown recipient: ${recipient}`);
    recipient = p.handle;
  }
  const c = { ...EMPTY_CONTEXT, ...(input.context ?? {}) };
  const context: HandoffContext = {
    repo: c.repo ?? "", branch: c.branch ?? "", task: c.task ?? "",
    done: c.done ?? [], next: c.next ?? [], files: c.files ?? [],
  };
  const now = new Date();
  const created_at = now.toISOString();
  const expires_at = new Date(now.getTime() + HANDOFF_TTL_MS).toISOString();
  const res = await run(
    ctx,
    `INSERT INTO handoffs (org_id, sender, recipient, status, body, context, prompt_title, prompt_body, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, sender, recipient, input.body, JSON.stringify(context),
    input.prompt?.title ?? null, input.prompt?.body ?? null, created_at, expires_at,
  );
  const id = res.meta.last_row_id as number;
  if (ledger) {
    await run(ctx, `INSERT OR IGNORE INTO processed_items (org_id, session_id, item_index, item_type, outcome, ref, created_at) VALUES (?, ?, ?, 'handoff', 'written', ?, ?)`,
      ctx.orgId, ledger.sessionId, ledger.itemIndex, String(id), created_at);
  }
  // The feed shows the handoff happened (who → whom, and its title). Direct
  // writer, no tags: an addressed message is not topic-tagged knowledge.
  await append_feed(ctx, {
    author: sender,
    summary: `${sender} left a handoff for ${recipient === "anyone" ? "anyone" : recipient}: #${id} ${firstLine(input.body)}`.slice(0, 300),
    body: context.task ? `Task: ${context.task}${context.branch ? ` (\`${context.branch}\`)` : ""}` : undefined,
  });
  return { handoff: (await getHandoff(ctx, id))!, replayed: false };
}

/** After a guarded UPDATE touched nothing, say why: unknown, not yours, or no longer pending. */
async function explainMiss(ctx: TenantContext, id: number, allowed: (r: HandoffRow) => boolean): Promise<never> {
  const r = await first<HandoffRow>(ctx, `SELECT * FROM handoffs WHERE id = ? AND org_id = ?`, id, ctx.orgId);
  if (!r) throw new HandoffError("not_found", "handoff not found");
  if (!allowed(r)) throw new HandoffError("forbidden", "not your handoff");
  throw new HandoffError("conflict", `handoff is ${r.status}`);
}

/**
 * Claim atomically: ONE statement flips pending → claimed only when the caller
 * may claim it (the recipient, anyone for an `anyone` handoff, or the sender).
 * Two racing claims: exactly one UPDATE changes a row; the other re-reads and
 * gets `handoff is claimed`.
 */
export async function claimHandoff(ctx: TenantContext, id: number, me: string, session: string): Promise<HandoffView> {
  const res = await run(
    ctx,
    `UPDATE handoffs SET status = 'claimed', claimed_at = ?, claimed_by = ?, claimed_by_session = ?
     WHERE id = ? AND org_id = ? AND status = 'pending'
       AND (recipient = 'anyone' OR recipient = ? COLLATE NOCASE OR sender = ? COLLATE NOCASE)`,
    nowIso(), me, session, id, ctx.orgId, me, me,
  );
  if (!res.meta.changes) await explainMiss(ctx, id, (r) => r.recipient === "anyone" || same(r.recipient, me) || same(r.sender, me));
  return (await getHandoff(ctx, id))!;
}

/** Expire by hand: only the sender or the named recipient, pending only. */
export async function expireHandoff(ctx: TenantContext, id: number, me: string): Promise<HandoffView> {
  const res = await run(
    ctx,
    `UPDATE handoffs SET status = 'expired'
     WHERE id = ? AND org_id = ? AND status = 'pending' AND (sender = ? COLLATE NOCASE OR recipient = ? COLLATE NOCASE)`,
    id, ctx.orgId, me, me,
  );
  if (!res.meta.changes) await explainMiss(ctx, id, (r) => same(r.sender, me) || same(r.recipient, me));
  return (await getHandoff(ctx, id))!;
}

/** The cron sweep: every pending handoff of the org past its expires_at. Returns how many flipped. */
export async function expireDueHandoffs(ctx: TenantContext, nowMs: number): Promise<number> {
  const res = await run(ctx, `UPDATE handoffs SET status = 'expired' WHERE org_id = ? AND status = 'pending' AND expires_at < ?`, ctx.orgId, new Date(nowMs).toISOString());
  return res.meta.changes ?? 0;
}

/**
 * The claim_handoff result: ONE markdown block an agent can act on — the prompt
 * first (the instructions), then the summary, then the context as lists.
 */
export function handoffAsTask(h: HandoffView): string {
  const c = h.context;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const parts: string[] = [];
  if (h.prompt) parts.push(h.prompt.body.trim());
  parts.push(`## Handoff summary\n\n${h.body.trim()}`);
  parts.push([
    "## Context",
    "",
    `- Repo: ${c.repo || "(none)"}`,
    `- Branch: ${c.branch || "(none)"}`,
    `- Task: ${c.task || "(none)"}`,
    "",
    "### Done",
    list(c.done),
    "",
    "### Next",
    list(c.next),
    "",
    "### Files",
    list(c.files),
  ].join("\n"));
  return parts.join("\n\n");
}
