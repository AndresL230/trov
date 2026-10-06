// Platform (superadmin) — the screens' controller: loads over /api/platform/*, and every
// `plat…` act. main.ts owns the app's one state object, the paint and the toast, so it hands
// those in (`createPlatform`) and forwards the acts; nothing here touches another screen's state.
// The views are platform.ts / platform-usage.ts (pure).

import {
  listPlatformOrgs, getPlatformOrg, createPlatformOrg, assignPlatformOrgAdmin, setPlatformOrgSuspended,
  setPersonOrgLimit, listPlatformAdmins, grantPlatformAdmin, revokePlatformAdmin, listPlatformAudit, getPlatformUsage,
  Unauthorized, ApiError,
} from "./api";
import {
  PLAT_TABS, ADMIN_KINDS, blankAddOrg, blankOwner, slugFromName, addOrgErrors, addOrgServerError, ownerServerError,
  adminError, adminTarget, assignmentSentence, lastSuperadminSentence,
  type PlatState, type PlatTab, type AdminKind,
} from "./platform";
import { USAGE_WINDOWS, type UsageWindow } from "./platform-usage";
import { DEFAULT_ORG_LIMIT } from "@shared/orgs";

export interface PlatformHost {
  /** The live state (main.ts's single object). */
  state: { plat: PlatState; screen: string; view: string };
  mount: HTMLElement;
  rerender: () => void;
  flash: (msg: string, ms?: number) => void;
  /** A 401: back to sign-in. */
  unauth: (e: unknown) => void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut: (then: () => void) => void;
  /** Leave the area (not a superadmin after all). */
  leave: () => void;
  /** Read `GET /api/orgs` again — the ONE loader (main.ts `loadMyOrgs`), which also sets
   *  `plat.superadmin`. Resolves once it has (to null when the read failed). */
  reloadOrgs: () => Promise<unknown>;
}

const code = (e: unknown): string => (e instanceof ApiError ? e.message : "");

export function createPlatform(h: PlatformHost) {
  const s = (): PlatState => h.state.plat;
  const on = (): boolean => h.state.screen === "platform" || h.state.screen === "platformorg";
  /** A failed read or write that was a 401: back to sign-in, nothing else to do. */
  const readFailed = (e: unknown): boolean => {
    if (e instanceof Unauthorized) { h.unauth(e); return true; }
    return false;
  };
  const focus = (sel: string): void => { h.mount.querySelector<HTMLElement>(sel)?.focus(); };

  function loadOrgs(): void {
    const p = s();
    p.orgs = { status: p.orgs.status === "ok" ? "ok" : "loading", data: p.orgs.data };
    listPlatformOrgs().then((rows) => { s().orgs = { status: "ok", data: rows }; h.rerender(); })
      .catch((e) => { if (readFailed(e)) return; s().orgs = { status: "error", data: s().orgs.data }; h.rerender(); });
  }
  let seq = 0;
  function loadDetail(slug: string): void {
    const p = s();
    const my = ++seq;
    const same = p.detail.data?.org.slug === slug;
    p.detail = { status: "loading", data: same ? p.detail.data : null };
    if (!same) { p.orgAudit = { status: "loading", data: [] }; p.owner = blankOwner(); }
    getPlatformOrg(slug).then((d) => { if (my !== seq) return; s().detail = { status: "ok", data: d }; h.rerender(); })
      .catch((e) => { if (readFailed(e) || my !== seq) return; s().detail = { status: "error", data: null }; h.rerender(); });
    listPlatformAudit(slug, 20).then((rows) => { if (my !== seq) return; s().orgAudit = { status: "ok", data: rows }; h.rerender(); })
      .catch((e) => { if (e instanceof Unauthorized || my !== seq) return; s().orgAudit = { status: "error", data: [] }; h.rerender(); });
  }
  let usageSeq = 0;
  function loadUsage(): void {
    const p = s();
    const my = ++usageSeq;
    p.usage = { status: "loading", data: p.usage.data };
    getPlatformUsage(p.usageDays).then((u) => { if (my !== usageSeq) return; s().usage = { status: "ok", data: u }; h.rerender(); })
      .catch((e) => { if (readFailed(e) || my !== usageSeq) return; s().usage = { status: "error", data: null }; h.rerender(); });
  }
  function loadAdmins(): void {
    const p = s();
    p.admins = { status: p.admins.status === "ok" ? "ok" : "loading", data: p.admins.data };
    listPlatformAdmins().then((rows) => { s().admins = { status: "ok", data: rows }; h.rerender(); })
      .catch((e) => { if (readFailed(e)) return; s().admins = { status: "error", data: s().admins.data }; h.rerender(); });
  }
  let auditSeq = 0;
  function loadAudit(): void {
    const p = s();
    const my = ++auditSeq;
    p.audit = { status: "loading", data: [] };
    listPlatformAudit(p.auditOrg, 100).then((rows) => { if (my !== auditSeq) return; s().audit = { status: "ok", data: rows }; h.rerender(); })
      .catch((e) => { if (readFailed(e) || my !== auditSeq) return; s().audit = { status: "error", data: [] }; h.rerender(); });
  }

  /** Load what the current Platform screen shows. Until the superadmin answer is in, it only
   *  paints (the screen says "Loading…"); `boot` calls back here when it lands. */
  function load(): void {
    const p = s();
    if (p.superadmin === false) { h.leave(); return; }
    if (p.superadmin === true) {
      if (h.state.screen === "platformorg") { if (p.orgSlug) loadDetail(p.orgSlug); }
      else if (p.tab === "usage") loadUsage();
      else if (p.tab === "admins") loadAdmins();
      else if (p.tab === "audit") { loadAudit(); if (p.orgs.status === "idle") loadOrgs(); }
      else loadOrgs();
    }
    h.rerender();
  }

  /** Is this person (still) a superadmin? Asked again after one is removed — it may have been
   *  themselves. The flag itself is set by main.ts's one `GET /api/orgs` loader. */
  function boot(): void {
    void h.reloadOrgs().then(() => {
      if (s().superadmin === null) s().superadmin = false;
      if (on()) { if (s().superadmin) load(); else h.leave(); } else h.rerender();
    });
  }

  function go(tab: PlatTab): void {
    const p = s();
    h.state.screen = "platform";
    p.tab = tab; p.orgSlug = null;
    p.suspendArm = null; p.revokeArm = null;
    load();
  }
  function openOrg(slug: string): void {
    const p = s();
    p.add = null;
    h.state.screen = "platformorg";
    p.orgSlug = slug; p.suspendArm = null;
    load();
    h.mount.querySelector<HTMLElement>("#cnpy-main")?.scrollTo(0, 0);
  }
  function closeAdd(): void {
    const d = s().add;
    if (!d || d.busy) return;
    s().add = null;
    h.rerender();
    focus("[data-plat-add-trigger]");
  }

  function submitAdd(): void {
    const d = s().add;
    if (!d || d.busy || d.done) return;
    d.errors = addOrgErrors(d);
    if (d.errors.name || d.errors.slug || d.errors.admin) {
      h.rerender();
      focus(d.errors.name ? "#plat-add-name" : d.errors.slug ? "#plat-add-slug" : "#plat-add-admin");
      return;
    }
    d.busy = true; h.rerender();
    createPlatformOrg({ slug: d.slug, name: d.name.trim(), admin: adminTarget(d.adminKind, d.adminValue) }).then((r) => {
      const cur = s().add;
      if (cur) { cur.busy = false; cur.done = { name: r.org.name, slug: r.org.slug, admin: r.admin }; }
      loadOrgs();
      h.rerender();
      focus("[data-plat-focus]");
    }).catch((e) => {
      if (readFailed(e)) return;
      const cur = s().add;
      if (!cur) return;
      cur.busy = false;
      cur.errors = addOrgServerError(code(e), cur);
      h.rerender();
      focus(cur.errors.slug ? "#plat-add-slug" : cur.errors.admin ? "#plat-add-admin" : "#plat-add-name");
    });
  }

  function submitOwner(): void {
    const p = s();
    const w = p.owner, slug = p.orgSlug;
    if (!slug || w.busy) return;
    const err = adminError(w.kind, w.value);
    if (err) { w.error = err; w.done = null; h.rerender(); return; }
    w.busy = true; w.error = null; w.done = null; h.rerender();
    assignPlatformOrgAdmin(slug, adminTarget(w.kind, w.value)).then((a) => {
      s().owner = { ...blankOwner(), kind: w.kind, done: a };
      h.flash(assignmentSentence(a, true), 4000);
      if (s().orgSlug === slug) loadDetail(slug);
    }).catch((e) => {
      if (readFailed(e)) return;
      const cur = s().owner;
      cur.busy = false; cur.error = ownerServerError(code(e), cur);
      h.rerender();
      focus("#plat-owner-input");
    });
  }

  function suspendGo(): void {
    const p = s();
    const slug = p.orgSlug, arm = p.suspendArm;
    if (!slug || !arm || p.suspendBusy) return;
    p.suspendBusy = true; h.rerender();
    setPlatformOrgSuspended(slug, arm === "suspend").then((org) => {
      const q = s();
      q.suspendBusy = false; q.suspendArm = null;
      if (q.detail.data?.org.slug === slug) q.detail = { status: "ok", data: { ...q.detail.data, org } };
      h.flash(arm === "suspend" ? `${org.name} is suspended. No data was deleted.` : `${org.name} is active again.`, 4000);
      if (s().orgSlug === slug) loadDetail(slug);
      loadOrgs();
    }).catch((e) => {
      if (readFailed(e)) return;
      const q = s();
      q.suspendBusy = false; q.suspendArm = null;
      h.flash(arm === "suspend" ? "The organization wasn't suspended. Try again." : "The organization wasn't unsuspended. Try again.", 4000);
    });
  }

  function grant(): void {
    const p = s();
    const handle = p.grantDraft.trim().replace(/^@/, "");
    if (!handle || p.grantBusy) return;
    p.grantBusy = true; p.grantError = null; h.rerender();
    grantPlatformAdmin(handle).then((rows) => {
      const q = s();
      q.grantBusy = false; q.grantDraft = ""; q.admins = { status: "ok", data: rows };
      h.flash(`@${handle} is now a superadmin.`, 4000);
    }).catch((e) => {
      if (readFailed(e)) return;
      const q = s();
      q.grantBusy = false;
      q.grantError = code(e) === "no_such_person" ? `No one has the handle @${handle}. Check the spelling; they need a Trov account first.` : "Superadmin wasn't granted. Try again.";
      h.rerender();
      focus("#plat-grant");
    });
  }
  function revokeGo(): void {
    const p = s();
    const handle = p.revokeArm;
    if (!handle || p.revokeBusy) return;
    p.revokeBusy = true; h.rerender();
    revokePlatformAdmin(handle).then((rows) => {
      const q = s();
      q.revokeBusy = false; q.revokeArm = null; q.admins = { status: "ok", data: rows };
      h.flash(`@${handle} is no longer a superadmin.`, 4000);
      // Removing yourself ends your own access: ask the server again, and leave if so.
      boot();
    }).catch((e) => {
      if (readFailed(e)) return;
      const q = s();
      q.revokeBusy = false; q.revokeArm = null;
      q.revokeError = code(e) === "last_superadmin" ? lastSuperadminSentence(handle)
        : code(e) === "not_found" ? `@${handle} is not a superadmin any more.` : `@${handle} wasn't removed. Try again.`;
      if (code(e) === "not_found") loadAdmins();
      h.rerender();
    });
  }
  function setLimit(limit: number | null): void {
    const p = s();
    const handle = p.limitHandle.trim().replace(/^@/, "");
    if (!handle || p.limitBusy) return;
    p.limitBusy = true; p.limitError = null; p.limitDone = null; h.rerender();
    setPersonOrgLimit(handle, limit).then((r) => {
      const q = s();
      q.limitBusy = false; q.limitValue = "";
      q.limitDone = r.org_limit === null
        ? `@${r.handle} is back on the default: ${DEFAULT_ORG_LIMIT} organizations.`
        : `@${r.handle} can now create up to ${r.org_limit} ${r.org_limit === 1 ? "organization" : "organizations"}.`;
      h.rerender();
    }).catch((e) => {
      if (readFailed(e)) return;
      const q = s();
      q.limitBusy = false;
      q.limitError = code(e) === "no_such_person" ? `No one has the handle @${handle}. Check the spelling.`
        : code(e) === "invalid_limit" ? "Enter a whole number from 0 to 1000." : "The limit wasn't saved. Try again.";
      h.rerender();
    });
  }

  /** Every `plat…` act. */
  function act(name: string, arg: string | null, value: string | null): void {
    const p = s();
    if (p.superadmin !== true) return;
    switch (name) {
      case "platGo": go("orgs"); return;
      case "platTab": if ((PLAT_TABS as readonly string[]).includes(arg ?? "")) go(arg as PlatTab); return;
      case "platReload": load(); return;
      case "platOpenOrg": if (arg) openOrg(arg); return;

      case "platAddOpen": p.add = blankAddOrg(); h.rerender(); focus("#plat-add-name"); return;
      case "platAddClose": closeAdd(); return;
      case "platAddName":
        if (!p.add) return;
        p.add.name = value ?? "";
        if (!p.add.slugTouched) { p.add.slug = slugFromName(p.add.name); delete p.add.errors.slug; }
        delete p.add.errors.name; delete p.add.errors.form;
        break;
      case "platAddSlug":
        if (!p.add) return;
        p.add.slug = (value ?? "").toLowerCase().replace(/\s+/g, "-");
        p.add.slugTouched = p.add.slug !== "";
        delete p.add.errors.slug; delete p.add.errors.form;
        break;
      case "platAddKind":
        if (!p.add || !(ADMIN_KINDS as readonly string[]).includes(arg ?? "")) return;
        p.add.adminKind = arg as AdminKind; p.add.adminValue = ""; delete p.add.errors.admin;
        h.rerender(); focus("#plat-add-admin");
        return;
      case "platAddAdmin":
        if (!p.add) return;
        p.add.adminValue = value ?? ""; delete p.add.errors.admin; delete p.add.errors.form;
        break;
      case "platAddSubmit": submitAdd(); return;

      case "platOwnerKind":
        if (!(ADMIN_KINDS as readonly string[]).includes(arg ?? "")) return;
        p.owner = { ...blankOwner(), kind: arg as AdminKind };
        break;
      case "platOwnerValue": p.owner.value = value ?? ""; p.owner.error = null; p.owner.done = null; break;
      case "platOwnerSubmit": submitOwner(); return;

      case "platSuspendArm": if (arg === "suspend" || arg === "unsuspend") p.suspendArm = arg; break;
      case "platSuspendCancel":
        if (p.suspendBusy || !p.suspendArm) return;
        h.confirmOut(() => { s().suspendArm = null; h.rerender(); focus("[data-confirm-trigger]"); });
        return;
      case "platSuspendGo": suspendGo(); return;

      case "platUsageDays": {
        const d = Number(arg);
        if (!(USAGE_WINDOWS as readonly number[]).includes(d)) return;
        p.usageDays = d as UsageWindow;
        loadUsage();
        break;
      }
      case "platUsageToggle": p.usageOpen = p.usageOpen === arg ? null : arg; break;

      case "platGrantDraft": p.grantDraft = value ?? ""; p.grantError = null; break;
      case "platGrantSubmit": grant(); return;
      case "platRevokeArm": if (arg) { p.revokeArm = arg; p.revokeError = null; } break;
      case "platRevokeCancel": {
        if (p.revokeBusy || !p.revokeArm) return;
        const who = p.revokeArm;
        h.confirmOut(() => { s().revokeArm = null; h.rerender(); focus(`[data-field="platRevoke:${who}"]`); });
        return;
      }
      case "platRevokeGo": revokeGo(); return;
      case "platLimitHandle": p.limitHandle = value ?? ""; p.limitError = null; p.limitDone = null; break;
      case "platLimitValue": p.limitValue = value ?? ""; p.limitError = null; p.limitDone = null; break;
      case "platLimitSubmit": {
        const v = p.limitValue.trim();
        if (!/^\d{1,4}$/.test(v) || Number(v) > 1000) { p.limitError = "Enter a whole number from 0 to 1000."; break; }
        setLimit(Number(v));
        return;
      }
      case "platLimitDefault": setLimit(null); return;

      case "platAuditOrg": p.auditOrg = value ?? ""; loadAudit(); break;
      default: return;
    }
    h.rerender();
  }

  // The add dialog's keyboard: Escape closes it, Tab stays inside it.
  document.addEventListener("keydown", (e) => {
    if (h.state.view !== "app" || !s().add) return;
    const dlg = h.mount.querySelector<HTMLElement>("[data-plat-dialog]");
    if (!dlg) return;
    if (e.key === "Escape") { e.preventDefault(); closeAdd(); return; }
    if (e.key !== "Tab") return;
    const items = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    if (at < 0 || (e.shiftKey && at === 0) || (!e.shiftKey && at === last)) {
      e.preventDefault();
      items[e.shiftKey ? last : 0].focus();
    }
  });

  return { boot, load, act };
}
