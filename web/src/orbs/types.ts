// The orb's two public types, from thinking-orbs `src/types.ts` (the Vue props left out). MIT — see ./LICENSE.

/** working — particles on tilted orbits; searching — a scan meridian sweeps a dotted globe; solving — bands
 *  scramble in quarter turns, then click back; listening — a waveform rolls through latitude rings; composing —
 *  an undulating multi-band sash; shaping — a dotted outline morphs circle → triangle → square. */
export type OrbState = "working" | "searching" | "solving" | "listening" | "composing" | "shaping";

/** Two tuned presets in CSS px — separate designs, not a scale factor: 64 (chat-avatar scale), 20 (inline text). */
export type OrbSize = 64 | 20;
