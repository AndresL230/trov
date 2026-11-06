import type { SprintRow, PlanRow } from "@shared/rows";
import type { SprintView } from "@shared/sprints";
import type { AiPlanDrift, AiSuggestion } from "@shared/ai-core";
import { composePlanNarrative, planNarrativeParts, normalizeSprintDate, sprintDateProblem, sprintDatesProblem, SPRINT_STATUSES, type PlanNarrativeInput } from "@shared/sprints-core";
import { type TenantContext, type Stmt, first, run, stmt, batch, nowIso } from "../data/sql";
import { list_sprints, sprintLead, SprintError } from "./sprints";
import { planDrift } from "../data/org-insights";

/**
 * One sprint as the ADMIN plan write receives it. This is the DTO vocabulary
 * (`label`, `due`), not the column names (`title`, `target_date`) — the seam is
 * documented in shared/sprints.ts and translated in write_plan below.
 */
export interface PlanSprintInput {
  id?: number; // present = update that sprint; absent = create
  label: string;
  summary?: string | null;
  description?: string | null;
  phase?: string | null;
  dates?: string | null;
  start?: string | null;                       // YYYY-MM-DD; absent = unchanged on an update, null/"" clears
  due: string;                                 // YYYY-MM-DD, or "" = unscheduled
  status: "upcoming" | "in_progress" | "done"; // any of the three (`complete_sprint` also sets 'done', for any member)
  urgency?: "low" | "normal" | "high";
  lead?: string | null;                        // person handle
  domain?: "notifications" | "tickets" | "gate" | "feed" | "search" | "infra" | null;
  github_ref?: number | number[] | null;
}

/** A plan write: the narrative's three parts (`now`, `next`, `later` — or an older client's `narrative` that
 *  already reads as them; shared/sprints-core `planNarrativeParts`) and the sprint entries. */
export interface PlanWrite extends PlanNarrativeInput {
  sprints: PlanSprintInput[];
}

export interface PlanView {
  narrative: string;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  sprints: SprintView[];
  /** What Trov wrote about where the work went against the plan (0065); absent with the switch off, nothing
   *  written, or a drift older than its window. */
  drift?: AiPlanDrift;
  /** The cookie read only, for an admin: the open Roadmap suggestions (a sprint draft, a narrative). Never MCP. */
  suggestions?: AiSuggestion[];
}

/** Every `sprints` column, as `plan_versions.sprints_json` snapshots each row (a full SprintRow, as `SELECT *` reads
 *  it). Built in SQL so the snapshot is taken inside the plan write's own batch; a test holds this list to the table. */
export const SPRINT_SNAPSHOT_COLUMNS = [
  "id", "title", "description", "target_date", "status", "github_ref", "created_at", "created_by", "updated_at", "phase",
  "dates", "summary", "urgency", "lead", "domain", "start_date", "org_id", "completed_at", "source_key",
] as const;

const githubRefJson = (ref: number | number[] | null | undefined): string | null =>
  ref === undefined || ref === null ? null : JSON.stringify(ref);

/**
 * ADMIN direct write (promote-class, like promote_doc — NOT the ingestion gate):
 * replace the plan narrative and create/update sprints (including status 'done' —
 * which `complete_sprint` also sets, for any member) in one non-destructively
 * versioned write. Sprints not mentioned are left untouched — never implicitly
 * deleted. `INSERT OR IGNORE` guards the singleton row for prod resilience (the
 * test harness never deletes it, but a fresh/drifted D1 might be missing it).
 *
 * Ticket membership of a sprint is NOT set here — that is the Tickets UI's job
 * (`POST /tickets/:id/sprint`). The plan write owns the sprint's own fields only.
 *
 * The narrative is ENFORCED HERE, for every caller (the owner's call, 2026-10-18): three parts — Now / Next /
 * Later — each a non-empty paragraph, composed into the ONE stored form (`composePlanNarrative`); a legacy
 * `narrative` string is taken only when it parses into them. Every refusal is decided BEFORE the first write, so a
 * refused plan writes nothing: a missing or empty part, a free-text narrative, or one over PLAN_NARRATIVE_MAX
 * (the composed text) is a `bad_request`, and an unknown sprint id is `no such sprint` — no plan row, no
 * plan_versions row, no sprint touched.
 * So are bad sprint dates (`bad_request`): `due` / `start` must each be a real
 * YYYY-MM-DD day or blank, and start <= due — checked against the STORED start when
 * an update omits `start`, so a new due cannot slip in before an existing start —
 * and a status that is not one of SPRINT_STATUSES.
 *
 * The write is ONE batch (a D1 transaction): every sprint, the plan row and its
 * `plan_versions` snapshot land together or not at all. The version is GUARDED: the
 * plan row moves only from the version this call read (compare-and-set), and the
 * snapshot's insert fails the whole batch when that did not take or the version is
 * already there — so two plan writes racing on one version cannot both apply: the
 * second is a `conflict` (409) with nothing written, never a half-applied plan and
 * a 500. Each sprint that becomes 'done' here gets `completed_at`; one that leaves
 * 'done' loses it.
 */
export async function write_plan(
  ctx: TenantContext,
  input: PlanWrite,
  author: string
): Promise<{ version: number; sprints: SprintRow[] }> {
  const shaped = planNarrativeParts(input);
  if ("problem" in shaped) throw new SprintError("bad_request", shaped.problem);
  const narrative = composePlanNarrative(shaped.parts);
  for (const sp of input.sprints) {
    if (!(SPRINT_STATUSES as readonly string[]).includes(sp.status)) {
      throw new SprintError("bad_request", `sprint "${sp.label}": status must be one of ${SPRINT_STATUSES.join(", ")}`);
    }
    const own = sprintDateProblem("start", sp.start) ?? sprintDateProblem("due", sp.due);
    if (own) throw new SprintError("bad_request", `sprint "${sp.label}": ${own}`);
    let start = sp.start;
    if (sp.id !== undefined) {
      const exists = await first<{ id: number; start_date: string | null }>(
        ctx, `SELECT id, start_date FROM sprints WHERE id = ? AND org_id = ?`, sp.id, ctx.orgId);
      if (!exists) throw new Error(`no such sprint: ${sp.id}`);
      if (start === undefined) start = exists.start_date;
    }
    // A stored start from before the rule is compared only when it is itself valid.
    if (sprintDateProblem("start", start)) continue;
    const order = sprintDatesProblem({ start, due: sp.due });
    if (order) throw new SprintError("bad_request", `sprint "${sp.label}": ${order}`);
  }
  // Every named lead is a member of this org (./sprints.ts `sprintLead`) — checked for the WHOLE plan
  // before the first write, and stored by canonical handle. Omitted stays unchanged; null clears.
  const leads = new Map<PlanWrite["sprints"][number], string | null | undefined>();
  for (const sp of input.sprints) leads.set(sp, await sprintLead(ctx, sp.lead));

  await run(ctx, `INSERT OR IGNORE INTO plan (org_id, narrative, current_version) VALUES (?, '', 0)`, ctx.orgId);

  const plan = await first<PlanRow>(ctx, `SELECT * FROM plan WHERE org_id = ?`, ctx.orgId);
  const base = plan?.current_version ?? 0;
  const version = base + 1;
  const now = nowIso();

  const stmts: Stmt[] = [];
  for (const sp of input.sprints) {
    const github_ref = githubRefJson(sp.github_ref);
    if (sp.id !== undefined) {
      // OMITTED means UNCHANGED. `label`, `due` and `status` are required on the
      // input, so they always overwrite. Every OPTIONAL column is written ONLY
      // when the caller actually supplied it: a plan write that names a sprint
      // without repeating its panel-authored fields (`summary`, `dates`,
      // `urgency`, `lead`, `domain`, `phase`, `description`, `github_ref`) leaves
      // them exactly as they were — `POST /sprints` (the Roadmap's New sprint
      // panel) writes those too, and the plan write must not clobber them.
      // An EXPLICIT `null` still CLEARS the column: `undefined` (absent) and
      // `null` (cleared) are distinct here, and that distinction is the contract.
      // `completed_at` (0089) follows the status: kept while it stays 'done', stamped when it becomes 'done', cleared
      // otherwise (every SET expression reads the row as it WAS, so `status` here is the old one).
      const sets: string[] = [`title = ?`, `target_date = ?`, `status = ?`, `updated_at = ?`,
        `completed_at = CASE WHEN ? <> 'done' THEN NULL WHEN status = 'done' THEN COALESCE(completed_at, ?) ELSE ? END`];
      const binds: unknown[] = [sp.label, normalizeSprintDate(sp.due) ?? "", sp.status, now, sp.status, now, now];
      const optional: [string, unknown][] = [
        ["description", sp.description],
        ["summary", sp.summary],
        ["phase", sp.phase],
        ["dates", sp.dates],
        ["start_date", sp.start === undefined ? undefined : normalizeSprintDate(sp.start)],
        ["urgency", sp.urgency],
        ["lead", leads.get(sp)],
        ["domain", sp.domain],
        ["github_ref", sp.github_ref === undefined ? undefined : github_ref],
      ];
      for (const [col, value] of optional) {
        if (value === undefined) continue;
        sets.push(`${col} = ?`);
        binds.push(value);
      }
      stmts.push(stmt(ctx, `UPDATE sprints SET ${sets.join(", ")} WHERE id = ? AND org_id = ?`, ...binds, sp.id, ctx.orgId));
    } else {
      stmts.push(stmt(
        ctx,
        `INSERT INTO sprints (org_id, title, description, summary, phase, dates, start_date, target_date, status, urgency, lead, domain,
                              github_ref, created_at, created_by, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ctx.orgId,
        sp.label,
        sp.description ?? null,
        sp.summary ?? null,
        sp.phase ?? null,
        sp.dates ?? null,
        normalizeSprintDate(sp.start),
        normalizeSprintDate(sp.due) ?? "",
        sp.status,
        sp.urgency ?? "normal",
        leads.get(sp) ?? null,
        sp.domain ?? null,
        github_ref,
        now,
        author,
        now,
        sp.status === "done" ? now : null
      ));
    }
  }

  // The guarded version: the plan row moves only from `base`; the snapshot right after it inserts a NULL version
  // (NOT NULL — the batch fails and rolls back) when that UPDATE did not take, and collides on the
  // (org_id, version) key when another write already made this version. Either way nothing of this call lands.
  stmts.push(stmt(ctx,
    `UPDATE plan SET narrative = ?, current_version = ?, updated_at = ?, updated_by = ? WHERE org_id = ? AND current_version = ?`,
    narrative, version, now, author, ctx.orgId, base));
  stmts.push(stmt(ctx,
    `INSERT INTO plan_versions (org_id, version, narrative, sprints_json, created_at, created_by)
     SELECT ?, CASE WHEN changes() > 0 THEN ? END, ?,
            (SELECT json_group_array(json_object(${SPRINT_SNAPSHOT_COLUMNS.map((c) => `'${c}', ${c}`).join(", ")}))
               FROM (SELECT * FROM sprints WHERE org_id = ? ORDER BY target_date ASC, id ASC)),
            ?, ?`,
    ctx.orgId, version, narrative, ctx.orgId, now, author));
  stmts.push(stmt(ctx, `SELECT * FROM sprints WHERE org_id = ? ORDER BY target_date ASC, id ASC`, ctx.orgId));

  let results;
  try {
    results = await batch<SprintRow>(ctx, stmts);
  } catch (e) {
    const err = e as { message?: unknown; cause?: { message?: unknown } } | null;
    if (/constraint failed: plan_versions/i.test(`${String(err?.message ?? e)} ${String(err?.cause?.message ?? "")}`)) {
      throw new SprintError("conflict", "the plan changed while this write was in flight: read it again (get_roadmap) and retry");
    }
    throw e;
  }
  const sprints = results[results.length - 1].results;
  return { version, sprints };
}

/**
 * Read the admin plan: narrative + version metadata, plus every sprint
 * (target_date ASC, id ASC, unscheduled last — the roadmap's order) as a
 * SprintView. NO GitHub, NO token — read-only against D1. Returns a default
 * empty view if the plan singleton row is missing.
 *
 * The sprint half is `list_sprints` (tools/sprints.ts), so `progress` is the
 * sprint's TICKETS ONLY (done + declined over total), `issues` is the cached,
 * event-derived GitHub issue count behind it (or null), and `members` is the
 * sprint's real distinct assignees.
 * One read model, shared by GET /roadmap, MCP get_roadmap and GET /sprints.
 */
export async function get_plan(ctx: TenantContext, now: Date = new Date()): Promise<PlanView> {
  const plan = await first<PlanRow>(ctx, `SELECT * FROM plan WHERE org_id = ?`, ctx.orgId);
  const sprints = await list_sprints(ctx, now);
  // What Trov wrote about where the work went (0065): absent with the switch off, nothing written, or aged out.
  const drift = await planDrift(ctx, now);

  return {
    narrative: plan?.narrative ?? "",
    version: plan?.current_version ?? 0,
    updated_at: plan?.updated_at ?? null,
    updated_by: plan?.updated_by ?? null,
    sprints,
    ...(drift ? { drift } : {}),
  };
}
