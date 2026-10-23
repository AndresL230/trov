// A handoff whose prompt is UPLOADED (0080_handoff_upload_tokens; docs/architecture/handoffs-prompts.md): MCP
// `send_handoff` with `prompt: { title, sha256, size_bytes }` writes nothing but a token, and the PUT to the
// artifact upload route (`/api/artifacts/upload/<token>`, through the real Worker entry) creates the handoff.
// MCP calls drive the REAL registered closures; Ask's refusal goes through a real turn with a stubbed model.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../src/index";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { sha256Hex } from "../src/tools/artifacts";
import { HANDOFF_BODY_MAX, consumeHandoffUploadToken } from "../src/tools/handoffs";
import { pruneHandoffUploadTokens } from "../src/platform/sweeps";
import { ASK_TOOLS, offeredTools } from "../src/ai/ask/tools";
import { ASK_NO_PROMPT_UPLOAD } from "../src/ai/ask/actions";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, bearerCtx, ensureMember, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { ask, eventsOf, fakeModel, withAsk, type StreamBlock } from "./helpers/ask";

const ME = "AndresL230";
const ORIGIN = "https://trov.test"; // PUBLIC_ORIGIN in vitest.config.ts
const ctx = { waitUntil() {}, passThroughException() {} } as unknown as ExecutionContext;
type ToolRes = { content: Array<{ type: string; text: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown>, handle = ME, orgId = ORG_A): Promise<{ body: any; isError: boolean }> {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle, undefined, undefined, orgId));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name, arguments: args })) as ToolRes;
    return { body: JSON.parse(res.content[0].text), isError: !!res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

const put = (url: string, body: BodyInit, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(url.startsWith("http") ? url : `${ORIGIN}${url}`, { method: "PUT", body, headers }), env as unknown as Env, ctx);

const PROMPT = `# Do the thing\n\n${"Step: read the file, change it, run the tests. ".repeat(80)}\nÜnïcödé ✓`;
const bytesOf = (s: string) => new TextEncoder().encode(s);

/** The upload-form send: { title, sha256, size_bytes } for `text`. */
async function declare(text: string, o: Record<string, unknown> = {}, handle = ME, orgId = ORG_A) {
  const bytes = bytesOf(text);
  return call("send_handoff", {
    body: "Uploaded prompt handoff\n\nWhere it stands.", context: { task: "Ship the upload form", done: ["a"], next: ["b"] },
    prompt: { title: "The long prompt", sha256: await sha256Hex(text), size_bytes: bytes.byteLength }, ...o,
  }, handle, orgId);
}

const counts = async (orgId = ORG_A) => ({
  handoffs: (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM handoffs WHERE org_id = ?`, orgId))!.n,
  feed: (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM feed WHERE org_id = ? AND summary LIKE '%left a handoff%'`, orgId))!.n,
  ledger: (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM processed_items WHERE org_id = ? AND item_type = 'handoff'`, orgId))!.n,
});

describe("send_handoff's upload form", () => {
  it("writes no handoff, feed row or ledger row until the PUT — only a hash-keyed token", async () => {
    const before = await counts();
    const r = await declare(PROMPT, { session: "sess-upload-1" });
    expect(r.isError).toBe(false);
    expect(Object.keys(r.body).sort()).toEqual(["expires_at", "upload_url"]);
    expect(r.body.upload_url).toMatch(new RegExp(`^${ORIGIN}/api/artifacts/upload/[A-Za-z0-9_-]{43}$`));
    expect(await counts()).toEqual(before);
    const tokens = await all<{ token_hash: string; principal: string; session_id: string; size_bytes: number }>(env.DB,
      `SELECT token_hash, principal, session_id, size_bytes FROM handoff_upload_tokens WHERE org_id = ?`, ORG_A);
    expect(tokens).toHaveLength(1);
    const raw = r.body.upload_url.split("/").pop();
    expect(tokens[0]).toMatchObject({ token_hash: await sha256Hex(raw), principal: ME, session_id: "sess-upload-1", size_bytes: bytesOf(PROMPT).byteLength });
  });

  it("the PUT creates exactly one handoff (sender = the bearer, prompt = the bytes); a replay with the same session returns it", async () => {
    const before = await counts();
    const r = await declare(PROMPT, { session: "sess-upload-2" });
    const res = await put(r.body.upload_url, PROMPT, { "content-type": "text/markdown" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { id: number; url: string };
    // The same link an inline send answers with (this test server has no org slug in its links).
    expect(out.url).toBe(`${ORIGIN}/#handoffs/${out.id}`);
    expect(await counts()).toEqual({ handoffs: before.handoffs + 1, feed: before.feed + 1, ledger: before.ledger + 1 });
    const row = await first<{ sender: string; recipient: string; prompt_title: string; prompt_body: string; context: string }>(env.DB,
      `SELECT sender, recipient, prompt_title, prompt_body, context FROM handoffs WHERE org_id = ? AND number = ?`, ORG_A, out.id);
    expect(row).toMatchObject({ sender: ME, recipient: "anyone", prompt_title: "The long prompt", prompt_body: PROMPT });
    expect(JSON.parse(row!.context)).toMatchObject({ task: "Ship the upload form", done: ["a"], next: ["b"] });

    // The same handoff from the same session again — either form — answers with it and mints nothing.
    const again = await declare(PROMPT, { session: "sess-upload-2" });
    expect(again.body).toEqual({ id: out.id, url: out.url, replayed: true });
    const inline = await call("send_handoff", {
      body: "Uploaded prompt handoff\n\nWhere it stands.", context: { task: "Ship the upload form", done: ["a"], next: ["b"] },
      session: "sess-upload-2", prompt: { title: "The long prompt", body: PROMPT },
    });
    expect(inline.body).toMatchObject({ id: out.id, replayed: true });
    expect(await counts()).toEqual({ handoffs: before.handoffs + 1, feed: before.feed + 1, ledger: before.ledger + 1 });
    // A second token minted for the same session before the first PUT landed replays at ITS PUT.
    const t2 = await declare(PROMPT, { session: "sess-upload-3" });
    const t3 = await declare(PROMPT, { session: "sess-upload-3" });
    const first3 = (await (await put(t2.body.upload_url, PROMPT)).json()) as { id: number };
    const second3 = (await (await put(t3.body.upload_url, PROMPT)).json()) as { id: number; replayed?: boolean };
    expect(second3).toMatchObject({ id: first3.id, replayed: true });
    expect(await counts()).toEqual({ handoffs: before.handoffs + 2, feed: before.feed + 2, ledger: before.ledger + 2 });
  });

  it("a wrong size or sha256 is a 400 that creates nothing; the token still works within its TTL", async () => {
    const before = await counts();
    const r = await declare(PROMPT);
    const short = await put(r.body.upload_url, PROMPT.slice(0, -3));
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ error: "bad_request" });
    // Same length, different bytes: the hash catches it.
    const swapped = await put(r.body.upload_url, `X${PROMPT.slice(1)}`);
    expect(swapped.status).toBe(400);
    expect(await counts()).toEqual(before);
    expect((await first<{ used_at: string | null }>(env.DB, `SELECT used_at FROM handoff_upload_tokens`))!.used_at).toBeNull();
    const ok = await put(r.body.upload_url, PROMPT);
    expect(ok.status).toBe(200);
    expect((await counts()).handoffs).toBe(before.handoffs + 1);
  });

  it("a body over the cap is a 413 before anything is read into a handoff", async () => {
    const r = await declare(PROMPT);
    const big = await put(r.body.upload_url, "y".repeat(HANDOFF_BODY_MAX + 1));
    expect(big.status).toBe(413);
    expect((await first<{ used_at: string | null }>(env.DB, `SELECT used_at FROM handoff_upload_tokens`))!.used_at).toBeNull();
    // The declared size itself is capped at mint.
    const over = await call("send_handoff", { body: "b", prompt: { title: "t", sha256: "a".repeat(64), size_bytes: HANDOFF_BODY_MAX + 1 } });
    expect(over.isError).toBe(true);
  });

  it("a used or expired token is a 410 and creates nothing more", async () => {
    const r = await declare(PROMPT);
    expect((await put(r.body.upload_url, PROMPT)).status).toBe(200);
    const before = await counts();
    const reused = await put(r.body.upload_url, PROMPT);
    expect(reused.status).toBe(410);
    expect(await reused.json()).toMatchObject({ error: "gone" });

    const late = await declare(PROMPT);
    await run(env.DB, `UPDATE handoff_upload_tokens SET expires_at = '2020-01-01T00:00:00.000Z' WHERE used_at IS NULL`);
    expect((await put(late.body.upload_url, PROMPT)).status).toBe(410);
    expect(await counts()).toEqual(before);
  });

  it("another org's token never creates anything in this org; the PUT acts only in the org it was minted in", async () => {
    const BOB = "upload-bob";
    await cookieFor(BOB, { member: false });
    await ensureMember(BOB, "member", ORG_B);
    const beforeA = await counts(ORG_A);
    const r = await declare(PROMPT, {}, BOB, ORG_B);
    expect(r.isError).toBe(false);
    // The token row names org B; the PUT writes there and only there.
    expect(await all(env.DB, `SELECT org_id FROM handoff_upload_tokens`)).toEqual([{ org_id: ORG_B }]);
    const res = await put(r.body.upload_url, PROMPT);
    expect(res.status).toBe(200);
    expect(await counts(ORG_A)).toEqual(beforeA);
    expect((await counts(ORG_B)).handoffs).toBe(1);
    // Org B's live token, presented to org A's context, is not a handoff token there (every statement binds the
    // org): the consume answers null — the route then tries artifacts, whose answer is the unknown-token 404.
    const r2 = await declare(PROMPT, {}, BOB, ORG_B);
    const raw = r2.body.upload_url.split("/").pop();
    expect(await consumeHandoffUploadToken(systemCtx(ORG_A), raw, new Response(PROMPT).body, null)).toBeNull();
    expect(await counts(ORG_A)).toEqual(beforeA);
    expect((await first<{ used_at: string | null }>(env.DB, `SELECT used_at FROM handoff_upload_tokens WHERE used_at IS NULL`))).not.toBeNull();
    // A token whose org is not there (or is suspended) is the unknown-token 404 at the route.
    await run(env.DB, `UPDATE handoff_upload_tokens SET org_id = ? WHERE used_at IS NULL`, "org_missing");
    expect((await put(r2.body.upload_url, PROMPT)).status).toBe(404);
    expect(await counts(ORG_A)).toEqual(beforeA);
    expect((await counts(ORG_B)).handoffs).toBe(1);
  });

  it("a sender who left the org since the mint gets the unknown-token 404, and nothing is created", async () => {
    const LEAVER = "upload-leaver";
    await cookieFor(LEAVER);
    const before = await counts();
    const r = await declare(PROMPT, {}, LEAVER);
    await run(env.DB, `DELETE FROM memberships WHERE user_id = ? AND org_id = ?`, LEAVER, ORG_A);
    expect((await put(r.body.upload_url, PROMPT)).status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it("mixing the forms, or neither, is refused and writes nothing", async () => {
    const both = await call("send_handoff", { body: "b", prompt: { title: "t", body: "x", sha256: "a".repeat(64), size_bytes: 1 } });
    expect(both.isError).toBe(true);
    expect(both.body.code).toBe("bad_request");
    const neither = await call("send_handoff", { body: "b", prompt: { title: "t" } });
    expect(neither.isError).toBe(true);
    expect(await all(env.DB, `SELECT 1 FROM handoff_upload_tokens`)).toEqual([]);
    // The recipient is checked at mint: an unknown one mints nothing.
    const ghost = await declare(PROMPT, { recipient: "ghost" });
    expect(ghost.isError).toBe(true);
    expect(await all(env.DB, `SELECT 1 FROM handoff_upload_tokens`)).toEqual([]);
  });

  it("the sweep removes tokens whose window has closed, used or not, and keeps live ones", async () => {
    const used = await declare(PROMPT);
    await put(used.body.upload_url, PROMPT);
    await declare(PROMPT);
    expect(await pruneHandoffUploadTokens(platformCtx(), Date.now())).toBe(0);
    expect(await pruneHandoffUploadTokens(platformCtx(), Date.now() + 10 * 60 * 1000)).toBe(2);
    expect(await all(env.DB, `SELECT 1 FROM handoff_upload_tokens`)).toEqual([]);
  });
});

describe("Ask refuses the upload form", () => {
  it("the input refuses { title, sha256, size_bytes } with the reason; the offered schema is inline only", async () => {
    const parsed = ASK_TOOLS.send_handoff.input.safeParse({ body: "b", prompt: { title: "t", sha256: "a".repeat(64), size_bytes: 10 } });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error!.issues)).toContain(ASK_NO_PROMPT_UPLOAD);
    expect(ASK_TOOLS.send_handoff.input.safeParse({ body: "b", prompt: { title: "t", body: "inline" } }).success).toBe(true);
    const offered = offeredTools(await tenantCtx(ME), "smart").find((t) => t.name === "send_handoff")!;
    const prompt = (offered.input_schema.properties as Record<string, { properties: Record<string, unknown>; required: string[] }>).prompt;
    expect(Object.keys(prompt.properties).sort()).toEqual(["body", "title"]);
    expect(prompt.required.sort()).toEqual(["body", "title"]);
  });

  it("a turn whose model sends the upload form gets the refusal back: no card, no token, no handoff", async () => {
    const final = "\n<trov-meta>{\"title\": \"Handoff\", \"followups\": []}</trov-meta>";
    const answer: StreamBlock[] = [{ type: "text", text: `Couldn't.${final}` }];
    const cookie = await cookieFor("ask-uploader");
    const before = await counts();
    const model = fakeModel([[
      { type: "tool_use", name: "send_handoff", input: { body: "Long one\n\nx", prompt: { title: "t", sha256: "b".repeat(64), size_bytes: 9000 } } },
    ], answer]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "hand it off", auto: true }));
    expect(eventsOf(r.events, "action")).toEqual([]);
    expect(eventsOf(r.events, "action_result")).toEqual([]);
    const result = (model.sent[1].messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0];
    expect(result.is_error).toBe(true);
    expect(result.content).toContain(ASK_NO_PROMPT_UPLOAD);
    expect(await all(env.DB, `SELECT 1 FROM handoff_upload_tokens`)).toEqual([]);
    expect(await counts()).toEqual(before);
  });
});
