// The Prompt Library (0028) — versioned, reusable instructions addressed by slug.
//
// Every save appends a prompt_versions row; `prompts.current_version` points at
// the latest, whose status and body ARE the prompt's. Two writers, one function:
// a PERSON (session cookie) saves draft / staged / published and may rename the
// slug; an AGENT (MCP bearer) always stages and never renames — a staged version
// waits for a person to publish it, the same agents-stage-humans-confirm rule the
// doc gate enforces. Not the ingestion gate: a prompt carries no vocab/confidence.
//
// DELETE is soft (0035 PART C): `deleted_at` / `deleted_by` mark the row, every
// version stays in D1, and a deleted prompt is absent from every read here (the
// SELECTs below filter it; prompts_fts never indexes it). Its slug stays RESERVED —
// a save to it is a 409 naming the fix — so `restorePrompt` is the one way back.
// Only the author or an admin may delete or restore, over the session cookie; there
// is no MCP delete, so an agent can never remove a prompt.

import { z } from "zod";
import { all, batch, first, run, stmt, nowIso, type Stmt, type TenantContext } from "../data/sql";
import { buildMatch } from "./reads";
import {
  firstLine, normalizeTags,
  type PromptDetail, type PromptSort, type PromptStatus, type PromptSummary, type PromptVersion,
} from "@shared/handoffs";

export class PromptError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request" | "forbidden", message: string) {
    super(message);
    this.name = "PromptError";
  }
}
export const PROMPT_ERROR_STATUS = { not_found: 404, conflict: 409, bad_request: 400, forbidden: 403 } as const;

/** Who is writing: a person over the session cookie, or an agent over MCP. */
export type PromptVia = "human" | "agent";

export const PROMPT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,59}$/;
const Slug = z.string().regex(PROMPT_SLUG_RE, "slug must be 2–60 chars of a-z, 0-9 and -");
export const PromptSaveInput = z.object({
  slug: Slug,
  base_slug: Slug.nullable().optional(),
  title: z.string().trim().min(1).max(200),
  // Optional: omitted on an existing prompt keeps its tags (an agent's save_prompt
  // often leaves them out); omitted on a new prompt is no tags.
  tags: z.array(z.string().max(40)).max(20).optional(),
  body: z.string().refine((b) => b.trim().length > 0, "body required").refine((b) => b.length <= 64 * 1024, "body over 64KB"),
  status: z.enum(["draft", "staged", "published"]).optional(),
  summary: z.string().max(300).optional(),
  description: z.string().max(1000).optional(),
});
export type PromptSaveInput = z.infer<typeof PromptSaveInput>;

interface PromptRow {
  slug: string; title: string; description: string; tags: string; author: string;
  current_version: number; updated_at: string; status: PromptStatus | null; body: string | null;
  use_count: number; last_used_at: string | null;
}
const COLS = `p.slug, p.title, p.description, p.tags, p.author, p.current_version, p.updated_at, v.status, v.body,
    p.use_count, p.last_used_at`;
// The current version's row. Binds the org FIRST; every read then adds its own `p.org_id = ?`.
const VERSION = `LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version AND v.org_id = ?`;
/** The live-prompt condition every read carries: a soft-deleted prompt is absent. */
const LIVE = `p.deleted_at IS NULL`;

function tagsOf(json: string): string[] {
  try { const v: unknown = JSON.parse(json); return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
function toDetail(r: PromptRow): PromptDetail {
  return {
    slug: r.slug, title: r.title, description: r.description, tags: tagsOf(r.tags), author: r.author,
    version: r.current_version, status: r.status ?? "draft", updated_at: r.updated_at, body: r.body ?? "",
    use_count: r.use_count ?? 0, last_used_at: r.last_used_at ?? null,
  };
}
const toSummary = (d: PromptDetail): PromptSummary => ({
  slug: d.slug, title: d.title, tags: d.tags, author: d.author, version: d.version, status: d.status, updated_at: d.updated_at, excerpt: firstLine(d.body),
  use_count: d.use_count, last_used_at: d.last_used_at,
});

/** ORDER BY for each sort. `used` = most used first; ties (incl. never used) by last use, then recency. */
const ORDER: Record<PromptSort, string> = {
  updated_desc: `p.updated_at DESC`,
  updated_asc: `p.updated_at ASC`,
  used: `p.use_count DESC, p.last_used_at IS NULL, p.last_used_at DESC, p.updated_at DESC, p.slug ASC`,
};

/** The library: `q` is an FTS5 match over slug / title / description / body / tags
 *  (ranked by bm25, title weighted), `tags` are ANDed, then sorted by `sort`
 *  (default recency; `used` = most used first). */
export async function listPrompts(ctx: TenantContext, opts: { q?: string; tags?: string[]; sort?: PromptSort } = {}): Promise<PromptSummary[]> {
  const match = buildMatch(opts.q ?? "");
  const order = ORDER[opts.sort ?? "updated_desc"] ?? ORDER.updated_desc;
  const rows = match
    ? await all<PromptRow>(ctx, `SELECT ${COLS} FROM prompts p ${VERSION} JOIN prompts_fts f ON f.slug = p.slug WHERE prompts_fts MATCH ? AND f.org_id = ? AND p.org_id = ? AND ${LIVE} ORDER BY ${order}`,
        ctx.orgId, match, ctx.orgId, ctx.orgId)
    : await all<PromptRow>(ctx, `SELECT ${COLS} FROM prompts p ${VERSION} WHERE p.org_id = ? AND ${LIVE} ORDER BY ${order}`, ctx.orgId, ctx.orgId);
  const want = normalizeTags(opts.tags ?? []);
  return rows.map(toDetail).filter((p) => want.every((t) => p.tags.includes(t))).map(toSummary);
}

export async function getPrompt(ctx: TenantContext, slug: string): Promise<PromptDetail | null> {
  const r = await first<PromptRow>(ctx, `SELECT ${COLS} FROM prompts p ${VERSION} WHERE p.slug = ? AND p.org_id = ? AND ${LIVE}`, ctx.orgId, slug, ctx.orgId);
  return r ? toDetail(r) : null;
}

/**
 * Record one USE of a prompt (0035): `use_count + 1`, `last_used_at = now`, in ONE
 * conditional UPDATE — so a call counts exactly once and an unknown slug writes nothing
 * (as does a deleted one) and returns false. Callers: MCP `get_prompt` (every principal) and the session-cookie
 * `POST /api/prompts/:slug/used` (the web Copy button). Does NOT touch `updated_at`
 * (a use is not an edit) nor the FTS index (0035 narrowed its update trigger).
 */
export async function recordPromptUse(ctx: TenantContext, slug: string): Promise<boolean> {
  const res = await run(ctx, `UPDATE prompts SET use_count = use_count + 1, last_used_at = ? WHERE slug = ? AND org_id = ? AND deleted_at IS NULL`, nowIso(), slug, ctx.orgId);
  return (res.meta.changes ?? 0) > 0;
}

/** Every version, newest first. Callers check the prompt is live first (getPrompt). */
export async function listPromptVersions(ctx: TenantContext, slug: string): Promise<PromptVersion[]> {
  return all<PromptVersion>(ctx, `SELECT version, status, author, created_at, summary, body FROM prompt_versions WHERE slug = ? AND org_id = ? ORDER BY version DESC`, slug, ctx.orgId);
}

/**
 * Save: upsert keyed on `base_slug || slug`. A new prompt is v1 authored by the
 * writer; an existing one gets version current+1. ALWAYS writes a version row.
 * Agent saves are forced to `staged` and may not rename; `branch` feeds an agent's
 * default summary. A slug held by a DELETED prompt — as the key or as a rename's
 * target — is a 409 (`reservedMessage`): the slug stays reserved, restore it instead.
 */
export async function savePrompt(
  ctx: TenantContext, writer: string, input: PromptSaveInput, via: PromptVia, opts: { branch?: string } = {},
): Promise<PromptDetail> {
  const key = input.base_slug || input.slug;
  const existing = await first<{ slug: string; current_version: number; deleted_at: string | null }>(ctx, `SELECT slug, current_version, deleted_at FROM prompts WHERE slug = ? AND org_id = ?`, key, ctx.orgId);
  if (existing?.deleted_at) throw new PromptError("conflict", reservedMessage(existing.slug));
  const renaming = !!existing && input.slug !== existing.slug;
  if (renaming && via === "agent") throw new PromptError("forbidden", "agents cannot rename a prompt's slug");
  if (renaming || (!existing && input.base_slug && input.base_slug !== input.slug)) {
    const holder = await first<{ deleted_at: string | null }>(ctx, `SELECT deleted_at FROM prompts WHERE slug = ? AND org_id = ?`, input.slug, ctx.orgId);
    if (holder) throw new PromptError("conflict", holder.deleted_at ? reservedMessage(input.slug) : `slug taken: ${input.slug}`);
  }
  if (!existing && input.base_slug && input.base_slug !== input.slug) throw new PromptError("not_found", `no prompt ${input.base_slug}`);

  const status: PromptStatus = via === "agent" ? "staged" : input.status ?? "draft";
  const summary = input.summary?.trim()
    || (via === "agent" ? (opts.branch ? `Staged by a session on ${opts.branch}` : "Staged by a session") : existing ? "Edited in Trov" : "Created in Trov");
  const tags = input.tags === undefined ? null : JSON.stringify(normalizeTags(input.tags));
  const now = nowIso();
  const version = existing ? existing.current_version + 1 : 1;

  const stmts: Stmt[] = [];
  if (!existing) {
    stmts.push(stmt(ctx, `INSERT INTO prompts (org_id, slug, title, description, tags, author, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ctx.orgId, input.slug, input.title, input.description ?? "", tags ?? "[]", writer, version, now, now));
  } else {
    // Rename first (both tables), so the version row below lands under the new slug.
    if (renaming) {
      stmts.push(stmt(ctx, `UPDATE prompts SET slug = ? WHERE slug = ? AND org_id = ?`, input.slug, existing.slug, ctx.orgId));
      stmts.push(stmt(ctx, `UPDATE prompt_versions SET slug = ? WHERE slug = ? AND org_id = ?`, input.slug, existing.slug, ctx.orgId));
    }
    stmts.push(stmt(ctx, `UPDATE prompts SET title = ?, description = COALESCE(?, description), tags = COALESCE(?, tags), current_version = ?, updated_at = ? WHERE slug = ? AND org_id = ?`,
      input.title, input.description ?? null, tags, version, now, input.slug, ctx.orgId));
  }
  stmts.push(stmt(ctx, `INSERT INTO prompt_versions (org_id, slug, version, status, author, summary, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, input.slug, version, status, writer, summary, input.body, now));
  await batch(ctx, stmts);
  return (await getPrompt(ctx, input.slug))!;
}

/** The 409 for a slug a deleted prompt still holds. */
const reservedMessage = (slug: string): string =>
  `slug ${slug} belongs to a deleted prompt — restore it instead of reusing the slug`;

/** Replace a prompt's tags (people only — the route is session-cookie). */
export async function setPromptTags(ctx: TenantContext, slug: string, tags: string[]): Promise<PromptDetail> {
  const res = await run(ctx, `UPDATE prompts SET tags = ?, updated_at = ? WHERE slug = ? AND org_id = ? AND deleted_at IS NULL`, JSON.stringify(normalizeTags(tags)), nowIso(), slug, ctx.orgId);
  if (!res.meta.changes) throw new PromptError("not_found", "prompt not found");
  return (await getPrompt(ctx, slug))!;
}

/** Publish a STAGED version (people only). Anything else is a 409 `not staged`. */
export async function publishPrompt(ctx: TenantContext, slug: string, version: number): Promise<PromptDetail> {
  if (!(await first(ctx, `SELECT 1 FROM prompts WHERE slug = ? AND org_id = ? AND deleted_at IS NULL`, slug, ctx.orgId))) throw new PromptError("not_found", "prompt not found");
  const res = await run(ctx, `UPDATE prompt_versions SET status = 'published' WHERE slug = ? AND org_id = ? AND version = ? AND status = 'staged'`, slug, ctx.orgId, version);
  if (!res.meta.changes) throw new PromptError("conflict", "not staged");
  await run(ctx, `UPDATE prompts SET updated_at = ? WHERE slug = ? AND org_id = ?`, nowIso(), slug, ctx.orgId);
  return (await getPrompt(ctx, slug))!;
}

/**
 * Soft-delete a prompt (0035 PART C): stamp `deleted_at` / `deleted_by` in ONE
 * conditional UPDATE; nothing else changes and no version row is touched. Only the
 * AUTHOR (case-insensitive, like every handle) or an ADMIN may; anyone else is
 * `forbidden` with nothing written. An unknown OR already-deleted slug is
 * `not_found` FIRST — a deleted prompt is gone from every read, this one included.
 * Session-cookie only (`POST /api/prompts/:slug/delete`); never an MCP tool.
 */
export async function deletePrompt(ctx: TenantContext, slug: string, actor: string, admin: boolean): Promise<{ slug: string; title: string }> {
  const row = await first<{ slug: string; title: string; author: string }>(ctx, `SELECT slug, title, author FROM prompts WHERE slug = ? AND org_id = ? AND deleted_at IS NULL`, slug, ctx.orgId);
  if (!row) throw new PromptError("not_found", "prompt not found");
  if (!admin && row.author.toLowerCase() !== actor.toLowerCase()) throw new PromptError("forbidden", "only the prompt's author or an admin can delete it");
  const res = await run(ctx, `UPDATE prompts SET deleted_at = ?, deleted_by = ? WHERE slug = ? AND org_id = ? AND deleted_at IS NULL`, nowIso(), actor, row.slug, ctx.orgId);
  if (!res.meta.changes) throw new PromptError("not_found", "prompt not found"); // a racing delete won
  return { slug: row.slug, title: row.title };
}

/**
 * Restore a soft-deleted prompt: clear `deleted_at` / `deleted_by`, so it is back in
 * every read (the FTS trigger re-indexes it) exactly as it was — same versions, same
 * `updated_at`. The same people as delete (author or admin), else `forbidden`; an
 * unknown slug is `not_found`, a live one `conflict` ("not deleted").
 */
export async function restorePrompt(ctx: TenantContext, slug: string, actor: string, admin: boolean): Promise<PromptDetail> {
  const row = await first<{ slug: string; author: string; deleted_at: string | null }>(ctx, `SELECT slug, author, deleted_at FROM prompts WHERE slug = ? AND org_id = ?`, slug, ctx.orgId);
  if (!row) throw new PromptError("not_found", "prompt not found");
  if (!admin && row.author.toLowerCase() !== actor.toLowerCase()) throw new PromptError("forbidden", "only the prompt's author or an admin can restore it");
  if (!row.deleted_at) throw new PromptError("conflict", "prompt is not deleted");
  await run(ctx, `UPDATE prompts SET deleted_at = NULL, deleted_by = NULL WHERE slug = ? AND org_id = ?`, row.slug, ctx.orgId);
  return (await getPrompt(ctx, row.slug))!;
}
