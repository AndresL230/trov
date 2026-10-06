// Issue/PR references in prose, as a pure matcher (no marked, no DOM) so it can
// be unit-tested: markdown.ts feeds it to marked as an inline extension.
//
//   #123                 → this org's main repo (REPO_URL)
//   owner/repo#123       → THAT repo — never REPO_URL. Linking the `#123` of
//                          `AndresL230/trov#51` to the sapling repo's issue
//                          51 sends the reader to the wrong issue.

const CROSS = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)\b/;
const BARE = /^#(\d+)\b/;
const ANY = /(?:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)?#\d/;

export interface IssueRef { raw: string; href: string; text: string }

/** Where the next reference MAY start in `src` (marked cuts its text token there). */
export function issueRefStart(src: string): number | undefined {
  const m = ANY.exec(src);
  return m ? m.index : undefined;
}

/** The reference `src` STARTS with, or null. `repoUrl` has no trailing slash. */
export function matchIssueRef(src: string, repoUrl: string): IssueRef | null {
  const cross = CROSS.exec(src);
  if (cross) return { raw: cross[0], href: `https://github.com/${cross[1]}/issues/${cross[2]}`, text: cross[0] };
  const bare = BARE.exec(src);
  if (bare) return { raw: bare[0], href: `${repoUrl}/issues/${bare[1]}`, text: bare[0] };
  return null;
}
