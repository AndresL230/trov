// The newest release's version, without the record. web/src/releases.ts (every release's notes and
// patch lines, ~185 KB and growing with every PR) is loaded only when Help › What's new opens
// (releases-lazy.ts), so what the app needs at boot reads this instead: the support form's attached
// version (main.ts) and the legacy `#releases/patches` route (hash.ts).
//
// Kept by hand, and pinned to `RELEASES[0]` by test/releases.test.ts, so it cannot drift: the PR that
// opens an "Unreleased" entry sets it to "Unreleased", and the PR that cuts that entry into the next
// `0.N` sets it to "0.N" (the releases.ts header says when).
export const LATEST_VERSION: string = "Unreleased";

/** The newest release: its version and its URL segment (releases.ts `releaseSlug`). */
export const LATEST_RELEASE: { readonly version: string; readonly slug: string } = {
  version: LATEST_VERSION,
  slug: LATEST_VERSION === "Unreleased" ? "unreleased" : LATEST_VERSION.toLowerCase(),
};
