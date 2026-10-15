// The AI tables' one repository (docs/architecture/ai.md): the org's switch (`orgs.ai_automation`,
// 0055_ai), what the model suggested (`ai_suggestions`) and the "Wrong?" people pressed
// (`ai_feedback`, 0055_ai). A TENANT module: every statement names `org_id = ?`, bound from the
// caller's context (test/data-layer.static.test.ts). Nothing here calls a model, and nothing reachable
// from src/mcp.ts imports it.
import type { AiCite, AiFeedbackBody, AiSuggestion, AiSuggestionState } from "@shared/ai";
import { all, batch, first, nowIso, run, stmt, type TenantContext } from "./sql";

// ── the switch ───────────────────────────────────────────────────────────────

/** Turn the org's AI on or off, audited (`org.ai`) in the same batch. The caller has checked the role. */
export async function setAiAutomation(ctx: TenantContext, enabled: boolean, at: string = nowIso()): Promise<void> {
  await batch(ctx, [
    stmt(ctx, `UPDATE orgs SET ai_automation = ? WHERE id = ?`, enabled ? 1 : 0, ctx.orgId),
    stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'org.ai', 'ai', ?, ?)`,
      ctx.orgId, ctx.userId, JSON.stringify({ enabled }), at),
  ]);
}

/** Allow or disallow Ask Trov's Auto mode in the org (`orgs.ai_chat_auto`, 0058), audited (`org.ai_chat_auto`)
 *  in the same batch. The caller has checked the role. */
export async function setAiChatAuto(ctx: TenantContext, on: boolean, at: string = nowIso()): Promise<void> {
  await batch(ctx, [
    stmt(ctx, `UPDATE orgs SET ai_chat_auto = ? WHERE id = ?`, on ? 1 : 0, ctx.orgId),
    stmt(ctx, `INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (?, ?, 'org.ai_chat_auto', 'ai', ?, ?)`,
      ctx.orgId, ctx.userId, JSON.stringify({ chatAuto: on }), at),
  ]);
}

// ── suggestions ──────────────────────────────────────────────────────────────

export interface AiSuggestionRow {
  id: number;
  item_type: string;
  item_ref: string;
  kind: string;
  value_json: string;
  confidence: number | null;
  reason: string;
  cites_json: string;
  model: string | null;
  prompt_version: string | null;
  state: AiSuggestionState;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
}

const SUGGESTION_COLS = `id, item_type, item_ref, kind, value_json, confidence, reason, cites_json, model, prompt_version, state, created_at, decided_by, decided_at`;

/** One of the org's suggestions by id — another org's id reads as not found. */
export function getSuggestion(ctx: TenantContext, id: number): Promise<AiSuggestionRow | null> {
  return first<AiSuggestionRow>(ctx, `SELECT ${SUGGESTION_COLS} FROM ai_suggestions WHERE id = ? AND org_id = ?`, id, ctx.orgId);
}

/** What a producer hands in. `reason` is required: a suggestion with no reason is never stored. */
export interface NewSuggestion {
  itemType: string;
  itemRef: string;
  kind: string;
  value: unknown;
  confidence: number | null;
  reason: string;
  cites: AiCite[];
  model: string | null;
  promptVersion: string | null;
}

/**
 * Store a suggestion, SUPERSEDING the open one of the same kind for the same item (a re-run replaces, never
 * piles up) — in one batch. A decided one (accepted / dismissed) is left alone: the person's choice stands.
 * Returns the new id, or null when there is no reason to give (nothing is written).
 */
export async function putSuggestion(ctx: TenantContext, s: NewSuggestion, at: string = nowIso()): Promise<number | null> {
  const reason = s.reason.trim();
  if (!reason) return null;
  const confidence = typeof s.confidence === "number" && Number.isFinite(s.confidence) ? Math.min(1, Math.max(0, s.confidence)) : null;
  const res = await batch<{ id: number }>(ctx, [
    stmt(ctx, `UPDATE ai_suggestions SET state = 'superseded' WHERE org_id = ? AND item_type = ? AND item_ref = ? AND kind = ? AND state = 'open'`,
      ctx.orgId, s.itemType, s.itemRef, s.kind),
    stmt(ctx, `INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, confidence, reason, cites_json, model, prompt_version, state, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?) RETURNING id`,
      ctx.orgId, s.itemType, s.itemRef, s.kind, JSON.stringify(s.value ?? null), confidence, reason, JSON.stringify(s.cites), s.model, s.promptVersion, at),
  ]);
  return res[1].results?.[0]?.id ?? null;
}

/** Decide an OPEN suggestion — one guarded UPDATE, so two people answering at once cannot both win.
 *  false = it was not open (or not this org's). */
export async function decideSuggestion(ctx: TenantContext, id: number, state: "accepted" | "dismissed", by: string, at: string = nowIso()): Promise<boolean> {
  const res = await run(ctx, `UPDATE ai_suggestions SET state = ?, decided_by = ?, decided_at = ? WHERE id = ? AND org_id = ? AND state = 'open'`,
    state, by, at, id, ctx.orgId);
  return (res.meta.changes ?? 0) > 0;
}

/** Undo an accept whose handler failed: back to open, only if it is still the accept `by` just made. */
export async function reopenSuggestion(ctx: TenantContext, id: number, by: string, at: string): Promise<void> {
  await run(ctx, `UPDATE ai_suggestions SET state = 'open', decided_by = NULL, decided_at = NULL
                   WHERE id = ? AND org_id = ? AND state = 'accepted' AND decided_by = ? AND decided_at = ?`, id, ctx.orgId, by, at);
}

const parse = <T>(json: string, fallback: T): T => {
  try { return JSON.parse(json) as T; } catch { return fallback; }
};

/** A row as the screens show it. `label` is the value in words — the kind's own; until a kind says how, the
 *  value as text. */
export function suggestionDto(r: AiSuggestionRow): AiSuggestion {
  const value = parse<unknown>(r.value_json, null);
  const cites = parse<unknown>(r.cites_json, []);
  return {
    id: r.id, itemType: r.item_type, itemRef: r.item_ref, kind: r.kind, value,
    label: typeof value === "string" ? value : JSON.stringify(value),
    reason: r.reason, confidence: r.confidence, cites: Array.isArray(cites) ? (cites as AiCite[]) : [], state: r.state,
  };
}

// ── "Wrong?" ─────────────────────────────────────────────────────────────────

/** Record that `handle` pressed "Wrong?" on an item — once per (person, item): pressing again writes nothing. */
export async function recordFeedback(ctx: TenantContext, handle: string, f: AiFeedbackBody, at: string = nowIso()): Promise<void> {
  await run(ctx,
    `INSERT INTO ai_feedback (org_id, handle, item_type, item_ref, kind, model, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(org_id, handle, item_type, item_ref) DO NOTHING`,
    ctx.orgId, handle, f.itemType, f.itemRef, f.kind, f.model, f.promptVersion, at);
}

/** The refs of `itemType` that `handle` marked "Wrong?" — what a producer leaves out of that person's screens. */
export async function hiddenFor(ctx: TenantContext, handle: string, itemType: string): Promise<Set<string>> {
  const rows = await all<{ item_ref: string }>(ctx,
    `SELECT item_ref FROM ai_feedback WHERE org_id = ? AND handle = ? AND item_type = ?`, ctx.orgId, handle, itemType);
  return new Set(rows.map((r) => r.item_ref));
}
