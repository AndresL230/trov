/**
 * Deleting an ORGANIZATION (src/deletion/org.ts; docs/architecture/organizations.md › What deletion removes
 * and what it keeps): every row bound to it goes, in one batch, and nothing of anyone else's moves; the R2
 * objects only it pointed at go after the commit; a live subscription is cancelled at Stripe FIRST, and a
 * Stripe failure deletes nothing. Owner only, cookie only, never MCP. Stand-in Stripe; no network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import type { OrgDeletionPreview } from "@shared/deletion-core";
import { ORG_DELETE_BILLING, ORG_DELETE_KEEPS, ORG_DELETE_REMOVES } from "@shared/deletion-core";
import { docImageKey } from "@shared/doc-images";
import { ORG_TABLES } from "../src/deletion/tables";
import { orgLogoKey } from "../src/orgs/logo";
import { call, exec, one, rows } from "./helpers/orgs";
import { cookieFor, seedPerson } from "./helpers/persons";
import { ORG_A, ORG_B } from "./helpers/tenant";
import { fillOrg, memberCtx, newOrg, orgDigest, orgKeyedTables, orgRowCounts } from "./helpers/deletion";
import { mintToken } from "../src/auth/tokens";
import { FakeStripe, bcall, billingEnv, deliver, event } from "./helpers/billing";

const OWNER = "olive";
const SLUG = "doomed";

describe("the list of what an organization owns", () => {
  it("ORG_TABLES is EVERY table with an org_id column — a migration that adds one fails here until it is listed", async () => {
    const schema = (await orgKeyedTables()).sort();
    expect([...ORG_TABLES].sort()).toEqual(schema);
    expect(new Set(ORG_TABLES).size).toBe(ORG_TABLES.length);
  });
});

describe("an owner deletes their organization", () => {
  it("removes every row bound to it — every org-keyed table, its members, invites, credentials, audit — and leaves the other orgs byte for byte", async () => {
    const id = await newOrg(OWNER, SLUG);
    await fillOrg(id, OWNER, "DOOMED");
    await fillOrg(ORG_B, "boss", "BEE");
    // The org-keyed tables the fixture filled for the doomed org: nearly all of them.
    const before = await orgRowCounts(id);
    const filled = Object.entries(before).filter(([, n]) => n > 0).map(([t]) => t);
    expect(filled.length).toBeGreaterThan(55);
    // Global rows that point at the org.
    await exec(`INSERT INTO support_reports (kind, subject, message, reporter, from_org, from_org_slug, route, app_version, user_agent, status, created_at)
                VALUES ('bug', 's', 'm', ?, ?, ?, '#feed', '0.29', 'ua', 'open', '2026-10-01T00:00:00Z')`, OWNER, id, SLUG);
    const keepB = await orgDigest(ORG_B), keepA = await orgDigest(ORG_A);
    const cookie = await cookieFor(OWNER, { member: false });

    const preview = await call<OrgDeletionPreview>("GET", `/api/o/${SLUG}/deletion`, cookie);
    expect(preview.status).toBe(200);
    expect(preview.json).toMatchObject({ org: { slug: SLUG, name: `${SLUG} org` }, members: 1, pending_invites: 1, repositories: 1, subscription: null, billing_ready: true, confirm: SLUG });

    const res = await call("POST", `/api/o/${SLUG}/delete`, cookie, { confirm: SLUG });
    expect(res).toEqual({ status: 200, json: { ok: true, slug: SLUG } });

    const after = await orgRowCounts(id);
    expect(Object.entries(after).filter(([, n]) => n > 0)).toEqual([]);
    expect(await one(`SELECT 1 AS x FROM orgs WHERE id = ?`, id)).toBeNull();
    expect(await one(`SELECT 1 AS x FROM support_reports WHERE from_org = ?`, id)).toBeNull();
    // Members keep their accounts.
    expect(await one(`SELECT handle FROM persons WHERE handle = ?`, OWNER)).toEqual({ handle: OWNER });
    // Nothing of the other two organizations moved.
    expect(await orgDigest(ORG_B)).toEqual(keepB);
    expect(await orgDigest(ORG_A)).toEqual(keepA);
    // ONE record that it happened: a platform row, the slug as its reference, the owner who did it.
    const audit = await rows<{ org_id: string | null; actor: string; target: string; detail: string }>(`SELECT org_id, actor, target, detail FROM org_admin_audit WHERE action = 'org.delete'`);
    expect(audit).toEqual([{ org_id: null, actor: OWNER, target: SLUG, detail: JSON.stringify({ by: "self", members: 1 }) }]);
    // The org is gone from its owner's list, and its address answers like any unknown org.
    expect((await call<{ orgs: unknown[] }>("GET", "/api/orgs", cookie)).json.orgs).toEqual([]);
    expect((await call("GET", `/api/o/${SLUG}/me`, cookie)).status).toBe(404);
  });

  it("an agent connection that can still reach another org keeps working THERE; one into this org alone goes with its tokens", async () => {
    const id = await newOrg(OWNER, SLUG);
    await seedPerson("mo", { member: false });
    await exec(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, 'mo', 'member', '2026-10-01', 'seed'), (?, 'mo', 'member', '2026-10-01', 'seed')`, id, ORG_B);
    await exec(`INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ('cl', 'Claude Code', '[]', '2026-10-01')`);
    const grant = async (orgs: string[]) => {
      const r = await exec(`INSERT INTO oauth_grants (person, client_id, client_name, created_at, org_id, mode) VALUES ('mo', 'cl', 'Claude Code', '2026-10-01', ?, 'manual')`, orgs[0]);
      const gid = r.meta.last_row_id;
      for (const [i, o] of orgs.entries()) await exec(`INSERT INTO oauth_grant_orgs (grant_id, org_id, person, added_at) VALUES (?, ?, 'mo', ?)`, gid, o, `2026-10-0${i + 1}`);
      await exec(`INSERT INTO oauth_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, 'access', '2026-10-01', '2099-01-01')`, `tok-${gid}`, gid);
      return gid;
    };
    const both = await grant([id, ORG_B]);
    const only = await grant([id]);
    await mintToken(await memberCtx("mo", id));
    const cookie = await cookieFor(OWNER, { member: false });
    expect((await call("POST", `/api/o/${SLUG}/delete`, cookie, { confirm: SLUG })).status).toBe(200);
    expect(await one(`SELECT org_id FROM oauth_grants WHERE id = ?`, both)).toEqual({ org_id: ORG_B });
    expect(await rows(`SELECT org_id FROM oauth_grant_orgs WHERE grant_id = ?`, both)).toEqual([{ org_id: ORG_B }]);
    expect(await one(`SELECT 1 AS x FROM oauth_tokens WHERE grant_id = ?`, both)).not.toBeNull();
    expect(await one(`SELECT 1 AS x FROM oauth_grants WHERE id = ?`, only)).toBeNull();
    expect(await one(`SELECT 1 AS x FROM oauth_tokens WHERE grant_id = ?`, only)).toBeNull();
    expect(await one(`SELECT 1 AS x FROM mcp_tokens WHERE org_id = ?`, id)).toBeNull();
  });

  it("the typed confirmation must be the slug: anything else is 400 and deletes nothing", async () => {
    const id = await newOrg(OWNER, SLUG);
    const cookie = await cookieFor(OWNER, { member: false });
    for (const confirm of [undefined, "", "Doomed org", "acme"]) {
      const res = await call<{ error: string }>("POST", `/api/o/${SLUG}/delete`, cookie, confirm === undefined ? {} : { confirm });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("confirm_mismatch");
    }
    expect(await one(`SELECT id FROM orgs WHERE id = ?`, id)).toEqual({ id });
    // Case and the spaces around it do not matter.
    expect((await call("POST", `/api/o/${SLUG}/delete`, cookie, { confirm: `  DOOMED ` })).status).toBe(200);
  });

  it("only an OWNER: an admin and a member get 403, a stranger the org's 404, a token-shaped caller the cookie-only 403 — and nothing is deleted", async () => {
    const id = await newOrg(OWNER, SLUG);
    for (const [h, role] of [["adele", "admin"], ["mem", "member"]] as const) {
      await seedPerson(h, { member: false });
      await exec(`INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, ?, '2026-10-01', 'seed')`, id, h, role);
      const c = await cookieFor(h, { member: false });
      expect((await call("GET", `/api/o/${SLUG}/deletion`, c)).status).toBe(403);
      expect((await call<{ error: string }>("POST", `/api/o/${SLUG}/delete`, c, { confirm: SLUG })).json.error).toBe("forbidden");
    }
    const stranger = await cookieFor("stranger", { member: false });
    expect(await call("POST", `/api/o/${SLUG}/delete`, stranger, { confirm: SLUG })).toEqual({ status: 404, json: { error: "not_found" } });
    const owner = await cookieFor(OWNER, { member: false });
    const bearer = await call("POST", `/api/o/${SLUG}/delete`, owner, { confirm: SLUG }, { headers: { authorization: "Bearer trov_mcp_x" } });
    expect(bearer.status).toBe(403);
    expect(await one(`SELECT id FROM orgs WHERE id = ?`, id)).toEqual({ id });
  });

  it("R2: an object is deleted only when no other org (or upload) points at the same bytes", async () => {
    const id = await newOrg(OWNER, SLUG);
    const shared = "a".repeat(64), mine = "b".repeat(64), logo = "c".repeat(64), sharedArt = "d".repeat(64), myArt = "e".repeat(64), inFlight = "f".repeat(64);
    for (const sha of [shared, mine, inFlight]) await env.ARTIFACTS_BUCKET.put(docImageKey(sha), "png");
    for (const sha of [sharedArt, myArt]) await env.ARTIFACTS_BUCKET.put(`artifacts/${sha}`, "bytes");
    await env.ARTIFACTS_BUCKET.put(orgLogoKey(logo), "logo");
    const img = (org: string, sha: string) => exec(`INSERT INTO doc_images (org_id, sha256, content_type, size_bytes, uploaded_by, created_at) VALUES (?, ?, 'image/png', 3, 'x', '2026-10-01')`, org, sha);
    await img(id, shared); await img(ORG_B, shared); await img(id, mine); await img(id, inFlight);
    // Another org is uploading `inFlight` right now (a live, unused token): its object stays.
    await exec(`INSERT INTO doc_image_upload_tokens (token_hash, principal, sha256, size_bytes, content_type, expires_at, created_at, org_id) VALUES ('t1', 'boss', ?, 3, 'image/png', '2099-01-01', '2026-10-01', ?)`, inFlight, ORG_B);
    const page = async (org: string, slug: string) => (await exec(`INSERT INTO artifact_pages (org_id, slug, title, kind, area, author_id, status, visibility, current_version, created_at, updated_at) VALUES (?, ?, 't', 'image', 'auth', 'x', 'draft', 'org', 1, '2026-10-01', '2026-10-01')`, org, slug)).meta.last_row_id;
    const version = (org: string, pageId: number, sha: string) => exec(`INSERT INTO artifact_versions (org_id, page_id, version_no, summary, r2_key, size_bytes, content_type, sha256, created_by, created_at) VALUES (?, ?, 1, '', ?, 5, 'image/png', ?, 'x', '2026-10-01')`, org, pageId, `artifacts/${sha}`, sha);
    await version(id, await page(id, "a1"), sharedArt);
    await version(id, await page(id, "a2"), myArt);
    await version(ORG_B, await page(ORG_B, "b1"), sharedArt);
    await exec(`UPDATE orgs SET logo_sha = ?, logo_source = 'upload' WHERE id = ?`, logo, id);

    const cookie = await cookieFor(OWNER, { member: false });
    expect((await call("POST", `/api/o/${SLUG}/delete`, cookie, { confirm: SLUG })).status).toBe(200);
    const exists = async (key: string) => (await env.ARTIFACTS_BUCKET.head(key)) !== null;
    expect(await exists(docImageKey(shared))).toBe(true);
    expect(await exists(docImageKey(inFlight))).toBe(true);
    expect(await exists(`artifacts/${sharedArt}`)).toBe(true);
    expect(await exists(docImageKey(mine))).toBe(false);
    expect(await exists(`artifacts/${myArt}`)).toBe(false);
    expect(await exists(orgLogoKey(logo))).toBe(false);
  });

  it("an org logo another org also shows stays", async () => {
    const id = await newOrg(OWNER, SLUG);
    const logo = "9".repeat(64);
    await env.ARTIFACTS_BUCKET.put(orgLogoKey(logo), "logo");
    await exec(`UPDATE orgs SET logo_sha = ? WHERE id IN (?, ?)`, logo, id, ORG_B);
    expect((await call("POST", `/api/o/${SLUG}/delete`, await cookieFor(OWNER, { member: false }), { confirm: SLUG })).status).toBe(200);
    expect(await env.ARTIFACTS_BUCKET.head(orgLogoKey(logo))).not.toBeNull();
  });
});

// ── billing ──────────────────────────────────────────────────────────────────

let stripe: FakeStripe;
beforeEach(() => { stripe = new FakeStripe(); vi.stubGlobal("fetch", stripe.fetch); });
afterEach(() => { vi.unstubAllGlobals(); });

/** `handle` buys Pro, the webhook lands, and they create `slug`. */
async function paidOrg(handle: string, slug: string) {
  const cookie = await cookieFor(handle, { member: false, email: `${handle}@example.com`, verified: true });
  expect((await bcall("GET", `/billing/start?plan=team`, cookie)).status).toBe(303);
  const session = stripe.lastSession();
  const sub = stripe.pay(session.id, 3);
  await deliver(event("checkout.session.completed", stripe.sessionJson(session)));
  expect((await bcall("POST", "/api/orgs", cookie, { slug, name: slug })).status).toBe(201);
  const id = (await one<{ id: string }>(`SELECT id FROM orgs WHERE slug = ?`, slug))!.id;
  return { cookie, sub, session, id };
}

describe("an organization that pays", () => {
  it("its subscription is cancelled at Stripe NOW — no proration, no final invoice — before anything is deleted; a webhook afterwards brings nothing back", async () => {
    const { cookie, sub, session, id } = await paidOrg("payer", "paidco");
    const preview = await bcall<OrgDeletionPreview>("GET", "/api/o/paidco/deletion", cookie);
    expect(preview.json.subscription).toMatchObject({ cancel_at_period_end: false });
    expect(preview.json.billing_ready).toBe(true);

    const res = await bcall("POST", "/api/o/paidco/delete", cookie, { confirm: "paidco" });
    expect(res.status).toBe(200);
    const cancels = stripe.callsTo("DELETE", `/v1/subscriptions/${sub.id}`);
    expect(cancels).toHaveLength(1);
    expect([...cancels[0].params.keys()]).toEqual([]); // Stripe's defaults: prorate=false, invoice_now=false — nothing refunded
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("canceled");
    expect(await one(`SELECT 1 AS x FROM orgs WHERE id = ?`, id)).toBeNull();
    // Trov keeps no billing row for it — Stripe keeps the customer and the invoices — except the event ledger.
    expect(await one(`SELECT COUNT(*) AS n FROM billing_subscriptions WHERE subscription_id = ?`, sub.id)).toEqual({ n: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM billing_checkouts WHERE session_id = ?`, session.id)).toEqual({ n: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM org_grants WHERE external_ref = ?`, sub.id)).toEqual({ n: 0 });
    const audit = await one<{ detail: string }>(`SELECT detail FROM org_admin_audit WHERE action = 'org.delete'`);
    expect(JSON.parse(audit!.detail)).toEqual({ by: "self", members: 1, stripe: { customer: sub.customer, subscriptions: [sub.id], cancelled: [sub.id] } });

    // Stripe's own events about it, after the fact: acknowledged, nothing written, nothing resurrected.
    for (const ev of [
      event("customer.subscription.deleted", stripe.subscriptionJson(sub)),
      event("invoice.paid", { id: "in_late", subscription: sub.id }),
      event("checkout.session.completed", stripe.sessionJson(session)),
    ]) {
      const r = await deliver(ev);
      expect(r.status).toBe(200);
      expect(["unknown_subscription", "unknown_checkout"]).toContain((r.json as { outcome: string }).outcome);
    }
    expect(await one(`SELECT COUNT(*) AS n FROM orgs WHERE slug = 'paidco'`)).toEqual({ n: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM org_grants`)).toEqual({ n: 0 });
    expect(await one(`SELECT COUNT(*) AS n FROM billing_subscriptions`)).toEqual({ n: 0 });
  });

  it("Stripe failing: 502 with a sentence to act on, and NOTHING is deleted", async () => {
    const { cookie, sub, id } = await paidOrg("payer", "paidco");
    const before = await orgDigest(id);
    stripe.fail = (c) => (c.method === "DELETE" ? Response.json({ error: { type: "api_error", message: "Stripe is down" } }, { status: 500 }) : null);
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await bcall<{ error: string; message: string }>("POST", "/api/o/paidco/delete", cookie, { confirm: "paidco" });
    spy.mockRestore();
    expect(res.status).toBe(502);
    expect(res.json.error).toBe("billing_failed");
    expect(res.json.message).toMatch(/nothing was deleted/i);
    expect(stripe.subscriptions.get(sub.id)!.status).toBe("active");
    expect(await orgDigest(id)).toEqual(before);
    // Stripe back: the same request goes through.
    stripe.fail = null;
    expect((await bcall("POST", "/api/o/paidco/delete", cookie, { confirm: "paidco" })).status).toBe(200);
  });

  it("a cancel that landed though its answer was lost counts: Stripe is asked again", async () => {
    const { cookie, sub } = await paidOrg("payer", "paidco");
    stripe.fail = (c) => {
      if (c.method !== "DELETE") return null;
      stripe.subscriptions.get(sub.id)!.status = "canceled"; // it happened at Stripe…
      return new Response("upstream timeout", { status: 504 }); // …and the answer never arrived
    };
    expect((await bcall("POST", "/api/o/paidco/delete", cookie, { confirm: "paidco" })).status).toBe(200);
  });

  it("an open checkout for the org is expired at Stripe, so nobody can pay for it after it is gone", async () => {
    const id = await newOrg("freeowner", "freeco");
    await exec(`UPDATE orgs SET plan = 'free' WHERE id = ?`, id);
    const cookie = await cookieFor("freeowner", { member: false });
    const up = await bcall<{ url: string }>("POST", "/api/o/freeco/billing/upgrade", cookie, {});
    expect(up.status).toBe(200);
    const session = stripe.lastSession();
    expect(session.status).toBe("open");
    expect((await bcall("POST", "/api/o/freeco/delete", cookie, { confirm: "freeco" })).status).toBe(200);
    expect(stripe.sessions.get(session.id)!.status).toBe("expired");
  });

  it("a deployment without Stripe keys cannot cancel a live subscription: 503, nothing deleted", async () => {
    const { cookie, id } = await paidOrg("payer", "paidco");
    const off: Env = { ...billingEnv(), STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" };
    const preview = await bcall<OrgDeletionPreview>("GET", "/api/o/paidco/deletion", cookie, undefined, { env: off });
    expect(preview.json.billing_ready).toBe(false);
    const res = await bcall<{ error: string }>("POST", "/api/o/paidco/delete", cookie, { confirm: "paidco" }, { env: off });
    expect(res.status).toBe(503);
    expect(res.json.error).toBe("billing_unavailable");
    expect(await one(`SELECT id FROM orgs WHERE id = ?`, id)).toEqual({ id });
  });
});

describe("the words", () => {
  it("say what is removed, what is kept and the billing policy", () => {
    expect(ORG_DELETE_REMOVES).toMatch(/docs.*tickets.*artifacts.*members and invitations/);
    expect(ORG_DELETE_KEEPS).toMatch(/keep their Trov accounts/);
    expect(ORG_DELETE_BILLING).toMatch(/cancelled at Stripe right away.*not refunded/);
  });
});
