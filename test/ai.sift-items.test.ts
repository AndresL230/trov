// Sift on NEW items (src/ai/sift-items.ts; feed-and-search.md › Tags; docs/architecture/ai.md › Jobs): the AI pass's
// `tag.fit` job over `card:tagfit:<type>:<id>`. ONE request per new item, one `noul` question per active tag —
// Sift's own question — and Sift's own bands, provenance, Undo, switches and metering. Jev is stubbed at the
// Response level; the D1, the router and the pass are real.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { runAiPass } from "../src/ai/pass";
import { newBudget } from "../src/repo/dispatch";
import { TAG_FIT_ITEM_JOB, tagFitKey } from "../src/ai/sift-items";
import { FIT_APPLY, FIT_SUGGEST, JEV_ACTOR, fitQuestion, scoreReason, setAiEnabled, settleFitSuggestion, undoTagFit } from "../src/tools/tag-fit";
import { setItemTags } from "../src/tools/tags";
import { promote_doc, propose_doc_update } from "../src/tools/writes";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, systemCtx, tenantCtx } from "./helpers/tenant";
import { dirtyRow, keyedEnv, markRow } from "./helpers/ai-pass";

const NOW = new Date("2026-10-15T12:40:00.000Z");
const BEFORE = "2026-10-15T12:00:00.000Z";
const OWNER = "AndresL230";

interface Sent { state: string; questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }> }
/** A Jev stub: per request, each question's `noul` from `p(tagName)` (the tag read back from Sift's own question). */
function jev(p: (tag: string) => number | null) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent;
    sent.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).flatMap(([k, q]) => {
      const tag = /the tag "([^"]+)"/.exec(q.instructions)?.[1] ?? "";
      const v = p(tag);
      return v === null ? [] : [[k, { type: "noul", noul: v }]];
    }));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 300, output_tokens: 6 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, asked: (k = 0) => Object.values(sent[k]?.questions ?? {}).map((q) => /the tag "([^"]+)"/.exec(q.instructions)?.[1]) };
}
const pass = (j: ReturnType<typeof jev>, e: Env = keyedEnv()) => runAiPass(e, newBudget(j.fetchImpl, 900), { jobs: [TAG_FIT_ITEM_JOB], now: NOW });

const tagsOf = async (slug: string, org = ORG_A) => (await all<{ tag: string }>(env.DB, `SELECT tag FROM entry_tags WHERE org_id = ? AND entry_type = 'doc' AND entry_id = ? ORDER BY tag`, org, slug)).map((r) => r.tag);
const modelRows = (slug: string, org = ORG_A) => all<{ tag: string; state: string; confidence: number; reason: string; resolved_by: string | null; run_id: number; prompt_version: string; model: string }>(env.DB,
  `SELECT tag, state, confidence, reason, resolved_by, run_id, prompt_version, model FROM org_tag_suggestions WHERE org_id = ? AND source = 'model' AND entry_type = 'doc' AND entry_id = ? ORDER BY tag`, org, slug);
const suggestMeter = async (org = ORG_A) => (await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_suggest'`, org))!.n;

/** Sift's own switch on (an admin's act), as a run needs it. */
const siftOn = async (org = ORG_A) => setAiEnabled(await tenantCtx(OWNER, org === ORG_A ? undefined : "admin", { orgId: org }), true);
/** A live (promoted) doc and its card. */
async function doc(slug: string, title: string, body: string, org = ORG_A): Promise<void> {
  await run(env.DB, `INSERT INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by) VALUES (?, ?, 'reference', ?, ?, 1, ?, 'tester')`, org, slug, title, body, BEFORE);
  await markRow(org, "card", `tagfit:doc:${slug}`, BEFORE);
}

describe("Sift on new items: one request, every active tag, Sift's bands", () => {
  it("asks ONE request with Sift's own question per active tag; ≥0.85 ADDS with provenance, 0.6–0.85 SUGGESTS, below nothing", async () => {
    await siftOn();
    await doc("data-layer", "The data layer", "Every tenant statement binds the org. Tables and migrations live in D1 storage.");
    const j = jev((t) => (t === "data" ? 0.9 : t === "architecture" ? 0.7 : 0.1));
    const r = await pass(j);
    expect(r.jev).toBe(1);
    expect(j.sent).toHaveLength(1);
    // Every active starter tag, each as Sift's `noul` question, the matched one (its words are in the doc) first.
    expect(j.asked().sort()).toEqual(["api", "architecture", "auth", "data", "infra", "ui"]);
    expect(j.asked()[0]).toBe("data");
    const q = Object.values(j.sent[0].questions).find((x) => x.instructions.includes('"data"'))!;
    expect(q).toEqual({ type: "noul", ...fitQuestion("data", "Tables, migrations, storage") });
    expect(j.sent[0].state.startsWith("The data layer\n\n")).toBe(true);
    // The bands.
    expect(await tagsOf("data-layer")).toEqual(["data"]);
    const rows = await modelRows("data-layer");
    expect(rows.map((x) => [x.tag, x.state, x.resolved_by])).toEqual([["architecture", "open", null], ["data", "accepted", JEV_ACTOR]]);
    // The reason is Trov's evidence: the doc's own words around the tag's (FTS), or Sift's score said as such.
    expect(rows.find((x) => x.tag === "data")!.reason).toMatch(/^Mentions “…/);
    expect(rows.find((x) => x.tag === "architecture")!.reason).toBe(scoreReason(0.7));
    expect(rows.every((x) => x.prompt_version === "jev-fit-items-1" && x.model === "jev-1.13.0")).toBe(true);
    // Metered exactly as Sift: one ai_suggest per request.
    expect(await suggestMeter()).toBe(1);
    expect(await dirtyRow(ORG_A, "card", "tagfit:doc:data-layer")).toBeNull();
  });

  it("the bands' edges are Sift's numbers: exactly FIT_APPLY adds, exactly FIT_SUGGEST suggests, just below writes nothing", async () => {
    await siftOn();
    await doc("edges", "Edges", "Nothing in particular.");
    await pass(jev((t) => (t === "api" ? FIT_APPLY : t === "ui" ? FIT_SUGGEST : t === "infra" ? FIT_SUGGEST - 0.001 : 0.2)));
    expect(await tagsOf("edges")).toEqual(["api"]);
    expect((await modelRows("edges")).map((x) => [x.tag, x.state])).toEqual([["api", "accepted"], ["ui", "open"]]);
  });

  it("each tag it touched is a one-item RUN of that tag, so the Tags tab's Undo takes exactly what it added", async () => {
    await siftOn();
    await doc("runbook", "Deploy runbook", "Workers Builds deploys on merge.");
    await run(env.DB, `INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, 'infra', 'doc', 'by-a-person')`, ORG_A);
    await pass(jev((t) => (t === "infra" ? 0.95 : 0.1)));
    expect(await tagsOf("runbook")).toEqual(["infra"]);
    const runs = await all<{ id: number; status: string; candidates: number; checked: number; added: number; started_by: string }>(env.DB,
      `SELECT id, status, candidates, checked, added, started_by FROM org_tag_runs WHERE org_id = ? AND tag = 'infra'`, ORG_A);
    expect(runs).toEqual([{ id: runs[0].id, status: "done", candidates: 1, checked: 1, added: 1, started_by: "system" }]);
    expect((await modelRows("runbook"))[0].run_id).toBe(runs[0].id);
    const audit = await all<{ action: string; target: string; detail: string }>(env.DB, `SELECT action, target, detail FROM org_admin_audit WHERE org_id = ? AND action = 'tag.fit'`, ORG_A);
    expect(audit.map((a) => [a.action, a.target, JSON.parse(a.detail).item])).toEqual([["tag.fit", "infra", "doc:runbook"]]);
    // Undo (an admin, the tag's latest run): exactly that tag off that doc — never what a person put on another item.
    const admin = await tenantCtx(OWNER);
    expect(await undoTagFit(admin, "infra")).toEqual({ removed: 1 });
    expect(await tagsOf("runbook")).toEqual([]);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM entry_tags WHERE org_id = ? AND entry_id = 'by-a-person'`, ORG_A))!.n).toBe(1);
    expect((await modelRows("runbook"))[0].state).toBe("undone");
  });

  it("PERSON OVER AI: a tag a person removed, dismissed or undid on the item is never asked about — so never added again", async () => {
    await siftOn();
    await doc("ui-rules", "UI rules", "Screens and components.");
    await pass(jev((t) => (t === "ui" ? 0.95 : t === "api" ? 0.7 : 0.1)));
    expect(await tagsOf("ui-rules")).toEqual(["ui"]);
    // A person takes `ui` off (remembered as `removed`) and dismisses the `api` suggestion.
    const person = await tenantCtx(OWNER);
    await setItemTags(person, "doc", "ui-rules", []);
    await settleFitSuggestion(person, "api", "doc", "ui-rules", false);
    // A new version is promoted: the card comes back, and Jev would say yes to both again.
    await markRow(ORG_A, "card", "tagfit:doc:ui-rules", BEFORE);
    const j = jev(() => 0.99);
    await pass(j);
    expect(j.asked()).not.toContain("ui");
    expect(j.asked()).not.toContain("api");
    expect(await tagsOf("ui-rules")).not.toContain("ui");
    expect(await tagsOf("ui-rules")).not.toContain("api");
  });

  it("a tag the item already carries, or a retired tag, is not asked about; an item with no tag left to ask sends nothing", async () => {
    await siftOn();
    await run(env.DB, `UPDATE org_tags SET retired_at = ? WHERE org_id = ? AND name IN ('ui', 'api', 'infra', 'auth')`, BEFORE, ORG_A);
    await doc("held", "Held", "x");
    await run(env.DB, `INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, 'data', 'doc', 'held')`, ORG_A);
    const j = jev(() => 0.99);
    await pass(j);
    expect(j.asked()).toEqual(["architecture"]);
    await run(env.DB, `INSERT OR IGNORE INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, 'architecture', 'doc', 'held')`, ORG_A);
    await markRow(ORG_A, "card", "tagfit:doc:held", BEFORE);
    const j2 = jev(() => 0.99);
    await pass(j2);
    expect(j2.sent).toHaveLength(0);
    expect(await dirtyRow(ORG_A, "card", "tagfit:doc:held")).toBeNull(); // written as it is: nothing to ask
  });

  it("never past ITEM_TAGS_MAX: with room for one more tag, only the surest fit is added", async () => {
    await siftOn();
    for (let i = 0; i < 11; i++) await run(env.DB, `INSERT INTO org_tags (org_id, name, description, color, starter, created_at, created_by, retired_at) VALUES (?, ?, '', 'slate', 0, ?, 't', ?)`, ORG_A, `old-${i}`, BEFORE, BEFORE);
    await doc("full", "Full", "x");
    for (let i = 0; i < 11; i++) await run(env.DB, `INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, ?, 'doc', 'full')`, ORG_A, `old-${i}`);
    await pass(jev((t) => (t === "data" ? 0.97 : t === "api" ? 0.9 : 0.1)));
    const tags = await tagsOf("full");
    expect(tags).toHaveLength(12);
    expect(tags).toContain("data");
    expect(tags).not.toContain("api");
  });
});

describe("Sift on new items: the switches, the router, what is never sent", () => {
  it("BOTH SWITCHES: Sift's own off → no request (the card is written as it is); the org's off → nothing read or asked", async () => {
    await doc("off-sift", "Off", "Tables and storage.");
    const j = jev(() => 0.99);
    await pass(j); // Sift's switch was never turned on
    expect(j.sent).toHaveLength(0);
    expect(await tagsOf("off-sift")).toEqual([]);
    expect(await dirtyRow(ORG_A, "card", "tagfit:doc:off-sift")).toBeNull();
    await siftOn();
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    await markRow(ORG_A, "card", "tagfit:doc:off-sift", BEFORE);
    await pass(j);
    expect(j.sent).toHaveLength(0);
    expect(await suggestMeter()).toBe(0);
  });

  it("promote_doc marks the card through the router, and the next tick tags the doc", async () => {
    await siftOn();
    await propose_doc_update(systemCtx(), { slug: "promoted", section: "reference", title: "Promoted", body: "Deploys and CI.", change_summary: "s", confidence: "high" }, OWNER);
    expect(await dirtyRow(ORG_A, "card", "tagfit:doc:promoted")).toBeNull(); // staged is not promoted
    await promote_doc(systemCtx(), "promoted", 1, OWNER);
    expect(await dirtyRow(ORG_A, "card", "tagfit:doc:promoted")).not.toBeNull();
    await pass(jev((t) => (t === "infra" ? 0.9 : 0.1)));
    expect(await tagsOf("promoted")).toEqual(["infra"]);
  });

  it("an artifact cannot carry tags yet: its card is written as it is, with no request", async () => {
    await siftOn();
    await markRow(ORG_A, "card", "tagfit:artifact:checkout-design", BEFORE);
    const j = jev(() => 0.99);
    await pass(j);
    expect(j.sent).toHaveLength(0);
    expect(await dirtyRow(ORG_A, "card", "tagfit:artifact:checkout-design")).toBeNull();
  });

  it("one org per request: org B's doc is asked about with org B's tags, and written in org B", async () => {
    await siftOn(ORG_B);
    await run(env.DB, `INSERT INTO org_tags (org_id, name, description, color, starter, created_at, created_by) VALUES (?, 'billing', 'Invoices', 'ochre', 0, ?, 't')`, ORG_B, BEFORE);
    await doc("b-doc", "B doc", "Invoices.", ORG_B);
    const j = jev((t) => (t === "billing" ? 0.9 : 0.1));
    await pass(j);
    expect(j.asked()).toContain("billing");
    expect(await tagsOf("b-doc", ORG_B)).toEqual(["billing"]);
    expect(await tagsOf("b-doc", ORG_A)).toEqual([]);
  });

  it("an answer with nothing usable is a failed attempt, never a guess", async () => {
    await siftOn();
    await doc("bad", "Bad", "x");
    await pass(jev(() => null));
    expect(await tagsOf("bad")).toEqual([]);
    expect((await dirtyRow(ORG_A, "card", "tagfit:doc:bad"))?.attempts).toBe(1);
  });

  it("tagFitKey reads `tagfit:<type>:<id>` and nothing else", () => {
    expect(tagFitKey("tagfit:doc:a-b")).toEqual({ type: "doc", id: "a-b" });
    expect(tagFitKey("tagfit:artifact:x:y")).toEqual({ type: "artifact", id: "x:y" });
    expect(tagFitKey("tagfit:doc:")).toBeNull();
    expect(tagFitKey("feed:1")).toBeNull();
  });
});
