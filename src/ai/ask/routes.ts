// Ask Trov's routes (docs/architecture/ask.md): tenant routes under `/api/o/:slug` (`ASK_ROUTES`,
// shared/ai-ask-core.ts), COOKIE ONLY — a request carrying an Authorization header is refused (`cookieOnly`;
// CLAUDE.md invariant 8), and none of this is an MCP tool. `tenantGate` has already resolved `c.var.ctx`, the cookie
// person's live membership of that org; every thread, message, card and attachment is that person's own, so anyone
// else's is the one `not_found` — except a thread its owner SHARED (ask.md › Sharing a conversation): with the org
// (0076_ask_sharing) every member reads it; with people by name (0077_ask_people_sharing) each reads it or continues
// it. `threadFor` says what the person reaches; every turn is its ASKER's — only they edit, regenerate, save, flag or
// decide the cards of it — and the thread's settings, sharing, export and deletion stay the owner's.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../auth/principal";
import { platform, type TenantContext } from "../../data/context";
import { all, first } from "../../data/sql";
import { meterBy, unmeterBy, METRIC_AI_CHAT, METRIC_AI_TOKENS_CACHED, METRIC_AI_TOKENS_IN, METRIC_AI_TOKENS_OUT } from "../../data/meter";
import { planAndAiSettings } from "../../plans/gate";
import { PLANS, planRefusal, resolveEntitlements } from "@shared/plans";
import { nextMonthStart } from "@shared/ai-core";
import {
  ASK_ATTACH_BYTES_MAX, ASK_ATTACH_FILES_MAX, ASK_ATTACH_KINDS, ASK_DEFAULT_MODE, ASK_FLAG_REASONS, ASK_LOW_SHARE, ASK_MODES, ASK_ROUTES,
  ASK_STARTERS_FALLBACK, askMode, askModesFor, AskCancelBodySchema, AskConfirmBodySchema, AskPeekBodySchema, AskRequestSchema, AskSaveBodySchema, AskSettingsPutSchema,
  AskThreadPatchSchema, AskWrongBodySchema, askExportName, parseAskRef,
  type AskAction, type AskActionAnswer, type AskAttachment, type AskAttachmentUpload, type AskBlock, type AskCommand, type AskEventMap, type AskMessage, type AskMessagePart, type AskMode,
  type AskSaveForm, type AskSearchHit, type AskSettings, type AskSharePerson, type AskState, type AskThreadDetail, type AskThreadGroup, type AskThreadSummary,
  type PeekResult, type RefView,
} from "@shared/ai-ask";
import {
  actionInOrg, askerOf, attachActionsToMessage, bindPendingAttachments, createThread, finishAction, getAskSettings, getThread, groupActions, insertAction,
  insertMessage, linkArtifact, listActions, listMessages, listSharedThreads, listThreads, markAttachmentsSent, markUndone, memberHandles, messageInOrg, moveAction,
  patchThread, pendingAttachments, pendingHolder, putAskSettings, recordAskWrong, replaceMessagesFrom, requestStop, rewriteAction, sameHandle, searchThreads,
  setMessageContent, setThreadPeople, setThreadShared, setThreadTitle, startTurn, threadFor, threadPeople,
  type ActionWithTurn, type ChatActionRow, type ChatMessageRow, type ChatThreadRow, type ThreadFor,
} from "../../data/ask";
import { orgIdentityOf, appBase } from "../../tools/org-links";
import { buildMatch, get_ticket, get_doc, get_sprint, withImportance } from "../../tools/reads";
import { withAiMeta, type FeedDbRow } from "../../tools/feed-ai";
import { prFilesFor } from "../../repo/pr-files-store";
import { tagsOfItems } from "../../tools/tags";
import { quickSearch } from "../../tools/quick-search";
import { createPage, deletePage, getPage } from "../../tools/artifacts";
import { getHandoff } from "../../tools/handoffs";
import { artifactOrigin, artifactsForTicket } from "../../tools/artifacts-agent";
import { listAssignedTickets } from "../../tools/mywork";
import { WRITES, ChangedSince, assertMayRunNow, waitingNote } from "./actions";
import { errorBody, resultLine, runTurn, type Emit, type TurnResult } from "./turn";
import { PlanFeatureError, PlanLimitError, PLAN_LIMIT_STATUS } from "../../plans/state";
import type { AskToolCtx } from "./context";
import { assetsDocs, type DocsSource } from "./docs";
import { buildHistory, contentOf, maybeCompact, seenRefs, type StoredContent } from "./history";
import { contextBlock, fallbackTitle, fence, newNonce } from "./prompt";
import { linkAnswer, normalRef, resolveViews } from "./refs";
import { AttachError, attachmentBlocks, attachmentsOf, checkFiles, storeAttachments, type UploadFile } from "./attachments";
import { partsHtml, partsMarkdown, type SavedPart } from "./render";
import { shortDay } from "./charts";
import { deleteAskThread, deleteUnsentAttachment } from "../../deletion/ask";

/** Test seams (empty in production): the Anthropic fetch (stubbed at the Response level), the docs text, the clock. */
export const askDeps: { fetchImpl?: typeof fetch; docs?: DocsSource; now?: () => number; stopPollMs?: number } = {};

type C = Context<AppEnv>;
const nowMs = () => (askDeps.now ? askDeps.now() : Date.now());
const nowDate = () => new Date(nowMs());

export const askApp = new Hono<AppEnv>();
/** `cookieOnly` (src/orgs/routes.ts), restated here: that module reaches billing and the secrets store, and nothing
 *  under src/ai/ask/ may (test/secrets.mcp.test.ts). Same refusal, same body. */
const cookieOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "this is a signed-in person's action, never a token's" }, 403)
    : next();

askApp.use("/ask", cookieOnly);
askApp.use("/ask/*", cookieOnly);

const positiveId = (raw: string | undefined): number | null => (raw && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null);
const me = (c: C): string => c.var.ctx.userId;
const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  try { return s ? (JSON.parse(s) as T) : fallback; } catch { return fallback; }
};

// ── the org's standing: plan, switches, this month's questions ───────────────

interface Standing {
  enabled: boolean;
  chatAuto: boolean;
  plan: Awaited<ReturnType<typeof planAndAiSettings>>["plan"];
  used: number;
  modes: readonly AskMode[];
}

async function standing(ctx: TenantContext): Promise<Standing> {
  const s = await planAndAiSettings(ctx, nowDate());
  return { enabled: s.enabled, chatAuto: s.chatAuto, plan: s.plan, used: s.used.ai_chat, modes: askModesFor(s.plan.plan) };
}

/** The person's default mode: Settings › Trov's, when the plan offers it; else Smart. */
const defaultModeOf = (modes: readonly AskMode[], stored: AskMode | null): AskMode => (stored && modes.includes(stored) ? stored : ASK_DEFAULT_MODE);

function allowanceOf(st: Standing, adding = 0) {
  // The cap the gate enforces (`planRefusal`, i.e. THE cap test `capReached` — Q11 — reads the same): Pro's is per seat — × the paid seats, or × the members
  // (at least 1) with no paid-seat count (a gifted Pro); an override of `ai_chat` is the whole cap (#12 §2.1).
  const cap = resolveEntitlements(st.plan.plan, st.plan.overrides, st.plan.members).ai_chat;
  const used = st.used + adding;
  return { used, cap, resetsAt: nextMonthStart(nowDate()), low: cap !== null && cap - used < cap * ASK_LOW_SHARE };
}

/** Starters, by plain rules from the person's own work (no model): their top assigned ticket, the active sprint,
 *  what shipped. The rest from the design's four. */
async function starters(ctx: TenantContext, handle: string): Promise<string[]> {
  const out: string[] = ["What shipped this week?"];
  try {
    const mine = await listAssignedTickets(ctx, handle, { limit: 3 });
    if (mine[0]) out.push(`Summarize ticket #${mine[0].id}`);
    const sprint = await first<{ title: string }>(ctx, `SELECT title FROM sprints WHERE org_id = ? AND status = 'in_progress' ORDER BY target_date LIMIT 1`, ctx.orgId);
    if (sprint) out.push(`What's blocking the ${sprint.title} work?`);
    const waiting = await first<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM handoffs WHERE org_id = ? AND status = 'pending' AND (recipient = ? COLLATE NOCASE OR recipient = 'anyone') AND sender <> ? COLLATE NOCASE`, ctx.orgId, handle, handle);
    if ((waiting?.n ?? 0) > 0 || mine.length > 0) out.push("What's waiting on me?");
  } catch (e) {
    console.error("ask starters", e instanceof Error ? e.name : "error");
  }
  for (const s of ASK_STARTERS_FALLBACK) if (out.length < 4 && !out.includes(s)) out.push(s);
  return out.slice(0, 4);
}

askApp.get(ASK_ROUTES.state, async (c) => {
  try {
    const st = await standing(c.var.ctx);
    const s = await getAskSettings(c.var.ctx, me(c));
    const body: AskState = {
      enabled: st.enabled,
      eligibility: !c.env.ANTHROPIC_API_KEY ? "no_key" : !st.enabled ? "off" : planRefusal(st.plan, "ai_chat", st.used, 1) ? "capped" : "ok",
      plan: st.plan.plan,
      // Per mode, whether a question in it can be sent NOW (Q50): the gate weighs a question by what its mode counts as,
      // so with 1–4 left Thinking (5) cannot while Smart can. No key or the switch off: none can.
      modes: ASK_MODES.filter((m) => st.modes.includes(m.id)).map((m) => ({
        id: m.id, label: m.label, hint: m.hint, countsAs: m.countsAs,
        canSend: !!c.env.ANTHROPIC_API_KEY && st.enabled && !planRefusal(st.plan, "ai_chat", st.used, m.countsAs),
      })),
      defaultMode: defaultModeOf(st.modes, s.default_mode),
      allowance: allowanceOf(st),
      autoAllowed: st.chatAuto,
      attach: { maxFiles: ASK_ATTACH_FILES_MAX, maxBytes: ASK_ATTACH_BYTES_MAX, kinds: [...ASK_ATTACH_KINDS] },
      starters: await starters(c.var.ctx, me(c)),
      // The upsell's number: Pro's questions per seat, from the one plan table (the client keeps no copy of it).
      proPerSeat: PLANS.team.entitlements.ai_chat,
    };
    return c.json(body);
  } catch (e) {
    console.error("ask state", e instanceof Error ? e.name : "error");
    return c.json({ error: "Couldn't read Ask Trov's state" }, 503);
  }
});

// ── ref views: peek and the inspector ────────────────────────────────────────

askApp.post(ASK_ROUTES.peek, async (c) => {
  const parsed = AskPeekBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const refs = parsed.data.refs.map(normalRef);
  const views = await resolveViews(c.var.ctx, me(c), refs, nowDate());
  // An item the person can't see — or that is not there — is the same `hidden`.
  const items: PeekResult[] = refs.map((r) => views.get(r) ?? { ref: r, hidden: true });
  return c.json({ items });
});

askApp.get("/ask/item/:ref", async (c) => {
  // Hono has already decoded the path once; a client that encoded twice is decoded again. A ref that will not decode
  // (`%25` arrives as a bare `%`) is taken as it is — and, never a ref, it is the same 404 as an unknown one.
  const raw = c.req.param("ref");
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* not percent-encoded: already decoded */ }
  const ref = normalRef(decoded);
  const p = parseAskRef(ref);
  const view = p ? (await resolveViews(c.var.ctx, me(c), [ref], nowDate())).get(ref) : undefined;
  if (!p || !view) return c.json({ ref, hidden: true }, 404);
  const ctx = c.var.ctx;
  let detail: Record<string, unknown> = {};
  switch (p.type) {
    case "ticket": {
      const t = await get_ticket(ctx, Number(p.key));
      const prs = (t?.links ?? []).filter((l) => /\/pull\/\d+/.test(l.url)).map((l) => `pr:${l.url.match(/\/pull\/(\d+)/)![1]}`);
      detail = { ticket: t, artifacts: await artifactsForTicket(ctx, Number(p.key), me(c)), prs: [...(await resolveViews(ctx, me(c), prs, nowDate())).values()] };
      break;
    }
    case "pr": {
      const s = await first<{ what: string | null; why: string | null; impact: string | null }>(ctx, `SELECT what, why, impact FROM pr_summaries WHERE org_id = ? AND pr_number = ?`, ctx.orgId, Number(p.key));
      const linked = await all<{ number: number }>(ctx, `SELECT DISTINCT t.number FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id AND t.org_id = l.org_id WHERE l.org_id = ? AND l.url LIKE ?`, ctx.orgId, `%/pull/${p.key}`);
      // Changed files: what Repo setups' capture stored (`pr_files`, 0073 — paths only, read by the gate's PR-files arm),
      // a count only when that read was complete. Added / deleted LINES are stored nowhere, so they stay null (hidden):
      // a read never calls GitHub (CLAUDE.md invariant 7).
      const at = await first<{ repo: string }>(ctx, `SELECT repo FROM repo_events WHERE org_id = ? AND kind = 'pr' AND number = ? ORDER BY occurred_at DESC LIMIT 1`, ctx.orgId, Number(p.key));
      const pf = at ? (await prFilesFor(ctx, at.repo, [Number(p.key)])).get(Number(p.key)) ?? null : null;
      detail = {
        what: s?.what ?? null, why: s?.why ?? null, impact: s?.impact ?? null, linkedTo: linked.map((l) => `ticket:${l.number}`),
        files: pf && pf.complete ? pf.paths.length : null, filePaths: pf ? pf.paths.slice(0, 30) : [], filesComplete: pf ? pf.complete : null,
        additions: null, deletions: null,
      };
      break;
    }
    case "doc": {
      const d = await get_doc(ctx, p.key);
      // A doc with a change waiting in Review: its excerpt is the STAGED version's body (what the person asked about),
      // the live body beside it; `staged` is null when nothing waits.
      const live = d ? d.versions.filter((v) => v.status === "promoted").reduce((m, v) => Math.max(m, v.version), 0) : 0;
      const waiting = d ? [...d.versions].reverse().find((v) => v.status === "staged" && v.version > live) ?? null : null;
      detail = d ? {
        body: d.doc.body, staged: waiting ? { version: waiting.version, body: waiting.body, created_by: waiting.created_by, created_at: waiting.created_at } : null,
        versions: d.versions.map((v) => ({ version: v.version, status: v.status, created_by: v.created_by, created_at: v.created_at })),
      } : {};
      break;
    }
    case "sprint": detail = { sprint: await get_sprint(ctx, Number(p.key)) }; break;
    case "handoff": detail = { handoff: await getHandoff(ctx, Number(p.key)) }; break;
    case "feed": {
      // The entry as the Feed reads it (`get_feed`'s projection): who wrote it — Trov's own carries `ai` (origin,
      // model, subject, sources) — Sift's `importance` when rated, and its tags. A feed entry has no kind column: the
      // inspector shows these, never a guessed "Shipped".
      const row = await first<FeedDbRow>(ctx, `SELECT * FROM feed WHERE org_id = ? AND id = ?`, ctx.orgId, Number(p.key));
      if (row) {
        const [withAi] = await withAiMeta(ctx, [row]);
        const { origin: _o, model: _m, subject: _s, ...plain } = withImportance(withAi) as FeedDbRow;
        detail = { entry: { ...plain, tags: (await tagsOfItems(ctx, "feed", [String(row.id)])).get(String(row.id)) ?? [] } };
      } else detail = { entry: null };
      break;
    }
    case "person": {
      const logins = await all<{ github_login: string }>(ctx, `SELECT github_login FROM org_login_map WHERE org_id = ? AND person = ? COLLATE NOCASE`, ctx.orgId, p.key);
      const prs = logins.length ? await all<{ number: number }>(ctx,
        `SELECT DISTINCT number FROM repo_events WHERE org_id = ? AND kind = 'pr' AND actor_login IN (${logins.map(() => "?").join(", ")}) ORDER BY occurred_at DESC LIMIT 5`, ctx.orgId, ...logins.map((l) => l.github_login)) : [];
      detail = { recentPrs: prs.map((x) => `pr:${x.number}`) };
      break;
    }
    case "artifact": {
      const a = await getPage(ctx, p.key, null, me(c)).catch(() => null);
      detail = a ? { kind: a.kind, version: a.current_version, visibility: a.visibility, status: a.status, raw_url: `/api/o/${(await orgIdentityOf(ctx))?.slug ?? ""}${a.raw_url}` } : {};
      break;
    }
    default: detail = {};
  }
  return c.json({ view, detail });
});

// ── the stream ───────────────────────────────────────────────────────────────

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

/** What a `/command` adds in front of the person's words (the model reads it as the person's own ask). */
const COMMAND_NOTE: Record<Exclude<AskCommand, "search">, string> = {
  ticket: "The person used /ticket: draft ONE new ticket from what they wrote (call create_ticket; it becomes a card they confirm).",
  handoff: "The person used /handoff: draft a handoff for an agent session (call send_handoff; it becomes a card they confirm).",
  summarize: "The person used /summarize: summarize the item(s) they attached as context, or this thread when there are none.",
  brief: "The person used /brief: write a short status brief for the team from what Trov has — what shipped, what is in flight, what is at risk — with sources.",
};

askApp.post(ASK_ROUTES.ask, async (c) => {
  const parsed = AskRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const req = parsed.data;
  const ctx = c.var.ctx;
  const handle = me(c);

  let thread: ChatThreadRow | null = null;
  let own = true;
  if (req.threadId) {
    // The owner's thread, or one shared with the person TO CONTINUE (0077); read access is the same 404 as none.
    const reach = await threadFor(ctx, handle, req.threadId);
    if (!reach || reach.access === "read") return c.json({ error: "not_found" }, 404);
    thread = reach.thread;
    own = reach.access === "owner";
  }
  const rows = thread ? await listMessages(ctx, thread.id) : [];
  const text = req.text.trim();
  // Edit-and-resend (`replaceFrom` = the last question) or regenerate (= the last answer).
  let replace: { from: ChatMessageRow; question: ChatMessageRow; regenerate: boolean } | null = null;
  if (req.replaceFrom !== undefined) {
    const target = rows.find((r) => r.id === req.replaceFrom);
    const lastQuestion = [...rows].reverse().find((r) => r.role === "user");
    if (!thread || !target || !lastQuestion) return c.json({ error: "invalid", message: "Only the last question or answer can be replaced." }, 400);
    if (target.role === "assistant" && target.id === rows.at(-1)!.id) {
      const q = [...rows].reverse().find((r) => r.role === "user" && r.id < target.id);
      if (!q) return c.json({ error: "invalid" }, 400);
      replace = { from: target, question: q, regenerate: true };
    } else if (target.id === lastQuestion.id) {
      if (!text) return c.json({ error: "invalid", message: "Say something." }, 400);
      replace = { from: target, question: target, regenerate: false };
    } else {
      return c.json({ error: "invalid", message: "Only the last question or answer can be replaced." }, 400);
    }
    // Every turn is its asker's: nobody edits or regenerates someone else's (the owner included).
    if (!sameHandle(askerOf(replace.question, thread), handle)) {
      return c.json({ error: "forbidden", message: "Only the person who asked it can edit or regenerate it." }, 403);
    }
  } else if (!text) {
    return c.json({ error: "invalid", message: "Say something." }, 400);
  }

  let st: Standing;
  try {
    st = await standing(ctx);
  } catch (e) {
    console.error("ask standing", e instanceof Error ? e.name : "error");
    return c.json({ error: "Couldn't read Ask Trov's state" }, 503);
  }
  // Mode access follows the plan: one the plan does not offer is refused before anything runs.
  if (!st.modes.includes(req.mode)) return c.json({ error: "mode_unavailable", message: `${askMode(req.mode).label} is not on this organization's plan.`, modes: st.modes }, 403);
  const settings = await getAskSettings(ctx, handle);

  const enc = new TextEncoder();
  const gone = new AbortController();
  // The client going away (the request's own signal) stops the model stream.
  c.req.raw.signal?.addEventListener?.("abort", () => gone.abort());
  let open = true;
  // The events are QUEUED on the response's own stream, never awaited: a browser that dropped the connection may
  // leave the stream unread rather than cancelled, and an awaited write then never settles — the runtime cancelled
  // the request as hung and the answer was never stored (seen under wrangler dev after Stop). Queued, the turn always
  // reaches its end and stores what it has; the client CANCELLING the stream ends the turn as stopped.
  let out: ReadableStreamDefaultController<Uint8Array> | null = null;
  const readable = new ReadableStream<Uint8Array>({
    start(ctl) { out = ctl; },
    cancel() { open = false; gone.abort(); },
  });
  const emit: Emit = async (event, data) => {
    if (!open) return;
    try { out!.enqueue(enc.encode(sse(event, data))); } catch { open = false; gone.abort(); }
  };
  const work = (async () => {
    try {
      await converse(c, { req, thread, own, rows, text, replace, st, settings, emit, signal: gone.signal });
    } catch (e) {
      console.error("ask turn", e instanceof Error ? e.name : "error");
      await emit("error", { code: "failed", message: "Something went wrong. Nothing was changed. Try again." });
    } finally {
      open = false;
      try { out!.close(); } catch { /* cancelled already */ }
    }
  })();
  try { c.executionCtx.waitUntil(work); } catch { /* no ExecutionContext (a test): the work runs on its own */ }
  return new Response(readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
});

interface Conversation {
  req: ReturnType<typeof AskRequestSchema.parse>;
  thread: ChatThreadRow | null;
  /** The person asking is the thread's owner (or it is new); false = a thread shared with them to continue. */
  own: boolean;
  rows: ChatMessageRow[];
  text: string;
  replace: { from: ChatMessageRow; question: ChatMessageRow; regenerate: boolean } | null;
  st: Standing;
  settings: Awaited<ReturnType<typeof getAskSettings>>;
  emit: Emit;
  signal: AbortSignal;
}

/** What the answer SHOWED, in the order it streamed — text runs (merged deltas), blocks (their index among the
 *  answer's blocks), write cards (by id, once) — stored with the answer so a reload draws the live order. */
function recordParts(emit: Emit): { emit: Emit; parts: AskMessagePart[] } {
  const parts: AskMessagePart[] = [];
  let blocks = 0;
  const cards = new Set<number>();
  const rec: Emit = async (event, data) => {
    if (event === "text") {
      const delta = (data as AskEventMap["text"]).delta;
      const last = parts[parts.length - 1];
      if (last?.kind === "text") last.md += delta; else parts.push({ kind: "text", md: delta });
    } else if (event === "block") parts.push({ kind: "block", index: blocks++ });
    else if (event === "action" || event === "action_result") {
      const id = (data as AskEventMap["action"]).id;
      if (!cards.has(id)) { cards.add(id); parts.push({ kind: "action", id }); }
    }
    return emit(event, data);
  };
  return { emit: rec, parts };
}

async function converse(c: C, outer: Conversation): Promise<void> {
  const rec = recordParts(outer.emit);
  const v: Conversation = { ...outer, emit: rec.emit };
  const { ctx } = c.var;
  const handle = me(c);
  const env = c.env;
  const mode = v.req.mode;
  const def = askMode(mode);
  const search = v.req.command === "search" && !v.replace?.regenerate;

  // The gate, in order: the platform key, the org's switch, the month's questions (by what the mode counts as).
  // `/search` calls no model and counts nothing, so only the switch gates it.
  if (!search && !env.ANTHROPIC_API_KEY) return v.emit("error", { code: "no_key", message: "Ask Trov is not set up on this deployment." });
  if (!v.st.enabled) return v.emit("error", { code: "off", message: "Ask Trov is off for this org. An admin can turn it on in Org settings › AI." });
  if (!search && planRefusal(v.st.plan, "ai_chat", v.st.used, def.countsAs)) {
    return v.emit("error", { code: "capped", message: `You've used this month's questions. Resets ${shortDay(nextMonthStart(nowDate()))}.` });
  }

  // Auto asked for while the org has it off: the answer runs as not-auto (the safe direction), and the `thread` event
  // says so (`autoOff`), so the composer shows "Asks first" (the owner, Q52).
  const auto = v.req.auto && v.st.chatAuto;
  const autoOff = v.req.auto && !v.st.chatAuto ? { autoOff: true as const } : {};
  const org = await orgIdentityOf(ctx);
  const orgSlug = org?.slug ?? "";
  // Context chips: kept only when they name something the person can see. A hidden item never enters a thread — not
  // its question, not a panel thread's `context_ref` (the owner, Q53).
  const askedContext = v.req.context.map(normalRef);
  const ctxSeen = askedContext.length ? await resolveViews(ctx, handle, askedContext, nowDate()) : new Map<string, RefView>();
  const visibleContext = askedContext.filter((r) => ctxSeen.has(r));
  const thread = v.thread ?? (await getThread(ctx, handle, await createThread(ctx, handle, {
    mode, auto, origin: v.req.origin ?? "page", contextRef: v.req.origin === "panel" ? visibleContext[0] ?? null : null,
  })))!;
  // A shared thread's turn leaves its mode and Auto as the owner set them (0077).
  const turn = await startTurn(ctx, thread.id, mode, auto, undefined, v.own);
  await v.emit("thread", { id: thread.id, title: thread.title, mode, auto, origin: thread.origin, contextRef: thread.context_ref, ...autoOff });

  // The question: kept (regenerate), replaced (edit — its attachments carried over), or new.
  let question: ChatMessageRow;
  let earlier = v.rows;
  let attachments: AskAttachment[] = [];
  if (v.replace) {
    await replaceMessagesFrom(ctx, thread.id, v.replace.from.id);
    earlier = v.rows.filter((r) => r.id < v.replace!.question.id);
    attachments = parseJson<AskAttachment[]>(v.replace.question.attachments_json, []);
  }
  if (v.replace?.regenerate) {
    question = v.replace.question;
  } else {
    // New attachments: this thread's, uploaded and not sent yet — each ALREADY an artifact. Files uploaded before the
    // thread existed are pending on the person's holder: the ones this question names move onto it first (Q60).
    await bindPendingAttachments(ctx, handle, thread.id, v.req.attachments);
    // Only files the person uploaded: in a shared thread, someone else's unsent upload is never theirs to send.
    const pending = await pendingAttachments(ctx, thread.id, handle, v.req.attachments);
    attachments = [...attachments, ...(await attachmentsOf(ctx, pending, orgSlug))];
    const context = visibleContext;
    const content: StoredContent = { text: v.text, command: v.req.command ?? null, context, refs: context, attached: attachments.map((a) => ({ id: a.id, title: a.title })) };
    const id = await insertMessage(ctx, thread.id, { role: "user", mode, content, attachments, askedBy: handle });
    await markAttachmentsSent(ctx, pending.map((p) => p.id), id);
    // The words were sent: the thread keeps no draft of them (a reload or another device opens an empty box). The
    // draft is the owner's: someone continuing a shared thread never had one there.
    if (v.own && thread.draft) await patchThread(ctx, handle, thread.id, { draft: "" });
    question = (await messageInOrg(ctx, id))!;
  }
  const qc = contentOf(question);
  const seen = seenRefs([...earlier, question]);

  if (search) return answerSearch(c, v, thread, turn, question, qc.text ?? "", seen, rec.parts);

  // The question counts BEFORE the model is called (an attempt, like every AI allowance) — and still counts if stopped.
  const p = platform(env, handle);
  const meteredAt = nowDate().toISOString();
  await meterBy(p, ctx.orgId, handle, [[METRIC_AI_CHAT, def.countsAs]], meteredAt);

  const nonce = newNonce();
  const compacted = await maybeCompact(env, ctx, thread, earlier, askDeps.fetchImpl);
  const { messages: history, actionsNote } = await buildHistory(ctx, compacted, earlier, nonce, handle);
  const ctxViews = (qc.context ?? []).length ? await resolveViews(ctx, handle, qc.context ?? [], nowDate()) : new Map();
  // An attachment the model can't take (too large, or no room left in this request) is stored but not read: the
  // model is told, and the person sees a notice (the turn's first activity lines).
  const files = await attachmentBlocks(ctx, env.ARTIFACTS_BUCKET, handle, attachments, nonce);
  const user = [
    ...(actionsNote ? [{ type: "text" as const, text: actionsNote }] : []),
    ...files.blocks,
    ...(ctxViews.size ? [{ type: "text" as const, text: fence(nonce, "Items the person attached as context", JSON.stringify([...ctxViews.values()])) }] : []),
    ...(qc.command && qc.command !== "search" ? [{ type: "text" as const, text: COMMAND_NOTE[qc.command as Exclude<AskCommand, "search">] }] : []),
    { type: "text" as const, text: qc.text || "(no text)" },
  ];

  const tool: AskToolCtx = {
    env, ctx, handle, orgSlug, origin: new URL(c.req.url).origin, threadId: thread.id,
    docs: askDeps.docs ?? assetsDocs(env), now: nowDate, searched: new Map(),
  };
  const out = await runTurn({
    env, ctx, tool, mode, turn,
    system: contextBlock({
      orgName: org?.name ?? "this organization", orgSlug, handle, role: ctx.role, mode,
      today: nowDate().toISOString().slice(0, 10), instructions: v.settings.instructions, autoMode: auto,
    }),
    history, user, seen, autoMode: auto, autoAllowed: v.st.chatAuto, nonce, emit: v.emit, signal: v.signal, notices: files.notices,
    fetchImpl: askDeps.fetchImpl, now: nowMs, stopPollMs: askDeps.stopPollMs,
  });
  await meterBy(p, ctx.orgId, handle, [[METRIC_AI_TOKENS_IN, out.tokens.in], [METRIC_AI_TOKENS_OUT, out.tokens.out], [METRIC_AI_TOKENS_CACHED, out.tokens.cached]]);

  const failed = out.ended === "failed" || out.ended === "refused";
  const cites = failed ? [] : await linkAnswer(ctx, handle, out.text, seen, nowDate());
  const stopped = out.ended === "stopped" || out.ended === "timeout";
  // An answer that finished with nothing in it — no words, no block, no card (the model spent its calls on lookups) —
  // is not a question answered: it is taken back off the allowance and stored with 0 units (the owner, Q-F2). A
  // stopped one still counts, as before.
  const empty = out.ended === "done" && isEmptyAnswer(out, rec.parts);
  if (empty) await unmeterBy(p, ctx.orgId, handle, [[METRIC_AI_CHAT, def.countsAs]], meteredAt);
  const messageId = await storeAnswer(ctx, thread.id, turn, mode, out, seen, cites, stopped || failed, empty ? 0 : def.countsAs, handle, rec.parts, lastAnswerWithContent(earlier));
  if (failed) return v.emit("error", { code: "failed", message: out.ended === "refused" ? "Trov can't answer that." : "Something went wrong. Nothing was changed. Try again." });

  const title = thread.title || out.title || fallbackTitle(qc.text ?? "");
  if (!thread.title) {
    await setThreadTitle(ctx, thread.id, title);
    // The thread is named from its first exchange.
    await v.emit("thread", { id: thread.id, title, mode, auto, origin: thread.origin, contextRef: thread.context_ref });
  }
  if (out.autosave && !stopped) {
    await autoSave(c, thread, turn, messageId, saveTarget(out, messageId, lastAnswerWithContent(earlier)), out.autosave, title, v.emit);
  }
  if (out.ended === "timeout") return v.emit("error", { code: "timeout", message: "Ask Trov ran out of time for this answer. What it said so far is kept." });
  if (out.followups.length && !stopped) await v.emit("followups", { items: out.followups });
  await v.emit("done", { messageId, questionId: question.id, cites, tokens: out.tokens, ...(stopped ? { stopped: true } : {}) });
}

/** No words, no block, no card: what Trov wrote is nothing (Q-F2). */
export function isEmptyAnswer(out: Pick<TurnResult, "text" | "blocks">, parts: readonly AskMessagePart[]): boolean {
  return !out.text.trim() && !out.blocks.length && !parts.some((x) => x.kind === "action");
}

/** The most recent earlier answer that has content (text or a block other than a save form), or null. */
function lastAnswerWithContent(rows: readonly ChatMessageRow[]): number | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r.role !== "assistant") continue;
    const c = contentOf(r);
    if ((c.text ?? "").trim() || ((c.blocks ?? []) as AskBlock[]).some((b) => b.kind !== "save_form")) return r.id;
  }
  return null;
}
/** Answers shorter than this, with no block of their own, are a reply to "save that", not content to save. */
const SAVE_CONTENT_CHARS = 280;
/** The answer `save_artifact` saves: the one the model named (`which`), else THIS answer when it has content of its
 *  own (a block, or more than a line or two), else the most recent earlier answer that has — "save this as a doc"
 *  asked after an answer saves THAT answer, not the one-line reply. */
function saveTarget(out: Pick<TurnResult, "text" | "blocks" | "saveWhich">, current: number, previous: number | null): number {
  if (out.saveWhich === "this") return current;
  if (out.saveWhich === "previous") return previous ?? current;
  const own = out.blocks.some((b) => b.kind !== "save_form") || out.text.trim().length >= SAVE_CONTENT_CHARS;
  return own || previous === null ? current : previous;
}

async function storeAnswer(ctx: TenantContext, threadId: number, turn: number, mode: AskMode, out: TurnResult, seen: Set<string>, cites: RefView[], stopped: boolean, countsAs: number, askedBy: string, parts?: AskMessagePart[], previous: number | null = null): Promise<number> {
  const content: StoredContent = {
    text: out.text, refs: [...seen], blocks: out.blocks, activity: out.activity, followups: stopped ? [] : out.followups, thinking: out.thinking,
    ...(parts ? { parts } : {}),
  };
  const id = await insertMessage(ctx, threadId, {
    role: "assistant", mode, content, cites, model: out.model, tokensIn: out.tokens.in, tokensOut: out.tokens.out, tokensCached: out.tokens.cached,
    units: out.called ? countsAs : 0, stopped, askedBy,
  });
  // A save form names the answer it saves.
  if (out.blocks.some((b) => b.kind === "save_form")) {
    const target = saveTarget(out, id, previous);
    content.blocks = out.blocks.map((b) => (b.kind === "save_form" ? { ...b, form: { ...b.form, messageId: target } } : b));
    await setMessageContent(ctx, id, content);
  }
  await attachActionsToMessage(ctx, threadId, turn, id);
  return id;
}

/** `/search <q>`: item cards from Trov's own search — no model call, nothing counted. */
async function answerSearch(c: C, v: Conversation, thread: ChatThreadRow, turn: number, question: ChatMessageRow, q: string, seen: Set<string>, parts: AskMessagePart[]): Promise<void> {
  const ctx = c.var.ctx;
  await v.emit("activity", { step: 1, tool: "search", icon: "search", label: `Searched Trov for '${q}'`, state: "run" });
  const res = await quickSearch(ctx, q, me(c), { limit: 4 });
  const refs = res.groups.flatMap((g) => g.hits.flatMap((h) => {
    if (g.type === "sprint") return /^sprint:\d+$/.test(h.id) ? [h.id] : [];
    if (g.type === "person") return [`person:${h.id.toLowerCase()}`];
    return [`${g.type}:${h.id}`];
  })).filter((r) => parseAskRef(r) !== null).slice(0, 9);
  const views = await resolveViews(ctx, me(c), refs, nowDate());
  const items = refs.flatMap((r) => (views.has(r) ? [views.get(r)!] : []));
  await v.emit("activity", { step: 1, state: "done", results: items.map((i) => i.ref), resultLine: resultLine(items.length) });
  const text = items.length ? (items.length === 1 ? "One item matches:" : `${items.length === 3 ? "Three" : items.length} items match best:`) : `Nothing in Trov matches “${q}”.`;
  await v.emit("text", { delta: text });
  const block: AskBlock = { kind: "items", items };
  if (items.length) await v.emit("block", block);
  for (const i of items) seen.add(i.ref);
  const out: TurnResult = {
    text, title: null, followups: [], blocks: items.length ? [block] : [], activity: [{ step: 1, tool: "search", icon: "search", label: `Searched Trov for '${q}'`, results: items.map((i) => i.ref), resultLine: resultLine(items.length) }],
    thinking: null, model: "", tokens: { in: 0, out: 0, cached: 0 }, ended: "done", called: false, autosave: null, saveWhich: null,
  };
  const messageId = await storeAnswer(ctx, thread.id, turn, v.req.mode, out, seen, items, false, 0, me(c), parts);
  if (!thread.title) {
    const title = fallbackTitle(`Search: ${q}`);
    await setThreadTitle(ctx, thread.id, title);
    await v.emit("thread", { id: thread.id, title, mode: v.req.mode, auto: thread.auto_mode === 1, origin: thread.origin, contextRef: thread.context_ref });
  }
  await v.emit("done", { messageId, questionId: question.id, cites: items, tokens: out.tokens });
}

// ── saving answers as artifacts ──────────────────────────────────────────────

interface SaveAsk { messageId: number | null; block: number | null; title: string; kind: "markdown" | "html"; visibility: "private" | "org" }

/** Write the artifact from the STORED answer (or thread): Markdown with refs as links, or an HTML page rendered
 *  here. Linked to the thread, and to the tickets and sprints the saved part cites. */
async function saveFromThread(c: C, thread: ChatThreadRow, s: SaveAsk): Promise<AskEventMap["artifact_saved"]> {
  const ctx = c.var.ctx;
  const rows = await listMessages(ctx, thread.id);
  const pick = s.messageId === null ? rows : rows.filter((m) => m.id === s.messageId);
  const org = await orgIdentityOf(ctx);
  const base = `${artifactOrigin(c.env.PUBLIC_ORIGIN, new URL(c.req.url).origin)}${org?.slug ? `/${org.slug}` : ""}`;
  const parts: SavedPart[] = pick.map((m) => {
    const content = contentOf(m);
    const blocks = ((content.blocks ?? []) as AskBlock[]).filter((b) => b.kind !== "save_form");
    return {
      who: m.role === "user" ? "person" : "trov", mode: m.mode, at: m.created_at,
      text: s.block !== null ? "" : content.text ?? "", blocks: s.block !== null ? (blocks[s.block] ? [blocks[s.block]] : []) : blocks,
      cites: parseJson<RefView[]>(m.cites_json, []),
    };
  });
  const cites = parts.flatMap((p) => p.cites);
  const links = [...new Map(cites.filter((x) => x.type === "ticket" || x.type === "sprint")
    .map((x) => [x.ref, { target_type: x.type as "ticket" | "sprint", target_ref: x.ref.split(":")[1] }])).values()].slice(0, 20);
  const content = s.kind === "html"
    ? partsHtml(s.title, parts, base, `${org?.name ?? "Trov"} · ${shortDay(nowDate().toISOString().slice(0, 10))}`)
    : partsMarkdown(s.title, parts, base);
  const page = await createPage(ctx, { title: s.title, kind: s.kind, area: "data", repo: "", visibility: s.visibility, content, summary: "Saved from Ask Trov", links }, me(c));
  await linkArtifact(ctx, thread.id, page.id, "saved", s.messageId);
  return { slug: page.slug, title: page.title, visibility: s.visibility, url: `#artifacts/${page.slug}` };
}

/** `save_artifact` in Auto: saved as private at once, as a card with Undo (state `auto`). */
async function autoSave(c: C, thread: ChatThreadRow, turn: number, messageId: number, target: number, a: NonNullable<TurnResult["autosave"]>, threadTitle: string, emit: Emit): Promise<void> {
  const ctx = c.var.ctx;
  const title = a.title ?? `${threadTitle}, ${shortDay(nowDate().toISOString().slice(0, 10))}`;
  const preview = { title: `Save "${title}" as an artifact`, lines: [{ label: "Visibility", value: "Private" }], item: null };
  const id = await insertAction(ctx, { threadId: thread.id, turn, tool: "save_artifact", kind: "other", groupId: a.groupId, toolUseId: "", args: a, preview, state: "running", askedBy: me(c) });
  try {
    const saved = await saveFromThread(c, thread, { messageId: a.scope === "thread" ? null : target, block: null, title, kind: a.kind, visibility: "private" });
    await finishAction(ctx, id, "auto", saved, { slug: saved.slug });
    await attachActionsToMessage(ctx, thread.id, turn, messageId);
    await emit("action_result", { id, groupId: a.groupId, tool: "save_artifact", kind: "other", preview, state: "auto", result: saved, ref: `artifact:${saved.slug}`, undo: true, at: nowDate().toISOString() });
    await emit("artifact_saved", saved);
  } catch (e) {
    const body = errorBody(e);
    await finishAction(ctx, id, "failed", body, null);
    await emit("action_result", { id, groupId: a.groupId, tool: "save_artifact", kind: "other", preview, state: "failed", result: body, ref: null, undo: false, at: nowDate().toISOString() });
  }
}

// ── threads ──────────────────────────────────────────────────────────────────

/** Pinned, Today, This week, Earlier (#12 §2.15) — by the thread's last exchange, in UTC. */
export function threadGroup(t: Pick<ChatThreadRow, "pinned" | "updated_at">, now: Date): AskThreadGroup {
  if (t.pinned === 1) return "pinned";
  const day = now.toISOString().slice(0, 10);
  if (t.updated_at.slice(0, 10) === day) return "today";
  return now.getTime() - new Date(t.updated_at).getTime() < 7 * 86_400_000 ? "week" : "earlier";
}

/** The owner's own thread; `people` = who it is shared with by name (0077), when anyone. */
const summaryOf = (t: ChatThreadRow, people?: AskSharePerson[]): AskThreadSummary => ({
  id: t.id, title: t.title, pinned: t.pinned === 1, mode: t.mode, auto: t.auto_mode === 1, origin: t.origin, contextRef: t.context_ref,
  hasDraft: t.draft.trim().length > 0, group: threadGroup(t, nowDate()), createdAt: t.created_at, updatedAt: t.updated_at,
  shared: t.shared_at !== null, ...(people?.length ? { people } : {}),
});

/** Someone else's thread as a person it is shared with reads it: none of the owner's own settings — no draft, no
 *  pin, no Auto, nor who else it is shared with — but whose it is, what the person may do, and how it reached them. */
const viewerSummaryOf = (r: ThreadFor): AskThreadSummary => ({
  ...summaryOf(r.thread), pinned: false, auto: false, hasDraft: false, group: threadGroup({ pinned: 0, updated_at: r.thread.updated_at }, nowDate()),
  owner: r.thread.handle, viewer: true, access: r.access === "continue" ? "continue" : "read", direct: r.direct,
});

/** The owner's threads with who each is shared with by name. */
async function ownSummaries(ctx: TenantContext, threads: readonly ChatThreadRow[]): Promise<AskThreadSummary[]> {
  const people = await threadPeople(ctx, threads.map((t) => t.id));
  return threads.map((t) => summaryOf(t, people.get(t.id)));
}

/** FTS5's snippet with its marker characters → the text and the match's offsets. */
export function snippetOffsets(raw: string | null): AskSearchHit["snippet"] {
  if (raw === null) return null;
  let text = "";
  const matches: [number, number][] = [];
  let open = -1;
  for (const ch of raw) {
    if (ch === "\u0002") open = text.length;
    else if (ch === "\u0003") { if (open >= 0) matches.push([open, text.length]); open = -1; }
    else text += ch;
  }
  return { text, matches };
}

/** Other people's threads shared with the person — by name ("Shared with you", `direct`) or with the org
 *  ("Organization"); their own shared ones are in their own list. */
askApp.get(ASK_ROUTES.shared, async (c) => {
  try {
    return c.json({ threads: (await listSharedThreads(c.var.ctx, me(c))).map(viewerSummaryOf) });
  } catch (e) {
    console.error("ask shared", e instanceof Error ? e.name : "error");
    return c.json({ error: "Couldn't read the shared threads" }, 503);
  }
});

askApp.get(ASK_ROUTES.threads, async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (!q) return c.json({ threads: await ownSummaries(c.var.ctx, await listThreads(c.var.ctx, me(c))) });
  const found = await searchThreads(c.var.ctx, me(c), q, buildMatch(q));
  const own = await ownSummaries(c.var.ctx, found.map((f) => f.thread));
  const hits: AskSearchHit[] = found.map((f, i) => ({ thread: own[i], snippet: snippetOffsets(f.snippet), matchCount: f.matchCount }));
  return c.json({ hits });
});

/** The item a decided write touched — what `WRITES[tool].run` returned as `ref` when it ran (the action_result and
 *  the confirm answer carry it), rebuilt for the thread read from the stored args and result, since no column keeps
 *  it. Without it a reloaded done line lost its number and its link. Unknown → null, never a guess. */
export function refOfAction(tool: string, state: string, args: unknown, result: unknown): string | null {
  if (state !== "confirmed" && state !== "auto" && state !== "undone") return null;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
  const txt = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const ref = (type: string, key: string | number | null): string | null => (key === null ? null : `${type}:${key}`);
  switch (tool) {
    case "create_ticket": return ref("ticket", num(r.id));
    case "edit_ticket": case "transition_ticket": case "add_ticket_comment": case "add_ticket_link": case "set_ticket_sprint":
    case "set_ticket_parent": case "assign_ticket": return ref("ticket", num(a.id) ?? num(r.id));
    case "append_feed": return r.outcome === "written" ? ref("feed", num(r.id)) : null;
    case "propose_doc_update": case "publish_doc": return ref("doc", txt(a.slug) ?? txt(r.slug));
    case "artifact_update": case "save_artifact": return ref("artifact", txt(r.slug) ?? txt(a.slug));
    case "create_sprint": return ref("sprint", num(r.id));
    case "set_sprint_active": case "complete_sprint": case "add_sprint_resource": return ref("sprint", num(a.id) ?? num(r.id));
    case "send_handoff": case "claim_handoff": return ref("handoff", num(r.id) ?? num(a.id));
    case "expire_handoff": return ref("handoff", num(a.id) ?? num(r.id));
    case "save_prompt": return ref("prompt", txt(r.slug));
    default: return null;
  }
}

const actionOf = (a: ChatActionRow): AskAction => {
  const result = parseJson<unknown>(a.result_json, null);
  return {
    id: a.id, groupId: a.group_id, tool: a.tool, kind: a.kind as AskAction["kind"], state: a.state as AskAction["state"],
    preview: parseJson(a.preview_json, { title: a.tool, lines: [], item: null }),
    ...cardFieldsOf(a), note: waitingNote(a.tool, a.state), result,
    ref: refOfAction(a.tool, a.state, parseJson<unknown>(a.args_json, {}), result),
    undo: a.undo_json !== null && (a.state === "confirmed" || a.state === "auto"),
    createdAt: a.created_at, decidedAt: a.decided_at,
  };
};
function cardFieldsOf(a: ChatActionRow): { fields: Record<string, unknown>; editable: string[] } {
  const spec = WRITES[a.tool];
  const args = parseJson<unknown>(a.args_json, {});
  return { fields: spec?.fields ? spec.fields(args) : {}, editable: a.state === "proposed" || a.state === "waiting" ? [...(spec?.editable ?? [])] : [] };
}

function messageOf(m: ChatMessageRow, actions: ChatActionRow[], thread: Pick<ChatThreadRow, "handle">): AskMessage {
  const content = contentOf(m);
  return {
    askedBy: askerOf(m, thread),
    id: m.id, role: m.role, mode: m.mode, text: content.text ?? "", command: (content.command ?? null) as AskCommand | null, context: content.context ?? [],
    blocks: (content.blocks ?? []) as AskBlock[], activity: (content.activity ?? []) as AskMessage["activity"], followups: content.followups ?? [],
    thinking: content.thinking ?? null, cites: parseJson<RefView[]>(m.cites_json, []), attachments: parseJson<AskAttachment[]>(m.attachments_json, []),
    actions: actions.filter((a) => a.message_id === m.id).map(actionOf), ...(content.parts ? { parts: content.parts } : {}), stopped: m.stopped === 1, model: m.model, units: m.units, createdAt: m.created_at,
  };
}

async function threadOr404(c: C): Promise<ChatThreadRow | Response> {
  const id = positiveId(c.req.param("id"));
  const t = id === null ? null : await getThread(c.var.ctx, me(c), id);
  return t ?? c.json({ error: "not_found" }, 404);
}

askApp.get("/ask/threads/:id", async (c) => {
  const id = positiveId(c.req.param("id"));
  // The person's own thread, or one shared with them (by name or with the org); anything else — private, another
  // org's, unknown, a removed member's — is the same 404 (its existence never shows).
  const reach = id === null ? null : await threadFor(c.var.ctx, me(c), id);
  if (!reach) return c.json({ error: "not_found" }, 404);
  const t = reach.thread;
  const [rows, actions] = await Promise.all([listMessages(c.var.ctx, t.id), listActions(c.var.ctx, t.id)]);
  // Every turn someone ELSE asked reads as theirs — for the owner too, once a thread is shared to continue.
  const messages = await asViewer(c.var.ctx, me(c), rows.map((m) => messageOf(m, actions, t)));
  const body: AskThreadDetail = reach.access === "owner"
    ? { thread: { ...summaryOf(t, (await threadPeople(c.var.ctx, [t.id])).get(t.id)), draft: t.draft }, messages }
    : { thread: { ...viewerSummaryOf(reach), draft: "" }, messages };
  return c.json(body);
});

/**
 * The turns of a thread that someone OTHER than `viewer` asked, as the viewer reads them (ask.md › Sharing a
 * conversation): a shared thread's reader reads the owner's turns this way, and since 0077 the owner reads the turns
 * of someone they shared it with to continue the same way. What was asked and what Trov wrote are shared as written;
 * what the stored answer resolved FOR ITS ASKER is resolved again for the viewer, so an item only the asker can see
 * (their private artifact) never shows its title, status or link:
 *  - every ref those turns name (sources, item cards, diagram nodes, context chips, steps' results, cards' items and
 *    done lines, a saved page) is re-read as the viewer in one batch, and what they can't see is dropped (a diagram
 *    node keeps its label and loses its link);
 *  - attachments are the asker's PRIVATE artifacts: the viewer gets each file's name, kind and size, never its slug,
 *    hash or preview; opening one is the private artifact's own rule (its author only), so it stays closed;
 *  - a card is never editable or undoable (only its asker decides it).
 * The viewer's own turns are returned untouched.
 */
async function asViewer(ctx: TenantContext, viewer: string, list: AskMessage[]): Promise<AskMessage[]> {
  const foreign = (m: AskMessage): boolean => !!m.askedBy && !sameHandle(m.askedBy, viewer);
  const messages = list.filter(foreign);
  if (!messages.length) return list;
  const refs = new Set<string>();
  for (const m of messages) {
    m.cites.forEach((x) => refs.add(x.ref));
    m.context.forEach((r) => refs.add(r));
    m.activity.forEach((st) => st.results.forEach((r) => refs.add(r)));
    for (const b of m.blocks) {
      if (b.kind === "items") b.items.forEach((x) => refs.add(x.ref));
      else if (b.kind === "diagram") b.diagram.nodes.forEach((n) => { if (n.ref) refs.add(n.ref); });
      else if (b.kind === "save_form" && b.form.saved) refs.add(`artifact:${b.form.saved.slug}`);
    }
    for (const a of m.actions) { if (a.ref) refs.add(a.ref); if (a.preview.item) refs.add(a.preview.item.ref); }
  }
  const named = [...refs].map(normalRef).filter((r) => parseAskRef(r) !== null);
  const seen = named.length ? await resolveViews(ctx, viewer, named, nowDate()) : new Map<string, RefView>();
  const view = (ref: string): RefView | null => seen.get(normalRef(ref)) ?? null;
  const sees = (ref: string): boolean => seen.has(normalRef(ref));
  const visible = (xs: readonly RefView[]): RefView[] => xs.flatMap((x) => { const now = view(x.ref); return now ? [now] : []; });
  const block = (b: AskBlock): AskBlock => {
    if (b.kind === "items") return { ...b, items: visible(b.items) };
    if (b.kind === "diagram") {
      return { ...b, diagram: { ...b.diagram, nodes: b.diagram.nodes.map((n) => (n.ref && sees(n.ref) ? { ...n, view: view(n.ref) } : { ...n, ref: null, view: null })) } };
    }
    if (b.kind === "save_form") return { ...b, form: { ...b.form, saved: b.form.saved && sees(`artifact:${b.form.saved.slug}`) ? b.form.saved : null } };
    return b;
  };
  return list.map((m) => (!foreign(m) ? m : {
    ...m,
    cites: visible(m.cites),
    context: m.context.filter(sees),
    activity: m.activity.map((st) => ({ ...st, results: st.results.filter(sees) })),
    blocks: m.blocks.map(block),
    attachments: m.attachments.map((f) => ({ id: f.id, slug: "", title: f.title, kind: f.kind, contentType: f.contentType, size: f.size, sha256: "" })),
    actions: m.actions.map((a) => {
      const hidden = a.ref !== null && !sees(a.ref);
      return {
        ...a, editable: [], undo: false,
        ref: hidden ? null : a.ref,
        preview: { ...a.preview, item: a.preview.item ? view(a.preview.item.ref) : null },
        // A saved answer the reader can't see: not its title or address either.
        result: hidden && a.tool === "save_artifact" ? null : a.result,
      };
    }),
  }));
}

askApp.patch("/ask/threads/:id", async (c) => {
  const t = await threadOr404(c);
  if (t instanceof Response) return t;
  const parsed = AskThreadPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const st = await standing(c.var.ctx);
  if (parsed.data.auto === true && !st.chatAuto) return c.json({ error: "auto_off", message: "An admin turned off Auto for this org. Trov asks before every change." }, 409);
  if (parsed.data.mode && !st.modes.includes(parsed.data.mode)) return c.json({ error: "mode_unavailable" }, 403);
  const { shared, people, ...rest } = parsed.data;
  // Who it is shared with by name (0077): members of this org, never the owner, each once — checked before anything
  // is written, so a refused list changes nothing.
  let named: AskSharePerson[] | null = null;
  if (people !== undefined) {
    named = await sharePeople(c.var.ctx, me(c), people);
    if (!named) return c.json({ error: "invalid", message: "Share only with members of this organization, other than you, each once." }, 400);
  }
  await patchThread(c.var.ctx, me(c), t.id, rest);
  // Share with the org / stop sharing (0076_ask_sharing), and the people by name (0077): the owner's own thread only
  // — `threadOr404` answered 404 to anyone else, a person it is shared with included.
  if (shared !== undefined) await setThreadShared(c.var.ctx, me(c), t.id, shared);
  if (named) await setThreadPeople(c.var.ctx, me(c), t.id, named);
  return c.json({ thread: (await ownSummaries(c.var.ctx, [(await getThread(c.var.ctx, me(c), t.id))!]))[0] });
});

/** A share list as stored: each handle a member of this org (in its stored spelling), not the owner, none twice.
 *  Null when any is not. */
async function sharePeople(ctx: TenantContext, owner: string, people: readonly AskSharePerson[]): Promise<AskSharePerson[] | null> {
  const keys = people.map((x) => x.handle.toLowerCase());
  if (new Set(keys).size !== keys.length || keys.includes(owner.toLowerCase())) return null;
  const members = new Map((await memberHandles(ctx, people.map((x) => x.handle))).map((h) => [h.toLowerCase(), h]));
  const out = people.map((x) => ({ handle: members.get(x.handle.toLowerCase()) ?? "", access: x.access }));
  return out.every((x) => x.handle) ? out : null;
}

/** The thread if the person may CONTINUE it — its owner, or shared with them to continue (0077) — else the 404. */
async function continuableOr404(c: C, rawId: string | undefined): Promise<ThreadFor | Response> {
  const id = positiveId(rawId);
  const reach = id === null ? null : await threadFor(c.var.ctx, me(c), id);
  return reach && reach.access !== "read" ? reach : c.json({ error: "not_found" }, 404);
}

/** A message of a thread the person may continue AND whose turn they asked — what Save and Wrong? act on. */
async function ownTurnMessage(c: C, rawId: string | undefined): Promise<{ m: ChatMessageRow; reach: ThreadFor } | null> {
  const id = positiveId(rawId);
  const m = id === null ? null : await messageInOrg(c.var.ctx, id);
  if (!m) return null;
  const reach = await threadFor(c.var.ctx, me(c), m.thread_id);
  if (!reach || reach.access === "read" || !sameHandle(askerOf(m, reach.thread), me(c))) return null;
  return { m, reach };
}

askApp.delete("/ask/threads/:id", async (c) => {
  const t = await threadOr404(c);
  if (t instanceof Response) return t;
  // Its attachments go with it, except a file a ticket or a doc still refers to (src/deletion/ask.ts).
  await deleteAskThread(c.var.ctx, platform(c.env, me(c)), c.env.ARTIFACTS_BUCKET, me(c), t.id);
  return c.json({ ok: true });
});

askApp.post("/ask/threads/:id/stop", async (c) => {
  const reach = await continuableOr404(c, c.req.param("id"));
  if (reach instanceof Response) return reach;
  await requestStop(c.var.ctx, reach.thread.id);
  return c.json({ ok: true });
});

askApp.get("/ask/threads/:id/export", async (c) => {
  const t = await threadOr404(c);
  if (t instanceof Response) return t;
  const rows = await listMessages(c.var.ctx, t.id);
  const org = await orgIdentityOf(c.var.ctx);
  const base = appBase(artifactOrigin(c.env.PUBLIC_ORIGIN, new URL(c.req.url).origin), org?.slug);
  const md = partsMarkdown(t.title || "Ask Trov", rows.map((m) => {
    const content = contentOf(m);
    return { who: m.role === "user" ? "person" : "trov", mode: m.mode, at: m.created_at, text: content.text ?? "", blocks: ((content.blocks ?? []) as AskBlock[]).filter((b) => b.kind !== "save_form"), cites: parseJson<RefView[]>(m.cites_json, []) };
  }), base);
  const name = askExportName(t.title);
  return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${name}.md"`, "cache-control": "no-store" } });
});

/** Save as artifact, from the footer or a block: a save form under that answer — no model call. */
askApp.post("/ask/messages/:id/save-form", async (c) => {
  const own = await ownTurnMessage(c, c.req.param("id"));
  if (!own || own.m.role !== "assistant") return c.json({ error: "not_found" }, 404);
  const m = own.m;
  const body = (await c.req.json().catch(() => null)) as { block?: unknown } | null;
  const content = contentOf(m);
  const blocks = (content.blocks ?? []) as AskBlock[];
  const block = typeof body?.block === "number" && Number.isInteger(body.block) && body.block >= 0 && body.block < blocks.length ? body.block : null;
  const t = own.reach.thread;
  const form: AskSaveForm = { messageId: m.id, block, title: `${t.title || "Ask Trov"}, ${shortDay(nowDate().toISOString().slice(0, 10))}`, kind: "markdown", visibility: "private", saved: null };
  const added: AskBlock = { kind: "save_form", form };
  await setMessageContent(c.var.ctx, m.id, { ...content, blocks: [...blocks, added] });
  return c.json({ block: added, index: blocks.length });
});

askApp.post("/ask/threads/:id/save", async (c) => {
  const reach = await continuableOr404(c, c.req.param("id"));
  if (reach instanceof Response) return reach;
  const t = reach.thread;
  const parsed = AskSaveBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const rows = await listMessages(c.var.ctx, t.id);
  const one = parsed.data.messageId;
  // One answer: only its asker saves it. The whole thread: only its owner.
  const answer = one === undefined ? null : rows.find((m) => m.id === one && m.role === "assistant" && sameHandle(askerOf(m, t), me(c)));
  if (one !== undefined && !answer) return c.json({ error: "not_found" }, 404);
  if (one === undefined && reach.access !== "owner") return c.json({ error: "not_found" }, 404);
  if (!rows.length) return c.json({ error: "invalid", message: "Nothing to save yet." }, 400);
  const title = parsed.data.title ?? `${t.title || "Ask Trov"}, ${shortDay(nowDate().toISOString().slice(0, 10))}`;
  try {
    const saved = await saveFromThread(c, t, { messageId: one ?? null, block: parsed.data.block ?? null, title, kind: parsed.data.kind ?? "markdown", visibility: parsed.data.visibility ?? "private" });
    // The form becomes the saved line.
    if (answer) {
      const content = contentOf(answer);
      const blocks = ((content.blocks ?? []) as AskBlock[]).map((b) => (b.kind === "save_form" && b.form.saved === null ? { ...b, form: { ...b.form, title, saved } } : b));
      await setMessageContent(c.var.ctx, answer.id, { ...content, blocks });
    }
    return c.json(saved);
  } catch (e) {
    // A plan refusal is the app's ONE 402 body (`limit`, `used`, `cap`, `plan`, `status`, `message`; Q59).
    if (e instanceof PlanLimitError || e instanceof PlanFeatureError) return c.json(e.refusal, PLAN_LIMIT_STATUS);
    const b = errorBody(e);
    return c.json({ error: b.code ?? "failed", message: b.error }, 400);
  }
});

// ── write cards ──────────────────────────────────────────────────────────────

function toolCtxFor(c: C, threadId: number, slug: string): AskToolCtx {
  return {
    env: c.env, ctx: c.var.ctx, handle: me(c), orgSlug: slug, origin: new URL(c.req.url).origin, threadId,
    docs: askDeps.docs ?? assetsDocs(c.env), now: nowDate, searched: new Map(),
  };
}

/** A card the person may decide: on a thread they may continue, proposed in a turn THEY asked (a card runs as the
 *  person who confirms it, so only its asker does). Anything else is the one 404. */
async function actionOr404(c: C): Promise<ActionWithTurn | Response> {
  const id = positiveId(c.req.param("id"));
  const a = id === null ? null : await actionInOrg(c.var.ctx, id);
  const reach = a ? await threadFor(c.var.ctx, me(c), a.thread_id) : null;
  return a && reach && reach.access !== "read" && sameHandle(askerOf(a, reach.thread), me(c)) ? a : c.json({ error: "not_found" }, 404);
}

/** The cards a request acts on: the one, or its whole group (unless `only`). */
async function targets(c: C, a: ActionWithTurn, only: boolean): Promise<ActionWithTurn[]> {
  return a.group_id && !only ? groupActions(c.var.ctx, a.thread_id, a.group_id) : [a];
}

const result = (a: ChatActionRow, state: AskEventMap["action_result"]["state"], res: unknown, ref: string | null, undo: boolean): AskEventMap["action_result"] =>
  ({ id: a.id, groupId: a.group_id, tool: a.tool, kind: a.kind as AskAction["kind"], preview: parseJson(a.preview_json, { title: a.tool, lines: [], item: null }), state, result: res, ref, undo, at: nowDate().toISOString() });

askApp.post("/ask/actions/:id/confirm", async (c) => {
  const a = await actionOr404(c);
  if (a instanceof Response) return a;
  const parsed = AskConfirmBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  if (a.state === "expired") return c.json({ error: "expired", message: "This card expired with its turn." }, 409);
  if (a.state !== "proposed" && a.state !== "waiting") return c.json({ error: "already", message: `This card was already ${a.state}.` }, 409);
  // A card lives only as long as its turn.
  if (a.turn !== a.thread_turn) {
    await moveAction(c.var.ctx, a.id, ["proposed", "waiting"], "expired");
    return c.json({ error: "expired", message: "This card expired with its turn." }, 409);
  }
  const org = await orgIdentityOf(c.var.ctx);
  const tc = toolCtxFor(c, a.thread_id, org?.slug ?? "");
  const results: AskEventMap["action_result"][] = [];
  for (const one of await targets(c, a, !!parsed.data.only || !!parsed.data.args)) {
    const spec = WRITES[one.tool];
    if (!spec || (one.state !== "proposed" && one.state !== "waiting")) continue;
    // The ONE claim: proposed | waiting → running. A second Confirm (or a racing one) finds nothing to move.
    if (!(await moveAction(c.var.ctx, one.id, ["proposed", "waiting"], "running"))) {
      if (one.id === a.id) return c.json({ error: "already", message: "This card was already decided." }, 409);
      continue;
    }
    let args: unknown = parseJson(one.args_json, {});
    // Edited before Confirm: only the card's editable fields; re-validated, and the card rebuilt.
    if (one.id === a.id && parsed.data.args) {
      const bad = Object.keys(parsed.data.args).filter((k) => !(spec.editable ?? []).includes(k) && !(k === "body" && spec.card === "doc_edit"));
      try {
        if (bad.length) throw new Error(`not editable: ${bad.join(", ")}`);
        args = spec.input.parse(await spec.edit!(tc, spec.input.parse(args), parsed.data.args));
        await rewriteAction(c.var.ctx, one.id, args, await spec.preview(tc, args));
      } catch (e) {
        await moveAction(c.var.ctx, one.id, "running", one.state);
        const msg = e instanceof z.ZodError ? "Those changes don't fit this card." : e instanceof Error && /^not editable/.test(e.message) ? e.message : errorBody(e).error;
        return c.json({ error: "invalid", message: msg }, 400);
      }
    }
    try {
      // The CONFIRMER's rights now, as if they called the tool themselves — never the rights the card was made
      // under (Q57); each writer's own rule (the lane, the assignment rule…) runs again inside `run`.
      assertMayRunNow(c.var.ctx, one.tool);
      const ran = await spec.run(tc, spec.input.parse(args));
      await finishAction(c.var.ctx, one.id, "confirmed", ran.result, ran.undo);
      results.push(result(one, "confirmed", ran.result, ran.ref, ran.undo !== null));
    } catch (e) {
      const body = errorBody(e);
      await finishAction(c.var.ctx, one.id, "failed", body, null);
      results.push(result(one, "failed", body, null, false));
    }
  }
  const answer: AskActionAnswer = { results };
  return c.json(answer);
});

askApp.post("/ask/actions/:id/cancel", async (c) => {
  const a = await actionOr404(c);
  if (a instanceof Response) return a;
  const parsed = AskCancelBodySchema.safeParse((await c.req.json().catch(() => null)) ?? {});
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const results: AskEventMap["action_result"][] = [];
  for (const one of await targets(c, a, parsed.data.only === true)) {
    if (await moveAction(c.var.ctx, one.id, ["proposed", "waiting"], "cancelled")) results.push(result(one, "cancelled", null, null, false));
    else if (one.id === a.id) return c.json({ error: a.state === "expired" ? "expired" : "not_proposed", message: `This card is ${a.state}.` }, 409);
  }
  return c.json({ results } satisfies AskActionAnswer);
});

/** Undo a card — or its whole group — newest first. Before each, the write's own check: has anyone changed the
 *  item since? If so nothing more is undone: "Changed since. Undo it by hand." */
askApp.post("/ask/actions/:id/undo", async (c) => {
  const a = await actionOr404(c);
  if (a instanceof Response) return a;
  const org = await orgIdentityOf(c.var.ctx);
  const tc = toolCtxFor(c, a.thread_id, org?.slug ?? "");
  const list = (await targets(c, a, false)).filter((x) => (x.state === "confirmed" || x.state === "auto") && x.undo_json !== null).reverse();
  if (!list.length) return c.json({ error: "no_undo", message: "There is nothing to undo here." }, 409);
  const results: AskEventMap["action_result"][] = [];
  for (const one of list) {
    const from = one.state;
    if (!(await moveAction(c.var.ctx, one.id, from, "running"))) continue;
    try {
      const data = parseJson<Record<string, unknown>>(one.undo_json, {});
      const res = one.tool === "save_artifact" ? await undoSave(tc, data.slug as string) : await WRITES[one.tool]!.undo!(tc, data);
      await markUndone(c.var.ctx, one.id);
      results.push(result(one, "undone", res, null, false));
    } catch (e) {
      await moveAction(c.var.ctx, one.id, "running", from);
      if (e instanceof ChangedSince) return c.json({ error: "changed", message: e.message, ref: e.ref, results }, 409);
      const body = errorBody(e);
      return c.json({ error: body.code ?? "failed", message: body.error, results }, 409);
    }
  }
  return c.json({ results } satisfies AskActionAnswer);
});

/** A saved answer's Undo: delete the private artifact — only while nobody added a version since. */
async function undoSave(tc: AskToolCtx, slug: string): Promise<unknown> {
  const p = await getPage(tc.ctx, slug, null, tc.handle);
  if (p.current_version !== 1 || p.visibility !== "private") throw new ChangedSince(`artifact:${slug}`);
  return deletePage(tc.ctx, slug, tc.handle, false);
}

// ── attachments: stored on attach ────────────────────────────────────────────

askApp.post(ASK_ROUTES.attachments, async (c) => {
  let form: FormData;
  try { form = await c.req.raw.formData(); } catch { return c.json({ error: "invalid", message: "Send multipart/form-data with file fields." }, 400); }
  const ctx = c.var.ctx;
  const raw = form.get("threadId");
  let threadId = 0;
  if (raw !== null && raw !== "") {
    // The owner's thread, or one shared with the person to continue: the file is THEIR private artifact either way.
    const reach = await continuableOr404(c, String(raw));
    if (reach instanceof Response) return reach;
    threadId = reach.thread.id;
  }
  const files: UploadFile[] = [];
  for (const v of form.getAll("file") as unknown as (string | File)[]) {
    if (typeof v === "string") continue;
    files.push({ name: v.name || "attachment", type: v.type || "application/octet-stream", bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  try {
    checkFiles(files); // before anything is stored, so a refused upload leaves nothing behind
    // No conversation yet: the files are PENDING — on the person's hidden holder, never a visible thread — until the
    // question that sends them binds them to its thread; never sent, they go after 24 h (Q60; 0068_ask_pending).
    const holder = threadId ? null : await pendingHolder(ctx, me(c));
    const org = await orgIdentityOf(ctx);
    const attachments = await storeAttachments(ctx, c.env.ARTIFACTS_BUCKET, me(c), org?.slug ?? "", threadId || holder!, files);
    const body: AskAttachmentUpload = { threadId: threadId || null, attachments };
    return c.json(body);
  } catch (e) {
    if (e instanceof AttachError) return c.json({ error: e.code, message: e.message }, e.status);
    if (e instanceof PlanLimitError || e instanceof PlanFeatureError) return c.json(e.refusal, PLAN_LIMIT_STATUS); // Q59
    const b = errorBody(e);
    return c.json({ error: b.code ?? "failed", message: b.error }, b.code === "plan_limit" ? 402 : b.code === "too_large" ? 413 : 400);
  }
});

/** Remove an uploaded attachment that was never sent (the composer's chip ✕): a HARD delete through src/deletion/
 *  (the owner's ruling, CLAUDE.md invariant 11) — refused when it was sent, published, referred to, or not theirs. */
askApp.delete("/ask/attachments/:id", async (c) => {
  const id = positiveId(c.req.param("id"));
  if (id === null) return c.json({ error: "not_found" }, 404);
  const r = await deleteUnsentAttachment(c.var.ctx, platform(c.env, me(c)), c.env.ARTIFACTS_BUCKET, me(c), id);
  if (r.ok) return c.json({ ok: true });
  const message = r.why === "sent" ? "It was sent with a question: it stays with the thread."
    : r.why === "published" ? "It is in Artifacts for the org now: delete it there."
    : r.why === "referenced" ? "A ticket or a doc refers to it: it stays." : "Not found.";
  return c.json({ error: r.why, message }, r.why === "not_found" ? 404 : 409);
});

// ── "Wrong?" ─────────────────────────────────────────────────────────────────

askApp.post("/ask/messages/:id/wrong", async (c) => {
  const own = await ownTurnMessage(c, c.req.param("id"));
  if (!own || own.m.role !== "assistant") return c.json({ error: "not_found" }, 404);
  const m = own.m;
  const parsed = AskWrongBodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const cites = parseJson<RefView[]>(m.cites_json, []).map((x) => x.ref);
  // Review's "Flagged in Ask": the reason only, on each cited item — never the question, the answer or who asked.
  const flags = ASK_FLAG_REASONS.includes(parsed.data.reason) ? cites : [];
  await recordAskWrong(c.var.ctx, me(c), m.id, m.model, { reason: parsed.data.reason, mode: m.mode, cites }, flags);
  return c.json({ ok: true });
});

// ── Settings › Trov ──────────────────────────────────────────────────────────

async function settingsBody(ctx: TenantContext, handle: string): Promise<AskSettings> {
  const [s, st] = await Promise.all([getAskSettings(ctx, handle), standing(ctx)]);
  return { instructions: s.instructions, defaultMode: defaultModeOf(st.modes, s.default_mode), modes: [...st.modes] };
}

askApp.get(ASK_ROUTES.settings, async (c) => c.json(await settingsBody(c.var.ctx, me(c))));

askApp.put(ASK_ROUTES.settings, async (c) => {
  const parsed = AskSettingsPutSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  // The default mode is Pro's: on a plan that offers only Smart, nothing else can be chosen.
  if (parsed.data.defaultMode && !(await standing(c.var.ctx)).modes.includes(parsed.data.defaultMode)) {
    return c.json({ error: "mode_unavailable", message: "On Free, every question uses Smart." }, 403);
  }
  await putAskSettings(c.var.ctx, me(c), { instructions: parsed.data.instructions?.trim(), defaultMode: parsed.data.defaultMode });
  return c.json(await settingsBody(c.var.ctx, me(c)));
});
