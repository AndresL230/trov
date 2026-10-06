import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { first } from "./helpers/db";
import { mirrorIssue } from "../src/tools/ticket-mirror";
import { create_ticket, set_ticket_sprint } from "../src/tools/tickets";
import { create_sprint, list_sprints } from "../src/tools/sprints";
import { getMyWork } from "../src/tools/mywork";
import { ingestEvent } from "../src/consumer";
import { eventsFromDelivery } from "../src/webhook";
import { ticket_badge } from "../src/tools/reads";
import { getKind } from "../src/notifications/registry";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import type { Window } from "@shared/notifications";

// Phase 4 (0032): no double counting. A mirrored ticket IS a GitHub issue that
// My Work's To-do, the badge's triage and the digest already account for — so
// those read native tickets only. Sprint progress counts BOTH.

const REPO = "SaplingLearn/sapling";
const WINDOW: Window = { cadence: "daily", start: new Date("2026-09-19T12:00:00Z"), end: new Date("2026-09-20T12:00:00Z"), id: "2026-09-20" };

function issueDelivery(action: string, number: number, o: { assignees?: string[]; state?: string; state_reason?: string; updated_at?: string } = {}) {
  return {
    action,
    ...(action === "assigned" && o.assignees?.[0] ? { assignee: { login: o.assignees[0] } } : {}),
    repository: { full_name: REPO },
    issue: {
      number, title: `Issue ${number}`, body: "b", html_url: `https://github.com/${REPO}/issues/${number}`,
      state: o.state ?? "open", state_reason: o.state_reason ?? null, updated_at: o.updated_at ?? "2026-09-20T10:00:00Z",
      user: { login: "meilin-gh" }, assignees: (o.assignees ?? []).map((login) => ({ login })), labels: [], milestone: null,
    },
  };
}

/** What the webhook does for an issues delivery: capture the event, then mirror. */
async function deliver(payload: ReturnType<typeof issueDelivery>): Promise<void> {
  for (const ev of eventsFromDelivery("issues", payload)) await ingestEvent(systemCtx(), platformCtx(), ev, "github-webhook");
  await mirrorIssue(systemCtx(), platformCtx(), REPO, payload);
}

const native = (title: string, assignees: string[] = []) =>
  create_ticket(systemCtx(), TicketCreate.parse({ title, assignees }), "meilin");

describe("My Work lists a mirrored ticket as a ticket", () => {
  it("the screen renders no issue list, so the mirrored ticket is in `tickets` (marked `source: github`) beside the native one", async () => {
    await deliver(issueDelivery("assigned", 214, { assignees: ["AndresL230"] }));
    await native("Native one", ["AndresL230"]);
    // The mirror did create an assigned, open ticket for the issue…
    expect(await first(env.DB, `SELECT status FROM tickets WHERE source = 'github'`)).toEqual({ status: "in_progress" });

    const mw = await getMyWork(systemCtx(), "AndresL230");
    // `todo` stays in the DTO for MCP's get_my_work; the SCREEN reads `tickets`.
    expect(mw.todo.map((t) => t.number)).toEqual([214]);
    expect(mw.tickets.map((t) => [t.title, t.source]).sort()).toEqual([["Issue 214", "github"], ["Native one", "canopy"]]);
    expect(mw.ticketsTotal).toBe(2);
  });
});

describe("the badge and the digest count native tickets only", () => {
  it("an unassigned mirrored ticket does not raise the badge; an unassigned native one does", async () => {
    await deliver(issueDelivery("opened", 1));
    await deliver(issueDelivery("opened", 2));
    expect(await ticket_badge(systemCtx())).toBe(0);
    await native("Needs a person");
    expect(await ticket_badge(systemCtx())).toBe(1);
  });

  it("the ticketq digest lists neither half of a mirrored ticket", async () => {
    await deliver(issueDelivery("opened", 1));                                   // unassigned mirrored
    await deliver(issueDelivery("assigned", 2, { assignees: ["AndresL230"] })); // mirrored, on AndresL230's plate
    const render = getKind("ticketq")!.render;
    expect(await render(systemCtx(), "AndresL230", WINDOW)).toBeNull();

    await native("Native unassigned");
    const section = await render(systemCtx(), "AndresL230", WINDOW);
    expect(section).not.toBeNull();
    expect(section!.text).toContain("Native unassigned");
    expect(section!.text).not.toContain("Issue 1");
    expect(section!.text).not.toContain("Issue 2");
  });
});

describe("sprint progress counts mirrored tickets", () => {
  it("a mirrored ticket in a sprint is in its total, and closing the issue on GitHub closes it in the progress", async () => {
    const sprintId = (await create_sprint(systemCtx(), SprintCreate.parse({ label: "Sprint A" }), "AndresL230")).id;
    await deliver(issueDelivery("opened", 7, { updated_at: "2026-09-20T10:00:00Z" }));
    const id = (await first<{ id: number }>(env.DB, `SELECT id FROM tickets WHERE source_ref = ?`, `${REPO}#7`))!.id;
    await set_ticket_sprint(systemCtx(), id, sprintId);
    await native("Native in sprint").then((nid) => set_ticket_sprint(systemCtx(), nid, sprintId));

    const progress = async () => (await list_sprints(systemCtx())).find((s) => s.id === sprintId)!.progress;
    expect(await progress()).toEqual({ closed: 0, total: 2, pct: 0 });

    await deliver(issueDelivery("closed", 7, { state: "closed", state_reason: "completed", updated_at: "2026-09-20T11:00:00Z" }));
    expect(await progress()).toEqual({ closed: 1, total: 2, pct: 50 });
    // …and the sprint itself is NOT completed by that — a person does that.
    expect((await list_sprints(systemCtx())).find((s) => s.id === sprintId)!.status).not.toBe("done");
  });
});
