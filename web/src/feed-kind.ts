// A feed entry's KIND is the leading "Word:" of its summary — the record-session types (`Decision:`, `Finding:`,
// `Incident:`, `Triage:`) and the ones Trov's session digests write (`Shipped:`, `Status:`;
// plugins/trov/skills/record-session/SKILL.md). Pure. A summary with no known word has no kind (null), never a guess.
export const FEED_KINDS = ["Shipped", "Status", "Decision", "Finding", "Incident", "Triage"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

/** The entry's kind word and the summary after it; `{ kind: null, rest: summary }` when it opens with none. */
export function feedKind(summary: string): { kind: FeedKind | null; rest: string } {
  const m = /^\s*([A-Za-z]+):\s*(.*)$/s.exec(summary);
  const word = m ? FEED_KINDS.find((k) => k.toLowerCase() === m[1].toLowerCase()) : undefined;
  return word && m![2].trim() ? { kind: word, rest: m![2].trim() } : { kind: null, rest: summary };
}
