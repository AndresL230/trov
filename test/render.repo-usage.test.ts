/**
 * The Usage tab per the design's UsageTarget (repo setups, Phase G — web/src/repo-usage.ts, web/src/repo.ts): one card
 * per target in one of four states, the extra families of a Worker, and the Product block (v2 or self-described v3).
 * Every scenario the sample switch shows is drawn from `repoScenarioUsage` — the projection's own shapes.
 *
 * What matters: the three empty states are exactly #185's words ("Not connected", "Not available from <host>" + its
 * reason, "No recent reading"); a repository never reads "not connected" for a thing it does not have; an unconfirmed
 * figure never shows; the SPA never branches on a provider id (families drive the extra blocks); the App menu narrows.
 */
import { describe, it, expect } from "vitest";
import { REPO_WIDE } from "@shared/repo-facts-core";
import type { RepoDashboard } from "@shared/repo";
import type { RepoProviderPart } from "@shared/hosting";
import { repoView, type RepoProps } from "../web/src/repo";
import { repoSample, repoScenario, repoScenarioUsage } from "../web/src/repo-sample";
import { SCENARIO_KEYS, SCENARIO_VARIANTS, type ScenarioKey } from "../web/src/repo-sample-keys";
import { targetState, usageExtras, usageTargets } from "../web/src/repo-usage";
import { ago, sparkPoints } from "../web/src/repo";

const NOW = Date.parse("2026-10-15T12:00:00Z");

function dashboard(key: ScenarioKey, variant = ""): RepoDashboard {
  return { ...repoSample(NOW), facts: repoScenario(key, variant, { now: NOW }), ...repoScenarioUsage(key, variant, { now: NOW }) };
}
function view(key: ScenarioKey, variant = "", over: Partial<RepoProps> = {}): string {
  return repoView({
    tab: "usage", range: "7d", driftOpen: false, repo: { status: "ok", data: dashboard(key, variant) }, fetchedAt: NOW, sample: true, admin: true,
    poll: null, productEnv: null, now: NOW, ...over,
  });
}
const partsOf = (key: ScenarioKey, variant = ""): RepoProviderPart[] => {
  const s = repoScenarioUsage(key, variant, { now: NOW }).providers;
  return s.status === "ok" ? s.data : [];
};
/** The markup of one target card. */
const card = (html: string, envPart: string): string => {
  const at = html.indexOf(`data-utarget="${envPart}"`);
  if (at < 0) return "";
  const next = html.indexOf("data-utarget=", at + 20);
  return html.slice(at, next < 0 ? html.indexOf("data-usage-", at) : next);
};
const states = (html: string): Record<string, string> =>
  Object.fromEntries([...html.matchAll(/data-utarget="([^"]+)" data-ustate="([a-z]+)"/g)].map((m) => [m[1], m[2]]));
const tools = { range: "7d" as const, now: NOW, ago, sparkPoints: (v: number[]) => sparkPoints(v) };

describe("the targets — four states, #185's words", () => {
  it("A: a Cloudflare Worker reads traffic, a Railway service CPU and memory; the environment's active users ride its first web target", () => {
    const html = view("A");
    expect(states(html)).toEqual({ "staging/web": "ok", "staging/api": "ok", "production/web": "ok", "production/api": "ok" });
    const web = card(html, "production/web");
    expect(web).toContain("Requests · 7d");
    expect(web).toContain("Error rate");
    expect(web).toContain("Active users");
    expect(web).toContain("from Cloudflare Workers");
    const api = card(html, "production/api");
    expect(api).toContain(">CPU<");
    expect(api).toContain(">Memory<");
    expect(api).not.toContain("Active users");
    expect(html).not.toContain("Not connected");
    expect(html).not.toMatch(/undefined|NaN|\[object/);
  });

  it("A/trouble: a host that has gone quiet reads 'No recent reading' — never a number, never 'not connected'", () => {
    const html = view("A", "trouble");
    expect(states(html)["staging/api"]).toBe("stale");
    const api = card(html, "staging/api");
    expect(api).toContain("No recent reading");
    expect(api).toContain("last poll 34m ago");
    expect(api).toContain("Railway has not reported for this range. Readings resume when it does; nothing is assumed in between.");
    expect(api).not.toMatch(/\d\.\d\d<\/span><span[^>]*>vCPU/);
  });

  it("C: a host with no usage API is 'Not available from Netlify' with its reason — never 'not connected'", () => {
    const html = view("C");
    expect(states(html)).toEqual({ "production/site": "na" });
    const site = card(html, "production/site");
    expect(site).toContain("Not available from Netlify");
    expect(site).toContain("Netlify has no documented usage API");
    expect(html).not.toContain("Not connected");
    expect(html).not.toContain("data-uextras");
  });

  it("E: Vercel is not available, Render reads CPU and memory, Cloudflare Pages reads traffic and its extras, Fly.io is not connected", () => {
    const html = view("E");
    expect(states(html)).toEqual({ "production/web": "na", "production/api": "ok", "production/docs": "ok", "production/jobs": "nc" });
    const jobs = card(html, "production/jobs");
    expect(jobs).toContain("Not connected");
    expect(jobs).toContain("Connect Fly.io to see CPU and memory for jobs in Production.");
    // The sample sends nothing: no Connect button there, whoever looks.
    expect(jobs).not.toContain('data-act="orgGo"');
    expect(html).toContain('data-uextras="production/docs"');
    expect(html).not.toContain('data-uextras="production/jobs"');
  });

  it("E with the App menu: one app's target alone, and Repo-wide only has none", () => {
    expect(Object.keys(states(view("E", "", { app: "api" })))).toEqual(["production/api"]);
    const wide = view("E", "", { app: REPO_WIDE });
    expect(states(wide)).toEqual({});
    expect(wide).toContain("Usage is read per app — Repo-wide only has none.");
    expect(wide).not.toContain("data-uextras");
  });

  it("G: Railway not connected — every service says so, with nothing guessed; connected (after), each reads", () => {
    for (const v of ["", "signals"]) {
      const html = view("G", v);
      const s = Object.values(states(html));
      expect(s.length, v).toBe(8);
      expect(new Set(s), v).toEqual(new Set(["nc"]));
      expect(html).toContain("Connect Railway to see CPU and memory for gateway in Production.");
    }
    expect(new Set(Object.values(states(view("G", "after"))))).toEqual(new Set(["ok"]));
  });

  it("H: Fly.io not connected for collector; normalizer on GitHub deployments is not available — never 'not connected'", () => {
    const html = view("H");
    expect(states(html)).toEqual({ "staging/collector": "nc", "staging/normalizer": "na", "production/collector": "nc", "production/normalizer": "na" });
    const norm = card(html, "production/normalizer");
    expect(norm).toContain("Not available from GitHub deployments");
    expect(norm).toContain("GitHub reports deploys only");
    expect(norm).not.toContain("Not connected");
  });

  it("no 'not connected' for a thing the repository does not have — every scenario, every variant", () => {
    for (const key of SCENARIO_KEYS) {
      for (const v of key === "N" ? ["", "trov"] : ["", ...SCENARIO_VARIANTS[key as Exclude<ScenarioKey, "N">]]) {
        const facts = repoScenario(key, v, { now: NOW });
        const html = view(key, v);
        for (const [target, state] of Object.entries(states(html))) {
          const [env, app] = target.split("/");
          const p = facts.parts.find((x) => x.env === env && x.app === app);
          expect(p, `${key}/${v} ${target}`).toBeDefined();
          // `nc` only where the scenario's host is really not connected; a host with nothing to read is `na`.
          if (state === "nc") expect(p!.connection === "not_connected" || p!.viaGithub, `${key}/${v} ${target}`).toBe(true);
          if (!p!.reportsMetrics) expect(state, `${key}/${v} ${target}`).toBe("na");
        }
        expect(html, `${key}/${v}`).not.toMatch(/undefined|NaN|\[object/);
      }
    }
  });

  it("a host with nothing to read is 'not available' even while it is not connected — never 'Connect Netlify' for usage it cannot give", () => {
    const [site] = partsOf("C");
    for (const connection of ["not_connected", "revoked"] as const) {
      const p: RepoProviderPart = { ...site, connection };
      expect(targetState(p, "7d")).toBe("na");
      const html = usageTargets([p], tools, { admin: true, sample: false });
      expect(html).toContain("Not available from Netlify");
      expect(html).not.toContain("Not connected");
      expect(html).not.toContain("Connect Netlify");
    }
  });

  it("I (a package) and L (nothing accepted yet) have no target: one sentence, no card, no 'not connected'", () => {
    for (const key of ["I", "L"] as const) {
      const html = view(key);
      expect(html).toContain('data-utargets="none"');
      expect(html).toContain("Usage is read per target.");
      expect(html).not.toContain("Not connected");
    }
  });

  it("an admin outside the sample is offered Connect <host>; a member reads who does it", () => {
    const parts = partsOf("E");
    const admin = usageTargets(parts, tools, { admin: true, sample: false });
    expect(card(admin, "production/jobs")).toContain('data-act="orgGo" data-arg="hosting"');
    expect(card(admin, "production/jobs")).toContain(">Connect Fly.io</button>");
    const member = usageTargets(parts, tools, { admin: false, sample: false });
    expect(card(member, "production/jobs")).not.toContain("<button");
    expect(card(member, "production/jobs")).toContain("An admin connects it in Org settings › Hosting.");
  });
});

describe("the extra families — drawn because the part carries them", () => {
  it("B: requests by outcome by Cloudflare's own names (no 4xx / 5xx), the Worker's runtime, its D1 database, its crons", () => {
    const html = view("B");
    const x = html.slice(html.indexOf('data-uextras="production/trov"'));
    expect(x).toContain("Requests by outcome · trov · Production");
    for (const s of ["success", "clientDisconnected", "scriptThrewException", "exceededResources"]) expect(x).toContain(`data-uoutcome="${s}"`);
    expect(x).toContain(">Success<");
    expect(x).toContain(">Client disconnected<");
    expect(x).toContain(">Script errors<");
    expect(x).toContain(">Exceeded limits<");
    expect(x).toContain("not an HTTP status");
    expect(x).not.toMatch(/4xx|5xx|Client errors|Server errors/);
    expect(x).toContain("Worker · trov · Production");
    expect(x).toContain(">CPU time p99<");
    expect(x).toContain("16.4");
    expect(x).toContain('data-uspark="cpu_p99"');
    expect(x).toContain("D1 database · 6c71838c");
    expect(x).toContain(">Database size<");
    expect((x.match(/data-ucron="/g) ?? []).length).toBe(3);
    expect(x).toContain("*/10 * * * *");
  });

  it("B/failed: the failing cron's failures turn red, CPU p99 climbs", () => {
    const x = view("B", "failed");
    const cron = x.slice(x.indexOf('data-ucron="*/10 * * * *"'));
    expect(cron.slice(0, 900)).toContain("color:var(--red)");
    expect(x).toContain("31.6");
  });

  it("A: a Worker with no D1 id says why storage is not read, and draws no empty crons block", () => {
    const html = view("A");
    const x = html.slice(html.indexOf('data-uextras="production/web"'));
    expect(x).toContain("Not available from Cloudflare Workers: no D1 database is named for this part");
    expect(x).not.toContain('data-uextra="schedules"');
  });

  it("an unconfirmed figure never shows: null quantiles draw no stat, a family never read draws no block", () => {
    const [p] = partsOf("B");
    const bare: RepoProviderPart = {
      ...p,
      extras: {
        runtime: { state: "stale", reason: null, day: null, cpu_p50_ms: null, cpu_p99_ms: null, wall_p50_ms: null, subrequests: { "24h": null, "7d": null, "30d": null }, since: null, trend: [] },
        outcomes: { state: "none", reason: null, since: null, ranges: { "24h": null, "7d": null, "30d": null } },
      },
    };
    const html = usageExtras([bare], tools, { admin: false, sample: false });
    expect(html).not.toContain("CPU time");
    expect(html).toContain("No recent reading.");
    expect(html).not.toContain('data-uextra="outcomes"');
  });

  it("the SPA never branches on a provider id: the same extras on another provider's part draw the same blocks", () => {
    const [p] = partsOf("B");
    const renamed: RepoProviderPart = { ...p, provider: "render", provider_label: "Somehost" };
    const html = usageExtras([renamed], tools, { admin: false, sample: false });
    expect(html).toContain("Requests by outcome");
    expect(html).toContain("from Somehost");
    expect(targetState(renamed, "7d")).toBe("ok");
  });
});

describe("the Product block", () => {
  it("B: Trov's own v3 body, drawn by each group's shape — never by a key", () => {
    const html = view("B");
    expect(html).toContain("Product · Trov");
    expect(html).toContain("from the app's own metrics endpoint");
    expect(html).toContain('data-pblock="now" data-pshape="now"');
    expect(html).toContain('data-pblock="mcp_tools" data-pshape="ranked"');
    expect(html).toContain('data-pblock="gate" data-pshape="stats"');
    expect(html).toContain('data-pblock="activity" data-pshape="stats"');
    for (const label of ["People", "Live docs", "Awaiting review", "In triage", "Open tickets", "MCP tool calls", "Agent writes through the gate", "Sessions recorded", "People active"]) expect(html).toContain(label);
    expect(html).toContain("Every agent write goes through the gate; a person promotes or rejects it.");
  });

  it("A: the app's v2 metrics keep their id-keyed blocks", () => {
    const html = view("A");
    expect(html).toContain('data-pblock="learning"');
    expect(html).not.toContain("data-pshape=");
  });

  it("C, E, G, H: no product endpoint — the section's own not-connected sentence, no number", () => {
    for (const key of ["C", "E", "G", "H"] as const) {
      const html = view(key);
      expect(html, key).toContain("No product metrics reported yet.");
    }
  });
});
