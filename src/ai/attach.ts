// What the three Phase C screens read of Trov's suggestions (docs/architecture/ai.md › The kinds): the cookie reads
// behind the ticket detail (`GET /tickets/:id`), Unplaced (`GET /needs-triage`) and Review (`GET /proposals`,
// `GET /adrs`) carry each item's OPEN suggestions as `ai` — and NOTHING when there is none, so the screen renders
// exactly what it did before (test/render.ai-cards.test.ts). Stored rows only: nothing here calls a model, and MCP's
// `get_ticket` never gets the field (it is added by these routes, not by the reader).
//
// The org's switch off → no field (`openSuggestions` joins the switch). A failed read → the rows as they were: a
// suggestion is never worth failing a screen for. Under `wrangler dev` with `LOCAL_AI_PREVIEW` the sample suggestions
// (shared/ai-fixtures.ts) go on the real rows instead, while the switch is on.
import type { Context } from "hono";
import type { AppEnv } from "../auth/principal";
import type { AiSuggestion } from "@shared/ai";
import type { AdrRow, NeedsTriageRow } from "@shared/rows";
import type { TicketDetail } from "@shared/tickets";
import { reviewRiskFixture, ticketSuggestionsFixture, unplacedSuggestionFixture } from "@shared/ai-fixtures";
import { aiSwitchOn, openSuggestions } from "../data/ai-cards";
import { aiPreviewMode } from "./preview";
import { CARD_ITEM_TYPES, TICKET_KINDS, unplacedDoc } from "./jobs/cards";
import { ticketByNumber } from "../tools/tickets";
import type { ProposalRow } from "../tools/reads";

type C = Context<AppEnv>;

async function guarded<T>(what: string, c: C, rows: T, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    console.error("ai suggestions read", what, e instanceof Error ? e.name : "error", `org=${c.var.ctx.orgId}`);
    return rows;
  }
}

/** `TicketDetail` with its open ticket suggestions (category, priority, a possible duplicate) as `ai`. */
export function withTicketSuggestions(c: C, t: TicketDetail): Promise<TicketDetail> {
  return guarded("ticket", c, t, async () => {
    // A closed ticket carries none (Q35): closing supersedes them, and one left open from before is not drawn either.
    if (t.status === "done" || t.status === "declined") return t;
    const preview = aiPreviewMode(c.env, c.req.url);
    let ai: AiSuggestion[];
    if (preview) {
      if (!(await aiSwitchOn(c.var.ctx))) return t;
      const other = t.id > 1 ? await ticketByNumber(c.var.ctx, t.id - 1) : null;
      ai = ticketSuggestionsFixture(preview, t.id, other ? { number: other.number, title: other.title } : null);
    } else {
      ai = await openSuggestions(c.var.ctx, CARD_ITEM_TYPES.ticket, [String(t.id)], TICKET_KINDS);
    }
    return ai.length ? { ...t, ai } : t;
  });
}

/** Unplaced's rows, each with its open destination as `ai` (only the rows that have one). */
export function withUnplacedSuggestions(c: C, rows: NeedsTriageRow[]): Promise<NeedsTriageRow[]> {
  return guarded("unplaced", c, rows, async () => {
    if (!rows.length) return rows;
    const preview = aiPreviewMode(c.env, c.req.url);
    if (preview) {
      if (!(await aiSwitchOn(c.var.ctx))) return rows;
      const first = rows.find((r) => unplacedDoc(r.raw));
      const s = first ? unplacedSuggestionFixture(preview, first.id) : null;
      return s && first ? rows.map((r) => (r.id === first.id ? { ...r, ai: [s] } : r)) : rows;
    }
    const all = await openSuggestions(c.var.ctx, CARD_ITEM_TYPES.unplaced, rows.map((r) => String(r.id)), ["unplaced.destination"]);
    return attach(rows, (r) => String(r.id), all);
  });
}

/** Review's proposals and drafted decisions, each with its open risk as `ai`. Review's own ids: `doc:<slug>@<v>`,
 *  `adr:<id>` (web/src/triage-map.ts). */
export function withReviewSuggestions<P extends ProposalRow, A extends AdrRow>(c: C, proposals: P[], adrs: A[]): Promise<{ proposals: P[]; adrs: A[] }> {
  const pRef = (p: P) => `doc:${p.slug}@${p.version}`;
  const aRef = (a: A) => `adr:${a.id}`;
  return guarded("review", c, { proposals, adrs }, async () => {
    if (!proposals.length && !adrs.length) return { proposals, adrs };
    const preview = aiPreviewMode(c.env, c.req.url);
    let all: AiSuggestion[];
    if (preview) {
      if (!(await aiSwitchOn(c.var.ctx))) return { proposals, adrs };
      // Each list its own samples, with their own ids (Q38): /proposals and /adrs are read apart.
      all = [
        ...proposals.map((p, i) => reviewRiskFixture(preview, pRef(p), i, "proposals")),
        ...adrs.filter((a) => a.status === "draft").map((a, i) => reviewRiskFixture(preview, aRef(a), i, "adrs")),
      ].filter((s): s is AiSuggestion => s !== null);
    } else {
      all = await openSuggestions(c.var.ctx, CARD_ITEM_TYPES.proposal, [...proposals.map(pRef), ...adrs.map(aRef)], ["review.risk"]);
    }
    return { proposals: attach(proposals, pRef, all), adrs: attach(adrs, aRef, all) };
  });
}

function attach<T>(rows: T[], refOf: (r: T) => string, all: AiSuggestion[]): T[] {
  if (!all.length) return rows;
  const by = new Map<string, AiSuggestion[]>();
  for (const s of all) by.set(s.itemRef, [...(by.get(s.itemRef) ?? []), s]);
  return rows.map((r) => { const ai = by.get(refOf(r)); return ai ? { ...r, ai } : r; });
}
