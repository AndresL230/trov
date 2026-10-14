// "Which existing items fit this tag?" (src/tools/tag-fit.ts, src/tools/classify.ts; issues #154–#158, #166).
// Every model call is stubbed at the Response level — no test reaches the network.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { geminiClassifier, validateJudgements, CLASSIFY_MODEL, CLASSIFY_PROMPT_VERSION, type ClassifyRequest } from "../src/tools/classify";
import {
  FIT_THRESHOLD, CANDIDATE_CAP, FIT_BATCH, excerptOf, fitQuery, fitCandidates, startTagFit, continueTagFit, runTagFit,
  setAiEnabled, aiEnabled, listFits, resolveFits, suggestAllowance,
} from "../src/tools/tag-fit";
import { addTag, editTag, listTags, retireTag } from "../src/tools/tags";
import { append_feed } from "../src/tools/writes";
import { RoleError } from "../src/data/context";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor } from "./helpers/persons";
import { ORG_A, ORG_B, systemCtx, tenantCtx } from "./helpers/tenant";

const OWNER = "AndresL230";
const KEYED = { ...env, GEMINI_API_KEY: "test-gemini-key" } as unknown as Env;
const UNKEYED = { ...env, GEMINI_API_KEY: "" } as unknown as Env;
const CANARY_B = "zebra-canary-org-b";

/** A Gemini stub: answers each call with `answer(items)`; records every request body. */
function gemini(answer: (items: { id: string; text: string }[]) => unknown, o: { status?: number; raw?: string } = {}) {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    const sent = JSON.parse(JSON.parse(body).contents[0].parts[0].text) as { items: { id: string; text: string }[] };
    const text = o.raw ?? JSON.stringify(answer(sent.items));
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: o.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies, classifier: geminiClassifier("k", { fetchImpl }) };
}
/** "fits" for every item whose text contains `word`, "does not fit" for the rest. */
const fitsIf = (word: string, confidence = 0.9) => (items: { id: string; text: string }[]) => ({
  results: items.map((i) => ({ id: i.id, answer: i.text.includes(word) ? "fits" : "does not fit", confidence, reason: `It talks about ${word}.` })),
});

const req = (items: { id: string; text: string }[]): ClassifyRequest => ({ kind: "tag.fit", question: "q?", answers: ["fits", "does not fit"], items });
const modelRows = (org = ORG_A) => all<{ entry_type: string; entry_id: string; tag: string; state: string; confidence: number; reason: string; model: string; prompt_version: string; suggested_by: string }>(env.DB,
  `SELECT entry_type, entry_id, tag, state, confidence, reason, model, prompt_version, suggested_by FROM org_tag_suggestions WHERE org_id = ? AND source = 'model' ORDER BY id`, org);
const calls = async (org = ORG_A) => (await first<{ n: number }>(env.DB, `SELECT COALESCE(SUM(count), 0) AS n FROM org_usage_daily WHERE org_id = ? AND metric = 'ai_suggest'`, org))?.n ?? 0;

async function seedBilling(): Promise<{ invoice: number; seats: number; other: number }> {
  const invoice = await append_feed(systemCtx(), { author: OWNER, summary: "Invoices show seat counts", body: "Billing: each invoice line now names the seats it covers." });
  const seats = await append_feed(systemCtx(), { author: OWNER, summary: "Seat billing for Pro", body: "billing per seat ```const sk = 'sk_live_abcdefghijklmnop'``` done ghp_abcdefghijklmnopqrstuvwxyz0123456789" });
  const other = await append_feed(systemCtx(), { author: OWNER, summary: "Sidebar polish", body: "Fonts in the sidebar." });
  // Org B's own billing entry: never a candidate of org A's run, never sent.
  await append_feed(systemCtx(ORG_B), { author: "bea", summary: `Billing at Acme ${CANARY_B}`, body: `billing ${CANARY_B}` });
  return { invoice, seats, other };
}
async function billingTag(on = true): Promise<void> {
  const admin = await tenantCtx(OWNER);
  await addTag(admin, { name: "billing", description: "Invoices, seats and payments" });
  if (on) await setAiEnabled(admin, true);
}

describe("the classify call (#155)", () => {
  it("keeps only well-formed judgements about items that were sent, from the allowed answers", () => {
    const items = [{ id: "0", text: "a" }, { id: "1", text: "b" }, { id: "2", text: "c" }, { id: "3", text: "d" }];
    const out = validateJudgements({
      results: [
        { id: "0", answer: "fits", confidence: 0.9, reason: "It is about invoices." },
        { id: "1", answer: "maybe", confidence: 0.9, reason: "Not an allowed answer." },
        { id: "2", answer: "fits", confidence: 1.4, reason: "Confidence out of range." },
        { id: "3", answer: "fits", confidence: 0.8, reason: "" },
        { id: "9", answer: "fits", confidence: 0.8, reason: "An id nobody sent." },
        { id: "0", answer: "does not fit", confidence: 0.9, reason: "A second answer for the same item." },
        { id: "3", answer: "fits", confidence: 0.8, reason: "x".repeat(241) },
      ],
    }, req(items));
    expect(out).toEqual([{ id: "0", answer: "fits", confidence: 0.9, reason: "It is about invoices." }]);
    expect(validateJudgements({ nope: [] }, req(items))).toEqual([]);
    expect(validateJudgements(null, req(items))).toEqual([]);
  });

  it("a valid answer becomes judgements; prose, a non-2xx, a network error or a timeout become NO judgement — never a throw", async () => {
    const items = [{ id: "0", text: "invoice" }, { id: "1", text: "fonts" }];
    const ok = gemini(fitsIf("invoice"));
    expect(await ok.classifier.classify(req(items))).toEqual([
      { id: "0", answer: "fits", confidence: 0.9, reason: "It talks about invoice." },
      { id: "1", answer: "does not fit", confidence: 0.9, reason: "It talks about invoice." },
    ]);
    expect(ok.classifier.model).toBe(CLASSIFY_MODEL);
    expect(ok.classifier.promptVersion).toBe(CLASSIFY_PROMPT_VERSION);
    const sent = JSON.parse(ok.bodies[0]);
    expect(sent.generationConfig).toEqual({ response_mime_type: "application/json", temperature: 0 });
    expect(JSON.parse(sent.contents[0].parts[0].text).allowed_answers).toEqual(["fits", "does not fit"]);

    expect(await gemini(() => null, { raw: "I think the first one fits." }).classifier.classify(req(items))).toBeNull();
    expect(await gemini(fitsIf("invoice"), { status: 500 }).classifier.classify(req(items))).toBeNull();
    const broken = geminiClassifier("k", { fetchImpl: (async () => { throw new Error("network down"); }) as unknown as typeof fetch });
    expect(await broken.classify(req(items))).toBeNull();
    const hung = geminiClassifier("k", { timeoutMs: 20, fetchImpl: ((_u: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch });
    expect(await hung.classify(req(items))).toBeNull();
    expect(await ok.classifier.classify(req([]))).toEqual([]);
  });
});

describe("what is sent", () => {
  it("an excerpt: code, links' targets, markup and anything shaped like a credential removed; at most 400 characters", () => {
    const e = excerptOf("Fixed **billing**. ```js\nconst key = 1\n``` See [the doc](https://x.io/secret) and `inline()`.\n    indented code\nToken ghp_abcdefghijklmnopqrstuvwxyz0123456789 and trov_mcp_abc123 and sk_live_123456789 done.");
    expect(e).toBe("Fixed billing. See the doc and . Token and and done.");
    expect(excerptOf("x".repeat(1000)).length).toBeLessThanOrEqual(400);
    expect(excerptOf(null)).toBe("");
  });

  it("the candidate query is the tag's name and description words, quoted, any of them", () => {
    expect(fitQuery("customer-success", "What customers ask for")).toBe(`"customer"* OR "success"* OR "customers"* OR "ask"*`);
    expect(fitQuery("x", "")).toBeNull();
  });

  it("candidates: this org's matching items, not already tagged, not dismissed — newest first, capped", async () => {
    const { invoice, seats, other } = await seedBilling();
    await billingTag();
    await env.DB.prepare(`INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, 'billing', 'feed', ?)`).bind(ORG_A, String(invoice)).run();
    let list = await fitCandidates(systemCtx(), "billing", "Invoices, seats and payments");
    expect(list.map((c) => c.id)).toEqual([String(seats)]);       // the tagged one and the unrelated one are out
    expect(list.map((c) => c.id)).not.toContain(String(other));
    expect(JSON.stringify(list)).not.toContain(CANARY_B);        // org B's entry is never a candidate
    expect(list[0].text).not.toContain("sk_live");
    expect(list[0].text).not.toContain("ghp_");
    await env.DB.prepare(`INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, suggested_by, suggested_at, state) VALUES (?, 'feed', ?, 'billing', 'model', 'system', 't', 'dismissed')`).bind(ORG_A, String(seats)).run();
    list = await fitCandidates(systemCtx(), "billing", "Invoices, seats and payments");
    expect(list).toEqual([]);                                     // a dismissal is remembered

    for (let i = 0; i < CANDIDATE_CAP + 5; i++) await append_feed(systemCtx(), { author: OWNER, summary: `billing note ${i}`, body: "billing" });
    list = await fitCandidates(systemCtx(), "billing", "");
    expect(list.length).toBe(CANDIDATE_CAP);
    expect(list[0].title).toBe(`billing note ${CANDIDATE_CAP + 4}`);
  });
});

describe("a run", () => {
  it("the switch is OFF by default: nothing is sent, no call is counted", async () => {
    await seedBilling();
    await billingTag(false);
    const g = gemini(fitsIf("Invoice"));
    expect(await aiEnabled(systemCtx())).toBe(false);
    expect(await runTagFit(KEYED, systemCtx(), "billing", { classifier: g.classifier })).toBe("off");
    expect(g.bodies).toEqual([]);
    expect(await calls()).toBe(0);
    expect(await all(env.DB, `SELECT 1 FROM org_tag_runs`)).toEqual([]);
    // No key on the platform: nothing either, whatever the switch says.
    await setAiEnabled(await tenantCtx(OWNER), true);
    expect(await runTagFit(UNKEYED, systemCtx(), "billing", { classifier: g.classifier })).toBe("no_key");
    expect(g.bodies).toEqual([]);
  });

  it("stores each confident 'fits' as a model suggestion, counts each call, and sends only this org's items", async () => {
    const { invoice, seats } = await seedBilling();
    await billingTag();
    const g = gemini((items) => ({ results: items.map((i) => ({
      id: i.id, answer: "fits", confidence: i.text.startsWith("Invoices") ? 0.95 : FIT_THRESHOLD - 0.01, reason: "It is about what a customer pays for.",
    })) }));
    expect(await runTagFit(KEYED, systemCtx(), "billing", { classifier: g.classifier })).toBe("done");

    expect(await modelRows()).toEqual([{ entry_type: "feed", entry_id: String(invoice), tag: "billing", state: "open", confidence: 0.95,
      reason: "It is about what a customer pays for.", model: CLASSIFY_MODEL, prompt_version: CLASSIFY_PROMPT_VERSION, suggested_by: "system" }]);
    expect(String(seats)).not.toBe(String(invoice)); // the one under the threshold left no row
    expect(await calls()).toBe(1);
    expect(g.bodies.join("")).not.toContain(CANARY_B);
    expect(g.bodies.join("")).not.toContain("sk_live");
    expect(await first(env.DB, `SELECT status, candidates, calls, suggested FROM org_tag_runs`)).toEqual({ status: "done", candidates: 2, calls: 1, suggested: 1 });
    // A suggestion is not the tag: the item carries nothing until an admin accepts.
    expect(await all(env.DB, `SELECT 1 FROM entry_tags WHERE tag = 'billing'`)).toEqual([]);
    expect((await listTags(await tenantCtx(OWNER), { aiAvailable: true })).fits).toMatchObject({ billing: { open: 1, run: { status: "done", suggested: 1 } } });
  });

  it("a re-run supersedes the tag's open model suggestions; a start while one runs is refused", async () => {
    await seedBilling();
    await billingTag();
    const g = gemini(fitsIf("Billing"));
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: g.classifier });
    const first1 = await modelRows();
    expect(first1.every((r) => r.state === "open")).toBe(true);
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: g.classifier });
    const rows = await modelRows();
    expect(rows.filter((r) => r.state === "superseded").length).toBe(first1.length);
    expect(rows.filter((r) => r.state === "open").length).toBe(first1.length);

    const s = await startTagFit(KEYED, systemCtx(), "billing");
    expect(s.status).toBe("started");
    expect((await startTagFit(KEYED, systemCtx(), "billing")).status).toBe("busy");
    if (s.status === "started") await continueTagFit(KEYED, systemCtx(), s.run, "billing", { classifier: g.classifier });
    expect((await startTagFit(KEYED, systemCtx(), "billing")).status).toBe("started");
  });

  it("the month's allowance (ai_suggestions in PLANS) stops a run between calls, and refuses a new one once spent", async () => {
    for (let i = 0; i < FIT_BATCH + 5; i++) await append_feed(systemCtx(), { author: OWNER, summary: `billing ${i}`, body: "billing" });
    await billingTag();
    await env.DB.prepare(`UPDATE orgs SET plan_overrides = ? WHERE id = ?`).bind(JSON.stringify({ ai_suggestions: 1 }), ORG_A).run();
    const g = gemini(fitsIf("billing"));
    expect(await runTagFit(KEYED, systemCtx(), "billing", { classifier: g.classifier })).toBe("capped");
    expect(g.bodies.length).toBe(1);
    expect(await calls()).toBe(1);
    expect(await suggestAllowance(systemCtx())).toEqual({ used: 1, cap: 1, spent: true });
    expect((await startTagFit(KEYED, systemCtx(), "billing")).status).toBe("capped");
    expect((await listTags(await tenantCtx(OWNER), { aiAvailable: true })).ai).toMatchObject({ enabled: true, available: true, used: 1, cap: 1, spent: true });
  });

  it("isolation: org B's run reads and sends only org B's items, with org B's own switch", async () => {
    await seedBilling();
    await billingTag(); // org A's switch on
    const bAdmin = await tenantCtx("bea", "admin", { orgId: ORG_B });
    await addTag(bAdmin, { name: "billing" });
    const g = gemini(fitsIf("Acme"));
    expect(await runTagFit(KEYED, systemCtx(ORG_B), "billing", { classifier: g.classifier })).toBe("off"); // B never turned it on
    await setAiEnabled(bAdmin, true);
    expect(await runTagFit(KEYED, systemCtx(ORG_B), "billing", { classifier: g.classifier })).toBe("done");
    const sent = g.bodies.join("");
    expect(sent).toContain(CANARY_B);
    expect(sent).not.toContain("Invoices show seat counts");
    expect((await modelRows(ORG_B)).length).toBe(1);
    expect(await modelRows(ORG_A)).toEqual([]);
    expect(await calls(ORG_A)).toBe(0);
  });
});

describe("review", () => {
  async function suggested(): Promise<{ invoice: number; seats: number }> {
    const ids = await seedBilling();
    await billingTag();
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: gemini(fitsIf("illing")).classifier });
    return ids;
  }

  it("lists each suggestion with its item's title and reason; accept is an authored write by the admin, dismiss is remembered", async () => {
    const { invoice, seats } = await suggested();
    const admin = await tenantCtx(OWNER);
    const fits = await listFits(admin, "billing");
    expect(fits.map((f) => f.title).sort()).toEqual(["Invoices show seat counts", "Seat billing for Pro"]);
    expect(fits[0]).toMatchObject({ type: "feed", reason: "It talks about illing.", confidence: 0.9 });

    expect(await resolveFits(admin, "billing", { resolution: "accept", items: [{ type: "feed", id: String(invoice) }] })).toEqual({ resolved: 1 });
    expect(await all(env.DB, `SELECT entry_id FROM entry_tags WHERE org_id = ? AND tag = 'billing'`, ORG_A)).toEqual([{ entry_id: String(invoice) }]);
    expect(await first(env.DB, `SELECT state, resolved_by, resolved_to FROM org_tag_suggestions WHERE entry_id = ? AND source = 'model'`, String(invoice)))
      .toEqual({ state: "accepted", resolved_by: OWNER, resolved_to: "billing" });

    await resolveFits(admin, "billing", { resolution: "dismiss", items: [{ type: "feed", id: String(seats) }] });
    expect(await listFits(admin, "billing")).toEqual([]);
    // The next run does not ask about the dismissed item again.
    const g = gemini(fitsIf("illing"));
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: g.classifier });
    expect(g.bodies.join("")).not.toContain("Seat billing for Pro");
    expect((await all<{ action: string }>(env.DB, `SELECT action FROM org_admin_audit WHERE action LIKE 'tag.fit.%' ORDER BY id`)).map((r) => r.action)).toEqual(["tag.fit.accept", "tag.fit.dismiss"]);
  });

  it("accept all; a member can neither review nor settle; a retired tag's suggestions are superseded; a rename takes them along", async () => {
    await suggested();
    const member = await tenantCtx("casey", "member");
    await expect(listFits(member, "billing")).rejects.toBeInstanceOf(RoleError);
    await expect(resolveFits(member, "billing", { resolution: "accept" })).rejects.toBeInstanceOf(RoleError);
    expect((await listTags(member)).ai).toBeUndefined();
    expect((await listTags(member)).fits).toBeUndefined();

    const admin = await tenantCtx(OWNER);
    await editTag(admin, "billing", { name: "payments" });
    expect((await listFits(admin, "payments")).length).toBe(2);
    expect(await resolveFits(admin, "payments", { resolution: "accept" })).toEqual({ resolved: 2 });
    expect((await all(env.DB, `SELECT 1 FROM entry_tags WHERE tag = 'payments'`)).length).toBe(2);

    await addTag(admin, { name: "invoices" });
    await runTagFit(KEYED, systemCtx(), "invoices", { classifier: gemini(fitsIf("Invoice")).classifier });
    expect((await listFits(admin, "invoices")).length).toBe(1);
    await retireTag(admin, "invoices");
    expect(await all(env.DB, `SELECT 1 FROM org_tag_suggestions WHERE tag = 'invoices' AND state = 'open'`)).toEqual([]);
  });
});

describe("routes", () => {
  const BASE = "/api/o/saplinglearn";
  it("the switch and the review are admin-only cookie routes; Find items says why it did not start", async () => {
    const [member, owner] = [await cookieFor("casey"), await cookieFor(OWNER)];
    expect((await call("PUT", `${BASE}/tag-settings`, member, { enabled: true })).status).toBe(403);
    expect((await call("PUT", `${BASE}/tag-settings`, owner, { enabled: true }, { headers: { authorization: "Bearer x" } })).status).toBe(403);
    expect((await call("PUT", `${BASE}/tag-settings`, owner, { enabled: true })).json).toEqual({ ok: true, enabled: true });
    expect((await call("PUT", `/api/tag-settings`, owner, { enabled: "yes" })).status).toBe(400);
    // The test Worker has no GEMINI_API_KEY: nothing can be sent, and the answer says so.
    expect((await call("POST", `${BASE}/tags/auth/find-items`, owner, {})).json).toEqual({ ok: true, status: "no_key" });
    expect((await call("POST", `${BASE}/tags/auth/find-items`, member, {})).status).toBe(403);
    expect((await call("POST", `${BASE}/tags`, owner, { name: "billing" })).json).toMatchObject({ ok: true, name: "billing", fit: "no_key" });
    expect((await call("GET", `${BASE}/tags/billing/fits`, owner)).json).toEqual({ fits: [] });
    expect((await call("GET", `${BASE}/tags/billing/fits`, member)).status).toBe(403);
    expect((await call("POST", `${BASE}/tags/billing/fits/resolve`, owner, { resolution: "accept" })).json).toMatchObject({ error: "not_found" });
    const list = (await call<{ ai: unknown }>("GET", `${BASE}/tags`, owner)).json;
    expect(list.ai).toMatchObject({ enabled: true, available: false });
    expect(await all(env.DB, `SELECT kind, enabled, updated_by FROM org_ai_settings`)).toEqual([{ kind: "tag.fit", enabled: 1, updated_by: OWNER }]);
  });
});
