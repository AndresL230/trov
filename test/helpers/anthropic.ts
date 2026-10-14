// The Anthropic Messages API, as tests see it: real `Response` bodies in its shape (src/ai/client.ts reads
// them through the SDK with an injected fetch) — never the network.

/** A fake key. Never a real one: the suite blanks ANTHROPIC_API_KEY (vitest.config.ts). */
export const FAKE_ANTHROPIC_KEY = "sk-ant-FAKE_key_for_tests_0123456789";

export interface MessageOpts {
  stop_reason?: "end_turn" | "max_tokens" | "refusal" | "stop_sequence";
  /** The `usage` block; `false` leaves it out. */
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | false;
  /** Content blocks sent before the text (a `thinking` block, as Haiku 5.5 may answer with). */
  before?: unknown[];
}

/** A Messages API response body whose one text block is `text`. */
export function messageBody(text: string, o: MessageOpts = {}): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [...(o.before ?? []), { type: "text", text }],
    stop_reason: o.stop_reason ?? "end_turn",
    stop_sequence: null,
    ...(o.usage === false ? {} : {
      usage: { input_tokens: 321, output_tokens: 45, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o.usage },
    }),
  };
}

export function messageResponse(text: string, o: MessageOpts = {}): Response {
  return new Response(JSON.stringify(messageBody(text, o)), { status: 200, headers: { "content-type": "application/json" } });
}

/** An API error response in Anthropic's shape. */
export function errorResponse(status: number, message = "upstream said no"): Response {
  return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message } }), { status, headers: { "content-type": "application/json" } });
}

/** What a call sent, read back from the fetch's `init`. */
export interface SentMessage {
  model: string;
  max_tokens: number;
  system: { type: "text"; text: string; cache_control?: { type: string } }[];
  messages: { role: string; content: { type: "text"; text: string; cache_control?: { type: string } }[] }[];
  output_config: { effort?: string; format: { type: string; schema: Record<string, unknown> } };
}

export function sentMessage(init?: RequestInit): SentMessage {
  return JSON.parse(String(init?.body ?? "{}")) as SentMessage;
}

/** The text a summarizer call sent as its input (the one user block). */
export const sentInput = (init?: RequestInit): string => sentMessage(init).messages[0].content.at(-1)!.text;
