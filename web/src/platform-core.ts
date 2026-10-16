// Platform's eager part — the superadmin area's STATE, the add-organization rules, its address and the
// standalone page's shell. Everything else of Platform (platform.ts, its tabs, its acts) is the lazy
// Platform chunk (platform-lazy.ts; web-ui.md › The app's bundles): nobody but a superadmin downloads it.
// The app's first download needs only this: `initialPlat` (the app's state), the routes (`PLAT_TABS`,
// hash.ts), the boot's `/platform/` (`PLATFORM_PATH`), and the org picker's name and slug rules.
// platform.ts re-exports every one of these, so its importers (and the tests) are unchanged.

import {
  orgSlugProblem, GITHUB_LOGIN_RE, INVITE_EMAIL_RE, ORG_NAME_MAX,
  type PlatformOrgRow, type PlatformOrgDetail, type PlatformAdmin, type PlatformAuditRow, type PlatformUsageResponse,
  type AdminAssignment, type AdminTarget,
} from "@shared/orgs";
import type { PlanId } from "@shared/plans";
import type { AccountDeletionPreview, OrgDeletionPreview } from "@shared/deletion-core";
import { trovMark } from "@shared/mark";
import { esc } from "./ui";
import { initialDeleteUi, type DeleteUi } from "./deletion";
import type { UsageWindow } from "./platform-usage";
import type { AccessState } from "./platform-access";
import type { SupportTabState } from "./platform-support";

// ── state ────────────────────────────────────────────────────────────────────
export type PlatTab = "orgs" | "access" | "usage" | "support" | "admins" | "audit";
export const PLAT_TABS: readonly PlatTab[] = ["orgs", "access", "usage", "support", "admins", "audit"];

export interface PlatSlice<T> { status: "idle" | "loading" | "ok" | "error"; data: T }

/** How the org admin is named: an existing person, or someone to invite. */
export type AdminKind = "handle" | "github" | "email";
export const ADMIN_KINDS: readonly AdminKind[] = ["handle", "github", "email"];

export interface AddOrgErrors { name?: string; slug?: string; admin?: string; form?: string }
export interface AddOrgDraft {
  name: string;
  slug: string;
  /** The slug was typed by hand, so the name no longer rewrites it. */
  slugTouched: boolean;
  adminKind: AdminKind;
  adminValue: string;
  /** The plan the org starts on (its limits can be set after, with Change plan). */
  plan: PlanId;
  busy: boolean;
  errors: AddOrgErrors;
  /** Set once the org exists: the modal says what happened. */
  done: { name: string; slug: string; admin: AdminAssignment } | null;
}
export const blankAddOrg = (): AddOrgDraft => ({ name: "", slug: "", slugTouched: false, adminKind: "handle", adminValue: "", plan: "team", busy: false, errors: {}, done: null });

export interface OwnerDraft { kind: AdminKind; value: string; busy: boolean; error: string | null; done: AdminAssignment | null }
export const blankOwner = (): OwnerDraft => ({ kind: "handle", value: "", busy: false, error: null, done: null });

export interface PlatState {
  /** null until GET /api/orgs answers; the area renders only on `true`. */
  superadmin: boolean | null;
  tab: PlatTab;
  /** The org whose detail page is open (its slug). */
  orgSlug: string | null;
  orgs: PlatSlice<PlatformOrgRow[]>;
  detail: PlatSlice<PlatformOrgDetail | null>;
  orgAudit: PlatSlice<PlatformAuditRow[]>;
  usage: PlatSlice<PlatformUsageResponse | null>;
  usageDays: UsageWindow;
  usageOpen: string | null;
  admins: PlatSlice<PlatformAdmin[]>;
  audit: PlatSlice<PlatformAuditRow[]>;
  /** The Audit tab's org filter ("" = every org). */
  auditOrg: string;
  add: AddOrgDraft | null;
  owner: OwnerDraft;
  /** The org page's "Add an owner" form is open (it is behind a button: rarely needed). */
  ownerOpen: boolean;
  suspendArm: "suspend" | "unsuspend" | null;
  suspendBusy: boolean;
  grantDraft: string;
  grantBusy: boolean;
  grantError: string | null;
  revokeArm: string | null;
  revokeBusy: boolean;
  /** Why the last removal was refused (the 409, as a sentence). */
  revokeError: string | null;
  /** Platform › Access and "Change plan" (platform-access.ts). */
  access: AccessState;
  /** Platform › Support (platform-support.ts): the reports, the filters, the one on screen. */
  support: SupportTabState;
  /** Platform › an organization › Delete (deletion.ts): the org on screen's deletion. */
  orgDelete: DeleteUi<OrgDeletionPreview>;
  /** Platform › Admins › Delete a person's account: the handle typed, and that account's deletion. */
  personDraft: string;
  personDelete: DeleteUi<AccountDeletionPreview>;
}

export function initialPlat(): PlatState {
  return {
    superadmin: null, tab: "orgs", orgSlug: null,
    orgs: { status: "idle", data: [] },
    detail: { status: "idle", data: null },
    orgAudit: { status: "idle", data: [] },
    usage: { status: "idle", data: null }, usageDays: 30, usageOpen: null,
    admins: { status: "idle", data: [] },
    audit: { status: "idle", data: [] }, auditOrg: "",
    add: null, owner: blankOwner(), ownerOpen: false,
    suspendArm: null, suspendBusy: false,
    grantDraft: "", grantBusy: false, grantError: null,
    revokeArm: null, revokeBusy: false, revokeError: null,
    access: initialAccess(),
    support: initialSupportTab(),
    orgDelete: initialDeleteUi<OrgDeletionPreview>(),
    personDraft: "", personDelete: initialDeleteUi<AccountDeletionPreview>(),
  };
}

// ── the add-organization rules (pure; the server re-checks every one) ────────
/** "Acme Robotics, Inc." → "acme-robotics-inc": the slug a name suggests. */
export function slugFromName(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 39).replace(/-+$/, "");
}

const SLUG_RULE = "Use 2 to 39 lowercase letters, digits or hyphens, starting with a letter or digit.";
export function slugError(slug: string): string | null {
  if (!slug) return "Enter a slug. It becomes the organization's address.";
  const problem = orgSlugProblem(slug);
  if (problem === "invalid") return SLUG_RULE;
  if (problem === "reserved") return `“${slug}” is reserved. Pick another slug.`;
  return null;
}
export function nameError(name: string): string | null {
  const n = name.trim();
  if (!n) return "Enter the organization's name.";
  return n.length > ORG_NAME_MAX ? `Keep the name to ${ORG_NAME_MAX} characters or fewer.` : null;
}
export const cleanHandle = (v: string): string => v.trim().replace(/^@/, "");
export function adminError(kind: AdminKind, value: string): string | null {
  const v = value.trim();
  if (kind === "handle") return cleanHandle(v) ? null : "Enter the person's Trov handle.";
  if (kind === "github") return GITHUB_LOGIN_RE.test(v.replace(/^@/, "")) ? null : "Enter a GitHub login: letters, digits and hyphens, up to 39 characters.";
  return v.length <= 254 && INVITE_EMAIL_RE.test(v) ? null : "Enter an email address, like name@example.com.";
}
/** The request body's `admin` for what was typed. */
export function adminTarget(kind: AdminKind, value: string): AdminTarget {
  const v = value.trim();
  return kind === "handle" ? { handle: cleanHandle(v) } : kind === "github" ? { github_login: v.replace(/^@/, "") } : { email: v };
}
export function addOrgErrors(d: Pick<AddOrgDraft, "name" | "slug" | "adminKind" | "adminValue">): AddOrgErrors {
  const e: AddOrgErrors = {};
  const n = nameError(d.name), s = slugError(d.slug), a = adminError(d.adminKind, d.adminValue);
  if (n) e.name = n;
  if (s) e.slug = s;
  if (a) e.admin = a;
  return e;
}
/** A server error code, as a sentence next to the field it concerns. */
export function addOrgServerError(code: string, d: Pick<AddOrgDraft, "slug" | "adminKind" | "adminValue">): AddOrgErrors {
  switch (code) {
    case "invalid_slug": return { slug: SLUG_RULE };
    case "reserved_slug": return { slug: `“${d.slug}” is reserved. Pick another slug.` };
    case "slug_taken": return { slug: `“${d.slug}” is already in use. Pick another slug.` };
    case "invalid_name": return { name: `Enter a name of 1 to ${ORG_NAME_MAX} characters.` };
    case "invalid_admin": return { admin: adminError(d.adminKind, d.adminValue) ?? "That isn't a valid handle, GitHub login or email. Check it and try again." };
    case "no_such_person": return { admin: noSuchPerson(d.adminValue) };
    default: return { form: "The organization wasn't created. Check your connection and try again." };
  }
}
const noSuchPerson = (v: string): string => `No one has the handle @${cleanHandle(v)}. Check the spelling, or invite them by GitHub login or email instead.`;
/** The same for "Add another owner" (one field). */
export function ownerServerError(code: string, d: Pick<OwnerDraft, "kind" | "value">): string {
  if (code === "no_such_person") return noSuchPerson(d.value);
  if (code === "invalid_admin") return adminError(d.kind, d.value) ?? "That isn't a valid handle, GitHub login or email. Check it and try again.";
  if (code === "already_member" || code === "invite_exists") return "They are already a member or already invited.";
  return "The owner wasn't added. Check your connection and try again.";
}


// The Access and Support tabs' empty state (platform-access.ts / platform-support.ts re-export these).
export const initialAccess = (): AccessState => ({ grants: { status: "idle", data: [] }, grant: null, revokeArm: null, revokeBusy: false, plan: null, gift: null, giftEnd: null });
export const initialSupportTab = (): SupportTabState => ({
  list: { status: "idle", data: [] }, open: null, next: null, more: "idle",
  status: "open", kind: "all",
  reportId: null, detail: { status: "idle", data: null }, missing: false, busy: false, actionError: null,
});

/** Platform puts nothing in the header: each tab's ONE primary action is in its lead line
 *  (Add organization on Organizations), the same place as on Org settings. */
export function platformHeaderControls(_p: Pick<PlatState, "superadmin" | "tab">, _screen: string): string {
  return "";
}
/** The detail page's "›" crumb. */
export function platformCrumb(p: Pick<PlatState, "detail" | "orgSlug">): string {
  return p.detail.data && p.detail.data.org.slug === p.orgSlug ? p.detail.data.org.name : p.orgSlug ?? "";
}

/** The standalone page's address — outside `/<slug>/`, so it needs no membership. */
export const PLATFORM_PATH = "/platform/";
export const isPlatformPath = (pathname: string): boolean => pathname === "/platform" || pathname.startsWith("/platform/");

const BTN = "height:38px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:600;white-space:nowrap";
const OUTLINE = `${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)`;

/**
 * The Platform area OUTSIDE any organization (`/platform/#platform…`): the same screens in a minimal
 * shell — the mark, the title and crumb, the way back, sign out; no org navigation — so a superadmin
 * who belongs to no organization still reaches them. Linked from the org picker and the switcher's menu.
 */
export function platformPageShell(p: PlatState, screen: string, main: string): string {
  const child = screen === "platformorg";
  const title = child
    ? `<h1 class="cnpy-platpage-t"><button type="button" data-act="platGo" style="font:inherit;letter-spacing:inherit;padding:0;color:var(--fg-55);cursor:pointer">Platform</button></h1><span aria-hidden="true" style="color:var(--fg-40);font-size:13px">›</span><span style="font-size:13px;font-weight:500;color:var(--fg-70);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(platformCrumb(p))}</span>`
    : `<h1 class="cnpy-platpage-t">Platform</h1>`;
  // `data-morph`: the page is patched in place while it stays the same screen (morph.ts `paint`).
  return `<div class="cnpy-platpage plat" data-morph="${child ? "platformorg" : "platform"}" data-screen-label="Platform (outside an organization)">
    <header class="cnpy-platpage-hdr">
      <div class="cnpy-platpage-l">
        <a href="/" aria-label="Trov: back to your organizations" class="cnpy-platpage-home">${trovMark(22)}<span>Trov</span></a>
        <span aria-hidden="true" style="color:var(--border-strong)">/</span>
        ${title}
      </div>
      <div class="cnpy-platpage-r">
        ${platformHeaderControls(p, screen)}
        <a href="/" class="cnpy-outlinebtn" style="${OUTLINE};height:34px;display:inline-flex;align-items:center;text-decoration:none;box-sizing:border-box">Your organizations</a>
        <button type="button" data-act="signOut" class="cnpy-outlinebtn" style="${OUTLINE};height:34px">Sign out</button>
      </div>
    </header>
    <main id="cnpy-main">${main}</main>
  </div>`;
}

