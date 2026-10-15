// Ask Trov — the icon set (FOUNDATION). The design's paths verbatim (ask-trov.dc.html L1060–1090: the
// sidebar's where they exist), drawn on a 24px stroke grid. One helper, `askIcon`, so every part draws them
// the same way. A part that needs a new icon adds it HERE (one line each — merge-friendly).

import type { AskActivityIcon, AskRefType } from "@shared/ai-ask-core";

export const ASK_ICON_PATHS = {
  // The Trov row in the sidebar, the composer's ⌘J button: the constellation (the design's default `askGraph`).
  ask: `<circle cx="12" cy="12" r="2.6"></circle><circle cx="5" cy="5.5" r="1.9"></circle><circle cx="19" cy="6.5" r="1.9"></circle><circle cx="17.5" cy="19" r="1.9"></circle><circle cx="5.5" cy="17.5" r="1.9"></circle><path d="M10 10.2 6.4 6.9M14.2 10.7l3.3-2.7M13.6 14.1l2.7 3.3M10 13.8l-3.1 2.4"></path>`,
  mywork: `<path d="M3 12 12 3l9 9"></path><path d="M5 10v10h14V10"></path><path d="M9 20v-6h6v6"></path>`,
  tickets: `<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"></path><path d="M13 5v2M13 11v2M13 17v2"></path>`,
  handoffs: `<path d="M22 2 11 13"></path><path d="M22 2 15 22l-4-9-9-4z"></path>`,
  prompts: `<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1"></path><path d="M16 21h1a2 2 0 0 0 2-2v-5a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"></path>`,
  repo: `<path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path>`,
  feed: `<path d="M4 5h16"></path><path d="M4 12h16"></path><path d="M4 19h10"></path>`,
  docs: `<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path><path d="M9 13h6"></path><path d="M9 17h6"></path>`,
  artifacts: `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 9h18"></path><path d="M7 13.5h6"></path><path d="M7 16.5h9"></path>`,
  review: `<rect x="4" y="4" width="16" height="16" rx="3"></rect><path d="m9 12.5 2 2 4-5"></path>`,
  search: `<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.2-3.2"></path>`,
  pr: `<circle cx="18" cy="18" r="3"></circle><circle cx="6" cy="6" r="3"></circle><path d="M13 6h3a2 2 0 0 1 2 2v7"></path><path d="M6 9v12"></path>`,
  person: `<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>`,
  chart: `<path d="M3 3v18h18"></path><path d="M7 16v-4M12 16V8M17 16v-7"></path>`,
  ci: `<circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path>`,
  read: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>`,
  image: `<rect x="3" y="4" width="18" height="16" rx="2"></rect><circle cx="9" cy="10" r="2"></circle><path d="m21 16-5-5-9 9"></path>`,
  file: `<path d="M6 3h7l5 5v13H6z"></path><path d="M13 3v5h5"></path>`,
  csv: `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M3 10h18M9 4v16"></path>`,
  clock: `<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>`,
  sprint: `<path d="M5 21V4"></path><path d="M5 4.5C7 3 9 3 12 4.5s5 1.5 7 0V13c-2 1.5-4 1.5-7 0s-5-1.5-7 0"></path>`,
  cmd: `<path d="M15 4 9 20"></path>`,
  // The phone (ask-phone.ts): the header's Open threads (not the app's nav hamburger beside it). Its + menu's
  // Attach / Mention rows draw the composer's `attach` and `at`.
  phThreads: `<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12z"></path><path d="M8.5 10.5h7M8.5 14h4.5"></path>`,
  // The shell's own controls.
  panel: `<rect x="3" y="4" width="18" height="16" rx="2"></rect><path d="M9 4v16"></path>`,
  plus: `<path d="M12 5v14M5 12h14"></path>`,
  close: `<path d="M5 5l14 14M19 5 5 19"></path>`,
  more: `<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"></circle>`,
  rename: `<path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path>`,
  pin: `<path d="M12 17v5"></path><path d="M9 3h6l-1 6 4 4v2H6v-2l4-4z"></path>`,
  download: `<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>`,
  trash: `<path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 13h10l1-13"></path><path d="M9 7V4h6v3"></path>`,
  arrow: `<path d="M5 12h14M13 6l6 6-6 6"></path>`,
  back: `<path d="M19 12H5M11 6l-6 6 6 6"></path>`,
  external: `<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"></path>`,
  openNew: `<path d="M7 17 17 7"></path><path d="M8 7h9v9"></path>`,
  send: `<path d="M12 19V5"></path><path d="m6 11 6-6 6 6"></path>`,
  menu: `<path d="M4 7h16M4 12h16M4 17h16"></path>`,
  // The composer's (ask-composer.ts).
  attach: `<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"></path>`,
  at: `<circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8"></path>`,
  upload: `<path d="M12 15V3"></path><path d="m7 8 5-5 5 5"></path><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4"></path>`,
  check: `<path d="m5 12.5 4.5 4.5L19 7.5"></path>`,
  chevron: `<path d="m6 9 6 6 6-6"></path>`,
} as const;
export type AskIconName = keyof typeof ASK_ICON_PATHS;

/** An Ask icon: `currentColor` stroke unless `color` is given. Decorative (aria-hidden) — the control names itself. */
export function askIcon(name: AskIconName, size = 15, color: string | null = null, strokeWidth = 1.8): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;display:block${color ? `;color:${color}` : ""}">${ASK_ICON_PATHS[name]}</svg>`;
}

/** An activity step's icon (`activity.icon`, shared/ai-ask-core.ts `ASK_ACTIVITY_ICONS`). */
export const ACTIVITY_ICON: Record<AskActivityIcon, AskIconName> = {
  search: "search", tickets: "tickets", ci: "ci", pr: "pr", sprint: "sprint", feed: "feed", docs: "docs", read: "read", handoffs: "handoffs", review: "review",
};

/** A ref type's icon (a chip's lead, a card's eyebrow, a picker row, a source row). */
export const REF_ICON: Record<AskRefType, AskIconName> = {
  ticket: "tickets", pr: "pr", doc: "docs", decision: "docs", feed: "feed", sprint: "sprint", handoff: "handoffs", artifact: "artifacts",
  person: "person", prompt: "prompts", repo: "repo",
};

/** The Trov mark (the logo's three squares) in `var(--mark)`. */
export const trovMark = (size: number): string =>
  `<svg width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true" style="flex:none;display:block"><path fill="var(--mark)" d="M0 83.72H46.51V46.51H0ZM46.51 46.51H83.72V0H46.51ZM83.72 46.51V83.72H46.51V100H100V46.51Z"></path></svg>`;

/** The running step's spinner (`ask-spin`; still under reduced motion). */
export const askSpinner = (size = 13): string =>
  `<svg class="ask-spin" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="flex:none;display:block;color:var(--fg-55)"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity=".25" stroke-width="2.4"></circle><path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"></path></svg>`;
