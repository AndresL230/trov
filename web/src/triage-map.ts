// The triage mapping layer: turns backend read shapes (api.ts) into the props
// the presentational Review/Maintenance components already expect. This is the
// reshape deferred during componentization — it lives HERE, in one place per
// surface, never inside components. Pure functions, no fetching, no state.

import type { StagedProposal, AdrRow, NeedsTriageRow, IdentityTask, DiscardedIdentity, PersonSummary } from "./api";
import type { ReviewItem } from "./review";
import type { AssignOptions, UnplacedItem, UnplacedKind, Person } from "./maintenance";
import type { IdentityGroup, DiscardedLogin } from "./identity";
import { collapsedLineDiff } from "./diff";
import { initialsOf, relTime } from "./ui";
import { initialsOfName } from "./people";
import { SECTIONS } from "@shared/vocabulary";
export { attachAskFlags } from "./api";

// ── shared derivations ───────────────────────────────────────────────────────
/** First non-empty line of a body — the card-summary fallback. */
function excerpt(body: string): string {
  return body.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** First sentence of a text (up to . ! or ?), for the ADR card summary. */
function firstSentence(text: string): string {
  const m = text.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : text).trim();
}

// ── Review · Proposals ───────────────────────────────────────────────────────
/** Client-side diff of the two raw bodies the read carries (backend sends no diff). */
export function diffEntries(promotedBody: string, stagedBody: string): { t: "ctx" | "add" | "del" | "ellipsis"; s: string }[] {
  return collapsedLineDiff(promotedBody, stagedBody).map((r) => ({ t: r.t, s: r.text }));
}

/** The fields a one-line listing of a review item needs (My Work's tile, the Feed's
 *  "Waiting on review") — no diff, no summary, so it is cheap enough to build on every
 *  paint. The full ReviewItem below spreads it, so the two can never disagree on id,
 *  badge or who staged it (`agent`). */
export type ReviewHead = Pick<ReviewItem, "id" | "kind" | "title" | "time" | "agent">;

function proposalHead(p: StagedProposal): ReviewHead {
  return { id: `doc:${p.slug}@${p.version}`, kind: "proposal", title: p.title, time: relTime(p.created_at), agent: p.author };
}
function adrHead(a: AdrRow): ReviewHead {
  return { id: `adr:${a.id}`, kind: "decision", title: a.title, time: relTime(a.created_at), agent: a.created_by };
}

export function proposalReviewItem(p: StagedProposal): ReviewItem {
  const stale = p.base_version !== null && p.base_version < p.current_version;
  return {
    ...proposalHead(p),
    eyebrow: `PROPOSAL · ${p.space.toUpperCase()} / ${p.section.toUpperCase()}`,
    summary: p.summary ?? excerpt(p.stagedBody),
    agent: p.author,
    agentInitials: initialsOf(p.author),
    time: relTime(p.created_at),
    flagged: p.low_confidence === 1,
    stale,
    staleNote: stale
      ? `Proposed from v${p.base_version} — the live doc is now v${p.current_version}. Review against current content before promoting.`
      : undefined,
    liveVersion: `LIVE (v${p.current_version})`,
    diff: diffEntries(p.promotedBody, p.stagedBody),
    // Rendered renders the two bodies whole (review-rendered.ts); a doc with nothing live is new.
    liveBody: p.promotedBody,
    proposedBody: p.stagedBody,
    isNew: p.current_version === 0 || p.promotedBody.trim() === "",
    ...(p.ai ? { ai: p.ai } : {}),
    ...(p.askFlags?.length ? { askFlags: p.askFlags } : {}),
    // Its place in its space's tree, and — for a page of a Markdown import — the run (Review groups by it).
    slug: p.slug, space: p.space, parentSlug: p.parent_slug ?? null, at: p.created_at, path: p.path ?? [],
    ...(p.import_id != null ? { importId: p.import_id, importPath: p.import_path ?? null, importFile: p.import_file_name ?? null, importBy: p.import_by ?? null, importAt: p.import_at ?? null } : {}),
  };
}

// ── Review · Decisions ───────────────────────────────────────────────────────
export function adrReviewItem(a: AdrRow): ReviewItem {
  const sections = [
    { h: "Context", p: a.context },
    { h: "Decision", p: a.decision },
    { h: "Rationale", p: a.rationale },
  ].filter((s): s is { h: string; p: string } => s.p !== null && s.p.trim() !== "");
  return {
    ...adrHead(a),
    eyebrow: `DECISION · ADR-${String(a.id).padStart(3, "0")}`,
    summary: a.decision ? firstSentence(a.decision) : "",
    agent: a.created_by,
    agentInitials: initialsOf(a.created_by),
    time: relTime(a.created_at),
    adr: sections,
    // A decision the agent drafted with low confidence stages like any draft (since 2026-10-18), and wears the same mark.
    flagged: a.confidence === "low",
    ...(a.ai ? { ai: a.ai } : {}),
    ...(a.askFlags?.length ? { askFlags: a.askFlags } : {}),
  };
}

/** Both reads merged, newest first (ISO strings compare lexically). */
function newestFirst<T>(proposals: StagedProposal[], adrs: AdrRow[], p: (x: StagedProposal) => T, a: (x: AdrRow) => T): T[] {
  const merged = [
    ...proposals.map((x) => ({ at: x.created_at, item: p(x) })),
    ...adrs.map((x) => ({ at: x.created_at, item: a(x) })),
  ];
  merged.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  return merged.map((m) => m.item);
}

/** The Review queue: both reads merged, newest first — with each proposal's diff. */
export function reviewItemsFromReads(proposals: StagedProposal[], adrs: AdrRow[]): ReviewItem[] {
  return newestFirst(proposals, adrs, proposalReviewItem, adrReviewItem);
}

/** The same queue in the same order as ReviewHeads — NO diff (My Work's tile). */
export function reviewHeadsFromReads(proposals: StagedProposal[], adrs: AdrRow[]): ReviewHead[] {
  return newestFirst(proposals, adrs, proposalHead, adrHead);
}

// ── synthesized-id codec (write buttons decode back to route params) ─────────
export type ReviewRef = { kind: "doc"; slug: string; version: number } | { kind: "adr"; id: number };

export function decodeReviewId(id: string): ReviewRef | null {
  if (id.startsWith("doc:")) {
    const at = id.lastIndexOf("@");
    if (at < 4) return null;
    const seg = id.slice(at + 1);
    if (!/^\d+$/.test(seg)) return null;
    const version = Number(seg);
    return { kind: "doc", slug: id.slice(4, at), version };
  }
  if (id.startsWith("adr:")) {
    const n = Number(id.slice(4));
    return Number.isInteger(n) && id.length > 4 ? { kind: "adr", id: n } : null;
  }
  return null;
}

// ── Unplaced · assign vocabulary ──────────────────────────────────────────
/** The real assign options: gate types × @shared/vocabulary targets.
 *  'needs-triage' is the queue itself, never an assignable section. `spaces` and `tags` are empty HERE:
 *  a doc's space is one of the organization's own (0081_docs_library) and a feed entry's tags are its own
 *  list (0056_org_tags), which render.ts fills in from `state.library` and `state.tags`. */
export const ASSIGN_OPTIONS: AssignOptions = {
  kinds: [
    { key: "doc", label: "Doc" },
    { key: "adr", label: "Decision" },
    { key: "feed", label: "Feed entry" },
  ],
  sections: SECTIONS.filter((s) => s !== "needs-triage"),
  spaces: [],
  tags: [],
};

// ── Unplaced · the queue ─────────────────────────────────────────────────────
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Why an item is here, in a few words — a lossy convenience over the gate's (or the agent's) reason, which always
 *  rides verbatim in `reasonNote`. The gate's own reasons (before 2026-10-18) are named; anything else an agent
 *  wrote is "Agent wasn't sure". */
export function unplacedReasonWord(reason: string): string {
  const r = reason.toLowerCase();
  if (r.startsWith("low confidence")) return "Low confidence";
  if (/out-of-vocab section|unknown section/.test(r)) return "Unknown section";
  if (/unknown space|archived space|no space given/.test(r)) return "No such space";
  if (r.startsWith("archived page")) return "Archived page";
  if (/out-of-vocab tag|unknown tag/.test(r)) return "Unknown tag";
  return "Agent wasn't sure";
}

/** Derive the card fields from the stored gate payload: JSON of the gated item
 *  (DocProposal / AdrDraft / FeedEntry) OR a free-form string an agent sent as a batch's own triage item (a
 *  note: it cannot be placed). The verbatim reason always rides in reasonNote. */
export function unplacedFromRow(r: NeedsTriageRow): UnplacedItem {
  let parsed: Record<string, unknown> | null = null;
  try {
    const p: unknown = JSON.parse(r.raw);
    if (p !== null && typeof p === "object" && !Array.isArray(p)) parsed = p as Record<string, unknown>;
  } catch { /* free-form string raw — stays null */ }
  const str = (k: string): string | null => {
    const v = parsed?.[k];
    return typeof v === "string" && v.trim() !== "" ? v : null;
  };
  const title = parsed
    ? str("title") ?? str("summary") ?? str("slug") ?? "Untitled item"
    : clip(r.raw, 80);
  const snippet = parsed
    ? str("body") ?? str("summary") ?? str("decision") ?? str("change_summary") ?? r.raw
    : r.raw;
  // What it is, by the shape the gate stored: a doc proposal has a slug and a body, a decision its decision (or its
  // context and rationale), a feed entry its summary; anything else is a note.
  const kind: UnplacedKind = !parsed ? "note"
    : str("slug") !== null && typeof parsed.body === "string" ? "doc"
    : str("decision") !== null || (str("context") !== null && str("rationale") !== null) ? "decision"
    : str("summary") !== null ? "feed" : "note";
  const adr = kind === "decision"
    ? [{ h: "Context", p: str("context") }, { h: "Decision", p: str("decision") }, { h: "Rationale", p: str("rationale") }]
        .filter((s): s is { h: string; p: string } => s.p !== null)
    : undefined;
  const tags = Array.isArray(parsed?.tags) ? (parsed!.tags as unknown[]).filter((t): t is string => typeof t === "string") : [];
  return {
    id: String(r.id),
    title,
    snippet: clip(snippet, 280),
    reason: unplacedReasonWord(r.reason),
    meta: `${r.source_author ?? "unknown"} · ${relTime(r.created_at)}`,
    reasonNote: r.reason,
    author: r.source_author ?? null,
    when: relTime(r.created_at),
    kind,
    lowConfidence: parsed?.confidence === "low" || r.reason.toLowerCase().startsWith("low confidence"),
    body: kind === "note" ? r.raw : kind === "doc" ? (str("body") ?? "") : (str("body") ?? str("summary") ?? ""),
    ...(adr ? { adr } : {}),
    section: str("section"),
    space: str("space"),
    tags,
    ...(r.ai ? { ai: r.ai } : {}),
  };
}

// ── Org settings › Members · Unmatched logins ───────────────────────────────────────────────────
/** Real sample kinds are only pr_merged / pr_closed / issue — commits are never
 *  captured events. The read returns samples, not a total, so the accent line
 *  says "recent activity" instead of fabricating a count. */
export function identityFromTask(t: IdentityTask): IdentityGroup {
  return {
    id: t.login,
    login: t.login,
    meta: `first seen ${relTime(t.first_seen)}`,
    countLabel: "recent activity",
    sample: t.sample.map((s) => ({
      kind: s.event_type === "issue" ? "Issue" : "PR",
      text: `#${s.ref_number} ${s.title ?? "(no title)"}`,
      when: relTime(s.occurred_at),
    })),
  };
}

/** A discarded login's row in the restore list: when it was discarded, and by whom. */
export function discardedFromRow(d: DiscardedIdentity): DiscardedLogin {
  const when = d.resolved_at ? ` ${relTime(d.resolved_at)}` : "";
  return { login: d.login, meta: `discarded${when}${d.resolved_by ? ` by ${d.resolved_by}` : ""}` };
}

/** The person picker's source: the persons directory. The picked value is the handle.
 *  Mapping is an identity link, not just an attribution label: it also lets that
 *  GitHub account sign in as the picked person (personPicker's helper text below
 *  the button says so). */
export function peopleFromPersons(persons: PersonSummary[]): Person[] {
  return persons.map((p) => ({ id: p.handle, name: p.name ?? p.handle, initials: initialsOfName(p.name, p.handle), color: p.color, avatar_url: p.avatar_url }));
}
