// The Docs Library — the controller: every `lib…` act main.ts dispatches lands here, with the reads and writes
// behind them (the views are web/src/library.ts, pure). `state.library` is read once per org at boot (the
// sidebar's Library group shows on every screen) and again after every space write; `state.spaceHome` is the
// open space's. Every write is a cookie route; a refusal is said in words (`spaceErrorText`).
import type { AppState } from "./render";
import {
  ApiError, OrgApiError, NotFound, Unauthorized, PreviewBlocked,
  getLibrary, getSpaceHome, createSpace, editSpace, setSpaceOwners, moveSpace, archiveSpace, restoreSpace,
} from "./api";
import { blankSpaceDraft, duplicateOf, isSpaceTab, FIRST, type SpaceDraft } from "./library";
import { cleanSpaceName, cleanSpaceDescription, isSpaceColor, isSpaceIcon, type SpaceDTO, type SpaceColor } from "@shared/docs-core";

export interface LibraryHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  rerenderSoon(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** Open a doc in the reader (`#doc/<slug>`). */
  openDoc(slug: string): void;
  /** Open New page with this space preset. */
  newPage(space: string): void;
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

export function createLibraryController(host: LibraryHost): LibraryController {
  const { state } = host;
  const ui = () => state.libUi;
  const rerender = () => host.rerender();
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

  function goSpace(slug: string): void {
    if (state.spaceSlug !== slug) state.spaceTab = "overview";
    state.screen = "space";
    state.spaceSlug = slug;
    ui().desc = null;
    openSpace(slug);
  }

  /** The space the open home shows, when its read is in. */
  const open = (): SpaceDTO | null => (state.spaceHome.data && state.spaceHome.data.space.slug === state.spaceSlug ? state.spaceHome.data.space : null);

  // What opened a space dialog (New space, Edit space, Edit owners, Archive): closing it without a write gives the
  // focus back there (Cancel, Escape, the backdrop), as the confirmation modal's keyboard contract says.
  let opener: { isConnected?: boolean; focus(o?: FocusOptions): void } | null = null;
  const remember = (): void => {
    const a = host.mount.ownerDocument?.activeElement as { focus?: unknown } | null | undefined;
    opener = a && typeof a.focus === "function" ? (a as typeof opener) : null;
  };
  const giveBack = (): void => {
    const o = opener;
    opener = null;
    if (o && o.isConnected !== false) o.focus({ preventScroll: true });
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
    const before = spaces.filter((s) => s.slug !== slug);
    const at = spaces.findIndex((s) => s.slug === slug);
    const afterNow = at > 0 ? spaces[at - 1].slug : null;
    const body: { name?: string; icon?: SpaceDTO["icon"]; color?: SpaceColor; description?: string } = {};
    if (name !== cur.name) body.name = name;
    if (d.icon !== cur.icon) body.icon = d.icon;
    if (d.color !== cur.color) body.color = d.color;
    if (description !== cur.description) body.description = description;
    const moved = d.after !== afterNow && (d.after === null || before.some((s) => s.slug === d.after));
    const edit = Object.keys(body).length ? editSpace(slug, body).then((r) => { landed(r.space); }) : Promise.resolve();
    edit
      .then(() => (moved ? moveSpace(slug, d.after).then(() => undefined) : undefined))
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

  function act(act: string, arg: string | null, value: string | null): void {
    switch (act) {
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
        const spaces = state.library.data?.spaces ?? [];
        if (!sp) return;
        remember();
        const at = spaces.findIndex((s) => s.slug === sp.slug);
        ui().space = {
          ...blankSpaceDraft(), mode: "edit", slug: sp.slug, name: sp.name, description: sp.description,
          icon: isSpaceIcon(sp.icon) ? sp.icon : blankSpaceDraft().icon, color: isSpaceColor(sp.color) ? sp.color : blankSpaceDraft().color,
          after: at > 0 ? spaces[at - 1].slug : null,
        };
        rerender();
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
      case "libAfter": { const d = ui().space; const v = value ?? arg; if (d && !d.busy && v) { d.after = v === FIRST ? null : v; rerender(); } return; }
      case "libSave": { const d = ui().space; if (d) save(d); return; }
      case "libSpaceClose": if (ui().space?.busy) return; host.confirmOut(() => { ui().space = null; rerender(); giveBack(); }); return;

      // ── the description, edited in place ──────────────────────────────────
      case "libDescEdit": { const sp = open(); if (!sp || ui().desc !== null) return; ui().desc = sp.description; rerender(); focusSoon("[data-lib-desc]"); return; }
      case "libDescInput": if (ui().desc === null) return; ui().desc = value ?? ""; rerender(); return;
      case "libDescSave": saveDescription(); return;
      case "libDescCancel": if (ui().desc === null) return; ui().desc = null; rerender(); return;

      // ── owners ────────────────────────────────────────────────────────────
      case "libOwners": { const sp = open(); if (!sp) return; remember(); ui().owners = { picks: [...sp.owners], busy: false, error: null }; rerender(); return; }
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
      case "libArchive": if (!open()) return; remember(); ui().archive = { busy: false, error: null }; rerender(); return;
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
