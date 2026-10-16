// The owner's rulings on Ask Trov (2026-10-16, PR #178's open questions), server side — one describe per ruling id.
// docs/architecture/ask.md carries each rule; the ids are the owner list's (Q57 confirm-time rights, Q55 the
// waiting note, …).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { create_ticket } from "../src/tools/tickets";
import { first, run } from "./helpers/db";
import { FIXTURE_ADMIN, cookieFor } from "./helpers/persons";
import { ORG_A, tenantCtx } from "./helpers/tenant";
import { BASE, ask, call, eventsOf, fakeModel, withAsk, type StreamBlock } from "./helpers/ask";

const ME = "ask-rulings";
const final = "\n<trov-meta>{\"title\": \"Rulings\", \"followups\": []}</trov-meta>";
const answer = (text = "Done."): StreamBlock[] => [{ type: "text", text: `${text}${final}` }];
const setRole = (handle: string, role: "owner" | "admin" | "member") =>
  run(env.DB, `UPDATE memberships SET role = ? WHERE org_id = ? AND user_id = ?`, role, ORG_A, handle);
const unassign = (n: number, login: string) =>
  run(env.DB, `DELETE FROM ticket_assignees WHERE org_id = ? AND login = ? AND ticket_id = (SELECT id FROM tickets WHERE org_id = ? AND number = ?)`, ORG_A, login, ORG_A, n);
const titleOf = async (n: number) => (await first<{ title: string }>(env.DB, `SELECT title FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))?.title;
async function ticketFor(title: string, assignees: string[]): Promise<number> {
  return create_ticket(await tenantCtx("AndresL230"), { title, body: "b", category: "other", priority: "normal", assignees }, "AndresL230");
}
/** One card from one scripted tool call, made by `cookie`. */
async function cardFrom(cookie: string, tool: string, input: unknown) {
  const model = fakeModel([[{ type: "tool_use", name: tool, input }], answer()]);
  const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "do it" }));
  return { card: eventsOf(r.events, "action")[0], model, events: r.events };
}
const confirm = (cookie: string, id: number) => call("POST", `${BASE}/ask/actions/${id}/confirm`, cookie, {});

describe("Q57: Confirm re-checks the confirmer's rights NOW — a card never carries the proposer's", () => {
  it("admin-only (update_plan): a card made as an admin does not run once the person is a member", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    const { card } = await cardFrom(cookie, "update_plan", { narrative: "Now: Q57 plan.", sprints: [] });
    expect(card).toMatchObject({ tool: "update_plan", state: "proposed" });
    await setRole(FIXTURE_ADMIN, "member");
    try {
      const r = await confirm(cookie, card.id);
      expect(r.status).toBe(200);
      expect(r.json.results[0]).toMatchObject({ id: card.id, state: "failed", result: { code: "forbidden" } });
      const plan = await first<{ narrative: string }>(env.DB, `SELECT narrative FROM plan WHERE org_id = ?`, ORG_A);
      expect(plan?.narrative ?? "").not.toContain("Q57 plan");
    } finally {
      await setRole(FIXTURE_ADMIN, "admin");
    }
  });

  it("admin-only: a member's model naming update_plan (never offered to them) makes no card at all", async () => {
    const cookie = await cookieFor(ME);
    const { card, model } = await cardFrom(cookie, "update_plan", { narrative: "Now: member plan.", sprints: [] });
    expect(card).toBeUndefined();
    const result = (model.sent[1].messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0];
    expect(result.is_error).toBe(true);
    expect(JSON.parse(result.content).code).toBe("unknown_tool"); // not in the catalog this person is offered
  });

  it("the ticket lane (invariant 6): taken off the ticket after the card was made, Confirm is refused and nothing changes", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Lane at confirm", [ME]);
    const { card } = await cardFrom(cookie, "edit_ticket", { id: n, title: "Renamed after leaving" });
    expect(card).toMatchObject({ tool: "edit_ticket", state: "proposed" });
    await unassign(n, ME);
    const r = await confirm(cookie, card.id);
    expect(r.json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
    expect(await titleOf(n)).toBe("Lane at confirm");
  });

  it("a status move in the lane: refused once the person is off the ticket", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Move at confirm", [ME]);
    const { card } = await cardFrom(cookie, "transition_ticket", { id: n, to: "in_progress" });
    await unassign(n, ME);
    expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))?.status).not.toBe("in_progress");
  });

  it("the admin exception (set_ticket_sprint off the lane) is the role held at Confirm, not at the card", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    const n = await ticketFor("Sprint at confirm", []);
    await run(env.DB, `INSERT INTO sprints (id, org_id, title, target_date, status, created_at, created_by) VALUES (5701, ?, 'Q57 sprint', '2026-11-20', 'upcoming', '2026-10-01T00:00:00Z', 'AndresL230')`, ORG_A);
    const { card } = await cardFrom(cookie, "set_ticket_sprint", { id: n, sprint_id: 5701 });
    expect(card).toMatchObject({ tool: "set_ticket_sprint", state: "proposed" });
    await setRole(FIXTURE_ADMIN, "member");
    try {
      expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
      expect((await first<{ s: number | null }>(env.DB, `SELECT sprint_id AS s FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n))?.s).toBeNull();
    } finally {
      await setRole(FIXTURE_ADMIN, "admin");
    }
  });

  it("the assignment rule: an assignee who left the ticket can no longer (re)assign it", async () => {
    const cookie = await cookieFor(ME);
    await cookieFor("q57-other");
    const n = await ticketFor("Assign at confirm", [ME]);
    const { card } = await cardFrom(cookie, "assign_ticket", { id: n, login: "q57-other", on: true });
    expect(card).toMatchObject({ tool: "assign_ticket", state: "proposed" });
    await unassign(n, ME);
    expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "failed", result: { code: "forbidden" } });
    const on = await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ticket_assignees WHERE org_id = ? AND login = 'q57-other'`, ORG_A);
    expect(on?.n).toBe(0);
  });

  it("a card whose rights still hold runs as before", async () => {
    const cookie = await cookieFor(ME);
    const n = await ticketFor("Still mine", [ME]);
    const { card } = await cardFrom(cookie, "edit_ticket", { id: n, title: "Still mine, renamed" });
    expect((await confirm(cookie, card.id)).json.results[0]).toMatchObject({ state: "confirmed" });
    expect(await titleOf(n)).toBe("Still mine, renamed");
  });
});

describe("Q55: a waiting card keeps its note across a reload", () => {
  it("the thread read gives a waiting card the note it streamed with; a proposed card none", async () => {
    const cookie = await cookieFor(FIXTURE_ADMIN);
    await run(env.DB, `UPDATE orgs SET ai_chat_auto = 1 WHERE id = ?`, ORG_A);
    const model = fakeModel([[
      { type: "tool_use", name: "update_plan", input: { narrative: "Now: waiting note.", sprints: [] } },
      ...Array.from({ length: 6 }, (_, i) => ({ type: "tool_use" as const, name: "create_ticket", input: { title: `Q55 cap ${i}` } })),
    ], answer()]);
    const r = await withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, { text: "all", auto: true }));
    const streamed = eventsOf(r.events, "action").map((a) => [a.id, a.note]);
    expect(streamed).toHaveLength(2); // update_plan (Confirm-only) and the 6th ticket (past the cap)
    const tid = eventsOf(r.events, "thread")[0].id;
    const read = await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    const stored = (read.json.messages as { actions: { id: number; note: string | null; state: string }[] }[]).flatMap((m) => m.actions);
    for (const [id, note] of streamed) expect(stored.find((a) => a.id === id)?.note).toBe(note);
    expect(stored.filter((a) => a.state === "auto").every((a) => a.note === null)).toBe(true);
  });
});
