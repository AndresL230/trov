// Projects' rows (0086_projects; docs/architecture/projects.md). A TENANT module: every statement names `org_id`,
// bound from the caller's context (CLAUDE.md invariant 4). WHO may open or change a project is src/tools/projects.ts's
// rule (`accessOf`); here is only what is stored. A deleted project (`deleted_at`) is read by nothing but the slug
// check — its slug stays reserved (invariant 11). The threads' half (which of a project's threads a person reaches)
// lives with Ask's own rule in src/data/ask.ts.
import { all, batch, first, nowIso, run, stmt, type Stmt, type TenantContext } from "./sql";
import type { ProjectRole, ProjectVisibility } from "@shared/projects-core";

export interface ProjectRow {
  id: number;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  instructions: string;
  visibility: ProjectVisibility;
  owner: string;
  archived_at: string | null;
  archived_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A project with the reading person's member row, when they have one (`member_role`). */
export type ProjectForRow = ProjectRow & { member_role: ProjectRole | null };

export interface ProjectMemberRow { project_id: number; handle: string; role: ProjectRole; added_by: string; added_at: string }
export interface ProjectPinRow { id: number; project_id: number; ref: string; added_by: string; added_at: string }

const COLS = `p.id, p.slug, p.name, p.description, p.icon, p.color, p.instructions, p.visibility, p.owner, p.archived_at, p.archived_by, p.deleted_at, p.created_at, p.updated_at`;

/** A LIVE (not deleted) project by slug, with `handle`'s member row — or null. Archived projects are returned. */
export function projectBySlug(ctx: TenantContext, handle: string, slug: string): Promise<ProjectForRow | null> {
  return first<ProjectForRow>(ctx,
    `SELECT ${COLS}, m.role AS member_role FROM projects p
       LEFT JOIN project_members m ON m.org_id = p.org_id AND m.project_id = p.id AND m.handle = ? COLLATE NOCASE
      WHERE p.org_id = ? AND p.slug = ? AND p.deleted_at IS NULL`, handle, ctx.orgId, slug);
}

/** A LIVE project by id, with `handle`'s member row — or null. */
export function projectById(ctx: TenantContext, handle: string, id: number): Promise<ProjectForRow | null> {
  return first<ProjectForRow>(ctx,
    `SELECT ${COLS}, m.role AS member_role FROM projects p
       LEFT JOIN project_members m ON m.org_id = p.org_id AND m.project_id = p.id AND m.handle = ? COLLATE NOCASE
      WHERE p.org_id = ? AND p.id = ? AND p.deleted_at IS NULL`, handle, ctx.orgId, id);
}

/** Live projects by id (each with `handle`'s member row) — for a thread list's project marks. */
export async function projectsByIds(ctx: TenantContext, handle: string, ids: readonly number[]): Promise<ProjectForRow[]> {
  if (!ids.length) return [];
  return all<ProjectForRow>(ctx,
    `SELECT ${COLS}, m.role AS member_role FROM projects p
       LEFT JOIN project_members m ON m.org_id = p.org_id AND m.project_id = p.id AND m.handle = ? COLLATE NOCASE
      WHERE p.org_id = ? AND p.deleted_at IS NULL AND p.id IN (${ids.map(() => "?").join(", ")})`, handle, ctx.orgId, ...ids);
}

/**
 * Every live project `handle` MAY be able to open — theirs, an `org` one, or a `members` one they are a member of —
 * most recently updated first. The final word is src/tools/projects.ts `accessOf` (this is its pre-filter: a row
 * not returned here is one it would refuse).
 */
export function projectsFor(ctx: TenantContext, handle: string): Promise<ProjectForRow[]> {
  return all<ProjectForRow>(ctx,
    `SELECT ${COLS}, m.role AS member_role FROM projects p
       LEFT JOIN project_members m ON m.org_id = p.org_id AND m.project_id = p.id AND m.handle = ? COLLATE NOCASE
      WHERE p.org_id = ? AND p.deleted_at IS NULL
        AND (p.owner = ? COLLATE NOCASE OR p.visibility = 'org' OR (p.visibility = 'members' AND m.handle IS NOT NULL))
      ORDER BY p.updated_at DESC, p.id DESC`, handle, ctx.orgId, handle);
}

/** Is `slug` taken in this org — by a live, archived OR deleted project (a deleted slug stays reserved)? */
export async function slugTaken(ctx: TenantContext, slug: string): Promise<boolean> {
  return !!(await first<{ id: number }>(ctx, `SELECT id FROM projects WHERE org_id = ? AND slug = ?`, ctx.orgId, slug));
}

export interface NewProject {
  slug: string; name: string; description: string; icon: string; color: string; instructions: string; visibility: ProjectVisibility; owner: string;
}

/** Insert a project; its id. The caller found the slug free (a racing insert of the same slug fails on UNIQUE). */
export async function insertProject(ctx: TenantContext, p: NewProject, at: string = nowIso()): Promise<number> {
  const res = await run(ctx,
    `INSERT INTO projects (org_id, slug, name, description, icon, color, instructions, visibility, owner, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, p.slug, p.name, p.description, p.icon, p.color, p.instructions, p.visibility, p.owner, at, at);
  return Number(res.meta.last_row_id);
}

export interface ProjectPatchRow { name?: string; description?: string; icon?: string; color?: string; instructions?: string; visibility?: ProjectVisibility }

/** Change a live project's details (and its `updated_at`). */
export async function updateProject(ctx: TenantContext, id: number, p: ProjectPatchRow, at: string = nowIso()): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const k of ["name", "description", "icon", "color", "instructions", "visibility"] as const) {
    if (p[k] !== undefined) { sets.push(`${k} = ?`); vals.push(p[k]); }
  }
  sets.push("updated_at = ?");
  vals.push(at);
  await run(ctx, `UPDATE projects SET ${sets.join(", ")} WHERE id = ? AND org_id = ? AND deleted_at IS NULL`, ...vals, id, ctx.orgId);
}

/** Something in the project changed (a pin, a member, a thread started in it): it moves up the list. */
export async function touchProject(ctx: TenantContext, id: number, at: string = nowIso()): Promise<void> {
  await run(ctx, `UPDATE projects SET updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`, at, id, ctx.orgId);
}

/** Archive (`by`) or restore (`by` null) a live project. */
export async function setArchived(ctx: TenantContext, id: number, by: string | null, at: string = nowIso()): Promise<void> {
  await run(ctx,
    by === null
      ? `UPDATE projects SET archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`
      : `UPDATE projects SET archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`,
    ...(by === null ? [at] : [at, by, at]), id, ctx.orgId);
}

// ── members ──────────────────────────────────────────────────────────────────

/** The members of these projects, each project's in the order they were added. */
export async function membersOf(ctx: TenantContext, ids: readonly number[]): Promise<ProjectMemberRow[]> {
  if (!ids.length) return [];
  return all<ProjectMemberRow>(ctx,
    `SELECT project_id, handle, role, added_by, added_at FROM project_members WHERE org_id = ? AND project_id IN (${ids.map(() => "?").join(", ")})
      ORDER BY project_id, added_at, rowid`, ctx.orgId, ...ids);
}

/** Replace a project's members with `members` (the WHOLE list) in ONE batch: a person kept keeps when they were first
 *  added (a role change is not a new add); the rest go. The caller checked every handle. */
export async function replaceMembers(ctx: TenantContext, id: number, members: readonly { handle: string; role: ProjectRole }[], by: string, at: string = nowIso()): Promise<void> {
  const keep = members.map((m) => m.handle);
  await batch(ctx, [
    stmt(ctx, `DELETE FROM project_members WHERE org_id = ? AND project_id = ?${keep.length ? ` AND handle COLLATE NOCASE NOT IN (${keep.map(() => "?").join(", ")})` : ""}`,
      ctx.orgId, id, ...keep),
    ...members.map((m) => stmt(ctx,
      `INSERT INTO project_members (org_id, project_id, handle, role, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(org_id, project_id, handle) DO UPDATE SET role = excluded.role`,
      ctx.orgId, id, m.handle, m.role, by, at)),
    stmt(ctx, `UPDATE projects SET updated_at = ? WHERE id = ? AND org_id = ?`, at, id, ctx.orgId),
  ]);
}

// ── pins ─────────────────────────────────────────────────────────────────────

/** A project's pins, newest first. */
export function pinsOf(ctx: TenantContext, id: number): Promise<ProjectPinRow[]> {
  return all<ProjectPinRow>(ctx,
    `SELECT id, project_id, ref, added_by, added_at FROM project_pins WHERE org_id = ? AND project_id = ? ORDER BY added_at DESC, id DESC`, ctx.orgId, id);
}

/** How many pins each of these projects has. */
export async function pinCounts(ctx: TenantContext, ids: readonly number[]): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await all<{ project_id: number; n: number }>(ctx,
    `SELECT project_id, COUNT(*) AS n FROM project_pins WHERE org_id = ? AND project_id IN (${ids.map(() => "?").join(", ")}) GROUP BY project_id`,
    ctx.orgId, ...ids);
  return new Map(rows.map((r) => [r.project_id, Number(r.n)]));
}

/** Pin `refs` (one already pinned is left as it is), in ONE batch with the project's `updated_at`. */
export async function addPins(ctx: TenantContext, id: number, refs: readonly string[], by: string, at: string = nowIso()): Promise<void> {
  if (!refs.length) return;
  await batch(ctx, [
    ...refs.map((ref) => stmt(ctx,
      `INSERT INTO project_pins (org_id, project_id, ref, added_by, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(org_id, project_id, ref) DO NOTHING`,
      ctx.orgId, id, ref, by, at)),
    stmt(ctx, `UPDATE projects SET updated_at = ? WHERE id = ? AND org_id = ?`, at, id, ctx.orgId),
  ]);
}

/** Unpin one ref. True when it was pinned. */
export async function removePin(ctx: TenantContext, id: number, ref: string, at: string = nowIso()): Promise<boolean> {
  const res = await run(ctx, `DELETE FROM project_pins WHERE org_id = ? AND project_id = ? AND ref = ?`, ctx.orgId, id, ref);
  const gone = (res.meta.changes ?? 0) > 0;
  if (gone) await touchProject(ctx, id, at);
  return gone;
}

// ── artifacts ────────────────────────────────────────────────────────────────

export interface ProjectArtifactRow {
  id: number; project_id: number; slug: string; title: string; kind: string; visibility: "private" | "org"; author_id: string; updated_at: string;
  thread_id: number | null; content: string | null;
}

/** The project's artifacts `viewer` may see (an org one, or their own private one), newest first, with the thread each
 *  was saved from and the current version's text (a text kind's; null for bytes). */
export function artifactsOf(ctx: TenantContext, id: number, viewer: string): Promise<ProjectArtifactRow[]> {
  return all<ProjectArtifactRow>(ctx,
    `SELECT a.id, a.project_id, a.slug, a.title, a.kind, a.visibility, a.author_id, a.updated_at,
            (SELECT ca.thread_id FROM chat_artifacts ca WHERE ca.org_id = a.org_id AND ca.artifact_id = a.id AND ca.role = 'saved' ORDER BY ca.id LIMIT 1) AS thread_id,
            (SELECT substr(v.content, 1, 2000) FROM artifact_versions v WHERE v.org_id = a.org_id AND v.page_id = a.id AND v.version_no = a.current_version) AS content
       FROM artifact_pages a
      WHERE a.org_id = ? AND a.project_id = ? AND a.deleted_at IS NULL AND a.current_version > 0 AND (a.visibility = 'org' OR a.author_id = ? COLLATE NOCASE)
      ORDER BY a.updated_at DESC, a.id DESC`, ctx.orgId, id, viewer);
}

/** How many of each project's artifacts `viewer` may see. */
export async function artifactCounts(ctx: TenantContext, ids: readonly number[], viewer: string): Promise<Map<number, number>> {
  if (!ids.length) return new Map();
  const rows = await all<{ project_id: number; n: number }>(ctx,
    `SELECT project_id, COUNT(*) AS n FROM artifact_pages
      WHERE org_id = ? AND deleted_at IS NULL AND current_version > 0 AND (visibility = 'org' OR author_id = ? COLLATE NOCASE)
        AND project_id IN (${ids.map(() => "?").join(", ")}) GROUP BY project_id`, ctx.orgId, viewer, ...ids);
  return new Map(rows.map((r) => [r.project_id, Number(r.n)]));
}

/** The artifact is the project's (saved from one of its threads, or uploaded on its page). */
export async function setArtifactProject(ctx: TenantContext, pageId: number, projectId: number): Promise<void> {
  await run(ctx, `UPDATE artifact_pages SET project_id = ? WHERE id = ? AND org_id = ?`, projectId, pageId, ctx.orgId);
}

// ── deleting (src/deletion/projects.ts is the one caller) ────────────────────

/** Every thread in the project, whoever's (a pending holder is never in one). */
export function projectThreadOwners(ctx: TenantContext, id: number): Promise<{ id: number; handle: string }[]> {
  return all<{ id: number; handle: string }>(ctx, `SELECT id, handle FROM chat_threads WHERE org_id = ? AND project_id = ? ORDER BY id`, ctx.orgId, id);
}

/** How many artifacts the project holds (every one, whoever may see it). */
export async function projectArtifactCount(ctx: TenantContext, id: number): Promise<number> {
  return Number((await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = ? AND project_id = ? AND deleted_at IS NULL`, ctx.orgId, id))?.n ?? 0);
}

/** The project's own rows going, as ONE batch: its pins and members, its artifacts' link to it cleared (they stay in
 *  Artifacts), and the project marked deleted — its slug stays reserved. */
export function projectDeleteStatements(ctx: TenantContext, id: number, at: string = nowIso()): Stmt[] {
  return [
    stmt(ctx, `DELETE FROM project_pins WHERE org_id = ? AND project_id = ?`, ctx.orgId, id),
    stmt(ctx, `DELETE FROM project_members WHERE org_id = ? AND project_id = ?`, ctx.orgId, id),
    stmt(ctx, `UPDATE artifact_pages SET project_id = NULL WHERE org_id = ? AND project_id = ?`, ctx.orgId, id),
    stmt(ctx, `UPDATE projects SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ? AND deleted_at IS NULL`, at, at, id, ctx.orgId),
  ];
}
