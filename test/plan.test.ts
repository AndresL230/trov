import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { write_plan, get_plan } from "../src/tools/plan";
import { all, first, run } from "./helpers/db";
import type { SprintRow, PlanVersionRow, PlanRow } from "@shared/rows";
import { PLAN_NARRATIVE_MAX, composePlanNarrative } from "@shared/sprints";
import { SprintError } from "../src/tools/sprints";
import { upsertProgress } from "../src/tools/progress";

import { systemCtx } from "./helpers/tenant";
import { narr, narrText } from "./helpers/plan";
const AUTHOR = "admin";

describe("write_plan", () => {
  it("first write creates version 1 with a snapshot; second write creates version 2; both snapshots remain (non-destructive)", async () => {
    const r1 = await write_plan(
      systemCtx(),
      { ...narr("v1 narrative"), sprints: [{ label: "M1", due: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    expect(r1.version).toBe(1);
    expect(r1.sprints).toHaveLength(1);

    const v1 = await first<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions WHERE version = 1`);
    expect(v1).not.toBeNull();
    const snapshot1 = JSON.parse(v1!.sprints_json) as SprintRow[];
    expect(snapshot1).toHaveLength(1);
    expect(snapshot1[0].title).toBe("M1");
    expect(v1!.created_by).toBe(AUTHOR);

    const r2 = await write_plan(
      systemCtx(),
      { ...narr("v2 narrative"), sprints: [{ label: "M2", due: "2026-09-01", status: "upcoming" }] },
      AUTHOR
    );
    expect(r2.version).toBe(2);
    expect(r2.sprints).toHaveLength(2); // M1 still exists, M2 added

    const versions = await all<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions ORDER BY version ASC`);
    expect(versions.map((v) => v.version)).toEqual([1, 2]); // BOTH snapshots remain
    const snapshot2 = JSON.parse(versions[1].sprints_json) as SprintRow[];
    expect(snapshot2.map((m) => m.title).sort()).toEqual(["M1", "M2"]);
  });

  it("writes every sprint column: the DTO's label/due map onto title/target_date, and the 0025 fields land", async () => {
    const r = await write_plan(
      systemCtx(),
      {
        ...narr("n"),
        sprints: [{
          label: "Ticket queue",
          summary: "One queue the whole org files into.",
          description: "**Tickets** are D1 rows, never GitHub issues.",
          phase: "Now",
          dates: "Sep 16 – Sep 30",
          due: "2026-09-30",
          status: "in_progress",
          urgency: "high",
          lead: "AndresL230",
          domain: "tickets",
          github_ref: [1, 2],
        }],
      },
      AUTHOR
    );
    const row = r.sprints[0];
    expect(row.title).toBe("Ticket queue");                 // label → title
    expect(row.target_date).toBe("2026-09-30");             // due → target_date
    expect(row.summary).toBe("One queue the whole org files into.");
    expect(row.description).toBe("**Tickets** are D1 rows, never GitHub issues.");
    expect(row.phase).toBe("Now");
    expect(row.dates).toBe("Sep 16 – Sep 30");
    expect(row.urgency).toBe("high");
    expect(row.lead).toBe("AndresL230");
    expect(row.domain).toBe("tickets");
    expect(JSON.parse(row.github_ref!)).toEqual([1, 2]);

    // …and the view exposes the same row in the product's vocabulary.
    const view = await get_plan(systemCtx());
    expect(view.sprints[0]).toMatchObject({
      label: "Ticket queue", due: "2026-09-30", active: true, urgency: "high", lead: "AndresL230", domain: "tickets",
    });
  });

  it("urgency defaults to 'normal' when the write omits it", async () => {
    const r = await write_plan(systemCtx(), { ...narr("n"), sprints: [{ label: "Plain", due: "2026-08-01", status: "upcoming" }] }, AUTHOR);
    expect(r.sprints[0].urgency).toBe("normal");
  });

  it("update-by-id leaves the panel-authored fields alone when the write omits them", async () => {
    // `POST /sprints` (the Roadmap's New sprint panel) now authors summary / dates /
    // urgency / lead / domain / phase / description too. A plan write that names a
    // sprint by id without repeating them must not wipe them — and `diffSprints`
    // does not look at those columns, so a wipe would be silent AND unreported.
    const created = await write_plan(
      systemCtx(),
      {
        ...narr("n"),
        sprints: [{
          label: "Ticket queue", summary: "goal line", description: "desc", phase: "Phase 2",
          dates: "Oct 1 – 10", due: "2026-10-01", status: "upcoming", urgency: "high",
          lead: "AndresL230", domain: "tickets", github_ref: 42,
        }],
      },
      AUTHOR
    );
    const id = created.sprints[0].id;

    // The likely call shape from the update-plan skill: carry the id, change the
    // few fields being discussed, say nothing about the rest.
    const after = await write_plan(
      systemCtx(),
      { ...narr("n2"), sprints: [{ id, label: "Ticket queue v2", due: "2026-10-15", status: "in_progress" }] },
      AUTHOR
    );
    const row = after.sprints.find((x) => x.id === id)!;
    expect(row.title).toBe("Ticket queue v2");      // required fields DO overwrite
    expect(row.target_date).toBe("2026-10-15");
    expect(row.status).toBe("in_progress");
    expect(row.summary).toBe("goal line");          // …everything omitted is untouched
    expect(row.description).toBe("desc");
    expect(row.phase).toBe("Phase 2");
    expect(row.dates).toBe("Oct 1 – 10");
    expect(row.urgency).toBe("high");
    expect(row.lead).toBe("AndresL230");
    expect(row.domain).toBe("tickets");
    expect(JSON.parse(row.github_ref!)).toBe(42);
  });

  it("an EXPLICIT null still clears a sprint field — omitted and null are different", async () => {
    const created = await write_plan(
      systemCtx(),
      {
        ...narr("n"),
        sprints: [{
          label: "Ticket queue", summary: "goal line", description: "desc", phase: "Phase 2",
          dates: "Oct 1 – 10", due: "2026-10-01", status: "upcoming", urgency: "high",
          lead: "AndresL230", domain: "tickets", github_ref: 42,
        }],
      },
      AUTHOR
    );
    const id = created.sprints[0].id;

    const after = await write_plan(
      systemCtx(),
      {
        ...narr("n"),
        sprints: [{
          id, label: "Ticket queue", due: "2026-10-01", status: "upcoming",
          summary: null, lead: null, domain: null, github_ref: null,
        }],
      },
      AUTHOR
    );
    const row = after.sprints.find((x) => x.id === id)!;
    expect(row.summary).toBeNull();
    expect(row.lead).toBeNull();
    expect(row.domain).toBeNull();
    expect(row.github_ref).toBeNull();
    // …and the fields THIS call omitted are still there.
    expect(row.description).toBe("desc");
    expect(row.phase).toBe("Phase 2");
    expect(row.dates).toBe("Oct 1 – 10");
    expect(row.urgency).toBe("high");
  });

  it("update-by-id changes label/status; admin CAN set status:'done' through write_plan", async () => {
    const r1 = await write_plan(
      systemCtx(),
      { ...narr("n"), sprints: [{ label: "Original", due: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    const id = r1.sprints[0].id;

    const r2 = await write_plan(
      systemCtx(),
      { ...narr("n"), sprints: [{ id, label: "Updated", due: "2026-08-01", status: "done" }] },
      AUTHOR
    );

    const m = r2.sprints.find((x) => x.id === id)!;
    expect(m.title).toBe("Updated");
    expect(m.status).toBe("done"); // legal here — admin-authored
  });

  it("unknown id throws 'no such sprint'", async () => {
    await expect(
      write_plan(
        systemCtx(),
        { ...narr("n"), sprints: [{ id: 999, label: "X", due: "2026-08-01", status: "upcoming" }] },
        AUTHOR
      )
    ).rejects.toThrow("no such sprint: 999");
  });

  it("sprints not mentioned in the write are left untouched", async () => {
    const r1 = await write_plan(
      systemCtx(),
      {
        ...narr("n"),
        sprints: [
          { label: "Keep", due: "2026-08-01", status: "upcoming" },
          { label: "Change", due: "2026-08-02", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const keepId = r1.sprints.find((m) => m.title === "Keep")!.id;
    const changeId = r1.sprints.find((m) => m.title === "Change")!.id;

    const r2 = await write_plan(
      systemCtx(),
      { ...narr("n"), sprints: [{ id: changeId, label: "Changed", due: "2026-08-02", status: "in_progress" }] },
      AUTHOR
    );

    const keep = r2.sprints.find((m) => m.id === keepId)!;
    expect(keep.title).toBe("Keep");
    expect(keep.status).toBe("upcoming"); // untouched
    const changed = r2.sprints.find((m) => m.id === changeId)!;
    expect(changed.title).toBe("Changed");
    expect(changed.status).toBe("in_progress");
  });

  it("re-creates the plan singleton via INSERT OR IGNORE when the row is missing (prod resilience)", async () => {
    await run(env.DB, `DELETE FROM plan`);
    const r = await write_plan(systemCtx(), { ...narr("n"), sprints: [] }, AUTHOR);
    expect(r.version).toBe(1);
    const plan = await first(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan).not.toBeNull();
  });
});

describe("get_plan", () => {
  it("surfaces the progress cache as `issues`, NOT as progress; an uncached sprint reads 0/0 with issues null", async () => {
    const r1 = await write_plan(
      systemCtx(),
      {
        ...narr("the narrative"),
        sprints: [
          { label: "Cached", due: "2026-08-01", status: "upcoming" },
          { label: "Uncached", due: "2026-08-02", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const cachedId = r1.sprints.find((m) => m.title === "Cached")!.id;
    await upsertProgress(systemCtx(), cachedId, 3, 10, "event");

    const view = await get_plan(systemCtx());
    expect(view.narrative).toBe(narrText("the narrative"));
    expect(view.version).toBe(1);
    expect(view.updated_by).toBe(AUTHOR);
    expect(view.updated_at).not.toBeNull();

    const cached = view.sprints.find((m) => m.id === cachedId)!;
    // The plan write creates no tickets, so the BAR is 0/0 even though the cache
    // says 3/10 — the cached GitHub counts land on `issues` and nowhere else.
    expect(cached.progress).toEqual({ closed: 0, total: 0, pct: 0 });
    expect(cached.issues).toEqual({ closed: 3, total: 10 });
    // The issues shape drops `source` / `computed_at` (kept exactly to the DTO).
    expect((cached.issues as unknown as Record<string, unknown>).source).toBeUndefined();
    expect((cached.issues as unknown as Record<string, unknown>).computed_at).toBeUndefined();

    // A sprint with no cache row AND no tickets reads 0/0 with issues null (the
    // "neither" case — see test/sprints.routes.test.ts for the other three).
    const uncached = view.sprints.find((m) => m.label === "Uncached")!;
    expect(uncached.progress).toEqual({ closed: 0, total: 0, pct: 0 });
    expect(uncached.issues).toBeNull();
    // No tickets in the sprint → no members. (A sprint's members ARE its tickets'
    // assignees; the plan write never sets them.)
    expect(uncached.members).toEqual([]);
  });

  it("derives `active` from status: in_progress → true, upcoming/done → false", async () => {
    await write_plan(
      systemCtx(),
      {
        ...narr("n"),
        sprints: [
          { label: "Running", due: "2026-08-01", status: "in_progress" },
          { label: "Later", due: "2026-08-02", status: "upcoming" },
          { label: "Shipped", due: "2026-08-03", status: "done" },
        ],
      },
      AUTHOR
    );
    const view = await get_plan(systemCtx());
    const byLabel = new Map(view.sprints.map((s) => [s.label, s.active]));
    expect(byLabel.get("Running")).toBe(true);
    expect(byLabel.get("Later")).toBe(false);
    expect(byLabel.get("Shipped")).toBe(false);
  });

  it("returns a default empty view when the plan singleton row is missing", async () => {
    await run(env.DB, `DELETE FROM plan`);
    const view = await get_plan(systemCtx());
    expect(view).toMatchObject({ narrative: "", version: 0, updated_at: null, updated_by: null, sprints: [] });
  });
});

describe("write_plan — the narrative cap (PLAN_NARRATIVE_MAX)", () => {
  // Seed a version-1 plan with one sprint, so "nothing written" is observable on
  // every table the write touches.
  async function seed() {
    const r = await write_plan(
      systemCtx(),
      { ...narr("seeded"), sprints: [{ label: "Seeded", due: "2026-08-01", status: "upcoming" }] },
      AUTHOR
    );
    return r.sprints[0].id;
  }
  async function snapshot() {
    return {
      plan: await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`),
      versions: await all<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions ORDER BY version`),
      sprints: await all<SprintRow>(env.DB, `SELECT * FROM sprints ORDER BY id`),
    };
  }

  // The cap counts the COMPOSED text, labels included: "**Now:** " + now + "\n\n**Next:** " + next + "\n\n**Later:** " + later.
  const LABELS = composePlanNarrative({ now: "", next: "", later: "" }).length; // 34
  const atCap = (extra = 0) => narr("x".repeat(PLAN_NARRATIVE_MAX - LABELS - "Next.".length - "Later.".length + extra));

  it("a narrative of exactly the cap writes", async () => {
    await seed();
    const r = await write_plan(systemCtx(), { ...atCap(), sprints: [] }, AUTHOR);
    expect(r.version).toBe(2);
    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan?.narrative.length).toBe(PLAN_NARRATIVE_MAX);
    expect(plan?.narrative).toBe(composePlanNarrative(atCap()));
  });

  it("each part is trimmed and folded to one paragraph, and the composed form is what is stored", async () => {
    await write_plan(systemCtx(), { now: "\n  Hosting,\n  then   billing.  ", next: " Search. ", later: "Docs.", sprints: [] }, AUTHOR);
    const plan = await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`);
    expect(plan?.narrative).toBe("**Now:** Hosting, then billing.\n\n**Next:** Search.\n\n**Later:** Docs.");
    const v = await first<PlanVersionRow>(env.DB, `SELECT * FROM plan_versions WHERE version = 1`);
    expect(v?.narrative).toBe(plan?.narrative);
  });

  it("one over the cap is refused naming the cap and the length — plan, plan_versions and sprints unchanged", async () => {
    const id = await seed();
    const before = await snapshot();

    const err = await write_plan(
      systemCtx(),
      {
        ...atCap(1),
        // A sprint edit and a sprint create ride the refused call: neither may land.
        sprints: [
          { id, label: "Renamed", due: "2026-09-01", status: "done" },
          { label: "Brand new", due: "2026-09-02", status: "upcoming" },
        ],
      },
      AUTHOR
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SprintError);
    expect((err as SprintError).code).toBe("bad_request");
    expect((err as Error).message).toContain(`${PLAN_NARRATIVE_MAX + 1} characters`);
    expect((err as Error).message).toContain(`the cap is ${PLAN_NARRATIVE_MAX}`);

    expect(await snapshot()).toEqual(before);
  });

  it("an unknown sprint id is refused before anything is written, too", async () => {
    const id = await seed();
    const before = await snapshot();
    await expect(
      write_plan(
        systemCtx(),
        {
          ...narr("fits"),
          sprints: [
            { id, label: "Renamed", due: "2026-09-01", status: "done" },
            { id: 999, label: "X", due: "2026-08-01", status: "upcoming" },
          ],
        },
        AUTHOR
      )
    ).rejects.toThrow("no such sprint: 999");
    expect(await snapshot()).toEqual(before);
  });

  it("a narrative already stored over the cap still reads whole — the cap is a write rule only", async () => {
    const long = "y".repeat(PLAN_NARRATIVE_MAX * 4);
    await run(env.DB, `UPDATE plan SET narrative = ? WHERE org_id = 'org_saplinglearn'`, long);
    expect((await get_plan(systemCtx())).narrative).toBe(long);
  });
});

describe("write_plan — the narrative is Now / Next / Later, enforced at write (2026-10-18)", () => {
  const stored = async () => (await first<PlanRow>(env.DB, `SELECT * FROM plan WHERE org_id = 'org_saplinglearn'`))?.narrative;

  it("a legacy `narrative` that already reads Now / Next / Later is taken, and stored in the ONE form", async () => {
    await write_plan(systemCtx(), { narrative: "**Now:** hosting. **Next:** billing. **Later:** docs.", sprints: [] }, AUTHOR);
    expect(await stored()).toBe("**Now:** hosting.\n\n**Next:** billing.\n\n**Later:** docs.");
  });

  it.each([
    ["a free-text narrative", { narrative: "We ship hosting, then billing." }, "pass `now`, `next` and `later`"],
    ["no narrative at all", {}, "pass `now`, `next` and `later`"],
    ["an empty part", { now: "Hosting.", next: "  ", later: "Docs." }, "next is empty"],
    ["a missing part", { now: "Hosting.", next: "Billing." }, "later is empty"],
    ["a part carrying a label of its own", { now: "Hosting. **Next:** billing.", next: "Billing.", later: "Docs." }, "label of its own"],
    ["parts and a narrative together", { ...narr("x"), narrative: "**Now:** a **Next:** b **Later:** c" }, "not together"],
  ])("%s is refused as bad_request, and nothing is written", async (_what, input, says) => {
    const before = await stored();
    const err = await write_plan(systemCtx(), { ...input, sprints: [{ label: "Rides along", due: "", status: "upcoming" }] }, AUTHOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SprintError);
    expect((err as SprintError).code).toBe("bad_request");
    expect((err as Error).message).toContain(says);
    expect((err as Error).message).toContain("Nothing was written");
    expect(await stored()).toBe(before);
    expect(await all(env.DB, `SELECT id FROM sprints WHERE title = 'Rides along'`)).toEqual([]);
  });
});
