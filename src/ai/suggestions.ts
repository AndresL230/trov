// Answering a suggestion (docs/architecture/ai.md › Suggestions): Accept writes the suggested value to the
// REAL field, as the person who pressed it; Dismiss is remembered. A person's action over a cookie route
// (./routes.ts), never an agent's — nothing reachable from src/mcp.ts imports this.
//
// Accepting is a per-KIND handler from `AI_ACCEPT_HANDLERS` (./accept.ts; Phase C registers the card kinds' —
// ./jobs/accept.ts; a kind with none, like `review.risk` (information only), answers `not_available`). A handler
// declares who may accept its kind (`role`: a ticket's category may be any member's call, a theme an admin's);
// dismissing is open to every member unless the handler says an admin (`dismissRole`: a theme's Remove), and may
// also act on the real item (`dismissed`).
import type { AiSuggestion, AiSuggestionError } from "@shared/ai";
import { hasRole, type TenantContext } from "../data/context";
import { decideSuggestion, getSuggestion, reopenSuggestion, suggestionDto, type AiSuggestionRow } from "../data/ai";
import { nowIso } from "../data/sql";
import { AcceptRefused, type AcceptHandler, type AcceptRequest } from "./accept";
import { THEME_ACCEPT_HANDLERS } from "./themes-accept";
import { CARD_ACCEPT_HANDLERS } from "./jobs/accept";

export { AcceptRefused, type AcceptHandler, type AcceptRequest } from "./accept";

/** THE registry, by `ai_suggestions.kind`: one line per producer's handlers. */
export const AI_ACCEPT_HANDLERS: Readonly<Record<string, AcceptHandler>> = {
  ...CARD_ACCEPT_HANDLERS, // Phase C: ticket.category / ticket.priority / ticket.duplicate / unplaced.destination (./jobs/accept.ts)
  ...THEME_ACCEPT_HANDLERS,
};

export type SuggestionAnswer =
  | { ok: true; suggestion: AiSuggestion }
  | { ok: false; status: 400 | 403 | 404 | 409; error: AiSuggestionError };

const STATUS: Record<AiSuggestionError, 400 | 403 | 404 | 409> = { not_found: 404, not_open: 409, not_available: 409, forbidden: 403, invalid: 400 };
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
  req: AcceptRequest = { origin: null },
): Promise<SuggestionAnswer> {
  const row = await getSuggestion(ctx, id);
  if (!row) return refuse("not_found");
  if (row.state !== "open") return refuse("not_open");
  const handler = Object.hasOwn(handlers, row.kind) ? handlers[row.kind] : undefined;
  if (!handler) return refuse("not_available");
  if (handler.role === "admin" && !hasRole(ctx, "admin")) return refuse("forbidden");
  if (!body) return { ok: false, status: 400, error: "invalid" };
  let value: unknown = body.value;
  if (value === undefined) {
    try { value = JSON.parse(row.value_json); } catch { value = null; }
  }
  if (handler.valid && !handler.valid(value)) return refuse("invalid");
  const at = nowIso();
  if (!(await decideSuggestion(ctx, id, "accepted", ctx.userId, at))) return refuse("not_open");
  try {
    await handler.apply(ctx, row, value, req);
  } catch (e) {
    await reopenSuggestion(ctx, id, ctx.userId, at);
    if (e instanceof AcceptRefused) return refuse(e.code);
    throw e;
  }
  return { ok: true, suggestion: suggestionDto({ ...row, state: "accepted", decided_by: ctx.userId, decided_at: at }) };
}

/** Dismiss suggestion `id` as `ctx`'s person — any member, unless the kind's handler says an admin
 *  (`dismissRole`); the decision is remembered (a re-run of the kind supersedes only an OPEN suggestion). */
export async function dismissSuggestion(
  ctx: TenantContext, id: number, handlers: Readonly<Record<string, AcceptHandler>> = AI_ACCEPT_HANDLERS,
): Promise<SuggestionAnswer> {
  const row = await getSuggestion(ctx, id);
  if (!row) return refuse("not_found");
  if (row.state !== "open") return refuse("not_open");
  const handler = Object.hasOwn(handlers, row.kind) ? handlers[row.kind] : undefined;
  if (handler?.dismissRole === "admin" && !hasRole(ctx, "admin")) return refuse("forbidden");
  const at = nowIso();
  if (!(await decideSuggestion(ctx, id, "dismissed", ctx.userId, at))) return refuse("not_open");
  if (handler?.dismissed) {
    await handler.dismissed(ctx, row).catch((e: unknown) => console.error("ai suggestion: dismiss hook failed", row.kind, e instanceof Error ? e.name : "error", `org=${ctx.orgId}`));
  }
  return { ok: true, suggestion: suggestionDto({ ...row, state: "dismissed", decided_by: ctx.userId, decided_at: at }) };
}
