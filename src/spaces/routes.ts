// The Docs Library's spaces over HTTP (0081_docs_library; docs/architecture/docs-library.md › Spaces) — mounted
// on the tenant API at `/spaces`: `/api/o/:slug/spaces…` for the org the path names, and `/api/spaces…` as the
// alias for a person with one org.
//
//   GET  /spaces                    any member: the Library — live spaces with page counts and owners, the
//                                   recently updated pages; an admin also gets the archived spaces
//   GET  /spaces/:slug              any member: a space's home — the space and every page in it
//   POST /spaces                    admin+: create `{ name, icon, color, description? }`
//   PUT  /spaces/:slug              `{ name?, icon?, color? }` admin+; `{ description? }` admin+ or an owner
//   PUT  /spaces/:slug/owners       admin+ or an owner: `{ owners: handle[] }`
//   POST /spaces/:slug/archive      admin+ (soft)
//   POST /spaces/:slug/restore      admin+
//   PUT  /spaces/prefs/me           any member, their OWN view only: `{ sidebar?: slug[] | null, pinned?: slug[],
//                                   hidden?: slug[] }` (the sidebar's spaces, at most 5; pinned / hidden cards)
//
// Cookie only, NEVER a token and never an MCP tool: a space is a person's to shape (agents stage, humans
// confirm). A request carrying an `Authorization` header is refused outright. The role is checked in the
// repository (src/tools/spaces.ts), so no route can forget it. MCP reads the live spaces through `list_spaces`.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { RoleError } from "../data/context";
import { PlanFeatureError, PlanLimitError } from "../plans/state";
import { SpaceError, archiveSpace, createSpace, editSpace, readLibrary, readSpaceHome, restoreSpace, saveLibraryPrefs, setSpaceOwners } from "../tools/spaces";

type C = Context<AppEnv>;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "the Library's spaces are a signed-in person's to change, never a token's" }, 403)
    : next();

/** Run a write; map each refusal to its status. A plan refusal is rethrown for the app's one 402 handler. */
async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlanLimitError || e instanceof PlanFeatureError) throw e;
    if (e instanceof RoleError) return c.json({ error: "forbidden", message: "only an admin, or an owner of this space, can do that" }, 403);
    if (e instanceof SpaceError) return c.json({ error: e.code, ...(e.field ? { field: e.field } : {}), message: e.message }, e.status);
    console.error("spaces route failed", e instanceof Error ? e.name : "error");
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

export const spacesApp = (() => {
  const r = new Hono<AppEnv>();
  r.use("*", personOnly);

  // Reads back a screen: a failed read is a 503 `{ error }`, never a 500.
  r.get("/", async (c) => {
    try { return c.json(await readLibrary(c.var.ctx)); }
    catch (e) { console.error("library read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read the Library" }, 503); }
  });
  r.get("/:slug", async (c) => {
    try {
      const home = await readSpaceHome(c.var.ctx, c.req.param("slug"));
      return home ? c.json(home) : c.json({ error: "not_found" }, 404);
    } catch (e) { console.error("space read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read that space" }, 503); }
  });

  r.post("/", (c) => guard(c, async () => c.json({ ok: true, space: await createSpace(c.var.ctx, await body(c)) }, 201)));
  // Two segments, so no space's slug can reach it (`/:slug` is one; `/:slug/owners` names its second).
  r.put("/prefs/me", (c) => guard(c, async () => c.json({ ok: true, prefs: await saveLibraryPrefs(c.var.ctx, await body(c)) })));
  r.put("/:slug", (c) => guard(c, async () => c.json({ ok: true, space: await editSpace(c.var.ctx, c.req.param("slug"), await body(c)) })));
  r.put("/:slug/owners", (c) => guard(c, async () => c.json({ ok: true, space: await setSpaceOwners(c.var.ctx, c.req.param("slug"), (await body(c)).owners) })));
  r.post("/:slug/archive", (c) => guard(c, async () => c.json({ ok: true, space: await archiveSpace(c.var.ctx, c.req.param("slug")) })));
  r.post("/:slug/restore", (c) => guard(c, async () => c.json({ ok: true, space: await restoreSpace(c.var.ctx, c.req.param("slug")) })));
  return r;
})();
