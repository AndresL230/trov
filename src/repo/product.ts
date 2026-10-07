// Sapling's PRODUCT metrics (contract v2:
// docs/superpowers/specs/2026-09-21-sapling-product-metrics.md) — the ONE place
// that knows how a key is stored and how it is shown. The poller
// (src/repo/poll.ts) writes through `countMetric` / `totalMetric`; the
// projection (src/tools/repo.ts) reads back through `parseProductMetric` and
// labels / groups through `productLabel` / `productGroup`. Trov is GENERIC over
// keys: a key missing from the registry below is still stored and still shown
// (under "Other", labelled from the key) — so Sapling can add a metric with no
// Trov change. The labels travel in the DTO; the browser bundle gains nothing.

import type { RepoRange } from "@shared/repo";

/** `counts[key][window]` → `sap_c_<key>_<window>`; `totals[key]` → `sap_t_<key>`.
 *  A key may itself END in a window word (`foo_24h`); that stays unambiguous
 *  because exactly ONE trailing window is ever stripped from a `sap_c_` name. */
export const PRODUCT_PREFIX = "sap_";
const COUNT_PREFIX = "sap_c_";
const TOTAL_PREFIX = "sap_t_";
export const countMetric = (key: string, range: RepoRange): string => `${COUNT_PREFIX}${key}_${range}`;
export const totalMetric = (key: string): string => `${TOTAL_PREFIX}${key}`;

export type ProductMetricName = { kind: "count"; key: string; range: RepoRange } | { kind: "total"; key: string };

/** The inverse of the two builders; `null` for any other metric name. */
export function parseProductMetric(metric: string): ProductMetricName | null {
  if (metric.startsWith(TOTAL_PREFIX)) {
    const key = metric.slice(TOTAL_PREFIX.length);
    return key ? { kind: "total", key } : null;
  }
  if (!metric.startsWith(COUNT_PREFIX)) return null;
  const m = /^(.+)_(24h|7d|30d)$/.exec(metric.slice(COUNT_PREFIX.length));
  return m ? { kind: "count", key: m[1], range: m[2] as RepoRange } : null;
}

// ── the registry: group, order and label of the keys Trov knows today ──────
export const PRODUCT_GROUPS = [
  ["growth", "Growth"],
  ["learning", "Learning activity"],
  ["community", "Community"],
  ["ai", "AI spend"],
  ["reliability", "Reliability"],
  ["other", "Other"],
] as const;
export type ProductGroupId = (typeof PRODUCT_GROUPS)[number][0];

/** How a figure is written. `cents` = integer cents shown as dollars. */
export type ProductFormat = "int" | "cents";

interface ProductKey { group: ProductGroupId; label: string; format?: ProductFormat; note?: string }

/** Registry ORDER is display order within a group. One table for `counts` and
 *  `totals` keys alike — the two never share a name in the contract, and a
 *  total's group only matters if the screen ever groups them.
 *
 *  The keys are what Sapling SERVES (SaplingLearn/Sapling#654), not the first
 *  draft of the contract: `study_guides` is not here (that table is a cache, so
 *  Sapling omits it — were it ever sent it would simply land under "Other"). A
 *  label says what the number IS — `rag_chunks_dropped` counts RUNS — and a
 *  `note` is the caveat the screen prints under the group, one line per noted
 *  key, so a group may carry more than one. */
const KNOWN: [string, ProductKey][] = [
  ["signups", { group: "growth", label: "Signups" }],
  ["approvals", { group: "growth", label: "Approvals" }],
  ["logins", { group: "growth", label: "Logins" }],
  ["users", { group: "growth", label: "Users" }],
  ["users_pending", { group: "growth", label: "Users pending" }],

  ["tutor_sessions", { group: "learning", label: "Tutor sessions" }],
  ["chat_messages", { group: "learning", label: "Chat messages" }],
  ["quizzes_started", { group: "learning", label: "Quizzes started" }],
  ["quizzes_completed", { group: "learning", label: "Quizzes completed" }],
  ["documents_uploaded", { group: "learning", label: "Documents uploaded" }],
  ["documents_processed", { group: "learning", label: "Documents processed" }],
  ["notes_created", { group: "learning", label: "Notes created" }],
  ["flashcards_created", { group: "learning", label: "Flashcards created", note: "lower bound — deleted cards are not counted" }],
  ["xp_events", { group: "learning", label: "XP events" }],
  ["achievements_earned", { group: "learning", label: "Achievements earned" }],
  ["documents", { group: "learning", label: "Documents" }],
  ["flashcards", { group: "learning", label: "Flashcards" }],
  ["notes", { group: "learning", label: "Notes" }],

  ["room_messages", { group: "community", label: "Room messages" }],
  ["feedback", { group: "community", label: "Feedback" }],
  ["issue_reports", { group: "community", label: "Issue reports" }],
  ["rooms", { group: "community", label: "Rooms" }],

  ["llm_calls", { group: "ai", label: "LLM calls" }],
  ["llm_tokens", { group: "ai", label: "LLM tokens" }],
  ["llm_cost_cents", { group: "ai", label: "LLM cost", format: "cents", note: "lower bound — unpriced models are not counted" }],

  ["errors_5xx", { group: "reliability", label: "5xx errors" }],
  ["errors_4xx", { group: "reliability", label: "4xx errors", note: "includes bot traffic and refused polls" }],
  ["quiz_generation_failed", { group: "reliability", label: "Quiz generation failed" }],
  ["quiz_context_write_failed", { group: "reliability", label: "Quiz context write failed" }],
  ["rag_retrieval_failed", { group: "reliability", label: "RAG retrieval failed" }],
  ["rag_visibility_resync_failed", { group: "reliability", label: "RAG visibility resync failed" }],
  ["rag_chunks_dropped", { group: "reliability", label: "RAG runs that dropped chunks" }], // it counts RUNS, not chunks
  ["rag_chunks", { group: "reliability", label: "RAG chunks" }],
  ["rag_document_chunks", { group: "reliability", label: "RAG document chunks" }],
];
// A Map, never an object lookup: a key named `constructor` must not find Object's.
const REGISTRY = new Map<string, ProductKey>(KNOWN);
const ORDER = new Map<string, number>(KNOWN.map(([key], i) => [key, i]));

/** `foo_bar` → "Foo bar". */
const humanise = (key: string): string => {
  const words = key.replace(/_+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : key;
};

export interface ProductKeyInfo { group: ProductGroupId; label: string; format: ProductFormat; note?: string }
export function productKeyInfo(key: string): ProductKeyInfo {
  const known = REGISTRY.get(key);
  return known
    ? { group: known.group, label: known.label, format: known.format ?? "int", ...(known.note ? { note: known.note } : {}) }
    : { group: "other", label: humanise(key), format: "int" };
}

/** Known keys in registry order, then unknown ones alphabetically. */
export const compareProductKeys = (a: string, b: string): number =>
  (ORDER.get(a) ?? Infinity) - (ORDER.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
