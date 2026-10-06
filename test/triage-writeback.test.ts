import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { systemCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { all, first } from "../src/db";
import type { DocVersionRow, AdrRow, NeedsTriageRow } from "@shared/rows";
import { ingestDocProposal } from "../src/consumer";
import { propose_doc_update, promote_doc, stage_adr, ratify_adr, route_triage } from "../src/tools/writes";
import { cookieFor as authedCookie } from "./helpers/persons";

const post = (path: string, cookie: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const getJson = async <T>(path: string, cookie: string): Promise<T> =>
  (await (await app.request(path, { headers: { cookie } }, env)).json()) as T;

const docBase = { section: "reference", change_summary: "s", confidence: "high" as const };

// ── GET /proposals: server-joined queue ───────────────────────────────────────
describe("GET /proposals", () => {
  it("returns staged versions newer than the live doc, joined with both bodies + reconciler metadata", async () => {
    const cookie = await authedCookie("andres");
    // v1 promoted (live), v2 staged as a one-line edit on top (changed/max < 0.5).
    const v1Body = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n");
    const v2Body = v1Body.replace("line 5", "line FIVE");
    await ingestDocProposal(systemCtx(), { ...docBase, slug: "architecture", title: "Architecture", body: v1Body }, "andres");
    await promote_doc(systemCtx(), "architecture", 1, "andres");
    await ingestDocProposal(systemCtx(), { ...docBase, slug: "architecture", body: v2Body }, "andres");

    const { proposals } = await getJson<{ proposals: Array<Record<string, unknown>> }>("/proposals", cookie);
    expect(proposals.length).toBe(1);
    const p = proposals[0];
    expect(p.slug).toBe("architecture");
    expect(p.version).toBe(2);
    expect(p.current_version).toBe(1);
    expect(p.base_version).toBe(1);
    expect(p.change_kind).toBe("edit");
    expect(p.stagedBody).toBe(v2Body);
    expect(p.promotedBody).toBe(v1Body); // live body, not the staged one
    expect(p.title).toBe("Architecture");
    expect(p.section).toBe("reference");
  });

  it("returns 401 without a session cookie", async () => {
    const res = await app.request("/proposals", {}, env);
    expect(res.status).toBe(401);
  });
});

// ── reject doc version ────────────────────────────────────────────────────────
describe("POST /doc/:slug/reject", () => {
  it("flips a staged version to 'rejected', drops it from /proposals, and never deletes it", async () => {
    const cookie = await authedCookie("andres");
    await propose_doc_update(systemCtx(), { ...docBase, slug: "spec", title: "Spec", body: "# draft" }, "andres");

    let proposals = (await getJson<{ proposals: unknown[] }>("/proposals", cookie)).proposals;
    expect(proposals.length).toBe(1);

    const res = await post("/doc/spec/reject", cookie, { version: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "rejected" });

    // leaves the queue
    proposals = (await getJson<{ proposals: unknown[] }>("/proposals", cookie)).proposals;
    expect(proposals.length).toBe(0);

    // soft only — the row + body remain
    const v = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'spec' AND version = 1`);
    expect(v?.status).toBe("rejected");
    expect(v?.body).toBe("# draft");
  });

  it("double-reject is idempotent-safe (no error, still rejected)", async () => {
    const cookie = await authedCookie("andres");
    await propose_doc_update(systemCtx(), { ...docBase, slug: "idem", title: "Idem", body: "x" }, "andres");
    expect((await post("/doc/idem/reject", cookie, { version: 1 })).status).toBe(200);
    const second = await post("/doc/idem/reject", cookie, { version: 1 });
    expect(second.status).toBe(200);
    const rows = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'idem'`);
    expect(rows.length).toBe(1); // nothing duplicated, nothing deleted
    expect(rows[0].status).toBe("rejected");
  });

  it("returns 401 without a session cookie (and does not mutate)", async () => {
    await propose_doc_update(systemCtx(), { ...docBase, slug: "guarded", title: "G", body: "x" }, "andres");
    const res = await app.request("/doc/guarded/reject", { method: "POST" }, env);
    expect(res.status).toBe(401);
    const v = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'guarded' AND version = 1`);
    expect(v?.status).toBe("staged");
  });
});

// ── reject adr ────────────────────────────────────────────────────────────────
describe("POST /adr/:id/reject", () => {
  it("flips a draft to 'rejected', drops it from the decisions queue, and never deletes it", async () => {
    const cookie = await authedCookie("andres");
    const id = await stage_adr(systemCtx(), { title: "Use X", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");

    let drafts = (await getJson<{ adrs: unknown[] }>("/adrs?status=draft", cookie)).adrs;
    expect(drafts.length).toBe(1);

    const res = await post(`/adr/${id}/reject`, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "rejected" });

    drafts = (await getJson<{ adrs: unknown[] }>("/adrs?status=draft", cookie)).adrs;
    expect(drafts.length).toBe(0);

    const adr = await first<AdrRow>(env.DB, `SELECT * FROM adrs WHERE id = ?`, id);
    expect(adr?.status).toBe("rejected"); // still present
  });

  it("double-reject is idempotent-safe; cannot reject a ratified decision", async () => {
    const cookie = await authedCookie("andres");
    const id = await stage_adr(systemCtx(), { title: "T", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    expect((await post(`/adr/${id}/reject`, cookie)).status).toBe(200);
    expect((await post(`/adr/${id}/reject`, cookie)).status).toBe(200); // idempotent

    const ratifiedId = await stage_adr(systemCtx(), { title: "R", context: "c", decision: "d", rationale: "r", confidence: "high" }, "andres");
    await ratify_adr(systemCtx(), ratifiedId);
    const res = await post(`/adr/${ratifiedId}/reject`, cookie);
    expect(res.status).toBe(400); // a ratified decision is not rejectable
  });
});

describe("POST /needs-triage/:id/discard", () => {
  it("resolves the item (audit cols set), drops it from /needs-triage, and never deletes it", async () => {
    const cookie = await authedCookie("andres");
    const id = await route_triage(systemCtx(), { raw: "some free text", reason: "out of vocab" });

    let items = (await getJson<{ items: unknown[] }>("/needs-triage", cookie)).items;
    expect(items.length).toBe(1);

    const res = await post(`/needs-triage/${id}/discard`, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, resolution: "discarded" });

    items = (await getJson<{ items: unknown[] }>("/needs-triage", cookie)).items;
    expect(items.length).toBe(0);

    const row = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    expect(row?.resolved).toBe(1);
    expect(row?.resolution).toBe("discarded");
    expect(row?.resolved_by).toBe("andres");
    expect(row?.resolved_at).toBeTruthy();
  });

  it("double-discard is idempotent-safe", async () => {
    const cookie = await authedCookie("andres");
    const id = await route_triage(systemCtx(), { raw: "x", reason: "y" });
    expect((await post(`/needs-triage/${id}/discard`, cookie)).status).toBe(200);
    expect((await post(`/needs-triage/${id}/discard`, cookie)).status).toBe(200);
    const rows = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    expect(rows.length).toBe(1);
  });
});

// ── assign-materialize triage ─────────────────────────────────────────────────
describe("POST /needs-triage/:id/assign", () => {
  it("materializes a REAL doc through the gate AND resolves with assigned_ref (out-of-vocab section, human supplies one)", async () => {
    const cookie = await authedCookie("andres");
    // Triage an out-of-vocab section so it lands in the queue.
    const r = await ingestDocProposal(
      systemCtx(),
      { slug: "orphan", section: "made-up-section", title: "Orphan", body: "hello world", change_summary: "s", confidence: "high" },
      "agent-x"
    );
    expect(r.outcome).toBe("triaged");
    const triage = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage ORDER BY id DESC LIMIT 1`);
    const id = triage!.id;

    const res = await post(`/needs-triage/${id}/assign`, cookie, { type: "doc", section: "reference" });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { ok: boolean; resolution: string; assigned_ref: string };
    expect(out).toMatchObject({ ok: true, resolution: "assigned", assigned_ref: "doc:orphan@1" });

    // A real row exists, staged THROUGH THE GATE (change_kind classified, not hand-inserted).
    const v = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'orphan'`);
    expect(v?.status).toBe("staged");
    expect(v?.change_kind).toBe("new");
    expect(v?.created_by).toBe("andres"); // author = the authenticated principal, not the agent

    // The triage item is resolved (and not deleted).
    const row = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    expect(row?.resolved).toBe(1);
    expect(row?.resolution).toBe("assigned");
    expect(row?.assigned_ref).toBe("doc:orphan@1");
  });

  it("a low-confidence-new doc assigns successfully (the human's assignment vouches for it)", async () => {
    const cookie = await authedCookie("andres");
    const r = await ingestDocProposal(
      systemCtx(),
      { slug: "shy", section: "reference", body: "tentative", change_summary: "s", confidence: "low" },
      "agent-x"
    );
    expect(r.outcome).toBe("triaged"); // low confidence on a NEW slug → triage
    const id = (await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage ORDER BY id DESC LIMIT 1`))!.id;

    const res = await post(`/needs-triage/${id}/assign`, cookie, { type: "doc" }); // no section override; uses raw's valid one
    expect(res.status).toBe(200);
    const v = await first<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'shy'`);
    expect(v?.status).toBe("staged");
  });

  it("double-assign is idempotent-safe: no second version is materialized", async () => {
    const cookie = await authedCookie("andres");
    await ingestDocProposal(
      systemCtx(),
      { slug: "twice", section: "bogus", body: "b", change_summary: "s", confidence: "high" },
      "agent-x"
    );
    const id = (await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage ORDER BY id DESC LIMIT 1`))!.id;

    expect((await post(`/needs-triage/${id}/assign`, cookie, { type: "doc", section: "reference" })).status).toBe(200);
    expect((await post(`/needs-triage/${id}/assign`, cookie, { type: "doc", section: "reference" })).status).toBe(200);
    const versions = await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'twice'`);
    expect(versions.length).toBe(1); // exactly one — the replay-safe assign did not double-stage
  });

  it("refuses (400) to place a doc with no valid section, leaving no stray triage row and no doc", async () => {
    const cookie = await authedCookie("andres");
    await ingestDocProposal(
      systemCtx(),
      { slug: "nope", section: "still-bogus", body: "b", change_summary: "s", confidence: "high" },
      "agent-x"
    );
    const before = await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`);
    const id = before[before.length - 1].id;

    const res = await post(`/needs-triage/${id}/assign`, cookie, { type: "doc" }); // raw.section is out-of-vocab
    expect(res.status).toBe(400);

    // No materialized doc, no extra triage row, original still unresolved.
    expect((await all<DocVersionRow>(env.DB, `SELECT * FROM doc_versions WHERE slug = 'nope'`)).length).toBe(0);
    expect((await all<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage`)).length).toBe(before.length);
    expect((await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id))?.resolved).toBe(0);
  });

  it("returns 401 without a session cookie", async () => {
    const id = await route_triage(systemCtx(), { raw: "{}", reason: "r" });
    const res = await app.request(`/needs-triage/${id}/assign`, { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("assign on an already-discarded item reports resolution:'discarded', not 'assigned'", async () => {
    const cookie = await authedCookie("andres");
    // Triage a free-form item (cannot be placed via assign — but first we discard it).
    const id = await route_triage(systemCtx(), { raw: "some free text", reason: "out of vocab" });

    // Discard it first.
    const discardRes = await post(`/needs-triage/${id}/discard`, cookie);
    expect(discardRes.status).toBe(200);
    expect(await discardRes.json()).toMatchObject({ ok: true, resolution: "discarded" });

    // Now call assign on the already-discarded item.
    const assignRes = await post(`/needs-triage/${id}/assign`, cookie, { type: "doc", section: "reference" });
    expect(assignRes.status).toBe(200);
    const out = (await assignRes.json()) as { ok: boolean; resolution: string; assigned_ref: string };
    // Must surface the actual recorded resolution ("discarded"), NOT falsely report "assigned".
    expect(out.resolution).toBe("discarded");
    expect(out.ok).toBe(true);

    // The row remains with its original discarded resolution — nothing was re-materialized.
    const row = await first<NeedsTriageRow>(env.DB, `SELECT * FROM needs_triage WHERE id = ?`, id);
    expect(row?.resolution).toBe("discarded");
    expect(row?.assigned_ref).toBeNull();
  });
});
