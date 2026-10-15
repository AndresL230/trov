// Help › What's new, loaded when it is opened. releases.ts holds every release's notes and patch
// lines (~185 KB, and every PR adds to it), so the app bundle does not carry it: the screen is
// rendered from `import("./releases")` (its own chunk), with a skeleton in the screen's own frame
// until the chunk is in — the pattern of the Repo screen's sample data (repo-sample.ts). Nothing
// else in the app imports releases.ts as a value; the newest version is release-latest.ts.
// The build-time readers (docs-changelog.ts, the tests) import releases.ts itself.
//
// `loadReleases()` is started by main.ts whenever a paint lands on the screen without it, and the
// screen repaints when it arrives (`rerenderSoon`). A chunk that fails to load (an old page after
// a deploy, whose chunk names are gone) says so, with what to do — reload — and is not retried in
// a loop.
import type * as ReleasesModule from "./releases";
import type { ReleasePage } from "./releases";
import { skeleton, skLine, skLines, skList, skW } from "./skeleton";
import { surface } from "./ui";

type Releases = typeof ReleasesModule;

let mod: Releases | null = null;
let inflight: Promise<Releases> | null = null;
let failed = false;

/** The loaded module, or null while it is not in. */
export const releasesLoaded = (): Releases | null => mod;
/** The last load failed (the screen says so; a reload tries again). */
export const releasesFailed = (): boolean => failed;

/** Start (or join) the chunk's load. Resolves once it is in; rejects if it failed. */
export function loadReleases(): Promise<Releases> {
  if (mod) return Promise.resolve(mod);
  inflight ??= import("./releases").then(
    (m) => { mod = m; failed = false; return m; },
    (e: unknown) => { inflight = null; failed = true; throw e; },
  );
  return inflight;
}

/** For tests: hand in the module as if it had loaded (or forget it with null). */
export function setReleasesModule(m: Releases | null): void {
  mod = m;
  inflight = null;
  failed = false;
}

const ARROW_L = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M19 12H5M11 18l-6-6 6-6"></path></svg>`;

/** `#releases` while the chunk is out: the index's head and a grid of card shapes. */
function indexSkeleton(): string {
  const card = (i: number) => `<div${surface(`--i:${Math.min(i, 8)}`, { cls: "cnpy-relcard" })}>
      ${skLine(skW(i, [96, 120, 104]), 12.5, 1.5)}
      <div style="margin-top:10px">${skLine(skW(i, ["70%", "56%", "82%", "64%"]), 16, 1.35)}</div>
      <div style="margin-top:8px;flex:1">${skLines(["100%", "92%", skW(i, ["58%", "40%", "66%"])], 13.5, 1.6)}</div>
      <div class="cnpy-relcard-foot">${skLine(150, 12.5, 1.5)}</div>
    </div>`;
  return `<div class="cnpy-relidx">
    <div class="cnpy-relidx-head">
      <h1 class="cnpy-relidx-title">What's new in Trov</h1>
      <div style="margin-top:10px">${skLines(["100%", "88%", "46%"], 14.5, 1.6)}</div>
    </div>
    ${skeleton("releases", "Loading releases…", `<div class="cnpy-relgrid">${skList(6, card)}</div>`)}
  </div>`;
}

/** `#releases/<v>` while the chunk is out: the page's back link, its title block and the card. */
function pageSkeleton(): string {
  return `<div class="cnpy-reldoc">
    <header class="cnpy-reldoc-head">
      <div class="cnpy-reldoc-toprow"><a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a></div>
      ${skeleton("release-head", "Loading the release…", `<div class="cnpy-reldoc-head-main">${skLine(120, 12.5, 1.5)}${skLine("48%", 32, 1.15)}${skLines(["86%", "62%"], 17, 1.6)}</div>`)}
    </header>
    <div${surface("--i:1", { cls: "cnpy-reldoc-card" })}>
      ${skeleton("release-body", "Loading the release notes…", `<div style="padding:28px 32px">${skList(5, (i) => `<div style="margin-top:${i ? 14 : 0}px">${skLine(skW(i, ["84%", "72%", "90%", "66%", "78%"]), 14.5, 1.6)}</div>`)}</div>`)}
    </div>
  </div>`;
}

function failedView(): string {
  return `<div class="cnpy-relidx">
    <div class="cnpy-relidx-head">
      <h1 class="cnpy-relidx-title">What's new in Trov</h1>
      <p class="cnpy-relidx-intro" role="status">The release notes did not load. Reload the page to try again.</p>
    </div>
  </div>`;
}

/** The `releases` screen: the real one once the chunk is in, its skeleton until then. */
export function releasesView(slug: string | null, page: ReleasePage): string {
  if (mod) return mod.releasesScreen(slug, page);
  if (failed) return failedView();
  return slug ? pageSkeleton() : indexSkeleton();
}

/** The header's "›" crumb on a release page: "v0.14", "Unreleased", with " · Patch notes".
 *  Before the chunk is in it is read off the slug (a slug IS the version, or "unreleased"). */
export function releaseCrumb(slug: string | null, page: ReleasePage): string {
  if (!slug) return "";
  let name: string;
  if (mod) {
    const r = mod.findRelease(slug);
    name = r ? (r.unreleased ? "Unreleased" : `v${r.version}`) : slug;
  } else {
    name = slug === "unreleased" ? "Unreleased" : `v${slug}`;
  }
  return page === "patches" ? `${name} · Patch notes` : name;
}
