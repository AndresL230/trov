import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { query } from "../src/tools/reads";
import { write_plan } from "../src/tools/plan";
import { upsertProgress } from "../src/tools/progress";
import { create_ticket, transition_ticket } from "../src/tools/tickets";
import { TicketCreate } from "@shared/tickets";
import { all } from "../src/db";
import { RESET_STATEMENTS } from "../scripts/seed/reset.mjs";
import { seedPerson } from "./helpers/persons";

import { systemCtx } from "./helpers/tenant";
const AUTHOR = "tester";

// The EXACT statement test/apply-migrations.ts runs beforeEach (roadmap-relevant:
// it UPDATE-resets the plan singleton and DELETEs sprints) — imported, not
// hand-duplicated, so it can never drift from the real reset.
const HARNESS_TRUNCATION = RESET_STATEMENTS.join("; ") + ";";

async function roadmapFtsCount(): Promise<number> {
  const rows = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM roadmap_fts`);
  return rows[0].n;
}

describe("query() learns the roadmap (plan + sprints via FTS)", () => {
  it("a sprint is a sprint-typed hit; the plan carries the narrative body", async () => {
    const { sprints } = await write_plan(
      systemCtx(),
      {
        narrative: "The vector search rollout brings semantic retrieval online this quarter.",
        sprints: [
          { label: "Vectorize GA", description: "Ship the Vectorize index to production", phase: "Now", due: "2026-08-01", status: "in_progress" },
        ],
      },
      AUTHOR
    );
    const sid = sprints[0].id;

    // 1. A term unique to the sprint → a sprint-typed hit for it.
    const r1 = await query(env.DB, { q: "vectorize", include_staged: true });
    const hit = r1.primary.find((p) => p.id === `sprint:${sid}`);
    expect(hit).toBeDefined();
    expect(hit!.type).toBe("sprint");
    expect(hit!.title).toBe("Vectorize GA");
    expect(hit!.authority).toBe("live");
    expect(hit!.body).toContain("Ship the Vectorize index");

    // 2. A phrase only in the narrative → the plan row, carrying the narrative body.
    const r2 = await query(env.DB, { q: "semantic retrieval online", include_staged: true });
    const plan = r2.primary.find((p) => p.id === "plan");
    expect(plan).toBeDefined();
    expect(plan!.type).toBe("sprint");
    expect(plan!.title).toBe("Roadmap plan");
    expect(plan!.authority).toBe("live");
    expect(plan!.body).toContain("vector search rollout");
  });

  it("sprint participates in the DEFAULT types (no explicit types needed)", async () => {
    await write_plan(
      systemCtx(),
      {
        narrative: "n",
        sprints: [{ label: "Quokka Launch", description: "the quokka sprint", due: "2026-09-01", status: "upcoming" }],
      },
      AUTHOR
    );
    const r = await query(env.DB, { q: "quokka", include_staged: true }); // no types → defaults include sprint
    expect(r.primary.some((p) => p.type === "sprint" && p.title === "Quokka Launch")).toBe(true);
  });

  it("the cached GitHub counts are NOT in the body line — a cache-only sprint carries none", async () => {
    const { sprints } = await write_plan(
      systemCtx(),
      {
        narrative: "n",
        sprints: [{ label: "Progress Sprint", description: "aardvark subsystem", due: "2026-10-01", status: "in_progress" }],
      },
      AUTHOR
    );
    const sid = sprints[0].id;
    await upsertProgress(systemCtx(), sid, 2, 5, "recompute");

    const r = await query(env.DB, { q: "aardvark", types: ["sprint"], include_staged: true });
    const hit = r.primary.find((p) => p.id === `sprint:${sid}`)!;
    // The sprint holds no tickets, so there is no progress to report at all —
    // the 2/5 issue cache never becomes a claim about the sprint.
    expect(hit.body).not.toContain("Progress:");
    expect(hit.body).not.toContain("2/5");
  });

  // The assembled sprint body must speak the SAME progress rule the Roadmap and
  // GET /sprints do (`sprintProgress`): the sprint's TICKETS only.
  it("the progress line is TICKETS ONLY: one done ticket and NO cache reads 1/1", async () => {
    await seedPerson("tester");
    const { sprints } = await write_plan(
      systemCtx(),
      { narrative: "n", sprints: [{ label: "Wombat Sprint", description: "wombat subsystem", due: "2026-10-05", status: "in_progress" }] },
      AUTHOR
    );
    const sid = sprints[0].id;
    const t = await create_ticket(systemCtx(), TicketCreate.parse({ title: "the wombat work", sprint_id: sid }), "tester");
    await transition_ticket(systemCtx(), t, "in_progress", "tester");
    await transition_ticket(systemCtx(), t, "done", "tester");

    // No sprint_progress row exists for this sprint at all.
    expect(await all(env.DB, `SELECT * FROM sprint_progress WHERE sprint_id = ?`, sid)).toHaveLength(0);

    const r = await query(env.DB, { q: "wombat", types: ["sprint"], include_staged: true });
    const hit = r.primary.find((p) => p.id === `sprint:${sid}`)!;
    expect(hit.body).toContain("Progress: 1/1 closed");
  });

  it("the cache never adds to the body line, and a sprint with no tickets carries no progress line", async () => {
    await seedPerson("tester");
    const { sprints } = await write_plan(
      systemCtx(),
      {
        narrative: "n",
        sprints: [
          { label: "Numbat Sprint", description: "numbat subsystem", due: "2026-10-06", status: "in_progress" },
          { label: "Bilby Sprint", description: "bilby subsystem", due: "2026-10-07", status: "upcoming" },
        ],
      },
      AUTHOR
    );
    const [numbat, bilby] = sprints;
    await upsertProgress(systemCtx(), numbat.id, 1, 2, "event"); // the GitHub half
    const done = await create_ticket(systemCtx(), TicketCreate.parse({ title: "numbat one", sprint_id: numbat.id }), "tester");
    await create_ticket(systemCtx(), TicketCreate.parse({ title: "numbat two", sprint_id: numbat.id }), "tester");
    await transition_ticket(systemCtx(), done, "in_progress", "tester");
    await transition_ticket(systemCtx(), done, "done", "tester");

    const r = await query(env.DB, { q: "numbat bilby", types: ["sprint"], include_staged: true });
    // 1 of 2 TICKETS done. The 1/2 issue cache is not added in (the old combined
    // line read 2/4), and it is not reported in the body at all.
    const numbatBody = r.primary.find((p) => p.id === `sprint:${numbat.id}`)!.body;
    expect(numbatBody).toContain("Progress: 1/2 closed");
    expect(numbatBody).not.toContain("2/4");
    // No tickets → nothing to say; the line is omitted entirely.
    expect(r.primary.find((p) => p.id === `sprint:${bilby.id}`)!.body).not.toContain("Progress:");
  });

  it("section/space filter excludes sprint (docsOnly)", async () => {
    await write_plan(
      systemCtx(),
      { narrative: "n", sprints: [{ label: "Mango Sprint", description: "mango note", due: "2026-11-01", status: "upcoming" }] },
      AUTHOR
    );
    const r = await query(env.DB, { q: "mango", section: "reference", include_staged: true });
    expect(r.primary.some((p) => p.type === "sprint")).toBe(false);
    expect(r.pointers.some((p) => p.type === "sprint")).toBe(false);
  });

  it("the harness truncation cascades into roadmap_fts (no leaked rows)", async () => {
    await write_plan(
      systemCtx(),
      {
        narrative: "some narrative that indexes the plan row",
        sprints: [{ label: "Iso Sprint", description: "d", phase: "Now", due: "2026-12-01", status: "upcoming" }],
      },
      AUTHOR
    );
    // 1 plan row (non-empty narrative) + 1 sprint row.
    expect(await roadmapFtsCount()).toBe(2);

    // Run the EXACT statement the harness runs beforeEach.
    await env.DB.exec(HARNESS_TRUNCATION);

    // Sprint DELETE cascades out; the plan UPDATE-to-'' deletes the plan row.
    expect(await roadmapFtsCount()).toBe(0);
  });
});
