// Errors an agent can act on (docs/architecture/web-ui.md › Errors an agent can act on). Every JSON error
// the Worker answers — the API, the token routes, /mcp's 401, the 404 — and every MCP tool error carries a
// `hint` saying what went wrong and what to do next, and NOTHING ELSE changes: the `error` code, any
// `message`, the status and the headers stay as they were. A hint is chosen by code (and status) alone,
// so answers that were identical stay identical (an unknown id and another organization's), and it names
// no organization, slug or secret. A webhook's bare 401 stays bare.
import { describe, it, expect } from "vitest";
import { env, createExecutionContext } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import worker from "../src/index";
import { buildTrovMcpServer } from "../src/mcp";
import { withErrorHint } from "../src/error-hints";
import type { Env } from "../src/env";
import {
  API_ERROR_HINTS, MCP_ERROR_HINTS, MCP_FALLBACK_HINT, MCP_INVALID_TOKEN_HINT, MCP_UNAUTHORIZED_HINT, STATUS_HINTS, apiErrorHint, mcpErrorHint,
} from "@shared/error-hints";
import { planRefusal } from "@shared/plans";
import { cookieFor } from "./helpers/persons";
import { bearerCtx } from "./helpers/tenant";

const fetchAt = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://trov.test${path}`, init), env, createExecutionContext());

describe("HTTP: the API's JSON errors gain a hint, and keep their code and status", () => {
  it("401 signed out, 403 not an admin, 409 no single organization", async () => {
    const r401 = await fetchAt("/api/orgs");
    expect(r401.status).toBe(401);
    expect(await r401.json()).toEqual({ error: "unauthorized", hint: API_ERROR_HINTS.unauthorized });

    const r403 = await fetchAt("/admin/backfill", { method: "POST", headers: { cookie: await cookieFor("not-admin") } });
    expect(r403.status).toBe(403);
    expect(await r403.json()).toEqual({ error: "admin only", hint: API_ERROR_HINTS["admin only"] });

    const r409 = await fetchAt("/feed", { headers: { cookie: await cookieFor("no-org-person", { member: false }) } });
    expect(r409.status).toBe(409);
    expect(await r409.json()).toEqual({ error: "org_required", hint: API_ERROR_HINTS.org_required });
  });

  it("404: an organization you are not in and one that does not exist are still the same bytes — and the hint names neither", async () => {
    const cookie = await cookieFor("AndresL230"); // a member of SaplingLearn, not of Acme (org_b, slug `acme`)
    const theirs = await fetchAt("/api/o/acme/docs", { headers: { cookie } });
    const none = await fetchAt("/api/o/no-such-org-anywhere/docs", { headers: { cookie } });
    expect([theirs.status, none.status]).toEqual([404, 404]);
    const [a, b] = [await theirs.text(), await none.text()];
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ error: "not_found", hint: API_ERROR_HINTS.not_found });
    expect(a).not.toMatch(/acme|saplinglearn|no-such-org/i);
  });

  it("an unknown address is the JSON 404 with a hint; a GET for a page is still the HTML page", async () => {
    const api = await fetchAt("/api/nope");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found", hint: apiErrorHint(404, "not_found") });
    const page = await fetchAt("/no/such/page");
    expect(page.status).toBe(404);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  it("a webhook's bare 401 stays bare: nothing to learn from it", async () => {
    const res = await fetchAt("/webhook/github/12345", { method: "POST", headers: { "x-github-event": "ping", "x-hub-signature-256": "sha256=00" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe('{"error":"unauthorized"}');
  });

  it("withErrorHint: 402 keeps the refusal whole (message and all), 429 keeps retry_after and Retry-After; nothing else is touched", async () => {
    const refusal = planRefusal({ plan: "free", overrides: {}, status: "active" }, "repositories", 1)!;
    const req = new Request("https://trov.test/x");
    const r402 = await withErrorHint(req, Response.json(refusal, { status: 402 }));
    expect(r402.status).toBe(402);
    expect(await r402.json()).toEqual({ ...refusal, hint: API_ERROR_HINTS.plan_limit });

    const r429 = await withErrorHint(req, Response.json({ error: "rate_limited", retry_after: 30 }, { status: 429, headers: { "retry-after": "30", "x-other": "kept" } }));
    expect(r429.headers.get("retry-after")).toBe("30");
    expect(r429.headers.get("x-other")).toBe("kept");
    expect(await r429.json()).toEqual({ error: "rate_limited", retry_after: 30, hint: API_ERROR_HINTS.rate_limited });

    const r410 = await withErrorHint(req, Response.json({ error: "gone" }, { status: 410 }));
    expect(await r410.json()).toEqual({ error: "gone", hint: API_ERROR_HINTS.gone });
    // an unknown code falls back to its status; a status with no line gets nothing
    expect(await (await withErrorHint(req, Response.json({ error: "something_new" }, { status: 400 }))).json()).toEqual({ error: "something_new", hint: STATUS_HINTS[400] });
    expect(await (await withErrorHint(req, Response.json({ error: "teapot" }, { status: 418 }))).json()).toEqual({ error: "teapot" });

    // untouched: a success, an existing hint, HTML, a non-object, and a HEAD
    const ok = Response.json({ error: "not really" }, { status: 200 });
    expect(await withErrorHint(req, ok)).toBe(ok);
    expect(await (await withErrorHint(req, Response.json({ error: "x", hint: "mine" }, { status: 404 }))).json()).toEqual({ error: "x", hint: "mine" });
    expect(await (await withErrorHint(req, new Response("<h1>no</h1>", { status: 404, headers: { "content-type": "text/html" } }))).text()).toBe("<h1>no</h1>");
    expect(await (await withErrorHint(req, Response.json(["a"], { status: 400 }))).json()).toEqual(["a"]);
    const head = Response.json({ error: "not_found" }, { status: 404 });
    expect(await withErrorHint(new Request("https://trov.test/x", { method: "HEAD" }), head)).toBe(head);
  });

  it("every hint is chosen by code and status alone and names no organization, slug or secret", () => {
    const all = [...Object.values(API_ERROR_HINTS), ...Object.values(STATUS_HINTS), ...Object.values(MCP_ERROR_HINTS), MCP_FALLBACK_HINT, MCP_UNAUTHORIZED_HINT, MCP_INVALID_TOKEN_HINT];
    for (const h of all) {
      expect(h).not.toMatch(/saplinglearn|acme|\borg_b\b|trov_mcp_[A-Za-z0-9]{6}/i);
      expect(h).not.toMatch(/COOKIE_SECRET|TROV_KEK|CLIENT_SECRET|STRIPE_/);
      expect(h.length).toBeGreaterThan(30);
    }
    expect(apiErrorHint(404, "not_found")).toBe(apiErrorHint(404, "not_found"));
    expect(apiErrorHint(404, "not found")).toBe(apiErrorHint(404, "not_found"));
  });
});

describe("/mcp's 401 says how to sign in", () => {
  it("with no token: the OAuth pointer in the header, and in the body what to do", async () => {
    const res = await fetchAt("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer resource_metadata="https://trov.test/.well-known/oauth-protected-resource"');
    expect(await res.json()).toEqual({ error: "unauthorized", hint: MCP_UNAUTHORIZED_HINT });
  });

  it("with a refused token: invalid_token, and the same words whether or not the token ever existed", async () => {
    const ask = (token: string) => fetchAt("/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
    const [a, b] = [await ask("trov_mcp_doesnotexist"), await ask("trov_oat_neither")];
    for (const r of [a, b]) {
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    const [ta, tb] = [await a.text(), await b.text()];
    expect(ta).toBe(tb);
    expect(JSON.parse(ta)).toEqual({ error: "unauthorized", hint: MCP_INVALID_TOKEN_HINT });
  });
});

describe("MCP: every tool error carries the hint for its code", () => {
  async function call(handle: string, name: string, args: Record<string, unknown>) {
    const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle));
    const client = new Client({ name: "test", version: "1.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.connect(s);
    await client.connect(c);
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { isError: res.isError, text: res.content[0].text };
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("not_found (a ticket, a sprint, a handoff, a prompt, an artifact): the code it had, or now has, and the one hint", async () => {
    for (const [name, args] of [
      ["get_ticket", { id: 999999 }], ["get_sprint", { id: 999999 }], ["get_handoff", { id: 999999 }],
      ["get_prompt", { slug: "no-such-prompt" }], ["artifact_get", { slug: "no-such-page" }],
    ] as const) {
      const r = await call("AndresL230", name, args);
      expect(r.isError, name).toBe(true);
      const body = JSON.parse(r.text);
      expect(body.code, name).toBe("not_found");
      expect(body.hint, name).toBe(mcpErrorHint("not_found"));
    }
    // get_ticket's sentence is unchanged; it gained its code
    expect(JSON.parse((await call("AndresL230", "get_ticket", { id: 999999 })).text)).toEqual({ error: "no such ticket: 999999", code: "not_found", hint: MCP_ERROR_HINTS.not_found });
  });

  it("bad_request and a validation error: the hint for the code; the SDK's own validation text is untouched", async () => {
    const bad = JSON.parse((await call("AndresL230", "assign_ticket", { id: 999999, login: "x", on: true })).text);
    expect(bad.hint).toBe(mcpErrorHint(bad.code));
    const invalid = await call("AndresL230", "get_ticket", { id: "not-a-number" });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toMatch(/^MCP error -32602: Input validation error: Invalid arguments for tool get_ticket/);
  });
});
