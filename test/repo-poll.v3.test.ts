/**
 * App metrics contract v3 (docs/superpowers/specs/2026-10-15-app-metrics-v3.md) — the POLL and the PROJECTION.
 *
 * A v3 body describes itself: `version: 3`, the `part` it reports and a `label`, and `groups` with their own ids,
 * labels, SHAPES (ranked / stats / figure / status) and notes; metrics are windowed (`values`) or point-in-time
 * (`value`). Values are stored as v2 stores counts / totals; the description is the environment's `app_metrics:<env>`
 * snapshot. v1 and v2 bodies parse EXACTLY as before. The fetch is stubbed at the Response level; rows are real D1.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all, first } from "./helpers/db";
import { appMetricsV3, pollSaplingMetrics, saplingProductMetrics } from "../src/repo/poll";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS, LONG_TOKEN, leakedFragments } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { ORG_A, systemCtx } from "./helpers/tenant";

const NOW = Date.parse("2026-10-15T12:05:00Z");
const STAGING_URL = "https://api.staging.saplinglearn.com/api/internal/metrics";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const w = (a: number, b: number, c: number) => ({ "24h": a, "7d": b, "30d": c });
const answers = (body: unknown) => (async (u: RequestInfo | URL) => (String(u) === STAGING_URL ? json(body) : new Response("nope", { status: 404 }))) as typeof fetch;
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try { return await fn(); } finally { spy.mockRestore(); }
};
const stored = () => all<{ metric: string; env: string; value: number }>(env.DB,
  `SELECT metric, env, value FROM repo_metrics WHERE org_id = ? AND (metric LIKE 'sap_%' OR metric LIKE 'active_users_%') ORDER BY metric`, ORG_A);
const snapshot = async (envKey = "staging") => {
  const row = await first<{ json: string }>(env.DB, `SELECT json FROM repo_snapshots WHERE org_id = ? AND kind = ?`, ORG_A, `app_metrics:${envKey}`);
  return row ? JSON.parse(row.json) as unknown : null;
};

/** Trov's own body (scenario B's Product block), trimmed. */
const TROV = {
  version: 3, part: "trov", label: "trov",
  groups: [
    { id: "now", label: "Right now", shape: "stats", metrics: [{ key: "people", label: "People", value: 6 }, { key: "live_docs", label: "Live docs", value: 184 }] },
    { id: "mcp_tools", label: "MCP tool calls", shape: "ranked", note: "Counted per UTC day: 24h is today so far.", metrics: [
      { key: "mcp_query", label: "query", values: w(600, 4210, 18000) }, { key: "mcp_get_doc", label: "get_doc", values: w(280, 1930, 8100) },
    ] },
    { id: "gate", label: "Agent writes through the gate", shape: "stats", metrics: [{ key: "gate_staged", label: "Staged", values: w(60, 451, 1900) }] },
    { id: "errors", label: "Errors", shape: "status", metrics: [{ key: "errors_5xx", label: "5xx", values: w(0, 2, 5) }, { key: "errors_4xx", label: "4xx", values: w(10, 70, 300), tone: "neutral" }] },
  ],
};

describe("appMetricsV3 — the validator (pure)", () => {
  it("keeps self-described groups and their metrics; values go to the v2 shapes, the description carries no value", () => {
    const r = appMetricsV3(TROV);
    expect(r.droppedCount).toBe(0);
    expect(r.descriptor).toEqual({
      version: 3, part: "trov", label: "trov",
      groups: [
        { id: "now", label: "Right now", shape: "stats", note: null, window: "now", metrics: [
          { key: "people", label: "People", format: "int", tone: null }, { key: "live_docs", label: "Live docs", format: "int", tone: null }] },
        { id: "mcp_tools", label: "MCP tool calls", shape: "ranked", note: "Counted per UTC day: 24h is today so far.", window: "range", metrics: [
          { key: "mcp_query", label: "query", format: "int", tone: null }, { key: "mcp_get_doc", label: "get_doc", format: "int", tone: null }] },
        { id: "gate", label: "Agent writes through the gate", shape: "stats", note: null, window: "range", metrics: [{ key: "gate_staged", label: "Staged", format: "int", tone: null }] },
        { id: "errors", label: "Errors", shape: "status", note: null, window: "range", metrics: [
          { key: "errors_5xx", label: "5xx", format: "int", tone: null }, { key: "errors_4xx", label: "4xx", format: "int", tone: "neutral" }] },
      ],
    });
    expect({ ...r.counts }).toEqual({
      mcp_query: { h24: 600, d7: 4210, d30: 18000 }, mcp_get_doc: { h24: 280, d7: 1930, d30: 8100 }, gate_staged: { h24: 60, d7: 451, d30: 1900 },
      errors_5xx: { h24: 0, d7: 2, d30: 5 }, errors_4xx: { h24: 10, d7: 70, d30: 300 },
    });
    expect({ ...r.totals }).toEqual({ people: 6, live_docs: 184 });
    expect(JSON.stringify(r.descriptor)).not.toMatch(/4210|184/);
  });

  it("drops a bad group whole and a bad metric alone — by name, never costing the rest", () => {
    const r = appMetricsV3({
      version: 3,
      groups: [
        { id: "Bad Id", label: "x", shape: "stats", metrics: [{ key: "a", label: "A", value: 1 }] },        // id
        { id: "noshape", label: "x", shape: "pie", metrics: [{ key: "b", label: "B", value: 1 }] },         // shape
        { id: "nolabel", label: "", shape: "stats", metrics: [{ key: "c", label: "C", value: 1 }] },        // label
        { id: "ok", label: "Fine", shape: "figure", metrics: [
          { key: "good", label: "Good", values: w(1, 2, 3), format: "cents" },
          { key: "nest", label: "Bad nesting", values: w(5, 2, 3) },
          { key: "mixed", label: "A point in a windowed group", value: 4 },
          { key: "Upper", label: "Bad key", values: w(1, 1, 1) },
          { key: "nolab", label: "\u0000", values: w(1, 1, 1) },
          { key: "float", label: "Float", values: w(1.5, 2, 3) },
        ] },
        { id: "ok", label: "Repeated id", shape: "stats", metrics: [{ key: "d", label: "D", value: 1 }] },
        { id: "dup", label: "Repeats a key", shape: "stats", metrics: [{ key: "good", label: "Good again", value: 1 }] },
        "junk",
      ],
    });
    expect(r.descriptor.groups.map((g) => [g.id, g.metrics.map((m) => [m.key, m.format])])).toEqual([["ok", [["good", "cents"]]]]);
    expect(r.dropped).toEqual([
      "groups.0", "groups.noshape", "groups.nolabel", "groups.ok.nest", "groups.ok.mixed", "groups.ok.Upper", "groups.ok.nolab", "groups.ok.float",
      "groups.ok", "groups.dup.good", "groups.dup", "groups.6",
    ]);
  });

  it("holds the body's caps: 12 groups, 24 metrics a group, 48 windowed and 24 point keys counting what v2 kept", () => {
    const many = { version: 3, groups: Array.from({ length: 14 }, (_, i) => ({ id: `g${i}`, label: `G${i}`, shape: "stats", metrics: [{ key: `k${i}`, label: "K", value: i }] })) };
    expect(appMetricsV3(many).descriptor.groups).toHaveLength(12);
    const wide = { version: 3, groups: [{ id: "g", label: "G", shape: "ranked", metrics: Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, label: "K", values: w(1, 1, 1) })) }] };
    expect(appMetricsV3(wide).descriptor.groups[0].metrics).toHaveLength(24);
    expect(appMetricsV3(wide, undefined, { counts: 40, totals: 0, keys: new Set() }).descriptor.groups[0].metrics).toHaveLength(8);
  });

  it("scrubs a rejected name before it is cut", () => {
    const r = appMetricsV3({ version: 3, groups: [{ id: "g", label: "G", shape: "stats", metrics: [{ key: LONG_TOKEN, label: "x", value: 1 }] }] }, (s) => s.split(LONG_TOKEN).join("[redacted]"));
    expect(leakedFragments(r.dropped.join(" "), LONG_TOKEN)).toEqual([]);
  });

  it("v1 and v2 bodies still parse exactly as before (the v2 validator ignores `version` and `groups`)", () => {
    const v2 = { active_users: w(6, 9, 9), counts: { signups: w(3, 21, 96) }, totals: { users: 1204 } };
    const p = saplingProductMetrics(v2);
    expect({ counts: { ...p.counts }, totals: { ...p.totals }, droppedCount: p.droppedCount }).toEqual({ counts: { signups: { h24: 3, d7: 21, d30: 96 } }, totals: { users: 1204 }, droppedCount: 0 });
    const withV3 = saplingProductMetrics({ ...v2, version: 3, groups: TROV.groups });
    expect({ ...withV3.counts }).toEqual({ signups: { h24: 3, d7: 21, d30: 96 } });
  });
});

describe("pollSaplingMetrics — v1, v2 and v3 bodies", () => {
  it("a v1 body is a plain success, as before, and leaves no description", async () => {
    const out = await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW, answers({ active_users: w(6, 9, 9) })));
    expect(out).toEqual([{ env: "staging", status: "ok", written: 3 }]);
    expect(await snapshot()).toBeNull();
  });

  it("a v2 body without active_users still fails as before (the core half is required below v3)", async () => {
    const out = await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW, answers({ counts: { signups: w(1, 2, 3) } })));
    expect(out[0].status).toBe("failed");
    expect(out[0].written).toBe(3);
  });

  it("a v3 body may leave active_users out: its values land as sap_* gauges and its description as the snapshot", async () => {
    const out = await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW, answers(TROV)));
    expect(out).toEqual([{ env: "staging", status: "ok", written: 17 }]);
    const rows = await stored();
    expect(rows.find((r) => r.metric === "sap_t_people")?.value).toBe(6);
    expect(rows.find((r) => r.metric === "sap_c_mcp_query_7d")?.value).toBe(4210);
    expect(rows.some((r) => r.metric.startsWith("active_users_"))).toBe(false);
    expect(await snapshot()).toMatchObject({ version: 3, part: "trov", label: "trov", groups: [{ id: "now" }, { id: "mcp_tools" }, { id: "gate" }, { id: "errors" }] });
  });

  it("a v3 body WITH a bad active_users still reads failed, its groups stored anyway; a dropped metric is named in the outcome", async () => {
    const body = { ...TROV, active_users: w(9, 6, 3), groups: [...TROV.groups, { id: "x", label: "X", shape: "stats", metrics: [{ key: "bad", label: "Bad", value: -1 }] }] };
    const out = await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW, answers(body)));
    expect(out[0].status).toBe("failed");
    expect(out[0].detail).toContain("groups.x.bad");
    expect((await stored()).find((r) => r.metric === "sap_t_people")?.value).toBe(6);
  });

  it("a producer that goes back to v2 loses its v3 description", async () => {
    await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW, answers(TROV)));
    await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW + 3_600_000, answers({ active_users: w(1, 1, 1) })));
    expect(await snapshot()).toBeNull();
  });
});

describe("the product section draws v3 groups by their shape", () => {
  it("v3 groups first, in the body's order, with their shapes, notes and tones; a point-in-time group is `now`; the rest as v2 groups them", async () => {
    await setOrgEnvironments([ENVS[0]], ORG_A);
    const body = { ...TROV, counts: { signups: w(3, 21, 96) } };
    await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[0]], NOW, answers(body)));
    const dash = await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, [ENVS[0]]);
    expect(dash.product.status).toBe("ok");
    const envs = dash.product.status === "ok" ? dash.product.data : [];
    const e = envs[0];
    expect(e).toMatchObject({ name: "staging", version: 3, part: "trov", label: "trov", totals: [] });
    expect(e.groups.map((g) => [g.id, g.title, g.shape ?? null, g.now ?? false])).toEqual([
      ["now", "Right now", "stats", true], ["mcp_tools", "MCP tool calls", "ranked", false], ["gate", "Agent writes through the gate", "stats", false],
      ["errors", "Errors", "status", false], ["growth", "Growth", null, false],
    ]);
    expect(e.groups[0].metrics.map((m) => [m.label, m.values["24h"], m.values["30d"]])).toEqual([["People", "6", "6"], ["Live docs", "184", "184"]]);
    expect(e.groups[1].note).toBe("Counted per UTC day: 24h is today so far.");
    expect(e.groups[1].metrics.map((m) => [m.label, m.values["7d"]])).toEqual([["query", "4.2K"], ["get_doc", "1.9K"]]);
    expect(e.groups[3].metrics.map((m) => [m.key, m.tone ?? null])).toEqual([["errors_5xx", null], ["errors_4xx", "neutral"]]);
  });

  it("a v2 environment beside it draws exactly as before — no shape, no version", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await quiet(() => pollSaplingMetrics(systemCtx(ORG_A), LONG_TOKEN, [ENVS[1]], NOW, (async () => json({ active_users: w(1, 2, 3), counts: { signups: w(3, 21, 96) } })) as typeof fetch));
    const dash = await getRepoDashboard(systemCtx(ORG_A), "o/r", NOW, ENVS);
    const envs = dash.product.status === "ok" ? dash.product.data : [];
    const prod = envs.find((x) => x.name === "production")!;
    expect("version" in prod).toBe(false);
    expect(prod.groups.map((g) => [g.id, "shape" in g])).toEqual([["growth", false]]);
  });
});
