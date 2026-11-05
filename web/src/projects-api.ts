// Projects — the typed client for every `PROJECT_ROUTES` entry (shared/projects-core.ts; cookie only, under
// /api/o/:slug). Every call goes through api.ts's ONE sender (`apiFetch`: the org prefix, the session cookie, a 401 as
// `Unauthorized`, the preview's write block). A refusal is an `OrgApiError` — its `message` the error CODE (`not_found`,
// `forbidden`, `invalid`, `archived`, `private_pin`), `detail` the server's sentence, `plan` the app's 402
// `plan_limit` body — so a screen says it with `projectErrorText`, and the plan's one sentence with `planLimitText`.
import { apiFetch, ApiError, OrgApiError, PreviewBlocked, planLimitText } from "./api";
import { isPlanRefusal } from "@shared/plans";
import {
  PROJECT_ROUTES,
  type ProjectCreateBody, type ProjectDetail, type ProjectList, type ProjectMembersBody, type ProjectPatchBody, type ProjectSummary,
} from "@shared/projects-core";

/** A route of PROJECT_ROUTES with its `:project` (and `:ref`) filled in, URL-encoded. */
export function projectPath(route: string, slug?: string, ref?: string): string {
  return route.replace(":project", encodeURIComponent(slug ?? "")).replace(":ref", encodeURIComponent(ref ?? ""));
}

async function refusal(res: Response): Promise<OrgApiError> {
  let j: { error?: unknown; message?: unknown; field?: unknown; retry_after?: unknown } = {};
  try { j = (await res.json()) as typeof j; } catch { /* not JSON */ }
  const err = new OrgApiError(res.status, typeof j.error === "string" ? j.error : String(res.status), typeof j.message === "string" ? j.message : null, typeof j.field === "string" ? j.field : null);
  if (isPlanRefusal(j)) err.plan = j;
  return err;
}

async function send<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
  const res = await apiFetch(path, init);
  if (!res.ok) throw await refusal(res);
  return res.json() as Promise<T>;
}

/** `GET /projects` — the live projects this person can open, the archived ones, and the org's `projects` limit. */
export const listProjects = (): Promise<ProjectList> => send("GET", PROJECT_ROUTES.list);
/** `POST /projects` — a new project, its creator the owner. 402 `plan_limit` past the org's `projects` limit. */
export const createProject = (body: ProjectCreateBody): Promise<ProjectSummary> =>
  send<{ project: ProjectSummary }>("POST", PROJECT_ROUTES.list, body).then((r) => r.project);
/** `GET /projects/:project` — one project's page. One `404 not_found` for a project the person can't open. */
export const getProject = (slug: string): Promise<ProjectDetail> => send("GET", projectPath(PROJECT_ROUTES.one, slug));
/** `PATCH /projects/:project` — details, instructions or visibility (owner; editors all but visibility). */
export const patchProject = (slug: string, body: ProjectPatchBody): Promise<ProjectDetail> => send("PATCH", projectPath(PROJECT_ROUTES.one, slug), body);
/** `DELETE /projects/:project` — owner or org admin. */
export const deleteProject = (slug: string): Promise<{ ok: true }> => send("DELETE", projectPath(PROJECT_ROUTES.one, slug));
export const archiveProject = (slug: string): Promise<ProjectSummary> => send("POST", projectPath(PROJECT_ROUTES.archive, slug), {});
export const restoreProject = (slug: string): Promise<ProjectSummary> => send("POST", projectPath(PROJECT_ROUTES.restore, slug), {});
/** `PUT /projects/:project/members` — the WHOLE member list (never on a private project: `400 invalid`). */
export const putProjectMembers = (slug: string, body: ProjectMembersBody): Promise<ProjectDetail> => send("PUT", projectPath(PROJECT_ROUTES.members, slug), body);
/** `POST /projects/:project/pins` — at most `PROJECT_LIMITS.pinsPerRequest` refs; 402 past `project_pins`;
 *  `400 private_pin` for an artifact less visible than the project. */
export const addProjectPins = (slug: string, refs: string[]): Promise<ProjectDetail> => send("POST", projectPath(PROJECT_ROUTES.pins, slug), { refs });
export const removeProjectPin = (slug: string, ref: string): Promise<ProjectDetail> => send("DELETE", projectPath(PROJECT_ROUTES.pin, slug, ref));
/** `POST /projects/:project/files` — multipart, Ask's attachment rules; each file becomes an artifact and is pinned. */
export function uploadProjectFiles(slug: string, files: readonly File[]): Promise<ProjectDetail> {
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);   // Ask's field name (`POST /ask/attachments`)
  return send("POST", projectPath(PROJECT_ROUTES.upload, slug), form);
}

/** A refused project call as a sentence that says what to do next — the plan's own sentence for a 402. */
export function projectErrorText(e: unknown, fallback: string, role: "owner" | "admin" | "member" | null = null): string {
  if (e instanceof PreviewBlocked) return "This is a preview: nothing is changed.";
  const plan = planLimitText(e, role);
  if (plan) return plan;
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  const raw = e instanceof OrgApiError ? e.detail : null;
  const detail = raw ? `${raw[0].toUpperCase()}${raw.slice(1)}${/[.!?]$/.test(raw) ? "" : "."}` : null;
  switch (e.message) {
    case "not_found": return "That project isn't there any more, or you can't open it. Reload the page.";
    case "forbidden": return "Only the project's owner or an editor can change that.";
    case "archived": return "This project is archived, so it is read-only. Restore it first.";
    case "private_pin": return detail ?? "A private artifact can't be pinned here: people in the project wouldn't see it. Publish it to the org first.";
    case "invalid": return detail ?? `${fallback} Check what you entered.`;
    default: return detail ?? `${fallback} Try again.`;
  }
}
