/**
 * Task 16 — Cloudflare Workers analytics (source K).
 *
 * `pollCloudflare` writes hourly `cf_requests` / `cf_errors` per frontend Worker
 * for 3 COMPLETE hours, lagged one hour (Task 16b), and records how far each
 * environment has been polled in the `cf_polled` snapshot; `getRepoDashboard`
 * projects the Usage tab's requests / error rate and the Cloudflare panel from
 * ONE read of those rows, zero-filling only as far as a poll has looked.
 * The fetch is stubbed at the Response level; every assertion is on D1 rows or
 * on the projection built from them.
 */
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { all } from "../src/db";
import { pollCloudflare } from "../src/repo/poll";
import { getSnapshot, putMetric, putSnapshot } from "../src/repo/store";
import { getRepoDashboard } from "../src/tools/repo";
import { ENVS, leakedFragments } from "./helpers/repo";

import { systemCtx } from "./helpers/tenant";
const NOW = Date.parse("2026-09-20T12:05:00Z");
const HOUR = 3_600_000;
const CF = { token: "t", accountId: "acct" };

interface CfRow { dimensions: unknown; sum: unknown }
const cfBody = (rows: CfRow[]) => ({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } } });
const hourRow = (at: string, requests: unknown, errors: unknown): CfRow => ({ dimensions: { datetimeHour: at }, sum: { requests, errors } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const stored = () => all<{ metric: string; env: string; part: string; value: number; at: string }>(env.DB,
  `SELECT metric, env, part, value, at FROM repo_metrics WHERE metric LIKE 'cf_%' ORDER BY env, metric, at`);

describe("pollCloudflare", () => {
  it("stores hourly requests and errors per frontend Worker", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      expect(String(u)).toBe("https://api.cloudflare.com/client/v4/graphql");
      expect(init?.method).toBe("POST");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer t");
      const sent = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, string> };
      seen.push(sent.variables.s);
      // 3 COMPLETE hours, LAGGED one: `to` is the current hour's floor minus an
      // hour, so the adaptive dataset has had an hour to settle before the
      // first (and only) write of each bucket.
      expect(sent.variables).toMatchObject({ a: "acct", from: "2026-09-20T08:00:00.000Z", to: "2026-09-20T11:00:00.000Z" });
      // Cloudflare's schema spells the scalar `string`, lowercase — `String!` is rejected.
      expect(sent.query).toContain("$a: string!");
      expect(sent.query).toContain("$s: string!");
      expect(sent.query).toContain("$from: Time!");
      expect(sent.query).not.toContain("String");
      expect(sent.query).toContain("workersInvocationsAdaptive");
      return json(cfBody([hourRow("2026-09-20T09:00:00Z", 500, 12), hourRow("2026-09-20T10:00:00Z", 640, 3)]));
    }) as typeof fetch;
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl);
    expect(seen).toEqual(["frontend-staging", "frontend"]);
    expect((await stored()).filter((r) => r.env === "staging")).toEqual([
      { metric: "cf_errors", env: "staging", part: "frontend", value: 12, at: "2026-09-20T09:00:00.000Z" },
      { metric: "cf_errors", env: "staging", part: "frontend", value: 3, at: "2026-09-20T10:00:00.000Z" },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 500, at: "2026-09-20T09:00:00.000Z" },
      { metric: "cf_requests", env: "staging", part: "frontend", value: 640, at: "2026-09-20T10:00:00.000Z" },
    ]);
    expect((await stored()).filter((r) => r.env === "production")).toHaveLength(4);
  });

  it("the overlap is a no-op: a second poll of the same hours writes nothing new, and the first value stands", async () => {
    const at = "2026-09-20T10:00:00Z";
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, (async () => json(cfBody([hourRow(at, 640, 3)]))) as typeof fetch);
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, (async () => json(cfBody([hourRow(at, 999, 9)]))) as typeof fetch);
    expect((await stored()).map((r) => [r.metric, r.value])).toEqual([["cf_errors", 3], ["cf_requests", 640]]);
  });

  it("a rejected token writes nothing and does not throw", async () => {
    const fetchImpl = (async () => json({ errors: [{ message: "unauthorized" }] }, 403)) as typeof fetch;
    await expect(pollCloudflare(systemCtx(), { token: "bad", accountId: "acct" }, ENVS, NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect(await stored()).toEqual([]);
  });

  it("a thrown fetch writes nothing and does not throw", async () => {
    const fetchImpl = (async () => { throw new Error("connect timeout"); }) as typeof fetch;
    await expect(pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect(await stored()).toEqual([]);
  });

  // A GraphQL error arrives with HTTP 200: `data` beside a non-empty `errors`
  // must not be read — and one environment's failure must not cost the next.
  it("a 200 body carrying `errors` is a failure for THAT environment only", async () => {
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const s = (JSON.parse(String(init?.body)) as { variables: { s: string } }).variables.s;
      return s === "frontend-staging"
        ? json({ errors: [{ message: "unknown field" }], ...cfBody([hourRow("2026-09-20T10:00:00Z", 1, 1)]) })
        : json(cfBody([hourRow("2026-09-20T10:00:00Z", 640, 3)]));
    }) as typeof fetch;
    await expect(pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect((await stored()).map((r) => [r.env, r.metric, r.value])).toEqual([["production", "cf_errors", 3], ["production", "cf_requests", 640]]);
  });

  // `datetime_leq: to` is INCLUSIVE, so the bucket AT `to` can come back. It is
  // the hour that closed seconds ago — complete by the clock, but the adaptive
  // dataset may still be short of it, and INSERT OR IGNORE would make that
  // short count PERMANENT. It is stored an hour later instead.
  it("skips the bucket AT `to` — the hour that only just closed is never stored", async () => {
    const fetchImpl = (async () => json(cfBody([
      hourRow("2026-09-20T10:00:00Z", 640, 3),
      hourRow("2026-09-20T11:00:00Z", 7, 0),  // AT `to`: closed at 12:00, five minutes before NOW
      hourRow("2026-09-20T12:00:00Z", 7, 0),  // the hour in progress at NOW (12:05)
      hourRow("2026-09-20T13:00:00Z", 1, 0),  // a clock ahead of ours
    ]))) as typeof fetch;
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, fetchImpl);
    expect((await stored()).map((r) => r.at)).toEqual(["2026-09-20T10:00:00.000Z", "2026-09-20T10:00:00.000Z"]);
  });

  it("skips a malformed row without losing the rows after it, and never stores NaN", async () => {
    const fetchImpl = (async () => json(cfBody([
      hourRow("not a date", 5, 0),
      hourRow("2026-09-20T09:00:00Z", -4, 0),
      hourRow("2026-09-20T09:00:00Z", 10, "many"),
      hourRow("2026-09-20T09:00:00Z", null, null),
      { dimensions: null, sum: null },
      { dimensions: { datetimeHour: "2026-09-20T09:00:00Z" }, sum: null },
      hourRow("2026-09-20T10:00:00Z", 500, 12),
    ]))) as typeof fetch;
    await expect(pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect((await stored()).map((r) => [r.metric, r.value, r.at])).toEqual([
      ["cf_errors", 12, "2026-09-20T10:00:00.000Z"], ["cf_requests", 500, "2026-09-20T10:00:00.000Z"],
    ]);
  });

  // P5-5: the same rule its two sibling pollers keep — the MESSAGE only, scrubbed.
  it("never logs the token or the raw error object, whatever fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const secret = { token: "cf-s3cret-token", accountId: "acct" };
    try {
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        // The worst case: the failure itself quotes the request back.
        throw new Error(`request failed: ${JSON.stringify(init?.headers)}`);
      }) as typeof fetch;
      await pollCloudflare(systemCtx(), secret, ENVS, NOW, fetchImpl);
      await pollCloudflare(systemCtx(), secret, ENVS, NOW, (async () => json({ errors: [{ message: "bad token cf-s3cret-token" }] })) as typeof fetch);
      expect(spy).toHaveBeenCalledTimes(4);
      for (const call of spy.mock.calls) {
        expect(call.slice(0, 2)).toEqual(["pollCloudflare", expect.stringMatching(/^(staging|production)$/)]);
        expect(typeof call[2]).toBe("string"); // never the Error object (its stack, its cause)
      }
      const logged = JSON.stringify(spy.mock.calls);
      expect(logged).not.toContain("cf-s3cret-token");
      expect(logged).toContain("[redacted]");
    } finally {
      spy.mockRestore();
    }
  });

  it("a body with no accounts (wrong account id) writes nothing and does not throw", async () => {
    const fetchImpl = (async () => json({ data: { viewer: { accounts: [] } } })) as typeof fetch;
    await expect(pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl)).resolves.toEqual(expect.any(Array));
    expect(await stored()).toEqual([]);
    // Nothing was looked at — no account matched — so nothing is "polled through".
    expect(await polled()).toBeNull();
  });
});

// ── outcomes ("Poll usage now") ──────────────────────────────────────────────
// The poller reports one outcome per environment it considered, so an admin's
// on-demand run can SHOW what the cron only logs.
describe("pollCloudflare — outcomes", () => {
  // A realistic token: the file's one-letter `CF.token` ("t") is scrubbed out of every message it appears in.
  const CF = { token: "cf-token", accountId: "acct" };
  const rows = [hourRow("2026-09-20T09:00:00Z", 500, 12), hourRow("2026-09-20T10:00:00Z", 640, 3)];

  it("ok with the NEW rows written, and ok with 0 on a repeat of the same hours", async () => {
    const fetchImpl = (async () => json(cfBody(rows))) as typeof fetch;
    expect(await pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl)).toEqual([
      { env: "staging", status: "ok", written: 4 },
      { env: "production", status: "ok", written: 4 },
    ]);
    expect(await pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl)).toEqual([
      { env: "staging", status: "ok", written: 0 },
      { env: "production", status: "ok", written: 0 },
    ]);
  });

  it("failed on a non-2xx, carrying the logged message", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const out = await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, (async () => new Response("", { status: 500 })) as typeof fetch);
      expect(out).toEqual([{ env: "staging", status: "failed", written: 0, detail: "cloudflare analytics 500" }]);
      expect(spy.mock.calls).toEqual([["pollCloudflare", "staging", "cloudflare analytics 500"]]);
    } finally { spy.mockRestore(); }
  });

  // A production finding: "cloudflare analytics 400" alone hid the real cause.
  // A non-2xx now says what the BODY said — errors[0].message and its code — and
  // Cloudflare's three auth statuses each carry a FIXED hint (never derived
  // from the secret): 400 = the Authorization value is not token-shaped at all,
  // 401 = token-shaped but wrong, 403 = a real token without the permission.
  describe("a non-2xx says why", () => {
    const failing = async (status: number, body: string, cf = CF) => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const out = await pollCloudflare(systemCtx(), cf, [ENVS[0]], NOW, (async () => new Response(body, { status })) as typeof fetch);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ env: "staging", status: "failed", written: 0 });
        expect(spy.mock.calls).toEqual([["pollCloudflare", "staging", out[0].detail]]); // the log and the detail are ONE string
        return out[0].detail!;
      } finally { spy.mockRestore(); }
    };
    const AUTH_FAILED = JSON.stringify({ success: false, errors: [{ code: 9106, message: "Authentication failed (status: 400)" }] });

    it("400: the body's message and code, plus the malformed-token hint", async () => {
      expect(await failing(400, AUTH_FAILED)).toBe(
        "cloudflare analytics 400: Authentication failed (status: 400) [9106] — the token value is malformed (quotes, spaces, or not an API token)");
    });

    it("401 and 403 carry their own hints; any other status carries none", async () => {
      expect(await failing(401, JSON.stringify({ errors: [{ code: "10000", message: "Authentication error" }] }))).toBe(
        "cloudflare analytics 401: Authentication error [10000] — the token is not valid");
      expect(await failing(403, JSON.stringify({ errors: [{ message: "not entitled" }] }))).toBe(
        "cloudflare analytics 403: not entitled — the token lacks Account Analytics: Read");
      expect(await failing(429, JSON.stringify({ errors: [{ code: { nested: 1 }, message: "slow down" }] }))).toBe("cloudflare analytics 429: slow down");
    });

    it("a body that ECHOES the token (or the account id) yields a detail without it — scrubbed before it is cut", async () => {
      const secret = { token: "cf-s3cret-token", accountId: "acct-1d-9f3b" };
      const json400 = await failing(400, JSON.stringify({ errors: [{ code: 9106, message: `bad header: Bearer ${secret.token} for ${secret.accountId}` }] }), secret);
      expect(json400).toContain("bad header: Bearer [redacted] for [redacted] [9106]");
      // Raw text, with the token STRADDLING the raw-text cut: cutting first would leave half of it behind.
      const raw = await failing(400, `${"x".repeat(110)}${secret.token} tail`, secret);
      expect(raw).not.toContain("cf-s3");
      expect(raw).toContain("[redacted]");
      for (const d of [json400, raw]) { expect(d).not.toContain(secret.token); expect(d).not.toContain(secret.accountId); }
    });

    it("the 200-with-`errors` arm scrubs BEFORE it cuts too — a token straddling the 200-char cut leaves nothing behind", async () => {
      const secret = { token: "cf-live-9aQ7x2Lm4Pz8Rv1Kd3Nb6Tc0We5Yh", accountId: "acct-1d-9f3b" };
      // 170 chars of prose, then the token: it straddles the cut at 200.
      const body = JSON.stringify({ errors: [{ message: `${"p".repeat(170)}${secret.token} — use a scoped token` }] });
      const detail = await failing(200, body, secret);
      expect(detail).toContain("[redact"); // the OUTER 200-char cut may clip the marker itself — never the token
      expect(detail).not.toContain("cf-live");
      expect(detail).not.toContain(secret.token.slice(0, 8));
    });

    // The 8 KB read cap is ALSO a cut that comes before the scrub. A mostly-blank
    // body collapses to one line, so a token cut in half by the cap would land
    // inside the 120 characters that are kept — and half a token matches no scrub.
    it("a token cut in half by the 8 KB read cap never reaches the detail", async () => {
      const secret = { token: "cf-live-9aQ7x2Lm4Pz8Rv1Kd3Nb6Tc0We5Yh", accountId: "acct-1d-9f3b" };
      for (const inside of [8, 20, secret.token.length - 1]) {
        const body = `gateway${" ".repeat(8192 - "gateway".length - inside)}${secret.token} and the rest of a long page`;
        const detail = await failing(502, body, secret);
        expect(detail).toBe("cloudflare analytics 502: gateway");
        expect(leakedFragments(detail, secret.token)).toEqual([]);
      }
      // A token wholly inside the cap is still scrubbed as before, not lost.
      const whole = await failing(502, `gateway ${secret.token}${" ".repeat(9000)}tail`, secret);
      expect(whole).toBe("cloudflare analytics 502: gateway [redacted]");
    });

    it("an enormous error body is read to a bound, not buffered whole", async () => {
      let pulled = 0;
      const chunk = new TextEncoder().encode("e".repeat(4096));
      const stream = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 5000) c.close(); else c.enqueue(chunk); } });
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const out = await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, (async () => new Response(stream, { status: 502 })) as typeof fetch);
        expect(out[0].detail).toMatch(/^cloudflare analytics 502: e{120}$/);
        expect(pulled).toBeLessThan(20); // ~8 KB wanted of ~20 MB offered
      } finally { spy.mockRestore(); }
    });

    it("a non-JSON body does not throw: the raw text's start, one line; and the hint survives a long body", async () => {
      expect(await failing(502, "<html>\n  <body>Bad   gateway</body></html>")).toBe("cloudflare analytics 502: <html> <body>Bad gateway</body></html>");
      const long = await failing(403, "y".repeat(5000));
      expect(long).toMatch(/^cloudflare analytics 403: y{120} — the token lacks Account Analytics: Read$/);
      const longJson = await failing(400, JSON.stringify({ errors: [{ message: "z".repeat(5000) }] }));
      expect(longJson).toMatch(/ — the token value is malformed \(quotes, spaces, or not an API token\)$/);
      expect(longJson.length).toBeLessThan(300);
    });

    it("a body that cannot be read does not throw either", async () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const broken = { ok: false, status: 503, text: async () => { throw new Error("stream closed"); } } as unknown as Response;
        const out = await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, (async () => broken) as typeof fetch);
        expect(out).toEqual([{ env: "staging", status: "failed", written: 0, detail: "cloudflare analytics 503" }]);
      } finally { spy.mockRestore(); }
    });
  });

  it("failed on a 200 body carrying `errors`, for THAT environment only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        const s = (JSON.parse(String(init?.body)) as { variables: { s: string } }).variables.s;
        return s === "frontend-staging" ? json({ errors: [{ message: "unknown field" }] }) : json(cfBody(rows));
      }) as typeof fetch;
      expect(await pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl)).toEqual([
        { env: "staging", status: "failed", written: 0, detail: "cloudflare analytics: unknown field" },
        { env: "production", status: "ok", written: 4 },
      ]);
    } finally { spy.mockRestore(); }
  });

  it("the detail is the SCRUBBED message — a failure quoting the token back never carries it", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const secret = { token: "cf-s3cret-token", accountId: "acct" };
      const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
        throw new Error(`request failed: ${JSON.stringify(init?.headers)}`);
      }) as typeof fetch;
      const out = await pollCloudflare(systemCtx(), secret, [ENVS[0]], NOW, fetchImpl);
      expect(out[0].status).toBe("failed");
      expect(JSON.stringify(out)).not.toContain("cf-s3cret-token");
      expect(out[0].detail).toContain("[redacted]");
      expect(out[0].detail).toBe(spy.mock.calls[0][2]);
    } finally { spy.mockRestore(); }
  });

  // Cloudflare's own errors can name the account they refused ("account <tag>
  // is not authorized…"), and the detail travels to the browser — so the ONE
  // scrub covers the account id as well as the token.
  it("the scrub covers the account id too — in the detail and in the log", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const secret = { token: "cf-s3cret-token", accountId: "acct-1d-9f3b" };
      const fetchImpl = (async () => json({ errors: [{ message: "account acct-1d-9f3b is not authorized for cf-s3cret-token" }] })) as typeof fetch;
      const out = await pollCloudflare(systemCtx(), secret, [ENVS[0]], NOW, fetchImpl);
      expect(out[0].detail).toBe("cloudflare analytics: account [redacted] is not authorized for [redacted]");
      expect(spy.mock.calls).toEqual([["pollCloudflare", "staging", out[0].detail]]);
    } finally { spy.mockRestore(); }
  });

  it("skipped for an environment that names no Worker — never fetched", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return json(cfBody(rows)); }) as typeof fetch;
    const out = await pollCloudflare(systemCtx(), CF, [{ ...ENVS[0], worker: "" }, ENVS[1]], NOW, fetchImpl);
    expect(out).toEqual([
      { env: "staging", status: "skipped", written: 0, detail: "no worker configured" },
      { env: "production", status: "ok", written: 4 },
    ]);
    expect(calls).toBe(1);
  });
});

// ── the `cf_polled` marker (Task 16b) ────────────────────────────────────────
// Cloudflare returns NO row for an hour without invocations, so "no row" only
// means "zero" for hours a poll is known to have looked at. Each environment's
// successful poll records the (exclusive) bound it looked through.
// P5-3: the marker is a covered INTERVAL per environment — `{ from, to }`, both
// hour floors, `to` exclusive — because a single high-water bound cannot say
// that a stretch in the middle was never looked at.
const polled = async () => (await getSnapshot<Record<string, unknown>>(systemCtx(), "cf_polled"))?.data ?? null;
const FROM = "2026-09-20T08:00:00.000Z";         // pollCloudflare's window at NOW is [FROM, TO)
const TO = "2026-09-20T11:00:00.000Z";
const IV = { from: FROM, to: TO };
const EARLIER = NOW - 2 * HOUR;                   // a poll two hours before …
const EARLIER_IV = { from: "2026-09-20T06:00:00.000Z", to: "2026-09-20T09:00:00.000Z" }; // … looked at this
const quiet = (async () => json(cfBody([]))) as typeof fetch;
const workerOf = (init?: RequestInit) => (JSON.parse(String(init?.body)) as { variables: { s: string } }).variables.s;

describe("pollCloudflare — the polled-through marker", () => {
  it("a successful poll records every environment as polled through `to`, in ONE snapshot row", async () => {
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, (async () => json(cfBody([hourRow("2026-09-20T10:00:00Z", 640, 3)]))) as typeof fetch);
    expect(await polled()).toEqual({ staging: IV, production: IV });
    expect(await all(env.DB, `SELECT kind FROM repo_snapshots`)).toEqual([{ kind: "cf_polled" }]);
  });

  // The whole point of the marker: a poll that LOOKED and found nothing is what
  // entitles the projection to draw a zero.
  it("a successful poll that returned zero rows still advances the bound", async () => {
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, quiet);
    expect(await stored()).toEqual([]);
    expect(await polled()).toEqual({ staging: IV, production: IV });
  });

  it.each([
    ["a 403", () => json({ errors: [{ message: "unauthorized" }] }, 403)],
    ["a 200 carrying `errors`", () => json({ errors: [{ message: "unknown field" }], ...cfBody([]) })],
    ["a body with no account", () => json({ data: { viewer: { accounts: [] } } })],
  ])("%s keeps that environment's previous bound while the other environment's advances", async (_name, failure) => {
    await pollCloudflare(systemCtx(), CF, ENVS, EARLIER, quiet);
    expect(await polled()).toEqual({ staging: EARLIER_IV, production: EARLIER_IV });
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) =>
      workerOf(init) === "frontend-staging" ? failure() : json(cfBody([]))) as typeof fetch;
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl);
    // production's window [08:00, 11:00) overlaps what it had looked at, so ONE interval grows.
    expect(await polled()).toEqual({ staging: EARLIER_IV, production: { from: EARLIER_IV.from, to: TO } });
  });

  it("an environment that has never succeeded has no bound at all", async () => {
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (workerOf(init) === "frontend-staging") throw new Error("connect timeout");
      return json(cfBody([]));
    }) as typeof fetch;
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, fetchImpl);
    expect(await polled()).toEqual({ production: IV });
  });

  it("never moves a bound backwards: a poll with an earlier clock leaves it where it was", async () => {
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, quiet);
    const before = await getSnapshot(systemCtx(), "cf_polled");
    await pollCloudflare(systemCtx(), CF, ENVS, EARLIER, quiet);
    expect(await getSnapshot(systemCtx(), "cf_polled")).toEqual(before); // same bounds, and not even rewritten
  });

  // Compared as parsed instants: a bound stored without milliseconds is the SAME
  // instant as `to`, not an older string.
  it("compares bounds as instants, and replaces one it cannot parse", async () => {
    await putSnapshot(systemCtx(), "cf_polled", { staging: { from: "2026-09-20T07:00:00Z", to: "2026-09-20T13:00:00Z" }, production: "not a date" });
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, quiet);
    expect(await polled()).toEqual({ staging: { from: "2026-09-20T07:00:00Z", to: "2026-09-20T13:00:00Z" }, production: IV });
  });

  it("contiguous hourly polls keep extending ONE interval", async () => {
    for (let h = 5; h >= 0; h--) await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW - h * HOUR, quiet);
    expect(await polled()).toEqual({ staging: { from: "2026-09-20T03:00:00.000Z", to: TO } });
  });

  // A poll window is 3 hours, so a missed tick or two still overlaps (or
  // touches) what was already looked at. Past that, hours exist that NO poll
  // ever saw — the interval restarts, and the jump is what records the hole.
  it("a window that only TOUCHES the interval extends it; a gap restarts `from`", async () => {
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW - 3 * HOUR, quiet); // looked at [05:00, 08:00)
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, quiet);            // [08:00, 11:00) touches it
    expect(await polled()).toEqual({ staging: { from: "2026-09-20T05:00:00.000Z", to: TO } });

    await putSnapshot(systemCtx(), "cf_polled", {});
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW - 4 * HOUR, quiet); // looked at [04:00, 07:00)
    await pollCloudflare(systemCtx(), CF, [ENVS[0]], NOW, quiet);            // 07:00 was never looked at
    expect(await polled()).toEqual({ staging: IV });
  });

  // The 16b shape — one ISO string, the exclusive bound — still sits in local dev
  // databases. It reads as the one window that certainly produced it.
  it("a LEGACY string bound reads as { from: bound − 3h, to: bound } and is upgraded when it advances", async () => {
    await putSnapshot(systemCtx(), "cf_polled", { staging: "2026-09-20T09:00:00Z", production: "2026-09-20T02:00:00Z" });
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, quiet);
    expect(await polled()).toEqual({
      staging: { from: "2026-09-20T06:00:00.000Z", to: TO }, // [06:00, 09:00) overlaps [08:00, 11:00)
      production: IV,                                         // [23:00, 02:00) does not: a hole, so it restarts
    });
  });

  it("writes nothing when every environment fails", async () => {
    const down = (async () => json({}, 500)) as typeof fetch;
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, down);
    expect(await polled()).toBeNull();
    // … and leaves an existing marker exactly as it was.
    await pollCloudflare(systemCtx(), CF, ENVS, EARLIER, quiet);
    const before = await getSnapshot(systemCtx(), "cf_polled");
    await pollCloudflare(systemCtx(), CF, ENVS, NOW, down);
    expect(await getSnapshot(systemCtx(), "cf_polled")).toEqual(before);
  });
});

// ── the projection ───────────────────────────────────────────────────────────
const ok = <T>(s: { status: string; data?: T }): T => { expect(s.status).toBe("ok"); return (s as { data: T }).data; };
/** The start of the hour `h` complete hours before NOW's own (12:00): h=1 → 11:00. */
const hoursBack = (h: number) => new Date(Date.parse("2026-09-20T12:00:00Z") - h * HOUR).toISOString();
const point = async (envKey: string, at: string, requests: number, errors: number) => {
  await putMetric(systemCtx(), { metric: "cf_requests", env: envKey, part: "frontend", value: requests, at });
  await putMetric(systemCtx(), { metric: "cf_errors", env: envKey, part: "frontend", value: errors, at });
};

describe("getRepoDashboard — usage and Cloudflare from cf_* metrics", () => {
  it("nothing captured → both sections not_connected", async () => {
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect(d.usage.status).toBe("not_connected");
    expect(d.cloudflare.status).toBe("not_connected");
  });

  it("sums requests, derives the error rate, and leaves active users unconnected", async () => {
    await point("staging", hoursBack(3), 1000, 30);
    await point("staging", hoursBack(1), 500, 0);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const [staging, production] = ok(d.usage)["24h"];
    expect(staging).toMatchObject({ name: "staging", host: "staging.saplinglearn.com", users: null });
    expect(staging.requests).toMatchObject({ value: "1.5K", tone: "neutral" });
    expect(staging.errorRate).toMatchObject({ value: "2.00%", tone: "warn" });
    // Never guess: production has no point in ANY range — null, not "0".
    expect(production).toMatchObject({ name: "production", requests: null, errorRate: null, users: null });
    expect(ok(d.cloudflare)["24h"]).toEqual([
      { env: "staging", label: "Workers requests", value: "1.5K" },
      { env: "staging", label: "Workers errors", value: "30" },
    ]);
  });

  // A quiet hour has NO row (Cloudflare returns only hours with invocations), so
  // the series is zero-filled — but only from the first captured point: before
  // capture began the value is unknown, not zero.
  it("zero-fills a quiet hour between captured ones, and nothing before capture began", async () => {
    await point("staging", hoursBack(4), 100, 10);
    await point("staging", hoursBack(1), 300, 0);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const [staging] = ok(d.usage)["24h"];
    expect(staging.requests?.trend).toEqual([100, 0, 0, 300]);
    expect(staging.errorRate?.trend).toEqual([10, 0, 0, 0]);
  });

  it("a range is filled from its start once capture is known to predate it", async () => {
    await point("staging", hoursBack(30), 50, 0); // outside 24h, inside 7d
    await point("staging", hoursBack(1), 300, 0);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const day = ok(d.usage)["24h"][0].requests;
    expect(day?.trend).toHaveLength(24);
    expect(day?.trend.slice(-2)).toEqual([0, 300]);
    expect(day?.value).toBe("300");
    // 7d: 24-hour buckets ending at the last complete hour. Capture began 30h
    // back — MID-bucket — so that bucket holds 6 captured hours, not 24, and is
    // not drawn as a day (P5-11); the total still counts its point.
    const week = ok(d.usage)["7d"][0].requests;
    expect(week?.trend).toEqual([300]);
    expect(week?.value).toBe("350");
  });

  it("an environment with points in 7d but none in 24h is null for 24h only", async () => {
    await point("production", hoursBack(40), 2_500_000, 100);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const usage = ok(d.usage);
    expect(usage["24h"][1]).toMatchObject({ name: "production", requests: null, errorRate: null });
    expect(usage["7d"][1].requests).toMatchObject({ value: "2.50M" });
    expect(usage["7d"][1].errorRate).toMatchObject({ value: "0.00%", tone: "good" });
    // The Cloudflare panel is gated on the WIDEST range; a narrower one may be empty.
    const cf = ok(d.cloudflare);
    expect(cf["24h"]).toEqual([]);
    expect(cf["7d"].map((r) => r.value)).toEqual(["2.50M", "100"]);
  });

  it("captured hours with zero requests read 0 and a true 0.00%, never a division by zero", async () => {
    await point("staging", hoursBack(1), 0, 0);
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "0" });
    expect(staging.errorRate).toMatchObject({ value: "0.00%", tone: "good", trend: [0] });
  });

  it("never reads the current, incomplete hour even if a row for it exists", async () => {
    await point("staging", hoursBack(1), 300, 0);
    await point("staging", hoursBack(0), 9999, 0);
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toMatchObject({ value: "300", trend: [300] });
  });

  it("rows that all aged out of the 30-day read → empty, not not_connected", async () => {
    await point("staging", hoursBack(31 * 24), 100, 0);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect(d.usage.status).toBe("empty");
    expect(d.cloudflare.status).toBe("empty");
  });

  it("no environment configured → not_connected whatever is stored", async () => {
    await point("staging", hoursBack(1), 300, 0);
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, []);
    expect(d.usage.status).toBe("not_connected");
    expect(d.cloudflare.status).toBe("not_connected");
  });

  // ── Task 16b: zeros are drawn only as far as a poll is known to have looked ──
  // `cf_polled` is `{ [envKey]: <exclusive bound> }`: polled through 11:00 means
  // the 10:00 bucket (hoursBack(2)) is the last one known.
  // P5-3: the marker is an INTERVAL. These tests are about its upper end, so
  // `from` sits before every point they write — coverage with no hole in it.
  const LONG_AGO = hoursBack(24 * 40);
  const markPolled = (bounds: Record<string, string>) =>
    putSnapshot(systemCtx(), "cf_polled", Object.fromEntries(Object.entries(bounds).map(([k, to]) => [k, { from: LONG_AGO, to }])));

  it("zero-fills past the last real point up to the polled bound — and no further", async () => {
    await point("staging", hoursBack(5), 100, 10);
    await point("staging", hoursBack(3), 300, 0);
    await point("production", hoursBack(5), 70, 0);
    await markPolled({ staging: hoursBack(1) }); // staging only: a bound never leaks to another environment
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const [staging, production] = ok(d.usage)["24h"];
    // 07:00, 08:00, 09:00, 10:00. The 11:00 bucket (hoursBack(1)) is NOT drawn: no poll has looked at it yet.
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300, 0], tone: "neutral" });
    expect(staging.errorRate).toEqual({ value: "2.50%", trend: [10, 0, 0, 0], tone: "warn" });
    expect(production.requests).toEqual({ value: "70", trend: [70], tone: "neutral" });
  });

  it("with NO marker the trend ends at the last real point", async () => {
    await point("staging", hoursBack(5), 100, 10);
    await point("staging", hoursBack(3), 300, 0);
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300], tone: "neutral" });
    expect(staging.errorRate?.trend).toEqual([10, 0, 0]);
  });

  // The poll died three days ago: nothing after its bound is known to be zero.
  it("a marker days old draws no zeros after it", async () => {
    await point("staging", hoursBack(100), 50, 0);
    await markPolled({ staging: hoursBack(72) });
    const usage = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
    // 7d = seven 24h buckets ending at 12:00. The point sits in bucket 2 — the
    // PARTIAL bucket capture began in, so it is counted but not drawn (P5-11); the
    // last polled hour (hoursBack(73)) is in bucket 3. Buckets 4–6 are unknown, not zero.
    expect(usage["7d"][0].requests).toEqual({ value: "50", trend: [0], tone: "neutral" });
    // 24h: capture predates the range, but no poll has looked inside it.
    expect(usage["24h"][0]).toMatchObject({ requests: null, errorRate: null });
  });

  it("a marker older than the last real point never truncates real points", async () => {
    await point("staging", hoursBack(5), 100, 0);
    await point("staging", hoursBack(3), 300, 0);
    await markPolled({ staging: hoursBack(10) });
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toEqual({ value: "400", trend: [100, 0, 300], tone: "neutral" });
  });

  it("a range with no real point, but polled and captured before it, reads a true 0 — and no error rate", async () => {
    await point("staging", hoursBack(30), 50, 5); // outside 24h, inside 7d
    await markPolled({ staging: hoursBack(1) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    const day = ok(d.usage)["24h"][0];
    // 23 buckets, not 24: the range's last hour (11:00) has not been polled yet.
    expect(day.requests).toEqual({ value: "0", trend: new Array(23).fill(0), tone: "neutral" });
    expect(day.errorRate).toBeNull(); // 0 of 0 is not a rate
    expect(ok(d.cloudflare)["24h"]).toEqual([
      { env: "staging", label: "Workers requests", value: "0" },
      { env: "staging", label: "Workers errors", value: "0" },
    ]);
    // 7d: the point sits in bucket 5 — the partial bucket capture began in,
    // counted but not drawn (P5-11) — and the last polled hour in bucket 6.
    expect(ok(d.usage)["7d"][0].requests).toEqual({ value: "50", trend: [0], tone: "neutral" });
    expect(ok(d.usage)["7d"][0].errorRate).toMatchObject({ value: "10.00%", trend: [0] });
  });

  it("a marker alone — polled, but nothing ever captured — connects nothing", async () => {
    await markPolled({ staging: hoursBack(1), production: hoursBack(1) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect(d.usage.status).toBe("not_connected");
    expect(d.cloudflare.status).toBe("not_connected");
  });

  it("a bound ahead of the clock fills only to the last complete hour; an unparseable one is no bound", async () => {
    await point("staging", hoursBack(3), 300, 0);
    await point("production", hoursBack(3), 300, 0);
    await markPolled({ staging: hoursBack(-5), production: "not a date" });
    const [staging, production] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests?.trend).toEqual([300, 0, 0]);
    expect(production.requests?.trend).toEqual([300]);
  });

  // ── P5-3: a hole in the coverage is never drawn as quiet hours ─────────────
  const cover = (key: string, from: string, to: string) => putSnapshot(systemCtx(), "cf_polled", { [key]: { from, to } });

  // Polls ran, the token expired for three days, polls resumed. The old single
  // bound jumped past the outage and drew it as consecutive zero days.
  it("30d: a poll outage is NOT zero-filled — the trend is the contiguous covered stretch, totals keep every real point", async () => {
    // 30d = thirty 24h buckets from hoursBack(720); bucket k starts at hoursBack(720 − 24k).
    for (let k = 5; k <= 10; k++) await point("staging", hoursBack(720 - 24 * k), 100, 0); // before the outage
    await point("staging", hoursBack(395), 7, 0);   // bucket 13 — the PARTIAL bucket the polls resumed in
    await point("staging", hoursBack(380), 50, 0);  // bucket 14; bucket 15 is a genuinely quiet, POLLED day
    for (let k = 16; k <= 29; k++) await point("staging", hoursBack(720 - 24 * k - 4), 50, 0);
    await cover("staging", hoursBack(400), hoursBack(1)); // buckets 11–12 were never looked at
    const month = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["30d"][0].requests;
    expect(month?.trend).toEqual([50, 0, ...new Array(14).fill(50)]); // buckets 14–29: no outage zeros
    expect(month?.value).toBe("1.4K"); // 600 + 7 + 50 + 700 — every real point is a fact
  });

  it("24h: real points before a hole still count, and only the covered stretch is drawn", async () => {
    await point("staging", hoursBack(10), 100, 0);
    await point("staging", hoursBack(9), 100, 0);
    await cover("staging", hoursBack(4), hoursBack(1)); // 8, 7, 6, 5 hours back: never looked at
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toEqual({ value: "200", trend: [0, 0, 0], tone: "neutral" });
  });

  it("real points that run right up to the covered interval are no hole — the trend starts at the first of them", async () => {
    await point("staging", hoursBack(6), 100, 0);
    await point("staging", hoursBack(5), 300, 0);
    await cover("staging", hoursBack(4), hoursBack(1));
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests?.trend).toEqual([100, 300, 0, 0, 0]);
  });

  it("a LEGACY string marker covers only the 3 hours before it", async () => {
    await point("staging", hoursBack(10), 100, 0);
    await putSnapshot(systemCtx(), "cf_polled", { staging: hoursBack(1) });
    const [staging] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
    expect(staging.requests).toEqual({ value: "100", trend: [0, 0, 0], tone: "neutral" }); // 4, 3, 2 hours back
  });

  // ── P5-11: the first drawn bucket is a WHOLE one ───────────────────────────
  it("a 7d/30d series starts at the first whole bucket when capture begins mid-bucket; at a bucket edge nothing is lost", async () => {
    await point("staging", hoursBack(60), 40, 0);      // 7d bucket 4 = [72h, 48h) back: capture began 12h into it
    await point("staging", hoursBack(30), 50, 0);      // bucket 5
    await point("staging", hoursBack(2), 300, 0);      // bucket 6
    await point("production", hoursBack(72), 40, 0);   // exactly the start of bucket 4
    await point("production", hoursBack(2), 300, 0);
    const [staging, production] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["7d"];
    expect(staging.requests).toEqual({ value: "390", trend: [50, 300], tone: "neutral" }); // total unchanged
    expect(production.requests).toEqual({ value: "340", trend: [40, 0, 300], tone: "neutral" });
  });

  // ── P5-2: a per-metric `null` has four meanings; `seen` tells them apart ────
  // so the screen can say "not connected" ONLY when nothing has ever landed.
  describe("seen — has this environment's source reported inside the 30-day read", () => {
    it("1 · never captured → seen false, and the metric is null", async () => {
      await point("staging", hoursBack(1), 300, 0); // staging only, so the section is ok
      const [, production] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
      expect(production).toMatchObject({ requests: null, errorRate: null, users: null, seen: { requests: false, users: false } });
    });

    it("2 · captured, but no point in THIS range → null here, seen true in every range", async () => {
      await point("production", hoursBack(40), 2_500_000, 100);
      const usage = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
      expect(usage["24h"][1]).toMatchObject({ requests: null, errorRate: null, seen: { requests: true, users: false } });
      expect(usage["7d"][1]).toMatchObject({ requests: { value: "2.50M" }, seen: { requests: true, users: false } });
    });

    // The reviewer's scenario: `wrangler triggers deploy` was never run, so the
    // poll died eight days ago. 24h and 7d are null — the SOURCE is still connected.
    it("3 · the poll stopped 8 days ago → 24h and 7d null, seen true, 30d still draws", async () => {
      await point("staging", hoursBack(24 * 12), 900, 9);
      await point("staging", hoursBack(24 * 8 + 3), 100, 1);
      await cover("staging", LONG_AGO, hoursBack(24 * 8));
      const usage = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage);
      for (const range of ["24h", "7d"] as const) {
        expect(usage[range][0], range).toMatchObject({ requests: null, errorRate: null, seen: { requests: true, users: false } });
      }
      expect(usage["30d"][0].requests).toMatchObject({ value: "1.0K" });
    });

    it("4 · a users reading over 3 hours old → users null, seen.users true", async () => {
      await point("staging", hoursBack(1), 300, 0);
      await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 41, at: hoursBack(6) });
      const [staging, production] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
      expect(staging).toMatchObject({ users: null, seen: { requests: true, users: true } });
      expect(production.seen).toEqual({ requests: false, users: false }); // never leaks across environments
    });

    it("a row under another part is not this environment's metric", async () => {
      await point("staging", hoursBack(1), 300, 0);
      await putMetric(systemCtx(), { metric: "cf_requests", env: "production", part: "backend", value: 5, at: hoursBack(1) });
      await putMetric(systemCtx(), { metric: "active_users_24h", env: "production", part: "frontend", value: 5, at: hoursBack(0) });
      const [, production] = ok((await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS)).usage)["24h"];
      expect(production.seen).toEqual({ requests: false, users: false });
    });
  });

  it("active users alone connect the usage section but not the Cloudflare panel", async () => {
    await putMetric(systemCtx(), { metric: "active_users_24h", env: "staging", part: "", value: 41, at: hoursBack(2) });
    const d = await getRepoDashboard(systemCtx(), "o/r", NOW, ENVS);
    expect(ok(d.usage)["24h"][0]).toMatchObject({ requests: null, errorRate: null, users: { value: "41" } });
    expect(ok(d.usage)["7d"][0].users).toBeNull();
    expect(d.cloudflare.status).toBe("not_connected");
  });
});
