// LOCAL DEVELOPMENT ONLY: sign in as any seeded person, so role and permission states can be tried in the browser
// without OAuth (docs/architecture/local-dev.md › Signing in as someone else). It is NOT an auth class of its own: it
// makes an ordinary session (`createSession`) and sets the ordinary session cookie, exactly as the GitHub / Google
// callbacks do — after which the person is signed in like anyone else (CLAUDE.md invariant 8).
//
// Honoured only when ALL of these hold (`devSignInAllowed`), and answered with a bare 404 otherwise — so a deployed
// Worker never even says the route exists:
//   • `DEV_LOGIN` is set — the local-only `.dev.vars` value that already makes `wrangler dev` sign everyone in as one
//     seeded person (src/auth/principal.ts). This route only lets that local setup pick WHICH person;
//   • the request came to a LOOPBACK http origin (`http://localhost:*`, `http://127.0.0.1:*` — what `wrangler dev`
//     serves on; a deployed Worker is never reached there), the rule of every local stand-in (src/platform/loopback.ts);
//   • the Worker holds no live Stripe key (`holdsLiveKey`): a Worker with one is, or talks to, production.
//
//   GET  /auth/dev/as                    a page listing every seeded person and their orgs (links below)
//   GET  /auth/dev/as?handle=<h>[&org=<slug>]   a session for <h>, then `/<slug>/` (their first org by default)
//   GET  /auth/dev/out                   drops that session: back to DEV_LOGIN's person
//
// `npm run dev:as -- <handle>` prints the link (scripts/dev/as.mjs).
import type { Context } from "hono";
import type { Env } from "../env";
import type { AppEnv } from "./principal";
import { all, first } from "../data/platform-sql";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { loopbackOrigin } from "../platform/loopback";
import { holdsLiveKey, type LiveKeyEnv } from "../billing/config";

/** Whether this request may use the dev sign-in (see the header). Pure. */
export function devSignInAllowed(env: Pick<Env, "DEV_LOGIN"> & LiveKeyEnv, requestUrl: string): boolean {
  const dev = typeof env.DEV_LOGIN === "string" ? env.DEV_LOGIN.trim() : "";
  return dev !== "" && loopbackOrigin(requestUrl) !== null && !holdsLiveKey(env);
}

interface PersonOrg { handle: string; name: string | null; slug: string | null; org: string | null; role: string | null }

const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** `GET /auth/dev/as`. */
export async function devSignIn(c: Context<AppEnv>): Promise<Response> {
  if (!devSignInAllowed(c.env, c.req.url)) return c.json({ error: "not_found" }, 404);
  const handle = (c.req.query("handle") ?? "").trim();
  if (!handle) return c.html(await peoplePage(c));
  const person = await first<{ handle: string }>(c.var.p, `SELECT handle FROM persons WHERE handle = ? COLLATE NOCASE`, handle);
  if (!person || person.handle === "trov" || person.handle === "github-webhook") return c.json({ error: "unknown_person", handle }, 404);
  const orgs = await all<{ slug: string }>(c.var.p,
    `SELECT o.slug FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? COLLATE NOCASE ORDER BY m.created_at, o.slug`, person.handle);
  const wanted = (c.req.query("org") ?? "").trim().toLowerCase();
  const slug = orgs.find((o) => o.slug === wanted)?.slug ?? orgs[0]?.slug ?? null;
  // The previous dev session (if any) goes, so switching does not pile up rows.
  const old = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (old) await deleteSession(c.var.p, old);
  const { id } = await createSession(c.var.p, person.handle);
  await setSessionCookie(c, id, c.env.COOKIE_SECRET);
  return c.redirect(slug ? `/${slug}/` : "/", 302);
}

/** `GET /auth/dev/out`. */
export async function devSignOut(c: Context<AppEnv>): Promise<Response> {
  if (!devSignInAllowed(c.env, c.req.url)) return c.json({ error: "not_found" }, 404);
  const old = await readSessionCookie(c, c.env.COOKIE_SECRET);
  if (old) await deleteSession(c.var.p, old);
  clearSessionCookie(c);
  return c.redirect("/", 302);
}

async function peoplePage(c: Context<AppEnv>): Promise<string> {
  const rows = await all<PersonOrg>(c.var.p,
    `SELECT p.handle, p.name, o.slug, o.name AS org, m.role FROM persons p
       LEFT JOIN memberships m ON m.user_id = p.handle COLLATE NOCASE
       LEFT JOIN orgs o ON o.id = m.org_id
      WHERE p.handle NOT IN ('trov', 'github-webhook')
      ORDER BY p.handle COLLATE NOCASE, o.slug`);
  const people = new Map<string, { name: string | null; orgs: PersonOrg[] }>();
  for (const r of rows) {
    const p = people.get(r.handle) ?? { name: r.name, orgs: [] };
    if (r.slug) p.orgs.push(r);
    people.set(r.handle, p);
  }
  const me = c.get("principal")?.handle ?? "";
  const items = [...people].map(([handle, p]) => {
    const orgs = p.orgs.length
      ? p.orgs.map((o) => `<a href="/auth/dev/as?handle=${encodeURIComponent(handle)}&amp;org=${encodeURIComponent(o.slug!)}">${esc(o.org ?? o.slug!)}</a> <span>${esc(o.role ?? "")}</span>`).join(" · ")
      : "<span>no organization</span>";
    return `<li><a href="/auth/dev/as?handle=${encodeURIComponent(handle)}"><b>${esc(p.name ?? handle)}</b> @${esc(handle)}</a>${handle.toLowerCase() === me.toLowerCase() ? " <em>(you)</em>" : ""}<br>${orgs}</li>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Sign in as (local)</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1f1d19;background:#f7f5ef}h1{font-size:20px}li{margin:0 0 12px}span{color:#6d675c;font-size:13px}a{color:#4b45c6}@media (prefers-color-scheme:dark){body{color:#ece8df;background:#161513}span{color:#a39d90}a{color:#a9a5ff}}</style></head>
<body><h1>Sign in as… <span>(local development only)</span></h1><p><span>A real session for the person you pick. <a href="/auth/dev/out">Sign out</a> to go back to DEV_LOGIN (${esc(String(c.env.DEV_LOGIN ?? ""))}).</span></p><ul>${items}</ul></body></html>`;
}
