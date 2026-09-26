// Backfill `feed.brief` for the entries written before the brief existed.
//
// A ONE-OFF local script (not Worker code). Spec:
// docs/superpowers/specs/2026-09-26-feed-brief-design.md, "Backfilling the existing entries".
//
// For every `feed` row with `brief IS NULL` it asks Google Gemini (gemini-2.5-flash — one step up from the model
// src/tools/summarize.ts uses, over the same REST generateContent call) for a brief: 1–2 plain sentences,
// ≤ 280 characters, on the problem solved and who it helps, written for someone who uses or runs the
// product — no file names, PR/issue numbers, commit shas or internal jargon. A reply that is not a
// non-empty string of ≤ 280 characters (after trim) is retried once, then logged and SKIPPED: that row
// stays title-only and a later re-run picks it up again.
//
// Writes are `UPDATE feed SET brief = '…' WHERE id = N AND brief IS NULL`, so a re-run never overwrites
// a brief an agent (or an earlier run) already wrote.
//
// Run order (prod):
//   1. Apply migration 0034_feed_brief first: `npm run db:migrate:remote`.
//   2. Dry run a sample and SHOW IT TO THE OWNER before writing anything:
//        CLOUDFLARE_ACCOUNT_ID=6a5f361bfafdb29f00faf0c49dd1a240 node scripts/backfill-feed-briefs.mjs --limit 10
//   3. Once approved, write:
//        CLOUDFLARE_ACCOUNT_ID=6a5f361bfafdb29f00faf0c49dd1a240 node scripts/backfill-feed-briefs.mjs --apply
//
// Flags:
//   (none)      dry run against the REMOTE (prod) D1: reads only, prints `#id · summary` and the brief.
//   --limit N   only the N newest rows still missing a brief.
//   --local     target the local dev D1 (`wrangler d1 execute --local`) instead of --remote.
//   --apply     write the briefs: an SQL file in os.tmpdir(), run with `wrangler d1 execute --file`.
//
// Env:
//   GEMINI_API_KEY         else read from .dev.vars.
//   CLOUDFLARE_ACCOUNT_ID  needed by wrangler for --remote (Canopy prod: 6a5f361bfafdb29f00faf0c49dd1a240);
//                          passed through to wrangler as-is. Not needed with --local.
//
// The D1 database name is read from wrangler.toml (the `DB` binding's `database_name`).

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "gemini-2.5-flash";
const BRIEF_MAX = 280;
const DELAY_MS = 400;
const GEMINI_TIMEOUT_MS = 20_000;
const BODY_MAX = 12_000; // bodies run 2.5–5 KB; cap what we send so an outlier cannot blow the prompt

// ---------------------------------------------------------------------------
// Args / config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LOCAL = args.includes("--local");
const LIMIT = (() => {
  const i = args.indexOf("--limit");
  if (i === -1) return null;
  const n = Number(args[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error("--limit needs a positive integer.");
    process.exit(1);
  }
  return n;
})();
const TARGET = LOCAL ? "--local" : "--remote";

function databaseName() {
  try {
    const toml = readFileSync(join(ROOT, "wrangler.toml"), "utf8");
    for (const block of toml.split(/^\[\[d1_databases\]\]\s*$/m).slice(1)) {
      const binding = block.match(/^\s*binding\s*=\s*"([^"]+)"/m)?.[1];
      const name = block.match(/^\s*database_name\s*=\s*"([^"]+)"/m)?.[1];
      if (binding === "DB" && name) return name;
    }
  } catch {
    /* fall through */
  }
  return "canopy";
}

function geminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const vars = readFileSync(join(ROOT, ".dev.vars"), "utf8");
    const m = vars.match(/^\s*GEMINI_API_KEY\s*=\s*(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    /* no .dev.vars */
  }
  return null;
}

const DB = databaseName();
const API_KEY = geminiKey();
if (!API_KEY) {
  console.error("No GEMINI_API_KEY: set it in the environment or in .dev.vars.");
  process.exit(1);
}
if (!LOCAL && !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.warn(
    "warning: CLOUDFLARE_ACCOUNT_ID is not set — wrangler --remote may fail (Canopy prod: 6a5f361bfafdb29f00faf0c49dd1a240)."
  );
}

// ---------------------------------------------------------------------------
// wrangler
// ---------------------------------------------------------------------------
function wrangler(extra) {
  try {
    return execFileSync("npx", ["wrangler", "d1", "execute", DB, TARGET, ...extra], {
      cwd: ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch (err) {
    // With --json, wrangler reports a failed statement on STDOUT — surface it (e.g. "no such column: brief"
    // when migration 0034 has not been applied to this database yet).
    const out = typeof err?.stdout === "string" ? err.stdout.trim() : "";
    throw new Error(`wrangler d1 execute ${TARGET} failed${out ? `:\n${out.slice(0, 1000)}` : ""}`);
  }
}

function readRows() {
  const sql =
    "SELECT id, summary, body FROM feed WHERE brief IS NULL ORDER BY id DESC" + (LIMIT ? ` LIMIT ${LIMIT}` : "");
  const out = wrangler(["--json", "--command", sql]);
  // --json prints a JSON array of statement results; slice defensively in case anything precedes it.
  const start = out.indexOf("[");
  if (start === -1) throw new Error(`unexpected wrangler output: ${out.slice(0, 200)}`);
  const parsed = JSON.parse(out.slice(start));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first && first.success === false) throw new Error(`query failed: ${JSON.stringify(first).slice(0, 300)}`);
  return first?.results ?? [];
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `You write the "brief" for an entry in a software team's activity feed.

The entry was written by an engineer or coding agent for other agents: a one-line summary and a long
technical body. People do not read that. The brief is what they read instead.

Rules for the brief:
- 1–2 plain sentences, at most ${BRIEF_MAX} characters in total.
- Say what problem was solved (or what is now possible) and who it helps, from a product standpoint,
  for someone who uses or runs the product.
- No file names, function names, PR/issue numbers, commit shas, branch names, table or column names,
  or internal jargon. No markdown, no lists, no quotes around it.
- Plain past or present tense; do not start with "This entry" or "The team".
- Be concrete: name the actual thing that was broken or missing and what happens now. Never use filler
  like "more effectively", "improves the experience", "enhances", "streamlines", "helps users manage",
  "better tracking" — if a sentence would fit any feature, it is wrong; say the specific effect.
- If the work was internal (a deploy, a migration, a triage, a status check), say what it means for the
  product or the team in concrete terms (e.g. "Production now has the tutor's retrieval fixes; one
  owner step — a real AI key in production — still blocks the last backfill.").

Good examples:
"Students' tutor chats no longer end in "please retry" when the AI skips its reply — the answer now finishes, without re-running anything."
"Uploaded course documents no longer silently fail to become searchable by the tutor — indexing now retries on its own and admins can see anything stuck."

Respond with exactly one JSON object and nothing else: { "brief": "..." }`;

function extractText(data) {
  const t = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return typeof t === "string" ? t : null;
}

function parseJsonObject(text) {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  if (first === -1 || last <= first) return null;
  try {
    const obj = JSON.parse(stripped.slice(first, last + 1));
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

/** One Gemini call → { brief } or { error }. */
async function askBrief(summary, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [
          {
            role: "user",
            parts: [{ text: `Summary: ${summary ?? ""}\n\nBody:\n${String(body ?? "").slice(0, BODY_MAX)}` }],
          },
        ],
        generationConfig: { response_mime_type: "application/json", temperature: 0 },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const text = extractText(await res.json());
    if (text === null) return { error: "no text in response" };
    const obj = parseJsonObject(text);
    if (!obj) return { error: `not a JSON object: ${text.slice(0, 80)}` };
    if (typeof obj.brief !== "string") return { error: "brief is not a string" };
    const brief = obj.brief.trim().replace(/\s+/g, " ");
    if (!brief) return { error: "brief is empty" };
    if (brief.length > BRIEF_MAX) return { error: `brief is ${brief.length} chars (> ${BRIEF_MAX})` };
    return { brief };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(
    `${APPLY ? "APPLY" : "DRY RUN"} · database ${DB} (${TARGET.slice(2)})${LIMIT ? ` · limit ${LIMIT}` : ""}\n`
  );
  const rows = readRows();
  console.log(`${rows.length} feed row(s) without a brief.\n`);

  const done = [];
  const skipped = [];
  for (const [i, row] of rows.entries()) {
    if (i > 0) await sleep(DELAY_MS);
    let result = await askBrief(row.summary, row.body);
    if (result.error) {
      await sleep(DELAY_MS);
      result = await askBrief(row.summary, row.body);
    }
    console.log(`#${row.id} · ${truncate(String(row.summary ?? ""), 90)}`);
    if (result.error) {
      console.log(`  ✗ skipped: ${result.error}\n`);
      skipped.push(row.id);
      continue;
    }
    console.log(`  → ${result.brief} (${result.brief.length} chars)\n`);
    done.push({ id: row.id, brief: result.brief });
  }

  console.log(`${done.length} brief(s) generated, ${skipped.length} skipped${skipped.length ? ` (#${skipped.join(", #")})` : ""}.`);

  if (!APPLY) {
    console.log("Dry run — nothing written. Re-run with --apply to write.");
    return;
  }
  if (done.length === 0) {
    console.log("Nothing to write.");
    return;
  }
  const lines = done.map(
    ({ id, brief }) => `UPDATE feed SET brief = ${sqlString(brief)} WHERE id = ${Number(id)} AND brief IS NULL;`
  );
  const file = join(tmpdir(), `canopy-feed-briefs-${Date.now()}.sql`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${lines.length} UPDATE(s) to ${file}; running it ${TARGET}…`);
  process.stdout.write(wrangler(["--file", file]));
  console.log("Done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
