// The raw route (issue #52 · Track B; spec:
// docs/superpowers/specs/2026-09-24-artifacts-implementation.md): the bytes of one
// artifact version, served from Canopy's own origin — which is why every response is
// locked down. Mounted at `/raw/a` in src/routes.ts, behind `sessionGate`.
//
//   GET /raw/a/:slug          the latest version
//   GET /raw/a/:slug@v:n      version n   (both spellings — `parseSlugVersion`)
//   GET /raw/a/:slug/v:n      version n
//   ?download=1               attachment, `<slug>-v<n>.<ext>`
//
// Text kinds come from D1 with `ARTIFACT_TEXT_CONTENT_TYPE[kind]`; binary kinds stream
// from R2 with their stored content_type (which the repository has already made safe:
// a `file` never carries an active type). On EVERY response, a 404 included:
// `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`,
// `Cache-Control: private`, and a CSP — the html/svg one lets an HTML artifact run its
// inline script and CDN libraries but reach nothing (`connect-src 'none'`, no forms, no
// base), the binary one allows nothing at all. The SPA frames html with
// `sandbox="allow-scripts"` and NEVER `allow-same-origin`, so the document runs at an
// opaque origin despite being served from this one.
//
// HTML (inline only) gets a small script injected before `</body>` (appended when there
// is none) that posts `{ type: "canopy:height", height }` to the parent whenever the
// document resizes, so the viewer can size its iframe. A download is the stored bytes,
// untouched.
//
// Not-found is the API's: `404 {"error":"not_found"}` for every cause.

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { ARTIFACT_TEXT_EXT, isTextKind, parseSlugVersion, type ArtifactKind } from "@shared/artifacts";
import { ArtifactError, ARTIFACT_NOT_FOUND, readRaw, type ArtifactRaw } from "../tools/artifacts";
import { artifactErrorResponse } from "./http";

export const RAW_CSP_ACTIVE =
  "default-src 'none'; script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net; " +
  "style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; " +
  "img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; " +
  // `sandbox` in the CSP itself: a raw html/svg opened TOP-LEVEL ("Open in new tab", a pasted
  // link) runs at an opaque origin, never Canopy's — the iframe's sandbox attribute only
  // covers the framed case (Track E, 2026-09-24).
  "sandbox allow-scripts";
export const RAW_CSP_PASSIVE = "default-src 'none'; frame-ancestors 'self'";

/** The CSP for a kind: text kinds (html / svg / markdown / mermaid) get the active one. */
export const rawCspFor = (kind: ArtifactKind | null): string => (kind && isTextKind(kind) ? RAW_CSP_ACTIVE : RAW_CSP_PASSIVE);

const baseHeaders = (kind: ArtifactKind | null): Record<string, string> => ({
  "x-frame-options": "SAMEORIGIN",
  "x-content-type-options": "nosniff",
  "cache-control": "private",
  "content-security-policy": rawCspFor(kind),
});

/** Injected into inline HTML: report the document height to the embedding viewer. */
export const HEIGHT_SCRIPT =
  `<script>(function(){function s(){try{parent.postMessage({type:"canopy:height",height:document.documentElement.scrollHeight},"*")}catch(e){}}` +
  `try{new ResizeObserver(s).observe(document.documentElement)}catch(e){}addEventListener("load",s);s()})();</script>`;

/** `html` with `HEIGHT_SCRIPT` before its LAST `</body>`, or appended when there is none. */
export function injectHeightScript(html: string): string {
  const re = /<\/body\s*>/gi;
  let last = -1;
  for (let m = re.exec(html); m; m = re.exec(html)) last = m.index;
  return last < 0 ? html + HEIGHT_SCRIPT : html.slice(0, last) + HEIGHT_SCRIPT + html.slice(last);
}

const TYPE_EXT: Record<string, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf",
  "text/plain": "txt", "text/csv": "csv", "application/json": "json", "application/zip": "zip",
};

/** The download extension: the text kind's, else the content type's, else the stored filename's, else `bin`. */
export function rawExtension(r: Pick<ArtifactRaw, "kind" | "content_type" | "filename">): string {
  if (isTextKind(r.kind)) return ARTIFACT_TEXT_EXT[r.kind];
  const byType = TYPE_EXT[r.content_type.split(";")[0].trim().toLowerCase()];
  if (byType) return byType;
  const name = r.filename ?? "";
  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
  return /^[a-z0-9]{1,10}$/.test(ext) ? ext : "bin";
}

export const rawFilename = (r: Pick<ArtifactRaw, "slug" | "version_no" | "kind" | "content_type" | "filename">): string =>
  `${r.slug}-v${r.version_no}.${rawExtension(r)}`;

async function serveRaw(c: Context<AppEnv>, ref: string): Promise<Response> {
  const parsed = parseSlugVersion(ref);
  try {
    if (!parsed) throw new ArtifactError("not_found", ARTIFACT_NOT_FOUND);
    const r = await readRaw(c.env.DB, c.env.ARTIFACTS_BUCKET, parsed.slug, parsed.version, c.get("principal").handle);
    const download = c.req.query("download") === "1";
    const attachment = download || r.kind === "file";
    const headers: Record<string, string> = {
      ...baseHeaders(r.kind),
      "content-type": r.content_type,
      "content-disposition": `${attachment ? "attachment" : "inline"}; filename="${rawFilename(r)}"`,
    };
    if (r.text !== null) {
      const body = r.kind === "html" && !download ? injectHeightScript(r.text) : r.text;
      return new Response(body, { status: 200, headers });
    }
    headers["content-length"] = String(r.object!.size);
    return new Response(r.object!.body, { status: 200, headers });
  } catch (e) {
    const res = artifactErrorResponse(e, baseHeaders(null));
    if (res) return res;
    throw e;
  }
}

/**
 * Registered on `/raw/*` BEFORE `sessionGate` (src/routes.ts), so even the gate's 401
 * carries the lock-down headers; a header a handler already set is left alone.
 */
export const rawHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  for (const [k, v] of Object.entries(baseHeaders(null))) {
    if (!c.res.headers.has(k)) c.res.headers.set(k, v);
  }
};

export const rawApp = new Hono<AppEnv>();
rawApp.get("/:ref", (c) => serveRaw(c, c.req.param("ref")));
rawApp.get("/:slug/:ver", (c) => serveRaw(c, `${c.req.param("slug")}/${c.req.param("ver")}`));
