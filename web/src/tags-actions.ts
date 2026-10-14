// The organization's tag list — the controller: every `tag…` act main.ts dispatches lands here, with
// the reads and writes behind them (the views are web/src/tags.ts, pure). The list itself
// (`state.tags`) is read once per org and again after every write, because the Feed's filter, the
// Unplaced picker, a doc's Tags row and Org settings › Tags all draw from it.
import type { AppState } from "./render";
import {
  ApiError, OrgApiError, Unauthorized, planLimitText,
  listOrgTags, getTagPage, addOrgTag, editOrgTag, mergeOrgTag, retireOrgTag, restoreOrgTag, resolveTagSuggestion, setItemTags,
  findTagItems, undoTagRun, setTagSuggestions, getTagRun,
} from "./api";
import { currentOrg, roleAtLeast } from "./org-settings";
import { isTagPageTab, tagDraftProblem } from "./tags";
import { isTagColor, normalizeTagName } from "@shared/tags-core";
import { POLL_MS, applyAnswer, barFill, barState, newLive, runCounter, shouldPoll, shownAt, type LiveRun } from "./fit-run";

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

  // ── a run, live (web/src/fit-run.ts) ───────────────────────────────────────
  // While a run goes (in the background, after the request that started it), its row reads
  // `GET …/tags/:name/run` every POLL_MS and draws what it says; between two answers one animation frame
  // loop eases the bar and the counter toward the latest numbers, writing them straight into the row's
  // elements (the page is not repainted per frame). Reading stops when the run ends,
  // while the tab is hidden (it resumes when it is shown), and after POLL_MAX reads.
  const reduced = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hidden = (): boolean => typeof document !== "undefined" && document.hidden;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let frame: number | null = null;
  /** Runs painted at least once since their row was (re)drawn. */
  const painted = new Set<string>();

  function watch(tag: string): void {
    if (!ui().live[tag]) ui().live[tag] = newLive(Date.now());
    schedule(tag, 0);
  }
  function schedule(tag: string, delay: number): void {
    if (timers.has(tag)) return;
    timers.set(tag, setTimeout(() => { timers.delete(tag); pollRun(tag); }, delay));
  }
  function pollRun(tag: string): void {
    const live = ui().live[tag];
    if (!live || !shouldPoll(live, hidden())) return;
    getTagRun(tag)
      .then((run) => {
        const cur = ui().live[tag];
        if (!cur) return;
        if (!run) { delete ui().live[tag]; rerender(); return; }
        const now = Date.now();
        const next = applyAnswer({ ...cur, shown: shownAt(cur, now, reduced()) }, run, now);
        ui().live[tag] = next;
        if (cur.candidates !== next.candidates || cur.status !== next.status || reduced()) { painted.delete(tag); rerender(); } // the square count or the words changed
        if (next.status === "running") { if (shouldPoll(next, hidden())) schedule(tag, POLL_MS); }
        animate();
      })
      .catch((e) => { if (fail(e)) return; if (ui().live[tag]) schedule(tag, POLL_MS * 3); });
  }
  /** One loop for every live run: ease toward the latest answer, then — once a run has ended and the view
   *  has caught up — hand it to the list (the review list opens when something fits). */
  function animate(): void {
    if (frame !== null || typeof requestAnimationFrame !== "function") return;
    const step = (): void => {
      frame = null;
      const now = Date.now();
      let again = false;
      for (const [tag, live] of Object.entries(ui().live)) {
        const was = live.shown;
        live.shown = shownAt(live, now, reduced());
        if (live.shown !== was || !painted.has(tag)) { paintRun(tag, live); painted.add(tag); } // nothing moved: nothing to write
        const caughtUp = live.shown >= live.checked;
        if (!caughtUp || live.status === "running") again = true;
        else if (!finishing.has(tag)) finish(tag, live);
      }
      if (again && !reduced()) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }
  /** Write one run's frame into its row: the bar's fill and state (its colour), the counter. */
  function paintRun(tag: string, live: LiveRun): void {
    const box = mount.querySelector<HTMLElement>(`[data-fitrun="${CSS.escape(tag)}"]`);
    if (!box) return;
    const state = barState(live, live.shown);
    if (box.dataset.state !== state) box.dataset.state = state;
    const bar = box.querySelector<HTMLElement>(".cnpy-fitrun-bar");
    bar?.setAttribute("aria-valuenow", String(Math.floor(live.shown)));
    bar?.setAttribute("aria-valuemax", String(live.candidates));
    const fill = bar?.querySelector<HTMLElement>("span");
    if (fill) fill.style.transform = `scaleX(${barFill(live, live.shown).toFixed(4)})`;
    const n = box.querySelector<HTMLElement>("[data-fitrun-n]");
    const words = runCounter(live, live.shown);
    if (n && n.textContent !== words) n.textContent = words;
  }
  const finishing = new Set<string>();
  function finish(tag: string, live: LiveRun): void {
    finishing.add(tag);
    // Let the bar show its end (its colour) a moment, then the list takes over: the row says
    // "Added to N items" (with Undo), "Checked N — none fit", or why it stopped.
    setTimeout(() => {
      finishing.delete(tag);
      listOrgTags().then((data) => {
        state.tags = { status: "ok", data };
        delete ui().live[tag];
        rerender();
      }).catch((e) => { if (fail(e)) return; delete ui().live[tag]; load(); });
    }, 1400);
  }
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (hidden()) return;
      for (const [tag, live] of Object.entries(ui().live)) if (live.status === "running") schedule(tag, 0);
    });
  }

  function load(): void {
    const mine = ++seq;
    if (state.tags.status !== "ok") state.tags = { status: "loading", data: state.tags.data };
    listOrgTags()
      .then((data) => {
        if (mine !== seq) return;
        state.tags = { status: "ok", data };
        // A run that is going (started here, or by another admin): draw it live.
        for (const [tag, r] of Object.entries(data.runs ?? {})) if (r.status === "running" && !ui().live[tag]) watch(tag);
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
        host.flash(`Added the tag ${name}`);
        if (r.fit === "started") watch(name);
        load(); host.planChanged();
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
    if (c.what === "undoRun") {
      undoTagRun(c.name).then((r) => done(`Took ${c.name} off ${r.removed} ${r.removed === 1 ? "item" : "items"}`)).catch((e) => failed(e, "Couldn't undo the run."));
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

  // ── Jev tagging existing items ─────────────────────────────────────────────
  const FIND_SAID: Record<string, string> = {
    started: "Looking for items that fit, and tagging them.",
    off: "Suggestions are off. Turn them on above first.",
    no_key: "This Trov has no TypeSafe AI key set, so it cannot look for items.",
    busy: "Trov is already looking for items for this tag.",
    capped: "This month's checks are used up. Trov can look again next month.",
    not_found: "That tag is not on the list any more. Reload the page.",
  };
  function find(tag: string): void {
    if (!admin() || ui().busy) return;
    ui().busy = `find:${tag}`;
    rerender();
    findTagItems(tag)
      .then((r) => {
        ui().busy = null;
        if (r.status === "started") { watch(tag); rerender(); return; }
        host.flash(FIND_SAID[r.status] ?? FIND_SAID.started, 6000);
        load();
      })
      .catch((e) => { ui().busy = null; if (fail(e)) return; host.flash(errorText(e, "Couldn't start looking."), 6000); rerender(); });
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
        if (!admin() || at < 0 || (what !== "retire" && what !== "dismiss" && what !== "undoRun")) return;
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

      // Jev tagging existing items: the switch, Find items
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
      // A doc's Tags row
      case "tagItemAdd": if (value) setDocTags((has) => (has.includes(value) ? has : [...has, value])); return;
      case "tagItemRemove": if (arg) setDocTags((has) => has.filter((t) => t !== arg)); return;
      default: return;
    }
    rerender();
  }

  return { act, load, loadIfNeeded, open };
}
