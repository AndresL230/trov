/**
 * Ask Trov — the conversation part (web/src/ask-conversation.ts; inventory §1b, §2). Every scenario it draws is
 * rendered from the recorded transcripts (shared/ai-fixtures.ts › askTranscript, the replay's own): `live`,
 * `streaming`, `thinking`, `answer`, `notfound`, and the stream parts of `search` and `answer-pr`; plus the events it
 * consumes (activity, thinking, the five block kinds, done, followups, error), its acts (edit-and-resend and
 * regenerate through `replaceFrom`, Try again, disclosures, Copy, Open in inspector), and its motion hooks.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import { askView, type AskCtx, type AskSendInput, type AskWhere } from "../web/src/ask-state";
import {
  conversationView, emptyView, conversationPart, parseMd, splitRow, chainOrder, cvItem, themeTip, thinkingLabel, quietStep, plainText, settleTail, jumpButton,
} from "../web/src/ask-conversation";
import { cvRef, parseCvRef, cvRefWord, isCvRef } from "../web/src/ask-cvref";
import { refFallbackText } from "../web/src/ask-refs";
import { newTurn, foldAskEvent, foldThreadEvent, emptyConvo, withLastTurn, type AskConvo, type AskMsg, type AskTurn } from "../web/src/ask-stream";
import type { AskApi } from "../web/src/ask-api";
import { dropdownMenu } from "../web/src/dropdown";
import mainSrc from "../web/src/main.ts?raw";
import { askTranscript, askRefFixtures, askStateFixture, askThreadsFixture, ASK_SCENARIO_QUESTION, type AskScenario } from "@shared/ai-fixtures";
import type { AskAttachment, AskEvent, AskThreadDetail } from "@shared/ai-ask-core";
import css from "../web/src/trov.css?raw";
import { singleItemCard, plainWords } from "../web/src/ask-one";
import { repoScenario } from "../web/src/repo-sample";
import { askRepoFacts, type RefView } from "@shared/ai-ask-core";

const NOW = new Date("2026-10-15T12:00:00Z");
const HQ = "What's blocking the hosting work? This is what I see in CI.";
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };

function base(plan: "pro" | "free" = "pro"): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture(plan, NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = askRefFixtures(NOW);
  return s;
}

const att = (f: { title: string; kind: "image" | "pdf" | "text"; size: number }, id: number, thumb?: string): AskAttachment =>
  ({ id, slug: `f-${id}`, title: f.title, kind: f.kind, contentType: f.kind === "image" ? "image/png" : "text/plain", size: f.size, sha256: "", ...(thumb ? { thumbUrl: thumb } : {}) });

/** A conversation as the controller builds it: the scenario's question, then its transcript folded event by event. */
function convoOf(scenario: AskScenario, o: { events?: AskEvent[]; qid?: number | null; busy?: boolean } = {}): AskConvo {
  const q = ASK_SCENARIO_QUESTION[scenario] ?? { text: "Hello", context: [], attachments: [] };
  const events = o.events ?? askTranscript(scenario, NOW).map((s) => s.event);
  let c: AskConvo = {
    ...emptyConvo(), uid: "c1", status: "ok",
    messages: [
      { role: "user", key: "qk1", id: o.qid ?? null, text: q.text, context: q.context, attachments: q.attachments.map((f, i) => att(f, 900 + i)), command: null },
      { role: "assistant", key: "ak1", turn: newTurn("smart") },
    ],
  };
  for (const e of events) c = e.event === "thread" ? foldThreadEvent(c, e.data) : withLastTurn(c, (t) => foldAskEvent(t, e, NOW.getTime()));
  const live = !c.messages.some((m) => m.role === "assistant" && (m.turn.done || m.turn.error));
  return { ...c, busy: o.busy ?? live };
}

function view(scenario: AskScenario, o: Parameters<typeof convoOf>[1] & { over?: (s: AppState) => void } = {}): { s: AppState; html: string } {
  const s = base();
  s.ask.page = convoOf(scenario, o);
  o.over?.(s);
  return { s, html: conversationView(askView(s, "page")) };
}

const turnOf = (c: AskConvo): AskTurn => (c.messages.find((m) => m.role === "assistant") as Extract<AskMsg, { role: "assistant" }>).turn;
const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");

// ── scenarios ───────────────────────────────────────────────────────────────

describe("`live` — a new thread", () => {
  it("the mark, the headline and the starters from ask/state (the design's four as the fallback)", () => {
    const s = base();
    const html = emptyView(askView(s, "page"));
    expect(html).toContain("Ask anything about your team's work");
    for (const q of s.ask.state.data!.starters) expect(html).toContain(`data-act="askCvSend" data-arg="${q.replace(/'/g, "&#39;")}"`);
    s.ask.state = { status: "ok", data: { ...s.ask.state.data!, starters: [] } };
    expect(text(emptyView(askView(s, "page")))).toContain("Where did our time go this month?");
  });
});

describe("QA-6: a blocked composer's starters send nothing and say why", () => {
  for (const [name, set, why] of [
    ["at the cap", (s: AppState) => { s.ask.state = { status: "ok", data: { ...s.ask.state.data!, allowance: { ...s.ask.state.data!.allowance, used: 1500 } } }; }, "You've used this month's questions."],
    ["off", (s: AppState) => { s.ask.state = { status: "ok", data: { ...s.ask.state.data!, enabled: false } }; }, "Ask Trov is off for this org."],
    ["no key", (s: AppState) => { s.ask.state = { status: "ok", data: { ...s.ask.state.data!, eligibility: "no_key" } }; }, "Ask Trov is not set up on this deployment."],
  ] as const) {
    it(name, () => {
      const s = base();
      set(s);
      const html = emptyView(askView(s, "page"));
      expect(html).not.toContain(`data-act="askCvSend"`);
      expect(html).toContain(`aria-disabled="true" data-mtip="${why.replace(/'/g, "&#39;")}"`);
      const { ctx, sent } = fakeCtx(s);
      act(ctx, "askCvSend", "What shipped this week?"); // a stale click
      expect(sent).toEqual([]);
    });
  }
});

describe("`answer` — the whole answer, in stream order", () => {
  const { html } = view("answer");
  const t = text(html);

  it("the question: a bubble, then what came with it as the composer's chips — one size, an image too (the owner)", () => {
    expect(html).toMatch(/<div class="ask-q can-edit" data-morph-key="q:qk1" data-ask-tween>/);
    expect(html).toContain(`<div class="ask-q-bubble">What&#39;s blocking the hosting work? This is what I see in CI.</div>`);
    expect(html).toMatch(/<button type="button" class="ask-co-chip ask-q-chip" data-act="askCvOpen" data-arg="askcv:page:qk1:upload:900" aria-label="Open ci-failure.png"><span class="ask-co-ico"/);
    expect(html).not.toContain("ask-qimg");
    expect(html).toMatch(/<button type="button" class="ask-co-chip ask-q-chip" data-act="askShOpen" data-arg="ticket:14" aria-label="Open #14">/);
    // The bubble first, the chips under it.
    expect(html.indexOf("ask-q-bubble")).toBeLessThan(html.indexOf("ask-q-chip"));
  });

  it("activity steps with their result lines; a step with results opens (aria-expanded), the show_* step stays quiet", () => {
    expect(t).toContain("Searched docs for 'hosting' · 3 results");
    expect(t).toContain("Read ticket #14 · 4 results");      // no resultLine: the count of what it found
    expect(html).toMatch(/data-act="askCvToggle" data-arg="ak1:s1" aria-expanded="false"/);
    expect(t).not.toContain("Showed items");
  });

  it("the text: headings, a list with ref chips, a table whose Status column is each ticket's live mark", () => {
    expect(html).toContain(`<h3 class="ask-h">What is blocking</h3>`);
    expect(html).toMatch(/<ul class="ask-ul"><li>The Netlify connect test fails on main since <button type="button" class="ask-chip ask-chip--inline"[^>]*data-ask-ref="pr:173"/);
    expect(html).toMatch(/<th scope="col">Status<\/th>/);
    const views = askRefFixtures(NOW);
    expect(html).toContain(`data-mtip="${views["ticket:14"].status!.tip}"`);
    expect(html).toMatch(/<td><span data-mtip="[^"]*"[^>]*>.*In progress<\/span><\/td>/);
    // A table is a rich block: Save (the answer is stored) and Open in inspector on hover.
    expect(html).toMatch(/<div class="ask-rich" data-rich="table"><div class="ask-tools" role="toolbar" aria-label="Block actions"><button type="button" class="ask-tool" data-act="askAcSaveForm" data-arg="ak1"/);
    expect(html).toContain(`data-act="askCvOpen" data-arg="askcv:page:ak1:table:0.0"`);
  });

  it("item cards (three to a row), each a hitArea card that opens its item; no Open in inspector on cards", () => {
    expect(html).toMatch(/<div class="ask-rich" data-rich="items">[\s\S]*?<div class="ask-cards" style="--n:3">/);
    expect(html).toContain(`<button data-act="askShOpen" data-arg="pr:176" class="cnpy-hit"`);
    expect(t).toContain("Pull request #176");
    expect(html).not.toContain("askcv:page:ak1:items:");
  });

  it("the bar chart: its total in weeks, the bars, Data from Trov; Open in inspector names the block", () => {
    expect(t).toContain("Merged PRs by week 48 in 8 weeks");
    expect(html.match(/class="ask-bar-b"/g)?.length).toBe(8);
    expect(html).toMatch(/class="ask-bars" role="img" aria-label="Merged PRs by week\. Aug 24: 4/);
    expect(t).toContain("Data from Trov");
    expect(html).toContain(`data-arg="askcv:page:ak1:chart:1"`);
  });

  it("the theme strip: the server's caption, a lane per theme, each cell's tooltip in the design's words", () => {
    expect(t).toContain("Where the time went, by theme Share of merged PRs");
    expect(html).toContain(`data-mtip="Hosting, week of Sep 21: 70% of capacity"`);
    expect(html).toContain(`data-mtip="Status marks, week of Aug 24: none"`);
    expect(html.match(/class="ask-tg ask-tl"/g)?.length).toBe(4);
    expect(html).toContain("var(--p-sky)");
  });

  it("the dependency chain: nodes in order with connectors between, each with a ref opening it, its live mark", () => {
    expect(html).toMatch(/data-fig="diagram" data-shape="chain"/);
    expect(html.match(/class="ask-dg-ah"/g)?.length).toBe(3);
    expect(html).toMatch(/<svg class="ask-dg-e ask-dg-e--lr"[^>]*>(<path [^>]*><\/path>){3}<\/svg>/);
    expect(html).toMatch(/<button type="button" class="ask-dg-c" data-act="askShOpen" data-arg="pr:176"/);
    expect(t).toContain("What waits on what Each step waits on the one before it");
  });

  it("the footer: the mode word, 7 sources, Copy, Regenerate with the modes, the actions part's Save and Wrong?", () => {
    expect(html).toMatch(/<span class="ask-foot-mode" data-mtip="Written by Trov">[\s\S]*?<span>Smart<\/span>/);
    expect(html).toMatch(/data-act="askCvToggle" data-arg="ak1:src" aria-expanded="false">7 sources/);
    expect(html).toContain(`data-act="askCvCopy" data-arg="page:ak1"`);
    expect(html).toContain(`data-act="askCvRegen" data-arg="page:ak1"`);
    expect(html).toContain(`data-act="askCvRegenMenu" data-arg="page:ak1" aria-label="Regenerate with another mode" aria-haspopup="menu" aria-expanded="false"`);
    expect(html).toContain(`data-act="askAcSaveForm" data-arg="ak1"`);
    expect(html).toContain(`data-act="askAcWrong" data-arg="ak1" aria-expanded="false">Wrong?`);
  });

  it("follow-ups under the last answer only, once it is done", () => {
    expect(html).toMatch(/<div data-morph-key="follow" class="ask-follow" role="list"[^>]*><div role="listitem"><button type="button" class="ask-fu" data-act="askCvSend" data-arg="File a ticket for the failing test">/);
  });

  it("no cursor once done; the answer is a keyed list of keyed parts (ask-motion.ts rule 2)", () => {
    expect(html).not.toContain("ask-cursor");
    expect(html).toMatch(/<div class="ask-a" data-morph-key="a:ak1" data-morph-list data-ask-enter="fade">/);
    expect(html).toContain(`<div data-morph-key="parts" class="ask-parts" data-morph-list data-ask-enter="rise">`);
    expect(html).toMatch(/data-morph-key="p0"/);
  });

  it("renders whole in the app shell too", () => {
    const s = base();
    s.ask.page = convoOf("answer");
    expect(render(s)).toContain(`data-fig="themes"`);
  });
});

describe("`streaming` — mid-answer", () => {
  const { html } = view("streaming");
  it("the soft cursor at the end of the last text, no footer, no follow-ups, Edit hidden while busy", () => {
    expect(html).toMatch(/<span class="ask-cursor" aria-hidden="true"><\/span><\/(p|li|h3)>/);
    expect(html).not.toContain("ask-foot");
    expect(html).not.toContain("ask-follow");
    expect(html).not.toContain("askCvEdit");
    expect(html).toContain(`aria-busy="true"`);
  });
  it("a cursor alone under a block that ended the stream so far; and alone while nothing came yet", () => {
    const events = askTranscript("answer", NOW).map((s) => s.event);
    const upToChart = events.slice(0, events.findIndex((e) => e.event === "block" && e.data.kind === "chart") + 1);
    expect(view("answer", { events: upToChart, busy: true }).html).toContain(`<div data-morph-key="cursor" class="ask-cur-alone">`);
    expect(view("answer", { events: [], busy: true }).html).toContain(`ask-cur-alone`);
    // The place the words will come holds a thinking orb: working before anything arrived, writing after a block.
    expect(view("answer", { events: [], busy: true }).html).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="solving" data-orb-size="20" width="20" height="20" aria-hidden="true"[^>]*><\/canvas><span class="ask-wait-l">Thinking…<\/span>/);
    expect(view("answer", { events: upToChart, busy: true }).html).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="composing"[^>]*aria-hidden="true"[^>]*><\/canvas><span class="ask-wait-l">Writing…<\/span>/);
  });
  it("the wait row stays under the steps for the whole wait — while a step runs too, with that step's orb", () => {
    const events = askTranscript("answer", NOW).map((s) => s.event);
    const firstText = events.findIndex((e) => e.event === "text");
    const beforeText = events.slice(0, firstText);
    const lastStepDone = beforeText.map((e) => e.event === "activity" && e.data.state === "done").lastIndexOf(true);
    expect(lastStepDone).toBeGreaterThan(0);
    const quiet = beforeText.slice(0, lastStepDone + 1).filter((e) => e.event !== "text");
    expect(view("answer", { events: quiet, busy: true }).html).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="working"[^>]*><\/canvas><span class="ask-wait-l">Thinking…<\/span>/);
    const running = events.slice(0, 2);
    expect(running.some((e) => e.event === "activity" && e.data.state === "run")).toBe(true);
    const during = view("answer", { events: running, busy: true }).html;
    expect(during).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="(searching|working)"[^>]*><\/canvas><span class="ask-wait-l">Thinking…/);
    // …below the steps: the wait row comes after the steps list.
    expect(during.indexOf("ask-cur-alone")).toBeGreaterThan(during.indexOf("ask-step is-run"));
  });
  it("Q-F1: a block is out and a step runs — the running step's orb, not the ribbon; the ribbon once no step runs", () => {
    const ev = askTranscript("answer", NOW).map((s) => s.event);
    const upToChart = ev.slice(0, ev.findIndex((e) => e.event === "block" && e.data.kind === "chart") + 1);
    const step = (n: number, state: "run" | "done"): AskEvent => state === "run"
      ? { event: "activity", data: { step: n, tool: "search_docs", icon: "search", label: "Searched docs for 'more'", state: "run" } }
      : { event: "activity", data: { step: n, state: "done" } };
    const n = 90;
    const during = view("answer", { events: [...upToChart, step(n, "run")], busy: true }).html;
    expect(during).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="searching"[^>]*><\/canvas><span class="ask-wait-l">Thinking…<\/span>/);
    const after = view("answer", { events: [...upToChart, step(n, "run"), step(n, "done")], busy: true }).html;
    expect(after).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="composing"[^>]*><\/canvas><span class="ask-wait-l">Writing…<\/span>/);
  });
  it("a running step keeps its own icon (the one orb is the wait row's) and its label carries the sweep", () => {
    const events = askTranscript("answer", NOW).map((s) => s.event).slice(0, 2);
    const { html: h } = view("answer", { events, busy: true });
    expect(h).toMatch(/<div class="ask-step is-run"><span class="ask-step-i"><svg/);
    expect(h.slice(h.indexOf("ask-step is-run"), h.indexOf("ask-cur-alone"))).not.toContain("cnpy-orb");
    expect(css).toContain(".ask-step.is-run .ask-step-l, .ask-think-l, .ask-wait-l { background:");
  });
  it("under reduced motion the words are plain — the rule wins over the sweep that comes LATER in trov.css (AU-F-RM1)", () => {
    const sweep = css.indexOf(".ask-step.is-run .ask-step-l, .ask-think-l, .ask-wait-l { background:linear-gradient");
    const plain = css.indexOf(".ask-step.is-run .ask-step-l, .ask-think-l, .ask-wait-l { animation:none !important;");
    expect(sweep).toBeGreaterThan(0);
    expect(plain).toBeGreaterThan(0);
    const rule = css.slice(plain, css.indexOf("}", plain));
    // Same selector, earlier in the file: only !important lets it win (it lost before: transparent words on a static sweep).
    if (plain < sweep) {
      expect(rule).toMatch(/background:none !important/);
      expect(rule).toMatch(/color:var\(--fg-55\) !important/);
    }
  });
});

describe("colour carries meaning only (the owner, 2026-10-16): Ask's \"working\" is the accent, never a hue of its own", () => {
  it("the orb's ink, the running sweep and the busy jump arrow are --accent (the lifted purple in dark); no Ask rule uses --purple", async () => {
    const orbSrc = (await import("../web/src/thinking-orb.ts?raw")).default as string;
    expect(orbSrc).toContain(`getPropertyValue("--accent")`);
    expect(orbSrc).not.toContain("--purple");
    expect(css).toContain(".ask-step.is-run .ask-step-l, .ask-think-l, .ask-wait-l { background:linear-gradient(90deg, var(--fg-40) 0%, var(--fg-40) 35%, var(--accent) 50%,");
    expect(css).toContain('.ask-jump[data-busy="1"] { color:var(--accent); border-color:color-mix(in srgb, var(--accent) 45%, var(--border)); }');
    const askRules = css.split("}").filter((r) => /(^|\n|,)\s*\.ask-/.test(r.split("{")[0] ?? ""));
    expect(askRules.filter((r) => r.includes("--purple"))).toEqual([]);
  });
});

describe("the thinking orbs mean one thing each — no picker (the owner)", () => {
  const orbs = (html: string): string[] => [...html.matchAll(/<canvas class="cnpy-orb" data-orb="(\w+)"/g)].map((m) => m[1]);
  const answerEvents = () => askTranscript("answer", NOW).map((s) => s.event);
  const thinkEvents = () => { const e = askTranscript("thinking", NOW).map((s) => s.event); return e.slice(0, e.findIndex((x) => x.event === "thinking") + 1); };
  it("thinking is the cube, writing the ribbon, a search the globe, other work the orbits", () => {
    expect(orbs(view("answer", { events: [], busy: true }).html)).toEqual(["solving"]);
    expect(orbs(view("thinking", { events: thinkEvents(), busy: true }).html)).toContain("solving");
    const ev = answerEvents();
    const upToChart = ev.slice(0, ev.findIndex((e) => e.event === "block" && e.data.kind === "chart") + 1);
    expect(orbs(view("answer", { events: upToChart, busy: true }).html)).toEqual(["composing"]);
    const search: AskEvent[] = [{ event: "activity", data: { step: 1, tool: "search_docs", icon: "search", label: "Searched docs for 'x'", state: "run" } }];
    expect(orbs(view("answer", { events: search, busy: true }).html)).toEqual(["searching"]);
    const work: AskEvent[] = [{ event: "activity", data: { step: 1, tool: "get_ticket", icon: "tickets", label: "Read ticket #87", state: "run" } }];
    expect(orbs(view("answer", { events: work, busy: true }).html)).toEqual(["working"]);
  });
  it("the Ask header has no thinking-animation switch any more", () => {
    const s = base();
    const html = render(s);
    expect(html).not.toContain("ask-orb");
    expect(html).not.toContain("Thinking animation");
  });
});

describe("`thinking` — Thinking… Ns, then Thought for Ns", () => {
  it("while it thinks the client counts the seconds", () => {
    const events = askTranscript("thinking", NOW).map((s) => s.event);
    const upTo = events.slice(0, events.findIndex((e) => e.event === "thinking") + 1);
    const { html } = view("thinking", { events: upTo, busy: true });
    expect(html).toMatch(/<span class="ask-think-l" data-ask-think="\d+">Thinking… \d+s<\/span>/);
    // Its icon is the "solving" orb while it thinks.
    expect(html).toMatch(/<div class="ask-step is-run"><span class="ask-step-i"><canvas class="cnpy-orb" data-orb="solving"[^>]*aria-hidden="true"/);
    expect(thinkingLabel(1000, 15_400)).toBe("Thinking… 14s");
    expect(thinkingLabel(1000, 500)).toBe("Thinking… 0s");
  });
  it("then a disclosure that opens to the summary, in a tweened wrapper", () => {
    const shut = view("thinking").html;
    expect(shut).toMatch(/<div class="ask-think" data-ask-tween>\s*<button type="button" class="ask-step" data-act="askCvToggle" data-arg="ak1:think" aria-expanded="false">/);
    expect(text(shut)).toContain("Thought for 14s");
    expect(shut).not.toContain("ask-think-sum");
    const open = view("thinking", { over: (s) => { s.ask.conversation.open = { "ak1:think": true }; } }).html;
    expect(open).toContain(`aria-expanded="true"`);
    expect(open).toMatch(/<div class="ask-think-sum">Started from ticket #14/);
    // Closing plays its exit (`data-closing`) before it goes.
    expect(view("thinking", { over: (s) => { s.ask.conversation.open = { "ak1:think": true }; s.ask.closing = { "cv:ak1:think": true }; } }).html)
      .toContain(`<div class="ask-think-sum" data-closing="1">`);
  });
});

describe("`notfound` — what was searched", () => {
  const { html } = view("notfound");
  const t = text(html);
  it("the heading, the query, two rephrase chips that send, What I searched with No matches", () => {
    expect(t).toContain("I couldn't find that in Trov.");
    expect(t).toContain("Nothing you can see mentions “the customer say about SSO pricing on the last call”.");
    expect(html).toContain(`<button type="button" class="ask-nf-try" data-act="askCvSend" data-arg="What do our docs say about pricing?">`);
    expect(html.match(/class="ask-nf-try"/g)?.length).toBe(2);
    expect(t).toContain("What I searched");
    expect(t).toContain("Docs Engineering and Product, 24 docs No matches");
    expect(t).toContain("Searched tickets and comments · No results");
    expect(t).not.toContain("Checked what was searched");
  });
});

describe("`search` and `answer-pr` — the stream parts", () => {
  it("search: item cards for what shipped, two to three a row", () => {
    const { html } = view("search");
    expect(html).toMatch(/<div class="ask-cards" style="--n:3">/);
    expect(text(html)).toContain("Checked merged PRs on AndresL230/trov · 3 results");
  });
  it("answer-pr: a step's results open to rows that open in the inspector (the stack the scenario pushes)", () => {
    const { html } = view("answer-pr", { over: (s) => { s.ask.conversation.open = { "ak1:s4": true }; } });
    expect(html).toMatch(/<div class="ask-step-det"><button type="button" class="ask-res" data-act="askShOpen" data-arg="pr:176">/);
    expect(text(html)).toMatch(/#176 .* Pull request/);
  });
  it("a repository's row says its head environment's checks (the Overview's ciLine), or its type word", () => {
    const { html } = view("answer", { over: (s) => { s.ask.conversation.open = { "ak1:s3": true }; } });
    expect(html).toMatch(/data-arg="repo:AndresL230\/trov"><svg[\s\S]*?<span class="ask-res-m">[^<]+<\/span>/);
  });
});

describe("the error, Stopped, and the oversized-image notice", () => {
  it("an error: the design's row with Try again, no footer, no follow-ups", () => {
    const events: AskEvent[] = [...askTranscript("answer", NOW).map((s) => s.event).slice(0, 3), { event: "error", data: { code: "failed", message: "boom" } }];
    const { html } = view("answer", { events, busy: false });
    expect(text(html)).toContain("Something went wrong. Nothing was changed. Try again");
    expect(html).toContain(`data-act="askCvRetry" data-arg="page:ak1"`);
    expect(html).toContain(`role="alert"`);
    expect(html).not.toContain("ask-foot");
  });
  it("stopped: the partial answer, the line, and the footer still shows", () => {
    const events = askTranscript("answer", NOW).map((s) => s.event).filter((e) => e.event !== "done" || true)
      .map((e) => (e.event === "done" ? { event: "done" as const, data: { ...e.data, stopped: true } } : e));
    const { html } = view("answer", { events });
    expect(text(html)).toContain("Stopped. The answer above is partial.");
    expect(html).toContain("ask-foot");
  });
  it("the backend's too-large image notice is an ordinary activity line", () => {
    const events: AskEvent[] = [
      { event: "activity", data: { step: 1, tool: "read_attachment", icon: "read", label: "Read standup.png", state: "run" } },
      { event: "activity", data: { step: 1, state: "done", resultLine: "Not read" } },
    ];
    const { html } = view("answer", { events, busy: true });
    expect(html).toMatch(/<div class="ask-step"><span class="ask-step-i"><svg[^>]*>[\s\S]*?<\/svg><\/span><span class="ask-step-l">Read standup\.png<\/span><span class="ask-step-n">· Not read<\/span><\/div>/);
  });
});

describe("jump to the latest (the owner)", () => {
  it("rendered with the conversation, hidden until the person scrolled away; in the accent while an answer streams; the act holds on to the bottom", () => {
    const s = base();
    const idle = jumpButton(askView(s, "page"));
    expect(idle).toMatch(/^<div class="ask-jump-w"><button type="button" class="ask-jump" data-act="askCvJump" data-arg="page" aria-label="Jump to the latest"[^>]*data-away="0" data-busy="0" tabindex="-1" aria-hidden="true">/);
    s.ask.conversation.away = { page: true };
    s.ask.page = { ...s.ask.page, busy: true };
    const away = jumpButton(askView(s, "page"));
    expect(away).toContain(`data-away="1" data-busy="1">`);
    expect(away).not.toMatch(/<button[^>]*aria-hidden/);
    const ctx = { ui: s.ask } as unknown as Parameters<NonNullable<typeof conversationPart.act>>[0];
    s.ask.conversation.stick = false;
    conversationPart.act!(ctx, "askCvJump", "page", null);
    expect(s.ask.conversation.stick).toBe(true);
    expect(s.ask.conversation.away.page).toBe(false);
    expect(css).toMatch(/\.ask-jump-w \{ position:sticky; bottom:0; height:0;/);
    expect(css).toContain('.ask-jump[data-away="1"] { opacity:1;');
  });
});

describe("settleTail — a streaming answer never shows half-written markdown (the owner)", () => {
  it("bare markers wait; unclosed emphasis and code close for now; half links show their text; half refs and rows wait", () => {
    expect(settleTail("Done.\n##")).toBe("Done.\n");
    expect(settleTail("Done.\n## ")).toBe("Done.\n");
    expect(settleTail("Intro\n- ")).toBe("Intro\n");
    expect(settleTail("Intro\n3.")).toBe("Intro\n");
    expect(settleTail("Intro\n``")).toBe("Intro\n");
    expect(settleTail("The **Production bac")).toBe("The **Production bac**");
    expect(settleTail("The **")).toBe("The ");
    expect(settleTail("An *aside")).toBe("An *aside*");
    expect(settleTail("Run `npm te")).toBe("Run `npm te`");
    expect(settleTail("See [the doc](https://tro")).toBe("See the doc");
    expect(settleTail("See [the do")).toBe("See the do");
    expect(settleTail("Blocked by [[ticket:8")).toBe("Blocked by ");
    expect(settleTail("| A | B |\n|---|---|\n| one | tw")).toBe("| A | B |\n|---|---|\n");
    // A list marker is not emphasis; earlier lines and closed marks are untouched.
    expect(settleTail("* First item")).toBe("* First item");
    expect(settleTail("**Done** and *done*\n- Next **st")).toBe("**Done** and *done*\n- Next **st**");
    expect(settleTail("A ref [[ticket:8]] and **b")).toBe("A ref [[ticket:8]] and **b**");
  });
  it("only while streaming: the live part renders the bold, a finished one is left as it came", () => {
    const events: AskEvent[] = [{ event: "text", data: { delta: "The **Production bac" } }];
    const live = view("answer", { events, busy: true }).html;
    expect(live).toContain("<strong>Production bac</strong>");
    expect(live).not.toContain("**");
  });
});

describe("bold around inline code (Final pass 2026-10-16, AU-F-MD1)", () => {
  it("**`file.ts`:** renders bold with the code inside — no raw marks, finished or streaming", () => {
    const md = "What's left:\n1. **`quiz.spec.ts`:** it passes a string. And **the `Streak` type** lacks a field.";
    for (const busy of [false, true]) {
      const html = view("answer", { events: [{ event: "text", data: { delta: md } }], busy }).html;
      expect(html).toContain(`<strong><code class="ask-code">quiz.spec.ts</code>:</strong>`);
      expect(html).toContain(`<strong>the <code class="ask-code">Streak</code> type</strong>`);
      expect(text(html)).not.toContain("**");
    }
  });
});

describe("the latest step stays running while Trov works with what it found (the owner)", () => {
  it("held running until the next step or the answer's first part; then it shows its results", () => {
    const events: AskEvent[] = [
      { event: "activity", data: { step: 1, tool: "search_docs", icon: "search", label: "Searched docs for 'hosting'", state: "run" } },
      { event: "activity", data: { step: 1, state: "done", results: ["doc:hosting"] } },
    ];
    const held = view("answer", { events, busy: true }).html;
    expect(held).toMatch(/<div class="ask-step is-run"><span class="ask-step-i"><svg[\s\S]*?<span class="ask-step-l">Searched docs for &#39;hosting&#39;<\/span><\/div>/);
    expect(held).not.toContain("ask-step-n");
    expect(held).toMatch(/class="ask-cur-alone"><canvas class="cnpy-orb" data-orb="searching"/);
    const answered = view("answer", { events: [...events, { event: "text", data: { delta: "Here is what I found." } }], busy: true }).html;
    expect(answered).not.toContain("ask-step is-run");
    expect(answered).toContain("· 1 result");
  });
});

describe("the question — Edit on the last one, edit-and-resend", () => {
  it("Edit only on the last question, and not while an answer streams", () => {
    const s = base();
    const c = convoOf("answer");
    s.ask.page = { ...c, messages: [...c.messages, { ...c.messages[0], key: "qk2", text: "And then?" } as AskMsg, { role: "assistant", key: "ak2", turn: turnOf(c) }] };
    const html = conversationView(askView(s, "page"));
    expect(html.match(/data-act="askCvEdit"/g)?.length).toBe(1);
    expect(html).toContain(`data-act="askCvEdit" data-arg="page:qk2"`);
    // Follow-ups under the LAST answer only.
    expect(html.match(/class="ask-follow"/g)?.length).toBe(1);
    expect(html.indexOf("ask-follow")).toBeGreaterThan(html.indexOf(`data-morph-key="a:ak2"`));
  });
  it("editing: the box, Sending replaces the answer below, Cancel and Send", () => {
    const { html } = view("answer", { over: (s) => { s.ask.conversation.editing = { where: "page", key: "qk1", text: "Why is it blocked?" }; } });
    expect(html).toContain(`<textarea class="ask-q-ta" rows="3" data-act="askCvEditText" data-field="askCvEdit:page" data-ask-edit aria-label="Edit your message">Why is it blocked?</textarea>`);
    expect(text(html)).toContain("Sending replaces the answer below. Cancel Send");
    expect(html).not.toContain(`class="ask-q-bubble"`);
  });
  it("image thumbnails when the upload has one; other files as chips with their size", () => {
    const s = base();
    const c = convoOf("answer");
    const q = c.messages[0] as Extract<AskMsg, { role: "user" }>;
    s.ask.page = { ...c, messages: [{ ...q, attachments: [att({ title: "ci.png", kind: "image", size: 400_000 }, 7, "/raw/ci.png"), att({ title: "deploys.csv", kind: "text", size: 2048 }, 8)] }, c.messages[1]] };
    const html = conversationView(askView(s, "page"));
    // The image's thumbnail is the chip's 22px lead — the same chip as any file (the owner).
    expect(html).toContain(`<img class="ask-co-thumb" src="/raw/ci.png" alt="" loading="lazy" decoding="async">`);
    expect(text(html)).toContain("ci.png 391 KB");
    expect(text(html)).toContain("deploys.csv 2 KB");
  });
});

// ── the acts ────────────────────────────────────────────────────────────────

function fakeCtx(s: AppState, o: { replay?: boolean; thread?: AskThreadDetail } = {}) {
  const sent: AskSendInput[] = [];
  const opened: [string, AskWhere | undefined][] = [];
  const flashes: string[] = [];
  const api = { getThread: async () => o.thread ?? (() => { throw new Error("no"); })() } as unknown as AskApi;
  const ctx: AskCtx = {
    get app() { return s; }, get ui() { return s.ask; }, api, replay: o.replay ?? false,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }),
    paint() {}, flash: (m) => { flashes.push(m); }, fail: (_e, m) => { flashes.push(m); }, want() {},
    send: (i) => { sent.push(i); }, stop() {}, openRef: (r, w) => { opened.push([r, w]); }, closeInspector() {}, newThread() {}, openThread() {}, reloadThreads() {},
    exit: (_k, apply) => apply(), cancelExit() {},
  };
  return { ctx, sent, opened, flashes };
}
const act = (ctx: AskCtx, name: string, arg: string | null, value: string | null = null) => conversationPart.act!(ctx, name, arg, value);
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("acts — edit-and-resend and regenerate go through replaceFrom", () => {
  it("edit a stored question: replaceFrom is its id, with the new words and its context", async () => {
    const s = base();
    s.ask.page = { ...convoOf("answer", { qid: 41 }), busy: false };
    const { ctx, sent } = fakeCtx(s);
    act(ctx, "askCvEdit", "page:qk1");
    expect(s.ask.conversation.editing).toEqual({ where: "page", key: "qk1", text: "What's blocking the hosting work? This is what I see in CI." });
    act(ctx, "askCvEditText", null, "Why is #14 blocked?");
    act(ctx, "askCvEditSend", null);
    await flush();
    expect(sent).toEqual([{ text: "Why is #14 blocked?", where: "page", context: ["ticket:14"], replaceFrom: 41 }]);
    expect(s.ask.conversation.editing).toBeNull();
  });

  // e2e AU-30: editing a `/search netlify` question showed "netlify" and resent it with no command — a search (no
  // model, nothing counted) became a model question. The box shows the command, and what is sent is parsed like the
  // composer's words (`parseCommand`).
  it("a command question keeps its command: the box shows '/search …', and the words are parsed again on Send", async () => {
    const s = base();
    const c = convoOf("answer", { qid: 41 });
    s.ask.page = { ...c, busy: false, messages: c.messages.map((m) => (m.role === "user" ? { ...m, text: "netlify", command: "search" } : m)) };
    const { ctx, sent } = fakeCtx(s);
    act(ctx, "askCvEdit", "page:qk1");
    expect(s.ask.conversation.editing?.text).toBe("/search netlify");
    act(ctx, "askCvEditText", null, "/search webhook");
    act(ctx, "askCvEditSend", null);
    await flush();
    expect(sent[0]).toMatchObject({ text: "webhook", command: "search", replaceFrom: 41 });
    act(ctx, "askCvEdit", "page:qk1");
    act(ctx, "askCvEditText", null, "What about webhooks?");
    act(ctx, "askCvEditSend", null);
    await flush();
    expect(sent[1]).toMatchObject({ text: "What about webhooks?", replaceFrom: 41 });
    expect(sent[1].command).toBeUndefined();
  });

  it("a question asked this session: its stored id is read back from the thread first", async () => {
    const s = base();
    s.ask.page = { ...convoOf("answer"), busy: false };
    const thread = { thread: { ...askThreadsFixture(NOW)[0], draft: "" }, messages: [{ id: 77, role: "user" }, { id: 78, role: "assistant" }] } as unknown as AskThreadDetail;
    const { ctx, sent } = fakeCtx(s, { thread });
    act(ctx, "askCvEdit", "page:qk1");
    act(ctx, "askCvEditText", null, "Again?");
    act(ctx, "askCvEditSend", null);
    await flush(); await flush();
    expect(sent[0].replaceFrom).toBe(77);
    expect((s.ask.page.messages[0] as Extract<AskMsg, { role: "user" }>).id).toBe(77);
  });

  it("in the replay (nothing stored) the question is dropped here and asked fresh", async () => {
    const s = base();
    s.ask.page = { ...convoOf("answer"), busy: false };
    const { ctx, sent } = fakeCtx(s, { replay: true });
    act(ctx, "askCvEdit", "page:qk1");
    act(ctx, "askCvEditText", null, "Fresh");
    act(ctx, "askCvEditSend", null);
    await flush();
    expect(sent[0]).toMatchObject({ text: "Fresh", replaceFrom: undefined });
    expect(s.ask.page.messages).toEqual([]);
  });

  it("regenerate: the same question, replaceFrom the answer's id, in its mode or the one picked", () => {
    const s = base();
    s.ask.page = { ...convoOf("answer"), busy: false };
    const { ctx, sent } = fakeCtx(s);
    act(ctx, "askCvRegen", "page:ak1");
    act(ctx, "askCvRegenMenu", "page:ak1");
    expect(s.ask.conversation.regen).toBe("page:ak1");
    act(ctx, "askCvRegenWith", "page:ak1:thinking");
    expect(s.ask.conversation.regen).toBeNull();
    expect(sent).toEqual([
      { text: HQ, where: "page", context: ["ticket:14"], mode: "smart", replaceFrom: 2 },
      { text: HQ, where: "page", context: ["ticket:14"], mode: "thinking", replaceFrom: 2 },
    ]);
  });

  it("the Regenerate with menu: ask/state's modes with their hints, the answer's own checked; Free has no menu", () => {
    const html = view("answer", { over: (s) => { s.ask.conversation.regen = "page:ak1"; } }).html;
    expect(html).toMatch(/<div class="ask-menu ask-regen-menu" role="menu" aria-label="Regenerate with">/);
    expect(html.match(/role="menuitemradio"/g)?.length).toBe(3);
    expect(html).toMatch(/aria-checked="true" data-act="askCvRegenWith" data-arg="page:ak1:smart"/);
    expect(text(html)).toContain("Counts as 5 questions.");
    const s = base("free");
    s.ask.page = convoOf("answer");
    const free = conversationView(askView(s, "page"));
    expect(free).toContain(`data-act="askCvRegen"`);
    expect(free).not.toContain("askCvRegenMenu");
  });

  it("Try again: regenerate when the failed answer was stored, else ask the question again in its place", async () => {
    const s = base();
    const events: AskEvent[] = [{ event: "error", data: { code: "failed", message: "x" } }];
    s.ask.page = { ...convoOf("answer", { events, qid: 5 }), busy: false };
    const { ctx, sent } = fakeCtx(s);
    act(ctx, "askCvRetry", "page:ak1");
    await flush();
    expect(sent[0]).toMatchObject({ text: HQ, replaceFrom: 5 });
  });

  it("a starter or follow-up sent in the ⌘J panel carries the panel's context, the page's item first", () => {
    const s = base();
    s.screen = "ticketdetail";
    s.ask.cmdj = { ...s.ask.cmdj, open: true, contextRef: "ticket:14" };
    s.ask.composer.panel.context = ["person:maya", "ticket:14"];
    const { ctx, sent } = fakeCtx(s);
    act(ctx, "askCvSend", "What's left before this can close?");
    // With the composer's own mode and switch (Q50: never a mode the allowance can't cover).
    expect(sent).toEqual([{ text: "What's left before this can close?", where: "panel", context: ["ticket:14", "person:maya"], mode: "smart", auto: false }]);
    s.screen = "ask";
    act(ctx, "askCvSend", "What shipped this week?");
    expect(sent[1]).toEqual({ text: "What shipped this week?", where: "page", mode: "smart", auto: false });
  });

  it("disclosures open at once and close through their exit; Copy says Copied", () => {
    const s = base();
    s.ask.page = { ...convoOf("answer"), busy: false };
    const { ctx } = fakeCtx(s);
    act(ctx, "askCvToggle", "ak1:src");
    expect(s.ask.conversation.open["ak1:src"]).toBe(true);
    const html = conversationView(askView(s, "page"));
    expect(html).toMatch(/<div data-morph-key="foot" class="ask-foot-w" data-ask-tween>[\s\S]*<div class="ask-src"><button type="button" class="ask-src-r" data-act="askShOpen" data-arg="ticket:14"><span class="ask-src-n">1<\/span>/);
    act(ctx, "askCvToggle", "ak1:src");
    expect(s.ask.conversation.open["ak1:src"]).toBeUndefined();
    act(ctx, "askCvCopy", "page:ak1");
    expect(s.ask.conversation.copied).toBe("page:ak1");
    expect(conversationView(askView(s, "page"))).toContain("<span>Copied</span>");
  });

  it("Open in inspector: a conversation-held ref, primed as hidden (never peeked), opened beside its conversation", () => {
    const s = base();
    s.ask.page = { ...convoOf("answer"), busy: false };
    const { ctx, opened } = fakeCtx(s);
    const ref = cvRef("page", "ak1", "chart", 1);
    act(ctx, "askCvOpen", ref);
    expect(opened).toEqual([[ref, "page"]]);
    expect(s.ask.refViews[ref]).toEqual({ ref, hidden: true });
    const it = cvItem(s.ask, ref);
    expect(it?.kind === "chart" && it.chart.total).toBe(48);
    expect(cvItem(s.ask, cvRef("page", "ak1", "table", "0.0"))).toMatchObject({ kind: "table", head: ["Ticket", "Status", "Owner", "Waiting on"] });
    expect(cvItem(s.ask, cvRef("page", "qk1", "upload", 900))).toMatchObject({ kind: "upload", attachment: { title: "ci-failure.png" } });
    expect(cvItem(s.ask, cvRef("page", "ak1", "themes", 1))).toBeNull();
    // The shell's frame and trail name it.
    expect(cvRefWord(ref)).toBe("Chart");
    expect(refFallbackText(ref)).toBe("Chart");
    s.ask.inspector = { ...s.ask.inspector, stack: [ref], idx: 0 };
    expect(render(s)).toMatch(/<span class="ask-insp-type">Chart<\/span>/);
  });
});

// ── pieces ──────────────────────────────────────────────────────────────────

describe("markdown and refs", () => {
  it("headings, paragraphs, bullet and numbered lists, code, tables (a bar inside a ref token is not a cell break)", () => {
    expect(parseMd("## A\n\nOne\ntwo\n\n- x\n- y\n\n1. a\n2. b\n\n```\ncode\n```\n| H | S |\n| --- | --- |\n| [[ticket:1]] | [[ticket:1|status]] |")).toEqual([
      { t: "h", text: "A" }, { t: "p", lines: ["One", "two"] }, { t: "ul", items: ["x", "y"] }, { t: "ol", items: ["a", "b"], start: 1 },
      { t: "code", text: "code" }, { t: "table", head: ["H", "S"], rows: [["[[ticket:1]]", "[[ticket:1|status]]"]] },
    ]);
    expect(splitRow("| a | [[ticket:14|status]] | c |")).toEqual(["a", "[[ticket:14|status]]", "c"]);
    // A half-streamed table: its first row heads it already.
    expect(parseMd("| Ticket | Sta")).toEqual([{ t: "table", head: ["Ticket", "Sta"], rows: [] }]);
  });
  it("inline bold, italics and code, across a ref chip; an unlinked token is plain words; Copy names the refs", () => {
    const s = base();
    const events: AskEvent[] = [{ event: "text", data: { delta: "**What [[ticket:14]] is about:** `netlify.test` is *submitted* and [[ticket:999]] too." } }];
    const { html } = view("answer", { events, busy: true });
    expect(html).toMatch(/<strong>What <button type="button" class="ask-chip ask-chip--inline"[^>]*data-ask-ref="ticket:14"[\s\S]*?<\/button> is about:<\/strong> <code class="ask-code">netlify\.test<\/code> is <em>submitted<\/em> and <span class="ask-reftext">#999<\/span>/);
    expect(plainText({ look: { views: s.ask.refViews, persons: [] } }, "See [[ticket:14]] ([[ticket:14|status]]) and [[ticket:999]].")).toBe("See #14 (In progress) and #999.");
  });
  it("a diagram is a chain only when its edges make one; a branching graph is drawn as a graph, a loop as a list", () => {
    const n = (id: string) => ({ id, label: id, eyebrow: null, ref: null, view: null });
    expect(chainOrder({ nodes: [n("a"), n("b"), n("c")], edges: [["b", "c"], ["a", "b"]] })?.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(chainOrder({ nodes: [n("a"), n("b"), n("c")], edges: [["a", "b"], ["a", "c"]] })).toBeNull();
    const events: AskEvent[] = [{ event: "block", data: { kind: "diagram", diagram: { title: "Fan out", caption: null, layout: "chain", nodes: [n("a"), n("b"), n("c")], edges: [["a", "b"], ["a", "c"]] } } }];
    const { html } = view("answer", { events, busy: true });
    expect(html).toMatch(/data-fig="diagram" data-shape="graph"/);
    expect(html.match(/class="ask-dg-ah"/g)?.length).toBe(2);
    const loop: AskEvent[] = [{ event: "block", data: { kind: "diagram", diagram: { title: "Loop", caption: null, layout: "list", nodes: [n("a"), n("b")], edges: [["a", "b"], ["b", "a"]] } } }];
    const looped = view("answer", { events: loop, busy: true }).html;
    expect(looped).toMatch(/data-fig="diagram" data-shape="list"/);
    expect(looped).not.toContain("ask-dg-ah");
    expect(looped).not.toContain("<svg class=\"ask-dg-e");
  });
  it("theme tooltips, quiet steps, and the local ref's round trip", () => {
    expect(themeTip("Hosting", "Sep 14", 0.7)).toBe("Hosting, week of Sep 14: 70% of capacity");
    expect(themeTip("Hosting", "Sep 14", 0)).toBe("Hosting, week of Sep 14: none");
    expect(quietStep({ tool: "show_chart" })).toBe(true);
    expect(quietStep({ tool: "save_artifact" })).toBe(true);
    expect(quietStep({ tool: "read_attachment" })).toBe(false);
    expect(parseCvRef(cvRef("panel", "m12", "table", "3.1"))).toEqual({ where: "panel", key: "m12", kind: "table", n: "3.1" });
    expect(parseCvRef("ticket:14")).toBeNull();
    expect(isCvRef("askcv:page:x:chart:0")).toBe(true);
  });
});

describe("contract — the events this part consumes, from every design transcript", () => {
  it.each(["answer", "thinking", "notfound", "search", "streaming", "answer-pr"] as const)("%s: steps run → done, blocks of known kinds, done with cites", (sc) => {
    const events = askTranscript(sc, NOW).map((s) => s.event);
    for (const e of events) {
      if (e.event === "activity" && e.data.state === "run") expect(e.data).toEqual({ step: expect.any(Number), tool: expect.any(String), icon: expect.any(String), label: expect.any(String), state: "run" });
      if (e.event === "activity" && e.data.state === "done") for (const r of e.data.results ?? []) expect(r).toMatch(/^[a-z]+:/);
      if (e.event === "thinking" && e.data.state === "done") expect(e.data).toEqual({ state: "done", seconds: expect.any(Number), summary: expect.any(String) });
      if (e.event === "block") expect(["items", "chart", "themes", "diagram", "not_found", "save_form"]).toContain(e.data.kind);
      if (e.event === "done") expect(e.data.cites.every((c) => typeof c.ref === "string" && typeof c.title === "string")).toBe(true);
    }
    // Everything renders without throwing.
    expect(view(sc).html.length).toBeGreaterThan(200);
  });
});

describe("a phone — nothing hovers, every touch target is 44px", () => {
  it("rich blocks draw no hover toolbar; Edit is on the last question, always shown", () => {
    const { html } = view("answer", { over: (s) => { s.phone = true; } });
    expect(html).toContain(`data-rich="chart"`);
    expect(html).not.toContain("ask-tools");
    expect(html).toContain(`data-act="askCvEdit" data-arg="page:qk1"`);
    expect(css).toMatch(/\[data-phone="1"\] \.ask-q-edit \{ opacity:1; \}|\[data-phone="1"\] \.ask-q-edit[^{]*\{ opacity:1; \}/);
    expect(css).toMatch(/\[data-phone="1"\] \.ask-tools \{ display:none; \}/);
    expect(view("answer").html).toContain("ask-tools");
  });
  it("ref chips and the footer's buttons get a 44px hit area (not a bigger look); rows in a stack a 44px min-height", () => {
    const rule = (sel: string) => css.split("\n").find((l) => l.includes(sel) && /height:44px/.test(l)) ?? "";
    for (const sel of ['[data-phone="1"] .ask-col .ask-chip::after', '[data-phone="1"] .ask-fb::after', '[data-phone="1"] .ask-q-edit::after', '[data-phone="1"] .ask-nf-try::after']) {
      expect(rule(sel), sel).toMatch(/content:""; position:absolute;[^}]*height:44px/);
    }
    for (const sel of ['[data-phone="1"] .ask-fu', '[data-phone="1"] .ask-res', '[data-phone="1"] .ask-src-r', '[data-phone="1"] button.ask-step']) {
      expect(rule(sel), sel).toContain("min-height:44px");
    }
  });
});

describe("motion — reduced motion and corners for the conversation's pieces", () => {
  const ask = css.slice(css.indexOf("/* ══ Ask Trov"), css.indexOf("/* ── the site on a phone"));
  const reduce = ask.slice(ask.indexOf("@media (prefers-reduced-motion: reduce)"));
  const block = reduce.slice(0, reduce.indexOf("\n}\n"));
  it.each([".ask-step-det", ".ask-think-sum", ".ask-think-l", ".ask-src", ".ask-bar-b", ".ask-tl", ".ask-dg-n", ".ask-dg-e--lr", ".ask-dg-e--tb", ".ask-q-editbox", ".ask-q-edit", ".ask-chev", ".ask-tools", ".ask-ci"])("%s is off under prefers-reduced-motion", (cls) => {
    expect(block).toContain(cls);
  });
  it("the disclosures, the question and the footer are tweened (their height glides)", () => {
    const { html } = view("answer");
    expect(html).toMatch(/class="ask-step-w" data-morph-key="s:1" data-ask-tween/);
    expect(html).toContain(`<div data-morph-key="foot" class="ask-foot-w" data-ask-tween>`);
    expect(html).toMatch(/class="ask-q can-edit" data-morph-key="q:qk1" data-ask-tween/);
  });
});

// ── ONE item (web/src/ask-one.ts): its own layout, never the grid's card stretched ─────────────────────────────

describe("one item — the single item card (ask-one.ts)", () => {
  const PEOPLE = [
    { handle: "andres", name: "Andres Lopez", color: "moss", avatar_url: null, role: null },
    { handle: "maya", name: "Maya Chen", color: "sky", avatar_url: null, role: null },
    { handle: "priya", name: "Priya Natarajan", color: "plum", avatar_url: null, role: null },
    { handle: "jon", name: "Jon Park", color: "ochre", avatar_url: null, role: null },
  ];
  const V = askRefFixtures(NOW) as Record<string, RefView>;
  const REPO = Object.keys(V).find((k) => k.startsWith("repo:"))!;
  V[REPO] = { ...V[REPO], extra: { facts: askRepoFacts(repoScenario("N", "trov", { now: NOW.getTime() })) } };
  // What the server adds for this card (src/ai/ask/refs.ts; test/ask.views.test.ts), which the design's fixtures predate.
  const add = (ref: string, extra: Record<string, unknown>) => { V[ref] = { ...V[ref], extra: { ...V[ref].extra, ...extra } }; };
  add("ticket:14", { excerpt: "Walk a new org from an empty Repo screen to its first deploy." });
  add("pr:176", { excerpt: "Adds the Netlify step to guided setup." });
  add("sprint:7", { excerpt: "Every host behind one provider interface." });
  add("person:andres", { openTickets: 5 });
  V["decision:7"] = { ref: "decision:7", type: "decision", num: 7, title: "Tokens live in one table", owner: "andres", updated: "2026-10-03T10:00:00Z", href: null,
    status: { mark: "check", tone: "accent", word: "Ratified", tip: "A person ratified this decision." }, extra: { excerpt: "Every provider's token goes through **one** resolver." } };
  V["prompt:release-notes"] = { ref: "prompt:release-notes", type: "prompt", title: "Write the release notes", owner: "priya", updated: "2026-10-12T10:00:00Z", href: "#prompts/release-notes",
    status: { mark: "dot", tone: "green", word: "Published", tip: "Settled: published by a person." }, extra: { excerpt: "Merged PRs into release notes." } };
  const look = { views: V, persons: PEOPLE } as unknown as Parameters<typeof singleItemCard>[0]["look"];
  const one = (ref: string, over: Partial<RefView> = {}): string => singleItemCard({ look: { ...look, views: { ...V, [ref]: { ...V[ref], ...over } } } }, { ...V[ref], ...over });
  /** The facts column as [label, plain value] pairs, in order. */
  const facts = (html: string): [string, string][] =>
    [...html.matchAll(/<dt class="ask-one-l">([^<]*)<\/dt><dd class="ask-one-v">([\s\S]*?)<\/dd>/g)].map((m) => [m[1], text(m[2]).trim()]);
  const labels = (html: string): string[] => facts(html).map(([l]) => l);
  const words = (html: string): string => text(html.match(/<p class="ask-one-x">([\s\S]*?)<\/p>/)?.[1] ?? "").trim();

  it("an items block with ONE item draws the single card; two or more keep the grid of cards", () => {
    const done: AskEvent = { event: "done", data: { messageId: 2, questionId: 1, cites: [], tokens: { in: 1, out: 1, cached: 0 } } };
    const single = view("answer", { events: [{ event: "block", data: { kind: "items", items: [V["ticket:14"]] } }, done] }).html;
    expect(single).toMatch(/<div class="ask-rich" data-rich="items">[\s\S]*?<div class="ask-one-c"><div class="ask-one cnpy-hitbox" data-one="ticket">/);
    expect(single).not.toContain("ask-cards");
    const two = view("answer", { events: [{ event: "block", data: { kind: "items", items: [V["ticket:14"], V["pr:176"]] } }, done] }).html;
    expect(two).toContain(`<div class="ask-cards" style="--n:2">`);
    expect(two).not.toContain("ask-one");
  });

  it("the whole card is ONE hitArea that opens the item (its last child); nothing inside is a button", () => {
    const html = one("ticket:14");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button data-act="askShOpen" data-arg="ticket:14" class="cnpy-hit" aria-label="Ticket #14: Guided repository setup"><\/button>\s*<\/div><\/div>$/);
    expect(text(html)).toContain("Open beside the thread");
  });

  it("ticket: the eyebrow and number, its body under the title; status, priority, assignees (pictures), sprint", () => {
    const html = one("ticket:14");
    expect(text(html)).toContain("Ticket #14");
    expect(html).toContain(`<span class="ask-one-t">Guided repository setup</span>`);
    expect(words(html)).toMatch(/^Walk a new org from an empty Repo screen/);
    expect(facts(html)).toEqual([["Status", "In progress"], ["Priority", "High"], ["Assignees", "MC AL Maya Chen +1"], ["Sprint", "Hosting"]]);
    expect(html.match(/class="cnpy-av"/g)?.length).toBe(2);                  // both assignees' pictures, through people.ts
    expect(facts(one("ticket:19", { extra: { priority: "normal", assignees: [], sprint: null } }))).toEqual([["Status", "Triage"], ["Priority", "Normal"], ["Assignees", "Unassigned"], ["Sprint", "Backlog"]]);
  });

  it("pull request: the repository beside the number, its What; state, checks (the summary and n of m), author, branch", () => {
    const html = one("pr:176");
    expect(text(html)).toContain("Pull request #176");
    expect(html).toMatch(/<span class="ask-one-ebr">[^<]+\/[^<]+<\/span>/);
    expect(words(html)).toMatch(/^Adds the Netlify step/);
    expect(facts(html)).toEqual([["State", "In review"], ["Checks", "Checks failing 3 of 4"], ["Author", "MC Maya Chen"], ["Branch", "maya/netlify-connect → main"]]);
    expect(facts(one("pr:176", { extra: { ...V["pr:176"].extra, checks: [] } }))[1]).toEqual(["Checks", "None captured"]);
  });

  it("doc: status, owner, space, version; the excerpt as plain words (markdown's marks out)", () => {
    const html = one("doc:hosting-connections");
    expect(labels(html)).toEqual(["Status", "Owner", "Space", "Version"]);
    expect(facts(html)[3]).toEqual(["Version", "v4"]);
    expect(words(html)).toMatch(/^An org connects a hosting account once/);
    expect(words(one("doc:hosting-connections", { extra: { ...V["doc:hosting-connections"].extra, excerpt: "**Sapling** is `fast`, see [the doc](https://x.y)." } }))).toBe("Sapling is fast, see the doc.");
  });

  it("decision: status, author, when it was proposed; the decision", () => {
    const html = one("decision:7");
    expect(facts(html)).toEqual([["Status", "Ratified"], ["Author", "AL Andres Lopez"], ["Proposed", "Oct 3"]]);
    expect(words(html)).toBe("Every provider's token goes through one resolver.");
  });

  it("feed entry: the kind word comes off the title into the facts; author, posted; the brief", () => {
    const html = one("feed:41", { title: "Shipped: status marks replace pills" });
    expect(html).toContain(`<span class="ask-one-t">Status marks replace pills</span>`);
    expect(labels(html)).toEqual(["Kind", "Author", "Posted"]);
    expect(facts(html).slice(0, 2)).toEqual([["Kind", "Shipped"], ["Author", "PN Priya Natarajan"]]);
    expect(words(html)).toMatch(/^Every board, table and rail/);
    expect(labels(one("feed:41"))).toEqual(["Author", "Posted"]);         // no kind word: no kind, never a guess
  });

  it("sprint: status, dates, progress as a thin bar and “n of m done”, lead; its summary", () => {
    const html = one("sprint:7");
    expect(facts(html)).toEqual([["Status", "3 days late"], ["Dates", "Oct 5 – 30"], ["Progress", "7 of 12 done"], ["Lead", "AL Andres Lopez"]]);
    expect(html).toContain(`<span class="ask-one-fill" style="width:58%"></span>`);
    expect(words(html)).toMatch(/^Every host behind one provider interface/);
    expect(facts(one("sprint:7", { extra: { ...V["sprint:7"].extra, progress: { closed: 0, total: 0 } } }))[2]).toEqual(["Progress", "No tickets yet"]);
  });

  it("handoff: status, from, to (anyone in words), sent; its task", () => {
    const html = one("handoff:11");
    expect(text(html)).toContain("Handoff #11");
    expect(labels(html)).toEqual(["Status", "From", "To", "Sent"]);
    expect(facts(html)[2]).toEqual(["To", "Anyone"]);
    expect(words(html)).toMatch(/^Pick up the performance plan/);
  });

  it("artifact: visibility, state, kind, version, author", () => {
    expect(facts(one("artifact:hosting-status-oct-15"))).toEqual([["Visibility", "Private"], ["State", "Draft"], ["Kind", "HTML page"], ["Version", "v1"], ["Author", "AL Andres Lopez"]]);
  });

  it("person: the picture, name and handle, the role; open tickets and what they are working on (their marks, from the look)", () => {
    const html = one("person:andres");
    expect(html).toMatch(/<div class="ask-one-who"><div class="cnpy-av"[^>]*>AL<\/div><div class="ask-one-whot"><span class="ask-one-t">Andres Lopez<\/span><span class="ask-one-h" style="color:var\(--p-moss\)">@andres<\/span>/);
    expect(words(html)).toBe("Founder. Hosting and the gate.");
    expect(facts(html)).toEqual([["Open tickets", "5"], ["Working on", "#18 Hosting connections: Netlify and Vercel #29 Fix the Netlify connect test on main"]]);
    expect(facts(one("person:jon", { extra: { handle: "jon", workingOn: [] } }))).toEqual([["Working on", "Nothing in progress"]]);
  });

  it("prompt: status, author, slug; its description", () => {
    const html = one("prompt:release-notes");
    expect(facts(html)).toEqual([["Status", "Published"], ["Author", "PN Priya Natarajan"], ["Slug", "release-notes"]]);
    expect(words(html)).toBe("Merged PRs into release notes.");
  });

  it("repository: each environment's verdict (the Overview's), what needs attention; the head's checks under the title", () => {
    const html = one(REPO);
    const f = facts(html);
    expect(f.length).toBeGreaterThan(1);
    expect(f[f.length - 1][0]).toBe("Attention");
    expect(words(html)).toMatch(/^Production: /);
    // Not read: Unknown, never Healthy, and the words say so.
    const unread = one(REPO, { extra: { facts: null } });
    expect(facts(unread)).toEqual([["State", "Unknown"]]);
    expect(words(unread)).toBe("Trov has no reading of this repository yet.");
  });

  it("plainWords: markdown's inline marks out, the words kept", () => {
    expect(plainWords("- **Bold** and *em* with `code` and ![img](a.png) [link](b)")).toBe("Bold and em with code and img link");
    expect(plainWords("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("CSS: two zones side by side, stacked under 560px of the card's own width (a container query); motion off; corners", () => {
    expect(css).toContain(".ask-one-c { container:askone / inline-size; }");
    expect(css).toMatch(/\.ask-one \{ display:grid; grid-template-columns:minmax\(0, 1fr\) minmax\(272px, 44%\);[^}]*grid-template-areas:"id facts" "ft facts";/);
    const narrow = css.slice(css.indexOf("@container askone (max-width: 559px)"));
    const block = narrow.slice(0, narrow.indexOf("\n}\n"));
    expect(block).toMatch(/\.ask-one \{ grid-template-columns:minmax\(0, 1fr\);[^}]*grid-template-areas:"id" "facts" "ft"; \}/);
    expect(block).toMatch(/\.ask-one-facts \{[^}]*border-left:0; border-top:1px solid var\(--border\)/);
    const reduce = css.slice(css.indexOf("/* the conversation's */"));
    expect(reduce.slice(0, 600)).toContain(".ask-one, .ask-one-go { transition:none !important; }");
    expect(reduce.slice(0, 600)).toContain(".ask-one-fill { animation:none !important; }");
    expect(css).toContain("[data-cnpy-theme] .ask-one,");
    expect(css).toContain("[data-cnpy-theme] .ask-one-fill { border-radius:calc(2px * var(--corner-scale)) !important; }");
  });
});
