// The Docs Library — the controller: every `lib…` act main.ts dispatches lands here, with the reads and writes
// behind them (the views are web/src/library.ts, pure). `state.library` is read once per org at boot (the
// sidebar's Library group shows on every screen) and again after every space write; `state.spaceHome` is the
// open space's. Every write is a cookie route; a refusal is said in words (`spaceErrorText`).
import type { AppState } from "./render";
import {
  ApiError, OrgApiError, NotFound, Unauthorized, PreviewBlocked,
  getLibrary, getSpaceHome, createSpace, editSpace, setSpaceOwners, archiveSpace, restoreSpace, archiveDoc, restoreDoc,
  saveLibraryPrefs,
} from "./api";
import type { ToastAction } from "./render";
import { buildTree, childrenOf } from "@shared/docs-tree-core";
import { blankSpaceDraft, duplicateOf, isSpaceTab, type SpaceDraft } from "./library";
import {
  cleanSpaceName, cleanSpaceDescription, isSpaceColor, isSpaceIcon, sidebarSlugs, DEFAULT_LIBRARY_PREFS, SIDEBAR_SPACES_MAX,
  type SpaceDTO, type SpaceColor, type LibraryPrefsDTO,
} from "@shared/docs-core";

export interface LibraryHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  rerenderSoon(): void;
  flash(msg: string, ms?: number, action?: ToastAction | null): void;
  unauth(e: unknown): void;
  /** A page was archived or restored (0083_doc_archive): read again what shows it — Review and the badges. */
  pageChanged(slug: string): void;
  /** An archive or a restore changed the tree: the open doc page is read again (the archived page itself, or a page
   *  whose "Pages under" and links it was in). */
  treeChanged(): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** Open a doc in the reader (`#doc/<slug>`). */
  openDoc(slug: string): void;
  /** Open New page with this space preset. */
  newPage(space: string): void;
  /** Run a repaint of Customize sidebar's lists so each row slides from where it was to where it lands
   *  (customize-drag.ts `slideRows`); without it, a plain repaint. */
  slide?(paint: () => void): void;
}

export interface LibraryController {
  act(act: string, arg: string | null, value: string | null): void;
  /** Read the Library (again). */
  load(): void;
  /** Open one space's home (its read; the screen is set by the caller or here). */
  openSpace(slug: string | null): void;
  /** Read a space's pages into `spaceHome` unless it already holds them (the docs pane on a doc page and New page). */
  ensureSpace(slug: string): void;
}

/** A refusal of Archive page / Restore as words (0083_doc_archive). */
export function pageArchiveErrorText(e: unknown, fallback: string): string {
  if (e instanceof PreviewBlocked) return "This is a preview: nothing is changed.";
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  switch (e.message) {
    case "forbidden": return "Only an admin, or an owner of this space, can archive or restore its pages.";
    case "archived": return "That page is already archived.";
    case "not_archived": return "That page isn't archived any more. Reload the page.";
    case "space_archived": return "This space is archived. Restore the space first.";
    case "not_found": return "That page isn't there any more. Reload the page.";
    default: return `${fallback} Try again.`;
  }
}

/** A refusal of a space route as words that say what to do next. */
export function spaceErrorText(e: unknown, fallback: string): string {
  if (e instanceof PreviewBlocked) return "This is a preview: nothing is changed.";
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  // The server's own words, as a sentence: a capital first, a full stop last (case LH8: "there's already a space…").
  const raw = e instanceof OrgApiError ? e.detail : null;
  const detail = raw ? `${raw[0].toUpperCase()}${raw.slice(1)}${/[.!?]$/.test(raw) ? "" : "."}` : null;
  switch (e.message) {
    case "name_taken": return detail ?? "A space already has that name. Pick another name.";
    case "forbidden": return "Only an admin, or an owner of this space, can change that.";
    case "archived": return "That space is archived. Restore it first.";
    case "not_found": return "That space is not there any more. Reload the page.";
    case "not_member": return detail ?? "An owner must be a member of this organization.";
    case "invalid": return detail ?? `${fallback} Check what you entered.`;
    default: return detail ?? `${fallback} Try again.`;
  }
}

/** The acts of a space's header "…" menu that the controller runs (Import is main.ts's `goImport`). */
const HEAD_ITEMS = new Set(["libEdit", "libDescEdit", "libOwners", "libArchive"]);

export function createLibraryController(host: LibraryHost): LibraryController {
  const { state } = host;
  const ui = () => state.libUi;
  const rerender = () => host.rerender();
  /** A repaint of Customize sidebar's lists, its rows sliding into their new places. */
  const slide = () => (host.slide ? host.slide(rerender) : rerender());
  const fail = (e: unknown): boolean => { if (e instanceof Unauthorized) { host.unauth(e); return true; } return false; };
  let libSeq = 0;
  let homeSeq = 0;

  function load(): void {
    const seq = ++libSeq;
    state.library = { status: "loading", data: state.library.data };
    getLibrary()
      .then((data) => { if (seq !== libSeq) return; state.library = { status: "ok", data }; host.rerenderSoon(); })
      .catch((e) => { if (fail(e) || seq !== libSeq) return; state.library = { status: "error", data: state.library.data, error: String(e) }; host.rerenderSoon(); });
  }

  function openSpace(slug: string | null): void {
    if (!slug) { rerender(); return; }
    const seq = ++homeSeq;
    const same = state.spaceHome.data?.space.slug === slug;
    state.spaceHome = { status: "loading", data: same ? state.spaceHome.data : null };
    rerender();
    getSpaceHome(slug)
      .then((data) => { if (seq !== homeSeq) return; state.spaceHome = { status: "ok", data }; host.rerenderSoon(); })
      .catch((e) => {
        if (fail(e) || seq !== homeSeq) return;
        state.spaceHome = e instanceof NotFound ? { status: "ok", data: null } : { status: "error", data: same ? state.spaceHome.data : null, error: String(e) };
        host.rerenderSoon();
      });
  }

  function ensureSpace(slug: string): void {
    const h = state.spaceHome;
    if (h.data?.space.slug === slug && (h.status === "ok" || h.status === "loading")) return;
    openSpace(slug);
  }

  /** A space a write answered with: put it everywhere it shows (the open home, the Library's lists). */
  function landed(sp: SpaceDTO): void {
    const h = state.spaceHome.data;
    if (h && h.space.slug === sp.slug) state.spaceHome = { ...state.spaceHome, data: { ...h, space: { ...sp, pages: h.space.pages, waiting: h.space.waiting } } };
    const lib = state.library.data;
    if (lib) {
      const swap = (list: SpaceDTO[]) => list.map((x) => (x.slug === sp.slug ? { ...sp, pages: x.pages, waiting: x.waiting } : x));
      state.library = { ...state.library, data: { ...lib, spaces: swap(lib.spaces), archived: swap(lib.archived) } };
    }
  }

  // ── the person's own view: the sidebar's spaces, pinned and hidden cards ──
  const prefsNow = (): LibraryPrefsDTO => state.library.data?.prefs ?? DEFAULT_LIBRARY_PREFS;
  const setPrefs = (prefs: LibraryPrefsDTO): void => {
    const lib = state.library.data;
    if (lib) state.library = { ...state.library, data: { ...lib, prefs } };
  };
  /** Apply a change at once and save it; on a refusal put the view back and say why. */
  function savePrefs(next: LibraryPrefsDTO, done: string): void {
    const before = prefsNow();
    setPrefs(next);
    ui().cardMenu = null;
    rerender();
    saveLibraryPrefs(next)
      .then(({ prefs }) => { setPrefs(prefs); host.flash(done); rerender(); })
      .catch((e) => { if (fail(e)) return; setPrefs(before); host.flash(spaceErrorText(e, "Couldn't save your Library view.")); rerender(); });
  }
  const liveSpaces = (): SpaceDTO[] => state.library.data?.spaces ?? [];
  const nameOf = (slug: string): string => liveSpaces().find((s) => s.slug === slug)?.name ?? slug;

  function saveCustomize(): void {
    const c = ui().customize;
    if (!c || c.busy) return;
    c.busy = true; c.error = null;
    rerender();
    const next: LibraryPrefsDTO = { ...prefsNow(), sidebar: c.dflt ? null : [...c.list] };
    saveLibraryPrefs({ sidebar: next.sidebar })
      .then(({ prefs }) => { setPrefs(prefs); host.confirmOut(() => { ui().customize = null; rerender(); giveBack(); }); host.flash("Sidebar saved"); })
      .catch((e) => { if (fail(e)) return; c.busy = false; c.error = spaceErrorText(e, "Couldn't save your sidebar."); rerender(); });
  }

  function goSpace(slug: string): void {
    if (state.spaceSlug !== slug) state.spaceTab = "overview";
    state.screen = "space";
    state.spaceSlug = slug;
    ui().desc = null;
    ui().headMenu = false;
    openSpace(slug);
  }

  /** The space the open home shows, when its read is in. */
  const open = (): SpaceDTO | null => (state.spaceHome.data && state.spaceHome.data.space.slug === state.spaceSlug ? state.spaceHome.data.space : null);

  // What opened a space dialog (New space, Edit space, Edit owners, Archive): closing it without a write gives the
  // focus back there (Cancel, Escape, the backdrop), as the confirmation modal's keyboard contract says.
  let opener: { isConnected?: boolean; focus(o?: FocusOptions): void } | null = null;
  // …or, when what opened it goes with the dialog's opening (a pane row's "…" menu item), this element instead.
  let openerElse: string | null = null;
  const remember = (orElse: string | null = null): void => {
    const a = host.mount.ownerDocument?.activeElement as { focus?: unknown } | null | undefined;
    opener = a && typeof a.focus === "function" ? (a as typeof opener) : null;
    openerElse = orElse;
  };
  const giveBack = (): void => {
    const o = opener;
    const orElse = openerElse;
    opener = null; openerElse = null;
    if (o && o.isConnected !== false) o.focus({ preventScroll: true });
    else if (orElse) host.mount.querySelector<HTMLElement>(orElse)?.focus({ preventScroll: true });
  };

  function focusSoon(selector: string): void {
    requestAnimationFrame(() => {
      const el = host.mount.querySelector<HTMLInputElement>(selector);
      if (el) { el.focus(); try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* not a text field */ } }
    });
  }

  function save(d: SpaceDraft): void {
    const spaces = state.library.data?.spaces ?? [];
    const name = cleanSpaceName(d.name);
    const description = cleanSpaceDescription(d.description);
    if (!name || description === null || duplicateOf(d, spaces) || d.busy) return;
    d.busy = true; d.error = null;
    rerender();
    const failed = (e: unknown, fallback: string) => {
      if (fail(e)) return;
      d.busy = false; d.error = spaceErrorText(e, fallback);
      rerender();
    };
    if (d.mode === "create") {
      createSpace({ name, icon: d.icon, color: d.color, ...(description ? { description } : {}) })
        .then(({ space }) => {
          host.confirmOut(() => {
            ui().space = null;
            state.spaceHome = { status: "ok", data: { space, pages: [], can_edit: true, can_admin: true } };
            goSpace(space.slug);
            host.flash(`Created ${space.name}`);
          });
          load();
        })
        .catch((e) => failed(e, "Couldn't create the space."));
      return;
    }
    const slug = d.slug;
    const cur = spaces.find((s) => s.slug === slug) ?? open();
    if (!slug || !cur) { d.busy = false; rerender(); return; }
    const body: { name?: string; icon?: SpaceDTO["icon"]; color?: SpaceColor; description?: string } = {};
    if (name !== cur.name) body.name = name;
    if (d.icon !== cur.icon) body.icon = d.icon;
    if (d.color !== cur.color) body.color = d.color;
    if (description !== cur.description) body.description = description;
    const edit = Object.keys(body).length ? editSpace(slug, body).then((r) => { landed(r.space); }) : Promise.resolve();
    edit
      .then(() => {
        host.confirmOut(() => { ui().space = null; rerender(); });
        host.flash(`Saved ${name}`);
        load();
      })
      .catch((e) => failed(e, "Couldn't save the space."));
  }

  function saveDescription(): void {
    const sp = open();
    const draft = ui().desc;
    if (!sp || draft === null) return;
    const description = cleanSpaceDescription(draft);
    ui().desc = null;
    if (description === null || description === sp.description) { rerender(); return; }
    const was = sp.description;
    landed({ ...sp, description });
    rerender();
    editSpace(sp.slug, { description })
      .then((r) => { landed(r.space); rerender(); })
      .catch((e) => {
        if (fail(e)) return;
        landed({ ...sp, description: was });
        host.flash(spaceErrorText(e, "Couldn't save the description."), 5000);
        rerender();
      });
  }

  function restore(slug: string): void {
    if (ui().restoring) return;
    ui().restoring = slug;
    rerender();
    restoreSpace(slug)
      .then(({ space }) => {
        ui().restoring = null;
        landed(space);
        host.flash(`Restored ${space.name}`);
        load();
        if (state.screen === "space" && state.spaceSlug === slug) openSpace(slug); else rerender();
      })
      .catch((e) => {
        if (fail(e)) return;
        ui().restoring = null;
        host.flash(spaceErrorText(e, "Couldn't restore the space."), 6000);
        rerender();
      });
  }

  // ── Archive page / Restore (0083_doc_archive) ─────────────────────────────
  /** What the confirmation needs about `slug`: its title, how many pages sit right under it, its space's name. */
  function pageFacts(slug: string): { title: string; under: number; space: string } | null {
    const h = state.spaceHome.data;
    const d = state.docDetail.data;
    const pg = h?.pages.find((p) => p.slug === slug);
    if (h && pg) return { title: pg.title, under: childrenOf(buildTree(h.pages), slug, pg.space).length, space: h.space.slug };
    if (d && d.doc.slug === slug) return { title: d.doc.title, under: d.page?.children.length ?? 0, space: d.doc.space };
    return null;
  }
  const spaceNameOf = (slug: string): string =>
    (state.spaceHome.data?.space.slug === slug ? state.spaceHome.data.space.name : null)
      ?? state.library.data?.spaces.find((s) => s.slug === slug)?.name ?? slug;

  /** Read again what an archive or a restore changed: the space's tree and its Archived pages, the Library's counts. */
  function afterPage(space: string, slug: string): void {
    load();
    if (state.spaceHome.data?.space.slug === space) openSpace(space);
    host.pageChanged(slug);
    host.treeChanged();
  }

  function archivePage(): void {
    const a = ui().pageArchive;
    if (!a || a.busy) return;
    a.busy = true; a.error = null;
    rerender();
    const space = pageFacts(a.slug)?.space ?? state.spaceHome.data?.space.slug ?? "";
    archiveDoc(a.slug)
      .then(() => {
        host.confirmOut(() => { ui().pageArchive = null; rerender(); });
        host.flash(`Archived ${a.title}`, 6000, { label: "Undo", act: "libPageRestore", arg: a.slug });
        afterPage(space, a.slug);
      })
      .catch((e) => { if (fail(e)) return; a.busy = false; a.error = pageArchiveErrorText(e, "Couldn't archive the page."); rerender(); });
  }

  function restorePage(slug: string): void {
    if (ui().pageRestoring) return;
    ui().pageRestoring = slug;
    rerender();
    const h = state.spaceHome.data;
    const d = state.docDetail.data;
    const title = h?.archived_pages?.find((p) => p.slug === slug)?.title ?? (d?.doc.slug === slug ? d.doc.title : null) ?? slug;
    const space = (d?.doc.slug === slug ? d.doc.space : null) ?? h?.space.slug ?? "";
    restoreDoc(slug)
      .then((r) => {
        ui().pageRestoring = null;
        const where = r.parent_slug ? h?.pages.find((p) => p.slug === r.parent_slug)?.title ?? null : null;
        host.flash(where ? `Restored ${title} under ${where}` : `Restored ${title} to the top level of ${spaceNameOf(space)}`, 5000, { label: "Open", act: "libOpenDoc", arg: slug });
        afterPage(space, slug);
        rerender();
      })
      .catch((e) => { if (fail(e)) return; ui().pageRestoring = null; host.flash(pageArchiveErrorText(e, "Couldn't restore the page."), 6000); rerender(); });
  }

  function act(act: string, arg: string | null, value: string | null): void {
    // An item of a space's header menu: the menu closes and the "…" takes the focus first, so a dialog the item opens
    // hands the focus back to it when it closes.
    if (ui().headMenu && HEAD_ITEMS.has(act)) {
      ui().headMenu = false;
      host.mount.querySelector<HTMLElement>('[data-act="libHeadMenu"]')?.focus({ preventScroll: true });
    }
    switch (act) {
      case "libPageArchive": {
        state.treeMenu = null;
        const facts = arg ? pageFacts(arg) : null;
        if (!arg || !facts) { rerender(); return; }
        // From the row's "…" menu the menu item closes with it: the focus comes back to that row's "…".
        remember(`.cnpy-dp-row[data-dtree="${arg}"] [data-act="treeMenu"]`);
        ui().pageArchive = { slug: arg, title: facts.title, under: facts.under, spaceName: spaceNameOf(facts.space), busy: false, error: null };
        rerender();
        // The confirmation's contract: its button is focused on open, so Enter / Space press it (confirm.ts).
        host.mount.querySelector<HTMLElement>("#lib-page-archive [data-confirm-focus]")?.focus();
        return;
      }
      case "libPageArchiveGo": archivePage(); return;
      case "libPageArchiveClose": if (ui().pageArchive?.busy) return; host.confirmOut(() => { ui().pageArchive = null; rerender(); giveBack(); }); return;
      case "libPageRestore": if (arg) restorePage(arg); return;
      // ── a space's header "…" menu ─────────────────────────────────────────
      case "libHeadMenu": ui().headMenu = !ui().headMenu; rerender(); return;
      // ── your own Library view (Library home's cards, the sidebar) ─────────
      case "libCardMenu": ui().cardMenu = arg && ui().cardMenu !== arg ? arg : null; rerender(); return;
      case "libHiddenToggle": ui().showHidden = !ui().showHidden; rerender(); return;
      case "libPin": {
        if (!arg) return;
        const p = prefsNow();
        savePrefs({ ...p, pinned: [arg, ...p.pinned.filter((k) => k !== arg)], hidden: p.hidden.filter((k) => k !== arg) }, `Pinned ${nameOf(arg)}`);
        return;
      }
      case "libUnpin": { if (!arg) return; const p = prefsNow(); savePrefs({ ...p, pinned: p.pinned.filter((k) => k !== arg) }, `Unpinned ${nameOf(arg)}`); return; }
      case "libHide": {
        if (!arg) return;
        const p = prefsNow();
        savePrefs({ ...p, hidden: [...p.hidden.filter((k) => k !== arg), arg], pinned: p.pinned.filter((k) => k !== arg) }, `Hid ${nameOf(arg)} from Library home`);
        return;
      }
      case "libShowCard": { if (!arg) return; const p = prefsNow(); savePrefs({ ...p, hidden: p.hidden.filter((k) => k !== arg) }, `${nameOf(arg)} is back on Library home`); return; }
      case "libSidebarAdd": {
        if (!arg) return;
        const p = prefsNow();
        const list = sidebarSlugs(liveSpaces(), p);
        if (list.includes(arg)) { ui().cardMenu = null; rerender(); return; }
        if (list.length >= SIDEBAR_SPACES_MAX) { host.flash(`Your sidebar shows ${SIDEBAR_SPACES_MAX} spaces. Remove one first, or use Customize sidebar.`, 5000); return; }
        savePrefs({ ...p, sidebar: [...list, arg] }, `${nameOf(arg)} is in your sidebar`);
        return;
      }
      case "libSidebarRemove": {
        if (!arg) return;
        const p = prefsNow();
        savePrefs({ ...p, sidebar: sidebarSlugs(liveSpaces(), p).filter((k) => k !== arg) }, `Removed ${nameOf(arg)} from your sidebar`);
        return;
      }
      case "libCustomize": {
        if (!state.library.data) return;
        remember();
        ui().cardMenu = null;
        const p = prefsNow();
        ui().customize = { list: sidebarSlugs(liveSpaces(), p), dflt: p.sidebar === null, busy: false, error: null };
        rerender();
        host.mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        return;
      }
      case "libCustomizeUp": case "libCustomizeDown": {
        const c = ui().customize;
        if (!c || c.busy || !arg) return;
        const i = c.list.indexOf(arg);
        const j = act === "libCustomizeUp" ? i - 1 : i + 1;
        if (i < 0 || j < 0 || j >= c.list.length) return;
        [c.list[i], c.list[j]] = [c.list[j], c.list[i]];
        c.dflt = false;
        slide();
        return;
      }
      case "libCustomizeOrder": {
        // A drop (customize-drag.ts): the picked slugs in their new order — only ones already picked, each once.
        const c = ui().customize;
        if (!c || c.busy || !arg) return;
        const order = [...new Set(arg.split(","))].filter((k) => c.list.includes(k));
        if (order.length !== c.list.length || order.every((k, i) => k === c.list[i])) { rerender(); return; }
        c.list = order; c.dflt = false;
        rerender();
        return;
      }
      case "libCustomizeRemove": { const c = ui().customize; if (!c || c.busy || !arg) return; c.list = c.list.filter((k) => k !== arg); c.dflt = false; slide(); return; }
      case "libCustomizeAdd": {
        const c = ui().customize;
        if (!c || c.busy || !arg || c.list.includes(arg) || c.list.length >= SIDEBAR_SPACES_MAX) return;
        c.list = [...c.list, arg]; c.dflt = false;
        slide();
        return;
      }
      case "libCustomizeReset": {
        const c = ui().customize;
        if (!c || c.busy) return;
        c.list = sidebarSlugs(liveSpaces(), null); c.dflt = true;
        slide();
        return;
      }
      case "libCustomizeSave": saveCustomize(); return;
      case "libCustomizeClose": if (ui().customize?.busy) return; host.confirmOut(() => { ui().customize = null; rerender(); giveBack(); }); return;
      case "libOpenSpace": if (arg) goSpace(arg); return;
      case "libOpenDoc": if (arg) host.openDoc(arg); return;
      case "libNewPage": host.newPage(arg ?? state.spaceSlug ?? ""); return;
      case "libTab":
        if (!isSpaceTab(arg) || arg === state.spaceTab) return;
        state.spaceTab = arg;
        rerender();
        return;

      // ── Create / Edit space ───────────────────────────────────────────────
      case "libNew":
        // The dialog sits over Library home (or the space's home it was opened from), both patched in place.
        if (state.screen !== "library" && state.screen !== "space") { state.screen = "library"; if (state.library.status !== "loading") load(); }
        remember();
        ui().space = blankSpaceDraft();
        rerender();
        // Name focused on open (design §7), right after the render — not in an animation frame, which a hidden tab
        // never paints.
        host.mount.querySelector<HTMLInputElement>("#lib-sp-name")?.focus();
        return;
      case "libEdit": {
        const sp = open();
        if (!sp) return;
        remember();
        ui().space = {
          ...blankSpaceDraft(), mode: "edit", slug: sp.slug, name: sp.name, description: sp.description,
          icon: isSpaceIcon(sp.icon) ? sp.icon : blankSpaceDraft().icon, color: isSpaceColor(sp.color) ? sp.color : blankSpaceDraft().color,
        };
        rerender();
        // Into the dialog at once, as New space does (a dialog opened from the keyboard must take the focus).
        host.mount.querySelector<HTMLElement>("#lib-sp-name")?.focus();
        return;
      }
      case "libField": {
        const d = ui().space;
        if (!d || d.busy) return;
        if (arg === "name") d.name = value ?? "";
        else if (arg === "description") d.description = value ?? "";
        else return;
        d.error = null;
        rerender();
        return;
      }
      case "libIcon": { const d = ui().space; if (d && !d.busy && isSpaceIcon(arg)) { d.icon = arg; rerender(); } return; }
      case "libColor": { const d = ui().space; if (d && !d.busy && isSpaceColor(arg)) { d.color = arg as SpaceColor; rerender(); } return; }
      case "libSave": { const d = ui().space; if (d) save(d); return; }
      case "libSpaceClose": if (ui().space?.busy) return; host.confirmOut(() => { ui().space = null; rerender(); giveBack(); }); return;

      // ── the description, edited in place ──────────────────────────────────
      case "libDescEdit": { const sp = open(); if (!sp || ui().desc !== null) return; ui().desc = sp.description; rerender(); focusSoon("[data-lib-desc]"); return; }
      case "libDescInput": if (ui().desc === null) return; ui().desc = value ?? ""; rerender(); return;
      case "libDescSave": saveDescription(); return;
      case "libDescCancel": if (ui().desc === null) return; ui().desc = null; rerender(); return;

      // ── owners ────────────────────────────────────────────────────────────
      case "libOwners": {
        const sp = open(); if (!sp) return;
        remember(); ui().owners = { picks: [...sp.owners], busy: false, error: null }; rerender();
        // The first person in the list (else Save owners): a keyboard user lands in the dialog, not on its trigger.
        host.mount.querySelector<HTMLElement>("#lib-owners .cnpy-libm-person, #lib-owners [data-confirm-focus]")?.focus();
        return;
      }
      case "libOwnerToggle": {
        const o = ui().owners;
        if (!o || o.busy || !arg) return;
        const has = o.picks.some((h) => h.toLowerCase() === arg.toLowerCase());
        o.picks = has ? o.picks.filter((h) => h.toLowerCase() !== arg.toLowerCase()) : [...o.picks, arg];
        o.error = null;
        rerender();
        return;
      }
      case "libOwnersSave": {
        const o = ui().owners;
        const sp = open();
        if (!o || !sp || o.busy) return;
        o.busy = true; o.error = null;
        rerender();
        setSpaceOwners(sp.slug, o.picks)
          .then(({ space }) => { landed(space); host.confirmOut(() => { ui().owners = null; rerender(); }); host.flash("Owners saved"); load(); })
          .catch((e) => { if (fail(e)) return; o.busy = false; o.error = spaceErrorText(e, "Couldn't save the owners."); rerender(); });
        return;
      }
      case "libOwnersClose": if (ui().owners?.busy) return; host.confirmOut(() => { ui().owners = null; rerender(); giveBack(); }); return;

      // ── archive / restore (an admin) ──────────────────────────────────────
      case "libArchive":
        if (!open()) return;
        remember(); ui().archive = { busy: false, error: null }; rerender();
        // The confirmation's contract: its button is focused on open, so Enter / Space press it (confirm.ts).
        host.mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        return;
      case "libArchiveGo": {
        const a = ui().archive;
        const sp = open();
        if (!a || !sp || a.busy) return;
        a.busy = true; a.error = null;
        rerender();
        archiveSpace(sp.slug)
          .then(({ space }) => { landed(space); host.confirmOut(() => { ui().archive = null; rerender(); }); host.flash(`Archived ${space.name}`); load(); })
          .catch((e) => { if (fail(e)) return; a.busy = false; a.error = spaceErrorText(e, "Couldn't archive the space."); rerender(); });
        return;
      }
      case "libArchiveClose": if (ui().archive?.busy) return; host.confirmOut(() => { ui().archive = null; rerender(); giveBack(); }); return;
      case "libRestore": if (arg) restore(arg); return;
    }
  }

  return { act, load, openSpace, ensureSpace };
}
