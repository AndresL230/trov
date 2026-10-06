import { Hono, type Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { PERSON_COLORS } from "@shared/rows";
import { avatarSrc } from "@shared/people";
import type { AppEnv } from "./principal";
import { isAdmin, resolveSessionPrincipal } from "./principal";
import { pkce, randomToken, hmacSeal, hmacUnseal } from "./crypto";
import { buildAuthorizeUrl, exchangeCode, getUser, getPrimaryEmail, isActiveOrgMember, SAPLING_ORG } from "./github";
import { buildGoogleAuthorizeUrl, exchangeGoogleCode, verifyGoogleIdToken } from "./google";
import { createSession, setSessionCookie, readSessionCookie, deleteSession, clearSessionCookie } from "./session";
import { mintToken, listTokens, revokeToken } from "./tokens";
import { getPerson, listIdentities, findIdentity, handleAvailable, createPerson, HandleTakenError, linkIdentity, unlinkIdentity, updateProfile, renamePerson, soleTitle } from "./persons";
import { run } from "../data/platform-sql";
import { completeSignIn, linkSignIn, sealOnboard, openOnboard, ONBOARD_COOKIE, ONBOARD_TTL_S, type ProviderProfile, type ForkResult } from "./onboard";
import { findLiveInvite, acceptInvite } from "./invites";
import { sendWelcome } from "../notifications/welcome";
import { takeOAuthPending } from "./oauth-routes";
import { listGrants, revokeGrant } from "./oauth";
import { platformContext } from "../data/gate";
import { resolveSoleTenant } from "../data/context";
import { joinLegacyOrg, legacySystemTenant } from "../data/legacy";

const OAUTH_TX_COOKIE = "oauth_tx";
export interface AuthDeps { fetchImpl?: typeof fetch; now?: () => number }

/**
 * The OAuth callback URL for this request. GitHub/Google require an https callback for
 * public hosts (http is only valid for localhost), so we force https for everything
 * except local dev. Without this, a request that reached the Worker over http (e.g.
 * before an edge http->https upgrade, or a bare-hostname browser navigation) would emit
 * an http redirect_uri that the provider rejects. The same value is used for the
 * authorize redirect and the token exchange, so they always match.
 */
export function callbackUrl(reqUrl: string, provider: "github" | "google" = "github"): string {
  const u = new URL(reqUrl);
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  const scheme = isLocal ? u.protocol.replace(/:$/, "") : "https";
  return `${scheme}://${u.host}${provider === "google" ? "/auth/google/callback" : "/auth/callback"}`;
}

type TxMode = "signin" | "link";
async function beginTx(c: Context<AppEnv>, mode: TxMode): Promise<{ state: string; challenge: string }> {
  const state = randomToken(16);
  const { verifier, challenge } = await pkce();
  const sealed = await hmacSeal(`${state}.${verifier}.${mode}`, c.env.COOKIE_SECRET);
  setCookie(c, OAUTH_TX_COOKIE, sealed, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 600 });
  return { state, challenge };
}

export function buildAuthApp(deps: AuthDeps = {}): Hono<AppEnv> {
  const authApp = new Hono<AppEnv>();
  // Everything here is person-level: the global tables through `c.var.p`, never a tenant. Set here as
  // well as in src/routes.ts so the sub-app stands alone.
  authApp.use("*", platformContext);
  const f = deps.fetchImpl;

  /** Common tail after a provider profile is in hand. */
  async function finish(c: Context<AppEnv>, mode: TxMode, profile: ProviderProfile, denied: string) {
    if (mode === "link") {
      const me = await resolveSessionPrincipal(c);
      if (!me) return c.json({ error: "unauthorized" }, 403);
      const r = await linkSignIn(c.var.p, me.handle, profile);
      if (r === "linked") return c.redirect("/#settings", 302);
      // Two distinct conflict states: the identity belongs to someone else (real
      // conflict) vs. the caller already has an identity of this provider (their own,
      // just re-clicked) — surfaced as separate query values so the client can flash
      // the right message instead of one generic "conflict".
      return c.redirect(r === "provider_already_linked" ? "/?link=already#settings" : "/?link=conflict#settings", 302);
    }
    const r: ForkResult = await completeSignIn(c.var.p, profile);
    if (r.kind === "denied") return c.redirect(denied, 302);
    if (r.kind === "onboard") {
      setCookie(c, ONBOARD_COOKIE, await sealOnboard(r.payload, c.env.COOKIE_SECRET), { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: ONBOARD_TTL_S });
      return c.redirect("/#onboard", 302);
    }
    const { id } = await createSession(c.var.p, r.handle);
    await setSessionCookie(c, id, c.env.COOKIE_SECRET);
    // Signed in from an MCP client's authorize link: go back to the consent screen.
    return c.redirect((await takeOAuthPending(c)) ?? "/", 302);
  }

  async function openTx(c: Context<AppEnv>) {
    const code = c.req.query("code"); const state = c.req.query("state");
    const sealedTx = getCookie(c, OAUTH_TX_COOKIE);
    deleteCookie(c, OAUTH_TX_COOKIE, { path: "/" });
    if (!code || !state || !sealedTx) return { error: c.json({ error: "invalid_request" }, 400) };
    const tx = await hmacUnseal(sealedTx, c.env.COOKIE_SECRET);
    if (!tx) return { error: c.json({ error: "bad_state" }, 403) };
    const [txState, verifier, mode] = tx.split(".");
    if (txState !== state) return { error: c.json({ error: "state_mismatch" }, 403) };
    return { code, verifier, mode: (mode === "link" ? "link" : "signin") as TxMode };
  }

  // ── GitHub ──
  authApp.get("/login", async (c) => {
    const mode: TxMode = c.req.query("link") === "1" && (await resolveSessionPrincipal(c)) ? "link" : "signin";
    const { state, challenge } = await beginTx(c, mode);
    return c.redirect(buildAuthorizeUrl({ clientId: c.env.GITHUB_CLIENT_ID, redirectUri: callbackUrl(c.req.url), state, challenge }), 302);
  });
  authApp.get("/callback", async (c) => {
    const tx = await openTx(c);
    if ("error" in tx) return tx.error;
    const token = await exchangeCode({ env: c.env, code: tx.code, redirectUri: callbackUrl(c.req.url), verifier: tx.verifier, fetchImpl: f });
    if (!token) return c.json({ error: "exchange_failed" }, 401);
    const gh = await getUser(token, f);
    if (!gh) return c.json({ error: "identity_failed" }, 401);
    if (!(await isActiveOrgMember(token, f))) return c.redirect("/?denied=1", 302);
    const profile: ProviderProfile = { provider: "github", subject: gh.login, label: gh.login, email: await getPrimaryEmail(token, f), name: gh.name, avatar_url: gh.avatar_url };
    return finish(c, tx.mode, profile, "/?denied=1");
  });

  // ── Google ──
  authApp.get("/google/login", async (c) => {
    if (!c.env.GOOGLE_CLIENT_ID) return c.json({ error: "google sign-in is not configured" }, 503);
    const mode: TxMode = c.req.query("link") === "1" && (await resolveSessionPrincipal(c)) ? "link" : "signin";
    const { state, challenge } = await beginTx(c, mode);
    return c.redirect(buildGoogleAuthorizeUrl({
      clientId: c.env.GOOGLE_CLIENT_ID, redirectUri: callbackUrl(c.req.url, "google"), state, challenge,
      loginHint: c.req.query("login_hint") || undefined, prompt: c.req.query("prompt") || undefined,
    }), 302);
  });
  authApp.get("/google/callback", async (c) => {
    const tx = await openTx(c);
    if ("error" in tx) return tx.error;
    const idToken = await exchangeGoogleCode({ env: c.env, code: tx.code, redirectUri: callbackUrl(c.req.url, "google"), verifier: tx.verifier, fetchImpl: f });
    if (!idToken) return c.json({ error: "exchange_failed" }, 401);
    const g = await verifyGoogleIdToken(idToken, { clientId: c.env.GOOGLE_CLIENT_ID ?? "", fetchImpl: f, now: deps.now });
    if (!g) return c.json({ error: "identity_failed" }, 401);
    const denied = `/?denied=invite&email=${encodeURIComponent(g.email)}`;
    if (!g.email_verified) return c.redirect(denied, 302);
    const profile: ProviderProfile = { provider: "google", subject: g.sub, label: g.email, email: g.email, name: g.name, avatar_url: g.picture };
    return finish(c, tx.mode, profile, denied);
  });

  // ── Onboarding (gated by the onboard cookie, not the session) ──
  async function onboardPayload(c: Context<AppEnv>) {
    const sealed = getCookie(c, ONBOARD_COOKIE);
    return sealed ? openOnboard(sealed, c.env.COOKIE_SECRET) : null;
  }
  authApp.get("/onboard", async (c) => {
    const p = await onboardPayload(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    return c.json({ provider: p.provider, label: p.label, email: p.email, name: p.name, avatar_url: p.avatar_url, suggested_handle: p.suggested_handle });
  });
  authApp.get("/handle-check", async (c) => {
    // Onboarding (no session yet) OR a signed-in person checking a rename target — either
    // capability is enough. sessionGate lets this path through as public, so both branches
    // are checked here.
    if (!(await onboardPayload(c)) && !(await resolveSessionPrincipal(c))) return c.json({ error: "unauthorized" }, 401);
    return c.json(await handleAvailable(c.var.p, (c.req.query("handle") ?? "").trim()));
  });
  const OnboardWrite = z.object({ handle: z.string().trim(), name: z.string().trim().max(120).nullable().optional(), color: z.enum(PERSON_COLORS) });
  authApp.post("/onboard", async (c) => {
    const p = await onboardPayload(c);
    if (!p) return c.json({ error: "unauthorized" }, 401);
    const parsed = OnboardWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    // A sealed onboard cookie is a capability, but it can be replayed (a second POST
    // with the same cookie and a different handle) — once the (provider, subject) pair
    // is actually linked, treat the cookie as spent instead of racing createPerson into
    // an orphan persons row that linkIdentity's PK conflict would otherwise leave behind.
    if (await findIdentity(c.var.p, p.provider, p.subject)) {
      deleteCookie(c, ONBOARD_COOKIE, { path: "/" });
      return c.json({ error: "already_onboarded" }, 409);
    }
    const avail = await handleAvailable(c.var.p, parsed.data.handle);
    if (!avail.available) return c.json({ error: avail.reason === "taken" ? "handle_taken" : `handle_${avail.reason}` }, avail.reason === "taken" ? 409 : 400);
    if (p.invite_email && !(await findLiveInvite(c.var.p, p.invite_email))) return c.json({ error: "invite_revoked" }, 403);
    try {
      await createPerson(c.var.p, { handle: parsed.data.handle, name: parsed.data.name ?? p.name, color: parsed.data.color, avatar_url: p.avatar_url, avatar_source: p.provider, email: p.email });
    } catch (e) {
      if (e instanceof HandleTakenError) return c.json({ error: "handle_taken" }, 409);
      throw e;
    }
    try {
      await linkIdentity(c.var.p, { provider: p.provider, subject: p.subject, label: p.label, person: parsed.data.handle, linkedBy: parsed.data.handle });
    } catch (e) {
      // The findIdentity pre-check above closes the common replay window, but a second
      // request racing between that check and this insert can still collide on the
      // (provider, subject) primary key — never leave a persons row with no identity.
      await run(c.var.p, `DELETE FROM persons WHERE handle = ?`, parsed.data.handle);
      if (/UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e))) return c.json({ error: "already_onboarded" }, 409);
      throw e;
    }
    // MT: until org invites exist (Phase 4), signing up IS joining the legacy org — after the identity is
    // linked, so the compensating DELETE above never meets a membership row.
    await joinLegacyOrg(c.var.p, parsed.data.handle);
    if (p.invite_email) await acceptInvite(c.var.p, p.invite_email, parsed.data.handle);
    deleteCookie(c, ONBOARD_COOKIE, { path: "/" });
    const { id } = await createSession(c.var.p, parsed.data.handle);
    await setSessionCookie(c, id, c.env.COOKIE_SECRET);
    // The welcome email, once the person exists and their session is in hand. It
    // is a courtesy, not part of the write: `sendWelcome` never throws, and its
    // outcome is deliberately ignored here so a mailer problem can never cost
    // somebody their sign-up. No address on file (GitHub returned none) = no mail.
    const email = p.email;
    if (email) {
      const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
      // MT: onboarding has no tenant yet — the welcome goes out under the legacy org's mail settings.
      await sendWelcome(c.env, legacySystemTenant(c.env, "system"), {
        email, name: parsed.data.name ?? p.name, handle: parsed.data.handle, origin, fetchImpl: deps.fetchImpl,
      });
    }
    // Signed up from an MCP client's authorize link: the SPA follows `redirect` back
    // to the consent screen instead of Get Started.
    const redirect = await takeOAuthPending(c);
    return c.json({ ok: true, handle: parsed.data.handle, ...(redirect ? { redirect } : {}) });
  });

  // ── Session-gated ──
  authApp.get("/me", async (c) => {
    const handle = c.get("principal").handle;
    const row = await getPerson(c.var.p, handle);
    const identities = (await listIdentities(c.var.p, handle)).map((i) => ({ provider: i.provider, label: i.label, linked_at: i.linked_at }));
    // `avatar_url` goes out RESOLVED: an uploaded avatar (0036) outranks the provider's. `role` is the
    // title held in the person's only org (Q9: it lives on the membership) — null with none or several.
    return c.json({ handle, name: row?.name ?? null, avatar_url: row ? avatarSrc(row) : null, role: row ? await soleTitle(c.var.p, handle) : null, color: row?.color ?? "stone", identities, org: SAPLING_ORG, admin: isAdmin(c.env, handle) });
  });
  const ProfileWrite = z.object({ name: z.string().trim().max(120).nullable().optional(), color: z.enum(PERSON_COLORS).optional() });
  authApp.put("/me", async (c) => {
    const parsed = ProfileWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
    const row = await updateProfile(c.var.p, c.get("principal").handle, parsed.data);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true, name: row.name, color: row.color });
  });
  const HandleWrite = z.object({ handle: z.string().trim() });
  authApp.post("/me/handle", async (c) => {
    const parsed = HandleWrite.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid payload" }, 400);
    const oldHandle = c.get("principal").handle;
    const newHandle = parsed.data.handle;
    // Case-insensitive "same" first: a no-op rename (including an admin re-submitting
    // their own handle in a different case) is never an admin-allowlist question.
    if (oldHandle.toLowerCase() === newHandle.toLowerCase()) return c.json({ error: "handle_same" }, 400);
    if (isAdmin(c.env, oldHandle) && !isAdmin(c.env, newHandle)) return c.json({ error: "admin_handle_not_allowlisted" }, 403);
    const r = await renamePerson(c.var.p, oldHandle, newHandle);
    if (!r.ok) {
      if (r.reason === "taken") return c.json({ error: "handle_taken" }, 409);
      // Defensive only — oldHandle always comes from a live session, so the person
      // is guaranteed to exist; this branch is unreachable from this route in practice.
      if (r.reason === "not_found") return c.json({ error: "not found" }, 404);
      return c.json({ error: `handle_${r.reason}` }, 400);
    }
    return c.json({ ok: true, handle: newHandle });
  });
  authApp.post("/identities/:provider/unlink", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "google") return c.json({ error: "unknown provider" }, 400);
    const r = await unlinkIdentity(c.var.p, c.get("principal").handle, provider);
    if (r === "last_identity") return c.json({ error: "last_identity" }, 409);
    if (r === "not_found") return c.json({ error: "not linked" }, 404);
    return c.json({ ok: true });
  });
  authApp.post("/logout", async (c) => {
    const id = await readSessionCookie(c, c.env.COOKIE_SECRET);
    if (id) await deleteSession(c.var.p, id);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });
  authApp.post("/mcp-token", async (c) => {
    // MT: a token is minted FOR an org (§7.1). Until `/api/o/:slug/mcp-tokens` exists (Phase 5a) that is the
    // caller's only org — the same cut-over alias every tenant route resolves through.
    const sole = await resolveSoleTenant(c.env, c.get("principal").handle, "session");
    if (!sole.ok) return c.json({ error: "org_required" }, 409);
    const { raw } = await mintToken(c.var.p, c.get("principal").handle, sole.ctx.orgId);
    return c.json({ token: raw });
  });
  authApp.get("/mcp-tokens", async (c) => c.json({ tokens: await listTokens(c.var.p, c.get("principal").handle) }));
  authApp.post("/mcp-tokens/:id/revoke", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || !(await revokeToken(c.var.p, c.get("principal").handle, id))) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });
  // Settings › Connected apps: the caller's OAuth connections. Session-cookie only,
  // never MCP. Someone else's id is the same 404 as an unknown one.
  authApp.get("/oauth-grants", async (c) => c.json({ grants: await listGrants(c.var.p, c.get("principal").handle) }));
  authApp.post("/oauth-grants/:id/revoke", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || !(await revokeGrant(c.var.p, c.get("principal").handle, id, Date.now()))) return c.json({ error: "not_found" }, 404);
    return c.json({ ok: true });
  });
  return authApp;
}

export const authApp = buildAuthApp();
