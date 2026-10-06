import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { IngestPayload, QueryType } from "@shared/contract";
import type { AppEnv } from "./auth/principal";
import { sessionGate, isAdmin } from "./auth/principal";
import { authApp } from "./auth/routes";
import { oauthApp } from "./auth/oauth-routes";
import { notificationsApp } from "./notifications/routes";
import { artifactsApp } from "./artifacts/routes";
import { rawApp, rawHeaders } from "./artifacts/raw";
import { ingestDocProposal, recordBatch } from "./consumer";
import { runBackfill, isFinalBackfillBatch } from "./tools/backfill";
import { get_doc, list_docs, list_doc_meta, get_feed, query, list_needs_triage, list_adrs, list_proposals, list_identity_tasks, list_discarded_identities, list_tickets, get_ticket, ticket_badge } from "./tools/reads";
import {
  create_ticket, edit_ticket, transition_ticket, move_ticket, toggle_assignee, add_ticket_link, remove_ticket_link, delete_ticket,
  set_ticket_sprint, set_ticket_parent, add_ticket_comment,
  TicketError, TICKET_ERROR_STATUS,
} from "./tools/tickets";
import {
  TicketCreate, TicketEdit, TicketTransition, TicketMove, TicketAssigneeToggle, TicketLinkAdd,
  TicketSprintSet, TicketParentSet, TicketCommentAdd, TicketSeg, TicketAssigneeFilter, TicketCategory,
} from "@shared/tickets";
import { promote_doc, ratify_adr, reject_doc_version, reject_adr, resolve_triage, assign_triage, map_identity, discard_identity_task, restore_identity_task, IdentityTaskError, type AssignType } from "./tools/writes";
import {
  create_sprint, set_sprint_active, complete_sprint, add_sprint_resource, delete_sprint, list_sprints, get_sprint,
  SprintError, SPRINT_ERROR_STATUS,
} from "./tools/sprints";
import { SprintCreate, SprintActiveSet, SprintResourceAdd } from "@shared/sprints";
import { get_plan } from "./tools/plan";
import {
  listHandoffs, getHandoff, createHandoff, claimHandoff, expireHandoff, HandoffCreateInput, HandoffError, HANDOFF_ERROR_STATUS,
} from "./tools/handoffs";
import { listPrompts, getPrompt, recordPromptUse, listPromptVersions, savePrompt, setPromptTags, publishPrompt, deletePrompt, restorePrompt, PromptSaveInput, PromptError, PROMPT_ERROR_STATUS } from "./tools/prompts";
import { isSection } from "@shared/vocabulary";
import { HANDOFF_BOXES, type HandoffBox } from "@shared/handoffs";
import { getMyWork } from "./tools/mywork";
import { quickSearch } from "./tools/quick-search";
import { QUICK_TYPES, type QuickType } from "@shared/quick-search";
import { feedStats, isFeedStatsDays, isFeedStatsTz } from "./tools/feed-stats";
import { getRepoDashboard, emptyRepoDashboard } from "./tools/repo";
import { reconcileRepo, type ReconcileResult } from "./repo/github";
import { repoEnvironments } from "./repo/config";
import { runLockedRepoRefresh, runUsagePolls } from "./repo/cron";
import type { DashboardData } from "@shared/dashboard";
import { first } from "./db";
import { platformContext, soleTenantGate, tenantGate } from "./data/gate";
import { orgsApp, myInvitesApp, orgTenantApp } from "./orgs/routes";
import { platformApp } from "./platform/routes";
import { legacyDb } from "./data/legacy";
import { createInvite, revokeInvite, listInvites } from "./auth/invites";
import { listPersons } from "./auth/persons";
import { sendInvite } from "./notifications/invite";
import type { InviteRow } from "@shared/rows";
import { readDocImage } from "./tools/doc-images";
import { getPersonProfile, writePersonProfile, setAvatar, clearAvatar, readAvatar, PeopleError, PEOPLE_ERROR_STATUS } from "./tools/people";
import { AVATAR_MAX_BYTES } from "@shared/people";

export const app = new Hono<AppEnv>();

// The raw artifact route's lock-down headers wrap EVERYTHING under /raw/, the gate's
// own 401 included — so this one middleware runs before the gate.
app.use("/raw/*", rawHeaders);

// Gate first: everything except /auth/login and /auth/callback requires a session.
// Fails closed with 401 (no data in the body).
app.use("*", sessionGate);

// The data-layer contexts (src/data/gate.ts): `c.var.p` for the global tables on every request, and
// `c.var.ctx` — the caller's ONE org, the cut-over alias — on every session route below that is not
// person-level (/auth/*, /avatar/*). A signed-in person with no single org gets 409 `org_required`.
app.use("*", platformContext);
app.use("*", soleTenantGate);

// Artifacts (issue #52): the JSON API and the raw bytes, both session-gated. The
// token-authenticated upload PUT is dispatched in src/index.ts, before this app.
app.route("/api/artifacts", artifactsApp);
app.route("/raw/a", rawApp);

// Doc images: the bytes behind `![alt](/img/<sha256>)` in a doc body, session-gated like
// the docs themselves. Content-addressed and immutable, so the cache can keep them
// forever; `default-src 'none'` + nosniff so the bytes are only ever an image.
app.get("/img/:sha", async (c) => {
  const sha = c.req.param("sha");
  const lockdown = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!/^[0-9a-f]{64}$/.test(sha)) return c.json({ error: "not_found" }, 404, lockdown);
  const img = await readDocImage(legacyDb(c.var.ctx), c.env.ARTIFACTS_BUCKET, sha);
  if (!img) return c.json({ error: "not_found" }, 404, lockdown);
  return new Response(img.body, {
    headers: {
      ...lockdown,
      "content-type": img.content_type,
      "content-length": String(img.size_bytes),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
});

// Person avatars (0036): the bytes behind an uploaded `/avatar/<sha256>`, served exactly
// like a doc image — session-gated, content-addressed and immutable, `default-src 'none'`
// + nosniff. The type is the one SNIFFED at upload (the R2 object's own metadata).
app.get("/avatar/:sha", async (c) => {
  const lockdown = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  const img = await readAvatar(c.env.ARTIFACTS_BUCKET, c.req.param("sha"));
  if (!img) return c.json({ error: "not_found" }, 404, lockdown);
  return new Response(img.body, {
    headers: {
      ...lockdown,
      "content-type": img.content_type,
      "content-length": String(img.size_bytes),
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
});

// Auth endpoints (login/callback public via the gate's allowlist; logout/mcp-token gated).
app.route("/auth", authApp);

// MCP OAuth (/.well-known/oauth-*, /oauth/*): public per the gate's prefix check;
// /oauth/authorize reads the session itself.
app.route("/", oauthApp);

// Email notification prefs/policy/settings/outbox (session-gated; admin routes
// re-check isAdmin inside). The signed one-click unsubscribe POST is NOT here —
// it lives in src/index.ts, outside the gate, and can only turn email off.
app.route("/api/notifications", notificationsApp);

// Orgs (§5.3) and the superadmin surface (§5.4). `/api/o/:slug/*` names its org in the path: `tenantGate`
// resolves the membership (404 for a non-member) for every sub-app mounted under it.
app.use("/api/o/:slug/*", tenantGate);
app.route("/api/orgs", orgsApp);
app.route("/api/invites", myInvitesApp);
app.route("/api/o/:slug", orgTenantApp);
app.route("/api/platform", platformApp);

app.post("/ingest", async (c) => {
  const json = await c.req.json().catch(() => null);
  const parsed = IngestPayload.safeParse(json);
  if (!parsed.success) {
    return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  }
  // SEAM: a Cloudflare Queue producer.send({ payload, principal }) would slot in here.
  // recordBatch = consume() + the post-batch artifact_links step, identical to MCP record_session.
  const result = await recordBatch(legacyDb(c.var.ctx), parsed.data, c.get("principal"));
  return c.json({ ok: true, result });
});

app.get("/docs", async (c) => {
  // `?fields=meta` drops the bodies (and ignores `section`) — a list-only read.
  if (c.req.query("fields") === "meta") return c.json({ docs: await list_doc_meta(legacyDb(c.var.ctx)) });
  const docs = await list_docs(legacyDb(c.var.ctx), c.req.query("section"));
  return c.json({ docs });
});

app.get("/doc/:slug", async (c) => {
  const found = await get_doc(legacyDb(c.var.ctx), c.req.param("slug"));
  if (!found) return c.json({ error: "not found" }, 404);
  return c.json(found);
});

app.get("/feed", async (c) => {
  const tags = c.req.query("tags");
  const limit = c.req.query("limit");
  const feed = await get_feed(legacyDb(c.var.ctx), {
    author: c.req.query("author"),
    tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
    since: c.req.query("since"),
    limit: limit ? Number(limit) : undefined,
  });
  return c.json({ feed });
});

// The Feed aside's "This week": entry counts per day, people, top tags and authors over
// the WHOLE window (never the Feed's loaded page). `days` 1–30 (default 7); `tz` = the
// viewer's minutes EAST of UTC, so the day buckets are their local days (default 0 = UTC).
// A bad parameter is a 400; a failed read is a 503 `{ error }` — never a 500.
app.get("/feed/stats", async (c) => {
  const daysRaw = c.req.query("days");
  const tzRaw = c.req.query("tz");
  const days = daysRaw === undefined ? 7 : /^\d{1,3}$/.test(daysRaw) ? Number(daysRaw) : NaN;
  if (!isFeedStatsDays(days)) return c.json({ error: "days must be an integer from 1 to 30" }, 400);
  const tz = tzRaw === undefined ? 0 : /^-?\d{1,4}$/.test(tzRaw) ? Number(tzRaw) : NaN;
  if (!isFeedStatsTz(tz)) return c.json({ error: "tz must be whole minutes east of UTC, within ±840" }, 400);
  try {
    return c.json(await feedStats(legacyDb(c.var.ctx), { days, tzOffsetMin: tz }));
  } catch (e) {
    console.error("feed stats failed", e instanceof Error ? e.message : String(e));
    return c.json({ error: "Couldn't read the feed stats" }, 503);
  }
});

// Human Search backs onto the same query() engine as MCP, but include_staged is
// false — the human screen surfaces only settled (live) context, never staged.
app.get("/search", async (c) => {
  const typesCsv = c.req.query("types");
  const types = typesCsv
    ? (typesCsv.split(",").map((t) => t.trim()).filter((t): t is QueryType => QueryType.safeParse(t).success))
    : undefined;
  const spaceRaw = c.req.query("space");
  const space = spaceRaw === "technical" || spaceRaw === "product" ? spaceRaw : undefined;
  const limit = c.req.query("limit");
  const result = await query(legacyDb(c.var.ctx), {
    q: c.req.query("q") ?? "",
    types: types && types.length ? types : undefined,
    section: c.req.query("section"),
    space,
    include_staged: false,
    limit: limit ? Number(limit) : undefined,
  }, c.get("principal").handle); // the viewer: a private artifact reaches only its author
  return c.json({ result });
});

// The "search everything" dropdown (web/src/quicksearch.ts): one D1 batch of small,
// LIMITed per-type lookups — titles + one-line excerpts, never bodies — for the
// session principal, live-only like /search. `q` under 2 characters answers without
// touching D1. Never a 500: a failure is an empty answer flagged `degraded`.
app.get("/search/quick", async (c) => {
  const typesCsv = c.req.query("types");
  const types = typesCsv
    ? typesCsv.split(",").map((t) => t.trim()).filter((t): t is QuickType => (QUICK_TYPES as readonly string[]).includes(t))
    : undefined;
  const limit = Number(c.req.query("limit"));
  const q = c.req.query("q") ?? "";
  c.header("cache-control", "private, no-store");
  try {
    const result = await quickSearch(legacyDb(c.var.ctx), q, c.get("principal").handle, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
      types,
    });
    return c.json({ result });
  } catch (e) {
    console.error("search/quick failed", e instanceof Error ? e.message : String(e));
    return c.json({ result: { q: q.trim(), groups: [] }, degraded: true });
  }
});

// SEAM: POST /ask — retrieve via query(), synthesize a grounded, slug-citing answer. Out of scope.

app.get("/needs-triage", async (c) => c.json({ items: await list_needs_triage(legacyDb(c.var.ctx)) }));

app.get("/adrs", async (c) => c.json({ adrs: await list_adrs(legacyDb(c.var.ctx), c.req.query("status")) }));

// ── Review group (session-cookie only, NEVER MCP): Proposals (staged doc
// versions) + Decisions (ADR drafts) — GET /proposals, GET /adrs, and their
// promote/ratify/reject resolves. Agent produces, human confirms. ──────────

// The Proposals queue (Phase 3): staged doc versions newer than their live doc,
// not rejected, server-joined with both bodies + reconciler metadata. Kills the
// old web N+1 (audit G9) and is the data source Phase 4's detail pane renders.
app.get("/proposals", async (c) => c.json({ proposals: await list_proposals(legacyDb(c.var.ctx)) }));

// ── Handoffs + Prompt Library (session-cookie; the MCP tools are the agent side) ──
// A handoff is an addressed message, not knowledge: its writers are direct (NOT
// the ingestion gate). The prompt writers take `via: "human"` here — a person may
// save a draft or publish; the MCP save_prompt passes "agent" and is forced to
// `staged`. Errors are `{ error }` with the writers' own 400/403/404/409.
const handoffFail = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof HandoffError) return c.json({ error: e.message }, HANDOFF_ERROR_STATUS[e.code]);
  if (e instanceof PromptError) return c.json({ error: e.message }, PROMPT_ERROR_STATUS[e.code]);
  throw e;
};
const handoffId = (raw: string): number | null => (/^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null);

app.get("/api/handoffs", async (c) => {
  const box = c.req.query("box") ?? "mine";
  if (!(HANDOFF_BOXES as readonly string[]).includes(box)) return c.json({ error: "unknown box" }, 400);
  return c.json({ handoffs: await listHandoffs(legacyDb(c.var.ctx), c.get("principal").handle, box as HandoffBox) });
});
app.get("/api/handoffs/:id", async (c) => {
  const id = handoffId(c.req.param("id"));
  const handoff = id === null ? null : await getHandoff(legacyDb(c.var.ctx), id);
  return handoff ? c.json({ handoff }) : c.json({ error: "not found" }, 404);
});
app.post("/api/handoffs", async (c) => {
  const raw = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = HandoffCreateInput.safeParse(raw);
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid payload" }, 400);
  // Optional replay key, the /ingest scheme: { session: { id }, item_index }.
  const sess = raw?.session as { id?: unknown } | undefined;
  const ledger = sess && typeof sess.id === "string" && sess.id
    ? { sessionId: sess.id, itemIndex: Number.isInteger(raw?.item_index) ? (raw!.item_index as number) : 0 }
    : undefined;
  try {
    const { handoff } = await createHandoff(legacyDb(c.var.ctx), c.get("principal").handle, parsed.data, ledger);
    return c.json({ ok: true, handoff });
  } catch (e) { return handoffFail(c, e); }
});
app.post("/api/handoffs/:id/claim", async (c) => {
  const id = handoffId(c.req.param("id"));
  if (id === null) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { session?: unknown };
  const session = typeof body.session === "string" && body.session.trim() ? body.session.trim().slice(0, 120) : `web_${crypto.randomUUID().slice(0, 8)}`;
  try { return c.json({ ok: true, handoff: await claimHandoff(legacyDb(c.var.ctx), id, c.get("principal").handle, session) }); }
  catch (e) { return handoffFail(c, e); }
});
app.post("/api/handoffs/:id/expire", async (c) => {
  const id = handoffId(c.req.param("id"));
  if (id === null) return c.json({ error: "not found" }, 404);
  try { return c.json({ ok: true, handoff: await expireHandoff(legacyDb(c.var.ctx), id, c.get("principal").handle) }); }
  catch (e) { return handoffFail(c, e); }
});

app.get("/api/prompts", async (c) => {
  const tags = (c.req.query("tags") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  const want = c.req.query("sort");
  const sort = want === "updated_asc" || want === "used" ? want : "updated_desc";
  return c.json({ prompts: await listPrompts(legacyDb(c.var.ctx), { q: c.req.query("q") ?? "", tags, sort }) });
});
app.get("/api/prompts/:slug", async (c) => {
  const prompt = await getPrompt(legacyDb(c.var.ctx), c.req.param("slug"));
  return prompt ? c.json({ prompt }) : c.json({ error: "not found" }, 404);
});
app.get("/api/prompts/:slug/versions", async (c) => {
  const slug = c.req.param("slug");
  if (!(await getPrompt(legacyDb(c.var.ctx), slug))) return c.json({ error: "not found" }, 404);
  return c.json({ versions: await listPromptVersions(legacyDb(c.var.ctx), slug) });
});
app.post("/api/prompts", async (c) => {
  const parsed = PromptSaveInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid payload" }, 400);
  try { return c.json({ ok: true, prompt: await savePrompt(legacyDb(c.var.ctx), c.get("principal").handle, parsed.data, "human") }); }
  catch (e) { return handoffFail(c, e); }
});
app.post("/api/prompts/:slug/tags", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { tags?: unknown } | null;
  if (!body || !Array.isArray(body.tags) || !body.tags.every((t) => typeof t === "string")) return c.json({ error: "tags (string[]) required" }, 400);
  try { return c.json({ ok: true, prompt: await setPromptTags(legacyDb(c.var.ctx), c.req.param("slug"), body.tags as string[]) }); }
  catch (e) { return handoffFail(c, e); }
});
// One USE of a prompt (the web Copy button; MCP get_prompt counts its own): one
// conditional UPDATE, so a request counts once. Unknown slug → 404; a D1 failure is a
// 503, never a 500 — a lost count must not break the copy.
app.post("/api/prompts/:slug/used", async (c) => {
  try {
    if (!(await recordPromptUse(legacyDb(c.var.ctx), c.req.param("slug")))) return c.json({ error: "not found" }, 404);
    const prompt = await getPrompt(legacyDb(c.var.ctx), c.req.param("slug"));
    return prompt ? c.json({ ok: true, use_count: prompt.use_count, last_used_at: prompt.last_used_at }) : c.json({ error: "not found" }, 404);
  } catch {
    return c.json({ error: "temporarily unavailable" }, 503);
  }
});
// Publishing is a human confirmation, gated exactly like POST /doc/:slug/promote:
// any signed-in person (sessionGate), never an MCP tool.
app.post("/api/prompts/:slug/publish", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { version?: unknown } | null;
  const version = Number(body?.version);
  if (!Number.isInteger(version)) return c.json({ error: "version (integer) required" }, 400);
  try { return c.json({ ok: true, prompt: await publishPrompt(legacyDb(c.var.ctx), c.req.param("slug"), version) }); }
  catch (e) { return handoffFail(c, e); }
});
// Soft delete + restore (0035 PART C): the prompt's author or an admin; anyone else
// is a 403 with nothing written. Session-cookie only — there is NO MCP delete, so an
// agent can never remove a prompt. A deleted prompt's slug stays reserved (a save to
// it is a 409), and restore is the one way back.
app.post("/api/prompts/:slug/delete", async (c) => {
  const me = c.get("principal").handle;
  try { return c.json({ ok: true, ...(await deletePrompt(legacyDb(c.var.ctx), c.req.param("slug"), me, isAdmin(c.env, me))) }); }
  catch (e) { return handoffFail(c, e); }
});
app.post("/api/prompts/:slug/restore", async (c) => {
  const me = c.get("principal").handle;
  try { return c.json({ ok: true, prompt: await restorePrompt(legacyDb(c.var.ctx), c.req.param("slug"), me, isAdmin(c.env, me)) }); }
  catch (e) { return handoffFail(c, e); }
});

// A person stages a NEW doc (version 1) through the same gate an agent's
// propose_doc_update uses — so it lands in Review as a staged proposal and goes
// live only when promoted. An existing slug is a 409: this route never edits.
const DocPropose = z.object({
  title: z.string().trim().min(1).max(200),
  section: z.string().trim().min(1),
  space: z.enum(["technical", "product"]),
  body: z.string().refine((b) => b.trim().length > 0, "body required"),
  summary: z.string().max(300).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9_/-]*$/).optional(),
});
app.post("/api/docs/propose", async (c) => {
  const parsed = DocPropose.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "invalid payload" }, 400);
  const d = parsed.data;
  if (!isSection(d.section)) return c.json({ error: `unknown section: ${d.section}` }, 400);
  const slug = d.slug ?? d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  if (!slug) return c.json({ error: "title has no usable slug" }, 400);
  if (await first(legacyDb(c.var.ctx), `SELECT 1 FROM docs WHERE slug = ?`, slug)) return c.json({ error: `a doc named ${slug} already exists` }, 409);
  const result = await ingestDocProposal(
    legacyDb(c.var.ctx),
    { slug, section: d.section, space: d.space, title: d.title, body: d.body, change_summary: d.summary?.trim() || "Created in Trov", confidence: "high" },
    c.get("principal").handle,
  );
  if (result.outcome === "refused") return c.json({ error: result.reason }, 400);
  if (result.outcome !== "written") return c.json({ error: result.outcome === "triaged" ? result.reason : "nothing to stage" }, 409);
  const proposal = (await list_proposals(legacyDb(c.var.ctx))).find((p) => p.slug === slug && p.version === result.version) ?? null;
  return c.json({ ok: true, proposal });
});

// Human confirmation (session-gated): promote a staged doc version into the live doc.
app.post("/doc/:slug/promote", async (c) => {
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version)) return c.json({ error: "version (integer) required" }, 400);
  try {
    const res = await promote_doc(legacyDb(c.var.ctx), c.req.param("slug"), version, c.get("principal").handle);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): reject a staged doc version. Soft status flip
// to 'rejected' so it leaves the proposals queue; the row + body remain.
app.post("/doc/:slug/reject", async (c) => {
  const body = await c.req.json().catch(() => null);
  const version = Number(body?.version);
  if (!Number.isInteger(version)) return c.json({ error: "version (integer) required" }, 400);
  try {
    const res = await reject_doc_version(legacyDb(c.var.ctx), c.req.param("slug"), version);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human confirmation (session-gated): ratify an ADR draft.
app.post("/adr/:id/ratify", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await ratify_adr(legacyDb(c.var.ctx), id);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): reject an ADR draft. Soft flip to 'rejected'
// so it leaves the decisions queue; the row remains.
app.post("/adr/:id/reject", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await reject_adr(legacyDb(c.var.ctx), id);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): discard a triage item. Soft — sets the audit
// columns + resolved flag so it leaves the queue; never a hard-delete.
app.post("/needs-triage/:id/discard", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const res = await resolve_triage(legacyDb(c.var.ctx), id, c.get("principal").handle, "discarded");
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human write-back (session-gated): assign-materialize a triage item. Re-runs the
// item's `raw` through the SAME gate for the chosen target type, then resolves it
// as 'assigned' with assigned_ref. The author is the authenticated principal.
app.post("/needs-triage/:id/assign", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: AssignType; section?: string; space?: "technical" | "product"; tags?: string[];
  } | null;
  try {
    const res = await assign_triage(legacyDb(c.var.ctx), id, c.get("principal").handle, {
      type: body?.type,
      section: body?.section,
      space: body?.space,
      tags: body?.tags,
    });
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// ── Maintenance group (session-cookie only, NEVER MCP): Unplaced items
// (/needs-triage + assign/discard above) + Identity (below). ─────────────────

// Pending unknown-login identity tasks, each with a small LIVE activity sample
// pulled from `events` at read time — activity is never copied onto the task —
// plus the discarded logins Undo can still restore.
app.get("/identity-tasks", async (c) =>
  c.json({ tasks: await list_identity_tasks(legacyDb(c.var.ctx)), discarded: await list_discarded_identities(legacyDb(c.var.ctx)) }));

// Human placement (session-gated): link a login to an EXISTING person (by
// handle) as a github identity (a direct authored write, not a gate re-run),
// then a soft resolve of the task. My Work picks the mapping up at read time,
// so every already-captured event for this login surfaces with no backfill.
app.post("/identity-tasks/:login/map", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { person?: string } | null;
  const person = typeof body?.person === "string" ? body.person.trim() : "";
  if (!person) return c.json({ error: "person (non-empty string) required" }, 400);
  try {
    const res = await map_identity(legacyDb(c.var.ctx), c.req.param("login"), person, c.get("principal").handle);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

// Human placement (session-gated): discard a login that will never be a person
// (an outside contributor). Soft and STICKY — the row stays `discarded` with the
// audit columns, and the login is never re-raised; its events are still captured.
// Restore puts it back in the list. 404 unknown login, 409 a mapped task.
const identityFail = (c: Context<AppEnv>, e: unknown) =>
  e instanceof IdentityTaskError
    ? c.json({ error: e.message }, e.code === "not_found" ? 404 : 409)
    : c.json({ error: "temporarily unavailable" }, 503);
app.post("/identity-tasks/:login/discard", async (c) => {
  try {
    const res = await discard_identity_task(legacyDb(c.var.ctx), c.req.param("login"), c.get("principal").handle);
    return c.json({ ok: true, ...res });
  } catch (e) {
    return identityFail(c, e);
  }
});
app.post("/identity-tasks/:login/restore", async (c) => {
  try {
    const res = await restore_identity_task(legacyDb(c.var.ctx), c.req.param("login"));
    return c.json({ ok: true, ...res });
  } catch (e) {
    return identityFail(c, e);
  }
});

// Person directory (session-gated): the avatar-chip source for every screen and the identity picker.
app.get("/persons", async (c) => c.json({ persons: await listPersons(legacyDb(c.var.p)) }));

// ── People profiles (0036; the contract is shared/people.ts) — session cookie, NEVER MCP ──
// Read: any signed-in member; `responsibilities` only to the person and admins. Write:
// the person or an admin (403 otherwise, nothing written). Avatar: the viewer's OWN only.
// `me` names the viewer (it is a reserved handle, so it can never be someone else's).
// A PeopleError is its status; anything else (a D1 failure) is a 503, never a 500.
const peopleFail = (c: Context<AppEnv>, e: unknown) =>
  e instanceof PeopleError ? c.json({ error: e.message }, PEOPLE_ERROR_STATUS[e.code]) : c.json({ error: "temporarily unavailable" }, 503);
const profileHandle = (c: Context<AppEnv>): string => {
  const h = c.req.param("handle") ?? "";
  return h.toLowerCase() === "me" ? c.get("principal").handle : h;
};
const adminCheck = (c: Context<AppEnv>) => (h: string) => isAdmin(c.env, h);
app.get("/api/people/:handle", async (c) => {
  try { return c.json(await getPersonProfile(legacyDb(c.var.ctx), profileHandle(c), c.get("principal").handle, adminCheck(c))); }
  catch (e) { return peopleFail(c, e); }
});
app.put("/api/people/:handle", async (c) => {
  const body = await c.req.json().catch(() => undefined);
  try { return c.json(await writePersonProfile(legacyDb(c.var.ctx), profileHandle(c), c.get("principal").handle, adminCheck(c), body)); }
  catch (e) { return peopleFail(c, e); }
});
// Multipart, field `file`. A declared length past the cap (plus multipart framing) is
// refused before the body is read.
app.post("/api/people/me/avatar", async (c) => {
  const len = Number(c.req.header("content-length"));
  if (Number.isFinite(len) && len > AVATAR_MAX_BYTES + 64 * 1024) return c.json({ error: `an avatar is at most ${AVATAR_MAX_BYTES} bytes` }, 413);
  let file: File | null = null;
  try {
    const form = await c.req.raw.formData();
    const v = form.get("file");
    file = v && typeof v !== "string" ? (v as File) : null;
  } catch {
    return c.json({ error: "the body must be multipart/form-data" }, 400);
  }
  try { return c.json({ ok: true, ...(await setAvatar(legacyDb(c.var.ctx), c.env.ARTIFACTS_BUCKET, c.get("principal").handle, file)) }); }
  catch (e) { return peopleFail(c, e); }
});
app.post("/api/people/me/avatar/remove", async (c) => {
  try { return c.json({ ok: true, ...(await clearAvatar(legacyDb(c.var.ctx), c.get("principal").handle)) }); }
  catch (e) { return peopleFail(c, e); }
});

// ── Maintenance › People: the invite list (admin, session-cookie only, NEVER MCP) ──
const InviteWrite = z.object({ email: z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "invalid email"), name: z.string().trim().max(120).optional() });
const adminGate = async (c: Context<AppEnv>, next: () => Promise<void>) =>
  isAdmin(c.env, c.get("principal").handle) ? next() : c.json({ error: "admin only" }, 403);
app.use("/invites", adminGate);
app.use("/invites/*", adminGate);
app.get("/invites", async (c) => c.json({ invites: await listInvites(legacyDb(c.var.p)) }));
app.post("/invites", async (c) => {
  const parsed = InviteWrite.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  let invite: InviteRow;
  try {
    invite = await createInvite(legacyDb(c.var.p), { email: parsed.data.email, name: parsed.data.name ?? null, invitedBy: c.get("principal").handle });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "invite_exists" || msg === "already_a_person") return c.json({ error: msg }, 409);
    throw e;
  }
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const email = await sendInvite(c.env, legacyDb(c.var.p), { email: invite.email, inviteeName: invite.name, inviterHandle: c.get("principal").handle, origin });
  return c.json({ ok: true, invite: (await first<InviteRow>(legacyDb(c.var.p), `SELECT * FROM invites WHERE email = ?`, invite.email))!, email });
});
app.post("/invites/:email/revoke", async (c) => {
  const ok = await revokeInvite(legacyDb(c.var.p), decodeURIComponent(c.req.param("email")));
  return ok ? c.json({ ok: true }) : c.json({ error: "no such invite" }, 404);
});
app.post("/invites/:email/resend", async (c) => {
  const email = decodeURIComponent(c.req.param("email")).toLowerCase();
  const row = await first<InviteRow>(legacyDb(c.var.p), `SELECT * FROM invites WHERE email = ?`, email);
  if (!row) return c.json({ error: "no such invite" }, 404);
  if (row.revoked_at || row.accepted_by) return c.json({ error: row.revoked_at ? "revoked" : "accepted" }, 409);
  const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  const result = await sendInvite(c.env, legacyDb(c.var.p), { email: row.email, inviteeName: row.name, inviterHandle: c.get("principal").handle, origin });
  return c.json({ ok: true, email: result });
});

// Roadmap read (session-gated): admin narrative + sprints in target-date order,
// merged with cached progress from the plan store. No live GitHub, no per-user token.
app.get("/roadmap", async (c) => c.json(await get_plan(legacyDb(c.var.ctx))));

// Personal dashboard (session-gated): the signed-in user's My Work projection —
// previous activity (summarized merged/closed PRs), open assigned issues, and open
// assigned tickets (native + mirrored, with the uncapped `ticketsTotal`), all D1.
// Stored nowhere; never 500s.
app.get("/me/dashboard", async (c) => {
  const login = c.get("principal").handle;
  try {
    const data: DashboardData = await getMyWork(legacyDb(c.var.ctx), login);
    return c.json(data);
  } catch {
    // Absolute backstop: never 500. Anything unexpected (D1) → empty degraded payload.
    const empty: DashboardData = { person: null, previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: true };
    return c.json(empty);
  }
});

// The Repo dashboard — the same class of read as /me/dashboard: a D1-only
// projection over captured events, tickets and sprints (src/tools/repo.ts). No
// live GitHub; whatever Trov has no capture path for is `not_connected`.
// Stored nowhere; never 500s.
app.get("/repo/dashboard", async (c) => {
  const repo = c.env.GITHUB_REPO ?? "";
  try {
    return c.json(await getRepoDashboard(legacyDb(c.var.ctx), repo, Date.now(), repoEnvironments(c.env)));
  } catch {
    return c.json(emptyRepoDashboard(repo, true));
  }
});

// ADMIN action (session-gated + admin-gated): server-side GitHub backfill.
// A computed/authored direct writer in the promote class — humans (admins)
// trigger it — but every captured event still funnels through the ingestEvent
// gate fn. Non-admins get 403; a missing service token/repo → 503 with the error.
app.post("/admin/backfill", async (c) => {
  const login = c.get("principal").handle;
  if (!isAdmin(c.env, login)) return c.json({ error: "admin only" }, 403);
  const res = await runBackfill(c.env, login);
  if (!res.ok) return c.json({ error: res.error }, 503);
  // Best-effort, and only on the batch that ENDS a Sync (web/src/main.ts
  // re-POSTs this route up to 10 times while the summary budget stays
  // exhausted): reconcileRepo redoes ~250 no-op statements on an
  // already-reconciled repo, so running it on every intermediate batch would
  // waste that work 9 times over for nothing. `repo` is present in the
  // response only when it actually ran. The client sends its own 1-based
  // batch number and its cap (`{ batch, of }`) — the server has no other way
  // to see the client's loop counter, and without it a Sync that hits the cap
  // while still exhausted would never reconcile. Read defensively: an absent
  // or malformed body behaves exactly as before (gates on the budget alone).
  const body = (await c.req.json().catch(() => null)) as { batch?: unknown; of?: unknown } | null;
  const batch = typeof body?.batch === "number" ? body.batch : undefined;
  const of = typeof body?.of === "number" ? body.of : undefined;
  // `repo.failed` names each reconcile arm that threw (deployments / runs / …),
  // so a Sync that silently lost one is distinguishable from one that had
  // nothing to do.
  let repo: ReconcileResult | undefined;
  if (isFinalBackfillBatch(res, batch, of) && c.env.GITHUB_SERVICE_TOKEN && c.env.GITHUB_REPO) {
    repo = await reconcileRepo(legacyDb(c.var.ctx), { token: c.env.GITHUB_SERVICE_TOKEN, repo: c.env.GITHUB_REPO }, repoEnvironments(c.env)).catch(() => undefined);
  }
  return c.json(repo ? { ...res, repo } : res);
});

// ADMIN action (session-gated + admin-gated, NEVER an MCP tool): "Poll now" —
// refresh what the Repo dashboard shows, on demand: health pings, the three
// usage pollers, then the GitHub reconcile (`runRepoRefresh`, src/repo/cron.ts
// — the budget, 19 + 7N subrequests, is stated there). NOT the issue-derived
// sections (open issues / bugs, issues by label, the feed's issue lines): those
// read `events`, whose only non-webhook writer is Sync GitHub's runBackfill. No
// request body. 200 even when every source failed — the body says so; it
// carries outcomes and NEVER a token, a header or an account id (`github.failed`
// is reconcile's ARM NAMES). Overlapping runs are correct (every write is
// idempotent) but wasteful, so a `refresh_lock` snapshot younger than 3 minutes
// is a 409 that runs nothing; the lock is cleared in a `finally`. Never a 500.
app.post("/admin/poll", async (c) => {
  const handle = c.get("principal").handle;
  if (!isAdmin(c.env, handle)) return c.json({ error: "admin only" }, 403);
  try {
    const res = await runLockedRepoRefresh(c.env, handle, Date.now());
    return res.ok ? c.json(res.result) : c.json({ error: "a refresh is already running", since: res.since }, 409);
  } catch (e) {
    // The lock statement itself failing (D1) — runRepoRefresh is total. Only
    // the error's NAME: nothing here knows which secret a message might quote.
    console.error("poll", e instanceof Error ? e.name : "error");
    return c.json({ error: "poll failed" }, 502);
  }
});

// The NARROWER, OLDER route — the three usage pollers only. "Poll now" calls
// `/admin/poll` above; this one is kept, unchanged, so nothing that still calls
// it breaks.
// ADMIN action (session-gated + admin-gated, NEVER an MCP tool): "Poll usage
// now" — run the three hourly usage pollers on demand and SEE the outcome,
// instead of waiting up to an hour for the repo cron's minute-0 tick and reading
// a log line. The SAME function as that tick (`runUsagePolls`), so it is
// idempotent with it: the pollers key on the hour floor and every write is
// INSERT OR IGNORE. 3N subrequests for N environments (6 today). No request
// body. 200 even when every source failed — the body says so; it carries
// per-environment outcomes and NEVER a token, a header or an account id (a
// `detail` is the poller's own scrubbed log message). Never a 500.
app.post("/admin/poll-usage", async (c) => {
  if (!isAdmin(c.env, c.get("principal").handle)) return c.json({ error: "admin only" }, 403);
  try {
    return c.json(await runUsagePolls(c.env, Date.now()));
  } catch (e) {
    // Unreachable today (runUsagePolls is total) — but never swallow it silently.
    console.error("poll-usage", e instanceof Error ? e.message : String(e));
    return c.json({ error: "poll failed" }, 502);
  }
});

// ── Tickets (session-cookie only, NEVER MCP): the one queue the whole org files
// into. Every route below is a DIRECT AUTHORED WRITE in the promote class — no
// consume(), no gate, no staged state, no proposals. The requester/actor/author
// is ALWAYS the authenticated principal; a client-supplied one is ignored. ────

/** Map a TicketError onto its status (404 unknown / 409 rule / 400 payload). */
const ticketFail = (c: Context<AppEnv>, e: unknown): Response => {
  if (e instanceof TicketError) return c.json({ error: e.message }, TICKET_ERROR_STATUS[e.code]);
  throw e; // not ours — a real 500
};

/** The id path param, or null when it is not an integer. */
const ticketId = (c: Context<AppEnv>): number | null => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) ? id : null;
};

/** Every write answers with the freshly re-read detail DTO, so one round-trip repaints. */
const ticketDetailResponse = async (c: Context<AppEnv>, id: number): Promise<Response> => {
  const ticket = await get_ticket(legacyDb(c.var.ctx), id);
  if (!ticket) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true, ticket });
};

app.post("/tickets", async (c) => {
  const parsed = TicketCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    // The principal is the requester, full stop — parsed.data has no requester field.
    const id = await create_ticket(legacyDb(c.var.ctx), parsed.data, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// The queue list. seg=open|closed|all (open = submitted + in_progress),
// assignee=anyone|me|unassigned (me = the principal), category = a vocab value
// ('all'/absent = every category). Sorted updated_at DESC.
app.get("/tickets", async (c) => {
  const segRaw = c.req.query("seg");
  const asgRaw = c.req.query("assignee");
  const catRaw = c.req.query("category");

  const seg = TicketSeg.safeParse(segRaw ?? "open");
  if (!seg.success) return c.json({ error: "invalid seg", issues: seg.error.issues }, 400);
  const assignee = TicketAssigneeFilter.safeParse(asgRaw ?? "anyone");
  if (!assignee.success) return c.json({ error: "invalid assignee", issues: assignee.error.issues }, 400);
  let category: TicketCategory | undefined;
  if (catRaw !== undefined && catRaw !== "" && catRaw !== "all") {
    const parsed = TicketCategory.safeParse(catRaw);
    if (!parsed.success) return c.json({ error: "invalid category", issues: parsed.error.issues }, 400);
    category = parsed.data;
  }

  const tickets = await list_tickets(legacyDb(c.var.ctx), {
    seg: seg.data,
    assignee: assignee.data,
    category,
    me: c.get("principal").handle,
  });
  return c.json({ tickets });
});

// REGISTERED BEFORE /tickets/:id ON PURPOSE: Hono matches in registration order,
// so a later ':id' route would otherwise swallow the literal '/tickets/badge'.
app.get("/tickets/badge", async (c) => c.json({ count: await ticket_badge(legacyDb(c.var.ctx)) }));

app.get("/tickets/:id", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const ticket = await get_ticket(legacyDb(c.var.ctx), id);
  if (!ticket) return c.json({ error: "not found" }, 404);
  return c.json(ticket);
});

// Edit the title and/or body — a mirrored ticket's too (seeded from the issue at
// import, Trov's afterwards). A patch that changes neither is a 400.
app.post("/tickets/:id/edit", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketEdit.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await edit_ticket(legacyDb(c.var.ctx), id, parsed.data, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// A status move. Legality is decided by the ONE shared transition table; an
// illegal move is a 409 and writes nothing at all (not even a history row).
app.post("/tickets/:id/status", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketTransition.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await transition_ticket(legacyDb(c.var.ctx), id, parsed.data.to, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// A board drop (the queue's Board view): status and position in one write —
// `move_ticket`. Cookie-only, like every ticket route; agents move a ticket with
// the MCP `transition_ticket`, which leaves it at the top of its new column.
app.post("/tickets/:id/move", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketMove.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await move_ticket(legacyDb(c.var.ctx), id, parsed.data.to, parsed.data.after_id, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// Assignment is immediate and reversible, so it is a toggle with no confirm step.
app.post("/tickets/:id/assignees", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketAssigneeToggle.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await toggle_assignee(legacyDb(c.var.ctx), id, parsed.data.login, parsed.data.on);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

app.post("/tickets/:id/links", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketLinkAdd.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await add_ticket_link(legacyDb(c.var.ctx), id, parsed.data.raw, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// Detach one link. The link must be on :id — another ticket's link id is a 404.
// A LOCKED link (a mirrored ticket's GitHub issue, 0032) is a 403, left in place.
app.post("/tickets/:id/links/:linkId/remove", async (c) => {
  const id = ticketId(c);
  const linkId = Number(c.req.param("linkId"));
  if (id === null || !Number.isInteger(linkId)) return c.json({ error: "invalid id" }, 400);
  try {
    await remove_ticket_link(legacyDb(c.var.ctx), id, linkId);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// Delete a ticket (session-gated, any member — no adminGate). A HARD delete; a
// ticket mirrored from a GitHub issue is a 403, left in place. See delete_ticket.
app.post("/tickets/:id/delete", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  try {
    return c.json({ ok: true, ...(await delete_ticket(legacyDb(c.var.ctx), id)) });
  } catch (e) {
    return ticketFail(c, e);
  }
});

// sprint_id null = the backlog. An unknown sprint id is a 404, not a silent write.
app.post("/tickets/:id/sprint", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketSprintSet.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await set_ticket_sprint(legacyDb(c.var.ctx), id, parsed.data.sprint_id);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// Nest child_id under :id. Tickets nest ONE level — the four rejections live in
// set_ticket_parent and come back as 409s with the database untouched.
app.post("/tickets/:id/parent", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketParentSet.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await set_ticket_parent(legacyDb(c.var.ctx), id, parsed.data.child_id);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

app.post("/tickets/:id/comment", async (c) => {
  const id = ticketId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = TicketCommentAdd.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    await add_ticket_comment(legacyDb(c.var.ctx), id, parsed.data.body, c.get("principal").handle);
    return ticketDetailResponse(c, id);
  } catch (e) {
    return ticketFail(c, e);
  }
});

// ── Sprints (session-cookie only, NEVER MCP): the Roadmap's containers. Direct
// authored writes in the promote class — no consume(), no gate, no staging. A
// sprint's TICKETS are set from the Tickets UI (POST /tickets/:id/sprint); its
// own fields come from here or from the admin plan write. ─────────────────────

/** Map a SprintError onto its status (404 unknown / 409 rule / 400 payload). */
const sprintFail = (c: Context<AppEnv>, e: unknown): Response => {
  if (e instanceof SprintError) return c.json({ error: e.message }, SPRINT_ERROR_STATUS[e.code]);
  throw e; // not ours — a real 500
};

/** The id path param, or null when it is not an integer. */
const sprintId = (c: Context<AppEnv>): number | null => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) ? id : null;
};

// Created from the Roadmap's New sprint panel: always inactive ('upcoming') and,
// without a `due`, unscheduled. The creator is the authenticated principal.
// `start` / `due` must be real YYYY-MM-DD days (or blank) with start <= due — the
// ONE rule in shared/sprints-core.ts; a refusal's `error` IS that rule's message
// (the New sprint panel shows it), and nothing is written.
app.post("/sprints", async (c) => {
  const parsed = SprintCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    const custom = parsed.error.issues.find((i) => i.code === "custom")?.message;
    return c.json({ error: custom ?? "invalid payload", issues: parsed.error.issues }, 400);
  }
  try {
    const sprint = await create_sprint(legacyDb(c.var.ctx), parsed.data, c.get("principal").handle);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return sprintFail(c, e);
  }
});

// The roadmap's sprint list: each with its tickets-only progress, the separate
// cached GitHub issue counts, and members.
// Registered before /sprints/:id (Hono matches in registration order).
app.get("/sprints", async (c) => c.json({ sprints: await list_sprints(legacyDb(c.var.ctx)) }));

app.get("/sprints/:id", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const sprint = await get_sprint(legacyDb(c.var.ctx), id);
  if (!sprint) return c.json({ error: "not found" }, 404);
  return c.json(sprint);
});

// The In Progress ↔ Upcoming toggle. `active` is derived from status, so this
// writes status; clearing active on a DONE sprint is a no-op (see set_sprint_active).
app.post("/sprints/:id/active", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = SprintActiveSet.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    const sprint = await set_sprint_active(legacyDb(c.var.ctx), id, parsed.data.active);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return sprintFail(c, e);
  }
});

// A resource on the sprint itself, parsed by the SHARED link parser (`#214`
// resolves the same way it does on a ticket). Answers with the full detail so
// one round-trip repaints the Resources list.
app.post("/sprints/:id/resources", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  const parsed = SprintResourceAdd.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid payload", issues: parsed.error.issues }, 400);
  try {
    const sprint = await add_sprint_resource(legacyDb(c.var.ctx), id, parsed.data.raw);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return sprintFail(c, e);
  }
});

// Delete a sprint (session-gated, any member — no adminGate). Its tickets move
// to the backlog; see delete_sprint. Never an ingestion path.
app.post("/sprints/:id/delete", async (c) => {
  const id = sprintId(c);
  if (id === null) return c.json({ error: "invalid id" }, 400);
  try {
    return c.json({ ok: true, ...(await delete_sprint(legacyDb(c.var.ctx), id)) });
  } catch (e) {
    return sprintFail(c, e);
  }
});

// Human confirmation (session-gated): flip a live sprint to 'done'. Admin action
// in the promote class — 'done' is never inferred from issues or tickets closing.
app.post("/sprints/:id/complete", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id)) return c.json({ error: "invalid id" }, 400);
  try {
    const sprint = await complete_sprint(legacyDb(c.var.ctx), id);
    return c.json({ ok: true, sprint });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
