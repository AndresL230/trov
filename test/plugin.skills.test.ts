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
  it("ships the eleven skills, at the version the release notes name", () => {
    expect(Object.keys(SKILLS).sort()).toEqual(["artifacts", "handoff", "link", "load-context", "my-work", "prompts", "read-plan", "record-session", "tickets", "trov", "update-plan"]);
    expect(plugin.version).toBe("0.11.1");
  });

  it("the explicit-only skills load on a request in words: no disable-model-invocation, and never on their own (#183)", () => {
    for (const [name, text] of Object.entries(SKILLS)) expect(frontmatter(text), name).not.toContain("disable-model-invocation");
    for (const name of ["handoff", "record-session", "tickets", "update-plan"]) {
      const description = /^description: (.*)$/m.exec(frontmatter(SKILLS[name]))?.[1] ?? "";
      expect(description, name).toContain(`asks for this in words or types /trov:${name}`);
      expect(description, name).toContain("never on your own");
    }
    expect(SKILLS.trov).toContain("**Explicit-only means asked, not typed.**");
  });

  it("record-session never sends needs_triage: unsure is a low-confidence proposal or left out, and a refusal is fixed and re-sent", () => {
    const rs = SKILLS["record-session"];
    expect(rs).not.toContain(`"needs_triage":`); // not in the payload it assembles
    expect(rs).toContain("never send `needs_triage`");
    expect(rs).toContain("Leave it OUT of the batch");
    for (const code of ["`image`", "`section`", "`space`", "`archived_page`"]) expect(rs, code).toContain(code);
    expect(rs).toContain("call `record_session` again with the SAME session id");
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

  it("handoff uploads a long prompt when it has a shell, sends it inline without one, and reports #N only after the PUT", () => {
    const h = SKILLS.handoff;
    for (const said of ["prompt: { title, sha256, size_bytes }", "prompt: { title, body }", "about 2 KB", "no shell", "curl -sS -X PUT --data-binary @"]) expect(h, said).toContain(said);
    expect(h).toMatch(/only once the PUT\s+has answered/);
    for (const tool of ["Bash(shasum -a 256:*)", "Bash(wc -c:*)", "Bash(curl -sS -X PUT:*)"]) expect(allowed(h)).toContain(tool);
  });

  it("load-context opens by asking where it is and saying so; nothing tells a person to add the server twice", () => {
    const lc = SKILLS["load-context"];
    expect(lc.indexOf("mcp__trov__get_connection` with it")).toBeGreaterThan(0);
    expect(lc.indexOf("0. **Say where you are")).toBeLessThan(lc.indexOf("2. **Query focused.**"));
    // Phase D: the repository's written state is read FIRST, before any query.
    expect(lc.indexOf("1. **Read where the repository stands")).toBeGreaterThan(lc.indexOf("0. **Say where you are"));
    expect(lc.indexOf("1. **Read where the repository stands")).toBeLessThan(lc.indexOf("2. **Query focused.**"));
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

/** A skill's frontmatter: the text between its two `---` lines. */
const frontmatter = (text: string): string => /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
type McpHook = Record<string, string>;
/** The `mcp_tool` hooks under one event of a skill's frontmatter `hooks:`, each with its matcher. The
 *  frontmatter is the small, fixed YAML shape the Phase 0 harness proved (agent-links spec): event →
 *  `- matcher?` / `hooks:` → `- type: mcp_tool` with `if`, `server`, `tool`, `input:` (two levels) and `timeout`. */
function skillHooks(text: string, event: string): McpHook[] {
  const fm = frontmatter(text);
  const block = new RegExp(`^  ${event}:\\n((?:    .*\\n?)*)`, "m").exec(fm)?.[1] ?? "";
  const out: McpHook[] = [];
  let matcher = "";
  let hook: McpHook | null = null;
  for (const line of block.split("\n")) {
    const m = /^(\s*)(- )?([\w-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, indent, dash, key, raw] = m;
    const value = raw.replace(/^"(.*)"$/, "$1");
    if (key === "matcher") { matcher = value; continue; }
    if (key === "type") { hook = { type: value, matcher }; out.push(hook); continue; }
    if (!hook || key === "hooks" || key === "input") continue;
    hook[indent.length + (dash ? 2 : 0) > 10 ? `input.${key}` : key] = value;
  }
  return out;
}

describe("the link skill registers its hooks from its own frontmatter (owner ruling 6)", () => {
  const link = SKILLS.link;
  const inbox = { type: "mcp_tool", server: "plugin:trov:trov", tool: "link_inbox", "input.session": "${session_id}", "input.event": "${hook_event_name}", timeout: "5" };

  it("calls link_inbox at every prompt, with the session and the event", () => {
    expect(skillHooks(link, "UserPromptSubmit")).toEqual([{ ...inbox, matcher: "" }]);
  });

  it("calls it after a git commit and a git push, and after no other Bash command", () => {
    expect(skillHooks(link, "PostToolUse")).toEqual([
      { ...inbox, matcher: "Bash", if: "Bash(git commit*)" },
      { ...inbox, matcher: "Bash", if: "Bash(git push*)" },
    ]);
  });

  it("hooks only that one tool, nowhere but this skill, and stays invocable so a spoken 'join link 12' registers them", () => {
    for (const [name, text] of Object.entries(SKILLS)) if (name !== "link") expect(frontmatter(text), name).not.toMatch(/^hooks:/m);
    expect(Object.keys(import.meta.glob("../plugins/trov/hooks/*"))).toEqual([]); // not plugin-wide: hooks.json would call link_inbox in every session
    expect(frontmatter(link)).not.toContain("disable-model-invocation");
    for (const t of ["request_link", "join_link", "send_link_note", "close_link", "list_links", "link_inbox"]) expect(allowed(link)).toContain(`mcp__trov__${t}`);
    expect(link).toContain('echo "$CLAUDE_CODE_SESSION_ID"');
    expect(link).toContain("Never request without a yes");
  });

  it("its description says to invoke it BEFORE request_link / join_link: a model that calls the tools directly gets no hooks (two-sessions e2e L-01)", () => {
    const description = /^description: (.*)$/m.exec(frontmatter(link))?.[1] ?? "";
    expect(description).toMatch(/ALWAYS invoke this skill before calling request_link or join_link/);
    expect(description).toMatch(/registers the hooks/);
  });

  it("load-context lists links at session start and never joins or requests one", () => {
    const lc = SKILLS["load-context"];
    expect(allowed(lc)).toContain("mcp__trov__list_links");
    for (const t of ["request_link", "join_link", "send_link_note", "close_link"]) expect(allowed(lc)).not.toContain(`mcp__trov__${t}`);
    expect(lc).toContain("say 'join link 12'");
  });
});
