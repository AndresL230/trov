// The team scenario's Projects (scripts/seed/projects.mjs; docs/architecture/local-dev.md): the prototype's five
// projects in SaplingLearn, every pin a ref that really exists in the seed (each resolves for its project's owner), and
// four of AndresL230's showcase threads in "Hosting providers".
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { loadScenarios, type SeedDb } from "../scripts/seed/scenarios.mjs";
import { HOSTING_INSTRUCTIONS, PROJECT_CHECKS } from "../scripts/seed/projects.mjs";
import { ProjectDetailSchema, ProjectListSchema } from "@shared/projects";
import { call } from "./helpers/ask";
import { cookieFor } from "./helpers/persons";

const db: SeedDb = {
  query: async (sqls) => Promise.all(sqls.map(async (s) => (await env.DB.prepare(s).all<Record<string, unknown>>()).results)),
  apply: async (_label, statements) => {
    for (let i = 0; i < statements.length; i += 40) await env.DB.batch(statements.slice(i, i + 40).map((s) => env.DB.prepare(s)));
  },
};
const P = "/api/o/saplinglearn/projects";

describe("the team scenario's projects", () => {
  it("holds its promises, and every pin resolves for its project's owner", async () => {
    await loadScenarios(db, ["team"], { now: new Date("2026-11-05T15:00:00.000Z") });
    for (const [label, sql, want] of PROJECT_CHECKS) {
      expect(Number((await env.DB.prepare(sql).first<{ n: number }>())?.n ?? 0), label).toBe(want);
    }
    const andres = await cookieFor("AndresL230");
    const list = ProjectListSchema.parse((await call("GET", P, andres)).json);
    expect(list.projects.map((p) => [p.slug, p.visibility, p.owner, p.access])).toEqual(expect.arrayContaining([
      ["hosting-providers", "members", "AndresL230", "owner"], ["teacher-dashboard-pilot", "org", "meilin", "editor"],
      ["gradebook-export-rework", "members", "Jose-Gael-Cruz-Lopez", "editor"], ["exam-week-incident", "private", "AndresL230", "owner"],
    ]));
    expect(list.archived.map((p) => p.slug)).toEqual(["streak-features"]);
    const hosting = ProjectDetailSchema.parse((await call("GET", `${P}/hosting-providers`, andres)).json);
    expect(hosting.project.instructions).toBe(HOSTING_INSTRUCTIONS);
    expect(hosting.chats).toHaveLength(4);
    expect(hosting.members.map((m) => [m.handle, m.role])).toEqual([["AndresL230", "owner"], ["Jose-Gael-Cruz-Lopez", "editor"], ["Darkest-Teddy", "viewer"]]);
    for (const slug of ["hosting-providers", "teacher-dashboard-pilot", "gradebook-export-rework", "exam-week-incident", "streak-features"]) {
      const d = ProjectDetailSchema.parse((await call("GET", `${P}/${slug}`, andres)).json);
      expect(d.pins.filter((x) => "hidden" in x.view).map((x) => x.ref), slug).toEqual([]);
    }
    // Jack sees Hosting providers as its viewer; Sana (in no project) sees only the org one.
    expect((await call("GET", `${P}/hosting-providers`, await cookieFor("Darkest-Teddy"))).json.project.access).toBe("viewer");
    expect(ProjectListSchema.parse((await call("GET", P, await cookieFor("sanaok"))).json).projects.map((p) => p.slug)).toEqual(["teacher-dashboard-pilot"]);
  });
});
