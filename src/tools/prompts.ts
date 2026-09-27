// The Prompt Library (0028) — versioned, reusable instructions addressed by slug.
//
// Every save appends a prompt_versions row; `prompts.current_version` points at
// the latest, whose status and body ARE the prompt's. Two writers, one function:
// a PERSON (session cookie) saves draft / staged / published and may rename the
// slug; an AGENT (MCP bearer) always stages and never renames — a staged version
// waits for a person to publish it, the same agents-stage-humans-confirm rule the
// doc gate enforces. Not the ingestion gate: a prompt carries no vocab/confidence.

import { z } from "zod";
import { all, first, run, nowIso, type DB } from "../db";
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
const SELECT = `SELECT p.slug, p.title, p.description, p.tags, p.author, p.current_version, p.updated_at, v.status, v.body,
    p.use_count, p.last_used_at
  FROM prompts p LEFT JOIN prompt_versions v ON v.slug = p.slug AND v.version = p.current_version`;

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
export async function listPrompts(db: DB, opts: { q?: string; tags?: string[]; sort?: PromptSort } = {}): Promise<PromptSummary[]> {
  const match = buildMatch(opts.q ?? "");
  const order = ORDER[opts.sort ?? "updated_desc"] ?? ORDER.updated_desc;
  const rows = match
    ? await all<PromptRow>(db, `${SELECT} JOIN prompts_fts f ON f.slug = p.slug WHERE prompts_fts MATCH ? ORDER BY ${order}`, match)
    : await all<PromptRow>(db, `${SELECT} ORDER BY ${order}`);
  const want = normalizeTags(opts.tags ?? []);
  return rows.map(toDetail).filter((p) => want.every((t) => p.tags.includes(t))).map(toSummary);
}

export async function getPrompt(db: DB, slug: string): Promise<PromptDetail | null> {
  const r = await first<PromptRow>(db, `${SELECT} WHERE p.slug = ?`, slug);
  return r ? toDetail(r) : null;
}

/**
 * Record one USE of a prompt (0035): `use_count + 1`, `last_used_at = now`, in ONE
 * conditional UPDATE — so a call counts exactly once and an unknown slug writes nothing
 * and returns false. Callers: MCP `get_prompt` (every principal) and the session-cookie
 * `POST /api/prompts/:slug/used` (the web Copy button). Does NOT touch `updated_at`
 * (a use is not an edit) nor the FTS index (0035 narrowed its update trigger).
 */
export async function recordPromptUse(db: DB, slug: string): Promise<boolean> {
  const res = await run(db, `UPDATE prompts SET use_count = use_count + 1, last_used_at = ? WHERE slug = ?`, nowIso(), slug);
  return (res.meta.changes ?? 0) > 0;
}

/** Every version, newest first. */
export async function listPromptVersions(db: DB, slug: string): Promise<PromptVersion[]> {
  return all<PromptVersion>(db, `SELECT version, status, author, created_at, summary, body FROM prompt_versions WHERE slug = ? ORDER BY version DESC`, slug);
}

/**
 * Save: upsert keyed on `base_slug || slug`. A new prompt is v1 authored by the
 * writer; an existing one gets version current+1. ALWAYS writes a version row.
 * Agent saves are forced to `staged` and may not rename; `branch` feeds an agent's
 * default summary.
 */
export async function savePrompt(
  db: DB, writer: string, input: PromptSaveInput, via: PromptVia, opts: { branch?: string } = {},
): Promise<PromptDetail> {
  const key = input.base_slug || input.slug;
  const existing = await first<{ slug: string; current_version: number }>(db, `SELECT slug, current_version FROM prompts WHERE slug = ?`, key);
  const renaming = !!existing && input.slug !== existing.slug;
  if (renaming && via === "agent") throw new PromptError("forbidden", "agents cannot rename a prompt's slug");
  if ((renaming || (!existing && input.base_slug && input.base_slug !== input.slug)) && (await first(db, `SELECT 1 FROM prompts WHERE slug = ?`, input.slug))) {
    throw new PromptError("conflict", `slug taken: ${input.slug}`);
  }
  if (!existing && input.base_slug && input.base_slug !== input.slug) throw new PromptError("not_found", `no prompt ${input.base_slug}`);

  const status: PromptStatus = via === "agent" ? "staged" : input.status ?? "draft";
  const summary = input.summary?.trim()
    || (via === "agent" ? (opts.branch ? `Staged by a session on ${opts.branch}` : "Staged by a session") : existing ? "Edited in Canopy" : "Created in Canopy");
  const tags = input.tags === undefined ? null : JSON.stringify(normalizeTags(input.tags));
  const now = nowIso();
  const version = existing ? existing.current_version + 1 : 1;

  const stmts: D1PreparedStatement[] = [];
  if (!existing) {
    stmts.push(db.prepare(`INSERT INTO prompts (slug, title, description, tags, author, current_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(input.slug, input.title, input.description ?? "", tags ?? "[]", writer, version, now, now));
  } else {
    // Rename first (both tables), so the version row below lands under the new slug.
    if (renaming) {
      stmts.push(db.prepare(`UPDATE prompts SET slug = ? WHERE slug = ?`).bind(input.slug, existing.slug));
      stmts.push(db.prepare(`UPDATE prompt_versions SET slug = ? WHERE slug = ?`).bind(input.slug, existing.slug));
    }
    stmts.push(db.prepare(`UPDATE prompts SET title = ?, description = COALESCE(?, description), tags = COALESCE(?, tags), current_version = ?, updated_at = ? WHERE slug = ?`)
      .bind(input.title, input.description ?? null, tags, version, now, input.slug));
  }
  stmts.push(db.prepare(`INSERT INTO prompt_versions (slug, version, status, author, summary, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(input.slug, version, status, writer, summary, input.body, now));
  await db.batch(stmts);
  return (await getPrompt(db, input.slug))!;
}

/** Replace a prompt's tags (people only — the route is session-cookie). */
export async function setPromptTags(db: DB, slug: string, tags: string[]): Promise<PromptDetail> {
  const res = await run(db, `UPDATE prompts SET tags = ?, updated_at = ? WHERE slug = ?`, JSON.stringify(normalizeTags(tags)), nowIso(), slug);
  if (!res.meta.changes) throw new PromptError("not_found", "prompt not found");
  return (await getPrompt(db, slug))!;
}

/** Publish a STAGED version (people only). Anything else is a 409 `not staged`. */
export async function publishPrompt(db: DB, slug: string, version: number): Promise<PromptDetail> {
  if (!(await first(db, `SELECT 1 FROM prompts WHERE slug = ?`, slug))) throw new PromptError("not_found", "prompt not found");
  const res = await run(db, `UPDATE prompt_versions SET status = 'published' WHERE slug = ? AND version = ? AND status = 'staged'`, slug, version);
  if (!res.meta.changes) throw new PromptError("conflict", "not staged");
  await run(db, `UPDATE prompts SET updated_at = ? WHERE slug = ?`, nowIso(), slug);
  return (await getPrompt(db, slug))!;
}
