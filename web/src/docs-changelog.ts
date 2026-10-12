// ── The public changelog (/docs/changelog), from web/src/releases.ts ────────
// The release NOTES only — each release's title, headline, highlights and heads-up, which that file's
// header says are written for Trov's users. Never its `ops` (deploy steps) or `patches` (the builders' log):
// those stay in the app's patch notes. A release not deployed yet (`unreleased`) is left out — what is on
// trov.dev is what has shipped. PURE.

import type { SitePage } from "@shared/site-pages";
import { RELEASES, type Release } from "./releases";
import { TROV_REPO } from "./site-chrome";

/** The releases the public changelog shows: every deployed one, newest first (the file's own order). */
export const publicReleases = (releases: readonly Release[] = RELEASES): Release[] => releases.filter((r) => !r.unreleased);

function release(r: Release): string {
  return [
    `## ${r.version}: ${r.title}`,
    `Released ${r.date}. ${r.headline}`,
    r.highlights.map((h) => `- ${h}`).join("\n"),
    r.headsUp?.length ? `**You will notice:**\n\n${r.headsUp.map((h) => `- ${h}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
}

export function changelogMarkdown(page: SitePage, releases: readonly Release[] = RELEASES): string {
  return [
    `# Changelog\n\n${page.description}`,
    `Each release says what you can now do and what you will notice. The full patch notes, with links to every pull request, are in the app under Help › What's new, and the code is on [GitHub](${TROV_REPO}).`,
    ...publicReleases(releases).map(release),
  ].join("\n\n");
}
