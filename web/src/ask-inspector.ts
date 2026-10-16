// Ask Trov — the inspector's per-type views (inventory §6; design ask-trov.dc.html L784–1003, L1710–1726; #12 §3).
// Scenarios: `answer-pr`, every `insp:<type>`, `phone-insp` (the body only — the sheet is the shell's).
//
// The frame — Back, the type word, "from #14 › #176", Open in page, Close, the resize edge, the phone sheet — is the
// shell's (ask-screen.ts `inspectorFrame`); this module renders what is under its header, and names the two items
// that have no RefView (`inspectorLocalHead`, which the frame asks for their type word and trail).
//
// THE INTERFACE (the shell calls these):
//   InspectorUi / initialInspectorUi()   this part's state, at `AppState.ask.inspectorUi` (the stack is the shell's)
//   inspectorBody(v, ref)                the body for one ref
//   inspectorLocalHead(v, ref)           the type word and short name of an `askcv:` item (a file, a block)
//   uploadRef(id) / chartRef(key, part)  the refs a sibling opens an attachment / an answer's chart with
//                                        (`data-act="askShOpen" data-arg="${chartRef(answer.key, i)}"`)
//   inspectorPart                        the acts (`askIn…`) and afterPaint (the reads, the motion)
//
// DATA. The header of every view is the item's RefView (`viewOf(v.look, ref)`); the rest is `GET /ask/item/:ref`
// (`ctx.api.getItem`, `AskItem.detail` — the same tools the per-type pages read: get_ticket, get_sprint, getHandoff,
// get_doc, the artifact page), read in `afterPaint`, NEVER on the render path. A repository's State (headline and its
// Shipped / In flight / At risk lists) is the Repo dashboard's own read (`GET /repo/dashboard`, `state`), the one
// per-type route Ask has no stand-in for (`inspectorIo`). A question's attachment and an answer's block are
// `askcv:` refs (ask-cvref.ts), found in the conversation (or in `local`, which the dev replay fills). A ref the person cannot see — hidden by peek, or a 404 from the read — shows one sentence and nothing of it.
//
// MOTION (ask-motion.ts; all of it off under prefers-reduced-motion, nothing replays on a repaint): the body is keyed
// per ref by the shell, so a new item fades in (`ask-view-in`); stepping BACK slides the view in from the left and
// forward from the right, and the "from …" trail slides with it (`afterPaint`, Web Animations, once per change of
// item); a read in flight is a skeleton that settles into the content (`syncSkeletons`); the sprint's bar wipes in,
// the chart's bars grow (staggered), the table fades in when the Chart / Table switch flips.

import { esc, attr, relTime } from "./ui";
import {
  parseAskRef, type AskAttachment, type AskChart, type AskItem, type RefView,
} from "@shared/ai-ask-core";
import type { AiRepoState } from "@shared/ai-core";
import { TROV_SYSTEM_HANDLE } from "@shared/ai-core";
import type { TicketDetail, TicketStatus, TicketPriority } from "@shared/tickets";
import { TICKET_STATUS_LABEL } from "@shared/tickets-core";
import type { SprintDetail, SprintForecast } from "@shared/sprints";
import type { FeedRow } from "@shared/rows";
import { forecastWords } from "./roadmap-ai";
import { sprintDatesLabel } from "@shared/sprints-core";
import type { HandoffView } from "@shared/handoffs";
import type { RepoFacts } from "@shared/repo-facts-core";
import type { AskCtx, AskLoad, AskPart, AskView } from "./ask-state";
import { inspectorRef } from "./ask-state";
import {
  isHiddenRef, personName, personOf, refAvatar, refChip, refFallbackText, refShort, refStatusIcon, refStatusMark, refTypeWord,
  repoFactsOf, repoHeadEnv, repoMark, repoVerdicts, verdictMark, viewOf, checksOf, checkSummaryMark, CHECK_PASS as PASS, CHECK_FAIL as FAIL,
} from "./ask-refs";
import { askIcon, REF_ICON, trovMark } from "./ask-icons";
import { AskApiError, isUnauthorized } from "./ask-api";
import {
  agentMark, aiMark, glyph, handoffMark, importanceMark, kindMark, markShape, priorityMark, stateMark, tagWords, ticketStatusIcon, STATE_KIND, type StateKind,
} from "./marks";
import { ciLine } from "./repo-verdict";
import { attentionLine } from "./repo-attention";
import { segmented } from "./segmented";
import { skeleton, skBar, skLine, skLines, skBox } from "./skeleton";
import { renderMarkdown } from "./markdown";
import { rawUrl, artifactFrame } from "./artifacts";
import { getRepoDashboard, patchArtifact } from "./api";
import { reducedMotion, ASK_EASE, ASK_FX } from "./ask-motion";
import { cvRefWord, isCvRef } from "./ask-cvref";
import { chartFigure, cvItem, diagramFigure, tableView, themesFigure, type CvItem } from "./ask-conversation";
import type { AskDiagram, AskThemesBlock } from "@shared/ai-ask-core";
import { feedKind } from "./feed-kind";

// ── the conversation part's items (`askcv:<where>:<key>:<kind>:<n>`, ask-cvref.ts) ────────────────────────────
// "Open in inspector" on a chart, the theme strip, a diagram, an items block, a table or a question's file pushes an
// `askcv:` ref. The conversation part holds what it names (`cvItem`); the inspector never reads it from the server,
// and draws it with the conversation's own figures (`chartFigure`, `themesFigure`, `diagramFigure`, `tableView`).
const cvItemOf = (v: AskView, ref: string): CvItem | null => (isCvRef(ref) ? cvItem(v.ui, ref) : null);

// ── state ────────────────────────────────────────────────────────────────────

/** An item with no RefView: an attachment, or an answer's chart. */
export type InspectorLocal = { kind: "upload"; att: AskAttachment } | { kind: "chart"; chart: AskChart };

export interface InspectorUi {
  /** `GET /ask/item/:ref` per ref. `ok` with `null` = not there or not the person's to see (a 404). */
  items: Record<string, AskLoad<AskItem | null>>;
  /** A repository's State (the Repo dashboard's `state`), per repo ref; `null` = none written. */
  repoState: Record<string, AskLoad<AiRepoState | null>>;
  /** The chart view's Chart / Table switch, per chart ref (default: chart). */
  chartView: Record<string, "chart" | "table">;
  /** Items with no RefView that were opened without a conversation holding them (the dev replay's). */
  local: Record<string, InspectorLocal>;
  /** A Publish to org in flight, per ref. */
  publishing: Record<string, true>;
}
export const initialInspectorUi = (): InspectorUi => ({ items: {}, repoState: {}, chartView: {}, local: {}, publishing: {} });

/** The reads and the write Ask's own client does not carry (AskApi has no Repo dashboard read and no artifact
 *  publish): the app's existing routes. Tests replace these. */
export const inspectorIo = {
  repoState: (repo: string): Promise<AiRepoState | null> => getRepoDashboard({ repo }).then((d) => d.state ?? null),
  publishArtifact: (slug: string): Promise<void> => patchArtifact(slug, { visibility: "org" }).then(() => undefined),
};

// ── refs with no RefView ─────────────────────────────────────────────────────

/** ONE kind of local ref: the conversation's `askcv:` (ask-cvref.ts). What it names is read from the conversation
 *  on screen (`cvItem`), else from `local` — what the dev replay registered for `insp:upload` / `insp:chart`. */
function localCvItem(v: AskView, ref: string): CvItem | null {
  const it = isCvRef(ref) ? v.ui.inspectorUi.local[ref] : undefined;
  return !it ? null : it.kind === "upload" ? { kind: "upload", attachment: it.att } : { kind: "chart", chart: it.chart };
}
const cvOrLocal = (v: AskView, ref: string): CvItem | null => cvItemOf(v, ref) ?? localCvItem(v, ref);
/** The frame's type word and trail name for an item with no RefView (null for any other ref). */
export function inspectorLocalHead(v: AskView, ref: string): { typeWord: string; short: string } | null {
  if (isCvRef(ref)) {
    const c = cvOrLocal(v, ref);
    const short = !c ? "an item" : c.kind === "chart" ? c.chart.title : c.kind === "themes" ? c.themes.title : c.kind === "diagram" ? c.diagram.title
      : c.kind === "upload" ? c.attachment.title : c.kind === "table" ? "a table" : "items";
    return { typeWord: cvRefWord(ref), short };
  }
  return null;
}

// ── small pieces ─────────────────────────────────────────────────────────────

const str = (x: unknown): string | null => (typeof x === "string" && x ? x : null);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []);
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "Sep 28" for an ISO day or time (the day as written, no timezone shift for a bare `YYYY-MM-DD`). */
function shortDay(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
/** "Fri, Oct 30" for a `YYYY-MM-DD`. */
function weekdayDay(day: string | null | undefined): string {
  const m = day?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${DAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
/** "Today, 9:20 AM", "Yesterday, 4:12 PM", "Mon, 4:12 PM", else "Sep 28". */
export function whenLabel(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const day0 = (t: number) => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
  const days = Math.round((day0(now) - day0(d.getTime())) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days > 1 && days < 7) return `${DAYS[d.getDay()]}, ${time}`;
  return shortDay(iso);
}
/** "412 KB", "1.4 MB". */
export function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

const eyebrow = (text: string): string => `<div class="ask-iv-eyebrow">${esc(text)}</div>`;
const title = (text: string, mono = false): string => `<h2 class="ask-iv-title${mono ? " ask-iv-title--mono" : ""}">${esc(text)}</h2>`;
const head = (text: string, trail = "", top = 20): string =>
  `<div class="ask-iv-h" style="margin-top:${top}px"><span>${esc(text)}</span>${trail ? `<span class="ask-iv-count">${esc(trail)}</span>` : ""}</div>`;
const row = (label: string, value: string): string => `<div class="ask-iv-row"><span class="ask-iv-lab">${esc(label)}</span>${value}</div>`;
const quiet = (text: string): string => `<span class="ask-iv-quiet">${esc(text)}</span>`;
const note = (text: string): string => `<p class="ask-iv-note">${esc(text)}</p>`;

/** A person as the button that opens them HERE (the design: beside the thread), the picture through people.ts. */
function personBtn(v: AskView, handle: string, size = 20, nameStyle = ""): string {
  const name = personName(v.look, handle);
  return `<button type="button" class="ask-iv-person" data-act="askShOpen" data-arg="person:${attr(handle.toLowerCase())}" aria-label="${attr(`${name}, open beside the thread`)}">${refAvatar(v.look, handle, size)}<span${nameStyle ? ` style="${nameStyle}"` : ""}>${esc(name)}</span></button>`;
}
/** An item row that opens another item here: a lead, a number, a title, a trail. */
function itemRow(ref: string, lead: string, num: string, t: string, trail = "", sub = ""): string {
  return `<button type="button" class="ask-iv-item" data-act="askShOpen" data-arg="${attr(ref)}">${lead}${num ? `<span class="ask-iv-num">${esc(num)}</span>` : ""}<span class="ask-iv-t">${sub ? `<span class="ask-iv-t1">${esc(t)}</span><span class="ask-iv-sub">${esc(sub)}</span>` : esc(t)}</span>${trail}</button>`;
}
/** A ref's row when only its view is known: its status icon, short name, title. Unknown → plain words. */
function refRow(v: AskView, ref: string, trail?: (x: RefView) => string, given?: RefView): string {
  const x = viewOf(v.look, ref) ?? given ?? null;
  if (!x) return `<div class="ask-iv-item is-plain">${askIcon(REF_ICON[parseAskRef(ref)?.type ?? "doc"], 13, "var(--fg-40)")}<span class="ask-iv-t">${esc(refFallbackText(ref))}</span></div>`;
  const lead = x.status ? refStatusIcon(x.status, 13) : askIcon(REF_ICON[x.type], 13, "var(--fg-40)");
  const num = (x.type === "ticket" || x.type === "pr") && x.num != null ? `#${x.num}` : "";
  return itemRow(ref, lead, num, x.title, trail ? trail(x) : x.status ? `<span class="ask-iv-sub">${esc(x.status.word)}</span>` : "");
}


// ── the skeleton and the states with no item ─────────────────────────────────

const skKey = (ref: string): string => `ask-insp-${ref.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 60)}`;
/** The rest of a view while its read is out: rows of fields, then a list. */
function detailSkeleton(ref: string, lead = true): string {
  const rows = [0, 1, 2, 3].map((i) => `<div class="ask-iv-row">${skBar(52, 8)}${skBar(["46%", "34%", "52%", "40%"][i], 10)}</div>`).join("");
  return skeleton(skKey(ref), "Loading this item…", `${lead ? `<div style="margin:2px 0 16px">${skLines(["92%", "84%", "60%"], 13.5, 1.65)}</div>` : ""}
    <div class="ask-iv-fields">${rows}</div>
    <div style="margin-top:20px">${skBar(90, 8)}</div>
    ${[0, 1, 2].map((i) => `<div class="ask-iv-skrow">${skBox(13, 13)}${skLine(["70%", "56%", "64%"][i], 13, 1.4)}</div>`).join("")}`);
}
function wholeSkeleton(ref: string): string {
  return skeleton(skKey(ref), "Loading this item…", `${skBar(60, 9, "margin-bottom:10px")}${skLine("72%", 19, 1.3)}<div style="height:14px"></div>${skLines(["92%", "84%", "60%"], 13.5, 1.65)}`);
}
const HIDDEN = "This item is not there, or it is not yours to see.";
const failed = (ref: string): string =>
  `<div class="ask-iv-fail">${esc("Couldn't read the rest of this item.")} <button type="button" class="ask-iv-link" data-act="askInRetry" data-arg="${attr(ref)}">Try again</button></div>`;

/** The detail of a read item, or the skeleton / failure line that stands in for it. */
function detailOr(v: AskView, ref: string, draw: (detail: Record<string, unknown>) => string, lead = true): string {
  const it = v.ui.inspectorUi.items[ref];
  if (!it || it.status === "idle" || it.status === "loading") return detailSkeleton(ref, lead);
  if (it.status === "error") return failed(ref);
  return draw(it.data?.detail ?? {});
}

// ── the views ────────────────────────────────────────────────────────────────

function ticketView(v: AskView, x: RefView, ref: string): string {
  const e = x.extra;
  const asgFromView = strs(e.assignees);
  const top = `${x.num != null ? eyebrow(`#${x.num}`) : ""}${title(x.title)}`;
  return top + detailOr(v, ref, (d) => {
    const t = (d.ticket ?? null) as TicketDetail | null;
    if (!t) return note("Trov has no more of this ticket.");
    const asg = t.assignees.length ? t.assignees : asgFromView;
    const sprintRef = t.sprint ? `sprint:${t.sprint.id}` : null;
    const sprintView = sprintRef ? viewOf(v.look, sprintRef) : null;
    const due = sprintView ? str(sprintView.extra.due) : null;
    const subs = t.children ?? [];
    const subsDone = subs.filter((s) => s.status === "done").length;
    const prs = (Array.isArray(d.prs) ? (d.prs as RefView[]) : []).filter((p) => p && typeof p.ref === "string");
    const comments = (t.comments ?? []).slice(-3);
    return `${t.body ? `<p class="ask-iv-p" style="margin:0 0 18px">${esc(t.body)}</p>` : ""}
      <div class="ask-iv-fields">
        ${row("Status", refStatusMarkFor(x, t.status))}
        ${row("Priority", priorityMark(t.priority as TicketPriority, 12.5))}
        ${row("Category", `<span class="ask-iv-val">${esc(cap(t.category))}</span>`)}
        ${row("Assignees", asg.length ? `<span class="ask-iv-people">${asg.map((h) => personBtn(v, h)).join("")}</span>` : `<span class="ask-iv-val" style="font-style:italic;color:var(--fg-55)">Unassigned</span>`)}
        ${row("Sprint", t.sprint && sprintRef
          ? `<button type="button" class="ask-iv-link ask-iv-strong" data-act="askShOpen" data-arg="${attr(sprintRef)}">${esc(t.sprint.label)}${due ? `<span class="ask-iv-quiet">Due ${esc(weekdayDay(due))}</span>` : ""}</button>`
          : `<span class="ask-iv-val">Backlog</span>`)}
        ${row("Requester", `<span class="ask-iv-inline">${personBtn(v, t.requester)}<span class="ask-iv-quiet">· opened ${esc(shortDay(t.created_at))}</span></span>`)}
      </div>
      ${subs.length ? `${head("Sub-tickets", `${subsDone} of ${subs.length} done`, 14)}
        <div class="ask-iv-list">${subs.map((s) => itemRow(`ticket:${s.id}`, ticketStatusIcon(s.status, 13), `#${s.id}`, s.title)).join("")}</div>` : ""}
      ${prs.length ? `${head("Linked pull requests")}
        <div class="ask-iv-list">${prs.map((p) => prRow(viewOf(v.look, p.ref) ?? p)).join("")}</div>` : ""}
      ${comments.length ? `${head("Latest comments", "", 20)}
        <div class="ask-iv-comments">${comments.map((c) => `<div class="ask-iv-comment">${refAvatar(v.look, c.author, 20)}<div style="min-width:0"><div class="ask-iv-inline"><span style="font-size:12.5px;font-weight:600">${esc(personName(v.look, c.author))}</span><span class="ask-iv-quiet">${esc(relTime(c.created_at))}</span></div><div class="ask-iv-cbody">${esc(c.body)}</div></div></div>`).join("")}</div>` : ""}`;
  });
}
/** The ticket's status from the view (its server word and tip), else its row's. */
function refStatusMarkFor(x: RefView, status: TicketStatus): string {
  return x.status ? refStatusMark(x.status, 12.5) : `<span class="ask-iv-val">${esc(TICKET_STATUS_LABEL[status])}</span>`;
}
function prRow(p: RefView): string {
  const lead = p.status ? refStatusIcon(p.status, 13) : askIcon("pr", 13, "var(--fg-40)");
  const sub = `#${p.num ?? "?"}${p.status ? ` · ${p.status.word}` : ""}`;
  return itemRow(p.ref, lead, "", p.title, `<span class="ask-iv-trail">${checkSummaryMark(checksOf(p))}</span>`, sub);
}

function prView(v: AskView, x: RefView, ref: string): string {
  const e = x.extra;
  const author = str(e.author);
  const checks = checksOf(x);
  const pass = checks.filter((c) => PASS.has(c.state)).length;
  const top = `${eyebrow(`#${x.num ?? "?"}${str(e.repo) ? ` · ${str(e.repo)}` : ""}`)}${title(x.title)}
    <div class="ask-iv-meta">${x.status ? refStatusMark(x.status, 12.5) : ""}${author ? personBtn(v, author) : ""}${x.updated ? quiet(`Updated ${relTime(x.updated)}`) : ""}</div>
    ${str(e.head) ? `<div class="ask-iv-branches"><span class="ask-iv-mono">${esc(str(e.head)!)}</span><span aria-hidden="true" style="color:var(--fg-40)">→</span><span class="ask-iv-mono">${esc(str(e.base) ?? "main")}</span></div>` : ""}
    <div class="ask-iv-checks">
      <div class="ask-iv-h" style="margin:0 0 8px"><span>Checks</span><span class="ask-iv-count">${esc(checks.length ? `${pass} of ${plural(checks.length, "check")} pass` : "None captured")}</span></div>
      ${checks.length ? `<div class="ask-iv-checklist">${checks.map((c) => {
        const ok = PASS.has(c.state), bad = FAIL.has(c.state);
        const tip = `${c.name} ${ok ? "passed" : bad ? "failed" : "is running"}`;
        return `<span class="ask-iv-check" data-mtip="${attr(tip)}">${markShape(ok ? "dot" : bad ? "diamond" : "ring", ok ? "var(--green)" : bad ? "var(--red)" : "var(--fg-55)", 9)}<span class="ask-iv-code">${esc(c.name)}</span><span class="cnpy-sr">${esc(ok ? "passed" : bad ? "failed" : "running")}</span></span>`;
      }).join("")}</div>` : ""}
    </div>`;
  return top + detailOr(v, ref, (d) => {
    const what = str(d.what), why = str(d.why), impact = str(d.impact);
    const linked = strs(d.linkedTo);
    // Changed files as Repo setups' capture stored them (`/ask/item` › pr): the count when the read was complete, "N+"
    // when it stopped at its page cap. Added / deleted lines are stored nowhere: null, so nothing is drawn for them.
    const files = typeof d.files === "number" ? d.files : null;
    const atLeast = files === null && strs(d.filePaths).length && d.filesComplete === false ? strs(d.filePaths).length : null;
    const add = typeof d.additions === "number" ? d.additions : null;
    const del = typeof d.deletions === "number" ? d.deletions : null;
    const para = (h: string, t: string | null, last = false) => (t ? `<div class="ask-iv-h" style="margin:${last ? "0" : "0"} 0 4px">${esc(h)}</div><p class="ask-iv-p ask-iv-p--fg" style="margin:0 0 ${last ? 16 : 12}px">${esc(t)}</p>` : "");
    const summary = what || why || impact
      ? `<div style="margin-top:16px">${para("What", what)}${para("Why", why)}${para("Impact", impact, true)}</div>`
      : `<p class="ask-iv-note" style="margin:16px 0">Trov has no summary of this pull request yet.</p>`;
    const counts = files !== null || atLeast !== null || add !== null || del !== null;
    return `${summary}
      ${counts || linked.length ? `<div class="ask-iv-foot">
        ${files !== null ? `<span>${esc(plural(files, "file"))}</span>` : atLeast !== null ? `<span>${esc(`${atLeast}+ files`)}</span>` : ""}${add !== null ? `<span class="ask-iv-add">+${add}</span>` : ""}${del !== null ? `<span class="ask-iv-del">−${del}</span>` : ""}
        <span style="flex:1"></span>
        ${linked.length ? `<span>Linked to</span>${linked.map((r) => refChip(r, v.look, { size: "cell" })).join("")}` : ""}
      </div>` : ""}`;
  });
}

function docView(v: AskView, x: RefView, ref: string): string {
  const e = x.extra;
  const owner = str(e.owner) ?? x.owner ?? null;
  const slug = parseAskRef(ref)?.key ?? "";
  return title(x.title) + detailOr(v, ref, (d) => {
    const versions = Array.isArray(d.versions) ? (d.versions as { version: number; status: string }[]) : [];
    const staged = e.staged === true || x.status?.word.startsWith("Staged") === true;
    const liveV = versions.filter((s) => s.status === "promoted").reduce<number | null>((m, s) => Math.max(m ?? 0, s.version), null)
      ?? (typeof e.version === "number" && !versions.length && !staged ? e.version : null);
    const stagedV = versions.filter((s) => s.status === "staged").reduce<number | null>((m, s) => Math.max(m ?? 0, s.version), null);
    const shownV = staged && stagedV !== null ? stagedV : liveV ?? (typeof e.version === "number" ? e.version : null);
    const space = str(e.space);
    // Staged: the excerpt is the version waiting in Review (the server's `staged.body`), never the live one.
    const waiting = d.staged && typeof d.staged === "object" ? str((d.staged as { body?: unknown }).body) : null;
    const body = (staged ? waiting : null) ?? str(d.body) ?? str(e.excerpt) ?? "";
    const excerpt = clipMarkdown(body);
    return `<div class="ask-iv-meta" style="margin-bottom:16px">
        ${x.status ? refStatusMark(x.status, 12.5) : ""}
        ${space || shownV !== null ? `<span class="ask-iv-label">${esc([space ? cap(space) : null, shownV !== null ? `v${shownV}` : null].filter(Boolean).join(" · "))}</span>` : ""}
        ${owner ? personBtn(v, owner) : ""}
        ${x.updated ? quiet(`Updated ${relTime(x.updated)}`) : ""}
      </div>
      ${excerpt ? `<div class="ask-iv-box ask-iv-md">${renderMarkdown(excerpt)}</div>` : note("This doc has no text yet.")}
      ${staged ? `<div class="ask-iv-staged">${x.status ? refStatusIcon(x.status, 13) : ""}${esc(liveV !== null ? `This version waits in Review. Agents still read v${liveV} until someone approves it.` : "This version waits in Review. Agents read it only once someone approves it.")}</div>` : ""}
      <div style="display:flex;gap:8px;margin-top:16px"><button type="button" class="ask-iv-btn" data-act="openDocFrom" data-arg="${attr(slug)}">Open doc${askIcon("openNew", 12, null, 2)}</button></div>`;
  }, false);
}
/** The first blocks of a markdown body, up to ~900 characters (a rendered EXCERPT; the doc opens whole). */
export function clipMarkdown(md: string, max = 900): string {
  const blocks = md.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  let n = 0;
  for (const b of blocks) {
    if (out.length && n + b.length > max) break;
    out.push(b.length > max ? `${b.slice(0, max - 1)}…` : b);
    n += b.length;
    if (out.length >= 8) break;
  }
  return out.join("\n\n");
}

const STATUS_ORDER: TicketStatus[] = ["in_progress", "testing", "submitted", "done", "declined"];
const GROUP_SHOWN = 4;
/** The sprint's forecast line — the SERVER's (`SprintDetail.forecast`, src/tools/sprints.ts `sprintForecast`, the one
 *  the Roadmap shows), in the Roadmap's words (`forecastWords`). No client math: nothing here can disagree with the
 *  sprint's status. null when the server says none. */
export function sprintForecastLine(f: SprintForecast | null | undefined): { late: boolean; text: string } | null {
  if (!f) return null;
  const w = forecastWords(f);
  return { late: w.late, text: w.delta ? `${w.lead}, ${w.delta}` : w.lead };
}
function sprintView(v: AskView, x: RefView, ref: string): string {
  return title(x.title) + detailOr(v, ref, (d) => {
    const s = (d.sprint ?? null) as SprintDetail | null;
    if (!s) return note("Trov has no more of this sprint.");
    const dates = sprintDatesLabel(s);
    const { closed, total } = s.progress;
    const pct = total ? Math.round((closed / total) * 100) : 0;
    const fc = sprintForecastLine(s.forecast);
    const goal = s.summary ?? (s.description ? s.description.split(/\n\s*\n/)[0] : null);
    const groups = STATUS_ORDER.map((st) => ({ st, rows: s.tickets.filter((t) => t.status === st) })).filter((g) => g.rows.length);
    return `<div class="ask-iv-meta" style="margin-bottom:12px">${dates ? `<span>${esc(dates)}</span>` : ""}${s.due ? `<span style="color:var(--fg)">Due ${esc(weekdayDay(s.due))}</span>` : ""}${s.lead ? personBtn(v, s.lead, 18) : ""}</div>
      ${goal ? `<p class="ask-iv-p ask-iv-p--fg" style="margin:0 0 16px">${esc(goal)}</p>` : ""}
      <div class="ask-iv-h ask-iv-h--plain" style="margin:0 0 6px"><span style="font-size:13px;font-weight:600;color:var(--fg)">${total ? `${pct}%` : "—"}</span><span class="ask-iv-count">${esc(total ? `${closed} of ${plural(total, "ticket")} done` : "No tickets yet")}</span></div>
      <div class="ask-iv-bar" role="progressbar" aria-label="Sprint progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="ask-iv-fill" style="width:${pct}%"></div></div>
      ${fc ? `<div class="ask-iv-forecast">${fc.late ? glyph("warn", "var(--amber)", 14) : markShape("dot", "var(--green)", 9)}${esc(fc.text)}</div>` : `<div style="height:18px"></div>`}
      ${groups.map((g) => {
        const shown = g.rows.slice(0, GROUP_SHOWN);
        const more = g.rows.length - shown.length;
        return `<div class="ask-iv-group">
          <div class="ask-iv-ghead">${ticketStatusIcon(g.st, 13, false)}<span style="font-size:12.5px;font-weight:600">${esc(TICKET_STATUS_LABEL[g.st])}</span><span class="ask-iv-label">${g.rows.length}</span></div>
          ${shown.map((t) => itemRow(`ticket:${t.id}`, "", `#${t.id}`, t.title, t.assignees[0] ? `<span class="ask-iv-trail" data-mtip="${attr(personName(v.look, t.assignees[0]))}">${refAvatar(v.look, t.assignees[0], 16)}</span>` : `<span class="ask-iv-trail" data-mtip="Unassigned"></span>`)).join("")}
          ${more > 0 ? `<div class="ask-iv-more">and ${esc(plural(more, "more", "more"))}</div>` : ""}
        </div>`;
      }).join("")}`;
  });
}

const DEPLOY_KIND: Record<string, { kind: StateKind; word: (env: string) => string }> = {
  ready: { kind: "good", word: (e) => e },
  error: { kind: "bad", word: (e) => `${e} failed` },
  building: { kind: "waiting", word: (e) => `${e}, building` },
  queued: { kind: "waiting", word: (e) => `${e}, queued` },
  canceled: { kind: "off", word: (e) => `${e}, canceled` },
};
const hostOf = (u: string | null): string => (u ? u.replace(/^https?:\/\//i, "").replace(/\/.*$/, "") : "");
/** Where a repository's missing pieces are connected (Org settings' tabs since #186). */
const ORG_LINK = {
  integrations: { href: "#org", label: "Org settings › Integrations" },
  hosting: { href: "#org/hosting", label: "Org settings › Hosting" },
  environments: { href: "#org/environments", label: "Org settings › Environments" },
  repos: { href: "#org/repos", label: "Org settings › Repositories" },
} as const;
const orgLink = (k: keyof typeof ORG_LINK, repo?: string): string => {
  const l = ORG_LINK[k];
  const href = k === "repos" && repo ? `#org/repos/${repo.split("/").map(encodeURIComponent).join("/")}` : l.href;
  return `<a class="ask-iv-link" href="${attr(href)}">${esc(k === "repos" && repo ? `${l.label} › Apps` : l.label)}</a>`;
};

function repoView(v: AskView, x: RefView, ref: string): string {
  const f = repoFactsOf(x);
  const repo = x.title;
  const top = title(repo, true);
  if (!f) {
    return `${top}<div class="ask-iv-meta">${repoMark(null)}</div>
      <p class="ask-iv-note">Trov has no reading of this repository yet. Its GitHub connection is in ${orgLink("integrations")}.</p>`;
  }
  const rows = repoVerdicts(f);
  const head0 = repoHeadEnv(f);
  // A monorepo names its apps (the facts are every app's, unnarrowed); a narrowed read says which app it is.
  const deploying = f.apps.filter((a) => a.kind !== "Package");
  const narrowed = f.app ? f.apps.find((a) => a.key === f.app) ?? null : null;
  const many = deploying.length > 1;
  const appLine = narrowed ? `<div class="ask-iv-meta">${quiet(`App: ${narrowed.label}`)}</div>`
    : many ? `<div class="ask-iv-meta">${quiet(`${plural(deploying.length, "app")}: ${deploying.map((a) => a.label).join(", ")}`)}</div>` : "";
  const envRows = rows.map(({ env, verdict }) => {
    const parts = f.parts.filter((p) => p.env === env.key);
    const url = hostOf(parts.find((p) => p.url)?.url ?? null);
    const hosts = parts.map((p) => {
      const appLabel = f.apps.find((a) => a.key === p.app)?.label ?? p.app;
      const off = p.connection === "not_connected" || p.connection === "revoked";
      return `<div class="ask-iv-part"><span>${esc(many && p.label !== appLabel ? `${appLabel} · ${p.label}` : p.label)}</span><span class="ask-iv-quiet">on ${esc(p.host)}${off ? " · not connected" : ""}</span></div>`;
    }).join("");
    return `<div class="ask-iv-env">
      <div class="ask-iv-envrow"><span class="ask-iv-envname">${esc(env.name)}</span><span class="ask-iv-code ask-iv-grow">${esc(url)}</span>${verdictMark(verdict, 12.5)}</div>
      ${hosts}
    </div>`;
  }).join("");
  const offHosts = [...new Set(f.parts.filter((p) => p.connection === "not_connected" || p.connection === "revoked").map((p) => p.host))];
  // The head environment's newest deploy (in flight or failed first, else what serves) and its branch's checks.
  const headParts = head0 ? f.parts.filter((p) => p.env === head0.key) : [];
  const deploys = headParts.flatMap((p) => [p.latest, p.serving].filter((d): d is NonNullable<typeof d> => !!d));
  const last = deploys.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
  const ci = head0 ? f.ci.find((c) => c.env === head0.key) : undefined;
  const cil = ciLine(ci);
  const ciKind: StateKind = cil?.tone === "good" ? "good" : cil?.tone === "bad" ? "bad" : "warn";
  const branch = head0?.branch ?? "main";
  const dk = last ? DEPLOY_KIND[last.state] ?? DEPLOY_KIND.ready : null;
  const deploy = last && head0 && dk
    ? `<div class="ask-iv-big">${kindMark(dk.word(head0.name), dk.kind, 13)}</div><div class="ask-iv-sm">${last.sha ? `<span class="ask-iv-code">${esc(last.sha.slice(0, 7))}</span> · ` : ""}${esc(relTime(last.readyAt ?? last.createdAt))}${last.by ? ` · ${esc(personName(v.look, last.by))}` : ""}</div>`
    : `<div class="ask-iv-big">${kindMark("Unknown", "waiting", 13)}</div><div class="ask-iv-sm">Trov has not seen a deploy here yet.</div>`;
  const checks = cil
    ? `<div class="ask-iv-big">${kindMark(cil.tone === "good" ? "Passing" : cil.tone === "bad" ? "Failing" : "Running", ciKind, 13)}</div><div class="ask-iv-sm">${esc(cil.text)}${ci?.names.length && cil.tone !== "good" ? ` · <span class="ask-iv-code">${esc(ci.names[0])}</span>` : ""}</div>`
    : `<div class="ask-iv-big">${kindMark("None captured", "waiting", 13)}</div><div class="ask-iv-sm">No checks captured on the branch head.</div>`;
  const now = Date.now();
  const full = { ...f, allApps: f.apps } as unknown as RepoFacts;
  const attention = f.attention.map((a) => attentionLine(a, full, now));
  const st = v.ui.inspectorUi.repoState[ref];
  const stateBox = !st || st.status === "idle" || st.status === "loading"
    ? skeleton(`${skKey(ref)}-state`, "Loading the repository's state…", `${skBar(40, 8, "margin-bottom:10px")}${skLines(["88%", "64%"], 14.5, 1.45)}`, "padding:14px 16px;border:1px solid var(--border);border-radius:10px")
    : st.data && st.data.headline
      ? `<div class="ask-iv-box ask-iv-state">
          <div class="ask-iv-h" style="margin:0 0 6px"><span>State</span></div>
          <div class="ask-iv-headline">${esc(st.data.headline)}</div>
          ${([["Shipped", st.data.shipped, markShape("check", "var(--accent)", 9)], ["In flight", st.data.inFlight, markShape("ring", "var(--blue)", 9)], ["At risk", st.data.attention, markShape("triangle", "var(--amber)", 9)]] as const)
            .filter(([, lines]) => lines.length).map(([label, lines, mark]) => `<div class="ask-iv-slist"><div class="ask-iv-slabel">${mark}${esc(label)}</div>${lines.map((l) => `<div class="ask-iv-sline">${esc(l.text)}</div>`).join("")}</div>`).join("")}
        </div>`
      : "";
  return `${top}${appLine}
    ${head("Environments", "", 0)}
    ${envRows || `<p class="ask-iv-note" style="margin-top:6px">No environment has a part of this repository yet. Set them up in ${orgLink("environments")}; its apps are in ${orgLink("repos", repo)}.</p>`}
    ${offHosts.length ? `<p class="ask-iv-note">${esc(`${offHosts.join(" and ")} ${offHosts.length === 1 ? "is" : "are"} not connected, so nothing is read from ${offHosts.length === 1 ? "it" : "them"}. An admin connects it in`)} ${orgLink("hosting")}.</p>` : ""}
    <div class="ask-iv-two">
      <div><div class="ask-iv-h" style="margin:0 0 6px"><span>Last deploy</span></div>${deploy}</div>
      <div><div class="ask-iv-h" style="margin:0 0 6px"><span>${esc(`CI on ${branch}`)}</span></div>${checks}</div>
    </div>
    ${stateBox}
    ${attention.length ? `${head("Needs attention")}<div class="ask-iv-list">${attention.map((a) => `<div class="ask-iv-att">${markShape(STATE_KIND[a.kind].shape, STATE_KIND[a.kind].tone, 9)}<span>${esc(a.text)}</span></div>`).join("")}</div>` : ""}`;
}

function handoffView(v: AskView, x: RefView, ref: string): string {
  const top = `${eyebrow(`Handoff #${x.num ?? "?"}`)}${title(x.title)}`;
  return top + detailOr(v, ref, (d) => {
    const h = (d.handoff ?? null) as HandoffView | null;
    if (!h) return note("Trov has no more of this handoff.");
    const c = h.context;
    const to = h.recipient === "anyone" ? `<span style="font-weight:500">Anyone</span>` : personBtn(v, h.recipient);
    const list = (label: string, items: string[], g: "done" | "todo") => items.length
      ? `${head(label, "", 14)}${items.map((t) => `<div class="ask-iv-step">${glyph(g, g === "done" ? "var(--accent)" : "var(--fg-55)", 14)}<span>${esc(t)}</span></div>`).join("")}` : "";
    return `<div class="ask-iv-meta">${handoffMark(h.status, 12.5)}${quiet(whenLabel(h.created_at))}</div>
      <div class="ask-iv-fromto"><span class="ask-iv-lab">From</span>${personBtn(v, h.sender)}${askIcon("arrow", 14, "var(--fg-40)", 2)}<span class="ask-iv-lab">To</span>${to}</div>
      ${c.task ? `${head("Task", "", 14)}<p class="ask-iv-p ask-iv-p--fg" style="margin:0">${esc(c.task)}</p>` : ""}
      ${list("Done", c.done, "done")}
      ${list("Next", c.next, "todo")}
      ${c.files.length ? `${head("Files", "", 14)}${c.files.map((p) => `<div class="ask-iv-file">${askIcon("file", 13, "var(--fg-40)")}<span class="ask-iv-code">${esc(p)}</span></div>`).join("")}` : ""}`;
  });
}

function feedView(v: AskView, x: RefView, ref: string): string {
  return detailOr(v, ref, (d) => {
    // The Feed's own projection of the entry (`/ask/item` › feed): `ai` on one Trov wrote, Sift's `importance`, tags.
    const e = (d.entry ?? null) as (Pick<FeedRow, "author" | "summary" | "brief" | "body" | "artifacts" | "created_at" | "ai" | "importance" | "tags">) | null;
    const author = e?.author ?? x.owner ?? null;
    const byTrov = e ? e.ai?.origin === "ai" : author === TROV_SYSTEM_HANDLE;
    let src: { prs?: unknown[]; commits?: unknown[]; issues?: unknown[] } = {};
    try { src = e?.artifacts ? JSON.parse(e.artifacts) : {}; } catch { src = {}; }
    const prs = (src.prs ?? []).map((p) => String(p).match(/(\d+)\s*$/)?.[1]).filter((n): n is string => !!n).map((n) => `pr:${n}`);
    const commits = (src.commits ?? []).map((c) => String(c).match(/\b([0-9a-f]{7,40})\b/i)?.[1]).filter((s): s is string => !!s);
    const issues = (src.issues ?? []).filter((i) => typeof i === "number");
    const brief = e?.brief ?? str(x.extra.brief);
    const paras = (e?.body ?? "").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    const sources = [
      ...prs.map((r) => refRow(v, r)),
      ...commits.map((s) => `<div class="ask-iv-item is-plain">${askIcon("ci", 13, "var(--fg-40)")}<span class="ask-iv-t ask-iv-code">${esc(s.slice(0, 7))}</span><span class="ask-iv-sub">Commit</span></div>`),
      ...issues.map((i) => `<div class="ask-iv-item is-plain">${askIcon("tickets", 13, "var(--fg-40)")}<span class="ask-iv-t">#${esc(String(i))}</span><span class="ask-iv-sub">Issue</span></div>`),
    ];
    // The entry's kind is the leading "Word:" of its summary (Shipped, Status, Decision, Finding, Incident, Triage —
    // `feedKind`): shown as a plain word in the meta line, the title the rest.
    const k = feedKind(e?.summary ?? x.title);
    return `<div class="ask-iv-meta" style="margin-bottom:8px">
        ${k.kind ? `<span class="ask-iv-label" data-feed-kind="${esc(k.kind.toLowerCase())}">${esc(k.kind)}</span>` : ""}
        ${importanceMark(e?.importance, 12)}
        ${author ? (byTrov ? `<span class="ask-iv-inline">${trovMark(14)}<span style="font-size:12.5px;font-weight:500">Trov</span></span>${aiMark(12)}` : `${personBtn(v, author)}${agentMark(12)}`) : ""}
        ${quiet(whenLabel(e?.created_at ?? x.updated ?? null))}
      </div>
      ${e?.tags?.length ? `<div class="ask-iv-meta" style="margin-bottom:8px">${tagWords(e.tags, { size: 12 })}</div>` : ""}
      ${title(k.kind ? k.rest : x.title)}
      ${brief ? `<p class="ask-iv-brief">${esc(brief)}</p>` : ""}
      ${paras.map((p) => `<p class="ask-iv-p" style="margin:0 0 10px">${esc(p)}</p>`).join("")}
      ${sources.length ? `${head("Sources", "", 16)}<div class="ask-iv-list">${sources.join("")}</div>` : ""}`;
  }, false);
}

function personView(v: AskView, x: RefView, ref: string): string {
  const handle = str(x.extra.handle) ?? parseAskRef(ref)?.key ?? x.title;
  const p = personOf(v.look, handle);
  const color = `var(--p-${p?.color ?? "slate"})`;
  const working = strs(x.extra.workingOn);
  const top = `<div class="ask-iv-hero">${refAvatar(v.look, handle, 52)}<div style="min-width:0"><h2 class="ask-iv-title" style="margin:0">${esc(x.title)}</h2><div style="font-size:12.5px;font-weight:500;color:${color}">@${esc(handle)}</div>${str(x.extra.role) ? `<div style="margin-top:2px;font-size:12.5px;color:var(--fg-55)">${esc(str(x.extra.role)!)}</div>` : ""}</div></div>
    ${head("Working on now", "", 0)}
    ${working.length ? `<div class="ask-iv-list ask-iv-list--ruled">${working.map((r) => refRow(v, r)).join("")}</div>` : note("Nothing in progress or testing.")}`;
  return top + detailOr(v, ref, (d) => {
    const prs = strs(d.recentPrs);
    return prs.length ? `${head("Recent pull requests", "", 18)}<div class="ask-iv-list ask-iv-list--ruled">${prs.map((r) => refRow(v, r, (pr) => `<span class="ask-iv-label">${esc(relTime(pr.updated ?? null))}</span>`)).join("")}</div>` : "";
  }, false);
}

const KIND_WORD: Record<string, string> = { html: "HTML page", markdown: "Markdown", image: "Image", pdf: "PDF", svg: "SVG", mermaid: "Diagram", file: "File", text: "Text" };
function artifactView(v: AskView, x: RefView, ref: string): string {
  const e = x.extra;
  const slug = parseAskRef(ref)?.key ?? "";
  const me = v.app.me?.handle ?? null;
  const org = v.app.me?.orgs.find((o) => o.slug === v.app.orgSlug)?.name ?? "your organization";
  const owner = x.owner ?? null;
  const top = `${title(x.title)}`;
  return top + detailOr(v, ref, (d) => {
    const kind = str(d.kind) ?? str(e.kind) ?? "file";
    const version = typeof d.version === "number" ? d.version : typeof e.version === "number" ? e.version : null;
    const vis = str(d.visibility) ?? str(e.visibility) ?? "private";
    const raw = typeof d.raw_url === "string" && version !== null ? rawUrl(slug, version) : null;
    const preview = raw ? artifactFrame({ kind, title: x.title, raw, key: `${slug}@${version}` }) : null;
    // Publishing is the author's step: only they see a private artifact, and only they may put it in the org.
    const mine = !!me && !!owner && owner.toLowerCase() === me.toLowerCase();
    const busy = !!v.ui.inspectorUi.publishing[ref];
    return `<div class="ask-iv-meta">${x.status ? refStatusMark(x.status, 12.5) : ""}<span class="ask-iv-label">${esc([KIND_WORD[kind] ?? cap(kind), version !== null ? `v${version}` : null].filter(Boolean).join(" · "))}</span>${owner ? quiet(`${personName(v.look, owner)}${x.updated ? ` · ${relTime(x.updated)}` : ""}`) : ""}</div>
      <div class="ask-iv-frame">
        <div class="ask-iv-chrome"><span class="ask-iv-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="ask-iv-chrome-t">${esc(`${v.app.orgSlug ?? ""}/a/${slug}`)}</span></div>
        ${preview ? `<div class="ask-iv-scroll">${preview}</div>` : `<div class="ask-iv-ph">${esc(raw ? "No preview for this kind. Open it to see it." : "No preview yet. Open it to see it.")}</div>`}
      </div>
      ${vis === "private" && mine ? `<div class="ask-iv-pub">
        <div class="ask-iv-pubtext">${esc(`Only you can see it. Publishing puts it in Artifacts for everyone in ${org}.`)}</div>
        <button type="button" class="ask-btn ask-btn--accent" data-act="askInPublish" data-arg="${attr(ref)}"${busy ? " disabled" : ""}>${busy ? "Publishing…" : "Publish to org"}</button>
      </div>` : ""}`;
  });
}

function uploadView(att: AskAttachment): string {
  const kind = KIND_WORD[att.kind] ?? cap(att.kind);
  const size = fmtSize(att.size);
  return `${title(att.title)}
    <div class="ask-iv-meta"><span class="ask-iv-label">${esc(`${kind} · ${size}`)}</span></div>
    <div class="ask-iv-frame">
      <div class="ask-iv-chrome"><span class="ask-iv-dots" aria-hidden="true"><span></span><span></span><span></span></span><span class="ask-iv-chrome-t">${esc(att.title)}</span></div>
      ${att.thumbUrl ? `<img class="ask-iv-img" src="${attr(att.thumbUrl)}" alt="${attr(att.title)}">` : `<div class="ask-iv-ph ask-iv-ph--stripe">${esc(`${kind} · ${size}`)}</div>`}
    </div>
    <p class="ask-iv-note" style="margin-top:12px">Attached to this thread. Trov reads it only when you ask about it.</p>`;
}

/** What each fixed query's rows count — said under the chart (never more than the query does). */
const QUERY_NOTE: Record<AskChart["query"], string> = {
  merged_prs_by_week: "merged pull requests, by the week they merged",
  ci_failures_by_week: "failed and timed-out CI runs, by week",
  tickets_by_status: "every ticket, by its status now",
  theme_shares: "merged pull requests, by theme",
  sprint_burndown: "open tickets at the end of each day",
};
const WEEKLY = new Set<AskChart["query"]>(["merged_prs_by_week", "ci_failures_by_week"]);
const FIRST_COL: Record<AskChart["query"], string> = {
  merged_prs_by_week: "Week of", ci_failures_by_week: "Week of", tickets_by_status: "Status", theme_shares: "Theme", sprint_burndown: "Day",
};
/** "Oct 18": the last day of the week that starts on `label` ("Oct 12"); the label itself when it can't be read. */
function weekEnd(label: string, year: number): string {
  const d = new Date(`${label} ${year} 12:00 UTC`);
  if (Number.isNaN(d.getTime())) return label;
  d.setUTCDate(d.getUTCDate() + 6);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
/** The line under the chart's title: "48 merged pull requests on AndresL230/trov, Aug 24 – Oct 18". */
export function chartLine(c: AskChart, year: number = new Date().getFullYear()): string {
  const repo = str(c.params.repo);
  if (c.query === "sprint_burndown") return `${plural(c.rows.length, "day")} · ${plural(c.total, "ticket")} in the sprint`;
  const range = WEEKLY.has(c.query) && c.rows.length ? `, ${c.rows[0].label} – ${weekEnd(c.rows[c.rows.length - 1].label, year)}` : "";
  return `${c.total} ${c.unit}${repo ? ` on ${repo}` : ""}${range}`;
}
function chartView(v: AskView, chart: AskChart, ref: string): string {
  const view = v.ui.inspectorUi.chartView[ref] ?? "chart";
  const max = Math.max(1, ...chart.rows.map((r) => r.value));
  const sw = segmented({
    id: "ask-insp-chart", ariaLabel: "Show as", value: view, act: "askInChartView", size: "sm", inertOn: true,
    options: [{ value: "chart", label: "Chart", arg: `${ref}|chart` }, { value: "table", label: "Table", arg: `${ref}|table` }],
  });
  // The conversation's own figure, larger and bare (the title, the line and the query's note are the view's own,
  // as the design draws them); the inspector's bars until it is here.
  const dataFrom = `<div class="ask-iv-datafrom">${trovMark(10)}${esc(`Data from Trov · ${QUERY_NOTE[chart.query]}`)}</div>`;
  const figure = view === "chart" && chart.rows.length ? chartFigure(chart, { barH: 220, bare: true }) : null;
  if (figure) {
    return `<div class="ask-iv-charthead">${title(chart.title)}${sw}</div>
      <div class="ask-iv-sm" style="margin-bottom:16px">${esc(chartLine(chart))}</div>
      <div class="ask-iv-figure" data-morph-key="fig:${attr(ref)}">${figure}</div>
      ${dataFrom}`;
  }
  const body = !chart.rows.length
    ? note("No rows for this chart yet.")
    : view === "chart"
      ? `<div class="ask-iv-bars" role="img" aria-label="${attr(`${chart.title}: ${chart.rows.map((r) => `${r.label} ${r.value}`).join(", ")}`)}" data-morph-key="bars:${attr(ref)}">
          ${chart.rows.map((r, i) => `<div class="ask-iv-barcol"><span class="ask-iv-barv">${r.value}</span><div class="ask-iv-barfill" style="height:${Math.round((r.value / max) * 180)}px;--i:${i}" data-mtip="${attr(`${r.label}: ${r.value} ${chart.unit}`)}"></div></div>`).join("")}
        </div>
        <div class="ask-iv-barlabels" aria-hidden="true">${chart.rows.map((r) => `<span>${esc(r.label)}</span>`).join("")}</div>`
      : `<table class="ask-iv-table" data-morph-key="table:${attr(ref)}">
          <thead><tr><th scope="col">${esc(FIRST_COL[chart.query])}</th><th scope="col" class="is-num">${esc(cap(chart.unit))}</th></tr></thead>
          <tbody>${chart.rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="is-num">${r.value}</td></tr>`).join("")}
            <tr class="is-total"><td>${chart.query === "sprint_burndown" ? "In the sprint" : "Total"}</td><td class="is-num">${chart.total}</td></tr></tbody>
        </table>`;
  return `<div class="ask-iv-charthead">${title(chart.title)}${sw}</div>
    <div class="ask-iv-sm" style="margin-bottom:16px">${esc(chartLine(chart))}</div>
    ${body}
    ${dataFrom}`;
}

/** A conversation-held item, drawn with the conversation's figures (a chart keeps the Chart / Table switch; a
 *  question's file is the upload view). */
function cvBody(v: AskView, c: CvItem, ref: string): string {
  switch (c.kind) {
    case "chart": return chartView(v, c.chart, ref);
    case "upload": return uploadView(c.attachment);
    case "themes": return `${title(c.themes.title)}<div class="ask-iv-figure">${themesFigure(c.themes)}</div>`;
    case "diagram": return `${title(c.diagram.title)}<div class="ask-iv-figure">${diagramFigure(v, c.diagram)}</div>`;
    case "table": return `<div class="ask-iv-figure">${tableView(v, c.head, c.rows)}</div>`;
    case "items": return `${head(plural(c.items.length, "item"), "", 0)}<div class="ask-iv-list">${c.items.map((x) => refRow(v, x.ref, undefined, x)).join("")}</div>`;
  }
}

// ── the body ─────────────────────────────────────────────────────────────────

/** The body for one ref (the frame around it is the shell's). */
export function inspectorBody(v: AskView, ref: string): string {
  const wrap = (type: string, html: string) => `<div class="ask-iv" data-ask-iv="${attr(type)}">${html}</div>`;
  // A conversation-held item first: it is primed as hidden (so nothing peeks it), which is not "not yours to see".
  if (isCvRef(ref)) {
    const c = cvOrLocal(v, ref);
    return c ? wrap(c.kind, cvBody(v, c, ref)) : wrap("gone", note("This is no longer in this thread."));
  }
  const p = parseAskRef(ref);
  if (!p) return wrap("gone", note("This is no longer in this thread."));
  // Hidden by peek, or not there on the read: the same one sentence, and nothing of it (even what was read before).
  const it = v.ui.inspectorUi.items[ref];
  if (isHiddenRef(v.look, ref) || (it?.status === "ok" && it.data === null)) return wrap("hidden", note(HIDDEN));
  const x = viewOf(v.look, ref) ?? it?.data?.view ?? null;
  if (!x) return wrap(p.type, wholeSkeleton(ref));
  switch (x.type) {
    case "ticket": return wrap("ticket", ticketView(v, x, ref));
    case "pr": return wrap("pr", prView(v, x, ref));
    case "doc": return wrap("doc", docView(v, x, ref));
    case "sprint": return wrap("sprint", sprintView(v, x, ref));
    case "repo": return wrap("repo", repoView(v, x, ref));
    case "handoff": return wrap("handoff", handoffView(v, x, ref));
    case "feed": return wrap("feed", feedView(v, x, ref));
    case "person": return wrap("person", personView(v, x, ref));
    case "artifact": return wrap("artifact", artifactView(v, x, ref));
    default:
      // A decision or a prompt: the view's own words, and its page.
      return wrap(x.type, `${eyebrow(refTypeWord(x))}${title(x.title)}<div class="ask-iv-meta">${x.status ? refStatusMark(x.status, 12.5) : ""}${x.owner ? personBtn(v, x.owner) : ""}${x.updated ? quiet(`Updated ${relTime(x.updated)}`) : ""}</div>`);
  }
}

// ── the part: reads, acts, motion ────────────────────────────────────────────

const setItem = (ctx: AskCtx, ref: string, l: AskLoad<AskItem | null>): void => { ctx.ui.inspectorUi.items = { ...ctx.ui.inspectorUi.items, [ref]: l }; };
const notThere = (e: unknown): boolean => (e instanceof AskApiError && (e.status === 404 || e.code === "not_found")) || (e instanceof Error && e.message === "not_found");

/** The refs a read item names, warmed with one peek so their rows show titles and marks. */
function relatedRefs(it: AskItem): string[] {
  const d = it.detail;
  const out: string[] = [];
  const t = d.ticket as TicketDetail | undefined;
  if (t?.sprint) out.push(`sprint:${t.sprint.id}`);
  out.push(...strs(d.linkedTo), ...strs(d.recentPrs));
  if (it.view.type === "person") out.push(...strs(it.view.extra.workingOn));
  const entry = d.entry as { artifacts?: string | null } | undefined;
  if (entry?.artifacts) {
    try { for (const p of (JSON.parse(entry.artifacts) as { prs?: unknown[] }).prs ?? []) { const n = String(p).match(/(\d+)\s*$/)?.[1]; if (n) out.push(`pr:${n}`); } } catch { /* not JSON */ }
  }
  return [...new Set(out)];
}

function load(ctx: AskCtx, ref: string): void {
  setItem(ctx, ref, { status: "loading", data: null });
  ctx.api.getItem(ref)
    .then((it) => { setItem(ctx, ref, { status: "ok", data: it }); ctx.want(relatedRefs(it)); })
    .catch((e) => {
      if (isUnauthorized(e)) { setItem(ctx, ref, { status: "error", data: null }); ctx.fail(e, ""); return; }
      setItem(ctx, ref, notThere(e) ? { status: "ok", data: null } : { status: "error", data: null });
    })
    .finally(() => ctx.paint());
}
function loadRepoState(ctx: AskCtx, ref: string, repo: string): void {
  ctx.ui.inspectorUi.repoState = { ...ctx.ui.inspectorUi.repoState, [ref]: { status: "loading", data: null } };
  const read = ctx.replay ? import("./ask-inspector-fixtures").then((f) => f.repoStateFixture()) : inspectorIo.repoState(repo);
  read.then((data) => { ctx.ui.inspectorUi.repoState = { ...ctx.ui.inspectorUi.repoState, [ref]: { status: "ok", data } }; })
    // No State is a section not drawn — never an error box over the facts.
    .catch(() => { ctx.ui.inspectorUi.repoState = { ...ctx.ui.inspectorUi.repoState, [ref]: { status: "ok", data: null } }; })
    .finally(() => ctx.paint());
}

/** Publish to org: the author's private artifact goes to everyone in the org. Under the dev replay nothing is
 *  written — the screen shows what would be. */
function publish(ctx: AskCtx, ref: string): void {
  const slug = parseAskRef(ref)?.key;
  if (!slug || parseAskRef(ref)?.type !== "artifact" || ctx.ui.inspectorUi.publishing[ref]) return;
  const org = ctx.app.me?.orgs.find((o) => o.slug === ctx.app.orgSlug)?.name ?? "the org";
  const done = (): void => {
    const x = ctx.ui.refViews[ref];
    if (x && !("hidden" in x)) {
      ctx.ui.refViews = { ...ctx.ui.refViews, [ref]: { ...x, status: { mark: "dot", tone: "blue", word: "Org", tip: "Everyone in the org can see it." }, extra: { ...x.extra, visibility: "org" } } };
    }
    const it = ctx.ui.inspectorUi.items[ref];
    if (it?.data) setItem(ctx, ref, { ...it, data: { ...it.data, detail: { ...it.data.detail, visibility: "org" } } });
    ctx.flash(`Published to ${org}`);
  };
  if (ctx.replay) { done(); ctx.paint(); return; }
  ctx.ui.inspectorUi.publishing = { ...ctx.ui.inspectorUi.publishing, [ref]: true };
  ctx.paint();
  inspectorIo.publishArtifact(slug)
    .then(done)
    .catch((e) => ctx.fail(e, "Couldn't publish it. Nothing was changed."))
    .finally(() => {
      const left = { ...ctx.ui.inspectorUi.publishing };
      delete left[ref];
      ctx.ui.inspectorUi.publishing = left;
      ctx.paint();
    });
}

/** What the last paint showed in each open frame, so a view's slide plays once per change of item. */
const shown = new WeakMap<Element, { ref: string; idx: number; trail: string }>();
/** Back slides the new view in from the left, forward from the right; the "from …" trail moves with it. */
export function animateNav(frame: Element, ref: string, idx: number, reduce = reducedMotion()): number {
  const trailEl = frame.querySelector<HTMLElement>(".ask-insp-from");
  const trail = trailEl?.textContent ?? "";
  const was = shown.get(frame);
  shown.set(frame, { ref, idx, trail });
  if (!was || reduce || was.ref === ref) return 0;
  const dir = idx < was.idx ? -1 : 1;
  let n = 0;
  const view = frame.querySelector<HTMLElement>(".ask-iv");
  if (view && typeof view.animate === "function") {
    view.animate([{ transform: `translateX(${dir * 14}px)` }, { transform: "none" }], { duration: ASK_FX.slow, easing: ASK_EASE.rise });
    n++;
  }
  if (trailEl && trail !== was.trail && typeof trailEl.animate === "function") {
    trailEl.animate([{ opacity: 0, transform: `translateX(${dir * 8}px)` }, { opacity: 1, transform: "none" }], { duration: ASK_FX.base, easing: ASK_EASE.fx });
    n++;
  }
  const back = frame.querySelector<HTMLElement>('[data-act="askShBack"] svg');
  if (dir < 0 && back && typeof back.animate === "function") {
    back.animate([{ transform: "translateX(-3px)" }, { transform: "none" }], { duration: ASK_FX.fast, easing: ASK_EASE.fx });
    n++;
  }
  return n;
}

export const inspectorPart: AskPart = {
  code: "In",
  act(ctx, name, arg) {
    switch (name) {
      case "askInRetry":
        if (arg) { const rest = { ...ctx.ui.inspectorUi.items }; delete rest[arg]; ctx.ui.inspectorUi.items = rest; ctx.paint(); }
        return;
      case "askInChartView": {
        const at = arg?.lastIndexOf("|") ?? -1;
        if (!arg || at < 0) return;
        const ref = arg.slice(0, at), view = arg.slice(at + 1);
        if (view !== "chart" && view !== "table") return;
        ctx.ui.inspectorUi.chartView = { ...ctx.ui.inspectorUi.chartView, [ref]: view };
        ctx.paint();
        return;
      }
      case "askInPublish": if (arg) publish(ctx, arg); return;
    }
  },
  afterPaint(ctx, mount) {
    const ref = inspectorRef(ctx.ui);
    if (!ref) return;
    // The open item is read once (outside the render path); a hidden one is never read.
    const p = parseAskRef(ref);
    if (p && !ctx.ui.inspectorUi.items[ref] && !isHiddenRef(ctx.look(), ref)) load(ctx, ref);
    if (p?.type === "repo" && !ctx.ui.inspectorUi.repoState[ref]) loadRepoState(ctx, ref, p.key);
    const frame = typeof mount.querySelector === "function" ? mount.querySelector(`.ask-insp-frame[data-where="${ctx.ui.inspector.where}"]`) : null;
    if (frame) animateNav(frame, ref, ctx.ui.inspector.idx);
  },
};
