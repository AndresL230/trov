// Phase C's Jev cards over real D1 (docs/architecture/ai.md › The kinds): the ticket card (`ticket.category`,
// `ticket.priority`, `ticket.duplicate` — ONE request per ticket), the Review card (`review.risk`) and the Unplaced
// card (`unplaced.destination`), run by the REAL registry through the pass, with Jev stubbed at the `Response` level;
// what their suggestions become on the screens' reads; and Accept through the existing writers, as the person.
//
// The guards (each removed once, the test seen failing, restored — see the PR): candidates only, person over AI,
// the switch, reasons are evidence, Accept routes through the existing writer as the person, never closes /
// promotes / rejects, decided kinds are never re-suggested, a re-run supersedes the open one.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { runAiPass, AI_JOBS } from "../src/ai/pass";
import { newBudget } from "../src/repo/dispatch";
import { create_ticket } from "../src/tools/tickets";
import { ingestAdrDraft, ingestDocProposal } from "../src/consumer";
import { route_triage } from "../src/tools/writes";
import { putSuggestion } from "../src/data/ai";
import { ticketDecide, ticketRequest, wordsEvidence, type TicketCardInput } from "../src/ai/jobs/ticket-card";
import { unplacedDecide, type UnplacedCardInput } from "../src/ai/jobs/unplaced-card";
import { reviewDecide, type ReviewCardInput } from "../src/ai/jobs/review-card";
import type { TicketDetail } from "@shared/tickets";
import type { NeedsTriageRow, AdrRow } from "@shared/rows";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { keyedEnv } from "./helpers/ai-pass";

const BASE = "/api/o/saplinglearn";
const later = () => new Date(Date.now() + 60_000);

/** Jev, stubbed: `answer` picks, per question, the option and its probability (the rest share what is left). */
type Pick = Record<string, [string, number] | undefined>;
function jev(answer: (body: { state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> }) => Pick) {
  const s = { calls: 0, haiku: 0, bodies: [] as { state: string; questions: Record<string, { type: string; criteria: Record<string, string> }> }[] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.anthropic.com/")) { s.haiku++; return new Response("{}", { status: 500 }); }
    if (!url.startsWith("https://api.typesafe.ai/")) return new Response("ok");
    s.calls++;
    const body = JSON.parse(String(init?.body));
    s.bodies.push(body);
    const pick = answer(body);
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions) as [string, { criteria: Record<string, string> }][]) {
      const opts = Object.keys(q.criteria);
      const [choice, p] = pick[id] ?? [opts[0], 0.2];
      const rest = (1 - p) / Math.max(1, opts.length - 1);
      answers[id] = { type: "choice", choice, confidence: p, probabilities: Object.fromEntries(opts.map((o) => [o, o === choice ? p : rest])) };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 40, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { s, fetchImpl };
}
const pass = (fetchImpl: typeof fetch, e: Env = keyedEnv()) => runAiPass(e, newBudget(fetchImpl), { now: later() });

const suggestions = (itemType: string, ref: string) =>
  all<{ id: number; kind: string; value_json: string; reason: string; cites_json: string; state: string; model: string; confidence: number }>(env.DB,
    `SELECT id, kind, value_json, reason, cites_json, state, model, confidence FROM ai_suggestions WHERE org_id = ? AND item_type = ? AND item_ref = ? ORDER BY id`, ORG_A, itemType, ref);

async function call<T>(method: string, path: string, cookie: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(path, { method, headers: { cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }, env as unknown as Env);
  return { status: res.status, json: (await res.json().catch(() => null)) as T };
}

const ticket = (title: string, body: string, o: { category?: "bug" | "other" | "request"; priority?: "low" | "normal" | "high" } = {}) =>
  create_ticket(systemCtx(ORG_A), { title, body, category: o.category ?? "other", priority: o.priority ?? "normal", assignees: [] }, "AndresL230");

describe("the ticket card", () => {
  it("ONE Jev request per new ticket, carrying category, priority and the duplicate question over the top five full-text hits only", async () => {
    const older = await ticket("Login page is blank on Safari", "Since this morning the login page shows a blank screen on Safari.");
    await ticket("Export the roadmap as CSV", "Add a CSV export to the roadmap.");
    const n = await ticket("Safari login shows a blank page", "The login page is blank on Safari 18; Chrome works. It blocks everyone on the team.");
    const { s, fetchImpl } = jev((b) => {
      const dup = Object.keys(b.questions.duplicate?.criteria ?? {}).find((k) => k === `ticket_${older}`);
      return b.state.includes(`#${n}:`) ? { category: ["bug", 0.93], priority: ["high", 0.86], duplicate: dup ? [dup, 0.97] : undefined } : {};
    });
    await pass(fetchImpl);
    expect(s.calls).toBe(3); // one per ticket card: never one per question
    expect(s.haiku).toBe(0);
    const mine = s.bodies.find((b) => b.state.includes(`#${n}:`))!;
    expect(Object.keys(mine.questions)).toEqual(["category", "priority", "duplicate"]);
    const offered = Object.keys(mine.questions.duplicate.criteria);
    expect(offered).toContain("none");
    expect(offered).toContain(`ticket_${older}`);
    expect(offered).not.toContain(`ticket_${n}`); // never itself
    expect(offered.length).toBeLessThanOrEqual(6); // five candidates and "none"
    const rows = await suggestions("ticket", String(n));
    expect(rows.map((r) => [r.kind, JSON.parse(r.value_json), r.state, r.model])).toEqual([
      ["ticket.category", "bug", "open", "jev-1.13.0"],
      ["ticket.priority", "high", "open", "jev-1.13.0"],
      ["ticket.duplicate", { number: older, label: `#${older} Login page is blank on Safari` }, "open", "jev-1.13.0"],
    ]);
    // Reasons are Trov's evidence: the ticket's own words, the words the two share — never model text.
    expect(rows[0].reason).toBe("it says “Safari login shows a blank page”");
    expect(rows[1].reason).toMatch(/^it says “.*blocks everyone.*”$/);
    expect(rows[2].reason).toMatch(/^both mention “(safari|login|blank|page)”/);
    expect(JSON.parse(rows[2].cites_json)).toEqual([{ ref: `ticket:${older}`, label: `#${older}`, href: `#tickets/${older}` }]);
    // The scope is written and gone.
    expect(await first(env.DB, `SELECT 1 FROM ai_dirty WHERE org_id = ? AND scope = 'card' AND scope_key = ?`, ORG_A, `ticket:${n}`)).toBeNull();
  });

  it("25 ticket cards with the real registry: 25 Jev requests and zero Haiku calls", async () => {
    for (let i = 1; i <= 25; i++) await ticket(`Ticket number ${i} about exports`, "");
    const { s, fetchImpl } = jev(() => ({}));
    await pass(fetchImpl);
    expect([s.calls, s.haiku]).toEqual([25, 0]);
  });

  it("person over AI: a category or priority a person chose is never asked about, and nothing is asked when nothing is left", async () => {
    const n = await ticket("Crash on save", "It crashes.", { category: "bug", priority: "high" });
    const { s, fetchImpl } = jev(() => ({ category: ["request", 0.99], priority: ["low", 0.99] }));
    await pass(fetchImpl);
    expect(s.calls).toBe(0); // no other ticket to be a duplicate of, both fields a person's: no request at all
    expect(await suggestions("ticket", String(n))).toEqual([]);
    // With only the priority left at its default, only the priority is asked.
    const m = await ticket("Crash on export", "It crashes too.", { category: "bug" });
    const j2 = jev(() => ({ priority: ["high", 0.95] }));
    await pass(j2.fetchImpl);
    const body = j2.s.bodies.find((b) => b.state.includes(`#${m}:`))!;
    expect(Object.keys(body.questions)).not.toContain("category");
    expect(Object.keys(body.questions)).toContain("priority");
    expect((await suggestions("ticket", String(m))).map((r) => r.kind)).toEqual(["ticket.priority"]);
  });

  it("a kind a person already decided is never suggested again; a re-run supersedes the OPEN one", async () => {
    const n = await ticket("Blank dashboard", "The dashboard is blank.");
    const ctx = systemCtx(ORG_A);
    const dismissed = (await putSuggestion(ctx, { itemType: "ticket", itemRef: String(n), kind: "ticket.category", value: "bug", confidence: 0.9, reason: "x", cites: [], model: "jev", promptVersion: "p" }))!;
    await run(env.DB, `UPDATE ai_suggestions SET state = 'dismissed', decided_by = 'AndresL230' WHERE id = ?`, dismissed);
    const open = (await putSuggestion(ctx, { itemType: "ticket", itemRef: String(n), kind: "ticket.priority", value: "low", confidence: 0.8, reason: "x", cites: [], model: "jev", promptVersion: "p" }))!;
    const { s, fetchImpl } = jev(() => ({ category: ["bug", 0.99], priority: ["high", 0.9] }));
    await pass(fetchImpl);
    expect(Object.keys(s.bodies[0].questions)).toEqual(["priority"]);
    const rows = await suggestions("ticket", String(n));
    expect(rows.map((r) => [r.kind, r.state])).toEqual([["ticket.category", "dismissed"], ["ticket.priority", "superseded"], ["ticket.priority", "open"]]);
    expect(rows[1].id).toBe(open);
  });

  it("below the threshold, or the value it already has, writes nothing — and the scope is still written", async () => {
    const n = await ticket("Some ticket", "Words.");
    const { fetchImpl } = jev(() => ({ category: ["bug", 0.5], priority: ["normal", 0.99] }));
    await pass(fetchImpl);
    expect(await suggestions("ticket", String(n))).toEqual([]);
    expect(await first(env.DB, `SELECT 1 FROM ai_dirty WHERE org_id = ? AND scope_key = ?`, ORG_A, `ticket:${n}`)).toBeNull();
  });

  it("the switch: an org with AI off is never asked anything, and its screens get no suggestion", async () => {
    const n = await ticket("Blank page", "The page is blank.");
    await putSuggestion(systemCtx(ORG_A), { itemType: "ticket", itemRef: String(n), kind: "ticket.category", value: "bug", confidence: 0.9, reason: "it says “blank”", cites: [], model: "jev", promptVersion: "p" });
    const cookie = await cookieFor("AndresL230");
    expect((await call<TicketDetail>("GET", `${BASE}/tickets/${n}`, cookie)).json.ai?.map((s) => s.kind)).toEqual(["ticket.category"]);
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    const { s, fetchImpl } = jev(() => ({ category: ["bug", 0.99] }));
    await pass(fetchImpl);
    expect(s.calls).toBe(0);
    expect((await call<TicketDetail>("GET", `${BASE}/tickets/${n}`, cookie)).json).not.toHaveProperty("ai");
  });
});

describe("candidates only (pure)", () => {
  const input: TicketCardInput = {
    number: 9, title: "Login blank", body: "The login page is blank.", category: "other", priority: "normal", askCategory: true, askPriority: true,
    candidates: [{ number: 3, title: "Blank login page", body: "login blank", snippet: null }],
  };
  const choice = (choice: string, opts: string[], p = 0.99) => ({ type: "choice" as const, choice, confidence: p, probabilities: Object.fromEntries(opts.map((o) => [o, o === choice ? p : 0])) });
  it("a duplicate is only ever one of the tickets OFFERED", () => {
    expect(ticketDecide(input, { duplicate: choice("ticket_3", ["none", "ticket_3"]) }).suggestions.map((s) => s.kind)).toEqual(["ticket.duplicate"]);
    expect(ticketDecide(input, { duplicate: choice("ticket_77", ["none", "ticket_77"]) }).suggestions).toEqual([]);
    expect(ticketDecide(input, { duplicate: choice("none", ["none", "ticket_3"]) }).suggestions).toEqual([]);
  });
  it("a destination counts only the options offered — sections and the offered docs", () => {
    const u: UnplacedCardInput = { id: 1, title: "Deploy steps", body: "Run the migrations.", filedUnder: "runbooks", docs: [{ slug: "ops", title: "Ops", section: "reference", body: "ops", snippet: null }] };
    const ans = (probs: Record<string, number>) => ({ destination: { type: "choice" as const, choice: Object.keys(probs)[0], confidence: 0.9, probabilities: probs } });
    expect(unplacedDecide(u, ans({ reference: 0.4, doc_1: 0.4, context: 0.2 })).suggestion?.value).toEqual({ type: "doc", section: "reference", near: "ops", label: "reference, next to “Ops”" });
    // An option nobody offered (a section outside the vocabulary, a doc beyond the list) counts for nothing.
    expect(unplacedDecide(u, ans({ "needs-triage": 0.9, doc_9: 0.05, context: 0.05 })).suggestion).toBeNull();
  });
  it("routine writes nothing; a risk never comes without the item's own words", () => {
    const r: ReviewCardInput = { type: "doc", ref: "doc:a@2", title: "A", section: "reference", changeKind: "edit", summary: "s", removed: ["Sessions last 7 days."], added: ["Sessions last 30 days."], docs: [], decisions: [] };
    const ans = (risk: string) => ({ risk: { type: "choice" as const, choice: risk, confidence: 0.9, probabilities: { decision: 0, contradicts: 0, process: 0, routine: 0, [risk]: 0.9 } } });
    expect(reviewDecide(r, ans("routine")).suggestion).toBeNull();
    expect(reviewDecide(r, ans("decision")).suggestion?.reason).toBe("it replaces “Sessions last 7 days.” with “Sessions last 30 days.”");
  });
  it("evidence is the ticket's own words: a window around a matching word, else the title", () => {
    expect(wordsEvidence({ title: "Export fails", body: "x" }, /\bfails\b/)).toBe("it says “Export fails”");
    expect(wordsEvidence({ title: "Hello", body: "nothing here" }, /\bcrash\b/)).toBe("it says “Hello”");
    expect(ticketRequest({ ...input, askCategory: false, askPriority: false, candidates: [] })).toBeNull();
  });
});

describe("Accept routes through the existing writer, as the person — and never closes, promotes or rejects", () => {
  it("category and priority: set on the ticket as the person; the status is untouched", async () => {
    const n = await ticket("Blank page", "The page is blank.");
    const ctx = systemCtx(ORG_A);
    const cat = (await putSuggestion(ctx, { itemType: "ticket", itemRef: String(n), kind: "ticket.category", value: "bug", confidence: 0.9, reason: "it says “blank”", cites: [], model: "jev", promptVersion: "p" }))!;
    const pri = (await putSuggestion(ctx, { itemType: "ticket", itemRef: String(n), kind: "ticket.priority", value: "high", confidence: 0.9, reason: "it says “blank”", cites: [], model: "jev", promptVersion: "p" }))!;
    const cookie = await cookieFor("meilin");
    expect((await call("POST", `${BASE}/ai/suggestions/${cat}/accept`, cookie, {})).status).toBe(200);
    expect((await call("POST", `${BASE}/ai/suggestions/${pri}/accept`, cookie, {})).status).toBe(200);
    expect(await first(env.DB, `SELECT category, priority, status FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n)).toEqual({ category: "bug", priority: "high", status: "submitted" });
    expect(await first(env.DB, `SELECT state, decided_by FROM ai_suggestions WHERE id = ?`, cat)).toEqual({ state: "accepted", decided_by: "meilin" });
  });

  it("a duplicate: a LINK to the other ticket, added by the person — both tickets stay open, nothing is closed", async () => {
    const older = await ticket("Blank login", "Login is blank.");
    const n = await ticket("Login blank again", "Login is blank.");
    const id = (await putSuggestion(systemCtx(ORG_A), { itemType: "ticket", itemRef: String(n), kind: "ticket.duplicate", value: { number: older, label: `#${older} Blank login` }, confidence: 0.97, reason: "both mention “login” and “blank”", cites: [], model: "jev", promptVersion: "p" }))!;
    const r = await call<{ ok: boolean }>("POST", `${BASE}/ai/suggestions/${id}/accept`, await cookieFor("meilin"), {});
    expect(r.status).toBe(200);
    const links = await all<{ url: string; label: string; meta: string; created_by: string }>(env.DB,
      `SELECT l.url, l.label, l.meta, l.created_by FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE t.org_id = ? AND t.number = ?`, ORG_A, n);
    expect(links).toEqual([{ url: `http://localhost/saplinglearn/#tickets/${older}`, label: `#${older}`, meta: "TROV · TICKET", created_by: "meilin" }]);
    expect(await all(env.DB, `SELECT number, status FROM tickets WHERE org_id = ? AND number IN (?, ?) ORDER BY number`, ORG_A, older, n))
      .toEqual([{ number: older, status: "submitted" }, { number: n, status: "submitted" }]);
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM ticket_events t JOIN tickets k ON k.id = t.ticket_id WHERE k.org_id = ? AND k.number IN (?, ?) AND t.from_status IS NOT NULL`, ORG_A, older, n)).toEqual({ n: 0 });
  });

  it("an Unplaced destination files the item exactly as \"File it\": the same gate, as the person", async () => {
    const id = await route_triage(systemCtx(ORG_A), { raw: { slug: "deploy-checklist", section: "runbooks", title: "Deploy checklist", body: "Run the migrations, then check health.", change_summary: "new", confidence: "low" }, reason: "section 'runbooks' is not in the vocabulary", source_author: "AndresL230" });
    const s = (await putSuggestion(systemCtx(ORG_A), { itemType: "unplaced", itemRef: String(id), kind: "unplaced.destination", value: { type: "doc", section: "reference", near: null, label: "reference" }, confidence: 0.8, reason: "the agent filed it under “runbooks” (not a section)", cites: [], model: "jev", promptVersion: "p" }))!;
    expect((await call("POST", `${BASE}/ai/suggestions/${s}/accept`, await cookieFor("meilin"), {})).status).toBe(200);
    expect(await first(env.DB, `SELECT resolved, resolution, resolved_by, assigned_ref FROM needs_triage WHERE id = ?`, id))
      .toMatchObject({ resolved: 1, resolution: "assigned", resolved_by: "meilin" });
    // Staged through the gate — a proposal waiting in Review, by the person; nothing promoted.
    expect(await first(env.DB, `SELECT status, created_by FROM doc_versions WHERE org_id = ? AND slug = 'deploy-checklist'`, ORG_A)).toEqual({ status: "staged", created_by: "meilin" });
    expect(await first(env.DB, `SELECT section, current_version FROM docs WHERE org_id = ? AND slug = 'deploy-checklist'`, ORG_A)).toMatchObject({ section: "reference", current_version: 0 });
  });

  it("a risk has no Accept (not_available) and Dismiss changes nothing in Review: no promote, no reject", async () => {
    const ctx = await tenantCtx("AndresL230");
    await ingestDocProposal(ctx, { slug: "auth-flow", section: "reference", body: "Sessions last 30 days.", change_summary: "longer sessions", confidence: "high" } as never, "AndresL230");
    const s = (await putSuggestion(systemCtx(ORG_A), { itemType: "proposal", itemRef: "doc:auth-flow@1", kind: "review.risk", value: { risk: "decision", label: "Changes a decision" }, confidence: 0.8, reason: "it adds “Sessions last 30 days.”", cites: [], model: "jev", promptVersion: "p" }))!;
    const cookie = await cookieFor("meilin");
    expect(await call("POST", `${BASE}/ai/suggestions/${s}/accept`, cookie, {})).toEqual({ status: 409, json: { error: "not_available" } });
    expect((await call("POST", `${BASE}/ai/suggestions/${s}/dismiss`, cookie, {})).status).toBe(200);
    expect(await first(env.DB, `SELECT status FROM doc_versions WHERE org_id = ? AND slug = 'auth-flow'`, ORG_A)).toEqual({ status: "staged" });
    expect(await first(env.DB, `SELECT current_version FROM docs WHERE org_id = ? AND slug = 'auth-flow'`, ORG_A)).toEqual({ current_version: 0 });
  });
});

describe("the Review and Unplaced cards through the pass, and the screens' reads", () => {
  it("a staged doc proposal and a drafted decision each get one Jev request; routine writes nothing; the risk shows on /proposals and /adrs", async () => {
    const ctx = await tenantCtx("AndresL230");
    await ingestDocProposal(ctx, { slug: "sessions", section: "reference", body: "A session lasts 30 days.", change_summary: "longer sessions", confidence: "high" } as never, "AndresL230");
    const adr = await ingestAdrDraft(ctx, { title: "Use D1 for search", context: "Search needs an index.", decision: "Use D1's FTS5 for search.", rationale: "One store.", confidence: "high" } as never, "AndresL230");
    const adrId = (adr as { id: number }).id;
    const { s, fetchImpl } = jev((b) => (b.state.includes("drafted decision") ? { risk: ["routine", 0.9] } : { risk: ["decision", 0.8] }));
    await pass(fetchImpl);
    expect(s.calls).toBe(2);
    expect((await suggestions("proposal", "doc:sessions@1")).map((r) => [r.kind, JSON.parse(r.value_json).risk])).toEqual([["review.risk", "decision"]]);
    expect(await suggestions("proposal", `adr:${adrId}`)).toEqual([]);
    const cookie = await cookieFor("meilin");
    const proposals = (await call<{ proposals: { slug: string; ai?: { kind: string; label: string }[] }[] }>("GET", `${BASE}/proposals`, cookie)).json.proposals;
    expect(proposals.find((p) => p.slug === "sessions")?.ai?.map((a) => [a.kind, a.label])).toEqual([["review.risk", "Changes a decision"]]);
    const adrs = (await call<{ adrs: AdrRow[] }>("GET", `${BASE}/adrs?status=draft`, cookie)).json.adrs;
    expect(adrs.find((a) => a.id === adrId)).not.toHaveProperty("ai");
  });

  it("an Unplaced doc gets one Jev request over the sections and nearby docs; a free-form item gets none", async () => {
    const ctx = systemCtx(ORG_A);
    const doc = await route_triage(ctx, { raw: { slug: "deploy-checklist", section: "runbooks", title: "Deploy checklist", body: "Before a deploy, run the migrations.", change_summary: "new", confidence: "low" }, reason: "section 'runbooks' is not in the vocabulary", source_author: "AndresL230" });
    const loose = await route_triage(ctx, { raw: "a free-form note", reason: "Flagged by an agent" });
    const { s, fetchImpl } = jev(() => ({ destination: ["reference", 0.8] }));
    await pass(fetchImpl);
    expect(s.calls).toBe(1);
    expect(Object.keys(s.bodies[0].questions.destination.criteria).slice(0, 3)).toEqual(["reference", "context", "decisions"]);
    const rows = await suggestions("unplaced", String(doc));
    expect(rows.map((r) => [r.kind, JSON.parse(r.value_json).section])).toEqual([["unplaced.destination", "reference"]]);
    expect(rows[0].reason).toContain("the agent filed it under “runbooks” (not a section)");
    expect(await suggestions("unplaced", String(loose))).toEqual([]);
    const items = (await call<{ items: NeedsTriageRow[] }>("GET", `${BASE}/needs-triage`, await cookieFor("meilin"))).json.items;
    expect(items.find((i) => i.id === doc)?.ai?.map((a) => a.label)).toEqual(["reference"]);
    expect(items.find((i) => i.id === loose)).not.toHaveProperty("ai");
  });

  it("MCP's get_ticket never carries the suggestions (the cookie read adds them)", async () => {
    expect(AI_JOBS.length).toBe(3);
    const { get_ticket } = await import("../src/tools/reads");
    const n = await ticket("Blank page", "x");
    await putSuggestion(systemCtx(ORG_A), { itemType: "ticket", itemRef: String(n), kind: "ticket.category", value: "bug", confidence: 0.9, reason: "it says “blank”", cites: [], model: "jev", promptVersion: "p" });
    expect(await get_ticket(systemCtx(ORG_A), n)).not.toHaveProperty("ai");
  });
});

describe("LOCAL_AI_PREVIEW: the sample suggestions on the three screens' real rows (wrangler dev only)", () => {
  const LOCAL = "http://localhost:8787";
  const withVars = (over: Partial<Env>): Env => ({ ...(env as unknown as Env), ...over });
  async function get<T>(origin: string, path: string, e: Env): Promise<T> {
    const res = await app.request(`${origin}/api/o/saplinglearn${path}`, { headers: { cookie: await cookieFor("AndresL230") } }, e);
    expect(res.status, path).toBe(200);
    return (await res.json()) as T;
  }
  it("ready: the ticket gets category, priority and a duplicate; the first doc in Unplaced a destination; Review's first a risk", async () => {
    const e = withVars({ LOCAL_AI_PREVIEW: "ready" });
    const a = await ticket("First ticket", "x");
    const b = await ticket("Second ticket", "y");
    const t = await get<TicketDetail>(LOCAL, `/tickets/${b}`, e);
    expect(t.ai?.map((s) => s.kind)).toEqual(["ticket.category", "ticket.priority", "ticket.duplicate"]);
    expect(t.ai?.[2].value).toEqual({ number: a, label: `#${a} First ticket` });
    const ctx = systemCtx(ORG_A);
    const doc = await route_triage(ctx, { raw: { slug: "x", section: "runbooks", title: "X", body: "b", change_summary: "c", confidence: "low" }, reason: "r" });
    await route_triage(ctx, { raw: "free-form", reason: "r" });
    const items = (await get<{ items: NeedsTriageRow[] }>(LOCAL, "/needs-triage", e)).items;
    expect(items.filter((i) => i.ai).map((i) => [i.id, i.ai?.[0].kind])).toEqual([[doc, "unplaced.destination"]]);
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "p1", section: "reference", body: "b", change_summary: "c", confidence: "high" } as never, "AndresL230");
    const proposals = (await get<{ proposals: { ai?: { label: string }[] }[] }>(LOCAL, "/proposals", e)).proposals;
    expect(proposals[0].ai?.map((s) => s.label)).toEqual(["Changes a decision"]);
    // empty: none; a deployed origin, or no var: none.
    expect(await get<TicketDetail>(LOCAL, `/tickets/${b}`, withVars({ LOCAL_AI_PREVIEW: "empty" }))).not.toHaveProperty("ai");
    expect(await get<TicketDetail>("https://trov.dev", `/tickets/${b}`, e)).not.toHaveProperty("ai");
    expect(await get<TicketDetail>(LOCAL, `/tickets/${b}`, env as unknown as Env)).not.toHaveProperty("ai");
    // The switch still holds under the preview.
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    expect(await get<TicketDetail>(LOCAL, `/tickets/${b}`, e)).not.toHaveProperty("ai");
  });
});
