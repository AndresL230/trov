// Links INTO an org's app. The SPA lives at `<origin>/<slug>/` with the hash route after it, and a
// person may belong to several orgs — so a link that is to open one org's ticket, handoff, artifact or
// digest must carry that org's slug: `<origin>/#handoffs/3` would open whichever org the browser
// last had. Everything the Worker hands out as a link (MCP tool results, the digest e-mails) is built
// here, from the org of the context it was produced under — never from a request value.
import { type TenantContext, first } from "../data/sql";

const slugs = new WeakMap<TenantContext, Promise<string | null>>();

/** The slug of `ctx`'s org (one primary-key read, remembered for the context's lifetime). */
export function orgSlugOf(ctx: TenantContext): Promise<string | null> {
  let hit = slugs.get(ctx);
  if (!hit) {
    hit = first<{ slug: string }>(ctx, `SELECT slug FROM orgs WHERE id = ?`, ctx.orgId).then((r) => r?.slug ?? null, () => null);
    slugs.set(ctx, hit);
  }
  return hit;
}

/** `<origin>/<slug>` — what a hash route (`/#tickets/12`) is appended to. With no slug (an org that is
 *  gone, a read that failed) it is the bare origin, whose `/` still routes a signed-in person somewhere. */
export const appBase = (origin: string, slug: string | null | undefined): string =>
  `${origin.replace(/\/+$/, "")}${slug ? `/${slug}` : ""}`;
/** `<origin>/api/o/<slug>` — what a tenant route's suffix (`/raw/a/<slug>@v1`) is appended to. */
export const apiBase = (origin: string, slug: string | null | undefined): string =>
  `${origin.replace(/\/+$/, "")}${slug ? `/api/o/${slug}` : ""}`;

/** `appBase` for a context: the org's own app address. */
export async function orgAppBase(ctx: TenantContext, origin: string): Promise<string> {
  return appBase(origin, await orgSlugOf(ctx));
}
