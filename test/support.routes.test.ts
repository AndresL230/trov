/**
 * Support reports (0049_support_reports; docs/architecture/support.md):
 *   • `POST /api/support` — any signed-in person, with or without an org; session cookie only; validated,
 *     rate-limited per person; the reporter is the session's person whatever the body says;
 *   • the mail to the operator — sent / failed / skipped — recorded on the row and never able to fail
 *     the submission; `Reply-To` is the reporter's provider-verified address; the provider key never
 *     reaches the row;
 *   • the superadmin's list / read / resolve / reopen, 404 for everyone else;
 *   • a handle rename rewrites both handle columns.
 * Real D1; mail is inspected at the Request level (resend mode with the global fetch swapped).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { renamePerson, HANDLE_COLUMNS } from "../src/auth/persons";
import { LIMITS } from "../src/platform/limits";
import { renderSupportEmail, supportReportUrl } from "../src/notifications/support";
import { cookieFor } from "./helpers/persons";
import { ensureMember, platformCtx, ORG_A, ORG_B } from "./helpers/tenant";
import { call, one, rows, exec, SUPERADMIN } from "./helpers/orgs";
import {
  SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX, SUPPORT_USER_AGENT_MAX, supportSubjectFrom,
  type SupportListResponse, type SupportReport, type SupportSubmitResponse,
} from "@shared/support";

afterEach(() => { vi.unstubAllGlobals(); });

const boss = () => cookieFor(SUPERADMIN);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0 Safari/537.36";
const BODY = { kind: "bug", subject: "Board drag drops the card", message: "Dragging a ticket to Testing snaps it back.\nSecond line.", route: "#tickets", org: "saplinglearn", app_version: "0.25", user_agent: UA };
interface Stored {
  id: number; kind: string; subject: string; message: string; reporter: string; from_org: string | null; from_org_slug: string | null;
  route: string | null; app_version: string | null; user_agent: string | null; status: string; resolved_by: string | null; resolved_at: string | null;
  created_at: string; mail_status: string | null; mail_at: string | null; mail_error: string | null;
}
const stored = () => rows<Stored>(`SELECT * FROM support_reports ORDER BY id`);
const submit = (cookie: string, body: unknown = BODY, o: { headers?: Record<string, string> } = {}) => call<SupportSubmitResponse & { error?: string; retry_after?: number }>("POST", "/api/support", cookie, body, o);
const platformBodies = () => rows<{ to_address: string; subject: string; html: string; text: string }>(`SELECT to_address, subject, html, text FROM platform_outbox_bodies ORDER BY id`);
/** The same request against an Env of the test's own (the mail mode, the recipient). */
async function submitWith(over: Record<string, unknown>, cookie: string, body: unknown = BODY): Promise<{ status: number; json: SupportSubmitResponse }> {
  const res = await app.request("/api/support", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }, { ...env, ...over });
  return { status: res.status, json: (await res.json()) as SupportSubmitResponse };
}

describe("POST /api/support — who may send", () => {
  it("401s signed out, and writes nothing", async () => {
    expect((await submit("")).status).toBe(401);
    // A bearer alone never reaches a session route…
    expect((await submit("", BODY, { headers: { authorization: "Bearer canopy_mcp_anything" } })).status).toBe(401);
    expect(await stored()).toEqual([]);
  });

  it("refuses a request that carries an Authorization header, even beside a session cookie", async () => {
    const r = await submit(await cookieFor("meilin"), BODY, { headers: { authorization: "Bearer canopy_mcp_anything" } });
    expect([r.status, r.json.error]).toEqual([403, "forbidden"]);
    expect(await stored()).toEqual([]);
  });

  it("a member's report is stored with what they typed, the four attached values and their own handle", async () => {
    const r = await submit(await cookieFor("meilin"));
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ ok: true, id: expect.any(Number), reply_to: "meilin@saplinglearn.org" });
    expect(await stored()).toEqual([expect.objectContaining({
      id: r.json.id, kind: "bug", subject: "Board drag drops the card", message: BODY.message, reporter: "meilin",
      from_org: ORG_A, from_org_slug: "saplinglearn", route: "#tickets", app_version: "0.25", user_agent: UA,
      status: "open", resolved_by: null, resolved_at: null, mail_status: "skipped", mail_error: null,
    })]);
  });

  it("works for a person in no organization at all — never the alias gate's 409", async () => {
    const r = await submit(await cookieFor("loner", { member: false }), { kind: "question", message: "How do I get an organization?" });
    expect(r.status).toBe(201);
    expect(r.json.reply_to).toBeNull(); // no provider-verified address on file
    expect(await stored()).toEqual([expect.objectContaining({ kind: "question", reporter: "loner", from_org: null, from_org_slug: null, route: null, app_version: null, user_agent: null })]);
  });

  it("and for a person in several", async () => {
    await ensureMember("meilin", "member", ORG_B);
    const r = await submit(await cookieFor("meilin"), { ...BODY, org: "acme" });
    expect(r.status).toBe(201);
    expect(await stored()).toEqual([expect.objectContaining({ from_org: ORG_B, from_org_slug: "acme" })]);
  });

  it("keeps the organization only if the caller is a member of it: another org's slug, an unknown one and a suspended one are all 'no organization'", async () => {
    const cookie = await cookieFor("meilin");
    expect((await submit(cookie, { ...BODY, org: "acme" })).status).toBe(201);          // exists; not a member
    expect((await submit(cookie, { ...BODY, org: "no-such-org" })).status).toBe(201);
    expect((await submit(cookie, { ...BODY, org: "Not A Slug!" })).status).toBe(201);
    await exec(`UPDATE orgs SET suspended_at = '2026-10-08T00:00:00.000Z' WHERE id = ?`, ORG_A);
    expect((await submit(cookie, BODY)).status).toBe(201);
    expect((await stored()).map((s) => [s.from_org, s.from_org_slug])).toEqual([[null, null], [null, null], [null, null], [null, null]]);
  });

  it("the author is the authenticated principal: a client-supplied one is ignored", async () => {
    const r = await submit(await cookieFor("meilin"), { ...BODY, reporter: SUPERADMIN, author: SUPERADMIN, handle: SUPERADMIN, status: "resolved", resolved_by: SUPERADMIN, id: 999, created_at: "2000-01-01T00:00:00.000Z" });
    expect(r.status).toBe(201);
    const [row] = await stored();
    expect(row).toMatchObject({ reporter: "meilin", status: "open", resolved_by: null });
    expect(row.id).not.toBe(999);
    expect(row.created_at.startsWith("2000")).toBe(false);
  });
});

describe("POST /api/support — validation", () => {
  it("refuses a missing or blank message, an unknown kind, a body that is not an object, and text past its cap", async () => {
    const cookie = await cookieFor("meilin");
    for (const bad of [
      null, [], "text", {},
      { kind: "bug" }, { kind: "bug", message: "" }, { kind: "bug", message: "   \n  " }, { kind: "bug", message: 7 },
      { kind: "praise", message: "hello" }, { message: "hello" },
      { kind: "bug", message: "x".repeat(SUPPORT_MESSAGE_MAX + 1) },
      { kind: "bug", message: "ok", subject: "s".repeat(SUPPORT_SUBJECT_MAX + 1) },
      { kind: "bug", message: "ok", subject: 7 },
    ]) {
      const r = await submit(cookie, bad);
      expect([r.status, r.json.error], JSON.stringify(bad).slice(0, 60)).toEqual([400, "invalid payload"]);
    }
    expect(await stored()).toEqual([]);
    // A refused report spends nothing of the day's allowance.
    expect(await one(`SELECT COUNT(*) AS n FROM abuse_counters WHERE action = 'support'`)).toEqual({ n: 0 });
  });

  it("accepts text exactly at its cap, trims it, and files a report with no subject under its message's first line", async () => {
    const cookie = await cookieFor("meilin");
    expect((await submit(cookie, { kind: "feedback", message: "m".repeat(SUPPORT_MESSAGE_MAX), subject: "s".repeat(SUPPORT_SUBJECT_MAX) })).status).toBe(201);
    expect((await submit(cookie, { kind: "feedback", message: "  The timeline is lovely.\r\nMore of that.  ", subject: "   " })).status).toBe(201);
    const [, second] = await stored();
    expect(second).toMatchObject({ subject: "The timeline is lovely.", message: "The timeline is lovely.\nMore of that." });
    const long = `${"word ".repeat(60)}end`;
    expect(supportSubjectFrom(long).length).toBeLessThanOrEqual(SUPPORT_SUBJECT_MAX);
    expect(supportSubjectFrom(long).endsWith("…")).toBe(true);
  });

  it("cuts the attached context to its cap instead of refusing, and flattens it to one line", async () => {
    const r = await submit(await cookieFor("meilin"), { ...BODY, user_agent: `UA\r\nInjected: 1 ${"a".repeat(SUPPORT_USER_AGENT_MAX)}`, route: " #tickets/7\n", app_version: "" });
    expect(r.status).toBe(201);
    const [row] = await stored();
    expect(row.user_agent).toHaveLength(SUPPORT_USER_AGENT_MAX);
    expect(row.user_agent).not.toMatch(/[\r\n]/);
    expect(row).toMatchObject({ route: "#tickets/7", app_version: null });
  });
});

describe("POST /api/support — the per-person limit", () => {
  it(`takes one unit a report; past ${LIMITS.support.max} a day it is 429 with Retry-After and writes nothing`, async () => {
    const cookie = await cookieFor("meilin");
    const bucket = new Date().toISOString().slice(0, 10);
    expect((await submit(cookie)).status).toBe(201);
    expect(await one(`SELECT count FROM abuse_counters WHERE subject = 'meilin' AND action = 'support' AND bucket = ?`, bucket)).toEqual({ count: 1 });
    await exec(`UPDATE abuse_counters SET count = ? WHERE subject = 'meilin' AND action = 'support'`, LIMITS.support.max);
    const res = await app.request("/api/support", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(BODY) }, env);
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: string; retry_after: number };
    expect(body.error).toBe("rate_limited");
    expect(body.retry_after).toBeGreaterThan(0);
    expect(res.headers.get("retry-after")).toBe(String(body.retry_after));
    expect(await stored()).toHaveLength(1);
    // Someone else's allowance is their own.
    expect((await submit(await cookieFor("sanaok"))).status).toBe(201);
  });
});

describe("the mail to the operator", () => {
  it("skipped: with no SUPPORT_NOTIFY_EMAIL nothing is sent or written to the outbox, and the report is stored", async () => {
    let called = 0;
    vi.stubGlobal("fetch", (async () => { called++; return new Response("{}", { status: 200 }); }) as typeof fetch);
    for (const over of [{}, { SUPPORT_NOTIFY_EMAIL: "   " }, { SUPPORT_NOTIFY_EMAIL: "", NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test" }]) {
      expect((await submitWith(over, await cookieFor("meilin"))).status).toBe(201);
    }
    expect(called).toBe(0);
    expect(await platformBodies()).toEqual([]);
    expect((await stored()).map((s) => [s.mail_status, s.mail_error])).toEqual([["skipped", null], ["skipped", null], ["skipped", null]]);
  });

  it("local mode: the rendered mail goes to the platform's bodies table, addressed to the operator", async () => {
    const r = await submitWith({ SUPPORT_NOTIFY_EMAIL: "owner@trov.test" }, await cookieFor("meilin"));
    expect(r.status).toBe(201);
    const sent = await platformBodies();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to_address: "owner@trov.test", subject: "[Trov bug] Board drag drops the card" });
    for (const part of ["Dragging a ticket to Testing snaps it back.", "Meilin Zhao (@meilin)", "meilin@saplinglearn.org", "SaplingLearn (saplinglearn)", "#tickets", "0.25", "Chrome/141.0", supportReportUrl("https://trov.test", r.json.id)]) {
      expect(sent[0].text, part).toContain(part);
    }
    expect(sent[0].html).toContain(`href="https://trov.test/platform/#platform/support/${r.json.id}"`);
    expect((await stored())[0]).toMatchObject({ mail_status: "sent", mail_error: null });
  });

  it("sent: the provider request — the operator's address, the platform's From, Reply-To the reporter's VERIFIED address", async () => {
    const out: { url: string; auth: string | null; body: { from: string; to: string[]; subject: string; reply_to?: string; html: string; text: string; headers?: unknown } }[] = [];
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      out.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }) as typeof fetch);
    // The editable notification address is NOT where a reply goes: only what a provider verified is.
    await exec(`UPDATE persons SET email = 'someone-else@evil.test' WHERE handle = 'meilin'`);
    const r = await submitWith({ SUPPORT_NOTIFY_EMAIL: " owner@trov.test ", NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test" }, await cookieFor("meilin"), { ...BODY, kind: "question", subject: "Line one\r\nBcc: victim@x.io" });
    expect(r.status).toBe(201);
    expect(r.json.reply_to).toBe("meilin@saplinglearn.org");
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://api.resend.com/emails");
    expect(out[0].auth).toBe("Bearer re_test");
    expect(out[0].body.to).toEqual(["owner@trov.test"]);
    expect(out[0].body.from).toBe("Trov <hello@trov.dev>");
    expect(out[0].body.reply_to).toBe("meilin@saplinglearn.org");
    expect(out[0].body.subject).toBe("[Trov question] Line one Bcc: victim@x.io"); // one line: no header can be smuggled in
    expect(out[0].body.headers).toBeUndefined(); // transactional: no List-Unsubscribe
    expect(out[0].body.html + out[0].body.text).not.toContain("someone-else@evil.test");
    expect((await stored())[0]).toMatchObject({ mail_status: "sent", mail_error: null });
    expect(await platformBodies()).toEqual([]);
  });

  it("no verified address: the mail still goes, with no Reply-To, and says so", async () => {
    const out: { reply_to?: string; text: string }[] = [];
    vi.stubGlobal("fetch", (async (_i: RequestInfo | URL, init?: RequestInit) => { out.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "em_2" }), { status: 200 }); }) as typeof fetch);
    const r = await submitWith({ SUPPORT_NOTIFY_EMAIL: "owner@trov.test", NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_test" }, await cookieFor("loner", { member: false, email: "typed@x.io" }), { kind: "bug", message: "Stuck on the org picker." });
    expect(r.json).toMatchObject({ ok: true, reply_to: null });
    expect(out).toHaveLength(1);
    expect("reply_to" in out[0]).toBe(false);
    expect(out[0].text).toContain("no verified email on file");
    expect(out[0].text).not.toContain("typed@x.io");
  });

  it("failed: a provider refusal is recorded on the row, scrubbed of the key, and the submission still succeeds", async () => {
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify({ message: "bad key re_live_SECRET123 for domain" }), { status: 403 })) as typeof fetch);
    const r = await submitWith({ SUPPORT_NOTIFY_EMAIL: "owner@trov.test", NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_live_SECRET123" }, await cookieFor("meilin"));
    expect(r.status).toBe(201);
    expect(JSON.stringify(r.json)).not.toContain("SECRET123");
    const [row] = await stored();
    expect(row).toMatchObject({ status: "open", mail_status: "failed", mail_error: "resend 403: bad key [redacted] for domain" });
    expect(row.mail_at).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("failed: a thrown fetch and a misconfigured mode (resend without its key) cost nothing either", async () => {
    vi.stubGlobal("fetch", (async () => { throw new Error("connect ECONNRESET with Bearer re_live_SECRET123"); }) as typeof fetch);
    const meilin = await cookieFor("meilin");
    expect((await submitWith({ SUPPORT_NOTIFY_EMAIL: "owner@trov.test", NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "re_live_SECRET123" }, meilin)).status).toBe(201);
    expect((await submitWith({ SUPPORT_NOTIFY_EMAIL: "owner@trov.test", NOTIFICATIONS_MODE: "resend", RESEND_API_KEY: "" }, meilin)).status).toBe(201);
    const all = await stored();
    expect(all.map((s) => s.mail_status)).toEqual(["failed", "failed"]);
    expect(all[0].mail_error).toBe("connect ECONNRESET with Bearer [redacted]");
    expect(all[1].mail_error).toMatch(/RESEND_API_KEY/); // the NAME of the missing secret, never a value
    // …and the superadmin's read of them carries no key either.
    const list = await call("GET", "/api/platform/support", await boss());
    expect(JSON.stringify(list.json)).not.toContain("SECRET123");
  });

  it("everything a person typed is escaped in the HTML", () => {
    const m = renderSupportEmail({
      id: 7, kind: "bug", subject: `<img src=x onerror=alert(1)>`, message: `<script>alert("x")</script>\nline two & more`,
      reporter: { handle: "meilin", name: `<b>Mei</b>`, email: "m@x.io" }, org: { slug: "acme", name: `Acme <Robotics>` },
      route: `#tickets"><script>`, appVersion: "0.25", userAgent: `UA <x>`, reportUrl: "https://trov.test/platform/#platform/support/7", host: "trov.test",
    });
    expect(m.subject).toBe("[Trov bug] <img src=x onerror=alert(1)>");
    expect(m.html).not.toContain("<script>");
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).not.toContain("<b>Mei</b>");
    expect(m.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(m.html).toContain("data-banner"); // the shared card: banner, fluid shell
    expect(m.html).toContain("max-width:680px");
    expect(m.text).toContain("line two & more");
  });
});

describe("/api/platform/support — the superadmin's side", () => {
  const adminRoutes = (id: number): [method: string, path: string][] => [
    ["GET", "/api/platform/support"], ["GET", `/api/platform/support/${id}`],
    ["POST", `/api/platform/support/${id}/resolve`], ["POST", `/api/platform/support/${id}/reopen`],
  ];

  it("401s signed out; 404s every route for anyone who is not a superadmin — the reporter and an org owner included — and changes nothing", async () => {
    const meilin = await cookieFor("meilin");
    const { json: { id } } = await submit(meilin);
    await ensureMember("olive", "owner", ORG_B);
    for (const [method, path] of adminRoutes(id)) {
      expect((await call(method, path, "")).status, `${method} ${path} signed out`).toBe(401);
      for (const cookie of [meilin, await cookieFor("olive", { member: false }), await cookieFor("nobody", { member: false })]) {
        const r = await call(method, path, cookie);
        expect([r.status, r.json], `${method} ${path}`).toEqual([404, { error: "not_found" }]);
      }
      const bearer = await call(method, path, await boss(), undefined, { headers: { authorization: "Bearer canopy_mcp_anything" } });
      expect([bearer.status, (bearer.json as { error: string }).error], `${method} ${path} with a bearer`).toEqual([403, "forbidden"]);
    }
    expect((await stored())[0]).toMatchObject({ status: "open", resolved_by: null });
  });

  it("lists newest first with the reporter's name and verified address and the org's name; filters by status and kind; counts the open ones", async () => {
    const meilin = await cookieFor("meilin");
    const a = (await submit(meilin, { ...BODY, kind: "bug", subject: "A" })).json.id;
    const b = (await submit(meilin, { ...BODY, kind: "question", subject: "B", org: null })).json.id;
    const c = (await submit(await cookieFor("loner", { member: false }), { kind: "feedback", message: "C", subject: "C" })).json.id;
    const cookie = await boss();
    const all = await call<SupportListResponse>("GET", "/api/platform/support", cookie);
    expect(all.status).toBe(200);
    expect(all.json.reports.map((r) => r.id)).toEqual([c, b, a]);
    expect(all.json).toMatchObject({ open: 3, next_before: null });
    expect(all.json.reports[2]).toEqual({
      id: a, kind: "bug", subject: "A", message: BODY.message,
      reporter: { handle: "meilin", name: "Meilin Zhao", email: "meilin@saplinglearn.org" },
      org: { slug: "saplinglearn", name: "SaplingLearn" },
      route: "#tickets", app_version: "0.25", user_agent: UA,
      status: "open", resolved_by: null, resolved_at: null, created_at: expect.stringMatching(/^\d{4}-/),
      mail: { status: "skipped", at: expect.stringMatching(/^\d{4}-/), error: null },
    } satisfies SupportReport);
    expect(all.json.reports[1].org).toBeNull();
    expect(all.json.reports[0].reporter).toEqual({ handle: "loner", name: "loner", email: null });

    expect((await call("POST", `/api/platform/support/${b}/resolve`, cookie)).status).toBe(200);
    const ids = async (qs: string) => (await call<SupportListResponse>("GET", `/api/platform/support${qs}`, cookie)).json.reports.map((r) => r.id);
    expect(await ids("?status=open")).toEqual([c, a]);
    expect(await ids("?status=resolved")).toEqual([b]);
    expect(await ids("?status=all&kind=bug")).toEqual([a]);
    expect(await ids("?status=resolved&kind=feedback")).toEqual([]);
    // The tab's count is every open report, whatever the filter.
    expect((await call<SupportListResponse>("GET", "/api/platform/support?status=resolved", cookie)).json.open).toBe(2);
    for (const bad of ["?status=closed", "?kind=praise", "?before=abc", "?before=0", "?limit=0", "?limit=-3"]) {
      expect((await call("GET", `/api/platform/support${bad}`, cookie)).status, bad).toBe(400);
    }
  });

  it("pages with `before`: each page continues where the last ended, and the last one says so", async () => {
    const meilin = await cookieFor("meilin");
    await exec(`DELETE FROM abuse_counters`);
    const made: number[] = [];
    for (let i = 0; i < 5; i++) made.push((await submit(meilin, { kind: "bug", message: `report ${i}` })).json.id);
    const cookie = await boss();
    const p1 = await call<SupportListResponse>("GET", "/api/platform/support?limit=2", cookie);
    expect(p1.json.reports.map((r) => r.id)).toEqual([made[4], made[3]]);
    expect(p1.json.next_before).toBe(made[3]);
    const p2 = await call<SupportListResponse>("GET", `/api/platform/support?limit=2&before=${p1.json.next_before}`, cookie);
    expect(p2.json.reports.map((r) => r.id)).toEqual([made[2], made[1]]);
    const p3 = await call<SupportListResponse>("GET", `/api/platform/support?limit=2&before=${p2.json.next_before}`, cookie);
    expect(p3.json.reports.map((r) => r.id)).toEqual([made[0]]);
    expect(p3.json.next_before).toBeNull();
    // The cap: a request cannot ask for an unbounded page.
    expect((await call<SupportListResponse>("GET", "/api/platform/support?limit=9999", cookie)).json.reports).toHaveLength(5);
  });

  it("reads one; resolve stamps who and when, reopen clears both; an unknown id is 404", async () => {
    const { json: { id } } = await submit(await cookieFor("meilin"));
    const cookie = await boss();
    const got = await call<{ report: SupportReport }>("GET", `/api/platform/support/${id}`, cookie);
    expect(got.json.report).toMatchObject({ id, subject: BODY.subject, message: BODY.message, status: "open" });

    const done = await call<{ ok: true; report: SupportReport }>("POST", `/api/platform/support/${id}/resolve`, cookie);
    expect(done.json.report).toMatchObject({ status: "resolved", resolved_by: SUPERADMIN });
    const at = done.json.report.resolved_at;
    expect(at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // Resolving twice keeps the first resolver and time.
    expect((await call<{ report: SupportReport }>("POST", `/api/platform/support/${id}/resolve`, cookie)).json.report.resolved_at).toBe(at);

    const back = await call<{ ok: true; report: SupportReport }>("POST", `/api/platform/support/${id}/reopen`, cookie);
    expect(back.json.report).toMatchObject({ status: "open", resolved_by: null, resolved_at: null });

    for (const path of ["/api/platform/support/999999", "/api/platform/support/abc", "/api/platform/support/0"]) {
      expect((await call("GET", path, cookie)).status, path).toBe(404);
    }
    expect((await call("POST", "/api/platform/support/999999/resolve", cookie)).status).toBe(404);
    expect((await call("POST", "/api/platform/support/999999/reopen", cookie)).status).toBe(404);
  });

  it("a superadmin gets no way into the organization a report came from: the row holds the slug and the route, nothing read from the org", async () => {
    const { json: { id } } = await submit(await cookieFor("meilin"));
    await exec(`INSERT INTO feed (org_id, author, summary, body, artifacts, created_at) VALUES (?, 'meilin', 'CANARY-SECRET-FEED', 'CANARY-SECRET-BODY', NULL, '2026-10-08T00:00:00.000Z')`, ORG_A);
    const cookie = await cookieFor("root-admin", { member: false });
    await exec(`INSERT INTO platform_admins (person, granted_at, granted_by) VALUES ('root-admin', '2026-10-08T00:00:00.000Z', 'seed')`);
    const got = await call<{ report: SupportReport }>("GET", `/api/platform/support/${id}`, cookie);
    expect(got.status).toBe(200);
    expect(Object.keys(got.json.report).sort()).toEqual(["app_version", "created_at", "id", "kind", "mail", "message", "org", "reporter", "resolved_at", "resolved_by", "route", "status", "subject", "user_agent"]);
    expect(JSON.stringify((await call("GET", "/api/platform/support", cookie)).json)).not.toContain("CANARY");
    expect((await call("GET", "/api/o/saplinglearn/feed", cookie)).status).toBe(404);
  });
});

describe("a handle rename", () => {
  it("rewrites the reporter and the resolver (HANDLE_COLUMNS), so a report follows its person", async () => {
    for (const column of ["reporter", "resolved_by"]) {
      expect(HANDLE_COLUMNS.some(([t, c]) => t === "support_reports" && c === column), `support_reports.${column} missing from HANDLE_COLUMNS`).toBe(true);
    }
    const mine = (await submit(await cookieFor("old-me"))).json.id;
    const theirs = (await submit(await cookieFor("meilin"))).json.id;
    await exec(`INSERT INTO platform_admins (person, granted_at, granted_by) VALUES ('old-me', '2026-10-08T00:00:00.000Z', 'seed')`);
    expect((await call("POST", `/api/platform/support/${theirs}/resolve`, await cookieFor("old-me"))).status).toBe(200);

    expect(await renamePerson(platformCtx(), "old-me", "new-me")).toEqual({ ok: true });

    expect(await one(`SELECT reporter FROM support_reports WHERE id = ?`, mine)).toEqual({ reporter: "new-me" });
    expect(await one(`SELECT reporter, resolved_by FROM support_reports WHERE id = ?`, theirs)).toEqual({ reporter: "meilin", resolved_by: "new-me" });
    expect(await one(`SELECT COUNT(*) AS n FROM support_reports WHERE reporter = 'old-me' OR resolved_by = 'old-me'`)).toEqual({ n: 0 });
    // The day's allowance followed the person too.
    expect(await one(`SELECT subject FROM abuse_counters WHERE action = 'support' AND subject IN ('old-me', 'new-me')`)).toEqual({ subject: "new-me" });
    // …and Platform shows the report under the new handle.
    const got = await call<{ report: SupportReport }>("GET", `/api/platform/support/${mine}`, await boss());
    expect(got.json.report.reporter.handle).toBe("new-me");
  });
});
