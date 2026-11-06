// Ask Trov's turns and write cards as state machines (0092_ai_state_guards; docs/architecture/ask.md › The stream,
// › Write cards): one turn at a time per thread (a second is `409 busy`; a lease past its time is taken over), Stop
// scoped to its turn, Confirm refused while the org's AI switch is off, a write that RAN is never recorded `failed`
// (a failure to record it leaves the card `running`, settled later as "may have run"), an Undo that ran never goes
// back to its card's Undo, and cards a dead turn left behind get an answer to sit under.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { adoptOrphanCards, stopRequested, ASK_ACTION_RUNNING_MAX_MS, ASK_TURN_LEASE_MS } from "../src/data/ask";
import { all, first, run } from "./helpers/db";
import { cookieFor } from "./helpers/persons";
import { ORG_A, tenantCtx } from "./helpers/tenant";
import { BASE, ask, call, eventsOf, fakeModel, threadOf, withAsk, type StreamBlock } from "./helpers/ask";

const ME = "ask-stater";
const final = "\n<trov-meta>{\"title\": \"State\", \"followups\": []}</trov-meta>";
const answer = (text = "Done."): StreamBlock[] => [{ type: "text", text: `${text}${final}` }];
const tickets = (title: string) => all<{ number: number; status: string }>(env.DB, `SELECT number, status FROM tickets WHERE org_id = ? AND title = ?`, ORG_A, title);
const card = (id: number) => first<{ state: string; result_json: string | null; undo_json: string | null; message_id: number | null }>(env.DB,
  `SELECT state, result_json, undo_json, message_id FROM chat_actions WHERE id = ? AND org_id = ?`, id, ORG_A);
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const setAi = (on: boolean) => run(env.DB, `UPDATE orgs SET ai_automation = ? WHERE id = ?`, on ? 1 : 0, ORG_A);

/** Make every UPDATE that moves a card INTO `state` fail (a D1 failure while RECORDING an outcome), for `fn`. */
async function failingRecord<T>(state: string, fn: () => Promise<T>): Promise<T> {
  await env.DB.prepare(`CREATE TRIGGER IF NOT EXISTS t_fail_record BEFORE UPDATE OF state ON chat_actions
    WHEN NEW.state = '${state}' BEGIN SELECT RAISE(ABORT, 'record failed'); END`).run();
  try { return await fn(); } finally { await env.DB.prepare(`DROP TRIGGER IF EXISTS t_fail_record`).run(); }
}

describe("one turn at a time per thread", () => {
  it("a second ask while a turn holds the thread is 409 busy (nothing stored); a lease past its time is taken over", async () => {
    const cookie = await cookieFor(ME);
    const tid = await threadOf(cookie);
    const before = (await all(env.DB, `SELECT id FROM chat_messages WHERE thread_id = ? AND org_id = ?`, tid, ORG_A)).length;
    await run(env.DB, `UPDATE chat_threads SET turn_at = ? WHERE id = ? AND org_id = ?`, new Date().toISOString(), tid, ORG_A);
    const busy = await withAsk({ fetchImpl: fakeModel([answer()]).fetchImpl }, () => ask(cookie, { threadId: tid, text: "again" }));
    expect(busy.status).toBe(409);
    expect(busy.json).toMatchObject({ error: "busy" });
    expect(busy.json.message).toMatch(/still answering/);
    expect((await all(env.DB, `SELECT id FROM chat_messages WHERE thread_id = ? AND org_id = ?`, tid, ORG_A)).length).toBe(before);
    // A lease older than its time is a dead turn's: the next ask takes over, and releases it when it ends.
    await run(env.DB, `UPDATE chat_threads SET turn_at = ? WHERE id = ? AND org_id = ?`, ago(ASK_TURN_LEASE_MS + 60_000), tid, ORG_A);
    const ok = await withAsk({ fetchImpl: fakeModel([answer()]).fetchImpl }, () => ask(cookie, { threadId: tid, text: "again" }));
    expect(ok.status).toBe(200);
    expect(eventsOf(ok.events, "done")).toHaveLength(1);
    expect((await first<{ turn_at: string | null }>(env.DB, `SELECT turn_at FROM chat_threads WHERE id = ?`, tid))!.turn_at).toBeNull();
  });

  it("Stop is its turn's: a turn the thread has moved past reads itself stopped", async () => {
    const cookie = await cookieFor(ME);
    const tid = await threadOf(cookie);
    const ctx = await tenantCtx(ME);
    const turn = (await first<{ turn: number }>(env.DB, `SELECT turn FROM chat_threads WHERE id = ?`, tid))!.turn;
    expect(await stopRequested(ctx, tid, turn)).toBe(false);
    await run(env.DB, `UPDATE chat_threads SET turn = turn + 1 WHERE id = ?`, tid);
    expect(await stopRequested(ctx, tid, turn)).toBe(true);
    expect(await stopRequested(ctx, tid, turn + 1)).toBe(false);
  });
});

describe("Confirm and the org's AI switch (invariant 15)", () => {
  it("off: Confirm is refused (403 off) before anything is claimed — the card stays proposed, nothing is written", async () => {
    const cookie = await cookieFor(ME);
    const r = await withAsk({ fetchImpl: fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Off ticket" } }], answer()]).fetchImpl },
      () => ask(cookie, { text: "file it" }));
    const c = eventsOf(r.events, "action")[0];
    await setAi(false);
    try {
      const off = await call("POST", `${BASE}/ask/actions/${c.id}/confirm`, cookie, {});
      expect(off.status).toBe(403);
      expect(off.json.error).toBe("off");
      expect((await card(c.id))!.state).toBe("proposed");
      expect(await tickets("Off ticket")).toEqual([]);
    } finally {
      await setAi(true);
    }
    // Back on: the same card confirms.
    expect((await call("POST", `${BASE}/ask/actions/${c.id}/confirm`, cookie, {})).json.results[0].state).toBe("confirmed");
  });
});

describe("a write that ran is never recorded as failed", () => {
  it("Confirm: the write runs, recording it fails → the card stays running (not failed), and later settles as 'may have run'", async () => {
    const cookie = await cookieFor(ME);
    const r = await withAsk({ fetchImpl: fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Recorded late" } }], answer()]).fetchImpl },
      () => ask(cookie, { text: "file it" }));
    const c = eventsOf(r.events, "action")[0];
    const tid = eventsOf(r.events, "thread")[0].id as number;
    const ok = await failingRecord("confirmed", () => call("POST", `${BASE}/ask/actions/${c.id}/confirm`, cookie, {}));
    expect(ok.json.results[0].state).toBe("confirmed"); // what happened
    expect(await tickets("Recorded late")).toHaveLength(1);
    expect((await card(c.id))!.state).toBe("running"); // never `failed`
    // Past its time, the thread read settles it — saying it MAY have run.
    await run(env.DB, `UPDATE chat_actions SET decided_at = ? WHERE id = ?`, ago(ASK_ACTION_RUNNING_MAX_MS + 60_000), c.id);
    await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    const settled = (await card(c.id))!;
    expect(settled.state).toBe("failed");
    expect(JSON.parse(settled.result_json!)).toMatchObject({ code: "interrupted" });
    expect(JSON.parse(settled.result_json!).error).toMatch(/may have run/);
  });

  it("Undo: the undo runs, recording it fails → never back to `confirmed` with a live Undo at once; recovery restores it and its own check refuses a second undo", async () => {
    const cookie = await cookieFor(ME);
    const r = await withAsk({ fetchImpl: fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Undo late" } }], answer()]).fetchImpl },
      () => ask(cookie, { text: "file it" }));
    const c = eventsOf(r.events, "action")[0];
    const tid = eventsOf(r.events, "thread")[0].id as number;
    expect((await call("POST", `${BASE}/ask/actions/${c.id}/confirm`, cookie, {})).json.results[0].state).toBe("confirmed");
    const undo = await failingRecord("undone", () => call("POST", `${BASE}/ask/actions/${c.id}/undo`, cookie, {}));
    expect(undo.json.results[0].state).toBe("undone");
    expect((await tickets("Undo late"))[0].status).toBe("declined"); // the undo ran
    expect((await card(c.id))!.state).toBe("running");
    await run(env.DB, `UPDATE chat_actions SET decided_at = ? WHERE id = ?`, ago(ASK_ACTION_RUNNING_MAX_MS + 60_000), c.id);
    await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    expect((await card(c.id))!.state).toBe("confirmed");
    const again = await call("POST", `${BASE}/ask/actions/${c.id}/undo`, cookie, {});
    expect(again.status).toBe(409);
    expect(again.json.error).toBe("changed");
  });

  it("Auto: the write runs, recording it fails → running, never failed", async () => {
    const cookie = await cookieFor(ME);
    const r = await failingRecord("auto", () => withAsk({ fetchImpl: fakeModel([[{ type: "tool_use", name: "create_ticket", input: { title: "Auto late" } }], answer()]).fetchImpl },
      () => ask(cookie, { text: "file", auto: true })));
    const res = eventsOf(r.events, "action_result")[0];
    expect(res.state).toBe("auto");
    expect(await tickets("Auto late")).toHaveLength(1);
    expect((await card(res.id))!.state).toBe("running");
  });
});

describe("cards a dead turn left behind", () => {
  it("get an empty, stopped answer to sit under — on the thread read, once no live turn holds the thread", async () => {
    const cookie = await cookieFor(ME);
    const tid = await threadOf(cookie);
    const t = (await first<{ turn: number }>(env.DB, `SELECT turn FROM chat_threads WHERE id = ?`, tid))!;
    // A turn that died after an Auto write ran: its card has no answer.
    const ins = await run(env.DB, `INSERT INTO chat_actions (org_id, thread_id, turn, tool, kind, group_id, tool_use_id, args_json, preview_json, state, result_json, undo_json, created_at, asked_by)
      VALUES (?, ?, ?, 'create_ticket', 'ticket', 'g', 'u', '{}', '{"title":"New ticket","lines":[],"item":null}', 'auto', '{}', '{}', ?, ?)`, ORG_A, tid, t.turn, new Date().toISOString(), ME);
    const id = Number(ins.meta.last_row_id);
    // While a live turn holds the thread, its cards are left alone.
    await run(env.DB, `UPDATE chat_threads SET turn_at = ? WHERE id = ?`, new Date().toISOString(), tid);
    await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    expect((await card(id))!.message_id).toBeNull();
    await run(env.DB, `UPDATE chat_threads SET turn_at = NULL WHERE id = ?`, tid);
    const read = await call("GET", `${BASE}/ask/threads/${tid}`, cookie);
    const holder = (read.json.messages as { role: string; stopped: boolean; actions: { id: number; undo: boolean }[] }[]).find((m) => m.actions.some((a) => a.id === id));
    expect(holder).toMatchObject({ role: "assistant", stopped: true });
    expect(holder!.actions.find((a) => a.id === id)!.undo).toBe(true);
    // Once: a second adoption finds nothing.
    expect(await adoptOrphanCards(await tenantCtx(ME), tid, t.turn + 1, "smart")).toEqual([]);
  });
});
