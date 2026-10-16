// Which thinking orb Ask Trov shows while it works — the person's pick (Settings › Trov, ask-settings.ts).
//
//   "match"      the default: the orb says what Trov is doing (ask-conversation.ts picks it — a search step
//                searches, the thinking row solves, the wait works, a reply being written composes)
//   an OrbState  that one animation for every orb in Ask: the steps, the thinking row and the wait
//
// Kept PER BROWSER (localStorage `trov.askOrb`, read once at start in main.ts, written on a pick): Ask's server-side
// settings (`person_ask_settings`) have fixed columns, and a look is not worth a migration. Pure; no DOM.
import type { OrbState } from "./thinking-orb";

export type AskOrbChoice = "match" | OrbState;

/** The localStorage key the pick is kept under. */
export const ASK_ORB_KEY = "trov.askOrb";

/** The choices, in the dropdown's order: the default first, then the six animations by a plain name. */
export const ASK_ORB_CHOICES: readonly { value: AskOrbChoice; label: string; hint?: string }[] = [
  { value: "match", label: "Match what it's doing", hint: "Searching, thinking and writing each look different." },
  { value: "working", label: "Orbits" },
  { value: "searching", label: "Globe" },
  { value: "solving", label: "Cube" },
  { value: "listening", label: "Wave" },
  { value: "composing", label: "Ribbon" },
  { value: "shaping", label: "Shapes" },
];

/** What "Match what it's doing" shows over time in its own preview: the states Ask really uses, in turn. */
export const ASK_ORB_MATCH_TOUR: readonly OrbState[] = ["working", "searching", "solving", "composing"];

const VALUES = new Set<string>(ASK_ORB_CHOICES.map((c) => c.value));

/** A stored or picked value, else the default (a hand-edited or retired value never breaks Ask). */
export const parseAskOrb = (raw: unknown): AskOrbChoice => (typeof raw === "string" && VALUES.has(raw) ? (raw as AskOrbChoice) : "match");

/** The orb to draw: the pick, or — on "match" — what the place in the answer means. */
export const askOrbState = (choice: AskOrbChoice, natural: OrbState): OrbState => (choice === "match" ? natural : choice);
