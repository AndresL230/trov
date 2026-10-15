// The App menu's narrowing of the Code and CI tabs (Repo setups, Phase E) — the rules ONE place, for the server's
// projection (src/tools/repo-scope.ts) and the SPA's wording (web/src/repo.ts) and sample. Zod-free, pure.
//
// What a pull request (or a commit, or a run) "touches" is the apps whose watch paths its changed files hit
// (`touches`, app keys — not Packages) and the Package apps they hit (`packages`). It REACHES an app when it touches it,
// or touches a Package that app uses (`usedBy`) — "via packages/ui". Under "Repo-wide only" (`REPO_WIDE`) it belongs
// when it touches no app and no package. Unknown (`touches: null`, files never read) belongs to no app and not to
// "Repo-wide only": it is shown under All apps alone, with no "touches" line — never guessed into an app.
import { REPO_WIDE } from "./repo-facts-core";

export interface ScopeApp { key: string; kind: string; usedBy: string[] | null }
export interface Touch { touches: string[] | null; packages?: string[] }

/** Does it belong under the App menu's `app` (an app key or `REPO_WIDE`)? `null` = unknown: its files were never
 *  read — or the list was cut short and nothing in it decides (`complete: false`). */
export function inScope(t: Touch, app: string, apps: readonly ScopeApp[], complete = true): boolean | null {
  if (t.touches === null) return null;
  const pk = t.packages ?? [];
  if (app === REPO_WIDE) return t.touches.length || pk.length ? false : complete ? true : null;
  if (reaches(t, app, apps)) return true;
  return complete ? false : null;
}

/** It touches `app` directly, touches it as a Package, or touches a Package `app` uses. */
export function reaches(t: Touch, app: string, apps: readonly ScopeApp[]): boolean {
  if (t.touches === null) return false;
  if (t.touches.includes(app)) return true;
  const pk = t.packages ?? [];
  if (pk.includes(app)) return true;
  return viaPackages(t, app, apps).length > 0;
}

/** The Packages that bring it to `app` when it does not touch `app` itself ("via packages/ui"): the Packages it
 *  touches whose users include `app`. `[]` when it touches `app` directly, or nothing brings it there. */
export function viaPackages(t: Touch, app: string, apps: readonly ScopeApp[]): string[] {
  if (t.touches === null || t.touches.includes(app)) return [];
  return (t.packages ?? []).filter((k) => apps.find((a) => a.key === k)?.usedBy?.includes(app));
}
