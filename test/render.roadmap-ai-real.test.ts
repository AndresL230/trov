// The Roadmap's AI pieces on REAL data (Phase D; the owner's ask): rows written by the real writers into Miniflare D1
// — `org_insights` through `putInsight`, `ai_suggestions` through `putSuggestion`, sprints and tickets through
// theirs — read back through the REAL reads (GET /api/o/:slug/roadmap with a session cookie, and MCP `get_roadmap`),
// and drawn by the REAL render (web/src/render.ts over the AI kit, web/src/ai-ui.ts). No fixture, no
// `LOCAL_AI_PREVIEW` (blank in the pool, and the origin is the deployed one): what a person sees after the pass ran.
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</div>`,
  renderMarkdownInline: (text: string) => text,
}));
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { buildTrovMcpServer } from "../src/mcp";
import { create_sprint, set_sprint_active } from "../src/tools/sprints";
import { create_ticket, set_ticket_sprint, transition_ticket } from "../src/tools/tickets";
import { putInsight } from "../src/data/org-insights";
import { putSuggestion } from "../src/data/ai";
import { AI_ROADMAP_ITEM, aiItemRef } from "@shared/ai";
import { aiFeedback } from "../web/src/ai-ui";
import { render, initialState, type AppState } from "../web/src/render";
import type { PlanView } from "../web/src/api";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, bearerCtx, systemCtx } from "./helpers/tenant";
import { run } from "./helpers/db";

const DEPLOYED = "https://trov.dev";
const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const ctx = () => systemCtx();
const NOTE = "Two of five closed; #3 waits on review and the rest are unassigned.";
const DRIFT = "The last two weeks went mostly to Billing, which isn't in any sprint.";

/** An active sprint begun ten days ago, due in ten, two of five tickets closed: the forecast is arithmetic over it. */
async function seedRoadmap(): Promise<{ sprintId: number; tickets: number[] }> {
  const now = Date.now();
  const sp = await create_sprint(ctx(), { label: "Hosting", urgency: "normal", start: ymd(now - 9 * DAY), due: ymd(now + 10 * DAY) }, "AndresL230");
  await set_sprint_active(ctx(), sp.id, true);
  const tickets: number[] = [];
  for (let i = 1; i <= 5; i++) {
    const n = await create_ticket(ctx(), { title: `Hosting task ${i}`, body: "", category: "request", priority: "normal", assignees: [] }, "AndresL230");
    await set_ticket_sprint(ctx(), n, sp.id);
    tickets.push(n);
  }
  await transition_ticket(ctx(), tickets[0], "done", "AndresL230");
  await transition_ticket(ctx(), tickets[1], "done", "AndresL230");
  return { sprintId: sp.id, tickets };
}

/** What the pass would have written: a note on the sprint, the drift, and two open suggestions. */
async function seedAi(sprintId: number, tickets: number[]): Promise<void> {
  const meta = { model: "claude-haiku-5-5", promptVersion: "note-1" };
  await putInsight(ctx(), "sprint_note", String(sprintId), { text: NOTE, cites: [{ ref: `ticket:${tickets[2]}`, label: `#${tickets[2]}`, href: `#tickets/${tickets[2]}` }] }, meta);
  await putInsight(ctx(), "plan_drift", "", {
    text: DRIFT, cites: [{ ref: "theme:7", label: "Billing", href: "#repo/planning" }], windowDays: 14,
    shares: [{ themeId: "7", theme: "Billing", pct: 46, inSprint: false }, { themeId: "8", theme: "Hosting", pct: 31, inSprint: true }],
  }, { model: "claude-haiku-5-5", promptVersion: "drift-1" });
  const backlog: number[] = [];
  for (let i = 1; i <= 2; i++) backlog.push(await create_ticket(ctx(), { title: `Backlog ${i}`, body: "", category: "bug", priority: "normal", assignees: [] }, "AndresL230"));
  await putSuggestion(ctx(), {
    ...AI_ROADMAP_ITEM, kind: "sprint_draft", value: { sprints: [{ name: "Billing fixes", goal: "Close the open billing bugs.", tickets: [backlog[0]] }, { name: "Polish", goal: "The small things.", tickets: [backlog[1]] }] },
    confidence: null, reason: "the backlog splits into billing bugs and polish.", cites: [{ ref: `ticket:${backlog[0]}`, label: `#${backlog[0]}`, href: `#tickets/${backlog[0]}` }],
    model: "claude-haiku-5-5", promptVersion: "draft-1",
  });
  await putSuggestion(ctx(), {
    ...AI_ROADMAP_ITEM, kind: "plan_narrative", value: { narrative: "**Now:** hosting. **Next:** billing." },
    confidence: null, reason: "Hosting is under way and billing drifted in.", cites: [{ ref: `sprint:${sprintId}`, label: "Hosting", href: `#sprints/${sprintId}` }],
    model: "claude-haiku-5-5", promptVersion: "narrative-1",
  });
}

async function roadmapRead(handle: string): Promise<PlanView> {
  const res = await app.request(`${DEPLOYED}/api/o/saplinglearn/roadmap`, { headers: { cookie: await cookieFor(handle) } }, env as unknown as Env);
  expect(res.status).toBe(200);
  return (await res.json()) as PlanView;
}

async function mcpRoadmap(): Promise<PlanView> {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx("AndresL230"));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  try {
    const res = (await client.callTool({ name: "get_roadmap", arguments: {} })) as { content: Array<{ text: string }>; isError?: boolean };
    expect(res.isError).toBeFalsy();
    return JSON.parse(res.content[0].text) as PlanView;
  } finally {
    await client.close();
    await server.close();
  }
}

const screen = (plan: PlanView, role: "admin" | "member"): string => {
  const s: AppState = {
    ...initialState(), view: "app", orgSlug: "saplinglearn", screen: "roadmap", roadmapTab: "narrative",
    me: { handle: "x", name: "X", avatar_url: null, color: "moss", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role }], superadmin: false, pending_invites: 0 },
    roadmap: { status: "ok", data: plan }, roadmapFeed: { status: "ok", data: [] },
  };
  return render(s);
};

describe("the Roadmap on real rows: the real read, the real render", () => {
  it("an admin sees the forecast, the sprint's note, the drift line and both suggestion cards — through the kit", async () => {
    const { sprintId, tickets } = await seedRoadmap();
    await seedAi(sprintId, tickets);
    const plan = await roadmapRead(FIXTURE_ADMIN);
    const sp = plan.sprints.find((s) => s.id === sprintId)!;
    // The forecast: 2 closed in 10 days (0.2 a day) over 3 open → 15 days from today, 5 after the due day.
    expect(sp.forecast).toMatchObject({ remaining: 3, perDay: 0.2, daysLate: 5 });
    expect(sp.note?.text).toBe(NOTE);
    expect(plan.drift?.shares.map((x) => x.pct)).toEqual([46, 31]);
    expect(plan.suggestions?.map((s) => s.kind).sort()).toEqual(["plan_narrative", "sprint_draft"]);

    const html = screen(plan, "admin");
    expect(html).toMatch(/class="rm-forecast"[^>]*>At this pace, done [A-Z][a-z]{2} \d+, <span[^>]*>5 days late<\/span>/);
    expect(html).toContain('class="rm-note"');
    expect(html).toContain(NOTE.replace("'", "&#39;"));
    expect(html).toContain(`href="#tickets/${tickets[2]}"`); // the note's cite, through aiCites
    expect(html).toContain('class="rm-drift"');
    expect(html).toContain("Billing 46%");
    expect(html).toContain("from the last 14 days"); // aiByline
    expect(html.match(/data-act="aiWrong"/g)?.length).toBeGreaterThanOrEqual(2); // note + drift
    expect(html).toContain('class="rm-suggestions"');
    expect(html.match(/data-act="aiAccept"/g)).toHaveLength(2); // aiSuggestionChip
    expect(html).toContain("Billing fixes");
    expect(html).toContain("mock-live-md"); // the narrative through the app's markdown
  });

  it("a member gets no suggestion card (the server sends none); MCP get_roadmap carries the forecast, note and drift, never a suggestion", async () => {
    const { sprintId, tickets } = await seedRoadmap();
    await seedAi(sprintId, tickets);
    const member = await roadmapRead("lpcooper-arch");
    expect(member.suggestions).toBeUndefined();
    const html = screen(member, "member");
    expect(html).toContain('class="rm-note"');
    expect(html).toContain('class="rm-drift"');
    expect(html).not.toContain("rm-suggestions");

    const viaMcp = await mcpRoadmap();
    const sp = viaMcp.sprints.find((s) => s.id === sprintId)!;
    expect(sp.forecast).toMatchObject({ remaining: 3 });
    expect(sp.note?.text).toBe(NOTE);
    expect(viaMcp.drift?.text).toBe(DRIFT);
    expect(viaMcp.suggestions).toBeUndefined();
  });

  it("'Wrong?' on the note hides it for that person only, through the real feedback route", async () => {
    const { sprintId, tickets } = await seedRoadmap();
    await seedAi(sprintId, tickets);
    const before = await roadmapRead("lpcooper-arch");
    const note = before.sprints.find((s) => s.id === sprintId)!.note!;
    const res = await app.request(`${DEPLOYED}/api/o/saplinglearn/ai/feedback`, {
      method: "POST", headers: { cookie: await cookieFor("lpcooper-arch"), "content-type": "application/json" },
      // Exactly what the note's "Wrong?" button carries (the kit's own body).
      body: JSON.stringify(aiFeedback("sprint_note", aiItemRef.sprintNote(sprintId, note.generatedAt), "sprint_note", note.model)),
    }, env as unknown as Env);
    expect(res.status).toBeLessThan(300);
    expect(screen(await roadmapRead("lpcooper-arch"), "member")).not.toContain('class="rm-note"');
    expect(screen(await roadmapRead("meilin"), "member")).toContain('class="rm-note"');
  });

  it("ABSENT: no rows, or the AI switch off — no note, drift or card; the forecast is arithmetic and stays", async () => {
    const { sprintId, tickets } = await seedRoadmap();
    const none = await roadmapRead(FIXTURE_ADMIN);
    expect(none.drift).toBeUndefined();
    expect(none.suggestions).toBeUndefined();
    expect(none.sprints.find((s) => s.id === sprintId)!.note).toBeUndefined();
    const bare = screen(none, "admin");
    for (const c of ["rm-note", "rm-drift", "rm-suggestions", "cnpy-ai"]) expect(bare).not.toContain(c);
    expect(bare).toContain("rm-forecast");

    await seedAi(sprintId, tickets);
    await run(env.DB, `UPDATE orgs SET ai_automation = 0 WHERE id = ?`, ORG_A);
    const off = await roadmapRead(FIXTURE_ADMIN);
    expect(off.drift).toBeUndefined();
    expect(off.suggestions).toBeUndefined();
    expect(off.sprints.find((s) => s.id === sprintId)!.note).toBeUndefined();
    const offHtml = screen(off, "admin");
    for (const c of ["rm-note", "rm-drift", "rm-suggestions"]) expect(offHtml).not.toContain(c);
    // With the AI fields gone, the screen is the same markup as with no rows at all.
    expect(offHtml).toBe(bare);
  });
});
