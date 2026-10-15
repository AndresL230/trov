// THE Jev provider (src/ai/client.ts `providerFor` hands it out for every Jev kind — `KIND_PROVIDER` names
// them; issue #155). TypeSafe AI's Jev (`POST https://api.typesafe.ai/v1/systemone`) is a NON-generative
// decision model: it answers questions about ONE item (`state`) with numbers and writes no text at all. This
// file is the ONLY place in src/ and shared/ that names TypeSafe's URL (test/secrets.mcp.test.ts), and
// only src/ai/client.ts imports it — a caller names a KIND, never a provider.
//
// Two ways in:
//   • `classify` — a RUN: one yes/no (`noul`) question asked of many items, one request per item. What Sift
//     (src/ai/sift.ts) uses; its behaviour is unchanged from before the provider split:
//       in   a KIND of judgement, a yes/no question about each item (with what "yes" and "no" mean), the two
//            allowed answers, and items (an id, the text the model reads, and the EVIDENCE Trov already has)
//       out  per item: one of the two answers, a confidence 0–1 and a one-sentence reason
//     the answer is "yes" (`answers[0]`) when the probability is ≥ 0.5, else "no" (`answers[1]`), and the
//     confidence is the probability of the answer given; the REASON is never the model's — it is the item's
//     `evidence`, which Trov built from what made the item a candidate (src/tools/tag-fit.ts: the full-text
//     snippet around the match). Nothing is invented.
//   • `ask` — ONE request about one item carrying several questions of the three types Jev has (verified
//     2026-10-15, docs/superpowers/specs/2026-10-14-ai-base.md): `noul` (yes/no → a probability), `choice`
//     (pick one of ≤255 named options → the option, the probabilities, a confidence) and `score` (2–10 ordered
//     levels → a fractional level, the probabilities, a confidence). Each answer is parsed against the
//     question that was asked and is null when it is malformed in ANY way — never a guess. No retry inside
//     `ask`: the status comes back, and the caller (the AI pass) decides.
//
// A run asks at most `CONCURRENCY` requests at once. Before EACH request the caller's `gate` is asked (the
// org's switches and its monthly allowance; it also counts the call): a "no" stops the run. Per request:
//   • 2xx with `answers.<key>` of type `noul` and a number 0–1 → a judgement; anything else → none for that item
//   • 422 (validation), a non-JSON body, a timeout, a network error → none for that item; the run goes on
//   • 429 (rate limited) or 529 (overloaded) → one retry after a short delay; again → the run STOPS
//   • 401 (bad key) or any other answer → the run STOPS (every later call would fail the same way)
// Nothing ever surfaces to a person and nothing throws: no judgement is simply no suggestion.
//
// The fetch is INJECTED (`fetchImpl`) like the Claude provider's, so tests stub it at the Response level and
// never reach the network. Never on a render path, and never reachable from src/mcp.ts
// (test/secrets.mcp.test.ts): it is called from background work only.

export interface ClassifyItem {
  id: string;
  /** What the model reads (`state`): already cut and scrubbed by the caller. */
  text: string;
  /** Trov's own evidence for the item — the reason a suggestion shows — or null when Trov has none (the
   *  caller then says honestly that it is the model's score, never an invented quote). */
  evidence: string | null;
}
export interface Judgement { id: string; answer: string; confidence: number; reason: string | null; model: string }

export interface ClassifyRequest {
  /** What is being judged, e.g. `tag.fit`. */
  kind: string;
  /** The yes/no question asked of every item (`instructions`)… */
  question: string;
  /** …and what each answer means (`criteria`). */
  criteria: { true: string; false: string };
  /** [the "yes" answer, the "no" answer]. */
  answers: readonly [string, string];
  items: readonly ClassifyItem[];
}

export interface ClassifyHooks {
  /** Asked before EACH request — may it be made? (It counts the call when it says yes.) */
  gate?: () => Promise<boolean>;
  /** Told when an item is done — its judgement, or null when there is none — so the caller can store it and
   *  show progress as the run goes. Not called for an item the run stopped before finishing. */
  onItem?: (item: ClassifyItem, judgement: Judgement | null) => Promise<void>;
}

export interface ClassifyResult {
  judgements: Judgement[];
  /** Requests made (each one passed the gate). */
  calls: number;
  /** Why it stopped before the end, or null: the gate said no, or the provider refused (bad key, rate limit). */
  stopped: null | "gate" | "provider";
}

export interface Classifier {
  /** The prompt's version, recorded beside the model on every suggestion — bump it when the question changes. */
  readonly promptVersion: string;
  /** Never throws. */
  classify(req: ClassifyRequest, hooks?: ClassifyHooks): Promise<ClassifyResult>;
}

// ── several questions about one item (`ask`) ─────────────────────────────────

/** One question, in TypeSafe's own shape. `noul`: yes/no, with what each means. `choice`: pick ONE of the
 *  named options (2–255), each with a description or null. `score`: one of 2–10 ordered levels, lowest first. */
export type JevQuestion =
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

/** A parsed answer. `noul.p` is the probability of yes. `choice.choice` is one of the options asked, its
 *  `probabilities` keyed by option. `score.score` is a fractional level index 0..levels-1 and `level` the
 *  name of the nearest one; `probabilities[i]` is level i's. */
export type JevAnswer =
  | { type: "noul"; p: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; level: string; probabilities: number[]; confidence: number };

/** The answer to `ask`: per question id, its parsed answer or null (malformed, missing, or of another type
 *  than asked); or why there is none — `status` 0 for a timeout, a network error or a body that is not JSON,
 *  -1 for questions Trov refused to send (none, a blank instruction, too few or too many options or levels). */
export type JevAsk =
  | { ok: true; model: string; answers: Record<string, JevAnswer | null>; usage: { inputTokens: number; outputTokens: number } }
  | { ok: false; status: number };

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** The model asked for; the response names the exact version that answered (stored on each suggestion). */
export const JEV_MODEL = "jev-latest";
export const CLASSIFY_PROMPT_VERSION = "jev-fit-1";
/** The key of the one question in each request. */
export const QUESTION_KEY = "fits";
export const CLASSIFY_TIMEOUT_MS = 10000;
/** Requests in flight at once. */
export const CONCURRENCY = 4;
/** The wait before the one retry of a 429 / 529. */
export const RETRY_DELAY_MS = 1500;
/** TypeSafe documents 255 characters as the most for a `choice` criterion; the same cap is kept here. */
const CRITERION_MAX = 255;
/** TypeSafe's bounds: a `choice` has at most 255 options; a `score` has 2–10 levels. */
export const CHOICE_OPTIONS_MAX = 255;
export const SCORE_LEVELS_MIN = 2;
export const SCORE_LEVELS_MAX = 10;

export interface ClassifierOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  concurrency?: number;
}

/** THE Jev provider: what `providerFor` returns for a Jev kind (src/ai/client.ts). */
export interface JevProvider extends Classifier {
  readonly name: "jev";
  /** The model asked for (`jev-latest`); each answer names the version that answered. */
  readonly model: string;
  /** One request about one item with several questions. Never throws. */
  ask(state: string, questions: Record<string, JevQuestion>): Promise<JevAsk>;
}

const prob = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const modelOf = (b: { model?: unknown } | null): string | null =>
  typeof b?.model === "string" && b.model.trim() ? b.model.trim().slice(0, 60) : null;

/** A `noul` probability from a Jev answer body, or null when it is not one. */
export function noulOf(body: unknown, key = QUESTION_KEY): { p: number; model: string | null } | null {
  const b = body as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> } | null;
  const a = b?.answers?.[key];
  if (!a || a.type !== "noul" || !prob(a.noul)) return null;
  return { p: a.noul, model: modelOf(b) };
}

/** A probabilities object whose keys are exactly `keys` (each 0–1), or null. */
function probabilities(v: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).length !== keys.length || !keys.every((k) => Object.prototype.hasOwnProperty.call(o, k) && prob(o[k]))) return null;
  return Object.fromEntries(keys.map((k) => [k, o[k] as number]));
}

/** One answer, parsed against the question that was asked: null on ANY mismatch. */
export function answerOf(q: JevQuestion, raw: unknown): JevAnswer | null {
  const a = raw as Record<string, unknown> | null;
  if (!a || typeof a !== "object" || Array.isArray(a) || a.type !== q.type) return null;
  if (q.type === "noul") return prob(a.noul) ? { type: "noul", p: a.noul } : null;
  if (q.type === "choice") {
    const options = Object.keys(q.criteria);
    if (typeof a.choice !== "string" || !options.includes(a.choice) || !prob(a.confidence)) return null;
    const p = probabilities(a.probabilities, options);
    return p ? { type: "choice", choice: a.choice, probabilities: p, confidence: a.confidence } : null;
  }
  const n = q.criteria.length;
  if (typeof a.score !== "number" || !Number.isFinite(a.score) || a.score < 0 || a.score > n - 1 || !prob(a.confidence)) return null;
  const idx = Array.from({ length: n }, (_, i) => String(i));
  const p = probabilities(a.probabilities, idx);
  if (!p) return null;
  return { type: "score", score: a.score, level: q.criteria[Math.round(a.score)], probabilities: idx.map((i) => p[i]), confidence: a.confidence };
}

/** Questions Trov may send: at least one, each with instructions; a choice of 2–255 options; a score of 2–10 levels. */
function sendable(questions: Record<string, JevQuestion>): boolean {
  const qs = Object.values(questions);
  return qs.length > 0 && qs.every((q) => {
    if (typeof q.instructions !== "string" || !q.instructions.trim()) return false;
    if (q.type === "choice") { const n = Object.keys(q.criteria).length; return n >= 2 && n <= CHOICE_OPTIONS_MAX; }
    if (q.type === "score") return q.criteria.length >= SCORE_LEVELS_MIN && q.criteria.length <= SCORE_LEVELS_MAX;
    return q.type === "noul";
  });
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** A question as it is sent: every criterion cut to TypeSafe's 255 characters. */
function wire(q: JevQuestion): Record<string, unknown> {
  if (q.type === "noul") {
    return { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: { true: clip(q.criteria.true, CRITERION_MAX), false: clip(q.criteria.false, CRITERION_MAX) } } : {}) };
  }
  if (q.type === "choice") {
    return { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(Object.entries(q.criteria).map(([k, v]) => [k, v === null ? null : clip(v, CRITERION_MAX)])) };
  }
  return { type: "score", instructions: q.instructions, criteria: q.criteria.map((l) => clip(l, CRITERION_MAX)) };
}

/** The Jev provider. */
export function jevProvider(apiKey: string, opts: ClassifierOpts = {}): JevProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CLASSIFY_TIMEOUT_MS;
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const width = Math.max(1, opts.concurrency ?? CONCURRENCY);

  /** One request: the answer body, or what went wrong. */
  async function post(state: string, questions: Record<string, unknown>): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(JEV_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: JEV_MODEL, state, questions }),
        signal: controller.signal,
      });
      if (!res.ok) return { ok: false, status: res.status };
      return { ok: true, body: await res.json() };
    } catch {
      return { ok: false, status: 0 }; // a timeout (abort), a network error, a body that is not JSON
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: "jev",
    model: JEV_MODEL,
    promptVersion: CLASSIFY_PROMPT_VERSION,

    async ask(state, questions) {
      if (!sendable(questions)) return { ok: false, status: -1 };
      const r = await post(state, Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, wire(q)])));
      if (!r.ok) return r;
      const b = r.body as { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens?: unknown; output_tokens?: unknown } } | null;
      const answers = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, answerOf(q, b?.answers?.[id])]));
      return { ok: true, model: modelOf(b) ?? JEV_MODEL, answers, usage: { inputTokens: count(b?.usage?.input_tokens), outputTokens: count(b?.usage?.output_tokens) } };
    },

    async classify(req, hooks = {}) {
      const judgements: Judgement[] = [];
      let calls = 0;
      let stopped: ClassifyResult["stopped"] = null;
      let next = 0;
      const question = wire({ type: "noul", instructions: req.question, criteria: req.criteria });
      const ask = (item: ClassifyItem) => post(item.text, { [QUESTION_KEY]: question });
      // The gate is asked one request at a time, so the allowance it checks (and counts) can never be
      // overrun by the requests running beside it.
      let lock: Promise<unknown> = Promise.resolve();
      const pass = (): Promise<boolean> => {
        const turn = lock.then(async () => (stopped ? false : hooks.gate ? hooks.gate() : true));
        lock = turn.catch(() => false);
        return turn.catch(() => false);
      };
      const done = async (item: ClassifyItem, j: Judgement | null): Promise<void> => {
        try { await hooks.onItem?.(item, j); } catch { /* progress is best-effort; the judgement stands */ }
      };
      const worker = async (): Promise<void> => {
        while (!stopped && next < req.items.length) {
          const item = req.items[next++];
          if (!(await pass())) { stopped ??= "gate"; return; }
          calls++;
          let r = await ask(item);
          if (!r.ok && (r.status === 429 || r.status === 529)) {
            await new Promise((done) => setTimeout(done, retryDelay));
            if (stopped) return;
            if (!(await pass())) { stopped ??= "gate"; return; } // the retry is a call too
            calls++;
            r = await ask(item);
          }
          if (!r.ok) {
            if (r.status === 422 || r.status === 0) { await done(item, null); continue; } // this item only
            stopped ??= "provider";                              // 401, 429/529 twice, anything else
            return;
          }
          const n = noulOf(r.body);
          if (!n) { await done(item, null); continue; }
          const yes = n.p >= 0.5;
          const j: Judgement = {
            id: item.id, answer: yes ? req.answers[0] : req.answers[1], confidence: yes ? n.p : 1 - n.p,
            reason: item.evidence, model: n.model ?? JEV_MODEL,
          };
          judgements.push(j);
          await done(item, j);
        }
      };
      try {
        await Promise.all(Array.from({ length: Math.min(width, req.items.length) }, worker));
      } catch {
        stopped ??= "provider";
      }
      return { judgements, calls, stopped };
    },
  };
}
