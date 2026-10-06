// Sprint dates (0035, PART B): a real `start` beside `due`, and the ONE sprint-date rule.
//
//   • the validator (shared/sprints-core): unset or a real YYYY-MM-DD day; start <= due
//   • every write path refuses a bad pair and writes NOTHING — POST /sprints, the
//     create_sprint MCP tool, update_plan (and write_plan itself, against the STORED
//     start when an update omits it)
//   • reads never validate: a legacy non-ISO target_date still reads back
//   • the migration's conservative backfill of `start_date` from the `dates` label
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildTrovMcpServer } from "../src/mcp";
import type { Env } from "../src/env";
import { app } from "../src/routes";
import { all, first, run } from "./helpers/db";
import { write_plan } from "../src/tools/plan";
import { create_sprint, list_sprints } from "../src/tools/sprints";
import type { SprintRow } from "@shared/rows";
import {
  isIsoCalendarDate, sprintDateProblem, sprintDatesProblem, sprintDatesLabel, SprintCreate, type SprintView,
} from "@shared/sprints";
import { cookieFor, seedPerson } from "./helpers/persons";
import combined from "../migrations/0035_library_and_sprint_dates.sql?raw";
import { bearerCtx, systemCtx } from "./helpers/tenant";
/** PART B of the consolidated migration — the sprint-dates part: the text between the
 *  PART B and PART C marker lines (PART C, prompt soft delete, follows it). */
const migration = (combined.split("-- ═══ PART B")[1] ?? "").split("-- ═══ PART C")[0];

const ADMIN = "admin-user"; // bound as an org admin by callTool

const sprintCount = async () => (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM sprints`))!.n;
const planVersions = async () => (await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM plan_versions`))!.n;

async function callTool(handle: string, name: string, args: Record<string, unknown>) {
  const server = buildTrovMcpServer(env as unknown as Env, await bearerCtx(handle, handle === "admin-user" ? "admin" : undefined));
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: res.content[0].text, isError: res.isError };
  } finally {
    await client.close();
    await server.close();
  }
}

const postSprint = async (body: unknown) =>
  app.request("/sprints", {
    method: "POST",
    headers: { cookie: await cookieFor("andres"), "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env);

// ── the validator ─────────────────────────────────────────────────────────────

describe("the ONE sprint-date validator (shared/sprints-core)", () => {
  it("accepts a real YYYY-MM-DD day, and unset (null / undefined / blank)", () => {
    expect(isIsoCalendarDate("2026-10-17")).toBe(true);
    expect(isIsoCalendarDate("2028-02-29")).toBe(true); // leap day
    for (const v of [null, undefined, "", "   "]) expect(sprintDateProblem("due", v)).toBeNull();
    expect(sprintDatesProblem({ start: "2026-10-06", due: "2026-10-17" })).toBeNull();
    expect(sprintDatesProblem({ start: "2026-10-17", due: "2026-10-17" })).toBeNull(); // same day is fine
    expect(sprintDatesProblem({ start: "2026-10-06", due: null })).toBeNull();
    expect(sprintDatesProblem({ start: null, due: "2026-10-17" })).toBeNull();
  });

  it("refuses an impossible day (Feb 30, 2027-02-29, month 13)", () => {
    for (const v of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-04-31"]) {
      expect(isIsoCalendarDate(v)).toBe(false);
      expect(sprintDateProblem("due", v)).toMatch(/^due must be a real calendar date written YYYY-MM-DD/);
    }
  });

  it("refuses anything that is not exactly YYYY-MM-DD", () => {
    for (const v of ["Oct 17", "2026-10-17T00:00:00Z", "2026-1-7", "17/10/2026", "0026-10-17", "20261017"]) {
      expect(isIsoCalendarDate(v)).toBe(false);
      expect(sprintDateProblem("start", v)).toContain(JSON.stringify(v.trim()));
    }
  });

  it("refuses start after due, naming both", () => {
    expect(sprintDatesProblem({ start: "2026-10-20", due: "2026-10-17" }))
      .toBe("start (2026-10-20) is after due (2026-10-17); a sprint must start on or before its due date — nothing was written.");
  });

  it("the zod schema applies the same rule, field by field and across the pair", () => {
    expect(SprintCreate.safeParse({ label: "S", start: "2026-10-06", due: "2026-10-17" }).success).toBe(true);
    expect(SprintCreate.safeParse({ label: "S", due: " 2026-10-17 " }).data?.due).toBe("2026-10-17"); // trimmed
    const feb = SprintCreate.safeParse({ label: "S", due: "2026-02-30" });
    expect(feb.success).toBe(false);
    expect(feb.error?.issues[0].message).toMatch(/^due must be a real calendar date/);
    const order = SprintCreate.safeParse({ label: "S", start: "2026-10-20", due: "2026-10-17" });
    expect(order.success).toBe(false);
    expect(order.error?.issues[0].message).toMatch(/^start \(2026-10-20\) is after due/);
  });

  it("sprintDatesLabel: the real span when a start is set, else the authored label", () => {
    expect(sprintDatesLabel({ start: "2026-10-06", due: "2026-10-17", dates: "ignored" })).toBe("Oct 6 – 17");
    expect(sprintDatesLabel({ start: "2026-10-06", due: "2026-11-02" })).toBe("Oct 6 – Nov 2");
    expect(sprintDatesLabel({ start: "2026-12-20", due: "2027-01-10" })).toBe("Dec 20, 2026 – Jan 10, 2027");
    expect(sprintDatesLabel({ start: "2026-10-06", due: null })).toBe("From Oct 6");
    expect(sprintDatesLabel({ start: null, due: "2026-10-17", dates: "SEP 8 – 19" })).toBe("SEP 8 – 19");
    expect(sprintDatesLabel({ start: null, due: "2026-10-17", dates: null })).toBeNull();
  });
});

// ── POST /sprints ─────────────────────────────────────────────────────────────

describe("POST /sprints — start/due validated, nothing written on a refusal", () => {
  it("stores a valid start and due and reads them back as start / due", async () => {
    await seedPerson("andres");
    const res = await postSprint({ label: "Dated", start: "2026-10-06", due: "2026-10-17" });
    expect(res.status).toBe(200);
    const { sprint } = (await res.json()) as { sprint: SprintView };
    expect(sprint.start).toBe("2026-10-06");
    expect(sprint.due).toBe("2026-10-17");
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints WHERE id = ?`, sprint.id);
    expect(row?.start_date).toBe("2026-10-06");
    expect(row?.target_date).toBe("2026-10-17");
  });

  it("a blank start / due is unset (start null, due '' → null)", async () => {
    await seedPerson("andres");
    const res = await postSprint({ label: "Blank", start: "", due: "" });
    expect(res.status).toBe(200);
    const { sprint } = (await res.json()) as { sprint: SprintView };
    expect(sprint.start).toBeNull();
    expect(sprint.due).toBeNull();
  });

  it("400s a typed 'Oct 17', a Feb 30 and a start after due — with the rule's message — and writes nothing", async () => {
    await seedPerson("andres");
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ label: "S", due: "Oct 17" }, /^due must be a real calendar date written YYYY-MM-DD \(got "Oct 17"\)/],
      [{ label: "S", due: "2026-02-30" }, /^due must be a real calendar date/],
      [{ label: "S", start: "2026-02-30", due: "2026-03-10" }, /^start must be a real calendar date/],
      [{ label: "S", start: "2026-10-20", due: "2026-10-17" }, /^start \(2026-10-20\) is after due \(2026-10-17\)/],
    ];
    for (const [body, message] of cases) {
      const res = await postSprint(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(message);
    }
    expect(await sprintCount()).toBe(0);
  });

  it("the writer re-checks too (a caller that skipped the schema) — bad_request, nothing written", async () => {
    await expect(create_sprint(systemCtx(), { label: "S", urgency: "normal", start: "2026-10-20", due: "2026-10-17" }, "andres"))
      .rejects.toMatchObject({ code: "bad_request" });
    expect(await sprintCount()).toBe(0);
  });
});

// ── MCP create_sprint + update_plan ───────────────────────────────────────────

describe("MCP create_sprint — the same rule", () => {
  it("creates with start/due, and refuses bad dates writing nothing", async () => {
    await seedPerson("beatrix");
    const good = await callTool("beatrix", "create_sprint", { label: "Agent sprint", start: "2026-10-06", due: "2026-10-17" });
    expect(good.isError).toBeFalsy();
    expect(JSON.parse(good.text)).toMatchObject({ start: "2026-10-06", due: "2026-10-17" });

    for (const args of [
      { label: "Bad", due: "Oct 17" },
      { label: "Bad", due: "2026-02-30" },
      { label: "Bad", start: "2026-10-20", due: "2026-10-17" },
    ]) {
      const res = await callTool("beatrix", "create_sprint", args);
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/must be a real calendar date|is after due/);
    }
    expect(await sprintCount()).toBe(1);
  });
});

describe("update_plan / write_plan — the same rule, before the first write", () => {
  it("creates and updates start through the DTO vocabulary; omitted start is kept, null clears", async () => {
    const res = await callTool(ADMIN, "update_plan", {
      narrative: "n",
      sprints: [{ label: "Planned", start: "2026-10-06", due: "2026-10-17", status: "upcoming" }],
    });
    expect(res.isError).toBeFalsy();
    const [sp] = await list_sprints(systemCtx());
    expect(sp.start).toBe("2026-10-06");

    await write_plan(systemCtx(), { narrative: "n", sprints: [{ id: sp.id, label: "Planned", due: "2026-10-24", status: "upcoming" }] }, ADMIN);
    expect((await list_sprints(systemCtx()))[0]).toMatchObject({ start: "2026-10-06", due: "2026-10-24" });

    await write_plan(systemCtx(), { narrative: "n", sprints: [{ id: sp.id, label: "Planned", start: null, due: "2026-10-24", status: "upcoming" }] }, ADMIN);
    expect((await list_sprints(systemCtx()))[0].start).toBeNull();
  });

  it("refuses a bad due, a bad start or start > due over MCP — no plan row, no version, no sprint", async () => {
    for (const entry of [
      { label: "Bad", due: "Oct 17", status: "upcoming" },
      { label: "Bad", due: "2026-02-30", status: "upcoming" },
      { label: "Bad", start: "2026-10-20", due: "2026-10-17", status: "upcoming" },
    ]) {
      const res = await callTool(ADMIN, "update_plan", { narrative: "n", sprints: [entry] });
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/must be a real calendar date|is after due/);
    }
    expect(await sprintCount()).toBe(0);
    expect(await planVersions()).toBe(0);
  });

  it("write_plan checks a new due against the STORED start when start is omitted", async () => {
    await write_plan(systemCtx(), { narrative: "n", sprints: [{ label: "S", start: "2026-10-06", due: "2026-10-17", status: "upcoming" }] }, ADMIN);
    const [sp] = await list_sprints(systemCtx());
    await expect(write_plan(systemCtx(), { narrative: "moved", sprints: [{ id: sp.id, label: "S", due: "2026-10-01", status: "upcoming" }] }, ADMIN))
      .rejects.toMatchObject({ code: "bad_request", message: expect.stringMatching(/start \(2026-10-06\) is after due \(2026-10-01\)/) });
    expect(await planVersions()).toBe(1);
    expect((await list_sprints(systemCtx()))[0].due).toBe("2026-10-17");
  });
});

// ── reads never validate ──────────────────────────────────────────────────────

describe("a legacy non-ISO due stored before the rule", () => {
  it("still reads back as stored, through the list and the roadmap route", async () => {
    await seedPerson("andres");
    await run(env.DB, `INSERT INTO sprints (title, target_date, status, created_at, created_by) VALUES ('Legacy', 'Oct 17', 'upcoming', '2026-09-01T00:00:00Z', 'andres')`);
    const [sp] = await list_sprints(systemCtx());
    expect(sp).toMatchObject({ label: "Legacy", due: "Oct 17", start: null });
    const res = await app.request("/roadmap", { headers: { cookie: await cookieFor("andres") } }, env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { sprints: SprintView[] }).sprints[0].due).toBe("Oct 17");
  });
});

// ── the migration's backfill ──────────────────────────────────────────────────

/** The migration's backfill statements (everything after the ALTER), re-run against the current rows. */
async function runBackfill(): Promise<void> {
  const body = migration.replace(/^--.*$/gm, "");
  const statements = body.split(/;\s*$/m).map((s) => s.trim()).filter((s) => /^(UPDATE|WITH)\b/.test(s));
  expect(statements.length).toBe(2);
  for (const st of statements) await env.DB.prepare(st).run();
}

describe("0035 PART B backfill — start_date from the dates label, conservatively", () => {
  it("fills a leading ISO date or '<month> <day>' (no year); leaves everything ambiguous NULL", async () => {
    const rows: [string | null, string, string | null][] = [
      ["Mar 1 – Apr 30", "2026-04-30", "2026-03-01"],
      ["SEP 8 – 19", "2026-09-19", "2026-09-08"],
      ["Sept. 20 – Oct 20", "2026-10-20", "2026-09-20"],
      ["September 8th – 19", "2026-09-19", "2026-09-08"],
      ["Dec 20 – Jan 10", "2027-01-10", "2026-12-20"],   // crosses New Year → the year before
      ["2026-05-01 → 2026-06-10", "2026-06-10", "2026-05-01"],
      ["Sep 8, 2025 – Oct 1", "2025-10-01", null],        // carries a year → not guessed
      ["Oct 20 – 30", "2026-10-01", null],                // disagrees with its own due
      ["Feb 30 – Mar 3", "2026-03-03", null],             // not a real day
      ["2026-02-30 → x", "2026-03-10", null],
      ["Weeks 3-4", "2026-10-01", null],                  // nothing to read
      ["Oct 1 – 17", "Oct 17", null],                     // non-ISO due → untouched
      [null, "2026-10-01", null],
      ["Jan 5 – Dec 30", "2025-12-30", "2025-01-05"],
    ];
    for (const [dates, due] of rows) {
      await run(env.DB, `INSERT INTO sprints (title, dates, target_date, status, created_at, created_by) VALUES (?, ?, ?, 'upcoming', '2026-09-01T00:00:00Z', 'andres')`, `S ${dates}`, dates, due);
    }
    await runBackfill();
    const got = await all<{ dates: string | null; target_date: string; start_date: string | null }>(env.DB, `SELECT dates, target_date, start_date FROM sprints ORDER BY id`);
    expect(got.map((r) => [r.dates, r.target_date, r.start_date])).toEqual(rows);
  });

  it("never overwrites a start that is already set, and never touches target_date", async () => {
    await run(env.DB, `INSERT INTO sprints (title, dates, start_date, target_date, status, created_at, created_by) VALUES ('Set', 'Sep 8 – 19', '2026-09-10', '2026-09-19', 'upcoming', '2026-09-01T00:00:00Z', 'andres')`);
    await runBackfill();
    const row = await first<SprintRow>(env.DB, `SELECT * FROM sprints`);
    expect(row).toMatchObject({ start_date: "2026-09-10", target_date: "2026-09-19", dates: "Sep 8 – 19" });
  });
});
