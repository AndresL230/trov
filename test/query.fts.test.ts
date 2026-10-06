import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { query } from "../src/tools/reads";
import { propose_doc_update, promote_doc, append_feed, stage_adr, ratify_adr } from "../src/tools/writes";
import { create_ticket } from "../src/tools/tickets";
import { seedPerson } from "./helpers/persons";
import { run, all, nowIso } from "../src/db";

const AUTHOR = "tester";

// Stage a doc version (creates the docs row with an empty live body on v1).
async function stageDoc(slug: string, title: string, body: string, section = "reference") {
  return propose_doc_update(systemCtx(), { slug, section, title, body, change_summary: "s", confidence: "high" }, AUTHOR);
}

describe("query() — FTS5 engine (triggers, ranking, bundle, authority, browse)", () => {
  it("trigger sync: a promoted body becomes searchable; deleting the doc clears it", async () => {
    await stageDoc("sync-doc", "Sync Doc", "placeholder");
    // Not yet promoted: live body is empty, only the title is indexed.
    let r = await query(systemCtx(), { q: "zephyr", include_staged: false });
    expect(r.primary.length).toBe(0);

    // Stage a real body and promote it — the body-UPDATE trigger re-indexes.
    const v2 = await propose_doc_update(
      systemCtx(),
      { slug: "sync-doc", section: "reference", body: "the zephyr subsystem", change_summary: "s", confidence: "high" },
      AUTHOR
    );
    await promote_doc(systemCtx(), "sync-doc", v2.version, AUTHOR);

    r = await query(systemCtx(), { q: "zephyr" });
    expect(r.primary.map((p) => p.id)).toContain("sync-doc");
    expect(r.primary.find((p) => p.id === "sync-doc")?.authority).toBe("live");

    // Deleting the base row cascades to docs_fts (the AFTER DELETE trigger).
    // (doc_versions FKs docs.slug, so clear versions first.)
    await run(env.DB, `DELETE FROM doc_versions WHERE slug = ?`, "sync-doc");
    await run(env.DB, `DELETE FROM docs WHERE slug = ?`, "sync-doc");
    r = await query(systemCtx(), { q: "zephyr" });
    expect(r.primary.length).toBe(0);
  });

  it("ranking: a title-term match outranks a body-term match", async () => {
    await stageDoc("needle-titled", "Needle Guide", "alpha content with no match term");
    await promote_doc(systemCtx(), "needle-titled", 1, AUTHOR);
    await stageDoc("needle-bodied", "Beta Guide", "the needle lives only in this body");
    await promote_doc(systemCtx(), "needle-bodied", 1, AUTHOR);

    const r = await query(systemCtx(), { q: "needle" });
    expect(r.primary.length).toBe(2);
    expect(r.primary[0].id).toBe("needle-titled");
    const titled = r.primary.find((p) => p.id === "needle-titled")!;
    const bodied = r.primary.find((p) => p.id === "needle-bodied")!;
    expect(titled.score).toBeGreaterThan(bodied.score);
  });

  it("bundle shape: primary carries FULL bodies, pointers carry snippets, counts honored", async () => {
    const fullBody = "widget ".repeat(60).trim(); // long enough that a snippet must truncate
    for (let i = 0; i < 5; i++) {
      await append_feed(systemCtx(), { author: AUTHOR, summary: `widget entry ${i}`, body: fullBody });
    }
    const r = await query(systemCtx(), { q: "widget", types: ["feed"], limit: 2, pointer_limit: 2 });
    expect(r.primary.length).toBe(2);
    expect(r.pointers.length).toBe(2);
    expect(r.meta).toEqual({ engine: "fts5", total: 4 });
    // primary bodies are the FULL stored body, not a snippet.
    expect(r.primary[0].body).toBe(fullBody);
    // pointers are snippets (shorter than the full body) with a score.
    expect(r.pointers[0].snippet.length).toBeLessThan(fullBody.length);
    expect(typeof r.pointers[0].score).toBe("number");
  });

  it("authority: unpromoted doc — agent sees staged content (via title match), human does not", async () => {
    // An unpromoted doc has an empty LIVE body, so only its title is FTS-indexed;
    // the agent finds it by title and the engine reaches the staged body at hydration.
    await stageDoc("draft-doc", "Quokka Feature", "the body explains the unpromoted feature");

    const agent = await query(systemCtx(), { q: "quokka", include_staged: true });
    const a = agent.primary.find((p) => p.id === "draft-doc");
    expect(a?.authority).toBe("unpromoted");
    expect(a?.current_version).toBe(0);
    expect(a?.body).toBe("the body explains the unpromoted feature"); // staged body surfaced to the agent

    const human = await query(systemCtx(), { q: "quokka", include_staged: false });
    expect(human.primary.find((p) => p.id === "draft-doc")).toBeUndefined();
    expect(human.pointers.find((p) => p.id === "draft-doc")).toBeUndefined();
  });

  it("authority: staged_pending sets pending_version; staged_body only for the agent", async () => {
    await stageDoc("evolving", "Evolving Doc", "live cabbage body");
    await promote_doc(systemCtx(), "evolving", 1, AUTHOR); // v1 live
    await propose_doc_update(
      systemCtx(),
      { slug: "evolving", section: "reference", body: "cabbage body, revised draft", change_summary: "s", confidence: "high" },
      AUTHOR
    ); // v2 staged

    const agent = await query(systemCtx(), { q: "cabbage", include_staged: true });
    const a = agent.primary.find((p) => p.id === "evolving")!;
    expect(a.authority).toBe("staged_pending");
    expect(a.current_version).toBe(1);
    expect(a.pending_version).toBe(2);
    expect(a.body).toBe("live cabbage body");          // body is the LIVE promoted body
    expect(a.staged_body).toBe("cabbage body, revised draft");

    const human = await query(systemCtx(), { q: "cabbage", include_staged: false });
    const h = human.primary.find((p) => p.id === "evolving")!;
    expect(h.authority).toBe("staged_pending");        // still surfaced (live body stands)
    expect(h.body).toBe("live cabbage body");
    expect(h.staged_body).toBeNull();                  // but the staged body is withheld
  });

  it("authority: ratified decision is live, draft decision is hidden from humans", async () => {
    const draftId = await stage_adr(systemCtx(), { title: "Draft Decision", context: "ctx kiwi", decision: "use kiwi", rationale: "kiwi is ripe", confidence: "high" }, AUTHOR);
    const ratId = await stage_adr(systemCtx(), { title: "Ratified Decision", context: "ctx kiwi", decision: "adopt kiwi", rationale: "kiwi is best", confidence: "high" }, AUTHOR);
    await ratify_adr(systemCtx(), ratId);

    const agent = await query(systemCtx(), { q: "kiwi", types: ["decision"], include_staged: true });
    const byId = new Map(agent.primary.map((p) => [p.id, p]));
    expect(byId.get(String(draftId))?.authority).toBe("draft");
    expect(byId.get(String(ratId))?.authority).toBe("live");

    const human = await query(systemCtx(), { q: "kiwi", types: ["decision"], include_staged: false });
    expect(human.primary.find((p) => p.id === String(draftId))).toBeUndefined();
    expect(human.primary.find((p) => p.id === String(ratId))?.authority).toBe("live");
  });

  it("empty q: degrades to a recency browse filtered by type", async () => {
    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-02-01T00:00:00.000Z";
    const t3 = "2026-03-01T00:00:00.000Z";
    await run(env.DB, `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, 'oldest', 'b', NULL, ?)`, AUTHOR, t1);
    await run(env.DB, `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, 'middle', 'b', NULL, ?)`, AUTHOR, t2);
    await run(env.DB, `INSERT INTO feed (author, summary, body, artifacts, created_at) VALUES (?, 'newest', 'b', NULL, ?)`, AUTHOR, t3);

    const r = await query(systemCtx(), { q: "", types: ["feed"] });
    expect(r.primary.map((p) => p.title)).toEqual(["newest", "middle", "oldest"]);
    expect(r.meta.engine).toBe("fts5");
  });

  it("tickets are NOT in the search fan-out — a ticket title term returns no ticket, though tickets_fts holds the row", async () => {
    await seedPerson(AUTHOR);
    // The same term in a ticket TITLE, a doc body and a feed body. The doc and the
    // feed entry come back; the ticket does NOT — tickets have their own surface.
    const id = await create_ticket(
      systemCtx(),
      { title: "Gradebook tamarind export fails", body: "over 1,000 rows", category: "bug", priority: "high", assignees: [] },
      AUTHOR
    );
    await stageDoc("tamarind-doc", "Unrelated Guide", "a passing mention of tamarind in the body");
    await promote_doc(systemCtx(), "tamarind-doc", 1, AUTHOR);
    await append_feed(systemCtx(), { author: AUTHOR, summary: "unrelated entry", body: "tamarind again, in a feed body" });

    // The index IS populated — 0024's triggers still run; only the fan-out dropped it.
    const indexed = await all<{ ticket_id: number }>(
      env.DB, `SELECT ticket_id FROM tickets_fts WHERE tickets_fts MATCH 'tamarind'`
    );
    expect(indexed.map((r) => Number(r.ticket_id))).toContain(id);

    // Agent-side query (include_staged defaults true here): no ticket anywhere.
    const r = await query(systemCtx(), { q: "tamarind" });
    const ids = [...r.primary, ...r.pointers].map((p) => p.id);
    expect(ids).not.toContain(`ticket:${id}`);
    expect(ids.some((x) => x.startsWith("ticket:"))).toBe(false);
    expect([...r.primary, ...r.pointers].some((p) => (p.type as string) === "ticket")).toBe(false);
    expect(r.primary.map((p) => p.title)).not.toContain("Gradebook tamarind export fails");
    // …and the other two types are unaffected.
    expect(r.primary.map((p) => p.id)).toContain("tamarind-doc");
    expect(r.primary.map((p) => p.type)).toContain("feed");

    // The HUMAN search (include_staged:false) doesn't get one either.
    const human = await query(systemCtx(), { q: "tamarind", include_staged: false });
    expect([...human.primary, ...human.pointers].some((p) => p.id.startsWith("ticket:"))).toBe(false);

    // An empty-q browse (the recency degrade path) has no ticket branch either.
    const browse = await query(systemCtx(), { q: "" });
    expect([...browse.primary, ...browse.pointers].some((p) => p.id.startsWith("ticket:"))).toBe(false);
  });

  it("section filter narrows to docs and excludes feed/decision", async () => {
    await stageDoc("ctx-doc", "Context Doc", "mango note", "context");
    await promote_doc(systemCtx(), "ctx-doc", 1, AUTHOR);
    await append_feed(systemCtx(), { author: AUTHOR, summary: "mango feed", body: "mango" });

    const r = await query(systemCtx(), { q: "mango", section: "context" });
    expect(r.primary.every((p) => p.type === "doc")).toBe(true);
    expect(r.primary.map((p) => p.id)).toContain("ctx-doc");
    void nowIso;
  });
});
