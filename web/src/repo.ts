// The Repo dashboard (Monitor › Repo) — ported from the Claude Design
// `Canopy Repo Dashboard.dc.html`. Purely presentational: props in, markup out,
// interactions via data-act / data-arg dispatched in main.ts.
//
// Five tabs, each ONE bordered panel divided by hairlines (the design's rule:
// lines, not cards), under an underline tab bar heading the page body
// (`repoTabBar`; they were sub-pages under the sidebar's Repo entry until
// 2026-09-27). Every block is a `RepoSection`, so each one renders four
// ways — live, `empty`, `not_connected` (nothing captured for it yet) and, while the
// fetch is out or failed, loading / error. The Worker decides which sections are
// live (`src/tools/repo.ts`); nothing here invents a number.
//
// Motion hooks (`cnpy-rise` + `--i`, `repo-bar`, `repo-spark`, `repo-fill`,
// `data-count`) are inert until main.ts flags a screen ENTER — so a rerender for
// an unrelated reason never replays them.

import {
  REPO_RANGES, REPO_TABS, REPO_TAB_SECTIONS,
  type RepoActivity, type RepoActivityKind, type RepoDashboard, type RepoPerson, type RepoPr, type RepoPrState,
  type RepoProductEnv, type RepoRange, type RepoSection, type RepoTab, type RepoTone, type RepoTrend, type RepoUsageEnv, type RepoUsageMetric,
  type PollOutcome, type RepoRefreshGithub, type RepoRefreshResult, type UsagePollSource,
} from "@shared/repo";
import type { Loadable } from "./render";
import { esc, attr, statusBadge, SURFACE } from "./ui";
import { personChip, personLink, personNameLink } from "./people";
import type { PersonSummary } from "./api";
import { segmented } from "./segmented";
import { tabBar, tabPanelAttrs } from "./tabs";

export interface RepoProps {
  tab: RepoTab;
  range: RepoRange;
  driftOpen: boolean;
  repo: Loadable<RepoDashboard | null>;
  fetchedAt: number | null;
  sample: boolean;
  /** The viewer is an admin — the only one offered "Poll now" (the Repo top bar, every tab). */
  admin: boolean;
  /** The last on-demand poll. Session-only; null = none / dismissed. */
  poll: RepoPollState | null;
  /** The environment the Usage tab's Product section shows. Session-only; null = the default. */
  productEnv: string | null;
  /** The persons directory — each mapped person's avatar (a RepoPerson carries none), and whose
   *  card a contributor's or an activity line's name opens. */
  persons?: PersonSummary[];
}

/** "Poll now" (POST /admin/poll): in flight, its per-source outcomes, a 409 (another refresh holds the lock), or a failed request. */
export type RepoPollState = { status: "polling" } | { status: "done"; result: RepoRefreshResult } | { status: "busy" } | { status: "error" };

// ── design tokens (verbatim from the .dc.html) ───────────────────────────────
const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const LABEL_SM = LABEL.replace("10.5px", "10px");
const FRAME = "max-width:1180px;margin:0 auto;padding:22px 32px 36px";
/** The dashboard's one panel: a surface card (`.cnpy-surface`) — its layout only here. */
const PANEL = "display:flex;flex-direction:column;overflow:hidden";
const CODE = "font-family:var(--label);font-size:12.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px";
const TOP = "border-top:1px solid var(--border)";
const LEFT = "border-left:1px solid var(--border)";

const TONE: Record<RepoTone, string> = { neutral: "var(--fg-55)", good: "var(--green)", warn: "var(--amber)", bad: "var(--red)" };
/** A status dot beside the ✓ / ✕ glyphs, drawn as an element rather than a "●" character
 *  so the corners layer shapes it like every other dot (canopy.css .repo-gdot). */
const GDOT = `<span class="repo-gdot" aria-hidden="true"></span>`;

/** Stagger index for the enter animation. */
const rise = (i: number, style = "", cls = ""): string => `class="cnpy-rise${cls ? ` ${cls}` : ""}" style="--i:${i};${style}"`;

// Defense-in-depth: a captured URL must be http(s) — never javascript:/data:.
const safeUrl = (u: string | null): string => (u && /^https?:\/\//i.test(u) ? u : "#");

/** Short age: "just now" is "0m" in a dense column, so floor at 1m. */
export function ago(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(1, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Polyline points for a sparkline in a 100×26 box (the design's `pts()`). */
export function sparkPoints(arr: number[], w = 100, h = 26, pad = 3): string {
  if (arr.length < 2) return "";
  const mn = Math.min(...arr), mx = Math.max(...arr), rg = (mx - mn) || 1;
  return arr.map((v, i) => `${((i / (arr.length - 1)) * w).toFixed(1)},${(h - pad - ((v - mn) / rg) * (h - 2 * pad)).toFixed(1)}`).join(" ");
}

// M11: `sparkPoints` returns "" for fewer than 2 points — a line needs two
// ends. Rendering the box anyway drew an empty sparkline; render nothing at
// all instead, same as the CI-failures block already does for `rate: null`.
const spark = (trend: number[], stroke: string, height: number, mt = 10): string =>
  trend.length < 2 ? "" :
  `<div class="repo-spark" style="margin-top:${mt}px"><svg viewBox="0 0 100 26" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block"><polyline points="${sparkPoints(trend)}" fill="none" stroke="${stroke}" stroke-width="1.6" vector-effect="non-scaling-stroke"></polyline></svg></div>`;

/** "▲ 2" / "▼ 3" / "—" — the design's week-over-week delta. */
const delta = (n: number): string => (n > 0 ? `▲ ${n}` : n < 0 ? `▼ ${Math.abs(n)}` : "—");

const avatar = (p: RepoPerson, size: number, persons: PersonSummary[] = []): string => {
  const h = p.handle?.toLowerCase();
  const avatar_url = h ? persons.find((x) => x.handle.toLowerCase() === h)?.avatar_url ?? null : null;
  return personChip(p.handle && p.color ? { handle: p.handle, name: p.name, color: p.color, avatar_url } : null, size, p.login);
};
const who = (p: RepoPerson): string => p.handle ?? p.login;
/** The directory's person behind a captured one — whose card a name opens; null (plain) for a
 *  login no one holds (a bot, an outside contributor) and for sample data, which is no one. */
const linkedPerson = (x: RepoPerson, p: Pick<RepoProps, "persons" | "sample">): PersonSummary | null => {
  const h = x.handle?.toLowerCase();
  return h && !p.sample ? (p.persons ?? []).find((y) => y.handle.toLowerCase() === h) ?? null : null;
};

// ── section states ───────────────────────────────────────────────────────────
type Phase = "loading" | "error" | "ready";
const phaseOf = (p: RepoProps): Phase =>
  p.repo.data ? "ready" : p.repo.status === "error" ? "error" : "loading";

const skeleton = (lines = 3): string => {
  const widths = [68, 92, 54, 80, 61];
  return `<div style="display:flex;flex-direction:column;gap:10px;justify-content:center;padding:12px 0">${Array.from({ length: lines }, (_, i) =>
    `<div class="repo-shimmer" style="height:12px;border-radius:6px;background:var(--hover);width:${widths[i % widths.length]}%;animation-delay:${(i * 0.2).toFixed(1)}s"></div>`).join("")}</div>`;
};

const emptyBlock = (sub: string): string =>
  `<div style="display:flex;align-items:center;justify-content:center;padding:14px 0"><div style="border:1px dashed var(--border-strong);border-radius:11px;padding:18px 24px;text-align:center;width:100%">
    <div style="font-size:13.5px;font-weight:500;color:var(--fg-70)">Nothing here yet</div>
    <div style="font-size:12.5px;color:var(--fg-40);margin-top:4px">${esc(sub)}</div>
  </div></div>`;

const errorBlock = (): string =>
  `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;padding:14px 0">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="1.8"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>
    <div><div style="font-size:13.5px;font-weight:500;color:var(--fg-70)">Couldn't load this section</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:3px">The dashboard request failed.</div></div>
    <button data-act="repoRefresh" class="cnpy-outlinebtn" style="padding:6px 14px;border-radius:8px;border:1px solid var(--border-strong);font-size:12.5px;font-weight:500;color:var(--fg-70)">Retry now</button>
  </div>`;

/** The design's "Source not connected" block. No button: there is no connect flow
 *  to start. Every section HAS a capture path now, so the copy names what that
 *  path is still waiting on, in the owner's terms — a setting or secret by NAME
 *  (never a value), a webhook event, the repo's CI, or Sync GitHub. */
const notConnected = (what: string): string =>
  `<div style="display:flex;align-items:center;justify-content:center;padding:14px 0;flex:1"><div style="border:1px dashed color-mix(in srgb,var(--accent) 45%,transparent);border-radius:11px;padding:18px 24px;text-align:center;width:100%;background:color-mix(in srgb,var(--accent) 4%,transparent)">
    <div style="font-size:13.5px;font-weight:600">Source not connected</div>
    <div style="font-size:12.5px;color:var(--fg-55);margin-top:4px;line-height:1.55">${esc(what)}</div>
  </div></div>`;

/** `nc` is given only by a section the Worker can actually send as
 *  `not_connected`; one it only ever sends as ok / empty (`bars`) has no such
 *  sentence to keep true, and falls back to the generic line below. */
interface SectionCopy { nc?: string; empty: string; lines?: number }
const NC_GENERIC = "Nothing has been captured for this section yet.";

/** Render one section in whichever of its states applies. */
function sec<T>(p: RepoProps, pick: (d: RepoDashboard) => RepoSection<T>, copy: SectionCopy, live: (data: T) => string): string {
  const phase = phaseOf(p);
  if (phase === "loading") return skeleton(copy.lines);
  if (phase === "error" || !p.repo.data) return errorBlock();
  const s = pick(p.repo.data);
  if (s.status === "not_connected") return notConnected(copy.nc ?? NC_GENERIC);
  if (s.status === "empty") return emptyBlock(copy.empty);
  return live(s.data);
}

/** True when a section has live data — for chrome that only makes sense beside it. */
function okData<T>(p: RepoProps, pick: (d: RepoDashboard) => RepoSection<T>): T | null {
  const s = p.repo.data ? pick(p.repo.data) : null;
  return s && s.status === "ok" ? s.data : null;
}

// ── header chrome ────────────────────────────────────────────────────────────
/** The repo the dashboard reads, beside the title. The tab in view is named by the page's
 *  own tab bar, so the crumb no longer repeats it; nothing is drawn until the slug is known. */
export function repoCrumb(p: RepoProps): string {
  const slug = p.repo.data?.repo ?? "";
  return slug
    ? `<span style="font-family:var(--label);font-size:11px;color:var(--fg-40);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(slug)}</span>`
    : "";
}

/** "updated just now" / "updated 4m ago" — main.ts re-ticks this node in place. */
export function repoUpdatedLabel(p: Pick<RepoProps, "repo" | "fetchedAt">, now: number = Date.now()): string {
  if (p.repo.status === "loading") return p.repo.data ? "refreshing…" : "loading…";
  if (p.fetchedAt === null) return "";
  const mins = Math.max(0, Math.round((now - p.fetchedAt) / 60000));
  return mins < 1 ? "updated just now" : `updated ${mins}m ago`;
}

export function repoControls(p: RepoProps): string {
  const envs = okData(p, (d) => d.environments) ?? [];
  const pills = envs.map((e) => {
    const c = TONE[e.tone];
    return `<span title="${attr(`${e.name} — ${e.pill.toLowerCase()}`)}" style="display:inline-flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap;color:var(--fg-70)"><span class="repo-envdot${e.tone === "good" || e.tone === "neutral" ? "" : " repo-pulse"}" style="--c:${c};width:7px;height:7px;border-radius:50%;background:${c};box-shadow:0 0 0 3px color-mix(in srgb,${c} 16%,transparent)"></span>${esc(e.name)}</span>`;
  }).join("");
  const busy = p.repo.status === "loading";
  // "Poll now" sits beside the refresh icon on EVERY tab and in every state of
  // the dashboard (loading, failed, degraded, all not_connected) — it depends on
  // nothing but who is looking. Admins only, never in sample mode; for everyone
  // else this bar is byte-for-byte what it was (pinned by a test), which is why
  // the refresh icon takes its longer title only when there are two controls to
  // tell apart. When the BAR is too narrow for crumb + labelled controls (a
  // container query in canopy.css, `.repo-pollbtn` — the room depends on the
  // rail, not only the viewport) the label is hidden and the button is the
  // icon's size; narrower still, the "updated …" text gives up its room, so at
  // phone width an admin's controls are narrower than a non-admin's.
  const canPoll = canPollRepo(p);
  const polling = p.poll?.status === "polling";
  const pollBtn = canPoll
    ? `<button data-act="repoPollNow" title="${polling ? "Polling…" : POLL_TITLE}" aria-label="${polling ? "Polling…" : POLL_TITLE}" class="cnpy-outlinebtn repo-pollbtn"${polling ? ' disabled aria-busy="true"' : ""} style="height:32px;padding:0 12px;border-radius:8px;border:1px solid var(--border);display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:500;white-space:nowrap;color:var(--fg-55);${polling ? "opacity:.6;cursor:default;pointer-events:none" : ""}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none${polling ? ";animation:cnpy-spin .8s linear infinite" : ""}">${polling ? `<path d="M21 12a9 9 0 1 1-9-9"></path>` : `<path d="M3 12h4l3-8 4 16 3-8h4"></path>`}</svg><span class="repo-pollbtn-label">${polling ? "Polling…" : "Poll now"}</span>
    </button>`
    : "";
  return `${pills}${pills ? `<div style="width:1px;height:20px;background:var(--border);margin:0 2px"></div>` : ""}
    <span data-repo-updated style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(repoUpdatedLabel(p))}</span>${pollBtn}
    <button data-act="repoRefresh" title="${canPoll ? REFRESH_TITLE : "Refresh"}" class="cnpy-iconbtn" style="width:32px;height:32px;border-radius:8px;border:1px solid var(--border);display:grid;place-items:center;color:var(--fg-55)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"${busy ? ' style="animation:cnpy-spin .8s linear infinite"' : ""}><path d="M21 12a9 9 0 1 1-3-6.7L21 8"></path><path d="M21 3v5h-5"></path></svg>
    </button>`;
}

// ── Overview ─────────────────────────────────────────────────────────────────
const kv = (k: string, v: string): string =>
  `<div style="display:grid;grid-template-columns:96px 1fr;gap:12px;padding:11px 0;${TOP}"><div style="${LABEL_SM};padding-top:2px">${k}</div>${v}</div>`;

function overviewTab(p: RepoProps): string {
  const now = Date.now();
  const envs = sec(p, (d) => d.environments, { nc: "Nothing captured for a configured environment yet. Cards appear once REPO_ENVIRONMENTS lists an environment and a health ping, a deploy or a head check lands for it — from the 10-minute cron, the GitHub webhook, or an admin's Sync GitHub.", empty: "No environments recorded." }, (rows) =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))">${rows.map((e, i) => {
      const c = TONE[e.tone];
      return `<div style="padding:20px 22px 10px;min-width:0;${i ? LEFT : ""}">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">
          <span style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;flex:1">${esc(e.name)}${e.note ? ` <span style="font-size:11.5px;font-weight:500;color:var(--fg-40)">${esc(e.note)}</span>` : ""}</span>
          ${statusBadge(e.pill, c)}
        </div>
        ${e.parts.map((pt) => kv(pt.part === "backend" ? "Backend" : "Frontend",
          pt.sha
            ? `<div style="font-size:13.5px;line-height:1.6;color:var(--fg-70);display:flex;align-items:center;gap:9px;flex-wrap:wrap"><span style="${CODE}">${esc(pt.sha)}</span><span style="font-size:12px;color:var(--fg-40);white-space:nowrap">${esc(ago(pt.deployedAt ?? "", now))} ago · by ${esc(pt.deployedBy ?? "unknown")} · ${esc(pt.host)}</span>${pt.result === "fail" ? `<span style="font-family:var(--label);font-size:10px;font-weight:600;color:var(--red)">FAILED</span>` : ""}</div>`
            : `<div style="font-size:12.5px;color:var(--fg-40)">No ${esc(pt.host)} deploy captured yet</div>`)).join("")}
        ${kv("CI on head", `<div style="font-size:13.5px;line-height:1.6;display:flex;align-items:center;gap:7px;color:${TONE[e.ciTone]}"><span style="font-family:var(--label);font-size:13px">${e.ciTone === "good" ? "✓" : e.ciTone === "bad" ? "✕" : GDOT}</span>${esc(e.ci)}</div>`)}
        ${kv("URL", `<div style="font-size:13.5px;line-height:1.6"><a href="${attr(safeUrl(e.url))}" target="_blank" rel="noopener" class="repo-link" style="font-family:var(--label);font-size:12.5px">${esc(e.url.replace(/^https?:\/\//, ""))} ↗</a></div>`)}
      </div>`;
    }).join("")}</div>`);

  // The drift strip only means something beside the two environments it compares.
  const drift = okData(p, (d) => d.drift);
  const driftStrip = drift ? `<button data-act="repoToggleDrift" aria-expanded="${p.driftOpen}" class="repo-strip" style="width:100%;display:flex;align-items:center;justify-content:center;gap:10px;padding:12px 22px;${TOP};font-size:13px;color:var(--fg-70)">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" style="flex:none"><path d="M6 3v12"></path><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>
      <span>${esc(drift.head)} is <span style="font-family:var(--label);font-weight:600;color:var(--fg)">${drift.ahead}</span> commits ahead, <span style="font-family:var(--label);font-weight:600;color:var(--fg)">${drift.behind}</span> behind ${esc(drift.base)}</span>
      <svg class="repo-chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2.4" style="flex:none;transform:rotate(${p.driftOpen ? 90 : 0}deg)"><path d="M9 6l6 6-6 6"></path></svg>
    </button>
    <div class="repo-drift" data-open="${p.driftOpen ? "1" : "0"}"><div style="overflow:hidden;min-height:0">${drift.groups.map((g) => {
      const c = g.kind === "pr" ? "var(--accent)" : g.kind === "behind" ? "var(--red)" : "var(--fg-55)";
      return `<div>
        <div style="display:flex;align-items:center;gap:9px;padding:10px 22px;${TOP};background:color-mix(in srgb,var(--fg) 2%,transparent)">
          <span style="font-family:var(--label);font-size:11px;font-weight:600;color:${c};background:color-mix(in srgb,${c} 12%,transparent);border-radius:5px;padding:1px 7px;flex:none">${esc(g.tag)}</span>
          <span style="font-size:13px;font-weight:500;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(g.title)}</span>
          <span style="font-size:11.5px;color:var(--fg-40);flex:none;margin-left:auto;white-space:nowrap">${esc(g.meta)}</span>
        </div>
        ${g.commits.map((cm) => `<div style="display:grid;grid-template-columns:84px minmax(0,1fr) 64px;gap:10px;align-items:center;padding:7px 22px 7px 30px;${TOP}">
          <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55)">${esc(cm.sha)}</span>
          <span style="font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(cm.msg)}</span>
          <span style="font-size:11px;color:var(--fg-40);text-align:right">${esc(ago(cm.at, now))}</span>
        </div>`).join("")}
      </div>`;
    }).join("")}</div></div>` : "";

  const stats = sec(p, (d) => d.stats, { nc: "Repo stats aren't connected.", empty: "No data recorded for this window.", lines: 2 }, (rows) =>
    `<div class="repo-tiles" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr))">${rows.map((s, i) => `<div style="padding:16px 22px;${i ? LEFT : ""}">
      <div style="${LABEL}">${esc(s.label)}</div>
      <div style="display:flex;align-items:baseline;gap:10px;margin-top:8px;flex-wrap:wrap">
        <span data-count="${s.value}" style="font-family:var(--label);font-size:27px;font-weight:600;letter-spacing:-0.02em">${s.value}</span>
        <span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:${TONE[s.tone]}">${delta(s.delta)}</span>
        <span style="font-size:11px;color:var(--fg-40)">vs last week</span>
      </div>
    </div>`).join("")}</div>`);

  // Three states, decided server-side (src/tools/repo.ts): `not_connected` =
  // nothing has ever pinged these URLs; `empty` = the pings exist but every
  // reading has aged out (the 10-minute cron has stopped) — which must NOT read
  // as "never set up".
  const health = sec(p, (d) => d.health, { nc: "No health ping has landed yet. The repo cron pings each environment in REPO_ENVIRONMENTS every 10 minutes, so this fills in after its first tick.", empty: "No fresh health reading — the last ping is over 30 minutes old.", lines: 2 }, (rows) =>
    rows.map((h) => {
      const c = h.up ? "var(--green)" : "var(--red)";
      return `<div class="repo-hrow" style="display:grid;grid-template-columns:84px minmax(0,1fr) 110px 90px;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:12.5px;font-weight:600;color:var(--fg-70)">${esc(h.env)}</span>
        <a href="${attr(safeUrl(h.url))}" target="_blank" rel="noopener" class="repo-link" style="font-family:var(--label);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg-55)">${esc(h.url.replace(/^https?:\/\//, ""))}</a>
        <span style="display:inline-flex;align-items:center;gap:7px;font-family:var(--label);font-size:11px;font-weight:600;color:${c}"><span style="width:7px;height:7px;border-radius:50%;background:${c}"></span>${h.up ? "UP" : "DOWN"}</span>
        <span style="font-family:var(--label);font-size:12px;color:var(--fg-55);text-align:right">${h.ms} ms</span>
      </div>`;
    }).join(""));

  const envsLive = okData(p, (d) => d.environments) !== null;
  return `<div ${rise(0)}>${envsLive ? envs : `<div style="padding:6px 22px">${envs}</div>`}</div>
    ${driftStrip ? `<div ${rise(1)}>${driftStrip}</div>` : ""}
    <div ${rise(2, `${TOP}`)}>${okData(p, (d) => d.stats) ? stats : `<div style="padding:6px 22px">${stats}</div>`}</div>
    <div ${rise(3, `${TOP};padding:16px 22px 14px;flex:1`)}>
      <div style="${LABEL};margin-bottom:4px">Health checks</div>
      ${health}
    </div>`;
}

// ── Code ─────────────────────────────────────────────────────────────────────
const M_CHIP = "font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;border-radius:5px;padding:2px 7px;white-space:nowrap;color:var(--fg-40);border:1px solid var(--border);background:transparent";
const PR_STATE: Record<RepoPrState, [string, string | null]> = {
  draft: ["DRAFT", null], review: ["IN REVIEW", "var(--blue)"], approved: ["APPROVED", "var(--green)"],
  merged: ["MERGED", "var(--accent)"], closed: ["CLOSED", null],
};
const CHECKS = { pass: ["✓", "var(--green)", "all checks passing"], fail: ["✕", "var(--red)", "checks failing"], run: [GDOT, "var(--amber)", "checks running"] } as const;

function prRow(pr: RepoPr, now: number, persons: PersonSummary[] = []): string {
  const [text, color] = PR_STATE[pr.state];
  const chip = color ? statusBadge(text, color) : `<span style="${M_CHIP}">${text}</span>`;
  const ck = pr.checks ? CHECKS[pr.checks] : null;
  return `<a href="${attr(safeUrl(pr.url))}" target="_blank" rel="noopener" class="repo-row" style="display:flex;align-items:center;gap:12px;padding:8px 20px;border-bottom:1px solid var(--border);color:inherit;text-decoration:none">
    <span title="${attr(who(pr.author))}" style="flex:none">${avatar(pr.author, 22, persons)}</span>
    <span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:500">${esc(pr.title)} <span style="font-family:var(--label);font-size:11px;font-weight:400;color:var(--fg-40)">#${pr.number}${pr.branch ? ` · ${esc(pr.branch)}` : ""}</span></span>
    <span style="flex:none">${chip}</span>
    <span title="${ck ? ck[2] : ""}" style="width:16px;text-align:center;flex:none;font-family:var(--label);font-size:12px;font-weight:600;color:${ck ? ck[1] : "transparent"}">${ck ? ck[0] : ""}</span>
    <span style="width:38px;text-align:right;flex:none;font-size:11.5px;color:var(--fg-40)">${esc(ago(pr.at, now))}</span>
  </a>`;
}

function codeTab(p: RepoProps): string {
  const now = Date.now();
  const tiles = sec(p, (d) => d.codeStats, { nc: "Repo stats aren't connected.", empty: "No data recorded for this window.", lines: 2 }, (rows) =>
    `<div class="repo-tiles" style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr))">${rows.map((s, i) => `<div style="padding:14px 20px 12px;${i ? LEFT : ""}">
      <div style="${LABEL}">${esc(s.label)}</div>
      <div style="display:flex;align-items:baseline;gap:9px;margin-top:6px;flex-wrap:wrap">
        <span data-count="${s.value}" style="font-family:var(--label);font-size:24px;font-weight:600;letter-spacing:-0.02em">${s.value}</span>
        <span style="font-size:11px;color:${s.tone === "neutral" ? "var(--fg-40)" : TONE[s.tone]};white-space:nowrap">${esc(s.sub)}</span>
      </div>
    </div>`).join("")}</div>`);

  const barsData = okData(p, (d) => d.bars);
  const bars = sec(p, (d) => d.bars, { empty: "No commits or merges in the last 14 days.", lines: 2 }, (b) => {
    const max = Math.max(1, ...b.days.map((d) => d.count));
    const w = 100 / b.days.length;
    const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    const mid = b.days[Math.floor((b.days.length - 1) / 2)];
    return `<svg viewBox="0 0 100 28" preserveAspectRatio="none" style="width:100%;height:74px;margin-top:10px;display:block">${b.days.map((d, i) => {
      const h = (d.count / max) * 25;
      return `<rect class="repo-bar" style="--i:${i}" x="${(i * w + 0.8).toFixed(2)}" y="${(27 - h).toFixed(2)}" width="${(w - 1.6).toFixed(2)}" height="${h.toFixed(2)}" fill="var(--accent)" opacity="0.85"><title>${esc(fmt(d.date))} — ${d.count}</title></rect>`;
    }).join("")}</svg>
    <div style="display:flex;justify-content:space-between;margin-top:6px;font-family:var(--label);font-size:10px;color:var(--fg-40)"><span>${esc(fmt(b.days[0].date))}</span><span>${esc(fmt(mid.date))}</span><span>${esc(fmt(b.days[b.days.length - 1].date))}</span></div>`;
  });

  const prList = okData(p, (d) => d.prs);
  const prsLive = prList !== null;
  // The header names what's actually shown, not the sample flag — a captured list can include OPEN PRs.
  const prsOpen = prList ? prList.rows.some((r) => r.state !== "merged" && r.state !== "closed") : false;
  // `ok` with no rows happens once open PRs are captured (`openCount` known)
  // but nothing was touched in 90 days — say that, not "not captured".
  const prs = sec(p, (d) => d.prs, { nc: "Pull requests aren't connected.", empty: "No pull requests captured yet.", lines: 4 }, (l) =>
    l.rows.length ? l.rows.map((r) => prRow(r, now, p.persons)).join("") : `<div style="padding:6px 20px">${emptyBlock("No pull requests updated in the last 90 days.")}</div>`);

  const br = okData(p, (d) => d.branches);
  const branches = sec(p, (d) => d.branches, { nc: "No branch snapshot yet. One is taken when an admin runs Sync GitHub and by the 6-hourly GitHub reconcile — both need GITHUB_SERVICE_TOKEN.", empty: "No branches recorded." }, (b) =>
    b.rows.map((r) => `<div class="repo-brow" style="display:grid;grid-template-columns:minmax(0,1.4fr) 90px 130px 54px;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="font-family:var(--label);font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span>
      <span style="font-size:11.5px;color:var(--fg-40);white-space:nowrap">${esc(ago(r.at, now))} ago</span>
      <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55);white-space:nowrap">+${r.ahead} / −${r.behind}${b.head ? ` vs ${esc(b.head)}` : ""}</span>
      <span style="text-align:right">${r.stale ? `<span style="font-family:var(--label);font-size:9.5px;font-weight:600;letter-spacing:.04em;color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 45%,transparent);background:color-mix(in srgb,var(--amber) 12%,transparent);border-radius:5px;padding:1px 5px;flex:none">STALE</span>` : ""}</span>
    </div>`).join(""));

  return `<div ${rise(0)}>${okData(p, (d) => d.codeStats) ? tiles : `<div style="padding:6px 20px">${tiles}</div>`}</div>
    <div ${rise(1, `${TOP};padding:14px 20px 12px`)}>
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px"><span style="${LABEL}">${esc(barsData?.title ?? "Activity — last 14 days")}</span><span style="font-size:11px;color:var(--fg-40);white-space:nowrap">${esc(barsData?.note ?? "")}</span></div>
      ${bars}
    </div>
    <div ${rise(2, `display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:13px 20px;${TOP};border-bottom:1px solid var(--border)`)}>
      <span style="${LABEL}">Pull requests — ${prsOpen ? "open &amp; recent" : "recently closed"}</span>
      <span style="font-size:11px;color:var(--fg-40);white-space:nowrap">sorted by last updated</span>
    </div>
    <div ${rise(3)}>${prsLive ? prs : `<div style="padding:6px 20px;border-bottom:1px solid var(--border)">${prs}</div>`}</div>
    <div ${rise(4, `padding:14px 20px 10px;flex:1;display:flex;flex-direction:column`)}>
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:4px"><span style="${LABEL}">Branches</span><span style="font-size:11px;color:var(--fg-40)">${br ? `${br.active} active · ${br.stale} stale` : ""}</span></div>
      ${branches}
    </div>`;
}

// ── CI & Deploys ─────────────────────────────────────────────────────────────
const ACTIVITY_ICON: Record<RepoActivityKind, [string, string]> = {
  push: ["M12 19V5M5 12l7-7 7 7", "var(--fg-55)"], merge: ["M20 6 9 17l-5-5", "var(--green)"],
  deploy: ["M13 2 3 14h9l-1 8 10-12h-9l1-8", "var(--accent)"], issue: ["M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18", "var(--amber)"],
  close: ["M20 6 9 17l-5-5", "var(--fg-55)"], release: ["M12 3l8 9-8 9-8-9z", "var(--blue)"],
  review: ["M4 12c2.7-4.7 13.3-4.7 16 0-2.7 4.7-13.3 4.7-16 0z", "var(--fg-55)"],
};

function activityRow(a: RepoActivity, now: number, p: Pick<RepoProps, "persons" | "sample">): string {
  const [d, c] = ACTIVITY_ICON[a.kind];
  const line = "font-size:12.5px;color:var(--fg-70);min-width:0;flex:1;line-height:1.5";
  const actor = a.actor ? linkedPerson(a.actor, p) : null;
  const link = a.url && safeUrl(a.url) !== "#" ? safeUrl(a.url) : null;
  // A known actor's name opens their person card, so it sits BESIDE the event's link, never in it.
  const body = actor && a.actor
    ? `<span style="${line}">${personNameLink(actor, who(a.actor))} ${link ? `<a href="${attr(link)}" target="_blank" rel="noopener" class="repo-quiet" style="text-decoration:none">${esc(a.text)}</a>` : esc(a.text)}</span>`
    : link
      ? `<a href="${attr(link)}" target="_blank" rel="noopener" class="repo-quiet" style="${line};text-decoration:none">${a.actor ? `${esc(who(a.actor))} ` : ""}${esc(a.text)}</a>`
      : `<span style="${line}">${a.actor ? `${esc(who(a.actor))} ` : ""}${esc(a.text)}</span>`;
  return `<div style="display:flex;align-items:flex-start;gap:10px;padding:8px 4px;${TOP}">
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2" style="flex:none;margin-top:3px"><path d="${d}"></path></svg>
    ${body}
    <span style="font-size:11px;color:var(--fg-40);flex:none">${esc(ago(a.at, now))}</span>
  </div>`;
}

// `t.delta` is "" once the window can't support a trend claim (see
// `windowDelta` in src/tools/repo.ts) — render the note alone then, with no
// delta span and no stray leading space.
const trendBlock = (title: string, t: RepoTrend, stroke: string): string =>
  `<div style="display:flex;align-items:baseline;justify-content:space-between"><span style="${LABEL}">${title}</span><span style="font-family:var(--label);font-size:16px;font-weight:600;white-space:nowrap">${esc(t.value)}</span></div>
  ${spark(t.trend, stroke, 44)}
  <div style="font-size:11.5px;color:var(--fg-40);margin-top:6px">${t.delta ? `<span style="font-family:var(--label);color:${TONE[t.tone]}">${esc(t.delta)}</span> ` : ""}${esc(t.note)}</div>`;
const titled = (title: string, body: string): string => `<div style="${LABEL}">${title}</div>${body}`;

function ciTab(p: RepoProps): string {
  const now = Date.now();
  const RESULT = { ok: ["var(--green)", "DEPLOYED"], fail: ["var(--red)", "FAILED"], cancel: ["var(--amber)", "CANCELLED"] } as const;
  const deploys = sec(p, (d) => d.deploys, { nc: "No deploy captured for a configured environment yet. Deploys arrive when the GitHub webhook delivers deployment_status and check_run events, or when an admin runs Sync GitHub; environments come from REPO_ENVIRONMENTS.", empty: "No deploys recorded.", lines: 2 }, (rows) =>
    rows.map((row) => {
      const okCount = row.deploys.filter((d) => d.result === "ok").length;
      const last = row.deploys[row.deploys.length - 1];
      return `<div style="display:flex;align-items:center;gap:16px;padding:14px 0;${TOP};flex-wrap:wrap">
        <span style="width:118px;font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--fg-70);flex:none">${esc(row.label)}</span>
        <div style="display:flex;align-items:center;gap:9px">${row.deploys.map((d, i) => {
          const [color, word] = RESULT[d.result];
          // Pure CSS tooltip (hover + keyboard focus): no state, so no rerender on every dot.
          return `<span class="repo-dotwrap" style="position:relative;display:inline-block">
            <button class="repo-dot" style="--i:${i};width:15px;height:15px;border-radius:50%;background:${color};display:block;padding:0" aria-label="${attr(`${d.sha} ${word.toLowerCase()} ${ago(d.at, now)} ago by ${d.by}`)}"></button>
            <span class="repo-tip" role="tooltip">
              <span style="display:block;font-family:var(--label);font-size:11.5px;font-weight:600">${esc(d.sha)}</span>
              <span style="display:block;font-size:11.5px;color:var(--fg-55);margin-top:2px">${esc(ago(d.at, now))} ago · by ${esc(d.by)}</span>
              <span style="display:block;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;margin-top:4px;color:${color}">${word}</span>
            </span>
          </span>`;
        }).join("")}</div>
        <span style="margin-left:auto;font-size:11.5px;color:var(--fg-40)">${last ? `last ${esc(ago(last.at, now))} ago · ` : ""}${okCount} of ${row.deploys.length} succeeded</span>
      </div>`;
    }).join(""));

  const fails = okData(p, (d) => d.ciFailures);
  // `rate === null` = run capture has not been recording for a whole week yet
  // (src/tools/repo.ts). The percentage and the sparkline both describe seven
  // days, so neither is drawn — a quiet line says why instead. The failure rows
  // themselves are facts and are always listed.
  const failures = sec(p, (d) => d.ciFailures, { nc: "No workflow run captured yet. Runs arrive when the GitHub webhook delivers workflow_run events, or when an admin runs Sync GitHub.", empty: "No CI failures this week." }, (f) =>
    `${f.rate === null
        ? `<div style="margin-top:8px;font-size:12.5px;color:var(--fg-40)">A 7-day rate appears after a week of captured runs.</div>`
        : spark(f.trend, "var(--amber)", 40)}
    ${f.total ? "" : `<div style="margin-top:10px;font-size:12.5px;color:var(--fg-55)">No CI failures this week.</div>`}
    <div style="margin-top:10px">${f.rows.map((r) => `<div style="display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr) minmax(0,1fr) 82px;gap:10px;align-items:center;padding:10px 4px;${TOP}">
      <span style="display:inline-flex;align-items:center;gap:7px;min-width:0"><span style="font-family:var(--label);font-size:12px;font-weight:600;color:var(--red);flex:none">✕</span><span style="font-family:var(--label);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.workflow)}</span></span>
      <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.branch)}</span>
      <span style="font-size:12px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.job)}</span>
      <span style="text-align:right;white-space:nowrap"><span style="font-size:11px;color:var(--fg-40)">${esc(ago(r.at, now))} · </span><a href="${attr(safeUrl(r.url))}" target="_blank" rel="noopener" class="repo-link" style="font-size:11.5px">Logs ↗</a></span>
    </div>`).join("")}</div>
    ${f.total > f.rows.length ? `<div style="margin-top:8px;font-size:12px;color:var(--fg-40)">Latest ${f.rows.length} of ${f.total} failures this week.</div>` : ""}`);

  // I2: `empty` now means "a reading has landed before, just not in the
  // window" (src/tools/repo.ts checks `latestMetric` on the empty path) — the
  // copy says so, rather than implying nothing has ever been reported.
  const cov = okData(p, (d) => d.coverage);
  const coverage = sec(p, (d) => d.coverage, { nc: "No coverage reported yet. It appears once the repo's CI posts a canopy/coverage commit status on a push to the default environment branch; it is read from a status webhook event, the 6-hourly GitHub reconcile, or Poll now.", empty: "No coverage reported in the last 30 days.", lines: 2 }, (t) => trendBlock("Test coverage", t, "var(--green)"));
  const bun = okData(p, (d) => d.bundle);
  const bundle = sec(p, (d) => d.bundle, { nc: "No bundle size reported yet. It appears once the repo's CI posts a canopy/bundle-kb commit status on a push to the default environment branch; it is read from a status webhook event, the 6-hourly GitHub reconcile, or Poll now.", empty: "No bundle size reported in the last 30 days.", lines: 2 }, (t) => trendBlock("Bundle size — web", t, "var(--fg-55)"));

  const activity = sec(p, (d) => d.activity, { nc: "The activity feed isn't connected.", empty: "No repo events captured yet.", lines: 4 }, (rows) =>
    `<div class="cnpy-scroll" style="max-height:236px;overflow-y:auto">${rows.map((a) => activityRow(a, now, p)).join("")}</div>`);
  const count = okData(p, (d) => d.activity)?.length ?? 0;

  return `<div ${rise(0, `padding:18px 20px 4px`)}>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="${LABEL}">Deploy history — last 10</span>
        <span style="display:${okData(p, (d) => d.deploys) ? "inline-flex" : "none"};gap:14px;font-size:10.5px;font-family:var(--label);color:var(--fg-40)">${(["ok", "fail", "cancel"] as const).map((k) => `<span style="display:inline-flex;align-items:center;gap:5px"><span style="width:8px;height:8px;border-radius:50%;background:${RESULT[k][0]}"></span>${RESULT[k][1].toLowerCase()}</span>`).join("")}</span>
      </div>
      ${deploys}
    </div>
    <div ${rise(1, `display:grid;grid-template-columns:minmax(0,1.35fr) minmax(280px,1fr);${TOP};flex:1`, "repo-split")}>
      <div style="padding:18px 20px;min-width:0;display:flex;flex-direction:column">
        <div style="display:flex;align-items:baseline;justify-content:space-between"><span style="${LABEL}">CI failures — 7-day rate</span>${fails && fails.rate !== null ? `<span style="font-family:var(--label);font-size:16px;font-weight:600;white-space:nowrap;color:var(--amber)">${fails.rate.toFixed(1)}%</span>` : ""}</div>
        ${failures}
      </div>
      <div style="${LEFT};min-width:0;display:flex;flex-direction:column" class="repo-split-r">
        <div style="padding:18px 20px">${cov ? coverage : titled("Test coverage", coverage)}</div>
        <div style="padding:18px 20px;${TOP};flex:1">${bun ? bundle : titled("Bundle size — web", bundle)}</div>
      </div>
    </div>
    <div ${rise(2, `${TOP};padding:14px 20px 10px`)}>
      <div style="${LABEL};margin-bottom:6px">Activity — last ${count || 20} events</div>
      ${activity}
    </div>`;
}

// ── Usage ────────────────────────────────────────────────────────────────────
// A `null` metric keeps its label row (so the block never collapses or shifts
// its neighbours) and shows a quiet line where the value would be — no
// sparkline element, no empty-state box. WHICH line is the Worker's `seen`
// flag: a source that has reported inside the 30-day read is CONNECTED, so its
// null reads "no recent reading" (no point in this range, a poll that stopped,
// a gauge gone stale); only a source that never reported reads "not
// connected". `spark()` already renders nothing under 2 trend points, so a
// connected-but-thin metric just shows its value with no line. `errorRate` is
// derived from the requests series, so it follows `seen.requests` — except
// while `requests` is live and the range simply holds no request to take a
// rate of (src/tools/repo.ts): that reads a quiet "—" in the same muted slot.
const absentLabel = (seen: boolean): string => (seen ? "no recent reading" : "not connected");
function usageEnv(e: RepoUsageEnv, i: number): string {
  const metric = (label: string, m: RepoUsageMetric | null, stroke: string, valueColor: string, absent: string): string =>
    `<div style="${TOP};padding:12px 0">
      <div style="display:flex;align-items:baseline;justify-content:space-between"><span style="${LABEL_SM}">${label}</span>${
        m
          ? `<span style="font-family:var(--label);font-size:17px;font-weight:600;white-space:nowrap;${valueColor ? `color:${valueColor}` : ""}">${esc(m.value)}</span>`
          : `<span style="font-size:11.5px;color:var(--fg-40)">${absent}</span>`
      }</div>
      ${m ? spark(m.trend, stroke, 40, 8) : ""}
    </div>`;
  const errC = e.errorRate ? TONE[e.errorRate.tone === "neutral" ? "good" : e.errorRate.tone] : "";
  return `<div style="padding:18px 20px 4px;min-width:0;${i ? LEFT : ""}">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px"><span style="font-size:15px;font-weight:600;flex:1">${esc(e.name)}</span><span style="font-family:var(--label);font-size:10px;color:var(--fg-40)">${esc(e.host)}</span></div>
    ${metric("Requests", e.requests, "var(--accent)", "", absentLabel(e.seen.requests))}
    ${metric("Error rate", e.errorRate, errC, errC, e.requests ? "—" : absentLabel(e.seen.requests))}
    ${metric("Active users", e.users, "var(--blue)", "", absentLabel(e.seen.users))}
  </div>`;
}

// ── Usage › Product ──────────────────────────────────────────────────────────
// What the app reports about itself (src/repo/poll.ts → `sap_*` gauges), as ONE
// section with an environment switch and three levels, so the eye has an order
// to read in instead of twelve identical tables:
//   1. a "Right now" stat strip (`totals` — point-in-time, they ignore the range)
//      and up to four headline tiles in the Overview's KPI style;
//   2. one block per group, each in the shape its data has — Learning a ranked
//      bar list, AI spend one feature figure, Reliability a status list whose
//      zeros fold into a line, Growth / Community stat pairs;
//   3. footnotes, and any key this file has never heard of as quiet rows under
//      "Other" — nothing here depends on a key existing.
// Nothing is derived: every figure is the DTO's own string; a `null` reads "no
// recent reading" (and draws no stale trend); an absent key is absent. Labels,
// notes, titles and environment names originate in ANOTHER service — every one
// goes through `esc()` / `attr()`.
const NUM = "font-family:var(--label);font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap";
const QUIET = "font-size:11.5px;color:var(--fg-40)";
const HEADLINE_KEYS = ["signups", "tutor_sessions", "llm_cost_cents", "errors_5xx", "chat_messages", "logins", "quizzes_completed"];
const AI_LEAD = "llm_cost_cents";
type Count = RepoProductEnv["groups"][number]["metrics"][number];

/** A figure as `countUp` (main.ts) writes it mid-animation — it mirrors the
 *  Worker's `compact` / `productValue` for the frames in between only: the last
 *  frame restores the DTO's own string, so the two can never disagree on screen. */
export function formatCount(n: number, fmt: string | undefined): string {
  const compact = (v: number): string =>
    v >= 999_995_000_000 ? `${(v / 1e12).toFixed(2)}T` : v >= 999_995_000 ? `${(v / 1e9).toFixed(2)}B`
    : v >= 999_950 ? `${(v / 1e6).toFixed(2)}M` : v >= 1_000 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
  if (fmt === "usd") return n >= 1_000_000 ? `$${compact(n / 100)}` : (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return fmt === "compact" ? compact(n) : String(Math.round(n));
}

/** The exact integer behind a compacted figure ("1.2K") — not behind a dollar amount. */
const exactTitle = (value: string | null, raw: number | null): string =>
  value !== null && raw !== null && value !== String(raw) && !value.startsWith("$") ? ` title="${attr(raw.toLocaleString("en-US"))}"` : "";
/** The count-up hook for a figure: only where there is an integer to count to. */
const countAttrs = (value: string, raw: number | null): string =>
  raw === null || !Number.isFinite(raw) ? "" : `data-count="${raw}"${value === String(raw) ? "" : ` data-count-fmt="${value.startsWith("$") ? "usd" : "compact"}"`}`;

const blockTitle = (title: string, aside = ""): string =>
  `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px"><span style="${LABEL_SM};min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(title)}</span>${aside}</div>`;

/** A block's caveats, already `"<label>: <note>"` — ONE footnote block, a line each. */
const noteLines = (rows: { label: string; note?: string }[]): string => {
  const notes = rows.filter((m) => m.note).map((m) => `${m.label}: ${m.note}`);
  return notes.length ? `<div class="repo-pnotes" style="font-size:11px;line-height:1.5;color:var(--fg-40);margin-top:12px">${notes.map((n) => `<div>${esc(n)}</div>`).join("")}</div>` : "";
};

/** Failure counts read `bad` the moment they are non-zero; 4xx is mostly bots
 *  and refused polls (its own note says so), so it never raises a colour. */
const failTone = (key: string): RepoTone => (/^errors_4/.test(key) ? "neutral" : "bad");

// Level 1 — the headline strip.
function headlineTiles(e: RepoProductEnv, range: RepoRange): string {
  const byKey = new Map<string, Count>();
  for (const g of e.groups) for (const m of g.metrics) if (!byKey.has(m.key)) byKey.set(m.key, m);
  const picks = HEADLINE_KEYS.flatMap((k) => byKey.get(k) ?? []).slice(0, 4);
  if (picks.length < 2) return "";
  return `<div class="repo-cells" style="${TOP}"><div class="repo-kpis" style="grid-template-columns:repeat(${picks.length},minmax(0,1fr))">${picks.map((m) => {
    const value = m.values[range], raw = m.raw[range];
    const alarm = m.key === "errors_5xx" && (raw ?? 0) > 0;
    return `<div data-pkpi="${attr(m.key)}" style="padding:16px 20px 16px">
      <div style="${LABEL};overflow:hidden;text-overflow:ellipsis">${esc(m.label)}</div>
      <div style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-top:8px;min-height:34px">${
        value === null
          ? `<span style="${QUIET};line-height:34px">${absentLabel(true)}</span>`
          : `<span ${countAttrs(value, raw)}${exactTitle(value, raw)} class="repo-kpi-n" style="${NUM};font-size:27px;letter-spacing:-0.02em;${alarm ? `color:${TONE.bad}` : ""}">${esc(value)}</span><span class="repo-kpi-s" style="font-size:11px;color:var(--fg-40);white-space:nowrap">last ${esc(range)}</span>`
      }</div>
      ${value === null ? "" : spark(m.trend, alarm ? TONE.bad : "var(--accent)", 34, 10)}
    </div>`;
  }).join("")}</div></div>`;
}

// "Right now" — the totals, as one wrapping line of figures. The separators are
// each item's left hairline; the negative margin tucks the one at a line's start
// out of sight, however the strip wraps.
function nowStrip(e: RepoProductEnv): string {
  if (!e.totals.length) return "";
  return `<div data-pblock="now" style="padding:0 20px 16px">
    <div style="overflow:hidden"><div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 0;margin-left:-15px">
      <span style="${LABEL_SM};padding:0 14px;border-left:1px solid var(--border)">Right now</span>
      ${e.totals.map((t) => `<span style="display:inline-flex;align-items:baseline;gap:6px;padding:0 14px;border-left:1px solid var(--border);white-space:nowrap">${
        t.value === null
          ? `<span style="font-size:12.5px;color:var(--fg-55)">${esc(t.label)}</span><span style="${QUIET}">${absentLabel(true)}</span>`
          : `<span${exactTitle(t.value, t.raw)} style="${NUM};font-size:13.5px">${esc(t.value)}</span><span style="font-size:12.5px;color:var(--fg-55)">${esc(t.label)}</span>`
      }</span>`).join("")}
    </div></div>
    ${noteLines(e.totals)}
  </div>`;
}

// Level 2 — a block per group, each in its own shape.
/** Learning activity: ranked by the range's figure, a bar per row scaled to the largest. */
function rankedBlock(metrics: Count[], range: RepoRange): string {
  const rows = metrics.map((m, i) => ({ m, i, raw: m.values[range] === null ? null : m.raw[range] }))
    .sort((a, b) => (a.raw === null ? 1 : 0) - (b.raw === null ? 1 : 0) || (b.raw ?? 0) - (a.raw ?? 0) || a.i - b.i);
  const max = Math.max(1, ...rows.map((r) => r.raw ?? 0));
  return rows.map(({ m, raw }, i) => {
    const value = m.values[range];
    return `<div class="repo-rank" data-prow="${attr(m.key)}">
      <span class="repo-rank-l" title="${attr(m.label)}" style="font-size:12.5px;color:var(--fg-70);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.label)}</span>
      ${value === null
        ? `<span class="repo-rank-bar"></span><span style="${QUIET};text-align:right;white-space:nowrap">${absentLabel(true)}</span>`
        : `<span class="repo-rank-bar" style="display:block;height:5px;border-radius:999px;background:var(--hover);overflow:hidden">${raw ? `<span class="repo-fill" style="--i:${i};display:block;height:100%;min-width:2px;border-radius:999px;background:var(--accent);width:${(Math.round(((raw ?? 0) / max) * 1000) / 10)}%"></span>` : ""}</span>
        <span${exactTitle(value, m.raw[range])} style="${NUM};font-size:12.5px;text-align:right">${esc(value)}</span>`}
    </div>`;
  }).join("");
}

/** AI spend: the cost as the one figure, the rest of the group as a quiet line under it. */
function featureBlock(metrics: Count[], range: RepoRange): string {
  const lead = metrics.find((m) => m.key === AI_LEAD) ?? metrics[0];
  const rest = metrics.filter((m) => m !== lead);
  const value = lead.values[range];
  return `<div data-prow="${attr(lead.key)}" style="display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;min-height:28px">${
      value === null
        ? `<span style="${QUIET}">${absentLabel(true)}</span>`
        : `<span ${countAttrs(value, lead.raw[range])}${exactTitle(value, lead.raw[range])} style="${NUM};font-size:22px;letter-spacing:-0.02em">${esc(value)}</span>`
    }<span style="font-size:12px;color:var(--fg-55)">${esc(lead.label)} · last ${esc(range)}</span></div>
    ${rest.length ? `<div style="overflow:hidden;margin-top:7px"><div style="display:flex;flex-wrap:wrap;gap:4px 0;margin-left:-11px;font-size:12.5px;color:var(--fg-55)">${rest.map((m) => {
      const v = m.values[range];
      return `<span data-prow="${attr(m.key)}" style="white-space:nowrap;padding:0 10px;border-left:1px solid var(--border)">${
        v === null ? `${esc(m.label)} <span style="${QUIET}">${absentLabel(true)}</span>`
          : `<span${exactTitle(v, m.raw[range])} style="${NUM};font-size:12.5px;color:var(--fg)">${esc(v)}</span> ${esc(m.label)}`}</span>`;
    }).join("")}</div></div>` : ""}
    ${value === null ? "" : spark(lead.trend, "var(--accent)", 72, 14)}`;
}

/** Reliability: what is non-zero leads, with a tone dot; every measured zero folds
 *  into ONE muted line (a real reading, but not the size of a problem); a figure
 *  with no recent reading is named apart and is never counted among the zeros. */
function statusBlock(metrics: Count[], range: RepoRange): string {
  const live = metrics.filter((m) => m.values[range] !== null);
  const hot = live.filter((m) => m.raw[range] !== 0)
    .sort((a, b) => (failTone(a.key) === "bad" ? 0 : 1) - (failTone(b.key) === "bad" ? 0 : 1) || (b.raw[range] ?? 0) - (a.raw[range] ?? 0));
  const zero = live.filter((m) => m.raw[range] === 0);
  const stale = metrics.filter((m) => m.values[range] === null);
  const names = (rows: Count[]) => rows.map((m) => esc(m.label)).join(", ");
  return `<div>${hot.map((m) => {
      const c = TONE[failTone(m.key)];
      return `<div class="repo-rank-h" data-prow="${attr(m.key)}" style="display:flex;align-items:center;gap:10px;padding:5px 0">
        <span style="width:7px;height:7px;border-radius:50%;background:${c};flex:none"></span>
        <span class="repo-rank-l" title="${attr(m.label)}" style="font-size:12.5px;color:var(--fg-70);min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.label)}</span>
        <span${exactTitle(m.values[range], m.raw[range])} style="${NUM};font-size:12.5px">${esc(m.values[range] ?? "")}</span>
      </div>`;
    }).join("")}
    ${zero.length ? `<div data-pzero style="display:flex;gap:10px;padding:${hot.length ? 8 : 2}px 0 0;font-size:12px;line-height:1.55;color:var(--fg-40)"><span style="width:7px;height:7px;border-radius:50%;border:1px solid var(--border-strong);box-sizing:border-box;flex:none;margin-top:6px"></span><span style="min-width:0"><span style="color:var(--fg-55)">${zero.length} at zero</span> — ${names(zero)}</span></div>` : ""}
    ${stale.length ? `<div data-pstale style="padding:6px 0 0 17px;font-size:12px;line-height:1.55;color:var(--fg-40)">${absentLabel(true)} — ${names(stale)}</div>` : ""}
  </div>`;
}
/** A rough height for a status list, so a range with fewer problems does not pull the page up. */
const statusHeight = (metrics: Count[], range: RepoRange): number => {
  const live = metrics.filter((m) => m.values[range] !== null);
  const hot = live.filter((m) => m.raw[range] !== 0).length;
  return hot * 29 + (live.length > hot ? 44 : 0) + (live.length < metrics.length ? 25 : 0);
};

const noteHeight = (metrics: Count[]): number => { const n = metrics.filter((m) => m.note).length; return n ? 12 + 17 * n : 0; };

/** Growth / Community: number over label, three across, no per-row trend. */
function pairsBlock(metrics: Count[], range: RepoRange): string {
  return `<div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 16px">${metrics.map((m) => {
    const value = m.values[range];
    return `<div data-prow="${attr(m.key)}" style="min-width:0">
      <div style="min-height:27px;display:flex;align-items:baseline">${value === null
        ? `<span style="${QUIET}">${absentLabel(true)}</span>`
        : `<span${exactTitle(value, m.raw[range])} style="${NUM};font-size:21px;letter-spacing:-0.02em">${esc(value)}</span>`}</div>
      <div title="${attr(m.label)}" style="font-size:12px;color:var(--fg-55);margin-top:2px;overflow:hidden;text-overflow:ellipsis">${esc(m.label)}</div>
    </div>`;
  }).join("")}</div>`;
}

/** Other, and any group this file has no shape for: quiet label / figure rows. */
function plainBlock(metrics: Count[], range: RepoRange): string {
  return `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(260px,100%),1fr));gap:0 40px">${metrics.map((m) => {
    const value = m.values[range];
    return `<div data-prow="${attr(m.key)}" style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:5px 0;min-width:0">
      <span title="${attr(m.label)}" style="font-size:12.5px;color:var(--fg-55);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.label)}</span>
      ${value === null ? `<span style="${QUIET};white-space:nowrap">${absentLabel(true)}</span>` : `<span${exactTitle(value, m.raw[range])} style="${NUM};font-size:12.5px;color:var(--fg-70)">${esc(value)}</span>`}
    </div>`;
  }).join("")}</div>`;
}

const WIDE = ["learning", "reliability"], NARROW = ["ai", "growth", "community"];

function productBody(e: RepoProductEnv, range: RepoRange, all: RepoProductEnv[], i: number): string {
  const groups = e.groups.filter((g) => g.metrics.length);
  if (!groups.length && !e.totals.length) {
    return `<div style="padding:0 20px 18px;font-size:12.5px;color:var(--fg-40)">This environment has reported no product metrics.</div>`;
  }
  // The status list is held to its tallest form across every range and
  // environment, so switching either never moves what sits under it.
  const relHeight = Math.max(0, ...all.flatMap((env) => env.groups.filter((g) => g.id === "reliability")
    .flatMap((g) => REPO_RANGES.map((r) => statusHeight(g.metrics, r)))));
  const block = (g: RepoProductEnv["groups"][number]): string =>
    `<div data-pblock="${attr(g.id)}"${g.id === "reliability" ? ` style="min-height:${relHeight + 28 + noteHeight(g.metrics)}px"` : ""}>${blockTitle(g.title)}${
      g.id === "learning" ? rankedBlock(g.metrics, range)
      : g.id === "ai" ? featureBlock(g.metrics, range)
      : g.id === "reliability" ? statusBlock(g.metrics, range)
      : g.id === "growth" || g.id === "community" ? pairsBlock(g.metrics, range)
      : plainBlock(g.metrics, range)
    }${noteLines(g.metrics)}</div>`;
  const pick = (id: string) => groups.find((g) => g.id === id);
  // Two balanced rows on a 12-column grid: a wide list beside a narrow block —
  // Learning | AI spend, then Reliability | Growth over Community. A side with
  // nothing to show gives its columns to the other.
  const wide = WIDE.flatMap((id) => pick(id) ?? []).map(block);
  const pairs = ["growth", "community"].flatMap((id) => pick(id) ?? []).map(block);
  const narrow = [...(pick("ai") ? [block(pick("ai")!)] : []), ...(pairs.length ? [pairs.join(`<div style="height:24px"></div>`)] : [])];
  const cells: string[] = [];
  for (let i = 0; i < Math.max(wide.length, narrow.length); i++) {
    const both = wide[i] !== undefined && narrow[i] !== undefined;
    if (wide[i] !== undefined) cells.push(`<div style="grid-column:span ${both ? 7 : 12};padding:18px 20px 20px">${wide[i]}</div>`);
    if (narrow[i] !== undefined) cells.push(`<div style="grid-column:span ${both ? 5 : 12};padding:18px 20px 20px">${narrow[i]}</div>`);
  }
  for (const g of groups) if (!WIDE.includes(g.id) && !NARROW.includes(g.id)) cells.push(`<div style="grid-column:1 / -1;padding:18px 20px 20px">${block(g)}</div>`);
  const strip = nowStrip(e), tiles = headlineTiles(e, range);
  return `${strip ? `<div ${rise(i)}>${strip}</div>` : ""}${tiles ? `<div ${rise(i + 1)}>${tiles}</div>` : ""}
    ${cells.length ? `<div ${rise(i + 2)}><div class="repo-cells" style="${TOP}"><div class="repo-pgrid" style="grid-template-columns:repeat(12,minmax(0,1fr))">${cells.join("")}</div></div></div>` : ""}`;
}

/** Which environment the section shows: the one picked this session, else the
 *  LAST configured one that has reported anything (production, today), else the first. */
function productEnvOf(envs: RepoProductEnv[], picked: string | null): RepoProductEnv {
  return envs.find((e) => e.name === picked)
    ?? [...envs].reverse().find((e) => e.totals.length || e.groups.some((g) => g.metrics.length))
    ?? envs[0];
}

/** The Product section of the Usage tab, entering at stagger index `i`. */
function productSection(p: RepoProps, i: number): string {
  const head = (aside = "") =>
    `<div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;padding:16px 20px 14px;min-height:30px"><span style="${LABEL}">Product</span>${aside}</div>`;
  const envs = okData(p, (d) => d.product);
  // No environment to draw — not connected, empty, loading, an error, OR an `ok`
  // that carries none (the Worker never sends that; the fallback is total anyway,
  // and an `ok` with nothing in it reads as the section's empty state, never as nothing).
  if (!envs?.length) {
    const copy = { nc: "No product metrics reported yet. They appear once the app's metrics endpoint serves `counts` / `totals` and `SAPLING_METRICS_TOKEN` is set.", empty: "No current product reading — the hourly poll of the app's metrics endpoint has gone quiet.", lines: 3 };
    const state = sec(p, (d) => d.product ?? { status: "not_connected" }, copy, () => emptyBlock(copy.empty));
    return `<div ${rise(i, `${TOP}`)}>${head()}<div style="padding:0 20px 14px">${state}</div></div>`;
  }
  const shown = productEnvOf(envs, p.productEnv);
  const seg = envs.length > 1
    // The one already showing takes no action (inertOn): pressing it again must not replay the cross-fade.
    ? segmented({
        id: "repo-product-env", ariaLabel: "Environment", act: "repoProductEnv", value: shown.name, size: "sm", inertOn: true,
        options: envs.map((e) => ({ value: e.name, label: e.name })),
      })
    : `<span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--fg-70)">${esc(shown.name)}</span>`;
  const aside = `<div style="display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px 14px;min-width:0"><span style="font-size:11px;color:var(--fg-40)">reported by the app · counts over ${esc(p.range)}</span>${seg}</div>`;
  return `<div style="${TOP};min-width:0">
      <div ${rise(i)}>${head(aside)}</div>
      <div class="repo-swap repo-pswap" data-penv="${attr(shown.name)}">${productBody(shown, p.range, envs, i)}</div>
    </div>`;
}

// ── "Poll now" — the admin's on-demand refresh of health, usage and GitHub ──
// (POST /admin/poll: health pings, the three usage pollers, the GitHub reconcile.)
// "App metrics": the app's own endpoint answers active users AND product metrics in one response.
const POLL_SOURCES: ["cloudflare" | "railway" | "sapling", string][] = [["cloudflare", "Cloudflare"], ["railway", "Railway"], ["sapling", "App metrics"]];
const MUTED = "var(--fg-40)";
/** The two top-bar controls say different things: one re-reads D1, one goes out to the sources. */
const REFRESH_TITLE = "Reload from Canopy's database";
// TRUE, not tidy: the issue-derived blocks (open issues / bugs, issues by label,
// the feed's issue lines) read `events`, which only Sync GitHub refreshes.
const POLL_TITLE = "Poll deploys, CI, usage and health now (admin) — issues refresh with Sync GitHub";
/** The poll result belongs to the Repo SCREEN, not to one of its tabs: it is kept
 *  while the person is anywhere on Repo and dropped the moment they are not
 *  (main.ts applies this on every rerender, so an in-flight poll's answer is
 *  dropped on arrival too). */
export const repoPollFor = (poll: RepoPollState | null, onRepoScreen: boolean): RepoPollState | null => (onRepoScreen ? poll : null);
/** Admins only, and never in sample mode (which never touches the Worker). Nothing else decides it. */
const canPollRepo = (p: Pick<RepoProps, "admin" | "sample">): boolean => p.admin && !p.sample;

/** One environment's outcome: `staging ✓ 3 new` / `✓ up to date` / `✗ <detail>` / `– skipped: <detail>`.
 *  An `ok` may carry a detail too (product keys the poll dropped, by name), and
 *  a `failed` may still have written rows (the app's product metrics land even
 *  when its active-users half is refused) — both are said, never hidden. */
function pollOutcome(o: PollOutcome): string {
  const [color, text] =
    o.status === "ok" ? [TONE.good, `${o.written > 0 ? `✓ ${o.written} new` : "✓ up to date"}${o.detail ? ` — ${o.detail}` : ""}`]
    : o.status === "failed" ? [TONE.bad, `✗ ${o.detail ?? "failed"}`]
    : [MUTED, `– skipped${o.detail ? `: ${o.detail}` : ""}`];
  // What a FAILED poll stored anyway is not part of the failure: muted, not red.
  const landed = o.status === "failed" && o.written > 0 ? `<span style="color:${MUTED}"> — ${o.written} new</span>` : "";
  // "*" is the whole source (an arm that threw), not an environment called "*".
  return `<span><span style="font-family:var(--label);font-weight:600;color:var(--fg-70)">${esc(o.env === "*" ? "all" : o.env)}</span> <span style="color:${color}">${esc(text)}</span>${landed}</span>`;
}
const pollSource = (s: UsagePollSource): string =>
  s === "not_configured" || !Array.isArray(s) ? `<span style="color:${MUTED}">not configured</span>`
  : !s.length ? `<span style="color:${MUTED}">no environment configured</span>`
  : s.map(pollOutcome).join(SEP);

const SEP = `<span style="color:${MUTED}"> · </span>`;
const PART_NAME: Record<string, string> = { backend: "api", frontend: "web" };
/** Health, summarised: how many targets are up, and each one that is not, by name — `4 up` / `3 up · staging api ✗ timeout`. */
function pollHealth(s: UsagePollSource | undefined): string {
  if (!Array.isArray(s)) return `<span style="color:${MUTED}">not configured</span>`;
  if (!s.length) return `<span style="color:${MUTED}">no environment configured</span>`;
  const up = s.filter((o) => o.status === "ok").length;
  const downs = s.filter((o) => o.status !== "ok").map((o) =>
    `<span><span style="font-family:var(--label);font-weight:600;color:var(--fg-70)">${esc(o.env === "*" ? "all" : o.env)}${o.part ? ` ${esc(PART_NAME[o.part] ?? o.part)}` : ""}</span> <span style="color:${TONE.bad}">${esc(`✗ ${o.detail ?? "down"}`)}</span></span>`);
  return [...(up || !downs.length ? [`<span style="color:${TONE.good}">${up} up</span>`] : []), ...downs].join(SEP);
}
/** GitHub: the reconcile's counts, or the arms that failed BY NAME, or why it did not run. */
function pollGithub(g: RepoRefreshGithub | "not_configured" | undefined): string {
  if (!g || g === "not_configured") return `<span style="color:${MUTED}">not configured</span>`;
  const failed = Array.isArray(g.failed) ? g.failed.map(String) : [];
  const counts = `${Number(g.written) || 0} new · ${Number(g.unchanged) || 0} unchanged`;
  if (!failed.length) return `<span style="color:${TONE.good}">${esc(counts)}</span>`;
  // The budget skip is reported through `failed`, but nothing FAILED — it never ran.
  if (failed.length === 1 && failed[0].startsWith("skipped:")) return `<span style="color:${MUTED}">${esc(`– ${failed[0]}`)}</span>`;
  const landed = g.written || g.unchanged ? `<span style="color:${MUTED}"> — ${esc(counts)}</span>` : "";
  return `<span style="color:${TONE.bad}">${esc(`✗ failed: ${failed.join(", ")}`)}</span>${landed}`;
}

/** The result strip at the top of whichever tab is open: one line per source, or the one-line refusal / failure. */
function pollStrip(poll: RepoPollState | null): string {
  if (!poll || poll.status === "polling") return "";
  const line = (label: string, body: string): string =>
    `<div><span style="font-weight:600;color:var(--fg-70)">${label}</span><span style="color:${MUTED}"> — </span>${body}</div>`;
  const lines = poll.status === "error" ? `<div style="color:${TONE.bad}">Poll failed — try again.</div>`
    : poll.status === "busy" ? `<div style="color:var(--fg-70)">A refresh is already running — try again in a minute.</div>`
    : line("Health", pollHealth(poll.result.health))
      + POLL_SOURCES.map(([key, label]) => line(label, pollSource(poll.result[key]))).join("")
      + line("GitHub", pollGithub(poll.result.github));
  return `<div class="repo-poll-strip" role="status" style="display:flex;align-items:flex-start;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);font-size:12px;line-height:1.7;color:var(--fg-55)">
      <div style="flex:1;min-width:0;overflow-wrap:anywhere">${lines}</div>
      <button data-act="repoPollDismiss" title="Dismiss" aria-label="Dismiss poll result" class="cnpy-iconbtn" style="flex:none;width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:14px;line-height:1;color:${MUTED}">×</button>
    </div>`;
}

const CF_REQUESTS = "Workers requests", CF_ERRORS = "Workers errors";
/** A figure as the Worker compacts it ("302", "12.4K", "1.24M") back to a number; null for anything else. */
export function parseCompact(s: string | undefined): number | null {
  const m = /^(\d+(?:\.\d+)?)([KMBT])?$/.exec((s ?? "").trim());
  return m ? Number(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2] ?? ""] ?? 1) : null;
}
/** errors ÷ requests as a bar width in percent — null (no bar) unless both are readable and requests > 0. */
export function errorShare(requests: string | undefined, errors: string | undefined): number | null {
  const req = parseCompact(requests), err = parseCompact(errors);
  if (req === null || err === null || req <= 0) return null;
  return Math.min(100, Math.round((err / req) * 1000) / 10);
}

function usageTab(p: RepoProps): string {
  const usageLive = okData(p, (d) => d.usage) !== null;
  const ranges = segmented({
    id: "repo-range", ariaLabel: "Range", act: "repoRange", value: p.range, size: "sm",
    options: REPO_RANGES.map((r) => ({ value: r, label: r })),
  });

  const usage = sec(p, (d) => d.usage, { nc: "No usage captured yet. Requests and error rate come from the hourly Cloudflare analytics poll (CF_ANALYTICS_TOKEN and CF_ANALYTICS_ACCOUNT_ID); active users come from the app's own metrics endpoint (SAPLING_METRICS_TOKEN). Both need an environment in REPO_ENVIRONMENTS.", empty: "No current usage reading — the hourly polls have gone quiet.", lines: 4 }, (u) =>
    `<div class="repo-swap" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))">${u[p.range].map(usageEnv).join("")}</div>`);
  // Infrastructure — two blocks, a column per environment in each, in the same
  // stat shape as the Product blocks above (figure over label), not two tables.
  // `ok` is gated on the WIDEST range (30d), so a narrower one can legitimately
  // hold no rows — say so, rather than render a titled panel with nothing in it.
  // "Nothing RECORDED", not "no requests": an empty range may be one no poll
  // ever covered, and zero traffic is a claim the capture cannot support.
  const envCols = (cols: string[]): string =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:18px 28px;margin-top:4px">${cols.join("")}</div>`;
  const envName = (name: string): string =>
    `<div style="font-family:var(--label);font-size:11.5px;font-weight:600;color:var(--fg-70);margin-bottom:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(name)}</div>`;
  // "0.48 vCPU" → the figure at size, its unit quiet beside it (the same string, split at the space).
  const stat = (value: string, label: string, size = 21): string => {
    const [, fig, unit] = /^(\S+)\s+(.+)$/.exec(value) ?? [null, value, ""];
    return `<div style="min-width:0"><div style="${NUM};font-size:${size}px;letter-spacing:-0.02em;${value === "—" ? "color:var(--fg-40)" : ""}">${esc(fig ?? value)}${unit ? `<span style="font-size:11.5px;font-weight:500;letter-spacing:0;color:var(--fg-55);margin-left:5px">${esc(unit)}</span>` : ""}</div><div style="font-size:12px;color:var(--fg-55);margin-top:2px;overflow:hidden;text-overflow:ellipsis">${esc(label)}</div></div>`;
  };
  const usageNow = okData(p, (d) => d.usage)?.[p.range] ?? [];
  const cf = sec(p, (d) => d.cloudflare, { nc: "No Cloudflare analytics captured yet. The hourly poll runs once the CF_ANALYTICS_TOKEN and CF_ANALYTICS_ACCOUNT_ID secrets are set and REPO_ENVIRONMENTS names each environment's Worker; it also feeds the requests and error rate above.", empty: "No Cloudflare metrics in the last 30 days." }, (c) => {
    const rows = c[p.range];
    if (!rows.length) return `<div class="repo-swap" style="padding:6px 0;font-size:12.5px;color:var(--fg-40)">Nothing recorded in this range.</div>`;
    const names = [...new Set(rows.map((r) => r.env))];
    return `<div class="repo-swap">${envCols(names.map((name, n) => {
      const mine = rows.filter((r) => r.env === name);
      const req = mine.find((r) => r.label === CF_REQUESTS), err = mine.find((r) => r.label === CF_ERRORS);
      // The share is the two figures this block itself shows, errors ÷ requests —
      // drawn only when both are there and there is a request to take a share of.
      const share = errorShare(req?.value, err?.value);
      const tone = usageNow.find((u) => u.name === name)?.errorRate?.tone;
      const fill = tone === "warn" || tone === "bad" ? TONE[tone] : "var(--fg-40)";
      return `<div data-cfenv="${attr(name)}" style="min-width:0">${envName(name)}
        <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px;align-items:end">${mine.map((r) => stat(r.value, r.label, r === req ? 21 : 17)).join("")}</div>
        ${share === null ? "" : `<div title="${attr(`${CF_ERRORS} as a share of ${CF_REQUESTS}`)}" style="height:4px;border-radius:999px;background:var(--hover);overflow:hidden;margin-top:12px"><div class="repo-fill" style="--i:${n};height:100%;min-width:${share > 0 ? 2 : 0}px;border-radius:999px;background:${fill};width:${share}%"></div></div>
        <div style="font-size:11px;color:var(--fg-40);margin-top:6px">errors as a share of requests</div>`}
      </div>`;
    }))}</div>`;
  });
  const hosting = sec(p, (d) => d.hosting, { nc: "No Railway reading captured yet. The hourly poll runs once an environment's RAILWAY_TOKEN_<ENVIRONMENT> secret is set and REPO_ENVIRONMENTS carries its railwayEnvironmentId and railwayServiceId.", empty: "No fresh hosting reading — the last Railway sample is over 3 hours old." }, (rows) =>
    envCols(rows.map((h) => `<div data-hostenv="${attr(h.env)}" style="min-width:0">${envName(h.env)}
      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 16px">${stat(h.cpu, "CPU")}${stat(h.memory, "Memory")}</div>
    </div>`)));

  // "Poll now" used to live in this header; it is in the Repo top bar now, on every tab.
  return `<div ${rise(0, `display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;padding:14px 20px;border-bottom:1px solid var(--border)`)}>
      <span style="${LABEL}">App usage</span>${ranges}
    </div>
    <div ${rise(1)}>${usageLive ? usage : `<div style="padding:6px 20px">${usage}</div>`}</div>
    ${productSection(p, 2)}
    <div ${rise(5, `${TOP};flex:1`, "repo-cells")}><div style="grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr))">
      <div style="padding:18px 20px 20px;display:flex;flex-direction:column">
        <div style="${LABEL};white-space:normal;line-height:1.5;margin-bottom:12px">Cloudflare — frontend Workers</div>
        ${cf}
      </div>
      <div style="padding:18px 20px 20px;display:flex;flex-direction:column">
        <div style="${LABEL};white-space:normal;line-height:1.5;margin-bottom:12px">Hosting — Railway backend</div>
        ${hosting}
      </div>
    </div></div>`;
}

// ── Team & Planning ──────────────────────────────────────────────────────────
function planningTab(p: RepoProps): string {
  const sprint = sec(p, (d) => d.sprint, { nc: "Sprints aren't connected.", empty: "No sprint is active — mark one active on the Roadmap.", lines: 2 }, (sp) => {
    const due = sp.due ? new Date(sp.due).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toUpperCase() : null;
    return `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="${LABEL}">Current sprint</span>
        ${due ? `<span style="margin-left:auto;font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.04em;color:var(--fg-55);border:1px solid var(--border);border-radius:5px;padding:2px 7px;white-space:nowrap">DUE ${esc(due)}</span>` : ""}
      </div>
      <div style="display:flex;align-items:center;gap:12px;margin-top:10px">
        <button data-act="openSprint" data-arg="${sp.id}" class="repo-quiet" style="font-size:16.5px;font-weight:600;letter-spacing:-0.01em;min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;padding:0">${esc(sp.label)}</button>
        <span style="font-family:var(--label);font-size:13px;font-weight:600;color:var(--accent);flex:none"><span data-count="${sp.pct}">${sp.pct}</span>%</span>
        <span style="font-size:12px;color:var(--fg-40);flex:none;white-space:nowrap">${sp.closed} closed · ${sp.total - sp.closed} open</span>
      </div>
      <div style="height:9px;border-radius:999px;background:var(--hover);overflow:hidden;margin-top:12px"><div class="repo-fill" style="height:100%;width:${sp.pct}%;background:var(--accent);border-radius:999px"></div></div>`;
  });
  const sprintLive = okData(p, (d) => d.sprint) !== null;

  const contributors = sec(p, (d) => d.contributors, { nc: "Contributors aren't connected.", empty: "No pushes, merges or reviews this week.", lines: 4 }, (rows) => {
    // `reviews` is null until a `review` row has ever been captured — never
    // guessed as 0, and excluded from the bar width (not just rendered as "—").
    const max = Math.max(1, ...rows.map((r) => r.pushes + r.merged + (r.reviews ?? 0)));
    return rows.map((r, i) => {
      const color = r.person.color ? `var(--p-${r.person.color})` : "var(--fg-40)";
      // A known person is one chip that opens their card; a bot or an unmapped login stays plain.
      const linked = linkedPerson(r.person, p);
      const name = "font-family:var(--label);font-size:11.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      return `<div style="display:grid;grid-template-columns:112px minmax(0,1fr) 74px;gap:12px;align-items:center;padding:5.5px 0;${TOP}">
        ${linked
          ? `<span style="display:inline-flex;min-width:0">${personLink(linked, r.person.login, 20, who(r.person), `min-width:0;${name}`)}</span>`
          : `<span style="display:inline-flex;align-items:center;gap:7px;min-width:0">${avatar(r.person, 20, p.persons)}<span style="${name}">${esc(who(r.person))}</span></span>`}
        <span style="display:block;height:6px;border-radius:999px;background:var(--hover);overflow:hidden"><span class="repo-fill" style="--i:${i};display:block;height:100%;border-radius:999px;background:${color};width:${Math.round(((r.pushes + r.merged + (r.reviews ?? 0)) / max) * 100)}%"></span></span>
        <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-55);text-align:right">${r.pushes} · ${r.merged} · ${r.reviews === null ? "—" : r.reviews}</span>
      </div>`;
    }).join("");
  });

  const labelData = okData(p, (d) => d.labels);
  const labels = sec(p, (d) => d.labels, { nc: "Issue labels aren't connected.", empty: "No open issues with labels.", lines: 4 }, (l) => {
    const max = Math.max(1, ...l.rows.map((r) => r.count));
    return l.rows.map((r, i) => {
      const bug = r.name.toLowerCase() === "bug";
      return `<div style="display:grid;grid-template-columns:110px minmax(0,1fr) 30px;gap:12px;align-items:center;padding:9px 0;${TOP}">
        <span style="font-family:var(--label);font-size:11.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.name)}</span>
        <span style="display:block;height:6px;border-radius:999px;background:var(--hover);overflow:hidden"><span class="repo-fill" style="--i:${i};display:block;height:100%;border-radius:999px;background:${bug ? "var(--red)" : "var(--border-strong)"};width:${Math.round((r.count / max) * 100)}%"></span></span>
        <span style="font-family:var(--label);font-size:12px;font-weight:600;text-align:right;color:${bug ? "var(--red)" : "var(--fg)"}">${r.count}</span>
      </div>`;
    }).join("");
  });

  // `t.delta` is null once the window can't support a trend claim (see
  // `windowDelta` in src/tools/repo.ts) — the count/sparkline still show, but
  // no delta chip and no "since" text (there is nothing to date it from).
  // I2: `empty` now means "a count has landed before, just not in the last 90
  // days", not "nothing has ever scanned this".
  const todos = sec(p, (d) => d.todos, { nc: "No TODO / FIXME count reported yet. It appears once the repo's CI posts a canopy/todo commit status on a push to the default environment branch; it is read from a status webhook event, the 6-hourly GitHub reconcile, or Poll now.", empty: "No count reported in the last 90 days." }, (t) =>
    `<div style="display:flex;align-items:baseline;gap:12px;margin-top:10px">
      <span data-count="${t.count}" style="font-family:var(--label);font-size:31px;font-weight:600;letter-spacing:-0.02em">${t.count}</span>
      ${t.delta === null ? "" : `<span style="font-family:var(--label);font-size:11.5px;font-weight:600;color:${t.delta <= 0 ? "var(--green)" : "var(--amber)"}">${t.delta < 0 ? "−" : "+"}${Math.abs(t.delta)}</span>
      <span style="font-size:11px;color:var(--fg-40)">since ${esc(t.since)}</span>`}
    </div>
    ${spark(t.trend, "var(--fg-55)", 52, 12)}
    <div style="font-size:11.5px;color:var(--fg-40);margin-top:8px">counted by CI on each push to the default environment branch</div>`);

  return `<div ${rise(0, `padding:20px 22px`)}>${sprintLive ? sprint : `<div style="${LABEL}">Current sprint</div>${sprint}`}</div>
    <div ${rise(1, `display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));${TOP};flex:1`)}>
      <div style="padding:16px 20px;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px"><span style="${LABEL}">Contributors this week</span><span title="pushes · merged PRs · reviews" style="font-family:var(--label);font-size:10px;color:var(--fg-40);letter-spacing:.04em">P · M · R</span></div>
        ${contributors}
      </div>
      <div style="padding:16px 20px;${LEFT};min-width:0">
        <div style="${LABEL};margin-bottom:6px">Open issues by label${labelData ? ` — ${labelData.total}` : ""}</div>
        ${labels}
      </div>
      <div style="padding:16px 20px;${LEFT};min-width:0;display:flex;flex-direction:column">
        <div style="${LABEL}">TODO / FIXME in source</div>
        ${todos}
      </div>
    </div>`;
}

// ── the screen ───────────────────────────────────────────────────────────────
const SCREEN_LABEL: Record<RepoTab, string> = { overview: "Overview", code: "Code", ci: "CI and Deploys", usage: "Usage", planning: "Planning" };

/** Does the tab in view have a section nothing has been captured for yet? */
function hasUncaptured(p: RepoProps): boolean {
  const d = p.repo.data;
  if (!d) return false;
  // The ONE section→tab mapping (shared with the MCP `get_repo_dashboard` tool).
  // `?? not_connected`: a payload from before a section existed lacks its key.
  return REPO_TAB_SECTIONS[p.tab].some((k) => ((d[k] as RepoSection<unknown> | undefined)?.status ?? "not_connected") === "not_connected");
}

/** The page's tab bar: every tab is in the one dashboard payload, so a switch
 *  (`setRepoTab`) is ONE rerender with nothing to load, and the underline slides. */
export function repoTabBar(tab: RepoTab): string {
  return tabBar({
    id: "repo-tab", ariaLabel: "Repo sections", act: "setRepoTab", value: tab,
    tabs: REPO_TABS.map(([value, label]) => ({ value, label })),
  });
}

/** One tab of the dashboard, under the tab bar. The bar renders in EVERY state (loading,
 *  failed, degraded, sample, nothing connected) — only the panel's content changes — so its
 *  line and underline never move; the sample / degraded banner, the "Poll now" strip and the
 *  "not connected" footer all sit under the line, in the labelled panel. */
export function repoView(p: RepoProps): string {
  const body = p.tab === "overview" ? overviewTab(p) : p.tab === "code" ? codeTab(p) : p.tab === "ci" ? ciTab(p)
    : p.tab === "usage" ? usageTab(p) : planningTab(p);

  const info = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>`;
  const banner = p.sample
    ? `<div class="cnpy-rise" style="display:flex;align-items:center;gap:9px;margin-bottom:16px;font-size:12.5px;color:var(--fg-55)">${info}
        <span><span style="font-family:var(--label);font-size:11.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px">sample data</span> — every section shown with placeholder values, not this repo's.</span>
        <button data-act="repoSampleOff" class="repo-textbtn" style="margin-left:auto;font-size:12.5px;font-weight:500;color:var(--accent);padding:0;white-space:nowrap">Back to live data</button>
      </div>`
    : p.repo.data?.degraded
      ? `<div class="cnpy-rise" style="display:flex;align-items:center;gap:9px;margin-bottom:16px;font-size:12.5px;color:var(--fg-55)">${info}Some reads failed, so this view may be incomplete.</div>`
      : "";
  const footer = !p.sample && hasUncaptured(p)
    ? `<div class="cnpy-rise" style="--i:6;display:flex;align-items:center;gap:9px;margin-top:14px;font-size:12px;color:var(--fg-40)">${info}
        <span>Sections marked <span style="color:var(--fg-55)">not connected</span> have had nothing captured yet — each says what it is waiting on.</span>
        <button data-act="repoSampleOn" class="repo-textbtn" style="font-size:12px;font-weight:500;color:var(--accent);padding:0;white-space:nowrap">Preview with sample data</button>
      </div>`
    : "";

  return `<div class="repo-frame" style="${FRAME}" data-screen-label="${SCREEN_LABEL[p.tab]}">
    ${repoTabBar(p.tab)}
    <div${tabPanelAttrs("repo-tab", p.tab)} style="padding-top:20px">
      ${banner}
      <div class="repo-panel ${SURFACE}" style="${PANEL}">${canPollRepo(p) ? pollStrip(p.poll) : ""}${body}</div>
      ${footer}
    </div>
  </div>`;
}
