// Ask Trov's contract (shared/ai-ask.ts, shared/ai-ask-core.ts): every SSE event shape, the fixtures for every
// design scenario (shared/ai-fixtures.ts › Ask Trov) checked against it, the ref tokens, the meta splitter, the
// server-written artifacts, and the dev-only replay route (its guard: LOCAL_AI_PREVIEW under `wrangler dev` only).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import {
  ASK_EVENTS, AskEventSchemas, AskSearchHitSchema, AskSettingsSchema, AskStateSchema, AskThreadSummarySchema, RefViewSchema,
  askModesFor, askRefTokens, parseAskRef,
} from "@shared/ai-ask";
import {
  ASK_SCENARIOS, askRefFixtures, askSearchFixture, askSettingsFixture, askStateFixture, askThreadsFixture, askTranscript, askTranscriptSse,
} from "@shared/ai-fixtures";
import { MetaSplitter } from "../src/ai/ask/prompt";
import { chainOrder, diagramDrawable } from "../src/ai/ask/tools";
import { applyHunkEdits, docHunks } from "../src/ai/ask/diff";
import { chartSvg, markdownHtml, tokensToMarkdown } from "../src/ai/ask/render";
import { snippetOffsets, threadGroup } from "../src/ai/ask/routes";
import { cookieFor } from "./helpers/persons";
import { readSse } from "./helpers/ask";
import { FAKE_ANTHROPIC_KEY } from "./helpers/anthropic";

const NOW = new Date("2026-10-15T12:00:00Z");

describe("the fixtures: one transcript per design scenario, every event in the contract", () => {
  it("covers every scenario; every event parses; each turn opens with `thread` and (unless cut mid-stream) closes with `done`", () => {
    expect(ASK_SCENARIOS).toEqual(["live", "streaming", "thinking", "answer", "answer-pr", "actions-ask", "actions-auto", "artifact", "artifact-saved",
      "search", "notfound", "cmdj", "ticket", "settings", "phone", "phone-plus", "phone-insp"]);
    for (const s of ASK_SCENARIOS) {
      const steps = askTranscript(s, NOW);
      for (const { event } of steps) {
        const parsed = AskEventSchemas[event.event].safeParse(event.data);
        expect(parsed.success, `${s} › ${event.event}: ${parsed.success ? "" : JSON.stringify(parsed.error.issues[0])}`).toBe(true);
      }
      if (!steps.length) continue;
      expect(steps[0].event.event, s).toBe("thread");
      const names = steps.map((x) => x.event.event);
      if (s === "streaming") expect(names).not.toContain("done");
      else expect(names, s).toContain("done");
      // The SSE body round-trips through the reader.
      expect(readSse(askTranscriptSse(steps)).map((e) => e.event)).toEqual(names);
    }
    // Every event kind appears somewhere (`error` is the one only a live failure sends).
    const seen = new Set(ASK_SCENARIOS.flatMap((s) => askTranscript(s, NOW).map((x) => x.event.event)));
    expect(ASK_EVENTS.filter((e) => !seen.has(e))).toEqual(["error"]);
  });

  it("thinking runs before the answer; actions-auto runs five and makes the Publish wait; the streaming cut stops mid-answer", () => {
    const thinking = askTranscript("thinking", NOW).filter((x) => x.event.event === "thinking").map((x) => x.event.data);
    expect(thinking).toEqual([{ state: "run" }, expect.objectContaining({ state: "done", seconds: 14 })]);
    const auto = askTranscript("actions-auto", NOW);
    expect(auto.filter((x) => x.event.event === "action_result")).toHaveLength(5);
    expect(auto.find((x) => x.event.event === "action")!.event.data).toMatchObject({ kind: "publish", state: "waiting", note: "Publishing waits for you, even on Auto." });
    expect(askTranscript("streaming", NOW).filter((x) => x.event.event === "text")).toHaveLength(58);
  });

  it("docs/superpowers/specs/ask-transcripts/ holds exactly the fixtures' transcripts (2026-10-15T12:00Z)", () => {
    const files = (import.meta as unknown as { glob: (p: string, o: { query: string; import: string; eager: true }) => Record<string, string> })
      .glob("../docs/superpowers/specs/ask-transcripts/*.sse", { query: "?raw", import: "default", eager: true });
    const want = Object.fromEntries(ASK_SCENARIOS.flatMap((s) => {
      const steps = askTranscript(s, NOW);
      return steps.length ? [[`../docs/superpowers/specs/ask-transcripts/${s}.sse`, askTranscriptSse(steps)]] : [];
    }));
    expect(Object.keys(files).sort()).toEqual(Object.keys(want).sort());
    for (const [path, text] of Object.entries(want)) expect(files[path], path).toBe(text);
  });

  it("the LIVE recordings (one real answer per mode, 2026-10-15) are in the contract too", () => {
    const live = (import.meta as unknown as { glob: (p: string, o: { query: string; import: string; eager: true }) => Record<string, string> })
      .glob("../docs/superpowers/specs/ask-transcripts/live/*.sse", { query: "?raw", import: "default", eager: true });
    expect(Object.keys(live).map((k) => k.split("/").pop()).sort()).toEqual(["fast.sse", "smart.sse", "thinking.sse"]);
    for (const [path, text] of Object.entries(live)) {
      const events = readSse(text);
      expect(events[0].event, path).toBe("thread");
      expect(events.at(-1)!.event, path).toBe("done");
      for (const e of events) expect(AskEventSchemas[e.event].safeParse(e.data).success, `${path} › ${e.event}`).toBe(true);
    }
    expect(readSse(Object.entries(live).find(([k]) => k.endsWith("thinking.sse"))![1]).some((e) => e.event === "thinking")).toBe(true);
  });

  it("the state, settings, threads, search and ref fixtures parse", () => {
    expect(AskStateSchema.parse(askStateFixture("pro", NOW)).modes).toHaveLength(3);
    expect(AskStateSchema.parse(askStateFixture("free", NOW)).modes.map((m) => m.id)).toEqual(["smart"]);
    AskSettingsSchema.parse(askSettingsFixture("pro"));
    for (const t of askThreadsFixture(NOW)) AskThreadSummarySchema.parse(t);
    for (const h of askSearchFixture(NOW)) {
      const hit = AskSearchHitSchema.parse(h);
      const [a, b] = hit.snippet!.matches[0];
      expect(hit.snippet!.text.slice(a, b).toLowerCase()).toBe("netlify");
    }
    for (const v of Object.values(askRefFixtures(NOW))) RefViewSchema.parse(v);
  });
});

describe("the pieces", () => {
  it("ref tokens: the kinds, the status cell, each ref once; anything else is not a ref", () => {
    expect(askRefTokens("[[ticket:14]] and [[ticket:14|status]] and [[pr:173]] and [[doc:auth-flow]] [[nope:1]] [[person:maya]]"))
      .toEqual(["ticket:14", "pr:173", "doc:auth-flow", "person:maya"]);
    expect(parseAskRef("repo:AndresL230/trov")).toEqual({ type: "repo", key: "AndresL230/trov" });
    expect(parseAskRef("ticket:")).toBeNull();
    expect(askModesFor("free")).toEqual(["smart"]);
    expect(askModesFor("personal")).toEqual(["smart"]);
    expect(askModesFor("team")).toEqual(["fast", "smart", "thinking"]);
  });

  it("the meta splitter never shows a prefix of <trov-meta>, and parses the title and follow-ups", () => {
    const s = new MetaSplitter();
    const shown = ["Answer <tr", "ov-", "meta>{\"title\": \"T\", \"followups\": [\"a\", \"b\", \"c\", \"d\"]}</trov-meta>"].map((d) => s.push(d)).join("");
    expect(shown).toBe("Answer ");
    expect(s.end()).toMatchObject({ text: "Answer", title: "T", followups: ["a", "b", "c"] });
    const plain = new MetaSplitter();
    expect(plain.push("a <tr")).toBe("a ");
    expect(plain.end()).toMatchObject({ tail: "<tr", text: "a <tr", title: null });
  });

  it("a diagram is a chain only when its edges walk every node once; doc hunks round-trip an edit", () => {
    const nodes = ["a", "b", "c"].map((id) => ({ id }));
    expect(chainOrder(nodes, [["b", "c"], ["a", "b"]])).toEqual(["a", "b", "c"]);
    expect(chainOrder(nodes, [["a", "b"], ["a", "c"]])).toBeNull();
    // …but the client draws any graph without a loop; only a loop or an edge to nowhere is a list
    expect(diagramDrawable(nodes, [["a", "b"], ["a", "c"]])).toBe(true);
    expect(diagramDrawable(nodes, [["a", "b"], ["b", "c"], ["c", "a"]])).toBe(false);
    expect(diagramDrawable(nodes, [["a", "zz"]])).toBe(false);
    const live = "# Doc\n\n## Tokens\n\nRefresh is automatic.\n\nEnd.";
    const proposed = "# Doc\n\n## Tokens\n\nRefresh is manual for now.\n\nEnd.";
    const hunks = docHunks(live, proposed);
    expect(hunks).toEqual([{ index: 0, heading: "## Tokens", before: "Refresh is automatic.", after: "Refresh is manual for now." }]);
    expect(applyHunkEdits(live, proposed, [{ index: 0, after: "Refresh is manual. Reconnect it." }])).toBe("# Doc\n\n## Tokens\n\nRefresh is manual. Reconnect it.\n\nEnd.");
    expect(applyHunkEdits(live, proposed, [{ index: 3, after: "x" }])).toBeNull();
  });

  it("a saved answer is written by the server: refs become links, every string is escaped, a chart is SVG from the numbers", () => {
    const v = askRefFixtures(NOW)["ticket:14"];
    expect(tokensToMarkdown("See [[ticket:14]] ([[ticket:14|status]]) and [[pr:1]].", [v], "https://trov.dev/acme"))
      .toBe("See [#14 Guided repository setup](https://trov.dev/acme/#tickets/14) (In progress) and pr 1.");
    const html = markdownHtml("# T <script>alert(1)</script>\n\n[x](javascript:alert(1)) **b**");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("javascript:");
    expect(html).toContain("<strong>b</strong>");
    const svg = chartSvg({ title: "C", total: 3, unit: "PRs", query: "merged_prs_by_week", params: {}, rows: [{ label: "Sep 7", value: 3 }] });
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain("Sep 7: 3 PRs");
  });

  it("thread groups and search offsets", () => {
    expect(threadGroup({ pinned: 1, updated_at: "2020-01-01T00:00:00Z" }, NOW)).toBe("pinned");
    expect(threadGroup({ pinned: 0, updated_at: "2026-10-15T01:00:00Z" }, NOW)).toBe("today");
    expect(threadGroup({ pinned: 0, updated_at: "2026-10-12T01:00:00Z" }, NOW)).toBe("week");
    expect(threadGroup({ pinned: 0, updated_at: "2026-09-01T01:00:00Z" }, NOW)).toBe("earlier");
    expect(snippetOffsets("…the \u0002netlify\u0003 step")).toEqual({ text: "…the netlify step", matches: [[5, 12]] });
  });
});

describe("the dev-only replay route", () => {
  const LOCAL = "http://127.0.0.1:8787/api/o/saplinglearn/ai/ask-replay";
  // The replay keeps THE AI read rule like every preview: a key (a fake one — nothing is sent) and the switch on.
  const previewEnv = { ...(env as unknown as Env), LOCAL_AI_PREVIEW: "ready", ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY } as Env;

  it("is 404 without LOCAL_AI_PREVIEW, and 404 off a loopback origin even with it", async () => {
    const cookie = await cookieFor("ask-dev");
    expect((await app.request(`${LOCAL}/answer`, { headers: { cookie } }, env as unknown as Env)).status).toBe(404);
    expect((await app.request("https://trov.dev/api/o/saplinglearn/ai/ask-replay/answer", { headers: { cookie } }, previewEnv)).status).toBe(404);
  });

  it("honours the read rule: no key, or the org's switch off, is 404 — the Ask screen then shows its real off state", async () => {
    const cookie = await cookieFor("ask-dev");
    const noKey = { ...previewEnv, ANTHROPIC_API_KEY: "" } as Env;
    expect((await app.request(`${LOCAL}/answer?speed=0`, { headers: { cookie } }, noKey)).status).toBe(404);
    expect((await app.request(LOCAL, { headers: { cookie } }, noKey)).status).toBe(404);
    await env.DB.prepare(`UPDATE orgs SET ai_automation = 0 WHERE slug = 'saplinglearn'`).run();
    expect((await app.request(`${LOCAL}/answer?speed=0`, { headers: { cookie } }, previewEnv)).status).toBe(404);
    expect((await app.request(LOCAL, { headers: { cookie } }, previewEnv)).status).toBe(404);
  });

  it("under `wrangler dev` with the preview on, streams a scenario's transcript and lists the fixtures", async () => {
    const cookie = await cookieFor("ask-dev");
    const res = await app.request(`${LOCAL}/actions-ask?speed=0`, { headers: { cookie } }, previewEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = readSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(askTranscript("actions-ask", NOW).map((x) => x.event.event));
    const list = await app.request(LOCAL, { headers: { cookie } }, previewEnv);
    const body = await list.json() as { scenarios: string[]; state: { pro: unknown } };
    expect(body.scenarios).toEqual([...ASK_SCENARIOS]);
    AskStateSchema.parse(body.state.pro);
    expect((await app.request(`${LOCAL}/nope`, { headers: { cookie } }, previewEnv)).status).toBe(404);
  });
});
