// Ask Trov — the conversation (inventory §1b, §2; ask-trov.dc.html L299–L650; scenarios `live`, `streaming`,
// `thinking`, `answer`, `notfound` and the stream parts of `search` and `answer-pr`).
//
//   the question   a right-aligned bubble, then what came with it as the composer's chips, one size for all (an
//                  image is its 22px thumb; ask-composer.ts `sentFileChip` / `sentRefChip`); Edit on hover over the LAST question (always on a phone)
//                  opens an edit box ("Sending replaces the answer below.") whose Send goes through `replaceFrom`
//   the answer     in stream order: activity steps (each with results opens to "N results", whose rows open in the
//                  inspector; `show_*` / `save_artifact` steps stay quiet; the oversized-image notice is an ordinary
//                  step), thinking ("Thinking… Ns" the client counts → "Thought for Ns", which opens to the summary),
//                  then the parts: markdown (headings, lists, tables with `[[ticket:14|status]]` cells, ref chips),
//                  rich blocks (item cards — ONE item is its own card, ask-one.ts —, the bar chart, the theme strip,
//                  the dependency chain, not found), write
//                  cards and Save forms (ask-actions.ts), with a soft cursor while it streams; Stopped / the error
//   the footer     the Trov mark + the mode word, "N sources" (a numbered list), Copy, Regenerate (+ "Regenerate
//                  with" the modes), Save as artifact and Wrong? (the actions part's acts: `askAcSaveForm`,
//                  `askAcWrong`, their args from ask-actions.ts `saveFormArg` / `wrongIsOpen`), then the follow-ups under the last answer only
//
// THE INTERFACE (the shell and the ⌘J panel call these): ConversationUi / initialConversationUi(), conversationView(v),
// emptyView(v), conversationPart (acts `askCv…`, the "menu" Escape layer, afterPaint). For the inspector: `cvItem(ui,
// ref)` resolves a conversation-held ref (ask-cvref.ts) and `chartFigure` / `themesFigure` / `diagramFigure` /
// `tableView` draw a block bigger without a second copy.
//
// Motion (ask-motion.ts): every message, part and step is a keyed child of a `data-ask-enter` list (streamed parts rise
// in once, a text part only grows); a disclosure (a step's results, the thinking summary, the sources) opens with a
// CSS entrance inside a `data-ask-tween` wrapper (the height glides) and closes through `ctx.exit` (`cv:<key>`); the
// bars grow, the lanes wipe and the chain's nodes rise once, on insertion. All of it off under reduced motion.

import { esc, attr, hitArea, HITBOX, relTime } from "./ui";
import type { AskCtx, AskPart, AskView, AskWhere } from "./ask-state";
import { convoOf, readOnly } from "./ask-state";
import {
  refChip, splitRefTokens, statusCell, viewOf, isHiddenRef, refFallbackText, refLabel, refShort, refTypeWord, refStatusMark,
  repoFactsOf, repoHeadEnv, repoMark, personName, refAvatar,
} from "./ask-refs";
import { askIcon, ACTIVITY_ICON, REF_ICON, trovMark } from "./ask-icons";
import { shownParts, turnLive, type AskAnswer, type AskQuestion, type AskStep, type AskTurn, type AskShownPart } from "./ask-stream";
import { actionGroupView, feedbackView, saveFormArg, saveFormView, wrongIsOpen } from "./ask-actions";
import {
  ASK_STARTERS_FALLBACK, askMode, isAskMode,
  type AskAttachment, type AskChart, type AskDiagram, type AskMode, type AskNotFound, type AskThemesBlock, type RefView,
} from "@shared/ai-ask-core";
import { skeleton, skLine, skLines } from "./skeleton";
import { markShape, tagSquare, tagTone } from "./marks";
import { ciLine } from "./repo-verdict";
import { aiDay } from "./ai-ui";
import { closingAttr, stickAfterScroll } from "./ask-motion";
import { cvRef, parseCvRef } from "./ask-cvref";
import { thinkingOrb, type OrbState } from "./thinking-orb";
import { composerAuto, composerBlock, composerBlockReason, composerMode, parseCommand, sentFileChip, sentRefChip } from "./ask-composer";
import { diagramFigure } from "./ask-diagram";
import { singleItemCard } from "./ask-one";

export interface ConversationUi {
  /** Disclosures by key (`<answerKey>:s<step>`, `<answerKey>:think`, `<answerKey>:src`). */
  open: Record<string, boolean>;
  /** Stick to the bottom while an answer streams (false once the person scrolls up). */
  stick: boolean;
  /** The answer whose Copy reads "Copied" for a moment (`<where>:<answerKey>`). */
  copied: string | null;
  /** The answer whose "Regenerate with" menu is open (`<where>:<answerKey>`). */
  regen: string | null;
  /** Edit-and-resend: the question being edited and its draft. */
  editing: { where: AskWhere; key: string; text: string } | null;
  /** Scrolled up away from the bottom (per scroller): the jump-to-latest arrow shows (`jumpButton`). */
  away: Partial<Record<AskWhere, boolean>>;
}
export const initialConversationUi = (): ConversationUi => ({ open: {}, stick: true, copied: null, regen: null, editing: null, away: {} });

/** Past this far from the bottom, the jump-to-latest arrow shows. */
const AWAY_PX = 160;

/** The jump-to-latest arrow (the owner): it sits on the scroller's bottom edge (a 0-height sticky row, so it changes no
 *  height), shows once the person scrolled up — the scroll listener flips `data-away` without a repaint; the render
 *  writes the same from `ui.conversation.away`, so a morph keeps it — and while an answer streams below it is in the
 *  accent (`data-busy`). A click glides to the bottom and holds on there (`askCvJump`). */
export function jumpButton(v: AskView): string {
  const away = v.ui.conversation.away[v.where] === true;
  return `<div class="ask-jump-w"><button type="button" class="ask-jump" data-act="askCvJump" data-arg="${v.where}" aria-label="Jump to the latest" data-tip="Jump to the latest" data-away="${away ? "1" : "0"}" data-busy="${convoOf(v).busy ? "1" : "0"}"${away ? "" : ` tabindex="-1" aria-hidden="true"`}>${askIcon("chevDown", 16, null, 2.2)}</button></div>`;
}
const setAway = (sc: HTMLElement, away: boolean): void => {
  const b = sc.querySelector<HTMLElement>(".ask-jump");
  if (!b) return;
  b.dataset.away = away ? "1" : "0";
  if (away) { b.removeAttribute("tabindex"); b.removeAttribute("aria-hidden"); } else { b.setAttribute("tabindex", "-1"); b.setAttribute("aria-hidden", "true"); }
};

// ── markdown (the answer's text: headings, lists, tables, code; tolerant of a half-streamed line) ─────────────

export type MdNode =
  | { t: "h"; text: string }
  | { t: "p"; lines: string[] }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[]; start: number }
  | { t: "table"; head: string[] | null; rows: string[][] }
  | { t: "code"; text: string };

const LIST_RE = /^\s*([-*+]|\d{1,3}[.)])\s+(.*)$/;
const isTableLine = (l: string): boolean => /^\s*\|/.test(l);
const isSepRow = (l: string): boolean => /^\s*\|?[\s:|-]*-[\s:|-]*$/.test(l);
const isBlockStart = (l: string): boolean => /^\s*```/.test(l) || /^\s{0,3}#{1,6}\s/.test(l) || isTableLine(l) || LIST_RE.test(l);

/** A table row's cells, split on `|` outside ref tokens (`[[ticket:14|status]]` keeps its bar). */
export function splitRow(line: string): string[] {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cur = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.startsWith("[[", i)) { depth++; cur += "[["; i++; continue; }
    if (s.startsWith("]]", i) && depth > 0) { depth--; cur += "]]"; i++; continue; }
    if (s[i] === "|" && depth === 0) { cells.push(cur.trim()); cur = ""; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

export function parseMd(md: string): MdNode[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: MdNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (h) { out.push({ t: "h", text: h[1].replace(/\s+#+\s*$/, "") }); i++; continue; }
    if (isTableLine(line)) {
      const rows: string[] = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(lines[i++]);
      // The first row heads the table once the separator follows it (or while it is the only row streamed yet).
      const headed = rows.length === 1 || isSepRow(rows[1]);
      const head = headed ? splitRow(rows[0]) : null;
      const body = (headed ? rows.slice(1) : rows).filter((r) => !isSepRow(r)).map(splitRow);
      out.push({ t: "table", head, rows: body });
      continue;
    }
    const li = line.match(LIST_RE);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST_RE);
        if (m && /\d/.test(m[1]) === ordered) { items.push(m[2]); i++; continue; }
        if (items.length && /^\s{2,}\S/.test(lines[i]) && !m) { items[items.length - 1] += ` ${lines[i].trim()}`; i++; continue; }
        break;
      }
      out.push(ordered ? { t: "ol", items, start: Number(li[1].replace(/\D/g, "")) || 1 } : { t: "ul", items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) para.push(lines[i++].trim());
    out.push({ t: "p", lines: para });
  }
  return out;
}

/** While a text part STREAMS, its last line may be half a piece of markdown — a `##` with no words yet, `**bo`, a
 *  `[link](ht`, a table row still being typed. Drawn as-is it shows the raw marks for a moment before they render (the
 *  owner). This settles that tail only: a bare heading / list / fence marker or a half table row waits for its words, an
 *  unclosed `**` / `*` / backtick is closed for now (so the words show bold as they come), a half link shows its text,
 *  a half `[[ref` waits. A finished answer is never touched. */
export function settleTail(md: string): string {
  const cut = md.lastIndexOf("\n");
  const head = md.slice(0, cut + 1);
  let last = md.slice(cut + 1);
  // A bare block marker: "##", "- ", "1.", "`", "``" — nothing to show yet.
  if (/^\s{0,3}#{1,6}\s*$/.test(last) || /^\s*([-*+]|\d{1,3}[.)])\s*$/.test(last) || /^\s*`{1,2}$/.test(last)) return head;
  // A table row still being typed (not closed by its last bar): wait for the whole row.
  if (/^\s*\|/.test(last) && !/\|\s*$/.test(last)) return head;
  // A ref token still coming.
  if (last.lastIndexOf("[[") > last.lastIndexOf("]]")) last = last.slice(0, last.lastIndexOf("[["));
  // A link still coming: its text so far.
  last = last.replace(/\[([^\]]*)\]\([^)]*$/, "$1").replace(/(^|[^[])\[([^\]]*)$/, "$1$2");
  // Unclosed emphasis and code, outside code spans: close them for now (a lone trailing mark just waits). A leading
  // list / heading marker ("* ", "- ", "## ") is not emphasis — it is set aside first.
  const lead = last.match(/^\s*(?:[-*+]|\d{1,3}[.)]|#{1,6})\s+/)?.[0] ?? "";
  last = last.slice(lead.length);
  const ticks = (last.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) last = /`$/.test(last) ? last.slice(0, -1) : `${last}\``;
  const outside = last.split(/`[^`]*`/).join("");
  const bold = (outside.match(/\*\*/g) ?? []).length;
  if (bold % 2 === 1) last = /\*\*\s*$/.test(last) ? last.replace(/\*\*\s*$/, "") : `${last}**`;
  const singles = (last.split(/`[^`]*`/).join("").replace(/\*\*/g, "").match(/\*/g) ?? []).length;
  if (singles % 2 === 1) last = /\*\s*$/.test(last) ? last.replace(/\*\s*$/, "") : `${last}*`;
  return head + lead + last;
}

/** Bold, italics, code and links on ESCAPED text (placeholders for the chips pass through untouched). */
function emphasis(html: string): string {
  // Code spans first, as placeholders, so a mark AROUND code (`**\`a.ts\`:**`) still pairs — splitting on them left
  // the `**` on either side raw (Final pass 2026-10-16, AU-F-MD1); what is inside a code span is never emphasis.
  const codes: string[] = [];
  return html
    .replace(/`([^`]+)`/g, (_, c: string) => `\u0001${codes.push(`<code class="ask-code">${c}</code>`) - 1}\u0001`)
    .replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)([^*]+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>`)
    .replace(/\u0001(\d+)\u0001/g, (_, n: string) => codes[Number(n)] ?? "");
}

/** A run of answer text: its ref tokens as chips (status tokens as the item's live mark), its markdown inline. */
export function inline(v: AskView, md: string, size: "inline" | "cell" = "inline"): string {
  const chips: string[] = [];
  const text = splitRefTokens(md).map((s) => {
    if ("text" in s) return esc(s.text);
    chips.push(s.status ? statusCell(s.ref, v.look, size === "cell" ? 12.5 : 13) : refChip(s.ref, v.look, { size }));
    return `\u0000${chips.length - 1}\u0000`;
  }).join("");
  return emphasis(text).replace(/\u0000(\d+)\u0000/g, (_, n: string) => chips[Number(n)] ?? "");
}

const CURSOR = `<span class="ask-cursor" aria-hidden="true"></span>`;

/** One table, scrolling inside its block. */
export function tableView(v: AskView, head: string[] | null, rows: string[][]): string {
  return `<div class="ask-tbl-scroll"><table class="ask-tbl">${head ? `<thead><tr>${head.map((h) => `<th scope="col">${inline(v, h, "cell")}</th>`).join("")}</tr></thead>` : ""}<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(v, c, "cell")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** A text part as markup; `cur` puts the soft cursor at the end of its last line. `tableTools(k)` wraps table k. */
function mdView(v: AskView, md: string, cur: boolean, tableTools: (k: number, inner: string) => string): string {
  // `cur`: this part is still streaming — its half-written tail is settled first (never a finished answer's).
  const nodes = parseMd(cur ? settleTail(md) : md);
  let tables = 0;
  return nodes.map((n, i) => {
    const c = cur && i === nodes.length - 1 ? CURSOR : "";
    switch (n.t) {
      case "h": return `<h3 class="ask-h">${inline(v, n.text)}${c}</h3>`;
      case "p": return `<p class="ask-p">${n.lines.map((l) => inline(v, l)).join("<br>")}${c}</p>`;
      case "ul": return `<ul class="ask-ul">${n.items.map((it, k) => `<li>${inline(v, it)}${k === n.items.length - 1 ? c : ""}</li>`).join("")}</ul>`;
      case "ol": return `<ol class="ask-ul"${n.start !== 1 ? ` start="${n.start}"` : ""}>${n.items.map((it, k) => `<li>${inline(v, it)}${k === n.items.length - 1 ? c : ""}</li>`).join("")}</ol>`;
      case "code": return `<pre class="ask-pre"><code>${esc(n.text)}</code></pre>${c}`;
      case "table": return `${tableTools(tables++, tableView(v, n.head, n.rows))}${c}`;
    }
  }).join("");
}

/** The answer's words as plain text (Copy): ref tokens as their names, status tokens as their words. */
export function plainText(v: Pick<AskView, "look">, md: string): string {
  return splitRefTokens(md).map((s) => {
    if ("text" in s) return s.text;
    const view = viewOf(v.look, s.ref);
    if (s.status) return view?.status?.word ?? "—";
    return view ? refShort(view) : refFallbackText(s.ref);
  }).join("");
}

// ── marks and names ──────────────────────────────────────────────────────────

/** An item's state as a mark: a repository's is the Overview's verdict (#186), anything else its RefStatus. */
function statusOf(view: RefView | null, size: number): string {
  if (!view) return "";
  if (view.type === "repo") return repoMark(repoFactsOf(view), size);
  return view.status ? refStatusMark(view.status, size) : "";
}

/** A row's meta: "Doc · Oct 12"; a repository's head-environment checks ("2 of 9 checks failing on a1c9e2f"). */
function rowMeta(view: RefView): string {
  if (view.type === "repo") {
    const f = repoFactsOf(view);
    const head = f ? repoHeadEnv(f) : null;
    const ci = f && head ? ciLine(f.ci.find((c) => c.env === head.key)) : null;
    if (ci) return ci.text;
  }
  const day = view.updated ? aiDay(view.updated) : "";
  return `${refTypeWord(view)}${day ? ` · ${day}` : ""}`;
}

/** One found item (a step's result, a source): opens in the inspector. Hidden items are left out. */
function itemRow(v: AskView, ref: string, n: number | null): string {
  if (isHiddenRef(v.look, ref)) return "";
  const view = viewOf(v.look, ref);
  const num = n === null ? "" : `<span class="ask-src-n">${n}</span>`;
  if (!view) return `<div class="${n === null ? "ask-res" : "ask-src-r"} is-wait">${num}<span class="ask-res-t">${esc(refFallbackText(ref))}</span></div>`;
  const icon = askIcon(REF_ICON[view.type], 14, "var(--fg-40)");
  return n === null
    ? `<button type="button" class="ask-res" data-act="askShOpen" data-arg="${attr(ref)}">${icon}<span class="ask-res-t">${esc(refLabel(view))}</span><span class="ask-res-m">${esc(rowMeta(view))}</span></button>`
    : `<button type="button" class="ask-src-r" data-act="askShOpen" data-arg="${attr(ref)}">${num}${icon}<span class="ask-src-t">${esc(refLabel(view))}</span><span style="flex:1"></span><span class="ask-src-m">${esc(rowMeta(view))}</span></button>`;
}

const chev = (open: boolean, down = false): string =>
  `<span class="ask-chev${down ? " ask-chev--down" : ""}${open ? " is-open" : ""}" aria-hidden="true">${askIcon(down ? "chevDown" : "chevRight", down ? 10 : 11, null, down ? 2.6 : 2.4)}</span>`;

const fmtSize = (n: number): string => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ── the rich blocks ──────────────────────────────────────────────────────────

const dataFoot = (): string => `<div class="ask-fig-foot">${trovMark(10)}<span>Data from Trov</span></div>`;

/** The bar chart: "Data from Trov" and the total; `barH` is the bars' area (150 in the thread, bigger in the inspector). */
/** `bare`: no caption and no "Data from Trov" — the inspector draws the title, the line and the query's note itself. */
export function chartFigure(c: AskChart, o: { barH?: number; bare?: boolean } = {}): string {
  const area = o.barH ?? 150;
  const max = Math.max(1, ...c.rows.map((r) => r.value));
  const n = c.rows.length;
  const weekly = /_by_week$/.test(c.query);
  const total = weekly ? `${c.total} in ${n} ${n === 1 ? "week" : "weeks"}` : `${c.total} in all`;
  const aria = `${c.title}. ${c.rows.map((r) => `${r.label}: ${r.value}`).join(", ")}. ${c.total} ${c.unit} in all.`;
  const bars = c.rows.map((r, i) => {
    const h = r.value > 0 ? Math.max(2, Math.round((r.value / max) * (area - 26))) : 0;
    return `<div class="ask-bar"><span class="ask-bar-v">${r.value}</span><div class="ask-bar-b" style="height:${h}px;animation-delay:${i * 45}ms"></div></div>`;
  }).join("");
  return `<figure class="ask-fig${o.bare ? " ask-fig--bare" : ""}" data-fig="chart">
    ${o.bare ? "" : `<figcaption class="ask-fig-cap"><span class="ask-fig-t">${esc(c.title)}</span><span class="ask-fig-s">${esc(total)}</span></figcaption>`}
    <div class="ask-fig-scroll"><div class="ask-bars" role="img" aria-label="${attr(aria)}" style="height:${area}px">${bars}</div>
    <div class="ask-bar-ls" aria-hidden="true">${c.rows.map((r) => `<span>${esc(r.label)}</span>`).join("")}</div></div>
    ${o.bare ? "" : dataFoot()}
  </figure>`;
}

const share = (v: number): number => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
/** A theme cell's words: "Hosting, week of Sep 14: 70% of capacity" (0 → "none"). */
export const themeTip = (theme: string, week: string, v: number): string =>
  `${theme}, week of ${week}: ${share(v) > 0 ? `${Math.round(share(v) * 100)}% of capacity` : "none"}`;

/** The theme strip: a lane per theme, a cell per week tinted by its share; the server's caption says what it counts. */
export function themesFigure(t: AskThemesBlock): string {
  const cols = `grid-template-columns:112px repeat(${t.weeks.length},minmax(0,1fr))`;
  const aria = `${t.title}. ${t.caption}. ${t.lanes.map((l) => `${l.theme}: ${t.weeks.map((w, k) => `${w} ${Math.round(share(l.values[k] ?? 0) * 100)}%`).join(", ")}`).join("; ")}.`;
  const head = `<div class="ask-tg" style="${cols}" aria-hidden="true"><span></span>${t.weeks.map((w) => `<span class="ask-tw">${esc(w)}</span>`).join("")}</div>`;
  const lanes = t.lanes.map((l, i) => {
    const cells = t.weeks.map((w, k) => {
      const v = share(l.values[k] ?? 0);
      const bg = v > 0 ? `color-mix(in srgb, ${tagTone(l.color)} ${Math.round(14 + v * 76)}%, transparent)` : "var(--hover)";
      return `<span class="ask-tc" data-mtip="${attr(themeTip(l.theme, w, v))}" style="background:${bg}"></span>`;
    }).join("");
    return `<div class="ask-tg ask-tl" style="${cols};animation-delay:${i * 90}ms"><span class="ask-tl-n">${tagSquare(l.color, 8)}<span>${esc(l.theme)}</span></span>${cells}</div>`;
  }).join("");
  return `<figure class="ask-fig" data-fig="themes">
    <figcaption class="ask-fig-cap"><span class="ask-fig-t">${esc(t.title)}</span><span class="ask-fig-s">${esc(t.caption)}</span></figcaption>
    <div class="ask-fig-scroll" role="img" aria-label="${attr(aria)}">${head}${lanes}</div>
    ${dataFoot()}
  </figure>`;
}

// The diagram (`show_diagram`) is its own module: ask-diagram.ts. Re-exported for the inspector and the tests.
export { chainOrder, diagramFigure } from "./ask-diagram";

/** One item card (a `hitArea` card: the owner's avatar sits on it, the whole card opens the item). */
function itemCard(v: AskView, it: RefView): string {
  const view = viewOf(v.look, it.ref) ?? it;
  const num = view.num != null && (view.type === "ticket" || view.type === "pr" || view.type === "handoff") ? ` #${view.num}` : "";
  const st = statusOf(view, 12);
  const owner = view.owner ?? null;
  return `<div class="ask-ci ${HITBOX}">${hitArea("askShOpen", view.ref, `${refTypeWord(view)}${num}: ${view.title}`)}
    <span class="ask-ci-eb">${askIcon(REF_ICON[view.type], 13, "var(--fg-40)")}${esc(refTypeWord(view) + num)}</span>
    <span class="ask-ci-t">${esc(view.title)}</span>
    ${st ? `<span class="ask-ci-st">${st}</span>` : ""}
    <span class="ask-ci-ft">${owner ? `${refAvatar(v.look, owner, 16)}<span class="ask-ci-o">${esc(personName(v.look, owner))}</span>` : ""}<span style="flex:1"></span>${view.updated ? `<span class="ask-ci-up">${esc(relTime(view.updated))}</span>` : ""}</span>
  </div>`;
}

function notFoundView(nf: AskNotFound, ro = false): string {
  // A reader can't ask in someone else's conversation: the tries are words, not buttons.
  const tryOf = (t: string) => (ro ? `<span class="ask-nf-try is-static">${askIcon("arrow", 12, null, 2)}<span>${esc(t)}</span></span>`
    : `<button type="button" class="ask-nf-try" data-act="askCvSend" data-arg="${attr(t)}">${askIcon("arrow", 12, null, 2)}<span>${esc(t)}</span></button>`);
  return `<div class="ask-nf">
    <div class="ask-nf-h">${askIcon("searchMinus", 16, "var(--fg-55)")}<span>I couldn't find that in Trov.</span></div>
    <p class="ask-p">Nothing you can see mentions “${esc(nf.query)}”. It may live somewhere Trov doesn't read, like email or a call. Try asking about something Trov keeps, or name an item:</p>
    ${nf.tries.length ? `<div class="ask-nf-tries">${nf.tries.map(tryOf).join("")}</div>` : ""}
    ${nf.searched.length ? `<div class="ask-nf-card"><div class="ask-nf-head">What I searched</div>${nf.searched.map((s) =>
      `<div class="ask-nf-row">${markShape("ring", "var(--fg-40)", 9)}<span class="ask-nf-a">${esc(s.area)}</span><span class="ask-nf-s">${esc(s.scope)}</span><span style="flex:1"></span><span class="ask-nf-none">No matches</span></div>`).join("")}</div>` : ""}
  </div>`;
}

/** A rich block's frame: on hover (or focus inside) Save as artifact — once the answer is stored — and Open in inspector. */
function rich(v: Pick<AskView, "app">, kind: string, inner: string, save: string | null, open: string | null): string {
  // A phone has nothing to hover: no toolbar (the design's phone scenarios).
  if (v.app.phone) { save = null; open = null; }
  const tools = [
    save ? `<button type="button" class="ask-tool" data-act="askAcSaveForm" data-arg="${attr(save)}" aria-label="Save as artifact" data-mtip="Save as artifact">${askIcon("saveArtifact", 13, null, 1.9)}</button>` : "",
    open ? `<button type="button" class="ask-tool" data-act="askCvOpen" data-arg="${attr(open)}" aria-label="Open in inspector" data-mtip="Open in inspector">${askIcon("openBeside", 13, null, 1.9)}</button>` : "",
  ].join("");
  return `<div class="ask-rich" data-rich="${kind}">${tools ? `<div class="ask-tools" role="toolbar" aria-label="Block actions">${tools}</div>` : ""}${inner}</div>`;
}

function blockView(v: AskView, a: AskAnswer, p: Extract<AskShownPart, { kind: "block" }>): string {
  const b = p.block;
  // The actions part's format; a reader saves nothing from someone else's conversation.
  const save = a.turn.messageId !== null && !readOnly(v) ? saveFormArg(a, p.index) : null;
  const open = (kind: "chart" | "themes" | "diagram") => cvRef(v.where, a.key, kind, p.index);
  switch (b.kind) {
    case "items": {
      const items = b.items.filter((it) => !isHiddenRef(v.look, it.ref));
      if (!items.length) return "";
      // Cards open themselves: no Open in inspector. ONE item is its own layout (ask-one.ts), never a stretched card.
      if (items.length === 1) return rich(v, "items", singleItemCard(v, items[0]), save, null);
      return rich(v, "items", `<div class="ask-cards" style="--n:${Math.min(items.length, 3)}">${items.map((it) => itemCard(v, it)).join("")}</div>`, save, null);
    }
    case "chart": return rich(v, "chart", chartFigure(b.chart), save, open("chart"));
    case "themes": return rich(v, "themes", themesFigure(b.themes), save, open("themes"));
    case "diagram": return rich(v, "diagram", diagramFigure(v, b.diagram), save, open("diagram"));
    case "not_found": return notFoundView(b.notFound, readOnly(v));
    // A save form is the owner's own step: a reader never sees it.
    case "save_form": return readOnly(v) ? "" : saveFormView(v, a, b, p.index);
  }
}

// ── the question ─────────────────────────────────────────────────────────────

function fileView(v: AskView, q: AskQuestion, f: AskAttachment): string {
  // The composer's chip, the same size for every file (the owner: an image is its 22px thumb, not a bigger card).
  // On a conversation someone else shared, their file stays their private artifact: its name, never a way in.
  const owner = convoOf(v).thread?.owner;
  const closed = readOnly(v) ? `Private to ${owner ? personName(v.look, owner) : "the person who attached it"}: you can see its name, not what is in it.` : null;
  return sentFileChip({ kind: f.kind, title: f.title, size: f.size, thumbUrl: f.thumbUrl }, "askCvOpen", cvRef(v.where, q.key, "upload", f.id), closed);
}

function question(v: AskView, q: AskQuestion, last: boolean): string {
  const busy = convoOf(v).busy;
  const ed = v.ui.conversation.editing;
  const editing = ed !== null && ed.where === v.where && ed.key === q.key;
  // A reader of someone else's shared conversation never edits it (only its owner continues it).
  const canEdit = last && !busy && !readOnly(v);
  const files = q.attachments.map((f) => fileView(v, q, f)).join("");
  const ctx = q.context.map((r) => sentRefChip(v.look, r)).join("");
  const edit = canEdit && !editing
    ? `<button type="button" class="ask-q-edit" data-act="askCvEdit" data-arg="${attr(`${v.where}:${q.key}`)}" aria-label="Edit message">${askIcon("rename", 11)}<span>Edit</span></button>` : "";
  const body = editing && canEdit && ed
    ? `<div class="ask-q-editbox">
        <textarea class="ask-q-ta" rows="3" data-act="askCvEditText" data-field="askCvEdit:${attr(v.where)}" data-ask-edit aria-label="Edit your message">${esc(ed.text)}</textarea>
        <div class="ask-q-editbar"><span class="ask-q-edithint">Sending replaces the answer below.</span>
          <button type="button" class="ask-btn" data-act="askCvEditCancel">Cancel</button>
          <button type="button" class="ask-btn ask-btn--accent" data-act="askCvEditSend"${ed.text.trim() ? "" : " disabled"}>Send</button></div>
      </div>`
    // The words first, what came with them under the bubble (the owner, 2026-10-16).
    : `<div class="ask-q-col"><div class="ask-q-bubble">${esc(q.text)}</div>${files || ctx ? `<div class="ask-q-att">${files}${ctx}</div>` : ""}${edit}</div>`;
  // `data-ask-tween`: the bubble ↔ the edit box glides instead of jumping.
  // Edit sits small under the question (the owner), inside its column, so it never shifts the bubble.
  return `<div class="ask-q${canEdit ? " can-edit" : ""}" data-morph-key="q:${attr(q.key)}" data-ask-tween>${body}</div>`;
}

// ── the answer ───────────────────────────────────────────────────────────────

/** What a running step's orb shows (thinking-orb.ts): looking things up searches, anything else works. */
const STEP_ORB: Partial<Record<AskStep["icon"], OrbState>> = { search: "searching", docs: "searching", feed: "searching", read: "searching", review: "searching" };
/** A step's orb: any search (`search_*`, `query`, or a step the server labels "Searched …", e.g. `list_tickets`) is the globe. */
const stepOrb = (s: Pick<AskStep, "tool" | "icon" | "label">): OrbState => (/^(search|query|find)/.test(s.tool) || /^Search/.test(s.label) ? "searching" : STEP_ORB[s.icon] ?? "working");

/** Every orb in an answer: the person's pick (Settings › Trov, `AskUi.orb`), else — on "match" — `natural`, what that
 *  place means. The label (when the orb is not decorative) still says what Trov is doing, whatever it looks like. */
/** The orb for what Trov is doing (fixed, the owner: no picker) — thinking is the cube ("solving"), writing the ribbon
 *  ("composing"), a search the globe ("searching"), other work the orbits ("working"). */
const orb = (_v: AskView, state: OrbState, label: string | null): string => thinkingOrb(state, 20, label);

/** The show tools and the save form's step are what the answer SHOWS — the design lists no step for them. */
export const quietStep = (s: Pick<AskStep, "tool">): boolean => /^show_/.test(s.tool) || s.tool === "save_artifact";

function stepView(v: AskView, a: AskAnswer, s: AskStep, held = false): string {
  const key = `${a.key}:s${s.step}`;
  // `held`: the latest step reads as still running while Trov works with what it found (the owner: as the gallery
  // shows it) — its result line and toggle come once the next step starts or the answer begins.
  // A notice (a result line and no results, e.g. "Not read") is never held: it is the news, not the work.
  const running = s.state === "run" || (held && !(s.resultLine && !s.results.length));
  const results = running ? [] : s.results.filter((r) => !isHiddenRef(v.look, r));
  const has = results.length > 0;
  const open = has && v.ui.conversation.open[key] === true;
  const run = running ? " is-run" : "";
  // A step keeps its own icon running or done; its label carries the sweep of light while it runs. The ONE orb is
  // the wait row's, under the steps (the owner: the orb and "Thinking…" stay below as the steps appear).
  const icon = askIcon(ACTIVITY_ICON[s.icon] ?? "search", 14, "var(--fg-40)");
  const found = running ? null : s.resultLine ?? (has ? `${results.length} ${results.length === 1 ? "result" : "results"}` : null);
  const line = found ? `<span class="ask-step-n">· ${esc(found)}</span>` : "";
  const head = has
    ? `<button type="button" class="ask-step${run}" data-act="askCvToggle" data-arg="${attr(key)}" aria-expanded="${open}"><span class="ask-step-i">${icon}</span><span class="ask-step-l">${esc(s.label)}</span>${line}${chev(open)}</button>`
    : `<div class="ask-step${run}"><span class="ask-step-i">${icon}</span><span class="ask-step-l">${esc(s.label)}</span>${line}</div>`;
  const det = open ? `<div class="ask-step-det"${closingAttr(v.ui.closing, `cv:${key}`)}>${results.map((r) => itemRow(v, r, null)).join("")}</div>` : "";
  return `<div class="ask-step-w" data-morph-key="s:${s.step}" data-ask-tween>${head}${det}</div>`;
}

/** "Thinking… Ns" — the CLIENT counts from the run event (afterPaint ticks the number between paints). */
export const thinkingLabel = (startedAt: number, now = Date.now()): string => `Thinking… ${Math.max(0, Math.floor((now - startedAt) / 1000))}s`;

function thinkView(v: AskView, a: AskAnswer): string {
  const th = a.turn.thinking;
  if (!th) return "";
  const clock = `<span class="ask-step-i">${askIcon("clock", 14, "var(--fg-40)")}</span>`;
  if (th.state === "run") {
    // While it thinks the clock is a thinking orb ("solving"); "Thought for Ns" keeps the clock.
    return `<div class="ask-think" data-ask-tween><div class="ask-step is-run"><span class="ask-step-i">${orb(v, "solving", null)}</span><span class="ask-think-l" data-ask-think="${th.startedAt}">${thinkingLabel(th.startedAt)}</span></div></div>`;
  }
  const key = `${a.key}:think`;
  const open = v.ui.conversation.open[key] === true;
  return `<div class="ask-think" data-ask-tween>
    <button type="button" class="ask-step" data-act="askCvToggle" data-arg="${attr(key)}" aria-expanded="${open}">${clock}<span class="ask-step-l">Thought for ${th.seconds}s</span>${chev(open)}</button>
    ${open ? `<div class="ask-think-sum"${closingAttr(v.ui.closing, `cv:${key}`)}>${esc(th.summary)}</div>` : ""}
  </div>`;
}

/** The modes "Regenerate with" offers: `ask/state`'s (never a UI constant). */
const modesOf = (v: AskView): { id: AskMode; label: string; hint: string }[] => v.ui.state.data?.modes ?? [];
const modeLabel = (v: AskView, m: AskMode): string => modesOf(v).find((x) => x.id === m)?.label ?? askMode(m).label;

function footer(v: AskView, a: AskAnswer): string {
  const t = a.turn;
  const k = a.key;
  const id = `${v.where}:${k}`;
  // The sources the person can see NOW (a reopened thread re-reads them, QA-1): one since hidden is not counted.
  const n = t.cites.filter((c) => !isHiddenRef(v.look, c.ref)).length;
  const srcOpen = n > 0 && v.ui.conversation.open[`${k}:src`] === true;
  const modes = modesOf(v);
  const regenOpen = v.ui.conversation.regen === id;
  const busy = convoOf(v).busy;
  // Regenerate, Save and Wrong? are the owner's: a reader of a shared conversation gets the sources and Copy.
  const stored = t.messageId !== null && !readOnly(v);
  const menu = regenOpen ? `<div class="ask-menu ask-regen-menu" role="menu" aria-label="Regenerate with"${closingAttr(v.ui.closing, "menu")}>
      <div class="ask-menu-head" aria-hidden="true">Regenerate with</div>
      ${modes.map((m) => `<button type="button" role="menuitemradio" aria-checked="${m.id === t.mode}" data-act="askCvRegenWith" data-arg="${attr(`${id}:${m.id}`)}"><span class="ask-mi"><span class="ask-mi-l">${esc(m.label)}</span><span class="ask-mi-h">${esc(m.hint)}</span></span>${m.id === t.mode ? askIcon("check", 14, "var(--accent)", 2.4) : ""}</button>`).join("")}
    </div>` : "";
  const row = `<div class="ask-foot">
    <span class="ask-foot-mode" data-mtip="Written by Trov">${trovMark(13)}<span>${esc(modeLabel(v, t.mode))}</span></span>
    <span class="ask-foot-sep" aria-hidden="true"></span>
    ${n ? `<button type="button" class="ask-fb" data-act="askCvToggle" data-arg="${attr(`${k}:src`)}" aria-expanded="${srcOpen}">${n} ${n === 1 ? "source" : "sources"}${chev(srcOpen, true)}</button>` : `<span class="ask-fb is-static">No sources</span>`}
    <button type="button" class="ask-fb" data-act="askCvCopy" data-arg="${attr(id)}">${askIcon("copy", 13, null, 2)}<span>${v.ui.conversation.copied === id ? "Copied" : "Copy"}</span></button>
    ${stored ? `<span class="ask-regen"><button type="button" class="ask-fb${modes.length > 1 ? " ask-fb--l" : ""}" data-act="askCvRegen" data-arg="${attr(id)}"${busy ? " disabled" : ""}>${askIcon("regen", 13, null, 2)}<span>Regenerate</span></button>${modes.length > 1
      ? `<button type="button" class="ask-fb ask-fb--r" data-act="askCvRegenMenu" data-arg="${attr(id)}" aria-label="Regenerate with another mode" aria-haspopup="menu" aria-expanded="${regenOpen}"${busy ? " disabled" : ""}>${askIcon("chevDown", 10, null, 2.6)}</button>${menu}` : ""}</span>` : ""}
    ${stored ? `<button type="button" class="ask-fb" data-act="askAcSaveForm" data-arg="${attr(saveFormArg(a))}">${askIcon("saveArtifact", 13, null, 1.9)}<span>Save as artifact</span></button>` : ""}
    ${stored ? `<button type="button" class="ask-fb" data-act="askAcWrong" data-arg="${attr(a.key)}" aria-expanded="${wrongIsOpen(v, a)}">Wrong?</button>` : ""}
  </div>`;
  const sources = srcOpen ? `<div class="ask-src"${closingAttr(v.ui.closing, `cv:${k}:src`)}>${t.cites.map((c, i) => itemRow(v, c.ref, i + 1)).join("")}</div>` : "";
  // One tweened wrapper: the sources list (and the Wrong? row) opening or closing glides the thread under it.
  return `<div class="ask-foot-w" data-ask-tween>${row}${feedbackView(v, a)}${sources}</div>`;
}

function partView(v: AskView, a: AskAnswer, p: AskShownPart, i: number, cur: boolean): string {
  const key = `p${i}`;
  if (p.kind === "text") {
    const save = a.turn.messageId !== null && !readOnly(v) ? saveFormArg(a) : null;
    return `<div class="ask-text" data-morph-key="${key}">${mdView(v, p.md, cur, (k, inner) => rich(v, "table", inner, save, cvRef(v.where, a.key, "table", `${i}.${k}`)))}</div>`;
  }
  if (p.kind === "actions") return `<div class="ask-part" data-morph-key="${key}" data-ask-tween>${actionGroupView(v, a, p.ids)}</div>`;
  if (p.block.kind === "save_form") return readOnly(v) ? "" : `<div class="ask-part" data-morph-key="${key}" data-ask-tween>${blockView(v, a, p)}</div>`;
  return `<div class="ask-part" data-morph-key="${key}" data-block="${attr(p.block.kind)}">${blockView(v, a, p)}</div>`;
}

const STOP_SQ = `<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true" style="flex:none;color:var(--fg-40)"><rect x=".8" y=".8" width="8.4" height="8.4" rx="1.2" fill="currentColor"></rect></svg>`;

function answer(v: AskView, a: AskAnswer, last: boolean): string {
  const t: AskTurn = a.turn;
  const live = turnLive(t);
  const parts = shownParts(t);
  const shownSteps = t.activity.filter((s) => !quietStep(s));
  // While nothing of the answer is out yet (and the Thinking row is not running), the latest step stays "running":
  // the tools finish in ms, but Trov is still working with what that step found.
  const holdLast = live && !parts.length && t.thinking?.state !== "run";
  const steps = shownSteps.map((s, i) => stepView(v, a, s, holdLast && i === shownSteps.length - 1)).join("");
  const think = thinkView(v, a);
  const end = parts.length - 1;
  const cursorIn = live && parts[end]?.kind === "text";
  // MOTION (ask-motion.ts): every part is a keyed child of a `data-ask-enter` list, so a streamed block or card
  // rises in once and a text part only grows; a write card / save form is `data-ask-tween` (its swap glides).
  const body = parts.map((p, i) => partView(v, a, p, i, cursorIn && i === end)).join("");
  // The wait row sits under the steps for the whole wait (the owner): before anything, while steps appear one by one,
  // and after them while the model reads what it found — gone only while words stream (the cursor is in them) or
  // while the Thinking row runs (it says the same, with its own orb). Its orb shows what is happening now: the
  // running step's kind, else working; writing once a block is out.
  const running = holdLast ? shownSteps.at(-1) : shownSteps.filter((s) => s.state === "run").at(-1);
  const curAlone = live && !cursorIn && t.thinking?.state !== "run";
  // A running step's kind wins — before the answer AND after a block is out (the owner, Q-F1); the ribbon ("Writing…")
  // only once a block is out and no step runs; the cube (thinking) before anything.
  const waitOrb: OrbState = running ? stepOrb(running) : parts.length ? "composing" : "solving";
  // Try again asks again: the owner's step, never a reader's.
  const retry = readOnly(v) ? "" : `<button type="button" class="ask-btn ask-btn--sm" data-act="askCvRetry" data-arg="${attr(`${v.where}:${a.key}`)}">Try again</button>`;
  const err = t.error ? `<div class="ask-err" role="alert">${markShape("diamond", "var(--red)", 10)}<span class="ask-err-t">Something went wrong.</span><span class="ask-err-s">Nothing was changed.</span><span style="flex:1"></span>${retry}</div>` : "";
  const stopped = t.stopped ? `<div class="ask-stopped">${STOP_SQ}<span>Stopped. The answer above is partial.</span></div>` : "";
  // Something written: words, a block or a card. A finished answer with none (the model spent its calls on lookups)
  // says so, with Try again, and has no Copy / Save of nothing (Q-F2; the server did not count it).
  const written = parts.some((p) => p.kind !== "text" || p.md.trim() !== "");
  const unwritten = t.done && !t.error && !t.stopped && !written
    ? `<div class="ask-err ask-err--none" role="status">${markShape("square", "var(--fg-40)", 9)}<span class="ask-err-t">Trov didn't write an answer.</span><span style="flex:1"></span>${retry}</div>`
    : "";
  // The footer: a finished answer's — and a stopped one's at once, for what it wrote (QA-4); the stored id that
  // Regenerate, Save and Wrong? need is read back after Stop (ask-controller.ts `readBackStopped`).
  const foot = (t.done || t.stopped) && !t.error && written ? footer(v, a) : "";
  const follow = last && t.done && !t.error && !convoOf(v).busy && t.followups.length && !readOnly(v)
    ? `<div class="ask-follow" role="list" aria-label="Follow-up questions">${t.followups.map((f) => `<div role="listitem"><button type="button" class="ask-fu" data-act="askCvSend" data-arg="${attr(f)}">${askIcon("followUp", 14, "var(--fg-40)")}<span>${esc(f)}</span></button></div>`).join("")}</div>`
    : "";
  // The answer is itself a keyed list: what comes and goes under it (the cursor, Stopped, the error, the footer,
  // the follow-ups) fades in once where it belongs instead of being paired with its neighbour by index.
  const kids: [string, string][] = [
    ["steps", steps || think ? `<div class="ask-steps" data-morph-list data-ask-enter="fade">${steps}${think ? `<div data-morph-key="think">${think}</div>` : ""}</div>` : ""],
    ["parts", `<div class="ask-parts" data-morph-list data-ask-enter="rise">${body}</div>`],
    // Live with no text streaming: a thinking orb and its word, in the sweep of light (the owner: the wait must read
    // as thinking — most of a turn's wait is here, its steps run for a few ms), hold the place where the words will
    // come — "Thinking…" before the words, "Writing…" once a block is out and the words are not.
    ["cursor", curAlone ? `<div class="ask-cur-alone">${orb(v, waitOrb, null)}<span class="ask-wait-l">${waitOrb === "composing" ? "Writing…" : "Thinking…"}</span></div>` : ""], ["err", err], ["none", unwritten], ["stopped", stopped], ["foot", foot], ["follow", follow],
  ];
  return `<div class="ask-a" data-morph-key="a:${attr(a.key)}" data-morph-list data-ask-enter="fade"${live ? ` aria-busy="true"` : ""}>${kids.filter(([, h]) => h).map(([k, h]) => h.replace(/^<(\w+)/, `<$1 data-morph-key="${k}"`)).join("")}</div>`;
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
  const roles = c.messages.map((m) => m.role);
  const lastA = roles.lastIndexOf("assistant");
  const lastQ = roles.lastIndexOf("user");
  return col(`<div class="ask-msgs" data-morph-key="msgs" data-morph-list data-ask-enter="rise">${c.messages.map((m, i) => (m.role === "user" ? question(v, m, i === lastQ) : answer(v, m, i === lastA))).join("")}</div>`);
}

/** A new thread: the mark, the headline, the starters (from `ask/state`, the design's four as the fallback). */
export function emptyView(v: AskView): string {
  const starters = v.ui.state.data?.starters?.length ? v.ui.state.data.starters : ASK_STARTERS_FALLBACK;
  // Blocked (no key, off, the questions used): the starters stay to read but send nothing, and say why (QA-6).
  const block = composerBlock(v);
  const why = block ? composerBlockReason(block) : null;
  const starter = (q: string) => why
    ? `<button type="button" aria-disabled="true" data-mtip="${attr(why)}">${askIcon("arrow", 13, "var(--fg-40)", 2)}<span>${esc(q)}</span></button>`
    : `<button type="button" data-act="askCvSend" data-arg="${attr(q)}">${askIcon("arrow", 13, "var(--fg-40)", 2)}<span>${esc(q)}</span></button>`;
  // Keyed by the conversation: New thread brings it back with its entrance. On arriving at Ask the pieces rise
  // with the screen (`.cnpy-rise` + `--i`, main.ts markEnter); afterwards `.ask-empty` fades in by itself.
  return `<div class="ask-empty" data-morph-key="empty:${attr(convoOf(v).uid)}">
    <div class="cnpy-rise" style="--i:0">${trovMark(28)}</div>
    <h2 class="ask-empty-h cnpy-rise" style="--i:1">Ask anything about your team's work</h2>
    <div class="ask-starters cnpy-rise" style="--i:2"${why ? ` data-blocked` : ""}>${starters.map(starter).join("")}</div>
  </div>`;
}

// ── a conversation-held item, for the inspector (ask-cvref.ts) ───────────────

export type CvItem =
  | { kind: "chart"; chart: AskChart }
  | { kind: "themes"; themes: AskThemesBlock }
  | { kind: "diagram"; diagram: AskDiagram }
  | { kind: "items"; items: RefView[] }
  | { kind: "table"; head: string[] | null; rows: string[][] }
  | { kind: "upload"; attachment: AskAttachment };

/** What a `askcv:` ref names, read from the conversation on screen (null once it is gone). */
export function cvItem(ui: Pick<AskView["ui"], "page" | "panel">, ref: string): CvItem | null {
  const p = parseCvRef(ref);
  if (!p) return null;
  const m = ui[p.where].messages.find((x) => x.key === p.key);
  if (!m) return null;
  if (p.kind === "upload") {
    const f = m.role === "user" ? m.attachments.find((x) => String(x.id) === p.n) : undefined;
    return f ? { kind: "upload", attachment: f } : null;
  }
  if (m.role !== "assistant") return null;
  const parts = shownParts(m.turn);
  if (p.kind === "table") {
    const [pi, ti] = p.n.split(".").map(Number);
    const part = parts[pi];
    if (part?.kind !== "text") return null;
    const tb = parseMd(part.md).filter((n): n is Extract<MdNode, { t: "table" }> => n.t === "table")[ti];
    return tb ? { kind: "table", head: tb.head, rows: tb.rows } : null;
  }
  const part = parts.find((x): x is Extract<AskShownPart, { kind: "block" }> => x.kind === "block" && x.index === Number(p.n));
  const b = part?.block;
  if (!b) return null;
  if (b.kind === "chart" && p.kind === "chart") return { kind: "chart", chart: b.chart };
  if (b.kind === "themes" && p.kind === "themes") return { kind: "themes", themes: b.themes };
  if (b.kind === "diagram" && p.kind === "diagram") return { kind: "diagram", diagram: b.diagram };
  if (b.kind === "items" && p.kind === "items") return { kind: "items", items: b.items };
  return null;
}

// ── acts ─────────────────────────────────────────────────────────────────────

const whereOf = (s: string | undefined): AskWhere => (s === "panel" ? "panel" : "page");

/** The answer `key` in `where`, and the question it answers. */
function exchange(ctx: AskCtx, where: AskWhere, key: string): { a: AskAnswer; q: AskQuestion | null; qi: number } | null {
  const ms = ctx.ui[where].messages;
  const i = ms.findIndex((m) => m.key === key);
  const a = ms[i];
  if (!a || a.role !== "assistant") return null;
  for (let j = i - 1; j >= 0; j--) { const m = ms[j]; if (m.role === "user") return { a, q: m, qi: j }; }
  return { a, q: null, qi: -1 };
}

/** Open, or close with its exit (ask-motion.ts rule 3), one disclosure. */
function toggle(ctx: AskCtx, key: string): void {
  const ui = ctx.ui.conversation;
  if (ui.open[key]) {
    ctx.exit(`cv:${key}`, () => { const { [key]: _gone, ...rest } = ctx.ui.conversation.open; ctx.ui.conversation.open = rest; }, 140);
    return;
  }
  ctx.cancelExit(`cv:${key}`);
  ui.open = { ...ui.open, [key]: true };
  ctx.paint();
}

const closeRegen = (ctx: AskCtx): void => ctx.exit("menu", () => { ctx.ui.conversation.regen = null; }, 120);

/** What to focus after the next paint (the edit box, the menu's checked mode). */
let focusNext: "edit" | "regen" | null = null;

/** Ask question `qi` of `where` again, as `text`: through `replaceFrom` (its stored id — `done.questionId` sets it as
 *  the answer ends; read back from the thread only when the answer ended in an error, with no `done`); a question the
 *  server never stored (no thread yet, or the replay) is dropped here and asked fresh. */
async function resend(ctx: AskCtx, where: AskWhere, qKey: string, text: string): Promise<void> {
  let c = ctx.ui[where];
  const qi = c.messages.findIndex((m) => m.key === qKey);
  const q = c.messages[qi];
  if (!q || q.role !== "user" || c.busy) return;
  let id = q.id;
  if (id === null && c.threadId !== null && !ctx.replay) {
    try {
      const d = await ctx.api.getThread(c.threadId);
      const stored = [...d.messages].reverse().find((m) => m.role === "user");
      id = stored ? stored.id : null;
    } catch (e) {
      ctx.fail(e, "Couldn't send that again.");
      return;
    }
    c = ctx.ui[where];
    if (id === null || c.busy) { ctx.flash("Couldn't send that again."); return; }
    ctx.ui[where] = { ...c, messages: c.messages.map((m) => (m.key === qKey && m.role === "user" ? { ...m, id } : m)) };
  } else if (id === null) {
    ctx.ui[where] = { ...c, messages: c.messages.slice(0, qi) };
  }
  const parsed = parseCommand(text);
  ctx.send({ text: parsed.text, ...(parsed.command ? { command: parsed.command } : {}), where, context: q.context, replaceFrom: id ?? undefined });
}

let copyTimer: ReturnType<typeof setTimeout> | null = null;
let ticker: ReturnType<typeof setInterval> | null = null;
let docWired = false;
/** Scrollers already listening (a WeakSet: morph would strip a marker attribute). */
const wired = new WeakSet<HTMLElement>();

export const conversationPart: AskPart = {
  code: "Cv",
  act(ctx, name, arg, value) {
    const ui = ctx.ui.conversation;
    const [w, key, extra] = (arg ?? "").split(":");
    // Someone else's shared conversation is read, never continued (0076_ask_sharing): nothing here asks again in it.
    if (/^askCv(Retry|Regen|RegenWith|RegenMenu|Edit|EditSend)$/.test(name) && readOnly({ ui: ctx.ui, where: ui.editing?.where ?? whereOf(w) })) return;
    switch (name) {
      // A starter, a follow-up, a rephrase chip: send its words as the next question.
      // In the ⌘J panel it carries the panel's context, the page's item first (a panel thread's `contextRef`).
      case "askCvSend": {
        if (!arg) return;
        const where: AskWhere = ctx.ui.cmdj.open && ctx.app.screen !== "ask" ? "panel" : "page";
        const see = { ui: ctx.ui, where };
        if (composerBlock(see) || readOnly(see)) return; // blocked, or someone else's shared thread: nothing is sent (QA-6)
        // The composer's own mode and switch — a mode the allowance can't cover is never sent (Q50).
        const how = { mode: composerMode(see), auto: composerAuto(see) };
        if (where === "panel") {
          const page = ctx.ui.cmdj.contextRef;
          const context = [...new Set([...(page ? [page] : []), ...ctx.ui.composer.panel.context])];
          ctx.send({ text: arg, where: "panel", context, ...how });
        } else ctx.send({ text: arg, where: "page", ...how });
        return;
      }
      case "askCvToggle": if (arg) toggle(ctx, arg); return;
      // A block or a file of the conversation, beside the thread: primed as hidden so no peek ever names it.
      case "askCvOpen": {
        const p = arg ? parseCvRef(arg) : null;
        if (!p || !arg) return;
        if (!(arg in ctx.ui.refViews)) ctx.ui.refViews = { ...ctx.ui.refViews, [arg]: { ref: arg, hidden: true } };
        ctx.openRef(arg, p.where);
        return;
      }
      case "askCvJump": {
        // Back to the latest: glide down and hold on there (a streaming answer keeps it in view again).
        const where: AskWhere = arg === "panel" ? "panel" : "page";
        const sc = typeof document !== "undefined" ? document.querySelector<HTMLElement>(`[data-ask-scroll="${where}"]`) : null;
        ui.stick = true;
        ui.away = { ...ui.away, [where]: false };
        if (sc) {
          setAway(sc, false);
          const smooth = typeof matchMedia === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
          sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? "smooth" : "auto" });
        }
        return;
      }
      case "askCvCopy": {
        const ex = key ? exchange(ctx, whereOf(w), key) : null;
        if (!ex || !arg) return;
        const look = ctx.look();
        const text = ex.a.turn.parts.filter((p): p is { kind: "text"; md: string } => p.kind === "text").map((p) => plainText({ look }, p.md)).join("").trim();
        try { void navigator.clipboard?.writeText(text).catch(() => undefined); } catch { /* no clipboard: the label still says so */ }
        ui.copied = arg;
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { if (ctx.ui.conversation.copied === arg) { ctx.ui.conversation.copied = null; ctx.paint(); } }, 1600);
        ctx.paint();
        return;
      }
      case "askCvRegenMenu":
        if (!arg) return;
        if (ui.regen === arg) { closeRegen(ctx); return; }
        ctx.cancelExit("menu");
        ui.regen = arg;
        focusNext = "regen";
        ctx.paint();
        return;
      case "askCvRegen": case "askCvRegenWith": {
        const where = whereOf(w);
        const ex = key ? exchange(ctx, where, key) : null;
        ui.regen = null;
        if (!ex?.q || ex.a.turn.messageId === null || ctx.ui[where].busy) { ctx.paint(); return; }
        const mode = name === "askCvRegenWith" && isAskMode(extra) ? extra : ex.a.turn.mode;
        ctx.send({ text: ex.q.text, where, context: ex.q.context, mode, replaceFrom: ex.a.turn.messageId });
        return;
      }
      // Try again after an error: ask the same question again in place of the failed answer.
      case "askCvRetry": {
        const where = whereOf(w);
        const ex = key ? exchange(ctx, where, key) : null;
        if (!ex?.q || ctx.ui[where].busy) return;
        if (ex.a.turn.messageId !== null) ctx.send({ text: ex.q.text, where, context: ex.q.context, mode: ex.a.turn.mode, replaceFrom: ex.a.turn.messageId });
        else void resend(ctx, where, ex.q.key, ex.q.text);
        return;
      }
      case "askCvEdit": {
        const where = whereOf(w);
        const q = ctx.ui[where].messages.find((m) => m.key === key);
        if (!q || q.role !== "user" || ctx.ui[where].busy) return;
        // A command question shows its command, so Send keeps it (or the person deletes it): parsed again on Send.
        ui.editing = { where, key: q.key, text: q.command ? `/${q.command} ${q.text}`.trim() : q.text };
        focusNext = "edit";
        ctx.paint();
        return;
      }
      case "askCvEditText": {
        if (!ui.editing) return;
        const was = ui.editing.text.trim() === "";
        ui.editing = { ...ui.editing, text: value ?? "" };
        if (was !== (ui.editing.text.trim() === "")) ctx.paint();      // Send's disabled state flips
        return;
      }
      case "askCvEditCancel": ui.editing = null; ctx.paint(); return;
      case "askCvEditSend": {
        const ed = ui.editing;
        if (!ed || !ed.text.trim()) return;
        ui.editing = null;
        void resend(ctx, ed.where, ed.key, ed.text.trim());
        return;
      }
    }
  },
  escape: [{ layer: "menu", isOpen: (ctx) => ctx.ui.conversation.regen !== null, close: (ctx) => closeRegen(ctx) }],
  onKeyDown(ctx, e) {
    const t = e.target as Element | null;
    // The edit box: ⌘/Ctrl+Enter sends, Escape cancels.
    if (t?.closest?.("[data-ask-edit]")) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); conversationPart.act?.(ctx, "askCvEditSend", null, null); return true; }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ctx.ui.conversation.editing = null; ctx.paint(); return true; }
      return false;
    }
    // "Regenerate with": ↑ / ↓ / Home / End move between the modes.
    const menu = t?.closest?.<HTMLElement>(".ask-regen-menu");
    if (menu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      const items = Array.from(menu.querySelectorAll<HTMLElement>("[role=menuitemradio]"));
      const at = items.indexOf(t as HTMLElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      e.preventDefault();
      items[next]?.focus();
      return true;
    }
    return false;
  },
  afterPaint(ctx, mount) {
    // `stick` (the bottom, ask-motion.ts rule 7 — the controller pins once the paint's glides started): only the
    // person scrolling UP lets go of it, and coming back to the bottom holds on again (`stickAfterScroll`).
    for (const sc of Array.from(mount.querySelectorAll<HTMLElement>("[data-ask-scroll]"))) {
      if (wired.has(sc)) continue;
      wired.add(sc);
      let top = sc.scrollTop;
      const where: AskWhere = sc.dataset.askScroll === "panel" ? "panel" : "page";
      sc.addEventListener("scroll", () => {
        ctx.ui.conversation.stick = stickAfterScroll(ctx.ui.conversation.stick, top, { top: sc.scrollTop, height: sc.scrollHeight, client: sc.clientHeight });
        top = sc.scrollTop;
        // The arrow: away from the bottom and not following it. Flipped here, without a repaint.
        const away = !ctx.ui.conversation.stick && sc.scrollHeight - sc.scrollTop - sc.clientHeight > AWAY_PX;
        if ((ctx.ui.conversation.away[where] === true) !== away) { ctx.ui.conversation.away = { ...ctx.ui.conversation.away, [where]: away }; setAway(sc, away); }
      }, { passive: true });
    }
    // "Thinking… Ns" counts between paints (the label alone; the next paint writes the same number).
    if (!ticker && mount.querySelector("[data-ask-think]")) {
      ticker = setInterval(() => {
        const els = Array.from(mount.querySelectorAll<HTMLElement>("[data-ask-think]"));
        if (!els.length) { if (ticker) clearInterval(ticker); ticker = null; return; }
        for (const el of els) el.textContent = thinkingLabel(Number(el.dataset.askThink));
      }, 500);
    }
    if (focusNext === "edit") {
      const ta = mount.querySelector<HTMLTextAreaElement>("[data-ask-edit]");
      if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    } else if (focusNext === "regen") {
      const menu = mount.querySelector<HTMLElement>(".ask-regen-menu");
      (menu?.querySelector<HTMLElement>('[aria-checked="true"]') ?? menu?.querySelector<HTMLElement>("[role=menuitemradio]"))?.focus();
    }
    focusNext = null;
    // A press outside "Regenerate with" closes it.
    if (!docWired && typeof document !== "undefined") {
      docWired = true;
      document.addEventListener("pointerdown", (e) => {
        if (ctx.ui.conversation.regen !== null && !(e.target as Element | null)?.closest?.(".ask-regen")) closeRegen(ctx);
      }, true);
    }
  },
};
