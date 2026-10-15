/**
 * The contract the inspector (web/src/ask-inspector.ts) reads from `GET /ask/item/:ref` (src/ai/ask/routes.ts):
 * for each type, the detail fields the view draws are there, in the shape it draws them. The inspector's web-side
 * fixtures (web/src/ask-inspector-fixtures.ts) are written to these same shapes.
 */
import { describe, it, expect } from "vitest";
import { create_ticket, add_ticket_comment } from "../src/tools/tickets";
import { create_sprint } from "../src/tools/sprints";
import { createPage } from "../src/tools/artifacts";
import { RefViewSchema } from "@shared/ai-ask";
import { cookieFor } from "./helpers/persons";
import { tenantCtx } from "./helpers/tenant";
import { BASE, call } from "./helpers/ask";

const ME = "AndresL230";
const item = async (ref: string) => call("GET", `${BASE}/ask/item/${encodeURIComponent(ref)}`, await cookieFor(ME));

describe("GET /ask/item — what the inspector reads", () => {
  it("ticket: the row, assignees, sub-tickets, comments, its sprint; linked PRs as RefViews", async () => {
    const ctx = await tenantCtx(ME);
    const sprint = await create_sprint(ctx, { label: "Hosting", urgency: "normal", start: "2026-10-05", due: "2026-10-30", lead: ME }, ME);
    const n = await create_ticket(ctx, { title: "Inspect me", body: "The body.", category: "bug", priority: "high", assignees: [ME], sprint_id: sprint.id }, ME);
    await add_ticket_comment(ctx, n, "A comment.", ME);
    const r = await item(`ticket:${n}`);
    expect(r.status).toBe(200);
    expect(RefViewSchema.parse(r.json.view)).toMatchObject({ ref: `ticket:${n}`, type: "ticket" });
    const t = r.json.detail.ticket;
    expect(t).toMatchObject({ id: n, title: "Inspect me", body: "The body.", category: "bug", priority: "high", status: "submitted", requester: ME, assignees: [ME], sprint: { id: sprint.id, label: "Hosting" } });
    expect(typeof t.created_at).toBe("string");
    expect(Array.isArray(t.children)).toBe(true);
    expect(t.comments).toEqual([expect.objectContaining({ author: ME, body: "A comment.", created_at: expect.any(String) })]);
    expect(Array.isArray(r.json.detail.prs)).toBe(true);
  });

  it("sprint: the sprint's view with dates, lead, progress and its tickets (number, title, status, assignees)", async () => {
    const ctx = await tenantCtx(ME);
    const sprint = await create_sprint(ctx, { label: "Contract sprint", urgency: "normal", summary: "The goal.", start: "2026-10-05", due: "2026-10-30", lead: ME }, ME);
    const n = await create_ticket(ctx, { title: "In it", body: "", category: "other", priority: "normal", assignees: [ME], sprint_id: sprint.id }, ME);
    const r = await item(`sprint:${sprint.id}`);
    expect(r.status).toBe(200);
    const s = r.json.detail.sprint;
    expect(s).toMatchObject({ label: "Contract sprint", summary: "The goal.", start: "2026-10-05", due: "2026-10-30", lead: ME, status: expect.any(String), progress: { closed: 0, total: 1 } });
    expect(s.tickets).toEqual([expect.objectContaining({ id: n, title: "In it", status: "submitted", assignees: [ME] })]);
  });

  it("artifact: kind, version, visibility and the raw route the sandboxed preview loads", async () => {
    const page = await createPage(await tenantCtx(ME), { title: "Contract page", kind: "html", area: "data", repo: "", visibility: "private", content: "<p>x</p>" }, ME);
    const r = await item(`artifact:${page.slug}`);
    expect(r.status).toBe(200);
    expect(r.json.detail).toMatchObject({ kind: "html", version: 1, visibility: "private" });
    expect(r.json.detail.raw_url).toMatch(/\/raw\/a\//);
    expect(r.json.view.owner?.toLowerCase()).toBe(ME.toLowerCase());     // Publish to org is the owner's
  });

  it("person: recent pull requests as refs", async () => {
    const r = await item(`person:${ME}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.detail.recentPrs)).toBe(true);
    expect(Array.isArray(r.json.view.extra.workingOn)).toBe(true);
  });

  it("an item that is not there is the same 404 as one that is not the person's (the inspector's hidden line)", async () => {
    expect((await item("ticket:999999")).status).toBe(404);
    expect((await item("upload:1")).status).toBe(404);         // an upload is never a server ref
  });
});
