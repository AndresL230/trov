// THE model client (docs/architecture/ai.md › Where a model call may happen; env.md): a caller names WHAT it
// asks for (`AiKind`) and never which model answers. `KIND_PROVIDER` is the ONE table from a kind to its
// provider, and `providerFor` the one place that choice is made:
//   • `claude` — Anthropic's Messages API (claude-haiku-5-5): one structured call — a system prompt and a
//     text in, a zod-checked value out. It writes words: the summaries today, the AI pass's producers later.
//   • `jev`    — TypeSafe AI's Jev (src/tools/classify.ts, the ONLY file that names TypeSafe's URL): a
//     non-generative decision model that answers yes/no, pick-one and score questions with numbers. It
//     classifies and gates: Sift (`tag.fit`) today.
//
// The house rules every call keeps:
//   • It NEVER throws. A missing key, a network error, a timeout, a 4xx/5xx, a refusal, an answer cut off
//     at `max_tokens`, text that is not JSON, or JSON the schema rejects: all of it resolves to null (for
//     Jev, no judgement), and the caller falls back to what it does without a model.
//   • It is never on a render path and never reachable from src/mcp.ts (test/secrets.mcp.test.ts pins who
//     imports it: the capture-time summary seams, the AI pass and the Sift run).
//   • Tests inject `fetchImpl` and answer with real `Response` bodies — never the network.
//   • No retries inside a Claude call (`maxRetries: 0`): the next Sync or tick is the retry. A Jev run keeps
//     its one retry of a 429 / 529 (src/tools/classify.ts).
//   • Nothing the call carries reaches a log: a failure logs its error NAME and HTTP status only.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { toClaudeSchema } from "./schema";
import { jevProvider, type JevProvider } from "../tools/classify";

export type {
  JevProvider, JevQuestion, JevAnswer, JevAsk, Classifier, ClassifyItem, ClassifyRequest, ClassifyHooks, ClassifyResult, Judgement,
} from "../tools/classify";

/** Who answers. */
export type AiProviderName = "claude" | "jev";

/** THE table: what a call is for → who answers it. A new use is one more line here; later phases add Jev's
 *  ticket, feed, review and gate kinds and Claude's producers (docs/superpowers/specs/2026-10-15-server-ai-build.md). */
export const KIND_PROVIDER = {
  summary_pr: "claude",
  summary_issue: "claude",
  // Sift: "does this item fit this tag?" (src/ai/sift.ts).
  "tag.fit": "jev",
} as const satisfies Record<string, AiProviderName>;

/** What a call is for. */
export type AiKind = keyof typeof KIND_PROVIDER;
/** The kinds each provider answers. */
export type ClaudeKind = { [K in AiKind]: (typeof KIND_PROVIDER)[K] extends "claude" ? K : never }[AiKind];
export type JevKind = { [K in AiKind]: (typeof KIND_PROVIDER)[K] extends "jev" ? K : never }[AiKind];

/** One call's size, for metering. Tokens are the provider's own counts: `inputTokens` the uncached input,
 *  `cachedTokens` the input served from the prompt cache (`cache_read_input_tokens`). Characters are
 *  what was sent (system + prefix + input) and the answer's text. Sizes only — never the text. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  inputChars: number;
  outputChars: number;
}

export interface StructuredRequest<T> {
  kind: ClaudeKind;
  system: string;
  /** A stable block sent before `input` (what a cache breakpoint marks, when `cache` is set). */
  prefix?: string;
  input: string;
  /** The answer's shape. Its JSON Schema (made acceptable by `toClaudeSchema`) constrains the output; the
   *  zod schema itself then checks the parsed answer, caps included. */
  schema: z.ZodType<T>;
  maxTokens: number;
  /** Mark the prefix (or, with no prefix, the system prompt) as a prompt-cache breakpoint. */
  cache?: boolean;
}

export interface ClaudeProvider {
  readonly name: "claude";
  /** The model that answers — the provenance a caller records beside what it stores. */
  readonly model: string;
  /** The checked answer and its size, or null on ANY failure (see the file header). Never throws. */
  structured<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: AiUsage } | null>;
  // ── the Message Batches API (the AI pass's non-urgent kinds: src/ai/batches.ts) ──
  /** Create ONE batch of structured requests — each sent exactly as `structured` would send it. Null on any
   *  failure (nothing was created, as far as Trov can tell). Never throws. */
  submitBatch(reqs: readonly ClaudeBatchRequest[]): Promise<ClaudeBatch | null>;
  /** A batch's status; `gone` when the provider no longer knows it (404); null on any other failure. */
  retrieveBatch(id: string): Promise<ClaudeBatch | "gone" | null>;
  /** An ENDED batch's results (two requests: the batch, then its results file); null on any failure. */
  batchResults(id: string): Promise<ClaudeBatchResult[] | null>;
  /** One batch result's message read EXACTLY as `structured` reads its own answer: a refusal, `max_tokens`, text
   *  that is not JSON or JSON the schema rejects is null. The size goes to `onCall` either way. */
  answer<T>(req: Pick<StructuredRequest<T>, "kind" | "schema">, message: unknown): { value: T; usage: AiUsage } | null;
}

/** One request of a batch. `requestId` is what the provider echoes back (`[A-Za-z0-9_-]{1,64}`). */
export interface ClaudeBatchRequest { requestId: string; req: StructuredRequest<unknown> }
export interface ClaudeBatch {
  id: string;
  ended: boolean;
  /** The provider's own tallies (all `processing` until the whole batch ends). */
  counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
}
export type ClaudeBatchResult =
  | { requestId: string; type: "succeeded"; message: unknown }
  | { requestId: string; type: "errored" | "canceled" | "expired" };

/** Either provider; `name` tells them apart. */
export type AiProvider = ClaudeProvider | JevProvider;
/** The provider a kind gets. */
export type ProviderOf<K extends AiKind> = (typeof KIND_PROVIDER)[K] extends "jev" ? JevProvider : ClaudeProvider;

export interface AiProviderOpts {
  /** The key of the provider the kind goes to: `ANTHROPIC_API_KEY` for Claude, `TYPESAFE_API_KEY` for Jev. */
  apiKey?: string;
  /** The fetch the SDK sends through (stubbed in tests; the local stand-in under `wrangler dev`). */
  fetchImpl?: typeof fetch;
  /** The whole call's deadline; the in-flight request is aborted when it passes. */
  timeoutMs?: number;
  model?: string;
  /** Told the size of every call a response came back for — a refusal or an unparseable answer included,
   *  so metering sees the tokens it was billed. Never told the text. */
  onCall?: (usage: AiUsage) => void;
  /** Jev only: the wait before a run's one retry of a 429 / 529, and how many requests a run keeps in flight. */
  retryDelayMs?: number;
  concurrency?: number;
}

export const CLAUDE_MODEL = "claude-haiku-5-5";
export const AI_TIMEOUT_MS = 10_000;

/** The provider for `kind`, or null when the deployment has no key for it (the caller's no-model path). */
export function providerFor<K extends AiKind>(kind: K, opts: AiProviderOpts): ProviderOf<K> | null {
  if (!opts.apiKey) return null;
  const name: AiProviderName = KIND_PROVIDER[kind];
  return (name === "jev" ? jevProvider(opts.apiKey, opts) : claudeProvider(opts.apiKey, opts)) as ProviderOf<K>;
}

/** The Messages API body for one structured request — what `structured` sends, and what one batch request carries. */
function messageParams(model: string, req: StructuredRequest<unknown>): Anthropic.MessageCreateParamsNonStreaming {
  const breakpoint = req.cache ? { cache_control: { type: "ephemeral" as const } } : {};
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: req.system, ...(req.prefix ? {} : breakpoint) }];
  const content: Anthropic.TextBlockParam[] = [
    ...(req.prefix ? [{ type: "text" as const, text: req.prefix, ...breakpoint }] : []),
    { type: "text", text: req.input },
  ];
  return {
    model,
    max_tokens: req.maxTokens,
    system,
    messages: [{ role: "user", content }],
    // Low effort: these are short, grounded answers, and the webhook waits on them.
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: toClaudeSchema(z.toJSONSchema(req.schema, { io: "input" }) as Record<string, unknown>) },
    },
  };
}

/** Read one Message as the answer to `req`: its size goes to `onCall` whatever becomes of the answer; then null
 *  for a refusal, an answer cut off at `max_tokens`, or JSON the schema rejects. Text that is not JSON THROWS
 *  (the caller's catch logs it). */
function readAnswer<T>(req: Pick<StructuredRequest<T>, "kind" | "schema">, res: Anthropic.Message, sentChars: number, opts: AiProviderOpts): { value: T; usage: AiUsage } | null {
  const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
  const usage: AiUsage = {
    inputTokens: count(res.usage?.input_tokens),
    outputTokens: count(res.usage?.output_tokens),
    cachedTokens: count(res.usage?.cache_read_input_tokens),
    inputChars: sentChars,
    outputChars: text.length,
  };
  try { opts.onCall?.(usage); } catch { /* a listener never fails a call */ }
  // A refusal, or an answer cut off at max_tokens, may not match the schema even when it parses.
  if (res.stop_reason === "refusal" || res.stop_reason === "max_tokens") {
    console.error(`ai (${req.kind}) no answer: stop_reason=${res.stop_reason}`);
    return null;
  }
  const parsed = req.schema.safeParse(JSON.parse(text));
  return parsed.success ? { value: parsed.data, usage } : null;
}

/** A failure's NAME and HTTP status only: an SDK error's message can quote the request. */
function logFailure(what: string, err: unknown): void {
  const status = err instanceof Anthropic.APIError && err.status ? ` status=${err.status}` : "";
  console.error(`ai (${what}) failed: ${err instanceof Error ? err.name : "error"}${status}`);
}

function batchOf(b: Anthropic.Messages.MessageBatch): ClaudeBatch {
  const c = b.request_counts;
  return {
    id: b.id,
    ended: b.processing_status === "ended",
    counts: { processing: count(c?.processing), succeeded: count(c?.succeeded), errored: count(c?.errored), canceled: count(c?.canceled), expired: count(c?.expired) },
  };
}

/** Claude over the Messages API, with structured outputs (`output_config.format: json_schema`). */
function claudeProvider(apiKey: string, opts: AiProviderOpts): ClaudeProvider {
  const model = opts.model ?? CLAUDE_MODEL;
  const client = new Anthropic({ apiKey, fetch: opts.fetchImpl, timeout: opts.timeoutMs ?? AI_TIMEOUT_MS, maxRetries: 0 });
  return {
    name: "claude",
    model,
    async structured<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: AiUsage } | null> {
      try {
        const res = await client.messages.create(messageParams(model, req as StructuredRequest<unknown>));
        return readAnswer(req, res, req.system.length + (req.prefix?.length ?? 0) + req.input.length, opts);
      } catch (err) {
        // A timeout/abort, a network error, an API error, or text that is not JSON.
        logFailure(req.kind, err);
        return null;
      }
    },
    async submitBatch(reqs) {
      if (!reqs.length) return null;
      try {
        return batchOf(await client.messages.batches.create({
          requests: reqs.map((r) => ({ custom_id: r.requestId, params: messageParams(model, r.req) })),
        }));
      } catch (err) {
        logFailure("batch create", err);
        return null;
      }
    },
    async retrieveBatch(id) {
      try {
        return batchOf(await client.messages.batches.retrieve(id));
      } catch (err) {
        if (err instanceof Anthropic.APIError && err.status === 404) return "gone";
        logFailure("batch retrieve", err);
        return null;
      }
    },
    async batchResults(id) {
      try {
        const out: ClaudeBatchResult[] = [];
        for await (const line of await client.messages.batches.results(id)) {
          if (typeof line?.custom_id !== "string") continue;
          const r = line.result;
          if (r?.type === "succeeded") out.push({ requestId: line.custom_id, type: "succeeded", message: r.message });
          else if (r?.type === "errored" || r?.type === "canceled" || r?.type === "expired") out.push({ requestId: line.custom_id, type: r.type });
        }
        return out;
      } catch (err) {
        logFailure("batch results", err);
        return null;
      }
    },
    answer<T>(req: Pick<StructuredRequest<T>, "kind" | "schema">, message: unknown): { value: T; usage: AiUsage } | null {
      try {
        if (!message || typeof message !== "object" || !Array.isArray((message as { content?: unknown }).content)) return null;
        return readAnswer(req, message as Anthropic.Message, 0, opts);
      } catch (err) {
        logFailure(req.kind, err);
        return null;
      }
    },
  };
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
