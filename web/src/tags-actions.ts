// The organization's tag list — the controller: every `tag…` act main.ts dispatches lands here, with
// the reads and writes behind them (the views are web/src/tags.ts, pure). The list itself
// (`state.tags`) is read once per org and again after every write, because the Feed's filter, the
// Unplaced picker, a doc's Tags row and Org settings › Tags all draw from it.
import type { AppState } from "./render";
import {
  ApiError, OrgApiError, Unauthorized, planLimitText,
  listOrgTags, getTagPage, addOrgTag, editOrgTag, mergeOrgTag, retireOrgTag, restoreOrgTag, resolveTagSuggestion, setItemTags,
  findTagItems, listTagFits, resolveTagFits, setTagSuggestions,
} from "./api";
import { currentOrg, roleAtLeast } from "./org-settings";
import { isTagPageTab, tagDraftProblem } from "./tags";
import { isTagColor, normalizeTagName } from "@shared/tags-core";

export interface TagsHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  /** The session expired: back to sign-in. */
  unauth(e: unknown): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** Open the Search screen on `q` (a decision has no page of its own). */
  search(q: string): void;
  /** The org's plan and use changed (a tag was added, retired or restored). */
  planChanged(): void;
  /** Open Org settings › Tags. */
  goList(): void;
}

export interface TagsController {
  /** Run one `tag…` act. */
  act(act: string, arg: string | null, value: string | null): void;
  /** Read the org's tag list (again). */
  load(): void;
  /** Read the list unless it is already here or on its way. */
  loadIfNeeded(): void;
  /** Open one tag's page. */
  open(name: string): void;
}

/** A refusal as words that say what to do next. */
export function tagErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  const detail = e instanceof OrgApiError ? e.detail : null;
  switch (e.message) {
    case "forbidden": return "Only an admin or an owner of this organization can change the tag list.";
    case "tag_exists": return "A tag with that name is already on the list.";
    case "tag_retired": return "A retired tag has that name. Restore it from the retired tags.";
    case "starter_tag": return "A starter tag can be renamed, but not retired or merged into another.";
    case "unknown_tag": return "That tag is not on the list any more. Reload the page.";
    case "not_found": return "That no longer exists. Reload the page.";
    case "internal": return `${fallback} Something went wrong on the server. Try again in a minute.`;
    default: return detail ? `${detail[0].toUpperCase()}${detail.slice(1)}${/[.!?]$/.test(detail) ? "" : "."}` : `${fallback} Try again.`;
  }
}

export function createTagsController(host: TagsHost): TagsController {
  const { state, mount } = host;
  const ui = () => state.tagsUi;
  const rerender = () => host.rerender();
  const admin = (): boolean => roleAtLeast(currentOrg(state)?.role, "admin");
  const fail = (e: unknown): boolean => { if (e instanceof Unauthorized) { host.unauth(e); return true; } return false; };
  const errorText = (e: unknown, fallback: string): string => {
    const plan = planLimitText(e, currentOrg(state)?.role ?? null);
    if (plan) host.planChanged();
    return plan ?? tagErrorText(e, fallback);
  };

  let seq = 0;
  // While a model run is going (it runs in the background, after the request that started it), the list
  // is read again every few seconds — the row then shows how many items may fit. At most POLL_MAX reads.
  const POLL_MS = 3000, POLL_MAX = 40;
  let polls = 0, pollTimer: ReturnType<typeof setTimeout> | null = null;
  const running = (): boolean => Object.values(state.tags.data?.fits ?? {}).some((f) => f.run?.status === "running");
  function poll(): void {
    if (pollTimer || polls >= POLL_MAX || !running() || state.view !== "app") return;
    pollTimer = setTimeout(() => { pollTimer = null; polls++; load(); }, POLL_MS);
  }
  function load(): void {
    const mine = ++seq;
    if (state.tags.status !== "ok") state.tags = { status: "loading", data: state.tags.data };
    listOrgTags()
      .then((data) => {
        if (mine !== seq) return;
        state.tags = { status: "ok", data };
        if (running()) poll(); else polls = 0;
        // The open review list follows what the run found.
        const open = ui().fitsOpen;
        if (open && !(data.fits?.[open]?.open)) ui().fitsOpen = null;
        rerender();
      })
      .catch((e) => { if (fail(e) || mine !== seq) return; state.tags = { status: "error", data: state.tags.data, error: String(e) }; rerender(); });
  }
  function loadIfNeeded(): void {
    if (state.tags.status === "idle" || state.tags.status === "error") load();
  }

  let pageSeq = 0;
  function loadPage(name: string): void {
    const mine = ++pageSeq;
    const same = state.tagPage.data?.tag.name === name;
    state.tagPage = { status: "loading", data: same ? state.tagPage.data : null };
    rerender();
    getTagPage(name)
      .then((data) => { if (mine !== pageSeq) return; state.tagPage = { status: "ok", data }; rerender(); })
      .catch((e) => {
        if (fail(e) || mine !== pageSeq) return;
        state.tagPage = e instanceof ApiError && e.status === 404 ? { status: "ok", data: null } : { status: "error", data: null, error: String(e) };
        rerender();
      });
  }
  function open(name: string): void {
    state.screen = "tag";
    state.tagName = name;
    state.personCard = null;
    ui().pageTab = "all";
    loadIfNeeded();
    loadPage(name);
  }

  /** A list write: mark `key` busy, run it, then read the list again and say what happened. */
  function write(key: string, run: () => Promise<string>, fallback: string): void {
    if (ui().busy) return;
    ui().busy = key;
    rerender();
    run()
      .then((msg) => { ui().busy = null; host.flash(msg); load(); host.planChanged(); })
      .catch((e) => { ui().busy = null; if (fail(e)) return; host.flash(errorText(e, fallback), 6000); load(); });
  }

  function add(): void {
    const u = ui();
    const list = state.tags.data;
    if (!admin() || u.addBusy || !list) return;
    const problem = tagDraftProblem(u.nameDraft, list.tags);
    if (problem !== null) { if (problem) { u.addError = problem; rerender(); } return; }
    const name = normalizeTagName(u.nameDraft);
    if (!name) return;
    u.addBusy = true; u.addError = null;
    rerender();
    addOrgTag({ name, description: u.descDraft.trim() })
      .then((r) => {
        u.addBusy = false; u.nameDraft = ""; u.descDraft = "";
        host.flash(r.fit === "started" ? `Added the tag ${name}. Looking for existing items that fit it.` : `Added the tag ${name}`);
        polls = 0; load(); host.planChanged();
      })
      .catch((e) => { u.addBusy = false; if (fail(e)) return; u.addError = errorText(e, "Couldn't add the tag."); rerender(); });
  }

  function saveEdit(): void {
    const e = ui().edit;
    if (!admin() || !e || e.saving) return;
    const name = normalizeTagName(e.nameDraft);
    if (!name) { e.error = "A tag is lowercase letters, digits and hyphens."; rerender(); return; }
    e.saving = true; e.error = null;
    rerender();
    const from = e.name;
    editOrgTag(from, { name, description: e.descDraft.trim(), color: e.color })
      .then((r) => {
        ui().edit = null;
        host.flash(r.name !== from ? `Renamed ${from} to ${r.name}` : `Saved ${r.name}`);
        // A rename moves the tag's page and the Feed's filter with it.
        if (state.feedTag === from) state.feedTag = r.name;
        if (state.tagName === from) state.tagName = r.name;
        load();
      })
      .catch((err) => { e.saving = false; if (fail(err)) return; e.error = errorText(err, "Couldn't save the tag."); rerender(); });
  }

  function closeConfirm(): void {
    const c = ui().confirm;
    if (!c || c.busy) return;
    const back = `tagConfirm:${c.what}:${c.name}`;
    host.confirmOut(() => {
      ui().confirm = null;
      rerender();
      mount.querySelector<HTMLElement>(`[data-field="${back}"]`)?.focus();
    });
  }
  function runConfirm(): void {
    const c = ui().confirm;
    if (!c || c.busy || !admin()) return;
    c.busy = true;
    rerender();
    const done = (msg: string) => { ui().confirm = null; host.flash(msg); load(); host.planChanged(); };
    if (c.what === "acceptAll") {
      resolveTagFits(c.name, "accept").then((r) => { ui().fitsOpen = null; done(applied(r.resolved, c.name)); }).catch((e) => failed(e, "Couldn't tag them."));
      return;
    }
    const failed = (e: unknown, fallback: string) => { ui().confirm = null; if (fail(e)) return; host.flash(errorText(e, fallback), 6000); load(); };
    if (c.what === "retire") retireOrgTag(c.name).then(() => done(`Retired ${c.name}`)).catch((e) => failed(e, `Couldn't retire ${c.name}.`));
    else if (c.what === "merge" && c.into) {
      const into = c.into;
      mergeOrgTag(c.name, into).then((r) => done(`Merged ${c.name} into ${into}${r.moved ? `: ${r.moved} ${r.moved === 1 ? "item" : "items"} moved` : ""}`)).catch((e) => failed(e, `Couldn't merge ${c.name}.`));
    } else resolveTagSuggestion(c.name, { resolution: "dismiss" }).then(() => done(`Dismissed ${c.name}`)).catch((e) => failed(e, `Couldn't dismiss ${c.name}.`));
  }

  const applied = (n: number, tag: string): string => `Tagged ${n} ${n === 1 ? "item" : "items"} ${tag}`;

  // ── what the model thinks may fit ──────────────────────────────────────────
  function loadFits(tag: string): void {
    const u = ui();
    u.fits = { status: "loading", data: u.fitsOpen === tag ? u.fits.data : [] };
    rerender();
    listTagFits(tag)
      .then((data) => { if (ui().fitsOpen !== tag) return; ui().fits = { status: "ok", data }; rerender(); })
      .catch((e) => { if (fail(e) || ui().fitsOpen !== tag) return; ui().fits = { status: "error", data: [], error: String(e) }; rerender(); });
  }
  const FIND_SAID: Record<string, string> = {
    started: "Looking for items that fit. Suggestions appear here when it is done.",
    off: "Suggestions are off. Turn them on above first.",
    no_key: "This Trov has no model key set, so it cannot look for items.",
    busy: "Trov is already looking for items for this tag.",
    capped: "This month's checks are used up. Trov can look again next month.",
    not_found: "That tag is not on the list any more. Reload the page.",
  };
  function find(tag: string): void {
    if (!admin() || ui().busy) return;
    ui().busy = `find:${tag}`;
    rerender();
    findTagItems(tag)
      .then((r) => { ui().busy = null; host.flash(FIND_SAID[r.status] ?? FIND_SAID.started, 6000); polls = 0; load(); })
      .catch((e) => { ui().busy = null; if (fail(e)) return; host.flash(errorText(e, "Couldn't start looking."), 6000); rerender(); });
  }
  function settleFit(tag: string, key: string, resolution: "accept" | "dismiss"): void {
    const cut = key.indexOf(":");
    const type = key.slice(0, cut), id = key.slice(cut + 1);
    if (!admin() || ui().fitBusy || cut < 0 || (type !== "feed" && type !== "doc" && type !== "adr")) return;
    ui().fitBusy = key;
    rerender();
    resolveTagFits(tag, resolution, [{ type, id }])
      .then(() => {
        ui().fitBusy = null;
        ui().fits = { ...ui().fits, data: ui().fits.data.filter((f) => `${f.type}:${f.id}` !== key) };
        if (resolution === "accept") host.flash(`Tagged it ${tag}`);
        load();
      })
      .catch((e) => { ui().fitBusy = null; if (fail(e)) return; host.flash(tagErrorText(e, "Couldn't save that."), 6000); loadFits(tag); });
  }

  /** The doc on screen: its Tags row writes through `POST /item-tags`. */
  function setDocTags(next: (has: string[]) => string[]): void {
    const d = state.docDetail.data;
    if (!d || ui().itemBusy) return;
    const slug = d.doc.slug;
    const tags = next(d.tags ?? []);
    ui().itemBusy = true;
    rerender();
    setItemTags("doc", slug, tags)
      .then((r) => {
        ui().itemBusy = false;
        if (state.docDetail.data?.doc.slug === slug) state.docDetail.data.tags = r.tags;
        load(); // the list's counts
      })
      .catch((e) => { ui().itemBusy = false; if (fail(e)) return; host.flash(tagErrorText(e, "Couldn't change the tags."), 6000); rerender(); });
  }

  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    switch (name) {
      // Navigation
      case "tagOpen": if (arg) open(arg); return;
      case "tagPageReload": if (state.tagName) loadPage(state.tagName); return;
      case "tagPageTab": if (isTagPageTab(arg)) u.pageTab = arg; break;
      case "tagOpenDecision": if (arg) host.search(arg); return;
      case "tagsReload": load(); break;
      case "tagsGo": host.goList(); return;

      // Org settings › Tags: add
      case "tagNameDraft": u.nameDraft = value ?? ""; u.addError = null; break;
      case "tagDescDraft": u.descDraft = value ?? ""; break;
      case "tagAdd": add(); return;

      // …edit in place
      case "tagEdit": {
        const t = state.tags.data?.tags.find((x) => x.name === arg);
        if (!admin() || !t) return;
        u.edit = { name: t.name, nameDraft: t.name, descDraft: t.description, color: t.color, saving: false, error: null };
        rerender();
        mount.querySelector<HTMLInputElement>("#tag-edit-name")?.focus();
        return;
      }
      case "tagEditName": if (u.edit) { u.edit.nameDraft = value ?? ""; u.edit.error = null; } break;
      case "tagEditDesc": if (u.edit) u.edit.descDraft = value ?? ""; break;
      case "tagEditColor": if (u.edit && isTagColor(arg)) u.edit.color = arg; break;
      case "tagEditCancel": {
        const back = u.edit ? `tagEdit:${u.edit.name}` : null;
        u.edit = null;
        rerender();
        if (back) mount.querySelector<HTMLElement>(`[data-field="${back}"]`)?.focus();
        return;
      }
      case "tagEditSave": saveEdit(); return;

      // …merge, retire, restore
      case "tagMergePick":
        if (!admin() || !arg || !value) return;
        u.confirm = { what: "merge", name: arg, into: value, busy: false };
        rerender();
        mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        return;
      case "tagConfirm": {
        const at = (arg ?? "").indexOf(":");
        const what = (arg ?? "").slice(0, at);
        if (!admin() || at < 0 || (what !== "retire" && what !== "dismiss" && what !== "acceptAll")) return;
        u.confirm = { what, name: (arg ?? "").slice(at + 1), busy: false };
        rerender();
        mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        return;
      }
      case "tagConfirmCancel": closeConfirm(); return;
      case "tagConfirmGo": runConfirm(); return;
      case "tagRestore":
        if (!admin() || !arg) return;
        write(arg, () => restoreOrgTag(arg).then(() => `Restored ${arg}`), `Couldn't restore ${arg}.`);
        return;
      case "tagShowRetired": u.showRetired = !u.showRetired; break;

      // …what agents suggested
      case "tagSugAccept":
        if (!admin() || !arg) return;
        write(arg, () => resolveTagSuggestion(arg, { resolution: "accept" }).then((r) => `Added ${arg}. ${applied(r.applied_to, arg)}`), `Couldn't add ${arg}.`);
        return;
      case "tagSugUse":
      case "tagSugMapPick": {
        // `tagSugUse`: arg = "<suggested>><tag>" (the look-alike's button). `tagSugMapPick`: the dropdown — arg = the suggestion, value = the tag.
        const cut = name === "tagSugUse" ? (arg ?? "").indexOf(">") : -1;
        const sug = name === "tagSugUse" ? (arg ?? "").slice(0, cut) : arg ?? "";
        const into = name === "tagSugUse" ? (arg ?? "").slice(cut + 1) : value ?? "";
        if (!admin() || !sug || !into || (name === "tagSugUse" && cut < 0)) return;
        write(sug, () => resolveTagSuggestion(sug, { resolution: "map", into }).then((r) => applied(r.applied_to, into)), `Couldn't use ${into}.`);
        return;
      }

      // What the model thinks may fit
      case "tagAiToggle": {
        const ai = state.tags.data?.ai;
        if (!admin() || !ai || u.aiBusy) return;
        u.aiBusy = true;
        rerender();
        setTagSuggestions(!ai.enabled)
          .then((r) => { u.aiBusy = false; host.flash(r.enabled ? "Suggestions are on. Trov looks for items when you add a tag." : "Suggestions are off. Nothing is sent."); load(); })
          .catch((e) => { u.aiBusy = false; if (fail(e)) return; host.flash(tagErrorText(e, "Couldn't change that."), 6000); rerender(); });
        return;
      }
      case "tagFind": if (arg) find(arg); return;
      case "tagFitsOpen":
        if (!arg) return;
        if (u.fitsOpen === arg) { u.fitsOpen = null; break; }
        u.fitsOpen = arg;
        loadFits(arg);
        return;
      case "tagFitsReload": if (u.fitsOpen) loadFits(u.fitsOpen); return;
      case "tagFitAccept": if (arg && u.fitsOpen) settleFit(u.fitsOpen, arg, "accept"); return;
      case "tagFitDismiss": if (arg && u.fitsOpen) settleFit(u.fitsOpen, arg, "dismiss"); return;

      // A doc's Tags row
      case "tagItemAdd": if (value) setDocTags((has) => (has.includes(value) ? has : [...has, value])); return;
      case "tagItemRemove": if (arg) setDocTags((has) => has.filter((t) => t !== arg)); return;
      default: return;
    }
    rerender();
  }

  return { act, load, loadIfNeeded, open };
}
