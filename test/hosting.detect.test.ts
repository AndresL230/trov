// "Detected: <provider>" (src/hosting/detect.ts) — a host the org's repository ALREADY shows signs of, read
// from the GitHub activity the capture stored (`repo_events`): check runs (with the posting app's slug in
// `raw`) and the deployments of configured environments (with their creator). It is a suggestion for the
// picker: one D1 read, this org's rows only, nothing external, and never an error on the setup screen.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { HostingProviderId, HostingSetupDTO } from "@shared/hosting";
import { app } from "../src/routes";
import { DETECT_WINDOW_MS, detectProviders, listDetectRows, readDetectionStatus, type DetectRow } from "../src/hosting/detect";
import { PROVIDERS } from "../src/hosting/registry";
import { run } from "./helpers/db";
import { ownerCookie, seedOrgSettings } from "./helpers/integrations";
import { send } from "./helpers/hosting-setup";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { seedOrgRepoConfig } from "./helpers/repo";

const A = "/api/o/saplinglearn";
const LABELS = Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, p.label])) as Record<HostingProviderId, string>;
const NONE = new Set<HostingProviderId>();
const row = (o: Partial<DetectRow>): DetectRow => ({ kind: "check", name: null, url: null, actor_login: null, app: null, last_at: "2026-10-07T12:00:00.000Z", n: 1, ...o });
const detect = (rows: DetectRow[], inUse: Set<HostingProviderId> = NONE) => detectProviders(rows, LABELS, inUse);

let seq = 0;
async function event(o: { org?: string; kind: "check" | "deploy" | "run"; name?: string; url?: string | null; actor?: string | null; app?: string | null; at: string }): Promise<void> {
  seq += 1;
  await run(env.DB,
    `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, env, part, state, name, actor_login, title, url, count, raw, provenance, occurred_at, recorded_at)
     VALUES (?, 'acme/web', ?, ?, 'main', 'abc', ?, NULL, NULL, 'success', ?, ?, NULL, ?, NULL, ?, 'webhook', ?, ?)`,
    o.org ?? ORG_A, `t:${seq}`, o.kind, seq, o.name ?? null, o.actor ?? null, o.url ?? null, JSON.stringify(o.app === undefined ? {} : { app: o.app }), o.at, o.at);
}

describe("detectProviders — what each host looks like from GitHub", () => {
  it("a check run posted by the provider's own GitHub App", () => {
    expect(detect([row({ app: "vercel", name: "Vercel Preview Comments" })])).toEqual([
      { provider: "vercel", evidence: "GitHub check runs posted by the Vercel app", last_seen: "2026-10-07T12:00:00.000Z", in_use: false },
    ]);
    expect(detect([row({ app: "netlify", name: "Header rules - acme-docs" })]).map((d) => d.provider)).toEqual(["netlify"]);
    expect(detect([row({ app: "cloudflare-workers-and-pages", name: "Workers Builds: web" })]).map((d) => d.provider)).toEqual(["cloudflare"]);
  });

  it("a check run that links to the host, or carries a name only that host uses", () => {
    expect(detect([row({ app: "some-ci", url: "https://app.netlify.com/sites/acme/deploys/1" })])).toMatchObject([{ provider: "netlify", evidence: "GitHub check runs that link to app.netlify.com" }]);
    expect(detect([row({ app: null, url: "https://dashboard.render.com/web/srv-1" })])).toMatchObject([{ provider: "render" }]);
    expect(detect([row({ app: "github-actions", name: "netlify/acme-docs/deploy-preview", url: "https://github.com/acme/web/runs/1" })])).toMatchObject([{ provider: "netlify", evidence: "a GitHub check run named netlify/acme-docs/deploy-preview" }]);
    expect(detect([row({ app: "github-actions", name: "Workers Builds: frontend-staging" })])).toMatchObject([{ provider: "cloudflare" }]);
  });

  it("a deployment created by the provider's bot (captured only for an environment already configured)", () => {
    expect(detect([row({ kind: "deploy", actor_login: "railway-app[bot]", name: "acme / staging" })])).toMatchObject([{ provider: "railway", evidence: "GitHub deployments created by railway-app[bot]" }]);
    expect(detect([row({ kind: "deploy", actor_login: "vercel[bot]", name: "Preview" })])).toMatchObject([{ provider: "vercel" }]);
    expect(detect([row({ kind: "deploy", actor_login: "someone", url: "https://fly.io/apps/acme/monitoring" })])).toMatchObject([{ provider: "fly", evidence: "GitHub deployments that link to fly.io" }]);
  });

  it("is narrow on purpose: an ordinary CI job is nobody's sign, and a look-alike host or name is not one either", () => {
    for (const r of [
      row({ app: "github-actions", name: "test", url: "https://github.com/acme/web/actions/runs/1" }),
      row({ app: "github-actions", name: "render docs" }),                    // a job NAMED render is not Render
      row({ app: "github-actions", name: "deploy to fly" }),
      row({ app: "notvercel", url: "https://vercel.com.evil.example/x" }),
      row({ app: null, url: "http://app.netlify.com/insecure" }),              // not https
      row({ app: null, url: "not a url" }),
      row({ kind: "deploy", actor_login: "octocat", name: "production" }),
    ]) expect(detect([r]), JSON.stringify(r)).toEqual([]);
  });

  it("one entry per provider, in picker order, carrying its NEWEST sign; a provider a part already uses is flagged, not dropped", () => {
    const out = detect([
      row({ app: "netlify", last_at: "2026-10-01T00:00:00.000Z" }),
      row({ app: "vercel", last_at: "2026-10-02T00:00:00.000Z" }),
      row({ kind: "deploy", actor_login: "vercel[bot]", last_at: "2026-10-05T00:00:00.000Z" }),
      row({ app: "cloudflare-workers-and-pages", last_at: "2026-10-03T00:00:00.000Z" }),
    ], new Set<HostingProviderId>(["cloudflare"]));
    expect(out.map((d) => [d.provider, d.last_seen.slice(0, 10), d.in_use])).toEqual([["cloudflare", "2026-10-03", true], ["vercel", "2026-10-05", false], ["netlify", "2026-10-01", false]]);
    expect(out[1].evidence).toBe("GitHub deployments created by vercel[bot]");
  });

  it("reads stored rows only: the module reaches no network and names no other org's data", () => {
    const detectSrc = (import.meta.glob("../src/hosting/detect.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)["../src/hosting/detect.ts"];
    expect(detectSrc).not.toMatch(/\bfetch\(|api\.github\.com|hostFetch|resolveGithubCredential/);
    expect(detectSrc).toContain("WHERE org_id = ?");
  });
});

describe("the read — this org's captured check runs and deployments of the last 90 days", () => {
  it("groups by app and name, newest first, and leaves out other kinds, other orgs and anything older than the window", async () => {
    const now = Date.parse("2026-10-07T12:00:00.000Z");
    const at = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
    await event({ kind: "check", name: "Vercel Preview Comments", app: "vercel", url: "https://vercel.com/acme/web", at: at(2) });
    await event({ kind: "check", name: "Vercel Preview Comments", app: "vercel", url: "https://vercel.com/acme/web", at: at(1) });
    await event({ kind: "check", name: "test", app: "github-actions", at: at(3) });
    await event({ kind: "deploy", name: "acme / staging", actor: "railway-app[bot]", at: at(4) });
    await event({ kind: "run", name: "ci", at: at(1) });                                  // not a sign
    await event({ kind: "check", name: "old", app: "netlify", at: at(DETECT_WINDOW_MS / 86_400_000 + 1) });
    await event({ org: ORG_B, kind: "check", name: "theirs", app: "netlify", at: at(1) });
    const rows = await listDetectRows(systemCtx(ORG_A), now);
    expect(rows.map((r) => [r.kind, r.name, r.app, r.actor_login, r.n, r.last_at])).toEqual([
      ["check", "Vercel Preview Comments", "vercel", null, 2, at(1)],
      ["check", "test", "github-actions", null, 1, at(3)],
      ["deploy", "acme / staging", null, "railway-app[bot]", 1, at(4)],
    ]);
    expect((await listDetectRows(systemCtx(ORG_B), now)).map((r) => r.name)).toEqual(["theirs"]);
  });
});

describe("GET /hosting carries what was detected", () => {
  it("nothing captured: an empty list; a captured Vercel check run: a suggestion; a provider a part uses: flagged", async () => {
    await seedOrgSettings();
    const me = await ownerCookie();
    const read = async () => (await send(app, "GET", `${A}/hosting`, me, undefined, env as never)).json as unknown as HostingSetupDTO;
    expect((await read()).detected).toEqual([]);

    const at = new Date(Date.now() - 3_600_000).toISOString();
    await event({ kind: "check", name: "Vercel Preview Comments", app: "vercel", at });
    await event({ kind: "check", name: "Workers Builds: frontend-staging", app: "cloudflare-workers-and-pages", at });
    const dto = await read();
    // SaplingLearn's Cloudflare frontend is a (legacy) part: seen, and already in use. Vercel is new.
    expect(dto.detected).toEqual([
      { provider: "cloudflare", evidence: "GitHub check runs posted by the Cloudflare Workers app", last_seen: at, in_use: true },
      { provider: "vercel", evidence: "GitHub check runs posted by the Vercel app", last_seen: at, in_use: false },
    ]);
    // It suggested; it connected nothing.
    expect(dto.connections.some((c) => c.provider === "vercel")).toBe(false);

    expect((await send(app, "PUT", `${A}/environments/staging/parts/web`, me, { provider: "vercel", settings: { project: "acme-web" } }, env as never)).status).toBe(201);
    expect((await read()).detected.find((d) => d.provider === "vercel")).toMatchObject({ in_use: true });
  });
});

describe("readDetectionStatus — where detection stands, for a new org", () => {
  const status = (detected: Parameters<typeof readDetectionStatus>[1] = [], envs = 2) => readDetectionStatus(systemCtx(ORG_B), detected, envs);
  const found = [{ provider: "vercel" as const, evidence: "GitHub check runs posted by the Vercel app", last_seen: "2026-10-07T12:00:00.000Z", in_use: false }];

  it("walks no repository → no environment → looking → nothing found / found, from this org's own rows", async () => {
    expect(await status()).toEqual({ state: "no_repo", repo: null, checked_at: null });
    await seedOrgRepoConfig(env.DB, ORG_B, "acme/web", []);
    expect(await status([], 0)).toEqual({ state: "no_environment", repo: "acme/web", checked_at: null });
    // A repository and environments, but its checks never read: looking.
    expect(await status()).toEqual({ state: "looking", repo: "acme/web", checked_at: null });
    // A reconcile read them and found no host Trov knows.
    await run(env.DB, `INSERT INTO repo_snapshots (org_id, kind, json, computed_at) VALUES (?, 'prs_reconciled', '{}', ?)`, ORG_B, "2026-10-07T12:30:00.000Z");
    expect(await status()).toEqual({ state: "none", repo: "acme/web", checked_at: "2026-10-07T12:30:00.000Z" });
    // A sync under way is looking again (it ends with a reconcile).
    await run(env.DB, `INSERT INTO sync_runs (org_id, repo, started_by, started_at, updated_at) VALUES (?, 'acme/web', 'andres', ?, ?)`, ORG_B, "2026-10-07T12:40:00.000Z", "2026-10-07T12:40:00.000Z");
    expect((await status()).state).toBe("looking");
    // Anything detected is found, whatever else is going on.
    expect((await status(found)).state).toBe("found");
  });

  it("never reads another org's rows", async () => {
    await seedOrgRepoConfig(env.DB, ORG_A, "other/repo", []);
    expect((await status()).state).toBe("no_repo");
  });

  it("GET /hosting carries it", async () => {
    await seedOrgSettings();
    const r = await send(app, "GET", `${A}/hosting`, await ownerCookie(), undefined, env as never);
    expect(r.status).toBe(200);
    expect((r.json as unknown as HostingSetupDTO).detection).toMatchObject({ state: expect.stringMatching(/^(no_repo|no_environment|looking|none|found)$/) });
  });
});
