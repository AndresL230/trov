// Maintenance › Identity — Discard / Restore. A discard is SOFT (the row stays,
// `discarded` + audit columns) and STICKY (the login's PK keeps
// ensure_identity_task's INSERT OR IGNORE from re-raising it); the login's
// events are still captured. Restore puts it back in the list and lifts both.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./helpers/tenant";
import { app } from "../src/routes";
import { all, first } from "./helpers/db";
import { ingestEvent } from "../src/consumer";
import { cookieFor, seedPerson } from "./helpers/persons";
import type { IdentityTaskWithSample, DiscardedIdentity } from "../src/tools/reads";
import type { IdentityTaskRow, EventRow } from "@shared/rows";
import type { CapturedEvent } from "@shared/contract";

const post = (path: string, cookie?: string, body?: unknown) =>
  app.request(
    path,
    { method: "POST", headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) },
    env
  );
const list = async (cookie: string) =>
  (await (await app.request("/identity-tasks", { headers: { cookie } }, env)).json()) as { tasks: IdentityTaskWithSample[]; discarded: DiscardedIdentity[] };
const task = (login: string) => first<IdentityTaskRow>(env.DB, `SELECT * FROM identity_tasks WHERE login = ?`, login);

const prEvent = (n: number, login: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`,
  event_type: "pr_merged",
  ref_number: n,
  subject_login: login,
  raw: JSON.stringify({ pr: { number: n, title: `PR ${n}`, user: { login } } }),
  provenance: "webhook",
  occurred_at: `2026-07-0${n}T10:00:00Z`,
});

describe("POST /identity-tasks/:login/discard", () => {
  it("is soft: the row stays, marked discarded with the audit columns, and leaves the pending list", async () => {
    const cookie = await cookieFor("andres");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    expect((await list(cookie)).tasks.map((t) => t.login)).toEqual(["rando"]);

    const res = await post("/identity-tasks/rando/discard", cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, login: "rando", status: "discarded" });

    const row = await task("rando");
    expect(row?.status).toBe("discarded");
    expect(row?.resolved_by).toBe("andres");
    expect(row?.resolved_at).toBeTruthy();
    const after = await list(cookie);
    expect(after.tasks).toEqual([]);
    expect(after.discarded).toEqual([{ login: "rando", resolved_at: row?.resolved_at, resolved_by: "andres" }]);
  });

  it("is sticky: a later event from the login raises NO new task, but the event is still captured", async () => {
    const cookie = await cookieFor("andres");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    await post("/identity-tasks/rando/discard", cookie);
    const discardedAt = (await task("rando"))?.resolved_at;

    await ingestEvent(systemCtx(), platformCtx(), prEvent(2, "rando"), "github-webhook");

    expect((await list(cookie)).tasks).toEqual([]);
    expect(await all(env.DB, `SELECT login FROM identity_tasks`)).toEqual([{ login: "rando" }]);
    expect((await task("rando"))?.status).toBe("discarded");
    expect((await task("rando"))?.resolved_at).toBe(discardedAt); // untouched by the re-raise attempt
    const events = await all<EventRow>(env.DB, `SELECT * FROM events WHERE subject_login = 'rando' ORDER BY ref_number`);
    expect(events.map((e) => e.semantic_key)).toEqual(["gh:pr:1:merged", "gh:pr:2:merged"]);
  });

  it("a second discard is an idempotent 200 that rewrites nothing", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("casey");
    const casey = await cookieFor("casey");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    await post("/identity-tasks/rando/discard", cookie);
    const before = await task("rando");
    const again = await post("/identity-tasks/rando/discard", casey);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, login: "rando", status: "discarded" });
    expect(await task("rando")).toEqual(before); // still andres's discard
  });

  it("404 for an unknown login; 409 for a mapped task (and it stays resolved)", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("casey");
    const unknown = await post("/identity-tasks/nobody-here/discard", cookie);
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "no such identity task: nobody-here" });

    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "mystery-dev"), "github-webhook");
    expect((await post("/identity-tasks/mystery-dev/map", cookie, { person: "casey" })).status).toBe(200);
    expect((await post("/identity-tasks/mystery-dev/discard", cookie)).status).toBe(409);
    expect((await task("mystery-dev"))?.status).toBe("resolved");
  });

  it("401 without a session cookie, and nothing is written", async () => {
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    expect((await post("/identity-tasks/rando/discard")).status).toBe(401);
    expect((await task("rando"))?.status).toBe("pending");
  });
});

describe("POST /identity-tasks/:login/restore", () => {
  it("puts the task back in the list with the audit columns cleared, and lifts the stickiness", async () => {
    const cookie = await cookieFor("andres");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    await post("/identity-tasks/rando/discard", cookie);

    const res = await post("/identity-tasks/rando/restore", cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, login: "rando", status: "pending" });
    const row = await task("rando");
    expect(row).toMatchObject({ status: "pending", resolved_at: null, resolved_by: null });
    const after = await list(cookie);
    expect(after.tasks.map((t) => t.login)).toEqual(["rando"]);
    expect(after.discarded).toEqual([]);

    // Back to normal: a later event leaves it listed, and it can be discarded again.
    await ingestEvent(systemCtx(), platformCtx(), prEvent(2, "rando"), "github-webhook");
    expect((await list(cookie)).tasks.map((t) => t.login)).toEqual(["rando"]);
    expect((await post("/identity-tasks/rando/discard", cookie)).status).toBe(200);
  });

  it("a restored login can be mapped like any other", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("casey");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    await post("/identity-tasks/rando/discard", cookie);
    await post("/identity-tasks/rando/restore", cookie);
    expect((await post("/identity-tasks/rando/map", cookie, { person: "casey" })).status).toBe(200);
    expect((await task("rando"))?.status).toBe("resolved");
  });

  it("a restore of a pending task is an idempotent 200; unknown 404; mapped 409", async () => {
    const cookie = await cookieFor("andres");
    await seedPerson("casey");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    expect((await post("/identity-tasks/rando/restore", cookie)).status).toBe(200);
    expect((await task("rando"))?.status).toBe("pending");
    expect((await post("/identity-tasks/nobody-here/restore", cookie)).status).toBe(404);
    await post("/identity-tasks/rando/map", cookie, { person: "casey" });
    expect((await post("/identity-tasks/rando/restore", cookie)).status).toBe(409);
  });

  it("a discarded login that has since been linked (a GitHub sign-in) leaves the discarded list and cannot be restored", async () => {
    const cookie = await cookieFor("andres");
    await ingestEvent(systemCtx(), platformCtx(), prEvent(1, "rando"), "github-webhook");
    await post("/identity-tasks/rando/discard", cookie);
    // They join after all: sign-in links the github identity (seedPerson writes that row).
    await seedPerson("rando");
    expect((await list(cookie)).discarded).toEqual([]);
    const res = await post("/identity-tasks/rando/restore", cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "login already linked to rando" });
    expect((await task("rando"))?.status).toBe("discarded");
    // Their events still resolve to them at read time — the discard never touched capture.
    await ingestEvent(systemCtx(), platformCtx(), prEvent(2, "rando"), "github-webhook");
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM events WHERE subject_login = 'rando'`))?.n).toBe(2);
  });
});
