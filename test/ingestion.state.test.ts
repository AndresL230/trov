// The knowledge store's transitions, each a compare-and-set on its from-state (the state-machine audit, issue #211;
// docs/architecture/ingestion-gate.md › Staged-write model): a promote never rolls a page back and supersedes what
// waited under it; the doc dedupe reads only the version still waiting; a page's version numbers are unique; only a
// draft decision moves; placing an Unplaced item twice makes one thing; the replay ledger is written with its item;
// an empty never-approved page leaves the Library and frees its slug; archives that race apply once.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { DocRow, DocVersionRow, NeedsTriageRow, AdrRow } from "@shared/rows";
import { ingestDocProposal, ingestFeedEntry } from "../src/consumer";
import { promote_doc, reject_doc_version, resolve_triage, route_triage, stage_adr } from "../src/tools/writes";
import { doc_slug_taken, list_docs } from "../src/tools/reads";
import { archiveSpace, libraryPages } from "../src/tools/spaces";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";

const OWNER = "AndresL230";
const BASE = "/api/o/saplinglearn";
const A = () => systemCtx(ORG_A);
const doc = (slug: string, body: string, o: { parent?: string; space?: string } = {}) => ({
  slug, section: "reference", title: `${slug} title`, body, change_summary: "s", confidence: "high" as const,
  ...(o.parent ? { parent_slug: o.parent } : {}), ...(o.space ? { space: o.space } : {}),
});
const stage = async (slug: string, body: string, o: { parent?: string; space?: string } = {}): Promise<number> => {
  const r = await ingestDocProposal(A(), doc(slug, body, o), OWNER, { sessionId: crypto.randomUUID(), itemIndex: 0 });
  if (r.outcome !== "written") throw new Error(`not staged: ${slug} ${JSON.stringify(r)}`);
  return r.version;
};
const versionsOf = (slug: string) =>
  all<Pick<DocVersionRow, "version" | "status" | "body">>(env.DB, `SELECT version, status, body FROM doc_versions WHERE org_id = ? AND slug = ? ORDER BY version`, ORG_A, slug);
const docOf = (slug: string) => first<DocRow>(env.DB, `SELECT * FROM docs WHERE org_id = ? AND slug = ?`, ORG_A, slug);
/** A staged version left behind by a promote from before 0088 (which superseded nothing). */
const leaveStale = (slug: string, version: number) =>
  env.DB.prepare(`UPDATE doc_versions SET status = 'staged' WHERE org_id = ? AND slug = ? AND version = ?`).bind(ORG_A, slug, version).run();

describe("promote: never backwards, and what waited under it is superseded", () => {
  it("promoting v3 supersedes the staged v2 under it: v2 can no longer be promoted or rejected, the page stays at v3", async () => {
    await stage("gate", "A");
    await promote_doc(A(), "gate", 1, OWNER);
    await stage("gate", "B");
    await stage("gate", "C");
    await promote_doc(A(), "gate", 3, OWNER);
    expect(await versionsOf("gate")).toEqual([
      { version: 1, status: "promoted", body: "A" },
      { version: 2, status: "superseded", body: "B" },   // soft: the row and its body stay
      { version: 3, status: "promoted", body: "C" },
    ]);
    await expect(promote_doc(A(), "gate", 2, OWNER)).rejects.toThrow(/not staged/);
    await expect(reject_doc_version(A(), "gate", 2)).rejects.toThrow(/superseded/);
    expect(await docOf("gate")).toMatchObject({ current_version: 3, body: "C" });
  });

  it("a newer version still waiting is left alone by an older one's promote", async () => {
    await stage("waits", "A");
    await stage("waits", "B");
    await promote_doc(A(), "waits", 1, OWNER);
    expect((await versionsOf("waits")).map((v) => v.status)).toEqual(["promoted", "staged"]);
  });

  it("a stale staged version is refused 409 `stale` and changes nothing", async () => {
    await stage("rolled", "A");
    await stage("rolled", "B");
    await stage("rolled", "C");
    await promote_doc(A(), "rolled", 3, OWNER);
    await leaveStale("rolled", 2);
    const cookie = await cookieFor(OWNER);
    const res = await call<{ error: string; message: string }>("POST", `${BASE}/doc/rolled/promote`, cookie, { version: 2 });
    expect(res.status).toBe(409);
    expect(res.json.error).toBe("stale");
    expect(await docOf("rolled")).toMatchObject({ current_version: 3, body: "C" });
    expect((await versionsOf("rolled")).find((v) => v.version === 2)?.status).toBe("staged");
  });

  it("a reject that lost to a promote rejects nothing", async () => {
    await stage("raced", "A");
    await promote_doc(A(), "raced", 1, OWNER);
    await expect(reject_doc_version(A(), "raced", 1)).rejects.toThrow(/promoted/);
    expect((await versionsOf("raced"))[0].status).toBe("promoted");
  });
});

describe("the doc dedupe reads only the version still waiting", () => {
  it("a body equal to a STALE staged version stages; one equal to the waiting version is unchanged", async () => {
    await stage("dedupe", "A");
    await promote_doc(A(), "dedupe", 1, OWNER);
    await stage("dedupe", "B");
    await stage("dedupe", "C");
    await promote_doc(A(), "dedupe", 3, OWNER);
    await leaveStale("dedupe", 2);
    const again = await ingestDocProposal(A(), doc("dedupe", "B"), OWNER);
    expect(again).toMatchObject({ outcome: "written", version: 4 });
    expect(await ingestDocProposal(A(), doc("dedupe", "B"), OWNER)).toEqual({ outcome: "unchanged", slug: "dedupe" });
    expect(await ingestDocProposal(A(), doc("dedupe", "C"), OWNER)).toEqual({ outcome: "unchanged", slug: "dedupe" }); // the live body
  });
});

describe("a page's version numbers are unique", () => {
  it("two proposals of one page at once get two numbers, and the schema refuses a duplicate", async () => {
    const [a, b] = await Promise.all([
      ingestDocProposal(A(), doc("twin", "one"), OWNER),
      ingestDocProposal(A(), doc("twin", "two"), OWNER),
    ]);
    expect([a.outcome, b.outcome]).toEqual(["written", "written"]);
    expect((await versionsOf("twin")).map((v) => v.version)).toEqual([1, 2]);
    await expect(env.DB.prepare(`INSERT INTO doc_versions (org_id, slug, version, body, status, created_at, created_by) VALUES (?, 'twin', 2, 'x', 'staged', 't', 'x')`).bind(ORG_A).run())
      .rejects.toThrow(/UNIQUE/);
  });
});

describe("only a draft decision is ratified or rejected", () => {
  it("a rejected decision can't be ratified (400) and stays rejected", async () => {
    const cookie = await cookieFor(OWNER);
    const id = await stage_adr(A(), { title: "Use Y", context: "c", decision: "d", rationale: "r", confidence: "high" }, OWNER);
    expect((await call("POST", `${BASE}/adr/${id}/reject`, cookie)).status).toBe(200);
    const res = await call<{ error: string }>("POST", `${BASE}/adr/${id}/ratify`, cookie);
    expect(res.status).toBe(400);
    expect(res.json.error).toContain("rejected");
    expect((await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id))?.status).toBe("rejected");
  });
});

describe("placing an Unplaced item makes one thing", () => {
  const held = () => route_triage(A(), { raw: { slug: "placed", section: "reference", body: "b", change_summary: "s", confidence: "high" }, reason: "r", source_author: "agent-x" });

  it("an assign retried after its write landed but its resolve did not replays the write", async () => {
    const id = await held();
    const row = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    // The first assign's write, under the item's own ledger key — and then it died before resolving the item.
    await ingestDocProposal(A(), doc("placed", "b"), OWNER, { sessionId: `triage:${id}:${row?.created_at}`, itemIndex: 0 });
    const cookie = await cookieFor(OWNER);
    const res = await call<{ resolution: string; assigned_ref: string }>("POST", `${BASE}/needs-triage/${id}/assign`, cookie, { type: "doc" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ resolution: "assigned", assigned_ref: "doc:placed@1" });
    expect(await versionsOf("placed")).toHaveLength(1);
  });

  it("two assigns at once stage one version", async () => {
    const id = await held();
    const cookie = await cookieFor(OWNER);
    const both = await Promise.all([1, 2].map(() => call("POST", `${BASE}/needs-triage/${id}/assign`, cookie, { type: "doc" })));
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(await versionsOf("placed")).toHaveLength(1);
    expect(await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id)).toMatchObject({ resolved: 1, resolution: "assigned", assigned_ref: "doc:placed@1" });
  });

  it("of a discard and an assign's resolve racing, the first stands and the other reports it", async () => {
    const id = await route_triage(A(), { raw: "loose", reason: "r" });
    const [x, y] = await Promise.all([resolve_triage(A(), id, OWNER, "discarded"), resolve_triage(A(), id, OWNER, "assigned", "doc:x@1")]);
    expect(x.resolution).toBe(y.resolution);
    const row = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    expect(row?.resolution).toBe(x.resolution);
  });
});

describe("the replay ledger is written with its item", () => {
  it("the same feed item sent twice at once is written once, its ledger row naming it", async () => {
    const ledger = { sessionId: "same-session", itemIndex: 0 };
    const entry = { summary: "once", body: "b", tags: ["api"], artifacts: { prs: [], commits: [], issues: [] } };
    const rs = await Promise.all([1, 2].map(() => ingestFeedEntry(A(), entry, OWNER, ledger)));
    expect(rs.map((r) => r.outcome).sort()).toEqual(["unchanged", "written"]);
    const feed = await all<{ id: number }>(env.DB, `SELECT id FROM feed WHERE org_id = ? AND summary = 'once'`, ORG_A);
    expect(feed).toHaveLength(1);
    expect(await first(env.DB, `SELECT item_type, outcome, ref FROM processed_items WHERE org_id = ? AND session_id = 'same-session'`, ORG_A))
      .toEqual({ item_type: "feed", outcome: "written", ref: String(feed[0].id) });
    expect(await all(env.DB, `SELECT tag FROM entry_tags WHERE org_id = ? AND entry_type = 'feed' AND entry_id = ?`, ORG_A, String(feed[0].id))).toEqual([{ tag: "api" }]);
  });

  it("a staged doc's ledger row names its version", async () => {
    await ingestDocProposal(A(), doc("ledgered", "x"), OWNER, { sessionId: "doc-session", itemIndex: 3 });
    expect(await first(env.DB, `SELECT item_type, outcome, ref FROM processed_items WHERE org_id = ? AND session_id = 'doc-session' AND item_index = 3`, ORG_A))
      .toEqual({ item_type: "doc", outcome: "staged", ref: "ledgered@1" });
  });
});

describe("an empty never-approved page", () => {
  it("leaves the Library when its only version is rejected, holds no slug, and the next proposal takes it over as a new page", async () => {
    await stage("shell", "first try");
    await reject_doc_version(A(), "shell", 1);
    expect((await libraryPages(A())).map((p) => p.slug)).not.toContain("shell");
    expect((await list_docs(A())).map((d) => d.slug)).not.toContain("shell");
    expect(await doc_slug_taken(A(), "shell")).toBeNull();

    const cookie = await cookieFor("meilin");
    const res = await call<{ ok: boolean; slug: string }>("POST", `${BASE}/docs/propose`, cookie, { slug: "shell", title: "Shell again", section: "context", space: "product", body: "second try" });
    expect(res.status).toBe(200);
    expect(await docOf("shell")).toMatchObject({ space: "product", section: "context", title: "Shell again", owner: "meilin", current_version: 0 });
    expect((await versionsOf("shell")).map((v) => [v.version, v.status])).toEqual([[1, "rejected"], [2, "staged"]]);
    expect((await libraryPages(A())).find((p) => p.slug === "shell")?.authority).toBe("unpromoted");
  });

  it("is no parent: a page proposed under it is placed at the top level", async () => {
    await stage("gone-parent", "x");
    await reject_doc_version(A(), "gone-parent", 1);
    const r = await ingestDocProposal(A(), doc("orphan-child", "y", { parent: "gone-parent" }), OWNER);
    expect(r).toMatchObject({ outcome: "written", parent_ignored: { parent_slug: "gone-parent", reason: "not_found" } });
  });
});

describe("archives that race apply once", () => {
  it("two archives of one page: one 200, one 409, the children moved up once", async () => {
    await stage("top", "t");
    await promote_doc(A(), "top", 1, OWNER);
    await stage("kid", "k", { parent: "top" });
    await promote_doc(A(), "kid", 1, OWNER);
    const cookie = await cookieFor(OWNER);
    const both = await Promise.all([1, 2].map(() => call("POST", `${BASE}/doc/top/archive`, cookie, {})));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await docOf("kid"))?.parent_slug).toBeNull();
    expect((await docOf("top"))?.archived_at).not.toBeNull();
  });

  it("two archives of one space write one audit row", async () => {
    const admin = await tenantCtx(OWNER);
    await Promise.all([archiveSpace(admin, "design"), archiveSpace(admin, "design")]);
    const audit = await all(env.DB, `SELECT target FROM org_admin_audit WHERE org_id = ? AND action = 'space.archive'`, ORG_A);
    expect(audit).toEqual([{ target: "design" }]);
  });
});
