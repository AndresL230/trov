// The AI screen contracts (shared/ai.ts): the preview fixtures every screen is built and
// screenshotted against must satisfy the same schemas the Worker will validate against.
import { describe, it, expect } from "vitest";
import { AiBriefSchema, AiRepoStateSchema, AiFeedMetaSchema, AiThemesSchema, AI_THEME_RANGES, AI_THEME_RANGE_WEEKS } from "@shared/ai";
import { AI_PREVIEW_MODES, aiPreviewFixtures, isAiPreviewMode, nextMonthStart } from "@shared/ai-fixtures";

const NOW = new Date("2026-10-14T12:00:00Z");

describe("AI contracts", () => {
  for (const mode of AI_PREVIEW_MODES) {
    it(`the ${mode} fixtures satisfy the schemas`, () => {
      const f = aiPreviewFixtures(mode, NOW);
      expect(AiBriefSchema.safeParse(f.brief).success).toBe(true);
      expect(AiRepoStateSchema.safeParse(f.repoState).success).toBe(true);
      for (const row of f.feed) expect(AiFeedMetaSchema.safeParse(row.ai).success).toBe(true);
      for (const r of AI_THEME_RANGES) {
        const t = f.themes[r];
        expect(AiThemesSchema.safeParse(t).success, `${mode}/${r}`).toBe(true);
        expect(t.range).toBe(r);
        if (mode !== "empty") expect(t.weeks).toHaveLength(AI_THEME_RANGE_WEEKS[r]);
      }
    });
  }

  it("capped carries resumesOn and the upgrade flag; ready and empty do not", () => {
    expect(aiPreviewFixtures("capped", NOW).brief).toMatchObject({ state: "capped", resumesOn: "2026-11-01", upgrade: true });
    expect(aiPreviewFixtures("ready", NOW).brief).toMatchObject({ state: "ready", resumesOn: null, upgrade: false });
    expect(aiPreviewFixtures("empty", NOW).brief).toMatchObject({ state: "empty", generatedAt: null, model: null });
  });

  it("proposed themes carry a suggestion id per lane and no caption", () => {
    const t = aiPreviewFixtures("proposed", NOW).themes["8w"];
    expect(t.caption).toBeNull();
    expect(t.lanes.every((l) => l.status === "proposed" && l.suggestionId !== null)).toBe(true);
  });

  it("weeks are Mondays, oldest first", () => {
    const { weeks } = aiPreviewFixtures("ready", NOW).themes["8w"];
    expect(weeks.every((w) => new Date(`${w}T00:00:00Z`).getUTCDay() === 1)).toBe(true);
    expect([...weeks].sort()).toEqual(weeks);
    expect(weeks.at(-1)).toBe("2026-10-12");
  });

  it("a lane whose counts don't match the weeks is refused", () => {
    const t = aiPreviewFixtures("ready", NOW).themes["8w"];
    const bad = { ...t, lanes: [{ ...t.lanes[0], counts: [1, 2] }] };
    expect(AiThemesSchema.safeParse(bad).success).toBe(false);
  });

  it("only the listed preview modes are honoured", () => {
    expect(isAiPreviewMode("ready")).toBe(true);
    expect(isAiPreviewMode("off")).toBe(false);
    expect(isAiPreviewMode("1")).toBe(false);
    expect(nextMonthStart(new Date("2026-12-31T23:00:00Z"))).toBe("2027-01-01");
  });
});

describe("aiItemRef", () => {
  it("names a written item by what it is about and when it was written", async () => {
    const { aiItemRef } = await import("@shared/ai-core");
    expect(aiItemRef.brief("2026-10-14T12:00:00.000Z")).toBe("2026-10-14T12:00:00.000Z");
    expect(aiItemRef.repoState("o/r", "t")).toBe("o/r@t");
    expect(aiItemRef.themes("o/r", "quarter", "t")).toBe("o/r:quarter@t");
    expect(aiItemRef.feed(7)).toBe("7");
  });
});
