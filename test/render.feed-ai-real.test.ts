// Phase C on REAL DATA, end to end into the screens that already exist (no LOCAL_AI_PREVIEW, no aiPreviewFixtures):
// rows are written through the real gate and the real `promote_doc` (so the ROUTER marks the cards), the real AI pass
// runs the registered jobs with Jev stubbed at the Response level, and the screens read back through the real reads —
// the cookie app's `/feed` and `/tags/:name`, and `/mcp`'s `get_feed` — before the existing renderers draw them:
//   • feed.importance → `FeedRow.importance` → the Feed byline's mark (render.ts `feedImportance`, marks.ts);
//   • Sift on new items → `entry_tags` / `org_tag_suggestions` → the tag page's "Added by Sift" item and its To review
//     row (web/src/tags.ts `tagPageView`), and the doc's own `tags`.
// And the absent case: an entry Sift left unrated (or rated routine) renders byte for byte what it did before the pass.
//
// TYPES: this file needs BOTH sides — the Worker (D1, the pass, the routes) and the web renderers (DOM-typed) — and no
// one tsconfig types both. So it is type-checked as a Worker test (tsconfig.worker.json) and loads the renderers through
// `web()` below, by a path tsc does not follow; vitest loads them at run time exactly as every render test does (the
// markdown mock included).
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import type { FeedRow } from "@shared/rows";
import type { TagPageDTO } from "@shared/tags-core";
import { runAiPass } from "../src/ai/pass";
import { IMPORTANCE_JOBS } from "../src/ai/importance";
import { TAG_FIT_ITEM_JOB } from "../src/ai/sift-items";
import { newBudget } from "../src/repo/dispatch";
import { ingestFeedEntry } from "../src/consumer";
import { promote_doc, propose_doc_update } from "../src/tools/writes";
import { setAiEnabled } from "../src/tools/tag-fit";
import { call } from "./helpers/orgs";
import { wf } from "./helpers/artifacts";
import { cookieFor, FIXTURE_ADMIN } from "./helpers/persons";
import { ORG_A, mintTokenFor, systemCtx, tenantCtx } from "./helpers/tenant";
import { keyedEnv } from "./helpers/ai-pass";

// After the real clock: the gate and the router stamp `marked_at` with it.
const NOW = new Date(Date.now() + 60 * 60_000);
const BASE = "/api/o/saplinglearn";
const OWNER = "AndresL230";

/** Jev at the Response level: an `importance` question answers `choice(state)`; a tag question answers `fit(tag)`. */
function jev(o: { choice?: (state: string) => { choice: string; confidence: number }; fit?: (tag: string) => number }) {
  let sent = 0;
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    sent++;
    const body = JSON.parse(String(init?.body)) as { state: string; questions: Record<string, { type: string; instructions: string }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([k, q]) => {
      if (q.type === "choice") {
        const c = o.choice!(body.state);
        const rest = (1 - c.confidence) / 2;
        return [k, { type: "choice", choice: c.choice, confidence: c.confidence, probabilities: { routine: rest, notable: rest, breaking: rest, [c.choice]: c.confidence } }];
      }
      return [k, { type: "noul", noul: o.fit!(/the tag "([^"]+)"/.exec(q.instructions)?.[1] ?? "") }];
    }));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 6 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent: () => sent };
}

/** The web renderers this test draws with (web/src/render.ts, marks.ts, tags.ts), typed as far as it uses them. */
interface Web {
  render(s: unknown): string;
  initialState(): Record<string, unknown>;
  FEED_AI_NOTE: string;
  IMPORTANCE_MARK: Record<"notable" | "breaking", { word: string; hint: string }>;
  tagPageView(p: { name: string; page: { status: "ok"; data: TagPageDTO }; tab: string; orgName: string; who: (h: string) => string }): string;
}
const WEB = ["../web/src/render", "../web/src/marks", "../web/src/tags"];
async function web(): Promise<Web> {
  const mods = await Promise.all(WEB.map((path: string) => import(/* @vite-ignore */ path)));
  return Object.assign({}, ...mods) as Web;
}

/** The Feed screen as the app holds it once `/feed` has loaded these rows (For agents, so every byline shows). */
function feedState({ initialState }: Web, rows: FeedRow[]): unknown {
  const s = initialState();
  return {
    ...s, view: "app", screen: "feed", feedView: "agents", orgSlug: "saplinglearn",
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" as const }], superadmin: false, pending_invites: 0 },
    persons: { status: "ok", data: [{ handle: OWNER, name: "Andres", color: "moss", avatar_url: null, role: null }] },
    feed: { status: "ok", data: rows },
    feedAuthors: [...new Set(rows.map((r) => r.author))],
  };
}

/** `/mcp` `tools/call` as a bearer of `OWNER` in org A; the parsed JSON body. */
async function mcpGetFeed(token: string): Promise<FeedRow[]> {
  const res = await wf("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_feed", arguments: {} } }),
  });
  const raw = await res.text();
  const data = (res.headers.get("content-type") ?? "").includes("text/event-stream") ? raw.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("") : raw;
  return JSON.parse(JSON.parse(data).result.content[0].text) as FeedRow[];
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

describe("feed.importance on real rows → /feed and get_feed → the Feed's byline", () => {
  it("rated entries carry `importance` through both reads and draw their mark; unrated and routine ones render as before", async () => {
    const w = await web();
    const write = async (summary: string, body: string) => {
      const r = await ingestFeedEntry(systemCtx(ORG_A), { summary, body, tags: [] } as never, OWNER);
      if (r.outcome !== "written") throw new Error("not written");
      return r.id;
    };
    const breaking = await write("Removed the /o/ org addresses", "Every link now uses /<slug>/.");
    const notable = await write("New: filter the Feed in your own words", "Type a request and the filters are set.");
    const routine = await write("Fixed a typo on Settings", "Copy only.");
    const unsure = await write("Reworked the sync panel's spacing", "Hard to call.");
    const mine = [breaking, notable, routine, unsure];

    const cookie = await cookieFor("feed-reader");
    const readFeed = async () => (await call<{ feed: FeedRow[] }>("GET", `${BASE}/feed`, cookie)).json.feed.filter((r) => mine.includes(r.id));
    const before = await readFeed();
    expect(before).toHaveLength(4);
    expect(before.some((r) => "importance" in r || "ai" in r)).toBe(false); // the real read, no preview rows

    const j = jev({
      choice: (state) =>
        state.includes("/o/ org addresses") ? { choice: "breaking", confidence: 0.93 }
          : state.includes("own words") ? { choice: "notable", confidence: 0.88 }
          : state.includes("typo") ? { choice: "routine", confidence: 0.95 }
          : { choice: "notable", confidence: 0.55 }, // below the threshold: stays unknown
    });
    await runAiPass(keyedEnv(), newBudget(j.fetchImpl, 900), { jobs: IMPORTANCE_JOBS, now: NOW });
    expect(j.sent()).toBe(4);

    // The cookie read (the Feed screen's) and the MCP read (`get_feed`) carry exactly the same field.
    const after = await readFeed();
    const byId = new Map(after.map((r) => [r.id, r]));
    expect(byId.get(breaking)!.importance).toBe("breaking");
    expect(byId.get(notable)!.importance).toBe("notable");
    expect(byId.get(routine)!.importance).toBe("routine");
    expect("importance" in byId.get(unsure)!).toBe(false); // NULL is left out, never a guessed routine
    const viaMcp = new Map((await mcpGetFeed((await mintTokenFor(OWNER, ORG_A)).raw)).map((r) => [r.id, r]));
    for (const id of mine) expect(viaMcp.get(id)?.importance).toBe(byId.get(id)!.importance);

    // The Feed draws one mark per notable / breaking entry, in that entry's own row.
    const { render, IMPORTANCE_MARK, FEED_AI_NOTE } = w;
    const html = render(feedState(w, after));
    expect(count(html, `data-importance="breaking"`)).toBe(1);
    expect(count(html, `data-importance="notable"`)).toBe(1);
    expect(html).toContain(IMPORTANCE_MARK.breaking.hint);
    expect(html).not.toContain(`data-importance="routine"`);
    // Importance is not `ai`: no Source switch, no first-run note (render.ai-absent.test.ts's field-absent Feed).
    expect(html).not.toContain(`data-act="aiFeedSource"`);
    expect(html).not.toContain(FEED_AI_NOTE);

    // FIELD ABSENT: the routine and the unrated entry render byte for byte what they rendered before the pass.
    const pick = (rows: FeedRow[]) => rows.filter((r) => r.id === routine || r.id === unsure);
    expect(render(feedState(w, pick(after)))).toBe(render(feedState(w, pick(before))));
  });
});

describe("Sift on new items on a real promoted doc → /tags/:name and /doc → the tag page", () => {
  it("an added tag shows as \"Added by Sift\" on its tag page and on the doc; a suggested one waits in To review", async () => {
    await setAiEnabled(await tenantCtx(OWNER), true); // Sift's own switch (the org's is on in the seed)
    await propose_doc_update(systemCtx(), { slug: "deploy-runbook", section: "reference", title: "Deploy runbook", body: "How deploys and CI run, and the endpoints they call.", change_summary: "s", confidence: "high" }, OWNER);
    await promote_doc(systemCtx(), "deploy-runbook", 1, OWNER); // the router marks card:tagfit:doc:deploy-runbook

    const j = jev({ fit: (t) => (t === "infra" ? 0.92 : t === "api" ? 0.7 : 0.1) });
    await runAiPass(keyedEnv(), newBudget(j.fetchImpl, 900), { jobs: [TAG_FIT_ITEM_JOB], now: NOW });
    expect(j.sent()).toBe(1);

    const admin = await cookieFor(FIXTURE_ADMIN);
    // The doc's own read carries the tag Sift added — and not the one it only suggested.
    const doc = (await call<{ tags?: string[] }>("GET", `${BASE}/doc/deploy-runbook`, admin)).json;
    expect(doc.tags).toEqual(["infra"]);

    // infra's page: the doc is listed, marked "Added by Sift" with how sure Sift was.
    const infra = await call<TagPageDTO>("GET", `${BASE}/tags/infra`, admin);
    expect(infra.status).toBe(200);
    const item = infra.json.items.doc.find((i) => i.id === "deploy-runbook")!;
    expect(item.jev).toMatchObject({ confidence: 0.92 });
    const { tagPageView } = await web();
    const page = tagPageView({ name: "infra", page: { status: "ok", data: infra.json }, tab: "doc", orgName: "SaplingLearn", who: (h) => h });
    const row = page.slice(page.indexOf(`data-tag-item="doc:deploy-runbook"`));
    expect(row.slice(0, row.indexOf("</li>"))).toMatch(/data-by-jev="1"[\s\S]*Added by Sift/);

    // api's page: the doc waits in To review, with Sift's confidence, for a person to Add or Dismiss.
    const api = await call<TagPageDTO>("GET", `${BASE}/tags/api`, admin);
    expect(api.json.review.map((i) => `${i.type}:${i.id}`)).toContain("doc:deploy-runbook");
    expect(api.json.items.doc.some((i) => i.id === "deploy-runbook")).toBe(false);
    const review = tagPageView({ name: "api", page: { status: "ok", data: api.json }, tab: "review", orgName: "SaplingLearn", who: (h) => h });
    expect(review).toContain(`data-tag-review="doc:deploy-runbook"`);
    expect(review).toContain("Sift is 70% sure");
  });
});
