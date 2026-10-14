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
//   POST /tags/:name/find-items             admin+: look for existing items that fit the tag (a model run,
//                                           in the background — src/tools/tag-fit.ts); answers at once
//   GET  /tags/:name/fits                   admin+: what the model suggested may fit, with each reason
//   POST /tags/:name/fits/resolve           admin+: accept | dismiss, some items or all of them
//   PUT  /tag-settings                      admin+: the org's switch for model suggestions (OFF by default)
//   POST /item-tags                         any member: replace the tags of one feed entry, doc or decision
// Adding a tag (or accepting a suggested one) also starts a model run, when the org's switch is on.
//
// Cookie only, NEVER a token and never an MCP tool: changing the list is a person's decision (agents
// stage, humans confirm). A request carrying an `Authorization` header is refused outright, like the
// other org settings (src/integrations/routes.ts). The role is checked in the repository
// (src/tools/tags.ts `requireRole`), so no route can forget it.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError, requireRole } from "../data/context";
import { PlanFeatureError, PlanLimitError } from "../plans/state";
import { TagError, addTag, editTag, listTags, mergeTag, resolveSuggestion, restoreTag, retireTag, setItemTags, tagPage } from "../tools/tags";
import { continueTagFit, listFits, resolveFits, setAiEnabled, startTagFit, type FitStart } from "../tools/tag-fit";

/**
 * Start a model run for `tag` and hand its work to the request's `waitUntil` — never on the response's
 * path, never on a page load. Without an ExecutionContext (a test calling the app directly) the run is
 * finished before answering. Nothing happens when the platform has no key or the org's switch is off.
 */
async function fitInBackground(c: C, tag: string): Promise<FitStart["status"]> {
  const s = await startTagFit(c.env, c.var.ctx, tag);
  if (s.status !== "started") return s.status;
  const work = continueTagFit(c.env, c.var.ctx, s.run, tag);
  let waitUntil: ((p: Promise<unknown>) => void) | null = null;
  try { const exec = c.executionCtx; waitUntil = (p) => exec.waitUntil(p); } catch { waitUntil = null; } // Hono throws with no ExecutionContext
  if (waitUntil) waitUntil(work); else await work;
  return "started";
}

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
    try { return c.json(await listTags(c.var.ctx, { aiAvailable: !!c.env.GEMINI_API_KEY })); }
    catch (e) { console.error("tags read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read the tags" }, 503); }
  });
  r.get("/:name", async (c) => {
    try {
      const page = await tagPage(c.var.ctx, c.req.param("name"));
      return page ? c.json(page) : c.json({ error: "not_found" }, 404);
    } catch (e) { console.error("tag read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read that tag" }, 503); }
  });

  r.post("/", (c) => guard(c, async () => {
    const added = await addTag(c.var.ctx, await body(c));
    return c.json({ ok: true, ...added, fit: await fitInBackground(c, added.name) }, 201);
  }));
  r.post("/:name/find-items", (c) => guard(c, async () => {
    requireRole(c.var.ctx, "admin");
    return c.json({ ok: true, status: await fitInBackground(c, c.req.param("name")) });
  }));
  r.get("/:name/fits", (c) => guard(c, async () => c.json({ fits: await listFits(c.var.ctx, c.req.param("name")) })));
  r.post("/:name/fits/resolve", (c) => guard(c, async () => c.json({ ok: true, ...(await resolveFits(c.var.ctx, c.req.param("name"), await body(c))) })));
  r.put("/:name", (c) => guard(c, async () => c.json({ ok: true, ...(await editTag(c.var.ctx, c.req.param("name"), await body(c))) })));
  r.post("/:name/merge", (c) => guard(c, async () => c.json({ ok: true, ...(await mergeTag(c.var.ctx, c.req.param("name"), (await body(c)).into)) })));
  r.post("/:name/retire", (c) => guard(c, async () => c.json({ ok: true, ...(await retireTag(c.var.ctx, c.req.param("name"))) })));
  r.post("/:name/restore", (c) => guard(c, async () => c.json({ ok: true, ...(await restoreTag(c.var.ctx, c.req.param("name"))) })));
  r.post("/suggestions/:name/resolve", (c) => guard(c, async () => {
    const res = await resolveSuggestion(c.var.ctx, c.req.param("name"), await body(c));
    // A suggested tag that joined the list: look for the other items that fit it too.
    return c.json({ ok: true, ...res, ...(res.resolution === "accept" && res.tag ? { fit: await fitInBackground(c, res.tag) } : {}) });
  }));
  return r;
})();

/** `PUT /tag-settings` `{ enabled }` — admin+: the org's switch for model suggestions. */
export const tagSettingsApp = (() => {
  const r = new Hono<AppEnv>();
  r.use("*", personOnly);
  r.put("/", (c) => guard(c, async () => c.json({ ok: true, ...(await setAiEnabled(c.var.ctx, (await body(c)).enabled)) })));
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
