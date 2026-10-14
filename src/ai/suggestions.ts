// Answering a suggestion (docs/architecture/ai.md › Suggestions): Accept writes the suggested value to the
// REAL field, as the person who pressed it; Dismiss is remembered. A person's action over a cookie route
// (./routes.ts), never an agent's — nothing reachable from src/mcp.ts imports this.
//
// Accepting is a per-KIND handler from `AI_ACCEPT_HANDLERS`. The registry is EMPTY today — no producer
// writes a suggestion yet — so accept answers `not_available` for every kind. A handler declares who may
// accept its kind (`role`: a ticket's category may be any member's call, a theme an admin's); dismissing is
// open to every member.
import type { AiSuggestion, AiSuggestionError } from "@shared/ai";
import { hasRole, type TenantContext } from "../data/context";
import { decideSuggestion, getSuggestion, reopenSuggestion, suggestionDto, type AiSuggestionRow } from "../data/ai";
import { nowIso } from "../data/sql";

export interface AcceptHandler {
  /** Who may accept this kind: any member, or an admin (admin or owner) of the org. */
  role: "member" | "admin";
  /** Write the real field AS `ctx`'s person (the signed-in caller's own context — the author is always the
   *  authenticated principal). `value` is the suggested one, or the person's replacement (Rename). Throw to
   *  refuse: the suggestion goes back to open. A `PlanLimitError` reaches the app's 402 as usual. */
  apply(ctx: TenantContext, suggestion: AiSuggestionRow, value: unknown): Promise<void>;
}

/** THE registry, by `ai_suggestions.kind`. Empty: nothing produces a suggestion yet. */
export const AI_ACCEPT_HANDLERS: Readonly<Record<string, AcceptHandler>> = {};

export type SuggestionAnswer =
  | { ok: true; suggestion: AiSuggestion }
  | { ok: false; status: 403 | 404 | 409; error: AiSuggestionError }
  | { ok: false; status: 400; error: "invalid" };

const STATUS: Record<AiSuggestionError, 403 | 404 | 409> = { not_found: 404, not_open: 409, not_available: 409, forbidden: 403 };
const refuse = (error: AiSuggestionError): SuggestionAnswer => ({ ok: false, status: STATUS[error], error });

/**
 * Accept suggestion `id` (its global row id) as `ctx`'s person. In this order: an id that is not this org's
 * is `not_found` (before anything else is said about it, a bad body included); a decided one `not_open`; a
 * kind with no handler `not_available`; a person below the handler's role `forbidden`; a body the contract
 * refuses (`body` null) `invalid`. Then the row is CLAIMED (one guarded
 * UPDATE, so two people pressing at once cannot both apply it), the handler writes, and on its throw the
 * claim is undone.
 */
export async function acceptSuggestion(
  ctx: TenantContext, id: number, body: { value?: unknown } | null, handlers: Readonly<Record<string, AcceptHandler>> = AI_ACCEPT_HANDLERS,
): Promise<SuggestionAnswer> {
  const row = await getSuggestion(ctx, id);
  if (!row) return refuse("not_found");
  if (row.state !== "open") return refuse("not_open");
  const handler = Object.hasOwn(handlers, row.kind) ? handlers[row.kind] : undefined;
  if (!handler) return refuse("not_available");
  if (handler.role === "admin" && !hasRole(ctx, "admin")) return refuse("forbidden");
  if (!body) return { ok: false, status: 400, error: "invalid" };
  const at = nowIso();
  if (!(await decideSuggestion(ctx, id, "accepted", ctx.userId, at))) return refuse("not_open");
  let value: unknown = body.value;
  if (value === undefined) {
    try { value = JSON.parse(row.value_json); } catch { value = null; }
  }
  try {
    await handler.apply(ctx, row, value);
  } catch (e) {
    await reopenSuggestion(ctx, id, ctx.userId, at);
    throw e;
  }
  return { ok: true, suggestion: suggestionDto({ ...row, state: "accepted", decided_by: ctx.userId, decided_at: at }) };
}

/** Dismiss suggestion `id` as `ctx`'s person — any member; the decision is remembered (a re-run of the kind
 *  supersedes only an OPEN suggestion). */
export async function dismissSuggestion(ctx: TenantContext, id: number): Promise<SuggestionAnswer> {
  const row = await getSuggestion(ctx, id);
  if (!row) return refuse("not_found");
  const at = nowIso();
  if (row.state !== "open" || !(await decideSuggestion(ctx, id, "dismissed", ctx.userId, at))) return refuse("not_open");
  return { ok: true, suggestion: suggestionDto({ ...row, state: "dismissed", decided_by: ctx.userId, decided_at: at }) };
}
