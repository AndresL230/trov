// THE read rule of every computed AI surface (src/plans/gate.ts `aiShown`; docs/architecture/ai.md › The read rule):
// a deployment with no Anthropic key reads EXACTLY like the org's switch off — no brief, state, themes, Roadmap note,
// drift or suggestion, and no decision on one. The pool blanks the key (vitest.config.ts), so a suite that reads
// those surfaces, or decides a suggestion, holds a FAKE key on the pool's env for each of its tests: `useAiKey()` at
// the top of the file or a describe. Never a real key, and never the network: every summarizer seam those suites
// reach is injected (`summarizer: null`), and the AI pass is handed stub providers.
import { afterEach, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { FAKE_ANTHROPIC_KEY } from "./anthropic";

type Keyed = { ANTHROPIC_API_KEY?: string };

/** Set the fake key on the pool's env before each test and blank it after. */
export function useAiKey(): void {
  beforeEach(() => { (env as unknown as Keyed).ANTHROPIC_API_KEY = FAKE_ANTHROPIC_KEY; });
  afterEach(() => { (env as unknown as Keyed).ANTHROPIC_API_KEY = ""; });
}

/** Run `fn` with the pool's key blanked — what a deployment with no key reads — and put the fake one back after. */
export async function withoutAiKey<T>(fn: () => Promise<T>): Promise<T> {
  const k = env as unknown as Keyed;
  const held = k.ANTHROPIC_API_KEY;
  k.ANTHROPIC_API_KEY = "";
  try { return await fn(); } finally { k.ANTHROPIC_API_KEY = held; }
}
