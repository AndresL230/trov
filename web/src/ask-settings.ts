// Settings › Trov (Trov handoff #12 §3, the design's `settings` scenario): how Ask Trov answers ME in this
// organization — my instructions (at most ASK_INSTRUCTIONS_MAX characters, with the counter and the Try chips), the
// mode a new thread starts in (Pro: a segmented switch; a plan with one mode says so), what Trov can and cannot see,
// and Save. Three tiles of personal Settings' bento (render.ts `settingsView`, after MCP access), placed by name in
// trov.css (`/* ── Ask: Settings › Trov ── */`).
//
// The rows are `GET / PUT /api/o/:slug/ask/settings`; the plan, the modes it offers and their words, and the org's
// switch are `GET …/ask/state` — never constants here. The controller is ask-settings-actions.ts (acts `trovSet…`).
//
// Pure markup over `TrovPrefsUi`: the page is `data-morph`ed, so typing patches it in place, and every part that
// changes while typing (the counter, its colour, Save's label) is always emitted.
import { esc } from "./ui";
import { segmented } from "./segmented";
import { markShape, STATE_KIND, kindMark } from "./marks";
import { skLine, skBox, skeleton } from "./skeleton";
import type { Loadable } from "./render";
import { ASK_INSTRUCTIONS_MAX, ASK_MODES, type AskMode, type AskSettings, type AskState } from "@shared/ai-ask-core";
import { PLANS, type PlanId } from "@shared/plans";
import { ASK_GITHUB_HELD } from "@shared/legal-core";

export interface TrovPrefsUi {
  /** The organization these were read for; another org on screen means read again. */
  slug: string | null;
  settings: Loadable<AskSettings | null>;
  /** Ask's standing in the org: whether it is on, the plan, the modes (with their words). */
  state: Loadable<AskState | null>;
  /** What the person has typed or picked and not saved; null = as saved. */
  draftInstructions: string | null;
  draftMode: AskMode | null;
  saving: boolean;
  /** Save reads "Saved" from a save until the next change. */
  saved: boolean;
  /** Why the last save was refused, in words. */
  error: string | null;
}

export const initialTrovPrefs = (): TrovPrefsUi => ({
  slug: null, settings: { status: "idle", data: null }, state: { status: "idle", data: null },
  draftInstructions: null, draftMode: null, saving: false, saved: false, error: null,
});

// ── the design's copy ────────────────────────────────────────────────────────
/** "Try:" — appended to what is there. */
export const TROV_TRY = ["Lead with what is blocked, then what shipped.", "Keep answers under 150 words and link every ticket."] as const;
export const TROV_SEES: readonly string[] = [
  "Tickets, docs, pull requests, sprints, handoffs, the feed and artifacts you can open yourself.",
  "The Repo dashboard: CI, deploys and environment health.",
  // Ask's GitHub tools (docs/architecture/ask.md › GitHub): shown once they are released (ASK_GITHUB_HELD).
  ...(ASK_GITHUB_HELD ? [] : ["Your connected repositories on GitHub, read-only: files, pull requests and their changes, issues, commits and checks, when a question needs them."]),
  "Files and screenshots you attach to a thread.",
];
export const TROV_DOES_NOT = [
  "Read other people's threads or private artifacts.",
  "Write code. It reads PR summaries and files tickets and handoffs for the agents that do.",
  "Reach anything outside Trov, like email, chat or calls.",
] as const;
export const TROV_GATE = "Its changes go through the same gate as an agent's. Doc edits wait in Review; tickets and handoffs wait for your Confirm unless a thread is on Auto.";
export const TROV_SAVED = "Saved. New threads use these settings.";
export const TROV_OFF = "Ask Trov is off for this org. An admin can turn it on in Org settings › AI.";
/** Where what Trov reads is connected (#186's Org settings split): each name opens its tab (`orgGo`). */
export const TROV_WHERE: readonly { tab: "integrations" | "repos" | "hosting" | "environments"; label: string }[] = [
  { tab: "integrations", label: "Integrations" },
  { tab: "repos", label: "Repositories" },
  { tab: "hosting", label: "Hosting" },
  { tab: "environments", label: "Environments" },
];
/** "Org settings › <tab>" as an in-app link (the house `orgGo` act; render.ts routes it). */
const orgLink = (tab: string, label: string, fs = 12.5): string =>
  `<button type="button" data-act="orgGo" data-arg="${tab}" class="cnpy-mutelink" style="padding:0;font-size:${fs}px;font-weight:500;color:var(--fg-70);text-decoration:underline;text-underline-offset:2px">${label}</button>`;
/** The one-mode line: the design's "On Free, every question uses Smart.", for the plan on screen. */
export const oneModeLine = (plan: string | null | undefined): string =>
  `On ${plan && plan in PLANS ? PLANS[plan as PlanId].name : "Free"}, every question uses Smart.`;

const LABEL = "font-size:11px;font-weight:600;font-family:var(--label);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)";
const NOTE = "font-size:13px;line-height:1.55;color:var(--fg-55)";

/** The text in the box: the draft, else what is saved. */
export const trovInstructions = (ui: TrovPrefsUi): string => ui.draftInstructions ?? ui.settings.data?.instructions ?? "";

/** The modes the plan offers, with their words: the state's, else the settings' ids read against ASK_MODES. */
export function trovModes(ui: TrovPrefsUi): { id: AskMode; label: string; hint: string }[] {
  const st = ui.state.data?.modes;
  if (st?.length) return st.map((m) => ({ id: m.id, label: m.label, hint: m.hint }));
  const ids = ui.settings.data?.modes ?? [];
  return ASK_MODES.filter((m) => ids.includes(m.id)).map((m) => ({ id: m.id, label: m.label, hint: m.hint }));
}

export const trovMode = (ui: TrovPrefsUi): AskMode | null => ui.draftMode ?? ui.settings.data?.defaultMode ?? null;

/** The counter's tone: quiet, amber in the last tenth, red past the limit. */
export function counterTone(n: number, max = ASK_INSTRUCTIONS_MAX): "quiet" | "near" | "over" {
  return n > max ? "over" : n > Math.floor(max * 0.9) ? "near" : "quiet";
}
const TONE_COLOR = { quiet: "var(--fg-40)", near: "var(--amber)", over: "var(--red)" } as const;

function instructionsTile(ui: TrovPrefsUi): string {
  const ready = !!ui.settings.data;
  const failed = !ready && ui.settings.status === "error";
  const text = trovInstructions(ui);
  const n = text.length;
  const tone = counterTone(n);
  const off = ui.state.data && !ui.state.data.enabled
    ? `<div data-trov-off style="display:flex;align-items:flex-start;gap:8px;margin:12px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg-70)"><span style="flex:none;margin-top:4px">${markShape(STATE_KIND.off.shape, STATE_KIND.off.tone, 9)}</span><span>${esc(TROV_OFF.replace(/Org settings › AI\.$/, ""))}${orgLink("ai", "Org settings &rsaquo; AI")}.</span></div>`
    : "";
  const field = failed
    ? `<div data-trov-error style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:14px 0 4px;font-size:13px;color:var(--fg-70)">${kindMark("Couldn't load your Trov settings.", "bad", 13)}<button type="button" data-act="trovSetRetry" class="cnpy-ghostbtn" style="padding:4px 12px;border-radius:7px;border:1px solid var(--border-strong);font-size:12.5px;color:var(--fg-70)">Try again</button></div>`
    : ready
    ? `<textarea id="trov-instr" data-field="trovInstr" data-act="trovSetInstr" maxlength="${ASK_INSTRUCTIONS_MAX}" rows="6" aria-describedby="trov-instr-count"${tone === "over" ? ' aria-invalid="true"' : ""} placeholder="For example: lead with what is blocked, and keep it short." style="display:block;width:100%;min-height:140px;resize:vertical;padding:11px 13px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font:inherit;font-size:14px;line-height:1.6;outline:none">${esc(text)}</textarea>
      <div style="display:flex;align-items:flex-start;gap:12px;margin-top:8px">
        <div style="flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:center;gap:6px"><span style="font-size:12px;color:var(--fg-55)">Try:</span>${TROV_TRY.map((t, i) => `<button type="button" data-act="trovSetTry" data-arg="${i}" class="cnpy-ghostbtn" style="padding:4px 10px;border-radius:7px;border:1px solid var(--border);font-size:12px;color:var(--fg-70);text-align:left">${esc(t)}</button>`).join("")}</div>
        <span id="trov-instr-count" class="cnpy-trov-count" data-trov-count="${tone}" aria-live="polite" style="flex:none;font-family:var(--label);font-size:12px;color:${TONE_COLOR[tone]};white-space:nowrap;font-variant-numeric:tabular-nums">${n} / ${ASK_INSTRUCTIONS_MAX}</span>
      </div>`
    : skeleton("trov-instr", "Loading your Trov settings&hellip;", `${skBox("100%", 140)}<div style="margin-top:10px">${skLine("60%", 12)}</div>`);
  return `<section class="cnpy-tile cnpy-surface cnpy-set-trov-instr" data-screen-label="Settings › Trov">
    <div style="${LABEL}">Trov</div>
    <h2 style="margin:14px 0 4px;font-size:16px;font-weight:600;letter-spacing:-0.01em"><label for="trov-instr">How Trov should answer you</label></h2>
    <p style="margin:0 0 12px;${NOTE}">Trov follows this in every new thread. It shapes tone and length, not what Trov can see.</p>
    ${field}
    ${off}
  </section>`;
}

function modeTile(ui: TrovPrefsUi): string {
  const modes = trovModes(ui);
  const picked = trovMode(ui);
  const plan = ui.state.data?.plan ?? null;
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px"><div style="${LABEL}">Default mode</div><span style="font-size:12px;color:var(--fg-55)">Pro</span></div>`;
  let body: string;
  if (!ui.settings.data) {
    body = ui.settings.status === "error"
      ? `<p style="margin:14px 0 0;${NOTE}">&mdash;</p>`
      : skeleton("trov-mode", "Loading&hellip;", `${skLine("80%", 13)}<div style="margin-top:12px">${skBox("100%", 34)}</div>`, "margin-top:14px");
  } else if (modes.length > 1) {
    const hint = modes.find((m) => m.id === picked)?.hint ?? "";
    body = `<p style="margin:14px 0 12px;${NOTE}">New threads start in this mode. You can switch per question in the composer.</p>
      ${segmented({ id: "trov-defmode", ariaLabel: "Default mode", value: picked ?? "", act: "trovSetMode", size: "md", fill: true, inertOn: true, options: modes.map((m) => ({ value: m.id, label: m.label })) })}
      <div data-trov-hint style="margin-top:10px;font-size:12.5px;line-height:1.5;color:var(--fg-70)">${esc(hint)}</div>`;
  } else {
    // One mode (Free, Personal): nothing to pick — the plan's line says what every question uses.
    body = `<p data-trov-onemode style="margin:14px 0 0;${NOTE}">${esc(oneModeLine(plan))}</p>`;
  }
  const foot = modes.length > 1 ? `<div style="margin-top:auto;padding-top:12px;border-top:1px solid var(--border);font-size:12px;color:var(--fg-55)">${esc(oneModeLine("free"))}</div>` : "";
  return `<section class="cnpy-tile cnpy-surface cnpy-set-trov-mode">
    ${head}
    ${body}
    ${foot ? `<div style="flex:1;min-height:18px"></div>${foot}` : ""}
  </section>`;
}

function seeTile(ui: TrovPrefsUi): string {
  const yes = markShape(STATE_KIND.good.shape, STATE_KIND.good.tone, 9);
  const no = markShape(STATE_KIND.off.shape, STATE_KIND.off.tone, 9);
  const row = (mark: string, t: string) => `<li style="display:flex;gap:9px;align-items:flex-start;padding:5px 0;font-size:13px;line-height:1.55;color:var(--fg-70)"><span style="flex:none;margin-top:5px;display:flex">${mark}</span><span>${esc(t)}</span></li>`;
  const list = "list-style:none;margin:0;padding:0";
  const n = trovInstructions(ui).length;
  const canSave = !!ui.settings.data && !ui.saving && counterTone(n) !== "over";
  // "Saved" arrives as its own node, so it rises once when a save lands (and never again on a rerender: the page is morphed).
  const label = ui.saving ? "Saving&hellip;" : ui.saved ? `<span class="cnpy-trov-saved">Saved</span>` : "Save";
  return `<section class="cnpy-tile cnpy-surface cnpy-set-trov-see">
    <div style="${LABEL}">What Trov can see</div>
    <div class="cnpy-trov-see">
      <div><h3 style="margin:0 0 8px;font-size:13.5px;font-weight:600">It reads</h3><ul style="${list}">${TROV_SEES.map((t) => row(yes, t)).join("")}</ul>
        <p data-trov-where style="margin:8px 0 0 18px;font-size:12.5px;line-height:1.55;color:var(--fg-55)">GitHub, hosts and environments are connected in Org settings &rsaquo; ${TROV_WHERE.map((w, i) => `${i === TROV_WHERE.length - 1 ? " and " : i ? ", " : ""}${orgLink(w.tab, w.label)}`).join("")}.</p></div>
      <div><h3 style="margin:0 0 8px;font-size:13.5px;font-weight:600">It does not</h3><ul style="${list}">${TROV_DOES_NOT.map((t) => row(no, t)).join("")}</ul></div>
    </div>
    <div class="cnpy-trov-foot">
      <span style="flex:1 1 280px;min-width:0;font-size:12.5px;line-height:1.5;color:var(--fg-55)">${esc(TROV_GATE)}</span>
      <span data-trov-err class="cnpy-trov-err" role="status" style="font-size:12.5px;color:var(--red)"${ui.error ? "" : " hidden"}>${esc(ui.error ?? "")}</span>
      <button type="button" data-act="trovSetSave" class="cnpy-accentbtn cnpy-trov-save"${canSave ? "" : ' disabled aria-disabled="true"'} style="flex:none;padding:7px 16px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;${canSave ? "" : "opacity:.45;cursor:default"}">${label}</button>
    </div>
  </section>`;
}

/** The three tiles, or nothing outside an organization (the rows are per org). */
export function trovSettingsTiles(ui: TrovPrefsUi, orgSlug: string | null): string {
  if (!orgSlug) return "";
  // A read for another organization is never shown as this one's: until this org's arrives, the skeleton.
  const cur = ui.slug === orgSlug ? ui : { ...initialTrovPrefs(), slug: orgSlug };
  return `${instructionsTile(cur)}\n\n    ${modeTile(cur)}\n\n    ${seeTile(cur)}`;
}

