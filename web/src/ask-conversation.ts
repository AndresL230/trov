// Ask Trov — the conversation (SEAM: a sibling agent replaces this stub; inventory §1b, §2).
//
// TODO(conversation): build to the design — the question bubble (files, image thumbs, context chips, Edit on
// the last question → edit-and-resend), activity steps (expandable result rows), thinking ("Thinking… Ns" →
// "Thought for Ns"), the answer's markdown (headings, lists, tables with status cells, ref chips), the rich
// blocks (item cards, bar chart, theme strip, dependency chain, not found) with their hover toolbar, the soft
// cursor, Stopped / error rows, the footer (mode word, N sources, Copy, Regenerate + "Regenerate with", Save as
// artifact, Wrong?) and the follow-ups under the last answer. The empty state (headline + starters) is yours too.
//
// THE INTERFACE (keep it; the shell and the ⌘J panel call these):
//   ConversationUi / initialConversationUi()   your state, at `AppState.ask.conversation`
//   conversationView(v)                         the scroller's contents for `v.where` (page or panel)
//   emptyView(v)                                a thread with no messages yet (above the composer)
//   conversationPart                            your acts (`askCv…`), Escape layers, afterPaint (scroll stick)
// Data: `convoOf(v).messages` (ask-stream.ts AskMsg: questions + AskTurn answers), `shownParts(turn)` for the
// answer in order (text / block / grouped actions), `v.look` for every ref (ask-refs.ts refChip, statusCell,
// splitRefTokens), `v.ui.state.data` for modes. Cards, done lines, Save forms and Wrong? are ask-actions.ts's:
// call `actionGroupView`, `saveFormView`, `feedbackView`. Send through `ctx.send`, regenerate with
// `ctx.send({ text: <its question>, replaceFrom: turn.messageId })`, open items with `ctx.openRef`.
// CSS: your block in trov.css is `/* ── Ask: conversation ── */`.

import { esc, attr } from "./ui";
import type { AskCtx, AskPart, AskView } from "./ask-state";
import { convoOf } from "./ask-state";
import { refChip, splitRefTokens, statusCell } from "./ask-refs";
import { askIcon, askSpinner, ACTIVITY_ICON, trovMark } from "./ask-icons";
import { shownParts, turnLive, type AskAnswer, type AskQuestion, type AskTurn } from "./ask-stream";
import { actionGroupView, feedbackView, saveFormView } from "./ask-actions";
import { ASK_STARTERS_FALLBACK, askMode } from "@shared/ai-ask-core";
import { skeleton, skLine, skLines } from "./skeleton";

export interface ConversationUi {
  /** Disclosures by key (`<answerKey>:s<step>`, `<answerKey>:think`, `<answerKey>:src`). */
  open: Record<string, boolean>;
  /** Stick to the bottom while an answer streams (false once the person scrolls up). */
  stick: boolean;
}
export const initialConversationUi = (): ConversationUi => ({ open: {}, stick: true });

/** Text with its ref tokens as chips (the stub keeps the markdown as plain text). */
function inline(v: AskView, md: string): string {
  return splitRefTokens(md).map((s) => ("text" in s ? esc(s.text) : s.status ? statusCell(s.ref, v.look) : refChip(s.ref, v.look))).join("");
}

function question(v: AskView, q: AskQuestion): string {
  const chips = q.context.map((r) => refChip(r, v.look, { size: "tag" })).join("");
  const files = q.attachments.map((f) => `<span class="ask-file">${askIcon(f.kind === "image" ? "image" : "file", 14, "var(--fg-55)")}${esc(f.title)}</span>`).join("");
  return `<div class="ask-q" data-morph-key="q:${attr(q.key)}">
    <div class="ask-q-col">${chips || files ? `<div class="ask-q-att">${files}${chips}</div>` : ""}<div class="ask-q-bubble">${esc(q.text)}</div></div>
  </div>`;
}

function answer(v: AskView, a: AskAnswer, last: boolean): string {
  const t: AskTurn = a.turn;
  const live = turnLive(t);
  const steps = t.activity.map((s) =>
    `<div class="ask-step${s.state === "run" ? " is-run" : ""}" data-morph-key="s:${attr(String(s.step))}">${s.state === "run" ? askSpinner(13) : askIcon(ACTIVITY_ICON[s.icon], 14, "var(--fg-40)")}<span>${esc(s.label)}</span>${s.resultLine ? `<span class="ask-step-n">· ${esc(s.resultLine)}</span>` : ""}</div>`).join("");
  const think = t.thinking
    ? `<div class="ask-step">${askIcon("clock", 14, "var(--fg-40)")}<span>${t.thinking.state === "run" ? "Thinking…" : `Thought for ${t.thinking.seconds}s`}</span></div>`
    : "";
  // MOTION (ask-motion.ts): every part is a keyed child of a `data-ask-enter` list, so a streamed block or card
  // rises in once and a text part only grows in place; an action group / save form is `data-ask-tween`, so its
  // card collapsing to a done line glides. Keep the keys stable per part (`p<i>`).
  const body = shownParts(t).map((p, i) => {
    const key = `p${i}`;
    if (p.kind === "text") return `<div class="ask-text" data-morph-key="${key}">${inline(v, p.md)}</div>`;
    if (p.kind === "actions") return `<div class="ask-part" data-morph-key="${key}" data-ask-tween>${actionGroupView(v, a, p.ids)}</div>`;
    if (p.block.kind === "save_form") return `<div class="ask-part" data-morph-key="${key}" data-ask-tween>${saveFormView(v, a, p.block, p.index)}</div>`;
    // TODO(conversation): the rich blocks. The stub names each one.
    return `<div class="ask-block-stub" data-morph-key="${key}" data-block="${attr(p.block.kind)}">${esc(p.block.kind.replace("_", " "))} block</div>`;
  }).join("");
  const cursor = live ? `<span class="ask-cursor" aria-hidden="true"></span>` : "";
  const err = t.error ? `<div class="ask-err">Something went wrong. <span style="color:var(--fg-55)">Nothing was changed.</span></div>` : "";
  const stopped = t.stopped ? `<div class="ask-stopped">Stopped. The answer above is partial.</div>` : "";
  const foot = t.done && !t.error
    ? `<div class="ask-foot">${trovMark(13)}<span>${esc(askMode(t.mode).label)}</span><span>· ${t.cites.length ? `${t.cites.length} source${t.cites.length === 1 ? "" : "s"}` : "No sources"}</span></div>${feedbackView(v, a)}`
    : "";
  const follow = last && t.done && !convoOf(v).busy && t.followups.length
    ? `<div class="ask-follow">${t.followups.map((f) => `<button type="button" data-act="askCvSend" data-arg="${attr(f)}">${askIcon("arrow", 14, "var(--fg-40)")}<span>${esc(f)}</span></button>`).join("")}</div>`
    : "";
  // The answer is itself a keyed list: what comes and goes under it (the cursor, Stopped, the error, the footer,
  // the follow-ups) fades in once where it belongs instead of being paired with its neighbour by index.
  const kids: [string, string][] = [
    ["steps", steps || think ? `<div class="ask-steps" data-morph-list data-ask-enter="fade">${steps}${think ? `<div data-morph-key="think">${think}</div>` : ""}</div>` : ""],
    ["parts", `<div class="ask-parts" data-morph-list data-ask-enter="rise">${body}</div>`],
    ["cursor", cursor], ["err", err], ["stopped", stopped], ["foot", foot ? `<div>${foot}</div>` : ""], ["follow", follow],
  ];
  return `<div class="ask-a" data-morph-key="a:${attr(a.key)}" data-morph-list data-ask-enter="fade">${kids.filter(([, h]) => h).map(([k, h]) => h.replace(/^<(\w+)/, `<$1 data-morph-key="${k}"`)).join("")}</div>`;
}

/** The scroller's contents: every message of the conversation in `v.where`. */
export function conversationView(v: AskView): string {
  const c = convoOf(v);
  // Keyed by the conversation (`uid`): another thread is another column (it enters once); the skeleton and the
  // messages are two keyed children, so the history landing replaces the skeleton with the settle fade
  // (syncSkeletons) and the message list's first paint animates nothing (ask-motion.ts rules 1, 2, 5).
  const col = (inner: string) => `<div class="ask-col" data-morph-key="cv:${attr(c.uid)}">${inner}</div>`;
  if (c.status === "loading" && !c.messages.length) {
    return col(`<div data-morph-key="sk">${skeleton("ask-thread", "Loading the thread…", `<div class="ask-q"><div class="ask-q-col" style="width:min(420px,70%)">${skLine("100%", 14.5, 1.55)}</div></div>${skLines(["92%", "84%", "88%", "60%"], 14.5, 1.7)}`)}</div>`);
  }
  if (c.status === "error" && !c.messages.length) return col(`<div class="ask-loading" data-morph-key="err">Couldn't open this thread.</div>`);
  const lastA = c.messages.map((m) => m.role).lastIndexOf("assistant");
  return col(`<div class="ask-msgs" data-morph-key="msgs" data-morph-list data-ask-enter="rise">${c.messages.map((m, i) => (m.role === "user" ? question(v, m) : answer(v, m, i === lastA))).join("")}</div>`);
}

/** A new thread: the mark, the headline, the starters (from `ask/state`, the design's four as the fallback). */
export function emptyView(v: AskView): string {
  const starters = v.ui.state.data?.starters?.length ? v.ui.state.data.starters : ASK_STARTERS_FALLBACK;
  // Keyed by the conversation: New thread brings it back with its entrance. On arriving at Ask the pieces rise
  // with the screen (`.cnpy-rise` + `--i`, main.ts markEnter); afterwards `.ask-empty` fades in by itself.
  return `<div class="ask-empty" data-morph-key="empty:${attr(convoOf(v).uid)}">
    <div class="cnpy-rise" style="--i:0">${trovMark(28)}</div>
    <h2 class="ask-empty-h cnpy-rise" style="--i:1">Ask anything about your team's work</h2>
    <div class="ask-starters cnpy-rise" style="--i:2">${starters.map((q) => `<button type="button" data-act="askCvSend" data-arg="${attr(q)}">${askIcon("arrow", 13, "var(--fg-40)", 2)}<span>${esc(q)}</span></button>`).join("")}</div>
  </div>`;
}

/** Scrollers already listening (a WeakSet: morph would strip a marker attribute). */
const wired = new WeakSet<HTMLElement>();

export const conversationPart: AskPart = {
  code: "Cv",
  act(ctx: AskCtx, name, arg) {
    // A starter, a follow-up, a rephrase chip: send its words as the next question.
    if (name === "askCvSend" && arg) ctx.send({ text: arg, where: ctx.ui.cmdj.open && ctx.app.screen !== "ask" ? "panel" : "page" });
  },
  afterPaint(ctx, mount) {
    // Stick to the bottom while an answer streams, unless the person scrolled up (the scroller says so).
    for (const sc of Array.from(mount.querySelectorAll<HTMLElement>("[data-ask-scroll]"))) {
      if (!wired.has(sc)) {
        wired.add(sc);
        sc.addEventListener("scroll", () => { ctx.ui.conversation.stick = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 60; }, { passive: true });
      }
      if (ctx.ui.conversation.stick) sc.scrollTop = sc.scrollHeight;
    }
  },
};
