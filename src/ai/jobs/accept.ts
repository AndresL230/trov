// Accepting the Phase C card suggestions (docs/architecture/ai.md › Suggestions): each handler writes the REAL field
// through the EXISTING writer, as the person who pressed Accept (`ctx` is the cookie person's own context — the
// author is always the authenticated principal). Registered in `AI_ACCEPT_HANDLERS` (../suggestions.ts).
//
//   • `ticket.category` / `ticket.priority` → `set_ticket_classification` (src/tools/tickets.ts)
//   • `ticket.duplicate`                    → `add_ticket_link` — a LINK to the other ticket, nothing else: no ticket is
//                                              closed, declined or merged (a person decides that, Invariant 5)
//   • `unplaced.destination`               → `assign_triage` (src/tools/writes.ts), exactly as Unplaced's "File it":
//                                              the item re-runs through the SAME gate as a doc in that section
// `review.risk` has NO handler: a risk is information on the Review card (Dismiss only) — nothing about it promotes,
// rejects or ratifies anything. Every handler is open to any member, as the writers behind them are on the web.
//
// A refusal is never a 500 (Q36): a value the kind does not take is `invalid` BEFORE the claim (`valid`), and a
// writer's refusal after it — the ticket or triage item gone, a link with no address — is answered with its code
// (`refusing`: TicketError and the triage writer's refusals → `AcceptRefused`). Anything else (a D1 failure) propagates.
import { TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketCategory, type TicketPriority } from "@shared/tickets-core";
import { AcceptRefused, type AcceptHandler } from "../accept";
import type { AiSuggestionError } from "@shared/ai";
import { add_ticket_link, set_ticket_classification, ticketByNumber, TicketError } from "../../tools/tickets";
import { assign_triage } from "../../tools/writes";
import { orgAppBase } from "../../tools/org-links";
import { ticketLinkUrls } from "../../data/ai-cards";
import { linksTicket, sourceIssueUrl } from "./cards";
import { PLACEABLE_SECTIONS } from "./unplaced-card";

const ticketNumber = (ref: string): number => {
  const n = Number(ref);
  if (!Number.isInteger(n) || n <= 0) throw new TicketError("not_found", `no such ticket: ${ref}`);
  return n;
};

/** The ticket a card is about, still OPEN: gone is `not_found`, done / declined a `conflict` — both `not_available`
 *  (Q35: closing a ticket supersedes its suggestions; one left open from before is refused here). */
async function openTicket(ctx: Parameters<AcceptHandler["apply"]>[0], number: number) {
  const t = await ticketByNumber(ctx, number);
  if (!t) throw new TicketError("not_found", `no such ticket: ${number}`);
  if (t.status === "done" || t.status === "declined") throw new TicketError("conflict", `ticket ${number} is closed`);
  return t;
}

const ticketCategory: AcceptHandler = {
  role: "member",
  async apply(ctx, s, value) {
    if (typeof value !== "string" || !(TICKET_CATEGORIES as readonly string[]).includes(value)) throw new TicketError("bad_request", "not a category");
    const number = (await openTicket(ctx, ticketNumber(s.item_ref))).number;
    await set_ticket_classification(ctx, number, { category: value as TicketCategory }, ctx.userId);
  },
};

const ticketPriority: AcceptHandler = {
  role: "member",
  async apply(ctx, s, value) {
    if (typeof value !== "string" || !(TICKET_PRIORITIES as readonly string[]).includes(value)) throw new TicketError("bad_request", "not a priority");
    const number = (await openTicket(ctx, ticketNumber(s.item_ref))).number;
    await set_ticket_classification(ctx, number, { priority: value as TicketPriority }, ctx.userId);
  },
};

const ticketDuplicate: AcceptHandler = {
  role: "member",
  async apply(ctx, s, value, req) {
    const target = Number((value as { number?: unknown } | null)?.number);
    if (!Number.isInteger(target) || target <= 0) throw new TicketError("bad_request", "not a ticket");
    const number = ticketNumber(s.item_ref);
    const [self, other] = await Promise.all([openTicket(ctx, number), ticketByNumber(ctx, target)]);
    if (!other) throw new TicketError("not_found", `no such ticket: ${target}`);
    // Already linked (by its address or the issue it mirrors): nothing to add.
    if (linksTicket(await ticketLinkUrls(ctx, self.id), target, other.source_ref)) return;
    // A mirrored ticket is linked by its GitHub issue; a native one by its address in this org's app.
    const url = sourceIssueUrl(other.source_ref) ?? (req?.origin ? `${await orgAppBase(ctx, req.origin)}/#tickets/${target}` : null);
    if (!url) throw new TicketError("bad_request", "no address to link the ticket by");
    await add_ticket_link(ctx, number, url, ctx.userId);
  },
};

const unplacedDestination: AcceptHandler = {
  role: "member",
  async apply(ctx, s, value) {
    const section = (value as { section?: unknown } | null)?.section;
    if (typeof section !== "string" || !(PLACEABLE_SECTIONS as readonly string[]).includes(section)) throw new Error("not a section");
    const id = Number(s.item_ref);
    if (!Number.isInteger(id) || id <= 0) throw new Error(`no such triage item: ${s.item_ref}`);
    await assign_triage(ctx, id, ctx.userId, { type: "doc", section });
  },
};

const TICKET_REFUSAL: Record<TicketError["code"], AiSuggestionError> = {
  not_found: "not_available", conflict: "not_available", bad_request: "invalid", forbidden: "forbidden",
};
/** The triage writer's refusals (src/tools/writes.ts `assign_triage`): the item is gone, or cannot be filed. */
const TRIAGE_REFUSAL = /^(no such triage item|cannot assign|not an object)/;

/** `h` with its writers' refusals answered by code (`AcceptRefused`), and `valid` checked before the claim. */
function refusing(h: AcceptHandler, valid: (value: unknown) => boolean): AcceptHandler {
  return {
    ...h,
    valid,
    async apply(ctx, s, value, req) {
      try {
        await h.apply(ctx, s, value, req);
      } catch (e) {
        if (e instanceof AcceptRefused) throw e;
        if (e instanceof TicketError) throw new AcceptRefused(TICKET_REFUSAL[e.code]);
        if (e instanceof Error && TRIAGE_REFUSAL.test(e.message)) throw new AcceptRefused("not_available");
        throw e;
      }
    },
  };
}
const isPositiveInt = (v: unknown): boolean => Number.isInteger(Number(v)) && Number(v) > 0;

/** The Phase C handlers, by `ai_suggestions.kind`. */
export const CARD_ACCEPT_HANDLERS: Readonly<Record<string, AcceptHandler>> = {
  "ticket.category": refusing(ticketCategory, (v) => typeof v === "string" && (TICKET_CATEGORIES as readonly string[]).includes(v)),
  "ticket.priority": refusing(ticketPriority, (v) => typeof v === "string" && (TICKET_PRIORITIES as readonly string[]).includes(v)),
  "ticket.duplicate": refusing(ticketDuplicate, (v) => isPositiveInt((v as { number?: unknown } | null)?.number)),
  "unplaced.destination": refusing(unplacedDestination, (v) => {
    const section = (v as { section?: unknown } | null)?.section;
    return typeof section === "string" && (PLACEABLE_SECTIONS as readonly string[]).includes(section);
  }),
};
