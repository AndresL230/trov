// Platform › Access and "Change plan" — the controller (the views are platform-access.ts). It is
// created by platform-actions.ts with the same host, and takes every `platGrant…` / `platPlan…` act;
// `act` answers whether the act was one of its own.

import { ApiError, Unauthorized, listPlatformGrants, createPlatformGrant, revokePlatformGrant, setPlatformOrgPlan, followPlatformOrgSubscription } from "./api";
import { ADMIN_KINDS, adminError, type AdminKind, type PlatState } from "./platform";
import {
  blankGrant, blankLimits, grantServerError, grantTarget, grantWho, limitDraftOf, parseLimitDraft,
  type AccessState, type ExpiryChoice,
} from "./platform-access";
import { PLANS, isPlanId, LIMIT_KEYS, GRANT_EXPIRY_DAYS, type LimitKey } from "@shared/plans";
import type { PlatformOrgRow } from "@shared/orgs";

export interface AccessHost {
  state: { plat: PlatState; screen: string; view: string };
  mount: HTMLElement;
  rerender: () => void;
  flash: (msg: string, ms?: number) => void;
  unauth: (e: unknown) => void;
  confirmOut: (then: () => void) => void;
  /** The org's row changed (its plan): put it on the page and in the list. */
  orgChanged: (org: PlatformOrgRow) => void;
}

const code = (e: unknown): string => (e instanceof ApiError ? e.message : "");

export function createAccess(h: AccessHost) {
  const a = (): AccessState => h.state.plat.access;
  const focus = (sel: string): void => { h.mount.querySelector<HTMLElement>(sel)?.focus(); };
  const gone = (e: unknown): boolean => { if (e instanceof Unauthorized) { h.unauth(e); return true; } return false; };

  /** The grants: a refresh keeps what is on screen until the fresh list lands. */
  function load(): void {
    const s = a();
    s.grants = { status: s.grants.status === "ok" ? "ok" : "loading", data: s.grants.data };
    listPlatformGrants().then((rows) => { a().grants = { status: "ok", data: rows }; h.rerender(); })
      .catch((e) => { if (gone(e)) return; a().grants = { status: "error", data: a().grants.data }; h.rerender(); });
  }

  function closeGrant(): void {
    const d = a().grant;
    if (!d || d.busy) return;
    a().grant = null;
    h.rerender();
    focus("[data-plat-grant-trigger]");
  }
  function submitGrant(): void {
    const d = a().grant;
    if (!d || d.busy || d.done) return;
    const to = adminError(d.kind, d.value);
    const limits = parseLimitDraft(d.limits);
    d.errors = { ...(to ? { to } : {}), ...("error" in limits ? { limits: limits.error } : {}) };
    if (to || "error" in limits) {
      if ("error" in limits) d.limitsOpen = true;
      h.rerender();
      focus(to ? "#plat-grant-to" : "#plat-grant-limit-seats");
      return;
    }
    d.busy = true; h.rerender();
    const note = d.note.trim();
    createPlatformGrant({
      to: grantTarget(d), plan: d.plan, overrides: limits.overrides, ...(note ? { note } : {}),
      expires_in_days: d.expiry === "never" ? null : Number(d.expiry),
    }).then((g) => {
      const cur = a().grant;
      if (cur) { cur.busy = false; cur.done = g; }
      load();
      h.rerender();
      focus("[data-plat-focus]");
    }).catch((e) => {
      if (gone(e)) return;
      const cur = a().grant;
      if (!cur) return;
      cur.busy = false;
      cur.errors = grantServerError(code(e), cur);
      h.rerender();
      focus(cur.errors.to ? "#plat-grant-to" : "#plat-grant-note");
    });
  }
  function revokeGo(): void {
    const s = a();
    const id = s.revokeArm;
    if (id === null || s.revokeBusy) return;
    const g = s.grants.data.find((x) => x.id === id);
    s.revokeBusy = true; h.rerender();
    revokePlatformGrant(id).then(() => {
      a().revokeBusy = false; a().revokeArm = null;
      h.flash(`Revoked the grant for ${g ? grantWho(g).name : "them"}.`, 4000);
      load();
    }).catch((e) => {
      if (gone(e)) return;
      a().revokeBusy = false; a().revokeArm = null;
      h.flash(code(e) === "grant_used" ? "That grant was already used: the organization exists. Change or suspend it on its page." : code(e) === "not_found" ? "That grant is no longer unused." : "The grant wasn't revoked. Try again.", 5000);
      load();
    });
  }

  function openPlan(): void {
    const d = h.state.plat.detail.data;
    if (!d?.org.plan) return;
    a().plan = {
      slug: d.org.slug, name: d.org.name, current: d.org.plan, artifactBytes: d.usage?.sizes.artifact_bytes ?? null,
      plan: d.org.plan.plan, limits: limitDraftOf(d.org.plan.overrides), confirm: false, busy: false, error: null,
    };
    h.rerender();
    focus("#plat-plan-pick");
  }
  function closePlan(): void {
    const d = a().plan;
    if (!d || d.busy) return;
    a().plan = null;
    h.rerender();
    focus("[data-plat-plan-trigger]");
  }
  function reviewPlan(): void {
    const d = a().plan;
    if (!d) return;
    const parsed = parseLimitDraft(d.limits);
    if ("error" in parsed) { d.error = parsed.error; h.rerender(); focus("#plat-plan-limit-seats"); return; }
    d.error = null; d.confirm = true;
    h.rerender();
    focus("[data-confirm-focus]");
  }
  function planGo(): void {
    const d = a().plan;
    if (!d || d.busy) return;
    const parsed = parseLimitDraft(d.limits);
    if ("error" in parsed) return;
    d.busy = true; h.rerender();
    setPlatformOrgPlan(d.slug, { plan: d.plan, overrides: parsed.overrides }).then((org) => {
      a().plan = null;
      h.orgChanged(org);
      h.flash(`${org.name} is on the ${PLANS[d.plan].name} plan. Nothing was removed.`, 4000);
      focus("[data-plat-plan-trigger]");
    }).catch((e) => {
      if (gone(e)) return;
      const cur = a().plan;
      if (!cur) return;
      cur.busy = false; cur.confirm = false;
      cur.error = code(e) === "invalid_overrides" ? "One of the limits isn't valid. Seats must be at least 1; the rest whole numbers, or “unlimited”." : "The plan wasn't changed. Check your connection and try again.";
      h.rerender();
    });
  }

  /** A paid org whose plan was set by hand: back to the plan its subscription pays for. */
  let following = false;
  function followSubscription(): void {
    const d = h.state.plat.detail.data;
    if (!d?.org.plan?.billing?.pinned || following) return;
    following = true;
    followPlatformOrgSubscription(d.org.slug).then((org) => {
      h.orgChanged(org);
      h.flash(`${org.name} follows its subscription again: ${PLANS[org.plan?.plan ?? "personal"].name}. Nothing was removed.`, 4000);
      focus("[data-plat-plan-trigger]");
    }).catch((e) => {
      if (gone(e)) return;
      h.flash("The plan wasn't changed. Check your connection and try again.", 6000);
    }).finally(() => { following = false; });
  }

  /** True when `name` was one of this controller's acts. */
  function act(name: string, arg: string | null, value: string | null): boolean {
    const s = a();
    switch (name) {
      case "platGrantOpen": s.grant = blankGrant(); h.rerender(); focus("#plat-grant-to"); return true;
      case "platGrantClose": closeGrant(); return true;
      case "platGrantKind":
        if (!s.grant || !(ADMIN_KINDS as readonly string[]).includes(arg ?? "")) return true;
        s.grant.kind = arg as AdminKind; s.grant.value = ""; delete s.grant.errors.to;
        h.rerender(); focus("#plat-grant-to");
        return true;
      case "platGrantValue": if (s.grant) { s.grant.value = value ?? ""; delete s.grant.errors.to; delete s.grant.errors.form; } break;
      case "platGrantPlan":
        if (s.grant && isPlanId(value)) { s.grant.plan = value; if (value !== "enterprise" && LIMIT_KEYS.every((k) => s.grant!.limits[k].trim() === "")) s.grant.limitsOpen = false; }
        break;
      case "platGrantLimits": if (s.grant) { s.grant.limitsOpen = true; h.rerender(); focus("#plat-grant-limit-seats"); } return true;
      case "platGrantLimit": if (s.grant && (LIMIT_KEYS as readonly string[]).includes(arg ?? "")) { s.grant.limits[arg as LimitKey] = value ?? ""; delete s.grant.errors.limits; } break;
      case "platGrantNote": if (s.grant) { s.grant.note = value ?? ""; delete s.grant.errors.form; } break;
      case "platGrantExpiry": if (s.grant && (value === "never" || (GRANT_EXPIRY_DAYS as readonly number[]).includes(Number(value)))) s.grant.expiry = value as ExpiryChoice; break;
      case "platGrantSubmit": submitGrant(); return true;
      case "platGrantRevokeArm": { const id = Number(arg); if (Number.isInteger(id)) s.revokeArm = id; break; }
      case "platGrantRevokeCancel": {
        if (s.revokeBusy || s.revokeArm === null) return true;
        const id = s.revokeArm;
        h.confirmOut(() => { a().revokeArm = null; h.rerender(); focus(`[data-field="platGrantRevoke:${id}"]`); });
        return true;
      }
      case "platGrantRevokeGo": revokeGo(); return true;

      case "platPlanOpen": openPlan(); return true;
      case "platPlanClose": closePlan(); return true;
      case "platPlanPick": if (s.plan && isPlanId(value)) { s.plan.plan = value; if (value !== s.plan.current.plan) s.plan.limits = blankLimits(); else s.plan.limits = limitDraftOf(s.plan.current.overrides); s.plan.error = null; } break;
      case "platPlanLimit": if (s.plan && (LIMIT_KEYS as readonly string[]).includes(arg ?? "")) { s.plan.limits[arg as LimitKey] = value ?? ""; s.plan.error = null; } break;
      case "platPlanReview": reviewPlan(); return true;
      case "platPlanBack":
        if (!s.plan || s.plan.busy) return true;
        h.confirmOut(() => { const d = a().plan; if (d) d.confirm = false; h.rerender(); focus("#plat-plan-pick"); });
        return true;
      case "platPlanGo": planGo(); return true;
      case "platPlanFollow": followSubscription(); return true;
      default: return false;
    }
    h.rerender();
    return true;
  }

  // The two form dialogs' keyboard: Escape closes, Tab stays inside. (A confirmation's keys are main.ts's.)
  document.addEventListener("keydown", (e) => {
    if (h.state.view !== "app" && h.state.view !== "platform") return;
    const s = a();
    const form = s.grant ? "grant" : s.plan && !s.plan.confirm ? "plan" : null;
    if (!form || h.state.plat.access.revokeArm !== null) return;
    if (h.mount.querySelector("[data-dd-pop]")) return; // an open dropdown owns the keyboard
    const dlg = h.mount.querySelector<HTMLElement>("[data-plat-dialog]");
    if (!dlg) return;
    if (e.key === "Escape") { e.preventDefault(); if (form === "grant") closeGrant(); else closePlan(); return; }
    if (e.key !== "Tab") return;
    const items = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const last = items.length - 1;
    if (at < 0 || (e.shiftKey && at === 0) || (!e.shiftKey && at === last)) { e.preventDefault(); items[e.shiftKey ? last : 0].focus(); }
  });

  return { load, act };
}
