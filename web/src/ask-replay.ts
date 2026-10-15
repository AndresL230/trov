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

import { askRepoFacts, type AskActionAnswer, type AskEvent, type AskEventMap, type AskState, type PeekResult, type RefView } from "@shared/ai-ask-core";
import { getReplayIndex, streamReplay, type AskApi, type AskReplayIndex } from "./ask-api";
import type { AskCtx, AskWhere } from "./ask-state";
import { COMPOSER_STATES, composerReplaySetup, type ComposerForced } from "./ask-composer";
import { REPLAY_WRITES, replayPriorExchange } from "./ask-actions";

/** The replay asked for in the page's address, or null. */
export function replayFromLocation(search: string): { scenario: string; speed: number } | null {
  const p = new URLSearchParams(search);
  const scenario = p.get("askReplay");
  if (!scenario || !/^[a-z-]+(?::[a-zA-Z]+)?$/.test(scenario)) return null;
  const n = Number(p.get("askSpeed") ?? "1");
  return { scenario, speed: Number.isFinite(n) && n >= 0 ? Math.min(n, 50) : 1 };
}

/** The `insp:<type>` scenarios' items (refs in the replay index's `refs`). `upload` and `chart` have no RefView: the
 *  inspector's web-side fixtures open the design's ci-failure.png and merged-PR chart (ask-inspector-fixtures.ts). */
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
      // `quota` is the design's Free org at its cap (the upsell to Pro is a Free org's).
      plan: forced === "free" || forced === "quota" ? "free" : "pro",
      setup: (ctx) => composerReplaySetup(ctx, "page", forced),
      state: (s) => forced === "quota" ? { ...s, allowance: { ...s.allowance, used: s.allowance.cap ?? 0, low: true } }
        : forced === "off" ? { ...s, enabled: false }
        : forced === "autoOff" ? { ...s, autoAllowed: false }
        : forced === "low" ? { ...s, allowance: { ...s.allowance, used: Math.max(0, (s.allowance.cap ?? 300) - 41), low: true } }
        : s,
    };
  }
  if (scenario.startsWith("insp:")) {
    const type = scenario.slice(5);
    const ref = INSP_FIXTURE[type];
    return {
      ...base,
      setup: (ctx) => {
        if (ref) ctx.openRef(ref);
        else if (type === "upload" || type === "chart") void import("./ask-inspector-fixtures").then((f) => f.openLocalFixture(ctx, type));
      },
    };
  }
  switch (scenario) {
    // The design's earlier exchange (a confirmed and a cancelled line; an undone one) above the streamed turn.
    case "actions-ask": case "actions-auto":
      return { ...base, play: [scenario], setup: (ctx) => { ctx.ui.page = { ...ctx.ui.page, messages: replayPriorExchange(scenario === "actions-auto"), status: "ok" }; } };
    case "streaming": case "thinking": case "answer": case "notfound":
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
    // The panel over the ticket (`?askReplay=cmdj#tickets/14`): the item is its context chip, as ⌘J there makes it.
    case "cmdj": return { ...base, play: ["cmdj"], where: "panel", setup: (ctx) => { ctx.ui.cmdj.open = true; ctx.ui.cmdj.contextRef = "ticket:14"; ctx.ui.composer.panel.context = ["ticket:14"]; } };
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
/** A write's sample answer: every card of its group (a group moves together), with the item the design's card makes. */
const sample = (ids: number[], state: AskEventMap["action_result"]["state"], groups: Map<number, string> = new Map()): AskActionAnswer =>
  // The card is already on screen (its `action` event): the result keeps its tool, kind and preview.
  ({ results: ids.map((id) => ({ id, groupId: groups.get(id) ?? null, tool: "", kind: "other" as const, preview: { title: "", lines: [], item: null }, state, result: state === "confirmed" ? REPLAY_WRITES[id]?.result ?? { sample: true } : { sample: true },
    ref: state === "confirmed" ? REPLAY_WRITES[id]?.ref ?? null : null, undo: state === "confirmed", at: now() })) });

/** The replay's stand-in for `askApi`: fixtures for reads, transcripts for sends, sample answers for writes. */
export function createReplayApi(index: AskReplayIndex, plan: ReplayPlan, speed: number): AskApi {
  const state = (plan.state ?? ((s: AskState) => s))(index.state[plan.plan]);
  let threads = [...index.threads];
  // The plan's transcripts play first, in order; after them each send picks one by its words.
  const queue = [...plan.play];
  const peekOne = (ref: string): PeekResult => index.refs[ref] ?? { ref, hidden: true };
  // The cards' groups, as the transcripts streamed them: Confirm / Cancel / Undo answer for the whole group.
  const groups = new Map<number, string>();
  const note = (e: AskEvent) => { if ((e.event === "action" || e.event === "action_result") && e.data.groupId) groups.set(e.data.id, e.data.groupId); };
  const group = (id: number): number[] => { const g = groups.get(id); return g ? [...groups].filter(([, x]) => x === g).map(([i]) => i) : [id]; };
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
      let ended = false;
      await streamReplay(scenario, speed, { onEvent: (e: AskEvent) => { if (e.event === "done" || e.event === "error") ended = true; note(e); o.onEvent(e); }, signal: o.signal });
      // A transcript recorded mid-answer (`streaming`: no `done`) is HELD as the design shows it — busy, the soft
      // cursor, Stop — until Stop aborts the request; the route itself ends the HTTP stream with the last event.
      const signal = o.signal;
      if (!ended && signal) {
        await new Promise<never>((_, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
        });
      }
    },
    peek: async (refs) => refs.map(peekOne),
    // The composer's @ picker over the fixtures' items (the replay's org is not the seed's).
    searchRefs: async (q) => {
      const n = q.trim().toLowerCase().replace(/^#/, "");
      return Object.values(index.refs)
        .filter((v) => !n || `${v.num ?? ""} ${v.title} ${v.ref}`.toLowerCase().includes(n))
        .map((v) => ({ ref: v.ref, type: v.type, title: v.title, status: v.status?.word ?? null }));
    },
    getItem: async (ref) => {
      const v = index.refs[ref];
      if (!v) throw new Error("not_found");
      // The design's details for the inspector (loaded on demand: dev replay only).
      const { inspectorDetailFixture } = await import("./ask-inspector-fixtures");
      return { view: v as RefView, detail: inspectorDetailFixture(ref, Date.now(), index.refs) ?? {} };
    },
    confirmAction: async (id, body) => sample(body?.args ? [id] : group(id), "confirmed", groups),
    cancelAction: async (id) => sample(group(id), "cancelled", groups),
    undoAction: async (id) => sample(group(id), "undone", groups),
    saveForm: async (messageId) => ({ block: { kind: "save_form", form: { messageId, block: null, title: "Hosting status, Oct 15", kind: "html", visibility: "private", saved: null } }, index: 0 }),
    saveThread: async (_id, body) => ({ slug: "hosting-status-oct-15", title: body.title ?? "Hosting status, Oct 15", visibility: body.visibility ?? "private", url: "#artifacts/hosting-status-oct-15" }),
    uploadAttachments: async (files, threadId) => ({
      threadId: threadId ?? 1,
      attachments: files.map((f, i) => ({ id: 900 + i, slug: `sample-${i}`, title: f.name, kind: f.type.startsWith("image/") ? "image" : f.type === "application/pdf" ? "pdf" : "text", contentType: f.type, size: f.size, sha256: "" })),
    }),
    deleteAttachment: async () => undefined,
    markWrong: async () => undefined,
    getSettings: async () => index.settings[plan.plan],
    putSettings: async (body) => ({ ...index.settings[plan.plan], ...body, modes: index.settings[plan.plan].modes }),
  };
}

/** The scenario a replay's repository plays (#186): the Repo Overview's own sample, never a sample of Ask's — N /
 *  `trov` is Trov's repository in trouble (B/trouble: checks failing on main, a deploy that failed). */
export const REPLAY_REPO_SCENARIO = { key: "N", variant: "trov" } as const;

/** Load the replay's index (the fixtures), with every repo ref's facts filled from the Overview's sample scenario
 *  (web/src/repo-sample.ts, loaded on demand like the Overview's own sample switch). */
export async function loadReplayIndex(): Promise<AskReplayIndex> {
  const index = await getReplayIndex();
  const repos = Object.values(index.refs).filter((v) => v.type === "repo" && !v.extra.facts);
  if (repos.length) {
    const { repoScenario } = await import("./repo-sample");
    const facts = askRepoFacts(repoScenario(REPLAY_REPO_SCENARIO.key, REPLAY_REPO_SCENARIO.variant));
    for (const v of repos) v.extra = { ...v.extra, facts };
  }
  return index;
}
