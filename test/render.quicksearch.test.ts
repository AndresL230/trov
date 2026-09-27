/**
 * The "search everything" dropdown's pure half (web/src/quicksearch.ts): grouping and
 * group order, the Screens list, highlight escaping, the keyboard selection state, the
 * states, the LRU and the prefix narrowing. The controller's DOM wiring is exercised in
 * the running app; everything it renders comes through `quickBodyHtml`.
 */
import { describe, it, expect } from "vitest";
import {
  quickGroups, flatRows, quickBodyHtml, highlight, matchScreens, rowOf, QuickCache, narrowResult, normQuery,
  QUICK_SCREENS, type QuickBodyProps,
} from "../web/src/quicksearch";
import type { QuickHit, QuickSearchResult } from "@shared/quick-search";

const hit = (o: Partial<QuickHit> & Pick<QuickHit, "type" | "id" | "title">): QuickHit =>
  ({ snippet: null, status: null, by: null, at: null, ...o });

const RESULT: QuickSearchResult = {
  q: "deploy",
  groups: [
    { type: "ticket", hits: [hit({ type: "ticket", id: "12", title: "Deploy fails on main", status: "in_progress" })] },
    { type: "doc", hits: [hit({ type: "doc", id: "deploys", title: "Deploy runbook", snippet: "how we deploy" }), hit({ type: "doc", id: "ci", title: "CI", snippet: "deploy checks" })] },
    { type: "person", hits: [hit({ type: "person", id: "dana", title: "Deploy Dana", color: "sky" })] },
  ],
};

const body = (over: Partial<QuickBodyProps> = {}): string => {
  const groups = quickGroups("deploy", RESULT);
  return quickBodyHtml({ q: "deploy", groups, sel: 0, status: "ok", slow: false, error: null, ...over });
};

describe("quick search — grouping", () => {
  it("lists the server's groups in its order, each with its icon + label head, then the all-results row", () => {
    const html = body();
    const heads = [...html.matchAll(/class="cnpy-qs-gh"><svg[^]*?<\/svg><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Tickets", "Docs", "People", "Screens"]);   // "deploy" prefixes a Repo screen's keyword → Screens last
    expect(html).toContain("Search everything for “deploy”");
  });

  it("puts Screens FIRST when a screen's label starts with the query, and alone below 2 characters", () => {
    const g = quickGroups("settings", { q: "settings", groups: RESULT.groups });
    expect(g[0].id).toBe("screen");
    expect(g[0].rows[0].title).toBe("Settings");
    expect(quickGroups("s", null).map((x) => x.id)).toEqual(["screen"]);
  });

  it("an empty query shows nothing anchored, and a jump-to list in the palette", () => {
    expect(quickGroups("", null)).toEqual([]);
    const jump = quickGroups("", null, { palette: true });
    expect(jump[0].rows.map((r) => r.title)).toContain("Release notes");
    expect(flatRows(jump, "").some((r) => r.group === "all")).toBe(false);
  });

  it("matches screens by label and keyword word-prefixes — MCP access, Release notes, New ticket", () => {
    expect(matchScreens("mcp")[0].screen.label).toBe("Settings › MCP access");
    expect(matchScreens("changelog")[0].screen.label).toBe("Release notes");
    expect(matchScreens("new tic")[0].screen.label).toBe("New ticket");
    expect(matchScreens("zzzz")).toEqual([]);
    const rel = QUICK_SCREENS.find((s) => s.label === "Release notes")!;
    expect(rel.steps).toEqual([["goReleases", null]]);
  });

  it("each type opens through the existing acts", () => {
    expect(rowOf(hit({ type: "ticket", id: "7", title: "t" })).pick).toEqual({ kind: "go", steps: [["openTicket", "7"]] });
    expect(rowOf(hit({ type: "doc", id: "a-doc", title: "t" })).pick).toEqual({ kind: "go", steps: [["openDocFrom", "a-doc"]] });
    expect(rowOf(hit({ type: "sprint", id: "sprint:3", title: "t" })).pick).toEqual({ kind: "go", steps: [["openSprint", "3"]] });
    expect(rowOf(hit({ type: "sprint", id: "plan", title: "x" })).pick).toEqual({ kind: "go", steps: [["goRoadmap", null]] });
    expect(rowOf(hit({ type: "artifact", id: "a-page", title: "t" })).pick).toEqual({ kind: "go", steps: [["artOpen", "a-page"]] });
    expect(rowOf(hit({ type: "prompt", id: "p", title: "t" })).pick).toEqual({ kind: "go", steps: [["openPrompt", "p"]] });
    expect(rowOf(hit({ type: "handoff", id: "14", title: "t" })).pick).toEqual({ kind: "go", steps: [["openHandoff", "14"]] });
    expect(rowOf(hit({ type: "feed", id: "3", title: "t" })).pick).toEqual({ kind: "go", steps: [["goFeed", null]] });
    expect(rowOf(hit({ type: "person", id: "dana", title: "Dana" })).pick).toEqual({ kind: "go", steps: [["openPerson", "dana"]] });
    expect(rowOf(hit({ type: "decision", id: "2", title: "Adopt X" })).pick).toEqual({ kind: "search", q: "Adopt X" });
  });

  it("a ticket row's context line names its status; a person row carries an avatar chip", () => {
    expect(rowOf(hit({ type: "ticket", id: "12", title: "t", status: "in_progress", snippet: "body words" })).context).toBe("In progress · body words");
    expect(body()).toMatch(/cnpy-qs-av/);
  });
});

describe("quick search — highlight escaping", () => {
  it("wraps word-start matches in <mark> and escapes everything else", () => {
    expect(highlight("Deploy <b>deploy</b> redeploy", "deploy"))
      .toBe(`<mark class="cnpy-qs-hl">Deploy</mark> &lt;b&gt;<mark class="cnpy-qs-hl">deploy</mark>&lt;/b&gt; redeploy`);
  });

  it("a query made of markup or regex characters is inert", () => {
    expect(highlight(`a <script>alert(1)</script> & "q"`, `<script> .* (`)).toBe(`a &lt;<mark class="cnpy-qs-hl">script</mark>&gt;alert(1)&lt;/<mark class="cnpy-qs-hl">script</mark>&gt; &amp; &quot;q&quot;`);
    const html = quickBodyHtml({ q: `<img src=x>`, groups: quickGroups(`<img src=x>`, { q: "", groups: [{ type: "doc", hits: [hit({ type: "doc", id: "d", title: `<img src=x onerror=alert(1)>` })] }] }), sel: 0, status: "ok", slow: false, error: null });
    expect(html).not.toContain("<img");
    expect(html).toContain("Search everything for “&lt;img src=x&gt;”");
  });

  it("highlights past a stem the same way the Worker matches (searchi → search)", () => {
    expect(highlight("The search page", "searchi")).toBe(`The <mark class="cnpy-qs-hl">search</mark> page`);
  });
});

describe("quick search — keyboard selection state", () => {
  it("exactly one row is selected, by its flat index across groups, with aria-selected", () => {
    const html = body({ sel: 2 });
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    const selected = html.match(/<div class="cnpy-qs-row is-sel[^"]*" role="option" id="cnpy-qs-o-(\d+)"/);
    expect(selected?.[1]).toBe("2");
    const rows = flatRows(quickGroups("deploy", RESULT), "deploy");
    expect(rows[2].title).toBe("CI");
    expect(rows[rows.length - 1]).toMatchObject({ group: "all", pick: { kind: "search", q: "deploy" } });
    // The all-results row is selectable too.
    expect(body({ sel: rows.length - 1 })).toMatch(new RegExp(`is-sel cnpy-qs-all" role="option" id="cnpy-qs-o-${rows.length - 1}"`));
  });
});

describe("quick search — states", () => {
  it("\"Searching…\" only once slow — floating over rows already shown", () => {
    expect(body({ status: "searching", slow: false })).not.toContain("Searching…");
    expect(body({ status: "searching", slow: true })).toContain(`cnpy-qs-note is-float" role="status">Searching…`);
    const empty = quickBodyHtml({ q: "qqqq", groups: [], sel: 0, status: "searching", slow: true, error: null });
    expect(empty).toContain(`cnpy-qs-note" role="status">Searching…`);
  });

  it("no results names the query (escaped); an error line sits above the rows it keeps", () => {
    expect(quickBodyHtml({ q: "<x>", groups: [], sel: 0, status: "ok", slow: false, error: null })).toContain("No results for “&lt;x&gt;”");
    const err = body({ status: "error", error: "Search didn’t answer" });
    expect(err.indexOf("is-err")).toBeLessThan(err.indexOf("cnpy-qs-row"));
    expect(err).toContain(`<mark class="cnpy-qs-hl">Deploy</mark> runbook`);
  });
});

describe("quick search — cache and prefix narrowing", () => {
  it("is an LRU with a TTL, and finds the longest cached prefix", () => {
    const c = new QuickCache(2, 1000);
    c.set("de", RESULT, 0); c.set("dep", RESULT, 0);
    expect(c.prefixOf("deplo", 10)).toBe(RESULT);
    c.get("de", 10); c.set("x1", RESULT, 10);          // "dep" is now least recent → evicted
    expect(c.get("dep", 10)).toBeNull();
    expect(c.get("de", 2000)).toBeNull();               // stale
    expect(normQuery("  Deploy   Fails ")).toBe("deploy fails");
  });

  it("narrows a prefix's answer to hits that still match the longer query", () => {
    const n = narrowResult(RESULT, "deploy run");
    expect(n.groups.flatMap((g) => g.hits.map((h) => h.id))).toEqual(["deploys"]);
  });
});
