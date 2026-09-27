// GET /search/quick — the "search everything" dropdown's read (src/tools/quick-search.ts).
// Every type found, prefix matching, FTS-syntax input safe, the visibility rules
// (another person's private artifact, a handoff not addressed to me, live-only for
// humans), the per-group limit, and a short query answering without touching D1.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor, seedPerson } from "./helpers/persons";
import { propose_doc_update, promote_doc, append_feed, stage_adr, ratify_adr } from "../src/tools/writes";
import { create_ticket } from "../src/tools/tickets";
import { create_sprint } from "../src/tools/sprints";
import { savePrompt } from "../src/tools/prompts";
import { createHandoff } from "../src/tools/handoffs";
import { quickSearch, buildPrefixMatch } from "../src/tools/quick-search";
import { createText, wf, jsonInit } from "./helpers/artifacts";
import type { QuickSearchResult, QuickType } from "@shared/quick-search";

const ME = "quickme";
const OTHER = "quickother";

async function quick(q: string, who = ME, extra = ""): Promise<QuickSearchResult> {
  const res = await app.request(`/search/quick?q=${encodeURIComponent(q)}${extra}`, { headers: { cookie: await cookieFor(who) } }, env);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { result: QuickSearchResult; degraded?: boolean };
  expect(body.degraded, `degraded answer for ${JSON.stringify(q)}`).toBeUndefined();   // a swallowed error is a failure
  return body.result;
}
const ids = (r: QuickSearchResult, type: QuickType): string[] => r.groups.find((g) => g.type === type)?.hits.map((h) => h.id) ?? [];

beforeEach(async () => { await seedPerson(ME, { name: "Quincy Me" }); await seedPerson(OTHER, { name: "Otto Other" }); });

/** A text artifact, published (create makes v1 a draft). */
async function publishedText(cookie: string, o: Record<string, unknown>): Promise<void> {
  const page = await createText(cookie, o);
  const res = await wf(`/api/artifacts/${page.slug}`, jsonInit("PATCH", { status: "published" }, cookie));
  expect(res.status).toBe(200);
}

async function liveDoc(slug: string, title: string, body: string): Promise<void> {
  await propose_doc_update(env.DB, { slug, section: "reference", title, body, change_summary: "s", confidence: "high" }, "agent");
  await promote_doc(env.DB, slug, 1, "agent");
}

describe("GET /search/quick — every type", () => {
  it("finds a ticket, doc, decision, sprint, artifact, prompt, handoff, person and feed entry by one word", async () => {
    await seedPerson("zebrafan", { name: "Zebra Person" });
    const tid = await create_ticket(env.DB, { title: "Zebra crossing is broken", body: "", category: "bug", priority: "normal", assignees: [] }, ME);
    await liveDoc("zebra-doc", "Zebra runbook", "how the zebra pipeline deploys");
    const adr = await stage_adr(env.DB, { title: "Adopt zebra stripes", context: "c", decision: "use zebra", rationale: "r", confidence: "high" }, "agent");
    await ratify_adr(env.DB, adr);
    const sp = await create_sprint(env.DB, { label: "Zebra sprint", urgency: "normal" }, ME);
    await publishedText(await cookieFor(ME), { title: "Zebra diagram", content: "# zebra" });
    await savePrompt(env.DB, ME, { slug: "zebra-review", title: "Zebra review", body: "Review the zebra", status: "published", description: "Checks stripes" }, "human");
    const { handoff } = await createHandoff(env.DB, OTHER, { recipient: ME, body: "Finish the zebra migration" });
    await append_feed(env.DB, { author: ME, summary: "Shipped the zebra importer", brief: "Imports zebras now." });

    const r = await quick("zebra");
    expect(ids(r, "ticket")).toEqual([String(tid)]);
    expect(ids(r, "doc")).toEqual(["zebra-doc"]);
    expect(ids(r, "decision").length).toBe(1);
    expect(ids(r, "sprint")).toContain(`sprint:${sp.id}`);
    expect(r.groups.find((g) => g.type === "artifact")?.hits[0]?.title).toBe("Zebra diagram");
    expect(ids(r, "prompt")).toEqual(["zebra-review"]);
    expect(ids(r, "handoff")).toEqual([String(handoff.id)]);
    expect(ids(r, "person")).toEqual(["zebrafan"]);
    expect(r.groups.find((g) => g.type === "feed")?.hits[0]).toMatchObject({ title: "Shipped the zebra importer", snippet: "Imports zebras now." });
    // Groups come in the fixed order, and no hit carries a body.
    expect(r.groups.map((g) => g.type)).toEqual(["ticket", "doc", "decision", "sprint", "artifact", "prompt", "handoff", "person", "feed"]);
    for (const g of r.groups) for (const h of g.hits) expect(Object.keys(h)).not.toContain("body");
  });

  it("matches a partial last word (prefix), including one past the stem", async () => {
    await liveDoc("deploys", "Deployment pipeline", "the searching agent");
    expect(ids(await quick("deplo"), "doc")).toEqual(["deploys"]);
    expect(ids(await quick("pipel"), "doc")).toEqual(["deploys"]);
    // "searchi" is past the porter stem "search": the trimmed alternative still finds it.
    expect(ids(await quick("searchi"), "doc")).toEqual(["deploys"]);
    expect(buildPrefixMatch("searchi")).toBe(`("searchi"* OR "search"* OR "searc"*)`);
    expect(buildPrefixMatch("auth tok")).toBe(`"auth"* AND "tok"*`);
    // Two words where the LAST gets alternatives: a syntax error before the explicit AND.
    expect(buildPrefixMatch("pipeline deplo")).toBe(`"pipeline"* AND ("deplo"* OR "depl"*)`);
    expect(ids(await quick("pipeline deplo"), "doc")).toEqual(["deploys"]);
  });

  it("finds a ticket by its number, and a person by @handle or a word of their name", async () => {
    await seedPerson("qiulinzy", { name: "Qiu Linzy Chenq" });
    const tid = await create_ticket(env.DB, { title: "Unrelated title", body: "", category: "other", priority: "normal", assignees: [] }, ME);
    expect(ids(await quick(`#${tid}`), "ticket")[0]).toBe(String(tid));
    expect(ids(await quick("@qiulin"), "person")).toEqual(["qiulinzy"]);
    expect(ids(await quick("chenq"), "person")).toEqual(["qiulinzy"]);
  });

  it("never lists a reserved system handle", async () => {
    const r = await quick("github-webhook");
    expect(ids(r, "person")).toEqual([]);
  });
});

describe("GET /search/quick — safe input", () => {
  it.each([`"`, `zeb"ra`, `a OR b`, `org visible`, `feed brief`, `one two three four five six seven`, `NEAR(x y)`, `x AND NOT y`, `(((`, `*`, `-foo`, `col:foo`, `^start`, `100%`, `under_score`, `'; DROP TABLE docs; --`, `\\`, `🦓🦓`])(
    "%s → 200 with a well-formed answer", async (q) => {
      const r = await quick(q);
      expect(Array.isArray(r.groups)).toBe(true);
    });

  it("a LIKE wildcard is literal: `%` does not match every person or handoff", async () => {
    await seedPerson("percent1", { name: "Nobody" });
    expect(ids(await quick("%%"), "person")).toEqual([]);
    expect(ids(await quick("__"), "person")).toEqual([]);
  });
});

describe("GET /search/quick — visibility", () => {
  it("another person's private artifact is never returned; the author finds their own", async () => {
    await publishedText(await cookieFor(OTHER), { title: "Okapi secrets", content: "okapi", visibility: "private" });
    expect(ids(await quick("okapi", ME), "artifact")).toEqual([]);
    expect((await quick("okapi", OTHER)).groups.find((g) => g.type === "artifact")?.hits.map((h) => h.title)).toEqual(["Okapi secrets"]);
  });

  it("a draft artifact, an unpromoted doc and a draft decision are withheld (live-only, like /search)", async () => {
    await createText(await cookieFor(ME), { title: "Walrus draft", content: "walrus" }); // v1 = draft
    await propose_doc_update(env.DB, { slug: "walrus-doc", section: "reference", title: "Walrus doc", body: "walrus", change_summary: "s", confidence: "high" }, "agent");
    await stage_adr(env.DB, { title: "Walrus decision", context: "c", decision: "d", rationale: "r", confidence: "high" }, "agent");
    const r = await quick("walrus");
    expect(ids(r, "artifact")).toEqual([]);
    expect(ids(r, "doc")).toEqual([]);
    expect(ids(r, "decision")).toEqual([]);
  });

  it("a prompt with no published version is withheld; publishing it makes it findable", async () => {
    await savePrompt(env.DB, ME, { slug: "narwhal", title: "Narwhal prompt", body: "narwhal body", status: "staged" }, "human");
    expect(ids(await quick("narwhal"), "prompt")).toEqual([]);
    await savePrompt(env.DB, ME, { slug: "narwhal", title: "Narwhal prompt", body: "narwhal body v2", status: "published" }, "human");
    expect(ids(await quick("narwhal"), "prompt")).toEqual(["narwhal"]);
  });

  it("handoffs: mine, anyone's and ones I sent are found; one between two other people never is; expired never", async () => {
    await seedPerson(ME); await seedPerson(OTHER); await seedPerson("third");
    const toMe = (await createHandoff(env.DB, OTHER, { recipient: ME, body: "Ibex work for you" })).handoff.id;
    const toAnyone = (await createHandoff(env.DB, OTHER, { recipient: "anyone", body: "Ibex work for anyone" })).handoff.id;
    const sent = (await createHandoff(env.DB, ME, { recipient: OTHER, body: "Ibex work I sent" })).handoff.id;
    const private3 = (await createHandoff(env.DB, OTHER, { recipient: "third", body: "Ibex work for third" })).handoff.id;
    const expired = (await createHandoff(env.DB, OTHER, { recipient: ME, body: "Ibex expired" })).handoff.id;
    await env.DB.prepare(`UPDATE handoffs SET status = 'expired' WHERE id = ?`).bind(expired).run();
    const got = ids(await quick("ibex"), "handoff").map(Number).sort((a, b) => a - b);
    expect(got).toEqual([toMe, toAnyone, sent].sort((a, b) => a - b));
    expect(got).not.toContain(private3);
    // Not by id either.
    expect(ids(await quick(`#${private3}`), "handoff")).toEqual([]);
  });
});

describe("GET /search/quick — limits and short queries", () => {
  it("caps each group at `limit` (default 4, ceiling 8)", async () => {
    for (let i = 0; i < 10; i++) await create_ticket(env.DB, { title: `Gecko ticket ${i}`, body: "", category: "other", priority: "normal", assignees: [] }, ME);
    expect(ids(await quick("gecko"), "ticket").length).toBe(4);
    expect(ids(await quick("gecko", ME, "&limit=2"), "ticket").length).toBe(2);
    expect(ids(await quick("gecko", ME, "&limit=50"), "ticket").length).toBe(8);
    expect((await quick("gecko", ME, "&types=doc")).groups).toEqual([]);
  });

  it("an empty, 1-character or symbols-only query answers with no groups and never touches D1", async () => {
    const noDb = new Proxy({}, { get() { throw new Error("D1 touched"); } }) as unknown as D1Database;
    for (const q of ["", " ", "a", "  z ", "!!", "@@"]) {
      expect(await quickSearch(noDb, q, ME)).toEqual({ q: q.trim(), groups: [] });
    }
    expect((await quick("a")).groups).toEqual([]);
  });

  it("needs a session (401 without one)", async () => {
    expect((await app.request("/search/quick?q=zebra", {}, env)).status).toBe(401);
  });
});
