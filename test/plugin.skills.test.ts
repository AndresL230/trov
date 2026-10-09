// The plugin's skills are how an agent learns to say WHERE it is: one connection covers every
// organization a person belongs to (0051), so each skill must pass `repo` on its Trov calls and be
// allowed to work it out. These read the shipped SKILL.md text — what a teammate's agent is given.
import { describe, it, expect } from "vitest";
import plugin from "../plugins/trov/.claude-plugin/plugin.json";

const SKILLS: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob("../plugins/trov/skills/*/SKILL.md", { query: "?raw", import: "default", eager: true }))
    .map(([path, text]) => [path.split("/").at(-2)!, text]),
);
const allowed = (text: string): string[] => (/^allowed-tools: (.*)$/m.exec(text)?.[1] ?? "").split(", ").map((t) => t.trim());

describe("the Trov plugin's skills and the organization a call acts in", () => {
  it("ships the ten skills, at the version the release notes name", () => {
    expect(Object.keys(SKILLS).sort()).toEqual(["artifacts", "handoff", "load-context", "my-work", "prompts", "read-plan", "record-session", "tickets", "trov", "update-plan"]);
    expect(plugin.version).toBe("0.8.0");
  });

  it("every skill that calls Trov derives `repo` from the git remote, passes it on every call, and may ask where it is", () => {
    for (const [name, text] of Object.entries(SKILLS)) {
      expect(allowed(text), name).toContain("mcp__trov__get_connection");
      expect(allowed(text), name).toContain("Bash(git remote get-url:*)");
      if (name === "trov") continue; // the map: it explains the rule in full instead of the short block
      expect(text, name).toContain("## Which organization — pass `repo` on every call");
      expect(text, name).toContain("git remote get-url origin");
      expect(text, name).toContain("leave `repo` out"); // no remote: the server decides, the agent does not invent one
      for (const code of ["repo_required", "not_connected", "ambiguous_org", "org_unavailable"]) expect(text, `${name}: ${code}`).toContain(code);
      expect(text, name).toContain("never pass a different repository to get an answer");
    }
  });

  it("load-context opens by asking where it is and saying so; nothing tells a person to add the server twice", () => {
    const lc = SKILLS["load-context"];
    expect(lc.indexOf("mcp__trov__get_connection` with it")).toBeGreaterThan(0);
    expect(lc.indexOf("0. **Say where you are")).toBeLessThan(lc.indexOf("1. **Query focused.**"));
    expect(lc).toContain("If `organization` is null");
    const map = SKILLS.trov;
    for (const said of ["`get_connection`", "`switch_org <org>`", "follows the repository", "**`manual`.**", "It cannot add an organization"]) expect(map, said).toContain(said);
    expect(allowed(map)).toContain("mcp__trov__switch_org");
    for (const text of Object.values(SKILLS)) {
      expect(text).not.toContain("trov-<org> <same url>");
      expect(text).not.toContain("A connection is for **one organization**");
    }
  });
});
