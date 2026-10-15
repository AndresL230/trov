// Handoff reading list (#167): at a claim, an FTS-ranked "Read these first (not complete)" list built
// from the handoff's own words through query() — no model, no network. Over the dev seed's fixtures
// (the docs, feed and decisions `npm run seed` loads locally), so the sample case asserted here is
// what the owner sees on localhost when he claims #15.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { app } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import docs from "../fixtures/dev/docs.json";
import feed from "../fixtures/dev/feed.json";
import adrs from "../fixtures/dev/adrs.json";
import handoffs from "../fixtures/dev/handoffs.json";
import { createHandoff, readingTerms, readingListAsMarkdown } from "../src/tools/handoffs";
import { createPage, patchPage } from "../src/tools/artifacts";
import { cookieFor } from "./helpers/persons";
import { run } from "./helpers/db";
import { systemCtx, bearerCtx, ORG_B } from "./helpers/tenant";
import { HANDOFF_READING_HEADING, HANDOFF_READING_MAX, type HandoffClaimResult, type HandoffView } from "../shared/handoffs";

beforeEach(async () => {
  for (const stmt of buildSeedStatements({ docs, feed, adrs, handoffs })) await env.DB.prepare(stmt).run();
});

const claim = async (id: number, who = "AndresL230"): Promise<Response> =>
  app.request(`/api/handoffs/${id}/claim`, {
    method: "POST", headers: { cookie: await cookieFor(who), "content-type": "application/json" }, body: JSON.stringify({ session: "sess-read" }),
  }, env);

async function mcpClaim(handle: string, id: number): Promise<{ text: string; isError?: boolean }> {
  const server = buildTrovMcpServer({ ...(env as unknown as Env), PUBLIC_ORIGIN: "https://trov.example/" } as Env, await bearerCtx(handle));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name: "claim_handoff", arguments: { id, session: "sess-mcp-read" } })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content[0].text, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

// A handoff about a made-up subsystem, so every match below is one this test placed.
const ZEPHYR = {
  recipient: "anyone",
  body: "Zephyr ledger checksum drifts after compaction\n\nThe nightly compaction rewrites zephyr segments and the checksum no longer matches.",
  context: { task: "Make the zephyr ledger checksum stable across compaction", next: ["Pin the segment order"], files: ["src/zephyr/ledger.ts"] },
};
const ZEPHYR_TEXT = "The zephyr ledger checksum covers every segment; compaction must keep segment order so the checksum holds.";
const sendZephyr = async (): Promise<number> => (await createHandoff(systemCtx(), "Darkest-Teddy", ZEPHYR)).handoff.id;
async function insertDoc(slug: string, title: string, body: string, opts: { org?: string; version?: number } = {}): Promise<void> {
  const org = opts.org ?? "org_saplinglearn";
  await run(env.DB, `INSERT INTO docs (org_id, slug, section, space, title, body, current_version, updated_at, updated_by, owner)
                     VALUES (?, ?, 'Architecture', 'technical', ?, ?, ?, '2026-10-01T00:00:00Z', 'AndresL230', 'AndresL230')`,
    org, slug, title, body, opts.version ?? 1);
}
const ids = (r: HandoffClaimResult) => r.reading_list!.map((x) => `${x.kind}:${x.id}`);

describe("readingTerms — the handoff's own words", () => {
  it("task and title first at weight 2, then the file names; stop words, numbers and short words dropped", () => {
    const h = {
      id: 1, sender: "a", recipient: "anyone", status: "pending", created_at: "", claimed_at: null, claimed_by: null, claimed_by_session: null,
      prompt: null, body: "The OCR retries exhaust the quota\n\nOn 180 pages it is done.",
      context: { repo: "", branch: "", task: "Checkpoint OCR batches", done: [], next: ["Add a test"], files: ["backend/services/ocr_batch.py"] },
    } satisfies HandoffView;
    const t = readingTerms(h);
    expect(t.slice(0, 3)).toEqual([{ term: "checkpoint", weight: 2 }, { term: "ocr", weight: 2 }, { term: "batches", weight: 2 }]);
    expect(t.map((x) => x.term)).toEqual(["checkpoint", "ocr", "batches", "retries", "exhaust", "quota", "batch", "test", "pages"]);
    expect(t.find((x) => x.term === "batch")!.weight).toBe(1); // from the file name
  });
});

describe("POST /api/handoffs/:id/claim — the reading list (dev seed sample)", () => {
  it("claiming #15 (OCR retries) lists the Document Pipeline doc first — non-empty on localhost", async () => {
    const res = await claim(15);
    expect(res.status).toBe(200);
    const body = (await res.json()) as HandoffClaimResult;
    expect(body.ok).toBe(true);
    expect(body.handoff.status).toBe("claimed");
    expect(body.reading_list!.length).toBeGreaterThan(0);
    expect(body.reading_list!.length).toBeLessThanOrEqual(HANDOFF_READING_MAX);
    expect(body.reading_list![0]).toMatchObject({ kind: "doc", id: "sapling-document-pipeline", title: "Document Pipeline (Upload, OCR & Streaming)" });
    expect(body.reading_list![0].snippet).toMatch(/OCR/);
    for (const it of body.reading_list!) expect(Object.keys(it).sort()).toEqual(["id", "kind", "snippet", "title"]);
  });

  it("#16 (interrupted SSE streams) and #17 (quiz agent) each get a list too", async () => {
    const sse = (await (await claim(16)).json()) as HandoffClaimResult;
    expect(ids(sse)).toEqual(expect.arrayContaining(["doc:sapling-document-pipeline", "doc:sapling-adr-durable-execution"]));
    const quiz = (await (await claim(17)).json()) as HandoffClaimResult;
    expect(quiz.reading_list!.length).toBeGreaterThan(0);
  });

  it("a failed claim carries no list (and no 200)", async () => {
    expect((await claim(14)).status).toBe(409); // already claimed
    expect((await claim(13, "lpcooper-arch")).status).toBe(403); // not theirs
  });

  it("a handoff whose words match nothing gets an empty list", async () => {
    const id = (await createHandoff(systemCtx(), "Darkest-Teddy", { body: "Qwxyzzy plover frobnicate" })).handoff.id;
    const r = (await (await claim(id)).json()) as HandoffClaimResult;
    expect(r.reading_list).toEqual([]);
  });
});

describe("the reading list — scope", () => {
  it("is this org's only: a closer match in another org never appears", async () => {
    await insertDoc("zephyr-ledger", "Zephyr ledger", ZEPHYR_TEXT);
    await insertDoc("zephyr-ledger-b", "Zephyr ledger checksum compaction", `${ZEPHYR_TEXT} ${ZEPHYR_TEXT}`, { org: ORG_B });
    const r = (await (await claim(await sendZephyr())).json()) as HandoffClaimResult;
    expect(ids(r)).toContain("doc:zephyr-ledger");
    expect(ids(r)).not.toContain("doc:zephyr-ledger-b");
  });

  it("only what the claimer can see: their own private artifact yes, someone else's private one never", async () => {
    const ctx = systemCtx();
    const mk = async (title: string, author: string, visibility: "org" | "private") => {
      const a = await createPage(ctx, { title, kind: "markdown", content: `# ${title}\n\n${ZEPHYR_TEXT}`, area: "data", visibility }, author);
      await patchPage(ctx, a.slug, { status: "published" }, author);
      return a.slug;
    };
    const mine = await mk("Zephyr ledger notes (mine)", "AndresL230", "private");
    const theirs = await mk("Zephyr ledger notes (theirs)", "lpcooper-arch", "private");
    const shared = await mk("Zephyr ledger notes (team)", "lpcooper-arch", "org");
    const r = (await (await claim(await sendZephyr())).json()) as HandoffClaimResult;
    expect(ids(r)).toEqual(expect.arrayContaining([`artifact:${mine}`, `artifact:${shared}`]));
    expect(ids(r)).not.toContain(`artifact:${theirs}`);
  });

  it("settled content only: no unpromoted doc, no draft decision, no draft artifact", async () => {
    await insertDoc("zephyr-unpromoted", "Zephyr ledger checksum draft", ZEPHYR_TEXT, { version: 0 });
    await run(env.DB, `INSERT INTO adrs (title, context, decision, rationale, status, confidence, created_at, created_by)
                       VALUES ('Zephyr ledger checksum', ?, 'Keep segment order', 'checksum', 'draft', 'high', '2026-10-01T00:00:00Z', 'AndresL230')`, ZEPHYR_TEXT);
    const draft = await createPage(systemCtx(), { title: "Zephyr ledger checksum sketch", kind: "markdown", content: ZEPHYR_TEXT, area: "data" }, "AndresL230");
    await insertDoc("zephyr-live", "Zephyr ledger", ZEPHYR_TEXT);
    const r = (await (await claim(await sendZephyr())).json()) as HandoffClaimResult;
    expect(ids(r)).toContain("doc:zephyr-live");
    expect(ids(r)).not.toContain("doc:zephyr-unpromoted");
    expect(r.reading_list!.some((x) => x.kind === "decision")).toBe(false);
    expect(ids(r)).not.toContain(`artifact:${draft.slug}`);
  });

  it("never lists a handoff's feed announcement (its own echoes every word)", async () => {
    await insertDoc("zephyr-live", "Zephyr ledger", ZEPHYR_TEXT);
    const id = await sendZephyr();
    const r = (await (await claim(id)).json()) as HandoffClaimResult;
    expect(r.reading_list!.some((x) => x.kind === "feed" && /left a handoff/.test(x.title))).toBe(false);
  });
});

describe("MCP claim_handoff — the section", () => {
  it("ends with '## Read these first (not complete)', each item with how to open it", async () => {
    const r = await mcpClaim("AndresL230", 15);
    expect(r.isError).toBeFalsy();
    const at = r.text.indexOf(`## ${HANDOFF_READING_HEADING}`);
    expect(at).toBeGreaterThan(r.text.indexOf("## Context"));
    const section = r.text.slice(at);
    expect(section).toContain("not everything that bears on the task");
    expect(section).toContain("- Doc: Document Pipeline (Upload, OCR & Streaming) (get_doc slug `sapling-document-pipeline`)");
  });

  it("an empty list draws no section; a list that could not be built says so", async () => {
    const id = (await createHandoff(systemCtx(), "Darkest-Teddy", { body: "Qwxyzzy plover frobnicate" })).handoff.id;
    const r = await mcpClaim("AndresL230", id);
    expect(r.text).not.toContain(HANDOFF_READING_HEADING);
    expect(readingListAsMarkdown([])).toBe("");
    expect(readingListAsMarkdown(null)).toContain("Couldn't build the reading list");
  });
});
