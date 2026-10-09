// Support reports over HTTP (0049_support_reports; docs/architecture/support.md). Never an MCP tool: a
// report is a PERSON's message to the platform's operator.
//
//   POST /api/support                          session: any signed-in person, with or without an org
//   POST /api/support/public                   PUBLIC (no session): the site's Contact form. With a session
//                                              cookie present it is the signed-in path — the principal wins
//   GET  /api/platform/support                 superadmin: the list (?status=&kind=&before=&limit=), newest first
//   GET  /api/platform/support/:id             superadmin: one report
//   POST /api/platform/support/:id/resolve     superadmin
//   POST /api/platform/support/:id/reopen      superadmin
//
// The public route is NOT a fourth auth class: it is an unauthenticated public route, admitted like the
// other public paths (`PUBLIC_PATHS`, src/auth/principal.ts), and bounded by what
// docs/architecture/abuse-limits.md › "The signed-out contact form" lists — above all, Trov never sends
// mail TO the address typed: it is only the Reply-To of the notice the operator gets.
import { Hono } from "hono";
import type { Context } from "hono";
import { resolveSessionPrincipal, type AppEnv } from "../auth/principal";
import { resolveTenant } from "../data/context";
import { cookieOnly } from "../orgs/routes";
import { welcomeRecipient } from "../orgs/repo";
import { mailOrigin } from "../orgs/mail";
import { getPerson } from "../auth/persons";
import { hmacSeal } from "../auth/crypto";
import { sendSupportNotice } from "../notifications/support";
import { rateLimited, takeLimit } from "./limits";
import { createReport, getReport, listReports, setReportStatus, type ReportSender } from "./support";
import {
  SupportSubmit, SupportPublicSubmit, cutAttached, isSupportKind, isSupportStatus, supportSubjectFrom,
  SUPPORT_FALLBACK_EMAIL, SUPPORT_MIN_FORM_MS, SUPPORT_USER_AGENT_MAX,
  type SupportKind, type SupportPublicResponse, type SupportSubmitResponse,
} from "@shared/support";
import { ORG_SLUG_RE } from "@shared/orgs";

export const supportApp = new Hono<AppEnv>();
supportApp.use("*", cookieOnly); // a bearer-shaped caller is refused on both routes

interface Filed {
  kind: SupportKind; subject: string; message: string;
  org: { id: string; slug: string } | null;
  route: string | null; appVersion: string | null; userAgent: string | null;
}

/**
 * Store one report, then mail the operator. The mail is reported on the row, never required:
 * everything it needs is read inside a guard, so not even a failed read can cost the submission.
 * Returns the id and where a reply will go.
 */
async function file(c: Context<AppEnv>, from: ReportSender, r: Filed): Promise<{ id: number; replyTo: string | null }> {
  const p = c.var.p;
  const subject = r.subject || supportSubjectFrom(r.message);
  const { id } = await createReport(p, { from, kind: r.kind, subject, message: r.message, org: r.org, route: r.route, appVersion: r.appVersion, userAgent: r.userAgent });
  let replyTo: string | null = "contactEmail" in from ? from.contactEmail : null;
  try {
    let reporter: { handle: string; name: string | null; email: string | null } | null = null;
    if ("handle" in from) {
      const [person, verified] = await Promise.all([getPerson(p, from.handle), welcomeRecipient(p, from.handle)]);
      replyTo = verified?.email ?? null;
      reporter = { handle: person?.handle ?? from.handle, name: person?.name ?? null, email: replyTo };
    }
    const full = r.org ? await getReport(p, id) : null;
    await sendSupportNotice(c.env, p, {
      id, kind: r.kind, subject, message: r.message, reporter, contactEmail: "contactEmail" in from ? from.contactEmail : null,
      org: r.org ? { slug: r.org.slug, name: full?.org?.name ?? null } : null,
      route: r.route, appVersion: r.appVersion, userAgent: r.userAgent,
      origin: mailOrigin(c.env, c.req.url),
    });
  } catch {
    /* the report is stored; Platform › Support shows it with no mail outcome */
  }
  return { id, replyTo };
}

supportApp.post("/", async (c) => {
  const parsed = SupportSubmit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const refused = await rateLimited(c, "support");
  if (refused) return refused;
  const b = parsed.data;
  const handle = c.get("principal").handle; // the reporter is the session's person: never read from the body
  // The org the form named is kept ONLY if the caller is a member of it (and it is not suspended) —
  // the same one-statement check as the tenant gate. Anything else is "outside an organization".
  const tenant = b.org && ORG_SLUG_RE.test(b.org) ? await resolveTenant(c.env, handle, b.org) : null;
  const org = tenant && b.org ? { id: tenant.orgId, slug: b.org } : null;
  const { id, replyTo } = await file(c, { handle }, { kind: b.kind, subject: b.subject, message: b.message, org, route: b.route, appVersion: b.app_version, userAgent: b.user_agent });
  return c.json({ ok: true, id, reply_to: replyTo } satisfies SupportSubmitResponse, 201);
});

// ── the public form ──────────────────────────────────────────────────────────
/**
 * The limiter's subject for a client address: a keyed hash (HMAC-SHA256 under `COOKIE_SECRET`), so the
 * raw IP is never stored and the counter cannot be turned back into one. A request with no client
 * address (it does not happen behind Cloudflare) shares ONE bucket, which is the conservative reading.
 */
export async function clientSubject(c: Context<AppEnv>): Promise<string> {
  const ip = (c.req.header("cf-connecting-ip") ?? "").trim().slice(0, 64) || "unknown";
  const sealed = await hmacSeal(`support-ip:${ip}`, c.env.COOKIE_SECRET);
  return `ip:${sealed.slice(sealed.lastIndexOf(".") + 1)}`;
}
/** The ONE subject every signed-out report counts against: the day's global cap. */
export const ANON_SUBJECT = "anonymous";

supportApp.post("/public", async (c) => {
  // A body that is not JSON (a form post, a text body) is refused before anything is read from it.
  if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) return c.json({ error: "invalid payload" }, 400);
  const parsed = SupportPublicSubmit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues.map((i) => ({ path: i.path, code: i.code })) }, 400);
  const b = parsed.data;
  // The browser is the request's own header, cut before it is stored; the page is the body's, cut by the schema.
  const userAgent = cutAttached(c.req.header("user-agent"), SUPPORT_USER_AGENT_MAX);
  const report: Filed = { kind: b.kind, subject: b.subject, message: b.message, org: null, route: b.page, appVersion: null, userAgent };

  // Signed in after all (the site is readable with a session too): the signed-in path. The PRINCIPAL is
  // the reporter and the typed address is ignored — exactly as `POST /api/support` would have it.
  const principal = c.env.DEV_LOGIN ? { handle: c.env.DEV_LOGIN } : await resolveSessionPrincipal(c);
  if (principal) {
    c.set("principal", principal);
    const refused = await rateLimited(c, "support");
    if (refused) return refused;
    const { replyTo } = await file(c, { handle: principal.handle }, report);
    return c.json({ ok: true, reply_to: replyTo } satisfies SupportPublicResponse, 201);
  }

  // A filled honeypot is a script: answered exactly like a success, and nothing is stored, counted or mailed.
  if ((b.website ?? "").trim() !== "") return c.json({ ok: true, reply_to: b.email } satisfies SupportPublicResponse, 201);
  // Sent sooner than a person can type it. Said plainly (a person who really was that fast just sends again).
  if (b.elapsed_ms === undefined || b.elapsed_ms < SUPPORT_MIN_FORM_MS) return c.json({ error: "too_fast" }, 400);

  // Per client address first, then the day's cap on ALL signed-out reports.
  const perIp = await takeLimit(c.var.p, await clientSubject(c), "support_anon_ip");
  if (perIp !== null) return c.json({ error: "rate_limited", retry_after: perIp }, 429, { "retry-after": String(perIp) });
  const all = await takeLimit(c.var.p, ANON_SUBJECT, "support_anon_all");
  if (all !== null) return c.json({ error: "support_closed", retry_after: all, contact: SUPPORT_FALLBACK_EMAIL }, 429, { "retry-after": String(all) });

  const { replyTo } = await file(c, { contactEmail: b.email }, report);
  return c.json({ ok: true, reply_to: replyTo } satisfies SupportPublicResponse, 201);
});

// ── the superadmin's side: registered on `platformApp`, behind its gate (404 for anyone else) ──
const reportId = (c: Context<AppEnv>): number | null => {
  const raw = c.req.param("id") ?? "";
  return /^[1-9]\d{0,14}$/.test(raw) ? Number(raw) : null;
};

export function registerSupportRoutes(app: Hono<AppEnv>): void {
  app.get("/support", async (c) => {
    const status = c.req.query("status") ?? "all";
    const kind = c.req.query("kind") ?? "all";
    const before = c.req.query("before");
    const limit = c.req.query("limit");
    if ((status !== "all" && !isSupportStatus(status)) || (kind !== "all" && !isSupportKind(kind))) return c.json({ error: "invalid payload" }, 400);
    if ((before !== undefined && !/^[1-9]\d{0,14}$/.test(before)) || (limit !== undefined && !/^[1-9]\d{0,3}$/.test(limit))) return c.json({ error: "invalid payload" }, 400);
    return c.json(await listReports(c.var.p, { status, kind, before: before ? Number(before) : null, limit: limit ? Number(limit) : undefined }));
  });

  app.get("/support/:id", async (c) => {
    const id = reportId(c);
    const report = id === null ? null : await getReport(c.var.p, id);
    return report ? c.json({ report }) : c.json({ error: "not_found" }, 404);
  });

  const move = (status: "open" | "resolved") => async (c: Context<AppEnv>) => {
    const id = reportId(c);
    const report = id === null ? null : await setReportStatus(c.var.p, id, status);
    return report ? c.json({ ok: true, report }) : c.json({ error: "not_found" }, 404);
  };
  app.post("/support/:id/resolve", move("resolved"));
  app.post("/support/:id/reopen", move("open"));
}
