// Vercel (#98) — src/hosting/providers/vercel.ts against recorded-shape fixtures (fixtures/hosting/vercel/).
// No network: every request goes through `hostFetch(vercel.apiHosts, stub)`, so the allowlist itself is part
// of what is tested, and the stub asserts host, path, query, method and the auth header of every call.
// Leak checks use a 64-character token and look for every 8-character piece of it (test/helpers/repo.ts).
import { describe, expect, it } from "vitest";
import { metricsForRole } from "@shared/hosting";
import { vercel } from "../src/hosting/providers/vercel";
import { HostRefusedError, HostingError, hostFetch } from "../src/hosting/http";
import { checkFields } from "../src/hosting/registry";
import type { PartRef, ProviderContext } from "../src/hosting/types";
import { LONG_TOKEN, leakedFragments } from "./helpers/repo";
import production from "../fixtures/hosting/vercel/deployments.production.json";
import preview from "../fixtures/hosting/vercel/deployments.preview.json";
import project from "../fixtures/hosting/vercel/project.json";
import user from "../fixtures/hosting/vercel/user.json";
import team from "../fixtures/hosting/vercel/team.json";
import forbidden from "../fixtures/hosting/vercel/error.forbidden.json";
import tokenTeam from "../fixtures/hosting/vercel/oauth-access-token.team.json";
import tokenPersonal from "../fixtures/hosting/vercel/oauth-access-token.personal.json";
import removed from "../fixtures/hosting/vercel/webhook.integration-configuration.removed.json";
import configuration from "../fixtures/hosting/vercel/integration-configuration.json";

const NOW = Date.parse("2026-10-07T12:20:00Z");
const TEAM_ID = "team_a1B2c3D4e5F6g7H8i9J0k1L2";
const TEAM = { team_id: TEAM_ID, team_slug: "acme" };
const secret = { reveal: () => LONG_TOKEN };
/** Distinct 64-character stand-ins for the integration's client secret, the install code and the token. */
const CLIENT_SECRET = [...LONG_TOKEN].reverse().join("");
const CODE = LONG_TOKEN.slice(32) + LONG_TOKEN.slice(0, 32);
const ACCESS = "vca_" + LONG_TOKEN.slice(8) + LONG_TOKEN.slice(0, 8);

const noLeak = (text: string, ...secrets: string[]) => {
  for (const s of [LONG_TOKEN, ...secrets]) expect(leakedFragments(text, s), text).toEqual([]);
};

interface Call { url: URL; method: string; headers: Headers; body: string | null }

/** One macrotask — a real fetch never settles synchronously, and a stub that rejected before the caller
 *  attached its handler would read as an unhandled rejection in the pool. */
const later = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A fetch stub that records every call, insists on the hardened init, and answers from `route` (after a
 *  macrotask, like the network). */
function stub(route: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("api.vercel.com"); // the ONLY host a credential travels to
    expect(init?.redirect).toBe("manual");
    expect(init?.signal).toBeTruthy();
    const c: Call = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : null };
    calls.push(c);
    await later();
    return route(c);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const query = (c: Call) => Object.fromEntries(c.url.searchParams);
const expectAuth = (c: Call, token = LONG_TOKEN) => expect(c.headers.get("authorization")).toBe(`Bearer ${token}`);

const ctx = (fetchImpl: typeof fetch, config: Record<string, string> = TEAM): ProviderContext =>
  ({ fetch: hostFetch(vercel.apiHosts, fetchImpl), credential: { secret, config }, now: NOW });

const part = (settings: Record<string, string>, role: PartRef["role"] = "web"): PartRef =>
  ({ orgId: "org_b", env: "production", envLabel: "production", branch: "production", key: "web", role, settings });

const deploysOf = (items: unknown[]) => ({ deployments: items, pagination: { count: items.length, next: null, prev: null } });

// ── the descriptor ───────────────────────────────────────────────────────────

describe("vercel — descriptor", () => {
  it("is a web provider whose credential goes to api.vercel.com only", () => {
    expect(vercel.id).toBe("vercel");
    expect(vercel.status).toBe("available");
    expect(vercel.roles).toEqual(["web"]);
    expect(vercel.apiHosts).toEqual(["api.vercel.com"]);
    expect(vercel.credentialScope).toBe("org");
    expect(vercel.docsUrl).toMatch(/^https:\/\/vercel\.com\//);
  });

  it("offers the integration first, then a pasted token, each saying where it is sent", () => {
    expect(vercel.connectionMethods.map((m) => m.method)).toEqual(["install", "token"]);
    const [install, token] = vercel.connectionMethods;
    expect(install.label).toBe("Connect with Vercel");
    expect(install.requires).toEqual(["VERCEL_INTEGRATION_CLIENT_ID", "VERCEL_INTEGRATION_CLIENT_SECRET", "VERCEL_INTEGRATION_SLUG"]);
    expect(install.grants.join(" ")).toMatch(/Projects: Read/);
    expect(install.grants.join(" ")).toMatch(/Deployments: Read/);
    expect(token.label).toBe("Paste an access token");
    expect(token.requires).toBeUndefined();
    expect(token.howTo).toMatch(/no read-only token/);
    expect(token.howTo).toMatch(/expiry/);
    for (const m of vercel.connectionMethods) expect(m.howTo).toMatch(/api\.vercel\.com/);
    expect(vercel.install?.clientIdVar).toBe("VERCEL_INTEGRATION_CLIENT_ID");
    expect(vercel.install?.clientSecretVar).toBe("VERCEL_INTEGRATION_CLIENT_SECRET");
  });

  it("claims deploys and no metric, with the reason in its plan note and a one-fetch poll", () => {
    expect(vercel.capabilities).toEqual({ deploys: true, metrics: [] });
    expect(vercel.planNote).toMatch(/Observability Plus/);
    expect(vercel.pollCost).toBe(1);
  });

  it.each([
    [{ project: "web" }],
    [{ project: "prj_Qm3xT8vLp2Rk7Yw4Nf6Hs9Bd1Cz5" }],
    [{ project: "my.app_v2-x", target: "preview", branch: "feature/ticket-board" }],
    [{ project: "web", target: "production" }],
  ])("accepts part settings %j", (settings) => {
    expect(checkFields(vercel.partSettings, settings, "settings")).toEqual({ values: settings });
  });

  it.each([
    [{}, "Project is required"],
    [{ project: "My App" }, "Project is not in the expected form"],
    [{ project: "a".repeat(101) }, "Project is not in the expected form"],
    [{ project: ".." }, "Project is not in the expected form"], // a dot segment would be resolved out of the URL path
    [{ project: "web", target: "staging" }, "Deploys shown is not in the expected form"],
    [{ project: "web", target: "preview", branch: "has space" }, "Branch (previews only) is not in the expected form"],
    [{ project: "web", team: "acme" }, "settings has a key this provider does not use"],
  ])("refuses part settings %j", (settings, message) => {
    const r = checkFields(vercel.partSettings, settings, "settings");
    expect("field" in r && r.message).toBe(message);
  });

  it("checks the org config: an optional team id and URL slug", () => {
    expect(checkFields(vercel.orgConfigFields, {}, "config")).toEqual({ values: {} });
    expect(checkFields(vercel.orgConfigFields, TEAM, "config")).toEqual({ values: TEAM });
    expect("field" in checkFields(vercel.orgConfigFields, { team_id: "acme" }, "config")).toBe(true);
    expect("field" in checkFields(vercel.orgConfigFields, { team_slug: "Acme Corp" }, "config")).toBe(true);
    expect(vercel.orgConfigFields.find((f) => f.key === "team_id")?.description).toMatch(/Leave empty for a personal account/);
  });

  it("links to the project's dashboard only when the link is exact", () => {
    expect(vercel.consoleUrl({ settings: { project: "web" } }, { team_slug: "acme" })).toBe("https://vercel.com/acme/web");
    expect(vercel.consoleUrl({ settings: { project: "prj_Qm3xT8vLp2Rk7Yw4Nf6Hs9Bd1Cz5" } }, { team_slug: "acme" })).toBeNull();
    expect(vercel.consoleUrl({ settings: { project: "web" } }, { team_id: TEAM_ID })).toBeNull();
    expect(vercel.consoleUrl({ settings: {} }, {})).toBeNull();
  });
});

// ── probe ────────────────────────────────────────────────────────────────────

describe("vercel — probe", () => {
  it("reads the part's project, in the team, with the bearer token — one request", async () => {
    const { fetchImpl, calls } = stub(() => json(project));
    const r = await vercel.probe(ctx(fetchImpl), part({ project: "web" }));
    expect(r).toEqual({ ok: true, detail: "Vercel answered for project web (team acme)." });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v9/projects/web");
    expect(query(calls[0])).toEqual({ teamId: TEAM_ID });
    expectAuth(calls[0]);
  });

  it("names the project by its name when the part holds its id", async () => {
    const { fetchImpl, calls } = stub(() => json(project));
    const r = await vercel.probe(ctx(fetchImpl, {}), part({ project: "prj_Qm3xT8vLp2Rk7Yw4Nf6Hs9Bd1Cz5" }));
    expect(r).toEqual({ ok: true, detail: "Vercel answered for project web." });
    const personal = stub(() => json(project));
    expect(await vercel.probe(ctx(personal.fetchImpl, { team_slug: "andres" }), part({ project: "web" }))).toEqual({ ok: true, detail: "Vercel answered for project web." });
    expect(calls[0].url.pathname).toBe("/v9/projects/prj_Qm3xT8vLp2Rk7Yw4Nf6Hs9Bd1Cz5");
    expect(calls[0].url.search).toBe(""); // no team configured → no teamId
  });

  it("proves the token alone with no part: the user, or the team when one is set", async () => {
    const personal = stub(() => json(user));
    expect(await vercel.probe(ctx(personal.fetchImpl, {}), null)).toEqual({ ok: true, detail: "Vercel answered for andres's account." });
    expect(personal.calls.map((c) => c.url.pathname)).toEqual(["/v2/user"]);
    expectAuth(personal.calls[0]);

    const inTeam = stub(() => json(team));
    expect(await vercel.probe(ctx(inTeam.fetchImpl, { team_id: TEAM_ID }), null)).toEqual({ ok: true, detail: "Vercel answered for team acme." });
    expect(inTeam.calls[0].url.pathname).toBe(`/v2/teams/${TEAM_ID}`);
    expect(query(inTeam.calls[0])).toEqual({ teamId: TEAM_ID });
  });

  it("reports a 401 with Vercel's reason and a fixed hint, scrubbed of the token", async () => {
    const { fetchImpl } = stub(() => json({ error: { code: "forbidden", message: `Not authorized: Bearer ${LONG_TOKEN}`, invalidToken: true } }, 401));
    const r = await vercel.probe(ctx(fetchImpl), part({ project: "web" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^vercel project 401: Not authorized: Bearer \[redacted\] — the credential is not valid$/);
    noLeak(r.detail);
  });

  it("explains a 404 on the project in fixed words", async () => {
    const { fetchImpl } = stub(() => json({ error: { code: "not_found", message: "Project not found" } }, 404));
    const r = await vercel.probe(ctx(fetchImpl), part({ project: "web" }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/^vercel project 404: Project not found — no such project/);
    expect(r.detail).toMatch(/Team ID/);
    noLeak(r.detail);
  });

  it("says a token scoped to one project may not read the account", async () => {
    const { fetchImpl } = stub(() => json(forbidden, 403));
    const r = await vercel.probe(ctx(fetchImpl, {}), null);
    expect(r).toEqual({ ok: false, status: 403, detail: "vercel user 403: Not authorized — the credential cannot read the account — a token scoped to one project may not; add a part and test against its project" });
  });

  it("turns a thrown fetch into fixed words — never the error's own text", async () => {
    const boom = stub(() => { throw new Error(`connect ECONNRESET Authorization: Bearer ${LONG_TOKEN}`); });
    const r = await vercel.probe(ctx(boom.fetchImpl), part({ project: "web" }));
    expect(r).toEqual({ ok: false, detail: "vercel project: the request failed" });
    const slow = stub(() => { const e = new Error("slow"); e.name = "TimeoutError"; throw e; });
    expect(await vercel.probe(ctx(slow.fetchImpl), part({ project: "web" }))).toEqual({ ok: false, detail: "vercel project: the request timed out" });
  });

  it("refuses a part with no (or an unsafe) project without a request", async () => {
    const { fetchImpl, calls } = stub(() => json(project));
    expect(await vercel.probe(ctx(fetchImpl), part({}))).toEqual({ ok: false, detail: "this part has no valid Vercel project set" });
    expect(await vercel.probe(ctx(fetchImpl), part({ project: ".." }))).toEqual({ ok: false, detail: "this part has no valid Vercel project set" });
    expect(calls).toHaveLength(0);
  });
});

// ── poll ─────────────────────────────────────────────────────────────────────

describe("vercel — poll", () => {
  it("asks for the project's 20 newest production deploys, in the team, in ONE request", async () => {
    const { fetchImpl, calls } = stub(() => json(production));
    await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(calls).toHaveLength(1);
    expect(calls.length).toBeLessThanOrEqual(vercel.pollCost);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v7/deployments");
    expect(query(calls[0])).toEqual({ projectId: "web", limit: "20", target: "production", teamId: TEAM_ID });
    expectAuth(calls[0]);
    expect(calls[0].headers.get("accept")).toBe("application/json");
  });

  it("maps every Vercel state onto DEPLOY_STATES, skipping DELETED", async () => {
    const { fetchImpl } = stub(() => json(production));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(r.deploys.map((d) => [d.id, d.state])).toEqual([
      ["dpl_9Fq2LmN4pR8sT1vW3xY5zA6bC7dE", "queued"], // QUEUED
      ["dpl_8Eq1KlM3oQ7rS0uV2wX4yZ5aB6cD", "queued"], // INITIALIZING
      ["dpl_7Dp0JkL2nP6qR9tU1vW3xY4zA5bC", "building"], // BUILDING
      ["dpl_6Co9IjK1mO5pQ8sT0uV2wX3yZ4aB", "ready"], // READY
      ["dpl_5Bn8HiJ0lN4oP7rS9tU1vW2xY3zA", "error"], // ERROR
      ["dpl_4Am7GhI9kM3nO6qR8sT0uV1wX2yZ", "canceled"], // CANCELED
      ["dpl_3zl6FgH8jL2mN5pQ7rS9tU0vW1xY", "error"], // BLOCKED — refused to build, a person must act
      // dpl_2yk5… DELETED — skipped
      ["dpl_1xj4DeF6hJ0kL3nO5pQ7rS8tU9vW", "ready"], // a CLI deploy
    ]);
    expect(r.deploys.every((d) => d.target === "production")).toBe(true);
  });

  it("normalises a deploy: commit from meta, first line of the message, ISO times, https URLs", async () => {
    const { fetchImpl } = stub(() => json(production));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(r.deploys[0]).toEqual({
      id: "dpl_9Fq2LmN4pR8sT1vW3xY5zA6bC7dE",
      state: "queued",
      target: "production",
      sha: "4c1e9a7b2d6f8e0a3b5c7d9e1f2a4b6c8d0e2f41",
      branch: "production",
      message: "Ticket board: keep the drag slot under the pointer",
      by: "andres",
      createdAt: "2026-10-07T12:14:05.000Z",
      readyAt: null, // in flight
      url: "https://web-q7m2x9k4p-acme.vercel.app",
      inspectUrl: "https://vercel.com/acme/web/9Fq2LmN4pR8sT1vW3xY5zA6bC7dE",
    });
    const ready = r.deploys.find((d) => d.id === "dpl_6Co9IjK1mO5pQ8sT0uV2wX3yZ4aB")!;
    expect(ready.readyAt).toBe("2026-10-07T09:43:01.000Z");
    expect(ready.createdAt).toBe("2026-10-07T09:41:22.000Z");
    const failed = r.deploys.find((d) => d.id === "dpl_5Bn8HiJ0lN4oP7rS9tU1vW2xY3zA")!;
    expect(failed.readyAt).toBe("2026-10-06T22:17:03.000Z");
    expect(failed.by).toBe("sanaok");
    const cli = r.deploys.find((d) => d.id === "dpl_1xj4DeF6hJ0kL3nO5pQ7rS8tU9vW")!;
    expect([cli.sha, cli.branch, cli.message]).toEqual([null, null, null]); // no git meta: unknown, not guessed
  });

  it("reads NO metric: every web metric unavailable with the reason, nothing covered, no points", async () => {
    const { fetchImpl } = stub(() => json(production));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(r.points).toEqual([]);
    expect(r.covered).toBeNull();
    expect(r.unavailable.map((u) => u.metric)).toEqual(metricsForRole("web"));
    for (const u of r.unavailable) expect(u.reason).toBe("Vercel exposes no public usage API (its Observability Query needs Observability Plus and is undocumented)");
  });

  it("marks every service metric unavailable for a part of a role it cannot serve", async () => {
    const { fetchImpl } = stub(() => json(production));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }, "service"));
    expect(r.unavailable.map((u) => u.metric)).toEqual(["cpu", "mem_mb"]);
    expect(r.unavailable[0].reason).toMatch(/web parts only/);
    expect(r.points).toEqual([]);
  });

  it("previews of one branch: no target sent, null-target rows of that branch only", async () => {
    const { fetchImpl, calls } = stub(() => json(preview));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web", target: "preview", branch: "main" }));
    expect(query(calls[0])).toEqual({ projectId: "web", limit: "20", teamId: TEAM_ID });
    expect(r.deploys.map((d) => [d.id, d.state, d.target, d.branch])).toEqual([
      ["dpl_Pv6aBcD7eFgH8iJkL9mNoP0qRsT1", "building", "preview", "main"],
      ["dpl_Pv4yZaB5cDeF6gHiJ7kLmN8oPqR9", "ready", "preview", "main"],
      ["dpl_Pv2wXyZ3aBcD4eFgH5iJkL6mNoP7", "error", "preview", "main"],
    ]);
    expect(r.deploys[0].url).toBe("https://web-git-main-acme.vercel.app");
  });

  it("previews of every branch when no branch is set — never production or a custom environment", async () => {
    const { fetchImpl } = stub(() => json(preview));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web", target: "preview" }));
    expect(r.deploys.map((d) => d.branch)).toEqual(["main", "feature/ticket-board", "main", "main"]);
    expect(r.deploys.every((d) => d.target === "preview")).toBe(true);
  });

  it("ignores Branch for production", async () => {
    const { fetchImpl } = stub(() => json(production));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web", branch: "main" }));
    expect(r.deploys).toHaveLength(8);
  });

  it("re-checks the target per row, trusting a row with no target only to the production filter", async () => {
    const base = production.deployments[3];
    const { target: _drop, ...noTarget } = base;
    const items = [
      { ...base, uid: "dpl_prod1" },
      { ...base, uid: "dpl_preview1", target: null },
      { ...base, uid: "dpl_staging1", target: "staging" },
      { ...noTarget, uid: "dpl_untargeted" },
    ];
    const prod = stub(() => json(deploysOf(items)));
    expect((await vercel.poll(ctx(prod.fetchImpl), part({ project: "web" }))).deploys.map((d) => d.id)).toEqual(["dpl_prod1", "dpl_untargeted"]);
    const prev = stub(() => json(deploysOf(items)));
    expect((await vercel.poll(ctx(prev.fetchImpl), part({ project: "web", target: "preview" }))).deploys.map((d) => d.id)).toEqual(["dpl_preview1"]);
  });

  it("skips malformed items one by one and drops a bad field without guessing", async () => {
    const good = production.deployments[3];
    const items = [
      "not an object",
      null,
      { ...good, uid: undefined },
      { ...good, uid: "dpl bad id" },
      { ...good, uid: "dpl_unknownstate", readyState: "PENDING", state: "PENDING" },
      { ...good, uid: "dpl_nocreated", created: undefined, createdAt: undefined },
      { ...good, uid: "dpl_badcreated", created: "garbage", createdAt: "garbage" },
      { ...good, uid: "dpl_kept", meta: { githubCommitSha: "not-a-sha", githubCommitRef: "main", githubCommitMessage: "\n\n" }, url: "http://insecure.vercel.app", inspectorUrl: "javascript:alert(1)", creator: { username: 42 } },
      { ...good, uid: "dpl_stateonly", readyState: undefined, state: "READY" },
    ];
    const { fetchImpl } = stub(() => json(deploysOf(items)));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(r.deploys.map((d) => d.id)).toEqual(["dpl_kept", "dpl_stateonly"]);
    const kept = r.deploys[0];
    expect([kept.sha, kept.branch, kept.message, kept.url, kept.inspectUrl, kept.by]).toEqual([null, "main", null, null, null, null]);
    expect(r.deploys[1].state).toBe("ready");
  });

  it("reads GitLab and Bitbucket commits too, upper-case SHAs lowered", async () => {
    const good = production.deployments[3];
    const items = [
      { ...good, uid: "dpl_gitlab", meta: { gitlabCommitSha: "ABCDEF0123456789ABCDEF0123456789ABCDEF01", gitlabCommitRef: "release", gitlabCommitMessage: "GitLab: ship it\nbody" } },
      { ...good, uid: "dpl_bitbucket", created: good.created - 1000, meta: { bitbucketCommitSha: "0123456789abcdef0123456789abcdef01234567", bitbucketCommitRef: "main", bitbucketCommitMessage: "Bitbucket: ship it" } },
    ];
    const { fetchImpl } = stub(() => json(deploysOf(items)));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(r.deploys.map((d) => [d.id, d.sha, d.branch, d.message])).toEqual([
      ["dpl_gitlab", "abcdef0123456789abcdef0123456789abcdef01", "release", "GitLab: ship it"],
      ["dpl_bitbucket", "0123456789abcdef0123456789abcdef01234567", "main", "Bitbucket: ship it"],
    ]);
  });

  it("returns newest first, each id once, at most 20, whatever order the page came in", async () => {
    const good = production.deployments[3];
    const items = Array.from({ length: 25 }, (_, i) => ({ ...good, uid: `dpl_n${String(i).padStart(2, "0")}`, created: good.created + i * 60_000 }));
    const { fetchImpl } = stub(() => json(deploysOf([...items, items[24]])));
    const r = await vercel.poll(ctx(fetchImpl), part({ project: "web" }));
    expect(r.deploys).toHaveLength(20);
    expect(r.deploys[0].id).toBe("dpl_n24");
    expect(r.deploys[19].id).toBe("dpl_n05");
    expect(new Set(r.deploys.map((d) => d.id)).size).toBe(20);
  });

  it("omits teamId for a personal account", async () => {
    const { fetchImpl, calls } = stub(() => json(production));
    await vercel.poll(ctx(fetchImpl, {}), part({ project: "web" }));
    expect(query(calls[0])).toEqual({ projectId: "web", limit: "20", target: "production" });
  });

  it("throws a scrubbed HostingError on a non-2xx", async () => {
    const { fetchImpl } = stub(() => new Response(`upstream echoed Authorization: Bearer ${LONG_TOKEN} and ${encodeURIComponent(LONG_TOKEN)}`, { status: 500 }));
    const err = await vercel.poll(ctx(fetchImpl), part({ project: "web" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostingError);
    expect((err as Error).message).toMatch(/^vercel deployments 500: upstream echoed Authorization: Bearer \[redacted\]/);
    noLeak((err as Error).message);
  });

  it("says a 429 is retried and a redirect is never followed", async () => {
    const limited = stub(() => json({ error: { code: "rate_limited", message: "Rate limit exceeded" } }, 429));
    await expect(vercel.poll(ctx(limited.fetchImpl), part({ project: "web" }))).rejects.toThrow("vercel deployments 429: Rate limit exceeded — rate limited; the next poll retries");
    const moved = stub(() => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/steal" } }));
    await expect(vercel.poll(ctx(moved.fetchImpl), part({ project: "web" }))).rejects.toThrow("vercel deployments 302 — a redirect is never followed");
    expect(moved.calls).toHaveLength(1);
  });

  it("refuses a 2xx with no deployments list, or that is not JSON", async () => {
    const empty = stub(() => json({ pagination: {} }));
    await expect(vercel.poll(ctx(empty.fetchImpl), part({ project: "web" }))).rejects.toThrow("vercel deployments: the response has no deployments list");
    const html = stub(() => new Response("<html>oops</html>", { status: 200 }));
    await expect(vercel.poll(ctx(html.fetchImpl), part({ project: "web" }))).rejects.toThrow("vercel deployments: the response is not JSON");
  });

  it("turns a thrown fetch into a fixed-text HostingError", async () => {
    const { fetchImpl } = stub(() => { throw new Error(`socket hang up ${LONG_TOKEN}`); });
    const err = await vercel.poll(ctx(fetchImpl), part({ project: "web" })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostingError);
    expect((err as Error).message).toBe("vercel deployments: the request failed");
  });

  it("throws on a part with no project, without a request", async () => {
    const { fetchImpl, calls } = stub(() => json(production));
    await expect(vercel.poll(ctx(fetchImpl), part({}))).rejects.toBeInstanceOf(HostingError);
    expect(calls).toHaveLength(0);
  });

  it("cannot reach any host but api.vercel.com — vercel.com included", async () => {
    const { fetchImpl, calls } = stub(() => json(production));
    const f = hostFetch(vercel.apiHosts, fetchImpl);
    await expect(f("https://vercel.com/api/v7/deployments")).rejects.toBeInstanceOf(HostRefusedError);
    await expect(f("http://api.vercel.com/v7/deployments")).rejects.toBeInstanceOf(HostRefusedError);
    await expect(f("https://api.vercel.com.evil.example/v7/deployments")).rejects.toBeInstanceOf(HostRefusedError);
    expect(calls).toHaveLength(0);
  });
});

// ── install ──────────────────────────────────────────────────────────────────

describe("vercel — install", () => {
  const install = vercel.install!;
  const REDIRECT = "https://trov.test/hosting/vercel/callback";
  const exchange = (fetchImpl: typeof fetch, q: Record<string, string> = {}) => install.exchange({
    fetch: hostFetch(vercel.apiHosts, fetchImpl), code: CODE, clientId: "oac_Trov1234567890abcdef", clientSecret: CLIENT_SECRET, redirectUri: REDIRECT, query: q,
  });
  const tokenBody = <T extends object>(f: T) => ({ ...f, access_token: ACCESS });

  it("sends the browser to the integration's install page with the state", () => {
    const url = install.authorizeUrl({ clientId: "oac_x", redirectUri: REDIRECT, state: "s+t/a=te", vars: { VERCEL_INTEGRATION_SLUG: "trov" } });
    expect(url).toBe("https://vercel.com/integrations/trov/new?state=s%2Bt%2Fa%3Dte");
    expect(() => install.authorizeUrl({ clientId: "oac_x", redirectUri: REDIRECT, state: "s", vars: {} })).toThrow(HostingError);
    expect(() => install.authorizeUrl({ clientId: "oac_x", redirectUri: REDIRECT, state: "s", vars: { VERCEL_INTEGRATION_SLUG: "../evil" } })).toThrow("slug is not configured");
  });

  it("exchanges the code (form-encoded, no bearer) and learns the team's name and slug — 2 requests", async () => {
    const { fetchImpl, calls } = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(tokenBody(tokenTeam)) : json(team)));
    const grant = await exchange(fetchImpl, { configurationId: "icfg_ignoredWhenTheBodyHasOne", teamId: TEAM_ID, next: "https://vercel.com/acme/~/integrations" });
    expect(calls).toHaveLength(2);
    const [tok, acct] = calls;
    expect(tok.method).toBe("POST");
    expect(tok.url.pathname).toBe("/v2/oauth/access_token");
    expect(tok.url.search).toBe("");
    expect(tok.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(tok.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(new URLSearchParams(tok.body ?? ""))).toEqual({ client_id: "oac_Trov1234567890abcdef", client_secret: CLIENT_SECRET, code: CODE, redirect_uri: REDIRECT });
    expect(acct.method).toBe("GET");
    expect(acct.url.pathname).toBe(`/v2/teams/${TEAM_ID}`);
    expect(query(acct)).toEqual({ teamId: TEAM_ID });
    expectAuth(acct, ACCESS);
    expect(grant).toEqual({
      accessToken: ACCESS,
      externalId: "icfg_Rt5uV6wX7yZ8aB9cD0eF1gH2",
      accountId: TEAM_ID,
      accountLabel: "Acme Learning",
      config: { team_id: TEAM_ID, team_slug: "acme" },
    });
  });

  it("a personal account: the user id, the username as label and URL slug, no team", async () => {
    const { fetchImpl, calls } = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(tokenBody(tokenPersonal)) : json(user)));
    const grant = await exchange(fetchImpl);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v2/oauth/access_token", "/v2/user"]);
    expect(calls[1].url.search).toBe("");
    expect(grant).toEqual({
      accessToken: ACCESS, externalId: "icfg_Sm4nO5pQ6rS7tU8vW9xY0zA1", accountId: "Xk2mP9qL4rT7vW1yZ3bN5cD8", accountLabel: "andres", config: { team_slug: "andres" },
    });
  });

  it("NEVER takes the installation id from the URL alone: the exchange's own id wins, and the callback's is only a candidate Vercel must confirm", async () => {
    // The exchange names its installation: the callback's `configurationId` is ignored — no confirming read.
    const named = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(tokenBody(tokenTeam)) : json(team)));
    expect((await exchange(named.fetchImpl, { configurationId: "icfg_SomeoneElses1" })).externalId).toBe(tokenTeam.installation_id);
    expect(named.calls.map((c) => c.url.pathname)).toEqual(["/v2/oauth/access_token", `/v2/teams/${TEAM_ID}`]);

    // It does not: ONE GET of the candidate, in the grant's team, with the NEW token — a 200 for exactly that id is a yes.
    const { installation_id: _gone, ...noInstall } = tokenBody(tokenTeam);
    const ID = configuration.id;
    const confirmed = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(noInstall)
      : c.url.pathname.startsWith("/v1/integrations/configuration/") ? json(configuration) : json(team)));
    expect((await exchange(confirmed.fetchImpl, { configurationId: ID })).externalId).toBe(ID);
    expect(confirmed.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual([
      "POST /v2/oauth/access_token", `GET /v1/integrations/configuration/${ID}`, `GET /v2/teams/${TEAM_ID}`,
    ]);
    const [, check] = confirmed.calls;
    expect(query(check)).toEqual({ teamId: TEAM_ID });
    expectAuth(check, ACCESS);

    // Anything else stores null — the grant itself still stands.
    for (const [why, answer] of [
      ["Vercel does not know it (404)", () => json(forbidden, 404)],
      ["the token may not read it (403)", () => json(forbidden, 403)],
      ["the body names ANOTHER configuration", () => json({ ...configuration, id: "icfg_AnotherOne123" })],
      ["the body names none", () => json({})],
      ["a redirect (never followed)", () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } })],
      ["the read throws", () => { throw new Error("boom"); }],
    ] as [string, () => Response][]) {
      const s = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(noInstall)
        : c.url.pathname.startsWith("/v1/integrations/configuration/") ? answer() : json(team)));
      const grant = await exchange(s.fetchImpl, { configurationId: ID });
      expect(grant.externalId, why).toBeNull();
      expect(grant.accessToken, why).toBe(ACCESS);
    }
    // A candidate that is not an id at all is never sent anywhere.
    const bare = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(noInstall) : json(team)));
    expect((await exchange(bare.fetchImpl, { configurationId: "not an id!" })).externalId).toBeNull();
    expect(bare.calls.map((c) => c.url.pathname)).toEqual(["/v2/oauth/access_token", `/v2/teams/${TEAM_ID}`]);
    // A personal account: the read carries no team.
    const { installation_id: _none, ...personalNoInstall } = tokenBody(tokenPersonal);
    const personal = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(personalNoInstall)
      : c.url.pathname.startsWith("/v1/integrations/configuration/") ? json({ ...configuration, id: "icfg_Personal123" }) : json(user)));
    expect((await exchange(personal.fetchImpl, { configurationId: "icfg_Personal123" })).externalId).toBe("icfg_Personal123");
    expect(personal.calls[1].url.search).toBe("");
  });

  it("names where the grant is managed: the team's integrations page when the install told Trov the team, else the dashboard's; a token's page", () => {
    expect(vercel.manageUrl!(TEAM, "install")).toBe("https://vercel.com/acme/~/integrations");
    expect(vercel.manageUrl!({ team_slug: "andres" }, "install")).toBe("https://vercel.com/dashboard/integrations");
    expect(vercel.manageUrl!({ team_id: TEAM_ID, team_slug: "../evil" }, "install")).toBe("https://vercel.com/dashboard/integrations");
    expect(vercel.manageUrl!(TEAM, "token")).toBe("https://vercel.com/account/tokens");
    expect(vercel.manageUrl!(TEAM, "oauth")).toBeNull();
  });

  it("a probe refused with 401 says so in its status — Test connection ends an installed connection on it", async () => {
    const { fetchImpl } = stub(() => json({ error: { code: "forbidden", message: `bad ${LONG_TOKEN}` } }, 401));
    const r = await vercel.probe(ctx(fetchImpl), null);
    expect(r).toMatchObject({ ok: false, status: 401 });
    noLeak(r.detail);
    const thrown = stub(() => { throw new Error("down"); });
    expect(await vercel.probe(ctx(thrown.fetchImpl), null)).toEqual({ ok: false, detail: "vercel team: the request failed" });
  });

  it("keeps the grant when the account read fails — the label is only a label", async () => {
    const { fetchImpl } = stub((c) => (c.url.pathname === "/v2/oauth/access_token" ? json(tokenBody(tokenTeam)) : json(forbidden, 403)));
    const grant = await exchange(fetchImpl);
    expect(grant.accountLabel).toBeNull();
    expect(grant.config).toEqual({ team_id: TEAM_ID });
    const thrown = stub((c) => { if (c.url.pathname === "/v2/oauth/access_token") return json(tokenBody(tokenTeam)); throw new Error("boom"); });
    expect((await exchange(thrown.fetchImpl)).accessToken).toBe(ACCESS);
  });

  it.each([
    ["no access token", { ...tokenTeam, access_token: "" }],
    ["a token with whitespace", { ...tokenTeam, access_token: "two words" }],
    ["another token type", { ...tokenTeam, access_token: "x", token_type: "mac" }],
    ["a malformed team id", { ...tokenTeam, access_token: "x", team_id: "acme" }],
    ["a malformed installation id", { ...tokenTeam, access_token: "x", installation_id: { id: 1 } }],
  ])("refuses a response with %s in fixed words", async (_what, body) => {
    const { fetchImpl, calls } = stub(() => json(body));
    await expect(exchange(fetchImpl)).rejects.toThrow("vercel token exchange: the response is not in the expected form");
    expect(calls).toHaveLength(1);
  });

  it("refuses a failed exchange with the secret and the code scrubbed", async () => {
    const { fetchImpl } = stub(() => json({ error: { message: `invalid client_secret ${CLIENT_SECRET} for code ${CODE}` } }, 400));
    const err = await exchange(fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostingError);
    expect((err as Error).message).toMatch(/^vercel token exchange 400: invalid client_secret \[redacted\] for code \[redacted\]/);
    noLeak((err as Error).message, CLIENT_SECRET, CODE);
  });

  it("revokes the installation with its own token, in its team; a 404 means already gone", async () => {
    for (const status of [204, 200, 404]) {
      const { fetchImpl, calls } = stub(() => new Response(null, { status }));
      await install.revoke!({ fetch: hostFetch(vercel.apiHosts, fetchImpl), secret, externalId: "icfg_Rt5uV6wX7yZ8aB9cD0eF1gH2", config: TEAM });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("DELETE");
      expect(calls[0].url.pathname).toBe("/v1/integrations/configuration/icfg_Rt5uV6wX7yZ8aB9cD0eF1gH2");
      expect(query(calls[0])).toEqual({ teamId: TEAM_ID });
      expectAuth(calls[0]);
    }
  });

  it("revoke: no installation id → no request; any other refusal throws scrubbed", async () => {
    const none = stub(() => new Response(null, { status: 204 }));
    await install.revoke!({ fetch: hostFetch(vercel.apiHosts, none.fetchImpl), secret, externalId: null, config: {} });
    expect(none.calls).toHaveLength(0);
    const { fetchImpl } = stub(() => json({ error: { message: `token ${LONG_TOKEN} lacks scope` } }, 403));
    const err = await install.revoke!({ fetch: hostFetch(vercel.apiHosts, fetchImpl), secret, externalId: "icfg_x", config: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostingError);
    expect((err as Error).message).toMatch(/^vercel uninstall 403: token \[redacted\] lacks scope/);
    noLeak((err as Error).message);
  });
});

// ── the uninstall webhook ────────────────────────────────────────────────────

describe("vercel — uninstall webhook", () => {
  const hook = vercel.install!.webhook!;
  const RAW = JSON.stringify(removed);
  async function sign(body: string, key: string): Promise<string> {
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
    return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const headers = (sig: string | null) => new Headers(sig === null ? {} : { "x-vercel-signature": sig });

  it("verifies the hex HMAC-SHA1 of the raw body under the client secret", async () => {
    const sig = await sign(RAW, CLIENT_SECRET);
    expect(sig).toMatch(/^[0-9a-f]{40}$/);
    expect(await hook.verify({ rawBody: RAW, headers: headers(sig), clientSecret: CLIENT_SECRET })).toBe(true);
    expect(await hook.verify({ rawBody: RAW, headers: headers(sig.toUpperCase()), clientSecret: CLIENT_SECRET })).toBe(true);
  });

  it.each([
    ["a tampered body", async () => ({ rawBody: RAW.replace("icfg_", "icfg_X"), sig: await sign(RAW, CLIENT_SECRET), key: CLIENT_SECRET })],
    ["another secret", async () => ({ rawBody: RAW, sig: await sign(RAW, "not-the-secret"), key: CLIENT_SECRET })],
    ["no header", async () => ({ rawBody: RAW, sig: null, key: CLIENT_SECRET })],
    ["a prefixed header", async () => ({ rawBody: RAW, sig: `sha1=${await sign(RAW, CLIENT_SECRET)}`, key: CLIENT_SECRET })],
    ["a non-hex header", async () => ({ rawBody: RAW, sig: "z".repeat(40), key: CLIENT_SECRET })],
    ["an empty secret", async () => ({ rawBody: RAW, sig: await sign(RAW, CLIENT_SECRET), key: "" })],
  ])("refuses %s", async (_what, make) => {
    const { rawBody, sig, key } = await make();
    expect(await hook.verify({ rawBody, headers: headers(sig), clientSecret: key })).toBe(false);
  });

  it("names the removed installation, from either payload shape", () => {
    expect(hook.removedExternalId(removed)).toBe("icfg_Rt5uV6wX7yZ8aB9cD0eF1gH2");
    expect(hook.removedExternalId({ type: "integration-configuration.removed", payload: { configurationId: "icfg_Flat123" } })).toBe("icfg_Flat123");
  });

  it("ignores every other event and anything malformed", () => {
    expect(hook.removedExternalId({ ...removed, type: "deployment.created" })).toBeNull();
    expect(hook.removedExternalId({ type: "integration-configuration.removed", payload: {} })).toBeNull();
    expect(hook.removedExternalId({ type: "integration-configuration.removed", payload: { configuration: { id: "has spaces" } } })).toBeNull();
    expect(hook.removedExternalId(null)).toBeNull();
    expect(hook.removedExternalId("integration-configuration.removed")).toBeNull();
  });
});
