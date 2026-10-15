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
