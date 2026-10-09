// Platform › Support — the tab's controller: its reads over /api/platform/support and every
// `platSupport…` act (platform-actions.ts forwards them). The view is platform-support.ts (pure).
//
// Reads follow the other tabs' rule: a first read (or one after a failure) says "loading"; a refresh
// keeps what is on screen until the new answer lands. A failed read is an error line with a retry —
// never a blank tab.

import { ApiError, Unauthorized, getPlatformSupportReport, listPlatformSupport, setPlatformSupportStatus } from "./api";
import { isSupportKindFilter, isSupportStatusFilter, type SupportTabState } from "./platform-support";
import type { SupportReport } from "@shared/support-core";

export interface SupportTabHost {
  state: { plat: { support: SupportTabState } };
  mount: HTMLElement;
  rerender: () => void;
  flash: (msg: string, ms?: number) => void;
  unauth: (e: unknown) => void;
}

export function createSupportTab(h: SupportTabHost) {
  const s = (): SupportTabState => h.state.plat.support;
  const focus = (sel: string): void => { h.mount.querySelector<HTMLElement>(sel)?.focus(); };
  const gone = (e: unknown): boolean => { if (e instanceof Unauthorized) { h.unauth(e); return true; } return false; };

  let listSeq = 0;
  /** The first page for the filter on screen. `quiet` = a refresh of what is already shown. */
  function loadList(quiet = false): void {
    const q = s();
    const my = ++listSeq;
    q.list = quiet && q.list.status === "ok" ? q.list : { status: "loading", data: q.list.data };
    q.more = "idle";
    listPlatformSupport({ status: q.status, kind: q.kind }).then((r) => {
      if (my !== listSeq) return;
      const cur = s();
      cur.list = { status: "ok", data: r.reports }; cur.next = r.next_before; cur.open = r.open;
      h.rerender();
    }).catch((e) => {
      if (gone(e) || my !== listSeq) return;
      s().list = { status: "error", data: s().list.data };
      h.rerender();
    });
  }

  function loadMore(): void {
    const q = s();
    if (q.next === null || q.more === "loading") return;
    const my = listSeq;
    q.more = "loading"; h.rerender();
    listPlatformSupport({ status: q.status, kind: q.kind, before: q.next }).then((r) => {
      if (my !== listSeq) return; // the filter changed underneath: this page belongs to another list
      const cur = s();
      const have = new Set(cur.list.data.map((x) => x.id));
      cur.list = { status: "ok", data: [...cur.list.data, ...r.reports.filter((x) => !have.has(x.id))] };
      cur.next = r.next_before; cur.open = r.open; cur.more = "idle";
      h.rerender();
    }).catch((e) => {
      if (gone(e) || my !== listSeq) return;
      s().more = "error";
      h.rerender();
    });
  }

  let detailSeq = 0;
  function loadDetail(id: number): void {
    const q = s();
    const my = ++detailSeq;
    // The row just clicked is the report: show it at once, and let the read confirm it.
    const known = q.detail.data?.id === id ? q.detail.data : q.list.data.find((r) => r.id === id) ?? null;
    q.detail = known ? { status: "ok", data: known } : { status: "loading", data: null };
    q.missing = false; q.actionError = null;
    getPlatformSupportReport(id).then((r) => {
      if (my !== detailSeq) return;
      s().detail = { status: "ok", data: r };
      h.rerender();
    }).catch((e) => {
      if (gone(e) || my !== detailSeq) return;
      const cur = s();
      cur.missing = e instanceof ApiError && e.status === 404;
      cur.detail = { status: "error", data: null };
      h.rerender();
    });
  }

  /** What the tab shows now: one report, or the list. The count rides along with either. */
  function load(): void {
    const q = s();
    if (q.reportId !== null) { loadDetail(q.reportId); if (q.list.status === "idle") loadList(); }
    else loadList(true);
  }

  /** A report changed: put it everywhere it is shown. */
  function replace(r: SupportReport): void {
    const q = s();
    if (q.detail.data?.id === r.id) q.detail = { status: "ok", data: r };
    q.list = { status: q.list.status, data: q.list.data.map((x) => (x.id === r.id ? r : x)) };
  }

  function move(status: "open" | "resolved"): void {
    const q = s();
    const id = q.reportId;
    if (id === null || q.busy) return;
    q.busy = true; q.actionError = null; h.rerender();
    setPlatformSupportStatus(id, status).then((r) => {
      const cur = s();
      cur.busy = false;
      replace(r);
      h.flash(status === "resolved" ? "Resolved. It is under Resolved now." : "Reopened.", 3000);
      loadList(true); // the filtered list and the tab's count have changed
      focus('[data-field="platSupportMove"]');
    }).catch((e) => {
      if (gone(e)) return;
      const cur = s();
      cur.busy = false;
      cur.actionError = e instanceof ApiError && e.status === 404 ? "That report no longer exists." : status === "resolved" ? "The report wasn't resolved. Check your connection and try again." : "The report wasn't reopened. Check your connection and try again.";
      h.rerender();
    });
  }

  /** Every `platSupport…` act; false = not one of them. */
  function act(name: string, arg: string | null, value: string | null): boolean {
    if (!name.startsWith("platSupport")) return false;
    const q = s();
    switch (name) {
      case "platSupportStatus":
        if (!isSupportStatusFilter(arg) || arg === q.status) return true;
        q.status = arg; q.list = { status: "loading", data: [] }; q.next = null;
        loadList();
        break;
      case "platSupportKind": {
        const v = value ?? arg;
        if (!isSupportKindFilter(v) || v === q.kind) return true;
        q.kind = v; q.list = { status: "loading", data: [] }; q.next = null;
        loadList();
        break;
      }
      case "platSupportMore": loadMore(); return true;
      case "platSupportOpen": {
        const id = Number(arg);
        if (!Number.isSafeInteger(id) || id <= 0) return true;
        q.reportId = id;
        loadDetail(id);
        h.rerender();
        window.scrollTo(0, 0);
        focus('[data-field="platSupportBack"]');
        return true;
      }
      case "platSupportBack": {
        const from = q.reportId;
        q.reportId = null; q.actionError = null; q.missing = false;
        loadList(true);
        h.rerender();
        if (from !== null) focus(`[data-field="platSupportRow:${from}"]`);
        return true;
      }
      case "platSupportResolve": move("resolved"); return true;
      case "platSupportReopen": move("open"); return true;
      default: return true;
    }
    h.rerender();
    return true;
  }

  return { load, loadList, act };
}
