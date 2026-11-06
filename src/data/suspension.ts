// An organization's SUSPENSION (0042_organizations `orgs.suspended_at`; docs/architecture/organizations.md › 5.
// Suspension): a superadmin suspends an org (src/platform/repo.ts `setSuspended`), and from then on it is as if
// it did not exist for its members — the tenant gates (./context.ts) answer 404, its bearer tokens and connected
// apps stop resolving, invitations into it are not offered or accepted, and the background jobs skip it
// (src/platform/jobs.ts). Nothing is deleted; unsuspending restores it all.
//
// Every statement that asks "is this org live?" says it with the ONE fragment below, so the rule has one
// spelling. A fragment, not a query: this module reaches no database (D1 stays inside the other src/data/ files).

/** SQL, true while the org is NOT suspended. `alias` is the `orgs` row's alias in the statement (`o`), or
 *  none when the statement reads `orgs` unaliased. */
export const orgLive = (alias?: string): string => `${alias ? `${alias}.` : ""}suspended_at IS NULL`;

/** SQL, true while the org IS suspended — the negation of `orgLive`, for a statement that reports it. */
export const orgSuspended = (alias?: string): string => `${alias ? `${alias}.` : ""}suspended_at IS NOT NULL`;
