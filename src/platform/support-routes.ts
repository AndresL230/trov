// Support reports over HTTP (0049_support_reports; docs/architecture/support.md). Session cookie only —
// never an MCP tool: a report is a signed-in PERSON's message to the platform's operator.
//
//   POST /api/support                          any signed-in person, with or without an org
//   GET  /api/platform/support                 superadmin: the list (?status=&kind=&before=&limit=), newest first
//   GET  /api/platform/support/:id             superadmin: one report
//   POST /api/platform/support/:id/resolve     superadmin
//   POST /api/platform/support/:id/reopen      superadmin
//
// There is no public form: a signed-out visitor gets the session gate's 401 (a public form is a spam and
// mail-abuse surface; the site keeps its `mailto:`).
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../auth/principal";
import { resolveTenant } from "../data/context";
import { cookieOnly } from "../orgs/routes";
import { welcomeRecipient } from "../orgs/repo";
import { mailOrigin } from "../orgs/mail";
import { getPerson } from "../auth/persons";
import { sendSupportNotice } from "../notifications/support";
import { rateLimited } from "./limits";
import { createReport, getReport, listReports, setReportStatus } from "./support";
import { SupportSubmit, isSupportKind, isSupportStatus, supportSubjectFrom, type SupportSubmitResponse } from "@shared/support";
import { ORG_SLUG_RE } from "@shared/orgs";

export const supportApp = new Hono<AppEnv>();
supportApp.use("*", cookieOnly);

supportApp.post("/", async (c) => {
  const parsed = SupportSubmit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  const refused = await rateLimited(c, "support");
  if (refused) return refused;
  const b = parsed.data;
  const handle = c.get("principal").handle;
  const p = c.var.p; // its actor is the session's person: the reporter is never read from the body
  // The org the form named is kept ONLY if the caller is a member of it (and it is not suspended) —
  // the same one-statement check as the tenant gate. Anything else is "outside an organization".
  const tenant = b.org && ORG_SLUG_RE.test(b.org) ? await resolveTenant(c.env, handle, b.org) : null;
  const org = tenant && b.org ? { id: tenant.orgId, slug: b.org } : null;
  const subject = b.subject || supportSubjectFrom(b.message);
  const { id } = await createReport(p, { kind: b.kind, subject, message: b.message, org, route: b.route, appVersion: b.app_version, userAgent: b.user_agent });
  // The mail to the operator: reported on the row, never required. Everything it needs is read here,
  // inside a guard, so not even a failed read can cost the submission.
  let replyTo: string | null = null;
  try {
    const [person, verified] = await Promise.all([getPerson(p, handle), welcomeRecipient(p, handle)]);
    replyTo = verified?.email ?? null;
    const full = await getReport(p, id);
    await sendSupportNotice(c.env, p, {
      id, kind: b.kind, subject, message: b.message,
      reporter: { handle: person?.handle ?? handle, name: person?.name ?? null, email: replyTo },
      org: org ? { slug: org.slug, name: full?.org?.name ?? null } : null,
      route: b.route, appVersion: b.app_version, userAgent: b.user_agent,
      origin: mailOrigin(c.env, c.req.url),
    });
  } catch {
    /* the report is stored; Platform › Support shows it with no mail outcome */
  }
  return c.json({ ok: true, id, reply_to: replyTo } satisfies SupportSubmitResponse, 201);
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
