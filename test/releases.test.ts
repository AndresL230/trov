/**
 * Help › What's new (web/src/releases.ts): the RELEASES data, the index grid, each
 * release's two pages, the `#releases…` routes and the screen as the app renders it.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import {
  RELEASES, releasesIndex, releasePageView, releasesScreen, releaseLine, releaseDate, releaseSlug, releaseHash,
  findRelease, releaseName, prUrl, TROV_REPO_URL, RELEASE_CAPS, splitPatchLine, type Release,
} from "../web/src/releases";
import * as releasesModule from "../web/src/releases";
import { esc } from "../web/src/ui";
import { parseHash, hashForRoute } from "../web/src/hash";
import { render, initialState } from "../web/src/render";
import { LATEST_RELEASE, LATEST_VERSION } from "../web/src/release-latest";
import { releasesView, releaseCrumb, setReleasesModule, releasesLoaded } from "../web/src/releases-lazy";
import css from "../web/src/trov.css?raw";

// Every web module as text: which of them import releases.ts, and how.
const webSources = import.meta.glob("../web/src/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// The live data has an Unreleased entry only between a merge and the next version cut,
// so the Unreleased rendering is tested against this fixture prepended to it.
const NEXT: Release = {
  version: "Unreleased", date: "2099-01-01", unreleased: true, title: "Next", headline: "Coming",
  highlights: ["a", "b", "c"], patches: { added: ["x"], changed: [], fixed: [], removed: [] },
};
const withNext: Release[] = [NEXT, ...RELEASES];

describe("RELEASES — the data", () => {
  it("is newest first: dates never increase down the list, and Unreleased (if any) is first", () => {
    for (let i = 1; i < RELEASES.length; i++) {
      expect(RELEASES[i].date <= RELEASES[i - 1].date, `${RELEASES[i].version} after ${RELEASES[i - 1].version}`).toBe(true);
    }
    RELEASES.forEach((r, i) => { if (r.unreleased) expect(i).toBe(0); });
  });

  it("has unique versions and slugs, real ISO dates, and 0.N versions counting down to 0.1 without a gap", () => {
    expect(new Set(RELEASES.map((r) => r.version)).size).toBe(RELEASES.length);
    expect(new Set(RELEASES.map(releaseSlug)).size).toBe(RELEASES.length);
    for (const r of RELEASES) {
      expect(r.date, r.version).toMatch(ISO);
      expect(Number.isNaN(Date.parse(`${r.date}T00:00:00Z`)), r.version).toBe(false);
    }
    // The shipped versions are exactly 0.N … 0.1, consecutive, newest first.
    const shipped = RELEASES.filter((r) => !r.unreleased).map((r) => r.version);
    for (const v of shipped) expect(v).toMatch(/^0\.\d+$/);
    expect(shipped).toEqual(shipped.map((_, i) => `0.${shipped.length - i}`));
    expect(RELEASES.find((r) => r.unreleased)?.formerly).toBeUndefined();
  });

  it("`formerly` holds every pre-renumbering number 0.1–0.34 exactly once, newest first, in release order", () => {
    // Each renumbered entry lists its own old version first, then the ones folded into it; read down
    // the list the old numbers run 0.34 … 0.1 without a gap or a repeat, so no old link is orphaned.
    const old = RELEASES.flatMap((r) => r.formerly ?? []);
    expect(old).toEqual(Array.from({ length: 34 }, (_, i) => `0.${34 - i}`));
    for (const r of RELEASES) if (r.formerly) expect(r.formerly.length, r.version).toBeGreaterThan(0);
  });

  it("every release has a title, a headline, highlights and at least one patch line, within RELEASE_CAPS", () => {
    const C = RELEASE_CAPS;
    for (const r of RELEASES) {
      const v = r.version;
      expect(r.title.trim(), v).not.toBe("");
      expect(r.title.length, `${v} title`).toBeLessThanOrEqual(C.titleChars);
      expect(r.headline.trim(), v).not.toBe("");
      expect(r.headline.length, `${v} headline`).toBeLessThanOrEqual(C.headlineChars);
      expect(r.highlights.length, `${v} highlights`).toBeGreaterThanOrEqual(C.highlights.min);
      expect(r.highlights.length, `${v} highlights`).toBeLessThanOrEqual(C.highlights.max);
      for (const h of r.highlights) expect(h.length, `${v} highlight: ${h.slice(0, 50)}`).toBeLessThanOrEqual(C.highlights.chars);
      expect((r.headsUp ?? []).length, `${v} headsUp`).toBeLessThanOrEqual(C.headsUp.max);
      for (const h of r.headsUp ?? []) expect(h.length, `${v} heads-up: ${h.slice(0, 50)}`).toBeLessThanOrEqual(C.headsUp.chars);
      expect((r.ops ?? []).length, `${v} ops`).toBeLessThanOrEqual(C.ops.max);
      for (const o of r.ops ?? []) expect(o.length, `${v} ops: ${o.slice(0, 50)}`).toBeLessThanOrEqual(C.ops.chars);
      const lines = [...r.patches.added, ...r.patches.changed, ...r.patches.fixed, ...r.patches.removed];
      expect(lines.length, v).toBeGreaterThan(0);
      expect(lines.length, `${v}: ${lines.length} patch lines`).toBeLessThanOrEqual(C.patches.max);
      for (const l of lines) expect(l.length, `${v} patch: ${l.slice(0, 50)}`).toBeLessThanOrEqual(C.patches.chars);
    }
  });

  it("patch lines are product words, not an engineering log: no file paths, test files or function calls", () => {
    const LOG = /\b(src|web\/src|shared|test|scripts|migrations)\/|\.test\.ts|\w\(\)/;
    for (const r of RELEASES) {
      for (const l of [...r.patches.added, ...r.patches.changed, ...r.patches.fixed, ...r.patches.removed]) {
        expect(l, r.version).not.toMatch(LOG);
      }
    }
  });

  it("every PR a patch line cites is in that release's prs list", () => {
    for (const r of RELEASES) {
      const lines = [...r.patches.added, ...r.patches.changed, ...r.patches.fixed, ...r.patches.removed];
      const cited = new Set(lines.flatMap((l) => [...l.matchAll(/\((#\d+(?:, #\d+)*)\)/g)].flatMap((m) => m[1].split(", ").map((x) => Number(x.slice(1))))));
      for (const n of cited) expect(r.prs ?? [], `${r.version} cites #${n}`).toContain(n);
    }
  });

  it("names the migration an admin must run for 0.4 (formerly 0.15) — in ops, not the users' heads-up", () => {
    const next = findRelease("0.4")!;
    expect(next.formerly).toContain("0.15");
    expect(next.ops?.join(" ")).toMatch(/0035_library_and_sprint_dates/);
    expect(next.headsUp?.join(" ")).not.toMatch(/0035/);
    expect(next.headsUp?.join(" ")).toMatch(/800 characters/);
  });

  it("keeps the deploy steps of the newest cut batch (0.11): every migration, the App events, the plugin", () => {
    const ops = (v: string) => findRelease(v)!.ops!.join(" ");
    // 0.11 (formerly 0.34) is #178 cut together with #186 / #187: its own migrations to 0068, the App events, the plugin.
    expect(ops("0.11")).toMatch(/0058_server_ai/);
    expect(ops("0.11")).toMatch(/deployment, release, create and workflow_job/);
    expect(ops("0.11")).toMatch(/plugin 0\.9\.0/);
    // 0.12 is the 10-17 staging epic (#193 + #194 + #195): its seven migrations are one file, 0076_10_17_staging.
    expect(ops("0.12")).toMatch(/0076_10_17_staging/);
    expect(ops("0.12")).not.toMatch(/0080_handoff_upload_tokens|0077_ask_people_sharing|0076_ask_github/);
    expect(ops("0.12")).toMatch(/GitHub lookups/);
  });

  it("release notes are for users: highlights, headlines and heads-ups carry no code, PRs, migrations or deploy steps", () => {
    const DEV = /`|\(#\d|migration|db:migrate|wrangler|secret|plugin 0\.|\/api\/|\.ts\b/i;
    for (const r of RELEASES) {
      for (const line of [r.headline, ...r.highlights, ...(r.headsUp ?? [])]) expect(line, r.version).not.toMatch(DEV);
    }
  });
});

describe("releaseLine / releaseDate / slugs", () => {
  it("escapes text, turns backticks into <code>, and links (#N) to the trov PR", () => {
    const html = releaseLine("`<b>` & \"x\" (#78)");
    expect(html).toContain('<code class="is-short">&lt;b&gt;</code>');
    expect(html).toContain("&amp; &quot;x&quot;");
    expect(html).not.toContain("<b>");
    expect(html).toContain(`href="${TROV_REPO_URL}/pull/78"`);
    expect(prUrl(78)).toBe("https://github.com/AndresL230/trov/pull/78");
  });

  it("links every PR in a (#1, #2) group, and leaves a bare #12 alone", () => {
    const html = releaseLine("both (#54, #55) but handoff #12 stays text");
    expect(html).toContain("/pull/54");
    expect(html).toContain("/pull/55");
    expect(html).not.toContain("/pull/12");
  });

  it("formats dates without timezone drift; slugs and hashes name each release", () => {
    expect(releaseDate("2026-09-26")).toBe("Sep 26, 2026");
    expect(releaseDate("2026-01-01")).toBe("Jan 1, 2026");
    expect(releaseSlug({ version: "0.7" })).toBe("0.7");
    expect(releaseSlug({ version: "Unreleased", unreleased: true })).toBe("unreleased");
    expect(releaseHash(null)).toBe("#releases");
    expect(releaseHash("0.7")).toBe("#releases/0.7");
    expect(releaseHash("0.7", "patches")).toBe("#releases/0.7/patches");
    expect(findRelease("UNRELEASED", withNext)?.unreleased).toBe(true);
    expect(findRelease("0.99")).toBeNull();
    expect(releaseName({ version: "0.10" })).toBe("v0.10");
    expect(releaseName(findRelease("0.1")!)).toBe("v0.1"); // no range: an entry is named by its own number
    expect(releaseName({ version: "Unreleased", unreleased: true })).toBe("Unreleased");
  });

  it("an old number above the new range still resolves through `formerly`: its link opens that entry", () => {
    const current = new Set(RELEASES.map(releaseSlug));
    const old = RELEASES.flatMap((r) => (r.formerly ?? []).map((v) => [v, r] as const));
    expect(old.length).toBe(34);
    for (const [v, r] of old) {
      if (current.has(v)) continue; // a number that is a current version opens that release (next test)
      expect(findRelease(v), v).toBe(r);
      expect(findRelease(v.toUpperCase()), v).toBe(r);
    }
    // `#releases/0.25` (folded into what is now 0.7): the route keeps the old slug, the page draws 0.7.
    const r = findRelease("0.25")!;
    expect(r.version).toBe("0.7");
    expect(r.formerly).toContain("0.25");
    expect(parseHash("#releases/0.25")).toEqual({ screen: "releases", ticketId: null, sprintId: null, releaseVersion: "0.25", releasePage: "notes" });
    const notes = releasePageView("0.25", "notes");
    expect(notes).not.toContain("No release called");
    expect(notes).toContain(`>${r.title}</h1>`);
    expect(notes).toContain("v0.7 · Released");
    // `#releases/0.34/patches`: the old number of the newest batch opens 0.11's patch notes.
    expect(parseHash("#releases/0.34/patches")).toMatchObject({ releaseVersion: "0.34", releasePage: "patches" });
    expect(findRelease("0.34")!.version).toBe("0.11");
    expect(releasePageView("0.34", "patches")).toMatch(/aria-selected="true"[^>]*>Patch notes</);
    expect(releasesScreen("0.34", "patches")).toBe(releasePageView("0.11", "patches"));
  });

  it("a current number wins over an old one: 0.1–0.11 open the release that has that number today", () => {
    // "0.4" was Foundations' old number (now 0.1's `formerly`) — it opens today's 0.4, the board.
    expect(findRelease("0.1")!.formerly).toContain("0.4");
    expect(findRelease("0.4")!.version).toBe("0.4");
    expect(findRelease("0.4")!.formerly).toEqual(["0.16", "0.15", "0.14"]);
    for (const r of RELEASES.filter((x) => !x.unreleased)) expect(findRelease(r.version), r.version).toBe(r);
    // The rule holds whatever the data: a fixture whose old number collides with a current one.
    const fx: Release[] = [
      { ...hostile[1], version: "0.2", formerly: ["0.9", "0.1"] },
      { ...hostile[1], version: "0.1", formerly: ["0.5"] },
    ];
    expect(findRelease("0.1", fx)).toBe(fx[1]); // current 0.1, not the entry that was once 0.1
    expect(findRelease("0.9", fx)).toBe(fx[0]); // old 0.9 → the entry that holds it
    expect(findRelease("0.5", fx)).toBe(fx[1]);
    expect(findRelease("0.7", fx)).toBeNull();
  });
});

const hostile: Release[] = [
  {
    version: "0.2", date: "2026-02-01", title: "<img src=x onerror=alert(1)>", headline: "Head <script>",
    highlights: ["one", "two", "three"], headsUp: ["Run `npm run db:migrate:remote`"],
    patches: { added: ["`a` (#9)"], changed: [], fixed: ["<i>bad</i>"], removed: [] }, prs: [9],
  },
  {
    version: "0.1", date: "2026-01-01", title: "First", headline: "Hello",
    highlights: ["a", "b", "c"], patches: { added: ["x"], changed: ["y"], fixed: [], removed: ["z"] },
  },
];

describe("the index — the newest release featured, the rest on a timeline (the owner's redesign)", () => {
  it("features the newest release and lists every other on the timeline, each linking to its page, newest first", () => {
    const html = releasesIndex(withNext);
    const feat = [...html.matchAll(/<a href="(#releases\/[^"]+)"[^>]*class="cnpy-surface cnpy-relfeat/g)].map((m) => m[1]);
    expect(feat).toEqual(["#releases/unreleased"]);
    const rows = [...html.matchAll(/<a href="(#releases\/[^"]+)" class="cnpy-reltl-card/g)].map((m) => m[1]);
    expect(rows).toEqual(withNext.slice(1).map((r) => `#releases/${releaseSlug(r)}`));
    expect(html.indexOf("cnpy-relfeat")).toBeLessThan(html.indexOf("Earlier releases"));
    // the featured card carries every highlight; with no Unreleased entry it is the newest shipped one, "Latest release"
    const live = releasesIndex();
    for (const h of RELEASES[0].highlights) expect(live).toContain(esc(h).replace(/`([^`]+)`/g, (_m, c) => `<code${c.length <= 28 ? ' class="is-short"' : ""}>${c}</code>`));
    expect(live).toContain(RELEASES[0].unreleased ? "Coming next" : "Latest release");
  });

  it("tags Unreleased, and each release carries its change counts", () => {
    const html = releasesIndex(withNext);
    expect(html).toContain("cnpy-relfeat cnpy-rise is-next");
    expect(html).toContain("Coming next");
    const r = withNext.find((x) => !x.unreleased)!;
    for (const k of ["added", "changed", "fixed", "removed"] as const) {
      if (r.patches[k].length) expect(html).toContain(`<b>${r.patches[k].length}</b>${k}`);
    }
    expect(html).not.toContain("cnpy-guide-toc"); // no "On this page" rail on the index
  });

  it("escapes every string from the data", () => {
    const html = releasesIndex(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("one release — its notes page and its patches page, one reading column", () => {
  const picked = (html: string, label: string) => new RegExp(`aria-selected="true"[^>]*>${label}<`).test(html);
  it("the notes page: back link, header, the Release notes tab picked, counts, numbered highlights, Heads-up, newer/older", () => {
    const html = releasePageView("0.8", "notes");
    const r = findRelease("0.8")!;
    expect(html).toContain('href="#releases" class="cnpy-rel-back');
    expect(html).toContain("All releases");
    expect(html).toContain("v0.8 · Released");
    expect(html).toContain(`>${r.title}</h1>`);
    // The two pages are the page's sections: a tab bar under the title, the body its panel.
    expect(html).toContain('role="tablist" aria-label="Release page"');
    expect(picked(html, "Release notes")).toBe(true);
    expect(html).toContain('data-act="releasePage" data-arg="patches"');
    // In the brand banner, above the title — the site's pills (brand-banner.ts)
    expect(html.indexOf('class="cnpy-brandband site-banner"')).toBeLessThan(html.indexOf('role="tablist"'));
    expect(html.indexOf('role="tablist"')).toBeLessThan(html.indexOf('class="cnpy-brandband-h"'));
    expect(html).toContain('role="tabpanel" id="release-page-panel"');
    expect(releasePageView("0.99", "notes")).not.toContain('role="tablist"'); // not-found: none
    expect(html).toContain(">Highlights<");
    expect(html).toMatch(/<span class="cnpy-relhl-n" aria-hidden="true">01<\/span><p>/);
    expect(html).toContain('aria-label="Heads-up"');
    expect(html).not.toContain("/pull/");        // release notes carry no PR links
    expect(html).not.toContain("Upgrade notes");
    expect(html).not.toContain("cnpy-relpatch-group");
    expect(html).toContain('href="#releases/0.9"');
    expect(html).toContain('href="#releases/0.7"');
  });

  it("the counts open their group on the patch notes; 'All N patch lines' links there", () => {
    const notes = releasePageView("0.11", "notes");
    const r = findRelease("0.11")!;
    for (const k of ["added", "changed", "fixed", "removed"] as const) {
      expect(notes).toMatch(new RegExp(`data-act="releaseGroup" data-arg="${k}"[\\s\\S]*?<span class="cnpy-relstat-n">${r.patches[k].length}</span>`));
      expect(releasePageView("0.11", "patches")).toContain(`id="relgroup-${k}"`);
    }
    expect(releasePageView("0.10", "notes")).not.toContain('data-arg="fixed"'); // 0.10 has no fixes
    expect(notes).toContain('href="#releases/0.11/patches"');
    const five: Release[] = [{ ...hostile[1], highlights: ["a", "b", "c", "d", "e"] }];
    expect(releasePageView("0.1", "notes", five)).toContain("cnpy-relhl-list is-long");
  });

  it("the patches page: the Upgrade notes first, then Added / Changed / Fixed / Removed with counts, each line's PRs as chips", () => {
    const html = releasePageView("0.2", "patches", hostile);
    expect(picked(html, "Patch notes")).toBe(true);
    expect(html).toContain('<span>Added</span><span class="cnpy-relpatch-n">1</span>');
    expect(html).toContain(">Fixed<");
    expect(html).not.toContain(">Changed<");
    expect(html).not.toContain(">Removed<");
    expect(html).not.toContain(">Highlights<");
    expect(html).toContain("/pull/9");
    expect(html).toContain('href="#releases/0.1/patches"');
    expect(html).toContain("cnpy-relpager-i is-newer is-none");
    const p11 = releasePageView("0.11", "patches");
    const order = ["Added", "Changed", "Fixed", "Removed"].map((g) => p11.indexOf(`<span>${g}</span>`));
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]))).toBe(true);
    expect(p11.indexOf('aria-label="Upgrade notes"')).toBeLessThan(p11.indexOf('class="cnpy-relpatch-group"'));
    // a line's trailing (#N) is a chip at its right, not text in the sentence
    expect(p11).toMatch(/<span class="cnpy-relpatch-t">[^<]*<\/span><span class="cnpy-relpatch-prs"><a href="https:\/\/github\.com\/AndresL230\/trov\/pull\/\d+"[^>]*class="cnpy-relpr-chip">#\d+<\/a>/);
    expect(splitPatchLine("Fixed a thing (#12, #13)")).toEqual(["Fixed a thing", [12, 13]]);
    expect(splitPatchLine("No PR here")).toEqual(["No PR here", []]);
    expect(p11).toContain("Pull requests");
  });

  it("one reading column, no side column: the callouts flow in the page, no nested cards", () => {
    for (const page of ["notes", "patches"] as const) {
      for (const r of RELEASES) {
        const html = releasePageView(releaseSlug(r), page);
        expect((html.match(/class="[^"]*\bcnpy-surface\b/g) ?? []).length, `${r.version} ${page}`).toBeLessThanOrEqual(1);
        expect(html).not.toMatch(/cnpy-reldoc-grid|cnpy-relheads|cnpy-card\b/);
      }
    }
    expect(css).toMatch(/\.cnpy-reldoc \{ max-width:1040px;/);
    expect(releasePageView("0.3", "notes")).not.toContain('aria-label="Heads-up"'); // none: nothing drawn
    expect(releasePageView("0.2", "notes", hostile)).toContain('class="cnpy-relcall-one"');
    expect(releasePageView("0.11", "notes")).toContain('class="cnpy-relcall-list"');
  });

  it("inline code: a short token is marked to stay on one line, a long path is not", () => {
    expect(releaseLine("`board_rank` and `docs/superpowers/specs/2026-09-26-feed-brief-design.md`"))
      .toBe('<code class="is-short">board_rank</code> and <code>docs/superpowers/specs/2026-09-26-feed-brief-design.md</code>');
  });

  it("escapes every string on both pages", () => {
    for (const page of ["notes", "patches"] as const) {
      const html = releasePageView("0.2", page, hostile);
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("<script>");
      expect(html).not.toContain("<i>bad</i>");
    }
  });

  it("no release-notes view shows a PR link or an ops note; every patch notes page keeps them", () => {
    const index = releasesIndex();
    expect(index).not.toContain("/pull/");
    expect(index).not.toMatch(/migration|wrangler/i);
    for (const r of RELEASES) {
      const notes = releasePageView(releaseSlug(r), "notes");
      expect(notes, r.version).not.toContain("/pull/");
      expect(notes, r.version).not.toMatch(/db:migrate|wrangler|Apply migration/);
      const patches = releasePageView(releaseSlug(r), "patches");
      for (const n of r.prs ?? []) expect(patches, r.version).toContain(`/pull/${n}"`);
      if (r.ops?.length) {
        expect(patches, r.version).toContain("Upgrade notes</div>");
        expect(patches, r.version).toContain(releaseLine(r.ops[0]));
      }
    }
  });

  it("an unknown version is a friendly not-found with a link back", () => {
    const html = releasePageView("0.99", "notes");
    expect(html).toContain("No release called “0.99”");
    expect(html).toContain('href="#releases"');
    expect(releasePageView("<x>", "notes")).not.toContain("<x>");
  });

  it("releasesScreen is the index without a version, the page with one", () => {
    expect(releasesScreen(null, "notes")).toContain("cnpy-relidx");
    expect(releasesScreen("unreleased", "notes", withNext)).toContain("Not deployed yet");
    expect(releasesScreen(null, "notes").includes("Not deployed yet")).toBe(RELEASES[0]?.unreleased === true);
  });
});

describe("#releases routes", () => {
  const base = { screen: "releases", ticketId: null, sprintId: null };
  it("parses the index, a release, and its patches, and round-trips", () => {
    expect(parseHash("#releases")).toEqual(base);
    expect(parseHash("#releases/0.7")).toEqual({ ...base, releaseVersion: "0.7", releasePage: "notes" });
    expect(parseHash("#releases/0.7/patches")).toEqual({ ...base, releaseVersion: "0.7", releasePage: "patches" });
    expect(parseHash("#releases/Unreleased").releaseVersion).toBe("unreleased");
    for (const h of ["#releases", "#releases/0.7", "#releases/0.7/patches", "#releases/unreleased", "#releases/unreleased/patches"]) {
      expect(hashForRoute(parseHash(h))).toBe(h);
    }
    expect(hashForRoute(parseHash("#releases/0.7/notes"))).toBe("#releases/0.7");
  });

  it("legacy hashes: #releases/patches opens the newest release's patches; #releases/notes the index", () => {
    expect(parseHash("#releases/patches")).toEqual({ ...base, releaseVersion: releaseSlug(RELEASES[0]), releasePage: "patches" });
    expect(parseHash("#releases/notes")).toEqual(base);
  });

  it("an unknown version still routes (the page says not found); junk falls back to My Work", () => {
    expect(parseHash("#releases/0.99").releaseVersion).toBe("0.99");
    expect(parseHash("#releases/0.7/nope").screen).toBe("mywork");
    expect(parseHash("#releases/a/b/c").screen).toBe("mywork");
    expect(parseHash("#releases/%E0%A4%A").screen).toBe("mywork");
  });
});

describe("the release record loads lazily (release-latest.ts, releases-lazy.ts)", () => {
  it("LATEST_RELEASE is the first entry of RELEASES — the cut that changes one changes the other", () => {
    expect(LATEST_VERSION).toBe(RELEASES[0].version);
    expect(LATEST_RELEASE.version).toBe(RELEASES[0].version);
    expect(LATEST_RELEASE.slug).toBe(releaseSlug(RELEASES[0]));
  });

  it("no app module imports releases.ts as a value — only a type, or the dynamic import", () => {
    // The build-time readers keep the full import: docs-changelog.ts (the public changelog, prerendered).
    const BUILD_TIME = ["docs-changelog.ts"];
    for (const [file, src] of Object.entries(webSources)) {
      const name = file.split("/").pop()!;
      if (name === "releases.ts" || BUILD_TIME.includes(name)) continue;
      const imports = [...src.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"\.\/releases";/gm)];
      for (const m of imports) expect(m[1], `${name}: ${m[0]}`).toBeTruthy();
    }
    expect(webSources["../web/src/releases-lazy.ts"]).toContain('import("./releases")');
  });

  it("before the chunk is in, the screen is its skeleton in its own frame, and the crumb reads the slug", () => {
    setReleasesModule(null);
    expect(releasesLoaded()).toBeNull();
    const index = releasesView(null, "notes");
    expect(index).toContain('class="cnpy-relidx"');
    expect(index).toContain("What&#39;s new in Trov"); // the brand banner, escaped
    expect(index).toContain('data-skel="releases"');
    expect(index).toContain('aria-busy="true"');
    expect(index).not.toContain("cnpy-relfeat-title");
    const page = releasesView("0.7", "patches");
    expect(page).toContain('class="cnpy-reldoc"');
    expect(page).toContain('href="#releases" class="cnpy-rel-back"');
    expect(page).toContain('data-skel="release-page"');
    expect(releaseCrumb("0.7", "patches")).toBe("v0.7 · Patch notes");
    expect(releaseCrumb("0.25", "notes")).toBe("v0.25"); // an old number reads as typed until the record is in
    expect(releaseCrumb("unreleased", "notes")).toBe("Unreleased");
    expect(releaseCrumb(null, "notes")).toBe("");
  });

  it("once it is in, the screen is releasesScreen's", () => {
    setReleasesModule(releasesModule);
    expect(releasesView(null, "notes")).toBe(releasesScreen(null, "notes"));
    expect(releasesView("0.7", "notes")).toBe(releasesScreen("0.7", "notes"));
    expect(releaseCrumb("0.99", "notes")).toBe("0.99"); // not a release: the slug as typed
    expect(releaseCrumb("0.25", "patches")).toBe("v0.7 · Patch notes"); // an old number: the entry it lands on
  });
});

describe("the What's new screen in the app", () => {
  beforeAll(() => setReleasesModule(releasesModule));
  const app = (releaseVersion: string | null, releasePage: "notes" | "patches" = "notes") => render({
    ...initialState(), view: "app", screen: "releases", releaseVersion, releasePage,
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], org: "SaplingLearn", admin: false },
  } as unknown as ReturnType<typeof initialState>);

  it("the index: titled What's new, the featured release and the timeline, the sidebar entry lit, no switch", () => {
    const html = app(null);
    expect(html).toMatch(/<h1[^>]*>What's new<\/h1>/);
    expect(html).toContain("cnpy-relfeat");
    expect(html).toContain('class="cnpy-navrow n-releases is-active"');
    expect(html).not.toContain('data-seg="releases-view"');
    expect(html).not.toContain('aria-label="Release page"');     // no tabs on the index
  });

  it("a release page: the title is a back button, the crumb names the release, the entry stays lit", () => {
    const html = app("0.10", "patches");
    // The tabs are the PAGE's, under its title — never in the app's top bar.
    const top = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(top).not.toContain('aria-label="Release page"');
    expect(html).toMatch(/aria-selected="true"[^>]*>Patch notes</);
    expect(html).toContain('data-act="releasePage" data-arg="notes"');
    expect((html.match(/aria-label="Release page"/g) ?? []).length).toBe(1);
    expect(app("0.99")).not.toContain('aria-label="Release page"'); // not-found: no tabs
    expect(html).toContain('data-act="goReleases"');
    expect(html).toContain("v0.10 · Patch notes");
    expect(app("0.29")).toContain("v0.7<"); // an old link's crumb names the entry it lands on
    expect(html).toContain('class="cnpy-navrow n-releases is-active"');
    expect(html).toContain(">Added<");
  });
});
