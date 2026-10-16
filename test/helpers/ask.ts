// Ask Trov in tests (docs/architecture/ask.md): the Anthropic Messages API's STREAM, as real SSE `Response` bodies
// in its wire shape (src/ai/ask/turn.ts reads them through the SDK with an injected fetch) — never the network —
// plus a cookie client for the Ask routes and an SSE reader for what they stream back.
import { env } from "cloudflare:test";
import type { Env } from "../../src/env";
import { app } from "../../src/routes";
import { askDeps } from "../../src/ai/ask/routes";
import { FAKE_ANTHROPIC_KEY } from "./anthropic";
import type { AskEventName } from "@shared/ai-ask-core";

export const KEYED: Env = { ...(env as unknown as Env), ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY };

export type StreamBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown; id?: string }
  | { type: "thinking"; thinking: string };

export interface StreamOpts {
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  model?: string;
}

let toolSeq = 0;

/** The SSE body of ONE streamed Messages API answer: message_start, each block's start / deltas / stop,
 *  message_delta (the stop reason and usage), message_stop — the shape the API streams. */
export function streamBody(blocks: StreamBlock[], o: StreamOpts = {}): string {
  const lines: string[] = [];
  const send = (type: string, data: Record<string, unknown>) => lines.push(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const u = { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o.usage };
  send("message_start", { message: { id: `msg_${++toolSeq}`, type: "message", role: "assistant", model: o.model ?? "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: u } });
  blocks.forEach((b, index) => {
    if (b.type === "text") {
      send("content_block_start", { index, content_block: { type: "text", text: "" } });
      for (const chunk of b.text.match(/[\s\S]{1,12}/g) ?? []) send("content_block_delta", { index, delta: { type: "text_delta", text: chunk } });
    } else if (b.type === "thinking") {
      send("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
      send("content_block_delta", { index, delta: { type: "thinking_delta", thinking: b.thinking } });
      send("content_block_delta", { index, delta: { type: "signature_delta", signature: "sig_test" } });
    } else {
      send("content_block_start", { index, content_block: { type: "tool_use", id: b.id ?? `toolu_${++toolSeq}`, name: b.name, input: {} } });
      send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    send("content_block_stop", { index });
  });
  const stop = o.stop_reason ?? (blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  send("message_delta", { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: o.usage?.output_tokens ?? 80 } });
  send("message_stop", {});
  return lines.join("");
}

export const streamResponse = (blocks: StreamBlock[], o: StreamOpts = {}): Response =>
  new Response(streamBody(blocks, o), { status: 200, headers: { "content-type": "text/event-stream" } });

/** What one model request carried. */
export interface SentRequest {
  model: string;
  system: { type: string; text: string; cache_control?: unknown }[];
  tools: { name: string; cache_control?: unknown; input_schema: Record<string, unknown> }[];
  messages: { role: string; content: unknown }[];
  thinking?: unknown;
  tool_choice?: unknown;
  output_config?: unknown;
}

/** A scripted model: each request is answered by the next script entry (a body, or a function of the request). */
export function fakeModel(script: (StreamBlock[] | ((req: SentRequest, n: number) => Response | Promise<Response>))[]) {
  const sent: SentRequest[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as SentRequest;
    sent.push(body);
    const step = script[sent.length - 1];
    if (!step) return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "no more script" } }), { status: 500 });
    return typeof step === "function" ? step(body, sent.length - 1) : streamResponse(step);
  }) as typeof fetch;
  return { fetchImpl, sent };
}

/** Run `fn` with the Ask route's test seams set (the fetch, the docs, the clock), then clear them. */
export async function withAsk<T>(seams: Partial<typeof askDeps>, fn: () => Promise<T>): Promise<T> {
  Object.assign(askDeps, seams);
  try { return await fn(); } finally { for (const k of Object.keys(askDeps)) delete (askDeps as Record<string, unknown>)[k]; }
}

export interface AskEventRead { event: AskEventName; data: any } // eslint-disable-line @typescript-eslint/no-explicit-any

/** The events an SSE body carries, in order. */
export function readSse(text: string): AskEventRead[] {
  return text.split("\n\n").filter((b) => b.trim()).map((b) => {
    const event = /^event: (.+)$/m.exec(b)?.[1] as AskEventName;
    const data = JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? "null");
    return { event, data };
  });
}

export const BASE = "/api/o/saplinglearn";

/** A cookie request to the app. */
export async function call<T = any>(method: string, path: string, cookie: string, body?: unknown, e: Env = KEYED, headers: Record<string, string> = {}): Promise<{ status: number; json: T; text: string }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await app.request(path, {
    method, headers: { cookie, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, e);
  const text = await res.text();
  let json: T;
  try { json = JSON.parse(text) as T; } catch { json = null as T; }
  return { status: res.status, json, text };
}

/** `POST /ask`, read to the end: the status and every SSE event. */
export async function ask(cookie: string, body: Record<string, unknown>, e: Env = KEYED): Promise<{ status: number; events: AskEventRead[]; json: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await call(`POST`, `${BASE}/ask`, cookie, { mode: "smart", ...body }, e);
  return { status: r.status, events: r.status === 200 ? readSse(r.text) : [], json: r.json };
}

export const eventsOf = (events: AskEventRead[], name: AskEventName) => events.filter((x) => x.event === name).map((x) => x.data);

/** A real (visible) thread of the cookie's person, made through the route with no model call (a `/search`). An
 *  upload with no `threadId` is PENDING (0068_ask_pending, Q60), so a test about a thread's files uploads into this. */
export async function threadOf(cookie: string): Promise<number> {
  const r = await ask(cookie, { text: "setup", command: "search" });
  return eventsOf(r.events, "thread")[0].id as number;
}
