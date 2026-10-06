// canopy-multitenancy.md §10.5 (D19) — a secret's plaintext is in NO response, NO log line and NO D1
// column. A distinct 64-character canary is stored for every kind and scope; every scan looks for the
// canary and for every 8-character piece of it. Upstreams are stubbed to do their worst: echo the
// request's credential and headers straight back in their error bodies.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { inspect } from "node:util";
import type { Env } from "../src/env";
import { Secret, getSecret, recordSecretOutcome, rotateOrgKey } from "../src/data/secrets";
import { orgSettingsApp } from "../src/integrations/routes";
import { HOOK_A, SLOTS, call, ownerCookie, seedOrgSettings, slotPath } from "./helpers/integrations";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;
const ACCOUNT = "fedcba9876543210fedcba9876543210";

// ── canaries ─────────────────────────────────────────────────────────────────
const canaries = new Map<string, string>(); // label → 64 hex characters
async function canary(label: string): Promise<string> {
  const held = canaries.get(label);
  if (held) return held;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`canary:${label}`)));
  const value = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  canaries.set(label, value);
  return value;
}
/** The label of a canary `text` holds any 8-character piece of, or null. */
function leak(text: string): string | null {
  for (const [label, value] of canaries) {
    for (let i = 0; i + 8 <= value.length; i++) if (text.includes(value.slice(i, i + 8))) return `${label} @${i}`;
  }
  return null;
}
const expectClean = (text: string, where: string) => expect(leak(text), where).toBeNull();

async function expectCleanResponse(res: Response, where: string): Promise<string> {
  const body = await res.text();
  expectClean(body, `${where} body`);
  expectClean(JSON.stringify([...res.headers]), `${where} headers`);
  return body;
}

// ── console: spied for the whole file ────────────────────────────────────────
const logged: unknown[][] = [];
/** Every way a logged argument could be turned into text — including a Secret and an Error. */
function stringify(arg: unknown): string {
  const parts: string[] = [];
  const add = (f: () => unknown) => { try { parts.push(String(f())); } catch { /* unprintable that way */ } };
  add(() => arg);
  add(() => `${arg as string}`);
  add(() => JSON.stringify(arg));
  add(() => inspect(arg, { depth: 8, showHidden: true, getters: true }));
  if (arg instanceof Error) {
    add(() => arg.message);
    add(() => arg.stack);
    add(() => inspect(arg.cause, { depth: 8, showHidden: true }));
  }
  if (arg && typeof arg === "object") add(() => JSON.stringify(Object.getOwnPropertyDescriptors(arg)));
  return parts.join("\n");
}
beforeEach(() => {
  logged.length = 0;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args); });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const args of logged) for (const arg of args) expectClean(stringify(arg), "a console argument");
});

// ── D1: every table, every column ────────────────────────────────────────────
async function dumpD1(): Promise<string> {
  const tables = (await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'`).all<{ name: string }>()).results;
  expect(tables.length).toBeGreaterThan(30);
  let out = "";
  for (const { name } of tables) {
    try { out += JSON.stringify((await env.DB.prepare(`SELECT * FROM "${name}"`).all()).results); } catch { /* an FTS shadow table */ }
  }
  return out;
}
const expectCleanD1 = async (where: string) => expectClean(await dumpD1(), `D1 after ${where}`);

// ── upstreams that echo everything back ──────────────────────────────────────
type Echo = (dump: string, credential: string) => Response | Promise<Response>;
const ECHOES: Record<string, Echo> = {
  "401 with the headers in a JSON error": (d) => Response.json({ errors: [{ message: `denied: ${d}`, code: 10000 }] }, { status: 401 }),
  "403 with the headers URL-encoded in `message`": (d) => Response.json({ message: `nope ${encodeURIComponent(d)} ${d}` }, { status: 403 }),
  "500 with a plain-text dump": (d) => new Response(`upstream crashed\n${d}\n${d}`, { status: 500 }),
  // The credential straddles the 8192-byte cut of the bounded read: its first half must not survive.
  "500 with the credential across the read cap": (d, cred) => new Response("x".repeat(8192 - 30) + cred + "y".repeat(9000) + d, { status: 500 }),
  "500 with a dump longer than the read cap": (d) => new Response(`${d} | `.repeat(60), { status: 500 }),
  "200 with a GraphQL error quoting the headers": (d) => Response.json({ errors: [{ message: `bad query from ${d}` }], data: null }),
  "200 with a body that is the headers": (d) => new Response(d, { status: 200 }),
  "a redirect to a URL carrying the credential": (d) => new Response(null, { status: 302, headers: { location: `https://evil.example/?h=${encodeURIComponent(d)}` } }),
  "a thrown error quoting the request": (d) => { throw new Error(`fetch failed: ${d}`); },
};
function echoUpstream(echo: Echo): { calls: number; credentials: string[] } {
  const state = { calls: 0, credentials: [] as string[] };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    state.calls++;
    const sent = (init?.headers ?? {}) as Record<string, string>;
    const headers = Object.entries(sent).map(([k, v]) => `${k}: ${v}`).join("; ");
    const credential = sent["Project-Access-Token"] ?? (sent.authorization ?? "").replace(/^Bearer /, "");
    state.credentials.push(credential);
    return echo(`${init?.method ?? "GET"} ${String(input)} ${headers} body=${typeof init?.body === "string" ? init.body : ""}`, credential);
  });
  return state;
}

/** Store a distinct canary for every kind and scope the seeded org expects (and the Cloudflare account id). */
async function setEveryCanary(me: string, generation = "v1"): Promise<void> {
  for (const [kind, scope] of SLOTS) {
    const body = { secret: await canary(`${generation}:${kind}:${scope}`), ...(kind === "cloudflare_analytics" ? { config: { account_id: ACCOUNT } } : {}) };
    const res = await call(me, slotPath(kind, scope), { method: "PUT", body });
    expect(res.status).toBe(201);
    await expectCleanResponse(res, `PUT ${slotPath(kind, scope)}`);
  }
}

beforeAll(async () => { await canary("probe"); });

describe("the scanners themselves", () => {
  it("see a canary, and any 8-character piece of it, wherever it is planted", async () => {
    const value = await canary("planted");
    expect(leak(`…${value}…`)).toBe("planted @0");
    expect(leak(`…${value.slice(31, 39)}…`)).toBe("planted @31");
    expect(leak(value.slice(0, 7))).toBeNull();
    await env.DB.prepare(`INSERT INTO org_audit (org_id, actor, action, target, detail, at) VALUES (?, 'x', 'secret.set', 't', ?, 'now')`).bind(ORG_A, JSON.stringify({ oops: value.slice(20, 30) })).run();
    expect(leak(await dumpD1())).toBe("planted @20");
    expect(leak(stringify(new Error(`boom ${value}`)))).toBe("planted @0");
    expect(leak(stringify({ nested: { deep: [value] } }))).toBe("planted @0");
    canaries.delete("planted");
  });

  it("a Secret that reaches a log line still shows nothing", async () => {
    const secret = new Secret(await canary("logged-object"));
    console.log("the credential is", secret, { secret }, [secret], new Error(`failed with ${secret}`));
    expect(logged.length).toBe(1);
    expectClean(logged[0].map(stringify).join("\n"), "a logged Secret");
    expect(stringify(secret)).toContain("[secret]");
  });
});

describe("never in a response", () => {
  it("no route answers with a stored secret, as the owner, with every kind and scope set", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await setEveryCanary(me);
    const fresh = async (label: string) => ({ secret: await canary(label) });

    // In an order that lets every route do real work: reads, tests, rotations, then the deletes.
    const requests: [method: string, path: string, body?: unknown][] = [
      ["GET", "/integrations"],
      ["GET", "/integrations/audit"],
      ["GET", "/repos"],
      ["GET", "/environments"],
      ["POST", "/integrations/github_token/test"],
      ["POST", "/integrations/cloudflare_analytics/test"],
      ["POST", "/integrations/railway/staging/test"],
      ["POST", "/integrations/metrics_endpoint/production/test"],
      ["POST", `/integrations/github_webhook/${HOOK_A}/test`],
      ["PUT", "/integrations/github_token", await fresh("v2:conflict")],                 // 409
      ["PUT", "/integrations/railway/staging", await fresh("v2:conflict-scoped")],       // 409
      ["POST", "/integrations/github_token/rotate", await fresh("v2:github_token:")],
      ["POST", "/integrations/railway/staging/rotate", await fresh("v2:railway:staging")],
      ["PUT", "/integrations/cloudflare_analytics/config", { config: { account_id: ACCOUNT } }],
      ["PUT", "/integrations/railway/staging/config", { config: { x: await canary("v2:config-value") } }], // 400
      ["POST", "/integrations/rotate-key"],
      ["GET", "/integrations"],
      ["GET", "/integrations/audit?limit=200"],
      ["PUT", "/environments", { order: ["production", "staging"] }],
      ["PUT", "/environments/staging", { api_url: "https://elsewhere.example.org" }],     // drops a metrics secret
      ["PUT", "/environments/preview", { branch: "preview" }],
      ["POST", "/repos", { repo_full_name: "acme/widgets" }],
      ["DELETE", "/integrations/github_token"],
      ["DELETE", "/integrations/railway/production"],
      ["DELETE", "/environments/staging"],
      ["DELETE", `/repos/${HOOK_A}`],                                                     // 409: the primary
      ["GET", "/integrations"],
      ["GET", "/integrations/audit"],
    ];
    const registered = orgSettingsApp.routes.filter((r) => r.method !== "ALL");
    for (const route of registered) {
      const re = new RegExp("^" + route.path.replace(/:[a-z]+/g, "[^/?]+") + "(\\?.*)?$");
      expect(requests.some(([m, p]) => m === route.method && re.test(p)), `${route.method} ${route.path} is exercised`).toBe(true);
    }

    echoUpstream((d) => Response.json({ errors: [{ message: `denied: ${d}` }] }, { status: 401 }));
    const seen = new Set<number>();
    for (const [method, path, body] of requests) {
      const res = await call(me, path, { method, body });
      seen.add(res.status);
      const text = await expectCleanResponse(res, `${method} ${path}`);
      for (const forbidden of ["ciphertext", "wrapped_key", "wrap_iv", '"iv"']) expect(text, `${method} ${path}`).not.toContain(forbidden);
    }
    expect([...seen].sort()).toEqual([200, 201, 400, 409]);
    await expectCleanD1("every route");
  });

  it("a validation error never echoes the submitted value, wherever a secret was pasted by mistake", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const v = await canary("mistyped");
    const attempts: [method: string, path: string, body: unknown][] = [
      ["PUT", "/integrations/github_token", { secret: ` ${v}` }],
      ["PUT", "/integrations/github_token", { secret: `${v}\n` }],
      ["PUT", "/integrations/github_token", { secret: [v] }],
      ["PUT", "/integrations/github_token", { secret: { value: v } }],
      ["PUT", "/integrations/github_token", `{"secret": "${v}"`],                      // truncated JSON
      ["PUT", "/integrations/github_token", v],                                        // not JSON at all
      ["POST", "/integrations/github_token/rotate", { secret: `${v}\t` }],
      ["PUT", "/integrations/cloudflare_analytics/config", { config: { account_id: v } }],
      ["PUT", "/integrations/cloudflare_analytics/config", { config: { [v]: "x" } }],
      ["PUT", "/integrations/cloudflare_analytics", { secret: "a-perfectly-fine-token", config: { account_id: v } }],
      ["PUT", `/integrations/railway/${v}`, { secret: v }],
      ["PUT", `/integrations/${v}`, { secret: v }],
      ["PUT", `/integrations/railway/staging/${v}`, { secret: v }],
      ["POST", `/integrations/railway/${v}/test`, undefined],
      ["DELETE", `/integrations/railway/${v}`, undefined],
      ["PUT", "/environments/staging", { api_url: `http://${v}.example.com` }],
      ["PUT", "/environments/staging", { api_url: `https://api.example.com/?key=${v}` }],
      ["PUT", "/environments/staging", { frontend_url: `https://u:${v}@example.com` }],
      ["PUT", "/environments/staging", { branch: `main ${v}` }],
      ["PUT", "/environments/staging", { [v]: v }],
      ["PUT", `/environments/${v}`, { branch: "main" }],
      ["PUT", "/environments", { order: [v] }],
      ["DELETE", `/environments/${v}`, undefined],
      ["POST", "/repos", { repo_full_name: v }],
      ["POST", "/repos", { repo_full_name: `acme/${v} ${v}` }],
      ["DELETE", `/repos/${v}`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await call(me, path, { method, body });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
      expect(res.status, `${method} ${path}`).toBeLessThan(500);
      await expectCleanResponse(res, `${method} ${path.replace(v, "<canary>")}`);
    }
    await expectCleanD1("refused writes");
  });
});

describe("never in a log line or in D1", () => {
  it("set / rotate / delete / rotate-key leave no plaintext behind", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await setEveryCanary(me);
    await expectCleanD1("set");
    for (const [kind, scope] of SLOTS) {
      const res = await call(me, `${slotPath(kind, scope)}/rotate`, { method: "POST", body: { secret: await canary(`v2:${kind}:${scope}`) } });
      expect(res.status).toBe(200);
      await expectCleanResponse(res, "rotate");
    }
    await expectCleanD1("rotate");
    expect(await rotateOrgKey(await tenantCtx("AndresL230"))).toMatchObject({ rotated: true, secrets: 7 });
    await expectCleanD1("rotate-key");
    // The secrets really are there, and really are the canaries — the scans above were not vacuous.
    for (const [kind, scope] of SLOTS) {
      expect((await getSecret(systemCtx(), kind as "railway", scope))!.reveal()).toBe(await canary(`v2:${kind}:${scope}`));
    }
    for (const [kind, scope] of SLOTS) expect((await call(me, slotPath(kind, scope), { method: "DELETE" })).status).toBe(200);
    await expectCleanD1("delete");
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM org_audit`).first<{ n: number }>())!.n).toBe(7 + 1 + 7 + 1 + 7); // 7 sets + cloudflare's config, 7 rotations, the key, 7 deletes
  });

  for (const [name, echo] of Object.entries(ECHOES)) {
    it(`Test connection against an upstream answering ${name}`, async () => {
      await seedOrgSettings();
      const me = await ownerCookie();
      await setEveryCanary(me);
      const upstream = echoUpstream(echo);
      for (const [kind, scope] of SLOTS) {
        const res = await call(me, `${slotPath(kind, scope)}/test`, { method: "POST" });
        expect(res.status, `${kind}:${scope}`).toBe(200);
        const body = JSON.parse(await expectCleanResponse(res, `test ${kind}:${scope}`)) as { ok: boolean; detail: string; integration: { last_error: string | null } };
        if (kind === "github_webhook") continue; // nothing is called for a webhook secret
        // GitHub's reader never quotes a body, so a 200 whose body is an echo is still an answer.
        if (!(kind === "github_token" && name.startsWith("200"))) {
          expect(body.ok, `${kind}:${scope} ${body.detail}`).toBe(false);
          expect(body.integration.last_error).toBe(body.detail);
          expect((body.integration.last_error ?? "").length).toBeLessThanOrEqual(300);
        }
      }
      expect(upstream.calls).toBe(6); // one outbound request per kind and scope — a redirect is not followed
      expect(upstream.credentials.map((c) => leak(c) !== null)).toEqual(Array(6).fill(true)); // …and each one really carried its canary
      expect(logged.length).toBeGreaterThan(0); // the failures WERE logged — and afterEach finds them clean
      await expectCleanD1(`Test connection (${name})`);
    });
  }

  it("a failure a poller reports is scrubbed before it is stored, however the credential is spelled", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    await setEveryCanary(me);
    const ctx = systemCtx();
    const secret = (await getSecret(ctx, "railway", "staging"))!;
    const v = secret.reveal();
    await recordSecretOutcome(ctx, "railway", "staging", { ok: false, revealed: secret, message: `HTTP 401 Project-Access-Token: ${v} / ${encodeURIComponent(v)} / ${"z".repeat(280)}${v}` });
    const stored = await env.DB.prepare(`SELECT last_error FROM org_secrets WHERE kind = 'railway' AND scope = 'staging'`).first<{ last_error: string }>();
    expect(stored!.last_error).toContain("[redacted]");
    expect(stored!.last_error.length).toBe(300);
    await expectCleanD1("recordSecretOutcome");
  });
});
