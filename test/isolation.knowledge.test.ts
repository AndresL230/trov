// Cross-tenant isolation for the Knowledge modules (canopy-multitenancy.md §10.2): docs, feed, search
// (FTS and quick search), triage, ADRs / proposals, tickets as reads.ts lists them, and the ingest
// gate's ledger and dedupe. Content written under one org is invisible and unmodifiable from the
// other; a write in B neither dedupes against nor touches A's rows.
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { IngestPayload, type CapturedEvent } from "@shared/contract";
import type { AdrRow, DocRow, DocVersionRow, NeedsTriageRow } from "@shared/rows";
import { app } from "../src/routes";
import { all, first, run } from "./helpers/db";
import { consume, ingestAdrDraft, ingestDocProposal, ingestEvent, ingestFeedEntry, ingestRepoEvent } from "../src/consumer";
import {
  get_doc, get_feed, get_ticket, list_adrs, list_discarded_identities, list_doc_meta, list_docs, list_identity_tasks,
  list_needs_triage, list_proposals, list_tickets, query, ticket_badge,
} from "../src/tools/reads";
import {
  append_feed, assign_triage, discard_identity_task, ensure_identity_task, IdentityTaskError, promote_doc, propose_doc_update,
  ratify_adr, reject_adr, reject_doc_version, resolve_triage, restore_identity_task, route_triage, stage_adr,
} from "../src/tools/writes";
import { quickSearch } from "../src/tools/quick-search";
import { savePrompt } from "../src/tools/prompts";
import { write_plan } from "../src/tools/plan";
import { feedStats } from "../src/tools/feed-stats";
import { storeIssueSummary, storePrSummary } from "../src/tools/summarize";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B, ensureMember, platformCtx, systemCtx } from "./helpers/tenant";

const A = systemCtx(ORG_A);
const B = systemCtx(ORG_B);
const P = platformCtx();
const T = "2026-10-06T00:00:00.000Z";
const WHO = "iso-author";

beforeEach(async () => {
  await run(env.DB, `INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by) VALUES (?, 'acme', 'Acme', ?, 'test')`, ORG_B, T);
});

const doc = (slug: string, body: string) =>
  ({ slug, section: "reference", title: `Wombat ${slug}`, body, change_summary: "s", confidence: "high" as const });
const adr = { title: "Adopt wombat burrows", context: "c", decision: "burrow", rationale: "r", confidence: "high" as const };
const versionsOf = (org: string, slug: string) =>
  all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE org_id = ? AND slug = ? ORDER BY version`, org, slug);

describe("docs and proposals", () => {
  it("a doc staged in A is not readable, listable or proposable-against from B", async () => {
    await propose_doc_update(A, doc("iso-doc", "wombat body"), WHO);

    expect(await get_doc(A, "iso-doc")).not.toBeNull();
    expect(await get_doc(B, "iso-doc")).toBeNull();
    expect(await list_docs(B)).toEqual([]);
    expect(await list_docs(B, "reference")).toEqual([]);
    expect(await list_doc_meta(B)).toEqual([]);
    expect(await list_proposals(B)).toEqual([]);
    expect((await list_proposals(A)).map((p) => p.slug)).toContain("iso-doc");
  });

  it("B cannot promote or reject A's version; A's row is untouched", async () => {
    await propose_doc_update(A, doc("iso-doc", "wombat body"), WHO);

    await expect(promote_doc(B, "iso-doc", 1, "intruder")).rejects.toThrow("no such doc version");
    await expect(reject_doc_version(B, "iso-doc", 1)).rejects.toThrow("no such doc version");
    expect((await versionsOf(ORG_A, "iso-doc")).map((v) => v.status)).toEqual(["staged"]);
    expect((await get_doc(A, "iso-doc"))?.doc.current_version).toBe(0);
  });

  it("the same slug is a different doc in each org: versions, promotion and bodies never cross", async () => {
    await propose_doc_update(A, doc("shared-slug", "A body"), WHO);
    await propose_doc_update(A, doc("shared-slug", "A body two"), WHO);
    const inB = await propose_doc_update(B, doc("shared-slug", "B body"), "bee");
    expect(inB.version).toBe(1); // not 3: B's version counter is its own

    await promote_doc(B, "shared-slug", 1, "bee");
    const a = await get_doc(A, "shared-slug");
    const b = await get_doc(B, "shared-slug");
    expect(a?.doc).toMatchObject({ current_version: 0, body: "", owner: WHO });
    expect(a?.versions.map((v) => v.status)).toEqual(["staged", "staged"]);
    expect(b?.doc).toMatchObject({ current_version: 1, body: "B body", owner: "bee" });
    expect(b?.versions.map((v) => v.body)).toEqual(["B body"]);
  });
});

describe("feed", () => {
  it("an entry and its tags appended in A reach neither B's feed nor B's stats", async () => {
    const id = await append_feed(A, { author: WHO, summary: "wombat shipped", body: "b", tags: ["infra"] });

    expect((await get_feed(A, { author: WHO })).map((f) => f.id)).toEqual([id]);
    expect((await get_feed(A, { author: WHO, tags: ["infra"] })).map((f) => f.id)).toEqual([id]);
    expect(await get_feed(B)).toEqual([]);
    expect(await get_feed(B, { author: WHO })).toEqual([]);
    expect(await get_feed(B, { tags: ["infra"] })).toEqual([]);

    const stats = await feedStats(B, { days: 7 });
    expect(stats).toMatchObject({ total: 0, people: 0, topTags: [], topAuthors: [] });
    expect((await feedStats(A, { days: 7 })).topAuthors.map((t) => t.author)).toContain(WHO);
  });

  it("a feed id from A tagged in B's entry_tags does not surface A's entry", async () => {
    const id = await append_feed(A, { author: WHO, summary: "wombat shipped" });
    await run(env.DB, `INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, 'api', 'feed', ?)`, ORG_B, String(id));
    expect(await get_feed(B, { tags: ["api"] })).toEqual([]);
    expect(await get_feed(A, { author: WHO, tags: ["api"] })).toEqual([]);
  });
});

describe("search", () => {
  async function seedA(): Promise<{ ticket: number; sprint: number }> {
    await seedPerson(WHO, { name: "Iso Author" });
    await propose_doc_update(A, doc("wombat-doc", "the wombat pipeline"), WHO);
    await promote_doc(A, "wombat-doc", 1, WHO);
    await append_feed(A, { author: WHO, summary: "wombat importer shipped", brief: "imports wombats" });
    await ratify_adr(A, await stage_adr(A, adr, WHO));
    const t = await run(env.DB, `INSERT INTO tickets (org_id, title, requester, created_at, updated_at) VALUES (?, 'wombat crossing broken', ?, ?, ?)`, ORG_A, WHO, T, T);
    const s = await run(env.DB, `INSERT INTO sprints (org_id, title, target_date, status, created_at, created_by) VALUES (?, 'wombat sprint', '2026-11-01', 'upcoming', ?, ?)`, ORG_A, T, WHO);
    await run(env.DB, `INSERT INTO handoffs (org_id, sender, recipient, body, created_at, expires_at) VALUES (?, ?, 'anyone', 'finish the wombat migration', ?, '2099-01-01T00:00:00Z')`, ORG_A, WHO, T);
    await run(env.DB, `INSERT INTO prompts (org_id, slug, title, description, tags, author, current_version, created_at, updated_at) VALUES (?, 'wombat-review', 'Wombat review', 'checks wombats', '[]', ?, 1, ?, ?)`, ORG_A, WHO, T, T);
    await run(env.DB, `INSERT INTO prompt_versions (org_id, slug, version, status, author, summary, body, created_at) VALUES (?, 'wombat-review', 1, 'published', ?, 's', 'review the wombat', ?)`, ORG_A, WHO, T);
    return { ticket: t.meta.last_row_id as number, sprint: s.meta.last_row_id as number };
  }

  it("query(): FTS hits and the browse list stop at the org", async () => {
    await seedA();
    const types = ["doc", "decision", "feed", "sprint"] as const;

    const inA = await query(A, { q: "wombat", types: [...types], include_staged: true });
    expect(new Set(inA.primary.map((p) => p.type))).toEqual(new Set(types));

    const inB = await query(B, { q: "wombat", include_staged: true, limit: 50, pointer_limit: 100 });
    expect(inB).toMatchObject({ primary: [], pointers: [] });
    const browseB = await query(B, { q: "", include_staged: true, limit: 50, pointer_limit: 100 });
    expect(browseB).toMatchObject({ primary: [], pointers: [] });
    expect(await query(B, { q: "wombat", section: "reference", include_staged: true })).toMatchObject({ primary: [], pointers: [] });
  });

  it("query(): B's own content is found, and only B's", async () => {
    await seedA();
    await propose_doc_update(B, doc("wombat-doc", "B's wombat notes"), "bee");
    const inB = await query(B, { q: "wombat", include_staged: true });
    expect(inB.primary.map((p) => [p.type, p.id, p.body])).toEqual([["doc", "wombat-doc", "B's wombat notes"]]);
    const docA = (await query(A, { q: "wombat", types: ["doc"], include_staged: true })).primary;
    expect(docA.map((p) => p.body)).toEqual(["the wombat pipeline"]);
  });

  it("quickSearch(): no group of A's reaches B — FTS types, the exact ticket number, handoffs and people", async () => {
    const { ticket } = await seedA();
    await seedPerson("wombatfan", { name: "Wombat Fan" });

    const inA = await quickSearch(A, "wombat", WHO, { limit: 8 });
    expect(inA.groups.map((g) => g.type).sort()).toEqual(["decision", "doc", "feed", "handoff", "person", "prompt", "sprint", "ticket"]);

    expect((await quickSearch(B, "wombat", WHO, { limit: 8 })).groups).toEqual([]);
    expect((await quickSearch(B, `#${ticket}`, WHO)).groups).toEqual([]);
    expect((await quickSearch(A, `#${ticket}`, WHO)).groups.find((g) => g.type === "ticket")?.hits.map((h) => h.id)).toEqual([String(ticket)]);

    // A person is a hit only in an org they are a member of — and the line under their name is the
    // title they hold in THAT org (`memberships.title`), never `persons.role` and never the other org's.
    await ensureMember("wombatfan", "member", ORG_B);
    await run(env.DB, `UPDATE persons SET role = 'stale global role' WHERE handle = 'wombatfan'`);
    await run(env.DB, `UPDATE memberships SET title = 'Marsupial lead' WHERE org_id = ? AND user_id = 'wombatfan'`, ORG_A);
    expect((await quickSearch(B, "wombat", WHO)).groups).toEqual([
      { type: "person", hits: [expect.objectContaining({ id: "wombatfan", snippet: null })] },
    ]);
    await run(env.DB, `UPDATE memberships SET title = 'Contractor' WHERE org_id = ? AND user_id = 'wombatfan'`, ORG_B);
    const person = async (ctx: typeof A) => (await quickSearch(ctx, "wombat", WHO, { types: ["person"] })).groups[0]?.hits[0]?.snippet;
    expect([await person(A), await person(B)]).toEqual(["Marsupial lead", "Contractor"]);
  });

  it("tickets as reads.ts serves them: list, detail and badge are per org", async () => {
    const { ticket, sprint } = await seedA();
    await run(env.DB, `UPDATE tickets SET sprint_id = ? WHERE id = ?`, sprint, ticket);

    expect((await list_tickets(A, { seg: "all" })).map((t) => t.id)).toContain(ticket);
    expect((await get_ticket(A, ticket))?.sprint).toEqual({ id: sprint, label: "wombat sprint" });
    expect(await list_tickets(B, { seg: "all" })).toEqual([]);
    expect(await get_ticket(B, ticket)).toBeNull();
    expect(await ticket_badge(B)).toBe(0);
    expect(await ticket_badge(A)).toBeGreaterThan(0);
  });
});

describe("triage", () => {
  it("an item routed in A is not listed, resolvable or assignable from B", async () => {
    const id = await route_triage(A, { raw: doc("triaged-doc", "x"), reason: "low confidence", source_author: WHO });

    expect((await list_needs_triage(A)).map((t) => t.id)).toContain(id);
    expect(await list_needs_triage(B)).toEqual([]);
    await expect(resolve_triage(B, id, "intruder")).rejects.toThrow("no such triage item");
    await expect(assign_triage(B, id, "intruder", { type: "doc" })).rejects.toThrow("no such triage item");

    const row = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    expect(row).toMatchObject({ resolved: 0, resolved_by: null });
    expect(await get_doc(B, "triaged-doc")).toBeNull();
  });

  it("assigning in A materialises in A only", async () => {
    const id = await route_triage(A, { raw: doc("triaged-doc", "x"), reason: "low confidence", source_author: WHO });
    const res = await assign_triage(A, id, WHO, { type: "doc" });
    expect(res.assigned_ref).toBe("doc:triaged-doc@1");
    expect(await get_doc(A, "triaged-doc")).not.toBeNull();
    expect(await get_doc(B, "triaged-doc")).toBeNull();
    expect(await all(env.DB, `SELECT 1 FROM processed_items WHERE org_id = ?`, ORG_B)).toEqual([]);
  });
});

describe("ADRs", () => {
  it("a draft staged in A is not listed, ratifiable or rejectable from B", async () => {
    const id = await stage_adr(A, adr, WHO);

    expect((await list_adrs(A, "draft")).map((a) => a.id)).toContain(id);
    expect(await list_adrs(B)).toEqual([]);
    expect(await list_adrs(B, "draft")).toEqual([]);
    await expect(ratify_adr(B, id)).rejects.toThrow("no such adr");
    await expect(reject_adr(B, id)).rejects.toThrow("no such adr");
    expect((await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id))?.status).toBe("draft");
  });

  it("the content-hash dedupe is per org", async () => {
    const inA = await ingestAdrDraft(A, adr, WHO);
    expect(inA.outcome).toBe("written");
    expect((await ingestAdrDraft(A, adr, WHO)).outcome).toBe("unchanged");

    const inB = await ingestAdrDraft(B, adr, "bee"); // identical content, another org: staged, not a duplicate
    expect(inB.outcome).toBe("written");
    expect((await ingestAdrDraft(B, adr, "bee")).outcome).toBe("unchanged");
    expect((await list_adrs(B)).map((a) => a.created_by)).toEqual(["bee"]);
  });
});

describe("the ingest gate", () => {
  const entry = { summary: "wombat shipped", body: "b", tags: ["infra"], artifacts: { prs: [], commits: [], issues: [] } };

  it("the replay ledger keys on the org: the same (session, index) is a first delivery in each", async () => {
    const ledger = { sessionId: "S-shared", itemIndex: 0 };
    expect((await ingestFeedEntry(A, entry, WHO, ledger)).outcome).toBe("written");
    expect((await ingestFeedEntry(B, entry, "bee", ledger)).outcome).toBe("written");
    expect((await ingestFeedEntry(A, entry, WHO, ledger)).outcome).toBe("unchanged");
    expect((await ingestFeedEntry(B, entry, "bee", ledger)).outcome).toBe("unchanged");

    expect((await get_feed(B)).map((f) => f.author)).toEqual(["bee"]);
    const rows = await all<{ org_id: string }>(env.DB, `SELECT org_id FROM processed_items WHERE session_id = 'S-shared' ORDER BY org_id`);
    expect(rows.map((r) => r.org_id)).toEqual([ORG_B, ORG_A]);
  });

  it("doc reconciliation reads the org's own doc: an identical body in A is not `unchanged` in B", async () => {
    const p = { ...doc("gate-doc", "same body"), space: "technical" as const, force: false };
    expect((await ingestDocProposal(A, p, WHO)).outcome).toBe("written");
    expect((await ingestDocProposal(A, p, WHO)).outcome).toBe("unchanged");

    const inB = await ingestDocProposal(B, p, "bee");
    expect(inB).toMatchObject({ outcome: "written", version: 1, change_kind: "new", base_version: null });

    // A low-confidence proposal for a slug that exists only in A is a NEW doc in B: triaged, in B.
    const low = await ingestDocProposal(B, { ...doc("only-in-a", "x"), confidence: "low", space: "technical", force: false }, "bee");
    await propose_doc_update(A, doc("only-in-a", "x"), WHO);
    expect(low.outcome).toBe("triaged");
    expect((await ingestDocProposal(B, { ...doc("only-in-a", "y"), confidence: "low", space: "technical", force: false }, "bee")).outcome).toBe("triaged");
    expect((await list_needs_triage(B)).length).toBe(2);
    expect((await list_needs_triage(A)).every((t) => t.source_author !== "bee")).toBe(true);
  });

  it("consume(): one payload, one session id, two orgs — each a full first run", async () => {
    const payload = IngestPayload.parse({
      session: { id: "S-both", author: "advisory", ended_at: T, skill_version: "2.0" },
      feed_entries: [entry],
      doc_proposals: [doc("consumed-doc", "line one\nline two")],
      adr_drafts: [{ ...adr, title: "Consume per org" }],
      needs_triage: [{ raw: "free text", reason: "unsure" }],
    });
    const fresh = { feed: { written: 1, unchanged: 0, triaged: 0 }, docs: { staged: 1, unchanged: 0, triaged: 0 },
      adrs: { staged: 1, unchanged: 0, triaged: 0 }, triage: { recorded: 1, unchanged: 0 } };
    const replay = { feed: { written: 0, unchanged: 1, triaged: 0 }, docs: { staged: 0, unchanged: 1, triaged: 0 },
      adrs: { staged: 0, unchanged: 1, triaged: 0 }, triage: { recorded: 0, unchanged: 1 } };

    expect(await consume(A, payload, { handle: WHO })).toEqual(fresh);
    expect(await consume(B, payload, { handle: "bee" })).toEqual(fresh);
    expect(await consume(B, payload, { handle: "bee" })).toEqual(replay);
    expect(await consume(A, payload, { handle: WHO })).toEqual(replay);

    expect((await get_feed(B)).length).toBe(1);
    expect((await list_docs(B)).map((d: DocRow) => [d.slug, d.owner])).toEqual([["consumed-doc", "bee"]]);
    expect((await list_adrs(B)).length).toBe(1);
    expect((await list_needs_triage(B)).length).toBe(1);
  });
});

describe("captured events, summaries and identity tasks", () => {
  const event = (login: string): CapturedEvent => ({
    semantic_key: "gh:pr:900:merged", event_type: "pr_merged", ref_number: 900, subject_login: login,
    raw: JSON.stringify({ pr: { number: 900, title: "PR 900", body: "b" } }), provenance: "webhook", occurred_at: T,
  });

  it("the same delivery is captured once per org, and its identity task is raised per org", async () => {
    expect((await ingestEvent(A, P, event("stranger-login"), "github-webhook")).outcome).toBe("written");
    expect((await list_identity_tasks(A)).map((t) => t.login)).toContain("stranger-login");
    expect(await list_identity_tasks(B)).toEqual([]);

    expect((await ingestEvent(B, P, event("stranger-login"), "github-webhook")).outcome).toBe("written");
    expect((await ingestEvent(B, P, event("stranger-login"), "github-webhook")).outcome).toBe("unchanged");
    expect((await list_identity_tasks(B)).map((t) => [t.login, t.sample.length])).toEqual([["stranger-login", 1]]);

    // Discarding in B leaves A's task pending; B cannot act on a login only A has seen.
    await discard_identity_task(B, "stranger-login", "bee");
    expect((await list_discarded_identities(B)).map((d) => d.login)).toEqual(["stranger-login"]);
    expect(await list_discarded_identities(A)).not.toContainEqual(expect.objectContaining({ login: "stranger-login" }));
    expect((await list_identity_tasks(A)).map((t) => t.login)).toContain("stranger-login");

    await ensure_identity_task(A, P, "only-a-login");
    await expect(discard_identity_task(B, "only-a-login", "bee")).rejects.toBeInstanceOf(IdentityTaskError);
    await expect(restore_identity_task(B, P, "only-a-login")).rejects.toMatchObject({ code: "not_found" });
  });

  it("PR / issue summaries and repo events are written in the caller's org", async () => {
    await ingestEvent(A, P, event("AndresL230"), "github-webhook");
    await ingestEvent(B, P, event("AndresL230"), "github-webhook");
    await storePrSummary(B, null, { semantic_key: "gh:pr:900:merged", pr_number: 900, title: "PR 900", body: "b" });
    await storeIssueSummary(B, null, { issue_number: 901, title: "Issue 901", body: "b" });
    expect(await all(env.DB, `SELECT org_id FROM pr_summaries WHERE semantic_key = 'gh:pr:900:merged'`)).toEqual([{ org_id: ORG_B }]);
    expect(await all(env.DB, `SELECT org_id FROM issue_summaries WHERE issue_number = 901`)).toEqual([{ org_id: ORG_B }]);

    const ev = { semantic_key: "gh:push:iso", kind: "push" as const, ref: "main", raw: "{}", provenance: "webhook" as const, occurred_at: T };
    expect((await ingestRepoEvent(A, ev)).outcome).toBe("written");
    expect((await ingestRepoEvent(B, ev)).outcome).toBe("written"); // not a redelivery of A's
    expect((await ingestRepoEvent(B, ev)).outcome).toBe("unchanged");
    expect((await all<{ org_id: string }>(env.DB, `SELECT org_id FROM repo_events WHERE semantic_key = 'gh:push:iso' ORDER BY org_id`)).map((r) => r.org_id)).toEqual([ORG_B, ORG_A]);
  });
});

describe("over HTTP: a member of B only", () => {
  it("reads none of A's knowledge and cannot change it", async () => {
    await propose_doc_update(A, doc("http-doc", "wombat over http"), WHO);
    const adrId = await stage_adr(A, adr, WHO);
    const triageId = await route_triage(A, { raw: "free", reason: "r", source_author: WHO });
    await append_feed(A, { author: WHO, summary: "wombat over http" });

    await seedPerson("bee", { member: false });
    await ensureMember("bee", "member", ORG_B);
    const cookie = await cookieFor("bee", { member: false });
    const get = async (path: string) => app.request(path, { headers: { cookie } }, env);
    const post = async (path: string, body: unknown = {}) =>
      app.request(path, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

    expect(await (await get("/docs")).json()).toEqual({ docs: [] });
    expect((await get("/doc/http-doc")).status).toBe(404);
    expect(await (await get("/feed")).json()).toEqual({ feed: [] });
    expect(await (await get("/proposals")).json()).toEqual({ proposals: [] });
    expect(await (await get("/adrs")).json()).toEqual({ adrs: [] });
    expect(await (await get("/needs-triage")).json()).toEqual({ items: [] });
    expect(await (await get("/search?q=wombat")).json()).toMatchObject({ result: { primary: [], pointers: [] } });
    expect(await (await get("/search/quick?q=wombat")).json()).toMatchObject({ result: { groups: [] } });

    expect((await post("/doc/http-doc/promote", { version: 1 })).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/adr/${adrId}/ratify`)).status).toBeGreaterThanOrEqual(400);
    expect((await post(`/needs-triage/${triageId}/discard`)).status).toBeGreaterThanOrEqual(400);
    expect((await versionsOf(ORG_A, "http-doc")).map((v) => v.status)).toEqual(["staged"]);
    expect((await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, adrId))?.status).toBe("draft");
    expect((await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, triageId))?.resolved).toBe(0);
  });
});

// Both orgs hold the SAME names — a doc slug, a prompt slug, the plan's fixed `plan` ref — so nothing
// but the org predicate tells their rows apart. (From the mutation spot check: each statement below
// survived having one org predicate neutralised while the two orgs' keys never collided.)
describe("two orgs with the same slugs and refs", () => {
  it("a doc proposal is deduped against THIS org's staged version, not a same-slug one elsewhere", async () => {
    await propose_doc_update(A, doc("shared", "first body"), WHO);
    await promote_doc(A, "shared", 1, WHO);
    await propose_doc_update(B, doc("shared", "second body"), WHO); // staged in B: the very body A is about to propose
    const r = await ingestDocProposal(A, doc("shared", "second body"), WHO);
    expect(r.outcome).toBe("written");
    expect((await versionsOf(ORG_A, "shared")).map((v) => v.status)).toEqual(["promoted", "staged"]);
    expect((await versionsOf(ORG_B, "shared")).map((v) => v.status)).toEqual(["staged"]);
  });

  it("quick search joins a doc and a prompt to THIS org's row of that slug", async () => {
    // B first, so a join that ignored the org would meet B's row first.
    await propose_doc_update(B, { ...doc("shared", "nothing to see"), title: "B title" }, WHO);
    await promote_doc(B, "shared", 1, WHO);
    await propose_doc_update(A, { ...doc("shared", "the numbat pipeline"), title: "A title" }, WHO);
    await promote_doc(A, "shared", 1, WHO);
    const docs = (await quickSearch(A, "numbat", WHO, { types: ["doc"], limit: 8 })).groups[0]?.hits ?? [];
    expect(docs.map((h) => [h.id, h.title])).toEqual([["shared", "A title"]]);
    expect((await quickSearch(B, "numbat", WHO, { types: ["doc"] })).groups).toEqual([]);

    // A prompt is searchable once it has a PUBLISHED version — in this org. B publishing the same slug
    // does not surface A's draft, and A's hit carries A's title.
    await savePrompt(B, WHO, { slug: "shared-prompt", title: "B numbat review", body: "Review the numbat", status: "published" }, "human");
    await savePrompt(A, WHO, { slug: "shared-prompt", title: "A numbat draft", body: "Draft about the numbat", status: "draft" }, "human");
    expect((await quickSearch(A, "numbat", WHO, { types: ["prompt"] })).groups).toEqual([]);
    expect(((await quickSearch(B, "numbat", WHO, { types: ["prompt"] })).groups[0]?.hits ?? []).map((h) => h.title)).toEqual(["B numbat review"]);
    // Published in both: each org's hit is its own row of that slug (title, author), never the other's.
    await savePrompt(A, "iso-a-author", { slug: "shared-prompt", title: "A numbat review", body: "Review the numbat, A's way", status: "published" }, "human");
    const hit = async (ctx: typeof A) => ((await quickSearch(ctx, "numbat", WHO, { types: ["prompt"] })).groups[0]?.hits ?? []).map((h) => [h.id, h.title]);
    expect(await hit(A)).toEqual([["shared-prompt", "A numbat review"]]);
    expect(await hit(B)).toEqual([["shared-prompt", "B numbat review"]]);
  });

  it("query(): another org's plan text never surfaces this org's plan, and its feed never crowds this org's browse", async () => {
    await write_plan(A, { narrative: "Ship the importer.", sprints: [] }, WHO);
    await write_plan(B, { narrative: "Adopt the quokka strategy.", sprints: [] }, WHO);
    expect((await query(A, { q: "quokka", types: ["sprint"] })).primary).toEqual([]);
    expect((await query(B, { q: "quokka", types: ["sprint"] })).primary.length).toBe(1);

    const mine = await append_feed(A, { author: WHO, summary: "A's only entry" });
    await run(env.DB, `UPDATE feed SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`, mine);
    for (let i = 0; i < 3; i++) await append_feed(B, { author: WHO, summary: `B's newer entry ${i}` });
    const browse = await query(A, { q: "", types: ["feed"], limit: 1, pointer_limit: 0 });
    expect(browse.primary.map((p) => p.id)).toEqual([String(mine)]);
  });
});
