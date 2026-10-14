// THE classify call (issue #155): one internal function every "instant intelligence" use goes through,
// instead of each feature calling a model its own way.
//
//   in   a KIND of judgement, a yes/no question about each item (with what "yes" and "no" mean), the two
//        allowed answers, and items (an id, the text the model reads, and the EVIDENCE Trov already has)
//   out  per item: one of the two answers, a confidence 0–1 and a one-sentence reason
//
// The model is TypeSafe AI's Jev (`POST https://api.typesafe.ai/v1/systemone`), a NON-generative decision
// model: it answers a `noul` (yes/no) question with a probability and writes no text at all. So:
//   • the answer is "yes" (`answers[0]`) when the probability is ≥ 0.5, else "no" (`answers[1]`), and the
//     confidence is the probability of the answer given;
//   • the REASON is never the model's — it is the item's `evidence`, which Trov built from what made the item
//     a candidate (src/tools/tag-fit.ts: the full-text snippet around the match). Nothing is invented.
//
// ONE request per item (TypeSafe's docs state no limit on questions per request, on the size of `state`,
// on rate or on price — so this asks the smallest thing, one item and one question at a time), at most
// `CONCURRENCY` in flight. Before EACH request the caller's `gate` is asked (the org's switch and its
// monthly allowance; it also counts the call): a "no" stops the run. Per request:
//   • 2xx with `answers.<key>` of type `noul` and a number 0–1 → a judgement; anything else → none for that item
//   • 422 (validation), a non-JSON body, a timeout, a network error → none for that item; the run goes on
//   • 429 (rate limited) or 529 (overloaded) → one retry after a short delay; again → the run STOPS
//   • 401 (bad key) or any other answer → the run STOPS (every later call would fail the same way)
// Nothing ever surfaces to a person and nothing throws: no judgement is simply no suggestion.
//
// The provider is INJECTED (`fetchImpl`) like the summarizer's, so tests stub it at the Response level and
// never reach the network. Never on a render path: it is called from background work only.

export interface ClassifyItem {
  id: string;
  /** What the model reads (`state`): already cut and scrubbed by the caller. */
  text: string;
  /** Trov's own evidence for the item — the reason a suggestion shows. */
  evidence: string;
}
export interface Judgement { id: string; answer: string; confidence: number; reason: string; model: string }

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

export interface ClassifierOpts {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retryDelayMs?: number;
  concurrency?: number;
}

/** A `noul` probability from a Jev answer body, or null when it is not one. */
export function noulOf(body: unknown, key = QUESTION_KEY): { p: number; model: string | null } | null {
  const b = body as { model?: unknown; answers?: Record<string, { type?: unknown; noul?: unknown }> } | null;
  const a = b?.answers?.[key];
  if (!a || a.type !== "noul" || typeof a.noul !== "number" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) return null;
  return { p: a.noul, model: typeof b?.model === "string" && b.model.trim() ? b.model.trim().slice(0, 60) : null };
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** The Jev classifier. */
export function jevClassifier(apiKey: string, opts: ClassifierOpts = {}): Classifier {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? CLASSIFY_TIMEOUT_MS;
  const retryDelay = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const width = Math.max(1, opts.concurrency ?? CONCURRENCY);

  /** One request: the answer body, or what went wrong. */
  async function ask(req: ClassifyRequest, item: ClassifyItem): Promise<{ ok: true; body: unknown } | { ok: false; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(JEV_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: item.text,
          questions: {
            [QUESTION_KEY]: {
              type: "noul",
              instructions: req.question,
              criteria: { true: clip(req.criteria.true, CRITERION_MAX), false: clip(req.criteria.false, CRITERION_MAX) },
            },
          },
        }),
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
    promptVersion: CLASSIFY_PROMPT_VERSION,
    async classify(req, hooks = {}) {
      const judgements: Judgement[] = [];
      let calls = 0;
      let stopped: ClassifyResult["stopped"] = null;
      let next = 0;
      // The gate is asked one request at a time, so the allowance it checks (and counts) can never be
      // overrun by the requests running beside it.
      let lock: Promise<unknown> = Promise.resolve();
      const pass = (): Promise<boolean> => {
        const turn = lock.then(async () => (stopped ? false : hooks.gate ? hooks.gate() : true));
        lock = turn.catch(() => false);
        return turn.catch(() => false);
      };
      const worker = async (): Promise<void> => {
        while (!stopped && next < req.items.length) {
          const item = req.items[next++];
          if (!(await pass())) { stopped ??= "gate"; return; }
          calls++;
          let r = await ask(req, item);
          if (!r.ok && (r.status === 429 || r.status === 529)) {
            await new Promise((done) => setTimeout(done, retryDelay));
            if (stopped) return;
            if (!(await pass())) { stopped ??= "gate"; return; } // the retry is a call too
            calls++;
            r = await ask(req, item);
          }
          if (!r.ok) {
            if (r.status === 422 || r.status === 0) continue;    // this item only
            stopped ??= "provider";                              // 401, 429/529 twice, anything else
            return;
          }
          const n = noulOf(r.body);
          if (!n) continue;
          const yes = n.p >= 0.5;
          judgements.push({
            id: item.id, answer: yes ? req.answers[0] : req.answers[1], confidence: yes ? n.p : 1 - n.p,
            reason: item.evidence, model: n.model ?? JEV_MODEL,
          });
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
