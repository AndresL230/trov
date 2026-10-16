// Ask Trov — the SINGLE item card (#178, the owner: "the one item card … can't be just a wider version that just
// looks boring, and has dead space on the right, the layout should be different"). An `items` block with ONE item
// draws this instead of the multi-card grid (ask-conversation.ts `itemCard`, unchanged for 2+):
//
//   left   the identity: the type + number eyebrow, a larger title, one or two lines of the item's own words
//          (`extra.excerpt` — a ticket's body, a PR's What, a doc's excerpt, a sprint's summary, a decision, a
//          prompt's description; a handoff's task; a feed entry's brief; a person's role; a repo's head CI line),
//          and a foot: when it was updated, and "Open beside the thread"
//   right  a facts column of label / value rows that matter for that type (`FACTS`), on a faint tint
//
// Everything comes from the RefView the block already carries — nothing on this render path reads (CLAUDE.md
// invariant 7); an unknown value is a missing row or "—", never a guess. The whole card is ONE `hitArea` (opens the
// item in the inspector, like the multi-card); nothing inside it is a button. Under 560px of its own width (a phone,
// the ⌘J panel) the facts stack under the identity — `@container askone` in trov.css (`.ask-one-c`). Motion is the
// rich block's own entrance (ask-motion.ts rule 2); the card's hover lift is off under reduced motion.

import { esc, hitArea, HITBOX, relTime } from "./ui";
import type { AskView } from "./ask-state";
import { parseAskRef, type RefView } from "@shared/ai-ask-core";
import { sprintDatesLabel } from "@shared/sprints-core";
import { ARTIFACT_STATUSES, type ArtifactStatus } from "@shared/artifacts-core";
import {
  checkSummaryMark, checksOf, CHECK_PASS, personName, personOf, refAvatar, refFallbackText, refShort, refStatusIcon, refStatusMark,
  refTypeWord, repoFactsOf, repoHeadEnv, repoMark, repoVerdicts, verdictMark, viewOf,
} from "./ask-refs";
import { askIcon, REF_ICON } from "./ask-icons";
import { artifactStatusMark, priorityMark } from "./marks";
import { ciLine } from "./repo-verdict";
import { aiDay } from "./ai-ui";
import { feedKind } from "./feed-kind";

type Look = AskView["look"];
type Fact = [label: string, html: string];

const str = (x: unknown): string | null => (typeof x === "string" && x.trim() ? x : null);
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string" && !!y) : []);
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plain = (text: string): string => `<span class="ask-one-tx">${esc(text)}</span>`;
const quiet = (text: string): string => `<span class="ask-one-q">${esc(text)}</span>`;
const mono = (text: string): string => `<span class="ask-one-mono">${esc(text)}</span>`;

/** One person: their picture (people.ts, through `refAvatar`) and name. */
const person = (look: Look, handle: string): string =>
  `<span class="ask-one-p">${refAvatar(look, handle, 18)}<span class="ask-one-pn">${esc(personName(look, handle))}</span></span>`;
/** Several people: every picture (≤ 4), then the first name and "+N". */
function people(look: Look, handles: string[]): string {
  if (handles.length <= 1) return handles.length ? person(look, handles[0]) : quiet("Unassigned");
  const more = handles.length - 1;
  return `<span class="ask-one-p"><span class="ask-one-avs">${handles.slice(0, 4).map((h) => refAvatar(look, h, 18)).join("")}</span><span class="ask-one-pn">${esc(`${personName(look, handles[0])} +${more}`)}</span></span>`;
}
const isPriority = (p: string | null): p is "high" | "normal" | "low" => p === "high" || p === "normal" || p === "low";

/** A sprint's progress: a thin bar and "n of m done" (the server's counts; none → "No tickets yet"). */
function progress(x: RefView): string | null {
  const p = x.extra.progress as { closed?: unknown; total?: unknown } | undefined;
  const closed = typeof p?.closed === "number" ? p.closed : null;
  const total = typeof p?.total === "number" ? p.total : null;
  if (closed === null || total === null) return null;
  if (total === 0) return quiet("No tickets yet");
  const pct = Math.max(0, Math.min(100, Math.round((closed / total) * 100)));
  return `<span class="ask-one-prog"><span class="ask-one-bar" aria-hidden="true"><span class="ask-one-fill" style="width:${pct}%"></span></span><span class="ask-one-tx">${esc(`${closed} of ${total} done`)}</span></span>`;
}

/** A PR's checks: the summary mark and "n of m pass". */
function checks(x: RefView): string | null {
  const c = checksOf(x);
  if (!c.length) return quiet("None captured");
  const pass = c.filter((k) => CHECK_PASS.has(k.state)).length;
  return `<span class="ask-one-p">${checkSummaryMark(c, 12.5)}${quiet(`${pass} of ${c.length}`)}</span>`;
}

/** The facts column, per type: the rows that matter for it, in reading order (a missing value is a missing row). */
function facts(x: RefView, look: Look): Fact[] {
  const e = x.extra;
  const st: Fact[] = x.status ? [["Status", refStatusMark(x.status, 12.5)]] : [];
  const owner = x.owner ?? null;
  const out: (Fact | null)[] = [];
  switch (x.type) {
    case "ticket": {
      const pr = str(e.priority);
      out.push(...st,
        isPriority(pr) ? ["Priority", priorityMark(pr, 12.5)] : null,
        ["Assignees", people(look, strs(e.assignees))],
        ["Sprint", str(e.sprint) ? plain(str(e.sprint)!) : quiet("Backlog")]);
      break;
    }
    case "pr": {
      const author = str(e.author);
      const head = str(e.head);
      out.push(x.status ? ["State", refStatusMark(x.status, 12.5)] : null,
        ["Checks", checks(x) ?? quiet("None captured")],
        author ? ["Author", person(look, author)] : null,
        head ? ["Branch", `<span class="ask-one-br">${mono(head)}<span class="ask-one-arr" aria-hidden="true">→</span>${mono(str(e.base) ?? "main")}</span>`] : null);
      break;
    }
    case "doc": {
      const o = str(e.owner) ?? owner;
      out.push(...st, o ? ["Owner", person(look, o)] : null,
        str(e.space) ? ["Space", plain(cap(str(e.space)!))] : null,
        typeof e.version === "number" ? ["Version", plain(`v${e.version}`)] : null);
      break;
    }
    case "decision":
      out.push(...st, owner ? ["Author", person(look, owner)] : null, x.updated ? ["Proposed", plain(aiDay(x.updated))] : null);
      break;
    case "feed": {
      const kind = feedKind(x.title).kind;
      out.push(kind ? ["Kind", plain(kind)] : null, owner ? ["Author", person(look, owner)] : null, x.updated ? ["Posted", plain(aiDay(x.updated))] : null);
      break;
    }
    case "sprint": {
      const dates = sprintDatesLabel({ start: str(e.start), due: str(e.due) });
      out.push(...st, dates ? ["Dates", plain(dates)] : null, (() => { const p = progress(x); return p ? ["Progress", p] as Fact : null; })(),
        owner ? ["Lead", person(look, owner)] : null);
      break;
    }
    case "handoff": {
      const from = str(e.from), to = str(e.to);
      out.push(...st, from ? ["From", person(look, from)] : null,
        ["To", !to || to === "anyone" ? plain("Anyone") : person(look, to)],
        x.updated ? ["Sent", plain(relTime(x.updated))] : null);
      break;
    }
    case "artifact": {
      const kind = str(e.kind);
      const state = str(e.status);
      out.push(x.status ? ["Visibility", refStatusMark(x.status, 12.5)] : null,
        state && (ARTIFACT_STATUSES as readonly string[]).includes(state) ? ["State", artifactStatusMark(state as ArtifactStatus, 12.5)] : null,
        kind ? ["Kind", plain(kind === "html" ? "HTML page" : kind === "markdown" ? "Markdown" : cap(kind))] : null,
        typeof e.version === "number" ? ["Version", plain(`v${e.version}`)] : null,
        owner ? ["Author", person(look, owner)] : null);
      break;
    }
    case "person": {
      const working = strs(e.workingOn);
      const open = typeof e.openTickets === "number" ? e.openTickets : null;
      out.push(open !== null ? ["Open tickets", open ? plain(String(open)) : quiet("None")] : null, ["Working on", working.length
        ? `<span class="ask-one-list">${working.slice(0, 3).map((r) => {
          const w = viewOf(look, r);
          return `<span class="ask-one-li">${w?.status ? refStatusIcon(w.status, 12) : ""}<span class="ask-one-num">${esc(w ? refShort(w) : refFallbackText(r))}</span>${w ? `<span class="ask-one-lt">${esc(w.title)}</span>` : ""}</span>`;
        }).join("")}</span>`
        : quiet("Nothing in progress")]);
      break;
    }
    case "prompt": {
      const slug = parseAskRef(x.ref)?.key ?? null;
      out.push(...st, owner ? ["Author", person(look, owner)] : null, slug ? ["Slug", mono(slug)] : null);
      break;
    }
    case "repo": {
      // The Overview's own verdicts, per environment (≤ 3, promotion order), and what needs attention.
      const f = repoFactsOf(x);
      const rows = repoVerdicts(f);
      if (!f) out.push(["State", repoMark(null, 12.5)]);
      else if (!rows.length) out.push(["State", repoMark(f, 12.5)]);
      for (const { env, verdict } of rows.slice(0, 3)) out.push([env.name, verdictMark(verdict, 12.5)]);
      if (f) out.push(["Attention", f.attention.length ? plain(`${f.attention.length} ${f.attention.length === 1 ? "thing" : "things"}`) : quiet("Nothing")]);
      break;
    }
  }
  return out.filter((r): r is Fact => r !== null);
}

/** Markdown's inline marks out of a stored excerpt (a doc's first paragraph is markdown): `code`, **bold**, *em*,
 *  [text](url), a leading quote or list marker. Plain words, never markup. */
export function plainWords(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/(^|[\s(])\*(?=\S)([^*]*?\S)\*(?=[\s).,;:!?]|$)/g, "$1$2")
    .replace(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The item's own words under its title (one or two lines, clamped by CSS), or null. */
function words(x: RefView): string | null {
  const e = x.extra;
  switch (x.type) {
    case "handoff": return str(e.task);
    case "feed": return str(e.brief);
    case "person": return str(e.role);
    case "repo": {
      const f = repoFactsOf(x);
      const head = f ? repoHeadEnv(f) : null;
      const ci = f && head ? ciLine(f.ci.find((c) => c.env === head.key)) : null;
      return ci ? `${head!.name}: ${ci.text}` : f ? "No checks captured on the branch head." : "Trov has no reading of this repository yet.";
    }
    default: return str(e.excerpt);
  }
}

/** The eyebrow: "Ticket #87", "Pull request #257 · owner/repo", "Handoff #13", else the type word. */
function eyebrow(x: RefView): string {
  const num = x.num != null && (x.type === "ticket" || x.type === "pr" || x.type === "handoff") ? ` #${x.num}` : "";
  return `${refTypeWord(x)}${num}`;
}

/** The card's title: a feed entry's summary after its kind word (the kind is a fact), else the view's. */
const titleOf = (x: RefView): string => (x.type === "feed" ? cap(feedKind(x.title).rest) : x.title);

/** ONE item, its own layout (an `items` block with a single item). `it` is the block's view; the look's fresher one wins. */
export function singleItemCard(v: Pick<AskView, "look">, it: RefView): string {
  const x = viewOf(v.look, it.ref) ?? it;
  const look = v.look;
  const rows = facts(x, look);
  const said = words(x);
  const label = `${eyebrow(x)}: ${x.title}`;
  const id = x.type === "person"
    ? (() => {
      const handle = str(x.extra.handle) ?? x.owner ?? "";
      const color = personOf(look, handle)?.color ?? "slate";
      return `<div class="ask-one-who">${refAvatar(look, handle, 40)}<div class="ask-one-whot"><span class="ask-one-t">${esc(x.title)}</span>${handle ? `<span class="ask-one-h" style="color:var(--p-${esc(color)})">@${esc(handle)}</span>` : ""}</div></div>`;
    })()
    : `<span class="ask-one-t">${esc(titleOf(x))}</span>`;
  const repo = x.type === "pr" ? str(x.extra.repo) : null;
  const updated = x.type === "handoff" || x.type === "feed" || x.type === "decision" || x.type === "person" ? null : x.updated ?? null;
  return `<div class="ask-one-c"><div class="ask-one ${HITBOX}" data-one="${esc(x.type)}">
    <div class="ask-one-id">
      <span class="ask-one-eb">${askIcon(REF_ICON[x.type], 13, "var(--fg-40)")}<span>${esc(eyebrow(x))}</span>${repo ? `<span class="ask-one-ebr">${esc(repo)}</span>` : ""}</span>
      ${id}
      ${said && plainWords(said) ? `<p class="ask-one-x">${esc(plainWords(said))}</p>` : ""}
    </div>
    ${rows.length ? `<dl class="ask-one-facts">${rows.map(([l, h]) => `<dt class="ask-one-l">${esc(l)}</dt><dd class="ask-one-v">${h}</dd>`).join("")}</dl>` : ""}
    <div class="ask-one-ft">${updated && relTime(updated) ? `<span class="ask-one-up">Updated ${esc(relTime(updated))}</span>` : ""}<span class="ask-one-go" aria-hidden="true">Open beside the thread${askIcon("arrow", 12, null, 2)}</span></div>
    ${hitArea("askShOpen", x.ref, label)}
  </div></div>`;
}
