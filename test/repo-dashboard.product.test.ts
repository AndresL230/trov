/**
 * Product metrics (contract v2) — the PROJECTION side.
 *
 * `getRepoDashboard`'s `product` section, read back from the `sap_c_*` /
 * `sap_t_*` gauges `pollSaplingMetrics` stores: per environment, `counts`
 * grouped (Growth / Learning activity / … / Other) with one figure per range,
 * `totals` on their own. Never guessed: a figure shows only while its latest
 * reading is ≤ 3 hours old; the trend is the 00:00 UTC readings of the last 30
 * days and a missed midnight is simply absent. Every assertion is on the
 * projection built from real D1 rows.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { pollSaplingMetrics } from "../src/repo/poll";
import { putMetrics } from "../src/repo/store";
import { productKeyInfo } from "../src/repo/product";
import { getRepoDashboard, emptyRepoDashboard } from "../src/tools/repo";
import type { RepoProductEnv } from "@shared/repo";
import { ENVS } from "./helpers/repo";

import { systemCtx } from "./helpers/tenant";
const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AT = Date.parse("2026-09-20T12:00:00Z");
const MIDNIGHT = Date.parse("2026-09-20T00:00:00Z");

const iso = (ms: number) => new Date(ms).toISOString();
type Row = [metric: string, env: string, at: number, value: number];
const seed = (rows: Row[]) => putMetrics(systemCtx(), rows.map(([metric, envKey, at, value]) => ({ metric, env: envKey, part: "", value, at: iso(at) })));
const count = (key: string, envKey: string, at: number, h24: number, d7: number, d30: number): Row[] =>
  [[`sap_c_${key}_24h`, envKey, at, h24], [`sap_c_${key}_7d`, envKey, at, d7], [`sap_c_${key}_30d`, envKey, at, d30]];
const product = async (now = NOW): Promise<RepoProductEnv[]> => {
  const s = (await getRepoDashboard(systemCtx(), "o/r", now, ENVS)).product;
  expect(s.status).toBe("ok");
  return (s as { data: RepoProductEnv[] }).data;
};
const metricOf = (e: RepoProductEnv, key: string) => e.groups.flatMap((g) => g.metrics).find((m) => m.key === key);

describe("getRepoDashboard — product metrics", () => {
  it("never reported → not_connected; an empty dashboard says the same", async () => {
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).product).toEqual({ status: "not_connected" });
    expect(emptyRepoDashboard("o/r", true).product).toEqual({ status: "not_connected" });
    // …and active users alone are not product metrics.
    await seed([["active_users_24h", "staging", AT, 74]]);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).product).toEqual({ status: "not_connected" });
  });

  it("no environment configured → not_connected, whatever is stored", async () => {
    await seed(count("signups", "staging", AT, 3, 21, 96));
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, [])).product).toEqual({ status: "not_connected" });
  });

  it("fresh readings: each range picks ITS OWN window, totals ignore the range, per environment", async () => {
    await seed([
      ...count("signups", "staging", AT, 3, 21, 96),
      ...count("signups", "production", AT, 1, 2, 1204),
      ["sap_t_users", "staging", AT, 1204],
      ["sap_t_users_pending", "staging", AT, 7],
    ]);
    const [staging, production] = await product();
    expect(staging.name).toBe("staging");
    expect(staging.groups).toEqual([{ id: "growth", title: "Growth", metrics: [
      { key: "signups", label: "Signups", values: { "24h": "3", "7d": "21", "30d": "96" }, raw: { "24h": 3, "7d": 21, "30d": 96 }, trend: [] },
    ] }]);
    expect(staging.totals).toEqual([
      { key: "users", label: "Users", value: "1.2K", raw: 1204, trend: [] },
      { key: "users_pending", label: "Users pending", value: "7", raw: 7, trend: [] },
    ]);
    expect(metricOf(production, "signups")?.values).toEqual({ "24h": "1", "7d": "2", "30d": "1.2K" });
    expect(production.totals).toEqual([]);
  });

  it("a second environment with nothing reported is still listed — with nothing in it", async () => {
    await seed(count("signups", "staging", AT, 3, 21, 96));
    const envs = await product();
    expect(envs.map((e) => e.name)).toEqual(["staging", "production"]);
    expect(envs[1]).toEqual({ name: "production", groups: [], totals: [] });
  });

  it("groups and orders known keys as the contract does; an unknown key lands in Other with a humanised label", async () => {
    await seed([
      ...count("zeta_thing", "staging", AT, 1, 1, 1), ...count("errors_5xx", "staging", AT, 1, 1, 1), ...count("llm_calls", "staging", AT, 1, 1, 1),
      ...count("room_messages", "staging", AT, 1, 1, 1), ...count("chat_messages", "staging", AT, 1, 1, 1), ...count("tutor_sessions", "staging", AT, 1, 1, 1),
      ...count("approvals", "staging", AT, 1, 1, 1), ...count("signups", "staging", AT, 1, 1, 1), ...count("alpha_2_beta", "staging", AT, 1, 1, 1),
      ...count("constructor", "staging", AT, 1, 1, 1),
      ["sap_t_mystery_total", "staging", AT, 4], ["sap_t_rooms", "staging", AT, 5], ["sap_t_users", "staging", AT, 6],
    ]);
    const [staging] = await product();
    expect(staging.groups.map((g) => [g.title, g.metrics.map((m) => m.label)])).toEqual([
      ["Growth", ["Signups", "Approvals"]],
      ["Learning activity", ["Tutor sessions", "Chat messages"]],
      ["Community", ["Room messages"]],
      ["AI spend", ["LLM calls"]],
      ["Reliability", ["5xx errors"]],
      ["Other", ["Alpha 2 beta", "Constructor", "Zeta thing"]],
    ]);
    expect(staging.totals.map((t) => t.label)).toEqual(["Users", "Rooms", "Mystery total"]);
  });

  // What Sapling actually serves (SaplingLearn/Sapling#654): `study_guides` is
  // omitted (that table is a cache), three keys are new, and two labels / two
  // notes say what the number really is.
  describe("the registry matches what Sapling serves", () => {
    it.each([
      ["logins", "growth", "Logins", undefined],
      ["quiz_context_write_failed", "reliability", "Quiz context write failed", undefined],
      ["rag_visibility_resync_failed", "reliability", "RAG visibility resync failed", undefined],
      ["rag_chunks_dropped", "reliability", "RAG runs that dropped chunks", undefined], // it counts RUNS, not chunks
      ["flashcards_created", "learning", "Flashcards created", "lower bound — deleted cards are not counted"],
      ["errors_4xx", "reliability", "4xx errors", "includes bot traffic and refused polls"],
      ["llm_cost_cents", "ai", "LLM cost", "lower bound — unpriced models are not counted"],
    ])("%s → %s / %j", (key, group, label, note) => {
      const info = productKeyInfo(key);
      expect(info).toMatchObject({ group, label, format: key === "llm_cost_cents" ? "cents" : "int" });
      expect(info.note).toBe(note);
    });

    it("`study_guides` is no longer a known key — it would still be shown, under Other", () => {
      expect(productKeyInfo("study_guides")).toEqual({ group: "other", label: "Study guides", format: "int" });
    });

    it("the new keys sit in their groups, in order, with their notes — two notes in one group both travel", async () => {
      await seed(["signups", "approvals", "logins", "flashcards_created", "study_guides", "errors_5xx", "errors_4xx", "quiz_generation_failed",
        "quiz_context_write_failed", "rag_retrieval_failed", "rag_visibility_resync_failed", "rag_chunks_dropped"].flatMap((k) => count(k, "staging", AT, 1, 2, 3)));
      const [staging] = await product();
      expect(staging.groups.map((g) => [g.title, g.metrics.map((m) => m.label)])).toEqual([
        ["Growth", ["Signups", "Approvals", "Logins"]],
        ["Learning activity", ["Flashcards created"]],
        ["Reliability", ["5xx errors", "4xx errors", "Quiz generation failed", "Quiz context write failed", "RAG retrieval failed", "RAG visibility resync failed", "RAG runs that dropped chunks"]],
        ["Other", ["Study guides"]],
      ]);
      expect(metricOf(staging, "flashcards_created")?.note).toBe("lower bound — deleted cards are not counted");
      expect(metricOf(staging, "errors_4xx")?.note).toBe("includes bot traffic and refused polls");
      expect(metricOf(staging, "logins")).not.toHaveProperty("note");
    });
  });

  it("llm_cost_cents reads as dollars with its lower-bound note; llm_tokens is compact", async () => {
    await seed([...count("llm_cost_cents", "staging", AT, 412, 2961, 11830), ...count("llm_tokens", "staging", AT, 900, 1_234_000, 2_500_000_000)]);
    const [staging] = await product();
    expect(metricOf(staging, "llm_cost_cents")).toMatchObject({
      label: "LLM cost", values: { "24h": "$4.12", "7d": "$29.61", "30d": "$118.30" }, raw: { "24h": 412, "7d": 2961, "30d": 11830 },
      note: "lower bound — unpriced models are not counted",
    });
    expect(metricOf(staging, "llm_tokens")?.values).toEqual({ "24h": "900", "7d": "1.23M", "30d": "2.50B" });
    expect(metricOf(staging, "llm_tokens")).not.toHaveProperty("note");
    // From $10K up the cents are dropped — the figure stays short.
    await env.DB.prepare(`DELETE FROM repo_metrics`).run();
    await seed(count("llm_cost_cents", "staging", AT, 999_999, 1_234_567, 250_000_000));
    expect(metricOf((await product())[0], "llm_cost_cents")?.values).toEqual({ "24h": "$9,999.99", "7d": "$12.3K", "30d": "$2.50M" });
  });

  it("a reading exactly 3 hours old still shows; one older than that reads null — the key stays listed", async () => {
    await seed([
      ...count("signups", "staging", MIDNIGHT, 3, 21, 96), ["sap_t_users", "staging", MIDNIGHT, 1204],
      ...count("approvals", "staging", AT, 1, 2, 3), // keeps the section ok throughout
    ]);
    const at = async (now: number) => { const [s] = await product(now); return [metricOf(s, "signups")?.values, s.totals[0]]; };
    expect(await at(MIDNIGHT + 3 * HOUR)).toEqual([{ "24h": "3", "7d": "21", "30d": "96" }, { key: "users", label: "Users", value: "1.2K", raw: 1204, trend: [1204] }]);
    const [values, total] = await at(NOW); // 12h05 later
    expect(values).toEqual({ "24h": null, "7d": null, "30d": null });
    expect(total).toMatchObject({ key: "users", value: null, raw: null });
  });

  it("a reading stamped ahead of the clock is not a current one", async () => {
    await seed([...count("signups", "staging", AT + 2 * HOUR, 9, 9, 9), ...count("approvals", "staging", AT, 1, 2, 3)]);
    const [staging] = await product();
    expect(metricOf(staging, "signups")).toBeUndefined();
    expect(metricOf(staging, "approvals")?.values["24h"]).toBe("1");
  });

  it("only stale readings → empty (the poll has gone quiet); aged out of the read entirely → still empty", async () => {
    await seed(count("signups", "staging", MIDNIGHT, 3, 21, 96));
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).product).toEqual({ status: "empty" });
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW + 60 * DAY, ENVS)).product).toEqual({ status: "empty" });
  });

  it("the trend is the 00:00 UTC `24h` readings of the last 30 days, oldest first — a missed midnight is absent, never zero", async () => {
    const days = [40, 29, 5, 3, 2, 0]; // midnights, as days before today's — 4 and 1 were missed, 40 is past the window
    await seed([
      ...days.flatMap((d) => count("signups", "staging", MIDNIGHT - d * DAY, 100 + d, 500, 900)),
      ...days.map((d): Row => ["sap_t_users", "staging", MIDNIGHT - d * DAY, 1000 - d]),
      ...count("signups", "staging", MIDNIGHT - 2 * DAY + HOUR, 7, 500, 900), // an hourly row is not a daily total
      ...count("signups", "staging", AT, 3, 21, 96),
      ["sap_t_users", "staging", AT, 1204],
    ]);
    const [staging] = await product();
    const signups = metricOf(staging, "signups")!;
    expect(signups.trend).toEqual([129, 105, 103, 102, 100]);
    expect(signups.values).toEqual({ "24h": "3", "7d": "21", "30d": "96" }); // ONE trend, whatever the range
    expect(staging.totals[0].trend).toEqual([971, 995, 997, 998, 1000]);
  });

  it("a `REPO_ENVIRONMENTS` key listed twice does not double a trend", async () => {
    await seed([
      ...[3, 2, 1, 0].flatMap((d) => count("signups", "staging", MIDNIGHT - d * DAY, 10 + d, 500, 900)),
      ...[3, 2, 1, 0].map((d): Row => ["sap_t_users", "staging", MIDNIGHT - d * DAY, 1000 - d]),
      ...count("signups", "staging", AT, 3, 21, 96), ["sap_t_users", "staging", AT, 1204],
    ]);
    // a copy-paste while adding a third environment: two entries, one key
    const s = (await getRepoDashboard(systemCtx(), "o/r", NOW, [ENVS[0], { ...ENVS[0], label: "staging (copy)" }, ENVS[1]])).product;
    const data = (s as { data: RepoProductEnv[] }).data;
    const staging = data.find((e) => e.name === "staging")!;
    expect(metricOf(staging, "signups")?.trend).toEqual([13, 12, 11, 10]);
    expect(staging.totals[0].trend).toEqual([997, 998, 999, 1000]);
  });

  it("fewer than two midnights is a short trend the screen will not draw", async () => {
    await seed([...count("signups", "staging", MIDNIGHT, 5, 21, 96), ...count("signups", "staging", AT, 3, 21, 96)]);
    expect(metricOf((await product())[0], "signups")?.trend).toEqual([5]);
  });

  it("a row for an unconfigured environment, with a part, or with a malformed name is nobody's product metric", async () => {
    await seed([...count("signups", "elsewhere", AT, 3, 21, 96), ["sap_c_signups", "staging", AT, 1], ["sap_x_users", "staging", AT, 1], ["sap_t_", "staging", AT, 1]]);
    await putMetrics(systemCtx(), [{ metric: "sap_t_users", env: "staging", part: "backend", value: 1, at: iso(AT) }]);
    // Rows HAVE landed, so the section is `empty`, not `not_connected` — but nothing is shown.
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).product).toEqual({ status: "empty" });
  });

  it("the product section never changes the usage / hosting sections' states, nor they its own", async () => {
    await seed(count("signups", "staging", AT, 3, 21, 96));
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect([d.usage.status, d.cloudflare.status, d.hosting.status, d.product.status]).toEqual(["not_connected", "not_connected", "not_connected", "ok"]);
    await env.DB.prepare(`DELETE FROM repo_metrics`).run();
    await seed([["active_users_24h", "staging", AT, 74], ["rw_cpu", "staging", AT - 9 * HOUR, 1]]);
    const e = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect([e.usage.status, e.cloudflare.status, e.hosting.status, e.product.status]).toEqual(["ok", "not_connected", "empty", "not_connected"]);
  });

  it("the render adds exactly ONE statement for product metrics — and none beyond the shared existence check when it is quiet", async () => {
    const countStatements = async () => {
      const spy = vi.spyOn(env.DB, "prepare");
      try { await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS); return spy.mock.calls.map((c) => String(c[0])); } finally { spy.mockRestore(); }
    };
    const quiet = await countStatements();
    expect(quiet.filter((q) => q.includes("names(m)"))).toHaveLength(1);
    await seed([...count("signups", "staging", AT, 3, 21, 96), ["sap_t_users", "staging", AT, 1204]]);
    const live = await countStatements();
    expect(live.length).toBe(quiet.length); // same statements, product ok or not
    expect(live.filter((q) => q.includes("names(m)"))).toHaveLength(1);
  });

  it("what the poller writes is what the screen reads", async () => {
    const body = { active_users: { "24h": 6, "7d": 9, "30d": 9 }, counts: { signups: { "24h": 3, "7d": 21, "30d": 96 }, new_thing: { "24h": 1, "7d": 1, "30d": 2 } }, totals: { users: 1204 } };
    await pollSaplingMetrics(systemCtx(), "s3cret", [ENVS[0]], NOW, (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch);
    const [staging] = await product();
    expect(staging.groups.map((g) => [g.id, g.metrics.map((m) => [m.key, m.values["7d"]])])).toEqual([["growth", [["signups", "21"]]], ["other", [["new_thing", "1"]]]]);
    expect(staging.totals.map((t) => [t.key, t.value])).toEqual([["users", "1.2K"]]);
  });
});
