// The Ask Trov gallery's specimens — every surface Ask Trov can put on screen, drawn by the APP'S OWN renderers from
// the app's own fixtures (shared/ai-fixtures.ts › Ask Trov, web/src/ask-inspector-fixtures.ts, the Repo Overview's
// sample). Nothing here writes markup of its own: each specimen is a real render (`render`,
// `conversationView`, `composerView`, `inspectorFrame`, `hoverCard`, `cmdjOverlay`, `thinkingOrb`, …) of a state set
// up the way the controller would leave it, and a part is cut out of that render with its ancestors kept (`keep`) so
// the CSS that styles it in place still applies.
//
// This file runs IN A BROWSER (build.ts bundles it and evaluates it in headless Chromium): the renderers are the
// SPA's, and a few of them need a DOM (the doc reader's markdown). It exposes `window.__askGallery()`, which returns
// the sections build.ts lays out. Every fixture-driven specimen is marked `sample`.

import { render, initialState, type AppState } from "../../web/src/render";
import { askView, type AskWhere } from "../../web/src/ask-state";
import { inspectorFrame } from "../../web/src/ask-screen";
import { conversationView, emptyView } from "../../web/src/ask-conversation";
import { composerView, knownHits, type ComposerFile } from "../../web/src/ask-composer";
import { hoverCard } from "../../web/src/ask-refs";
import { threadsView } from "../../web/src/ask-threads";
import { thinkingOrb, thinkingOrbTour, type OrbState } from "../../web/src/thinking-orb";
import { askOrbDropdown, ASK_ORB_MATCH_TOUR } from "../../web/src/ask-orb";
import { createDropdowns, dropdown, dropdownMenu } from "../../web/src/dropdown";
import { cmdjHeaderButton } from "../../web/src/ask-cmdj";
import { askFlagsLine } from "../../web/src/review";
import { emptyConvo, foldAskEvent, newTurn, type AskConvo, type AskMsg, type AskQuestion, type AskTurn } from "../../web/src/ask-stream";
import { actionDropdowns, replayPriorExchange, REPLAY_WRITES } from "../../web/src/ask-actions";
import { withRepoFacts } from "../../web/src/ask-replay";
import { cvRef } from "../../web/src/ask-cvref";
import { inspectorDetailFixture } from "../../web/src/ask-inspector-fixtures";
import { repoScenario } from "../../web/src/repo-sample";
import {
  askRefFixtures, askSearchFixture, askStateFixture, askThreadsFixture, askTranscript, ASK_SCENARIO_QUESTION, type AskScenario,
} from "@shared/ai-fixtures";
import {
  askRepoFacts, type AskAttachment, type AskDiagram, type AskEvent, type AskEventMap, type AskState, type PeekResult, type RefView,
} from "@shared/ai-ask-core";

// ── what build.ts receives ───────────────────────────────────────────────────

/** How a specimen is staged. `inline`: in the gallery's own page, in a themed box; `desktop`: the whole app in a
 *  1440 × `h` frame; `phone`: the whole app in a 390 × `h` frame (its own viewport, so the app's phone rules apply). */
export interface Spec {
  id: string;
  title: string;
  /** The state it shows, in a few words. */
  state: string;
  /** Where it appears in the app. */
  where: string;
  note?: string;
  /** Drawn from fixture data (sample content), not a live org. */
  sample: boolean;
  kind: "inline" | "desktop" | "phone";
  html: string;
  /** Inline staging: the box's width (px; else the column's), its height (px; else its content's), extra classes. */
  w?: number;
  minW?: number;
  h?: number;
  stage?: string;
}
export interface Section { id: string; title: string; intro: string; specs: Spec[] }

// ── the fixtures' world ──────────────────────────────────────────────────────

const NOW = new Date();
const T = NOW.getTime();
const ME = {
  handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [],
  orgs: [{ slug: "acme", name: "Acme", role: "owner" as const }], superadmin: false, pending_invites: 0,
};
const PEOPLE = [
  { handle: "andres", name: "Andres Lopez", color: "moss" as const, avatar_url: null, role: null },
  { handle: "maya", name: "Maya Chen", color: "sky" as const, avatar_url: null, role: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null, role: null },
  { handle: "jon", name: "Jon Park", color: "ochre" as const, avatar_url: null, role: null },
];
const REPO = "repo:AndresL230/trov";

/** The fixtures' ref views, the repository's facts filled from the Overview's sample (as the dev replay does). */
function views(): Record<string, PeekResult> {
  const v: Record<string, PeekResult> = askRefFixtures(NOW);
  const r = v[REPO] as RefView;
  v[REPO] = { ...r, extra: { facts: askRepoFacts(repoScenario("N", "trov", { now: T })) } };
  // The single item card's words (#178: `extra.excerpt`, a person's `openTickets` — src/ai/ask/refs.ts), which the
  // design's fixtures (and so the recorded transcripts) predate.
  const words: Record<string, Record<string, unknown>> = {
    "ticket:14": { excerpt: "Walk a new org from an empty Repo screen to its first deploy: pick the repository, confirm what the scan found, connect the host." },
    "ticket:29": { excerpt: "netlify-connect.test.ts still asserts on the old pills, so CI on main is red. Update it to the status marks and re-run." },
    "pr:176": { excerpt: "Adds the Netlify step to guided setup: paste a token, pick the site, and Trov starts polling its deploys." },
    "sprint:7": { excerpt: "Every host behind one provider interface, and each environment's deploys on the Repo screen." },
    "person:andres": { openTickets: 5 }, "person:maya": { openTickets: 2 }, "person:priya": { openTickets: 1 }, "person:jon": { openTickets: 1 },
  };
  for (const [ref, extra] of Object.entries(words)) { const x = v[ref] as RefView; v[ref] = { ...x, extra: { ...x.extra, ...extra } }; }
  // A decision and a prompt (the transcripts carry none): what the server builds for them (src/ai/ask/refs.ts).
  v["decision:7"] = { ref: "decision:7", type: "decision", num: 7, title: "Hosting tokens live in one encrypted table", owner: "andres", updated: new Date(T - 9 * 86_400_000).toISOString(), href: null,
    status: { mark: "check", tone: "accent", word: "Ratified", tip: "A person ratified this decision." },
    extra: { excerpt: "Every provider's token goes through `resolveCredential`, encrypted at rest; nothing reads a Worker secret for a host." } };
  v["prompt:release-notes"] = { ref: "prompt:release-notes", type: "prompt", title: "Write the release notes", owner: "priya", updated: new Date(T - 3 * 86_400_000).toISOString(), href: "#prompts/release-notes",
    status: { mark: "dot", tone: "green", word: "Published", tip: "Settled: published by a person." },
    extra: { excerpt: "Turns the merged PRs since the last tag into release notes in product words, one line each." } };
  return v;
}
const VIEWS = views();
const R = VIEWS as Record<string, RefView>;

/** A signed-in app on the Ask screen with Ask's reads in — what the controller holds after `GET /ask/state`, the
 *  thread list and the peeks. */
function app(o: { phone?: boolean; plan?: "pro" | "free"; state?: (s: AskState) => AskState } = {}): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "acme";
  (s as { me: unknown }).me = ME;
  s.persons = { status: "ok", data: PEOPLE } as AppState["persons"];
  s.theme = "light";
  if (o.phone) { s.phone = true; s.narrow = true; }
  s.ask.vw = o.phone ? 390 : 1440;
  const st = askStateFixture(o.plan ?? "pro", NOW);
  s.ask.state = { status: "ok", data: o.state ? o.state(st) : st };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = { ...VIEWS };
  return s;
}

// ── conversations ────────────────────────────────────────────────────────────

let seq = 0;
const key = (p: string) => `${p}${++seq}`;

/** A sample image for a question's file card: drawn here (a CI log, red on the failing line). Sample data. */
function sampleShot(): string {
  const c = document.createElement("canvas");
  c.width = 272; c.height = 176;
  const g = c.getContext("2d")!;
  g.fillStyle = "#15171c"; g.fillRect(0, 0, 272, 176);
  g.fillStyle = "#262a33"; g.fillRect(0, 0, 272, 20);
  for (const [i, col] of ["#ff5f57", "#febc2e", "#28c840"].entries()) { g.fillStyle = col; g.beginPath(); g.arc(12 + i * 13, 10, 4, 0, 7); g.fill(); }
  const lines: [string, string][] = [
    ["#8b93a1", "$ npm test"], ["#5ab86c", "✓ status-marks.test.ts (14)"], ["#5ab86c", "✓ repo-picker.test.ts (9)"],
    ["#df7372", "✗ netlify-connect.test.ts (1 failed)"], ["#df7372", "  expected .cnpy-pill to exist"], ["#8b93a1", "Tests  1 failed | 23 passed"],
  ];
  g.font = "11px ui-monospace, Menlo, monospace";
  lines.forEach(([col, t], i) => { g.fillStyle = col; g.fillText(t, 12, 42 + i * 21); });
  return c.toDataURL("image/png");
}
const SHOT = sampleShot();

const att = (id: number, title: string, kind: AskAttachment["kind"], size: number, thumb = false): AskAttachment =>
  ({ id, slug: `sample-${id}`, title, kind, contentType: kind === "image" ? "image/png" : kind === "pdf" ? "application/pdf" : "text/plain", size, sha256: "", ...(thumb ? { thumbUrl: SHOT } : {}) });

function question(text: string, o: { context?: string[]; files?: AskAttachment[]; id?: number | null; command?: AskQuestion["command"] } = {}): AskMsg {
  return { role: "user", key: key("q"), id: o.id === undefined ? 1 : o.id, text, context: o.context ?? [], attachments: o.files ?? [], command: o.command ?? null };
}
const answer = (turn: AskTurn): AskMsg => ({ role: "assistant", key: key("a"), turn });

/** A turn folded from events, exactly as the controller folds a stream (the repository's views carry their facts). */
function fold(events: readonly AskEvent[], mode: AskTurn["mode"] = "smart", now = T): AskTurn {
  let t = newTurn(mode);
  for (const raw of events) {
    const e = withRepoFacts(raw, { refs: R });
    if (e.event === "thread") continue;
    t = foldAskEvent(t, e, now);
  }
  return t;
}
const events = (scenario: AskScenario): AskEvent[] => askTranscript(scenario, NOW).map((s) => s.event);
const ev = <K extends keyof AskEventMap>(event: K, data: AskEventMap[K]): AskEvent => ({ event, data } as AskEvent);

/** The scenario's question and its transcript folded: the conversation the replay would leave on screen. */
function scenarioMsgs(scenario: AskScenario, mode: AskTurn["mode"] = "smart"): AskMsg[] {
  const q = ASK_SCENARIO_QUESTION[scenario];
  const files = (q?.attachments ?? []).map((f, i) => att(950 + i, f.title, f.kind, f.size, f.kind === "image"));
  return [question(q?.text ?? "", { context: q?.context ?? [], files }), answer(fold(events(scenario), mode))];
}

function convo(messages: AskMsg[], o: { busy?: boolean; title?: string } = {}): AskConvo {
  const live = messages.some((m) => m.role === "assistant" && !m.turn.done && !m.turn.error && !m.turn.stopped);
  return { ...emptyConvo(), uid: key("cv"), threadId: 1, title: o.title ?? "Hosting status", status: "ok", messages, busy: o.busy ?? live };
}

/** The Ask page with `messages` as its conversation (`over` adjusts anything else). */
function page(messages: AskMsg[], over: (s: AppState) => void = () => undefined, o: Parameters<typeof app>[0] & { busy?: boolean } = {}): AppState {
  const s = app(o);
  s.ask.page = convo(messages, { busy: o.busy });
  over(s);
  return s;
}
const cv = (s: AppState, where: AskWhere = "page"): string => conversationView(askView(s, where));
const lastAnswerKey = (s: AppState): string => {
  const m = [...s.ask.page.messages].reverse().find((x) => x.role === "assistant");
  return m?.key ?? "";
};

// ── cutting a part out of a real render ──────────────────────────────────────

/** `html` with only the elements matching `sels` (and their ancestors) kept: the part, in its real place. */
function keep(html: string, sels: string | string[], nth?: number): string {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const list = (Array.isArray(sels) ? sels : [sels]).flatMap((s) => Array.from(tpl.content.querySelectorAll(s)));
  const targets = nth === undefined ? list : list.slice(nth, nth + 1);
  if (!targets.length) throw new Error(`gallery: nothing matches ${String(sels)}`);
  const up = new Set<Element>();
  for (const t of targets) for (let n: Element | null = t; n; n = n.parentElement) up.add(n);
  const prune = (p: ParentNode) => {
    for (const c of Array.from(p.children)) {
      if (targets.includes(c)) continue;
      if (up.has(c)) prune(c); else c.remove();
    }
  };
  prune(tpl.content);
  return tpl.innerHTML;
}

/** An open dropdown placed against its trigger by the app's own dropdown controller (`createDropdowns().afterPaint`
 *  measures the laid-out trigger — build.ts loads the app's CSS into this page), in a `w` × `h` box at the window's
 *  corner: the coordinates it writes are the ones the gallery's frame (or fixed stage) will have. */
function placed(html: string, dd: AppState["dd"], w: number, h: number, pad = 0): string {
  const box = document.createElement("div");
  box.setAttribute("data-cnpy-theme", "light");
  box.style.cssText = `position:fixed;left:0;top:0;width:${w}px;height:${h}px;padding:${pad}px;box-sizing:border-box;overflow:hidden;transform:translateZ(0)`;
  box.innerHTML = html;
  document.body.appendChild(box);
  createDropdowns({ state: { dd }, mount: box, rerender: () => undefined, dispatch: () => undefined }).afterPaint();
  const out = box.innerHTML;
  box.remove();
  return out;
}

// ── specimen helpers ─────────────────────────────────────────────────────────

const inline = (id: string, title: string, state: string, where: string, html: string, o: Partial<Spec> = {}): Spec =>
  ({ id, title, state, where, sample: true, kind: "inline", html, ...o });
const desktop = (id: string, title: string, state: string, where: string, s: AppState, o: Partial<Spec> = {}): Spec =>
  ({ id, title, state, where, sample: true, kind: "desktop", html: render(s), h: 900, ...o });
const phone = (id: string, title: string, state: string, where: string, s: AppState, o: Partial<Spec> = {}): Spec =>
  ({ id, title, state, where, sample: true, kind: "phone", html: render(s), h: 844, ...o });

// ── the hosting answer (the design's main scenario), and its pieces ──────────

const HOSTING = () => scenarioMsgs("answer");

// ═════════════════════════════════════════════════════════════════════════════
// Sections
// ═════════════════════════════════════════════════════════════════════════════

function screens(): Section {
  const empty = app();
  const answered = page(HOSTING());
  const streaming = page(scenarioMsgs("streaming"));
  const thinking = page(scenarioMsgs("thinking", "thinking"));
  const pr = page(HOSTING(), (s) => {
    s.ask.inspector = { ...s.ask.inspector, stack: ["ticket:14", "pr:176", "pr:173"], idx: 2 };
    for (const ref of s.ask.inspector.stack) fillItem(s, ref);
    s.ask.threadsForced = false;
  });
  const search = page(scenarioMsgs("search"), (s) => {
    s.ask.threadQ = "netlify";
    s.ask.hits = { status: "ok", data: askSearchFixture(NOW) };
    s.ask.threadMenu = 5;
  }, {});
  const orbMenu = page(HOSTING(), (s) => { s.dd = { open: "ask-orb", opening: false, closing: false }; });
  const drag = page(HOSTING(), (s) => { s.ask.composer.page = { ...s.ask.composer.page, drag: true }; });
  return {
    id: "screens", title: "Whole screens", intro: "The Ask screen as the app draws it at 1440 × 900: the thread list, the conversation and its composer, the inspector. Scaled to fit; “Actual size” shows it 1:1.",
    specs: [
      desktop("scr-new", "A new thread", "Empty: the mark, the headline, the starters; the composer centred", "#ask", empty),
      desktop("scr-answer", "An answered question", "Done: steps, text, table, cards, chart, themes, chain, footer, follow-ups", "#ask/<id>", answered),
      desktop("scr-stream", "Streaming", "Mid-answer: the soft cursor, Send is Stop", "#ask/<id>", streaming),
      desktop("scr-thinking", "Thinking mode", "Done: “Thought for 14s” above the answer", "#ask/<id>", thinking),
      desktop("scr-pr", "The inspector open", "PR #173, opened from #176 from ticket #14 (the trail); the thread list hidden", "#ask/<id>, beside the thread", pr),
      desktop("scr-search", "Searching threads", "“netlify”: hits with the match marked; a row's ⋯ menu open", "The thread list", search),
      desktop("scr-orb", "Thinking animation", "The header's dropdown open: Match what it's doing, then the six orbs", "The Ask header, beside the bug button", orbMenu,
        { html: placed(render(orbMenu), orbMenu.dd, 1440, 900) }),
      desktop("scr-drag", "Dropping files", "Files dragged over the conversation", "The conversation", drag),
    ],
  };
}

/** The inspector's read for `ref` landed (`GET /ask/item/:ref`), from the dev replay's detail fixtures. */
function fillItem(s: AppState, ref: string): void {
  const view = s.ask.refViews[ref] as RefView | undefined;
  const detail = inspectorDetailFixture(ref, T, s.ask.refViews as Record<string, RefView>);
  if (view && detail) s.ask.inspectorUi.items[ref] = { status: "ok", data: { view, detail } };
}

function questions(): Section {
  const plain = page([question("What shipped this week?"), answer(fold(events("search")))]);
  const files = [att(901, "ci-failure.png", "image", 421_888, true), att(902, "deploys-october.csv", "text", 18_432), att(903, "netlify-api.pdf", "pdf", 1_258_291)];
  const rich = page([question("Why does this fail only on main? Compare it with the October deploys.", { context: ["ticket:14", "pr:176"], files })]);
  rich.ask.page.busy = false;
  const ph = page([question("What's blocking the hosting work? This is what I see in CI.", { context: ["ticket:14"], files: [att(904, "ci-failure.png", "image", 421_888)] })]);
  ph.ask.page.busy = false;
  const idle = page([question("What's blocking the hosting work?", { context: ["ticket:14"] })], (s) => { s.ask.page.busy = false; });
  const editing = page([question("What's blocking the hosting work?", { context: ["ticket:14"] })]);
  editing.ask.page.busy = false;
  editing.ask.conversation.editing = { where: "page", key: editing.ask.page.messages[0].key, text: "What's blocking the hosting work, and who owns each part?" };
  const cmd = page([question("netlify", { command: "search" })]);
  cmd.ask.page.busy = false;
  const q = (s: AppState) => keep(cv(s), ".ask-q");
  return {
    id: "question", title: "The question", intro: "The person's message: a right-aligned bubble with its files and context chips above it. Edit shows on hover over the last question (always on a phone).",
    specs: [
      inline("q-plain", "A question", "Plain text", "The conversation", keep(cv(plain), ".ask-q")),
      inline("q-rich", "With files and context", "An image card with its thumbnail, a CSV and a PDF chip, two context chips", "The conversation", q(rich)),
      inline("q-ph", "An image with no thumbnail", "The striped placeholder (no preview yet)", "The conversation", q(ph)),
      inline("q-edit-hover", "Edit (hover)", "The last question, idle: Edit appears on hover (forced visible here)", "The conversation", q(idle), { stage: "gx-hover-edit" }),
      inline("q-editbox", "Edit and resend", "The edit box: “Sending replaces the answer below.”", "The conversation", q(editing)),
      inline("q-command", "A command question", "Sent with /search", "The conversation", q(cmd)),
    ],
  };
}

function steps(): Section {
  const runEvents: AskEvent[] = [
    ev("activity", { step: 1, tool: "query", icon: "search", label: "Searched docs for 'hosting'", state: "run" }),
    ev("activity", { step: 1, state: "done", results: ["doc:hosting-connections", "doc:performance-plan", "doc:release-0-30-notes"], resultLine: "3 results" }),
    ev("activity", { step: 2, tool: "get_ticket", icon: "tickets", label: "Read ticket #14", state: "run" }),
    ev("activity", { step: 2, state: "done", results: ["ticket:14", "sprint:7", "person:maya", "person:andres"] }),
    ev("activity", { step: 3, tool: "get_repo_dashboard", icon: "ci", label: "Checked CI on AndresL230/trov", state: "run" }),
  ];
  const running = page([question("What's blocking the hosting work?"), answer(fold(runEvents))]);
  const searching = page([question("What's blocking the hosting work?"), answer(fold([ev("activity", { step: 1, tool: "query", icon: "search", label: "Searched docs for 'hosting'", state: "run" })]))]);
  const done = page(HOSTING());
  const openS = page(HOSTING(), (s) => { const k = lastAnswerKey(s); s.ask.conversation.open = { [`${k}:s1`]: true, [`${k}:s3`]: true }; });
  const none = page(scenarioMsgs("notfound"));
  const big = page([question("Why is this failing?", { files: [att(905, "ci-full-page.png", "image", 9_800_000)] }), answer(fold([
    ev("activity", { step: 1, tool: "read_attachment", icon: "read", label: "ci-full-page.png is too large for Trov to view, so it was stored but not read.", state: "run" }),
    ev("activity", { step: 1, state: "done", resultLine: "Not read" }),
    ev("activity", { step: 2, tool: "read_attachment", icon: "read", label: "build-log.txt didn't fit in this message, so it was stored but not read.", state: "run" }),
    ev("activity", { step: 2, state: "done", resultLine: "Not read" }),
    ev("activity", { step: 3, tool: "get_repo_dashboard", icon: "ci", label: "Checked CI on AndresL230/trov", state: "run" }),
    ev("activity", { step: 3, state: "done", results: [REPO], resultLine: "1 result" }),
  ]))]);
  const st = (s: AppState) => keep(cv(s), ".ask-steps");
  const stw = (s: AppState) => keep(cv(s), [".ask-steps", ".ask-cur-alone"]);
  return {
    id: "steps", title: "Steps", intro: "What Trov did, one line per tool call, above the answer. A step keeps its own icon; while it runs a sweep of light crosses its words and the wait row under the steps shows the ONE orb (searching for look-ups, working for the rest). A done step with results opens to rows that open in the inspector.",
    specs: [
      inline("st-run", "Running", "Two done, the third running; the wait row under them (orb: working, for a CI read)", "Above the answer", stw(running)),
      inline("st-search", "Running a search", "One step running; the wait row's orb: searching", "Above the answer", stw(searching)),
      inline("st-done", "Done", "Five steps with their result lines", "Above the answer", st(done)),
      inline("st-open", "Results open", "Steps 1 and 3 opened: their rows (the repository row is its CI line)", "Above the answer", st(openS)),
      inline("st-none", "No results", "Three searches that found nothing", "Above the answer", st(none)),
      inline("st-notread", "Files not read", "An image over the model's limit, and a file past the request budget: “Not read”", "The turn's first steps", st(big)),
    ],
  };
}

function thinking(): Section {
  const run = page([question("What's blocking the hosting work?"), answer(fold([
    ...events("thinking").filter((e) => e.event === "activity"),
    ev("thinking", { state: "run" }),
  ], "thinking", T - 7000))]);
  const done = page(scenarioMsgs("thinking", "thinking"));
  const open = page(scenarioMsgs("thinking", "thinking"), (s) => { s.ask.conversation.open = { [`${lastAnswerKey(s)}:think`]: true }; });
  const th = (s: AppState) => keep(cv(s), ".ask-think");
  return {
    id: "thinking", title: "Thinking", intro: "Thinking mode only. While it thinks the clock is an orb (solving) and the client counts the seconds; then “Thought for Ns”, which opens to the summary — never raw thinking.",
    specs: [
      inline("th-run", "Thinking", "Running: “Thinking… 7s” (the gallery counts on)", "Under the steps", th(run)),
      inline("th-done", "Thought for 14s", "Done, closed", "Under the steps", th(done)),
      inline("th-open", "The summary", "Done, opened", "Under the steps", th(open)),
    ],
  };
}

function waiting(): Section {
  const stepsDone = events("answer").filter((e) => e.event === "activity").slice(0, 10);
  const wait = page([question("What's blocking the hosting work?"), answer(fold(stepsDone))]);
  const nothing = page([question("What's blocking the hosting work?"), answer(newTurn("smart"))]);
  const blockOut = page([question("What shipped this week?"), answer(fold([
    ...events("search").filter((e) => e.event === "activity"),
    ev("block", { kind: "items", items: [R["pr:173"], R["pr:171"], R["doc:release-0-30-notes"]] }),
  ]))]);
  const cur = page(scenarioMsgs("streaming"));
  return {
    id: "wait", title: "The wait", intro: "The wait row: while a turn is live and no words are streaming, the one orb and its word sit under the steps for the whole wait, in the sweep of light — “Thinking…” before anything is written (its orb follows the running step: searching for look-ups, else working), “Writing…” once a block is out. It steps aside while words stream (the soft cursor is in them) and while the Thinking row runs.",
    specs: [
      inline("w-first", "Thinking… (nothing yet)", "Sent, nothing back yet (orb: working)", "Under the question", keep(cv(nothing), [".ask-cur-alone"])),
      inline("w-steps", "Thinking… (steps done)", "Every step done, no words yet (orb: working)", "Under the steps", keep(cv(wait), [".ask-steps", ".ask-cur-alone"])),
      inline("w-writing", "Writing…", "A block is out, the words are not (orb: composing)", "Under the block", keep(cv(blockOut), [".ask-parts", ".ask-cur-alone"])),
      inline("w-cursor", "The soft cursor", "Streaming mid-list (the design's token 58)", "At the end of the words", keep(cv(cur), ".ask-parts")),
      inline("w-pinned", "A pinned orb", "The header's pick is Shapes: every orb in Ask is Shapes, the words still say what it does", "Steps and the wait",
        keep(cv(page([question("What's blocking the hosting work?"), answer(fold(events("answer").filter((e) => e.event === "activity").slice(0, 9)))], (s) => { s.ask.orb = "shaping"; })), [".ask-steps", ".ask-cur-alone"])),
    ],
  };
}

const MD_SAMPLE = [
  "Most of the hosting work is moving. What blocks it is narrow: [[ticket:14]] waits on the Netlify connect step, and that step can't merge while one test fails on main.",
  "",
  "## What is blocking",
  "",
  "- The Netlify connect test fails on main since [[pr:173]] changed the status marks it checks.",
  "- [[person:andres]] owns the fix. It isn't filed as a ticket yet.",
  "- Token refresh in [[doc:hosting-connections]] is still described as **automatic**, which is *no longer true*.",
  "",
  "## Next, in order",
  "",
  "1. Update `netlify-connect.test.ts` to assert on the new marks.",
  "2. Merge [[pr:176]], then pick up [[handoff:11]].",
  "3. Close [[sprint:7]] once [[ticket:18]] is in.",
  "",
  "| Ticket | Status | Owner | Waiting on |",
  "| --- | --- | --- | --- |",
  "| [[ticket:14]] | [[ticket:14|status]] | Maya Chen | PR #176 |",
  "| [[ticket:18]] | [[ticket:18|status]] | Andres Lopez | PR #176 |",
  "| [[ticket:19]] | [[ticket:19|status]] | Unassigned | #18 |",
  "| [[ticket:24]] | [[ticket:24|status]] | Priya Natarajan | — |",
  "",
  "Every kind of item links the same way: [[repo:AndresL230/trov]], [[feed:41]], [[artifact:hosting-status-oct-15]], [[person:maya]], [[doc:release-0-30-notes]], [[pr:178]]. A ref Trov hasn't shown in this thread stays plain text: [[decision:7]], [[prompt:triage-bot]].",
  "",
  "```ts",
  "expect(row.querySelector(\".cnpy-mark\")).not.toBeNull();",
  "expect(row.querySelector(\".cnpy-pill\")).toBeNull();",
  "```",
  "",
  "See the [hosting docs](https://trov.dev/docs) for the token rules.",
].join("\n");

function markdown(): Section {
  const turn = fold([ev("text", { delta: MD_SAMPLE }), ev("done", { messageId: 2, questionId: 1, cites: [], tokens: { in: 1, out: 1, cached: 0 } })]);
  const s = page([question("What's blocking the hosting work?"), answer(turn)]);
  const tools = page([question("What's blocking the hosting work?"), answer(turn)]);
  return {
    id: "markdown", title: "Answer text", intro: "Ask's own small markdown reader: headings, paragraphs with bold, italics, code and links, bullet and numbered lists, tables (a `[[ticket:14|status]]` cell is the item's live mark), code blocks, and a ref chip for every kind of item — linked only when a tool returned it this thread.",
    specs: [
      inline("md-all", "Everything the reader draws", "Done", "The answer", keep(cv(s), ".ask-parts")),
      inline("md-tools", "A table's toolbar", "Hovered: Save as artifact · Open in inspector (forced visible here)", "On a table, a chart, the themes, a chain", keep(cv(tools), ".ask-rich[data-rich=table]"), { stage: "gx-show-tools" }),
    ],
  };
}

function blocks(): Section {
  const hosting = page(HOSTING());
  const b = (kind: string) => keep(cv(hosting), `.ask-part[data-block="${kind}"]`);
  const items = (refs: string[]) => keep(cv(page([question("Show me"), answer(fold([ev("block", { kind: "items", items: refs.map((r) => R[r]) }), ev("done", { messageId: 2, questionId: 1, cites: [], tokens: { in: 1, out: 1, cached: 0 } })]))])), ".ask-part[data-block=items]");
  const diagram = (title: string, caption: string, nodes: AskDiagram["nodes"], edges: [string, string][]) => fold([ev("block", { kind: "diagram", diagram: {
    title, caption, layout: "list", nodes, edges } }), ev("done", { messageId: 2, questionId: 1, cites: [], tokens: { in: 1, out: 1, cached: 0 } })]);
  const dg = (t: ReturnType<typeof fold>) => keep(cv(page([question("Show me"), answer(t)])), ".ask-part[data-block=diagram]");
  const N = (id: string, ref: string | null, label: string, eyebrow: string | null = null) => ({ id, eyebrow, label, ref, view: ref ? R[ref] : null });
  const branch = diagram("Who waits on the Netlify step", "Both tickets wait on the PR", [
    N("pr", "pr:176", "#176 Netlify connect step", "Pull request"), N("t14", "ticket:14", "#14 Guided repository setup", "Ticket"),
    N("t18", "ticket:18", "#18 Hosting connections", "Ticket"), N("doc", null, "The Netlify section of the hosting doc", "Doc"),
  ], [["pr", "t14"], ["pr", "t18"], ["t18", "doc"]]);
  const wide = diagram("What the Hosting sprint waits on", "Two roots; #29 skips a layer", [
    N("ci", REPO, "netlify-connect.test", "CI on main"), N("h12", "handoff:12", "Fix the connect test", null),
    N("pr", "pr:176", "#176 Netlify connect step", "Pull request"), N("t14", "ticket:14", "#14 Guided repository setup", "Ticket"),
    N("t18", "ticket:18", "#18 Hosting connections", "Ticket"), N("t29", "ticket:29", R["ticket:29"].title, "Ticket"), N("sprint", "sprint:7", "Hosting, due Oct 30", "Sprint"),
  ], [["ci", "pr"], ["pr", "t14"], ["pr", "t18"], ["h12", "t18"], ["t14", "sprint"], ["t18", "sprint"], ["t29", "sprint"]]);
  const fan = diagram("What #14 waits on", "Three things before it", [
    N("t18", "ticket:18", "#18 Hosting connections", "Ticket"), N("pr", "pr:176", "#176 Netlify connect step", "Pull request"),
    N("h12", "handoff:12", "Fix the connect test", null), N("t14", "ticket:14", "#14 Guided repository setup", "Ticket"),
  ], [["t18", "t14"], ["pr", "t14"], ["h12", "t14"]]);
  const cycle = diagram("A loop", "A cycle is always a list", [
    N("a", "ticket:14", "#14 Guided repository setup", "Ticket"), N("b", "ticket:18", "#18 Hosting connections", "Ticket"), N("c", "pr:176", "#176 Netlify connect step", "Pull request"),
  ], [["a", "b"], ["b", "c"], ["c", "a"]]);
  const chartFew = fold([ev("block", { kind: "chart", chart: { title: "Tickets by status", total: 31, unit: "tickets", query: "tickets_by_status", params: {},
    rows: [{ label: "Triage", value: 9 }, { label: "In progress", value: 7 }, { label: "Testing", value: 4 }, { label: "Done", value: 11 }, { label: "Declined", value: 0 }] } }),
    ev("done", { messageId: 2, questionId: 1, cites: [], tokens: { in: 1, out: 1, cached: 0 } })]);
  const nf = page(scenarioMsgs("notfound"));
  return {
    id: "blocks", title: "Rich blocks", intro: "What a show tool puts in the answer. Every number is the server's; a block (but item cards) has Save as artifact and Open in inspector on hover.",
    specs: [
      inline("b-items3", "Item cards", "Three: a ticket, a PR, a sprint (each opens itself)", "The answer", b("items")),
      inline("b-items-all", "Item cards, every type", "Doc (staged), handoff, repository, feed, person, artifact", "The answer", items(["doc:release-0-30-notes", "handoff:11", REPO, "feed:41", "person:priya", "artifact:hosting-status-oct-15"])),
      // ONE item is its own layout (ask-one.ts): the identity on the left, the type's facts on the right; under 560px
      // (a phone, the ⌘J panel) the facts stack under it.
      ...([["ticket:29", "Ticket", "Status, priority, assignees, sprint; its body under the title"],
        ["pr:176", "Pull request", "State, checks, author, branch; its What under the title"],
        ["doc:hosting-connections", "Doc", "Status, owner, space, version; its excerpt"],
        ["decision:7", "Decision", "Status, author, when it was proposed; the decision"],
        ["feed:41", "Feed entry", "Kind, author, posted; its brief"],
        ["sprint:7", "Sprint", "Status, dates, progress as a bar and “n of m done”, lead; its summary"],
        ["handoff:11", "Handoff", "Status, from, to, sent; its task"],
        ["artifact:hosting-status-oct-15", "Artifact", "Visibility, state, kind, version, author"],
        ["person:andres", "Person", "The picture, name and handle, the role; open tickets, what they are working on"],
        ["prompt:release-notes", "Prompt", "Status, author, slug; its description"],
        [REPO, "Repository", "Each environment's verdict (the Overview's), what needs attention; the head's checks"],
      ] as const).map(([ref, word, state]) => inline(`b-one-${ref.split(":")[0]}`, `One item: ${word.toLowerCase()}`, state, "The answer", items([ref]))),
      inline("b-one-narrow", "One item, narrow", "Under 560px (a phone, the ⌘J panel) the facts stack under the identity", "The ⌘J panel", items(["ticket:29"]), { w: 388 }),
      inline("b-one-narrow-sprint", "One item, narrow: a sprint", "The progress bar keeps its words", "The ⌘J panel", items(["sprint:7"]), { w: 388 }),
      inline("b-chart", "Bar chart", "Merged PRs by week (8 weeks)", "The answer", b("chart")),
      inline("b-chart2", "Bar chart, not weekly", "Tickets by status, a zero bar", "The answer", keep(cv(page([question("Show me"), answer(chartFew)])), ".ask-part[data-block=chart]")),
      inline("b-themes", "Theme strip", "Four lanes × eight weeks, tinted by share", "The answer", b("themes")),
      inline("b-chain", "Dependency chain", "Left → right: four nodes, each opens its item; the root (the repository's verdict) is emphasised", "The answer", b("diagram")),
      inline("b-graph", "Branching diagram", "A fan-out drawn as parallel lanes; the parent centres on its children", "The answer", dg(branch)),
      inline("b-graph-wide", "A bigger graph", "Two roots, a fan-in, an edge that skips a layer (it routes through an empty slot)", "The answer", dg(wide)),
      inline("b-fanin", "Fan-in", "Three things one ticket waits on", "The answer", dg(fan)),
      inline("b-chain-panel", "Chain, narrow", "At the ⌘J panel's width the chain runs top → bottom", "The ⌘J panel", b("diagram"), { w: 380 }),
      inline("b-graph-panel", "Branching, narrow", "Top → bottom with two lanes", "The ⌘J panel", dg(branch), { w: 380 }),
      inline("b-list", "Diagram as a list", "Too narrow for its lanes (three, on a phone): a timeline in order", "A phone", dg(fan), { w: 340 }),
      inline("b-cycle", "A cycle", "Can't be laid out: always the timeline", "The answer", dg(cycle)),
      inline("b-notfound", "Not found", "“I couldn't find that in Trov.”, the tries, What I searched", "The answer", keep(cv(nf), ".ask-part[data-block=not_found]")),
      inline("b-tools", "A block's toolbar", "Hovered (forced visible here)", "On a chart", b("chart"), { stage: "gx-show-tools" }),
    ],
  };
}

// ── write cards ──────────────────────────────────────────────────────────────

type ActionEv = AskEventMap["action"];
const askCards = (): ActionEv[] => events("actions-ask").filter((e): e is { event: "action"; data: ActionEv } => e.event === "action").map((e) => e.data);
const autoEvents = (): AskEvent[] => events("actions-auto");

/** More kinds than the transcripts carry, previewed as the server's `card()` titles them (src/ai/ask/actions.ts). */
function moreCards(): ActionEv[] {
  return [
    { id: 61, groupId: "g-61", tool: "transition_ticket", kind: "move", state: "proposed", note: null,
      preview: { title: "Move #14 to Testing", lines: [{ label: "Status", value: "In progress → Testing" }], item: R["ticket:14"] }, fields: { id: 14, to: "testing" }, editable: [] },
    { id: 62, groupId: "g-62", tool: "create_sprint", kind: "sprint", state: "proposed", note: null,
      preview: { title: "New sprint: Billing", lines: [{ label: "Start", value: "2026-11-02" }, { label: "Due", value: "2026-11-20" }, { label: "Lead", value: "@priya" }, { label: "Summary", value: "Stripe checkout, the plan page and the seat count." }], item: null },
      fields: { label: "Billing" }, editable: [] },
    { id: 63, groupId: "g-63", tool: "add_ticket_comment", kind: "other", state: "proposed", note: null,
      preview: { title: "Comment on #14", lines: [{ label: "Comment", value: "The connect step is blocked on the netlify-connect test; the fix is in handoff #12." }], item: R["ticket:14"] }, fields: { id: 14 }, editable: [] },
    { id: 64, groupId: "g-64", tool: "update_plan", kind: "other", state: "waiting", note: "Changing the roadmap plan waits for you, even on Auto.",
      preview: { title: "Update the roadmap plan", lines: [{ label: "Narrative", value: "Hosting lands first, then billing; the perf work rides along." }, { label: "Sprints", value: "Hosting, Billing" }], item: null }, fields: {}, editable: [] },
    { id: 65, groupId: "g-65", tool: "complete_sprint", kind: "sprint", state: "waiting", note: "Completing a sprint waits for you, even on Auto.",
      preview: { title: "Complete Hosting", lines: [{ label: "Status", value: "active → done" }], item: R["sprint:7"] }, fields: { id: 7 }, editable: [] },
    { id: 66, groupId: "g-66", tool: "create_ticket", kind: "ticket", state: "waiting", note: "Auto runs up to 5 changes per answer.",
      preview: { title: "New ticket", lines: [{ label: "Title", value: "Rename status helpers to marks" }, { label: "Category", value: "chore" }, { label: "Priority", value: "low" }], item: null },
      fields: { title: "Rename status helpers to marks", category: "chore", priority: "low", assignee: null }, editable: ["title", "category", "priority", "assignee"] },
  ];
}

/** One answer holding `actions` (folded as `action` events), then each card moved to its state by the decision the
 *  server would send (`action_result`), the way Confirm / Cancel / Undo's answers fold in. */
function cardsAnswer(cards: ActionEv[], decide: Record<number, AskEventMap["action_result"]["state"] | "expired" | "running"> = {}, results: Record<number, unknown> = {}): AskTurn {
  let t = fold([...cards.map((c) => ev("action", c)), ev("done", { messageId: 4, questionId: 3, cites: [], tokens: { in: 1, out: 1, cached: 0 } })]);
  const at = new Date(T - 4 * 60_000).toISOString();
  for (const c of cards) {
    const d = decide[c.id];
    if (!d) continue;
    if (d === "expired" || d === "running") {
      t = { ...t, actions: { ...t.actions, [c.id]: { ...t.actions[c.id], state: d } } };
      continue;
    }
    const w = REPLAY_WRITES[c.id] ?? DEFAULT_WRITES[c.id];
    t = foldAskEvent(t, ev("action_result", { id: c.id, groupId: c.groupId, tool: c.tool, kind: c.kind, preview: c.preview, state: d,
      result: results[c.id] ?? (d === "failed" ? { error: "The ticket was moved by someone else a moment ago." } : w?.result ?? null),
      ref: d === "confirmed" || d === "auto" || d === "undone" ? w?.ref ?? null : null, undo: d === "confirmed" || d === "auto", at }), T);
  }
  return t;
}
const DEFAULT_WRITES: Record<number, { ref: string; result: unknown }> = {
  46: { ref: "doc:release-0-30-notes", result: { outcome: "promoted" } },
  61: { ref: "ticket:14", result: { id: 14, status: "testing" } },
  62: { ref: "sprint:8", result: { id: 8, label: "Billing" } },
  63: { ref: "ticket:14", result: { id: 14 } },
  64: { ref: "", result: {} },
  65: { ref: "sprint:7", result: { id: 7 } },
  66: { ref: "ticket:33", result: { id: 33, title: "Rename status helpers to marks" } },
};

function cardSpec(id: string, title: string, state: string, cards: ActionEv[], o: { decide?: Parameters<typeof cardsAnswer>[1]; results?: Record<number, unknown>; over?: (s: AppState, k: string) => void; stage?: string } = {}): Spec {
  const s = page([question("Draft the follow-ups."), answer(cardsAnswer(cards, o.decide, o.results))]);
  o.over?.(s, lastAnswerKey(s));
  return inline(id, title, state, "The answer, where the model called the write", keep(cv(s), ".ask-parts .ask-part"), o.stage ? { stage: o.stage } : {});
}

function cards(): Section {
  const [ticket, handoff, doc] = askCards();
  const publish = autoEvents().find((e): e is { event: "action"; data: ActionEv } => e.event === "action")!.data;
  const blocked: ActionEv = { ...publish, id: 47, state: "proposed", note: null, preview: { ...publish.preview, canPublish: false } };
  const [move, sprint, comment, plan, complete, capped] = moreCards();
  const moveSprint: ActionEv = { id: 67, groupId: "g-67", tool: "set_ticket_sprint", kind: "move", state: "proposed", note: null,
    preview: { title: "Move #14 to Billing", lines: [{ label: "Sprint", value: "Hosting → Billing" }], item: R["ticket:14"] }, fields: {}, editable: [] };
  const editTicket: ActionEv = { id: 68, groupId: "g-68", tool: "edit_ticket", kind: "ticket", state: "proposed", note: null,
    preview: { title: "Edit #14", lines: [{ label: "Title", value: `${R["ticket:14"].title} → Connect Netlify and Vercel from Org settings` }], item: R["ticket:14"] },
    fields: { title: "Connect Netlify and Vercel from Org settings", body: null }, editable: ["title"] };
  const group: ActionEv[] = [
    { ...ticket, id: 71, groupId: "g-7", fields: { ...ticket.fields }, editable: [] },
    { ...ticket, id: 72, groupId: "g-7", preview: { ...ticket.preview, lines: [{ label: "Title", value: "Remove the pill styles left in trov.css" }, { label: "Category", value: "chore" }, { label: "Priority", value: "low" }] }, fields: { title: "Remove the pill styles left in trov.css", category: "chore", priority: "low", assignee: "priya" }, editable: [] },
    { ...ticket, id: 73, groupId: "g-7", preview: { ...ticket.preview, lines: [{ label: "Title", value: "Rename status helpers to marks" }, { label: "Category", value: "chore" }, { label: "Priority", value: "low" }] }, fields: { title: "Rename status helpers to marks", category: "chore", priority: "low", assignee: null }, editable: [] },
  ];
  const groupRes = { 71: { id: 30, title: "Reconnect expired hosting tokens from Org settings" }, 72: { id: 31, title: "Remove the pill styles" }, 73: { id: 32, title: "Rename status helpers" } };
  Object.assign(DEFAULT_WRITES, { 71: { ref: "ticket:30", result: groupRes[71] }, 72: { ref: "ticket:31", result: groupRes[72] }, 73: { ref: "ticket:32", result: groupRes[73] } });
  const autoT = fold(autoEvents());
  const autoS = page([question(ASK_SCENARIO_QUESTION["actions-auto"]!.text), answer(autoT)]);
  const prior = page(replayPriorExchange(false, new Date(T - 20 * 60_000).toISOString()));
  const priorAuto = page(replayPriorExchange(true, new Date(T - 20 * 60_000).toISOString()));
  // Edited in place: the person's drafts on the card, and (`field`) the text open as an input.
  const editedOf = (cid: number, drafts: Record<string, unknown> = {}, field?: string) => (s: AppState) => {
    s.ask.actions.drafts = { [cid]: drafts };
    if (field) s.ask.actions.inline = { [cid]: { field, was: null, had: false } };
  };
  return {
    id: "cards", title: "Write cards", intro: "A write never runs when the model calls it: the server builds a card from Trov's rows and it waits for Confirm (or runs at once on Auto). After the decision the card becomes a line. Consecutive calls to one tool are one card, one Confirm, one Undo.",
    specs: [
      cardSpec("c-ticket", "New ticket", "Pending: “Draft, not created yet”, Edit, Cancel, Confirm", [ticket]),
      cardSpec("c-ticket-edit", "New ticket — edited inline", "Priority cycled to Normal, the assignee picked, the title open as an input (no Edit mode)", [ticket], { over: editedOf(31, { priority: "normal", assignee: "maya" }, "title") }),
      cardSpec("c-ticket-run", "New ticket — confirming", "Confirm pressed: “Working…”, every button disabled", [ticket], { over: (s) => { s.ask.actions.busy = { 31: true }; } }),
      cardSpec("c-handoff", "New handoff", "Pending: from → to, the task, Done / Next, files", [handoff]),
      cardSpec("c-handoff-edit", "New handoff — edited inline", "Send to picked (Maya), the task open as an input", [handoff], { over: editedOf(32, { recipient: "maya" }, "task") }),
      cardSpec("c-doc", "Doc edit", "Pending: the version step, the hunk under its heading (− / +)", [doc]),
      cardSpec("c-doc-edit", "Doc edit — edited inline", "The + text clicked: a textarea that looks like it", [doc], { over: editedOf(33, {}, "hunk:0") }),
      cardSpec("c-publish", "Publish a staged doc", "Waiting (Auto never publishes): the note, Confirm", [publish]),
      cardSpec("c-publish-no", "Publish — not allowed", "canPublish false: “Open in Review” instead of Confirm", [blocked]),
      cardSpec("c-move", "Move a ticket", "Pending: one row — the ticket, In progress → Testing, Cancel / Confirm", [move]),
      cardSpec("c-move-sprint", "Move a ticket to a sprint", "Pending: the ticket, Hosting → Billing", [moveSprint]),
      cardSpec("c-edit-ticket", "Edit a ticket", "Pending: the ticket, its new title (edits in place)", [editTicket]),
      cardSpec("c-sprint", "New sprint", "Pending", [sprint]),
      cardSpec("c-other", "Any other write", "Pending: a comment", [comment]),
      cardSpec("c-plan", "Waiting for you", "Auto on, Confirm-only: the roadmap plan", [plan]),
      cardSpec("c-complete", "Waiting for you", "Auto on, Confirm-only: completing a sprint", [complete]),
      cardSpec("c-cap", "Waiting for you", "Auto on, past the cap of 5 per answer", [capped]),
      cardSpec("c-group", "A group", "Three tickets, one card, one Confirm", group),
      cardSpec("l-done", "Done", "Confirmed: linked, a time, Undo", [ticket], { decide: { 31: "confirmed" } }),
      cardSpec("l-done-h", "Done — handoff", "Confirmed", [handoff], { decide: { 32: "confirmed" } }),
      cardSpec("l-done-doc", "Done — doc edit", "Proposed: it waits in Review (no Undo)", [doc], { decide: { 33: "confirmed" }, results: { 33: { outcome: "staged" } } }),
      cardSpec("l-done-move", "Done — move", "Confirmed", [move], { decide: { 61: "confirmed" } }),
      cardSpec("l-done-pub", "Done — published", "Confirmed", [publish], { decide: { 46: "confirmed" } }),
      cardSpec("l-group", "Done — a group", "“Filed tickets #30, #31 and #32”, one Undo", group, { decide: { 71: "confirmed", 72: "confirmed", 73: "confirmed" } }),
      cardSpec("l-done-sprint", "Done — new sprint", "Confirmed", [sprint], { decide: { 62: "confirmed" } }),
      cardSpec("l-done-other", "Done — any other write", "Confirmed: a comment", [comment], { decide: { 63: "confirmed" } }),
      cardSpec("l-done-plan", "Done — the plan", "Confirmed (no item to link)", [plan], { decide: { 64: "confirmed" } }),
      cardSpec("l-done-complete", "Done — sprint completed", "Confirmed", [complete], { decide: { 65: "confirmed" } }),
      cardSpec("l-undoing", "Undoing", "Undo pressed: “Undoing…”", [ticket], { decide: { 31: "confirmed" }, over: (s) => { s.ask.actions.busy = { 31: true }; } }),
      cardSpec("l-refused", "Undo refused", "409 changed: “Changed since. Undo it by hand.” and a link", [move], { decide: { 61: "confirmed" }, over: (s) => { s.ask.actions.refused = { 61: { message: "Changed since. Undo it by hand.", ref: "ticket:14" } }; } }),
      cardSpec("l-undone", "Undone", "Undo went through", [ticket], { decide: { 31: "undone" } }),
      cardSpec("l-undone-h", "Undone — handoff", "Expired while unclaimed", [handoff], { decide: { 32: "undone" } }),
      cardSpec("l-cancel", "Cancelled", "Cancel pressed", [handoff], { decide: { 32: "cancelled" } }),
      cardSpec("l-cancel-group", "Cancelled — a group", "One line for the group", group, { decide: { 71: "cancelled", 72: "cancelled", 73: "cancelled" } }),
      cardSpec("l-mixed", "A group, decided apart", "Each card edited alone: one created, the rest cancelled", group, { decide: { 71: "confirmed", 72: "cancelled", 73: "cancelled" } }),
      cardSpec("l-expired", "Expired", "The next turn started first", [doc], { decide: { 33: "expired" } }),
      cardSpec("l-failed", "Didn't work", "The write was refused; the server's reason", [move], { decide: { 61: "failed" } }),
      inline("l-auto", "Auto", "Five writes ran on their own; the sixth (Publish) waits", "The answer", keep(cv(autoS), ".ask-parts")),
      inline("l-prior", "An earlier exchange", "A confirmed line and a cancelled one (the replay's prior turn)", "Above the newest answer", keep(cv(prior), ".ask-parts")),
      inline("l-prior-auto", "An earlier Auto exchange", "Its lines, one undone", "Above the newest answer", keep(cv(priorAuto), ".ask-parts")),
    ],
  };
}

// ── assignments (assign_ticket, claim_handoff) ───────────────────────────────

/** An `assign_ticket` card as the server previews it (src/ai/ask/actions.ts: `Assign @h to #id`, the Assignee line,
 *  the ticket's RefView — whose `extra.assignees` is who is on it now). */
const asgCard = (id: number, group: string, num: number, login: string, on: boolean, item: RefView = R[`ticket:${num}`]): ActionEv => ({
  id, groupId: group, tool: "assign_ticket", kind: "ticket", state: "proposed", note: null,
  preview: { title: on ? `Assign @${login} to #${num}` : `Remove @${login} from #${num}`, lines: [{ label: "Assignee", value: `${on ? "Add" : "Remove"} @${login}` }], item },
  fields: { id: num, login, on }, editable: ["login"],
});
/** What Confirm answers for it: the ticket, and who is on it after. */
function asgWrite(c: ActionEv): void {
  const f = c.fields as { id: number; login: string; on: boolean };
  const before = (c.preview.item?.extra.assignees as string[] | undefined) ?? [];
  DEFAULT_WRITES[c.id] = { ref: `ticket:${f.id}`, result: { assignees: f.on ? [...before, f.login] : before.filter((h) => h !== f.login) } };
}

function assignments(): Section {
  const add = asgCard(91, "g-91", 18, "maya", true);                       // #18: Andres stays, Maya joins
  const addNone = asgCard(92, "g-92", 19, "jon", true);                    // #19: nobody on it yet
  const rmLast = asgCard(93, "g-93", 24, "priya", false);                  // #24: Priya was the only one
  const rmOther = asgCard(94, "g-94", 14, "andres", false);                // #14: Maya stays
  const rep = [asgCard(95, "g-95", 18, "andres", false), asgCard(96, "g-95", 18, "maya", true)];   // #18: Andres → Maya
  const many = [asgCard(97, "g-97", 19, "priya", true), asgCard(98, "g-97", 29, "priya", true)];   // one person, two tickets
  const handoff: RefView = { ...R["handoff:11"], extra: { ...R["handoff:11"].extra, from: "maya" } };
  const claim: ActionEv = { id: 99, groupId: "g-99", tool: "claim_handoff", kind: "handoff", state: "proposed", note: null,
    preview: { title: "Claim handoff #11", lines: [{ label: "Title", value: handoff.title }, { label: "From", value: "@maya" }], item: handoff }, fields: { id: 11 }, editable: [] };
  for (const c of [add, addNone, rmLast, rmOther, ...rep, ...many]) asgWrite(c);
  DEFAULT_WRITES[99] = { ref: "handoff:11", result: { id: 11, claimed_by: "andres" } };
  // The picker open: the card's trigger and its menu (a root overlay in the app), placed by the app's dropdown code.
  const picker = (c: ActionEv, h: number) => {
    const s = page([question("Give #18 to Maya too."), answer(cardsAnswer([c]))]);
    s.dd = { open: `ask-ac-asg-${c.id}`, opening: false, closing: false };
    return placed(`${keep(cv(s), ".ask-parts .ask-part")}${dropdownMenu(actionDropdowns(s), s.dd)}`, s.dd, 720, h);
  };
  return {
    id: "assign", title: "Assignment cards", intro: "Assigning a ticket (assign_ticket — consecutive calls are one card) or claiming a handoff reads as an assignment: the item with its status mark, then the people with their avatars — from → to for a replacement, “Unassigned” at either end, “Adds” / “Removes” beside whoever stays. Edit picks the person with the app's dropdown; the line says what happened in names.",
    specs: [
      cardSpec("a-add", "Add beside someone", "Pending: “Adds Maya Chen · Andres Lopez stays on it”", [add]),
      cardSpec("a-add-none", "Add to an unassigned ticket", "Pending: Unassigned → Jon Park", [addNone]),
      cardSpec("a-rm-other", "Remove beside someone", "Pending: “Removes Andres Lopez · Maya Chen stays on it”", [rmOther]),
      cardSpec("a-rm-last", "Remove the last one", "Pending: Priya Natarajan → Unassigned (no Edit: nobody else to pick)", [rmLast]),
      cardSpec("a-replace", "Replace", "Pending: two writes on one ticket, one card — Andres Lopez → Maya Chen", rep),
      cardSpec("a-many", "One person, two tickets", "Pending: a card per ticket in one frame, one Confirm", many),
      cardSpec("a-edit", "Edited inline", "Another person picked in the dropdown (Jon Park)", [add], { over: (s) => { s.ask.actions.drafts = { 91: { login: "jon" } }; } }),
      inline("a-picker", "Editing, the picker open", "The menu: every member who could take it, with avatars (not Andres — already on it)", "The answer; the menu over it",
        picker(add, 420), { w: 720, h: 420, stage: "gx-fixed gx-block" }),
      inline("a-picker-rm", "Editing a removal, the picker open", "Only the people on it now", "The answer; the menu over it",
        picker(rmOther, 360), { w: 720, h: 360, stage: "gx-fixed gx-block" }),
      cardSpec("a-busy", "Confirming", "Confirm pressed: “Working…”", [add], { over: (s) => { s.ask.actions.busy = { 91: true }; } }),
      cardSpec("a-done", "Done — added", "“Assigned ticket #18 to Maya Chen”, Undo", [add], { decide: { 91: "confirmed" } }),
      cardSpec("a-done-none", "Done — added to an unassigned ticket", "Confirmed", [addNone], { decide: { 92: "confirmed" } }),
      cardSpec("a-done-rm", "Done — removed", "“Took Priya Natarajan off ticket #24”", [rmLast], { decide: { 93: "confirmed" } }),
      cardSpec("a-done-rep", "Done — replaced", "“Reassigned ticket #18 from Andres Lopez to Maya Chen”, one Undo for both halves", rep, { decide: { 95: "confirmed", 96: "confirmed" } }),
      cardSpec("a-done-many", "Done — two tickets", "“Assigned tickets #19 and #29 to Priya Natarajan”", many, { decide: { 97: "confirmed", 98: "confirmed" } }),
      cardSpec("a-auto", "Done on Auto", "Ran at once", [add], { decide: { 91: "auto" } }),
      cardSpec("a-cancel", "Cancelled", "Cancel pressed", [add], { decide: { 91: "cancelled" } }),
      cardSpec("a-cancel-rep", "Cancelled — a replacement", "One line for both halves", rep, { decide: { 95: "cancelled", 96: "cancelled" } }),
      cardSpec("a-undone", "Undone", "Undo went through", [add], { decide: { 91: "undone" } }),
      cardSpec("a-undone-rep", "Undone — a replacement", "Both halves undone", rep, { decide: { 95: "undone", 96: "undone" } }),
      cardSpec("a-failed", "Didn't work", "The write was refused; the server's reason", [add], { decide: { 91: "failed" }, results: { 91: { error: "Maya Chen is not a member of this organization any more." } } }),
      cardSpec("a-expired", "Expired", "The next turn started first", [add], { decide: { 91: "expired" } }),
      cardSpec("a-claim", "Claim a handoff", "Pending: the handoff, Maya Chen → you, “No one else can claim it after”", [claim]),
      cardSpec("a-claim-busy", "Claim — confirming", "“Working…”", [claim], { over: (s) => { s.ask.actions.busy = { 99: true }; } }),
      cardSpec("a-claim-done", "Claim — done", "“Claimed handoff #11”", [claim], { decide: { 99: "confirmed" } }),
      cardSpec("a-claim-cancel", "Claim — cancelled", "Cancel pressed", [claim], { decide: { 99: "cancelled" } }),
    ],
  };
}

function saving(): Section {
  const formT = fold(events("artifact"));
  const savedT = fold(events("artifact-saved"));
  const form = page([question("save this as a doc"), answer(formT)]);
  const org = page([question("save this as a doc"), answer(formT)], (s) => { s.ask.actions.forms = { [`${lastAnswerKey(s)}|0`]: { visibility: "org", kind: "markdown" } }; });
  const busy = page([question("save this as a doc"), answer(formT)], (s) => { s.ask.actions.saving = { [`${lastAnswerKey(s)}|0`]: true }; });
  const untitled = page([question("save this as a doc"), answer(formT)], (s) => { s.ask.actions.forms = { [`${lastAnswerKey(s)}|0`]: { title: "" } }; });
  const saved = page([question("save this as a doc"), answer(savedT)]);
  const autoSaved = page([question("save this as a doc"), answer(fold([ev("action_result", { id: 81, groupId: "g-81", tool: "save_artifact", kind: "other",
    preview: { title: "Save as artifact", lines: [], item: null }, state: "auto", result: { slug: "hosting-status-oct-15", title: "Hosting status, Oct 15", visibility: "private" },
    ref: "artifact:hosting-status-oct-15", undo: true, at: new Date(T - 60_000).toISOString() }), ev("done", { messageId: 8, questionId: 7, cites: [], tokens: { in: 1, out: 1, cached: 0 } })]))]);
  const f = (s: AppState) => keep(cv(s), ".ask-part .ask-acts");
  return {
    id: "save", title: "Save as artifact", intro: "The footer's (or a block's) Save as artifact adds a form under the answer — no model call. Saved, it becomes a line with Open; on Auto the model's save_artifact saves at once, with Undo.",
    specs: [
      inline("sv-form", "The form", "Title, Kind (HTML page), Who can see it (Private)", "Under the answer", f(form)),
      inline("sv-org", "The form — Org, Markdown", "Org picked: the hint names the org", "Under the answer", f(org)),
      inline("sv-empty", "The form — no title", "Save disabled", "Under the answer", f(untitled)),
      inline("sv-busy", "Saving", "“Saving…”", "Under the answer", f(busy)),
      inline("sv-saved", "Saved", "“Saved as artifact: … · Private”, Open", "Under the answer", f(saved)),
      inline("sv-auto", "Saved on Auto", "The line with a time, Open and Undo", "Under the answer", keep(cv(autoSaved), ".ask-part .ask-acts")),
    ],
  };
}

function footer(): Section {
  const ft = (s: AppState) => keep(cv(s), [".ask-foot-w"]);
  const k = (s: AppState) => lastAnswerKey(s);
  const base = page(HOSTING());
  const src = page(HOSTING(), (s) => { s.ask.conversation.open = { [`${k(s)}:src`]: true }; });
  const copied = page(HOSTING(), (s) => { s.ask.conversation.copied = `page:${k(s)}`; });
  const regen = page(HOSTING(), (s) => { s.ask.conversation.regen = `page:${k(s)}`; });
  const wrong = page(HOSTING(), (s) => { s.ask.actions.wrongOpen = { [k(s)]: true }; });
  const fast = page([question("What's blocking the hosting work?"), answer(fold(events("answer"), "fast"))]);
  const thinkingS = page(scenarioMsgs("thinking", "thinking"));
  const free = page(HOSTING(), () => undefined, { plan: "free" });
  const noSrc = page(scenarioMsgs("notfound"));
  return {
    id: "footer", title: "The footer", intro: "Under every finished answer: the Trov mark and the mode, the sources, Copy, Regenerate (with another mode on Pro), Save as artifact and Wrong?.",
    specs: [
      inline("f-smart", "Smart", "Seven sources, closed", "Under the answer", ft(base)),
      inline("f-fast", "Fast", "The mode word", "Under the answer", ft(fast)),
      inline("f-think", "Thinking", "The mode word", "Under the answer", ft(thinkingS)),
      inline("f-free", "Free plan", "One mode: no “Regenerate with” caret", "Under the answer", ft(free)),
      inline("f-none", "No sources", "Nothing cited", "Under the answer", ft(noSrc)),
      inline("f-src", "Sources open", "The numbered list; each row opens in the inspector", "Under the answer", ft(src)),
      inline("f-copied", "Copied", "Copy pressed (for 1.6s)", "Under the answer", ft(copied)),
      inline("f-regen", "Regenerate with", "The menu: the plan's modes, the current one checked", "Above the footer", ft(regen), { stage: "gx-pad-top-menu" }),
      inline("f-wrong", "Wrong?", "Open: the three reasons", "Under the footer", ft(wrong)),
      inline("f-flags", "Wrong?, in Review", "What the reasons add to a cited doc's Review detail (askFlagsLine)", "Review › a doc or decision", `<div style="padding:4px 22px 18px">${askFlagsLine([
        { ref: "doc:hosting-connections", reason: "out_of_date", count: 1, lastAt: NOW.toISOString() },
        { ref: "doc:hosting-connections", reason: "source_wrong", count: 2, lastAt: NOW.toISOString() },
      ])}</div>`),
    ],
  };
}

function endings(): Section {
  const follow = page(HOSTING());
  const stoppedT = (() => {
    const evs = askTranscript("streaming", NOW).map((x) => x.event);
    return fold([...evs, ev("done", { messageId: 2, questionId: 1, cites: [R["ticket:14"], R["pr:173"]], tokens: { in: 1, out: 1, cached: 0 }, stopped: true })]);
  })();
  const stopped = page([question("What's blocking the hosting work?"), answer(stoppedT)]);
  const errOf = (code: "failed" | "timeout" | "too_large" | "no_key" | "capped" | "off", partial: boolean) => {
    const evs = partial ? events("streaming").slice(0, 20) : [];
    return page([question("What's blocking the hosting work?"), answer(fold([...evs, ev("error", { code, message: "" })]))]);
  };
  return {
    id: "endings", title: "How an answer ends", intro: "How an answer ends: up to three follow-ups under the last answer; Stopped when the person pressed Stop; the error line when the stream ended early (every error code draws the same line — capped and off also block the composer, below).",
    specs: [
      inline("e-follow", "Follow-ups", "Three suggestions under the last answer", "Under the footer", keep(cv(follow), ".ask-follow")),
      inline("e-stopped", "Stopped", "“Stopped. The answer above is partial.”", "Where the answer stopped", keep(cv(stopped), [".ask-stopped", ".ask-foot-w"])),
      inline("e-error", "Error", "failed, after some steps: “Something went wrong. Nothing was changed.” Try again", "Under the answer", keep(cv(errOf("failed", true)), [".ask-steps", ".ask-err"])),
      inline("e-error0", "Error before anything", "timeout with nothing streamed", "Under the question", keep(cv(errOf("timeout", false)), ".ask-a")),
      inline("e-nokey", "No key (no_key)", "The same error line — no dedicated message", "Under the question", keep(cv(errOf("no_key", false)), ".ask-a")),
      inline("e-capped", "Capped (capped)", "The error line; the composer shows the quota block", "Under the question", keep(cv(errOf("capped", false)), ".ask-a")),
    ],
  };
}

function emptyState(): Section {
  const s = app();
  const custom = app({ state: (st) => ({ ...st, starters: ["What's left on ticket #14?", "How is the Hosting sprint going?", "What's waiting on me?", "What did Maya ship this week?"] }) });
  const panel = app();
  panel.screen = "mywork";
  panel.ask.cmdj = { open: true, contextRef: "ticket:14" };
  panel.ask.composer.panel = { ...panel.ask.composer.panel, context: ["ticket:14"] };
  return {
    id: "empty", title: "A new thread", intro: "Before the first question: the mark, the headline and four starters — from the server's rules (the person's top ticket, the active sprint, what waits on them), the design's four as the fallback.",
    specs: [
      inline("em-page", "The empty state", "The fallback starters", "#ask (a new thread)", emptyView(askView(s, "page"))),
      inline("em-rules", "The empty state", "Starters from the person's own work", "#ask (a new thread)", emptyView(askView(custom, "page"))),
      inline("em-panel", "In the ⌘J panel", "One column of starters (panel width), the page's item as context", "The ⌘J panel", keep(render(panel), ".ask-panel"), { w: 420, h: 640, stage: "gx-fixed" }),
    ],
  };
}

// ── the composer ─────────────────────────────────────────────────────────────

function composerSpecs(): Section {
  const look = { views: VIEWS, persons: PEOPLE };
  const file = (k: string, name: string, size: number, kind: ComposerFile["kind"], state: ComposerFile["state"], id: number, thumb = false): ComposerFile =>
    ({ key: k, name, size, kind, state, preview: thumb ? SHOT : null, att: state === "ready" && kind ? att(id, name, kind, size, thumb) : null });
  const co = (s: AppState, where: AskWhere = "page") => composerView(askView(s, where));
  const withUi = (over: Partial<AppState["ask"]["composer"]["page"]>, o: Parameters<typeof app>[0] = {}, msgs: AskMsg[] | null = HOSTING(), busy?: boolean) => {
    const s = msgs ? page(msgs, () => undefined, { ...o, busy }) : app(o);
    s.ask.composer.page = { ...s.ask.composer.page, ...over };
    return s;
  };
  const files = [file("f0", "ci-failure.png", 421_888, "image", "ready", 901, true), file("f1", "deploys-october.csv", 18_432, "text", "ready", 902), file("f2", "netlify-api.pdf", 1_258_291, "pdf", "uploading", 903)];
  const at = (q: string, sel: number, status: "ok" | "loading" = "ok") => withUi({ text: `What changed in @${q}`, picker: { kind: "@", q, at: 16, sel, hits: status === "ok" ? knownHits(look, q) : [], status } });
  return {
    id: "composer", title: "The composer", intro: "One per conversation. Every limit and flag comes from GET /ask/state. Files upload on attach; @ searches the org, / is the five commands; the mode menu (Pro) and the Ask before changes / Auto switch are remembered per thread.",
    specs: [
      inline("co-centre", "Centred", "An empty conversation: the disclaimer under it", "Under the starters", co(app())),
      inline("co-dock", "Docked", "A conversation with messages: “Ask a follow-up”", "The conversation's foot", co(page(HOSTING()))),
      inline("co-text", "Typing", "Words in the box; Send is on", "The conversation's foot", co(withUi({ text: "Who owns the Netlify fix, and when does it land?" }))),
      inline("co-busy", "Answering", "Send is Stop; “Trov is answering…”", "The conversation's foot", co(page(scenarioMsgs("streaming")))),
      inline("co-ctx", "Context", "A context chip and the context line (“About ticket #14”)", "The conversation's foot", co(withUi({ context: ["ticket:14"] }))),
      inline("co-files", "Files", "An image (thumbnail), a CSV, a PDF still uploading; context; the line “About ticket #14 · 3 files”", "The conversation's foot",
        co(withUi({ text: "Why does this fail only on main?", files, attachments: files.flatMap((f) => (f.att ? [f.att] : [])), context: ["ticket:14", "person:maya"] }))),
      inline("co-big", "Too large", "A file over the cap: the red chip and its note", "The conversation's foot",
        co(withUi({ text: "Summarize this standup", files: [file("f9", "standup-recording.mov", 84_934_656, null, "too_large", 0)] }))),
      inline("co-big-img", "Too large — an image", "An image over the attach cap: the red chip and its note (one under the cap but over the model's limit is stored and noted in the steps instead)", "The conversation's foot",
        co(withUi({ text: "Why is this failing?", files: [file("f7", "ci-full-page.png", 12_900_000, "image", "too_large", 0)] }))),
      inline("co-failed", "Not attached", "An upload failed: “Something went wrong. Try again”", "The conversation's foot",
        co(withUi({ files: [file("f8", "deploys-october.csv", 18_432, "text", "failed", 0)], error: true }))),
      inline("co-unsup", "Can't be attached", "An unsupported kind", "The conversation's foot", co(withUi({ notice: { kind: "unsupported", name: "design.fig" } }))),
      inline("co-many", "Too many files", "Past the per-message count", "The conversation's foot", co(withUi({ notice: { kind: "too_many", name: "screenshot-6.png" } }))),
      inline("co-at", "@ mention", "“@net”: the picker, grouped by type, the second row selected", "Above the box", co(at("net", 1)), { stage: "gx-pad-top-pick" }),
      inline("co-at-all", "@ mention, everything", "“@”: every group", "Above the box", co(at("", 0)), { stage: "gx-pad-top-pick" }),
      inline("co-at-load", "@ mention, searching", "“Searching…”", "Above the box", co(at("sso", 0, "loading")), { stage: "gx-pad-top-short" }),
      inline("co-at-none", "@ mention, nothing", "“Nothing matches”", "Above the box", co(withUi({ text: "@zzz", picker: { kind: "@", q: "zzz", at: 0, sel: 0, hits: [], status: "ok" } })), { stage: "gx-pad-top-short" }),
      inline("co-slash", "Commands", "“/”: the five commands", "Above the box", co(withUi({ text: "/", picker: { kind: "/", q: "", at: 0, sel: 0, hits: [], status: "ok" } })), { stage: "gx-pad-top-pick" }),
      inline("co-slash-q", "Commands, filtered", "“/s”: search, summarize", "Above the box", co(withUi({ text: "/s", picker: { kind: "/", q: "s", at: 0, sel: 1, hits: [], status: "ok" } })), { stage: "gx-pad-top-short" }),
      inline("co-mode", "The mode menu", "Pro: Fast, Smart, Thinking with their hints", "Above the mode button", co(withUi({ modeMenu: true })), { stage: "gx-pad-top-menu" }),
      inline("co-think", "Thinking picked", "The mode button reads Thinking", "The toolbar", co(withUi({ mode: "thinking" }))),
      inline("co-auto", "Auto on", "The switch on Auto", "The toolbar", co(withUi({ auto: true }))),
      inline("co-autooff", "Auto turned off by an admin", "The switch locked, with its tip", "The toolbar", co(page(HOSTING(), () => undefined, { state: (st) => ({ ...st, autoAllowed: false }) }))),
      inline("co-free", "Free plan", "No mode switch", "The toolbar", co(page(HOSTING(), () => undefined, { plan: "free" }))),
      inline("co-low", "Running low", "The usage line under a fifth left", "Under the box", co(page(HOSTING(), () => undefined, { state: (st) => ({ ...st, allowance: { ...st.allowance, used: 1459, low: true } }) }))),
      inline("co-quota-free", "Used up (Free)", "“You've used this month's questions.” and Upgrade to Pro", "In place of the box", co(page(HOSTING(), () => undefined, { plan: "free", state: (st) => ({ ...st, allowance: { ...st.allowance, used: st.allowance.cap ?? 50 } }) }))),
      inline("co-quota-pro", "Used up (Pro)", "No upsell", "In place of the box", co(page(HOSTING(), () => undefined, { state: (st) => ({ ...st, allowance: { ...st.allowance, used: st.allowance.cap ?? 1500 } }) }))),
      inline("co-off", "Ask is off", "“Ask Trov is off for this org.”", "In place of the box", co(page(HOSTING(), () => undefined, { state: (st) => ({ ...st, enabled: false }) }))),
      inline("co-nokey", "No key on the server", "ask/state eligibility no_key: the composer has no state of its own for it (a send ends in the error line)", "The conversation's foot", co(page(HOSTING(), () => undefined, { state: (st) => ({ ...st, eligibility: "no_key" }) }))),
      inline("co-panel", "Panel form", "The ⌘J panel's: “Ask first”, its own placeholder and context", "The ⌘J panel", (() => {
        const s = app(); s.screen = "mywork"; s.ask.cmdj = { open: true, contextRef: "ticket:14" };
        s.ask.composer.panel = { ...s.ask.composer.panel, context: ["ticket:14"] };
        s.ask.composer.panel = { ...s.ask.composer.panel, text: "Who reviews #176?" };
        return keep(render(s), ".ask-panel .ask-composer");
      })(), { w: 420, h: 200, stage: "gx-fixed" }),
    ],
  };
}

// ── the inspector ────────────────────────────────────────────────────────────

function inspector(): Section {
  const frame = (stack: string[], o: { over?: (s: AppState) => void; load?: boolean } = {}) => {
    const s = page(HOSTING());
    s.ask.inspector = { ...s.ask.inspector, stack, idx: stack.length - 1 };
    if (o.load !== false) for (const r of stack) fillItem(s, r);
    o.over?.(s);
    return inspectorFrame(askView(s, "page"));
  };
  const box = { w: 480, h: 760, stage: "gx-fixed" };
  const a = (s: AppState) => lastAnswerKey(s);
  // The conversation's own items (a question's file, an answer's blocks): `askcv:` refs, primed hidden.
  const cvFrame = (kind: "chart" | "themes" | "diagram" | "table" | "upload", over?: (s: AppState) => void) => {
    const s = page([question("What's blocking the hosting work? This is what I see in CI.", { files: [att(951, "ci-failure.png", "image", 421_888, true)] }), answer(fold(events("answer")))]);
    const qk = s.ask.page.messages[0].key;
    const ak = a(s);
    const blockIdx = { chart: 1, themes: 2, diagram: 3 } as Record<string, number>;
    const ref = kind === "upload" ? cvRef("page", qk, "upload", 951) : kind === "table" ? cvRef("page", ak, "table", "0.0") : cvRef("page", ak, kind, blockIdx[kind]);
    s.ask.refViews = { ...s.ask.refViews, [ref]: { ref, hidden: true } };
    s.ask.inspector = { ...s.ask.inspector, stack: [ref], idx: 0 };
    over?.(s);
    return inspectorFrame(askView(s, "page"));
  };
  return {
    id: "inspector", title: "The inspector", intro: "Beside the thread (480px, resizable 380–720; a full-height sheet on a phone): one view per type. The header is the item's RefView; the rest is GET /ask/item/:ref, a skeleton until it lands.",
    specs: [
      inline("i-ticket", "Ticket", "#14: status, priority, sprint, sub-tickets, linked PRs, comments", "Beside the thread", frame(["ticket:14"]), box),
      inline("i-pr", "Pull request", "#176, opened from #14 (the trail): checks, What / Why / Impact", "Beside the thread", frame(["ticket:14", "pr:176"]), box),
      inline("i-pr-merged", "Pull request, merged", "#173", "Beside the thread", frame(["pr:173"]), box),
      inline("i-doc-staged", "Doc, staged", "Release 0.30 notes: the version waiting in Review", "Beside the thread", frame(["doc:release-0-30-notes"]), box),
      inline("i-doc-live", "Doc, live", "Hosting connections", "Beside the thread", frame(["doc:hosting-connections"]), box),
      inline("i-sprint", "Sprint", "Hosting: progress, the forecast (3 days late), tickets", "Beside the thread", frame(["sprint:7"]), box),
      inline("i-repo", "Repository", "The Overview's facts and verdicts; State still loading", "Beside the thread", frame([REPO]), box),
      inline("i-handoff", "Handoff", "#11, pending", "Beside the thread", frame(["handoff:11"]), box),
      inline("i-feed", "Feed entry", "#41", "Beside the thread", frame(["feed:41"]), box),
      inline("i-person", "Person", "Maya Chen", "Beside the thread", frame(["person:maya"]), box),
      inline("i-artifact", "Artifact", "A private draft: the sandboxed preview, Publish to org (the author's)", "Beside the thread", frame(["artifact:hosting-status-oct-15"]), box),
      inline("i-upload", "A question's file", "ci-failure.png", "Beside the thread", cvFrame("upload"), box),
      inline("i-chart", "An answer's chart", "Larger, with the Chart / Table switch", "Beside the thread", cvFrame("chart"), box),
      inline("i-chart-table", "An answer's chart, as a table", "The switch on Table", "Beside the thread", cvFrame("chart", (s) => { s.ask.inspectorUi.chartView = { [s.ask.inspector.stack[0]]: "table" }; }), box),
      inline("i-themes", "An answer's theme strip", "Larger", "Beside the thread", cvFrame("themes"), box),
      inline("i-diagram", "An answer's chain", "Larger", "Beside the thread", cvFrame("diagram"), box),
      inline("i-table", "An answer's table", "Larger", "Beside the thread", cvFrame("table"), box),
      inline("i-loading", "Loading", "The read in flight: the skeleton", "Beside the thread", frame(["ticket:18"], { load: false, over: (s) => { s.ask.inspectorUi.items["ticket:18"] = { status: "loading", data: null }; } }), box),
      inline("i-hidden", "Not yours to see", "A hidden ref: one sentence, nothing of the item", "Beside the thread", frame(["ticket:99"], { load: false, over: (s) => { s.ask.refViews["ticket:99"] = { ref: "ticket:99", hidden: true }; } }), box),
      inline("i-missing", "Gone", "The read answered 404", "Beside the thread", frame(["ticket:19"], { load: false, over: (s) => { s.ask.inspectorUi.items["ticket:19"] = { status: "ok", data: null }; } }), box),
    ],
  };
}

function hoverCards(): Section {
  const look = { views: VIEWS, persons: PEOPLE };
  const refs: [string, string][] = [
    ["ticket:14", "Ticket"], ["pr:176", "Pull request (a check failing)"], ["pr:173", "Pull request (merged)"], ["doc:hosting-connections", "Doc"],
    ["sprint:7", "Sprint"], [REPO, "Repository"], ["handoff:11", "Handoff"], ["feed:41", "Feed entry"], ["person:maya", "Person"], ["artifact:hosting-status-oct-15", "Artifact"],
  ];
  return {
    id: "hover", title: "The hover card", intro: "Hovering a ref chip for 320ms shows a 300px card under it (above it near the bottom); its foot opens the item beside the thread.",
    specs: refs.map(([ref, name]) => inline(`hc-${ref.replace(/[^a-z0-9]+/gi, "-")}`, name, ref, "Over any ref chip", hoverCard(R[ref], look, { x: 12, y: 12 }), { w: 324, h: 230, stage: "gx-fixed" })),
  };
}

function cmdj(): Section {
  const over = (o: { msgs?: boolean; insp?: boolean; empty?: boolean } = {}) => {
    const s = app();
    s.screen = "mywork";
    s.ask.cmdj = { open: true, contextRef: "ticket:14" };
    s.ask.composer.panel = { ...s.ask.composer.panel, context: ["ticket:14"] };
    if (o.msgs) {
      const q = ASK_SCENARIO_QUESTION.cmdj!;
      s.ask.panel = { ...convo([question(q.text, { context: q.context }), answer(fold(events("cmdj")))]), title: "What's left on #14" };
      s.ask.composer.panel = { ...s.ask.composer.panel, context: [] };
    }
    if (o.insp) {
      s.ask.inspector = { ...s.ask.inspector, stack: ["pr:176"], idx: 0, where: "panel" };
      fillItem(s, "pr:176");
    }
    return s;
  };
  return {
    id: "cmdj", title: "The ⌘J panel", intro: "420px on the right over any page (full screen on a phone): its own conversation, the page's item as context, Open as thread. Shown here over My Work.",
    specs: [
      desktop("cj-empty", "Opened", "Empty: the starters, the page's item as the context chip", "Over any page", over()),
      desktop("cj-answer", "Answered", "The `cmdj` scenario: what's left on #14", "Over any page", over({ msgs: true })),
      desktop("cj-insp", "With its inspector", "PR #176 open to the panel's left", "Over any page", over({ msgs: true, insp: true })),
      inline("cj-button", "Ask about this", "The Tickets page header's one change: opens the panel with the ticket as context", "A ticket's page header", (() => {
        const s = app(); s.screen = "ticketdetail"; s.ticketId = 14;
        return `<div style="padding:16px 18px">${cmdjHeaderButton(s)}</div>`;
      })(), { w: 300 }),
    ],
  };
}

function toasts(): Section {
  const toast = (msg: string): string => {
    const s = page(HOSTING());
    s.toast = msg; s.toastAt = Date.now(); s.toastMs = 86_400_000;     // held on screen for a day (the app fades it after a few seconds)
    return keep(render(s), ".cnpy-toast");
  };
  const box = { w: 560, h: 76, stage: "gx-fixed" };
  const list: [string, string, string][] = [
    ["ts-done", "Created ticket #30", "Confirm went through (the card's done line, said once)"],
    ["ts-undone", "Undone", "Undo went through"],
    ["ts-saved", "Saved to Artifacts", "Save as artifact"],
    ["ts-wrong", "Thanks. The team can see this in Review.", "A Wrong? reason was sent"],
    ["ts-pub", "Published to Acme", "An artifact published to the org from the inspector"],
    ["ts-export", "Exported Hosting status.md", "A thread exported as markdown"],
    ["ts-del", "Deleted Hosting status", "A thread deleted"],
    ["ts-expired", "This card expired with its turn. Ask again.", "Confirm on a card whose turn has passed"],
    ["ts-undo-fail", "Couldn't undo that.", "Undo refused for another reason"],
  ];
  return {
    id: "toasts", title: "Toasts", intro: "What Ask says at the foot of the window after an action (the app's toast; it fades after a few seconds — held here).",
    specs: list.map(([id, msg, state]) => inline(id, msg, state, "The foot of the window", toast(msg), box)),
  };
}

function threads(): Section {
  const col = (over: (s: AppState) => void = () => undefined) => { const s = page(HOSTING()); s.ask.page = { ...s.ask.page, threadId: 1 }; over(s); return threadsView(askView(s, "page")); };
  const box = { w: 260, h: 620, stage: "gx-fixed gx-threads" };
  return {
    id: "threads", title: "The thread list", intro: "260px on a desktop (hidden under 1180px, or while the inspector is open under 1640px), a drawer on a phone: New thread, search, Pinned / Today / This week, each row's ⋯ menu.",
    specs: [
      inline("t-list", "The list", "Hosting status active", "The left column", col(), box),
      inline("t-search", "Search", "“netlify”: four threads, the match marked", "The left column", col((s) => { s.ask.threadQ = "netlify"; s.ask.hits = { status: "ok", data: askSearchFixture(NOW) }; }), box),
      inline("t-menu", "A row's menu", "Rename, Pin, Export as markdown, Delete", "The left column", col((s) => { s.ask.threadMenu = 3; }), box),
      inline("t-rename", "Renaming", "Inline", "The left column", col((s) => { s.ask.renaming = { id: 3, text: "What shipped in week 41?" }; }), box),
      inline("t-loading", "Loading", "The skeleton", "The left column", col((s) => { s.ask.threads = { status: "loading", data: [] }; }), box),
    ],
  };
}

function orbs(): Section {
  const states: OrbState[] = ["working", "searching", "solving", "listening", "composing", "shaping"];
  const row = (size: 20 | 64) => `<div class="gx-orbs">${states.map((st) => `<figure class="gx-orb">${thinkingOrb(st, size)}<figcaption>${st}</figcaption></figure>`).join("")}<figure class="gx-orb">${thinkingOrbTour(ASK_ORB_MATCH_TOUR, size, null)}<figcaption>match (tour)</figcaption></figure></div>`;
  const dd = { open: "ask-orb", opening: false, closing: false };
  return {
    id: "orbs", title: "Thinking orbs", intro: "Ask's working animations (thinking-orb.ts): one canvas loop paints every orb on the shared clock. By default the orb matches what Trov is doing — searching, working, solving (thinking), composing (writing); the header's Thinking animation dropdown can pin one for every orb.",
    specs: [
      inline("o-20", "The six orbs, 20px", "As steps, thinking and the wait use them", "Steps, thinking, the wait", row(20), { sample: false }),
      inline("o-64", "The six orbs, 64px", "The engine's larger preset", "Nowhere on screen today (thinking-orb.ts keeps the size)", row(64), { sample: false }),
      inline("o-dd", "The header dropdown", "The trigger (the picked orb and a caret) and its menu, each option with its orb", "The Ask header",
        placed(`${dropdown(askOrbDropdown("match"), dd)}${dropdownMenu([askOrbDropdown("match")], dd)}`, dd, 360, 380, 16), { sample: false, w: 360, h: 380, stage: "gx-fixed gx-ddbox" }),
      inline("o-dd-cube", "A pinned orb", "Cube picked: the trigger shows it", "The Ask header",
        placed(`${dropdown(askOrbDropdown("solving"), { ...dd, open: null })}`, { ...dd, open: null }, 360, 72, 16), { sample: false, w: 360, h: 72, stage: "gx-fixed gx-ddbox" }),
    ],
  };
}

function phones(): Section {
  const answered = page(HOSTING(), () => undefined, { phone: true });
  const plus = page(HOSTING(), (s) => { s.ask.phone.plus = true; }, { phone: true });
  const insp = page(HOSTING(), (s) => { s.ask.inspector = { ...s.ask.inspector, stack: ["ticket:14"], idx: 0 }; fillItem(s, "ticket:14"); }, { phone: true });
  const drawer = page(HOSTING(), (s) => { s.ask.phone.drawer = true; }, { phone: true });
  const empty = app({ phone: true });
  const cards = page([question(ASK_SCENARIO_QUESTION["actions-ask"]!.text), answer(fold(events("actions-ask")))], () => undefined, { phone: true });
  const stream = page(scenarioMsgs("streaming"), () => undefined, { phone: true });
  const atp = page(HOSTING(), (s) => { s.ask.composer.page = { ...s.ask.composer.page, text: "What changed in @net", picker: { kind: "@", q: "net", at: 16, sel: 1, hits: knownHits({ views: VIEWS }, "net"), status: "ok" } }; }, { phone: true });
  const panel = (() => { const s = app({ phone: true }); s.screen = "mywork"; s.ask.cmdj = { open: true, contextRef: "ticket:14" }; s.ask.panel = convo([question(ASK_SCENARIO_QUESTION.cmdj!.text, { context: ["ticket:14"] }), answer(fold(events("cmdj")))]); return s; })();
  return {
    id: "phone", title: "On a phone", intro: "At 390 × 844 (≤ 640px is a phone): the header's Open threads + New thread, the thread list as a drawer, the composer's controls under one + menu with the meta line, the inspector as a full-height sheet. Every control is at least 44px.",
    specs: [
      phone("p-empty", "A new thread", "Empty", "#ask", empty),
      phone("p-answer", "An answer", "Done (scroll the frame)", "#ask/<id>", answered),
      phone("p-stream", "Streaming", "Stop in the bar", "#ask/<id>", stream),
      phone("p-cards", "Write cards", "Three pending cards, stacked", "#ask/<id>", cards),
      phone("p-plus", "The + menu", "Attach, Mention, Run a command; Mode; Changes in this thread", "Above the composer", plus),
      phone("p-at", "@ mention", "The picker over the box", "Above the composer", atp),
      phone("p-insp", "The inspector sheet", "Ticket #14, full height", "Over the thread", insp),
      phone("p-drawer", "The thread drawer", "Open over a scrim", "From the left", drawer),
      phone("p-cmdj", "⌘J on a phone", "The panel is full screen", "Over any page", panel),
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════

declare global { interface Window { __askGallery?: () => Section[] } }

window.__askGallery = (): Section[] => [
  // In the order they appear in a conversation: a new thread and its box, the question, the answer as it comes (steps,
  // thinking, the wait, words, blocks, cards), how it ends, then what opens beside or over it; whole screens last.
  emptyState(), composerSpecs(), questions(), steps(), thinking(), waiting(), markdown(), blocks(), cards(), assignments(), saving(), footer(),
  endings(), toasts(), inspector(), hoverCards(), threads(), cmdj(), orbs(), screens(), phones(),
];
