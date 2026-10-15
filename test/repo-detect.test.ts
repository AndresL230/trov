/**
 * The repo scan's PURE side (repo setups, Phase D): the subset parsers, every detector on fixture files
 * (fixtures/repo-scan/), the registry's file pick and merge, the signal token rules (a match, and the ambiguous
 * case that matches nothing), and the parts a suggestion proposes.
 */
import { describe, it, expect } from "vitest";
import type { SeenSignal } from "@shared/repo-scan-core";
import { parseJsonc, parseToml, parseYaml } from "../src/repo/detect/parse";
import { DETECTORS, SCAN_FILE_MAX, detectAll, lookedFor, pickFiles, type DetectInput } from "../src/repo/detect";
import { candidateMatches, envForHint, matchSignals, parseSignalName } from "../src/repo/detect/match";
import { buildParts, foldDescribed } from "../src/repo/scan";
import { PROVIDERS } from "../src/hosting/registry";
import { ENVS } from "./helpers/repo";

const RAW = import.meta.glob("../fixtures/repo-scan/**/*", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

/** A fixture repository: path → text (`_github` / `_do` mapped back to `.github` / `.do`; the README left out). */
function fixture(name: "storefront" | "singles"): Map<string, string> {
  const prefix = `../fixtures/repo-scan/${name}/`;
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(RAW)) {
    if (!k.startsWith(prefix)) continue;
    const path = k.slice(prefix.length).replace(/^_github\//, ".github/").replace(/^_do\//, ".do/");
    if (path !== "README.md") out.set(path, v);
  }
  return out;
}
const single = (file: string): string => fixture("singles").get(file)!;
const input = (files: Record<string, string>, extraTree: string[] = [], repo = "acme/shop"): DetectInput =>
  ({ repo, tree: [...Object.keys(files), ...extraTree], files: new Map(Object.entries(files)) });
const run = (id: string, i: DetectInput) => DETECTORS.find((d) => d.id === id)!.detect(i);

const sig = (kind: SeenSignal["kind"], name: string, extra: Partial<SeenSignal> = {}): SeenSignal =>
  ({ kind, name, provider: null, count: 3, lastAt: "2026-10-14T00:00:00Z", source: null, ...extra });

describe("the subset parsers", () => {
  it("TOML: tables, arrays of tables, dotted keys, multi-line arrays, inline tables, strings of every kind", () => {
    const t = parseToml(`a = "x\\ty" # c\nb = 'lit'\nn = 1_000\n[s.t]\nk = true\narr = [\n  "1", # one\n  "2",\n]\n[[list]]\nv = 1\n[[list]]\nv = 2\ninl = { x = "y", z = [1, 2] }\nm = """\nmulti"""\n`);
    expect(t).toEqual({ a: "x\ty", b: "lit", n: 1000, s: { t: { k: true, arr: ["1", "2"] } }, list: [{ v: 1 }, { v: 2, inl: { x: "y", z: [1, 2] }, m: "multi" }] });
    expect(parseToml(`__proto__ = "x"\nok = 1`)).toEqual({ ok: 1 });
    expect(parseToml("this is not toml\n= nor this\nfine = 'yes'")).toEqual({ fine: "yes" });
  });

  it("YAML: maps, sequences of scalars and of maps, flow sequences, block scalars, comments; a second document is ignored", () => {
    const y = parseYaml(`a: 1\nb: "two" # c\nlist:\n  - x\n  - 'y'\nmaps:\n  - name: n1\n    deep:\n      k: v\n  - name: n2\nflow: [p, q]\nrun: |\n  line 1\n  line 2\nsame:\n- s1\n---\nother: doc\n`);
    expect(y).toEqual({ a: 1, b: "two", list: ["x", "y"], maps: [{ name: "n1", deep: { k: "v" } }, { name: "n2" }], flow: ["p", "q"], run: "line 1\nline 2", same: ["s1"] });
    expect(parseYaml("")).toBeNull();
  });

  it("JSONC: comments and trailing commas; strings that look like comments are kept", () => {
    expect(parseJsonc(`{ "a": "http://x//y", /* c */ "b": [1, 2,], // tail\n }`)).toEqual({ a: "http://x//y", b: [1, 2] });
    expect(parseJsonc("{ nope")).toBeNull();
  });
});

describe("the detectors, each on its fixture", () => {
  it("wrangler.toml (Trov's own): a Worker named trov, its D1 id and crons as extras, [env.preview] as trov-preview", () => {
    const [c] = run("wrangler", input({ "wrangler.toml": single("wrangler.toml") }));
    expect(c).toMatchObject({ folder: "/", kind: "Worker", provider: "cloudflare", source: "deploy" });
    expect(c.settings).toEqual({ worker: "trov", d1_database_ids: "6c71838c-18f7-4f68-8513-b58e86c237b9", crons: "*/10 * * * *;0 * * * *;0 * * * SUN,MON" });
    expect(c.envSettings).toEqual({ preview: { worker: "trov-preview", d1_database_ids: "b8e88540-be00-4938-9f71-1eac4a8e7232", crons: "*/10 * * * *;0 * * * *;0 * * * SUN,MON" } });
    expect(c.evidence).toEqual([{ kind: "file", text: "from wrangler.toml · Worker trov" }]);
  });

  it("wrangler.jsonc: an environment's own name, else wrangler's <name>-<env>; a Pages project is a Site with no Worker setting", () => {
    const [c] = run("wrangler", input({ "edge/wrangler.jsonc": single("wrangler.jsonc") }));
    expect(c).toMatchObject({ folder: "edge", kind: "Worker", settings: { worker: "edge-api", crons: "0 3 * * *" } });
    expect(c.envSettings).toEqual({ staging: { worker: "edge-api-stg", crons: "0 3 * * *" }, production: { worker: "edge-api-production", crons: "0 3 * * *" } });
    const [pages] = run("wrangler", input({ "apps/docs/wrangler.toml": fixture("storefront").get("apps/docs/wrangler.toml")! }));
    expect(pages).toMatchObject({ folder: "apps/docs", kind: "Site", provider: "cloudflare", settings: {}, names: ["storefront-docs"] });
  });

  it("vercel.json, netlify.toml ([build] base), fly.toml (app)", () => {
    expect(run("vercel", input({ "apps/web/vercel.json": fixture("storefront").get("apps/web/vercel.json")! }))).toMatchObject([{ folder: "apps/web", kind: "Site", provider: "vercel", settings: {} }]);
    expect(run("vercel", input({ "vercel.json": `{ "name": "legacy-site" }` }))).toMatchObject([{ folder: "/", settings: { project: "legacy-site" } }]);
    expect(run("netlify", input({ "netlify.toml": single("netlify.toml") }))).toMatchObject([{ folder: "sites/marketing", kind: "Site", provider: "netlify", evidence: [{ text: "from netlify.toml · base sites/marketing" }] }]);
    expect(run("netlify", input({ "a/netlify.toml": `[build]\nbase = "../../x"` }))).toEqual([]); // climbs out of the repository
    expect(run("fly", input({ "apps/jobs/fly.toml": fixture("storefront").get("apps/jobs/fly.toml")! }))).toMatchObject([{ folder: "apps/jobs", kind: "Service", provider: "fly", settings: { app: "storefront-jobs" } }]);
  });

  it("render.yaml: a service per entry, rootDir its folder; a database is not an app", () => {
    expect(run("render", input({ "render.yaml": fixture("storefront").get("render.yaml")! }))).toEqual([{
      folder: "apps/api", kind: "Service", provider: "render", source: "deploy", names: ["storefront-api"], settings: {},
      evidence: [{ kind: "file", text: "from render.yaml · service storefront-api" }],
    }]);
    expect(run("render", input({ "render.yaml": "services:\n  - type: cron\n    name: nightly\n  - type: web\n    runtime: static\n    name: www\n" })).map((c) => [c.folder, c.kind])).toEqual([["/", "Job"], ["/", "Site"]]);
  });

  it("railway.json, amplify.yml (appRoot, AWS later), .do/app.yaml (no host), Procfile", () => {
    expect(run("railway", input({ "railway.json": single("railway.json") }))).toMatchObject([{ folder: "/", kind: "Service", provider: "railway" }]);
    expect(run("amplify", input({ "amplify.yml": single("amplify.yml") }))).toMatchObject([{ folder: "apps/admin", kind: "Site", provider: "aws" }]);
    expect(run("digitalocean", input({ ".do/app.yaml": single(".do/app.yaml") })).map((c) => [c.folder, c.kind, c.provider, c.names])).toEqual([
      ["services/api", "Service", null, ["api"]], ["web", "Site", null, ["www"]], ["services/cron", "Job", null, ["nightly"]],
    ]);
    expect(run("procfile", input({ Procfile: single("Procfile") }))).toMatchObject([{ folder: "/", kind: "Service", provider: null, evidence: [{ text: "from Procfile · processes web, worker, release" }] }]);
  });

  it("a Dockerfile counts only with a workflow that references its folder AND deploys", () => {
    const wf = single(".github/workflows/deploy-api.yml");
    expect(run("docker", input({ ".github/workflows/deploy-api.yml": wf }, ["services/api/Dockerfile", "tools/Dockerfile"]))).toEqual([{
      folder: "services/api", kind: "Service", provider: null, source: "deploy", names: [], workflow: ".github/workflows/deploy-api.yml", settings: {},
      evidence: [{ kind: "file", text: "from services/api/Dockerfile" }, { kind: "file", text: "deployed by .github/workflows/deploy-api.yml" }],
    }]);
    // A workflow that builds but never deploys is not evidence.
    expect(run("docker", input({ ".github/workflows/ci.yml": "jobs:\n  b:\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          context: ./services/api\n" }, ["services/api/Dockerfile"]))).toEqual([]);
  });

  it("workspaces: pnpm / package.json / lerna / go.work / Cargo members; a member with no deploy config is a Package used by its dependents", () => {
    const sf = fixture("storefront");
    const tree = [...sf.keys()];
    const out = run("workspaces", { repo: "acme/storefront", tree, files: sf });
    expect(out.map((c) => [c.folder, c.kind, c.usedBy])).toEqual([
      ["apps/api", "Package", []], ["apps/docs", "Package", []], ["apps/jobs", "Package", []], ["apps/web", "Package", []], ["packages/ui", "Package", ["apps/docs", "apps/web"]],
    ]);
    expect(out.find((c) => c.folder === "packages/ui")!.evidence).toEqual([{ kind: "workspace", text: "from packages/ui/package.json · used by apps/docs and apps/web" }]);
    expect(out.find((c) => c.folder === "apps/web")!.evidence).toEqual([{ kind: "workspace", text: "workspace package @acme/web (pnpm-workspace.yaml)" }]);

    const go = run("workspaces", input({ "go.work": single("go.work") }, ["cmd/server/go.mod", "pkg/shared/go.mod", "tools/go.mod", "other/go.mod"]));
    expect(go.map((c) => c.folder)).toEqual(["cmd/server", "pkg/shared", "tools"]);
    const cargo = run("workspaces", input({ "Cargo.toml": single("Cargo.toml") }, ["crates/core/Cargo.toml", "crates/cli/Cargo.toml"]));
    expect(cargo.map((c) => [c.folder, c.evidence[0].text])).toEqual([["crates/cli", "from crates/cli/Cargo.toml"], ["crates/core", "from crates/core/Cargo.toml"]]);
    const lerna = run("workspaces", input({ "lerna.json": single("lerna.json") }, ["modules/a/package.json", "modules/b/x/package.json"]));
    expect(lerna.map((c) => c.folder)).toEqual(["modules/a"]);
    expect(run("workspaces", input({ "package.json": `{ "name": "solo" }` }))).toEqual([]);
  });
});

describe("the registry", () => {
  const sf = fixture("storefront");
  const tree = [...sf.keys(), "node_modules/x/vercel.json", "fixtures/vercel.json", "a/b/c/d/e/vercel.json"];

  it("picks ≤ 24 files nearest the root first, never from dependencies, fixtures or too deep", () => {
    const many = Array.from({ length: 40 }, (_, i) => `apps/a${String(i).padStart(2, "0")}/package.json`);
    const pick = pickFiles([...tree, ...many]);
    expect(pick.length).toBe(SCAN_FILE_MAX);
    expect(pick.slice(0, 3)).toEqual(["render.yaml", "package.json", "pnpm-workspace.yaml"]); // the root first, by detector order
    expect(pick).toContain("apps/web/vercel.json"); // deploy configs before members' package.json at the same depth
    expect(pick).toContain(".github/workflows/deploy-jobs.yml");
    expect(pick.some((p) => p.startsWith("node_modules/") || p.startsWith("fixtures/") || p.startsWith("a/b/c/d/e/"))).toBe(false);
    expect(lookedFor()).toEqual(expect.arrayContaining(["wrangler.toml", "vercel.json", "netlify.toml", "fly.toml", "render.yaml", "railway.json", "amplify.yml", ".do/app.yaml", "Procfile", "Dockerfile", ".github/workflows", "package.json", "pnpm-workspace.yaml", "go.work", "Cargo.toml"]));
  });

  it("merges per folder: one app per deployed folder (host-led, the workspace evidence joined), a Package for the rest", () => {
    const out = detectAll({ repo: "acme/storefront", tree: [...sf.keys()], files: sf });
    expect(out.map((c) => [c.folder, c.kind, c.provider])).toEqual([
      ["apps/api", "Service", "render"], ["apps/docs", "Site", "cloudflare"], ["apps/jobs", "Service", "fly"], ["apps/web", "Site", "vercel"], ["packages/ui", "Package", null],
    ]);
    const jobs = out.find((c) => c.folder === "apps/jobs")!;
    expect(jobs.settings).toEqual({ app: "storefront-jobs" });
    expect(jobs.workflow).toBe(".github/workflows/deploy-jobs.yml");
    expect(jobs.evidence.map((e) => e.text)).toEqual([
      "from apps/jobs/fly.toml · app storefront-jobs", "from apps/jobs/Dockerfile", "deployed by .github/workflows/deploy-jobs.yml", "workspace package @acme/jobs (pnpm-workspace.yaml)",
    ]);
    expect(out.find((c) => c.folder === "apps/api")!.names).toEqual(["storefront-api", "@acme/api"]);
  });

  it("a connected host's describe() upgrades evidence, fills its settings and turns a Package it builds into an app", () => {
    const base = detectAll({ repo: "acme/storefront", tree: [...sf.keys()], files: sf });
    const out = foldDescribed(base, [
      { provider: "vercel", label: "Vercel", project: { name: "storefront-web", folder: "apps/web", settings: { project: "storefront-web" }, kind: "Site" } },
      { provider: "vercel", label: "Vercel", project: { name: "storefront-ui-docs", folder: "packages/ui", settings: { project: "storefront-ui-docs" }, kind: "Site" } },
      { provider: "render", label: "Render", project: { name: "admin", folder: "apps/admin", settings: { service_id: "srv-abc" }, kind: "Service" } },
    ]);
    const web = out.find((c) => c.folder === "apps/web")!;
    expect(web.settings).toEqual({ project: "storefront-web" });
    expect(web.evidence.at(-1)).toEqual({ kind: "provider", text: "Vercel project storefront-web builds apps/web" });
    expect(out.find((c) => c.folder === "packages/ui")).toMatchObject({ kind: "Site", provider: "vercel", usedBy: [] });
    expect(out.find((c) => c.folder === "apps/admin")).toMatchObject({ kind: "Service", provider: "render", settings: { service_id: "srv-abc" } });
  });
});

describe("signals → candidates, by token rules", () => {
  it("reads every host's real name format (step 0)", () => {
    expect(parseSignalName(sig("deployment", "Production – storefront-web"))).toEqual({ tokens: ["storefront", "web"], envHint: "production" });
    expect(parseSignalName(sig("deployment", "Preview – storefront-web"))).toEqual({ tokens: ["storefront", "web"], envHint: "preview" });
    expect(parseSignalName(sig("deployment", "storefront-api / production"))).toEqual({ tokens: ["storefront", "api"], envHint: "production" });
    expect(parseSignalName(sig("deployment", "main - express-hello-world"))).toEqual({ tokens: ["express", "hello", "world"], envHint: "main" });
    expect(parseSignalName(sig("deployment", "docs (Production)"))).toEqual({ tokens: ["docs"], envHint: "production" });
    expect(parseSignalName(sig("check", "Render – api", { source: "render" }))).toEqual({ tokens: ["api"], envHint: null });
    expect(parseSignalName(sig("check", "Workers Builds: trov"))).toEqual({ tokens: ["trov"], envHint: null });
    expect(parseSignalName(sig("status", "netlify/marketing/deploy-preview"))).toEqual({ tokens: ["marketing"], envHint: "preview" });
    expect(parseSignalName(sig("status", "Vercel"))).toEqual({ tokens: [], envHint: null });
    expect(parseSignalName(sig("workflow", "deploy-jobs.yml", { source: ".github/workflows/deploy-jobs.yml" }))).toEqual({ tokens: ["deploy", "jobs"], envHint: null });
  });

  const cands = [
    { folder: "apps/web", kind: "Site" as const, names: [] },
    { folder: "apps/api", kind: "Service" as const, names: ["storefront-api"] },
    { folder: "apps/admin", kind: "Site" as const, names: [] },
    { folder: "packages/ui", kind: "Package" as const, names: [] },
  ];

  it("a signal containing the folder's last segment matches it — exactly one candidate", () => {
    const signals = [sig("deployment", "Production – storefront-web"), sig("deployment", "storefront-api / production"), sig("check", "Render – api", { source: "render" }), sig("deployment", "main - storefront-ui")];
    const m = matchSignals(cands, signals, "acme/storefront");
    expect(m.map((l) => l.map((s) => s.name))).toEqual([["Production – storefront-web"], ["storefront-api / production", "Render – api"], [], []]); // a Package never matches
  });

  it("AMBIGUOUS — a signal two candidates match goes to neither", () => {
    const m = matchSignals(cands, [sig("deployment", "Production – storefront-web-admin")], "acme/storefront");
    expect(m.every((l) => l.length === 0)).toBe(true);
  });

  it("the root's segment is the repository's name; a host's own name matches exactly", () => {
    expect(candidateMatches({ folder: "/", kind: "Worker", names: [] }, parseSignalName(sig("check", "Workers Builds: trov")), "AndresL230/trov")).toBe(true);
    expect(candidateMatches({ folder: "/", kind: "Worker", names: ["edge-api-stg"] }, parseSignalName(sig("check", "Workers Builds: edge-api-stg")), "acme/x")).toBe(true);
    expect(candidateMatches({ folder: "svc", kind: "Worker", names: ["edge-api"] }, parseSignalName(sig("check", "Workers Builds: edge-api-stg")), "acme/x")).toBe(false);
  });

  it("an environment hint names an org environment by key / label, prod ↔ production, else by branch; none or several → null", () => {
    expect(envForHint("Production", ENVS)).toBe("production");
    expect(envForHint("prod", ENVS)).toBe("production");
    expect(envForHint("main", ENVS)).toBe("staging"); // Render names the branch
    expect(envForHint("preview", ENVS)).toBeNull();
    expect(envForHint(null, ENVS)).toBeNull();
  });
});

describe("the parts a suggestion proposes", () => {
  it("its own host when the settings are complete — on production; the other named environments get a github part from their signal", () => {
    const parts = buildParts({ folder: "apps/jobs", kind: "Service", provider: "fly", source: "deploy", evidence: [], settings: { app: "storefront-jobs" } },
      [sig("deployment", "jobs / staging")], ENVS, PROVIDERS);
    expect(parts).toEqual([
      { env: "staging", provider: "github", settings: { environment: "jobs / staging" } },
      { env: "production", provider: "fly", settings: { app: "storefront-jobs" } },
    ]);
  });

  it("wrangler's environments go where they name; extras ride along for Phase G", () => {
    const parts = buildParts({ folder: "edge", kind: "Worker", provider: "cloudflare", source: "deploy", evidence: [], settings: { worker: "edge-api", crons: "0 3 * * *" },
      envSettings: { staging: { worker: "edge-api-stg" }, production: { worker: "edge-api-production" } } }, [], ENVS, PROVIDERS);
    expect(parts).toEqual([{ env: "staging", provider: "cloudflare", settings: { worker: "edge-api-stg" } }, { env: "production", provider: "cloudflare", settings: { worker: "edge-api-production" } }]);
  });

  it("no complete host settings: a github part per named environment; else the deploying workflow on the first environment; a Package none", () => {
    const render = { folder: "apps/api", kind: "Service" as const, provider: "render" as const, source: "deploy" as const, evidence: [], settings: {} };
    expect(buildParts(render, [sig("deployment", "main - storefront-api"), sig("deployment", "production - storefront-api")], ENVS, PROVIDERS)).toEqual([
      { env: "staging", provider: "github", settings: { environment: "main - storefront-api" } },
      { env: "production", provider: "github", settings: { environment: "production - storefront-api" } },
    ]);
    expect(buildParts({ ...render, provider: null, workflow: ".github/workflows/deploy-api.yml" }, [], ENVS, PROVIDERS)).toEqual([{ env: "staging", provider: "github", settings: { workflow: ".github/workflows/deploy-api.yml" } }]);
    expect(buildParts({ ...render, provider: null }, [], ENVS, PROVIDERS)).toEqual([]);
    expect(buildParts({ folder: "packages/ui", kind: "Package", provider: null, source: "workspace", evidence: [] }, [sig("deployment", "Production – ui")], ENVS, PROVIDERS)).toEqual([]);
  });
});
