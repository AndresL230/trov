// Ask Trov — the dev replay hook (FOUNDATION; LOCAL DEVELOPMENT ONLY). Recipe: inventory §0.
//
//   http://localhost:<port>/<org>/?askReplay=<scenario>[&askSpeed=4]#ask
//
// With `askReplay` in the address, the Ask screen runs on the dev replay route (`GET /api/o/:slug/ai/ask-replay`,
// src/ai/routes.ts, honoured only under `wrangler dev` with LOCAL_AI_PREVIEW and no live Stripe key): the state,
// threads, search and ref views come from its fixtures (shared/ai-fixtures.ts › Ask Trov), each send streams a
// recorded transcript at real pacing, and NOTHING is written — a write answers with a sample result. Every design
// scenario plus `composer:<state>` and `insp:<type>` sets the screen up as the design shows it (`replayPlan`),
// so each part can be built and screenshotted without a key. A part that needs more set-up for its scenario
// adds it to `replayPlan`'s `setup` (one case per scenario — merge-friendly).

import type { AskActionAnswer, AskEvent, AskEventMap, AskState, PeekResult, RefView } from "@shared/ai-ask-core";
import { getReplayIndex, streamReplay, type AskApi, type AskReplayIndex } from "./ask-api";
import type { AskCtx, AskWhere } from "./ask-state";
import { COMPOSER_STATES, type ComposerForced } from "./ask-composer";

/** The replay asked for in the page's address, or null. */
export function replayFromLocation(search: string): { scenario: string; speed: number } | null {
  const p = new URLSearchParams(search);
  const scenario = p.get("askReplay");
  if (!scenario || !/^[a-z-]+(?::[a-zA-Z]+)?$/.test(scenario)) return null;
  const n = Number(p.get("askSpeed") ?? "1");
  return { scenario, speed: Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 1 };
}

/** The `insp:<type>` scenarios' items (refs in the replay index's `refs`). `upload` and `chart` have no RefView
 *  fixture yet (a gap the inspector's sibling fills: the design's ci-failure.png and the merged-PR chart). */
export const INSP_FIXTURE: Record<string, string> = {
  ticket: "ticket:14", pr: "pr:176", doc: "doc:release-0-30-notes", sprint: "sprint:7", repo: "repo:AndresL230/trov", handoff: "handoff:11",
  feed: "feed:41", person: "person:maya", artifact: "artifact:hosting-status-oct-15",
};

export interface ReplayPlan {
  /** Free (`composer:free`, `composer:low`) or Pro state. */
  plan: "pro" | "free";
  /** Transcripts to play on arrival, in order (each after its scenario's question), in which conversation. */
  play: string[];
  where: AskWhere;
  /** What the screen looks like besides the stream (runs once the index is in; `after` once the plays end). */
  setup?(ctx: AskCtx): void;
  after?(ctx: AskCtx): void;
  /** Overrides on the fixture state. */
  state?(s: AskState): AskState;
}

export function replayPlan(scenario: string): ReplayPlan {
  const base: ReplayPlan = { plan: "pro", play: [], where: "page" };
  if (scenario.startsWith("composer:")) {
    const forced = scenario.slice(9) as ComposerForced;
    if (!(COMPOSER_STATES as readonly string[]).includes(forced)) return base;
    return {
      ...base,
      plan: forced === "free" ? "free" : "pro",
      setup: (ctx) => { ctx.ui.composer.page.forced = forced; },
      state: (s) => forced === "quota" ? { ...s, allowance: { ...s.allowance, used: s.allowance.cap ?? 0, low: true } }
        : forced === "off" ? { ...s, enabled: false }
        : forced === "autoOff" ? { ...s, autoAllowed: false }
        : forced === "low" ? { ...s, allowance: { ...s.allowance, used: Math.max(0, (s.allowance.cap ?? 300) - 41), low: true } }
        : s,
    };
  }
  if (scenario.startsWith("insp:")) {
    const ref = INSP_FIXTURE[scenario.slice(5)];
    return { ...base, setup: (ctx) => { if (ref) ctx.openRef(ref); } };
  }
  switch (scenario) {
    case "streaming": case "thinking": case "answer": case "notfound": case "actions-ask": case "actions-auto":
    case "phone": case "phone-plus": case "phone-insp":
      return {
        ...base, play: [scenario === "phone" || scenario === "phone-plus" || scenario === "phone-insp" ? "answer" : scenario],
        setup: (ctx) => { if (scenario === "phone-plus") ctx.ui.phone.plus = true; },
        after: (ctx) => {
          if (scenario === "phone-insp") ctx.openRef("ticket:14");
        },
      };
    case "answer-pr":
      return { ...base, play: ["answer"], after: (ctx) => { ctx.openRef("ticket:14"); ctx.openRef("pr:176"); ctx.openRef("pr:173"); ctx.ui.threadsForced = false; ctx.paint(); } };
    case "artifact": case "artifact-saved": return { ...base, play: ["answer", scenario] };
    case "search": return { ...base, play: ["search"], setup: (ctx) => { ctx.ui.threadQ = "netlify"; ctx.ui.threadMenu = 5; } };
    case "cmdj": return { ...base, play: ["cmdj"], where: "panel", setup: (ctx) => { ctx.ui.cmdj.open = true; ctx.ui.cmdj.contextRef = "ticket:14"; } };
    default: return base;
  }
}

/** Which recorded transcript a typed question replays (the design's `route`, L1344–1355). */
export function replayRoute(text: string): string {
  const s = text.toLowerCase();
  if (/save (this|it)|as an? (doc|artifact)/.test(s)) return "artifact";
  if (/^\/search/.test(s) || /ship|0\.30/.test(s)) return "search";
  if (/file a ticket|draft|hand ?off|follow-ups|move #/.test(s)) return "actions-ask";
  if (/block|hosting|#14|summari[sz]e|time|theme/.test(s)) return "answer";
  return "notfound";
}

const now = (): string => new Date().toISOString();
const sample = (ids: number[], state: AskEventMap["action_result"]["state"]): AskActionAnswer =>
  ({ results: ids.map((id) => ({ id, groupId: null, state, result: { sample: true }, ref: null, undo: state === "confirmed", at: now() })) });

/** The replay's stand-in for `askApi`: fixtures for reads, transcripts for sends, sample answers for writes. */
export function createReplayApi(index: AskReplayIndex, plan: ReplayPlan, speed: number): AskApi {
  const state = (plan.state ?? ((s: AskState) => s))(index.state[plan.plan]);
  let threads = [...index.threads];
  // The plan's transcripts play first, in order; after them each send picks one by its words.
  const queue = [...plan.play];
  const peekOne = (ref: string): PeekResult => index.refs[ref] ?? { ref, hidden: true };
  return {
    getState: async () => state,
    listThreads: async () => threads,
    searchThreads: async (q) => (q.trim().toLowerCase() === index.search.q ? index.search.hits
      : threads.filter((t) => t.title.toLowerCase().includes(q.trim().toLowerCase())).map((thread) => ({ thread, snippet: null, matchCount: 1 }))),
    getThread: async (id) => {
      const thread = threads.find((t) => t.id === id);
      if (!thread) throw new Error("not_found");
      return { thread: { ...thread, draft: "" }, messages: [] };
    },
    patchThread: async (id, patch) => {
      threads = threads.map((t) => (t.id === id ? { ...t, ...(patch.title !== undefined ? { title: patch.title } : {}), ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}) } : t));
      return threads.find((t) => t.id === id)!;
    },
    deleteThread: async (id) => { threads = threads.filter((t) => t.id !== id); },
    exportUrl: () => "#",
    stopThread: async () => undefined,
    async ask(req, o) {
      const scenario = queue.shift() ?? replayRoute(req.text);
      await streamReplay(scenario, speed, { onEvent: (e: AskEvent) => o.onEvent(e), signal: o.signal });
    },
    peek: async (refs) => refs.map(peekOne),
    getItem: async (ref) => {
      const v = index.refs[ref];
      if (!v) throw new Error("not_found");
      return { view: v as RefView, detail: {} };
    },
    confirmAction: async (id) => sample([id], "confirmed"),
    cancelAction: async (id) => sample([id], "cancelled"),
    undoAction: async (id) => sample([id], "undone"),
    saveForm: async (messageId) => ({ block: { kind: "save_form", form: { messageId, block: null, title: "Hosting status, Oct 15", kind: "html", visibility: "private", saved: null } }, index: 0 }),
    saveThread: async (_id, body) => ({ slug: "hosting-status-oct-15", title: body.title ?? "Hosting status, Oct 15", visibility: body.visibility ?? "private", url: "#artifacts/hosting-status-oct-15" }),
    uploadAttachments: async (files, threadId) => ({
      threadId: threadId ?? 1,
      attachments: files.map((f, i) => ({ id: 900 + i, slug: `sample-${i}`, title: f.name, kind: f.type.startsWith("image/") ? "image" : f.type === "application/pdf" ? "pdf" : "text", contentType: f.type, size: f.size, sha256: "" })),
    }),
    markWrong: async () => undefined,
    getSettings: async () => index.settings[plan.plan],
    putSettings: async (body) => ({ ...index.settings[plan.plan], ...body, modes: index.settings[plan.plan].modes }),
  };
}

/** Load the replay's index (the fixtures). */
export const loadReplayIndex = getReplayIndex;
