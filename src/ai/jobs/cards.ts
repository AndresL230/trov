// The Phase C Jev CARD JOBS (docs/architecture/ai.md › The kinds), registered in `AI_JOBS` (../pass.ts). Each reads
// its item from D1 (src/data/ai-cards.ts), asks ONE Jev request per item (the pass enforces it), and writes what the
// answer becomes as `ai_suggestions` rows (`putSuggestion`: an older OPEN suggestion of the same kind for the same
// item is superseded; a decided one is left alone). Nothing here changes a ticket, a proposal or an Unplaced item:
// every result is a suggestion a PERSON accepts (./accept.ts) or dismisses.
//
//   • `ticket.card` — `card:ticket:<n>`: category, priority and a possible duplicate, in one request (./ticket-card.ts)
//   • `review.risk` — `card:proposal:doc:<slug>:<version>` / `card:proposal:adr:<id>` (./review-card.ts)
//   • `unplaced.destination` — `card:unplaced:<id>` (./unplaced-card.ts)
//
// `input` returns null — the scope is written with NO call — when there is nothing to ask: the item is gone or
// already decided, every field is a person's, the ticket is closed, an Unplaced item is not a doc.
import { isOpenStatus, type TicketCategory, type TicketPriority, type TicketStatus } from "@shared/tickets-core";
import type { TenantContext } from "../../data/sql";
import { putSuggestion } from "../../data/ai";
import {
  adrCardRow, decidedKinds, docCandidates, proposalCardRow, ratifiedAdrCandidates, ticketCandidates, ticketCardRow, ticketLinkUrls, triageCardRow,
} from "../../data/ai-cards";
import type { JevAnswers, JevJob } from "../jobs";
import { anyWordsMatch } from "./text";
import { DUPLICATE_CANDIDATES, TICKET_PROMPT_VERSION, ticketDecide, ticketRequest, type TicketCardInput } from "./ticket-card";
import { REVIEW_PROMPT_VERSION, linesNotIn, reviewDecide, reviewRequest, type ReviewCardInput } from "./review-card";
import { UNPLACED_DOC_CANDIDATES, UNPLACED_PROMPT_VERSION, unplacedDecide, unplacedRequest, type UnplacedCardInput } from "./unplaced-card";

/** What `ai_suggestions.item_type` each card writes under — and what the screens read back. */
export const CARD_ITEM_TYPES = { ticket: "ticket", proposal: "proposal", unplaced: "unplaced" } as const;
export const TICKET_KINDS = ["ticket.category", "ticket.priority", "ticket.duplicate"] as const;

const intKey = (key: string, prefix: string): number | null => {
  const raw = key.slice(prefix.length);
  return /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
};

/** The GitHub issue URL a mirrored ticket's `source_ref` (`owner/repo#n`) names. */
export const sourceIssueUrl = (ref: string | null): string | null => {
  const m = ref?.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
};

/** Does a ticket already link candidate `n` (its in-app address, or the GitHub issue it mirrors)? */
export const linksTicket = (urls: readonly string[], n: number, sourceRef: string | null): boolean => {
  const issue = sourceIssueUrl(sourceRef);
  return urls.some((u) => new RegExp(`#tickets/${n}$`).test(u) || (issue !== null && u.replace(/\/+$/, "") === issue));
};

// ── the ticket card ──────────────────────────────────────────────────────────

export const ticketCardJob: JevJob<TicketCardInput> = {
  name: "ticket.card",
  provider: "jev",
  // The request's first question; one request carries all three ticket kinds (one Jev call per ticket card).
  kind: "ticket.category",
  scope: "card",
  keyPrefix: "ticket:",
  promptVersion: TICKET_PROMPT_VERSION,
  async input(ctx, scope) {
    const number = intKey(scope.key, "ticket:");
    if (number === null) return null;
    const t = await ticketCardRow(ctx, number);
    if (!t || !isOpenStatus(t.status as TicketStatus)) return null;
    const decided = await decidedKinds(ctx, CARD_ITEM_TYPES.ticket, String(number));
    let candidates: TicketCardInput["candidates"] = [];
    const match = decided.has("ticket.duplicate") ? null : anyWordsMatch(t.title);
    if (match) {
      const links = await ticketLinkUrls(ctx, t.id);
      // A few more than offered, so a candidate it already links does not cost a place in the top five.
      const hits = await ticketCandidates(ctx, match, t.id, DUPLICATE_CANDIDATES + 3);
      candidates = hits.filter((h) => !linksTicket(links, h.number, h.source_ref)).slice(0, DUPLICATE_CANDIDATES)
        .map((h) => ({ number: h.number, title: h.title, body: h.body, snippet: h.snippet }));
    }
    const input: TicketCardInput = {
      number, title: t.title, body: t.body, category: t.category as TicketCategory, priority: t.priority as TicketPriority,
      // Person over AI: only the value nobody picked is asked about.
      askCategory: t.category === "other" && !decided.has("ticket.category"),
      askPriority: t.priority === "normal" && !decided.has("ticket.priority"),
      candidates,
    };
    return ticketRequest(input) ? input : null;
  },
  ask(item) {
    const req = ticketRequest(item.input);
    if (!req) throw new Error("nothing to ask");
    return req;
  },
  async write(ctx, item, answer) {
    const d = ticketDecide(item.input, answer.answers);
    if (d.unanswered) return false;
    for (const s of d.suggestions) await put(ctx, CARD_ITEM_TYPES.ticket, String(item.input.number), s, answer, TICKET_PROMPT_VERSION);
    return true;
  },
};

// ── the Review card ──────────────────────────────────────────────────────────

/** `proposal:doc:<slug>:<version>` / `proposal:adr:<id>` → what it names. */
export function proposalKey(key: string): { type: "doc"; slug: string; version: number } | { type: "adr"; id: number } | null {
  const rest = key.slice("proposal:".length);
  if (rest.startsWith("adr:")) { const id = intKey(rest, "adr:"); return id === null ? null : { type: "adr", id }; }
  if (!rest.startsWith("doc:")) return null;
  const at = rest.lastIndexOf(":");
  const slug = rest.slice(4, at);
  const version = Number(rest.slice(at + 1));
  return at > 4 && slug && Number.isInteger(version) && version > 0 ? { type: "doc", slug, version } : null;
}

export const reviewRiskJob: JevJob<ReviewCardInput> = {
  name: "review.risk",
  provider: "jev",
  kind: "review.risk",
  scope: "card",
  keyPrefix: "proposal:",
  promptVersion: REVIEW_PROMPT_VERSION,
  async input(ctx, scope) {
    const k = proposalKey(scope.key);
    if (!k) return null;
    const ref = k.type === "doc" ? `doc:${k.slug}@${k.version}` : `adr:${k.id}`;
    if ((await decidedKinds(ctx, CARD_ITEM_TYPES.proposal, ref)).has("review.risk")) return null;
    if (k.type === "doc") {
      const p = await proposalCardRow(ctx, k.slug, k.version);
      if (!p) return null;
      const removed = linesNotIn(p.staged_body, p.live_body);
      const added = linesNotIn(p.live_body, p.staged_body);
      const match = anyWordsMatch(`${p.title} ${p.summary ?? ""} ${added.join(" ")}`);
      const [docs, decisions] = match ? await Promise.all([docCandidates(ctx, match, p.slug, 2), ratifiedAdrCandidates(ctx, match, null, 2)]) : [[], []];
      return {
        type: "doc", ref, title: p.title, section: p.section, changeKind: p.change_kind, summary: p.summary, removed, added,
        docs: docs.map((d) => ({ slug: d.slug, title: d.title, snippet: d.snippet })),
        decisions: decisions.map((d) => ({ id: d.id, title: d.title, snippet: d.snippet })),
      };
    }
    const a = await adrCardRow(ctx, k.id);
    if (!a) return null;
    const match = anyWordsMatch(`${a.title} ${a.decision ?? ""}`);
    const [docs, decisions] = match ? await Promise.all([docCandidates(ctx, match, null, 2), ratifiedAdrCandidates(ctx, match, a.id, 2)]) : [[], []];
    return {
      type: "adr", ref, title: a.title, context: a.context ?? "", decision: a.decision ?? "", rationale: a.rationale ?? "",
      docs: docs.map((d) => ({ slug: d.slug, title: d.title, snippet: d.snippet })),
      decisions: decisions.map((d) => ({ id: d.id, title: d.title, snippet: d.snippet })),
    };
  },
  ask: (item) => reviewRequest(item.input),
  async write(ctx, item, answer) {
    const d = reviewDecide(item.input, answer.answers);
    if (d.unanswered) return false;
    if (d.suggestion) await put(ctx, CARD_ITEM_TYPES.proposal, item.input.ref, d.suggestion, answer, REVIEW_PROMPT_VERSION);
    return true;
  },
};

// ── the Unplaced card ────────────────────────────────────────────────────────

/** An Unplaced item's raw, when it is a doc an agent proposed (a slug and a body); anything else is not asked about. */
export function unplacedDoc(raw: string): { slug: string; title: string; body: string; section: string | null } | null {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.slug !== "string" || typeof r.body !== "string" || !r.body.trim()) return null;
  const title = typeof r.title === "string" && r.title.trim() ? r.title : r.slug;
  return { slug: r.slug, title, body: r.body, section: typeof r.section === "string" && r.section.trim() ? r.section.trim() : null };
}

export const unplacedDestinationJob: JevJob<UnplacedCardInput> = {
  name: "unplaced.destination",
  provider: "jev",
  kind: "unplaced.destination",
  scope: "card",
  keyPrefix: "unplaced:",
  promptVersion: UNPLACED_PROMPT_VERSION,
  async input(ctx, scope) {
    const id = intKey(scope.key, "unplaced:");
    if (id === null) return null;
    if ((await decidedKinds(ctx, CARD_ITEM_TYPES.unplaced, String(id))).has("unplaced.destination")) return null;
    const row = await triageCardRow(ctx, id);
    const doc = row ? unplacedDoc(row.raw) : null;
    if (!doc) return null;
    const match = anyWordsMatch(`${doc.title} ${doc.body}`, 10);
    const docs = match ? await docCandidates(ctx, match, doc.slug, UNPLACED_DOC_CANDIDATES + 2) : [];
    return { id, title: doc.title, body: doc.body, filedUnder: doc.section, docs };
  },
  ask: (item) => unplacedRequest(item.input),
  async write(ctx, item, answer) {
    const d = unplacedDecide(item.input, answer.answers);
    if (d.unanswered) return false;
    if (d.suggestion) await put(ctx, CARD_ITEM_TYPES.unplaced, String(item.input.id), d.suggestion, answer, UNPLACED_PROMPT_VERSION);
    return true;
  },
};

async function put(
  ctx: TenantContext, itemType: string, itemRef: string,
  s: { kind: string; value: unknown; confidence: number; reason: string; cites: { ref: string; label: string; href: string | null }[] },
  answer: JevAnswers, promptVersion: string,
): Promise<void> {
  await putSuggestion(ctx, { itemType, itemRef, kind: s.kind, value: s.value, confidence: s.confidence, reason: s.reason, cites: s.cites, model: answer.model, promptVersion });
}

/** The card jobs, in the order the pass runs them. */
export const CARD_JOBS = [ticketCardJob, reviewRiskJob, unplacedDestinationJob] as const;
