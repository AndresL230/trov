// Handoffs — addressed messages from one session to the next (0028).
//
// NOT the ingestion gate: a handoff is not knowledge, so it carries no vocab or
// confidence and is never staged. Its writers are direct, like the ticket
// writers, with three rules of their own:
//   · the SENDER is always the authenticated principal, never the body's;
//   · a claim is ONE conditional UPDATE (`… WHERE status = 'pending' AND <may
//     claim>`), so two sessions racing on an `anyone` handoff cannot both win;
//   · a create that carries a session id is replay-safe through processed_items,
//     keyed exactly like /ingest and record_session (session id + item index).
//
// A handoff's two ids (canopy-multitenancy.md §12 Q2), as for a ticket (./tickets.ts): `number` is
// the per-org number (0042_organizations — allocated by the insert trigger) and it is what every function here
// takes and returns: the wire's `id`, `#12`, a link, the feed line. The row `id` is internal and
// never leaves this file. Another org's number is simply not there.

import { z } from "zod";
import { all, first, run, nowIso, type TenantContext } from "../data/sql";
import { append_feed } from "./writes";
import { memberHandle } from "../auth/persons";
import { query } from "./reads";
import { routeAi } from "./ai-route";
import { randomToken, sha256Hex } from "../auth/crypto";
import { ARTIFACT_UPLOAD_TTL_MS, SHA256_HEX_RE } from "@shared/artifacts";
import type { QueryPrimary } from "@shared/contract";
import {
  EMPTY_CONTEXT, firstLine, HANDOFF_READING_MAX, HANDOFF_READING_HEADING,
  type HandoffBox, type HandoffContext, type HandoffStatus, type HandoffView, type HandoffReadingItem, type HandoffReadingKind,
} from "@shared/handoffs";

export class HandoffError extends Error {
  constructor(readonly code: "not_found" | "conflict" | "bad_request" | "forbidden" | "gone" | "too_large", message: string) {
    super(message);
    this.name = "HandoffError";
  }
}
export const HANDOFF_ERROR_STATUS = { not_found: 404, conflict: 409, bad_request: 400, forbidden: 403, gone: 410, too_large: 413 } as const;

/** 32 KB of UTF-8 — a summary, not a transcript (long instructions go in the prompt). */
export const HANDOFF_BODY_MAX = 32 * 1024;
/** A pending handoff expires this long after it was sent (the cron flips it). */
export const HANDOFF_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const Strings = z.array(z.string().max(2000)).max(200);
export const HandoffCreateInput = z.object({
  recipient: z.string().trim().min(1).max(64).optional(),
  body: z.string().refine((b) => b.trim().length > 0, "body required")
    .refine((b) => new TextEncoder().encode(b).length <= HANDOFF_BODY_MAX, "body over 32KB"),
  context: z.object({
    repo: z.string().max(200).optional(),
    branch: z.string().max(200).optional(),
    task: z.string().max(500).optional(),
    done: Strings.optional(),
    next: Strings.optional(),
    files: Strings.optional(),
  }).optional(),
  // Both or neither: an empty prompt is `null` (or absent).
  prompt: z.object({ title: z.string().trim().min(1).max(200), body: z.string().min(1).max(HANDOFF_BODY_MAX) }).nullable().optional(),
});
export type HandoffCreateInput = z.infer<typeof HandoffCreateInput>;

interface HandoffRow {
  id: number; number: number; sender: string; recipient: string; status: HandoffStatus; body: string; context: string;
  prompt_title: string | null; prompt_body: string | null;
  created_at: string; claimed_at: string | null; claimed_by: string | null; claimed_by_session: string | null;
  expires_at: string;
}

function parseContext(json: string): HandoffContext {
  let v: Record<string, unknown> = {};
  try { const p: unknown = JSON.parse(json); if (p && typeof p === "object" && !Array.isArray(p)) v = p as Record<string, unknown>; } catch { /* malformed → empty */ }
  const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string) : "");
  const list = (k: string) => (Array.isArray(v[k]) ? (v[k] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  return { repo: str("repo"), branch: str("branch"), task: str("task"), done: list("done"), next: list("next"), files: list("files") };
}

export function toHandoffView(r: HandoffRow): HandoffView {
  return {
    id: r.number, sender: r.sender, recipient: r.recipient, status: r.status,
    created_at: r.created_at, claimed_at: r.claimed_at, claimed_by: r.claimed_by, claimed_by_session: r.claimed_by_session,
    prompt: r.prompt_title !== null && r.prompt_body !== null ? { title: r.prompt_title, body: r.prompt_body } : null,
    body: r.body, context: parseContext(r.context),
  };
}

// `?1` is the caller; the org predicate follows it in the statement, so its `?` binds second.
const BOX_WHERE: Record<HandoffBox, string> = {
  mine: "(recipient = ?1 COLLATE NOCASE OR sender = ?1 COLLATE NOCASE)",
  me: "recipient = ?1 COLLATE NOCASE",
  anyone: "recipient = 'anyone' AND sender <> ?1 COLLATE NOCASE",
  sent: "sender = ?1 COLLATE NOCASE",
};

/** The caller's handoffs in one box, newest first. `statuses` narrows (the MCP list reads pending only). */
export async function listHandoffs(ctx: TenantContext, me: string, box: HandoffBox, statuses?: HandoffStatus[]): Promise<HandoffView[]> {
  const st = statuses && statuses.length ? ` AND status IN (${statuses.map((s) => `'${s}'`).join(", ")})` : "";
  const rows = await all<HandoffRow>(ctx, `SELECT * FROM handoffs WHERE ${BOX_WHERE[box]} AND org_id = ?${st} ORDER BY created_at DESC, id DESC`, me, ctx.orgId);
  return rows.map(toHandoffView);
}

/** One handoff of the org BY NUMBER; another org's number reads as absent. */
export async function getHandoff(ctx: TenantContext, number: number): Promise<HandoffView | null> {
  const r = await first<HandoffRow>(ctx, `SELECT * FROM handoffs WHERE number = ? AND org_id = ?`, number, ctx.orgId);
  return r ? toHandoffView(r) : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The handoff a session item already created, or null; a ledger row with no handoff behind it is a conflict. */
async function replayedHandoff(ctx: TenantContext, ledger?: { sessionId: string; itemIndex: number }): Promise<HandoffView | null> {
  if (!ledger) return null;
  const hit = await first<{ ref: string | null }>(ctx, `SELECT ref FROM processed_items WHERE org_id = ? AND session_id = ? AND item_index = ?`, ctx.orgId, ledger.sessionId, ledger.itemIndex);
  if (!hit) return null;
  const prior = hit.ref ? await getHandoff(ctx, Number(hit.ref)) : null;
  if (prior) return prior;
  throw new HandoffError("conflict", "this session item was already recorded");
}

/** `anyone`, or the canonical handle of a MEMBER of this org (§4.3): another org's person reads as unknown. */
async function resolveRecipient(ctx: TenantContext, raw: string | undefined): Promise<string> {
  const recipient = raw ?? "anyone";
  if (recipient.toLowerCase() === "anyone") return "anyone";
  const member = await memberHandle(ctx, recipient.replace(/^@/, ""));
  if (!member) throw new HandoffError("bad_request", `unknown recipient: ${recipient}`);
  return member;
}

/** The fixed context shape, every field present. */
function fullContext(input: HandoffCreateInput["context"]): HandoffContext {
  const c = { ...EMPTY_CONTEXT, ...(input ?? {}) };
  return {
    repo: c.repo ?? "", branch: c.branch ?? "", task: c.task ?? "",
    done: c.done ?? [], next: c.next ?? [], files: c.files ?? [],
  };
}

/**
 * Leave a handoff. `ledger` (an agent's session id + item index) makes a retried
 * call return the FIRST call's handoff instead of writing a second row.
 */
export async function createHandoff(
  ctx: TenantContext, sender: string, input: HandoffCreateInput, ledger?: { sessionId: string; itemIndex: number },
): Promise<{ handoff: HandoffView; replayed: boolean }> {
  const prior = await replayedHandoff(ctx, ledger);
  if (prior) return { handoff: prior, replayed: true };
  const recipient = await resolveRecipient(ctx, input.recipient);
  const context = fullContext(input.context);
  const now = new Date();
  const created_at = now.toISOString();
  const expires_at = new Date(now.getTime() + HANDOFF_TTL_MS).toISOString();
  const res = await run(
    ctx,
    `INSERT INTO handoffs (org_id, sender, recipient, status, body, context, prompt_title, prompt_body, created_at, expires_at)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    ctx.orgId, sender, recipient, input.body, JSON.stringify(context),
    input.prompt?.title ?? null, input.prompt?.body ?? null, created_at, expires_at,
  );
  // The row id is used once, to read back the number the trigger gave it; everything after is the number.
  const id = (await first<{ number: number }>(ctx, `SELECT number FROM handoffs WHERE id = ? AND org_id = ?`, res.meta.last_row_id as number, ctx.orgId))!.number;
  if (ledger) {
    await run(ctx, `INSERT OR IGNORE INTO processed_items (org_id, session_id, item_index, item_type, outcome, ref, created_at) VALUES (?, ?, ?, 'handoff', 'written', ?, ?)`,
      ctx.orgId, ledger.sessionId, ledger.itemIndex, String(id), created_at);
  }
  // The feed shows the handoff happened (who → whom, and its title). Direct
  // writer, no tags: an addressed message is not topic-tagged knowledge.
  // HANDOFF_FEED_LINE (below) recognises this line, so no handoff's reading list lists an announcement.
  await append_feed(ctx, {
    author: sender,
    summary: `${sender} left a handoff for ${recipient === "anyone" ? "anyone" : recipient}: #${id} ${firstLine(input.body)}`.slice(0, 300),
    body: context.task ? `Task: ${context.task}${context.branch ? ` (\`${context.branch}\`)` : ""}` : undefined,
  });
  await routeAi(ctx, { type: "handoff_sent", recipient });
  return { handoff: (await getHandoff(ctx, id))!, replayed: false };
}

// ── The upload form (0080_handoff_upload_tokens) ──────────────────────────────
//
// A long prompt costs an agent thousands of output tokens to type into a tool call; with a shell it can
// upload the text instead. `send_handoff` with `prompt: { title, sha256, size_bytes }` writes NO handoff:
// `mintHandoffUpload` stores the whole pending handoff on a single-use token (only the token's SHA-256 is
// kept, as for artifact uploads; same 5-minute TTL) and returns the PUT link. The PUT — the artifact route,
// `PUT /api/artifacts/upload/<token>` (src/artifacts/upload.ts), so no new unauthenticated route — checks
// the bytes and only then runs `createHandoff`: a half-made handoff never shows in an inbox or a badge.
// Ask has no shell and never mints one (src/ai/ask/actions.ts refuses the form).

export const HandoffUploadInput = HandoffCreateInput.extend({
  prompt: z.object({
    title: z.string().trim().min(1).max(200),
    sha256: z.string().trim().toLowerCase().regex(SHA256_HEX_RE, "sha256 must be 64 hex characters (e.g. `shasum -a 256 prompt.md`)"),
    size_bytes: z.number().int().min(1, "size_bytes must be a positive integer").max(HANDOFF_BODY_MAX, `the prompt is at most ${HANDOFF_BODY_MAX} bytes`),
  }),
});
export type HandoffUploadInput = z.infer<typeof HandoffUploadInput>;

export type HandoffUploadMint =
  | { replayed: true; handoff: HandoffView }
  | { replayed: false; token: string; upload_path: string; expires_at: string };

/**
 * The upload form's first half: validate everything a create would (the recipient is checked now, and
 * again at the PUT), then mint the token. A session item that already made a handoff returns it instead
 * (`replayed`), so a retried send never mints a second one. `linkBase` is the app link of the caller's org
 * (`<origin>/<slug>`), which the PUT's `url` is built from. Writes only the token row.
 */
export async function mintHandoffUpload(
  ctx: TenantContext, sender: string, input: HandoffUploadInput, linkBase: string, ledger?: { sessionId: string; itemIndex: number },
): Promise<HandoffUploadMint> {
  const prior = await replayedHandoff(ctx, ledger);
  if (prior) return { replayed: true, handoff: prior };
  const recipient = await resolveRecipient(ctx, input.recipient);
  const token = randomToken();
  const now = Date.now();
  const expires_at = new Date(now + ARTIFACT_UPLOAD_TTL_MS).toISOString();
  await run(
    ctx,
    `INSERT INTO handoff_upload_tokens (token_hash, org_id, principal, recipient, body, context, prompt_title, sha256, size_bytes, session_id, link_base, expires_at, used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    await sha256Hex(token), ctx.orgId, sender, recipient, input.body, JSON.stringify(fullContext(input.context)),
    input.prompt.title, input.prompt.sha256, input.prompt.size_bytes, ledger?.sessionId ?? null, linkBase, expires_at, new Date(now).toISOString(),
  );
  return { replayed: false, token, upload_path: `/api/artifacts/upload/${token}`, expires_at };
}

interface HandoffUploadTokenRow {
  principal: string; recipient: string; body: string; context: string; prompt_title: string;
  sha256: string; size_bytes: number; session_id: string | null; link_base: string; expires_at: string; used_at: string | null;
}

/** Up to `max` bytes of a body, or null when it holds more (reading stops there). */
async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

const hexOf = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The PUT for a handoff token. `null` when the token is not a handoff token OF THIS ORG (the caller then
 * tries artifacts). In order: a used or expired token is `gone`; a body over `HANDOFF_BODY_MAX` is
 * `too_large`; a body whose length or SHA-256 is not the declared one, or that is not UTF-8, is
 * `bad_request` — none of these touch the token, so it stays usable within its TTL. Then ONE conditional
 * UPDATE claims it (a racing second PUT gets `gone`), the sender must still be a member (else `not_found`,
 * as for a token that is not there), and `createHandoff` runs as the sender with the token's ledger key —
 * the feed line, the AI router and the replay ledger exactly as an inline send. A create that fails
 * releases the claim.
 */
export async function consumeHandoffUploadToken(
  ctx: TenantContext, token: string, body: ReadableStream<Uint8Array> | null, contentLength: string | null,
): Promise<{ handoff: HandoffView; replayed: boolean; url: string } | null> {
  const hash = await sha256Hex(String(token ?? ""));
  const t = await first<HandoffUploadTokenRow>(ctx,
    `SELECT principal, recipient, body, context, prompt_title, sha256, size_bytes, session_id, link_base, expires_at, used_at
       FROM handoff_upload_tokens WHERE token_hash = ? AND org_id = ?`, hash, ctx.orgId);
  if (!t) return null;
  const gone = () => new HandoffError("gone", "this upload link has expired or was already used");
  if (t.used_at !== null || t.expires_at <= nowIso()) throw gone();
  const tooLarge = new HandoffError("too_large", `a handoff prompt is at most ${HANDOFF_BODY_MAX} bytes`);
  if (contentLength !== null && Number(contentLength) > HANDOFF_BODY_MAX) throw tooLarge;
  if (!body) throw new HandoffError("bad_request", "the upload body is empty");
  const bytes = await readCapped(body, HANDOFF_BODY_MAX);
  if (!bytes) throw tooLarge;
  if (bytes.byteLength !== t.size_bytes || hexOf(await crypto.subtle.digest("SHA-256", bytes)) !== t.sha256) {
    throw new HandoffError("bad_request", "the upload did not match its declared size_bytes or sha256");
  }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new HandoffError("bad_request", "the prompt must be UTF-8 text"); }

  const now = nowIso();
  const claim = await run(ctx, `UPDATE handoff_upload_tokens SET used_at = ? WHERE token_hash = ? AND org_id = ? AND used_at IS NULL AND expires_at > ?`, now, hash, ctx.orgId, now);
  if (!claim.meta.changes) throw gone();
  try {
    // The sender must still belong to the org the token was minted in (the bearer that minted it may have left).
    if (!(await memberHandle(ctx, t.principal))) throw new HandoffError("not_found", "not_found");
    const input = HandoffCreateInput.parse({
      body: t.body, recipient: t.recipient === "anyone" ? undefined : t.recipient, context: parseContext(t.context),
      prompt: { title: t.prompt_title, body: text },
    });
    const ledger = t.session_id ? { sessionId: t.session_id, itemIndex: 0 } : undefined;
    const { handoff, replayed } = await createHandoff(ctx, t.principal, input, ledger);
    return { handoff, replayed, url: `${t.link_base}/#handoffs/${handoff.id}` };
  } catch (e) {
    await run(ctx, `UPDATE handoff_upload_tokens SET used_at = NULL WHERE token_hash = ? AND org_id = ? AND used_at = ?`, hash, ctx.orgId, now);
    if (e instanceof z.ZodError) throw new HandoffError("bad_request", e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
    throw e;
  }
}

/** After a guarded UPDATE touched nothing, say why: unknown, not yours, or no longer pending. */
async function explainMiss(ctx: TenantContext, id: number, allowed: (r: HandoffRow) => boolean): Promise<never> {
  const r = await first<HandoffRow>(ctx, `SELECT * FROM handoffs WHERE number = ? AND org_id = ?`, id, ctx.orgId);
  if (!r) throw new HandoffError("not_found", "handoff not found");
  if (!allowed(r)) throw new HandoffError("forbidden", "not your handoff");
  throw new HandoffError("conflict", `handoff is ${r.status}`);
}

/**
 * Claim atomically: ONE statement flips pending → claimed only when the caller
 * may claim it (the recipient, anyone for an `anyone` handoff, or the sender).
 * Two racing claims: exactly one UPDATE changes a row; the other re-reads and
 * gets `handoff is claimed`. `id` is the handoff's NUMBER here and in `expireHandoff`.
 */
export async function claimHandoff(ctx: TenantContext, id: number, me: string, session: string): Promise<HandoffView> {
  const res = await run(
    ctx,
    `UPDATE handoffs SET status = 'claimed', claimed_at = ?, claimed_by = ?, claimed_by_session = ?
     WHERE number = ? AND org_id = ? AND status = 'pending'
       AND (recipient = 'anyone' OR recipient = ? COLLATE NOCASE OR sender = ? COLLATE NOCASE)`,
    nowIso(), me, session, id, ctx.orgId, me, me,
  );
  if (!res.meta.changes) await explainMiss(ctx, id, (r) => r.recipient === "anyone" || same(r.recipient, me) || same(r.sender, me));
  return (await getHandoff(ctx, id))!;
}

/** Expire by hand: only the sender or the named recipient, pending only. */
export async function expireHandoff(ctx: TenantContext, id: number, me: string): Promise<HandoffView> {
  const res = await run(
    ctx,
    `UPDATE handoffs SET status = 'expired'
     WHERE number = ? AND org_id = ? AND status = 'pending' AND (sender = ? COLLATE NOCASE OR recipient = ? COLLATE NOCASE)`,
    id, ctx.orgId, me, me,
  );
  if (!res.meta.changes) await explainMiss(ctx, id, (r) => same(r.sender, me) || same(r.recipient, me));
  return (await getHandoff(ctx, id))!;
}

/**
 * The claim_handoff result: ONE markdown block an agent can act on — the prompt
 * first (the instructions), then the summary, then the context as lists.
 */
export function handoffAsTask(h: HandoffView): string {
  const c = h.context;
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  const parts: string[] = [];
  if (h.prompt) parts.push(h.prompt.body.trim());
  parts.push(`## Handoff summary\n\n${h.body.trim()}`);
  parts.push([
    "## Context",
    "",
    `- Repo: ${c.repo || "(none)"}`,
    `- Branch: ${c.branch || "(none)"}`,
    `- Task: ${c.task || "(none)"}`,
    "",
    "### Done",
    list(c.done),
    "",
    "### Next",
    list(c.next),
    "",
    "### Files",
    list(c.files),
  ].join("\n"));
  return parts.join("\n\n");
}

// ── "Read these first (not complete)" (#167) ──────────────────────────────────
//
// Computed when a handoff is CLAIMED (a write path) and returned with the claim; never stored and
// never computed on a render. It is retrieval, not judgement: the handoff's own words become a
// `query()` — the same FTS5/bm25 engine as MCP `query` and /search — over the claiming org (`ctx`,
// so another org's rows are never candidates). What the claimer could not see is never listed:
// `viewer` is the claimer (a private artifact reaches only its author) and `include_staged: false`
// keeps it to settled content, as /search does (no unpromoted doc, no draft decision or artifact).
// No model, no network. Every surface heads it HANDOFF_READING_HEADING: it is never complete.

const READING_TYPES: readonly HandoffReadingKind[] = ["doc", "decision", "feed", "artifact"];
/** The query's words: enough to rank by, few enough that one common word cannot swamp them. */
const READING_TERMS_MAX = 24;
/** Candidates bm25 picks PER KIND (full bodies) before they are re-ranked, filtered and capped. */
const READING_FETCH = 8;
/** A handoff's own feed announcement (createHandoff's summary) — it echoes the handoff, so it is never "read first". */
const HANDOFF_FEED_LINE = /^\S+ left a handoff for \S+: #\d+ /;

// Words that carry no topic: English glue plus a handoff's own vocabulary.
const READING_STOP = new Set((
  "about above after again against all also and any are aren because been before being below between both but "
  + "can cannot could did does doing done down during each few for from further had has have having her here hers "
  + "him his how into its itself just let more most must nor not now off once only other our ours out over own "
  + "same she should some still such than that the their theirs them then there these they this those through too "
  + "under until very was were what when where which while who whom why will with would yet you your yours "
  + "get got make made need needs use used using via per like one two three left right next last first new old "
  + "handoff handoffs session task todo done next files file see read run runs ran work works working wip fix fixed "
  + "add added adds remove removed change changed update updated thing things way bit lot ok yes"
).split(" "));

/** One query word and how much it says: the task's and the title's words count double. */
export interface ReadingTerm { term: string; weight: number }

/**
 * The handoff's own words, most telling first: the task and the title (weight 2), then the file
 * names, what is next, the rest of the body, what is done and the prompt's title (weight 1).
 * Lowercased, de-duplicated, no stop words, no bare numbers, nothing under three letters; at most
 * READING_TERMS_MAX.
 */
export function readingTerms(h: HandoffView): ReadingTerm[] {
  const c = h.context;
  const lines = h.body.split("\n");
  const fi = lines.findIndex((l) => l.trim());
  const rest = fi >= 0 ? lines.slice(fi + 1).join("\n") : "";
  // A file path speaks through its name: `src/tools/handoffs.ts` → `handoffs`.
  const stems = c.files.map((f) => (f.split("/").pop() ?? "").replace(/\.[^.]+$/, ""));
  const sources: Array<[string, number]> = [
    [c.task, 2], [firstLine(h.body), 2],
    ...stems.map((x): [string, number] => [x, 1]), ...c.next.map((x): [string, number] => [x, 1]),
    [rest, 1], ...c.done.map((x): [string, number] => [x, 1]), [h.prompt?.title ?? "", 1],
  ];
  const out: ReadingTerm[] = [];
  for (const [text, weight] of sources) {
    for (const w of words(text)) {
      if (w.length < 3 || /^\d+$/.test(w) || READING_STOP.has(w) || out.some((t) => t.term === w)) continue;
      out.push({ term: w, weight });
      if (out.length >= READING_TERMS_MAX) return out;
    }
  }
  return out;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** A word's matching stem: a long word drops its last two letters (`retries` → `retri`, `pages` → `page`). */
const stemOf = (t: string): string => (t.length <= 4 ? t : t.slice(0, Math.max(4, t.length - 2)));

/** The query words a text contains, by stem (a token that starts with the stem and is not much longer). */
function termsIn(text: string, terms: ReadingTerm[]): Set<string> {
  const tokens = new Set(words(text));
  const hit = new Set<string>();
  for (const t of terms) {
    const st = stemOf(t.term);
    for (const x of tokens) if (x.startsWith(st) && x.length <= st.length + 4) { hit.add(t.term); break; }
  }
  return hit;
}

/** The line of `body` holding the most of the query's weight — Trov's own text, as evidence. */
function evidence(body: string, terms: ReadingTerm[]): string {
  let best = "", bestW = 0;
  for (const l of body.split(/\n+|(?<=[.!?])\s+/)) {
    const hit = termsIn(l, terms);
    const w = terms.reduce((sum, t) => sum + (hit.has(t.term) ? t.weight : 0), 0);
    if (w > bestW) { best = l; bestW = w; }
  }
  const s = best.replace(/[#>*`|]+/g, " ").replace(/\s+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 199).trimEnd()}…` : s;
}

/**
 * The reading list for a handoff `viewer` has just claimed: at most HANDOFF_READING_MAX items, best
 * first. `[]` when the handoff has no searchable words or nothing matched well enough.
 *
 * Two passes, both plain retrieval. `query()` (bm25, OR of the words) picks READING_FETCH candidates
 * of EACH kind — one call per kind, because bm25 from different FTS tables does not compare (a small
 * table where every row holds a word scores ~0) — and its order is the tiebreak. The candidates are
 * then ranked together by WHICH of the handoff's words they hold — each word
 * worth its weight times how rare it is among the candidates, double in the title — because an OR
 * query alone ranks a short entry that shares one word ("page") above the doc that shares five.
 * An item holding fewer than two of the words (one, for a one-word handoff) is not listed.
 */
export async function handoffReadingList(ctx: TenantContext, h: HandoffView, viewer: string): Promise<HandoffReadingItem[]> {
  const terms = readingTerms(h);
  if (!terms.length) return [];
  const q = terms.map((t) => t.term).join(" ");
  const found: QueryPrimary[] = [];
  for (const type of READING_TYPES) {
    // A feed kind fetches one extra: a handoff announcement is dropped below.
    const res = await query(ctx, { q, types: [type], include_staged: false, limit: READING_FETCH + (type === "feed" ? 1 : 0), pointer_limit: 0 }, viewer);
    found.push(...res.primary.filter((p) => p.type === type));
  }
  const cands = found
    .filter((p) => !(p.type === "feed" && HANDOFF_FEED_LINE.test(p.title)))
    .map((p, rank) => ({
      p, rank, inTitle: termsIn(p.title, terms), inAll: termsIn(`${p.title}\n${p.body}`, terms),
      size: new Set(words(`${p.title}\n${p.body}`)).size,
    }));
  const df = new Map<string, number>();
  for (const c of cands) for (const t of c.inAll) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + cands.length / (df.get(t) ?? 1));
  // A long doc holds more of any word list by its length alone: its score is damped by its size
  // against the candidates' average (bm25's own length rule, half strength).
  const avgSize = cands.reduce((sum, c) => sum + c.size, 0) / Math.max(1, cands.length);
  const need = Math.min(2, terms.length);
  return cands
    .filter((c) => c.inAll.size >= need)
    .map((c) => ({
      ...c,
      score: terms.reduce((sum, t) => sum + (c.inAll.has(t.term) ? t.weight * idf(t.term) * (c.inTitle.has(t.term) ? 2 : 1) : 0), 0)
        / (0.5 + 0.5 * (c.size / Math.max(1, avgSize))),
    }))
    .sort((x, y) => y.score - x.score || x.rank - y.rank)
    .slice(0, HANDOFF_READING_MAX)
    .map(({ p }) => ({ kind: p.type as HandoffReadingKind, id: p.id, title: p.title, snippet: evidence(p.body, terms) }));
}

/**
 * Claim, then build the reading list. The claim is the write and it stands on its own: a list that
 * cannot be built is `null` (logged without its text), never a failed claim.
 */
export async function claimHandoffWithReading(
  ctx: TenantContext, id: number, me: string, session: string,
): Promise<{ handoff: HandoffView; reading_list: HandoffReadingItem[] | null }> {
  const handoff = await claimHandoff(ctx, id, me, session);
  let reading_list: HandoffReadingItem[] | null;
  try { reading_list = await handoffReadingList(ctx, handoff, me); }
  catch (e) {
    console.error("handoff reading list failed", e instanceof Error ? e.name : "error");
    reading_list = null;
  }
  return { handoff, reading_list };
}

const READING_KIND_WORD: Record<HandoffReadingKind, string> = { doc: "Doc", decision: "Decision", feed: "Feed entry", artifact: "Artifact" };
// How an agent opens each kind: docs and artifacts by slug; a decision or a feed entry has no
// read-by-id tool, so `query` with its type finds it (the listed snippet is already its passage).
const READING_OPEN: Record<HandoffReadingKind, (id: string) => string> = {
  doc: (id) => `get_doc slug \`${id}\``,
  decision: (id) => `decision #${id}, via query types ["decision"]`,
  feed: (id) => `feed entry #${id}, via query types ["feed"]`,
  artifact: (id) => `artifact_get slug \`${id}\``,
};
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

/**
 * The claim_handoff section for the list. Empty → "" (nothing is drawn); `null` → one line saying
 * it could not be built, so an agent does not read silence as "nothing relevant".
 */
export function readingListAsMarkdown(items: HandoffReadingItem[] | null): string {
  if (items === null) return `## ${HANDOFF_READING_HEADING}\n\nCouldn't build the reading list this time. Use \`query\` with the task's words.`;
  if (!items.length) return "";
  const rows = items.map((it) => {
    const line = `- ${READING_KIND_WORD[it.kind]}: ${clip(it.title.replace(/\s+/g, " ").trim(), 140)} (${READING_OPEN[it.kind](it.id)})`;
    return it.snippet ? `${line}\n  > ${clip(it.snippet, 200)}` : line;
  });
  return [
    `## ${HANDOFF_READING_HEADING}`,
    "",
    "Ranked by a text search over this organization with the handoff's own words. It is a starting point, not everything that bears on the task; `query` finds more.",
    "",
    ...rows,
  ].join("\n");
}
