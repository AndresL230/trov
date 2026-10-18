// Help › What's new, loaded when it is opened. releases.ts holds every release's notes and patch
// lines (~68 KB since #190 trimmed it; every PR adds a line), so the app bundle does not carry it: the screen is
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

/** `#releases` while the chunk is out: the index's head, the featured card's shape and timeline rows. */
function indexSkeleton(): string {
  const row = (i: number) => `<li class="cnpy-reltl-item">
      <div class="cnpy-reltl-rail" style="align-items:flex-end">${skLine(48, 13, 1.4)}${skLine(80, 12, 1.4)}</div>
      <div class="cnpy-reltl-card">${skLine(skW(i, ["52%", "40%", "60%"]), 16.5, 1.35)}<div style="margin-top:8px">${skLines(["92%", skW(i, ["58%", "44%", "66%"])], 13.5, 1.6)}</div></div>
    </li>`;
  return `<div class="cnpy-relidx">
    <div class="cnpy-relidx-head">
      <h1 class="cnpy-relidx-title">What's new in Trov</h1>
      <div style="margin-top:10px">${skLines(["100%", "88%", "46%"], 14.5, 1.6)}</div>
    </div>
    ${skeleton("releases", "Loading releases…", `<div${surface("", { cls: "cnpy-relfeat" })}>
        ${skLine(160, 12.5, 1.5)}<div style="margin-top:14px">${skLine("54%", 26, 1.25)}</div><div style="margin-top:10px">${skLines(["86%", "60%"], 15, 1.6)}</div>
        <div class="cnpy-relfeat-hl">${skList(4, (i) => `<div>${skLines(["100%", skW(i, ["70%", "52%", "80%", "60%"])], 13.5, 1.6)}</div>`)}</div>
      </div>
      <div class="cnpy-reltl"><ol class="cnpy-reltl-list">${skList(4, row)}</ol></div>`)}
  </div>`;
}

/** `#releases/<v>` while the chunk is out: the back link, the title block's shape and the page's lines. */
function pageSkeleton(): string {
  return `<div class="cnpy-reldoc">
    <a href="#releases" class="cnpy-rel-back">${ARROW_L}All releases</a>
    ${skeleton("release-page", "Loading the release…", `<div class="cnpy-reldoc-head">${skLine(120, 12.5, 1.5)}<div style="margin-top:10px">${skLine("48%", 32, 1.2)}</div><div style="margin-top:12px">${skLines(["70%", "46%"], 16, 1.6)}</div></div>
      <div style="margin-top:30px">${skLine(220, 14, 1.5)}</div>
      <div class="cnpy-relhl-list" style="margin-top:28px">${skList(4, (i) => `<div style="padding:18px 0;border-top:1px solid var(--border)">${skLines(["94%", skW(i, ["72%", "56%", "80%", "64%"])], 15, 1.65)}</div>`)}</div>`)}
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

/** The header's "›" crumb on a release page: "v0.10", "v0.1", "Unreleased", with " · Patch notes".
 *  Before the chunk is in it is read off the slug (a slug IS the version, or "unreleased"); once
 *  it is, an old pre-renumbering link (`#releases/0.25`) reads as the release it lands on ("v0.7"). */
export function releaseCrumb(slug: string | null, page: ReleasePage): string {
  if (!slug) return "";
  let name: string;
  if (mod) {
    const r = mod.findRelease(slug);
    name = r ? mod.releaseName(r) : slug;
  } else {
    name = slug === "unreleased" ? "Unreleased" : `v${slug}`;
  }
  return page === "patches" ? `${name} · Patch notes` : name;
}
