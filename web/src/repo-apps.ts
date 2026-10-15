// Org settings › Repositories › a repo › Apps (repo setups, Phase D2; docs/architecture/hosting-providers.md ›
// Apps) — what a repository ships, set up by an admin. Detection SUGGESTS; a person decides: nothing the scan found
// changes the Repo screen (but its found-apps card) until it is accepted here.
//
// ONE read, `GET /api/o/:slug/repos/:owner/:name/apps` (`RepoAppsSetupDTO`), drawn in Org settings' idiom (org-ui.ts)
// on three pages of the Repositories tab (`#org/repos/<owner>/<name>[/apps/<key>|/new]`, hash.ts):
//   • APPS — the lead (how many apps, how many more the scan found; Scan again, Add an app, Accept all), the
//     SUGGESTIONS (each: a blue ring "Suggested", folder, kind, host or "no host", its evidence; Ignore / Accept),
//     the APPS (name, folder, kind, host, a targets line; a row opens the app), the UNASSIGNED deploy names (seen in
//     30 days, named by no app; "Make an app" prefilled);
//   • an APP — its name, kind (`segmented()`), folder and watch paths (a list), how a release shows up (a Package, or
//     an app with no host), and its TARGETS: one row per environment — a part on a host opens #185's part editor
//     prefilled with the app key; a `github` part (or an environment with no part) picks its deploy signal from a
//     `dropdown()` that offers ONLY signals seen in the last 30 days; Add part opens the editor empty with the key;
//     Remove app behind the page's `confirmModal` (keep its parts, the default, or remove them too);
//   • ADD AN APP — name, folder, kind, how a release shows up (from tags and workflows actually seen).
// Pure: props in, markup out. Every act starts with `orgApps` and is dispatched (main.ts → org-actions.ts) to
// web/src/repo-apps-actions.ts. The SPA never branches on a provider id: a host is named by the read's catalogue.

import { esc, attr, relTime, surface } from "./ui";
import { O_LABEL, O_FIELD, O_HELP, O_ERR, accentBtn, quietBtn, dangerLink, orgHead, tabLead, textField, failedNote, loadingNote, type OrgSlice } from "./org-ui";
import { segmented } from "./segmented";
import { dropdown, initialDropdownUi, type DropdownOption, type DropdownProps, type DropdownUi } from "./dropdown";
import { kindMark, stateMark, type StateKind } from "./marks";
import { APP_KINDS, APP_KIND_ROLE, type AppKind } from "@shared/repo-apps-core";
import type { AppSuggestionDTO, RepoAppsSetupDTO, SeenSignal } from "@shared/repo-scan-core";
import { SIGNAL_WINDOW_DAYS, keyFromSignalName, pickableSignals, settingsNameSignal, signalKey, signalSettings } from "@shared/repo-apps-setup-core";
import { MAX_PARTS_PER_ENVIRONMENT, PART_KEY_RE, type ConnectionStatus, type EnvironmentPartDTO, type HostingProviderId } from "@shared/hosting";
import type { OrgRepoRoute } from "./hash";

// ── state ────────────────────────────────────────────────────────────────────

export type SetupApp = RepoAppsSetupDTO["apps"][number];

/** An app's page, being edited. Saved as one PUT of the app, then one part write per changed deploy signal. */
export interface AppDraft {
  key: string;
  label: string;
  folder: string;
  kind: AppKind;
  watch: string[];
  /** The "Add a path" field. */
  watchDraft: string;
  /** How a release shows up: "" (not tracked — stored NULL), `tag:<glob>` (an SQLite GLOB on the tag, read by releases,
   *  Phase F), `workflow:<file>@<branch>`. */
  release: string;
  /** Deploy signals picked per environment, by `signalKey` ("" = not tracked) — applied on Save. */
  picks: Record<string, string>;
  saving: boolean;
  error: string | null;
  /** `label`, `folder`, `watch`, `release_signal`, `kind`, or null for the whole form. */
  errorField: string | null;
}

/** Add an app by hand. */
export interface AddDraft {
  key: string;
  folder: string;
  kind: AppKind;
  release: string;
  saving: boolean;
  error: string | null;
  errorField: string | null;
}

/** Everything the Apps pages keep (`state.org.apps`). */
export interface RepoAppsUi {
  /** The repository `setup` was read for. */
  repo: string | null;
  setup: OrgSlice<RepoAppsSetupDTO | null>;
  draft: AppDraft | null;
  add: AddDraft | null;
  /** Scan again is running. */
  scanning: boolean;
  /** Suggestions with an accept / ignore in flight (their ids). */
  busy: string[];
  /** The Remove confirmation's choice: also remove the app's parts. Off by default. */
  removeParts: boolean;
}

export function initialRepoAppsUi(): RepoAppsUi {
  return { repo: null, setup: { status: "idle", data: null }, draft: null, add: null, scanning: false, busy: [], removeParts: false };
}

// ── words ────────────────────────────────────────────────────────────────────

const B = (s: string): string => `<strong style="font-weight:600;color:var(--fg)">${esc(s)}</strong>`;
const CODE = (s: string): string => `<code style="font-family:var(--code);font-size:12px;color:var(--fg-70);overflow-wrap:anywhere">${esc(s)}</code>`;
const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";
const ROW = "display:flex;align-items:flex-start;gap:10px 14px;flex-wrap:wrap;padding:13px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px";
const times = (n: number): string => `${n} ${n === 1 ? "time" : "times"}`;
const listed = (names: string[]): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const folderWord = (f: string): string => (f === "/" ? "/" : f);

/** A host's name, from the read's catalogue. */
export function providerWord(d: RepoAppsSetupDTO, id: HostingProviderId | null): string {
  if (!id) return "GitHub";
  return d.providers?.find((p) => p.id === id)?.label ?? id;
}
/** Does this host learn its deploys from GitHub (the deploy-signal picker applies)? */
export const viaGithub = (d: RepoAppsSetupDTO, id: HostingProviderId): boolean => d.providers?.find((p) => p.id === id)?.via_github === true;

/** The hosts an app's parts run on, in words — "no host" when it has none. */
export function appHost(d: RepoAppsSetupDTO, app: Pick<SetupApp, "parts">): string {
  const words = [...new Set(app.parts.map((p) => providerWord(d, p.provider)))];
  return words.length ? listed(words) : "no host";
}

/** What an app ships to, in one line: "production from main · staging from develop", or why it ships nowhere. */
export function targetsLine(d: RepoAppsSetupDTO, app: SetupApp): string {
  if (APP_KIND_ROLE[app.kind] === null) {
    const users = d.suggestions.find((s) => s.key === app.key)?.usedBy ?? [];
    return users.length ? `No targets · ships inside ${listed(users)}` : "No targets · ships inside the apps that use it";
  }
  const envs = d.environments ?? [];
  const lines = envs.filter((e) => app.parts.some((p) => p.env === e.key)).map((e) => `${e.label} from ${e.branch}`);
  return lines.length ? lines.join(" · ") : "No targets yet";
}

/** A signal as the picker names it: `Deployment “Production – web”`, `Check run “Render – api”`, `Workflow deploy.yml`. */
export function signalLabel(s: SeenSignal): string {
  if (s.kind === "deployment") return `Deployment “${s.name}”`;
  if (s.kind === "check") return `Check run “${s.name}”`;
  if (s.kind === "status") return `Status “${s.name}”`;
  return `Workflow ${(s.source ?? s.name).replace(/^\.github\/workflows\//, "")}`;
}
/** Where a signal came from and how often: "Render · 14 times · last 25m ago". */
export function signalMeta(d: RepoAppsSetupDTO, s: SeenSignal): string {
  return `${providerWord(d, s.provider)} · ${times(s.count)} · last ${relTime(s.lastAt) || "—"}`;
}
/** Where an unassigned name came from: "Vercel deployment", "Check run by render", "GitHub workflow". */
export function signalSource(d: RepoAppsSetupDTO, s: SeenSignal): string {
  const host = s.provider ? providerWord(d, s.provider) : null;
  if (s.kind === "deployment") return host ? `${host} deployment` : "GitHub deployment";
  if (s.kind === "check") return host ? `${host} check run` : s.source ? `Check run by ${s.source}` : "Check run";
  if (s.kind === "status") return host ? `${host} commit status` : "Commit status";
  return "GitHub Actions workflow";
}
/** What a `github` part's setting reads, in words. */
export function settingWord(settings: Readonly<Record<string, string>>): string {
  if (settings.environment) return `Deployment “${settings.environment}”`;
  if (settings.check_app && settings.check_name) return `Check run “${settings.check_name}” by ${settings.check_app}`;
  if (settings.workflow) return `Workflow ${settings.workflow.replace(/^\.github\/workflows\//, "")}`;
  return "Nothing yet";
}

/** How a release shows up, in words. */
export function releaseWord(v: string | null): string {
  if (!v) return "Not tracked";
  if (v.startsWith("tag:")) return `A tag matching ${v.slice(4)}`;
  if (v.startsWith("workflow:")) {
    const [file, branch] = v.slice(9).split("@");
    return `A workflow run of ${file.replace(/^\.github\/workflows\//, "")}${branch ? ` on ${branch}` : ""}`;
  }
  return v;
}

/** The release choices: a tag only when tags were seen (`tag:v*`), a workflow only when its runs were — one per
 *  environment branch (`workflow:<file>@<branch>`; the run carries no branch here, so with no environment none is
 *  offered rather than a guessed one) — and "Not tracked". `current` (what is stored) stays pickable even when it was
 *  not seen lately. */
export function releaseOptions(d: RepoAppsSetupDTO, current: string | null = null): DropdownOption[] {
  const out: DropdownOption[] = [];
  // Tags not read yet (null) offer nothing, exactly like none seen: a tag is offered only once one was seen.
  const tags = d.tags;
  if (tags && tags.count > 0) {
    out.push({ value: "tag:v*", label: "A tag matching v*", hint: `Seen ${times(tags.count)}${tags.latest ? ` · latest ${tags.latest.tag}, ${relTime(tags.latest.at)}` : ""}` });
  }
  const seen = new Set<string>();
  for (const s of d.signals) {
    if (s.kind !== "workflow") continue;
    const file = (s.source ?? s.name).replace(/^\.github\/workflows\//, "");
    if (seen.has(file)) continue;
    seen.add(file);
    for (const branch of [...new Set((d.environments ?? []).map((e) => e.branch))]) {
      out.push({ value: `workflow:${file}@${branch}`, label: `A workflow run of ${file} on ${branch}`, hint: `Seen ${times(s.count)} in ${SIGNAL_WINDOW_DAYS} days · it does not say whether it reached its users` });
    }
  }
  if (current && !out.some((o) => o.value === current)) out.push({ value: current, label: releaseWord(current), hint: `Set before · not seen in ${SIGNAL_WINDOW_DAYS} days` });
  out.push({ value: "", label: "Not tracked", hint: "Shows pull requests and CI only" });
  return out;
}

/** The app key "Make an app" starts from for an unassigned name. */
export const keyForSignal = (s: SeenSignal): string => keyFromSignalName(s.kind === "workflow" ? (s.source ?? s.name).replace(/^\.github\/workflows\//, "") : s.name);

// ── the deploy-signal picker ─────────────────────────────────────────────────

/** The part of an app in an environment, if any. */
export const partIn = (app: Pick<SetupApp, "parts">, env: string): EnvironmentPartDTO | null => app.parts.find((p) => p.env === env) ?? null;

/** The seen signal a `github` part's setting names, if it was seen in the window. */
export function currentSignal(d: RepoAppsSetupDTO, part: EnvironmentPartDTO | null): SeenSignal | null {
  if (!part) return null;
  return pickableSignals(d.signals).find((s) => settingsNameSignal(part.settings, s)) ?? null;
}

/**
 * The picker for one target: a `dropdown()` of the signals SEEN in the last 30 days that a `github` part can be set
 * to (`pickableSignals`) — never a name that was not seen, not even the part's own stale setting (that is said
 * under the picker in words). For an environment with no part, its first option is "Not tracked".
 */
export function signalDropdown(d: RepoAppsSetupDTO, app: SetupApp, env: string, dr: Pick<AppDraft, "picks" | "saving"> | null): DropdownProps {
  const part = partIn(app, env);
  const now = currentSignal(d, part);
  const value = dr?.picks[env] ?? (now ? signalKey(now) : "");
  const options: DropdownOption[] = pickableSignals(d.signals).map((s) => ({ value: signalKey(s), label: signalLabel(s), hint: signalMeta(d, s) }));
  const head: DropdownOption = part
    ? { value: "", label: "Keep what it reads now", shown: options.length ? "Pick a deploy signal" : "No deploy seen in 30 days", hint: "The part's setting stays as it is" }
    : { value: "", label: "Not tracked", hint: "The Repo screen says unknown for this target" };
  return {
    id: `org-apps-sig-${env}`, act: "orgAppsSignal", arg: env, value, options: [head, ...options],
    ariaLabel: `How Trov sees a deploy of ${app.label} in ${d.environments?.find((e) => e.key === env)?.label ?? env}`, size: "sm", fill: true,
    disabled: !!dr?.saving,
  };
}

/** The release picker of an app's page, or of Add an app. */
export function releaseDropdown(d: RepoAppsSetupDTO, id: "org-apps-release" | "org-apps-add-release", value: string, stored: string | null, disabled: boolean): DropdownProps {
  return { id, act: id === "org-apps-release" ? "orgAppsRelease" : "orgAppsAddRelease", value, options: releaseOptions(d, stored), labelledBy: `${id}-l`, fill: true, disabled };
}

// ── shared pieces ────────────────────────────────────────────────────────────

/** "Repositories › owner/name › Apps › api" — each step back is a link. */
function crumb(route: OrgRepoRoute, appWord: string | null): string {
  const link = (text: string, arg: string, code = false) => `<button type="button" data-act="orgAppsGo" data-arg="${attr(arg)}" class="cnpy-mutelink" style="padding:0;font-size:13px;font-weight:500;color:var(--fg-55);${code ? "font-family:var(--code);font-size:12.5px;" : ""}">${esc(text)}</button>`;
  const sep = `<span aria-hidden="true" style="color:var(--fg-40)">›</span>`;
  const here = (text: string, code = false) => `<span aria-current="page" style="font-weight:600;${code ? "font-family:var(--code);font-size:12.5px;" : "white-space:nowrap;"}">${esc(text)}</span>`;
  const steps = [link("Repositories", "")];
  if (route.view === "apps") steps.push(here(route.repo, true));
  else { steps.push(link(route.repo, "apps", true), link("Apps", "apps"), here(appWord ?? "")); }
  return `<nav aria-label="Where you are" data-apps-crumb style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px;margin-bottom:16px">${steps.join(sep)}</nav>`;
}

const SUGGESTED = (): string => stateMark("Suggested", "var(--blue)", "ring", 12.5, "Suggested by the scan, not accepted. Nothing changes until you accept it.");

const CONN_KIND: Record<ConnectionStatus, StateKind> = { connected: "good", error: "bad", not_connected: "waiting", revoked: "stopped" };
const CONN_WORD: Record<ConnectionStatus, string> = { connected: "Connected", error: "Error", not_connected: "Not connected", revoked: "Revoked" };

// ── APPS ─────────────────────────────────────────────────────────────────────

function suggestionRow(d: RepoAppsSetupDTO, s: AppSuggestionDTO, ui: RepoAppsUi): string {
  const busy = ui.busy.includes(s.id);
  const host = s.provider ? providerWord(d, s.provider) : "no host";
  const evidence = s.evidence.map((e) => `<div style="font-size:12px;color:var(--fg-40);margin-top:4px;overflow-wrap:anywhere">${esc(e.text)}</div>`).join("");
  return `<li data-apps-suggestion="${attr(s.id)}" style="${ROW}">
    <span style="padding-top:2px;flex:none">${SUGGESTED()}</span>
    <div style="flex:1 1 360px;min-width:0">
      <div style="display:flex;align-items:baseline;gap:6px 10px;flex-wrap:wrap"><span style="font-size:13.5px;font-weight:600">${esc(s.key)}</span>${CODE(folderWord(s.folder))}<span style="font-size:12px;color:var(--fg-55);white-space:nowrap">${esc(s.kind)} · ${esc(host)}</span></div>
      ${evidence}
    </div>
    <div style="display:flex;gap:8px;flex:none;margin-left:auto;align-items:center">
      ${quietBtn("Ignore", "orgAppsIgnore", { arg: s.id, disabled: busy, field: `orgAppsIgnore:${s.id}`, label: `Ignore the suggested ${s.key}` })}
      ${quietBtn(busy ? "Working…" : "Accept", "orgAppsAccept", { arg: s.id, disabled: busy, busy, field: `orgAppsAccept:${s.id}`, label: `Accept ${s.key}`, extra: "border-color:var(--border-strong);color:var(--fg)" })}
    </div>
  </li>`;
}

function appRow(d: RepoAppsSetupDTO, a: SetupApp): string {
  return `<li data-apps-app="${attr(a.key)}" style="border-bottom:1px solid var(--border);margin-bottom:-1px">
    <button type="button" data-act="orgAppsGo" data-arg="${attr(`app:${a.key}`)}" data-field="${attr(`orgAppsOpen:${a.key}`)}" class="cnpy-rowbtn" style="display:flex;align-items:center;gap:6px 14px;flex-wrap:wrap;width:100%;padding:13px 16px;text-align:left;color:var(--fg)">
      <span style="font-size:13.5px;font-weight:600;min-width:90px">${esc(a.label)}</span>
      <span style="min-width:120px">${CODE(folderWord(a.folder))}</span>
      <span style="font-size:12.5px;color:var(--fg-70);white-space:nowrap;min-width:150px">${esc(a.kind)} · ${esc(appHost(d, a))}</span>
      <span data-apps-targets style="font-size:12px;color:var(--fg-40);flex:1 1 200px;min-width:0">${esc(targetsLine(d, a))}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2.4" aria-hidden="true" style="flex:none"><path d="M9 6l6 6-6 6"></path></svg>
    </button>
  </li>`;
}

function unassignedRow(d: RepoAppsSetupDTO, s: SeenSignal): string {
  return `<li data-apps-unassigned="${attr(signalKey(s))}" style="${ROW};align-items:center">
    <span style="font-size:13px;font-weight:600;font-family:var(--code);overflow-wrap:anywhere">${esc(s.name)}</span>
    <span style="font-size:12px;color:var(--fg-55)">${esc(signalSource(d, s))}</span>
    <span style="font-size:12px;color:var(--fg-40)">seen ${esc(times(s.count))} · last ${esc(relTime(s.lastAt) || "—")}</span>
    <span style="margin-left:auto">${quietBtn("Make an app", "orgAppsGo", { arg: `new:${signalKey(s)}`, field: `orgAppsMake:${signalKey(s)}`, label: `Make an app from ${s.name}` })}</span>
  </li>`;
}

function appsList(route: OrgRepoRoute, d: RepoAppsSetupDTO, ui: RepoAppsUi): string {
  const pending = d.suggestions.filter((s) => s.state === "pending");
  const n = d.apps.length;
  const anyBusy = ui.busy.length > 0;
  const actions = `${quietBtn(ui.scanning ? "Scanning…" : "Scan again", "orgAppsScan", { disabled: ui.scanning, busy: ui.scanning, field: "orgAppsScan" })}
    ${quietBtn("Add an app", "orgAppsGo", { arg: "new", field: "orgAppsNew" })}
    ${accentBtn(pending.length ? `Accept all ${pending.length}` : "Accept all", "orgAppsAcceptAll", { disabled: pending.length === 0 || anyBusy, field: "orgAppsAcceptAll" })}`;
  const lead = tabLead(`${B(String(n))} ${n === 1 ? "app" : "apps"}${pending.length
    ? ` &middot; Trov found ${B(String(pending.length))} more in this repo. Nothing changes until you accept them.`
    : d.scan.scannedAt ? " &middot; Trov found nothing more in this repo." : " &middot; This repo has not been scanned yet."}`, `<div style="display:flex;gap:8px;flex-wrap:wrap">${actions}</div>`);
  const scanned = d.scan.scannedAt ? `scanned ${esc(relTime(d.scan.scannedAt))} · from config files and deploys seen in ${SIGNAL_WINDOW_DAYS} days` : "not scanned yet";
  const scanError = d.scan.error ? `<div role="status" data-apps-scan-error style="${O_HELP};color:var(--fg-55);margin:0 0 10px">The last scan could not run: ${esc(d.scan.error)}</div>` : "";
  const degraded = d.degraded ? `<div role="status" data-apps-degraded style="${O_HELP};color:var(--fg-55);margin:0 0 14px">Part of this page could not be read just now: what the scan found may be missing. Reload to try again.</div>` : "";
  const suggestions = pending.length ? `<section aria-labelledby="org-apps-sugg-t" data-apps-group="suggestions">
      ${orgHead("Suggestions", scanned, pending.length, "org-apps-sugg-t")}${scanError}
      <ul${surface(LIST)}>${pending.map((s) => suggestionRow(d, s, ui)).join("")}</ul>
    </section>` : `<section aria-labelledby="org-apps-sugg-t" data-apps-group="suggestions">${orgHead("Suggestions", scanned, 0, "org-apps-sugg-t")}${scanError}
      <div data-apps-nosugg style="font-size:12.5px;color:var(--fg-55);padding:2px 0 4px">${d.scan.looked.length
        ? `Nothing to suggest. Trov looked for ${esc(listed(d.scan.looked.slice(0, 6)))}${d.scan.looked.length > 6 ? " and more" : ""} and at the deploys GitHub reported.`
        : "Nothing to suggest yet."} Add an app by hand if it ships some other way.</div>
    </section>`;
  const apps = `<section aria-labelledby="org-apps-apps-t" data-apps-group="apps" style="margin-top:30px">
      ${orgHead("Apps", "", n, "org-apps-apps-t")}
      ${n ? `<ul${surface(LIST)}>${d.apps.map((a) => appRow(d, a)).join("")}</ul>`
        : `<div data-apps-none style="font-size:12.5px;color:var(--fg-55);padding:2px 0 4px">No app in ${esc(route.repo)} yet. Accept a suggestion, or add an app by hand.</div>`}
    </section>`;
  const un = d.unassigned;
  const unassigned = un.length ? `<section aria-labelledby="org-apps-un-t" data-apps-group="unassigned" style="margin-top:30px">
      ${orgHead("Unassigned deploy names", `${un.length} deploy ${un.length === 1 ? "name belongs" : "names belong"} to no app`, un.length, "org-apps-un-t")}
      <ul${surface(LIST)}>${un.map((s) => unassignedRow(d, s)).join("")}</ul>
    </section>` : "";
  return `${lead}${degraded}${suggestions}${apps}${unassigned}`;
}

// ── an APP ───────────────────────────────────────────────────────────────────

/** What stops an app draft from saving, by field. */
export function draftProblems(dr: Pick<AppDraft, "label" | "folder" | "watch">): Record<string, string> {
  const out: Record<string, string> = {};
  if (!dr.label.trim()) out.label = "";
  else if (dr.label.trim().length > 60) out.label = "At most 60 characters.";
  if (/(^|\/)\.\.(\/|$)/.test(dr.folder) || dr.folder.length > 200) out.folder = "A folder inside the repository, at most 200 characters.";
  if (dr.watch.length > 20) out.watch = "At most 20 paths.";
  return out;
}

function watchBlock(app: SetupApp, dr: AppDraft): string {
  const chips = dr.watch.map((w, i) => `<span data-apps-watch="${attr(w)}" style="display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 4px 0 10px;border:1px solid var(--border);border-radius:8px;font-family:var(--code);font-size:12px;color:var(--fg-70);max-width:100%;box-sizing:border-box"><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w)}</span><button type="button" data-act="orgAppsWatchDel" data-arg="${i}" aria-label="${attr(`Remove ${w}`)}" ${dr.saving || dr.watch.length <= 1 ? "disabled " : ""}class="cnpy-iconbtn" style="width:22px;height:22px;display:grid;place-items:center;border-radius:6px;color:var(--fg-40)"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"></path></svg></button></span>`).join("");
  const err = dr.errorField === "watch" && dr.error ? `<div role="alert" style="${O_ERR}">${esc(dr.error)}</div>` : "";
  return `<div class="cnpy-org-field" style="margin-top:16px">
      <div id="org-apps-watch-l" style="${O_LABEL}">Watch paths</div>
      <div role="group" aria-labelledby="org-apps-watch-l" style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:7px">${chips}
        <input id="org-apps-watch" data-act="orgAppsWatchDraft" data-field="orgAppsWatchDraft" data-enter="orgAppsWatchAdd" value="${attr(dr.watchDraft)}" placeholder="packages/db/**" aria-label="A path to add" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200"${dr.saving ? " disabled" : ""} class="cnpy-input" style="${O_FIELD};width:200px;height:30px;font-family:var(--code);font-size:12px" />
        ${quietBtn("Add a path", "orgAppsWatchAdd", { disabled: dr.saving || !dr.watchDraft.trim() || dr.watch.length >= 20, field: "orgAppsWatchAdd", extra: "height:30px" })}
      </div>
      ${err}
      <div style="${O_HELP}">A pull request or commit that touches any of these belongs to ${esc(app.label)}.</div>
    </div>`;
}

/** A part's row as Hosting draws it (status, last poll, Test this part, Edit) — handed in by org-settings.ts, "" when
 *  Hosting's read is not in yet. */
export type PartRowFn = (env: string, key: string) => string;

function targetRow(d: RepoAppsSetupDTO, app: SetupApp, env: { key: string; label: string; branch: string }, dr: AppDraft, dd: DropdownUi, partRow: PartRowFn | null): string {
  const part = partIn(app, env.key);
  const head = `<div style="min-width:120px"><div style="font-size:13.5px;font-weight:600">${esc(env.label)}</div><code style="font-family:var(--code);font-size:11.5px;color:var(--fg-55)">${esc(env.branch)}</code></div>`;
  const ref = `${env.key}/${app.key}`;
  let how: string;
  let action: string;
  const hosted = part && !viaGithub(d, part.provider) ? partRow?.(env.key, app.key) ?? "" : "";
  if (hosted) {
    // A part on a host: Hosting's own row — THE status function's mark, its last poll, Test this part, Edit.
    return `<li data-apps-target="${attr(env.key)}" style="display:flex;align-items:flex-start;gap:0 14px;flex-wrap:wrap;padding-left:16px;border-bottom:1px solid var(--border);margin-bottom:-1px">
      <div style="padding:13px 0;flex:none">${head}</div><ul style="${LIST};flex:1 1 320px;min-width:0">${hosted}</ul></li>`;
  }
  if (part && !viaGithub(d, part.provider)) {
    // A part on a host: who runs it, its connection (THE status function's word), and the part editor.
    const id = Object.values(part.settings).find(Boolean) ?? "";
    how = `<div style="display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;font-size:12.5px;color:var(--fg-70)"><span>${esc(providerWord(d, part.provider))}${id ? ` &middot; ${CODE(id)}` : ""}</span>${kindMark(CONN_WORD[part.connection], CONN_KIND[part.connection], 12)}</div>`;
    action = quietBtn("Edit", "orgHxPartEdit", { arg: ref, field: `orgHxPartEdit:${ref}`, label: `Edit ${env.label} › ${app.label}` });
  } else {
    const picker = signalDropdown(d, app, env.key, dr);
    const now = part && !currentSignal(d, part) ? `<div data-apps-stale style="${O_HELP}">Now: ${esc(settingWord(part.settings))}, not seen in the last ${SIGNAL_WINDOW_DAYS} days.</div>` : "";
    how = `<div style="min-width:0;flex:1 1 260px" data-apps-signal="${attr(env.key)}">${dropdown(picker, dd)}${now}</div>`;
    action = part
      ? quietBtn("Edit", "orgHxPartEdit", { arg: ref, field: `orgHxPartEdit:${ref}`, label: `Edit ${env.label} › ${app.label}` })
      : quietBtn("Add part", "orgHxPartNew", { arg: `${env.key}||${app.key}`, field: `orgHxPartNew:${env.key}`, label: `Add a part of ${app.label} to ${env.label}` });
  }
  return `<li data-apps-target="${attr(env.key)}" style="${ROW};align-items:center">${head}<div style="flex:1 1 280px;min-width:0;display:flex;align-items:center">${how}</div><span style="flex:none;margin-left:auto">${action}</span></li>`;
}
function appView(d: RepoAppsSetupDTO, app: SetupApp, dr: AppDraft, dd: DropdownUi, partRow: PartRowFn | null): string {
  const problems = draftProblems(dr);
  const errOf = (f: string): string | null => (dr.errorField === f && dr.error ? dr.error : problems[f] || null);
  const role = APP_KIND_ROLE[dr.kind];
  const envs = d.environments ?? [];
  const n = app.parts.length;
  const lead = tabLead(`${B(app.label)} ships from ${CODE(folderWord(app.folder))} to ${B(String(n))} ${n === 1 ? "target" : "targets"}. Changes apply on save; the Repo screen redraws from them.`,
    `<div style="display:flex;gap:8px;align-items:center">${dangerLink("Remove app", "orgConfirm", { arg: `app:${app.key}`, disabled: dr.saving, field: `orgConfirm:app:${app.key}` })}${accentBtn(dr.saving ? "Saving…" : "Save", "orgAppsSave", { disabled: dr.saving || Object.keys(problems).length > 0, busy: dr.saving, field: "orgAppsSave" })}</div>`);
  const general = dr.error && (dr.errorField === null || !["label", "folder", "watch", "release_signal", "kind"].includes(dr.errorField))
    ? `<div role="alert" style="${O_ERR};margin:0 0 14px">${esc(dr.error)}</div>` : "";
  const noHost = n === 0 || role === null;
  const release = noHost ? `<div class="cnpy-org-field" style="margin-top:16px" data-apps-release>
      <div id="org-apps-release-l" style="${O_LABEL}">How a release shows up</div>
      <div style="margin-top:7px;max-width:420px">${dropdown(releaseDropdown(d, "org-apps-release", dr.release, app.releaseSignal, dr.saving), dd)}</div>
      <div style="${O_HELP}">${role === null ? "A package ships as releases, not to a URL." : "This app has no host yet: Trov can follow its releases instead."}</div>
    </div>` : "";
  const form = `<section aria-labelledby="org-apps-app-t" data-apps-group="app">
      ${orgHead("App", "", null, "org-apps-app-t")}
      <div${surface("padding:16px")}>
        <div class="cnpy-org-grid">
          ${textField({ id: "org-apps-label", label: "Name", act: "orgAppsLabel", field: "orgAppsLabel", value: dr.label, max: 60, disabled: dr.saving, enter: "orgAppsSave", error: errOf("label"), help: `Key <code style="font-family:var(--code)">${esc(app.key)}</code>: every part of this app carries it.` })}
          ${textField({ id: "org-apps-folder", label: "Folder", act: "orgAppsFolder", field: "orgAppsFolder", value: dr.folder, max: 200, disabled: dr.saving, enter: "orgAppsSave", error: errOf("folder"), placeholder: "apps/web", help: "Where it lives in the repository; / is the root." })}
        </div>
        <div class="cnpy-org-field" style="margin-top:16px"><div style="${O_LABEL}">Kind</div>
          <div style="margin-top:7px">${segmented({ id: "org-apps-kind", ariaLabel: "Kind", act: "orgAppsKind", value: dr.kind, size: "sm", inertOn: true, options: APP_KINDS.map((k) => ({ value: k, label: k })) })}</div>
          <div style="${O_HELP}">${esc(KIND_HINT[dr.kind])}</div>
        </div>
        ${watchBlock(app, dr)}
        ${release}
      </div>
    </section>`;
  const targets = role === null ? `<section aria-labelledby="org-apps-tg-t" data-apps-group="targets" style="margin-top:30px">
      ${orgHead("Targets", "", 0, "org-apps-tg-t")}
      <div data-apps-notargets style="font-size:12.5px;color:var(--fg-55)">${esc(targetsLine(d, app))}. A package is not deployed on its own.</div>
    </section>`
    : `<section aria-labelledby="org-apps-tg-t" data-apps-group="targets" style="margin-top:30px">
      ${orgHead("Targets", "how Trov sees a deploy in each environment", n, "org-apps-tg-t")}
      ${envs.length ? `<ul${surface(LIST)}>${envs.map((e) => targetRow(d, app, e, dr, dd, partRow)).join("")}</ul>`
        : `<div data-apps-noenvs style="font-size:12.5px;color:var(--fg-55)">No environment yet. ${quietBtn("Open Environments", "orgTab", { arg: "environments" })}</div>`}
      <div style="${O_HELP}">Only deploys GitHub reported in the last ${SIGNAL_WINDOW_DAYS} days are offered. An environment holds at most ${MAX_PARTS_PER_ENVIRONMENT} parts.</div>
    </section>`;
  return `${lead}${general}${form}${targets}`;
}

const KIND_HINT: Record<AppKind, string> = {
  Site: "Serves pages to people: Trov reads requests, errors and latency.",
  Worker: "Serves requests at the edge: Trov reads requests, errors and latency.",
  Service: "A server that runs: Trov reads CPU and memory.",
  Job: "Runs on a schedule or a queue: Trov reads CPU and memory.",
  Package: "Never deployed on its own: it ships as releases, inside the apps that use it.",
};

// ── ADD AN APP ───────────────────────────────────────────────────────────────

/** What stops a new app from being added, by field. `taken` = the keys already in use. */
export function addProblems(a: Pick<AddDraft, "key" | "folder">, taken: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const key = a.key.trim();
  if (!key) out.key = "";
  else if (!PART_KEY_RE.test(key)) out.key = "1 to 32 characters: a to z, 0 to 9, - or _.";
  else if (taken.includes(key)) out.key = `An app called ${key} exists already.`;
  if (/(^|\/)\.\.(\/|$)/.test(a.folder) || a.folder.length > 200) out.folder = "A folder inside the repository, at most 200 characters.";
  return out;
}

function addView(route: OrgRepoRoute, d: RepoAppsSetupDTO, a: AddDraft, dd: DropdownUi): string {
  const problems = addProblems(a, d.apps.map((x) => x.key));
  const errOf = (f: string): string | null => (a.errorField === f && a.error ? a.error : problems[f] || null);
  const nothing = d.suggestions.filter((s) => s.state === "pending").length === 0 && d.signals.length === 0;
  const lead = tabLead(nothing
    ? `Trov found no deploy config in ${B(route.repo)} and no host reports to GitHub. Describe the app and how a release shows up, and the Repo screen picks it up.`
    : `Describe an app of ${B(route.repo)} the scan did not find. The Repo screen picks it up once it is added.`);
  const general = a.error && (a.errorField === null || !["key", "folder", "kind", "release_signal"].includes(a.errorField)) ? `<div role="alert" style="${O_ERR};margin-top:12px">${esc(a.error)}</div>` : "";
  return `${lead}<div${surface("padding:16px;max-width:820px")} data-apps-add>
      <div class="cnpy-org-grid">
        ${textField({ id: "org-apps-add-key", label: "Name", act: "orgAppsAddKey", field: "orgAppsAddKey", value: a.key, max: 32, required: true, disabled: a.saving, enter: "orgAppsAddSave", error: errOf("key"), placeholder: "mobile", help: "Its permanent key: lowercase letters, digits, - or _." })}
        ${textField({ id: "org-apps-add-folder", label: "Folder", act: "orgAppsAddFolder", field: "orgAppsAddFolder", value: a.folder, max: 200, disabled: a.saving, enter: "orgAppsAddSave", error: errOf("folder"), placeholder: "/" })}
      </div>
      <div class="cnpy-org-field" style="margin-top:16px"><div style="${O_LABEL}">Kind</div>
        <div style="margin-top:7px">${segmented({ id: "org-apps-add-kind", ariaLabel: "Kind", act: "orgAppsAddKind", value: a.kind, size: "sm", inertOn: true, options: APP_KINDS.map((k) => ({ value: k, label: k })) })}</div>
        <div style="${O_HELP}">${esc(KIND_HINT[a.kind])}</div>
      </div>
      <div style="height:1px;background:var(--border);margin:18px 0"></div>
      <div class="cnpy-org-field"><div id="org-apps-add-release-l" style="${O_LABEL}">How a release shows up</div>
        <div style="margin-top:7px;max-width:420px">${dropdown(releaseDropdown(d, "org-apps-add-release", a.release, null, a.saving), dd)}</div>
        <div style="${O_HELP}">Only tags and workflows GitHub reported are offered. Parts on a host are added on the app's page.</div>
      </div>
      ${general}
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        ${quietBtn("Cancel", "orgAppsGo", { arg: "apps", disabled: a.saving })}
        ${accentBtn(a.saving ? "Adding…" : "Add app", "orgAppsAddSave", { disabled: a.saving || Object.keys(problems).length > 0, busy: a.saving, field: "orgAppsAddSave" })}
      </div>
    </div>`;
}

// ── the page ─────────────────────────────────────────────────────────────────

/** One repository's page under Org settings › Repositories (admins): its Apps, one app, or Add an app. */
export function repoAppsPage(route: OrgRepoRoute, ui: RepoAppsUi, dd: DropdownUi = initialDropdownUi(), partRow: PartRowFn | null = null): string {
  const d = ui.repo === route.repo ? ui.setup.data : null;
  const app = d && route.view === "app" ? d.apps.find((a) => a.key === route.app) ?? null : null;
  const head = crumb(route, route.view === "new" ? "Add an app" : app?.label ?? route.app ?? "");
  if (!d) {
    return `${head}${ui.setup.status === "error" && ui.repo === route.repo ? failedNote("the apps of this repository", "orgAppsReload") : loadingNote("apps", { rows: 3 })}`;
  }
  if (route.view === "new") return `${head}${addView(route, d, ui.add ?? blankAdd(), dd)}`;
  if (route.view === "app") {
    if (!app) return `${head}<div data-apps-gone style="font-size:13px;color:var(--fg-55)">There is no app ${CODE(route.app ?? "")} in ${esc(route.repo)}. ${quietBtn("Back to its apps", "orgAppsGo", { arg: "apps" })}</div>`;
    return `${head}${appView(d, app, ui.draft && ui.draft.key === app.key ? ui.draft : draftOf(app), dd, partRow)}`;
  }
  return `${head}${appsList(route, d, ui)}`;
}

export const blankAdd = (key = ""): AddDraft => ({ key, folder: "/", kind: "Site", release: "", saving: false, error: null, errorField: null });

/** An app's page as stored (the draft starts here). */
export function draftOf(app: SetupApp): AppDraft {
  return {
    key: app.key, label: app.label, folder: app.folder, kind: app.kind, watch: [...app.watch], watchDraft: "", release: app.releaseSignal ?? "",
    picks: {}, saving: false, error: null, errorField: null,
  };
}

/** The dropdowns on the page on screen — what `orgOverlays` renders the open menu from. */
export function repoAppsDropdowns(route: OrgRepoRoute, ui: RepoAppsUi): DropdownProps[] {
  const d = ui.repo === route.repo ? ui.setup.data : null;
  if (!d) return [];
  if (route.view === "new") return [releaseDropdown(d, "org-apps-add-release", (ui.add ?? blankAdd()).release, null, !!ui.add?.saving)];
  if (route.view !== "app") return [];
  const app = d.apps.find((a) => a.key === route.app);
  if (!app) return [];
  const dr = ui.draft && ui.draft.key === app.key ? ui.draft : draftOf(app);
  const out: DropdownProps[] = [];
  if (APP_KIND_ROLE[dr.kind] !== null) {
    for (const e of d.environments ?? []) {
      const part = partIn(app, e.key);
      if (!part || viaGithub(d, part.provider)) out.push(signalDropdown(d, app, e.key, dr));
    }
  }
  if (app.parts.length === 0 || APP_KIND_ROLE[dr.kind] === null) out.push(releaseDropdown(d, "org-apps-release", dr.release, app.releaseSignal, dr.saving));
  return out;
}

/** The Remove confirmation's words, and its one choice (keep the parts — the default — or remove them too). */
export function appRemoveCopy(ui: RepoAppsUi, key: string): { title: string; body: string; confirmLabel: string; busyLabel: string; detail: string } | null {
  const d = ui.setup.data;
  const app = d?.apps.find((a) => a.key === key);
  if (!d || !app) return null;
  const n = app.parts.length;
  const synthesised = app.source === "synthesised";
  const remove = synthesised || ui.removeParts;
  const body = `Trov stops showing ${app.label}’s deploys, previews and usage on the Repo screen. Its pull requests and commits stay in Code.${
    n === 0 ? " Its deploy name goes back to unassigned, so you can add it again later." : ""}`;
  const choice = n === 0 ? "" : synthesised
    ? `<div data-apps-rm-parts style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:10px">${esc(app.label)} is read from its ${n === 1 ? "part" : `${n} parts`}: ${n === 1 ? "it goes" : "they go"} with it, with ${n === 1 ? "its" : "their"} deploy history.</div>`
    : `<div data-apps-rm-parts style="margin-top:12px"><div style="font-size:12.5px;color:var(--fg-70);margin-bottom:7px">Its ${n === 1 ? "part" : `${n} parts`} in ${esc(listed([...new Set(app.parts.map((p) => d.environments?.find((e) => e.key === p.env)?.label ?? p.env))]))}</div>
        ${segmented({ id: "org-apps-rm-parts", ariaLabel: "Its parts", act: "orgAppsRemoveParts", value: remove ? "remove" : "keep", size: "sm", inertOn: true, options: [{ value: "keep", label: "Keep them" }, { value: "remove", label: "Remove them too" }] })}
        <div style="${O_HELP}">${remove ? `Their deploy history goes with them, and the deploy ${n === 1 ? "name goes" : "names go"} back to unassigned.` : `They stay in their environments and keep reading: ${esc(app.label)} then reads as an app at the root of the primary repository.`}</div>
      </div>`;
  return { title: `Remove ${app.label}?`, body, confirmLabel: "Remove app", busyLabel: "Removing…", detail: choice };
}

/** The settings a picked signal writes to a `github` part (null: a signal no setting can name). */
export function settingsForPick(d: RepoAppsSetupDTO, key: string): Record<string, string> | null {
  const s = pickableSignals(d.signals).find((x) => signalKey(x) === key);
  return s ? signalSettings(s) : null;
}
