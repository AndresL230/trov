// The team scenario's Projects (scripts/seed/projects.mjs; docs/architecture/local-dev.md): the prototype's five
// projects in SaplingLearn, every pin a ref that really exists in the seed (each resolves for its project's owner), four
// of AndresL230's showcase threads in "Hosting providers" and its Files pin, and the prototype's chats in "Teacher
// dashboard pilot" (two) and "Gradebook export rework" (one), each under Ask's own sharing.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { loadScenarios, type SeedDb } from "../scripts/seed/scenarios.mjs";
import { HOSTING_INSTRUCTIONS, PROJECT_CHECKS, projectStatements } from "../scripts/seed/projects.mjs";
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
    // The showcase's attached image (its bytes go to R2 only in the dev seed): the Files pin is that same file uploaded.
    const now = new Date("2026-11-05T15:00:00.000Z");
    await loadScenarios(db, ["team"], { now, image: { sha: "ab".repeat(32), size: 421_888 } });
    await db.apply("Projects again", projectStatements(now)); // idempotent: it rewrites only what it owns
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
    // Files: the uploaded image is the project's, the org's (so every member sees the pin), pinned.
    const file = "artifact:railway-build-log-png-2";
    expect(hosting.pins.find((x) => x.ref === file)?.view).toMatchObject({ type: "artifact", title: "railway-build-log.png", extra: { kind: "image", visibility: "org" } });
    expect(hosting.artifacts.find((a) => `artifact:${a.slug}` === file)).toMatchObject({ kind: "image", visibility: "org", author: "AndresL230" });
    // Jack sees Hosting providers as its viewer, the file pin included; Sana (in no project) sees only the org one.
    const jack = await cookieFor("Darkest-Teddy");
    const asJack = ProjectDetailSchema.parse((await call("GET", `${P}/hosting-providers`, jack)).json);
    expect(asJack.project.access).toBe("viewer");
    expect(asJack.pins.filter((x) => "hidden" in x.view).map((x) => x.ref)).toEqual([]);
    expect(asJack.pins.map((x) => x.ref)).toContain(file);
    const sana = await cookieFor("sanaok");
    expect(ProjectListSchema.parse((await call("GET", P, sana)).json).projects.map((p) => p.slug)).toEqual(["teacher-dashboard-pilot"]);

    // Chats keep Ask's privacy. Teacher dashboard pilot: Andres has his own and Mei Lin's (shared by name, Can continue);
    // Mei Lin has only hers; Sana reads hers through the org share.
    const chats = async (slug: string, cookie: string) =>
      ProjectDetailSchema.parse((await call("GET", `${P}/${slug}`, cookie)).json).chats.map((c) => [c.title, c.owner ?? null, c.access ?? null]);
    expect(await chats("teacher-dashboard-pilot", andres)).toEqual([
      ["Sort the pilot feedback by school", null, null], ["What did teachers ask for most?", "meilin", "continue"],
    ]);
    expect((await chats("teacher-dashboard-pilot", await cookieFor("meilin"))).map((c) => c[0])).toEqual(["What did teachers ask for most?"]);
    expect(await chats("teacher-dashboard-pilot", sana)).toEqual([["What did teachers ask for most?", "meilin", "read"]]);
    // Gradebook export rework: Jose's thread, shared with the org: Andres and Jack read it.
    expect(await chats("gradebook-export-rework", andres)).toEqual([["Why is the export empty for Northside?", "Jose-Gael-Cruz-Lopez", "read"]]);
    expect(await chats("gradebook-export-rework", jack)).toEqual([["Why is the export empty for Northside?", "Jose-Gael-Cruz-Lopez", "read"]]);
    expect(list.projects.filter((p) => p.slug !== "exam-week-incident").map((p) => [p.slug, p.chats])).toEqual(expect.arrayContaining([
      ["hosting-providers", 4], ["teacher-dashboard-pilot", 2], ["gradebook-export-rework", 1],
    ]));
  });
});
