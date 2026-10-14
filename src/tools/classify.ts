// THE classify call (issue #155): one internal function every "instant intelligence" use goes through,
// instead of each feature calling a model its own way.
//
//   in   a KIND of judgement, a one-paragraph question, the fixed list of ALLOWED answers, and items
//        (an id and a short text each)
//   out  per item: one answer FROM THAT LIST, a confidence 0–1 and a one-sentence reason
//
// Structured output, validated: an item whose answer is not in the list, whose confidence is not a number
// in 0–1, whose reason is empty or long, or whose id was not sent, is DISCARDED — that item simply has no
// judgement. A timeout, a network error, a non-2xx answer or prose instead of JSON: no judgement for any
// item, and nothing surfaces to a person (`null`). It never throws.
//
// Never on a render path: it is called from background work only (src/tools/tag-fit.ts). The provider is
// INJECTED like the summarizer's (src/tools/summarize.ts — the same Gemini model and platform key), so
// tests stub it at the Response level and never reach the network.
import { GEMINI_TIMEOUT_MS, parseStructuredJson } from "./summarize";

export interface ClassifyItem { id: string; text: string }
export interface Judgement { id: string; answer: string; confidence: number; reason: string }

export interface ClassifyRequest {
  /** What is being judged, e.g. `tag.fit` — part of the prompt's identity (`promptVersion`). */
  kind: string;
  /** The question, in plain words, asked of every item. */
  question: string;
  /** The ONLY answers accepted. */
  answers: readonly string[];
  items: readonly ClassifyItem[];
}

export interface Classifier {
  /** Recorded on every suggestion it produces. */
  readonly model: string;
  /** The prompt's version, recorded beside the model — bump `CLASSIFY_PROMPT_VERSION` when the prompt changes. */
  readonly promptVersion: string;
  /** Judgements for the items it could judge, or null when the call failed. Never throws. */
  classify(req: ClassifyRequest): Promise<Judgement[] | null>;
}

export const CLASSIFY_MODEL = "gemini-2.5-flash-lite";
export const CLASSIFY_PROMPT_VERSION = "classify-1";
/** A reason longer than this is not one sentence: the item is discarded. */
export const REASON_MAX = 240;

export const CLASSIFY_SYSTEM_PROMPT =
  "You label short items for a team's knowledge base. For EACH item, answer the question with exactly one of the allowed answers. " +
  "Respond with a SINGLE JSON object and nothing else — no code fences, no preamble: " +
  '{"results": [{"id": string, "answer": string, "confidence": number, "reason": string}]}. ' +
  '"id": the item\'s id exactly as given. "answer": one of the allowed answers, spelled exactly. ' +
  '"confidence": how sure you are, from 0 to 1. "reason": ONE short plain sentence, grounded only in the item\'s text. ' +
  "Judge only from the text given; never invent facts. An item you cannot judge may be left out.";

export interface ClassifierOpts {
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Keep the judgements that are well-formed and about an item that was sent; drop the rest. */
export function validateJudgements(o: Record<string, unknown> | null, req: Pick<ClassifyRequest, "answers" | "items">): Judgement[] {
  const results = o?.results;
  if (!Array.isArray(results)) return [];
  const sent = new Set(req.items.map((i) => i.id));
  const seen = new Set<string>();
  const out: Judgement[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const { id, answer, confidence, reason } = r as Record<string, unknown>;
    if (typeof id !== "string" || !sent.has(id) || seen.has(id)) continue;
    if (typeof answer !== "string" || !req.answers.includes(answer)) continue;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    if (typeof reason !== "string") continue;
    const why = reason.replace(/\s+/g, " ").trim();
    if (!why || why.length > REASON_MAX) continue;
    seen.add(id);
    out.push({ id, answer, confidence, reason: why });
  }
  return out;
}

/** The Gemini classifier. One HTTP call per `classify`, raced against a timeout. */
export function geminiClassifier(apiKey: string, opts: ClassifierOpts = {}): Classifier {
  const model = opts.model ?? CLASSIFY_MODEL;
  const timeoutMs = opts.timeoutMs ?? GEMINI_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    model,
    promptVersion: CLASSIFY_PROMPT_VERSION,
    async classify(req) {
      if (req.items.length === 0) return [];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const userText = JSON.stringify({ kind: req.kind, question: req.question, allowed_answers: req.answers, items: req.items });
      try {
        const res = await doFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: CLASSIFY_SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: userText }] }],
            generationConfig: { response_mime_type: "application/json", temperature: 0 },
          }),
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (typeof text !== "string") return null;
        const parsed = parseStructuredJson(text);
        return parsed ? validateJudgements(parsed, req) : null;
      } catch {
        return null; // a timeout (abort), a network error, a body that is not JSON
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
