// The triage mapping layer: turns backend read shapes (api.ts) into the props
// the presentational Review/Maintenance components already expect. This is the
// reshape deferred during componentization — it lives HERE, in one place per
// surface, never inside components. Pure functions, no fetching, no state.

import type { StagedProposal, AdrRow, NeedsTriageRow, IdentityTask, PersonSummary } from "./api";
import type { ReviewItem } from "./review";
import type { AssignOptions, UnplacedItem, IdentityGroup, Person } from "./maintenance";
import { collapsedLineDiff } from "./diff";
import { initialsOf, relTime } from "./ui";
import { initialsOfName } from "./people";
import { SECTIONS, TAGS } from "@shared/vocabulary";

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
export type ReviewHead = Pick<ReviewItem, "id" | "kind" | "title" | "badge" | "badgeColor" | "time" | "agent">;

function proposalHead(p: StagedProposal): ReviewHead {
  return { id: `doc:${p.slug}@${p.version}`, kind: "proposal", title: p.title, badge: "STAGED", badgeColor: "var(--amber)", time: relTime(p.created_at), agent: p.author };
}
function adrHead(a: AdrRow): ReviewHead {
  return { id: `adr:${a.id}`, kind: "decision", title: a.title, badge: "DRAFT", badgeColor: "var(--blue)", time: relTime(a.created_at), agent: a.created_by };
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

// ── Maintenance · assign vocabulary ──────────────────────────────────────────
/** The real assign options: gate types × @shared/vocabulary targets.
 *  'needs-triage' is the queue itself, never an assignable section. */
export const ASSIGN_OPTIONS: AssignOptions = {
  kinds: [
    { key: "doc", label: "Doc section" },
    { key: "adr", label: "Decision record" },
    { key: "feed", label: "Feed update" },
  ],
  sections: SECTIONS.filter((s) => s !== "needs-triage"),
  spaces: ["technical", "product"],
  tags: [...TAGS],
};

// ── Maintenance · Unplaced ───────────────────────────────────────────────────
function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Derive the card fields from the stored gate payload: JSON of the gated item
 *  (DocProposal / AdrDraft / FeedEntry) OR a free-form string for agent-flagged
 *  batch items. The two-bucket chip is a lossy convenience — the verbatim gate
 *  reason always rides in reasonNote. */
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
  return {
    id: String(r.id),
    title,
    snippet: clip(snippet, 280),
    reason: r.reason.toLowerCase().startsWith("low confidence") ? "LOW CONFIDENCE" : "AGENT FLAGGED",
    meta: `${r.source_author ?? "unknown"} · ${relTime(r.created_at)}`,
    reasonNote: r.reason,
    author: r.source_author ?? null,
    when: relTime(r.created_at),
  };
}

// ── Maintenance · Identity ───────────────────────────────────────────────────
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
      kind: s.event_type === "issue" ? "ISSUE" : "PR",
      text: `#${s.ref_number} ${s.title ?? "(no title)"}`,
      when: relTime(s.occurred_at),
    })),
  };
}

/** The person picker's source: the persons directory. The picked value is the handle.
 *  Mapping is an identity link, not just an attribution label: it also lets that
 *  GitHub account sign in as the picked person (personPicker's helper text below
 *  the button says so). */
export function peopleFromPersons(persons: PersonSummary[]): Person[] {
  return persons.map((p) => ({ id: p.handle, name: p.name ?? p.handle, initials: initialsOfName(p.name, p.handle), color: p.color, avatar_url: p.avatar_url }));
}
