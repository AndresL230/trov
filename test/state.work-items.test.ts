// The work items' state machines (fix/sm-work-items, #212): tickets, sprints and the plan, handoffs, prompts and agent
// links. Each transition is compare-and-set or one batch; a clock expiry is read, not only swept; and each count that
// several screens show has ONE definition. A race is staged with a D1 binding that runs a competing write right before
// the writer's batch (or its statement) — the window a check-then-act leaves open. Real D1 over the reset seed.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import { LINK_IDLE_MS } from "@shared/links";
import { create_ticket, move_ticket, set_ticket_parent, transition_ticket } from "../src/tools/tickets";
import { mirrorIssue } from "../src/tools/ticket-mirror";
import { ticket_badge } from "../src/tools/reads";
import { sidebarBadges } from "../src/tools/badges";
import { complete_sprint, create_sprint, set_sprint_active } from "../src/tools/sprints";
import { SPRINT_SNAPSHOT_COLUMNS, write_plan } from "../src/tools/plan";
import { buildWeekInput } from "../src/ai/week";
import { claimHandoff, createHandoff, listHandoffs } from "../src/tools/handoffs";
import { getPrompt, publishPrompt, savePrompt } from "../src/tools/prompts";
import { acceptLink, joinLink, readInbox, requestLink, sendLink, sendLinkNote } from "../src/tools/links";
import { all, first, run } from "./helpers/db";
import { ORG_A, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { narr } from "./helpers/plan";

const ME = "AndresL230", J = "Jose-Gael-Cruz-Lopez";
const e = env as unknown as Env;

/** An Env whose D1 runs `hook` once, right before the FIRST batch (or, with `on: "run"`, the first statement whose SQL
 *  matches `match`) — another writer landing between a writer's read and its write. */
function racing(hook: () => Promise<unknown>, o: { on?: "batch" | "run"; match?: RegExp } = {}): Env {
  let fired = false;
  const fire = async () => { if (!fired) { fired = true; await hook(); } };
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === "batch" && (o.on ?? "batch") === "batch") {
        return async (stmts: D1PreparedStatement[]) => { await fire(); return target.batch(stmts); };
      }
      if (prop === "prepare" && o.on === "run") {
        return (sql: string) => {
          const s = target.prepare(sql);
          if (!o.match?.test(sql)) return s;
          return new Proxy(s, {
            get(st, k) {
              if (k === "bind") return (...args: unknown[]) => {
                const bound = st.bind(...args);
                return new Proxy(bound, { get(b, kk) { if (kk === "run") return async () => { await fire(); return b.run(); }; const v = Reflect.get(b, kk); return typeof v === "function" ? v.bind(b) : v; } });
              };
              const v = Reflect.get(st, k);
              return typeof v === "function" ? v.bind(st) : v;
            },
          });
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { ...e, DB };
}

const ticketInput = (o: Partial<TicketCreate> & { title: string }): TicketCreate => ({ body: "", category: "other", priority: "normal", assignees: [], ...o });
const ticketRow = (n: number) => first<{ id: number; status: string; parent_id: number | null; board_rank: number | null }>(env.DB, `SELECT id, status, parent_id, board_rank FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, n);
const events = async (n: number) => (await all<{ from_status: string | null; to_status: string; actor: string }>(env.DB,
  `SELECT e.from_status, e.to_status, e.actor FROM ticket_events e JOIN tickets t ON t.id = e.ticket_id WHERE t.org_id = ? AND t.number = ? ORDER BY e.id`, ORG_A, n));

// ── tickets ──────────────────────────────────────────────────────────────────

describe("create_ticket: ONE batch", () => {
  it("writes the ticket, its assignees, its opening history row and its link together, and answers the per-org number", async () => {
    await addOrgRepo("SaplingLearn/sapling");
    const a = await create_ticket(systemCtx(), ticketInput({ title: "First", assignees: [J, "meilin"], link: "#214" }), ME);
    const b = await create_ticket(systemCtx(), ticketInput({ title: "Second" }), ME);
    expect(b).toBe(a + 1);
    const t = (await ticketRow(a))!;
    expect(await events(a)).toEqual([{ from_status: null, to_status: "submitted", actor: ME }]);
    expect((await all<{ login: string }>(env.DB, `SELECT login FROM ticket_assignees WHERE ticket_id = ? ORDER BY login`, t.id)).map((r) => r.login)).toEqual([J, "meilin"]);
    expect(await all(env.DB, `SELECT url FROM ticket_links WHERE ticket_id = ?`, t.id)).toEqual([{ url: "https://github.com/SaplingLearn/sapling/issues/214" }]);
    // The second ticket took none of the first one's children.
    const t2 = (await ticketRow(b))!;
    expect(await all(env.DB, `SELECT * FROM ticket_assignees WHERE ticket_id = ?`, t2.id)).toEqual([]);
    expect(await events(b)).toHaveLength(1);
  });

  it("a batch that fails leaves nothing behind — no ticket without its opening row", async () => {
    const before = (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM tickets`))!.n;
    const broken = { ...e, DB: new Proxy(env.DB, { get(t, p) { if (p === "batch") return async () => { throw new Error("D1 is down"); }; const v = Reflect.get(t, p); return typeof v === "function" ? v.bind(t) : v; } }) };
    await expect(create_ticket(systemCtx(ORG_A, "system", broken), ticketInput({ title: "Never" }), ME)).rejects.toThrow("D1 is down");
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM tickets`))!.n).toBe(before);
  });
});

describe("the status writers are compare-and-set", () => {
  it("transition_ticket: a move that lost a race is a 409 naming the status, with no history row and nothing closed", async () => {
    const n = await create_ticket(systemCtx(), ticketInput({ title: "Raced" }), ME);
    const env2 = racing(() => run(env.DB, `UPDATE tickets SET status = 'in_progress' WHERE org_id = ? AND number = ?`, ORG_A, n));
    await expect(transition_ticket(systemCtx(ORG_A, "system", env2), n, "done", ME))
      .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("it is in_progress now") });
    expect((await ticketRow(n))!.status).toBe("in_progress");
    expect(await events(n)).toEqual([{ from_status: null, to_status: "submitted", actor: ME }]); // never "submitted → done"
  });

  it("transition_ticket: the move and its history row land together", async () => {
    const n = await create_ticket(systemCtx(), ticketInput({ title: "Moves" }), ME);
    await transition_ticket(systemCtx(), n, "in_progress", ME);
    await transition_ticket(systemCtx(), n, "done", ME);
    expect((await ticketRow(n))!.status).toBe("done");
    expect((await events(n)).map((x) => [x.from_status, x.to_status])).toEqual([[null, "submitted"], ["submitted", "in_progress"], ["in_progress", "done"]]);
  });

  it("move_ticket: a drop that lost a race writes nothing — status, position, history and the column's renumbering", async () => {
    const a = await create_ticket(systemCtx(), ticketInput({ title: "A" }), ME);
    const b = await create_ticket(systemCtx(), ticketInput({ title: "B" }), ME);
    const c = await create_ticket(systemCtx(), ticketInput({ title: "C" }), ME);
    await transition_ticket(systemCtx(), b, "in_progress", ME);
    await transition_ticket(systemCtx(), c, "in_progress", ME);
    const env2 = racing(() => run(env.DB, `UPDATE tickets SET status = 'declined' WHERE org_id = ? AND number = ?`, ORG_A, a));
    await expect(move_ticket(systemCtx(ORG_A, "system", env2), a, "in_progress", b, ME)).rejects.toMatchObject({ code: "conflict" });
    expect((await ticketRow(a))!).toMatchObject({ status: "declined", board_rank: null });
    expect((await events(a))).toHaveLength(1);
    // The column it would have joined keeps its NULL positions (its renumbering runs only after the move took).
    expect([(await ticketRow(b))!.board_rank, (await ticketRow(c))!.board_rank]).toEqual([null, null]);
    // Without the race the same drop lands, renumbered.
    await run(env.DB, `UPDATE tickets SET status = 'submitted' WHERE org_id = ? AND number = ?`, ORG_A, a);
    await move_ticket(systemCtx(), a, "in_progress", b, ME);
    expect((await ticketRow(a))!.status).toBe("in_progress");
    expect((await ticketRow(b))!.board_rank).not.toBeNull();
    expect((await events(a)).at(-1)).toMatchObject({ from_status: "submitted", to_status: "in_progress" });
  });

  it("the mirror's forced status re-reads after a person's move lands first, and records the status the ticket really left", async () => {
    const REPO = "SaplingLearn/sapling";
    await addOrgRepo(REPO);
    const issue = (action: string, state: string, updated: string) => ({
      action, repository: { full_name: REPO },
      issue: { number: 501, title: "Mirrored", body: "b", html_url: `https://github.com/${REPO}/issues/501`, state, state_reason: state === "closed" ? "completed" : null,
        updated_at: updated, user: { login: ME }, assignees: [], labels: [] },
    });
    expect(await mirrorIssue(systemCtx(), platformCtx(), REPO, issue("opened", "open", "2026-10-01T00:00:00Z"))).toBe("created");
    const id = (await first<{ number: number }>(env.DB, `SELECT number FROM tickets WHERE source_ref = ?`, `${REPO}#501`))!.number;
    const env2 = racing(() => run(env.DB, `UPDATE tickets SET status = 'in_progress' WHERE org_id = ? AND number = ?`, ORG_A, id));
    expect(await mirrorIssue(systemCtx(ORG_A, "system", env2), platformCtx(), REPO, issue("closed", "closed", "2026-10-02T00:00:00Z"))).toBe("updated");
    expect((await ticketRow(id))!.status).toBe("done");
    expect((await events(id)).at(-1)).toEqual({ from_status: "in_progress", to_status: "done", actor: "github-webhook" });
  });
});

describe("set_ticket_parent", () => {
  it("refuses a CLOSED parent, writing nothing", async () => {
    const p = await create_ticket(systemCtx(), ticketInput({ title: "Parent" }), ME);
    const c = await create_ticket(systemCtx(), ticketInput({ title: "Child" }), ME);
    await transition_ticket(systemCtx(), p, "done", ME);
    await expect(set_ticket_parent(systemCtx(), p, c)).rejects.toMatchObject({ code: "conflict", message: "a closed ticket cannot take sub-tickets" });
    expect((await ticketRow(c))!.parent_id).toBeNull();
  });

  it("re-checks the rules in the write: a parent closed (or nested) since the checks is a 409 with nothing written", async () => {
    const p = await create_ticket(systemCtx(), ticketInput({ title: "Parent" }), ME);
    const c = await create_ticket(systemCtx(), ticketInput({ title: "Child" }), ME);
    const before = await first<{ updated_at: string }>(env.DB, `SELECT updated_at FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, p);
    const env2 = racing(() => run(env.DB, `UPDATE tickets SET status = 'declined' WHERE org_id = ? AND number = ?`, ORG_A, p));
    await expect(set_ticket_parent(systemCtx(ORG_A, "system", env2), p, c)).rejects.toMatchObject({ code: "conflict" });
    expect((await ticketRow(c))!.parent_id).toBeNull();
    expect(await first(env.DB, `SELECT updated_at FROM tickets WHERE org_id = ? AND number = ?`, ORG_A, p)).toEqual(before);
    // An open parent still takes it.
    const p2 = await create_ticket(systemCtx(), ticketInput({ title: "Parent 2" }), ME);
    await set_ticket_parent(systemCtx(), p2, c);
    expect((await ticketRow(c))!.parent_id).toBe((await ticketRow(p2))!.id);
  });
});

describe("ONE definition per count", () => {
  it("nobody picked up = a native ticket in Triage with no assignee: the badge, the sidebar batch and the digest agree", async () => {
    await create_ticket(systemCtx(), ticketInput({ title: "Waiting" }), ME);
    const picked = await create_ticket(systemCtx(), ticketInput({ title: "Moved, nobody on it" }), ME);
    await transition_ticket(systemCtx(), picked, "in_progress", ME); // out of Triage: picked up
    await create_ticket(systemCtx(), ticketInput({ title: "Assigned", assignees: [J] }), ME);
    expect(await ticket_badge(systemCtx())).toBe(1);
    expect((await sidebarBadges(systemCtx(), ME)).tickets).toBe(1);
  });
});

// ── sprints and the plan ─────────────────────────────────────────────────────

const sprintRow = (id: number) => first<{ status: string; completed_at: string | null; updated_at: string }>(env.DB, `SELECT status, completed_at, updated_at FROM sprints WHERE id = ?`, id);

describe("sprints: completed_at (0088)", () => {
  it("complete_sprint stamps it; re-opening clears it; clearing 'active' never un-finishes a done sprint", async () => {
    const s = await create_sprint(systemCtx(), SprintCreate.parse({ label: "S" }), ME);
    expect((await sprintRow(s.id))!.completed_at).toBeNull();
    await complete_sprint(systemCtx(), s.id);
    const done = (await sprintRow(s.id))!;
    expect(done.status).toBe("done");
    expect(done.completed_at).toBe(done.updated_at);
    await set_sprint_active(systemCtx(), s.id, false);
    expect((await sprintRow(s.id))!).toMatchObject({ status: "done", completed_at: done.completed_at });
    await set_sprint_active(systemCtx(), s.id, true);
    expect((await sprintRow(s.id))!).toMatchObject({ status: "in_progress", completed_at: null });
  });

  it("set_sprint_active(false) holds its no-op in the write: a completion that lands after its read is not undone", async () => {
    const s = await create_sprint(systemCtx(), SprintCreate.parse({ label: "S" }), ME);
    await set_sprint_active(systemCtx(), s.id, true);
    const env2 = racing(() => run(env.DB, `UPDATE sprints SET status = 'done', completed_at = '2026-10-01T00:00:00.000Z' WHERE id = ?`, s.id), { on: "run", match: /^UPDATE sprints SET status = \?/ });
    await set_sprint_active(systemCtx(ORG_A, "system", env2), s.id, false);
    expect((await sprintRow(s.id))!).toMatchObject({ status: "done", completed_at: "2026-10-01T00:00:00.000Z" });
  });

  it("write_plan: stamps it when a sprint becomes done, KEEPS it while it stays done, clears it when it leaves", async () => {
    const s = await create_sprint(systemCtx(), SprintCreate.parse({ label: "S" }), ME);
    await write_plan(systemCtx(), { ...narr(), sprints: [{ id: s.id, label: "S", due: "", status: "done" }] }, ME);
    const first1 = (await sprintRow(s.id))!.completed_at;
    expect(first1).not.toBeNull();
    await run(env.DB, `UPDATE sprints SET completed_at = '2026-01-01T00:00:00.000Z' WHERE id = ?`, s.id);
    await write_plan(systemCtx(), { ...narr(), sprints: [{ id: s.id, label: "S renamed", due: "", status: "done" }] }, ME);
    expect((await sprintRow(s.id))!.completed_at).toBe("2026-01-01T00:00:00.000Z");
    await write_plan(systemCtx(), { ...narr(), sprints: [{ id: s.id, label: "S", due: "", status: "upcoming" }] }, ME);
    expect((await sprintRow(s.id))!.completed_at).toBeNull();
    const created = await write_plan(systemCtx(), { ...narr(), sprints: [{ label: "Born done", due: "", status: "done" }] }, ME);
    expect(created.sprints.find((x) => x.title === "Born done")!.completed_at).not.toBeNull();
  });

  it("the weekly highlights read completed_at: a sprint finished months ago does not come back when a plan write lists it", async () => {
    const old = await create_sprint(systemCtx(), SprintCreate.parse({ label: "Finished long ago" }), ME);
    await complete_sprint(systemCtx(), old.id);
    await run(env.DB, `UPDATE sprints SET completed_at = '2026-07-01T00:00:00.000Z' WHERE id = ?`, old.id);
    const fresh = await create_sprint(systemCtx(), SprintCreate.parse({ label: "Finished this week" }), ME);
    await complete_sprint(systemCtx(), fresh.id);
    // The plan write stamps updated_at on every sprint it lists — the old sprint included.
    await write_plan(systemCtx(), { ...narr(), sprints: [{ id: old.id, label: "Finished long ago", due: "", status: "done" }] }, ME);
    const end = new Date(Date.now() + 60_000);
    const week = await buildWeekInput(systemCtx(), "2026-W45", end, end);
    const sprints = week.items.filter((i) => i.kind === "sprint").map((i) => i.title);
    expect(sprints).toEqual(["Finished this week"]);
  });

  it("a status outside the vocabulary is refused before anything is written", async () => {
    const before = await all(env.DB, `SELECT * FROM plan_versions WHERE org_id = ?`, ORG_A);
    await expect(write_plan(systemCtx(), { ...narr(), sprints: [{ label: "X", due: "", status: "finished" as never }] }, ME))
      .rejects.toMatchObject({ code: "bad_request" });
    expect(await all(env.DB, `SELECT * FROM plan_versions WHERE org_id = ?`, ORG_A)).toEqual(before);
  });
});

describe("write_plan: ONE batch with a guarded version", () => {
  it("two writes racing on one version: the loser is a 409 and NOTHING of it lands — no sprint, no plan text, no version", async () => {
    const s = await create_sprint(systemCtx(), SprintCreate.parse({ label: "Keep me" }), ME);
    await write_plan(systemCtx(), { ...narr("base"), sprints: [] }, ME);
    const v = (await first<{ current_version: number }>(env.DB, `SELECT current_version FROM plan WHERE org_id = ?`, ORG_A))!.current_version;
    // Another plan write commits version v+1 between this call's read and its batch.
    const env2 = racing(async () => {
      await run(env.DB, `UPDATE plan SET current_version = ?, narrative = 'theirs' WHERE org_id = ?`, v + 1, ORG_A);
      await run(env.DB, `INSERT INTO plan_versions (org_id, version, narrative, sprints_json, created_at, created_by) VALUES (?, ?, 'theirs', '[]', '2026-10-01', 'x')`, ORG_A, v + 1);
    });
    await expect(write_plan(systemCtx(ORG_A, "system", env2), { ...narr("mine"), sprints: [{ id: s.id, label: "Renamed by the loser", due: "", status: "done" }, { label: "New from the loser", due: "", status: "upcoming" }] }, ME))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await first(env.DB, `SELECT title, status FROM sprints WHERE id = ?`, s.id)).toEqual({ title: "Keep me", status: "upcoming" });
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM sprints WHERE title = 'New from the loser'`)).toEqual({ n: 0 });
    expect(await first(env.DB, `SELECT narrative, current_version FROM plan WHERE org_id = ?`, ORG_A)).toEqual({ narrative: "theirs", current_version: v + 1 });
  });

  it("a guarded plan row that moved without a version row (drift) still fails the whole batch", async () => {
    await write_plan(systemCtx(), { ...narr("base"), sprints: [] }, ME);
    const env2 = racing(() => run(env.DB, `UPDATE plan SET current_version = current_version + 5 WHERE org_id = ?`, ORG_A));
    await expect(write_plan(systemCtx(ORG_A, "system", env2), { ...narr("mine"), sprints: [{ label: "Should not exist", due: "", status: "upcoming" }] }, ME))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM sprints WHERE title = 'Should not exist'`)).toEqual({ n: 0 });
  });

  it("the snapshot is taken in the batch: every sprints column, each row as SELECT * reads it", async () => {
    const cols = (await all<{ name: string }>(env.DB, `SELECT name FROM pragma_table_info('sprints')`)).map((c) => c.name).sort();
    expect([...SPRINT_SNAPSHOT_COLUMNS].sort()).toEqual(cols);
    const r = await write_plan(systemCtx(), { ...narr(), sprints: [{ label: "Snap", due: "2026-12-01", status: "upcoming", github_ref: [1, 2] }] }, ME);
    const snap = JSON.parse((await first<{ sprints_json: string }>(env.DB, `SELECT sprints_json FROM plan_versions WHERE org_id = ? AND version = ?`, ORG_A, r.version))!.sprints_json);
    expect(snap).toEqual(r.sprints);
    expect(snap.find((x: { title: string }) => x.title === "Snap")).toMatchObject({ github_ref: "[1,2]", target_date: "2026-12-01" });
  });
});

// ── handoffs ─────────────────────────────────────────────────────────────────

describe("handoffs: expiry is read, not only swept", () => {
  async function pendingPastDue(recipient = ME): Promise<number> {
    const { handoff } = await createHandoff(systemCtx(), J, { body: "Old one", recipient });
    await run(env.DB, `UPDATE handoffs SET expires_at = '2026-01-01T00:00:00.000Z' WHERE org_id = ? AND number = ?`, ORG_A, handoff.id);
    return handoff.id;
  }

  it("a pending handoff past expires_at cannot be claimed (409 'handoff is expired') and reads as expired", async () => {
    const id = await pendingPastDue();
    await expect(claimHandoff(systemCtx(), id, ME, "sess")).rejects.toMatchObject({ code: "conflict", message: "handoff is expired" });
    expect(await first(env.DB, `SELECT status FROM handoffs WHERE org_id = ? AND number = ?`, ORG_A, id)).toEqual({ status: "pending" }); // the cron flips the row
    expect((await listHandoffs(systemCtx(), ME, "me")).find((h) => h.id === id)?.status).toBe("expired");
    expect((await listHandoffs(systemCtx(), ME, "me", ["pending"])).map((h) => h.id)).not.toContain(id);
    expect((await listHandoffs(systemCtx(), ME, "me", ["expired"])).map((h) => h.id)).toContain(id);
  });

  it("the badge does not count it", async () => {
    const before = (await sidebarBadges(systemCtx(), ME)).handoffs;
    await pendingPastDue();
    expect((await sidebarBadges(systemCtx(), ME)).handoffs).toBe(before);
    await createHandoff(systemCtx(), J, { body: "Fresh", recipient: ME });
    expect((await sidebarBadges(systemCtx(), ME)).handoffs).toBe(before + 1);
  });

  it("create with a ledger key is one guarded batch: a racing twin that wrote the ledger first is answered, not repeated", async () => {
    const ledger = { sessionId: "sess-race", itemIndex: 0 };
    const first1 = await createHandoff(systemCtx(), ME, { body: "Twin one" }, ledger);
    // The read-side replay check is passed by a call that read before the first one's batch landed: simulate it by
    // clearing the ledger for the read and putting it back right before the batch.
    await run(env.DB, `DELETE FROM processed_items WHERE org_id = ? AND session_id = 'sess-race'`, ORG_A);
    const env2 = racing(() => run(env.DB, `INSERT INTO processed_items (org_id, session_id, item_index, item_type, outcome, ref, created_at) VALUES (?, 'sess-race', 0, 'handoff', 'written', ?, '2026-10-01')`, ORG_A, String(first1.handoff.id)));
    const twin = await createHandoff(systemCtx(ORG_A, "system", env2), ME, { body: "Twin two" }, ledger);
    expect(twin).toMatchObject({ replayed: true, handoff: { id: first1.handoff.id } });
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM handoffs WHERE org_id = ? AND body = 'Twin two'`, ORG_A)).toEqual({ n: 0 });
  });
});

// ── prompts ──────────────────────────────────────────────────────────────────

describe("prompts: an agent reads the SETTLED version", () => {
  const input = (body: string, status?: "draft" | "staged" | "published") => ({ slug: "settled-one", title: "Settled", body, ...(status ? { status } : {}) });

  it("an agent's staged v2 does not replace the published v1 for agents; the library shows the latest", async () => {
    await savePrompt(systemCtx(), ME, input("v1 body", "published"), "human");
    await savePrompt(systemCtx(), J, input("v2 staged by an agent"), "agent");
    expect(await getPrompt(systemCtx(), "settled-one", "settled")).toMatchObject({ version: 1, status: "published", body: "v1 body" });
    expect(await getPrompt(systemCtx(), "settled-one")).toMatchObject({ version: 2, status: "staged", body: "v2 staged by an agent" });
    await publishPrompt(systemCtx(), "settled-one", 2);
    expect(await getPrompt(systemCtx(), "settled-one", "settled")).toMatchObject({ version: 2, status: "published" });
  });

  it("with nothing published, the settled read is the latest, its status saying so", async () => {
    await savePrompt(systemCtx(), J, { slug: "only-staged", title: "Only staged", body: "s" }, "agent");
    expect(await getPrompt(systemCtx(), "only-staged", "settled")).toMatchObject({ version: 1, status: "staged" });
  });

  it("publish takes only the newest version that is not a draft", async () => {
    await savePrompt(systemCtx(), ME, input("v1", "staged"), "human");
    await savePrompt(systemCtx(), ME, input("v2", "staged"), "human");
    await expect(publishPrompt(systemCtx(), "settled-one", 1)).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("newer version") });
    await savePrompt(systemCtx(), ME, input("v3 draft", "draft"), "human");
    await publishPrompt(systemCtx(), "settled-one", 2); // a draft after it does not block it
    await expect(publishPrompt(systemCtx(), "settled-one", 3)).rejects.toMatchObject({ code: "conflict", message: "not staged" });
    expect(await getPrompt(systemCtx(), "settled-one", "settled")).toMatchObject({ version: 2, body: "v2" });
  });

  it("a save to a prompt deleted after the read is a 409 that writes no version", async () => {
    await savePrompt(systemCtx(), ME, input("v1", "published"), "human");
    const env2 = racing(() => run(env.DB, `UPDATE prompts SET deleted_at = '2026-10-01', deleted_by = ? WHERE org_id = ? AND slug = 'settled-one'`, ME, ORG_A));
    await expect(savePrompt(systemCtx(ORG_A, "system", env2), ME, input("v2"), "human")).rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("deleted prompt") });
    expect(await all(env.DB, `SELECT version FROM prompt_versions WHERE org_id = ? AND slug = 'settled-one'`, ORG_A)).toEqual([{ version: 1 }]);
  });
});

// ── agent links ──────────────────────────────────────────────────────────────

describe("agent links: open means not expired and not idle", () => {
  async function openLink(): Promise<number> {
    const ca = await tenantCtx(ME), cj = await tenantCtx(J);
    const { id } = await requestLink(ca, ME, { target: { person: J }, reason: "r", session: `s-${ME}` }, { via: "mcp", origin: "https://trov.dev" });
    await sendLink(ca, ME, id);
    await acceptLink(cj, J, id);
    await joinLink(cj, J, { id, session: `t-${J}` }, "mcp");
    return id;
  }

  it("a note on an open link past its expires_at (not swept yet) is 409 'link has expired' and writes nothing", async () => {
    const id = await openLink();
    await run(env.DB, `UPDATE agent_links SET expires_at = ? WHERE org_id = ? AND number = ?`, new Date(Date.now() - 1000).toISOString(), ORG_A, id);
    await expect(sendLinkNote(await tenantCtx(ME), platformCtx(), ME, { id, session: `s-${ME}`, body: "late" }, "mcp"))
      .rejects.toMatchObject({ code: "conflict", message: "link has expired" });
    expect(await first(env.DB, `SELECT COUNT(*) AS n FROM agent_link_notes WHERE org_id = ? AND link_number = ?`, ORG_A, id)).toEqual({ n: 0 });
  });

  it("the inbox hands nothing over on a link idle 12 h, and does not revive it", async () => {
    const id = await openLink();
    await sendLinkNote(await tenantCtx(ME), platformCtx(), ME, { id, session: `s-${ME}`, body: "waiting" }, "mcp");
    const idleAt = new Date(Date.now() - LINK_IDLE_MS - 60_000).toISOString();
    await run(env.DB, `UPDATE agent_links SET decided_at = ?, requester_seen_at = ?, recipient_seen_at = ? WHERE org_id = ? AND number = ?`, idleAt, idleAt, idleAt, ORG_A, id);
    expect(await readInbox(await tenantCtx(J), J, `t-${J}`)).toEqual({ notes: [], more: 0 });
    expect(await first(env.DB, `SELECT recipient_seen_at FROM agent_links WHERE org_id = ? AND number = ?`, ORG_A, id)).toEqual({ recipient_seen_at: idleAt });
    expect(await first(env.DB, `SELECT delivered_at FROM agent_link_notes WHERE org_id = ? AND link_number = ?`, ORG_A, id)).toEqual({ delivered_at: null });
  });
});
