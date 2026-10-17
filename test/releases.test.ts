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
  findRelease, releaseName, prUrl, TROV_REPO_URL, RELEASE_CAPS, type Release,
} from "../web/src/releases";
import * as releasesModule from "../web/src/releases";
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

  it("keeps the deploy steps of 0.11: every migration, the App events, the plugin", () => {
    const ops = (v: string) => findRelease(v)!.ops!.join(" ");
    // 0.11 (formerly 0.34) is #178 cut together with #186 / #187: its own migrations to 0068, the App events, the plugin.
    expect(ops("0.11")).toMatch(/0058_server_ai/);
    expect(ops("0.11")).toMatch(/deployment, release, create and workflow_job/);
    expect(ops("0.11")).toMatch(/plugin 0\.9\.0/);
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
    expect(notes).toContain(">v0.7<");
    // `#releases/0.34/patches`: the old number of the newest batch opens 0.11's patch notes.
    expect(parseHash("#releases/0.34/patches")).toMatchObject({ releaseVersion: "0.34", releasePage: "patches" });
    expect(findRelease("0.34")!.version).toBe("0.11");
    expect(releasePageView("0.34", "patches")).toContain('aria-label="Patch notes"');
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
    const r = withNext.find((x) => !x.unreleased)!; // the newest shipped card (a live Unreleased entry may sit before it)
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
    const html = releasePageView("0.8", "notes");
    const r = findRelease("0.8")!;
    expect(html).toContain('href="#releases" class="cnpy-rel-back"');
    expect(html).toContain("All releases");
    expect(html).toContain(">v0.8<");
    expect(html).toContain(`>${r.title}</h1>`);
    // The switch sits on the back link's row, right after the back link.
    const row = html.slice(html.indexOf('class="cnpy-reldoc-toprow'), html.indexOf('class="cnpy-reldoc-head-main"'));
    expect(row).toContain('class="cnpy-rel-back"');
    expect(row).toContain('data-seg="release-page"');
    expect(row).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Release notes</);
    expect(row).toContain('data-act="releasePage" data-arg="patches"');
    expect(releasePageView("0.3", "notes")).toContain('class="cnpy-reldoc-toprow'); // no note: still there
    expect(releasePageView("0.99", "notes")).not.toContain('data-seg="release-page"'); // not-found: none
    expect(html).toContain(">Highlights<");
    expect(html).toContain("Heads-up");
    expect(html).not.toContain("/pull/");        // release notes carry no PR links
    expect(html).not.toContain("Upgrade notes");
    expect(html).not.toContain("cnpy-relpatch-group");       // no patch groups on the notes page
    // Newer = 0.9, older = 0.7, each keeping the page kind.
    expect(html).toContain('href="#releases/0.9"');
    expect(html).toContain('href="#releases/0.7"');
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
    // Notes: the Heads-up is in the page's right column (after the title block, before the card),
    // never inside the card; the card is the At a glance strip, then the highlights.
    const notes = releasePageView("0.11", "notes");
    expect(notes).not.toMatch(/cnpy-reldoc-split|cnpy-reldoc-side/);
    const at = (h: string, k: string) => h.indexOf(k);
    const card = at(notes, 'class="cnpy-surface');
    expect(notes).toContain('class="cnpy-reldoc-grid has-heads"');
    expect(at(notes, 'class="cnpy-reldoc-head-main"')).toBeLessThan(at(notes, 'class="cnpy-relheads'));
    expect(at(notes, 'class="cnpy-relheads')).toBeLessThan(card);
    expect(notes.slice(card)).not.toContain("cnpy-relheads");
    expect(at(notes, 'class="cnpy-relglance"')).toBeLessThan(at(notes, "cnpy-reldoc-hl"));
    // The patch notes page puts its Upgrade notes in the same spot — never in the card.
    const p14 = releasePageView("0.11", "patches");
    expect(p14).toContain('class="cnpy-reldoc-grid has-heads"');
    expect(p14).toContain('class="cnpy-relheads cnpy-rise" aria-label="Upgrade notes"');
    expect(p14).not.toContain('aria-label="Heads-up"');
    expect(p14.slice(p14.indexOf('class="cnpy-surface'))).not.toContain("cnpy-relheads");
    // One heads-up item is one line; several are a compact list; none renders nothing.
    expect(releasePageView("0.2", "notes", hostile)).toContain('class="cnpy-relheads-one"');
    expect(notes).toContain('class="cnpy-relheads-list"');
    expect(releasePageView("0.3", "notes")).not.toContain("cnpy-relheads");
    expect(releasePageView("0.3", "notes")).not.toContain("has-heads");
    // Five or more highlights may flow into two columns (a very wide card only) — the data stays
    // under RELEASE_CAPS, so only a fixture has that many.
    const five: Release[] = [{ ...hostile[1], highlights: ["a", "b", "c", "d", "e"] }];
    expect(releasePageView("0.1", "notes", five)).toContain("cnpy-reldoc-hl is-long");
    expect(notes).not.toContain("cnpy-reldoc-hl is-long");
    // At a glance: a full-width strip ABOVE the columns — version, date, one large figure per
    // non-empty group (each opening that group on the patch notes), the all-lines link.
    expect(notes).toContain('class="cnpy-relglance" aria-label="At a glance"');
    expect(notes.indexOf("cnpy-relglance")).toBeLessThan(notes.indexOf("cnpy-reldoc-hl"));
    const r14 = findRelease("0.11")!;
    for (const k of ["added", "changed", "fixed", "removed"] as const) {
      expect(notes).toMatch(new RegExp(`data-act="releaseGroup" data-arg="${k}"[\\s\\S]*?<span class="cnpy-relstat-n">${r14.patches[k].length}</span>`));
      expect(releasePageView("0.11", "patches")).toContain(`id="relgroup-${k}"`);
    }
    expect(releasePageView("0.10", "notes")).not.toContain('data-arg="fixed"'); // 0.10 has no fixes
    expect(notes).toContain('href="#releases/0.11/patches"');
    const patches = releasePageView("0.11", "patches");
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
    const row = notes.slice(notes.indexOf('class="cnpy-relheads'), notes.indexOf("</aside>", notes.indexOf('class="cnpy-relheads')));
    expect(row).toContain("Heads-up");
    expect(row).not.toMatch(/--amber|color-mix/);
  });

  // #188: the page's note (Heads-up / Upgrade notes) once sat in the HEADER grid beside the title, so
  // the body started under the note — 2,000px down on a long Upgrade notes list. It is now a SIBLING
  // of the body in one two-column grid, and trov.css puts it in a column that spans the body's rows.
  it("the note and the body are siblings in ONE two-column grid, never body-after-header (#188)", () => {
    const VOID = new Set(["br", "img", "input", "hr", "meta", "link", "source", "wbr"]);
    /** The direct children of the first element whose class list has `cls`: "tag.firstClass". */
    const childrenOf = (html: string, cls: string): string[] => {
      const start = html.search(new RegExp(`<[a-z]+ [^>]*class="${cls}[" ]`));
      const out: string[] = [];
      let depth = 0;
      for (const m of html.slice(start).matchAll(/<(\/?)([a-z][a-z0-9]*)([^>]*)>/g)) {
        const [, close, tag, rest] = m;
        if (close) { if (--depth === 0) break; continue; }
        if (depth === 1) out.push(`${tag}.${/class="([^" ]+)/.exec(rest)?.[1] ?? ""}`);
        if (!VOID.has(tag) && !rest.endsWith("/")) depth++;
      }
      return out;
    };
    for (const [slug, page, label] of [["0.4", "notes", "Heads-up"], ["0.4", "patches", "Upgrade notes"]] as const) {
      const html = releasePageView(slug, page);
      expect(html).toContain('class="cnpy-reldoc-grid has-heads"');
      expect(childrenOf(html, "cnpy-reldoc-grid"), `${slug} ${page}`)
        .toEqual(["div.cnpy-reldoc-toprow", "header.cnpy-reldoc-head", "aside.cnpy-relheads", "article.cnpy-surface", "nav.cnpy-relpager"]);
      // The header is the title block only: no note, no body inside it.
      const head = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
      expect(head).not.toContain("cnpy-relheads");
      expect(head).not.toContain(label);
      expect(head).not.toContain("cnpy-surface");
    }
    // No note: the same grid, one column, no aside.
    expect(childrenOf(releasePageView("0.3", "notes"), "cnpy-reldoc-grid"))
      .toEqual(["div.cnpy-reldoc-toprow", "header.cnpy-reldoc-head", "article.cnpy-surface", "nav.cnpy-relpager"]);
    // The CSS: from 900px of page the note's area spans the title, body and pager rows, and the LAST
    // row is the flexible one, so the note's height never grows the title's or the body's row.
    const block = css.slice(css.indexOf("@container reldoc (min-width: 900px)"));
    expect(block).toMatch(/grid-template-rows:auto auto auto 1fr;/);
    expect(block).toMatch(/grid-template-areas:"top top" "head side" "body side" "pager side";/);
    expect(block).toMatch(/\.cnpy-reldoc-grid\.has-heads > \.cnpy-relheads \{ grid-area:side; \}/);
    expect(block).toMatch(/\.cnpy-reldoc-grid\.has-heads > \.cnpy-reldoc-card \{ grid-area:body; \}/);
    // And nothing sticks or scrolls inside itself: the note flows with the page.
    expect(css).not.toMatch(/\.cnpy-relheads[^{]*\{[^}]*(position:sticky|overflow(-y)?:auto)/);
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
    expect(index).toContain("What's new in Trov");
    expect(index).toContain('data-skel="releases"');
    expect(index).toContain('aria-busy="true"');
    expect(index).not.toContain("cnpy-relcard-title");
    const page = releasesView("0.7", "patches");
    expect(page).toContain('class="cnpy-reldoc"');
    expect(page).toContain('href="#releases" class="cnpy-rel-back"');
    expect(page).toContain('data-skel="release-body"');
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

  it("the index: titled What's new, the grid, the sidebar entry lit, no global switch", () => {
    const html = app(null);
    expect(html).toMatch(/<h1[^>]*>What's new<\/h1>/);
    expect(html).toContain("cnpy-relgrid");
    expect(html).toContain('class="cnpy-navrow n-releases is-active"');
    expect(html).not.toContain('data-seg="releases-view"');
    expect(html).not.toContain('data-seg="release-page"');     // no switch on the index
  });

  it("a release page: the title is a back button, the crumb names the release, the entry stays lit", () => {
    const html = app("0.10", "patches");
    // The switch is in the PAGE header's back-link row — never in the app's top bar.
    const top = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(top).not.toContain('data-seg="release-page"');
    const row = html.slice(html.indexOf('class="cnpy-reldoc-toprow'), html.indexOf('class="cnpy-reldoc-head-main"'));
    expect(row).toMatch(/class="cnpy-seg-btn is-on"[^>]*aria-pressed="true">Patch notes</);
    expect(row).toContain('data-act="releasePage" data-arg="notes"');
    expect((html.match(/data-seg="release-page"/g) ?? []).length).toBe(1);
    expect(app("0.99")).not.toContain('data-seg="release-page"'); // not-found: no switch
    expect(html).toContain('data-act="goReleases"');
    expect(html).toContain("v0.10 · Patch notes");
    expect(app("0.29")).toContain("v0.7<"); // an old link's crumb names the entry it lands on
    expect(html).toContain('class="cnpy-navrow n-releases is-active"');
    expect(html).toContain(">Added<");
  });
});
