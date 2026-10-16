// What Trov WROTE about the roadmap (0065_org_insights; docs/architecture/roadmap-my-work.md › Roadmap
// intelligence): sprint notes and plan drift — computed writes of the AI pass's org rollup (src/ai/roadmap.ts) —
// and the Roadmap's open suggestions (`ai_suggestions`, kinds `sprint_draft` / `plan_narrative`).
//
// A TENANT module: every statement names `org_id`, bound from the caller's context. The READS are reachable from
// src/mcp.ts (`get_roadmap`, `list_sprints`, `get_sprint` carry the notes and the drift), so this file imports
// nothing from src/ai/ and calls no model. Every read is GATED BY THE READ RULE (src/plans/gate.ts `aiShown`): the
// org's switch in the same statement (`orgs.ai_automation`) and an Anthropic key on the deployment — with AI off or no
// key the fields are absent, never an "off" state; at the month's cap a line is its last version, `state: "capped"`.
import {
  AI_DRIFT_WINDOW_DAYS, AI_ROADMAP_ITEM, AI_ROADMAP_SUGGESTION_KINDS, AiPlanDriftSchema, AiRoadmapLineSchema,
  type AiCite, type AiPlanDrift, type AiRoadmapLine, type AiSprintNote, type AiSuggestion, type AiThemeShare,
} from "@shared/ai";
import { all, batch, first, nowIso, stmt, type TenantContext } from "./sql";
import { suggestionDto, type AiSuggestionRow } from "./ai";
import { aiKeySet } from "./context";
import { aiShown } from "../plans/gate";

export type InsightKind = "sprint_note" | "plan_drift";
/** How many versions of one insight are kept (the newest is what the Roadmap reads). */
export const INSIGHT_KEEP = 10;

export interface InsightPayload { text: string; cites: AiCite[]; windowDays?: number; shares?: AiThemeShare[] }

/**
 * Store a new version of one insight — `version` = the key's newest + 1 — and delete every version past the
 * last `INSIGHT_KEEP`, in ONE batch. A computed write (promote class), never a suggestion.
 */
export async function putInsight(
  ctx: TenantContext, kind: InsightKind, key: string, payload: InsightPayload, meta: { model: string | null; promptVersion: string | null }, at: string = nowIso(),
): Promise<void> {
  await batch(ctx, [
    stmt(ctx, `INSERT INTO org_insights (org_id, kind, key, version, generated_at, model, prompt_version, json)
               SELECT ?, ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ? FROM org_insights WHERE org_id = ? AND kind = ? AND key = ?`,
      ctx.orgId, kind, key, at, meta.model, meta.promptVersion, JSON.stringify(payload), ctx.orgId, kind, key),
    stmt(ctx, `DELETE FROM org_insights WHERE org_id = ? AND kind = ? AND key = ?
                 AND version <= (SELECT MAX(version) FROM org_insights WHERE org_id = ? AND kind = ? AND key = ?) - ?`,
      ctx.orgId, kind, key, ctx.orgId, kind, key, INSIGHT_KEEP),
  ]);
}

interface InsightRow { key: string; generated_at: string; model: string | null; json: string }

/** What THE read rule (src/plans/gate.ts `aiShown`) adds to a line at the month's cap: the LAST version, said capped. */
type LineCap = Pick<AiRoadmapLine, "state" | "resumesOn" | "upgrade">;

/** The "Wrong?" ref of an insight row, in SQL — `aiItemRef.sprintNote` (`<sprint id>@<generatedAt>`) and
 *  `aiItemRef.planDrift` (`<generatedAt>`), the refs the Roadmap's buttons send. */
const FEEDBACK_REF: Record<InsightKind, string> = { sprint_note: `i.key || '@' || i.generated_at`, plan_drift: `i.generated_at` };

/**
 * The newest version of each key of `kind` (one key when given) — only under THE read rule: the org's switch on (the
 * join, in the same statement) and an Anthropic key on the deployment (no key: nothing is read). When a row comes
 * back, the rule's one statement says whether the month's `ai_runs` are spent (Q19: every surface says `capped`).
 * A PERSON's context (not the pass's system one) never gets a version they pressed "Wrong?" on — in the same
 * statement, so every surface leaves it out: the cookie Roadmap and `/sprints`, and MCP's `get_roadmap`,
 * `list_sprints` and `get_sprint` (owner ruling Q-S2 / RM-14: "Wrong?" hides an item for that person everywhere).
 */
async function latest(ctx: TenantContext, kind: InsightKind, key?: string, now: Date = new Date()): Promise<{ rows: InsightRow[]; cap: LineCap }> {
  if (!aiKeySet(ctx)) return { rows: [], cap: {} };
  const viewer = ctx.role === "system" ? null : ctx.userId;
  const rows = await all<InsightRow>(ctx,
    `SELECT i.key AS key, i.generated_at AS generated_at, i.model AS model, i.json AS json
       FROM org_insights i JOIN orgs o ON o.id = i.org_id AND o.ai_automation = 1
      WHERE i.org_id = ? AND i.kind = ?${key === undefined ? "" : " AND i.key = ?"}
        AND i.version = (SELECT MAX(v.version) FROM org_insights v WHERE v.org_id = ? AND v.kind = i.kind AND v.key = i.key)${viewer === null ? "" : `
        AND NOT EXISTS (SELECT 1 FROM ai_feedback f WHERE f.org_id = i.org_id AND f.handle = ? AND f.item_type = i.kind AND f.item_ref = ${FEEDBACK_REF[kind]})`}`,
    ...(key === undefined ? [ctx.orgId, kind, ctx.orgId] : [ctx.orgId, kind, key, ctx.orgId]), ...(viewer === null ? [] : [viewer]));
  if (!rows.length) return { rows, cap: {} };
  const gate = await aiShown(ctx, now);
  if (!gate.shown) return { rows: [], cap: {} };
  return { rows, cap: gate.capped ? { state: "capped", resumesOn: gate.resumesOn, upgrade: gate.upgrade } : {} };
}

const parse = (json: string): unknown => { try { return JSON.parse(json); } catch { return null; } };

/** One stored line as the screens get it, or null when the row does not read as one (never shown half-made). */
function lineOf(r: InsightRow, cap: LineCap): AiSprintNote | null {
  const p = parse(r.json) as { text?: unknown; cites?: unknown } | null;
  const ok = AiRoadmapLineSchema.safeParse({ text: p?.text, cites: p?.cites, generatedAt: r.generated_at, model: r.model, ...cap });
  return ok.success ? ok.data : null;
}

/** The newest note per sprint id (as text), or for one sprint. Empty under THE read rule's off. A read that fails is
 *  empty too: a note is never worth failing the Roadmap for. */
export async function sprintNotes(ctx: TenantContext, sprintId?: number): Promise<Map<string, AiSprintNote>> {
  const out = new Map<string, AiSprintNote>();
  try {
    const { rows, cap } = await latest(ctx, "sprint_note", sprintId === undefined ? undefined : String(sprintId));
    for (const r of rows) {
      const line = lineOf(r, cap);
      if (line) out.set(r.key, line);
    }
  } catch (e) {
    console.error("org insights: notes read failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
  }
  return out;
}

/** The newest drift line, while it still describes the window it was written for (`AI_DRIFT_WINDOW_DAYS`); null
 *  under THE read rule's off, nothing written, or a drift that has aged out. */
export async function planDrift(ctx: TenantContext, now: Date = new Date()): Promise<AiPlanDrift | null> {
  try {
    const { rows: [r], cap } = await latest(ctx, "plan_drift", "", now);
    if (!r) return null;
    const at = Date.parse(r.generated_at);
    if (!Number.isFinite(at) || now.getTime() - at > AI_DRIFT_WINDOW_DAYS * 86_400_000) return null;
    const p = parse(r.json) as Record<string, unknown> | null;
    const ok = AiPlanDriftSchema.safeParse({ ...p, generatedAt: r.generated_at, model: r.model, ...cap });
    return ok.success ? ok.data : null;
  } catch (e) {
    console.error("org insights: drift read failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    return null;
  }
}

/** The kind's own words for a Roadmap suggestion's label (`suggestionDto` would print its JSON). */
function roadmapLabel(s: AiSuggestion): string {
  if (s.kind === "sprint_draft") {
    // A stored value is not trusted to be the shape: one that is not a list labels as none (the screen skips the
    // card), never a throw that would take every other suggestion with it.
    const raw = (s.value as { sprints?: unknown } | null)?.sprints;
    const sprints = Array.isArray(raw) ? (raw as ({ tickets?: unknown[] } | null)[]) : [];
    const tickets = sprints.reduce((n, sp) => n + (Array.isArray(sp?.tickets) ? sp.tickets.length : 0), 0);
    return `${sprints.length} ${sprints.length === 1 ? "sprint" : "sprints"} from ${tickets} backlog ${tickets === 1 ? "ticket" : "tickets"}`;
  }
  return "a new plan narrative";
}

/** The Roadmap's OPEN suggestions (newest first), only under THE read rule (the switch, joined; the key). The CALLER decides who sees them
 *  (an admin, on the cookie read — never MCP). */
export async function roadmapSuggestions(ctx: TenantContext): Promise<AiSuggestion[]> {
  if (!aiKeySet(ctx)) return [];
  try {
    const rows = await all<AiSuggestionRow>(ctx,
      `SELECT s.id, s.item_type, s.item_ref, s.kind, s.value_json, s.confidence, s.reason, s.cites_json, s.model, s.prompt_version,
              s.state, s.created_at, s.decided_by, s.decided_at
         FROM ai_suggestions s JOIN orgs o ON o.id = s.org_id AND o.ai_automation = 1
        WHERE s.org_id = ? AND s.item_type = ? AND s.item_ref = ? AND s.state = 'open' AND s.kind IN (${AI_ROADMAP_SUGGESTION_KINDS.map(() => "?").join(", ")})
        ORDER BY s.created_at DESC, s.id DESC LIMIT 10`,
      ctx.orgId, AI_ROADMAP_ITEM.itemType, AI_ROADMAP_ITEM.itemRef, ...AI_ROADMAP_SUGGESTION_KINDS);
    return rows.map(suggestionDto).map((s) => ({ ...s, label: roadmapLabel(s) }));
  } catch (e) {
    console.error("org insights: suggestions read failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`);
    return [];
  }
}

/** When this org last got a suggestion of `kind` for its plan (any state), or null — what keeps the weekly
 *  narrative weekly and a dismissed draft from coming straight back. */
export async function lastRoadmapSuggestionAt(ctx: TenantContext, kind: string): Promise<{ at: string; open: boolean } | null> {
  const r = await first<{ created_at: string; open: number }>(ctx,
    `SELECT created_at, CASE WHEN state = 'open' THEN 1 ELSE 0 END AS open FROM ai_suggestions
      WHERE org_id = ? AND item_type = ? AND item_ref = ? AND kind = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ctx.orgId, AI_ROADMAP_ITEM.itemType, AI_ROADMAP_ITEM.itemRef, kind);
  return r ? { at: r.created_at, open: r.open === 1 } : null;
}

/** The Roadmap as ONE PERSON gets it on the cookie read: an ADMIN also gets the open suggestions. MCP never comes here
 *  (no suggestions there). What they pressed "Wrong?" on is already left out by the read itself (`latest`), on every
 *  surface. */
export async function roadmapForPerson<P extends { suggestions?: AiSuggestion[] }>(ctx: TenantContext, plan: P, o: { admin: boolean }): Promise<P> {
  if (!o.admin) return plan;
  const suggestions = await roadmapSuggestions(ctx);
  return suggestions.length ? { ...plan, suggestions } : plan;
}
