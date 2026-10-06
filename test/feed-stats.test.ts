/**
 * GET /feed/stats — the Feed aside's "This week" read: per-day counts over the WHOLE
 * window (zero days included), total / distinct people, top tags and authors with
 * deterministic tie order, `days` / `tz` validation, and a failed read that is a 503
 * `{ error }`, never a 500.
 */
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { createSession } from "../src/auth/session";
import { hmacSeal } from "../src/auth/crypto";
import { feedStats, feedStatsWindow } from "../src/tools/feed-stats";
import { seedPerson } from "./helpers/persons";
import type { FeedStats } from "@shared/feed-stats";

async function cookieFor(login: string): Promise<string> {
  await seedPerson(login);
  const { id } = await createSession(env.DB, login);
  return `session=${await hmacSeal(id, "test-cookie-secret")}`;
}

let nextId = 1;
async function entry(author: string, createdAt: string, tags: string[] = []): Promise<number> {
  const id = nextId++;
  await env.DB.prepare(`INSERT INTO feed (id, author, summary, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, author, `entry ${id}`, createdAt).run();
  for (const t of tags) {
    await env.DB.prepare(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES (?, 'feed', ?)`).bind(t, String(id)).run();
  }
  return id;
}

// "Now" for the tool tests: Saturday 2026-09-26, 15:00 UTC.
const NOW = Date.parse("2026-09-26T15:00:00.000Z");

describe("feedStatsWindow", () => {
  it("covers `days` calendar days ending with today, in UTC by default", () => {
    const w = feedStatsWindow(7, 0, NOW);
    expect(w.dates).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26"]);
    expect(w.since).toBe("2026-09-20T00:00:00.000Z");
    expect(w.until).toBe("2026-09-27T00:00:00.000Z");
  });

  it("shifts the day boundaries to the viewer's local days with a tz offset", () => {
    // UTC-5 (tz = -300): 15:00Z is 10:00 local on the 26th; the local day starts at 05:00Z.
    const w = feedStatsWindow(2, -300, NOW);
    expect(w.dates).toEqual(["2026-09-25", "2026-09-26"]);
    expect(w.since).toBe("2026-09-25T05:00:00.000Z");
    expect(w.until).toBe("2026-09-27T05:00:00.000Z");
    // UTC+10 (tz = 600): 15:00Z is 01:00 on the 27th local.
    expect(feedStatsWindow(1, 600, NOW).dates).toEqual(["2026-09-27"]);
  });
});

describe("feedStats", () => {
  it("buckets every day of the window, zero days included, and totals only in-window entries", async () => {
    await entry("kai", "2026-09-26T09:00:00.000Z");
    await entry("kai", "2026-09-26T14:59:00.000Z");
    await entry("mira", "2026-09-24T23:30:00.000Z");
    await entry("mira", "2026-09-20T00:00:00.000Z");          // the window's first instant
    await entry("old", "2026-09-19T23:59:59.999Z");           // one ms before it — out
    const s = await feedStats(systemCtx(), { days: 7, now: NOW });
    expect(s.days).toEqual([
      { date: "2026-09-20", count: 1 }, { date: "2026-09-21", count: 0 }, { date: "2026-09-22", count: 0 },
      { date: "2026-09-23", count: 0 }, { date: "2026-09-24", count: 1 }, { date: "2026-09-25", count: 0 },
      { date: "2026-09-26", count: 2 },
    ]);
    expect(s.total).toBe(4);
    expect(s.people).toBe(2);
    expect(s.topAuthors.map((a) => a.author)).not.toContain("old");
  });

  it("with a tz offset, an entry lands on the viewer's local day", async () => {
    // 2026-09-25T02:00Z is still the 24th in UTC-5.
    await entry("kai", "2026-09-25T02:00:00.000Z");
    const utc = await feedStats(systemCtx(), { days: 7, now: NOW });
    const local = await feedStats(systemCtx(), { days: 7, tzOffsetMin: -300, now: NOW });
    expect(utc.days.find((d) => d.date === "2026-09-25")?.count).toBe(1);
    expect(local.days.find((d) => d.date === "2026-09-24")?.count).toBe(1);
    expect(local.days.find((d) => d.date === "2026-09-25")?.count).toBe(0);
  });

  it("orders top authors by count, ties by handle, at most three", async () => {
    for (const a of ["zed", "zed", "zed", "bo", "bo", "al", "al", "cy"]) await entry(a, "2026-09-25T10:00:00.000Z");
    const s = await feedStats(systemCtx(), { days: 7, now: NOW });
    expect(s.topAuthors).toEqual([{ author: "zed", count: 3 }, { author: "al", count: 2 }, { author: "bo", count: 2 }]);
    expect(s.people).toBe(4);
  });

  it("orders top tags by count, ties by tag, at most four, only feed tags in the window", async () => {
    await entry("kai", "2026-09-25T10:00:00.000Z", ["ui", "api"]);
    await entry("kai", "2026-09-25T11:00:00.000Z", ["ui", "data"]);
    await entry("kai", "2026-09-25T12:00:00.000Z", ["ui", "infra", "auth"]);
    await entry("kai", "2026-09-10T12:00:00.000Z", ["architecture", "auth"]); // out of window
    // A doc tag with the same id is not a feed tag.
    await env.DB.prepare(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES ('architecture', 'doc', '1')`).run();
    const s = await feedStats(systemCtx(), { days: 7, now: NOW });
    expect(s.topTags).toEqual([
      { tag: "ui", count: 3 }, { tag: "api", count: 1 }, { tag: "auth", count: 1 }, { tag: "data", count: 1 },
    ]);
  });

  it("an empty window is all zero days, not an error", async () => {
    const s = await feedStats(systemCtx(), { days: 3, now: NOW });
    expect(s).toEqual({ days: [
      { date: "2026-09-24", count: 0 }, { date: "2026-09-25", count: 0 }, { date: "2026-09-26", count: 0 },
    ], total: 0, people: 0, topTags: [], topAuthors: [] });
  });
});

describe("GET /feed/stats", () => {
  it("needs a session", async () => {
    const res = await app.request("/feed/stats", {}, env);
    expect(res.status).toBe(401);
  });

  it("defaults to 7 days and returns the stats shape", async () => {
    await entry("kai", new Date().toISOString(), ["ui"]);
    const res = await app.request("/feed/stats", { headers: { cookie: await cookieFor("kai") } }, env);
    expect(res.status).toBe(200);
    const body = await res.json() as FeedStats;
    expect(body.days).toHaveLength(7);
    expect(body.days[6]).toEqual({ date: new Date().toISOString().slice(0, 10), count: 1 });
    expect(body).toMatchObject({ total: 1, people: 1, topTags: [{ tag: "ui", count: 1 }], topAuthors: [{ author: "kai", count: 1 }] });
  });

  it("honours days (1 and 30 are the bounds) and tz", async () => {
    const cookie = await cookieFor("kai");
    for (const days of [1, 30]) {
      const res = await app.request(`/feed/stats?days=${days}&tz=-300`, { headers: { cookie } }, env);
      expect(res.status).toBe(200);
      expect(((await res.json()) as FeedStats).days).toHaveLength(days);
    }
  });

  it("refuses a bad days or tz with a 400 { error }", async () => {
    const cookie = await cookieFor("kai");
    for (const q of ["days=0", "days=31", "days=7.5", "days=-1", "days=abc", "days=", "tz=900", "tz=1.5", "tz=x", "tz=-841"]) {
      const res = await app.request(`/feed/stats?${q}`, { headers: { cookie } }, env);
      expect(res.status, q).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBeTruthy();
    }
  });

  it("a failed read is a 503 { error }, never a 500", async () => {
    const cookie = await cookieFor("kai");
    // Sessions resolve first; only the stats statements hit the broken binding.
    const realPrepare = env.DB.prepare.bind(env.DB);
    const DB = new Proxy(env.DB, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (/FROM feed/.test(sql)) throw new Error("D1 is down");
            return realPrepare(sql);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const res = await app.request("/feed/stats", { headers: { cookie } }, { ...env, DB });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Couldn't read the feed stats" });
  });
});
