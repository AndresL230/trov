// A repository as an agent names it on an MCP call (`repo`): `owner/name`, or what
// `git remote get-url origin` prints for a GitHub remote. ONE spelling comes out — `owner/name` — so
// the lookup against an org's connected repositories (`org_repos.repo_full_name`, compared without
// case) never depends on which form the agent passed. Zod-free.

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** `https://github.com/owner/name(.git)`, `ssh://git@github.com/owner/name`, `git://…` — with or without `www.`, a user and a port. */
const URL_FORM = /^(?:https?|ssh|git):\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?\/([^/\s]+)\/([^/\s]+?)$/i;
/** `git@github.com:owner/name(.git)` — the scp-like form. */
const SCP_FORM = /^(?:[^@/\s]+@)?github\.com:([^/\s]+)\/([^/\s]+?)$/i;
const PLAIN_FORM = /^([^/\s:@]+)\/([^/\s:@]+)$/;

/** `owner/name` for a GitHub repository reference, or null when it is not one. Only github.com is
 *  understood: the repositories an organization connects are GitHub's. */
export function normalizeRepoRef(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!raw || raw.length > 300) return null;
  const m = URL_FORM.exec(raw) ?? SCP_FORM.exec(raw) ?? PLAIN_FORM.exec(raw);
  if (!m) return null;
  const [, owner, name] = m;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return `${owner}/${name}`;
}

/** An organization's URL slug as an agent may pass it (`org`): the shape only — whether it is one of
 *  the connection's organizations is the resolver's question (src/data/bearer.ts). */
export function normalizeOrgSlug(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,38}$/.test(s) ? s : null;
}
