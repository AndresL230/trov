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

describe("the org image module holds no credential (src/orgs/logo.ts: the token is resolved by its caller)", () => {
  it("src/orgs/logo.ts reaches neither src/data/secrets.ts nor src/github-app/", () => {
    const reach = reachable("src/orgs/logo.ts");
    expect(reach.has("src/data/secrets.ts")).toBe(false);
    expect([...reach].filter((f) => f.startsWith("src/github-app/"))).toEqual([]);
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

describe("deletion is a person's, never an agent's (invariant 2)", () => {
  it("nothing reachable from src/mcp.ts imports the deletion core, the Stripe cancel, or a deletion route", () => {
    const fromMcp = reachable("src/mcp.ts");
    expect(SOURCES.has("src/deletion/person.ts") && SOURCES.has("src/deletion/org.ts")).toBe(true);
    // The walker finds it from where it IS used: the HTTP app.
    expect(reachable("src/routes.ts").has("src/deletion/person.ts")).toBe(true);
    expect([...fromMcp].filter((f) => f.startsWith("src/deletion/") || f === "src/billing/cancel.ts")).toEqual([]);
    for (const file of fromMcp) expect(SOURCES.get(file), file).not.toMatch(/\b(deleteAccount|deleteOrganization|cancelSubscriptionNow)\s*\(/);
  });
});

describe("the model client is the summary seams', the AI pass's, the Sift run's and the plain-language filter's, never an agent's (docs/architecture/ai.md)", () => {
  it("nothing reachable from src/mcp.ts imports src/ai/ or the Jev provider; only the call sites import the client", () => {
    const fromMcp = reachable("src/mcp.ts");
    expect(SOURCES.has("src/ai/client.ts")).toBe(true);
    // The walker finds it from where it IS used: the webhook (and Sync, through the backfill).
    expect(reachable("src/webhook.ts").has("src/ai/client.ts")).toBe(true);
    expect(reachable("src/tools/backfill.ts").has("src/ai/client.ts")).toBe(true);
    // …and the repo tick, through the AI pass (docs/architecture/ai.md); the AI routes from the HTTP app.
    expect(reachable("src/repo/cron.ts").has("src/ai/pass.ts")).toBe(true);
    expect(reachable("src/routes.ts").has("src/ai/routes.ts")).toBe(true);
    // …and the Sift run, from the Tags routes — and through it the Jev provider.
    expect(reachable("src/routes.ts").has("src/ai/sift.ts")).toBe(true);
    expect(reachable("src/ai/sift.ts").has("src/tools/classify.ts")).toBe(true);
    // MCP reaches the tags module (and its Sift helpers), but no model client and no provider.
    expect(fromMcp.has("src/tools/tag-fit.ts")).toBe(true);
    expect([...fromMcp].filter((f) => f.startsWith("src/ai/"))).toEqual([]);
    expect(fromMcp.has("src/tools/classify.ts")).toBe(false);
    // THE call sites (ai.md › Where a model call may happen): the summary seams, the AI pass (with its batch half
    // and its job interface — types only — and Phase C's card logic, Jev's answer types only), the Sift run, the filter
    // route — and the Ask route (docs/architecture/ask.md): its turn (the streamed answer) and its history (the one-time
    // compaction of a long thread, by Fast).
    const importers = [...SOURCES.keys()].filter((f) => f !== "src/ai/client.ts" && reachableDirect(f).has("src/ai/client.ts")).sort();
    expect(importers).toEqual([
      "src/ai/ask/history.ts", "src/ai/ask/turn.ts",
      "src/ai/batches.ts", "src/ai/filter.ts", "src/ai/jobs.ts", "src/ai/jobs/review-card.ts", "src/ai/jobs/ticket-card.ts", "src/ai/jobs/unplaced-card.ts",
      "src/ai/pass.ts", "src/ai/sift.ts", "src/tools/summarize.ts",
    ]);
    expect(reachable("src/routes.ts").has("src/ai/ask/turn.ts")).toBe(true);
    // …and those three import its TYPES only: no value of the client (no provider, no call) is in them.
    for (const f of ["src/ai/jobs/review-card.ts", "src/ai/jobs/ticket-card.ts", "src/ai/jobs/unplaced-card.ts"]) {
      expect(SOURCES.get(f), f).toMatch(/import type \{[^}]*\} from "\.\.\/client";/);
      expect(SOURCES.get(f), f).not.toMatch(/import \{[^}]*\} from "\.\.\/client";/);
    }
    // The filter's ONE way in is its cookie route (src/ai/routes.ts `POST /ai/filter`): nothing else imports it.
    expect(reachable("src/routes.ts").has("src/ai/filter.ts")).toBe(true);
    expect([...SOURCES.keys()].filter((f) => reachableDirect(f).has("src/ai/filter.ts") && f !== "src/ai/filter.ts")).toEqual(["src/ai/routes.ts"]);
    // THE ROUTER (Phase B) is what MCP's writers mark through — reachable from src/mcp.ts — and it lives OUTSIDE
    // src/ai/ for exactly that reason: src/tools/ai-route.ts and src/data/ai-dirty.ts import nothing from src/ai/.
    expect(fromMcp.has("src/tools/ai-route.ts")).toBe(true);
    expect(fromMcp.has("src/data/ai-dirty.ts")).toBe(true);
    for (const f of ["src/tools/ai-route.ts", "src/data/ai-dirty.ts"]) expect([...reachable(f)].filter((x) => x.startsWith("src/ai/")), f).toEqual([]);
    // …and src/ai/router.ts (the AI side's name for it) only re-exports them.
    expect([...reachableDirect("src/ai/router.ts")].sort()).toEqual(["src/data/ai-dirty.ts", "src/tools/ai-route.ts"]);
    // The key is read where summaries are chosen, where AI eligibility is answered, the pass starts and the filter calls (and
    // where Platform says whether they are on) — and, as ONE BIT (`aiKeySet`: is there a key?), by the data layer's
    // context for THE read rule of the computed AI surfaces (src/plans/gate.ts `aiShown`) — nowhere else.
    const readers = [...SOURCES].filter(([f, text]) => f.startsWith("src/") && /\.ANTHROPIC_API_KEY\b/.test(text)).map(([f]) => f).sort();
    expect(readers).toEqual([
      "src/ai/ask/history.ts", "src/ai/ask/routes.ts", "src/ai/ask/turn.ts",
      "src/ai/eligibility.ts", "src/ai/filter.ts", "src/ai/pass.ts", "src/data/context.ts", "src/plans/summaries.ts", "src/platform/routes.ts",
    ]);
    // TypeSafe's key: the Sift run and the AI pass (its Jev jobs and gates) send with it; the Tags list says whether one is set.
    const jevReaders = [...SOURCES].filter(([f, text]) => f.startsWith("src/") && /\.TYPESAFE_API_KEY\b/.test(text)).map(([f]) => f).sort();
    expect(jevReaders).toEqual(["src/ai/pass.ts", "src/ai/sift.ts", "src/tags/routes.ts"]);
  });

  it("the Jev provider is the client's alone: only src/ai/client.ts imports it, and only it names TypeSafe's URL", () => {
    const providerImporters = [...SOURCES.keys()].filter((f) => reachableDirect(f).has("src/tools/classify.ts")).sort();
    expect(providerImporters).toEqual(["src/ai/client.ts"]);
    const namers = [...SOURCES].filter(([, text]) => /typesafe\.ai/i.test(text)).map(([f]) => f).sort();
    expect(namers).toEqual(["src/tools/classify.ts"]);
    // …and the SPA never names its API host either (the browser never calls a model). The Privacy Policy may link
    // TypeSafe AI's trust center (its subprocessors list); that is not the API.
    const web = (import.meta as unknown as { glob: (pattern: string[], o: { query: string; import: string; eager: true }) => Record<string, string> })
      .glob(["../web/src/**/*.ts"], { query: "?raw", import: "default", eager: true });
    expect(Object.keys(web).length).toBeGreaterThan(20);
    expect(Object.entries(web).filter(([, text]) => /api\.typesafe\.ai/i.test(text)).map(([f]) => f)).toEqual([]);
  });
});

describe("Ask Trov's import boundary (docs/architecture/ask.md › Never reachable from Ask)", () => {
  const askFiles = () => [...SOURCES.keys()].filter((f) => f.startsWith("src/ai/ask/"));

  it("src/ai/ask/** reaches no secret, no GitHub App credential, no billing — and never src/mcp.ts", () => {
    expect(askFiles().length).toBeGreaterThan(8);
    for (const entry of askFiles()) {
      const reach = reachable(entry);
      expect(reach.has("src/data/secrets.ts"), `${entry} reaches src/data/secrets.ts`).toBe(false);
      expect([...reach].filter((f) => f.startsWith("src/github-app/")), `${entry} reaches src/github-app/`).toEqual([]);
      expect([...reach].filter((f) => f.startsWith("src/billing/")), `${entry} reaches src/billing/`).toEqual([]);
      expect(reach.has("src/mcp.ts"), `${entry} reaches src/mcp.ts`).toBe(false);
      expect([...reach].filter((f) => f.startsWith("src/integrations/") || f === "src/deletion/person.ts" || f === "src/deletion/org.ts"), entry).toEqual([]);
    }
    // …and no Ask file so much as names a decrypt path or the audit log.
    for (const f of askFiles()) expect(SOURCES.get(f), f).not.toMatch(/\b(getSecret|resolveCredential|resolveGithubCredential|installationToken)\s*\(|\borg_audit\b|\borg_admin_audit\b/);
  });

  it("the walker finds Ask from the HTTP app, and MCP still reaches nothing under src/ai/", () => {
    expect(reachable("src/routes.ts").has("src/ai/ask/routes.ts")).toBe(true);
    expect([...reachable("src/mcp.ts")].filter((f) => f.startsWith("src/ai/"))).toEqual([]);
  });
});

/** The files `file` imports directly. */
function reachableDirect(file: string): Set<string> {
  const out = new Set<string>();
  for (const m of SOURCES.get(file)!.matchAll(IMPORT)) {
    const next = resolve(file, m[1] ?? m[2]);
    if (next) out.add(next);
  }
  return out;
}

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
