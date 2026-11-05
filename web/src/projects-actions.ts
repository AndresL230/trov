// Projects — the controller: every `proj…` act main.ts dispatches lands here, with the reads and writes behind them
// (the views are web/src/projects.ts, pure; the client is web/src/projects-api.ts). `state.projects.list` is read when
// the Projects screen opens (and by Ask, for Move to project); `state.projects.detail` is the open project's page — or
// the project of the thread open in Ask (its pins count, its chats). Every write is a cookie route; a refusal is said in
// words (`projectErrorText`), a 402 in the plan's one sentence. Add to Knowledge and Archive put up a toast with Undo.
import type { AppState, ToastAction } from "./render";
import {
  listProjects, getProject, createProject, patchProject, deleteProject, archiveProject, restoreProject, putProjectMembers,
  addProjectPins, removeProjectPin, uploadProjectFiles, projectErrorText,
} from "./projects-api";
import { OrgApiError, Unauthorized, quickSearch, patchArtifact } from "./api";
import { askApi, quickHitsToRefs, type AskRefHit } from "./ask-api";
import { knownHits } from "./ask-composer";
import {
  blankPinPick, blankProjectDraft, draftFrom, atProjectCap, privatePicks, pinRoomText, uploadRefusalText, deletedProjectText, PIN_TYPE_TABS, PROJECT_SORTS,
  type PinTypeTab, type ProjectSort, type ProjectsUi,
} from "./projects";
import { currentOrg } from "./org-core";
import { PLANS } from "@shared/plans";
import type { AskThreadProject } from "@shared/ai-ask-core";
import {
  PROJECT_LIMITS, PROJECT_PIN_TYPES, isProjectVisibility, type ProjectDetail, type ProjectSummary, type ProjectPatchBody, type ProjectRole,
} from "@shared/projects-core";
import { isSpaceColor, isSpaceIcon } from "@shared/docs-core";

export interface ProjectsHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  rerenderSoon(): void;
  flash(msg: string, ms?: number, action?: ToastAction | null): void;
  unauth(e: unknown): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** The reader's role in the org (an owner can upgrade; an admin may archive or delete any project). */
  role(): "owner" | "admin" | "member" | null;
  /** Ask's page conversation becomes a new thread in this project (the project page's composer), unless it is busy. */
  prepareAsk(p: AskThreadProject): void;
  /** Open a stored Ask thread (`#ask/<id>`). */
  openThread(id: number): void;
  /** Go to an in-app route (`#tickets/87`) or open an outside URL (a PR) in a new tab. */
  openHref(href: string): void;
  /** Org settings › General, where an owner upgrades. */
  upgrade(): void;
  /** A project's threads changed (one deleted with it): Ask reads its thread list again. */
  threadsChanged(): void;
}

export interface ProjectsController {
  act(act: string, arg: string | null, value: string | null): boolean;
  /** Read the list (again). */
  loadList(): void;
  /** Open a project's home (`#project/<slug>`): its read, Ask's composer for a new thread in it. */
  open(slug: string): void;
  /** After every paint: what Ask needs (the open thread's project, the list for Move to project). */
  afterPaint(): void;
  /** The open project's read again, keeping what is on screen (a thread was asked, renamed or moved). */
  refreshDetail(): void;
  /** The file picker and the drop zone (a file has no string value to dispatch). Once, at boot. */
  install(): void;
}

/** How long a toast carrying Undo stays up (main.ts's UNDO_TOAST_MS). */
const UNDO_MS = 8000;
const SEARCH_MS = 180;

export const projectRef = (p: Pick<ProjectSummary, "slug" | "name" | "icon" | "color">): AskThreadProject => ({ slug: p.slug, name: p.name, icon: p.icon, color: p.color });

export function createProjectsController(host: ProjectsHost): ProjectsController {
  const { state, mount } = host;
  const ui = (): ProjectsUi => state.projects;
  const rerender = () => host.rerender();
  const fail = (e: unknown): boolean => { if (e instanceof Unauthorized) { host.unauth(e); return true; } return false; };
  const text = (e: unknown, fallback: string) => projectErrorText(e, fallback, host.role());
  /** The org's plan's name ("Free"), for the pin room's sentence. */
  const planName = (): string => { const p = currentOrg(state)?.plan; return p ? PLANS[p].name : "Your plan"; };
  let listSeq = 0;
  let detailSeq = 0;
  /** The slug the detail read in flight is for. */
  let detailFor: string | null = null;
  let searchSeq = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  /** Undo for the toast on screen, by its token. */
  const undos = new Map<string, () => void>();
  let undoSeq = 0;
  const undoable = (msg: string, run: () => void): void => {
    const token = `u${++undoSeq}`;
    undos.clear();
    undos.set(token, run);
    host.flash(msg, UNDO_MS, { label: "Undo", act: "projUndo", arg: token });
  };
  const focus = (sel: string) => mount.querySelector<HTMLElement>(sel)?.focus();

  // ── reads ──────────────────────────────────────────────────────────────────

  function loadList(): void {
    const seq = ++listSeq;
    ui().list = { status: "loading", data: ui().list.data };
    listProjects()
      .then((data) => { if (seq !== listSeq) return; ui().list = { status: "ok", data }; host.rerenderSoon(); })
      .catch((e) => { if (fail(e) || seq !== listSeq) return; ui().list = { status: "error", data: ui().list.data }; host.rerenderSoon(); });
  }

  /** Read `slug`'s page into `detail`. `keep`: a refresh — what is on screen stays while it is out. */
  function readDetail(slug: string, keep: boolean): void {
    const seq = ++detailSeq;
    detailFor = slug;
    const same = ui().detail.data?.project.slug === slug;
    ui().detail = { status: "loading", data: same || keep ? ui().detail.data : null };
    getProject(slug)
      .then((data) => {
        if (seq !== detailSeq) return;
        ui().detail = { status: "ok", data };
        detailFor = null;
        if (state.screen === "project" && ui().slug === slug) readyAsk(data);
        host.rerenderSoon();
      })
      .catch((e) => {
        if (fail(e) || seq !== detailSeq) return;
        detailFor = null;
        // One 404 for a project that isn't there and one the person can't open (the spec's rule): "no project here".
        ui().detail = e instanceof OrgApiError && e.status === 404 ? { status: "ok", data: null } : { status: "error", data: same ? ui().detail.data : null };
        host.rerenderSoon();
      });
  }
  /** Ask's composer on the project page: a new thread in this project (a live one; an archived one has no composer). */
  function readyAsk(d: ProjectDetail): void {
    if (!d.project.archivedAt) host.prepareAsk(projectRef(d.project));
  }

  function open(slug: string): void {
    const u = ui();
    if (u.slug !== slug) { u.tab = "chats"; u.instr = null; u.instrBusy = false; }
    u.slug = slug; u.headMenu = false; u.rowMenu = null;
    const cached = u.detail.data?.project.slug === slug ? u.detail.data : null;
    if (cached) readyAsk(cached);
    readDetail(slug, false);
    rerender();
  }

  function refreshDetail(): void {
    const d = ui().detail;
    if (d.status === "ok" && d.data && detailFor === null) readDetail(d.data.project.slug, true);
  }

  /** A write answered with the project's page: put it where it shows (the page, the list's summary). */
  function landed(d: ProjectDetail): void {
    if (ui().detail.data?.project.slug === d.project.slug || ui().slug === d.project.slug) ui().detail = { status: "ok", data: d };
    swapSummary(d.project);
  }
  function swapSummary(p: ProjectSummary): void {
    const l = ui().list.data;
    if (!l) return;
    const { instructions: _drop, ...s } = p as ProjectSummary & { instructions?: string };
    const live = l.projects.filter((x) => x.slug !== p.slug);
    const archived = l.archived.filter((x) => x.slug !== p.slug);
    ui().list = { ...ui().list, data: { ...l, projects: p.archivedAt ? live : [s, ...live], archived: p.archivedAt ? [s, ...archived] : archived } };
  }
  /** The project a list act names: the open page's, else the list's (live or archived). */
  const summaryOf = (slug: string): ProjectSummary | null =>
    (ui().detail.data?.project.slug === slug ? ui().detail.data!.project : null)
    ?? ui().list.data?.projects.find((p) => p.slug === slug) ?? ui().list.data?.archived.find((p) => p.slug === slug) ?? null;

  // ── the dialogs ────────────────────────────────────────────────────────────

  function openDialog(d: ProjectsUi["dialog"]): void {
    const u = ui();
    u.rowMenu = null; u.headMenu = false;
    u.dialog = d;
    rerender();
    focus("[data-confirm-dialog] [data-confirm-focus]");
  }
  function closeDialog(): void {
    if (!ui().dialog) return;
    host.confirmOut(() => {
      ui().dialog = null;
      state.dd = { open: null, opening: false, closing: false };
      rerender();
      focus("[data-confirm-trigger]");
    });
  }

  function save(): void {
    const dlg = ui().dialog;
    if (dlg?.kind !== "edit") return;
    const d = dlg.draft;
    const name = d.name.trim();
    if (d.busy || !name) return;
    if (d.mode === "new" && atProjectCap(ui().list.data?.limit)) return;
    dlg.draft = { ...d, busy: true, error: null };
    rerender();
    const description = d.description.trim();
    if (d.mode === "new") {
      createProject({ name, description, icon: d.icon, color: d.color, visibility: d.visibility })
        .then((p) => {
          host.confirmOut(() => {
            ui().dialog = null;
            loadList();
            state.screen = "project";
            open(p.slug);
            host.flash("Project created");
          });
        })
        .catch((e) => { if (fail(e)) return; dlg.draft = { ...dlg.draft, busy: false, error: text(e, "Couldn't create the project.") }; rerender(); });
      return;
    }
    const was = summaryOf(d.slug ?? "");
    const body: ProjectPatchBody = {};
    if (!was || name !== was.name) body.name = name;
    if (!was || description !== was.description) body.description = description;
    if (!was || d.icon !== was.icon) body.icon = d.icon;
    if (!was || d.color !== was.color) body.color = d.color;
    if (was && d.visibility !== was.visibility && was.access === "owner") body.visibility = d.visibility;
    if (!Object.keys(body).length) { closeDialog(); return; }
    patchProject(d.slug ?? "", body)
      .then((detail) => { landed(detail); host.confirmOut(() => { ui().dialog = null; rerender(); host.flash("Details saved"); }); })
      .catch((e) => { if (fail(e)) return; dlg.draft = { ...dlg.draft, busy: false, error: text(e, "Couldn't save the details.") }; rerender(); });
  }

  // ── Add to Knowledge ───────────────────────────────────────────────────────

  function search(): void {
    const dlg = ui().dialog;
    if (dlg?.kind !== "pin") return;
    if (searchTimer) clearTimeout(searchTimer);
    const q = dlg.pick.q.trim();
    if (q.length < 2) { dlg.pick = { ...dlg.pick, status: "idle", hits: [] }; return; }
    dlg.pick = { ...dlg.pick, status: "loading" };
    const seq = ++searchSeq;
    searchTimer = setTimeout(() => {
      quickSearch(q)
        .then(async (r) => {
          // The quick search has no pull requests: the ones Trov already shows are offered, as in Ask's @ picker.
          const known = knownHits({ views: state.ask.refViews }, q).filter((h) => h.type === "pr");
          const seen = new Set<string>();
          const hits = [...quickHitsToRefs(r), ...known].filter((h) => (PROJECT_PIN_TYPES as readonly string[]).includes(h.type) && !seen.has(h.ref) && seen.add(h.ref));
          let views: Record<string, import("@shared/ai-ask-core").PeekResult> = {};
          try { for (const v of await askApi.peek(hits.map((h) => h.ref).slice(0, 50))) views[v.ref] = v; } catch { views = {}; }
          return { hits, views };
        })
        .then(({ hits, views }) => {
          const now = ui().dialog;
          if (seq !== searchSeq || now?.kind !== "pin") return;
          now.pick = { ...now.pick, status: "ok", hits, views: { ...now.pick.views, ...views } };
          host.rerenderSoon();
        })
        .catch((e) => {
          const now = ui().dialog;
          if (fail(e) || seq !== searchSeq || now?.kind !== "pin") return;
          now.pick = { ...now.pick, status: "error" };
          host.rerenderSoon();
        });
    }, SEARCH_MS);
  }

  function addPins(): void {
    const dlg = ui().dialog;
    const d = ui().detail.data;
    if (dlg?.kind !== "pin" || !d || dlg.pick.busy || !dlg.pick.sel.length) return;
    const slug = d.project.slug;
    const refs = dlg.pick.sel.slice();
    // Past the project's pin room the whole pick is refused here, before anything is sent: each chunk below is
    // committed alone, so a later one refused (402) would leave the earlier ones pinned.
    const room = pinRoomText(d.pinLimit, refs.length, host.role() === "owner", planName());
    if (room) { dlg.pick = { ...dlg.pick, error: room }; rerender(); return; }
    dlg.pick = { ...dlg.pick, busy: true, error: null };
    rerender();
    // At most `pinsPerRequest` refs a call; the last answer is the page.
    const chunks: string[][] = [];
    for (let i = 0; i < refs.length; i += PROJECT_LIMITS.pinsPerRequest) chunks.push(refs.slice(i, i + PROJECT_LIMITS.pinsPerRequest));
    const added: string[] = [];
    let page: ProjectDetail | null = null;
    chunks.reduce<Promise<void>>((p, c) => p.then(() => addProjectPins(slug, c)).then((detail) => { page = detail; added.push(...c); }), Promise.resolve())
      .then(() => {
        if (page) landed(page);
        host.confirmOut(() => {
          ui().dialog = null;
          rerender();
          undoable(`Added ${refs.length} to Knowledge`, () => unpinAll(slug, refs));
        });
      })
      .catch((e) => {
        if (fail(e)) return;
        // Some chunks were pinned before one was refused: the page shows what is pinned now, and the dialog says so
        // (what was added leaves the pick, so Add again sends only the rest).
        if (page) landed(page);
        const now = ui().dialog;
        if (now?.kind === "pin") {
          const why = text(e, "Couldn't add the rest.");
          now.pick = { ...now.pick, busy: false, sel: now.pick.sel.filter((r) => !added.includes(r)), error: added.length ? `Added ${added.length} of ${refs.length}. ${why}` : text(e, "Couldn't add them.") };
        }
        rerender();
      });
  }
  function unpinAll(slug: string, refs: string[]): void {
    refs.reduce<Promise<ProjectDetail | null>>((p, r) => p.then(() => removeProjectPin(slug, r)), Promise.resolve(null))
      .then((detail) => { if (detail) landed(detail); rerender(); host.flash(`Removed ${refs.length} from Knowledge`); })
      .catch((e) => { if (fail(e)) return; host.flash(text(e, "Couldn't undo that."), 4200); refreshDetail(); });
  }

  function upload(files: File[]): void {
    const d = ui().detail.data;
    if (!d || !files.length) return;
    const dlg = ui().dialog;
    // Ask's attachment rules, checked before anything is sent, in the project's words (the server's are a message's).
    const refused = uploadRefusalText(files);
    if (refused) {
      if (dlg?.kind === "pin") { dlg.pick = { ...dlg.pick, error: refused }; rerender(); }
      else host.flash(refused, 4200);
      return;
    }
    if (dlg?.kind === "pin") { dlg.pick = { ...dlg.pick, uploading: true, error: null }; rerender(); }
    uploadProjectFiles(d.project.slug, files)
      .then((detail) => {
        landed(detail);
        const done = () => host.flash(`Uploaded ${files.length} ${files.length === 1 ? "file" : "files"} to Knowledge`);
        if (ui().dialog?.kind === "pin") host.confirmOut(() => { ui().dialog = null; rerender(); done(); });
        else { rerender(); done(); }
      })
      .catch((e) => {
        if (fail(e)) return;
        const now = ui().dialog;
        if (now?.kind === "pin") { now.pick = { ...now.pick, uploading: false, error: text(e, "Couldn't upload the files.") }; rerender(); }
        else host.flash(text(e, "Couldn't upload the files."), 4200);
      });
  }

  // ── Share ──────────────────────────────────────────────────────────────────

  function saveShare(): void {
    const dlg = ui().dialog;
    const d = ui().detail.data;
    if (dlg?.kind !== "share" || !d || dlg.share.busy) return;
    const s = dlg.share;
    const visChanged = s.visibility !== d.project.visibility && d.project.access === "owner";
    const before = d.members.filter((m) => m.role !== "owner").map((m) => `${m.handle.toLowerCase()}:${m.role}`).sort().join(",");
    const after = s.members.map((m) => `${m.handle.toLowerCase()}:${m.role}`).sort().join(",");
    const membersChanged = before !== after && s.visibility !== "private";
    if (!visChanged && !membersChanged) { closeDialog(); return; }
    dlg.share = { ...s, busy: true, error: null };
    rerender();
    const slug = d.project.slug;
    const vis = visChanged ? patchProject(slug, { visibility: s.visibility }) : Promise.resolve(null);
    vis.then((x) => (membersChanged ? putProjectMembers(slug, { members: s.members }) : x))
      .then((detail) => { if (detail) landed(detail); host.confirmOut(() => { ui().dialog = null; rerender(); host.flash("Sharing saved"); }); })
      .catch((e) => { if (fail(e)) return; const now = ui().dialog; if (now?.kind === "share") { now.share = { ...now.share, busy: false, error: text(e, "Couldn't save the sharing.") }; rerender(); } });
  }

  // ── archive, restore, delete ───────────────────────────────────────────────

  function archive(slug: string): void {
    const p = summaryOf(slug);
    ui().rowMenu = null; ui().headMenu = false;
    archiveProject(slug)
      .then((s) => {
        swapSummary(s);
        if (ui().detail.data?.project.slug === slug) ui().detail = { status: "ok", data: { ...ui().detail.data!, project: { ...ui().detail.data!.project, ...s } } };
        // Archived, it leaves the live list: from its page, back to Projects (the design's).
        if (state.screen === "project" && ui().slug === slug) state.screen = "projects";
        loadList();
        rerender();
        undoable(`${p?.name ?? "The project"} archived`, () => restore(slug));
      })
      .catch((e) => { if (fail(e)) return; host.flash(text(e, "Couldn't archive the project."), 4200); rerender(); });
    rerender();
  }
  function restore(slug: string): void {
    const p = summaryOf(slug);
    ui().restoring = slug;
    rerender();
    restoreProject(slug)
      .then((s) => {
        ui().restoring = null;
        swapSummary(s);
        if (ui().detail.data?.project.slug === slug) readDetail(slug, true);
        loadList();
        rerender();
        host.flash(`${p?.name ?? "The project"} restored`);
      })
      .catch((e) => { ui().restoring = null; if (fail(e)) return; host.flash(text(e, "Couldn't restore the project."), 4200); rerender(); });
  }
  function deleteGo(): void {
    const dlg = ui().dialog;
    if (dlg?.kind !== "delete" || dlg.busy) return;
    const slug = dlg.slug;
    const p = summaryOf(slug);
    dlg.busy = true; dlg.error = null;
    rerender();
    deleteProject(slug)
      .then((done) => {
        host.confirmOut(() => {
          ui().dialog = null;
          const l = ui().list.data;
          if (l) ui().list = { ...ui().list, data: { ...l, projects: l.projects.filter((x) => x.slug !== slug), archived: l.archived.filter((x) => x.slug !== slug) } };
          if (ui().detail.data?.project.slug === slug) ui().detail = { status: "idle", data: null };
          if (state.screen === "project") state.screen = "projects";
          loadList();
          host.threadsChanged();
          rerender();
          host.flash(deletedProjectText(p?.name ?? "The project", done.chats));
        });
      })
      .catch((e) => { if (fail(e)) return; const now = ui().dialog; if (now?.kind === "delete") { now.busy = false; now.error = text(e, "Couldn't delete the project."); rerender(); } });
  }

  // ── acts ───────────────────────────────────────────────────────────────────

  function act(name: string, arg: string | null, value: string | null): boolean {
    const u = ui();
    const dlg = u.dialog;
    switch (name) {
      case "projOpen": if (!arg) return true; state.screen = "project"; open(arg); return true;
      case "projRetry": if (arg) readDetail(arg, false); else loadList(); rerender(); return true;
      case "projQ": u.q = value ?? ""; rerender(); return true;
      case "projFilter": if (arg === "all" || arg === "mine" || arg === "shared") u.filter = arg; rerender(); return true;
      case "projSort": { const v = value ?? arg; if ((PROJECT_SORTS as readonly string[]).includes(v ?? "")) u.sort = v as ProjectSort; rerender(); return true; }
      case "projArchivedToggle": u.archivedOpen = !u.archivedOpen; rerender(); return true;
      case "projRowMenu": u.rowMenu = u.rowMenu === arg ? null : arg; u.headMenu = false; rerender(); if (u.rowMenu) focus(".pj-rowmenu [role='menuitem']"); return true;
      case "projHeadMenu": u.headMenu = !u.headMenu; u.rowMenu = null; rerender(); if (u.headMenu) focus(".pj-headmenu [role='menuitem']"); return true;
      case "projTab": if (arg === "chats" || arg === "artifacts") u.tab = arg; rerender(); return true;
      case "projUndo": { const run = arg ? undos.get(arg) : undefined; undos.clear(); state.toast = null; state.toastAction = null; if (run) run(); rerender(); return true; }
      case "projUpgrade": host.upgrade(); return true;
      case "projChat": { const id = Number(arg); if (id > 0) host.openThread(id); return true; }
      case "projArtifact": if (arg) host.openHref(`#artifacts/${encodeURIComponent(arg)}`); return true;
      case "projPinOpen": {
        const pin = u.detail.data?.pins.find((p) => p.ref === arg);
        if (pin && !("hidden" in pin.view) && pin.view.href) host.openHref(pin.view.href);
        return true;
      }

      // New project / Edit details
      case "projNew":
        if (u.list.status === "idle") loadList();
        openDialog({ kind: "edit", draft: blankProjectDraft() });
        return true;
      case "projEdit": { const p = arg ? summaryOf(arg) : null; if (p) openDialog({ kind: "edit", draft: draftFrom(p) }); return true; }
      case "projField":
        if (dlg?.kind === "edit" && (arg === "name" || arg === "description")) {
          const max = arg === "name" ? PROJECT_LIMITS.nameMax : PROJECT_LIMITS.descriptionMax;
          dlg.draft = { ...dlg.draft, [arg]: (value ?? "").slice(0, max), error: null };
          rerender();
        }
        return true;
      case "projIcon": if (dlg?.kind === "edit" && isSpaceIcon(arg)) { dlg.draft = { ...dlg.draft, icon: arg }; rerender(); } return true;
      case "projColor": if (dlg?.kind === "edit" && isSpaceColor(arg)) { dlg.draft = { ...dlg.draft, color: arg }; rerender(); } return true;
      case "projVis": if (dlg?.kind === "edit" && isProjectVisibility(arg)) { dlg.draft = { ...dlg.draft, visibility: arg }; rerender(); } return true;
      case "projSave": save(); return true;
      case "projDialogClose": {
        const busy = dlg ? (dlg.kind === "edit" ? dlg.draft.busy : dlg.kind === "pin" ? dlg.pick.busy : dlg.kind === "share" ? dlg.share.busy : dlg.busy) : false;
        if (!busy) closeDialog();
        return true;
      }

      // Instructions, edited in place
      case "projInstrEdit": {
        const d = u.detail.data;
        if (!d) return true;
        u.instr = d.project.instructions;
        rerender();
        const ta = mount.querySelector<HTMLTextAreaElement>("[data-pj-instr]");
        if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
        return true;
      }
      case "projInstrInput": if (u.instr !== null && !u.instrBusy) { u.instr = (value ?? "").slice(0, PROJECT_LIMITS.instructionsMax); rerender(); } return true;
      case "projInstrCancel": if (!u.instrBusy) { u.instr = null; rerender(); focus('[data-act="projInstrEdit"]'); } return true;
      case "projInstrSave": {
        const d = u.detail.data;
        if (!d || u.instr === null || u.instrBusy) return true;
        const instructions = u.instr;
        u.instrBusy = true;
        rerender();
        patchProject(d.project.slug, { instructions })
          .then((detail) => { landed(detail); u.instr = null; u.instrBusy = false; rerender(); host.flash("Instructions saved. New messages use them."); })
          .catch((e) => { u.instrBusy = false; if (fail(e)) return; host.flash(text(e, "Couldn't save the instructions."), 4200); rerender(); });
        return true;
      }

      // Knowledge
      case "projUnpin": {
        const d = u.detail.data;
        if (!d || !arg || u.unpinning) return true;
        u.unpinning = arg;
        rerender();
        removeProjectPin(d.project.slug, arg)
          .then((detail) => { u.unpinning = null; landed(detail); rerender(); host.flash("Removed from Knowledge"); })
          .catch((e) => { u.unpinning = null; if (fail(e)) return; host.flash(text(e, "Couldn't remove it."), 4200); rerender(); });
        return true;
      }
      case "projAdd": openDialog({ kind: "pin", pick: blankPinPick() }); return true;
      case "projPinQ": if (dlg?.kind === "pin") { dlg.pick = { ...dlg.pick, q: value ?? "", error: null }; search(); rerender(); } return true;
      case "projPinType": if (dlg?.kind === "pin" && (PIN_TYPE_TABS as readonly string[]).includes(arg ?? "")) { dlg.pick = { ...dlg.pick, type: arg as PinTypeTab }; rerender(); } return true;
      case "projPinToggle":
        if (dlg?.kind === "pin" && arg && !dlg.pick.busy) {
          const on = value === "1";
          const sel = dlg.pick.sel.filter((r) => r !== arg);
          dlg.pick = { ...dlg.pick, sel: on ? [...sel, arg] : sel, error: null };
          rerender();
        }
        return true;
      case "projPinGo": addPins(); return true;
      case "projPublish": {
        if (dlg?.kind !== "pin" || !arg || dlg.pick.publishing) return true;
        dlg.pick = { ...dlg.pick, publishing: arg };
        rerender();
        const ref = `artifact:${arg}`;
        patchArtifact(arg, { visibility: "org" })
          .then(() => {
            const now = ui().dialog;
            if (now?.kind !== "pin") return;
            const v = now.pick.views[ref];
            const views = v && !("hidden" in v) ? { ...now.pick.views, [ref]: { ...v, extra: { ...v.extra, visibility: "org" } } } : now.pick.views;
            now.pick = { ...now.pick, publishing: null, views };
            rerender();
            host.flash("Published to the org");
          })
          .catch((e) => { const now = ui().dialog; if (now?.kind === "pin") now.pick = { ...now.pick, publishing: null }; if (fail(e)) return; host.flash(text(e, "Couldn't publish it."), 4200); rerender(); });
        return true;
      }
      case "projUploadPick": {
        const which = u.dialog?.kind === "pin" ? "dialog" : "page";
        mount.querySelector<HTMLInputElement>(`[data-proj-file="${which}"]`)?.click();
        return true;
      }

      // Share
      case "projShare": {
        const d = u.detail.data;
        if (!d) return true;
        openDialog({ kind: "share", share: { visibility: d.project.visibility, members: d.members.filter((m) => m.role !== "owner").map((m) => ({ handle: m.handle, role: m.role as ProjectRole })), busy: false, error: null } });
        return true;
      }
      case "projShareVis": if (dlg?.kind === "share" && isProjectVisibility(arg) && !dlg.share.busy) { dlg.share = { ...dlg.share, visibility: arg, error: null }; rerender(); } return true;
      case "projShareAdd": {
        if (dlg?.kind !== "share" || !value || dlg.share.busy) return true;
        if (dlg.share.members.some((m) => m.handle.toLowerCase() === value.toLowerCase())) return true;
        if (dlg.share.members.length >= PROJECT_LIMITS.membersMax) { dlg.share = { ...dlg.share, error: `A project can have up to ${PROJECT_LIMITS.membersMax} people.` }; rerender(); return true; }
        dlg.share = { ...dlg.share, members: [...dlg.share.members, { handle: value, role: "editor" }], error: null };
        rerender();
        return true;
      }
      case "projShareRole": {
        if (dlg?.kind !== "share" || !arg || dlg.share.busy) return true;
        const same = (h: string) => h.toLowerCase() === arg.toLowerCase();
        dlg.share = {
          ...dlg.share, error: null,
          members: value === "remove" ? dlg.share.members.filter((m) => !same(m.handle))
            : value === "editor" || value === "viewer" ? dlg.share.members.map((m) => (same(m.handle) ? { ...m, role: value } : m)) : dlg.share.members,
        };
        rerender();
        return true;
      }
      case "projShareSave": saveShare(); return true;

      // Archive / Restore / Delete
      case "projArchive": if (arg) archive(arg); return true;
      case "projRestore": if (arg && u.restoring !== arg) restore(arg); return true;
      case "projDelete": { const p = arg ? summaryOf(arg) : null; if (p) openDialog({ kind: "delete", slug: p.slug, busy: false, error: null }); return true; }
      case "projDeleteGo": deleteGo(); return true;
    }
    return false;
  }

  // ── after a paint: Ask's needs ─────────────────────────────────────────────

  /** The project Ask last asked to read (once per project, so a failed read is not asked again on every paint). */
  let askWanted: string | null = null;
  function afterPaint(): void {
    if (state.view !== "app") return;
    if (state.screen !== "ask") askWanted = null;
    if (state.screen === "project") {
      // The composer is Ask's page conversation, made a new thread in this project: again once an answer that was
      // streaming in it when the page opened has ended.
      const d = ui().detail.data;
      const c = state.ask.page;
      const ready = c.threadId === null && (c.thread?.project ?? c.project)?.slug === ui().slug;
      if (d && d.project.slug === ui().slug && !d.project.archivedAt && !ready && !c.busy) { readyAsk(d); host.rerenderSoon(); }
      return;
    }
    if (state.screen !== "ask") return;
    // Move to project lists the person's live projects.
    if (ui().list.status === "idle") loadList();
    // The open thread's project: its chats ("In <project>") and its pins count (the composer's line).
    const c = state.ask.page;
    const slug = c.thread?.project?.slug ?? c.project?.slug ?? null;
    if (!slug || slug === askWanted) return;
    askWanted = slug;
    if (ui().detail.data?.project.slug !== slug && detailFor !== slug) readDetail(slug, false);
  }

  // ── the file picker, the drop zone, the menus' outside click and Escape ────

  function install(): void {
    mount.addEventListener("change", (e) => {
      const el = e.target as HTMLElement;
      if (!(el instanceof HTMLInputElement) || el.type !== "file" || !el.hasAttribute("data-proj-file")) return;
      upload(Array.from(el.files ?? []));
      el.value = "";
    });
    const zone = (e: DragEvent) => (e.target as Element | null)?.closest?.<HTMLElement>("[data-proj-drop]") ?? null;
    mount.addEventListener("dragover", (e) => { const z = zone(e); if (!z || !e.dataTransfer?.types.includes("Files")) return; e.preventDefault(); z.setAttribute("data-over", "1"); });
    mount.addEventListener("dragleave", (e) => { zone(e)?.removeAttribute("data-over"); });
    mount.addEventListener("drop", (e) => {
      const z = zone(e);
      if (!z) return;
      e.preventDefault();
      z.removeAttribute("data-over");
      upload(Array.from(e.dataTransfer?.files ?? []));
    });
    mount.addEventListener("click", (e) => {
      const u = ui();
      if (!u.rowMenu && !u.headMenu) return;
      if ((e.target as Element | null)?.closest?.(".pj-rowmenu, .pj-headmenu, [data-act=\"projRowMenu\"], [data-act=\"projHeadMenu\"]")) return;
      u.rowMenu = null; u.headMenu = false;
      rerender();
    }, true);
    document.addEventListener("keydown", (e) => {
      const u = ui();
      if (state.view !== "app" || (state.screen !== "projects" && state.screen !== "project")) return;
      const menu = (e.target as Element | null)?.closest?.<HTMLElement>(".pj-rowmenu, .pj-headmenu");
      if (menu && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        const items = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']"));
        const at = items.indexOf(document.activeElement as HTMLElement);
        items[(at + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        e.preventDefault();
        return;
      }
      if (e.key !== "Escape") return;
      if (u.rowMenu) { const slug = u.rowMenu; u.rowMenu = null; rerender(); focus(`[data-act="projRowMenu"][data-arg="${CSS.escape(slug)}"]`); e.preventDefault(); return; }
      if (u.headMenu) { u.headMenu = false; rerender(); focus('[data-act="projHeadMenu"]'); e.preventDefault(); return; }
      if (u.instr !== null && (e.target as Element | null)?.closest?.("[data-pj-instr]") && !u.instrBusy) { u.instr = null; rerender(); focus('[data-act="projInstrEdit"]'); e.preventDefault(); }
    });
  }

  return { act, loadList, open, afterPaint, refreshDetail, install };
}
