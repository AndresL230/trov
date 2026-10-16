// A sprint's state — done, ready, overdue, in progress, upcoming — as the Roadmap's Timeline draws it:
// its words, its glyph (marks.ts) and colour, and the state's mark. Its own module so the landing's
// mockups (landing-mocks.ts) draw the same mark without the Timeline (timeline.ts re-exports it).
import { glyphMark, type Glyph } from "./marks";

export type TlState = "done" | "ready" | "overdue" | "active" | "upcoming";

export const STATE_LABEL: Record<TlState, string> = {
  done: "Done", ready: "Ready to complete", overdue: "Overdue", active: "In progress", upcoming: "Upcoming",
};
const STATE_TAG: Record<TlState, string> = {
  done: "Done", ready: "Ready", overdue: "Overdue", active: "In progress", upcoming: "Upcoming",
};
/** The state's glyph (marks.ts): the ring fills as the sprint moves along — the tickets' shapes —
 *  and a late one is a warning triangle. */
const STATE_GLYPH: Record<TlState, Glyph> = { upcoming: "todo", active: "half", ready: "most", done: "done", overdue: "warn" };
/** What each state means — the tooltip on its mark. */
const STATE_HINT: Record<TlState, string> = {
  upcoming: "Not started yet.",
  active: "Running now.",
  ready: "Every ticket is closed. A person confirms it done.",
  done: "Confirmed done.",
  overdue: "Past its due date with tickets still open.",
};
/** The state's colour — theme vars only. Upcoming is the neutral fg family. */
export const STATE_COLOR: Record<TlState, string> = {
  done: "var(--green)", ready: "var(--accent)", overdue: "var(--red)", active: "var(--accent)", upcoming: "var(--fg-55)",
};
export function stateTag(state: TlState, label = STATE_TAG[state], size = 12): string {
  return `<span class="tl-tag" style="display:inline-flex;flex:none">${glyphMark(STATE_GLYPH[state], STATE_COLOR[state], label, size, STATE_HINT[state])}</span>`;
}
