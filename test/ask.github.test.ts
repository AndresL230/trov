// Ask Trov's GitHub tools (src/ai/ask/github.ts, src/repo/ask-github.ts; docs/architecture/ask.md › GitHub): read-only
// lookups in the org's CONNECTED repositories, through the org's credential — against real D1, with the model AND
// GitHub stubbed at the Response level (never the network). The real transport runs: the stored token is resolved by
// `resolveGithubCredential`, each person's access is asked of GitHub, and every request goes through `githubFetch`.
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { ASK_GITHUB_REQUESTS_MAX, ASK_GITHUB_TEXT_MAX } from "@shared/ai-ask-core";
import { setSecret } from "../src/data/secrets";
import { askGithubTransport, scopedSearch } from "../src/repo/ask-github";
import { encodePath } from "../src/ai/ask/github";
import { offeredTools } from "../src/ai/ask/tools";
import { contextBlock } from "../src/ai/ask/prompt";
import { all, first, run } from "./helpers/db";
import { AI_ROUTES, type AiSettings } from "@shared/ai";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, tenantCtx } from "./helpers/tenant";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, withAsk, type SentRequest } from "./helpers/ask";

const ME = "ask-gh"; // a plain member with a linked GitHub identity (login = handle): what they read is what THEIR GitHub account can
const TOKEN = "ghp_asktest_TOKEN_0123456789abcdefghijkl";
const PRIMARY = "SaplingLearn/sapling";
const SECOND = "SaplingLearn/docs-site";
const final = "\n<trov-meta>{\"title\": \"Code check\", \"followups\": []}</trov-meta>";

async function connect(o: { switchOn?: boolean } = {}): Promise<void> {
  const at = "2026-01-01T00:00:00Z";
  await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_gh1', ?, ?, 1, 0, ?, 'test')`, ORG_A, PRIMARY, at);
  await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_gh2', ?, ?, 0, 0, ?, 'test')`, ORG_A, SECOND, at);
  await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, legacy_hook, created_at, created_by) VALUES ('hook_gh3', ?, 'OtherCo/secret', 1, 0, ?, 'test')`, ORG_B, at);
  await setSecret(await tenantCtx("AndresL230"), "github_token", "", TOKEN);
  // The admin's switch (0076, off by default): on, unless a test is about it being off.
  await run(env.DB, `UPDATE orgs SET ai_chat_github = ? WHERE id = ?`, o.switchOn === false ? 0 : 1, ORG_A);
}

interface GhCall { url: string; method: string; auth: string | null; accept: string | null }
const PERMISSION = /^\/repos\/[^/]+\/[^/]+\/collaborators\/([^/]+)\/permission$/;
/** A scripted GitHub: `answer(url)` per request, every content request recorded in `calls`. The access check
 *  (`/collaborators/<login>/permission`) is answered by `perm` (default: read) and recorded apart, in `checks`. */
function fakeGithub(
  answer: (url: URL, n: number) => Response | Promise<Response>,
  perm: (login: string) => Response | Promise<Response> = () => json({ permission: "read", role_name: "read" }),
) {
  const calls: GhCall[] = [];
  const checks: GhCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const h = new Headers(init?.headers);
    const rec = { url: url.href, method: init?.method ?? "GET", auth: h.get("authorization"), accept: h.get("accept") };
    const m = PERMISSION.exec(url.pathname);
    if (m) { checks.push(rec); return perm(decodeURIComponent(m[1])); }
    calls.push(rec);
    return answer(url, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls, checks };
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const fileBody = (path: string, text: string) => ({ type: "file", path, name: path.split("/").at(-1), size: text.length, sha: "abc123", encoding: "base64", content: b64(text), html_url: `https://github.com/${PRIMARY}/blob/main/${path}` });

/** Every tool_result block of a model request. */
const resultsOf = (req: SentRequest) => (req.messages.at(-1)!.content as { type: string; content: unknown; is_error?: boolean }[]).filter((b) => b.type === "tool_result");

let logged: string[] = [];
afterEach(() => { vi.restoreAllMocks(); logged = []; });
function captureLogs(): void {
  for (const m of ["error", "log", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); });
}

describe("the admin's switch (orgs.ai_chat_github, 0076): off by default", () => {
  it("off: no GitHub tool is offered, a call to one reaches no GitHub, and the model is told an admin can turn it on", async () => {
    expect((await first<{ v: number }>(env.DB, `SELECT ai_chat_github AS v FROM orgs WHERE id = ?`, ORG_A))?.v).toBe(0); // the default
    await connect({ switchOn: false });
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json({}));
    const model = fakeModel([
      [{ type: "tool_use", name: "github_read", input: { path: "README.md" } }],
      [{ type: "text", text: `Not available.${final}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "What is in the README?" }));
    expect(r.status).toBe(200);
    expect(model.sent[0].tools.map((t) => t.name).filter((n) => n.startsWith("github_"))).toEqual([]);
    expect(model.sent[0].system[1].text).toContain("GitHub lookups are off for this organization");
    expect(model.sent[0].system[1].text).toContain("Org settings › AI");
    expect(resultsOf(model.sent[1])[0]).toMatchObject({ is_error: true });
    expect(String(resultsOf(model.sent[1])[0].content)).toContain("unknown_tool");
    expect(gh.calls).toEqual([]);
    expect(gh.checks).toEqual([]);
  });

  it("only an admin sets it (cookie route, audited); a member is 403 and a bearer is refused", async () => {
    const admin = await cookieFor(FIXTURE_ADMIN);
    const on = await call<AiSettings>("PUT", `${BASE}${AI_ROUTES.settings}`, admin, { chatGithub: true });
    expect(on.status).toBe(200);
    expect(on.json).toMatchObject({ chatGithub: true, chatAuto: true, enabled: true }); // the other switches are untouched
    expect(await all(env.DB, `SELECT actor, action, detail FROM org_admin_audit WHERE org_id = ? AND action = 'org.ai_chat_github'`, ORG_A))
      .toEqual([{ actor: FIXTURE_ADMIN, action: "org.ai_chat_github", detail: JSON.stringify({ chatGithub: true }) }]);
    expect(await call("PUT", `${BASE}${AI_ROUTES.settings}`, await cookieFor(ME), { chatGithub: false })).toMatchObject({ status: 403, json: { error: "forbidden" } });
    expect((await call("PUT", `${BASE}${AI_ROUTES.settings}`, admin, { chatGithub: false }, KEYED, { authorization: "Bearer trov_mcp_x" })).status).toBe(403);
    expect((await first<{ v: number }>(env.DB, `SELECT ai_chat_github AS v FROM orgs WHERE id = ?`, ORG_A))?.v).toBe(1);
    // Any member reads it.
    expect((await call<AiSettings>("GET", `${BASE}${AI_ROUTES.settings}`, await cookieFor(ME))).json.chatGithub).toBe(true);
  });
});

describe("each person's own GitHub access", () => {
  const readOnce = () => fakeModel([[{ type: "tool_use", name: "github_read", input: { path: "README.md" } }], [{ type: "text", text: `Done.${final}` }]]);

  it("a member with no linked GitHub (Google only) is told to link it — and GitHub is never asked", async () => {
    await connect();
    const cookie = await cookieFor("ask-google", { github: false });
    const gh = fakeGithub(() => json(fileBody("README.md", "TOP-SECRET-CONTENT")));
    const model = readOnce();
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "README?" }));
    const res = resultsOf(model.sent[1])[0];
    expect(res.is_error).toBe(true);
    const body = JSON.parse(String(res.content));
    expect(body.code).toBe("not_linked");
    expect(body.error).toContain("Link GitHub in Settings");
    expect(gh.calls).toEqual([]);
    expect(gh.checks).toEqual([]);
    expect(eventsOf(r.events, "activity").find((a) => a.state === "done").resultLine).toBe("GitHub not linked");
  });

  it("a linked member without access to the repository is refused, and nothing of it is read", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json(fileBody("README.md", "TOP-SECRET-CONTENT")), () => json({ permission: "none", role_name: "none" }));
    const model = readOnce();
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "README?" }));
    const body = JSON.parse(String(resultsOf(model.sent[1])[0].content));
    expect(body.code).toBe("no_access");
    expect(body.error).toContain(`You don't have access to ${PRIMARY} on GitHub (as ${ME})`);
    expect(gh.checks.map((c) => new URL(c.url).pathname)).toEqual([`/repos/${PRIMARY}/collaborators/${ME}/permission`]);
    expect(gh.checks[0].method).toBe("GET");
    expect(gh.calls).toEqual([]); // no content request at all
    expect(JSON.stringify(model.sent)).not.toContain("TOP-SECRET-CONTENT");
    expect(eventsOf(r.events, "activity").find((a) => a.state === "done").resultLine).toBe("No access on GitHub");
  });

  it("an access check that fails or times out denies — never allows", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    for (const perm of [() => new Response("boom", { status: 500 }), () => { throw new DOMException("timed out", "TimeoutError"); }]) {
      const gh = fakeGithub(() => json(fileBody("README.md", "TOP-SECRET-CONTENT")), perm as () => Response);
      const model = readOnce();
      const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "README?" }));
      expect(r.status).toBe(200);
      expect(eventsOf(r.events, "done")).toHaveLength(1);
      const body = JSON.parse(String(resultsOf(model.sent[1])[0].content));
      expect(body.code).toBe("access_unknown");
      expect(body.error).toContain("so nothing of it was read");
      expect(gh.calls).toEqual([]);
    }
  });

  it("checked once per repository per answer, outside the lookup cap; a second repository is checked on its own", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json(fileBody("a.md", "a")));
    const model = fakeModel([
      [
        { type: "tool_use", name: "github_read", input: { path: "a.md" } },
        { type: "tool_use", name: "github_read", input: { path: "b.md" } },
        { type: "tool_use", name: "github_read", input: { repo: SECOND, path: "c.md" } },
      ],
      [{ type: "text", text: `Done.${final}` }],
    ]);
    await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Files?" }));
    expect(gh.calls).toHaveLength(3);
    expect(gh.checks.map((c) => new URL(c.url).pathname)).toEqual([`/repos/${PRIMARY}/collaborators/${ME}/permission`, `/repos/${SECOND}/collaborators/${ME}/permission`]);
    expect(gh.checks.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true); // the org's credential asks, through the resolver
  });
});

describe("a connected repository", () => {
  it("reads a file through the org's credential, fenced, and the step says so — for a plain member", async () => {
    await connect();
    captureLogs();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub((url) => (url.pathname.endsWith("/contents/src/index.ts") ? json(fileBody("src/index.ts", "export const answer = 42;\n")) : json({ message: "Not Found" }, 404)));
    const model = fakeModel([
      [{ type: "text", text: "Looking." }, { type: "tool_use", name: "github_read", input: { path: "src/index.ts" } }],
      [{ type: "text", text: `It exports \`answer\`.${final}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "What does src/index.ts export?" }));
    expect(r.status).toBe(200);
    expect(eventsOf(r.events, "done")).toHaveLength(1);

    // Offered, with the repositories named in the context block (the system's second part).
    const offered = model.sent[0].tools.map((t) => t.name);
    for (const n of ["github_read", "github_search_code", "github_pull_request", "github_issue", "github_commit", "github_list", "github_ci"]) expect(offered).toContain(n);
    expect(model.sent[0].system[1].text).toContain(`${PRIMARY} (primary), ${SECOND}`);

    // ONE read-only request, to api.github.com under that repository, with the org's token.
    expect(gh.calls).toEqual([{ url: `https://api.github.com/repos/${PRIMARY}/contents/src/index.ts`, method: "GET", auth: `Bearer ${TOKEN}`, accept: "application/vnd.github+json" }]);

    // The step, and the result back to the model inside the turn's fence.
    const acts = eventsOf(r.events, "activity");
    expect(acts[0]).toMatchObject({ step: 1, tool: "github_read", icon: "read", label: "Opened 'src/index.ts' on GitHub", state: "run" });
    expect(acts[1]).toMatchObject({ step: 1, state: "done" });
    const res = resultsOf(model.sent[1])[0];
    expect(res.is_error).toBeUndefined();
    expect(String(res.content)).toMatch(/^<<trov-data [0-9a-f]{18}>> Result of github_read\n/);
    expect(String(res.content)).toContain("export const answer = 42;");

    // The token is nowhere but the Authorization header: not the model's requests, the stream, the logs or the rows.
    expect(JSON.stringify(model.sent)).not.toContain(TOKEN);
    expect(JSON.stringify(r.events)).not.toContain(TOKEN);
    expect(logged.join("\n")).not.toContain(TOKEN);
    const stored = await first<{ n: number; total: number }>(env.DB,
      `SELECT SUM(content_json LIKE ? OR cites_json LIKE ?) AS n, COUNT(*) AS total FROM chat_messages WHERE org_id = ?`, `%${TOKEN}%`, `%${TOKEN}%`, ORG_A);
    expect(stored?.total).toBe(2);
    expect(stored?.n).toBe(0);
  });

  it("reopening the conversation reads the stored answer — GitHub is not asked again", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json(fileBody("README.md", "# Sapling\n")));
    const model = fakeModel([[{ type: "tool_use", name: "github_read", input: { path: "README.md" } }], [{ type: "text", text: `A readme.${final}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Readme?" }));
    const threadId = eventsOf(r.events, "thread")[0].id;
    expect(gh.calls).toHaveLength(1);
    const detail = await withAsk({ githubFetch: gh.fetchImpl }, () => call("GET", `${BASE}/ask/threads/${threadId}`, cookie));
    expect(detail.status).toBe(200);
    expect(detail.text).toContain("Opened 'README.md' on GitHub"); // the step is kept with the answer…
    expect(gh.calls).toHaveLength(1); // …and nothing re-read GitHub to draw it
  });

  it("another repository of the org is read when named; a PR of the PRIMARY links as pr:N, a list counts its rows", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub((url) => {
      if (url.pathname === `/repos/${PRIMARY}/pulls/7`) return json({ number: 7, title: "Add the gate", state: "open", user: { login: "AndresL230" }, head: { ref: "feat/gate", sha: "f00" }, base: { ref: "main" }, body: "Why.", changed_files: 1, html_url: "https://github.com/x/y/pull/7" });
      if (url.pathname === `/repos/${PRIMARY}/pulls/7/files`) return json([{ filename: "src/gate.ts", status: "added", additions: 3, deletions: 0, patch: "@@ +1,3 @@\n+a\n+b\n+c" }]);
      if (url.pathname === `/repos/${SECOND}/releases`) return json([{ tag_name: "v1.2.0", name: "1.2", published_at: "2026-10-01T00:00:00Z", author: { login: "meilin" }, body: "Notes" }, { tag_name: "v1.1.0" }]);
      return json({ message: "Not Found" }, 404);
    });
    const model = fakeModel([
      [{ type: "tool_use", name: "github_pull_request", input: { number: 7 } }, { type: "tool_use", name: "github_list", input: { repo: "saplinglearn/DOCS-SITE", what: "releases" } }],
      [{ type: "text", text: `[[pr:7]] adds the gate; docs-site is on v1.2.0.${final}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "PR 7, and the docs site's latest release?" }));
    expect(gh.calls.map((c) => new URL(c.url).pathname)).toEqual([`/repos/${PRIMARY}/pulls/7`, `/repos/${PRIMARY}/pulls/7/files`, `/repos/${SECOND}/releases`]);
    const [pr, list] = resultsOf(model.sent[1]).map((x) => String(x.content));
    expect(pr).toContain("\"title\":\"Add the gate\"");
    expect(pr).toContain("src/gate.ts");
    expect(list).toContain("v1.2.0");
    const acts = eventsOf(r.events, "activity").filter((a) => a.state === "done");
    expect(acts[0].results).toEqual(["pr:7"]);
    expect(acts[1].resultLine).toBe("2 results");
    expect(eventsOf(r.events, "activity")[2].label).toBe("Listed recent releases in saplinglearn/DOCS-SITE on GitHub");
  });

  it("CI on the default branch: the repository, then its check runs and combined status", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub((url) => {
      if (url.pathname === `/repos/${PRIMARY}`) return json({ default_branch: "main" });
      if (url.pathname === `/repos/${PRIMARY}/commits/main/check-runs`) return json({ total_count: 2, check_runs: [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "failure" }] });
      if (url.pathname === `/repos/${PRIMARY}/commits/main/status`) return json({ state: "failure", sha: "abc", statuses: [{ context: "canopy/deploy", state: "success" }] });
      return json({}, 404);
    });
    const model = fakeModel([[{ type: "tool_use", name: "github_ci", input: {} }], [{ type: "text", text: `Lint fails.${final}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Is main green?" }));
    expect(gh.calls).toHaveLength(3);
    const out = String(resultsOf(model.sent[1])[0].content);
    expect(out).toContain("\"passing\":1");
    expect(out).toContain("\"failing\":1");
    expect(eventsOf(r.events, "activity")[0]).toMatchObject({ tool: "github_ci", icon: "ci", label: "Checked CI on GitHub" });
  });
});

describe("only the org's connected repositories", () => {
  it("another org's repository, or any other, is refused as not connected — and GitHub is never asked", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json(fileBody("x", "secret")));
    const model = fakeModel([
      [
        { type: "tool_use", name: "github_read", input: { repo: "OtherCo/secret", path: "x" } },
        { type: "tool_use", name: "github_search_code", input: { repo: "torvalds/linux", q: "kmalloc" } },
        { type: "tool_use", name: "github_read", input: { repo: "https://github.com/OtherCo/secret.git", path: "x" } },
      ],
      [{ type: "text", text: `Those are not connected.${final}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Read OtherCo's code" }));
    expect(r.status).toBe(200);
    expect(gh.calls).toEqual([]);
    const results = resultsOf(model.sent[1]);
    expect(results).toHaveLength(3);
    for (const res of results) {
      expect(res.is_error).toBe(true);
      const body = JSON.parse(String(res.content));
      expect(body.code).toBe("not_connected");
      expect(body.error).toContain(`Connected: ${PRIMARY}, ${SECOND}`);
    }
    expect(eventsOf(r.events, "activity").filter((a) => a.state === "done").map((a) => a.resultLine)).toEqual(["Not connected", "Not connected", "Not connected"]);
  });

  it("an org with no connected repository is offered no GitHub tool", async () => {
    await setSecret(await tenantCtx("AndresL230"), "github_token", "", TOKEN);
    await run(env.DB, `UPDATE orgs SET ai_chat_github = 1 WHERE id = ?`, ORG_A); // switched on, but nothing to read
    const cookie = await cookieFor(ME);
    const model = fakeModel([[{ type: "text", text: `Hi.${final}` }]]);
    await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "Hi" }));
    expect(model.sent[0].tools.map((t) => t.name).filter((n) => n.startsWith("github_"))).toEqual([]);
    expect(model.sent[0].system[1].text).not.toContain("Connected GitHub repositories");
  });

  it("the transport checks the org's rows again, and no path climbs out of /repos/<repo>/", async () => {
    await connect();
    await cookieFor(ME); // the person and their linked GitHub identity
    const gh = fakeGithub(() => json({}));
    const t = askGithubTransport(KEYED, await tenantCtx(ME, "member"), { fetchImpl: gh.fetchImpl });
    expect(await t.get("OtherCo/secret", { path: "" })).toMatchObject({ ok: false, code: "not_connected" });
    expect(await t.get(PRIMARY, { path: "../../OtherCo/secret/contents" })).toMatchObject({ ok: false, code: "bad_request" });
    // The URL parser reads `%2e%2e` as `..` too: the check on the PARSED path refuses it.
    expect(await t.get(PRIMARY, { path: "contents/%2e%2e/%2e%2e/%2e%2e/OtherCo/secret" })).toMatchObject({ ok: false, code: "bad_request" });
    expect(gh.calls).toEqual([]);
    expect(await t.get(PRIMARY, { path: "contents/README.md" })).toMatchObject({ ok: true });
    expect(gh.calls.map((c) => c.url)).toEqual([`https://api.github.com/repos/${PRIMARY}/contents/README.md`]);
    // The tools' own encoding: a dot segment is refused; a literal `%2e` is encoded, never read as a dot.
    expect(() => encodePath("src/../../etc")).toThrow();
    expect(encodePath("src/a b/#c.ts")).toBe("src/a%20b/%23c.ts");
    expect(encodePath("%2e%2e/x")).toBe("%252e%252e/x");
    // The code search is scoped to the one repository, whatever qualifiers the words carry.
    expect(scopedSearch("kmalloc repo:torvalds/linux org:OtherCo -repo:x user:me", PRIMARY)).toBe(`kmalloc repo:${PRIMARY}`);
  });

  it("Fast (the index) is never offered the GitHub tools", async () => {
    const ctx = await tenantCtx(ME, "member");
    expect(offeredTools(ctx, "fast", { github: true }).map((t) => t.name).filter((n) => n.startsWith("github_"))).toEqual([]);
    expect(offeredTools(ctx, "smart", { github: true }).map((t) => t.name).filter((n) => n.startsWith("github_"))).toHaveLength(7);
    expect(offeredTools(ctx, "smart").map((t) => t.name).filter((n) => n.startsWith("github_"))).toEqual([]);
    expect(contextBlock({ orgName: "A", orgSlug: "a", handle: "h", role: "member", mode: "smart", today: "2026-10-17", instructions: "", autoMode: false, githubRepos: [{ name: PRIMARY, primary: true }] }))
      .toContain(`Connected GitHub repositories`);
  });
});

describe("the AI switch, failures and limits", () => {
  it("the org's AI switch off: no model call, no GitHub call", async () => {
    await connect();
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json({}));
    const model = fakeModel([[{ type: "tool_use", name: "github_read", input: { path: "x" } }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Read x" }));
    expect(eventsOf(r.events, "error")[0].code).toBe("off");
    expect(model.sent).toHaveLength(0);
    expect(gh.calls).toEqual([]);
  });

  it("GitHub failing — a 500, a timeout, a 404, a rate limit, no credential — is an honest tool error, and the answer still finishes", async () => {
    await connect();
    captureLogs();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub((url) => {
      if (url.pathname.endsWith("/pulls/1")) return new Response("boom", { status: 500 });
      if (url.pathname.endsWith("/pulls/2")) throw new DOMException("The operation timed out.", "TimeoutError");
      if (url.pathname.endsWith("/pulls/3")) return json({ message: "Not Found" }, 404);
      return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" });
    });
    const model = fakeModel([
      [1, 2, 3, 4].map((n) => ({ type: "tool_use" as const, name: "github_pull_request", input: { number: n } })),
      [{ type: "text", text: `GitHub did not answer.${final}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "PRs 1-4?" }));
    expect(r.status).toBe(200);
    expect(eventsOf(r.events, "done")).toHaveLength(1);
    expect(eventsOf(r.events, "error")).toEqual([]);
    const bodies = resultsOf(model.sent[1]).map((x) => { expect(x.is_error).toBe(true); return JSON.parse(String(x.content)); });
    expect(bodies.map((b) => b.code)).toEqual(["failed", "timeout", "not_found", "rate_limited"]);
    expect(bodies[0].error).toBe("GitHub answered with an error (500).");
    expect(bodies[1].error).toBe("GitHub did not answer within 8 seconds.");
    expect(JSON.stringify(bodies)).not.toContain("boom"); // GitHub's own body is never relayed as fact
    expect(logged.join("\n")).not.toContain(TOKEN);

    // No credential at all: the org's token removed → `no_credential`, and still no 500.
    await run(env.DB, `DELETE FROM org_secrets WHERE org_id = ?`, ORG_A).catch(() => undefined);
    const model2 = fakeModel([[{ type: "tool_use", name: "github_read", input: { path: "x" } }], [{ type: "text", text: `Not connected.${final}` }]]);
    const gh2 = fakeGithub(() => json({}));
    const r2 = await withAsk({ fetchImpl: model2.fetchImpl, githubFetch: gh2.fetchImpl }, () => ask(cookie, { text: "x?" }));
    expect(r2.status).toBe(200);
    expect(JSON.parse(String(resultsOf(model2.sent[1])[0].content)).code).toBe("no_credential");
    expect(gh2.calls).toEqual([]);
  });

  it("an upstream that echoes the Authorization header back: the token is scrubbed before anything reads it", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub(() => json({ number: 9, title: "x", body: "echo: Bearer " + TOKEN, user: { login: "u" } }));
    const model = fakeModel([[{ type: "tool_use", name: "github_issue", input: { number: 9 } }], [{ type: "text", text: `Ok.${final}` }]]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Issue 9?" }));
    expect(JSON.stringify(model.sent)).not.toContain(TOKEN);
    expect(String(resultsOf(model.sent[1])[0].content)).toContain("[redacted]");
    expect(JSON.stringify(r.events)).not.toContain(TOKEN);
  });

  it(`at most ${ASK_GITHUB_REQUESTS_MAX} GitHub requests per answer: the next call is refused with limit`, async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const gh = fakeGithub((url) => (url.pathname.endsWith("/files") ? json([]) : json({ number: 1, title: "t", user: { login: "u" } })));
    // A pull request with its files is two requests: five spend the ten; the sixth is refused.
    const model = fakeModel([
      [1, 2, 3, 4, 5, 6].map((n) => ({ type: "tool_use" as const, name: "github_pull_request", input: { number: n } })),
      [{ type: "text", text: `Five read.${final}` }],
    ]);
    await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "PRs?" }));
    expect(gh.calls).toHaveLength(ASK_GITHUB_REQUESTS_MAX);
    const results = resultsOf(model.sent[1]);
    expect(results.slice(0, 5).every((x) => !x.is_error)).toBe(true);
    expect(results[5].is_error).toBe(true);
    expect(JSON.parse(String(results[5].content)).code).toBe("limit");
  });

  it("a large file is cut with a note; a diff's patches share one budget", async () => {
    await connect();
    const cookie = await cookieFor(ME);
    const big = "x".repeat(ASK_GITHUB_TEXT_MAX + 6_000);
    const gh = fakeGithub((url) => (url.pathname.includes("/contents/")
      ? json(fileBody("big.txt", big))
      : json({ sha: "abc", commit: { message: "m", author: { name: "A", date: "2026-10-01" } }, files: Array.from({ length: 8 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", patch: "y".repeat(5_000) })) })));
    const model = fakeModel([
      [{ type: "tool_use", name: "github_read", input: { path: "big.txt" } }, { type: "tool_use", name: "github_commit", input: { sha: "abc" } }],
      [{ type: "text", text: `Big.${final}` }],
    ]);
    const r = await withAsk({ fetchImpl: model.fetchImpl, githubFetch: gh.fetchImpl }, () => ask(cookie, { text: "Big?" }));
    const [file, commit] = resultsOf(model.sent[1]).map((x) => String(x.content));
    expect(file).toContain(`(truncated: ${ASK_GITHUB_TEXT_MAX.toLocaleString("en-US")} of ${big.length.toLocaleString("en-US")} characters shown)`);
    expect(file).toContain("\"truncated\":true");
    expect(file.length).toBeLessThan(ASK_GITHUB_TEXT_MAX + 2_000);
    expect(commit).toContain("\"patches_truncated\":true");
    expect((commit.match(/y/g) ?? []).length).toBeLessThanOrEqual(ASK_GITHUB_TEXT_MAX);
    expect(eventsOf(r.events, "activity").filter((a) => a.state === "done").map((a) => a.resultLine)).toEqual(["Truncated", "Truncated"]);
  });
});
