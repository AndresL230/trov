// The artifacts HTTP API (issue #52 · Track B; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md). A Hono sub-app mounted
// at `/api/artifacts` in src/routes.ts, so EVERY route here sits behind the app's
// `sessionGate` (session cookie; a bearer token never reaches it). The principal is
// `c.get("principal").handle`.
//
// Thin over the repository (src/tools/artifacts.ts) — no rule is re-implemented here:
// requests are shape-checked with the zod schemas in @shared/artifacts (400 + `issues`),
// then handed over; an `ArtifactError` maps through `artifactErrorResponse` (404 parity:
// every not-found is the byte-identical `{"error":"not_found"}`). A malformed request is
// a 4xx, never a 500.
//
// `POST /:slug/ratify` is THE human confirm gate: session only, never an MCP tool — and
// it refuses a request that carries an Authorization header outright, so no future
// change to `sessionGate` can turn a bearer into a ratification.
//
// The token-authenticated upload PUT (`/api/artifacts/upload/:token`) is NOT here: it
// has no session, so src/index.ts dispatches it (src/artifacts/upload.ts) before the app.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { isAdmin, type AppEnv } from "../auth/principal";
import {
  AddTextVersionSchema, ArtifactBinaryKindSchema, ArtifactLinkInputSchema, ArtifactListFiltersSchema,
  ArtifactPageFieldsSchema, ARTIFACT_BINARY_CAP, ARTIFACT_FILENAME_MAX, ARTIFACT_SUMMARY_MAX, ARTIFACT_TEXT_CAP,
  CreateTextArtifactSchema, FetchArtifactUrlSchema, PatchArtifactSchema, RatifyArtifactSchema, UploadTicketSchema,
  isTextKind, parseSlugVersion, type ArtifactUploadTicketDTO,
} from "@shared/artifacts";
import {
  ArtifactError, ARTIFACT_NOT_FOUND, addBinaryVersion, addLink, addTextVersion, createPage, getPage, getVersionPair, listPages, mintUploadToken,
  patchPage, ratify, removeLink, deletePage, restorePage,
} from "../tools/artifacts";
import { artifactErrorResponse } from "./http";
import { FetchUrlError, fetchArtifactUrl } from "./fetch-url";
import { legacyDb } from "../data/legacy";

/** Multipart overhead allowed on top of the binary cap before the body is even read. */
export const MULTIPART_SLACK = 1024 * 1024;
/** A JSON text body: the cap × 6 (worst-case `\uXXXX` escaping) + room for the other fields. */
export const JSON_BODY_MAX = ARTIFACT_TEXT_CAP * 6 + 64 * 1024;

type C = Context<AppEnv>;

const bad = (c: C, message: string, issues?: unknown) =>
  c.json(issues === undefined ? { error: "bad_request", message } : { error: "bad_request", message, issues }, 400);
const tooLarge = (c: C, message: string) => c.json({ error: "too_large", message }, 413);

/** Run a handler; an ArtifactError becomes its status, anything else propagates. */
async function guard(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    const r = artifactErrorResponse(e);
    if (r) return r;
    throw e;
  }
}

const declaredLength = (c: C): number | null => {
  const n = Number(c.req.header("content-length"));
  return c.req.header("content-length") !== undefined && Number.isFinite(n) ? n : null;
};
const isMultipart = (c: C): boolean => /^multipart\/form-data\b/i.test(c.req.header("content-type") ?? "");

type Parsed<T> = { ok: true; data: T } | { ok: false; res: Response };

/** Read a JSON body (length-capped) and validate it. */
async function jsonBody<T>(c: C, schema: z.ZodType<T>): Promise<Parsed<T>> {
  const len = declaredLength(c);
  if (len !== null && len > JSON_BODY_MAX) return { ok: false, res: tooLarge(c, `the request body exceeds ${JSON_BODY_MAX} bytes`) };
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return { ok: false, res: bad(c, "the body must be JSON") };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) return { ok: false, res: bad(c, "invalid request", parsed.error.issues) };
  return { ok: true, data: parsed.data };
}

/** Read a multipart body (length-capped): its string fields and the one `file`. */
async function multipartBody(c: C): Promise<{ ok: true; fields: Record<string, string>; file: File | null } | { ok: false; res: Response }> {
  const len = declaredLength(c);
  if (len !== null && len > ARTIFACT_BINARY_CAP + MULTIPART_SLACK) {
    return { ok: false, res: tooLarge(c, `file exceeds ${ARTIFACT_BINARY_CAP} bytes`) };
  }
  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return { ok: false, res: bad(c, "the body must be multipart/form-data") };
  }
  const fields: Record<string, string> = {};
  let file: File | null = null;
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") fields[k] = v;
    else if (k === "file" && !file) file = v as File;
  }
  return { ok: true, fields, file };
}

// Multipart field shapes (every value arrives as a string).
const optionalText = (max: number) => z.string().max(max).optional();
const BinaryCreateFieldsSchema = ArtifactPageFieldsSchema.extend({
  kind: ArtifactBinaryKindSchema,
  summary: optionalText(ARTIFACT_SUMMARY_MAX),
  content_type: optionalText(255),
  filename: optionalText(ARTIFACT_FILENAME_MAX),
});
const BinaryVersionFieldsSchema = z.object({
  summary: optionalText(ARTIFACT_SUMMARY_MAX),
  content_type: optionalText(255),
  filename: optionalText(ARTIFACT_FILENAME_MAX),
});

/** `links` in a multipart form is a JSON array string. */
function formFields(fields: Record<string, string>): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const out: Record<string, unknown> = { ...fields };
  for (const k of Object.keys(out)) if (out[k] === "") delete out[k];
  if (typeof out.links === "string") {
    try {
      out.links = JSON.parse(out.links);
    } catch {
      return { ok: false, message: "links must be a JSON array" };
    }
  }
  return { ok: true, value: out };
}

/** The file part of a multipart request: present, non-empty, under the cap. */
async function fileBytes(c: C, file: File | null): Promise<{ ok: true; bytes: ArrayBuffer } | { ok: false; res: Response }> {
  if (!file) return { ok: false, res: bad(c, "a `file` part is required") };
  if (file.size > ARTIFACT_BINARY_CAP) return { ok: false, res: tooLarge(c, `file exceeds ${ARTIFACT_BINARY_CAP} bytes`) };
  if (file.size === 0) return { ok: false, res: bad(c, "a binary artifact cannot be empty") };
  return { ok: true, bytes: await file.arrayBuffer() };
}

/** A strictly positive integer query value, `undefined` when absent, `null` when malformed. */
function positiveInt(v: string | undefined): number | null | undefined {
  if (v === undefined || v === "") return undefined;
  return /^\d{1,9}$/.test(v) && Number(v) >= 1 ? Number(v) : null;
}

export interface ArtifactsAppDeps {
  /** The fetch `POST /fetch` uses (tests inject a stub; never the network). */
  fetchImpl?: typeof fetch;
}

export function createArtifactsApp(deps: ArtifactsAppDeps = {}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const who = (c: C): string => c.get("principal").handle;

  // ── library ────────────────────────────────────────────────────────────────
  r.get("/", (c) => guard(async () => {
    const parsed = ArtifactListFiltersSchema.safeParse(c.req.query());
    if (!parsed.success) return bad(c, "invalid filters", parsed.error.issues);
    return c.json({ artifacts: await listPages(legacyDb(c.var.ctx), parsed.data, who(c)) });
  }));

  // ── create ─────────────────────────────────────────────────────────────────
  r.post("/", (c) => guard(async () => {
    if (isMultipart(c)) {
      const body = await multipartBody(c);
      if (!body.ok) return body.res;
      const f = formFields(body.fields);
      if (!f.ok) return bad(c, f.message);
      if (typeof f.value.kind === "string" && isTextKind(f.value.kind)) {
        return bad(c, "text kinds are created with a JSON body (content)");
      }
      const parsed = BinaryCreateFieldsSchema.safeParse(f.value);
      if (!parsed.success) return bad(c, "invalid request", parsed.error.issues);
      const bytes = await fileBytes(c, body.file);
      if (!bytes.ok) return bytes.res;
      const d = parsed.data;
      const page = await createPage(legacyDb(c.var.ctx), {
        ...d,
        bytes: bytes.bytes,
        content_type: d.content_type ?? (body.file!.type || null),
        filename: d.filename ?? (body.file!.name || null),
      }, who(c), c.env.ARTIFACTS_BUCKET);
      return c.json(page, 201);
    }
    const body = await jsonBody(c, CreateTextArtifactSchema);
    if (!body.ok) return body.res;
    return c.json(await createPage(legacyDb(c.var.ctx), body.data, who(c)), 201);
  }));

  // ── fetch a URL (text only; nothing stored) ─────────────────────────────────
  r.post("/fetch", (c) => guard(async () => {
    const body = await jsonBody(c, FetchArtifactUrlSchema);
    if (!body.ok) return body.res;
    try {
      return c.json(await fetchArtifactUrl(body.data.url, deps.fetchImpl ?? fetch));
    } catch (e) {
      if (e instanceof FetchUrlError) return c.json({ error: e.code, message: e.message }, e.status);
      throw e;
    }
  }));

  // ── upload ticket (binary via a signed PUT) ────────────────────────────────
  r.post("/upload-url", (c) => guard(async () => {
    const body = await jsonBody(c, UploadTicketSchema);
    if (!body.ok) return body.res;
    const mint = await mintUploadToken(legacyDb(c.var.ctx), body.data, who(c));
    const dto: ArtifactUploadTicketDTO = {
      id: mint.id,
      slug: mint.slug,
      upload_url: new URL(mint.upload_url, new URL(c.req.url).origin).toString(),
      expires_at: mint.expires_at,
    };
    return c.json(dto, 201);
  }));

  // ── one page ───────────────────────────────────────────────────────────────
  const detail = (c: C, ref: string) => guard(async () => {
    const parsed = parseSlugVersion(ref);
    if (!parsed) throw new ArtifactError("not_found", ARTIFACT_NOT_FOUND);
    const v = positiveInt(c.req.query("v"));
    if (v === null) return bad(c, "v must be a positive integer");
    if (v !== undefined && parsed.version !== null && v !== parsed.version) return bad(c, "two different versions were asked for");
    return c.json(await getPage(legacyDb(c.var.ctx), parsed.slug, v ?? parsed.version, who(c)));
  });
  r.get("/:slug", (c) => detail(c, c.req.param("slug")));
  r.get("/:slug/:ver{v[0-9]+}", (c) => detail(c, `${c.req.param("slug")}/${c.req.param("ver")}`));

  r.patch("/:slug", (c) => guard(async () => {
    const body = await jsonBody(c, PatchArtifactSchema);
    if (!body.ok) return body.res;
    return c.json(await patchPage(legacyDb(c.var.ctx), c.req.param("slug"), body.data, who(c)));
  }));

  // ── versions ───────────────────────────────────────────────────────────────
  r.post("/:slug/versions", (c) => guard(async () => {
    const slug = c.req.param("slug");
    if (isMultipart(c)) {
      const body = await multipartBody(c);
      if (!body.ok) return body.res;
      const f = formFields(body.fields);
      if (!f.ok) return bad(c, f.message);
      const parsed = BinaryVersionFieldsSchema.safeParse(f.value);
      if (!parsed.success) return bad(c, "invalid request", parsed.error.issues);
      const bytes = await fileBytes(c, body.file);
      if (!bytes.ok) return bytes.res;
      const d = parsed.data;
      const res = await addBinaryVersion(legacyDb(c.var.ctx), c.env.ARTIFACTS_BUCKET, slug, {
        bytes: bytes.bytes,
        content_type: d.content_type ?? (body.file!.type || null),
        filename: d.filename ?? (body.file!.name || null),
        summary: d.summary,
      }, who(c));
      return c.json(res, res.unchanged ? 200 : 201);
    }
    const body = await jsonBody(c, AddTextVersionSchema);
    if (!body.ok) return body.res;
    const res = await addTextVersion(legacyDb(c.var.ctx), slug, body.data, who(c));
    return c.json(res, res.unchanged ? 200 : 201);
  }));

  r.get("/:slug/diff", (c) => guard(async () => {
    const a = positiveInt(c.req.query("a"));
    const b = positiveInt(c.req.query("b"));
    if (a == null || b == null) return bad(c, "a and b must be positive integers");
    return c.json(await getVersionPair(legacyDb(c.var.ctx), c.req.param("slug"), a, b, who(c)));
  }));

  // ── links ──────────────────────────────────────────────────────────────────
  r.post("/:slug/links", (c) => guard(async () => {
    const body = await jsonBody(c, ArtifactLinkInputSchema);
    if (!body.ok) return body.res;
    return c.json(await addLink(legacyDb(c.var.ctx), c.req.param("slug"), body.data, who(c)));
  }));
  r.post("/:slug/links/remove", (c) => guard(async () => {
    const body = await jsonBody(c, ArtifactLinkInputSchema);
    if (!body.ok) return body.res;
    return c.json(await removeLink(legacyDb(c.var.ctx), c.req.param("slug"), body.data, who(c)));
  }));

  // ── ratify: the human confirm gate — session only ───────────────────────────
  r.post("/:slug/ratify", (c) => guard(async () => {
    if (c.req.header("authorization")) {
      return c.json({ error: "forbidden", message: "ratify is a signed-in person's action, never a token's" }, 403);
    }
    const body = await jsonBody(c, RatifyArtifactSchema);
    if (!body.ok) return body.res;
    return c.json(await ratify(legacyDb(c.var.ctx), c.req.param("slug"), body.data.version, who(c)));
  }));

  // ── soft delete + restore (0035 PART D) — session only, never an MCP tool ────
  // The page's author or an admin; anyone else is a 403 with nothing written. A deleted
  // page is the one not_found everywhere, its slug stays reserved, and restore is the
  // one way back. Like ratify, a request carrying an Authorization header is refused.
  const personOnly = (c: C) =>
    c.req.header("authorization") ? c.json({ error: "forbidden", message: "deleting an artifact is a signed-in person's action, never a token's" }, 403) : null;
  r.post("/:slug/delete", (c) => guard(async () => {
    const refused = personOnly(c);
    if (refused) return refused;
    const me = who(c);
    return c.json({ ok: true, ...(await deletePage(legacyDb(c.var.ctx), c.req.param("slug"), me, isAdmin(c.env, me))) });
  }));
  r.post("/:slug/restore", (c) => guard(async () => {
    const refused = personOnly(c);
    if (refused) return refused;
    const me = who(c);
    return c.json({ ok: true, artifact: await restorePage(legacyDb(c.var.ctx), c.req.param("slug"), me, isAdmin(c.env, me)) });
  }));

  return r;
}

export const artifactsApp = createArtifactsApp();
