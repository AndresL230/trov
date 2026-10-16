/**
 * My Work › Your brief over REAL data, end to end — no `LOCAL_AI_PREVIEW`, no `aiPreviewFixtures`, no fixture DTO:
 * real D1 rows (an assigned ticket in an overdue sprint, a handoff left for the person, their Status note) → the
 * real `brief.person` job in a real AI pass (Anthropic stubbed at the `Response` level) writes a `person_brief` row →
 * the real read (`GET /me/dashboard`, and MCP `get_my_work`'s `getMyWork`) → the real screen (`render`, wired at
 * web/src/render.ts to `briefTile`). Then the tile's own "Wrong?" button: its `data-arg` is POSTed, as the web
 * client sends it, to the real `/ai/feedback` route, and the next read leaves the field out, so the screen falls
 * back to the plain layout (the field-absent markup itself is pinned by test/render.ai-absent.test.ts).
 *
 * Type-checked under tsconfig.worker.json (it reaches D1 and src/): the SPA's modules are loaded at run time by a
 * computed path, so neither config type-checks the other's code (render tests that import web/src statically are
 * listed in tsconfig.web.json instead — this one cannot be, since it imports the Worker).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${body}</div>`,
  renderMarkdownInline: (text: string) => text,
}));
import { env } from "cloudflare:test";
import { app as worker } from "../src/routes";
import { runAiPass } from "../src/ai/pass";
import { briefJob } from "../src/ai/brief";
import { newBudget } from "../src/repo/dispatch";
import { latestBrief, markMyWorkOpened } from "../src/data/person-brief";
import { getMyWork } from "../src/tools/mywork";
import { AI_ROUTES } from "@shared/ai";
import type { DashboardData } from "@shared/dashboard";
import { first, run } from "./helpers/db";
import { ORG_A, systemCtx } from "./helpers/tenant";
import { cookieFor } from "./helpers/persons";
import { keyedEnv, markRow, stubProviders } from "./helpers/ai-pass";

const ME = "AndresL230";
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const ctx = () => systemCtx(ORG_A);

const NOW_TEXT = "Your status note says the hosting screens are half done.";
const WHY_TICKET = "Its sprint is past due, so it is the first thing to close.";

/** The SPA's own modules, loaded at run time (see the header). */
interface Web {
  render(s: unknown): string;
  initialState(): Record<string, unknown>;
  parseFeedbackArg(arg: string | null): { itemType: string; itemRef: string; kind: string; model: string | null } | null;
}
const WEB_RENDER = "../web/src/render";
const WEB_AI_ACTIONS = "../web/src/ai-actions";
let web: Web;
beforeAll(async () => {
  web = { ...(await import(/* @vite-ignore */ WEB_RENDER)), ...(await import(/* @vite-ignore */ WEB_AI_ACTIONS)) } as Web;
});

function screen(data: DashboardData): string {
  const { render, initialState } = web;
  const s = {
    ...initialState(), view: "app", orgSlug: "saplinglearn",
    me: { handle: ME, name: "Andres", avatar_url: null, color: "sky", identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "admin" }], superadmin: false, pending_invites: 0 },
    persons: { status: "ok", data: [{ handle: ME, name: "Andres", color: "sky", avatar_url: null, role: null }] },
    screen: "mywork", mywork: { status: "ok", data },
  };
  return render(s);
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

async function dashboard(cookie: string): Promise<DashboardData> {
  const res = await worker.request("/me/dashboard", { headers: { cookie } }, env);
  expect(res.status).toBe(200);
  return (await res.json()) as DashboardData;
}

beforeEach(async () => {
  // The person's world, as real rows: their Status note, a ticket in an overdue sprint, a handoff from Jose.
  await run(env.DB, `INSERT INTO feed (org_id, author, summary, brief, created_at) VALUES (?, ?, 'Status: hosting screens half done', NULL, ?)`, ORG_A, ME, iso(60 * MIN));
  await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (901, ?, 'Hosting', ?, 'in_progress', ?, ?)`,
    ORG_A, new Date(Date.now() - 3 * DAY).toISOString().slice(0, 10), iso(10 * DAY), ME);
  await run(env.DB, `INSERT INTO tickets (id, org_id, number, title, body, category, priority, status, requester, sprint_id, created_at, updated_at)
    VALUES (3, ?, 3, 'Netlify connect flow', '', 'other', 'normal', 'in_progress', 'meilin', 901, ?, ?)`, ORG_A, iso(5 * DAY), iso(MIN));
  await run(env.DB, `INSERT INTO ticket_assignees (org_id, ticket_id, login) VALUES (?, 3, ?)`, ORG_A, ME);
  await run(env.DB, `INSERT INTO handoffs (org_id, number, sender, recipient, status, body, created_at, expires_at) VALUES (?, 7, 'Jose-Gael-Cruz-Lopez', ?, 'pending', 'Finish the Render provider\nmore', ?, ?)`,
    ORG_A, ME, iso(DAY), new Date(Date.now() + 3 * DAY).toISOString());
  await markMyWorkOpened(ctx(), ME);
});

describe("My Work › Your brief, from a stored person_brief row through the real read", () => {
  it("the job's row fills DashboardData.brief on /me/dashboard and get_my_work; the tile renders it; its Wrong? hides it server-side", async () => {
    const cookie = await cookieFor(ME);
    // Before any brief: the field is absent and the screen is the plain layout.
    const before = await dashboard(cookie);
    expect("brief" in before).toBe(false);
    expect(screen(before)).not.toContain("mw-bento-brief");

    // The real job writes the row (the model answers Now and one "why"; the server keeps its own order and titles).
    await markRow(ORG_A, "person", ME, iso(0));
    const note = (await first<{ id: number }>(env.DB, `SELECT id FROM feed WHERE org_id = ? AND author = ?`, ORG_A, ME))!.id;
    const s = stubProviders({ claude: () => JSON.stringify({ now: { text: NOW_TEXT, cites: [`feed:${note}`] }, recently: null, next: [{ ref: "ticket:3", why: WHY_TICKET }] }) });
    await runAiPass(keyedEnv(), newBudget(s.fetchImpl), { jobs: [briefJob], now: new Date(Date.now() + 31 * MIN) });
    expect(s.haiku).toBe(1);
    const row = (await latestBrief(ctx(), ME))!;
    expect(row).toMatchObject({ version: 1, model: "claude-haiku-5-5", prompt_version: "brief.2" });

    // The real read: the same brief on the cookie route and on MCP's getMyWork, generatedAt = the row's.
    const data = await dashboard(cookie);
    const brief = data.brief!;
    expect(brief).toMatchObject({ state: "ready", generatedAt: row.generated_at, model: "claude-haiku-5-5", now: { text: NOW_TEXT }, recently: null });
    expect(brief.next.items.map((i) => [i.ref, i.kind, i.title])).toEqual([
      ["ticket:3", "overdue", "Netlify connect flow"], // overdue first (the server's rule order) — its own kind…
      ["handoff:7", "handoff", "Finish the Render provider"], // …then someone waiting; the server's own fallback why
    ]);
    expect(brief.next.items[0].why).toBe(WHY_TICKET);
    expect((await getMyWork(ctx(), ME)).brief).toEqual(brief);

    // The real screen: the bento laid out by area, the brief tile first, its sentence, Next in order, the byline.
    const html = screen(data);
    expect(html).toContain('class="mw-bento mw-bento-brief');
    const start = html.lastIndexOf("<section", html.indexOf('data-mw="brief"'));
    const tile = html.slice(start, html.lastIndexOf("<section", html.indexOf('data-mw="review"')));
    const t = text(tile);
    expect(t).toContain("Your brief");
    expect(t).toContain(NOW_TEXT);
    expect(t.indexOf("Netlify connect flow")).toBeGreaterThan(-1);
    expect(t.indexOf("Finish the Render provider")).toBeGreaterThan(t.indexOf("Netlify connect flow"));
    expect(t).toContain(WHY_TICKET);
    expect(t).toContain("Overdue"); // past its sprint's date: the Overdue mark, never "Due soon" (BR-OWNER-1)
    expect(t).not.toContain("Due soon");
    expect(tile).not.toContain("mock-live-md"); // nothing rendered as markdown
    // The app's motion hooks on the real tile: the rows rise in order on the entrance; landing later, the tile
    // fades with the dashboard read's skeleton (test/render.brief-motion.test.ts pins the mechanics).
    expect(tile).toContain('data-settle-with="mw-tickets"');
    // The one shape (BR-OWNER-1): Recently is empty here, so it says "Nothing new." in its slot; Next has two
    // items and keeps its third row, empty; the byline keeps its step.
    expect([...tile.matchAll(/class="(?:mw-brief-(?:next|line) )?cnpy-rise" style="--i:(\d+)[;"]/g)].map((m) => Number(m[1]))).toEqual([1, 1, 2, 2, 3, 3, 4, 6]);
    expect(t).toContain("Recently Nothing new.");
    expect(tile).toContain('<li class="mw-brief-next mw-brief-pad" aria-hidden="true"></li>');
    expect(tile).not.toContain("mw-scroll");

    // "Wrong?": exactly what the button carries, sent as the web client sends it.
    const arg = /data-act="aiWrong" data-arg="([^"]+)"/.exec(tile)?.[1];
    const body = web.parseFeedbackArg(arg ? arg.replace(/&quot;/g, '"').replace(/&amp;/g, "&") : null);
    expect(body).toMatchObject({ itemType: "brief", itemRef: row.generated_at, kind: "brief", model: "claude-haiku-5-5" });
    const res = await worker.request(`/api/o/saplinglearn${AI_ROUTES.feedback}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, env);
    expect(res.status).toBe(200);

    // The next read leaves the field out (for this person), and the screen is the plain layout again.
    const after = await dashboard(cookie);
    expect("brief" in after).toBe(false);
    expect("brief" in (await getMyWork(ctx(), ME))).toBe(false);
    const plain = screen(after);
    expect(plain).not.toContain("mw-bento-brief");
    expect(plain).not.toContain('data-mw="brief"');
    expect(plain).toContain('data-mw="library"');
  });
});
