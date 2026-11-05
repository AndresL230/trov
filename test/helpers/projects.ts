// Projects in tests (docs/architecture/projects.md): the people of the access table, and a project made through the
// real route. Every call is a cookie request to the app (helpers/ask.ts `call`).
import { env } from "cloudflare:test";
import { BASE, call } from "./ask";
import { cookieFor, FIXTURE_ADMIN } from "./persons";
import { ensureMember, ORG_B } from "./tenant";
import { createSession } from "../../src/auth/session";
import { hmacSeal } from "../../src/auth/crypto";
import { platformCtx } from "./tenant";
import type { ProjectCreateBody, ProjectSummary } from "@shared/projects-core";

export const P = `${BASE}/projects`;
export const OWNER = "pj-owner";
export const EDITOR = "pj-editor";
export const VIEWER = "pj-viewer";
export const OTHER = "pj-other";
export const ADMIN = FIXTURE_ADMIN;
/** A member of the OTHER org (Acme) only. */
export const STRANGER = "pj-stranger";

export interface Cast { owner: string; editor: string; viewer: string; admin: string; other: string; stranger: string }

/** A cookie for each person of the access table (all members of SaplingLearn but the stranger, who is Acme's). */
export async function cast(): Promise<Cast> {
  await ensureMember(STRANGER, "member", ORG_B);
  const { id } = await createSession(platformCtx(), STRANGER);
  return {
    owner: await cookieFor(OWNER), editor: await cookieFor(EDITOR), viewer: await cookieFor(VIEWER),
    admin: await cookieFor(ADMIN), other: await cookieFor(OTHER), stranger: `session=${await hmacSeal(id, "test-cookie-secret")}`,
  };
}

/** A project of `cookie`'s, made through `POST /projects`. */
export async function newProject(cookie: string, body: Partial<ProjectCreateBody> = {}): Promise<ProjectSummary> {
  const r = await call("POST", P, cookie, { name: "Hosting providers", icon: "server", color: "#525cc3", visibility: "members", ...body });
  if (r.status !== 200) throw new Error(`newProject: ${r.status} ${r.text}`);
  return r.json.project as ProjectSummary;
}

/** A project with EDITOR as editor and VIEWER as viewer. */
export async function teamProject(c: Cast, body: Partial<ProjectCreateBody> = {}): Promise<ProjectSummary> {
  const p = await newProject(c.owner, body);
  if (p.visibility !== "private") {
    const r = await call("PUT", `${P}/${p.slug}/members`, c.owner, { members: [{ handle: EDITOR, role: "editor" }, { handle: VIEWER, role: "viewer" }] });
    if (r.status !== 200) throw new Error(`teamProject members: ${r.status} ${r.text}`);
  }
  return p;
}

/** Put SaplingLearn on a plan (the reset leaves it on Enterprise). */
export const planOf = (plan: "free" | "team" | "enterprise") => env.DB.prepare(`UPDATE orgs SET plan = ? WHERE id = 'org_saplinglearn'`).bind(plan).run();
