// Issue/PR references in prose, as a pure matcher (no marked, no DOM) so it can
// be unit-tested: markdown.ts feeds it to marked as an inline extension.
//
//   #123                 → this org's primary repo (github.ts `repoUrl()`); with no
//                          repository connected it is not a reference at all
//   owner/repo#123       → THAT repo — never the org's own. Linking the `#123` of
//                          `AndresL230/trov#51` to another repo's issue 51 sends
//                          the reader to the wrong issue.

const CROSS = /^([A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)#(\d+)\b/;
const BARE = /^#(\d+)\b/;
const ANY = /(?:[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+)?#\d/;

export interface IssueRef { raw: string; href: string; text: string }

/** Where the next reference MAY start in `src` (marked cuts its text token there). */
export function issueRefStart(src: string): number | undefined {
  const m = ANY.exec(src);
  return m ? m.index : undefined;
}

/** The reference `src` STARTS with, or null. `repoUrl` has no trailing slash; null = the org
 *  has no repository, so only an `owner/repo#N` matches. */
export function matchIssueRef(src: string, repoUrl: string | null): IssueRef | null {
  const cross = CROSS.exec(src);
  if (cross) return { raw: cross[0], href: `https://github.com/${cross[1]}/issues/${cross[2]}`, text: cross[0] };
  const bare = BARE.exec(src);
  if (bare && repoUrl) return { raw: bare[0], href: `${repoUrl}/issues/${bare[1]}`, text: bare[0] };
  return null;
}
