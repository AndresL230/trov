// Answering a suggestion (docs/architecture/ai.md › Suggestions): Accept writes the suggested value to the
// REAL field, as the person who pressed it; Dismiss is remembered. A person's action over a cookie route
// (./routes.ts), never an agent's — nothing reachable from src/mcp.ts imports this.
//
// Accepting is a per-KIND handler from `AI_ACCEPT_HANDLERS` (./accept.ts; Phase C registers the card kinds' —
// ./jobs/accept.ts; a kind with none, like `review.risk` (information only), answers `not_available`). A handler
// declares who may accept its kind (`role`: a ticket's category may be any member's call, a theme an admin's);
// dismissing is whoever can set the field — `dismissRole`, else that same `role` (Q22) — and may also act on the real
// item (`dismissed`).
import { aiItemRef, type AiSuggestion, type AiSuggestionError } from "@shared/ai";
import { hasRole, type TenantContext } from "../data/context";
import { decideSuggestion, getSuggestion, recordFeedback, reopenSuggestion, suggestionDto, type AiSuggestionRow } from "../data/ai";
import { nowIso } from "../data/sql";
import { aiShown } from "../plans/gate";
import { AcceptRefused, type AcceptHandler, type AcceptRequest } from "./accept";
import { THEME_ACCEPT_HANDLERS } from "./themes-accept";
import { CARD_ACCEPT_HANDLERS } from "./jobs/accept";
import { PLAN_NARRATIVE_ACCEPT, SPRINT_DRAFT_ACCEPT } from "./roadmap-accept";

export { AcceptRefused, type AcceptHandler, type AcceptRequest } from "./accept";

/** THE registry, by `ai_suggestions.kind`: one line per producer's handlers. */
export const AI_ACCEPT_HANDLERS: Readonly<Record<string, AcceptHandler>> = {
  ...CARD_ACCEPT_HANDLERS, // Phase C: ticket.category / ticket.priority / ticket.duplicate / unplaced.destination (./jobs/accept.ts)
  ...THEME_ACCEPT_HANDLERS,
  sprint_draft: SPRINT_DRAFT_ACCEPT, // Phase D: an admin creates the drafted sprints (./roadmap-accept.ts)
  plan_narrative: PLAN_NARRATIVE_ACCEPT, // Phase D: an admin writes the proposed narrative (./roadmap-accept.ts)
};

export type SuggestionAnswer =
  | { ok: true; suggestion: AiSuggestion }
  | { ok: false; status: 400 | 403 | 404 | 409; error: AiSuggestionError };

const STATUS: Record<AiSuggestionError, 400 | 403 | 404 | 409> = { not_found: 404, off: 403, not_open: 409, not_available: 409, forbidden: 403, invalid: 400 };
const refuse = (error: AiSuggestionError): SuggestionAnswer => ({ ok: false, status: STATUS[error], error });

/**
 * Accept suggestion `id` (its global row id) as `ctx`'s person. In this order: an id that is not this org's
 * is `not_found` (before anything else is said about it, a bad body included); THE read rule's off (the org's switch
 * off, or no Anthropic key — src/plans/gate.ts `aiShown`) `off`: a suggestion nobody is shown is decided by nobody;
 * a decided one `not_open`; a
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
  if (!(await aiShown(ctx)).shown) return refuse("off");
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

/** Dismiss suggestion `id` as `ctx`'s person — WHOEVER CAN SET THE FIELD (owner ruling Q22): the kind's `dismissRole`,
 *  else the role that may accept it (a Roadmap suggestion is an admin's either way); a kind with no handler
 *  (`review.risk`: the proposal's own promote / reject are every member's) any member. The decision is remembered (a
 *  re-run of the kind supersedes only an OPEN suggestion), and it is also recorded as this person's `ai_feedback`
 *  (item type `suggestion`, its id) for the evals. THE read rule's off refuses it (`off`), as it refuses Accept. */
export async function dismissSuggestion(
  ctx: TenantContext, id: number, handlers: Readonly<Record<string, AcceptHandler>> = AI_ACCEPT_HANDLERS,
): Promise<SuggestionAnswer> {
  const row = await getSuggestion(ctx, id);
  if (!row) return refuse("not_found");
  if (!(await aiShown(ctx)).shown) return refuse("off");
  if (row.state !== "open") return refuse("not_open");
  const handler = Object.hasOwn(handlers, row.kind) ? handlers[row.kind] : undefined;
  if ((handler?.dismissRole ?? handler?.role ?? "member") === "admin" && !hasRole(ctx, "admin")) return refuse("forbidden");
  const at = nowIso();
  if (!(await decideSuggestion(ctx, id, "dismissed", ctx.userId, at))) return refuse("not_open");
  // Dismiss is also a "this is wrong" for the evals (Q22): never fails the dismissal.
  await recordFeedback(ctx, ctx.userId, { itemType: "suggestion", itemRef: aiItemRef.suggestion(id), kind: row.kind, model: row.model, promptVersion: row.prompt_version }, at)
    .catch((e: unknown) => console.error("ai suggestion: dismiss feedback failed", e instanceof Error ? e.name : "error", `org=${ctx.orgId}`));
  if (handler?.dismissed) {
    await handler.dismissed(ctx, row).catch((e: unknown) => console.error("ai suggestion: dismiss hook failed", row.kind, e instanceof Error ? e.name : "error", `org=${ctx.orgId}`));
  }
  return { ok: true, suggestion: suggestionDto({ ...row, state: "dismissed", decided_by: ctx.userId, decided_at: at }) };
}
