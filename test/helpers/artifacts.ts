// Shared plumbing for the cross-cutting artifact suites (issue #52 · Track E). Every
// helper drives a REAL entry point: `worker.fetch` from src/index.ts for HTTP / raw /
// upload, and the real `/mcp` JSON-RPC endpoint (bearer auth, the registered tools) for
// MCP — never the repository directly.

import { env } from "cloudflare:test";
import { expect } from "vitest";
import worker from "../../src/index";
import { mintToken } from "../../src/auth/tokens";
import { sha256Hex } from "../../src/tools/artifacts";
import type { ArtifactDetailDTO } from "@shared/artifacts";
import { cookieFor, seedPerson } from "./persons";
import { platformCtx, ORG_A } from "./tenant";

export const ORIGIN = "https://trov.test";
export const NOT_FOUND = JSON.stringify({ error: "not_found" });
export const MCP_NOT_FOUND = JSON.stringify({ error: "not_found", code: "not_found" });

const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;

/** One request through the Worker's own fetch (index.ts dispatch → Hono app). */
export const wf = (path: string, init: RequestInit = {}): Promise<Response> =>
  worker.fetch(new Request(path.startsWith("http") ? path : `${ORIGIN}${path}`, init), env, ctx);

export const jsonInit = (method: string, body: unknown, cookie?: string, extra: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json", ...extra },
  body: JSON.stringify(body),
});

export const get = (path: string, cookie: string) => wf(path, { headers: { cookie } });

export function multipart(fields: Record<string, string>, file?: { bytes: Uint8Array; name: string; type: string }): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  if (file) fd.set("file", new File([file.bytes], file.name, { type: file.type }));
  return fd;
}

/** Create a text page over HTTP (201 asserted). */
export async function createText(cookie: string, o: Record<string, unknown> = {}): Promise<ArtifactDetailDTO> {
  const res = await wf("/api/artifacts", jsonInit("POST", { title: "Auth flow", kind: "markdown", area: "auth", content: "# Auth", ...o }, cookie));
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}

/** Create a binary page over HTTP multipart (201 asserted). */
export async function createBinary(
  cookie: string, fields: Record<string, string>, file: { bytes: Uint8Array; name: string; type: string }
): Promise<ArtifactDetailDTO> {
  const res = await wf("/api/artifacts", { method: "POST", headers: { cookie }, body: multipart(fields, file) });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}

/** Mint an upload URL over HTTP; returns the parsed DTO and the PUT path. */
export async function uploadUrl(cookie: string, body: Record<string, unknown>): Promise<{ status: number; text: string; path: string | null; dto: any }> {
  const res = await wf("/api/artifacts/upload-url", jsonInit("POST", body, cookie));
  const text = await res.text();
  const dto = res.status === 201 ? JSON.parse(text) : null;
  return { status: res.status, text, dto, path: dto ? new URL(dto.upload_url).pathname : null };
}

export const put = (path: string, body: BodyInit | null, headers: Record<string, string> = {}) =>
  wf(path, { method: "PUT", body, headers });

/** Unique bytes (R2 is NOT reset between tests — a shared key would leak state). */
export function uniqueBytes(prefix: string, n?: number): Uint8Array {
  const tag = new TextEncoder().encode(`${prefix}:${crypto.randomUUID()}:`);
  const out = new Uint8Array(n ?? tag.byteLength + 16);
  out.set(tag.subarray(0, Math.min(tag.byteLength, out.byteLength)));
  return out;
}

export { sha256Hex, cookieFor, seedPerson };

// ── MCP over the real /mcp endpoint ──────────────────────────────────────────

/** A bearer for `handle` (the person is seeded; a fresh token per test DB). */
export async function bearerFor(handle: string): Promise<string> {
  await seedPerson(handle);
  const { raw } = await mintToken(platformCtx(), handle, ORG_A);
  return raw;
}

let rpcId = 0;
/** One JSON-RPC call to /mcp as `handle`; returns the `result` (or `error`) object. */
export async function mcpRpc(handle: string, method: string, params: unknown): Promise<{ result?: any; error?: any }> {
  const token = await bearerFor(handle);
  const res = await wf("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("")
    : text;
  const msg = JSON.parse(data);
  return { result: msg.result, error: msg.error };
}

/** tools/call as `handle`: the tool's text, parsed body and error flag. */
export async function mcpCall(handle: string, name: string, args: Record<string, unknown>): Promise<{ text: string; body: any; isError: boolean; rpcError?: any }> {
  const r = await mcpRpc(handle, "tools/call", { name, arguments: args });
  if (r.error) return { text: JSON.stringify(r.error), body: r.error, isError: true, rpcError: r.error };
  const text = r.result.content[0].text as string;
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  return { text, body, isError: !!r.result.isError };
}

export async function mcpToolNames(handle: string): Promise<string[]> {
  const r = await mcpRpc(handle, "tools/list", {});
  return (r.result.tools as { name: string }[]).map((t) => t.name);
}

export async function mcpToolSchema(handle: string, name: string): Promise<{ properties: Record<string, unknown> }> {
  const r = await mcpRpc(handle, "tools/list", {});
  return (r.result.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find((t) => t.name === name)!.inputSchema;
}
