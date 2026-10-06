// The GitHub repository the org on screen tracks — its PRIMARY repo, from `GET /api/o/:slug/me`
// (`repos.primary`, canopy-multitenancy.md §9). It is what a bare `#214`, a PR number or a commit
// sha in a feed entry links to. One module-level value, set once by main.ts when the org's read
// lands: the markdown renderer's `#123` extension runs outside any state, so it reads it here.
// Null until then — and for an org with no repository connected — and then a bare reference is
// plain text, never a link to somebody else's repository.
let primary: string | null = null;

/** `owner/repo`, or null to clear it. */
export function setPrimaryRepo(fullName: string | null): void { primary = fullName && /^[^/\s]+\/[^/\s]+$/.test(fullName) ? fullName : null; }
/** `owner/repo` of the org's primary repository, or null. */
export const primaryRepo = (): string | null => primary;
/** Its GitHub URL (no trailing slash), or null when no repository is connected. */
export const repoUrl = (): string | null => (primary ? `https://github.com/${primary}` : null);
