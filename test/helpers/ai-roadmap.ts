// Phase D test helpers (the Roadmap's producers, doc drift): reading a prompt's fenced input back, driving one tick
// of the pass, and the reserved `trov` person.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import { runAiPass, type AiJob, type AiPassResult } from "../../src/ai/pass";
import { newBudget, CRON_SUBREQUEST_BUDGET } from "../../src/repo/dispatch";
import { FENCE } from "../../src/ai/grounding";
import { run } from "./db";
import { keyedEnv, type Stub } from "./ai-pass";

/** The JSON of every fenced block in a prompt's input, by label. */
export function fencedBlocks(input: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = new RegExp(`<<<${FENCE} ([^>]+)>>>\\n([\\s\\S]*?)\\n<<<END ${FENCE}>>>`, "g");
  // A JSON block parsed; a text block (a document, `fencedText`) as its text.
  for (const m of input.matchAll(re)) { try { out[m[1]] = JSON.parse(m[2]); } catch { out[m[1]] = m[2]; } }
  return out;
}

/** The input text of a Haiku request body (the last user block, after the org prefix). */
export const inputOf = (body: { messages: { content: { text: string }[] }[] }): string => body.messages[0].content.at(-1)!.text;

/** One tick of the pass over `jobs`, both keys set unless `env` says otherwise. */
export const tick = (s: Stub, jobs: readonly AiJob[], now: Date, e: Env = keyedEnv()): Promise<AiPassResult> =>
  runAiPass(e, newBudget(s.fetchImpl, CRON_SUBREQUEST_BUDGET), { jobs, now });

/** The reserved system person Trov writes as. Its row arrives with 0061_ai_digests (another Phase D job); until
 *  that lands on this branch the tests add it here, exactly as the dev seed does. */
export async function ensureTrovPerson(): Promise<void> {
  await run(env.DB, `INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('trov', 'Trov', 'stone', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`);
}

// ── 0064's theme tables (another Phase D job's migration) ────────────────────
// Until 0064 is on this branch the drift's tests create its two tables themselves, with 0064's own columns, and drop
// them after; once it is here they are already there and only the rows are added (and removed).
const THEME_DDL = [
  `CREATE TABLE repo_themes (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', color_key TEXT NOT NULL, status TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
    seed_prs TEXT NOT NULL DEFAULT '[]', merged_into INTEGER, model TEXT, prompt_version TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    decided_by TEXT, decided_at TEXT)`,
  `CREATE TABLE pr_themes (org_id TEXT NOT NULL, repo TEXT NOT NULL COLLATE NOCASE, pr_number INTEGER NOT NULL, theme_id INTEGER,
    source TEXT NOT NULL, confidence REAL, model TEXT, prompt_version TEXT, set_by TEXT, set_at TEXT NOT NULL, PRIMARY KEY (org_id, repo, pr_number))`,
];

/** Run `fn` with 0064's tables present; `theme` adds an ACTIVE theme (its id), `prTheme` files a PR under one. */
export async function withThemes(fn: (t: {
  theme: (org: string, repo: string, name: string) => Promise<number>;
  prTheme: (org: string, repo: string, pr: number, themeId: number) => Promise<void>;
}) => Promise<void>): Promise<void> {
  const exists = !!(await env.DB.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repo_themes'`).first());
  if (!exists) for (const ddl of THEME_DDL) await env.DB.prepare(ddl).run();
  const now = new Date().toISOString();
  try {
    await fn({
      theme: async (org, repo, name) => (await env.DB.prepare(
        `INSERT INTO repo_themes (org_id, repo, name, color_key, status, created_by, created_at) VALUES (?, ?, ?, 'c1', 'active', 'trov', ?) RETURNING id`,
      ).bind(org, repo, name, now).first<{ id: number }>())!.id,
      prTheme: async (org, repo, pr, themeId) => {
        await env.DB.prepare(`INSERT INTO pr_themes (org_id, repo, pr_number, theme_id, source, set_at) VALUES (?, ?, ?, ?, 'ai', ?)`).bind(org, repo, pr, themeId, now).run();
      },
    });
  } finally {
    if (exists) { await env.DB.prepare(`DELETE FROM pr_themes`).run(); await env.DB.prepare(`DELETE FROM repo_themes`).run(); }
    else { await env.DB.prepare(`DROP TABLE IF EXISTS pr_themes`).run(); await env.DB.prepare(`DROP TABLE IF EXISTS repo_themes`).run(); }
  }
}
