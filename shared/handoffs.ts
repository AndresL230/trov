// Handoffs and the Prompt Library — the DTOs the Worker's routes return and the
// SPA renders, plus the request bodies. Types only (plus pure helpers), zod-free:
// the browser bundle imports this module. The zod validators live server-side.

export type HandoffStatus = "pending" | "claimed" | "expired";
/** Which slice of the handoffs a list read returns.
 *  mine = recipient OR sender is me · me = recipient is me ·
 *  anyone = recipient 'anyone' AND sender is not me · sent = sender is me. */
export type HandoffBox = "mine" | "me" | "anyone" | "sent";
export const HANDOFF_BOXES: readonly HandoffBox[] = ["mine", "me", "anyone", "sent"];

export interface HandoffContext {
  repo: string;
  branch: string;
  task: string;
  done: string[];
  next: string[];
  files: string[];
}
export const EMPTY_CONTEXT: HandoffContext = { repo: "", branch: "", task: "", done: [], next: [], files: [] };

/** The API shape of a handoff. `id` is its per-org NUMBER (rendered `#12`) — the row id never leaves the Worker (src/tools/handoffs.ts). */
export interface HandoffView {
  id: number;
  sender: string;
  /** A person handle, or the literal `anyone`. */
  recipient: string;
  status: HandoffStatus;
  created_at: string;
  claimed_at: string | null;
  claimed_by: string | null;
  claimed_by_session: string | null;
  prompt: { title: string; body: string } | null;
  /** Markdown; the first non-blank line is the title. Max 32 KB. */
  body: string;
  context: HandoffContext;
}

/** POST /api/handoffs */
export interface HandoffCreate {
  recipient?: string;
  body: string;
  context?: Partial<HandoffContext>;
  prompt?: { title: string; body: string } | null;
}

export type PromptStatus = "draft" | "staged" | "published";
/** `used` = most used first (use_count desc, then last_used_at desc, then updated_at desc). */
export type PromptSort = "updated_desc" | "updated_asc" | "used";

/** A library card: the prompt at its latest version; excerpt = first non-blank line of the body. */
export interface PromptSummary {
  slug: string;
  title: string;
  tags: string[];
  author: string;
  version: number;
  status: PromptStatus;
  updated_at: string;
  excerpt: string;
  /** Times the prompt was fetched by MCP get_prompt or copied on the web (0035). */
  use_count: number;
  /** When it was last used; null = never (or not since 0035). */
  last_used_at: string | null;
}

export interface PromptDetail {
  slug: string;
  title: string;
  description: string;
  tags: string[];
  author: string;
  version: number;
  status: PromptStatus;
  updated_at: string;
  body: string;
  /** See PromptSummary.use_count / last_used_at (0035). */
  use_count: number;
  last_used_at: string | null;
}

export interface PromptVersion {
  version: number;
  status: PromptStatus;
  author: string;
  created_at: string;
  summary: string;
  body: string;
}

/** POST /api/prompts — upsert keyed on base_slug || slug. */
export interface PromptSave {
  slug: string;
  base_slug?: string | null;
  title: string;
  tags: string[];
  body: string;
  status?: PromptStatus;
  summary?: string;
}

/** POST /api/docs/propose — stages a version-1 doc proposal through the gate. */
export interface DocProposeBody {
  title: string;
  section: string;
  space: string;
  body: string;
  summary?: string;
  slug?: string;
}

/** The first non-blank line of a markdown body, with its heading / quote marker and inline marks stripped. */
export function firstLine(body: string | null | undefined): string {
  const line = (body ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.replace(/^\s*(#+|>)\s*/, "").replace(/[*`]/g, "").trim();
}

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
/** The distinct `{{variable}}` names in a body, in first-seen order. */
export function detectVars(body: string): string[] {
  const seen: string[] = [];
  for (const m of (body ?? "").matchAll(VAR_RE)) if (!seen.includes(m[1])) seen.push(m[1]);
  return seen;
}
/** Replace each `{{var}}` that has a non-blank value; unfilled ones stay as placeholders. */
export function fillVars(body: string, vals: Record<string, string>): string {
  return (body ?? "").replace(VAR_RE, (w, n: string) => (vals[n] && vals[n].trim() ? vals[n] : w));
}
/** Tags as stored: lowercased, trimmed, a–z 0–9 and "-", deduped, empties dropped. */
export function normalizeTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const v = String(t).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}
