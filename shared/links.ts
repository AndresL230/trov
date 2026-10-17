// Agent links (0078_agent_links) — the DTOs the Worker returns and the SPA will render, plus the fixed
// numbers. Types and constants only, zod-free: the browser bundle may import this module. The validators
// and every rule live server-side, in src/tools/links.ts.

export type LinkState = "draft" | "requested" | "open" | "declined" | "cancelled" | "closed" | "expired";
/** The states a link is still alive in; every other state is an end. */
export const LINK_LIVE_STATES: readonly LinkState[] = ["draft", "requested", "open"];

export type LinkTopicKind = "pr" | "branch" | "ticket" | "person";
/** What kind of session is bound to a side: a coding agent with the plugin, any other MCP chat, an Ask thread. */
export type LinkSideKind = "code" | "chat" | "ask";
export type LinkSideName = "requester" | "recipient";
/** Who wrote a note: a side's agent, its Ask thread, or the side's person on the link's page. */
export type LinkNoteAuthorKind = "agent" | "ask" | "person";

/** Which slice a list read returns, for the caller:
 *  waiting = requests sent to me · mine = my drafts and the requests I sent · open = my open links ·
 *  unbound = my open links whose side of mine has no session yet · closed = ended links, most recent first. */
export type LinkBox = "waiting" | "mine" | "open" | "unbound" | "closed";
export const LINK_BOXES: readonly LinkBox[] = ["waiting", "mine", "open", "unbound", "closed"];

/** Limits (the owner's rulings, 2026-10-17). The per-person hourly note limit is `LIMITS.link_note`. */
export const LINK_REASON_MAX = 280;
export const LINK_NOTE_MAX = 1000;
export const LINK_NOTES_PER_SIDE = 20;
export const LINK_LIVE_MAX = 5;
/** How long each state lasts: a draft 1 h, a request 24 h, an open link 7 days — and an open link neither side's
 *  agent has checked, joined or written in 12 h ends early (the cron's `expireDueLinks`). */
export const LINK_DRAFT_TTL_MS = 60 * 60 * 1000;
export const LINK_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const LINK_OPEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LINK_IDLE_MS = 12 * 60 * 60 * 1000;
/** Notes handed over by one inbox read; the rest wait for the next. */
export const LINK_INBOX_BATCH = 5;
/** The prefix of an Ask thread's session (`ask-thread-<id>`): written only by Ask, refused over MCP. */
export const ASK_THREAD_SESSION_PREFIX = "ask-thread-";

export interface LinkSideView {
  handle: string;
  /** Null until a session is bound to the side. */
  kind: LinkSideKind | null;
  session: string | null;
  branch: string | null;
  seen_at: string | null;
}

/** The API shape of a link. `id` is its per-org NUMBER (rendered `#12`) — the row id never leaves the Worker. */
export interface LinkView {
  id: number;
  state: LinkState;
  repo: string | null;
  topic: { kind: LinkTopicKind; ref: string };
  reason: string;
  requester: LinkSideView;
  recipient: LinkSideView;
  /** requester = recipient: one person's two sessions. Opens on send. */
  self: boolean;
  created_at: string;
  sent_at: string | null;
  decided_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
  close_reason: string | null;
  expires_at: string;
}

export interface LinkNoteView {
  id: number;
  side: LinkSideName;
  author: string;
  author_kind: LinkNoteAuthorKind;
  body: string;
  created_at: string;
  delivered_at: string | null;
}

export interface LinkDetail extends LinkView { notes: LinkNoteView[] }

/** How a topic reads in a sentence: `PR #180`, branch `feat/x`, ticket #12, @jose. */
export function linkTopicLabel(kind: LinkTopicKind, ref: string): string {
  if (kind === "pr") return `PR #${ref}`;
  if (kind === "branch") return `branch \`${ref}\``;
  if (kind === "ticket") return `ticket #${ref}`;
  return `@${ref}`;
}
