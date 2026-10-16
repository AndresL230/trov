// Ask Trov — ref views (FOUNDATION; #12 §2.5–2.6). EVERY chip, card, hover card, inspector header, picker
// row and source row draws from ONE server view model, `RefView` (shared/ai-ask-core.ts), held per ref in
// `AskUi.refViews` (the controller fills it from `done.cites`, `items` blocks, diagram nodes, action
// previews and batched `POST /ask/peek`). Pure markup here — no fetch, no state writes.
//
//   refStatusMark(status)      a RefStatus { mark, tone, word, tip } as the app's mark (marks.ts) + word
//   refChip(ref, look)         the inline chip (`[[ticket:14]]`): opens the inspector, shows the hover card
//   statusCell(ref, look)      `[[ticket:14|status]]`: the item's live mark and word (a table's Status column)
//   splitRefTokens(text)       a text's plain runs and ref tokens, in order (the conversation's renderer)
//   hoverCard(view, look, at)  the 300px card shown 320ms after a chip is hovered or focused
//   refTypeWord / refShort / refLabel / refCtxWord   the design's names for an item (ask-trov.dc.html L1558–1561)
//
// A chip carries `data-ask-ref="<ref>"` (the hover controller in ask-controller.ts watches it) and
// `data-act="askShOpen"` (open in the inspector).

import { ASK_REF_TOKEN_RE, parseAskRef, type AskRefType, type AskRepoFacts, type AskTone, type PeekResult, type RefStatus, type RefView } from "@shared/ai-ask-core";
import type { PersonSummary } from "@shared/people";
import { esc, attr, relTime } from "./ui";
import { glyph, markShape, priorityIcon, stateMark, type Glyph, type MarkShape } from "./marks";
import { VERDICT, ciLine, envVerdict, type EnvVerdict } from "./repo-verdict";
import { personChip } from "./people";
import { askIcon, REF_ICON } from "./ask-icons";
import { cvRefWord, isCvRef } from "./ask-cvref";

/** What the ref renderers read: the views by ref, and the org's people (avatars, names, colors). */
export interface RefLook {
  views: Readonly<Record<string, PeekResult>>;
  persons: readonly PersonSummary[];
}

/** A view the person can see, or null (unknown yet, or hidden). */
export function viewOf(look: Pick<RefLook, "views">, ref: string): RefView | null {
  const v = look.views[ref];
  return v && !("hidden" in v) ? v : null;
}
export const isHiddenRef = (look: Pick<RefLook, "views">, ref: string): boolean => {
  const v = look.views[ref];
  return !!v && "hidden" in v;
};

// ── status marks ─────────────────────────────────────────────────────────────

const GLYPHS: readonly string[] = ["todo", "half", "most", "done", "declined", "warn"];
/** A RefStatus tone as the app's token. */
export function toneVar(t: AskTone): string {
  switch (t) {
    case "accent": return "var(--accent)";
    case "amber": return "var(--amber)";
    case "green": return "var(--green)";
    case "red": return "var(--red)";
    case "blue": return "var(--blue)";
    case "muted": return "var(--fg-55)";
    case "faded": return "var(--fg-40)";
  }
}
/** The status's icon alone (a chip's lead, a card row): a progress glyph or a small shape. */
export function refStatusIcon(s: RefStatus, size = 12): string {
  const tone = toneVar(s.tone);
  return GLYPHS.includes(s.mark) ? glyph(s.mark as Glyph, tone, size) : markShape(s.mark as MarkShape, tone, Math.round(size * 0.72));
}
/** The status as a mark: its icon and its sentence-case word, the tip on `data-mtip` (marks.ts's idiom). */
export function refStatusMark(s: RefStatus, size = 12.5): string {
  const icon = refStatusIcon(s, Math.round(size + 1.5));
  return `<span data-mtip="${attr(s.tip)}" style="display:inline-flex;align-items:center;gap:${size < 12 ? 5 : 6}px;font-size:${size}px;color:var(--fg-70);white-space:nowrap">${icon}${esc(s.word)}</span>`;
}

// ── names ────────────────────────────────────────────────────────────────────

const TYPE_WORD: Record<AskRefType, string> = {
  ticket: "Ticket", pr: "Pull request", doc: "Doc", decision: "Decision", feed: "Feed entry", sprint: "Sprint", handoff: "Handoff",
  artifact: "Artifact", person: "Person", prompt: "Prompt", repo: "Repo",
};
export const refTypeWord = (v: Pick<RefView, "type">): string => TYPE_WORD[v.type];
/** The plural for a picker group ("Tickets", "Pull requests", "People"). */
export const refTypeGroup = (t: AskRefType): string => (t === "person" ? "People" : t === "pr" ? "Pull requests" : t === "feed" ? "Feed entries" : `${TYPE_WORD[t]}s`);

const handleOf = (v: RefView): string => (typeof v.extra.handle === "string" ? v.extra.handle : parseAskRef(v.ref)?.key ?? v.ref);

/** The short name a chip shows: `#14`, `@maya`, `Handoff #11`, else the title. */
export function refShort(v: RefView): string {
  if ((v.type === "ticket" || v.type === "pr") && v.num != null) return `#${v.num}`;
  if (v.type === "person") return `@${handleOf(v)}`;
  if (v.type === "handoff" && v.num != null) return `Handoff #${v.num}`;
  return v.title;
}
/** The full name (a picker row, a source row): `#14 Guided repository setup`, a person's name, else the title. */
export function refLabel(v: RefView): string {
  if ((v.type === "ticket" || v.type === "pr" || v.type === "handoff") && v.num != null) return `#${v.num} ${v.title}`;
  return v.title;
}
/** How the composer's context line names it: "ticket #14", "PR #176", "doc Hosting connections", "@maya". */
export function refCtxWord(v: RefView): string {
  switch (v.type) {
    case "ticket": return v.num != null ? `ticket #${v.num}` : `ticket ${v.title}`;
    case "pr": return v.num != null ? `PR #${v.num}` : `PR ${v.title}`;
    case "handoff": return v.num != null ? `handoff #${v.num}` : `handoff ${v.title}`;
    case "person": return `@${handleOf(v)}`;
    case "repo": case "feed": case "artifact": return v.title;
    default: return `${v.type} ${v.title}`;
  }
}
/** What a ref token shows when its item is not linked (not cited, hidden, not loaded): plain words from the key. */
export function refFallbackText(ref: string): string {
  if (isCvRef(ref)) return cvRefWord(ref);     // a block or a file of the conversation (ask-cvref.ts)
  const p = parseAskRef(ref);
  if (!p) return ref;
  if (p.type === "ticket" || p.type === "pr" || p.type === "handoff") return /^\d+$/.test(p.key) ? `#${p.key}` : p.key;
  if (p.type === "person") return `@${p.key}`;
  return p.key;
}

export const personOf = (look: Pick<RefLook, "persons">, handle: string | null | undefined): PersonSummary | null =>
  handle ? look.persons.find((p) => p.handle.toLowerCase() === handle.toLowerCase()) ?? null : null;
/** A person's avatar through people.ts (never an <img> of our own). */
export const refAvatar = (look: Pick<RefLook, "persons">, handle: string, size: number): string =>
  personChip(personOf(look, handle), size, handle);
/** A person's display name: the directory's, else the handle. */
export const personName = (look: Pick<RefLook, "persons">, handle: string): string => personOf(look, handle)?.name ?? handle;

// ── the chip ─────────────────────────────────────────────────────────────────

export interface RefChipOpts {
  /** `inline` (in a paragraph, 13px), `cell` (a table cell, 12.5px), `tag` (a 28px chip above a question). */
  size?: "inline" | "cell" | "tag";
  /** The act a click runs (default `askShOpen`: open in the inspector) and its arg (default the ref). */
  act?: string;
  arg?: string;
}
/** A ref as its chip. Unknown or hidden → the token's plain words (an unlinked ref is text, #12 §2.5). */
export function refChip(ref: string, look: RefLook, o: RefChipOpts = {}): string {
  const v = viewOf(look, ref);
  if (!v) return `<span class="ask-reftext">${esc(refFallbackText(ref))}</span>`;
  const size = o.size ?? "inline";
  const person = v.type === "person";
  const lead = person ? refAvatar(look, handleOf(v), 15)
    : (v.type === "ticket" || v.type === "pr") && v.status ? refStatusIcon(v.status, 12)
    : askIcon(REF_ICON[v.type], 13, "var(--fg-55)");
  const label = v.type === "pr" && v.status?.word === "Merged" ? `${refShort(v)} merged` : refShort(v);
  const aria = `${refTypeWord(v)}: ${person ? v.title : refLabel(v)}${v.status ? `, ${v.status.word}` : ""}`;
  const color = person ? `var(--p-${personOf(look, handleOf(v))?.color ?? "slate"})` : "var(--fg)";
  return `<button type="button" class="ask-chip ask-chip--${size}" data-act="${attr(o.act ?? "askShOpen")}" data-arg="${attr(o.arg ?? ref)}" data-ask-ref="${attr(ref)}" aria-label="${attr(aria)}" style="color:${color}">${lead}<span class="ask-chip-t">${esc(label)}</span></button>`;
}

/** `[[ticket:14|status]]`: the item's live status mark and word; "—" when it has none or is not linked. */
export function statusCell(ref: string, look: RefLook, size = 12.5): string {
  const v = viewOf(look, ref);
  return v?.status ? refStatusMark(v.status, size) : `<span style="color:var(--fg-40)">—</span>`;
}

/** A text's plain runs and ref tokens, in order. `status` marks a status-cell token. */
export type RefSeg = { text: string } | { ref: string; status: boolean };
export function splitRefTokens(text: string): RefSeg[] {
  const out: RefSeg[] = [];
  let at = 0;
  for (const m of text.matchAll(ASK_REF_TOKEN_RE)) {
    const i = m.index ?? 0;
    if (i > at) out.push({ text: text.slice(at, i) });
    out.push({ ref: `${m[1]}:${m[2]}`, status: m[3] === "status" });
    at = i + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}

/** Every ref a text's tokens name (to warm the store with one peek while an answer streams). */
export const refsInText = (text: string): string[] => [...new Set(splitRefTokens(text).flatMap((s) => ("ref" in s ? [s.ref] : [])))];

// ── a repository (#186) ──────────────────────────────────────────────────────
// A repo ref carries the Repo Overview's facts (`extra.facts`, shared/ai-ask-core.ts `AskRepoFacts`); its state is
// the Overview's own verdict (web/src/repo-verdict.ts `envVerdict`: Healthy only when checks PASS on the branch head,
// Live when none are captured, Unknown when nothing was seen) drawn with `stateMark` — never a mark of Ask's own.
// Environments are named by their label, hosts by the part's label, never a provider id.

/** The facts a repo ref carries, or null (not read: Unknown). */
export function repoFactsOf(v: Pick<RefView, "type" | "extra">): AskRepoFacts | null {
  const f = v.type === "repo" ? v.extra.facts : null;
  return f && typeof f === "object" && Array.isArray((f as AskRepoFacts).envs) ? (f as AskRepoFacts) : null;
}
/** The environment a repo's headline speaks for: Production (by key), else the last in promotion order. */
export function repoHeadEnv(f: AskRepoFacts): AskRepoFacts["envs"][number] | null {
  const envs = [...f.envs].sort((a, b) => a.position - b.position);
  return envs.find((e) => e.key === "production") ?? envs[envs.length - 1] ?? null;
}
/** Each environment's verdict, in promotion order (none when the facts were not read). */
export function repoVerdicts(f: AskRepoFacts | null): { env: AskRepoFacts["envs"][number]; verdict: EnvVerdict }[] {
  return f ? [...f.envs].sort((a, b) => a.position - b.position).map((env) => ({ env, verdict: envVerdict(f, env.key) })) : [];
}
/** A verdict as its mark (the Overview's tone, shape, word and tip). */
export const verdictMark = (v: Pick<EnvVerdict, "word" | "tone" | "shape" | "tip">, size = 12.5): string => stateMark(v.word, v.tone, v.shape, size, v.tip);
/** A repository's headline mark: its head environment's verdict, or Unknown when there are no facts. */
export function repoMark(f: AskRepoFacts | null, size = 12.5): string {
  const head = f ? repoHeadEnv(f) : null;
  return verdictMark(f && head ? envVerdict(f, head.key) : VERDICT.unknown, size);
}

/** A repository's CI as a mark — its head environment's checks, in the checks' own words ("Checks failing" /
 *  "passing" / "running", the PR summary's vocabulary), the line itself in the tooltip; "Unknown" when no checks were
 *  captured on the branch head (never guessed). A diagram's repo node is CI (the owner, QA-5): the design's "CI on
 *  main" node shows the checks, not the deploy verdict. */
export function repoCiMark(f: AskRepoFacts | null, size = 12.5): string {
  const head = f ? repoHeadEnv(f) : null;
  const c = f && head ? f.ci.find((x) => x.env === head.key) : undefined;
  const line = ciLine(c);
  if (!c || !line) return stateMark(VERDICT.unknown.word, VERDICT.unknown.tone, VERDICT.unknown.shape, size, f ? "No checks captured on the branch head." : "Trov has no reading of this repository yet.");
  const tip = `${head!.name}: ${line.text}`;
  return c.state === "fail" ? stateMark("Checks failing", "var(--red)", "diamond", size, tip)
    : c.state === "pass" ? stateMark("Checks passing", "var(--green)", "dot", size, tip)
    : stateMark("Checks running", "var(--fg-55)", "ring", size, tip);
}

// ── a pull request's checks ──────────────────────────────────────────────────

/** A PR's checks as the design's summary: failing (diamond), passing (dot), running (ring), or nothing. */
export type PrCheck = { name: string; state: string };
export const checksOf = (x: Pick<RefView, "extra">): PrCheck[] => (Array.isArray(x.extra.checks) ? (x.extra.checks as { name?: unknown; state?: unknown }[])
  .filter((c) => typeof c.name === "string").map((c) => ({ name: String(c.name), state: String(c.state ?? "") })) : []);
export const CHECK_PASS: ReadonlySet<string> = new Set(["success", "neutral", "skipped"]);
export const CHECK_FAIL: ReadonlySet<string> = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);
export function checkSummaryMark(checks: PrCheck[], size = 11.5): string {
  if (!checks.length) return "";
  if (checks.some((c) => CHECK_FAIL.has(c.state))) return stateMark("Checks failing", "var(--red)", "diamond", size, "At least one check failed on its newest commit.");
  if (checks.every((c) => CHECK_PASS.has(c.state))) return stateMark("Checks passing", "var(--green)", "dot", size, "Every check passed on its newest commit.");
  return stateMark("Checks running", "var(--fg-55)", "ring", size, "Checks are still running on its newest commit.");
}

// ── the hover card (ask-trov.dc.html L1010–1038) ─────────────────────────────

export interface HoverAt { x: number; y: number }
const metaLine = (html: string): string => `<div class="ask-hc-meta">${html}</div>`;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

/** The 300px card for one item, placed at `at` (viewport px, already clamped by the controller). Person cards
 *  lead with the avatar; everything else with its type word, title and status. Its foot opens the item. */
export function hoverCard(v: RefView, look: RefLook, at: HoverAt): string {
  const e = v.extra;
  let body = "";
  if (v.type === "person") {
    const handle = handleOf(v);
    const working = Array.isArray(e.workingOn) ? (e.workingOn as unknown[]).filter((x): x is string => typeof x === "string") : [];
    const now = working.map((r) => { const w = viewOf(look, r); return w ? refShort(w) : refFallbackText(r); });
    body = `<div class="ask-hc-person">${refAvatar(look, handle, 36)}<div style="min-width:0"><div class="ask-hc-title">${esc(v.title)}</div><div style="font-size:12px;font-weight:500;color:var(--p-${personOf(look, handle)?.color ?? "slate"})">@${esc(handle)}</div></div></div>
      ${str(e.role) ? `<div style="margin-top:10px;font-size:12.5px;color:var(--fg-70)">${esc(str(e.role)!)}</div>` : ""}
      ${now.length ? `<div style="margin-top:4px;font-size:12.5px;color:var(--fg-55)">Working on ${esc(now.length > 1 ? `${now.slice(0, -1).join(", ")} and ${now[now.length - 1]}` : now[0])}</div>` : ""}`;
  } else {
    const eyebrow = `${refTypeWord(v)}${v.num != null && (v.type === "ticket" || v.type === "pr" || v.type === "handoff") ? ` #${v.num}` : ""}`;
    body = `<div class="ask-hc-eyebrow">${askIcon(REF_ICON[v.type], 13, "var(--fg-40)")}${esc(eyebrow)}</div>
      <div class="ask-hc-title" style="margin-top:5px">${esc(v.title)}</div>
      ${v.status ? `<div style="margin-top:8px">${refStatusMark(v.status, 12.5)}</div>` : ""}`;
    if (v.type === "ticket") {
      const asg = Array.isArray(e.assignees) ? (e.assignees as unknown[]).filter((x): x is string => typeof x === "string") : [];
      const pr = str(e.priority);
      body += `<div class="ask-hc-row">${pr ? `<span style="display:inline-flex;align-items:center;gap:5px">${pr === "high" || pr === "normal" || pr === "low" ? priorityIcon(pr, 13, false) : ""}${esc(pr[0].toUpperCase() + pr.slice(1))}</span>` : ""}<span style="display:inline-flex;gap:2px">${asg.map((h) => refAvatar(look, h, 18)).join("")}</span><span style="color:var(--fg-55)">${esc(str(e.sprint) ? `Sprint ${str(e.sprint)}` : "Backlog")}</span></div>
        ${v.updated ? `<div style="margin-top:8px;font-size:11.5px;color:var(--fg-40)">Updated ${esc(relTime(v.updated))}</div>` : ""}`;
    } else if (v.type === "pr") {
      const author = str(e.author);
      const checks = Array.isArray(e.checks) ? (e.checks as { name?: unknown; state?: unknown }[]) : [];
      const failing = checks.filter((c) => c.state === "failure").length;
      body += `${author ? `<div class="ask-hc-row">${refAvatar(look, author, 16)}${esc(personName(look, author))}<span style="color:var(--fg-55)">· ${esc(relTime(v.updated ?? null))}</span></div>` : ""}
        ${str(e.head) ? `<div style="margin-top:6px;font-family:var(--code);font-size:11px;color:var(--fg-55)">${esc(`${str(e.head)} → ${str(e.base) ?? "main"}`)}</div>` : ""}
        ${checks.length ? `<div class="ask-hc-row"><span style="display:inline-flex;gap:3px">${checks.map((c) => markShape(c.state === "failure" ? "diamond" : "dot", c.state === "failure" ? "var(--red)" : "var(--green)", 8)).join("")}</span>${esc(failing ? `${failing} check${failing === 1 ? "" : "s"} failing` : "All checks pass")}</div>` : ""}`;
    } else if (v.type === "doc") {
      const owner = str(e.owner);
      body += metaLine(esc([str(e.space) ? `${str(e.space)![0].toUpperCase()}${str(e.space)!.slice(1)}` : null, e.version != null ? `v${String(e.version)}` : null, owner ? personName(look, owner) : null].filter(Boolean).join(" · ")))
        + (str(e.excerpt) ? `<div class="ask-hc-excerpt">${esc(str(e.excerpt)!)}</div>` : "");
    } else if (v.type === "repo") {
      // The environments' verdicts (at most three, promotion order), then the head environment's checks.
      const f = repoFactsOf(v);
      const rows = repoVerdicts(f);
      const head = f ? repoHeadEnv(f) : null;
      const ci = f && head ? ciLine(f.ci.find((c) => c.env === head.key)) : null;
      body += rows.length
        ? `<div class="ask-hc-row" style="flex-wrap:wrap">${rows.slice(0, 3).map(({ env, verdict }) => `<span style="display:inline-flex;align-items:center;gap:6px">${esc(env.name)} ${verdictMark(verdict, 12)}</span>`).join("")}</div>`
        : `<div class="ask-hc-row">${verdictMark(VERDICT.unknown, 12)}</div>`;
      body += metaLine(esc(ci ? `${head!.name}: ${ci.text}` : f ? "No checks captured on the branch head." : "Trov has no reading of this repository yet."));
    } else {
      const meta = v.type === "handoff" ? `From ${personName(look, str(e.from) ?? "")} to ${str(e.to) === "anyone" || !str(e.to) ? "anyone" : personName(look, str(e.to)!)}`
        : v.type === "feed" ? str(e.brief)
        : v.type === "artifact" ? [str(e.kind) === "html" ? "HTML page" : str(e.kind) === "markdown" ? "Markdown" : str(e.kind), e.version != null ? `v${String(e.version)}` : null].filter(Boolean).join(" · ")
        : null;
      if (meta) body += metaLine(esc(meta));
    }
  }
  // Keyed by the ref: another chip's card is a new element, so it pops in again (ask-motion.ts rule 1).
  return `<div class="ask-hc" role="dialog" aria-label="${attr(v.title)}" data-ask-hc="${attr(v.ref)}" data-morph-key="hc:${attr(v.ref)}" style="left:${Math.round(at.x)}px;top:${Math.round(at.y)}px">
    ${body}
    <div class="ask-hc-foot"><span>Click to open beside the thread</span><button type="button" data-act="askShOpen" data-arg="${attr(v.ref)}" class="ask-hc-open">Open</button></div>
  </div>`;
}

/** The card's size, for the controller's placement (ask-trov.dc.html L1473: 300 × ~190). */
export const HOVER_CARD = { width: 300, height: 190, delayMs: 320, leaveMs: 140 } as const;
/** Where the card goes for a chip at `r` in a `vw` × `vh` viewport: under it, else above; 12px from the edges. */
export function placeHoverCard(r: { left: number; top: number; bottom: number }, vw: number, vh: number): HoverAt {
  const x = Math.max(12, Math.min(r.left, vw - HOVER_CARD.width - 12));
  let y = r.bottom + 6;
  if (y + HOVER_CARD.height > vh - 12) y = Math.max(12, r.top - HOVER_CARD.height - 6);
  return { x, y };
}
