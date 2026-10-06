// Which org is on screen (canopy-multitenancy.md §5.1, Phase 6) — pure, so it is unit-tested
// without a DOM. The app lives at `/o/<slug>/` with the hash route after it (`/o/acme/#tickets/12`);
// `/` only decides where to go. main.ts is the one module that reads `location` and calls these.

import { ORG_SLUG_RE, type MyOrg, type OrgRole } from "@shared/orgs";

/** The browser key that remembers the last org opened here. A plain slug — never a credential:
 *  the membership is checked by the server on every request. */
export const LAST_ORG_KEY = "trov.org";
/** Session keys of the sign-in return-to: the hash, and the org the person was on. */
export const RETURN_HASH_KEY = "trov.returnHash";
export const RETURN_ORG_KEY = "trov.returnOrg";

/** The slug in `/o/<slug>` or `/o/<slug>/…`, or null on any other path. */
export function orgSlugFromPath(pathname: string): string | null {
  const m = /^\/o\/([^/]+)(?:\/|$)/.exec(pathname);
  if (!m) return null;
  const slug = m[1].toLowerCase();
  return ORG_SLUG_RE.test(slug) ? slug : null;
}

/** An org's home path — what every in-app URL is written under. */
export const orgBase = (slug: string | null): string => (slug ? `/o/${slug}/` : "/");
/** An org's URL with a hash route (`#tickets/12`, or "" for its My Work). */
export const orgHref = (slug: string, hash = ""): string => `${orgBase(slug)}${hash && hash !== "#" ? (hash.startsWith("#") ? hash : `#${hash}`) : ""}`;

export const findOrg = (orgs: readonly MyOrg[] | null | undefined, slug: string | null): MyOrg | null =>
  (slug && orgs?.find((o) => o.slug === slug)) || null;

const RANK: Record<OrgRole, number> = { member: 0, admin: 1, owner: 2 };
/** Admin means admin OR owner of the org on screen — there is no person-level admin. */
export const isOrgAdmin = (org: Pick<MyOrg, "role"> | null | undefined): boolean => !!org && RANK[org.role] >= RANK.admin;

export type Landing =
  /** Open this org. `rewrite` = the address bar does not say so yet (`/`, an old deep link). */
  | { kind: "org"; slug: string; rewrite: boolean }
  /** The org picker; `lost` names the slug the URL asked for that is not the person's. */
  | { kind: "picker"; lost: string | null };

/**
 * Where a signed-in page load lands.
 *  • `/o/<slug>/…` → that org if the person is a member, else the picker (saying so).
 *  • `/` (and old links, `/#tickets/12`): the org they signed in from, else their ONLY org,
 *    else — with several — the last one opened in this browser if they are still in it;
 *    otherwise the picker (several with none remembered, or none at all).
 */
export function resolveLanding(o: { pathSlug: string | null; orgs: readonly MyOrg[]; lastUsed?: string | null; returnOrg?: string | null }): Landing {
  if (o.pathSlug) return findOrg(o.orgs, o.pathSlug) ? { kind: "org", slug: o.pathSlug, rewrite: false } : { kind: "picker", lost: o.pathSlug };
  const back = findOrg(o.orgs, o.returnOrg ?? null);
  if (back) return { kind: "org", slug: back.slug, rewrite: true };
  if (o.orgs.length === 1) return { kind: "org", slug: o.orgs[0].slug, rewrite: true };
  const last = findOrg(o.orgs, o.lastUsed ?? null);
  return last ? { kind: "org", slug: last.slug, rewrite: true } : { kind: "picker", lost: null };
}

/** `owner/repo` → its GitHub URL, or null when the org has no repository connected. */
export const repoUrlOf = (fullName: string | null | undefined): string | null => (fullName ? `https://github.com/${fullName}` : null);
