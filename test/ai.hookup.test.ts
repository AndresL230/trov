// THE HOOKUP, proven with REAL data (no LOCAL_AI_PREVIEW, no shared/ai-fixtures): GitHub deliveries captured by the
// real webhook path → the AI pass (both providers stubbed at the `Response` level) writes a session digest through
// the gate and a `repo_state` version → the REAL reads (`GET /repo/dashboard` and MCP `get_repo_dashboard`, `GET
// /feed` and MCP `get_feed`) carry `RepoDashboard.state` and `FeedRow.ai` → the EXISTING screens render them: Repo ›
// Summary › State (`web/src/repo-ai.ts` `repoStateSection`, the Repo screen's Summary tab in `web/src/repo.ts`) and the Feed's
// Trov entry, Source switch and note (`web/src/render.ts`). Then "Wrong?" — the body the rendered button carries,
// posted to the real route — hides exactly that item on the next read, for that person only.
//
// This file is Worker code (tsconfig.worker.json), so it loads the SPA's modules at RUNTIME through a computed path
// (the type checker never follows it into web/src — the same split every render test keeps); markdown is mocked as
// in the render tests (no DOM in the pool).
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Env } from "../src/env";
import { app as api } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import { runAiPass } from "../src/ai/pass";
import { sessionDigestJob } from "../src/ai/digests";
import { repoStateJob } from "../src/ai/repo-state";
import { newBudget, CRON_SUBREQUEST_BUDGET } from "../src/repo/dispatch";
import { captureDelivery } from "../src/webhook";
import { append_feed } from "../src/tools/writes";
import { AiFeedMetaSchema, AiRepoStateSchema, AI_ROUTES, aiItemRef, type AiFeedbackBody } from "@shared/ai";
import type { FeedRow } from "@shared/rows";
import type { RepoDashboard } from "@shared/repo";
import { cookieFor } from "./helpers/persons";
import { ORG_A, bearerCtx, systemCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { keyedEnv, stubProviders, type ClaudeReply } from "./helpers/ai-pass";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));

/** The SPA's modules, loaded at run time (see the header). Only what this test touches is typed. */
interface Web {
  render(s: Record<string, unknown>): string;
  initialState(): Record<string, unknown>;
  FEED_AI_NOTE: string;
  parseFeedbackArg(arg: string | null): AiFeedbackBody | null;
}
const WEB = "../web/src/";
const web = async (): Promise<Web> => {
  // The Repo screen is its own chunk (web-ui.md › The app's bundles): handed in as loaded, so it renders, not its skeleton.
  const { repoChunk } = await import(/* @vite-ignore */ `${WEB}repo-lazy`);
  repoChunk.set(await import(/* @vite-ignore */ `${WEB}repo`));
  return {
    ...(await import(/* @vite-ignore */ `${WEB}render`)),
    ...(await import(/* @vite-ignore */ `${WEB}ai-actions`)),
  } as Web;
};

const e = env as unknown as Env;
const REPO = "SaplingLearn/sapling";
const ME = "AndresL230";
const MIN = 60_000;

const deliver = (event: string, payload: unknown) =>
  captureDelivery(systemCtx(ORG_A, "github-webhook"), e, { repo: REPO, githubToken: async () => null }, event, JSON.stringify(payload), { summarizer: null, issueSummarizer: null });
const sha = (k: number) => `${k.toString(16).padStart(4, "0")}def${"0".repeat(33)}`;
const push = {
  ref: "refs/heads/main", after: sha(3), before: "0".repeat(40), compare: "https://github.com/x",
  repository: { full_name: REPO, default_branch: "main", pushed_at: 1_760_000_000 }, sender: { login: ME },
  head_commit: { id: sha(2), message: "Hosting: the Vercel connect screen", timestamp: "2026-10-14T10:00:00Z" },
  commits: ["Hosting: the provider interface", "Hosting: Org settings › Hosting", "Hosting: the Vercel connect screen"]
    .map((m, k) => ({ id: sha(k), distinct: true, message: m, timestamp: "2026-10-14T10:00:00Z" })),
};
const merge = {
  action: "closed", repository: { full_name: REPO, default_branch: "main" },
  pull_request: { number: 185, title: "Hosting providers", body: "never sent", html_url: `https://github.com/${REPO}/pull/185`, state: "closed", merged: true,
    merged_at: "2026-10-14T10:30:00Z", closed_at: "2026-10-14T10:30:00Z", updated_at: "2026-10-14T10:30:00Z", user: { login: ME },
    head: { ref: "feat/hosting", sha: sha(2) }, base: { ref: "main" }, milestone: null },
};

/** Haiku, answering whichever job asked — each with only the refs its own input carries. */
const reply: ClaudeReply = (body) => {
  const input = body.messages[0].content.at(-1)!.text;
  const refs = (re: RegExp) => [...new Set([...input.matchAll(re)].map((m) => m[1]))];
  if (input.includes("<burst>")) {
    return JSON.stringify({
      type: "Shipped", summary: "Shipped: hosting providers connect to a repository", brief: "Teams see every host's deploys and usage in one place.",
      what: "A provider interface, Org settings › Hosting and the Vercel connect screen.", why: null, impact: "Everyone with a hosted repository.",
      follow_up: null, state: null, blocked_on: null, next: null, tags: ["infra"], cites: [...refs(/\b(pr:\d+)/g), ...refs(/\b(sha:[0-9a-f]{7})/g)],
    });
  }
  return JSON.stringify({
    headline: "Hosting providers landed on main.",
    shipped: [{ text: "Hosting providers connect to a repository.", cites: [...refs(/\b(pr:\d+)/g), ...refs(/\b(feed:\d+)/g)] }],
    in_flight: [],
    attention: [],
  });
};

async function get<T>(path: string, cookie: string): Promise<T> {
  const res = await api.request(`https://trov.dev/api/o/saplinglearn${path}`, { headers: { cookie } }, e);
  expect(res.status, path).toBe(200);
  return (await res.json()) as T;
}
async function mcp<T>(tool: string, args: Record<string, unknown>): Promise<T> {
  const server = buildTrovMcpServer(e, await bearerCtx(ME));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.content[0].text) as T;
  } finally {
    await client.close();
    await server.close();
  }
}

/** The app state a signed-in AndresL230 has on `screen`, with the reads' answers in it. */
function appState(w: Web, o: Record<string, unknown>): Record<string, unknown> {
  return {
    ...w.initialState(), view: "app", orgSlug: "saplinglearn",
    me: { handle: ME, name: "Andres", avatar_url: null, color: "sky", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" }], superadmin: false, pending_invites: 0 },
    persons: { status: "ok", data: [{ handle: ME, name: "Andres", color: "sky", avatar_url: null, role: null }] },
    ...o,
  };
}
/** The "Wrong?" button inside `html` after `marker`, read back exactly as the SPA reads it (`parseFeedbackArg`). */
function wrongArg(w: Web, html: string, marker: string): AiFeedbackBody {
  const at = html.indexOf(marker);
  expect(at, marker).toBeGreaterThanOrEqual(0);
  const m = /data-act="aiWrong" data-arg="([^"]+)"/.exec(html.slice(at));
  expect(m).not.toBeNull();
  const raw = m![1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const body = w.parseFeedbackArg(raw);
  expect(body).not.toBeNull();
  return body!;
}

// The whole pipeline plus the SPA's modules loaded at run time: ~2 s alone, past the 5 s default under a full
// suite's load (the gate run of 2026-10-15) — so the file's own budget.
describe("the AI screens over REAL rows: webhook → pass → reads → render", { timeout: 60_000 }, () => {
  it("absent: before the pass the reads carry no `state` / `ai`, and the screens draw no AI section", async () => {
    const w = await web();
    await addOrgRepo(REPO, ORG_A);
    await append_feed(systemCtx(), { author: ME, summary: "Decision: hosting connections stay read-only", body: "b", tags: [] });
    const cookie = await cookieFor(ME);
    const dash = await get<RepoDashboard>("/repo/dashboard", cookie);
    expect(dash).not.toHaveProperty("state");
    const { feed } = await get<{ feed: FeedRow[] }>("/feed", cookie);
    expect(feed.some((r) => "ai" in r)).toBe(false);
    const repoHtml = w.render(appState(w, { screen: "repo", repoTab: "summary", repo: { status: "ok", data: dash } }));
    expect(repoHtml).not.toContain('data-ai="repo_state"');
    const feedHtml = w.render(appState(w, { screen: "feed", feed: { status: "ok", data: feed } }));
    expect(feedHtml).not.toContain('data-ai="feed"');
    expect(feedHtml).not.toContain("feed-source");
    expect(feedHtml).not.toContain(w.FEED_AI_NOTE);
  });

  it("present: State and the Trov entry render from the real reads; MCP carries the same; \"Wrong?\" hides each for its presser only", async () => {
    const w = await web();
    await addOrgRepo(REPO, ORG_A);
    await append_feed(systemCtx(), { author: ME, summary: "Decision: hosting connections stay read-only", body: "b", tags: [] });
    await deliver("push", push);
    await deliver("pull_request", merge);
    const s = stubProviders({ jev: () => 0.9, claude: reply });
    // Past the session's 45 minutes and the repo's debounce: the pass runs sessions first, then the repo state.
    await runAiPass(keyedEnv(), newBudget(s.fetchImpl, CRON_SUBREQUEST_BUDGET), { jobs: [sessionDigestJob, repoStateJob], now: new Date(Date.now() + 7 * 60 * MIN) });
    expect([s.jev, s.haiku]).toEqual([2, 2]);

    const cookie = await cookieFor(ME);
    // ── Repo › Summary (State) ──
    const dash = await get<RepoDashboard>("/repo/dashboard", cookie);
    const state = AiRepoStateSchema.parse(dash.state);
    expect(state).toMatchObject({ state: "ready", model: "claude-haiku-5-5", headline: "Hosting providers landed on main.", inFlight: [], attention: [] });
    expect(state.shipped[0].cites.map((c) => c.ref)).toEqual(expect.arrayContaining(["pr:185"]));
    expect(state.shipped[0].cites.find((c) => c.ref === "pr:185")!.href).toBe(`https://github.com/${REPO}/pull/185`);
    // MCP get_repo_dashboard carries the SAME state (overview, or no tab).
    expect((await mcp<{ state?: unknown }>("get_repo_dashboard", { tab: "overview" })).state).toEqual(dash.state);
    expect((await mcp<{ state?: unknown }>("get_repo_dashboard", {})).state).toEqual(dash.state);

    const repoHtml = w.render(appState(w, { screen: "repo", repoTab: "summary", repo: { status: "ok", data: dash } }));
    expect(repoHtml).toContain('data-ai="repo_state" data-ai-state="ready"');
    expect(repoHtml).toContain("Hosting providers landed on main.");
    expect(repoHtml).toContain("Hosting providers connect to a repository.");
    expect(repoHtml).toContain(`href="https://github.com/${REPO}/pull/185"`);
    const stateWrong = wrongArg(w, repoHtml, 'data-ai="repo_state"');
    expect(stateWrong).toMatchObject({ itemType: "repo_state", itemRef: aiItemRef.repoState(REPO, state.generatedAt!) });
    expect(stateWrong.itemRef).toBe(`${REPO}@${state.generatedAt}`);

    // ── the Feed's Trov entry ──
    const { feed } = await get<{ feed: FeedRow[] }>("/feed", cookie);
    const trov = feed.filter((r) => r.ai);
    expect(trov).toHaveLength(1);
    const entry = trov[0];
    expect(entry).toMatchObject({ author: "trov", summary: "Shipped: hosting providers connect to a repository" });
    expect(AiFeedMetaSchema.parse(entry.ai)).toMatchObject({ origin: "ai", subject: ME, model: "claude-haiku-5-5" });
    expect(entry.ai!.sources.map((c) => c.ref)).toContain("pr:185");
    expect(feed.filter((r) => !r.ai).map((r) => r.summary)).toEqual(["Decision: hosting connections stay read-only"]);
    // MCP get_feed carries the same rows, `ai` included.
    expect(await mcp<FeedRow[]>("get_feed", {})).toEqual(feed);
    // The repo state cites the digest by its feed id: the two producers are wired to each other.
    expect(state.shipped[0].cites.map((c) => c.ref)).toContain(`feed:${entry.id}`);

    const feedHtml = w.render(appState(w, { screen: "feed", feedView: "reading", feed: { status: "ok", data: feed } }));
    expect(feedHtml).toContain(`data-ai="feed" data-feed-id="${entry.id}"`);
    expect(feedHtml).toContain("Shipped: hosting providers connect to a repository");
    expect(feedHtml).toContain("deploys and usage in one place."); // the brief, in the reading view
    expect(feedHtml).toContain('data-seg="feed-source"'); // the Source switch
    expect(feedHtml).toContain(w.FEED_AI_NOTE.slice(0, 40)); // the one-time note
    expect(feedHtml).toContain(`href="https://github.com/${REPO}/pull/185"`); // a source, linked to the digest's repo
    const feedWrong = wrongArg(w, feedHtml, `data-feed-id="${entry.id}"`);
    expect(feedWrong).toMatchObject({ itemType: "feed", itemRef: String(entry.id) });

    // ── "Wrong?": the exact bodies the buttons carry, to the real route; the next reads leave each out ──
    for (const body of [stateWrong, feedWrong]) {
      const res = await api.request(`https://trov.dev/api/o/saplinglearn${AI_ROUTES.feedback}`,
        { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, e);
      expect(res.status).toBe(200);
    }
    expect(await get<RepoDashboard>("/repo/dashboard", cookie)).not.toHaveProperty("state");
    expect((await mcp<{ state?: unknown }>("get_repo_dashboard", {})).state).toBeUndefined();
    expect((await get<{ feed: FeedRow[] }>("/feed", cookie)).feed.some((r) => r.ai)).toBe(false);
    expect((await mcp<FeedRow[]>("get_feed", {})).some((r) => r.ai)).toBe(false);
    // …for that person only: another member still reads both.
    const other = await cookieFor("Darkest-Teddy");
    expect(AiRepoStateSchema.parse((await get<RepoDashboard>("/repo/dashboard", other)).state).generatedAt).toBe(state.generatedAt);
    expect((await get<{ feed: FeedRow[] }>("/feed", other)).feed.filter((r) => r.ai).map((r) => r.id)).toEqual([entry.id]);
  });
});
