// "Which existing items fit this tag?" (src/tools/tag-fit.ts, src/tools/classify.ts; issues #154–#158, #166).
// The model is TypeSafe AI's Jev. Every request is stubbed at the Response level — no test reaches the network.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { jevClassifier, noulOf, JEV_URL, JEV_MODEL, CLASSIFY_PROMPT_VERSION, type ClassifyRequest, type ClassifyItem } from "../src/tools/classify";
import {
  FIT_THRESHOLD, CANDIDATE_CAP, NO_SNIPPET_REASON, excerptOf, evidenceOf, fitQuery, fitCandidates, startTagFit, continueTagFit, runTagFit,
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
const KEYED = { ...env, TYPESAFE_API_KEY: "test-typesafe-key" } as unknown as Env;
const UNKEYED = { ...env, TYPESAFE_API_KEY: "" } as unknown as Env;
const CANARY_B = "zebra-canary-org-b";

interface Sent { url: string; headers: Record<string, string>; body: { model: string; state: string; questions: Record<string, { type: string; instructions: string; criteria: { true: string; false: string } }> } }
type Reply = number | { status: number; body?: unknown; raw?: string } | "hang";
/** A Jev stub: answers each request with `reply(state)` — a `noul` probability, or a whole response; records every request. */
function jev(reply: (state: string) => Reply) {
  const sent: Sent[] = [];
  let inFlight = 0, maxInFlight = 0;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const s: Sent = { url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: JSON.parse(String(init?.body ?? "{}")) };
    sent.push(s);
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((r) => setTimeout(r, 1));
      const r = reply(s.body.state);
      if (r === "hang") return await new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      if (typeof r === "number") {
        return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { fits: { type: "noul", noul: r } }, usage: { input_tokens: 80, output_tokens: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(r.raw ?? JSON.stringify(r.body ?? { error: "x" }), { status: r.status, headers: { "content-type": "application/json" } });
    } finally { inFlight--; }
  }) as unknown as typeof fetch;
  return { fetchImpl, sent, peak: () => maxInFlight, classifier: jevClassifier("k", { fetchImpl, retryDelayMs: 0, timeoutMs: 30 }) };
}
/** `p` for every item whose text contains `word`, 0.05 for the rest. */
const fitsIf = (word: string, p = 0.9) => (state: string): Reply => (state.includes(word) ? p : 0.05);

const item = (id: string, text: string, evidence = `Mentions “…${text}…”`): ClassifyItem => ({ id, text, evidence });
const req = (items: ClassifyItem[]): ClassifyRequest => ({ kind: "tag.fit", question: "Is this about billing?", criteria: { true: "It is about billing.", false: "It is not." }, answers: ["fits", "does not fit"], items });
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

describe("the classify call: Jev (#155)", () => {
  it("one request per item: TypeSafe's URL, a bearer key, the model, the item as `state` and ONE noul question", async () => {
    const j = jev(() => 0.8);
    await j.classifier.classify(req([item("0", "Invoices show seat counts")]));
    expect(j.sent.length).toBe(1);
    const [s] = j.sent;
    expect(s.url).toBe(JEV_URL);
    expect(s.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(s.headers).toEqual({ authorization: "Bearer k", "content-type": "application/json" });
    expect(Object.keys(s.body).sort()).toEqual(["model", "questions", "state"]);
    expect(s.body.model).toBe(JEV_MODEL);
    expect(s.body.state).toBe("Invoices show seat counts");
    expect(s.body.questions).toEqual({ fits: { type: "noul", instructions: "Is this about billing?", criteria: { true: "It is about billing.", false: "It is not." } } });
  });

  it("the answer is the noul probability: yes at 0.5 or more, the confidence that of the answer given; the model is the one that answered; the reason is Trov's evidence", async () => {
    const r = await jev((s) => (s === "a" ? 0.92 : 0.2)).classifier.classify(req([item("0", "a"), item("1", "b")]));
    expect(r.calls).toBe(2);
    expect(r.stopped).toBeNull();
    expect(r.judgements.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: "0", answer: "fits", confidence: 0.92, reason: "Mentions “…a…”", model: "jev-1.13.0" },
      { id: "1", answer: "does not fit", confidence: 0.8, reason: "Mentions “…b…”", model: "jev-1.13.0" },
    ]);
  });

  it("parsing: a missing, wrongly typed or out-of-range noul is no judgement", () => {
    const ok = { model: "jev-1.13.0", answers: { fits: { type: "noul", noul: 0.7 } } };
    expect(noulOf(ok)).toEqual({ p: 0.7, model: "jev-1.13.0" });
    expect(noulOf({ answers: { fits: { type: "noul", noul: 0.7 } } })).toEqual({ p: 0.7, model: null });
    for (const bad of [
      { answers: { fits: { type: "noul", noul: 1.2 } } }, { answers: { fits: { type: "noul", noul: -0.1 } } },
      { answers: { fits: { type: "noul", noul: "0.7" } } }, { answers: { fits: { type: "choice", choice: "yes" } } },
      { answers: { other: { type: "noul", noul: 0.7 } } }, { answers: {} }, {}, null, "text",
    ]) expect(noulOf(bad), JSON.stringify(bad)).toBeNull();
  });

  it("422, a body that is not JSON, a bad answer or a timeout: no judgement for THAT item, the rest go on", async () => {
    const j = jev((s) => (s === "422" ? { status: 422, body: { detail: "questions.fits.criteria" } } : s === "prose" ? { status: 200, raw: "I think yes" }
      : s === "range" ? 3 : s === "slow" ? "hang" : 0.9));
    const r = await j.classifier.classify(req([item("0", "422"), item("1", "prose"), item("2", "range"), item("3", "slow"), item("4", "fine")]));
    expect(r.judgements.map((x) => x.id)).toEqual(["4"]);
    expect(r.stopped).toBeNull();
    expect(r.calls).toBe(5);
  });

  it("429 / 529: one retry after a short delay; again → the run stops, quietly", async () => {
    let n = 0;
    const once = jev(() => (n++ === 0 ? { status: 529 } : 0.9));
    const r1 = await once.classifier.classify(req([item("0", "a")]));
    expect(r1).toMatchObject({ calls: 2, stopped: null });
    expect(r1.judgements.length).toBe(1);

    const always = jev(() => ({ status: 429 }));
    const r2 = await jevClassifier("k", { fetchImpl: always.fetchImpl, retryDelayMs: 0, concurrency: 1 }).classify(req([item("0", "a"), item("1", "b"), item("2", "c")]));
    expect(r2).toEqual({ judgements: [], calls: 2, stopped: "provider" });
    expect(always.sent.length).toBe(2); // the first item and its one retry; nothing after
  });

  it("401 (bad key) stops the run at once; a network error is no judgement; it never throws", async () => {
    const bad = jev(() => ({ status: 401 }));
    const r = await jevClassifier("k", { fetchImpl: bad.fetchImpl, concurrency: 1 }).classify(req([item("0", "a"), item("1", "b")]));
    expect(r).toEqual({ judgements: [], calls: 1, stopped: "provider" });
    const down = jevClassifier("k", { fetchImpl: (async () => { throw new Error("network"); }) as unknown as typeof fetch });
    expect(await down.classify(req([item("0", "a")]))).toEqual({ judgements: [], calls: 1, stopped: null });
    expect(await down.classify(req([]))).toEqual({ judgements: [], calls: 0, stopped: null });
  });

  it("small concurrency (4), and the gate is asked before EVERY request: a no stops the rest", async () => {
    const j = jev(() => 0.9);
    const items = Array.from({ length: 12 }, (_, i) => item(String(i), `item ${i}`));
    const r = await j.classifier.classify(req(items));
    expect(r.calls).toBe(12);
    expect(j.peak()).toBeLessThanOrEqual(4);
    expect(j.peak()).toBeGreaterThan(1);

    let allowed = 5;
    const g = jev(() => 0.9);
    const r2 = await g.classifier.classify(req(items), { gate: async () => allowed-- > 0 });
    expect(r2.calls).toBe(5);
    expect(g.sent.length).toBe(5);
    expect(r2.stopped).toBe("gate");
  });
});

describe("what is sent, and the reason shown", () => {
  it("an excerpt: code, links' targets, markup and anything shaped like a credential removed; at most 400 characters", () => {
    const e = excerptOf("Fixed **billing**. ```js\nconst key = 1\n``` See [the doc](https://x.io/secret) and `inline()`.\n    indented code\nToken ghp_abcdefghijklmnopqrstuvwxyz0123456789 and trov_mcp_abc123 and sk_live_123456789 done.");
    expect(e).toBe("Fixed billing. See the doc and . Token and and done.");
    expect(excerptOf("x".repeat(1000)).length).toBeLessThanOrEqual(400);
    expect(excerptOf(null)).toBe("");
  });

  it("the reason is the EVIDENCE: the full-text snippet around the match, scrubbed — or, with none, that it matches the description", () => {
    expect(evidenceOf("…the session cookie expires after…")).toBe("Mentions “…the session cookie expires after…”");
    expect(evidenceOf("rotate ghp_abcdefghijklmnopqrstuvwxyz0123456789 weekly")).toBe("Mentions “…rotate weekly…”");
    expect(evidenceOf("…")).toBe(NO_SNIPPET_REASON);
    expect(evidenceOf(null)).toBe("Matches the tag's description");
  });

  it("the candidate query is the tag's name and description words, quoted, any of them", () => {
    expect(fitQuery("customer-success", "What customers ask for")).toBe(`"customer"* OR "success"* OR "customers"* OR "ask"*`);
    expect(fitQuery("x", "")).toBeNull();
  });

  it("candidates: this org's matching items first, not already tagged, not dismissed; too few → topped up with the newest others (no evidence); capped", async () => {
    const { invoice, seats, other } = await seedBilling();
    await billingTag();
    await env.DB.prepare(`INSERT INTO entry_tags (org_id, tag, entry_type, entry_id) VALUES (?, 'billing', 'feed', ?)`).bind(ORG_A, String(invoice)).run();
    let list = await fitCandidates(systemCtx(), "billing", "Invoices, seats and payments");
    // The keyword match first, then — fewer than TOP_UP_TO matched — the newest others, with NO evidence.
    expect(list.map((c) => [c.id, c.evidence === null])).toEqual([[String(seats), false], [String(other), true]]);
    expect(JSON.stringify(list)).not.toContain(CANARY_B);
    expect(list[0].text).not.toContain("sk_live");
    expect(list[0].text).not.toContain("ghp_");
    expect(list[0].evidence).toMatch(/^Mentions “….*[Bb]illing.*…”$/);
    expect(list[0].evidence).not.toContain("ghp_");
    await env.DB.prepare(`INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, suggested_by, suggested_at, state) VALUES (?, 'feed', ?, 'billing', 'model', 'system', 't', 'dismissed')`).bind(ORG_A, String(seats)).run();
    // A dismissal is remembered — by the top-up too.
    expect((await fitCandidates(systemCtx(), "billing", "Invoices, seats and payments")).map((c) => c.id)).toEqual([String(other)]);

    for (let i = 0; i < CANDIDATE_CAP + 5; i++) await append_feed(systemCtx(), { author: OWNER, summary: `billing note ${i}`, body: "billing" });
    list = await fitCandidates(systemCtx(), "billing", "");
    expect(list.length).toBe(CANDIDATE_CAP);
    expect(list[0].title).toBe(`billing note ${CANDIDATE_CAP + 4}`);
  });
});

describe("a run", () => {
  it("the switch is OFF by default: nothing is sent, no call is counted; no TypeSafe key: nothing either", async () => {
    await seedBilling();
    await billingTag(false);
    const j = jev(fitsIf("Invoice"));
    expect(await aiEnabled(systemCtx())).toBe(false);
    expect(await runTagFit(KEYED, systemCtx(), "billing", { classifier: j.classifier })).toBe("off");
    expect(j.sent).toEqual([]);
    expect(await calls()).toBe(0);
    expect(await all(env.DB, `SELECT 1 FROM org_tag_runs`)).toEqual([]);
    await setAiEnabled(await tenantCtx(OWNER), true);
    expect(await runTagFit(UNKEYED, systemCtx(), "billing", { classifier: j.classifier })).toBe("no_key");
    // A Gemini key alone does not do: tag suggestions use TypeSafe's.
    expect(await runTagFit({ ...UNKEYED, GEMINI_API_KEY: "g" } as Env, systemCtx(), "billing", { classifier: j.classifier })).toBe("no_key");
    expect(j.sent).toEqual([]);
  });

  it("stores each confident 'fits' with Jev's model, the prompt version and Trov's evidence; counts each request; sends only this org's items", async () => {
    const { invoice } = await seedBilling();
    await billingTag();
    const j = jev((s) => (s.startsWith("Invoices") ? 0.95 : FIT_THRESHOLD - 0.01));
    expect(await runTagFit(KEYED, systemCtx(), "billing", { jev: { fetchImpl: j.fetchImpl, retryDelayMs: 0 } })).toBe("done");
    const rows = await modelRows();
    expect(rows).toEqual([{ entry_type: "feed", entry_id: String(invoice), tag: "billing", state: "open", confidence: 0.95,
      reason: expect.stringMatching(/^Mentions “…/), model: "jev-1.13.0", prompt_version: CLASSIFY_PROMPT_VERSION, suggested_by: "system" }]);
    expect(CLASSIFY_PROMPT_VERSION).toBe("jev-fit-1");
    expect(await calls()).toBe(3);                                  // one per candidate (2 matched + 1 topped up)
    expect(j.sent.length).toBe(3);
    expect(j.sent[0].headers.authorization).toBe("Bearer test-typesafe-key");
    const all2 = JSON.stringify(j.sent);
    expect(all2).not.toContain(CANARY_B);
    expect(all2).not.toContain("sk_live");
    expect(j.sent[0].body.questions.fits.instructions).toContain(`"billing"`);
    expect(j.sent[0].body.questions.fits.criteria.true).toBe("The item is about billing: Invoices, seats and payments.");
    expect(await first(env.DB, `SELECT status, candidates, calls, checked, suggested FROM org_tag_runs`)).toEqual({ status: "done", candidates: 3, calls: 3, checked: 3, suggested: 1 });
    expect(await all(env.DB, `SELECT 1 FROM entry_tags WHERE tag = 'billing'`)).toEqual([]);
    expect((await listTags(await tenantCtx(OWNER), { aiAvailable: true })).fits).toMatchObject({ billing: { open: 1, run: { status: "done", suggested: 1 } } });
  });

  it("the provider refusing (bad key) ends the run as failed, quietly, with no suggestion", async () => {
    await seedBilling();
    await billingTag();
    const j = jev(() => ({ status: 401 }));
    expect(await runTagFit(KEYED, systemCtx(), "billing", { jev: { fetchImpl: j.fetchImpl, concurrency: 1 } })).toBe("failed");
    expect(await modelRows()).toEqual([]);
    expect(await first(env.DB, `SELECT status, calls FROM org_tag_runs`)).toEqual({ status: "failed", calls: 1 });
  });

  it("a re-run supersedes the tag's open model suggestions; a start while one runs is refused", async () => {
    await seedBilling();
    await billingTag();
    const j = jev(fitsIf("illing"));
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: j.classifier });
    const first1 = await modelRows();
    expect(first1.length).toBe(2);
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: j.classifier });
    const rows = await modelRows();
    expect(rows.filter((r) => r.state === "superseded").length).toBe(2);
    expect(rows.filter((r) => r.state === "open").length).toBe(2);

    const s = await startTagFit(KEYED, systemCtx(), "billing");
    expect(s.status).toBe("started");
    expect((await startTagFit(KEYED, systemCtx(), "billing")).status).toBe("busy");
    if (s.status === "started") await continueTagFit(KEYED, systemCtx(), s.run, "billing", { classifier: j.classifier });
    expect((await startTagFit(KEYED, systemCtx(), "billing")).status).toBe("started");
  });

  it("the month's allowance (ai_suggestions) is checked before every request: the run stops at it, and a new one is refused", async () => {
    for (let i = 0; i < 10; i++) await append_feed(systemCtx(), { author: OWNER, summary: `billing ${i}`, body: "billing" });
    await billingTag();
    await env.DB.prepare(`UPDATE orgs SET plan_overrides = ? WHERE id = ?`).bind(JSON.stringify({ ai_suggestions: 3 }), ORG_A).run();
    const j = jev(fitsIf("billing"));
    expect(await runTagFit(KEYED, systemCtx(), "billing", { classifier: j.classifier })).toBe("capped");
    expect(j.sent.length).toBe(3);                                 // never past the cap, with 4 in flight
    expect(await calls()).toBe(3);
    expect((await modelRows()).length).toBe(3);
    expect(await suggestAllowance(systemCtx())).toEqual({ used: 3, cap: 3, spent: true });
    expect((await startTagFit(KEYED, systemCtx(), "billing")).status).toBe("capped");
    expect((await listTags(await tenantCtx(OWNER), { aiAvailable: true })).ai).toMatchObject({ enabled: true, available: true, used: 3, cap: 3, spent: true });
  });

  it("turning the switch off mid-run sends nothing more", async () => {
    for (let i = 0; i < 10; i++) await append_feed(systemCtx(), { author: OWNER, summary: `billing ${i}`, body: "billing" });
    await billingTag();
    let n = 0;
    const admin = await tenantCtx(OWNER);
    const j = jev(() => { if (++n === 2) void setAiEnabled(admin, false); return 0.9; });
    await runTagFit(KEYED, systemCtx(), "billing", { jev: { fetchImpl: j.fetchImpl, concurrency: 1, retryDelayMs: 0 } });
    expect(j.sent.length).toBeLessThan(10);
  });

  it("isolation: org B's run reads and sends only org B's items, with org B's own switch", async () => {
    await seedBilling();
    await billingTag();
    const bAdmin = await tenantCtx("bea", "admin", { orgId: ORG_B });
    await addTag(bAdmin, { name: "billing" });
    const j = jev(fitsIf("Acme"));
    expect(await runTagFit(KEYED, systemCtx(ORG_B), "billing", { classifier: j.classifier })).toBe("off");
    await setAiEnabled(bAdmin, true);
    expect(await runTagFit(KEYED, systemCtx(ORG_B), "billing", { classifier: j.classifier })).toBe("done");
    const sent = JSON.stringify(j.sent);
    expect(sent).toContain(CANARY_B);
    expect(sent).not.toContain("Invoices show seat counts");
    expect((await modelRows(ORG_B)).length).toBe(1);
    expect(await modelRows(ORG_A)).toEqual([]);
    expect(await calls(ORG_A)).toBe(0);
  });
});

describe("a run, live, and the experience of an empty match (#2 of the owner's notes)", () => {
  it("writes candidates, checked and suggested AS IT GOES — seen mid-run — and the run route answers them", async () => {
    for (let i = 0; i < 8; i++) await append_feed(systemCtx(), { author: OWNER, summary: `billing ${i}`, body: "billing" });
    await billingTag();
    const seen: unknown[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      // What a poll would read now, before this answer is stored.
      seen.push(await first(env.DB, `SELECT status, candidates, checked, suggested FROM org_tag_runs ORDER BY id DESC LIMIT 1`));
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { fits: { type: "noul", noul: n % 2 ? 0.9 : 0.1 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await runTagFit(KEYED, systemCtx(), "billing", { jev: { fetchImpl, concurrency: 1, retryDelayMs: 0 } })).toBe("done");
    expect(seen[0]).toEqual({ status: "running", candidates: 8, checked: 0, suggested: 0 });
    expect(seen[3]).toEqual({ status: "running", candidates: 8, checked: 3, suggested: 2 });
    expect(seen[7]).toEqual({ status: "running", candidates: 8, checked: 7, suggested: 4 });
    const owner = await cookieFor(OWNER);
    const { run } = (await call<{ run: Record<string, unknown> }>("GET", "/api/o/saplinglearn/tags/billing/run", owner)).json;
    expect(run).toEqual({ status: "done", started_at: expect.any(String), ended_at: expect.any(String), candidates: 8, checked: 8, suggested: 4 });
  });

  it("a tag whose words match nothing (no description) is still judged: the newest items, each fit's reason honestly the model's score", async () => {
    await append_feed(systemCtx(), { author: OWNER, summary: "Electron app opens on login", body: "The tray app starts with the OS." });
    await append_feed(systemCtx(), { author: OWNER, summary: "Sidebar polish", body: "Fonts." });
    const admin = await tenantCtx(OWNER);
    await addTag(admin, { name: "desktop" });
    await setAiEnabled(admin, true);
    const j = jev((s) => (s.includes("Electron") ? 0.87 : 0.1));
    expect(await runTagFit(KEYED, systemCtx(), "desktop", { classifier: j.classifier })).toBe("done");
    expect(j.sent.length).toBe(2);
    expect((await modelRows()).map((r) => r.reason)).toEqual(["Jev rates it a fit (87%)"]);
    expect(await first(env.DB, `SELECT candidates, checked, suggested FROM org_tag_runs`)).toEqual({ candidates: 2, checked: 2, suggested: 1 });
  });

  it("an empty organization: nothing to check, said plainly — a run that ends with 0 candidates and no call", async () => {
    await billingTag();
    const j = jev(() => 0.9);
    expect(await runTagFit(KEYED, systemCtx(), "billing", { classifier: j.classifier })).toBe("done");
    expect(j.sent).toEqual([]);
    expect(await calls()).toBe(0);
    expect((await listTags(await tenantCtx(OWNER), { aiAvailable: true })).fits?.billing.run).toMatchObject({ status: "done", candidates: 0, checked: 0, suggested: 0 });
  });
});

describe("review", () => {
  async function suggested(): Promise<{ invoice: number; seats: number }> {
    const ids = await seedBilling();
    await billingTag();
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: jev(fitsIf("illing")).classifier });
    return ids;
  }

  it("lists each suggestion with its item's title and its evidence; accept is an authored write by the admin, dismiss is remembered", async () => {
    const { invoice, seats } = await suggested();
    const admin = await tenantCtx(OWNER);
    const fits = await listFits(admin, "billing");
    expect(fits.map((f) => f.title).sort()).toEqual(["Invoices show seat counts", "Seat billing for Pro"]);
    expect(fits[0]).toMatchObject({ type: "feed", confidence: 0.9, reason: expect.stringMatching(/^Mentions “…/) });

    expect(await resolveFits(admin, "billing", { resolution: "accept", items: [{ type: "feed", id: String(invoice) }] })).toEqual({ resolved: 1 });
    expect(await all(env.DB, `SELECT entry_id FROM entry_tags WHERE org_id = ? AND tag = 'billing'`, ORG_A)).toEqual([{ entry_id: String(invoice) }]);
    expect(await first(env.DB, `SELECT state, resolved_by, resolved_to FROM org_tag_suggestions WHERE entry_id = ? AND source = 'model'`, String(invoice)))
      .toEqual({ state: "accepted", resolved_by: OWNER, resolved_to: "billing" });

    await resolveFits(admin, "billing", { resolution: "dismiss", items: [{ type: "feed", id: String(seats) }] });
    expect(await listFits(admin, "billing")).toEqual([]);
    const j = jev(fitsIf("illing"));
    await runTagFit(KEYED, systemCtx(), "billing", { classifier: j.classifier });
    expect(JSON.stringify(j.sent)).not.toContain("Seat billing for Pro");
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
    await runTagFit(KEYED, systemCtx(), "invoices", { classifier: jev(fitsIf("Invoice")).classifier });
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
    // The test Worker has no TYPESAFE_API_KEY: nothing can be sent, and the answer says so.
    expect((await call("POST", `${BASE}/tags/auth/find-items`, owner, {})).json).toEqual({ ok: true, status: "no_key" });
    expect((await call("POST", `${BASE}/tags/auth/find-items`, member, {})).status).toBe(403);
    expect((await call("POST", `${BASE}/tags`, owner, { name: "billing" })).json).toMatchObject({ ok: true, name: "billing", fit: "no_key" });
    expect((await call("GET", `${BASE}/tags/billing/fits`, owner)).json).toEqual({ fits: [], run: null });
    expect((await call("GET", `${BASE}/tags/billing/run`, owner)).json).toEqual({ run: null });
    expect((await call("GET", `${BASE}/tags/billing/run`, member)).status).toBe(403);
    expect((await call("GET", `${BASE}/tags/billing/fits`, member)).status).toBe(403);
    expect((await call("POST", `${BASE}/tags/billing/fits/resolve`, owner, { resolution: "accept" })).json).toMatchObject({ error: "not_found" });
    const list = (await call<{ ai: unknown }>("GET", `${BASE}/tags`, owner)).json;
    expect(list.ai).toMatchObject({ enabled: true, available: false });
    expect(await all(env.DB, `SELECT kind, enabled, updated_by FROM org_ai_settings`)).toEqual([{ kind: "tag.fit", enabled: 1, updated_by: OWNER }]);
  });
});
