// Markdown import over HTTP (docs/architecture/docs-library.md › Import) — mounted on the tenant API at `/imports`:
// `/api/o/:slug/imports…` for the org the path names, and `/api/imports…` as the alias for a person with one org.
//
//   GET  /imports                   any member: Imports history (newest first) + how many are in progress
//   GET  /imports/:id               any member: one run
//   POST /imports                   any member: start a run — the manifest + conflict choices (`doc_import` limit)
//   POST /imports/:id/images        the starter: one image, multipart `path` + `file`
//   POST /imports/:id/pages         the starter: ≤ 25 pages `{ path, text }`, each into the gate
//   POST /imports/:id/finish        the starter: end it; `{ cancel: true }` — the starter or an admin — stops it
//   POST /imports/:id/approve-all   any member: Review's Approve all for the import's waiting pages (bounded; repeat)
//   POST /imports/:id/reject-all    any member: Review's Reject all (soft; bounded; repeat)
//
// Cookie only, NEVER a token and never an MCP tool: an import is a signed-in person's (agents propose pages one at a
// time through `propose_doc_update`), and approving or rejecting is a human confirmation. A request carrying an
// `Authorization` header is refused outright. A read that fails is a 503 `{ error }`; a refusal is
// `{ error: code, message }` (src/imports/runs.ts `ImportError`) — `import_running` also carries the `run`.
import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { MAX_IMAGE_BYTES } from "@shared/docs-import-core";
import { rateLimited } from "../platform/limits";
import {
  ImportError, approveImport, checkStart, finishImport, listImports, readImport, rejectImport, sendImportPages, startImport, uploadImportImage,
  type UploadedImage,
} from "./runs";

type C = Context<AppEnv>;

const personOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "an import is a signed-in person's, never a token's" }, 403)
    : next();

async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ImportError) return c.json({ error: e.code, message: e.message, ...(e.run ? { run: e.run } : {}) }, e.status);
    console.error("imports route failed", e instanceof Error ? e.name : "error");
    return c.json({ error: "internal" }, 500);
  }
}

async function body(c: C): Promise<unknown> {
  try { return await c.req.json(); } catch { return null; }
}

/** The run id in the path, or null. */
const runId = (c: C): number | null => {
  const raw = c.req.param("id") ?? "";
  return /^\d{1,15}$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
};
const unknownRun = (c: C) => c.json({ error: "not_found", message: "there is no such import" }, 404);

export const importsApp = (() => {
  const r = new Hono<AppEnv>();
  r.use("*", personOnly);
  const me = (c: C): string => c.get("principal").handle;

  r.get("/", async (c) => {
    try { return c.json(await listImports(c.var.ctx)); }
    catch (e) { console.error("imports read failed", e instanceof Error ? e.name : "error"); return c.json({ error: "Couldn't read the imports" }, 503); }
  });
  r.get("/:id", async (c) => {
    const id = runId(c);
    if (id === null) return unknownRun(c);
    try { return c.json({ run: await readImport(c.var.ctx, id) }); }
    catch (e) {
      if (e instanceof ImportError) return c.json({ error: e.code, message: e.message }, e.status);
      console.error("import read failed", e instanceof Error ? e.name : "error");
      return c.json({ error: "Couldn't read that import" }, 503);
    }
  });

  // The request is checked (the space, the caps, the lock) BEFORE a unit of the person's daily allowance is taken.
  r.post("/", (c) => guard(c, async () => {
    const input = await checkStart(c.var.ctx, await body(c));
    const refused = await rateLimited(c, "doc_import");
    if (refused) return refused;
    return c.json({ ok: true, ...(await startImport(c.var.ctx, me(c), input)) }, 201);
  }));

  // Multipart, fields `path` and `file`. A declared length past the image cap (plus framing) is refused unread.
  r.post("/:id/images", (c) => guard(c, async () => {
    const id = runId(c);
    if (id === null) return unknownRun(c);
    const len = Number(c.req.header("content-length"));
    if (Number.isFinite(len) && len > MAX_IMAGE_BYTES + 64 * 1024) return c.json({ error: "too_large", message: "an image is at most 10 MB" }, 413);
    let path: unknown = null;
    let file: UploadedImage | null = null;
    try {
      const form = await c.req.raw.formData();
      path = form.get("path");
      const v = form.get("file");
      file = v && typeof v !== "string" ? (v as unknown as UploadedImage) : null;
    } catch {
      return c.json({ error: "invalid", message: "the body must be multipart/form-data" }, 400);
    }
    return c.json({ ok: true, ...(await uploadImportImage(c.var.ctx, c.env.ARTIFACTS_BUCKET, id, me(c), path, file)) });
  }));

  r.post("/:id/pages", (c) => guard(c, async () => {
    const id = runId(c);
    if (id === null) return unknownRun(c);
    return c.json({ ok: true, ...(await sendImportPages(c.var.ctx, id, me(c), await body(c))) });
  }));
  r.post("/:id/finish", (c) => guard(c, async () => {
    const id = runId(c);
    if (id === null) return unknownRun(c);
    return c.json({ ok: true, run: await finishImport(c.var.ctx, id, me(c), await body(c)) });
  }));
  r.post("/:id/approve-all", (c) => guard(c, async () => {
    const id = runId(c);
    if (id === null) return unknownRun(c);
    return c.json({ ok: true, ...(await approveImport(c.var.ctx, id, me(c))) });
  }));
  r.post("/:id/reject-all", (c) => guard(c, async () => {
    const id = runId(c);
    if (id === null) return unknownRun(c);
    return c.json({ ok: true, ...(await rejectImport(c.var.ctx, id)) });
  }));
  return r;
})();
