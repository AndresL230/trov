// The organization's tag list over HTTP (0054_org_tags; docs/architecture/feed-and-search.md › Tags) —
// mounted on the tenant API at `/tags` and `/item-tags`: `/api/o/:slug/tags…` for the org the path names,
// and `/api/tags…` as the alias for a person with one org.
//
//   GET  /tags                              any member: the list, counts, the plan's cap; an admin also
//                                           gets what agents suggested
//   GET  /tags/:name                        any member: one tag and everything that carries it
//   POST /tags                              admin+: add
//   PUT  /tags/:name                        admin+: rename and/or edit description, colour
//   POST /tags/:name/merge|retire|restore   admin+
//   POST /tags/suggestions/:name/resolve    admin+: accept | map | dismiss
//   POST /item-tags                         any member: replace the tags of one feed entry, doc or decision
//
// Cookie only, NEVER a token and never an MCP tool: changing the list is a person's decision (agents
// stage, humans confirm). A request carrying an `Authorization` header is refused outright, like the
// other org settings (src/integrations/routes.ts). The role is checked in the repository
// (src/tools/tags.ts `requireRole`), so no route can forget it.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError } from "../data/context";
import { PlanFeatureError, PlanLimitError } from "../plans/state";
import { TagError, addTag, editTag, listTags, mergeTag, resolveSuggestion, restoreTag, retireTag, setItemTags, tagPage } from "../tools/tags";

type C = Context<AppEnv>;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "the tag list is a signed-in person's to change, never a token's" }, 403)
    : next();

/** Run a write; map each refusal to its status. A plan refusal is rethrown for the app's one 402 handler. */
async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlanLimitError || e instanceof PlanFeatureError) throw e;
    if (e instanceof RoleError) return c.json({ error: "forbidden" }, 403);
    if (e instanceof TagError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("tags route failed", e instanceof Error ? e.name : "error");
    return c.json({ error: "internal" }, 500);
  }
}

async function body(c: C): Promise<Record<string, unknown>> {
  try {
    const v = (await c.req.json()) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const tagsApp = (() => {
  const r = new Hono<AppEnv>();
  r.use("*", personOnly);

  // Reads back a screen: a failed read is a 503 `{ error }`, never a 500.
  r.get("/", async (c) => {
    try { return c.json(await listTags(c.var.ctx)); }
    catch (e) { console.error("tags read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read the tags" }, 503); }
  });
  r.get("/:name", async (c) => {
    try {
      const page = await tagPage(c.var.ctx, c.req.param("name"));
      return page ? c.json(page) : c.json({ error: "not_found" }, 404);
    } catch (e) { console.error("tag read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read that tag" }, 503); }
  });

  r.post("/", (c) => guard(c, async () => c.json({ ok: true, ...(await addTag(c.var.ctx, await body(c))) }, 201)));
  r.put("/:name", (c) => guard(c, async () => c.json({ ok: true, ...(await editTag(c.var.ctx, c.req.param("name"), await body(c))) })));
  r.post("/:name/merge", (c) => guard(c, async () => c.json({ ok: true, ...(await mergeTag(c.var.ctx, c.req.param("name"), (await body(c)).into)) })));
  r.post("/:name/retire", (c) => guard(c, async () => c.json({ ok: true, ...(await retireTag(c.var.ctx, c.req.param("name"))) })));
  r.post("/:name/restore", (c) => guard(c, async () => c.json({ ok: true, ...(await restoreTag(c.var.ctx, c.req.param("name"))) })));
  r.post("/suggestions/:name/resolve", (c) => guard(c, async () => c.json({ ok: true, ...(await resolveSuggestion(c.var.ctx, c.req.param("name"), await body(c))) })));
  return r;
})();

/** `POST /item-tags` `{ type, id, tags }` — any member. */
export const itemTagsApp = (() => {
  const r = new Hono<AppEnv>();
  r.use("*", personOnly);
  r.post("/", (c) => guard(c, async () => {
    const b = await body(c);
    return c.json({ ok: true, tags: await setItemTags(c.var.ctx, b.type, b.id, b.tags) });
  }));
  return r;
})();
