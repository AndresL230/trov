// Undo on an Ask-created ticket DECLINES it (the owner approved), and a declined ticket stays OUT of the default views
// (the owner's ruling, docs/architecture/ask.md › Write cards): Ask's own `list_tickets` (default `seg: open`), its
// starters, the person's ref card's "working on", My Work and the queue's server default (`GET /tickets` with no
// seg). A view that asks for closed or all tickets still shows it — declining is not deleting.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { create_ticket } from "../src/tools/tickets";
import { getMyWork } from "../src/tools/mywork";
import { all, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, tenantCtx } from "./helpers/tenant";
import { BASE, ask, call, eventsOf, fakeModel, withAsk } from "./helpers/ask";

const ME = "ask-decliner";
const final = "\n<trov-meta>{\"title\": \"Declined\", \"followups\": []}</trov-meta>";

describe("a ticket Ask created and the person undid is declined, and out of every default view", () => {
  it("Ask's list_tickets, its starters, My Work and the queue's default leave it out; seg=closed still has it", async () => {
    await run(env.DB, `UPDATE orgs SET ai_chat_auto = 1 WHERE id = ?`, ORG_A);
    const cookie = await cookieFor(ME);
    const open = await create_ticket(await tenantCtx("AndresL230"), { title: "Still open", body: "", category: "bug", priority: "normal", assignees: [ME] }, "AndresL230");

    // Ask files one in Auto, then the person presses Undo.
    const made = fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Undo me out", assignees: [ME] } }], [{ type: "text", text: `Filed.${final}` }]]);
    const r = await withAsk({ fetchImpl: made.fetchImpl }, () => ask(cookie, { text: "file it", auto: true }));
    const result = eventsOf(r.events, "action_result")[0];
    expect(result.state).toBe("auto");
    expect((await call("POST", `${BASE}/ask/actions/${result.id}/undo`, cookie, {})).json.results[0].state).toBe("undone");
    const [declined] = await all<{ number: number; status: string }>(env.DB, `SELECT number, status FROM tickets WHERE org_id = ? AND title = 'Undo me out'`, ORG_A);
    expect(declined.status).toBe("declined");

    // Ask's own read, with the model's default arguments.
    const listed = fakeModel([[{ type: "tool_use", name: "list_tickets", input: {} }], [{ type: "text", text: `Listed.${final}` }]]);
    await withAsk({ fetchImpl: listed.fetchImpl }, () => ask(cookie, { text: "what's open?" }));
    const toolResult = JSON.stringify(listed.sent[1].messages.at(-1)!.content);
    expect(toolResult).toContain("Still open");
    expect(toolResult).not.toContain("Undo me out");

    // The composer's starters: the person's top assigned ticket is the open one, never the declined one.
    const state = await call("GET", `${BASE}/ask/state`, cookie);
    expect(state.json.starters).toContain(`Summarize ticket #${open}`);
    expect(state.json.starters.join(" ")).not.toContain(`#${declined.number}`);

    // My Work.
    const work = await getMyWork(await tenantCtx(ME), ME);
    expect(work.tickets.map((t) => t.id)).toContain(open);
    expect(work.tickets.map((t) => t.id)).not.toContain(declined.number);

    // The ref card for the person: what they are working on.
    const peek = await call("POST", `${BASE}/ask/peek`, cookie, { refs: [`person:${ME}`] });
    expect(JSON.stringify(peek.json.items[0])).not.toContain(`ticket:${declined.number}`);

    // The queue's server default is open; asking for closed still finds it.
    const queue = await call("GET", `${BASE}/tickets`, cookie);
    const numbers = (queue.json.tickets ?? queue.json).map((t: { id: number }) => t.id);
    expect(numbers).toContain(open);
    expect(numbers).not.toContain(declined.number);
    const closed = await call("GET", `${BASE}/tickets?seg=closed`, cookie);
    expect((closed.json.tickets ?? closed.json).map((t: { id: number }) => t.id)).toContain(declined.number);
  });
});
