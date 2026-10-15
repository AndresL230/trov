// Phase C's suggestions END TO END on REAL data — no `LOCAL_AI_PREVIEW`, no fixtures: the REAL pass (Jev stubbed
// at the `Response` level) writes `ai_suggestions` rows into Miniflare D1; the SPA's OWN api client
// (web/src/api.ts `getTicket` / `listNeedsTriage` / `listStagedProposals` / `listAdrs`) reads them through the REAL
// cookie routes (`fetch` is pointed at the Worker's Hono app, with a real session cookie); the SPA's OWN `render`
// draws the ticket detail, Unplaced and Review from what came back, through the AI kit's chip (web/src/ai-ui.ts
// `aiSuggestionChip`); and pressing Accept is the AI kit's own act (web/src/ai-actions.ts `aiAccept` →
// `acceptAiSuggestion` → `POST /ai/suggestions/:id/accept`), after which the re-read shows the field changed and
// the chip gone.
//
// This is a WORKER test (tsconfig.worker.json): web/src is type-checked under tsconfig.web.json only (DOM lib), so
// the SPA modules are loaded at runtime through non-literal specifiers and typed here by the little they are used for.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { app as worker } from "../src/routes";
import { runAiPass } from "../src/ai/pass";
import { newBudget } from "../src/repo/dispatch";
import { create_ticket } from "../src/tools/tickets";
import { ingestDocProposal } from "../src/consumer";
import { route_triage } from "../src/tools/writes";
import type { TicketDetail } from "@shared/tickets";
import type { AdrRow, NeedsTriageRow } from "@shared/rows";
import type { AiSuggestion } from "@shared/ai-core";
import { first } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, systemCtx, tenantCtx } from "./helpers/tenant";
import { keyedEnv } from "./helpers/ai-pass";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));

// ── the SPA, loaded at runtime ───────────────────────────────────────────────
type State = Record<string, unknown> & { ai: { busy: number[]; unavailable: number[] } };
interface WebRender { render(s: State): string; initialState(): State }
interface WebApi {
  setApiOrg(slug: string | null): void;
  getTicket(id: number): Promise<TicketDetail>;
  listNeedsTriage(): Promise<NeedsTriageRow[]>;
  listStagedProposals(): Promise<(Record<string, unknown> & { slug: string; ai?: AiSuggestion[] })[]>;
  listAdrs(status?: string): Promise<AdrRow[]>;
}
interface WebAi {
  createAiController(host: { state: State; mount: unknown; rerender(): void; flash(m: string): void; unauth(e: unknown): void; decided?(id: number, how: string): void }): { act(act: string, arg: string | null, value: string | null): void };
}
const RENDER = "../web/src/render";
const API = "../web/src/api";
const AI_ACTIONS = "../web/src/ai-actions";
let web: WebRender;
let api: WebApi;
let aiActions: WebAi;

const ME = "meilin"; // a plain member (Google-only), not the tickets' author
const realFetch = globalThis.fetch;
beforeAll(async () => {
  web = (await import(/* @vite-ignore */ RENDER)) as WebRender;
  api = (await import(/* @vite-ignore */ API)) as WebApi;
  aiActions = (await import(/* @vite-ignore */ AI_ACTIONS)) as WebAi;
  api.setApiOrg("saplinglearn");
  // The browser's same-origin fetch, answered by the Worker's own app with the person's session cookie.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (!path.startsWith("/api/")) throw new Error(`unexpected request ${path}`);
    const headers = { ...(init?.headers as Record<string, string> | undefined), cookie: await cookieFor(ME) };
    return worker.request(`http://localhost${path}`, { method: init?.method ?? "GET", headers, body: init?.body }, env as unknown as Env);
  }) as typeof fetch;
}, 120_000); // the SPA's modules are transformed on first import: slow under a full, parallel run
afterAll(() => { globalThis.fetch = realFetch; api?.setApiOrg(null); });

const PERSONS = { status: "ok", data: [{ handle: "meilin", name: "Mei Lin", color: "moss", avatar_url: null, role: null }] };
const screen = (o: Record<string, unknown>): State => ({
  ...web.initialState(), view: "app", orgSlug: "saplinglearn", persons: PERSONS,
  me: { handle: ME, name: "Mei Lin", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "member" }], superadmin: false, pending_invites: 0 },
  ...o,
});

// ── Jev, stubbed at the Response level: what the pass's real requests are answered ──
function jevFetch(pick: Record<string, (opts: string[]) => [string, number]>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).startsWith("https://api.typesafe.ai/")) return new Response("ok");
    const body = JSON.parse(String(init?.body)) as { questions: Record<string, { criteria: Record<string, string> }> };
    const answers: Record<string, unknown> = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const opts = Object.keys(q.criteria);
      const [choice, p] = pick[id]?.(opts) ?? [opts[opts.length - 1], 0.9];
      const rest = (1 - p) / (opts.length - 1);
      answers[id] = { type: "choice", choice, confidence: p, probabilities: Object.fromEntries(opts.map((o) => [o, o === choice ? p : rest])) };
    }
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers, usage: { input_tokens: 40, output_tokens: 3 } }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
const runPass = (f: typeof fetch) => runAiPass(keyedEnv(), newBudget(f), { now: new Date(Date.now() + 60_000) });

/** Press the AI kit's button `act` for suggestion `id` and wait until the screen is told it was decided. */
function press(state: State, act: "aiAccept" | "aiDismiss", id: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const ctl = aiActions.createAiController({
      state, mount: null, rerender: () => undefined, flash: (m) => { if (m !== "Accepted" && m !== "Removed") reject(new Error(m)); },
      unauth: (e) => reject(e), decided: (_id, how) => resolve(how),
    });
    ctl.act(act, String(id), null);
  });
}
const chipIds = (html: string): number[] => [...html.matchAll(/data-act="aiAccept" data-arg="(\d+)"/g)].map((m) => Number(m[1]));

describe("real rows → real reads → the SPA's render → the AI kit's Accept", () => {
  it("ticket detail: the pass's category, priority and duplicate render as chips; Accept sets the category and the chip goes", async () => {
    const ctx = systemCtx(ORG_A);
    const older = await create_ticket(ctx, { title: "Safari login page is blank", body: "The login page renders blank on Safari.", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    const n = await create_ticket(ctx, { title: "Blank login page on Safari", body: "Since today the login page is blank on Safari, which blocks everyone.", category: "other", priority: "normal", assignees: [] }, "AndresL230");
    await runPass(jevFetch({
      category: () => ["bug", 0.95],
      priority: () => ["high", 0.9],
      duplicate: (opts) => [opts.includes(`ticket_${older}`) ? `ticket_${older}` : "none", 0.97],
    }));

    const t = await api.getTicket(n);
    expect(t.ai?.map((s) => s.kind)).toEqual(["ticket.category", "ticket.priority", "ticket.duplicate"]);
    let html = web.render(screen({ screen: "ticketdetail", ticketId: n, ticketDetail: { status: "ok", data: t } }));
    expect(html).toContain("bug category");
    expect(html).toContain("high priority");
    expect(html).toContain(`possible duplicate of #${older} Safari login page is blank`);
    expect(html).toContain("cnpy-ai-chip");
    // One Accept per stored row, carrying that row's id (the duplicate's chip comes first: the left column).
    expect(chipIds(html).sort((x, y) => x - y)).toEqual(t.ai!.map((s) => s.id).sort((x, y) => x - y));

    // Accept the category through the AI kit's own act and the real route.
    const state = screen({ screen: "ticketdetail", ticketId: n, ticketDetail: { status: "ok", data: t } });
    const cat = t.ai!.find((s) => s.kind === "ticket.category")!;
    expect(await press(state, "aiAccept", cat.id)).toBe("accept");
    expect(await first(env.DB, `SELECT category, status FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n)).toEqual({ category: "bug", status: "submitted" });
    expect(await first(env.DB, `SELECT state, decided_by FROM ai_suggestions WHERE id = ?`, cat.id)).toEqual({ state: "accepted", decided_by: ME });

    // The screen's re-read: the category is the ticket's own now, its chip gone, the other two still there.
    const again = await api.getTicket(n);
    expect(again.category).toBe("bug");
    html = web.render(screen({ screen: "ticketdetail", ticketId: n, ticketDetail: { status: "ok", data: again } }));
    expect(html).not.toContain("bug category");
    expect(chipIds(html)).toHaveLength(2);

    // Accept the duplicate: a link, by the person; nothing closes.
    const dup = again.ai!.find((s) => s.kind === "ticket.duplicate")!;
    expect(await press(state, "aiAccept", dup.id)).toBe("accept");
    const linked = await api.getTicket(n);
    expect(linked.links.map((l) => [l.label, l.created_by])).toEqual([[`#${older}`, ME]]);
    expect(linked.status).toBe("submitted");
    expect((await api.getTicket(older)).status).toBe("submitted");
  });

  it("Unplaced: the pass's destination renders as a chip on the item; Accept files it as \"File it\" does and the item leaves the queue", async () => {
    const id = await route_triage(systemCtx(ORG_A), { raw: { slug: "deploy-checklist", section: "runbooks", title: "Deploy checklist", body: "Before a deploy, run the migrations, then check the health endpoint.", change_summary: "new", confidence: "low" }, reason: "section 'runbooks' is not in the vocabulary", source_author: "AndresL230" });
    await runPass(jevFetch({ destination: () => ["reference", 0.9] }));

    const rows = await api.listNeedsTriage();
    const row = rows.find((r) => r.id === id)!;
    expect(row.ai?.map((s) => [s.kind, s.label])).toEqual([["unplaced.destination", "reference"]]);
    const html = web.render(screen({ screen: "maintenance", needsTriage: { status: "ok", data: rows } }));
    expect(html).toContain("file it as a doc in reference");
    expect(html).toContain("cnpy-ai-row-mark");
    expect(chipIds(html)).toEqual([row.ai![0].id]);

    expect(await press(screen({ screen: "maintenance" }), "aiAccept", row.ai![0].id)).toBe("accept");
    expect(await first(env.DB, `SELECT resolution, resolved_by FROM needs_triage WHERE id = ?`, id)).toEqual({ resolution: "assigned", resolved_by: ME });
    expect(await first(env.DB, `SELECT status, created_by FROM doc_versions WHERE org_id = ? AND slug = 'deploy-checklist'`, ORG_A)).toEqual({ status: "staged", created_by: ME });
    expect((await api.listNeedsTriage()).find((r) => r.id === id)).toBeUndefined();
  });

  it("Review: the pass's risk renders as a quiet line with Dismiss only; Dismiss removes it and the proposal stays staged", async () => {
    await ingestDocProposal(await tenantCtx("AndresL230"), { slug: "auth-flow", section: "reference", title: "Auth flow", body: "A session lasts 30 days.", change_summary: "longer sessions", confidence: "high" } as never, "AndresL230");
    await runPass(jevFetch({ risk: () => ["decision", 0.9] }));

    const proposals = await api.listStagedProposals();
    const p = proposals.find((x) => x.slug === "auth-flow")!;
    expect(p.ai?.map((s) => [s.kind, s.label])).toEqual([["review.risk", "Changes a decision"]]);
    const html = web.render(screen({ screen: "review", proposals: { status: "ok", data: proposals }, draftAdrs: { status: "ok", data: await api.listAdrs("draft") } }));
    expect(html).toContain("cnpy-ai-risk-line");
    expect(html).toContain("Changes a decision");
    expect(html).not.toContain('data-act="aiAccept"');
    expect(html).toContain(`data-act="aiDismiss" data-arg="${p.ai![0].id}"`);

    expect(await press(screen({ screen: "review" }), "aiDismiss", p.ai![0].id)).toBe("dismiss");
    expect((await api.listStagedProposals()).find((x) => x.slug === "auth-flow")).not.toHaveProperty("ai");
    expect(await first(env.DB, `SELECT status FROM doc_versions WHERE org_id = ? AND slug = 'auth-flow'`, ORG_A)).toEqual({ status: "staged" });
  });
});
