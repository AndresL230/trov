import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { getMyWork } from "../src/tools/mywork";
import { get_plan } from "../src/tools/plan";
import { query, get_feed, list_proposals, list_needs_triage, list_adrs, list_identity_tasks, list_tickets, get_ticket, ticket_badge } from "../src/tools/reads";
import { get_sprint } from "../src/tools/sprints";
import { all, first } from "../src/db";
import docs from "../fixtures/dev/docs.json";
import feed from "../fixtures/dev/feed.json";
import adrs from "../fixtures/dev/adrs.json";
import triage from "../fixtures/dev/triage.json";
import roadmap from "../fixtures/dev/roadmap.json";
import events from "../fixtures/dev/events.json";
import identity from "../fixtures/dev/identity.json";
import tickets from "../fixtures/dev/tickets.json";

import { systemCtx } from "./helpers/tenant";
const fx = { docs, feed, adrs, triage, roadmap, events, identity, tickets };

beforeEach(async () => {
  for (const stmt of buildSeedStatements(fx)) {
    await env.DB.prepare(stmt).run();
  }
});

describe("dev seed lights up every surface", () => {
  it("My Work: previous activity + to-dos for AndresL230", async () => {
    const mw = await getMyWork(systemCtx(), "AndresL230");
    expect(mw.degraded).toBe(false);
    expect(mw.person).toBe("Andres");
    expect(mw.previousActivity.length).toBeGreaterThan(0);
    expect(mw.todo.length).toBeGreaterThan(0);
    // Priority tags parsed + stripped from assigned issues.
    expect(mw.todo.some((t) => t.priority === "P0")).toBe(true);
    expect(mw.todo.some((t) => t.priority === "P1")).toBe(true);
    // Structured summaries (0018) reach the DTO, not just the prose mirror.
    expect(mw.previousActivity.some((p) => p.what !== null && p.displayTitle !== null)).toBe(true);
    expect(mw.previousActivity.some((p) => p.baseRef === "main")).toBe(true);
    expect(mw.todo.some((t) => t.displayTitle !== null && t.nextStep !== null)).toBe(true);
    // Widened issue raw (0018): the GitHub group's title/due_on reaches the
    // card's Sprint row (no seeded sprint claims the group number).
    expect(mw.todo.some((t) => t.sprint !== null && t.sprint.title.length > 0)).toBe(true);
  });

  it("Roadmap: narrative + sprints carrying progress, the 0025 fields, and resources", async () => {
    const plan = await get_plan(systemCtx());
    expect(plan.narrative.length).toBeGreaterThan(0);
    expect(plan.sprints.length).toBe(7);
    expect(plan.sprints.some((sp) => sp.progress.total > 0)).toBe(true);
    // Sprints span multiple roadmap phases…
    expect(new Set(plan.sprints.map((sp) => sp.phase)).size).toBeGreaterThan(1);
    // …and the seed exercises every 0025 field, so the Roadmap card has something
    // to render for each of them.
    expect(plan.sprints.every((sp) => sp.summary !== null && sp.dates !== null)).toBe(true);
    expect(new Set(plan.sprints.map((sp) => sp.urgency))).toEqual(new Set(["low", "normal", "high"]));
    expect(plan.sprints.every((sp) => sp.lead !== null && sp.domain !== null)).toBe(true);
    expect(plan.sprints.some((sp) => sp.active)).toBe(true);

    const resources = await all<{ sprint_id: number; kind: string }>(env.DB, `SELECT * FROM sprint_resources`);
    expect(new Set(resources.map((r) => r.sprint_id)).size).toBe(2);
    expect(new Set(resources.map((r) => r.kind))).toEqual(new Set(["github", "figma", "plain"]));

    // Progress is TICKETS ONLY: sprint 3 holds four seeded tickets (one of them
    // done), so the roadmap bar reads 1/4. Its 2/3 cached GitHub issues travel
    // separately on `issues` and never enter the bar (the old combined number
    // was 3/7). The seed proves the split, not just the math.
    const cache = await first<{ closed: number; total: number }>(env.DB, `SELECT closed, total FROM sprint_progress WHERE sprint_id = 3`);
    const three = plan.sprints.find((sp) => sp.id === 3)!;
    expect(cache).toEqual({ closed: 2, total: 3 });
    expect(three.progress).toEqual({ closed: 1, total: 4, pct: 25 });
    expect(three.issues).toEqual({ closed: 2, total: 3 });
    expect(three.members.length).toBeGreaterThan(0);
  });

  it("Roadmap: a sprint's resources merge its own links with its tickets', deduped by url", async () => {
    const detail = (await get_sprint(systemCtx(), 3))!;
    const urls = detail.resources.map((r) => r.url);
    const shared = "https://github.com/SaplingLearn/sapling/issues/214";

    // The fixture deliberately attaches the SAME issue to sprint 3 and to ticket 3.
    expect(await all(env.DB, `SELECT * FROM sprint_resources WHERE sprint_id = 3 AND url = ?`, shared)).toHaveLength(1);
    expect(await all(env.DB, `SELECT * FROM ticket_links WHERE url = ?`, shared)).toHaveLength(1);
    // …and it appears exactly once on the sprint screen, as the SPRINT's copy (first).
    expect(urls.filter((u) => u === shared)).toHaveLength(1);
    expect(urls[0]).toBe("https://github.com/SaplingLearn/sapling/issues/160"); // sprint resources lead
    expect(urls.indexOf(shared)).toBeLessThan(urls.indexOf("https://www.figma.com/design/planner-duration"));
    expect(new Set(urls).size).toBe(urls.length);
    // Roots then children: ticket 2 is the sub-ticket of ticket 3, but it lives in
    // sprint 4 — so nothing in sprint 3 renders at depth 1.
    expect(detail.tickets.every((t) => t.depth === 0)).toBe(true);
    expect(detail.tickets.map((t) => t.id).sort()).toEqual([1, 3, 4, 7]);
  });

  it("People: the four engineers plus the two non-engineer requesters", async () => {
    // `github-webhook` (0032) is a system principal, not a person: the GitHub
    // mirror's fallback requester. It is never listed or assignable.
    const persons = await all<{ handle: string }>(env.DB, `SELECT handle FROM persons WHERE handle != 'github-webhook' ORDER BY handle`);
    expect(persons.map((p) => p.handle)).toEqual(
      ["AndresL230", "Darkest-Teddy", "Jose-Gael-Cruz-Lopez", "lpcooper-arch", "meilin", "sanaok"].sort()
    );
    // meilin / sanaok are Google-only: no github identity, so they can never
    // collide with an event subject_login.
    const ids = await all<{ provider: string; person: string }>(env.DB, `SELECT provider, person FROM identities`);
    expect(ids.filter((i) => i.person === "meilin").map((i) => i.provider)).toEqual(["google"]);
    expect(ids.filter((i) => i.person === "sanaok").map((i) => i.provider)).toEqual(["google"]);
  });

  it("Tickets: the queue lights up — badge, links, nesting, sprint labels, comments, history", async () => {
    // The sidebar badge is non-zero, so the nav renders it out of the box.
    const badge = await ticket_badge(env.DB);
    expect(badge).toBeGreaterThan(0);

    // `seg=open` = submitted + in_progress only; nothing closed leaks in.
    const open = await list_tickets(env.DB, { seg: "open" });
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((t) => t.status === "submitted" || t.status === "in_progress")).toBe(true);
    // …and the closed segment is populated too (the seed has a done and a declined).
    const closed = await list_tickets(env.DB, { seg: "closed" });
    expect(new Set(closed.map((t) => t.status))).toEqual(new Set(["done", "declined"]));

    // Every requester is one of the two non-engineer staff — the queue's whole point.
    const allTickets = await list_tickets(env.DB, { seg: "all" });
    expect(new Set(allTickets.map((t) => t.requester))).toEqual(new Set(["meilin", "sanaok"]));
    // …and the badge counts exactly the unassigned open ones.
    expect(badge).toBe(open.filter((t) => t.assignees.length === 0).length);

    // A ticket with two links, and it is a parent with a child.
    const linked = allTickets.find((t) => t.link_count === 2);
    expect(linked, "no seeded ticket carries two links").toBeDefined();
    expect(linked!.sub_count).toBe(1);
    expect(linked!.sprint_label, "a sprint-assigned ticket shows its sprint label").not.toBeNull();

    const detail = (await get_ticket(env.DB, linked!.id))!;
    expect(detail.children.length).toBe(1);
    expect(detail.parent).toBeNull();
    expect(new Set(detail.links.map((l) => l.kind))).toEqual(new Set(["github", "figma"]));
    expect(detail.comments.length).toBeGreaterThan(0);
    // The opening row is there, so the thread reads "opened this ticket".
    expect(detail.events[0].from_status).toBeNull();
    expect(detail.events[0].to_status).toBe("submitted");

    // The child points back at it, and lives in a different sprint.
    const child = (await get_ticket(env.DB, detail.children[0].id))!;
    expect(child.parent?.id).toBe(detail.id);
    expect(child.sprint?.id).not.toBe(detail.sprint?.id);

    // Assignees are engineers; assignee:'me' narrows to one person's tickets.
    const mine = await list_tickets(env.DB, { seg: "all", assignee: "me", me: "AndresL230" });
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((t) => t.assignees.includes("AndresL230"))).toBe(true);
  });

  it("Search: ranked hits for a known term", async () => {
    const r = await query(env.DB, { q: "MCP", include_staged: true });
    expect(r.primary.length).toBeGreaterThan(0);
  });

  it("Feed: tagged entries present", async () => {
    expect((await get_feed(env.DB, {})).length).toBeGreaterThan(0);
    expect((await get_feed(env.DB, { tags: ["auth"] })).length).toBeGreaterThan(0);
  });

  // Four queues, and four is now the total: the roadmap-proposal queue was
  // dropped along with its table in 0025, so these are all of them.
  it("Triage: all four queues populated", async () => {
    expect((await list_proposals(env.DB)).length).toBeGreaterThan(0);
    expect((await list_needs_triage(env.DB)).length).toBeGreaterThan(0);
    expect((await list_adrs(env.DB, "draft")).length).toBeGreaterThan(0);
    expect((await list_identity_tasks(env.DB)).length).toBeGreaterThan(0);
  });
});
