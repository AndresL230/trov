// canopy-multitenancy.md §10.5 "Never via MCP" (D14): no MCP path can reach a decrypt. Statically —
// nothing reachable from src/mcp.ts imports src/data/secrets.ts — and at runtime: a bearer context is
// refused by `getSecret` whatever its role.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { SecretAccessError, getSecret, resolveCredential, setSecret } from "../src/data/secrets";
import { bearerCtx, tenantCtx } from "./helpers/tenant";

const e = env as unknown as Env;

// Every worker source file, as text (Vite inlines the glob at transform time).
const globbed = (import.meta as unknown as { glob: (pattern: string[], o: { query: string; import: string; eager: true }) => Record<string, string> })
  .glob(["../src/**/*.ts", "../shared/**/*.ts"], { query: "?raw", import: "default", eager: true });
const SOURCES = new Map(Object.entries(globbed).map(([path, text]) => [path.replace(/^\.\.\//, ""), text]));

const IMPORT = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

/** The repo-relative file a specifier names, or null for a package. */
function resolve(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@shared/")) base = `shared/${spec.slice("@shared/".length)}`;
  else if (spec.startsWith(".")) {
    const parts = from.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    base = parts.join("/");
  } else return null;
  for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) if (SOURCES.has(candidate)) return candidate;
  throw new Error(`unresolved import ${spec} in ${from}`);
}

/** Every file reachable from `entry` through static, type-only, re-export and dynamic imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    for (const m of SOURCES.get(file)!.matchAll(IMPORT)) {
      const next = resolve(file, m[1] ?? m[2]);
      if (next && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

describe("the import graph", () => {
  it("the walker follows real imports (it finds the secrets module from the HTTP app)", () => {
    expect(SOURCES.has("src/mcp.ts")).toBe(true);
    expect(SOURCES.has("src/data/secrets.ts")).toBe(true);
    const fromRoutes = reachable("src/routes.ts");
    expect(fromRoutes.has("src/integrations/routes.ts")).toBe(true);
    expect(fromRoutes.has("src/data/secrets.ts")).toBe(true);
    expect(reachable("src/integrations/probe.ts").has("src/data/secrets.ts")).toBe(true);
  });

  it("nothing reachable from src/mcp.ts imports src/data/secrets.ts, nor the Integrations API", () => {
    const fromMcp = reachable("src/mcp.ts");
    expect(fromMcp.size).toBeGreaterThan(20);
    expect(fromMcp.has("src/tools/reads.ts")).toBe(true);
    expect(fromMcp.has("src/data/secrets.ts")).toBe(false);
    expect([...fromMcp].filter((f) => f.startsWith("src/integrations/"))).toEqual([]);
    // …and no MCP-reachable file so much as names the decrypt path.
    for (const file of fromMcp) expect(SOURCES.get(file), file).not.toMatch(/\b(getSecret|resolveCredential|resolveGithubCredential)\s*\(/);
    // …nor the GitHub App (0043_github_app): its installation tokens are credentials too, and its key signs as the App.
    expect(SOURCES.has("src/github-app/credential.ts")).toBe(true);
    expect([...fromMcp].filter((f) => f.startsWith("src/github-app/"))).toEqual([]);
    for (const file of fromMcp) expect(SOURCES.get(file), file).not.toMatch(/\b(installationToken|mintInstallationToken|signAppJwt)\s*\(|\.GITHUB_APP_PRIVATE_KEY\b/);
  });

  it("the hosting layer: MCP reaches only its secret-free read side — never the modules that hold, use or write a provider credential", () => {
    // The Repo dashboard projection (reachable from src/mcp.ts) reads the registry, the provider descriptions and
    // the stored parts. Everything that decrypts, stores, exchanges, revokes or polls with a credential is here:
    const credentialed = ["connections", "poll", "routes", "webhook", "setup", "part-writes", "probe"].map((m) => `src/hosting/${m}.ts`);
    for (const f of credentialed) expect(SOURCES.has(f), f).toBe(true);
    const fromMcp = reachable("src/mcp.ts");
    expect(fromMcp.has("src/hosting/parts.ts"), "the walker does reach the hosting read side").toBe(true);
    expect(credentialed.filter((f) => fromMcp.has(f))).toEqual([]);
    // …and the read side itself calls no credential path: no import of the secrets module, no install exchange or revoke.
    for (const f of [...fromMcp].filter((x) => x.startsWith("src/hosting/"))) {
      expect(SOURCES.get(f), f).not.toMatch(/from\s+["'][^"']*data\/secrets["']|\binstall!?\.(?:exchange|revoke)!?\s*\(/);
    }
  });
});

describe("billing is not an agent's", () => {
  it("nothing reachable from src/mcp.ts imports the Stripe client, or anything else of src/billing/", () => {
    const fromMcp = reachable("src/mcp.ts");
    expect(SOURCES.has("src/billing/stripe.ts")).toBe(true);
    // The walker finds it from where it IS used: the HTTP app and the Worker's entry point (the webhook).
    expect(reachable("src/routes.ts").has("src/billing/stripe.ts")).toBe(true);
    expect(reachable("src/index.ts").has("src/billing/webhook.ts")).toBe(true);
    expect([...fromMcp].filter((f) => f.startsWith("src/billing/"))).toEqual([]);
    // …and no MCP-reachable file names the client's call or reads either Stripe secret.
    for (const file of fromMcp) expect(SOURCES.get(file), file).not.toMatch(/\bstripeCall\s*\(|\.STRIPE_SECRET_KEY\b|\.STRIPE_WEBHOOK_SECRET\b/);
    // The key is read in ONE module (the config) and sent by ONE (the client).
    const readers = [...SOURCES].filter(([f, text]) => f.startsWith("src/") && f !== "src/env.ts" && /\bSTRIPE_SECRET_KEY\b/.test(text)).map(([f]) => f);
    expect(readers).toEqual(["src/billing/config.ts"]);
    const senders = [...SOURCES].filter(([f, text]) => f.startsWith("src/") && /\bsecretKey\b/.test(text)).map(([f]) => f).sort();
    expect(senders).toEqual(["src/billing/config.ts", "src/billing/stripe.ts"]);
  });
});

describe("a bearer context", () => {
  it("cannot read a secret, whatever its role — neither the stored one nor the legacy fallback", async () => {
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", "tok_0123456789abcdef0123456789abcdef");
    const legacy: Env = { ...e, GITHUB_SERVICE_TOKEN: "ghs_legacy_token_value_000000000000" };
    for (const ctx of [await bearerCtx("AndresL230"), await bearerCtx("meilin", "admin"), await bearerCtx("sanaok", "member")]) {
      expect(ctx.via).toBe("bearer");
      await expect(getSecret(ctx, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
      await expect(resolveCredential(ctx, legacy, "github_token", "")).rejects.toBeInstanceOf(SecretAccessError);
      await expect(resolveCredential(ctx, legacy, "railway", "staging")).rejects.toBeInstanceOf(SecretAccessError);
    }
  });
});
