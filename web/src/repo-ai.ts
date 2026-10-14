// The Repo dashboard's two sections Trov writes (shared/ai-core.ts), each drawn ONLY when the
// dashboard carries its field — absent, the tab is exactly what it was (test/render.ai-absent.test.ts):
//
//   Overview › State (`RepoDashboard.state`): a one-line headline and three wrapping columns —
//     Shipped recently (the done glyph, green), In flight (the half glyph, blue), Needs attention
//     (the warning glyph, amber) — each line linked to its sources; "Written by Trov from 6 events".
//   Planning › Where the work went (`RepoDashboard.themes`, per range): the caption, an 8 weeks /
//     Quarter switch, and a lane per theme with a band per week sized by its merged pull requests
//     (a zero week draws no band). A lane is a button: it is picked (`aria-pressed`), the others fade,
//     and its description and pull requests show under the chart. Proposed themes are suggestions
//     (ai-ui.ts `aiSuggestionChip`): an admin accepts, renames or removes each; a member is told
//     they wait on an admin.
//
// Both are their own card above the dashboard's one panel (the mock's layout): the panel's hairlines
// and its sections are untouched. Pure markup; the acts are ai-actions.ts's.

import type { AiLine, AiRepoState, AiThemeLane, AiThemeRange, AiThemes } from "@shared/ai-core";
import { AI_THEME_RANGES, AI_THEME_RANGE_LABELS } from "@shared/ai-core";
import { esc, attr, surface } from "./ui";
import { glyph } from "./marks";
import { segmented } from "./segmented";
import {
  AI_EMPTY, AI_TIP, aiByline, aiCapped, aiCite, aiCites, aiDay, aiEmpty, aiFeedback, aiIsHidden, aiSuggestionChip, aiWrongBtn, type AiUi,
} from "./ai-ui";

/** What the two sections need from the screen besides the field. */
export interface RepoAiProps {
  ui: AiUi;
  admin: boolean;
  /** `owner/repo` — the item a "Wrong?" is about. */
  repo: string;
}

const HEAD = "margin:0;font-size:13.5px;font-weight:600;font-family:var(--label);color:var(--fg-55)";
const CARD = "padding:20px 22px;display:flex;flex-direction:column;gap:18px;margin-bottom:16px;min-width:0";

// ── Overview › State ─────────────────────────────────────────────────────────

const COLUMNS: { key: "shipped" | "inFlight" | "attention"; title: string; mark: string; tone: string }[] = [
  { key: "shipped", title: "Shipped recently", mark: glyph("done", "var(--green)", 13), tone: "var(--green)" },
  { key: "inFlight", title: "In flight", mark: glyph("half", "var(--blue)", 13), tone: "var(--blue)" },
  { key: "attention", title: "Needs attention", mark: glyph("warn", "var(--amber)", 13), tone: "var(--amber)" },
];

function stateLine(l: AiLine): string {
  return `<li style="line-height:1.55;overflow-wrap:anywhere">${esc(l.text)}${l.cites.length ? ` <span style="display:inline-flex;flex-wrap:wrap;gap:6px">${aiCites(l.cites)}</span>` : ""}</li>`;
}

/** Overview's first section. "" when this person pressed "Wrong?" on it. */
export function repoStateSection(st: AiRepoState, p: RepoAiProps): string {
  const ref = `${p.repo}@${st.generatedAt ?? "state"}`;
  if (aiIsHidden(p.ui, "repo_state", ref)) return "";
  const from = st.eventCount === null ? undefined : `${st.eventCount} ${st.eventCount === 1 ? "event" : "events"}`;
  const head = `<div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px">
      <h2 id="repo-state-h" style="${HEAD}">State</h2>${aiByline(st.generatedAt, AI_TIP.state, { from })}
    </div>`;
  let body: string;
  if (st.state === "empty") body = aiEmpty(AI_EMPTY.state);
  else if (st.state === "capped") {
    const clause = st.generatedAt ? `this state is from ${aiDay(st.generatedAt)} and resumes ${aiDay(st.resumesOn)}` : `the state resumes ${aiDay(st.resumesOn)}`;
    body = `<div style="display:flex;flex-direction:column;gap:8px">${st.headline ? `<p class="repo-state-hl" style="margin:0;font-size:18px;font-weight:500;line-height:1.4;letter-spacing:-0.005em;max-width:64ch">${esc(st.headline)}</p>` : ""}${aiCapped(st, clause)}</div>`;
  } else {
    const cols = COLUMNS.map((c) => {
      const lines = st[c.key];
      return `<div style="display:flex;flex-direction:column;gap:10px;min-width:0" data-ai-col="${c.key}">
          <h3 style="margin:0;font-size:13px;font-weight:600;color:${c.tone};display:flex;align-items:center;gap:6px">${c.mark}${c.title}</h3>
          ${lines.length
            ? `<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px;font-size:13.5px">${lines.map(stateLine).join("")}</ul>`
            : `<p style="margin:0;font-size:13px;color:var(--fg-55)">Nothing here.</p>`}
        </div>`;
    }).join("");
    body = `<div style="display:flex;flex-direction:column;gap:18px">
        ${st.headline ? `<p class="repo-state-hl" style="margin:0;font-size:18px;font-weight:500;line-height:1.4;letter-spacing:-0.005em;max-width:64ch">${esc(st.headline)}</p>` : ""}
        <div class="repo-state-cols">${cols}</div>
      </div>`;
  }
  const wrong = st.generatedAt && st.state !== "empty"
    ? `<div style="display:flex;justify-content:flex-end">${aiWrongBtn(aiFeedback("repo_state", ref, "repo_state", st.model))}</div>` : "";
  return `<section${surface(CARD, { cls: "repo-ai cnpy-rise" })} data-ai="repo_state" data-ai-state="${st.state}" aria-labelledby="repo-state-h">${head}${body}${wrong}</section>`;
}

// ── Planning › Where the work went ───────────────────────────────────────────

/** "Aug 24" for a week's Monday. */
export const weekLabel = (day: string): string => aiDay(day);

/** A week's band height in px: proportional to its count against the busiest week in view; a zero
 *  week has NO band (null). */
export function bandHeight(count: number, max: number): number | null {
  if (!(count > 0) || !(max > 0)) return null;
  return Math.round(6 + (Math.min(count, max) / max) * 30);
}

const chip = (lane: Pick<AiThemeLane, "colorKey">): string =>
  `<span aria-hidden="true" style="width:10px;height:10px;border-radius:3px;background:var(--p-${lane.colorKey});flex:none"></span>`;

function lanePicked(t: AiThemes, ui: AiUi): AiThemeLane | null {
  return t.lanes.find((l) => l.id === ui.themesLane) ?? t.lanes[0] ?? null;
}

function chart(t: AiThemes, picked: AiThemeLane | null): string {
  const n = t.weeks.length;
  const max = Math.max(0, ...t.lanes.flatMap((l) => l.counts));
  const cols = `grid-template-columns:var(--lane-w,190px) repeat(${n},minmax(0,1fr))`;
  const head = `<div class="repo-themes-row" aria-hidden="true" style="display:grid;${cols};gap:6px;font-size:12px;color:var(--fg-55);padding:0 4px 4px;border-bottom:1px solid var(--border)"><span></span>${t.weeks.map((w) => `<span style="text-align:center;white-space:nowrap">${esc(weekLabel(w))}</span>`).join("")}</div>`;
  const rows = t.lanes.map((l) => {
    const on = picked?.id === l.id;
    const total = l.counts.reduce((a, b) => a + b, 0);
    const cells = t.weeks.map((_, i) => {
      const h = bandHeight(l.counts[i] ?? 0, max);
      return `<span style="display:flex;align-items:center;justify-content:center;height:40px">${h === null ? "" : `<span class="repo-band" style="display:block;width:100%;height:${h}px;border-radius:4px;background:var(--p-${l.colorKey})"></span>`}</span>`;
    }).join("");
    return `<button type="button" data-act="aiThemesLane" data-arg="${attr(l.id)}" aria-pressed="${on}" aria-label="${attr(`${l.name}: ${total} merged pull ${total === 1 ? "request" : "requests"}${l.status === "proposed" ? ", proposed" : ""}`)}" class="repo-lane" data-on="${on ? "1" : "0"}" style="display:grid;${cols};gap:6px;align-items:center;width:100%;text-align:left;border-radius:8px;padding:6px 4px;min-height:52px;${on ? "background:var(--hover)" : "opacity:.55"}">
        <span style="display:flex;align-items:center;gap:8px;padding-left:6px;font-weight:500;font-size:13.5px;min-width:0"><span style="display:inline-flex;align-items:center;gap:8px;min-width:0">${chip(l)}<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.name)}</span></span></span>${cells}
      </button>`;
  }).join("");
  return `<div class="repo-themes-scroll" style="overflow-x:auto">
      <div class="repo-themes-chart" style="min-width:${Math.max(640, 200 + n * 52)}px;display:flex;flex-direction:column;gap:4px">${head}${rows}</div>
    </div>`;
}

function laneDetail(l: AiThemeLane): string {
  return `<div class="repo-lane-detail" style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--border);padding-top:16px" aria-live="polite">
      <h3 style="margin:0;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px">${chip(l)}${esc(l.name)}</h3>
      <p style="margin:0;color:var(--fg-70);line-height:1.55">${esc(l.description)}</p>
      ${l.prs.length ? `<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px;font-size:13.5px">${l.prs.map((c) => `<li>${aiCite(c)}</li>`).join("")}</ul>` : ""}
    </div>`;
}

/** The proposed themes, each a suggestion an admin acts on. */
function proposals(lanes: AiThemeLane[], p: RepoAiProps): string {
  const ui = p.ui;
  const items = lanes.map((l) => {
    const id = l.suggestionId;
    if (id === null) return "";
    const renaming = ui.rename?.id === id;
    const rename = renaming
      ? `<span style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap">
          <label for="ai-rename-${id}" class="cnpy-sr">New name for ${esc(l.name)}</label>
          <input id="ai-rename-${id}" data-act="aiRenameDraft" data-arg="${id}" data-field="aiRename:${id}" data-enter="aiRenameSave" value="${attr(ui.rename?.draft ?? "")}" maxlength="60" autocomplete="off" class="cnpy-input" style="height:26px;padding:0 8px;border:1px solid var(--border-strong);border-radius:6px;background:var(--surface);color:var(--fg);font-size:12.5px;width:180px;max-width:100%" />
          <button type="button" data-act="aiRenameSave" data-arg="${id}" class="cnpy-ghostbtn" style="font-size:12px;font-weight:500;border:1px solid var(--border-strong);border-radius:6px;padding:2px 9px;min-height:26px">Save</button>
          <button type="button" data-act="aiRenameCancel" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-55);padding:2px 6px;min-height:26px">Cancel</button>
        </span>`
      : `<button type="button" data-act="aiRenameOpen" data-arg="${id}" data-field="aiRenameOpen:${id}" class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-70);border-radius:6px;padding:2px 9px;min-height:26px;white-space:nowrap">Rename</button>`;
    return `<li style="min-width:0">${aiSuggestionChip(
      { key: `theme-${id}`, id, label: l.name, reason: l.description, cites: l.prs.slice(0, 3) },
      { open: ui.reasonOpen === `theme-${id}`, busy: ui.busy.includes(id), unavailable: ui.unavailable.includes(id), canAct: p.admin, dismissLabel: "Remove", extra: rename },
    )}</li>`;
  }).join("");
  return `<div id="repo-themes-proposed" class="repo-themes-proposed" tabindex="-1" style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px">
        <h3 style="margin:0;font-size:14px;font-weight:600">Trov suggests these themes</h3>
        ${p.admin ? "" : `<span style="font-size:12.5px;color:var(--fg-55)">Waiting for an admin to accept themes</span>`}
      </div>
      <ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:8px">${items}</ul>
    </div>`;
}

/** Planning's first section, from the range picked (`ui.themesRange`). "" when this person pressed
 *  "Wrong?" on it. */
export function themesSection(all: Record<AiThemeRange, AiThemes>, p: RepoAiProps): string {
  const range = p.ui.themesRange;
  const t = all[range] ?? all["8w"];
  if (!t) return "";
  const ref = `${p.repo}:${range}@${t.generatedAt ?? "themes"}`;
  if (aiIsHidden(p.ui, "themes", ref)) return "";
  const proposed = t.lanes.filter((l) => l.status === "proposed");
  const switcher = segmented({
    id: "repo-themes-range", ariaLabel: "Range", act: "aiThemesRange", value: range, size: "sm", inertOn: true,
    options: AI_THEME_RANGES.map((r) => ({ value: r, label: AI_THEME_RANGE_LABELS[r] })),
  });
  const edit = p.admin && t.state !== "empty"
    ? `<button type="button" data-act="aiThemesEdit" class="cnpy-ghostbtn" style="font-size:13px;font-weight:500;border:1px solid var(--border-strong);border-radius:6px;padding:5px 12px;min-height:32px;white-space:nowrap">Edit themes</button>` : "";
  const written = t.caption ? "Themes and caption written by Trov" : "Themes written by Trov";
  const count = t.state === "empty" ? "" : aiByline(t.generatedAt, AI_TIP.themes, {
    lead: written, from: t.prCount === null ? undefined : `${t.prCount} pull ${t.prCount === 1 ? "request" : "requests"}`,
  });
  const head = `<div style="display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px">
      <div style="display:flex;flex-direction:column;gap:6px;flex:1 1 420px;min-width:0">
        <h2 id="repo-themes-h" style="margin:0;font-size:18px;font-weight:600;letter-spacing:-0.01em">Where the work went</h2>
        ${t.caption ? `<p style="margin:0;color:var(--fg-70);max-width:62ch;line-height:1.55">${esc(t.caption)}</p>` : ""}
        ${count}
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">${switcher}${edit}</div>
    </div>`;
  if (t.state === "empty" || !t.lanes.length) {
    return `<section${surface(CARD, { cls: "repo-ai cnpy-rise" })} data-ai="themes" data-ai-state="${t.state}" aria-labelledby="repo-themes-h">${head}${aiEmpty(AI_EMPTY.themes)}</section>`;
  }
  const picked = lanePicked(t, p.ui);
  const capped = t.state === "capped" ? aiCapped(t, `themes resume ${aiDay(t.resumesOn)}`) : "";
  const wrong = t.generatedAt ? aiWrongBtn(aiFeedback("themes", ref, "themes", t.model), 12) : "";
  return `<section${surface(CARD, { cls: "repo-ai cnpy-rise" })} data-ai="themes" data-ai-state="${proposed.length ? "proposed" : t.state}" aria-labelledby="repo-themes-h">
      ${head}${capped}
      ${proposed.length ? proposals(proposed, p) : ""}
      ${chart(t, picked)}
      ${picked ? laneDetail(picked) : ""}
      <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px">
        <p style="margin:0;font-size:12px;color:var(--fg-55)">Band height is merged pull requests per week.</p>${wrong}
      </div>
    </section>`;
}
