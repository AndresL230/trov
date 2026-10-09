/**
 * Help › What's new (web/src/releases.ts): the RELEASES data, the index grid, each
 * release's two pages, the `#releases…` routes and the screen as the app renders it.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => s.replace(/</g, "&lt;"),
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import {
  RELEASES, releasesIndex, releasePageView, releasesScreen, releaseLine, releaseDate, releaseSlug, releaseHash,
  findRelease, prUrl, TROV_REPO_URL, type Release,
} from "../web/src/releases";
import { parseHash, hashForRoute } from "../web/src/hash";
import { render, initialState } from "../web/src/render";

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

  it("has unique versions and slugs, real ISO dates, and 0.N versions counting down to 0.1", () => {
    expect(new Set(RELEASES.map((r) => r.version)).size).toBe(RELEASES.length);
    expect(new Set(RELEASES.map(releaseSlug)).size).toBe(RELEASES.length);
    for (const r of RELEASES) {
      expect(r.date, r.version).toMatch(ISO);
      expect(Number.isNaN(Date.parse(`${r.date}T00:00:00Z`)), r.version).toBe(false);
    }
    const shipped = RELEASES.filter((r) => !r.unreleased).map((r) => r.version);
    for (const v of shipped) expect(v).toMatch(/^0\.\d+$/);
    const minors = shipped.map((v) => Number(v.split(".")[1]));
    for (let i = 1; i < minors.length; i++) expect(minors[i]).toBe(minors[i - 1] - 1);
    expect(minors[minors.length - 1]).toBe(1);
  });

  it("every release has a title, a headline, 3–6 highlights and at least one patch line", () => {
    for (const r of RELEASES) {
      expect(r.title.trim(), r.version).not.toBe("");
      expect(r.headline.trim(), r.version).not.toBe("");
      expect(r.highlights.length, r.version).toBeGreaterThanOrEqual(3);
      expect(r.highlights.length, r.version).toBeLessThanOrEqual(6);
      const lines = r.patches.added.length + r.patches.changed.length + r.patches.fixed.length + r.patches.removed.length;
      expect(lines, r.version).toBeGreaterThan(0);
    }
  });

  it("every PR a patch line cites is in that release's prs list", () => {
    for (const r of RELEASES) {
      const lines = [...r.patches.added, ...r.patches.changed, ...r.patches.fixed, ...r.patches.removed];
      const cited = new Set(lines.flatMap((l) => [...l.matchAll(/\((#\d+(?:, #\d+)*)\)/g)].flatMap((m) => m[1].split(", ").map((x) => Number(x.slice(1))))));
      for (const n of cited) expect(r.prs ?? [], `${r.version} cites #${n}`).toContain(n);
    }
  });

  it("names the migration an admin must run for 0.15 — in ops, not the users' heads-up", () => {
    const next = findRelease("0.15")!;
    expect(next.ops?.join(" ")).toMatch(/0035_library_and_sprint_dates/);
    expect(next.ops?.join(" ")).not.toMatch(/0036/);
    expect(next.headsUp?.join(" ")).toMatch(/800 characters/);
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
    expect(releaseSlug({ version: "0.14" })).toBe("0.14");
    expect(releaseSlug({ version: "Unreleased", unreleased: true })).toBe("unreleased");
    expect(releaseHash(null)).toBe("#releases");
    expect(releaseHash("0.14")).toBe("#releases/0.14");
    expect(releaseHash("0.14", "patches")).toBe("#releases/0.14/patches");
    expect(findRelease("UNRELEASED", withNext)?.unreleased).toBe(true);
    expect(findRelease("0.99")).toBeNull();
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

describe("the index — a grid of release cards", () => {
  it("renders every release as a card linking to its page, newest first", () => {
    const html = releasesIndex(withNext);
    expect(html).toContain('class="cnpy-relgrid"');
    const hrefs = [...html.matchAll(/<a href="(#releases\/[^"]+)"[^>]*class="cnpy-surface cnpy-card cnpy-relcard/g)].map((m) => m[1]);
    expect(hrefs).toEqual(withNext.map((r) => `#releases/${releaseSlug(r)}`));
    expect(hrefs[0]).toBe("#releases/unreleased");
  });

  it("tags Unreleased, and each card carries its count line", () => {
    const html = releasesIndex(withNext);
    expect(html).toContain("cnpy-relcard cnpy-rise is-next");
    expect(html).toContain(">Unreleased<");
    const r = withNext[1];
    const n = r.patches.added.length + r.patches.changed.length + r.patches.fixed.length + r.patches.removed.length;
    expect(html).toContain(`${r.highlights.length} highlights · ${n} patch lines`);
    expect(html).not.toContain("cnpy-guide-toc"); // no "On this page" rail on the index
  });

  it("escapes every string from the data", () => {
    const html = releasesIndex(hostile);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});

describe("one release — its notes page and its patches page", () => {
  it("the notes page: back link, header, Release notes picked, highlights, Heads-up, PRs, newer/older", () => {
    const html = releasePageView("0.14", "notes");
    const r = findRelease("0.14")!;
    expect(html).toContain('href="#releases" class="cnpy-rel-back"');
    expect(html).toContain("All releases");
    expect(html).toContain(">v0.14<");
    expect(html).toContain(`>${r.title}</h1>`);
    // The switch sits on the back link's row in the PAGE header, right after the back link.
    const row = html.slice(html.indexOf('class="cnpy-reldoc-toprow"'), html.indexOf('class="cnpy-reldoc-head-main"'));
    expect(row).toContain('class="cnpy-rel-back"');
    expect(row).toContain('data-seg="release-page"');
    expect(row).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Release notes</);
    expect(row).toContain('data-act="releasePage" data-arg="patches"');
    expect(releasePageView("0.13", "notes")).toContain('class="cnpy-reldoc-toprow"'); // no note: still there
    expect(releasePageView("0.99", "notes")).not.toContain('data-seg="release-page"'); // not-found: none
    expect(html).toContain(">Highlights<");
    expect(html).toContain("Heads-up");
    expect(html).not.toContain("/pull/");        // release notes carry no PR links
    expect(html).not.toContain("Upgrade notes");
    expect(html).not.toContain("cnpy-relpatch-group");       // no patch groups on the notes page
    // Newer = 0.15, older = 0.13, each keeping the page kind.
    expect(html).toContain('href="#releases/0.15"');
    expect(html).toContain('href="#releases/0.13"');
  });

  it("the patches page: Added / Changed / Fixed / Removed with counts; empty groups left out", () => {
    const html = releasePageView("0.2", "patches", hostile);
    expect(html).toContain('<span>Added</span><span class="cnpy-relpatch-n">1</span>');
    expect(html).toContain(">Fixed<");
    expect(html).not.toContain(">Changed<");
    expect(html).not.toContain(">Removed<");
    expect(html).not.toContain(">Highlights<");
    expect(html).toContain("/pull/9");
    // Older link stays on patches; the newest has no newer link.
    expect(html).toContain('href="#releases/0.1/patches"');
    expect(html).toContain("cnpy-relpager-i is-newer is-none");
  });

  it("each page is ONE wide surface card (no nested cards or boxes), the header outside it", () => {
    for (const page of ["notes", "patches"] as const) {
      for (const r of RELEASES) {
        const html = releasePageView(releaseSlug(r), page);
        expect((html.match(/class="[^"]*\bcnpy-surface\b/g) ?? []).length, `${r.version} ${page}`).toBe(1);
        expect(html).not.toContain("cnpy-card");
        expect(html.indexOf("cnpy-reldoc-head")).toBeLessThan(html.indexOf('class="cnpy-surface'));
      }
    }
    // Notes: the Heads-up lives in the PAGE HEADER (beside the title block, before the switch),
    // never inside the card; the card is the At a glance strip, then the highlights.
    const notes = releasePageView("0.14", "notes");
    expect(notes).not.toMatch(/cnpy-reldoc-split|cnpy-reldoc-side/);
    const at = (h: string, k: string) => h.indexOf(k);
    const card = at(notes, 'class="cnpy-surface');
    expect(notes).toContain("cnpy-reldoc-head cnpy-rise has-heads");
    expect(at(notes, 'class="cnpy-reldoc-head-main"')).toBeLessThan(at(notes, 'class="cnpy-relheads"'));
    expect(at(notes, 'class="cnpy-relheads"')).toBeLessThan(card);
    expect(notes.slice(card)).not.toContain("cnpy-relheads");
    expect(at(notes, 'class="cnpy-relglance"')).toBeLessThan(at(notes, "cnpy-reldoc-hl"));
    // The patch notes page puts its Upgrade notes in the same header spot — never in the card.
    const p14 = releasePageView("0.14", "patches");
    expect(p14).toContain("cnpy-reldoc-head cnpy-rise has-heads");
    expect(p14).toContain('class="cnpy-relheads" aria-label="Upgrade notes"');
    expect(p14).not.toContain('aria-label="Heads-up"');
    expect(p14.slice(p14.indexOf('class="cnpy-surface'))).not.toContain("cnpy-relheads");
    // One heads-up item is one line; several are a compact list; none renders nothing.
    expect(notes).toContain('class="cnpy-relheads-one"');
    expect(releasePageView("0.15", "notes")).toContain('class="cnpy-relheads-list"');
    expect(releasePageView("0.13", "notes")).not.toContain("cnpy-relheads");
    expect(releasePageView("0.13", "notes")).not.toContain("has-heads");
    // Five or more highlights may flow into two columns (a very wide card only).
    expect(notes).toContain("cnpy-reldoc-hl is-long");
    expect(releasePageView("0.2", "notes")).not.toContain("is-long");
    // At a glance: a full-width strip ABOVE the columns — version, date, one large figure per
    // non-empty group (each opening that group on the patch notes), the all-lines link.
    expect(notes).toContain('class="cnpy-relglance" aria-label="At a glance"');
    expect(notes.indexOf("cnpy-relglance")).toBeLessThan(notes.indexOf("cnpy-reldoc-hl"));
    const r14 = findRelease("0.14")!;
    for (const k of ["added", "changed", "fixed", "removed"] as const) {
      expect(notes).toMatch(new RegExp(`data-act="releaseGroup" data-arg="${k}"[\\s\\S]*?<span class="cnpy-relstat-n">${r14.patches[k].length}</span>`));
      expect(releasePageView("0.14", "patches")).toContain(`id="relgroup-${k}"`);
    }
    expect(releasePageView("0.12", "notes")).not.toContain('data-arg="fixed"'); // 0.12 has no fixes
    expect(notes).toContain('href="#releases/0.14/patches"');
    const patches = releasePageView("0.14", "patches");
    // Patches: the groups STACKED in order (no side-by-side columns), a long group marked for
    // two balanced columns at most, PRs as chips; the card STARTS with the groups.
    const order = ["Added", "Changed", "Fixed", "Removed"].map((g) => patches.indexOf(`<span>${g}</span>`));
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]))).toBe(true);
    expect((patches.match(/class="cnpy-relpatch-group"/g) ?? []).length).toBe(4);
    expect(patches).not.toContain("--cols");
    expect(patches).toContain('class="cnpy-relpatch-list is-long"');
    expect(patches.slice(patches.indexOf('class="cnpy-surface')).search(/<[a-z]+ class="cnpy-relpatch-group"/))
      .toBeLessThan(200);
    expect(patches).toContain('class="cnpy-relpr-chip"');
    const row = notes.slice(notes.indexOf('class="cnpy-relheads"'), notes.indexOf("</aside>", notes.indexOf('class="cnpy-relheads"')));
    expect(row).toContain("Heads-up");
    expect(row).not.toMatch(/--amber|color-mix/);
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
        expect(patches, r.version).toContain(">Upgrade notes<");
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
    expect(releasesScreen(null, "notes")).toContain("cnpy-relgrid");
    expect(releasesScreen("unreleased", "notes", withNext)).toContain("Not deployed yet");
    // The live index shows "Not deployed yet" exactly while the data carries an Unreleased entry (a branch
    // between its first shipped change and the merge that cuts the version).
    expect(releasesScreen(null, "notes").includes("Not deployed yet")).toBe(RELEASES[0]?.unreleased === true);
  });
});

describe("#releases routes", () => {
  const base = { screen: "releases", ticketId: null, sprintId: null };
  it("parses the index, a release, and its patches, and round-trips", () => {
    expect(parseHash("#releases")).toEqual(base);
    expect(parseHash("#releases/0.14")).toEqual({ ...base, releaseVersion: "0.14", releasePage: "notes" });
    expect(parseHash("#releases/0.14/patches")).toEqual({ ...base, releaseVersion: "0.14", releasePage: "patches" });
    expect(parseHash("#releases/Unreleased").releaseVersion).toBe("unreleased");
    for (const h of ["#releases", "#releases/0.14", "#releases/0.14/patches", "#releases/unreleased", "#releases/unreleased/patches"]) {
      expect(hashForRoute(parseHash(h))).toBe(h);
    }
    expect(hashForRoute(parseHash("#releases/0.14/notes"))).toBe("#releases/0.14");
  });

  it("legacy hashes: #releases/patches opens the newest release's patches; #releases/notes the index", () => {
    expect(parseHash("#releases/patches")).toEqual({ ...base, releaseVersion: releaseSlug(RELEASES[0]), releasePage: "patches" });
    expect(parseHash("#releases/notes")).toEqual(base);
  });

  it("an unknown version still routes (the page says not found); junk falls back to My Work", () => {
    expect(parseHash("#releases/0.99").releaseVersion).toBe("0.99");
    expect(parseHash("#releases/0.14/nope").screen).toBe("mywork");
    expect(parseHash("#releases/a/b/c").screen).toBe("mywork");
    expect(parseHash("#releases/%E0%A4%A").screen).toBe("mywork");
  });
});

describe("the What's new screen in the app", () => {
  const app = (releaseVersion: string | null, releasePage: "notes" | "patches" = "notes") => render({
    ...initialState(), view: "app", screen: "releases", releaseVersion, releasePage,
    me: { handle: "alice", name: "Alice", avatar_url: null, color: "stone", identities: [], org: "SaplingLearn", admin: false },
  } as unknown as ReturnType<typeof initialState>);

  it("the index: titled What's new, the grid, the sidebar entry lit, no global switch", () => {
    const html = app(null);
    expect(html).toMatch(/<h1[^>]*>What's new<\/h1>/);
    expect(html).toContain("cnpy-relgrid");
    expect(html).toContain('class="cnpy-navrow n-releases is-active"');
    expect(html).not.toContain('data-seg="releases-view"');
    expect(html).not.toContain('data-seg="release-page"');     // no switch on the index
  });

  it("a release page: the title is a back button, the crumb names the release, the entry stays lit", () => {
    const html = app("0.14", "patches");
    // The switch is in the PAGE header's back-link row — never in the app's top bar.
    const top = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(top).not.toContain('data-seg="release-page"');
    const row = html.slice(html.indexOf('class="cnpy-reldoc-toprow"'), html.indexOf('class="cnpy-reldoc-head-main"'));
    expect(row).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Patch notes</);
    expect(row).toContain('data-act="releasePage" data-arg="notes"');
    expect((html.match(/data-seg="release-page"/g) ?? []).length).toBe(1);
    expect(app("0.99")).not.toContain('data-seg="release-page"'); // not-found: no switch
    expect(html).toContain('data-act="goReleases"');
    expect(html).toContain("v0.14 · Patch notes");
    expect(html).toContain('class="cnpy-navrow n-releases is-active"');
    expect(html).toContain(">Added<");
  });
});
