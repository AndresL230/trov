// Org settings › Repositories › a repo › Apps — the controller behind web/src/repo-apps.ts: every `orgApps…` act
// (org-actions.ts hands them over), the one read (`GET …/repos/:owner/:name/apps`), the app writes, and the scan's
// own routes (Scan again, a suggestion's accept / ignore / undo — Phase D1's, called from here).
//
// A write that a person may want back says so in a toast with Undo for 5 seconds (accept, accept all, ignore,
// remove): the toast's button is a `data-act` like any other (`orgAppsUndo`), whose arg names a closure kept here —
// never a token in the markup. Parts are #185's: the part editor is hosting-actions.ts's (`orgHxPartNew` /
// `orgHxPartEdit`), opened prefilled with the app key; a part write reloads this page through org-actions.ts.

import type { AppState, ToastAction } from "./render";
import {
  ApiError, OrgApiError, Unauthorized, rateLimitText,
  acceptRepoSuggestion, deleteRepoAppSetup, getRepoAppsSetup, ignoreRepoSuggestion, putEnvironmentPart, putRepoAppSetup, scanRepoNow, undoRepoSuggestion,
  type RepoAppBody,
} from "./api";
import { currentOrg, roleAtLeast } from "./org-settings";
import { hashForRoute, type OrgRepoRoute } from "./hash";
import { addProblems, blankAdd, draftOf, draftProblems, keyForSignal, settingsForPick, type AppDraft, type RepoAppsUi, type SetupApp } from "./repo-apps";
import { relTime } from "./ui";
import { APP_KIND_ROLE, isAppKind } from "@shared/repo-apps-core";
import { signalKey } from "@shared/repo-apps-setup-core";
import type { RepoAppsSetupDTO } from "@shared/repo-scan-core";

export interface AppsHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number, action?: ToastAction | null): void;
  unauth(e: unknown): void;
  /** Read Hosting's setup again (the part editor draws from it, and an accept writes parts). */
  loadHosting(): void;
  /** Move the address bar to a page without a reload (a history entry, so Back returns). Injected for tests. */
  push?(hash: string): void;
}

export interface AppsActions {
  /** Run one `orgApps…` act; false when the act is not one of them. */
  act(name: string, arg: string | null, value: string | null): boolean;
  /** The route moved onto (or within) a repository's page: read what it needs. */
  enter(): void;
  /** Read the page's repository again (after a part write elsewhere). */
  reload(): void;
  /** The confirmation said yes: remove the app `key`. */
  runConfirm(key: string, done: (msg: string, ms?: number, action?: ToastAction | null) => void, failed: (e: unknown, fallback: string) => void): void;
}

/** How long a toast with Undo stays up. */
export const APPS_UNDO_MS = 5000;

const sentence = (s: string): string => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
};

/** A refusal as words that say what to do next (the server's own sentence names a rule, never a value). */
export function appsErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  const limited = rateLimitText(e);
  if (limited) return limited;
  const detail = e instanceof OrgApiError ? e.detail : null;
  switch (e.message) {
    case "forbidden": return "Only an admin or an owner of this organization can set up its apps.";
    case "not_found": return "That no longer exists. Reload the page.";
    case "app_conflict": return detail ? sentence(detail) : "That key belongs to an app of another repository.";
    case "key_taken": return "An app or a part already has this suggestion's key. Rename or remove that one first, or add this app by hand under another name.";
    case "too_many_parts": return "This environment already has 6 parts, the most one can have.";
    case "internal": return `${fallback} Something went wrong on the server. Try again in a minute.`;
    default: return detail ? sentence(detail) : `${fallback} Try again.`;
  }
}

export function createAppsActions(host: AppsHost): AppsActions {
  const { state, mount } = host;
  const u = (): RepoAppsUi => state.org.apps;
  const page = (): OrgRepoRoute | null => state.org.repoPage;
  const org = () => currentOrg(state);
  const admin = (): boolean => roleAtLeast(org()?.role, "admin");
  const rerender = (): void => host.rerender();
  const fail = (e: unknown): boolean => { if (e instanceof Unauthorized) { host.unauth(e); return true; } return false; };
  const data = (): RepoAppsSetupDTO | null => { const p = page(); return p && u().repo === p.repo ? u().setup.data : null; };
  const push = (hash: string): void => {
    if (host.push) { host.push(hash); return; }
    if (location.hash !== hash) history.pushState(null, "", hash);
  };

  // ── Undo: closures by id, so the toast's button carries an id and nothing else ──
  const undos = new Map<string, () => Promise<unknown>>();
  let undoSeq = 0;
  const withUndo = (msg: string, run: (() => Promise<unknown>) | null): void => {
    if (!run) { host.flash(msg, APPS_UNDO_MS); return; }
    const id = `u${++undoSeq}`;
    undos.set(id, run);
    setTimeout(() => undos.delete(id), APPS_UNDO_MS + 1000);
    host.flash(msg, APPS_UNDO_MS, { label: "Undo", act: "orgAppsUndo", arg: id });
  };

  // ── the read ───────────────────────────────────────────────────────────────
  function load(): Promise<void> {
    const o = org();
    const p = page();
    if (!o || !p || !admin()) return Promise.resolve();
    const ui = u();
    const repo = p.repo;
    if (ui.repo !== repo) { ui.repo = repo; ui.setup = { status: "loading", data: null }; ui.draft = null; ui.add = null; ui.busy = []; }
    else if (ui.setup.status !== "ok") ui.setup = { status: "loading", data: ui.setup.data };
    const slug = o.slug;
    return getRepoAppsSetup(slug, repo)
      .then((d) => {
        if (state.org.slug !== slug || u().repo !== repo) return;
        // The server answers with the canonical name: keep the page's route on it.
        u().setup = { status: "ok", data: d };
        rerender();
      })
      .catch((e) => {
        if (fail(e) || u().repo !== repo) return;
        u().setup = { status: "error", data: u().setup.data, error: e instanceof Error ? e.message : String(e) };
        rerender();
      });
  }
  function enter(): void {
    const p = page();
    if (!p || !admin()) return;
    if (u().repo !== p.repo || u().setup.status === "idle" || u().setup.status === "error") void load();
    if (!state.org.hosting.setup.data && state.org.hosting.setup.status !== "loading") host.loadHosting();
    if (p.view === "new" && !u().add) u().add = blankAdd();
  }

  // ── moving between the pages ───────────────────────────────────────────────
  function go(next: OrgRepoRoute | null): void {
    const prev = page();
    state.screen = "org";
    state.org.tab = "repos";
    state.org.repoPage = next;
    if (!next || next.view !== "app" || prev?.app !== next.app) u().draft = null;
    if (!next || next.view !== "new") u().add = null;
    push(hashForRoute({ screen: "org", ticketId: null, sprintId: null, orgTab: "repos", ...(next ? { orgRepo: next } : {}) }));
    enter();
    rerender();
    document.getElementById("cnpy-main")?.scrollTo?.(0, 0);
  }
  function goArg(arg: string): void {
    const p = page();
    if (arg === "") { go(null); return; }
    if (arg.startsWith("repo:")) { go({ repo: arg.slice(5), view: "apps" }); return; }
    if (!p) return;
    if (arg === "apps") { go({ repo: p.repo, view: "apps" }); return; }
    if (arg.startsWith("app:")) { go({ repo: p.repo, view: "app", app: arg.slice(4) }); return; }
    if (arg === "new" || arg.startsWith("new:")) {
      // "Make an app" from an unassigned name: the name, prefilled.
      const s = arg.startsWith("new:") ? data()?.signals.find((x) => signalKey(x) === arg.slice(4)) ?? null : null;
      go({ repo: p.repo, view: "new" });
      u().add = blankAdd(s ? keyForSignal(s) : "");
      rerender();
      mount.querySelector<HTMLElement>("#org-apps-add-key")?.focus();
    }
  }

  // ── the scan and the suggestions ───────────────────────────────────────────
  const pendingIds = (d: RepoAppsSetupDTO | null): string[] => (d?.suggestions ?? []).filter((s) => s.state === "pending").map((s) => s.id);
  function scan(): void {
    const o = org(), p = page(), ui = u();
    if (!o || !p || ui.scanning) return;
    const before = new Set(pendingIds(data()));
    const lastAt = data()?.scan.scannedAt ?? null;
    ui.scanning = true;
    rerender();
    scanRepoNow(o.slug, p.repo)
      .then(() => load())
      .then(() => {
        u().scanning = false;
        const after = pendingIds(data());
        const fresh = after.filter((id) => !before.has(id)).length;
        const err = data()?.scan.error;
        host.flash(err ? `Scanned ${p.repo}, but the scan could not finish: ${err}`
          : fresh ? `Scanned ${p.repo}. Found ${fresh} new ${fresh === 1 ? "app" : "apps"} to review.`
          : `Scanned ${p.repo}. Nothing new${lastAt ? ` since ${relTime(lastAt)}` : ""}.`, err ? 6000 : 3200);
        rerender();
      })
      .catch((e) => { u().scanning = false; if (fail(e)) return; host.flash(appsErrorText(e, "Couldn't scan the repository."), 6000); rerender(); });
  }

  const keyOf = (id: string): string => data()?.suggestions.find((s) => s.id === id)?.key ?? "the app";
  const afterWrite = (): void => { void load(); host.loadHosting(); };

  function accept(id: string): void {
    const o = org(), p = page(), ui = u();
    if (!o || !p || ui.busy.includes(id)) return;
    const key = keyOf(id);
    ui.busy = [...ui.busy, id];
    rerender();
    acceptRepoSuggestion(o.slug, p.repo, id)
      .then((r) => {
        u().busy = u().busy.filter((x) => x !== id);
        const token = r?.undo;
        withUndo(`Accepted ${key}. The Repo screen now shows it.`, token ? () => undoRepoSuggestion(o.slug, p.repo, token) : null);
        afterWrite();
      })
      .catch((e) => { u().busy = u().busy.filter((x) => x !== id); if (fail(e)) return; host.flash(appsErrorText(e, `Couldn't accept ${key}.`), 6000); void load(); });
  }
  async function acceptAll(): Promise<void> {
    const o = org(), p = page(), ui = u();
    const ids = pendingIds(data());
    if (!o || !p || !ids.length || ui.busy.length) return;
    ui.busy = [...ids];
    rerender();
    const tokens: string[] = [];
    let failed: unknown = null;
    for (const id of ids) {
      try { const r = await acceptRepoSuggestion(o.slug, p.repo, id); if (r?.undo) tokens.push(r.undo); }
      catch (e) { failed = e; break; }
    }
    u().busy = [];
    if (failed && fail(failed)) return;
    const n = failed ? tokens.length : ids.length;
    const undo = tokens.length ? async () => { for (const t of [...tokens].reverse()) await undoRepoSuggestion(o.slug, p.repo, t); } : null;
    if (failed) host.flash(`${appsErrorText(failed, `Accepted ${n} of ${ids.length}.`)}`, 6000);
    else withUndo(`Accepted ${n} ${n === 1 ? "app" : "apps"}. The Repo screen now shows ${n === 1 ? "it" : "them"}.`, undo);
    afterWrite();
  }
  function ignore(id: string): void {
    const o = org(), p = page(), ui = u();
    if (!o || !p || ui.busy.includes(id)) return;
    const key = keyOf(id);
    ui.busy = [...ui.busy, id];
    rerender();
    ignoreRepoSuggestion(o.slug, p.repo, id)
      .then((r) => {
        u().busy = u().busy.filter((x) => x !== id);
        const token = r && typeof r === "object" ? r.undo : undefined;
        withUndo(`Ignored ${key}. Scan again brings it back.`, token ? () => undoRepoSuggestion(o.slug, p.repo, token) : null);
        void load();
      })
      .catch((e) => { u().busy = u().busy.filter((x) => x !== id); if (fail(e)) return; host.flash(appsErrorText(e, `Couldn't ignore ${key}.`), 6000); void load(); });
  }
  function undo(id: string): void {
    const run = undos.get(id);
    if (!run) return;
    undos.delete(id);
    run().then(() => { host.flash("Undone."); afterWrite(); })
      .catch((e) => { if (fail(e)) return; host.flash(appsErrorText(e, "Couldn't undo it."), 6000); afterWrite(); });
  }

  // ── an app's page ──────────────────────────────────────────────────────────
  const appOnPage = (): SetupApp | null => { const p = page(); return p?.view === "app" ? data()?.apps.find((a) => a.key === p.app) ?? null : null; };
  /** The page's draft, made from the stored app on its first edit. */
  function draft(): AppDraft | null {
    const app = appOnPage();
    if (!app) return null;
    const ui = u();
    if (!ui.draft || ui.draft.key !== app.key) ui.draft = draftOf(app);
    return ui.draft;
  }
  const clear = (dr: { error: string | null; errorField: string | null }, field: string): void => { if (dr.errorField === field || dr.errorField === null) { dr.error = null; dr.errorField = null; } };

  function save(): void {
    const o = org(), p = page(), d = data(), app = appOnPage(), dr = draft();
    if (!o || !p || !d || !app || !dr || dr.saving || Object.keys(draftProblems(dr)).length) return;
    const body: RepoAppBody = { label: dr.label.trim(), folder: dr.folder.trim() || "/", kind: dr.kind, watch: dr.watch, release_signal: dr.release || null };
    // The deploy signals picked per environment: a `github` part's setting replaced, or one created for an
    // environment with no part. The host that learns its deploys from GitHub is named by the catalogue.
    const viaGithub = d.providers?.find((x) => x.via_github)?.id ?? null;
    const role = APP_KIND_ROLE[dr.kind];
    const parts: { env: string; write: Parameters<typeof putEnvironmentPart>[3] }[] = [];
    for (const [env, pick] of Object.entries(dr.picks)) {
      if (!pick || role === null) continue;
      const settings = settingsForPick(d, pick);
      if (!settings || !viaGithub) continue;
      const part = app.parts.find((x) => x.env === env);
      if (part) parts.push({ env, write: { provider: part.provider, role: part.role, settings } });
      else parts.push({ env, write: { provider: viaGithub, role, settings, label: dr.label.trim() } });
    }
    dr.saving = true; dr.error = null; dr.errorField = null;
    rerender();
    putRepoAppSetup(o.slug, p.repo, app.key, body)
      .then(async (r) => {
        for (const x of parts) await putEnvironmentPart(o.slug, x.env, app.key, x.write);
        u().draft = null;
        host.flash(`Saved ${r.app.label}. The Repo screen redraws from it.`);
        afterWrite();
        rerender();
      })
      .catch((e) => {
        const cur = u().draft;
        if (cur) cur.saving = false;
        if (fail(e)) return;
        if (cur) {
          const field = e instanceof OrgApiError ? e.field : null;
          cur.errorField = field && ["label", "folder", "watch", "release_signal", "kind"].includes(field) ? field : null;
          cur.error = appsErrorText(e, "Couldn't save the app.");
        }
        rerender();
        void load();
      });
  }

  // ── Add an app ─────────────────────────────────────────────────────────────
  function add(): void {
    const o = org(), p = page(), d = data(), a = u().add;
    if (!o || !p || !d || !a || a.saving || Object.keys(addProblems(a, d.apps.map((x) => x.key))).length) return;
    const key = a.key.trim();
    a.saving = true; a.error = null; a.errorField = null;
    rerender();
    putRepoAppSetup(o.slug, p.repo, key, { kind: a.kind, label: key, folder: a.folder.trim() || "/", release_signal: a.release || null })
      .then(() => {
        u().add = null;
        host.flash(`Added ${key} to ${p.repo}.${a.release ? ` Its Overview follows ${a.release.startsWith("tag:") ? "releases from tags" : "its workflow's runs"}.` : ""}`);
        go({ repo: p.repo, view: "app", app: key });
        void load();
      })
      .catch((e) => {
        const cur = u().add;
        if (cur) cur.saving = false;
        if (fail(e)) return;
        if (cur) {
          const field = e instanceof OrgApiError ? e.field : null;
          cur.errorField = field && ["key", "folder", "kind", "release_signal"].includes(field) ? field : null;
          cur.error = appsErrorText(e, "Couldn't add the app.");
        }
        rerender();
      });
  }

  // ── Remove (the page's confirmation said yes) ──────────────────────────────
  function runConfirm(key: string, done: (msg: string, ms?: number, action?: ToastAction | null) => void, failed: (e: unknown, fallback: string) => void): void {
    const o = org(), p = page(), d = data();
    const app = d?.apps.find((a) => a.key === key);
    if (!o || !p || !app) { done(""); return; }
    const removeParts = app.source === "synthesised" || u().removeParts;
    const before: RepoAppBody = { kind: app.kind, label: app.label, folder: app.folder, watch: app.watch, release_signal: app.releaseSignal };
    deleteRepoAppSetup(o.slug, p.repo, key, removeParts)
      .then((r) => {
        u().removeParts = false;
        done("");
        go({ repo: p.repo, view: "apps" });
        if (r.removed_parts.length) {
          // Its parts went with it: the deploy names they read are unassigned again. Their deploy history is gone,
          // so there is nothing exact to undo.
          withUndo(`Removed ${app.label}. Its deploy name is unassigned again.`, null);
        } else if (app.parts.length === 0) {
          withUndo(`Removed ${app.label}.`, () => putRepoAppSetup(o.slug, p.repo, key, before));
        } else {
          withUndo(`Removed ${app.label}. Its parts stay in their environments.`, () => putRepoAppSetup(o.slug, p.repo, key, before));
        }
        afterWrite();
      })
      .catch((e) => { u().removeParts = false; failed(e, `Couldn't remove ${app.label}.`); void load(); });
  }

  // ── acts ───────────────────────────────────────────────────────────────────
  function act(name: string, arg: string | null, value: string | null): boolean {
    if (!name.startsWith("orgApps")) return false;
    if (!admin()) return true;
    const ui = u();
    switch (name) {
      case "orgAppsGo": goArg(arg ?? ""); return true;
      case "orgAppsReload": void load(); return true;
      case "orgAppsScan": scan(); return true;
      case "orgAppsAccept": if (arg) accept(arg); return true;
      case "orgAppsAcceptAll": void acceptAll(); return true;
      case "orgAppsIgnore": if (arg) ignore(arg); return true;
      case "orgAppsUndo": if (arg) undo(arg); return true;
      // an app's page
      case "orgAppsLabel": { const dr = draft(); if (dr) { dr.label = value ?? ""; clear(dr, "label"); } break; }
      case "orgAppsFolder": { const dr = draft(); if (dr) { dr.folder = value ?? ""; clear(dr, "folder"); } break; }
      case "orgAppsKind": { const dr = draft(); if (dr && isAppKind(arg) && !dr.saving) { dr.kind = arg; clear(dr, "kind"); } break; }
      case "orgAppsWatchDraft": { const dr = draft(); if (dr) { dr.watchDraft = value ?? ""; clear(dr, "watch"); } break; }
      case "orgAppsWatchAdd": {
        const dr = draft();
        const v = dr?.watchDraft.trim() ?? "";
        if (!dr || !v || dr.saving || dr.watch.length >= 20) return true;
        if (!dr.watch.includes(v)) dr.watch = [...dr.watch, v];
        dr.watchDraft = "";
        rerender();
        mount.querySelector<HTMLElement>("#org-apps-watch")?.focus();
        return true;
      }
      case "orgAppsWatchDel": {
        const dr = draft();
        const i = Number(arg);
        if (dr && !dr.saving && Number.isInteger(i) && i >= 0 && i < dr.watch.length && dr.watch.length > 1) dr.watch = dr.watch.filter((_, j) => j !== i);
        break;
      }
      case "orgAppsRelease": { const dr = draft(); if (dr && !dr.saving) { dr.release = value ?? ""; clear(dr, "release_signal"); } break; }
      case "orgAppsSignal": { const dr = draft(); if (dr && arg && !dr.saving) dr.picks = { ...dr.picks, [arg]: value ?? "" }; break; }
      case "orgAppsSave": save(); return true;
      case "orgAppsRemoveParts": ui.removeParts = arg === "remove"; break;
      // Add an app
      case "orgAppsAddKey": if (ui.add) { ui.add.key = value ?? ""; clear(ui.add, "key"); } break;
      case "orgAppsAddFolder": if (ui.add) { ui.add.folder = value ?? ""; clear(ui.add, "folder"); } break;
      case "orgAppsAddKind": if (ui.add && isAppKind(arg) && !ui.add.saving) { ui.add.kind = arg; clear(ui.add, "kind"); } break;
      case "orgAppsAddRelease": if (ui.add && !ui.add.saving) { ui.add.release = value ?? ""; clear(ui.add, "release_signal"); } break;
      case "orgAppsAddSave": add(); return true;
      default: return true;
    }
    rerender();
    return true;
  }

  return { act, enter, reload: () => { if (page()) void load(); }, runConfirm };
}
