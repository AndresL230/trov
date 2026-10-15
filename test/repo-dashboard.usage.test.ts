/**
 * The Usage tab's per-environment compare (`getRepoDashboard` → `usage`, src/tools/repo.ts `projectUsage`):
 * requests and error rate summed over each environment's WEB parts — their hourly `hx_requests` /
 * `hx_errors`, whoever hosts them — with each part's covered interval from its last poll
 * (`hosting_poll_state`), beside the app's `active_users_*` gauges. D1 only.
 *
 * Never guess: a provider returns no row for a quiet hour, so a missing hour is drawn as 0 only where a poll
 * is known to have looked (the part's covered interval, or between real points); before capture began, past
 * the covered end, or across a hole it is unknown — and a metric with nothing known is null, never "0".
 */
import { describe, it, expect } from "vitest";
import { putMetric } from "../src/repo/store";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS } from "./helpers/repo";
import { setOrgEnvironments } from "./helpers/org-config";
import { addPart, hxPoint, pollState } from "./helpers/dashboard-hosting";
import { ORG_A, systemCtx } from "./helpers/tenant";

const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };
/** The start of the hour `h` complete hours before NOW's own (12:00): h=1 → 11:00. */
const hoursBack = (h: number) => new Date(Date.parse("2026-09-20T12:00:00Z") - h * HOUR).toISOString();
const dash = () => getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);

/** Each environment's Cloudflare Workers frontend — a web part like any other. */
async function frontends(): Promise<void> {
  await setOrgEnvironments(ENVS, ORG_A);
  for (const e of ["staging", "production"]) await addPart(ORG_A, e, "frontend", "cloudflare", "web", { worker: `frontend-${e}` }, 0, "Frontend");
}
const point = async (envKey: string, at: string, requests: number, errors: number, part = "frontend") => {
  await hxPoint("requests", envKey, part, at, requests);
  await hxPoint("errors", envKey, part, at, errors);
};
/** The part's polls have looked at `[from, to)`. */
const cover = (envKey: string, from: string, to: string, part = "frontend", provider = "cloudflare") =>
  pollState(ORG_A, envKey, part, provider, NOW, { covered: [from, to] });

describe("usage — requests and error rate from the web parts' hx_* points", () => {
  it("nothing captured → not_connected (with or without parts)", async () => {
    expect((await dash()).usage.status).toBe("not_connected");
    await frontends();
    expect((await dash()).usage.status).toBe("not_connected");
  });

  it("sums requests, derives the error rate, and leaves active users unconnected", async () => {
    await frontends();
    await point("staging", hoursBack(3), 1000, 30);
    await point("staging", hoursBack(1), 500, 0);
    const [staging, production] = ok((await dash()).usage)["24h"];
    expect(staging).toMatchObject({ name: "staging", host: "staging.saplinglearn.com", users: null });
    expect(staging.requests).toMatchObject({ value: "1.5K", tone: "neutral" });
    expect(staging.errorRate).toMatchObject({ value: "2.00%", tone: "warn" });
    // Never guess: production has no point in ANY range — null, not "0".
    expect(production).toMatchObject({ name: "production", requests: null, errorRate: null, users: null });
  });

  it("sums EVERY web part of the environment, whoever hosts it; a service part, or a part of another environment, never counts", async () => {
    await frontends();
    await addPart(ORG_A, "staging", "web", "render", "web", {}, 1);
    await addPart(ORG_A, "staging", "api", "render", "service", {}, 2);
    await point("staging", hoursBack(2), 100, 1);
    await cover("staging", hoursBack(2), hoursBack(0));
    await point("staging", hoursBack(2), 50, 0, "web");
    await point("staging", hoursBack(1), 30, 3, "web");
    await point("staging", hoursBack(1), 999, 999, "api");          // a service's series is not traffic
    await point("staging", hoursBack(1), 777, 7, "nowhere");        // no such part
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests).toEqual({ value: "180", trend: [150, 30], tone: "neutral" });
    expect(staging.errorRate).toMatchObject({ value: "2.22%", tone: "warn" });
    expect(staging.errorRate!.trend.map((v) => Math.round(v * 100) / 100)).toEqual([0.67, 10]);
  });

  it("the trend is drawn only where EVERY summed part is known; the totals keep every real point", async () => {
    await frontends();
    await addPart(ORG_A, "staging", "web", "render", "web", {}, 1);
    await point("staging", hoursBack(5), 100, 0);
    await cover("staging", hoursBack(5), hoursBack(1));                // the frontend: known 07:00–11:00
    await point("staging", hoursBack(2), 40, 0, "web");               // the web part: known from 10:00 only
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests).toEqual({ value: "140", trend: [40], tone: "neutral" });
  });

  it("a web part whose provider reads no requests (Vercel) adds nothing — its covered interval is no zero", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await addPart(ORG_A, "staging", "web", "vercel", "web");
    await cover("staging", hoursBack(4), hoursBack(1), "web", "vercel");
    expect((await dash()).usage.status).toBe("not_connected");
    await addPart(ORG_A, "staging", "frontend", "cloudflare", "web", {}, 1);
    await point("staging", hoursBack(2), 60, 0);
    expect(ok((await dash()).usage)["24h"][0].requests).toEqual({ value: "60", trend: [60], tone: "neutral" });
  });

  it("errors a counted part cannot read leave the error rate unknown — requests still show", async () => {
    await setOrgEnvironments(ENVS, ORG_A);
    await addPart(ORG_A, "staging", "web", "render", "web");
    await pollState(ORG_A, "staging", "web", "render", NOW, { covered: [hoursBack(3), hoursBack(1)], unavailable: [{ metric: "errors", reason: "web services only" }] });
    await hxPoint("requests", "staging", "web", hoursBack(2), 80);
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging).toMatchObject({ requests: { value: "80" }, errorRate: null });
  });

  // A quiet hour has NO row, so the series is zero-filled — but only from the first captured point: before
  // capture began the value is unknown, not zero.
  it("zero-fills a quiet hour between captured ones, and nothing before capture began", async () => {
    await frontends();
    await point("staging", hoursBack(4), 100, 10);
    await point("staging", hoursBack(1), 300, 0);
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests?.trend).toEqual([100, 0, 0, 300]);
    expect(staging.errorRate?.trend).toEqual([10, 0, 0, 0]);
  });

  it("a range is filled from its start once capture is known to predate it", async () => {
    await frontends();
    await point("staging", hoursBack(30), 50, 0); // outside 24h, inside 7d
    await point("staging", hoursBack(1), 300, 0);
    const usage = ok((await dash()).usage);
    const day = usage["24h"][0].requests;
    expect(day?.trend).toHaveLength(24);
    expect(day?.trend.slice(-2)).toEqual([0, 300]);
    expect(day?.value).toBe("300");
    // 7d: 24-hour buckets ending at the last complete hour. Capture began 30h back — MID-bucket — so that
    // bucket holds 6 captured hours, not 24, and is not drawn as a day; the total still counts its point.
    expect(usage["7d"][0].requests).toMatchObject({ value: "350", trend: [300] });
  });

  it("an environment with points in 7d but none in 24h is null for 24h only", async () => {
    await frontends();
    await point("production", hoursBack(40), 2_500_000, 100);
    const usage = ok((await dash()).usage);
    expect(usage["24h"][1]).toMatchObject({ name: "production", requests: null, errorRate: null });
    expect(usage["7d"][1].requests).toMatchObject({ value: "2.50M" });
    expect(usage["7d"][1].errorRate).toMatchObject({ value: "0.00%", tone: "good" });
  });

  it("captured hours with zero requests read 0 and a true 0.00%, never a division by zero", async () => {
    await frontends();
    await point("staging", hoursBack(1), 0, 0);
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "0" });
    expect(staging.errorRate).toMatchObject({ value: "0.00%", tone: "good", trend: [0] });
  });

  it("never reads the current, incomplete hour even if a row for it exists", async () => {
    await frontends();
    await point("staging", hoursBack(1), 300, 0);
    await point("staging", hoursBack(0), 9999, 0);
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "300", trend: [300] });
  });

  it("rows that all aged out of the 30-day read → empty, not not_connected", async () => {
    await frontends();
    await point("staging", hoursBack(31 * 24), 100, 0);
    expect((await dash()).usage.status).toBe("empty");
  });

  it("no environment configured → not_connected whatever is stored", async () => {
    await frontends();
    await point("staging", hoursBack(1), 300, 0);
    expect((await getRepoDashboard(systemCtx(), "o/r", NOW, [])).usage.status).toBe("not_connected");
  });

  // ── zeros are drawn only as far as a poll is known to have looked ──────────
  it("zero-fills past the last real point up to the covered end — and no further", async () => {
    await frontends();
    await point("staging", hoursBack(5), 100, 10);
    await point("staging", hoursBack(3), 300, 0);
    await point("production", hoursBack(5), 70, 0);
    await cover("staging", hoursBack(5), hoursBack(1)); // staging only: coverage never leaks to another environment
    const [staging, production] = ok((await dash()).usage)["24h"];
    // 07:00, 08:00, 09:00, 10:00. The 11:00 bucket (hoursBack(1)) is NOT drawn: no poll has looked at it yet.
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300, 0], tone: "neutral" });
    expect(staging.errorRate).toEqual({ value: "2.50%", trend: [10, 0, 0, 0], tone: "warn" });
    expect(production.requests).toEqual({ value: "70", trend: [70], tone: "neutral" });
  });

  it("with NO covered interval the trend ends at the last real point", async () => {
    await frontends();
    await point("staging", hoursBack(5), 100, 10);
    await point("staging", hoursBack(3), 300, 0);
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300], tone: "neutral" });
    expect(staging.errorRate?.trend).toEqual([10, 0, 0]);
  });

  // The poll died three days ago: nothing after its covered end is known to be zero.
  it("a covered interval that ended days ago draws no zeros after it", async () => {
    await frontends();
    await point("staging", hoursBack(100), 50, 0);
    await cover("staging", hoursBack(100), hoursBack(72));
    const usage = ok((await dash()).usage);
    // 7d = seven 24h buckets ending at 12:00. The point sits in bucket 2 — the PARTIAL bucket coverage
    // began in, so it is counted but not drawn; the last polled hour is in bucket 3. Buckets 4–6 are unknown.
    expect(usage["7d"][0].requests).toEqual({ value: "50", trend: [0], tone: "neutral" });
    // 24h: capture predates the range, but no poll has looked inside it.
    expect(usage["24h"][0]).toMatchObject({ requests: null, errorRate: null });
  });

  it("a covered end older than the last real point never truncates real points", async () => {
    await frontends();
    await point("staging", hoursBack(5), 100, 0);
    await point("staging", hoursBack(3), 300, 0);
    await cover("staging", hoursBack(12), hoursBack(10));
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests?.value).toBe("400");
    expect(staging.requests?.trend.slice(-3)).toEqual([100, 0, 300]);
  });

  it("a range with no real point, but covered and captured before it, reads a true 0 — and no error rate", async () => {
    await frontends();
    await point("staging", hoursBack(30), 50, 5); // outside 24h, inside 7d
    await cover("staging", hoursBack(30), hoursBack(1));
    const usage = ok((await dash()).usage);
    const day = usage["24h"][0];
    // 23 buckets, not 24: the range's last hour (11:00) has not been polled yet.
    expect(day.requests).toEqual({ value: "0", trend: new Array(23).fill(0), tone: "neutral" });
    expect(day.errorRate).toBeNull(); // 0 of 0 is not a rate
    // 7d: the point sits in bucket 5 — the partial bucket capture began in, counted but not drawn — and the
    // last polled hour in bucket 6.
    expect(usage["7d"][0].requests).toEqual({ value: "50", trend: [0], tone: "neutral" });
    expect(usage["7d"][0].errorRate).toMatchObject({ value: "10.00%", trend: [0] });
  });

  it("a covered interval alone — polled, nothing ever stored — is a KNOWN zero (the provider's contract), with no error rate", async () => {
    await frontends();
    await cover("staging", hoursBack(4), hoursBack(1));
    const [staging, production] = ok((await dash()).usage)["24h"];
    expect(staging).toMatchObject({ requests: { value: "0", trend: [0, 0, 0] }, errorRate: null, seen: { requests: false } });
    expect(production).toMatchObject({ requests: null, errorRate: null });
  });

  it("a covered end ahead of the clock fills only to the last complete hour; an unparseable one is no interval", async () => {
    await frontends();
    await point("staging", hoursBack(3), 300, 0);
    await point("production", hoursBack(3), 300, 0);
    await cover("staging", hoursBack(3), hoursBack(-5));
    await cover("production", hoursBack(3), "not a date");
    const [staging, production] = ok((await dash()).usage)["24h"];
    expect(staging.requests?.trend).toEqual([300, 0, 0]);
    expect(production.requests?.trend).toEqual([300]);
  });

  // ── a hole in the coverage is never drawn as quiet hours ───────────────────
  it("30d: a poll outage is NOT zero-filled — the trend is the contiguous covered stretch, totals keep every real point", async () => {
    await frontends();
    // 30d = thirty 24h buckets from hoursBack(720); bucket k starts at hoursBack(720 − 24k).
    for (let k = 5; k <= 10; k++) await point("staging", hoursBack(720 - 24 * k), 100, 0); // before the outage
    await point("staging", hoursBack(395), 7, 0);   // bucket 13 — the PARTIAL bucket the polls resumed in
    await point("staging", hoursBack(380), 50, 0);  // bucket 14; bucket 15 is a genuinely quiet, POLLED day
    for (let k = 16; k <= 29; k++) await point("staging", hoursBack(720 - 24 * k - 4), 50, 0);
    await cover("staging", hoursBack(400), hoursBack(1)); // buckets 11–12 were never looked at
    const month = ok((await dash()).usage)["30d"][0].requests;
    expect(month?.trend).toEqual([50, 0, ...new Array(14).fill(50)]); // buckets 14–29: no outage zeros
    expect(month?.value).toBe("1.4K"); // 600 + 7 + 50 + 700 — every real point is a fact
  });

  it("24h: real points before a hole still count, and only the covered stretch is drawn", async () => {
    await frontends();
    await point("staging", hoursBack(10), 100, 0);
    await point("staging", hoursBack(9), 100, 0);
    await cover("staging", hoursBack(4), hoursBack(1)); // 8, 7, 6, 5 hours back: never looked at
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests).toEqual({ value: "200", trend: [0, 0, 0], tone: "neutral" });
  });

  it("real points that run right up to the covered interval are no hole — the trend starts at the first of them", async () => {
    await frontends();
    await point("staging", hoursBack(6), 100, 0);
    await point("staging", hoursBack(5), 300, 0);
    await cover("staging", hoursBack(4), hoursBack(1));
    const [staging] = ok((await dash()).usage)["24h"];
    expect(staging.requests?.trend).toEqual([100, 300, 0, 0, 0]);
  });

  it("a 7d/30d series starts at the first whole bucket when capture begins mid-bucket; at a bucket edge nothing is lost", async () => {
    await frontends();
    await point("staging", hoursBack(60), 40, 0);      // 7d bucket 4 = [72h, 48h) back: capture began 12h into it
    await point("staging", hoursBack(30), 50, 0);      // bucket 5
    await point("staging", hoursBack(2), 300, 0);      // bucket 6
    await point("production", hoursBack(72), 40, 0);   // exactly the start of bucket 4
    await point("production", hoursBack(2), 300, 0);
    const [staging, production] = ok((await dash()).usage)["7d"];
    expect(staging.requests).toEqual({ value: "390", trend: [50, 300], tone: "neutral" }); // total unchanged
    expect(production.requests).toEqual({ value: "340", trend: [40, 0, 300], tone: "neutral" });
  });

  // A per-metric `null` has four meanings; `seen` tells them apart, so the screen can say "not connected"
  // ONLY when nothing has ever landed.
  describe("seen — has this environment's source reported inside the 30-day read", () => {
    it("1 · never captured → seen false, and the metric is null", async () => {
      await frontends();
      await point("staging", hoursBack(1), 300, 0); // staging only, so the section is ok
      const [, production] = ok((await dash()).usage)["24h"];
      expect(production).toMatchObject({ requests: null, errorRate: null, users: null, seen: { requests: false, users: false } });
    });

    it("2 · captured, but no point in THIS range → null here, seen true in every range", async () => {
      await frontends();
      await point("production", hoursBack(40), 2_500_000, 100);
      const usage = ok((await dash()).usage);
      expect(usage["24h"][1]).toMatchObject({ requests: null, errorRate: null, seen: { requests: true, users: false } });
      expect(usage["7d"][1]).toMatchObject({ requests: { value: "2.50M" }, seen: { requests: true, users: false } });
    });

    // The poll died eight days ago. 24h and 7d are null — the SOURCE is still connected.
    it("3 · the poll stopped 8 days ago → 24h and 7d null, seen true, 30d still draws", async () => {
      await frontends();
      await point("staging", hoursBack(24 * 12), 900, 9);
      await point("staging", hoursBack(24 * 8 + 3), 100, 1);
      await cover("staging", hoursBack(24 * 12), hoursBack(24 * 8));
      const usage = ok((await dash()).usage);
      for (const range of ["24h", "7d"] as const) {
        expect(usage[range][0], range).toMatchObject({ requests: null, errorRate: null, seen: { requests: true, users: false } });
      }
      expect(usage["30d"][0].requests).toMatchObject({ value: "1.0K" });
    });

    it("4 · a users reading over 3 hours old → users null, seen.users true", async () => {
      await frontends();
      await point("staging", hoursBack(1), 300, 0);
      await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 41, at: hoursBack(6) });
      const [staging, production] = ok((await dash()).usage)["24h"];
      expect(staging).toMatchObject({ users: null, seen: { requests: true, users: true } });
      expect(production.seen).toEqual({ requests: false, users: false }); // never leaks across environments
    });

    it("a row under another part is not this environment's metric", async () => {
      await frontends();
      await point("staging", hoursBack(1), 300, 0);
      await hxPoint("requests", "production", "backend", hoursBack(1), 5);
      await putMetric(systemCtx(), { metric: "active_users_24h", env: "production", part: "frontend", value: 5, at: hoursBack(0) });
      const [, production] = ok((await dash()).usage)["24h"];
      expect(production.seen).toEqual({ requests: false, users: false });
    });
  });

  it("active users alone connect the usage section", async () => {
    await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 41, at: hoursBack(2) });
    const usage = ok((await dash()).usage);
    expect(usage["24h"][0]).toMatchObject({ requests: null, errorRate: null, users: { value: "41" } });
    expect(usage["7d"][0].users).toBeNull();
  });

  it("a service part's gauges never connect usage, and the old cf_* / rw_* names are read by nothing", async () => {
    await frontends();
    await addPart(ORG_A, "staging", "api", "render", "service", {}, 1);
    await hxPoint("cpu", "staging", "api", hoursBack(1), 0.5);
    await putMetric(systemCtx(), { metric: "cf_requests", env: "staging", part: "frontend", value: 10, at: hoursBack(1) });
    await putMetric(systemCtx(), { metric: "rw_cpu", env: "staging", part: "backend", value: 0.5, at: hoursBack(1) });
    const d = await dash();
    expect(d.usage.status).toBe("not_connected");
    expect(d.providers.status).toBe("ok");   // the service part's CPU is the providers section's
  });
});
