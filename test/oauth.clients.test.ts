// The sign-in each MCP client we document actually runs, end to end over the Worker: discovery from /mcp's
// 401, registration (RFC 7591), the consent page, the code exchange, and a call on /mcp with the token.
// The request shapes are the clients' own: ChatGPT's apps (a per-connector https callback on chatgpt.com,
// the `resource` on authorize and token) and the Codex CLI (a loopback callback with a path of its own,
// on a fresh port; an OAuth library that may send the client id in a Basic header). Claude Code's is
// test/oauth.routes.test.ts. docs/architecture/auth-identity-people.md › MCP OAuth.
import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { pkce } from "../src/auth/crypto";
import { seedPerson, cookieFor } from "./helpers/persons";
import { ensureMember, ORG_B } from "./helpers/tenant";

const ORIGIN = "https://example.com";
const RESOURCE = `${ORIGIN}/mcp`;
const manual = (init: RequestInit = {}) => ({ redirect: "manual" as const, ...init });
const form = (o: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(o).toString(),
});
const csrfOf = (html: string) => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
const basic = (id: string, secret = "") => `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`;

/** What the client learns before it has a token: /mcp's 401 → the resource metadata → the server's. */
async function discover(): Promise<{ registration_endpoint: string; authorization_endpoint: string; token_endpoint: string }> {
  const unauth = await SELF.fetch(RESOURCE, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect(unauth.status).toBe(401);
  const prmUrl = /resource_metadata="([^"]+)"/.exec(unauth.headers.get("www-authenticate") ?? "")?.[1];
  expect(prmUrl).toBe(`${ORIGIN}/.well-known/oauth-protected-resource`);
  const prm = (await (await SELF.fetch(prmUrl!)).json()) as { resource: string; authorization_servers: string[] };
  expect(prm.resource).toBe(RESOURCE);
  const as = await SELF.fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`);
  return (await as.json()) as { registration_endpoint: string; authorization_endpoint: string; token_endpoint: string };
}

async function register(endpoint: string, body: Record<string, unknown>): Promise<{ client_id: string; client_secret?: string; token_endpoint_auth_method: string }> {
  const r = await SELF.fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  expect(r.status).toBe(201);
  return (await r.json()) as { client_id: string; token_endpoint_auth_method: string };
}

/** GET authorize signed in → the consent page; POST its form with `choice` → the code at the redirect. */
async function consent(authorizeUrl: string, cookie: string, choice: Record<string, string | string[]>): Promise<{ page: string; location: URL }> {
  const page = await (await SELF.fetch(authorizeUrl, manual({ headers: { cookie } }))).text();
  const f = new URLSearchParams(new URL(authorizeUrl).searchParams);
  f.set("csrf", csrfOf(page)); f.set("decision", "allow");
  for (const [k, v] of Object.entries(choice)) for (const one of [v].flat()) f.append(k, one);
  const r = await SELF.fetch(`${ORIGIN}/oauth/authorize`, manual({ method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: f.toString() }));
  expect(r.status).toBe(302);
  return { page, location: new URL(r.headers.get("location")!) };
}

/** One JSON-RPC call on /mcp with the token; the answer whether it comes back as JSON or as one SSE event. */
async function mcpCall(token: string, method: string, params: Record<string, unknown> = {}): Promise<{ result?: Record<string, unknown> }> {
  const r = await SELF.fetch(RESOURCE, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(r.status).toBe(200);
  const text = await r.text();
  const data = text.trimStart().startsWith("{") ? text : text.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).join("");
  return JSON.parse(data) as { result?: Record<string, unknown> };
}

describe("ChatGPT (an app in developer mode)", () => {
  it("registers its per-connector chatgpt.com callback, is offered Manual, and calls /mcp with the token", async () => {
    await seedPerson("gpt-user");
    await ensureMember("gpt-user", "member", ORG_B);
    const meta = await discover();
    const callback = "https://chatgpt.com/connector/oauth/abc123XYZ";
    const client = await register(meta.registration_endpoint, {
      client_name: "ChatGPT", redirect_uris: [callback, "https://chatgpt.com/connector_platform_oauth_redirect"],
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: "mcp",
    });
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.client_secret).toBeUndefined();

    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: callback, code_challenge: challenge,
      code_challenge_method: "S256", state: "gpt-state", scope: "mcp", resource: RESOURCE,
    });
    const cookie = await cookieFor("gpt-user");
    const { page, location } = await consent(`${meta.authorization_endpoint}?${q}`, cookie, { mode: "manual", org: ["saplinglearn", "acme"], current: "acme" });
    // A chat is in no repository: with two organizations, Manual is preselected all the same.
    expect(page).toContain("ChatGPT");
    expect(page).toMatch(/name="mode" value="manual" form="consent" checked/);
    expect(page).not.toMatch(/name="mode" value="repo" form="consent" checked/);
    expect(location.origin + location.pathname).toBe(callback);
    expect(location.searchParams.get("state")).toBe("gpt-state");

    const tok = await SELF.fetch(meta.token_endpoint, form({
      grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier,
      redirect_uri: callback, client_id: client.client_id, resource: RESOURCE,
    }));
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string; token_type: string };
    expect(t.token_type).toBe("Bearer");

    const conn = await mcpCall(t.access_token, "tools/call", { name: "get_connection", arguments: {} });
    const body = JSON.parse(((conn.result!.content as { text: string }[])[0]).text) as { handle: string; mode: string; organization: { slug: string } };
    expect(body).toMatchObject({ handle: "gpt-user", mode: "manual", organization: { slug: "acme" } });

    // Reads are marked read-only, so ChatGPT runs them without asking; writes are not.
    const list = await mcpCall(t.access_token, "tools/list");
    const tools = list.result!.tools as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    const hint = (n: string) => tools.find((x) => x.name === n)?.annotations?.readOnlyHint;
    expect([hint("query"), hint("get_connection"), hint("create_ticket"), hint("record_session")]).toEqual([true, true, false, false]);

    const again = await SELF.fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: client.client_id, resource: RESOURCE }));
    expect(again.status).toBe(200);
  });
});

describe("the Codex CLI", () => {
  it("registers a loopback callback with its own path, signs in on another port, and sends its client id in a Basic header", async () => {
    await seedPerson("codex-user");
    const meta = await discover();
    const registeredCb = "http://127.0.0.1:41000/callback/7f3e";
    const client = await register(meta.registration_endpoint, {
      client_name: "Codex", redirect_uris: [registeredCb], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none",
    });

    const callback = "http://127.0.0.1:52817/callback/7f3e";
    const { verifier, challenge } = await pkce();
    const q = new URLSearchParams({
      response_type: "code", client_id: client.client_id, redirect_uri: callback, code_challenge: challenge,
      code_challenge_method: "S256", state: "codex-state", resource: RESOURCE,
    });
    const { location } = await consent(`${meta.authorization_endpoint}?${q}`, await cookieFor("codex-user"), {});
    expect(location.origin + location.pathname).toBe(callback);

    // No client_id in the form: it rides an HTTP Basic header with an empty secret.
    const tok = await SELF.fetch(meta.token_endpoint, form({
      grant_type: "authorization_code", code: location.searchParams.get("code")!, code_verifier: verifier, redirect_uri: callback, resource: RESOURCE,
    }, { authorization: basic(client.client_id) }));
    expect(tok.status).toBe(200);
    const t = (await tok.json()) as { access_token: string; refresh_token: string };
    const init = await mcpCall(t.access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "0.163.0" } });
    expect((init.result!.serverInfo as { name: string }).name).toBe("trov");

    // The Basic id is checked like a form one: another client's id does not refresh this token.
    const other = await register(meta.registration_endpoint, { client_name: "Other", redirect_uris: [registeredCb] });
    const wrong = await SELF.fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: t.refresh_token }, { authorization: basic(other.client_id) }));
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
    const right = await SELF.fetch(meta.token_endpoint, form({ grant_type: "refresh_token", refresh_token: t.refresh_token }, { authorization: basic(client.client_id) }));
    expect(right.status).toBe(200);
  });

  it("no client id at all — neither in the form nor in a header — is invalid_request, and the code is not spent", async () => {
    const r = await SELF.fetch(`${ORIGIN}/oauth/token`, form({ grant_type: "authorization_code", code: "c", code_verifier: "v", redirect_uri: "http://127.0.0.1:1/cb" }, { authorization: "Basic !!" }));
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toBe("invalid_request");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM oauth_codes WHERE used_at IS NOT NULL`).first<{ n: number }>())!.n).toBe(0);
  });
});
