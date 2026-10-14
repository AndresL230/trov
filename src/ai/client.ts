// THE model client (docs/architecture/env.md › ANTHROPIC_API_KEY): one structured call — a system prompt
// and a text in, a zod-checked value out — behind a provider-agnostic interface, so a caller names WHAT it
// asks for (`AiKind`) and never which model answers. `providerFor` is the one place that choice is made;
// today every kind goes to Claude (claude-haiku-5-5), and another provider slots in there without a
// caller changing.
//
// The house rules every call keeps:
//   • It NEVER throws. A missing key, a network error, a timeout, a 4xx/5xx, a refusal, an answer cut off
//     at `max_tokens`, text that is not JSON, or JSON the schema rejects: all of it resolves to null, and
//     the caller falls back to what it does without a model (the excerpt, for summaries).
//   • It is never on a render path and never reachable from src/mcp.ts: only the capture-time summary
//     seams (src/tools/summarize.ts, via src/plans/summaries.ts) import it.
//   • Tests inject `fetchImpl` and answer with real Messages API `Response` bodies — never the network.
//   • No retries inside a call (`maxRetries: 0`): the next Sync or tick is the retry.
//   • Nothing the call carries reaches a log: a failure logs its error NAME and HTTP status only.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { toClaudeSchema } from "./schema";

/** What a call is for. A new use is one more member here (and a line in `providerFor`). */
export type AiKind = "summary_pr" | "summary_issue";

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
  kind: AiKind;
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

export interface AiProvider {
  /** The model that answers — the provenance a caller records beside what it stores. */
  readonly model: string;
  /** The checked answer and its size, or null on ANY failure (see the file header). Never throws. */
  structured<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: AiUsage } | null>;
}

export interface AiProviderOpts {
  apiKey?: string;
  /** The fetch the SDK sends through (stubbed in tests; the local stand-in under `wrangler dev`). */
  fetchImpl?: typeof fetch;
  /** The whole call's deadline; the in-flight request is aborted when it passes. */
  timeoutMs?: number;
  model?: string;
  /** Told the size of every call a response came back for — a refusal or an unparseable answer included,
   *  so metering sees the tokens it was billed. Never told the text. */
  onCall?: (usage: AiUsage) => void;
}

export const CLAUDE_MODEL = "claude-haiku-5-5";
export const AI_TIMEOUT_MS = 10_000;

/** The provider for `kind`, or null when the deployment has no key (the caller's no-model path). */
export function providerFor(kind: AiKind, opts: AiProviderOpts): AiProvider | null {
  if (!opts.apiKey) return null;
  return PROVIDERS[kind](opts.apiKey, opts);
}

const PROVIDERS: Record<AiKind, (apiKey: string, opts: AiProviderOpts) => AiProvider> = {
  summary_pr: claudeProvider,
  summary_issue: claudeProvider,
};

/** Claude over the Messages API, with structured outputs (`output_config.format: json_schema`). */
function claudeProvider(apiKey: string, opts: AiProviderOpts): AiProvider {
  const model = opts.model ?? CLAUDE_MODEL;
  const client = new Anthropic({ apiKey, fetch: opts.fetchImpl, timeout: opts.timeoutMs ?? AI_TIMEOUT_MS, maxRetries: 0 });
  return {
    model,
    async structured<T>(req: StructuredRequest<T>): Promise<{ value: T; usage: AiUsage } | null> {
      try {
        const breakpoint = req.cache ? { cache_control: { type: "ephemeral" as const } } : {};
        const system: Anthropic.TextBlockParam[] = [{ type: "text", text: req.system, ...(req.prefix ? {} : breakpoint) }];
        const content: Anthropic.TextBlockParam[] = [
          ...(req.prefix ? [{ type: "text" as const, text: req.prefix, ...breakpoint }] : []),
          { type: "text", text: req.input },
        ];
        const res = await client.messages.create({
          model,
          max_tokens: req.maxTokens,
          system,
          messages: [{ role: "user", content }],
          // Low effort: these are short, grounded answers, and the webhook waits on them.
          output_config: {
            effort: "low",
            format: { type: "json_schema", schema: toClaudeSchema(z.toJSONSchema(req.schema, { io: "input" }) as Record<string, unknown>) },
          },
        });
        // A response came back: its size is reported whatever becomes of the answer.
        const text = res.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text ?? "";
        const usage: AiUsage = {
          inputTokens: count(res.usage?.input_tokens),
          outputTokens: count(res.usage?.output_tokens),
          cachedTokens: count(res.usage?.cache_read_input_tokens),
          inputChars: req.system.length + (req.prefix?.length ?? 0) + req.input.length,
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
      } catch (err) {
        // A timeout/abort, a network error, an API error, or text that is not JSON. The name and status
        // only: an SDK error's message can quote the request.
        const status = err instanceof Anthropic.APIError && err.status ? ` status=${err.status}` : "";
        console.error(`ai (${req.kind}) failed: ${err instanceof Error ? err.name : "error"}${status}`);
        return null;
      }
    },
  };
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
