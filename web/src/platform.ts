// Platform — the SUPERADMIN's screens (canopy-multitenancy.md §5.4), over /api/platform/*.
// One page with a tab bar (the Repo / Org settings idiom):
//   ORGANIZATIONS — every org with its status, owners, members, invites; "Add organization"
//                   (a modal: name, slug, the org admin) and, behind a row, the org's DETAIL
//                   (suspend / unsuspend, members, invites, add another owner, usage, audit).
//   USAGE         — platform-usage.ts.
//   ADMINS & LIMITS — the superadmins (grant / remove) and a person's org-creation limit.
//   AUDIT         — recent administration entries, filterable by org.
// The area exists only for a superadmin (`PlatState.superadmin`, read from GET /api/orgs);
// a superadmin is NOT a member of the orgs listed and sees sizes and counts, never content.
//
// Purely presentational: state in, markup out. Interactions dispatch `plat…` acts, which
// main.ts hands to platform-actions.ts.

import {
  orgSlugProblem, GITHUB_LOGIN_RE, INVITE_EMAIL_RE, ORG_NAME_MAX, DEFAULT_ORG_LIMIT,
  type PlatformOrgRow, type PlatformOrgDetail, type PlatformAdmin, type PlatformAuditRow, type PlatformUsageResponse,
  type AdminAssignment, type AdminTarget, type OrgRole, type OrgInvite,
} from "@shared/orgs";
import { esc, attr, relTime, statusBadge, surface } from "./ui";
import { trovMark } from "@shared/mark";
import { tabBar, tabPanelAttrs } from "./tabs";
import { segmented } from "./segmented";
import { confirmModal } from "./confirm";
import { usageView, orgUsageBlock, type UsageWindow } from "./platform-usage";

// ── state ────────────────────────────────────────────────────────────────────
export type PlatTab = "orgs" | "usage" | "admins" | "audit";
export const PLAT_TABS: readonly PlatTab[] = ["orgs", "usage", "admins", "audit"];
const TAB_LABEL: Record<PlatTab, string> = { orgs: "Organizations", usage: "Usage", admins: "Admins & limits", audit: "Audit" };

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
  busy: boolean;
  errors: AddOrgErrors;
  /** Set once the org exists: the modal says what happened. */
  done: { name: string; slug: string; admin: AdminAssignment } | null;
}
export const blankAddOrg = (): AddOrgDraft => ({ name: "", slug: "", slugTouched: false, adminKind: "handle", adminValue: "", busy: false, errors: {}, done: null });

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
  suspendArm: "suspend" | "unsuspend" | null;
  suspendBusy: boolean;
  grantDraft: string;
  grantBusy: boolean;
  grantError: string | null;
  revokeArm: string | null;
  revokeBusy: boolean;
  /** Why the last removal was refused (the 409, as a sentence). */
  revokeError: string | null;
  limitHandle: string;
  limitValue: string;
  limitBusy: boolean;
  limitError: string | null;
  limitDone: string | null;
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
    add: null, owner: blankOwner(),
    suspendArm: null, suspendBusy: false,
    grantDraft: "", grantBusy: false, grantError: null,
    revokeArm: null, revokeBusy: false, revokeError: null,
    limitHandle: "", limitValue: "", limitBusy: false, limitError: null, limitDone: null,
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
const cleanHandle = (v: string): string => v.trim().replace(/^@/, "");
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

/** What naming an admin did, said plainly. `another` = an org that already had an owner. */
export function assignmentSentence(a: AdminAssignment, another = false): string {
  if (a.status === "owner") return `@${a.handle} is now ${another ? "an" : "the"} owner.`;
  return `Invited ${a.github_login ?? a.email ?? "them"} — they become ${another ? "an" : "the"} owner when they sign in and accept. ${a.email ? "Trov emailed them the invitation." : "No email is sent for a GitHub login: tell them it is waiting."}`;
}

/** What suspension does, exactly — the confirmation's body. */
export function suspendCopy(org: Pick<PlatformOrgRow, "name" | "member_count">, suspend: boolean): { title: string; body: string } {
  const who = org.member_count === 1 ? "Its 1 member loses" : `Its ${org.member_count} members lose`;
  return suspend
    ? { title: `Suspend ${org.name}?`, body: `${who} access right away, and its MCP tokens and connected apps stop working. No data is deleted, and you can unsuspend it at any time.` }
    : { title: `Unsuspend ${org.name}?`, body: "Its members get access again, and its MCP tokens and connected apps work again. Nothing else changes." };
}
export const lastSuperadminSentence = (handle: string): string =>
  `@${handle} is the only superadmin, so they can't be removed. Grant someone else first, then remove them.`;

// ── shared atoms ─────────────────────────────────────────────────────────────
const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
const QUIET = "font-size:11.5px;color:var(--fg-40)";
const FIELD = "display:block;width:100%;box-sizing:border-box;height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;font-family:var(--sans);outline:none";
const FIELD_LABEL = "display:block;font-size:12.5px;font-weight:500;color:var(--fg-70);margin-bottom:6px";
const BTN = "height:38px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:600;white-space:nowrap";
const OUTLINE = `${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)`;
const ROW = "display:flex;align-items:center;gap:12px;padding:11px 20px;border-bottom:1px solid var(--border);margin-bottom:-1px";
const FRAME = "width:100%;max-width:1180px;margin:0 auto;padding:18px clamp(20px,2.6vw,46px) 100px;box-sizing:border-box";
const PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;

/** An accent button that is inert (and says why it can't be pressed by being muted) until `on`. */
function goBtn(label: string, on: boolean, act: string, extra = ""): string {
  return `<button type="button" data-act="${attr(act)}"${on ? ` class="cnpy-accentbtn"` : " disabled"} style="${BTN};${on ? "border:1px solid transparent;background:var(--accent);color:var(--accent-fg);cursor:pointer" : "border:1px solid var(--border);background:transparent;color:var(--fg-40);cursor:default"}${extra}">${esc(label)}</button>`;
}
const sectionHead = (title: string, aside = "", first = false): string =>
  `<div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:${first ? 0 : 28}px 0 10px"><h2 style="${LABEL};margin:0">${esc(title)}</h2>${aside ? `<span style="${QUIET}">${aside}</span>` : ""}</div>`;
const emptyCard = (title: string, sub: string): string =>
  `<div style="border:1px dashed var(--border-strong);border-radius:11px;padding:22px 24px;text-align:center"><div style="font-size:13.5px;font-weight:600;color:var(--fg-70)">${esc(title)}</div><div style="font-size:12.5px;color:var(--fg-40);margin-top:4px;line-height:1.5">${esc(sub)}</div></div>`;
const loadingLine = (what: string): string => `<div style="font-size:12.5px;color:var(--fg-40);padding:10px 0">Loading ${esc(what)}…</div>`;
const errorLine = (what: string): string =>
  `<div role="alert" style="font-size:13px;color:var(--fg-70);padding:10px 0">Couldn't load ${esc(what)}. <button type="button" data-act="platReload" class="cnpy-mutelink" style="padding:0;font-size:13px;font-weight:500;color:var(--accent)">Try again</button></div>`;
const fieldError = (id: string, msg: string | undefined | null): string =>
  msg ? `<div id="${attr(id)}" role="alert" style="font-size:12px;line-height:1.45;color:var(--red);margin-top:6px">${esc(msg)}</div>` : "";
const handleText = (h: string): string => `<span style="font-size:12.5px;font-weight:500;color:var(--fg-70)">@${esc(h)}</span>`;
const dateTitle = (iso: string | null): string => (iso ? ` title="${attr(new Date(iso).toLocaleString("en-US"))}"` : "");
const shortDate = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};
const orgStatus = (o: Pick<PlatformOrgRow, "status">): string =>
  o.status === "suspended" ? statusBadge("SUSPENDED", "var(--red)") : statusBadge("ACTIVE", "var(--green)");
const ROLE_TONE: Record<OrgRole, string> = { owner: "var(--accent)", admin: "var(--blue)", member: "var(--fg-55)" };
const roleBadge = (r: OrgRole): string => statusBadge(r.toUpperCase(), ROLE_TONE[r]);

/** The standing note: what a superadmin is, and is not. */
export const NOT_A_MEMBER = "You are not a member of this organization. As superadmin you can manage it and see its sizes and counts, but you cannot open or read its content.";
const infoNote = (text: string): string =>
  `<div role="note" style="display:flex;align-items:flex-start;gap:9px;padding:11px 14px;border:1px solid var(--border);border-radius:9px;font-size:12.5px;line-height:1.5;color:var(--fg-55)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg><span>${esc(text)}</span></div>`;

/** The admin-kind switch + its one field, shared by the modal and "Add another owner". */
function adminField(o: { segId: string; kindAct: string; valueAct: string; field: string; enter: string; kind: AdminKind; value: string; error: string | null | undefined; disabled: boolean; inputId: string }): string {
  const meta: Record<AdminKind, { label: string; placeholder: string; help: string; type: string }> = {
    handle: { label: "Trov handle", placeholder: "maya", help: "Someone who already has a Trov account. They become an owner at once.", type: "text" },
    github: { label: "GitHub login", placeholder: "octocat", help: "They see the invite when they sign in with this GitHub account, and become an owner when they accept. No email is sent: tell them it is waiting.", type: "text" },
    email: { label: "Email address", placeholder: "name@example.com", help: "Trov emails them the invite. They become an owner when they sign in with this address and accept.", type: "email" },
  };
  const m = meta[o.kind];
  const errId = `${o.inputId}-err`;
  return `${segmented({
      id: o.segId, ariaLabel: "How to name the org admin", act: o.kindAct, value: o.kind, size: "sm", fill: true, inertOn: true,
      options: [{ value: "handle", label: "Existing person" }, { value: "github", label: "GitHub login" }, { value: "email", label: "Email" }],
    })}
    <label for="${attr(o.inputId)}" style="${FIELD_LABEL};margin-top:12px">${m.label}</label>
    <input id="${attr(o.inputId)}" type="${m.type}" data-act="${attr(o.valueAct)}" data-field="${attr(o.field)}" data-enter="${attr(o.enter)}" value="${attr(o.value)}" placeholder="${attr(m.placeholder)}" autocomplete="off" autocapitalize="off" spellcheck="false"${o.disabled ? " disabled" : ""}${o.error ? ` aria-invalid="true" aria-describedby="${attr(errId)}"` : ` aria-describedby="${attr(o.inputId)}-help"`} class="cnpy-input" style="${FIELD}${o.error ? ";border-color:var(--red)" : ""}" />
    ${o.error ? fieldError(errId, o.error) : `<div id="${attr(o.inputId)}-help" style="${QUIET};margin-top:6px;line-height:1.45">${m.help}</div>`}`;
}

// ── ORGANIZATIONS ────────────────────────────────────────────────────────────
function orgRow(o: PlatformOrgRow): string {
  const owners = o.owners.length
    ? o.owners.map((w) => `<span style="white-space:nowrap">${esc(w.name ?? w.handle)} <span style="color:var(--fg-40)">@${esc(w.handle)}</span></span>`).join(`<span style="color:var(--fg-40)">, </span>`)
    : `<span style="color:var(--amber)">No owner yet${o.pending_invites ? " — invite pending" : ""}</span>`;
  const cell = (label: string, inner: string, cls = "") => `<div class="plat-c${cls ? ` ${cls}` : ""}" style="min-width:0"><span class="plat-cl">${label}</span>${inner}</div>`;
  const n = (v: number) => `<span style="font-variant-numeric:tabular-nums;font-size:12.5px;font-weight:600;color:${v ? "var(--fg-70)" : "var(--fg-40)"}">${v}</span>`;
  const sus = o.status === "suspended";
  return `<button type="button" data-act="platOpenOrg" data-arg="${attr(o.slug)}" class="plat-row plat-orgs-grid${sus ? " is-suspended" : ""}" aria-label="${attr(`${o.name}${sus ? ", suspended" : ""} — open`)}" style="width:100%;text-align:left;padding:12px 20px;border-bottom:1px solid var(--border);margin-bottom:-1px">
    <div class="plat-c plat-c-name" style="min-width:0"><span style="display:block;font-size:13.5px;font-weight:600;color:${sus ? "var(--fg-55)" : "var(--fg)"};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.name)}</span><span style="display:block;font-family:var(--code);font-size:11.5px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.slug)}</span></div>
    ${cell("Status", orgStatus(o))}
    ${cell("Owners", `<span style="display:block;font-size:12.5px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${owners}</span>`, "plat-c-wide")}
    ${cell("Members", n(o.member_count))}
    ${cell("Invites", n(o.pending_invites))}
    ${cell("Created", `<span style="font-size:12px;color:var(--fg-55);white-space:nowrap"${dateTitle(o.created_at)}>${esc(shortDate(o.created_at))}</span>`)}
    ${cell("Last activity", `<span style="font-size:12px;color:var(--fg-55);white-space:nowrap"${dateTitle(o.last_activity_at)}>${o.last_activity_at ? esc(relTime(o.last_activity_at)) : "Never"}</span>`)}
  </button>`;
}

export function orgsTab(p: Pick<PlatState, "orgs">): string {
  const intro = `<div style="font-size:12.5px;color:var(--fg-55);margin:0 0 18px">Every organization on Trov. Add one and name its admin; they invite their team and set it up from there.</div>`;
  if (p.orgs.status === "error" && !p.orgs.data.length) return intro + errorLine("organizations");
  if (p.orgs.status !== "ok" && !p.orgs.data.length) return intro + loadingLine("organizations");
  if (!p.orgs.data.length) {
    return `${intro}<div style="display:flex;justify-content:center;padding:40px 0"><div style="max-width:420px;width:100%">${emptyCard("No organizations yet", "Add the first one and name its admin. They take it from there.")}
      <div style="display:flex;justify-content:center;margin-top:14px"><button type="button" data-act="platAddOpen" class="cnpy-accentbtn" style="${BTN};display:inline-flex;align-items:center;gap:7px;background:var(--accent);color:var(--accent-fg)">${PLUS}Add organization</button></div></div></div>`;
  }
  const suspended = p.orgs.data.filter((o) => o.status === "suspended").length;
  return `${intro}<div${surface("overflow:hidden", { cls: "plat-table" })}>
      <div class="plat-thead plat-orgs-grid" aria-hidden="true" style="padding:12px 20px 9px;border-bottom:1px solid var(--border)"><span>Organization</span><span>Status</span><span>Owners</span><span>Members</span><span>Invites</span><span>Created</span><span>Last activity</span></div>
      ${p.orgs.data.map(orgRow).join("")}
    </div>
    <div style="${QUIET};margin-top:10px">${p.orgs.data.length} ${p.orgs.data.length === 1 ? "organization" : "organizations"}${suspended ? `, ${suspended} suspended` : ""}. Select one to manage it.</div>`;
}

// ── one organization ─────────────────────────────────────────────────────────
function inviteRow(i: OrgInvite): string {
  return `<div style="${ROW};flex-wrap:wrap">
    <div style="flex:1;min-width:0;line-height:1.35"><div style="font-size:13.5px;font-weight:500;color:var(--fg-70);overflow-wrap:anywhere">${esc(i.github_login ?? i.email ?? "")}</div><div style="${QUIET}">${i.github_login ? "GitHub login" : "Email"} · invited ${esc(relTime(i.created_at))} by @${esc(i.invited_by)}${i.email ? ` · ${i.mail_status === "sent" ? "email sent" : i.mail_status === "failed" ? "email not sent" : "no email sent"}` : ""}</div></div>
    ${roleBadge(i.role)}${statusBadge("PENDING", "var(--amber)")}
  </div>`;
}

export function auditList(rows: PlatformAuditRow[], showOrg: boolean): string {
  return `<div${surface("overflow:hidden")}>${rows.map((r) => {
    const detail = Object.entries(r.detail).filter(([, v]) => v !== null && v !== "" && typeof v !== "object").map(([k, v]) => `${k}: ${String(v)}`).join(" · ");
    return `<div class="plat-audit" style="padding:10px 20px;border-bottom:1px solid var(--border);margin-bottom:-1px">
      <span style="font-family:var(--code);font-size:12px;color:var(--fg);white-space:nowrap">${esc(r.action)}</span>
      <span style="min-width:0;font-size:12.5px;color:var(--fg-70);overflow-wrap:anywhere">${esc(r.target)}${detail ? ` <span style="color:var(--fg-40)">· ${esc(detail)}</span>` : ""}</span>
      ${showOrg ? `<span class="plat-au-org" style="font-family:var(--code);font-size:11.5px;color:var(--fg-55);white-space:nowrap">${r.org ? esc(r.org) : `<span style="color:var(--fg-40)">platform</span>`}</span>` : ""}
      <span class="plat-au-actor" style="font-size:12px;color:var(--fg-55);white-space:nowrap">@${esc(r.actor)}</span>
      <span class="plat-au-time" style="font-size:12px;color:var(--fg-40);white-space:nowrap"${dateTitle(r.at)}>${esc(relTime(r.at))}</span>
    </div>`;
  }).join("")}</div>`;
}

export function platformOrgView(p: PlatState): string {
  const gate = gateNotice(p);
  if (gate) return gate;
  const wrap = (inner: string) => `<div class="plat" data-screen-label="Platform organization" style="${FRAME}">${inner}</div>`;
  const d = p.detail.data && p.detail.data.org.slug === p.orgSlug ? p.detail.data : null;
  if (!d) {
    if (p.detail.status === "error") return wrap(`${errorLine("this organization")}<div style="${QUIET}">If it was renamed or removed, go back to the list.</div>`);
    return wrap(loadingLine("the organization"));
  }
  const o = d.org;
  const sus = o.status === "suspended";
  const action = sus
    ? `<button type="button" data-act="platSuspendArm" data-arg="unsuspend" data-confirm-trigger class="cnpy-outlinebtn" aria-haspopup="dialog" aria-expanded="${p.suspendArm === "unsuspend"}" aria-controls="plat-suspend-confirm" style="${OUTLINE}">Unsuspend</button>`
    : `<button type="button" data-act="platSuspendArm" data-arg="suspend" data-confirm-trigger class="cnpy-dangerbtn" aria-haspopup="dialog" aria-expanded="${p.suspendArm === "suspend"}" aria-controls="plat-suspend-confirm" style="${OUTLINE};color:var(--fg-55)">Suspend</button>`;
  const head = `<div${surface("padding:18px 20px")}>
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><h2 style="margin:0;font-size:19px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere">${esc(o.name)}</h2>${orgStatus(o)}</div>
        <div style="margin-top:4px;font-size:12.5px;color:var(--fg-55);line-height:1.5"><span style="font-family:var(--code);font-size:12px">${esc(o.slug)}</span> · created ${esc(shortDate(o.created_at))} by @${esc(o.created_by)}${o.last_activity_at ? ` · last activity ${esc(relTime(o.last_activity_at))}` : " · no activity yet"}</div>
      </div>
      ${action}
    </div>
    ${sus ? `<div role="status" style="margin-top:14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--red) 40%,transparent);background:color-mix(in srgb,var(--red) 8%,transparent);border-radius:9px;font-size:12.5px;line-height:1.5;color:var(--fg-70)">Suspended${o.suspended_at ? ` ${esc(relTime(o.suspended_at))}` : ""}${o.suspended_by ? ` by @${esc(o.suspended_by)}` : ""}. Members can't open it and its MCP tokens and connected apps don't work. No data was deleted.</div>` : ""}
  </div>
  <div style="margin-top:12px">${infoNote(NOT_A_MEMBER)}</div>`;

  const members = d.members.length
    ? `<div${surface("overflow:hidden")}>${d.members.map((m) => `<div style="${ROW}">
        <div style="flex:1;min-width:0;line-height:1.35"><div style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(m.name ?? m.handle)}</div><div style="display:flex;gap:8px;min-width:0;${QUIET}">${handleText(m.handle)}${m.title ? `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">· ${esc(m.title)}</span>` : ""}</div></div>
        <span class="plat-hide-sm" style="${QUIET};white-space:nowrap"${dateTitle(m.joined_at)}>joined ${esc(relTime(m.joined_at))}</span>
        ${roleBadge(m.role)}
      </div>`).join("")}</div>`
    : emptyCard("No members yet", "The organization has no one in it until an invited owner signs in and accepts.");
  const pending = d.invites.filter((i) => i.status === "pending");
  const invites = pending.length
    ? `<div${surface("overflow:hidden")}>${pending.map(inviteRow).join("")}</div>`
    : `<div style="${QUIET};padding:2px 0">No pending invites.</div>`;

  const w = p.owner;
  const canAdd = !w.busy && adminError(w.kind, w.value) === null;
  const ownerForm = `<div${surface("padding:16px 20px")}>
    <div style="max-width:520px">
      ${adminField({ segId: "plat-owner-kind", kindAct: "platOwnerKind", valueAct: "platOwnerValue", field: "platOwnerValue", enter: "platOwnerSubmit", kind: w.kind, value: w.value, error: w.error, disabled: w.busy, inputId: "plat-owner-input" })}
      <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:14px">
        ${goBtn(w.busy ? "Adding…" : "Add owner", canAdd, "platOwnerSubmit")}
        ${w.done ? `<span role="status" style="font-size:12.5px;color:var(--fg-70)">${esc(assignmentSentence(w.done, true))}</span>` : ""}
      </div>
    </div>
  </div>`;

  const audit = p.orgAudit.status === "error" ? errorLine("the audit entries")
    : p.orgAudit.status !== "ok" ? loadingLine("audit entries")
    : p.orgAudit.data.length ? auditList(p.orgAudit.data, false)
    : `<div style="${QUIET};padding:2px 0">No audit entries for this organization.</div>`;

  return wrap(`${head}
    ${sectionHead("Members", `${d.members.length}`)}${members}
    ${sectionHead("Pending invites", `${pending.length}`)}${invites}
    ${sectionHead("Add another owner")}${ownerForm}
    ${sectionHead("Usage", "last 30 days")}${orgUsageBlock(d.usage, 30)}
    ${sectionHead("Recent audit entries")}${audit}`);
}

// ── ADMINS & LIMITS ──────────────────────────────────────────────────────────
export function adminsTab(p: PlatState, me: string | null): string {
  const intro = `<div style="font-size:12.5px;color:var(--fg-55);margin:0 0 18px">Superadmins run the Platform area: they add and suspend organizations and see usage. It is not a membership of any organization.</div>`;
  const list = p.admins.status === "error" && !p.admins.data.length ? errorLine("the superadmins")
    : p.admins.status !== "ok" && !p.admins.data.length ? loadingLine("superadmins")
    : `<div${surface("overflow:hidden")}>${p.admins.data.map((a) => `<div style="${ROW}">
        <div style="flex:1;min-width:0;line-height:1.35"><div style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name ?? a.handle)}</div><div style="${QUIET};overflow-wrap:anywhere">${handleText(a.handle)} · granted ${esc(relTime(a.granted_at))} by @${esc(a.granted_by)}</div></div>
        ${me && a.handle.toLowerCase() === me.toLowerCase() ? `<span style="font-family:var(--label);font-size:10px;font-weight:600;letter-spacing:.05em;color:var(--fg-40);border:1px solid var(--border);border-radius:5px;padding:2px 6px">YOU</span>` : ""}
        <button type="button" data-act="platRevokeArm" data-arg="${attr(a.handle)}" data-field="platRevoke:${attr(a.handle)}"${p.revokeArm === a.handle ? " data-confirm-trigger" : ""} class="cnpy-rejectbtn" aria-haspopup="dialog" aria-label="Remove @${attr(a.handle)} as superadmin" style="font-size:12px;color:var(--fg-55);padding:5px 10px;border-radius:6px;border:1px solid var(--border);white-space:nowrap">Remove</button>
      </div>`).join("")}</div>`;
  const canGrant = !p.grantBusy && cleanHandle(p.grantDraft) !== "";
  const limitHandleOk = cleanHandle(p.limitHandle) !== "";
  const limitOk = /^\d{1,4}$/.test(p.limitValue.trim()) && Number(p.limitValue.trim()) <= 1000;
  return `${intro}
    ${sectionHead("Superadmins", `${p.admins.data.length}`, true)}
    ${list}
    ${p.revokeError ? `<div role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:10px">${esc(p.revokeError)}</div>` : ""}
    <div${surface("padding:16px 20px;margin-top:12px")}>
      <label for="plat-grant" style="${FIELD_LABEL}">Grant superadmin to a person</label>
      <div class="plat-inline">
        <input id="plat-grant" data-act="platGrantDraft" data-field="platGrantDraft" data-enter="platGrantSubmit" value="${attr(p.grantDraft)}" placeholder="Their Trov handle" autocomplete="off" autocapitalize="off" spellcheck="false"${p.grantError ? ` aria-invalid="true" aria-describedby="plat-grant-err"` : ""} class="cnpy-input" style="${FIELD};flex:1;min-width:0${p.grantError ? ";border-color:var(--red)" : ""}" />
        ${goBtn(p.grantBusy ? "Granting…" : "Grant", canGrant, "platGrantSubmit")}
      </div>
      ${fieldError("plat-grant-err", p.grantError)}
      <div style="${QUIET};margin-top:8px;line-height:1.45">They can then do everything on this page, including removing other superadmins.</div>
    </div>
    ${sectionHead("Organization limit")}
    <div${surface("padding:16px 20px")}>
      <div style="font-size:12.5px;color:var(--fg-55);line-height:1.5;margin-bottom:14px">How many organizations a person may create by themselves. The default is ${DEFAULT_ORG_LIMIT}; superadmins have no limit. Organizations you add here don't count against anyone.</div>
      <div class="plat-inline" style="align-items:flex-end">
        <div style="flex:2;min-width:0"><label for="plat-limit-handle" style="${FIELD_LABEL}">Person</label><input id="plat-limit-handle" data-act="platLimitHandle" data-field="platLimitHandle" value="${attr(p.limitHandle)}" placeholder="Their Trov handle" autocomplete="off" autocapitalize="off" spellcheck="false" class="cnpy-input" style="${FIELD}" /></div>
        <div style="flex:1;min-width:0"><label for="plat-limit-value" style="${FIELD_LABEL}">Limit</label><input id="plat-limit-value" type="number" inputmode="numeric" min="0" max="1000" step="1" data-act="platLimitValue" data-field="platLimitValue" data-enter="platLimitSubmit" value="${attr(p.limitValue)}" placeholder="0 to 1000" class="cnpy-input" style="${FIELD}" /></div>
        ${goBtn(p.limitBusy ? "Saving…" : "Set limit", !p.limitBusy && limitHandleOk && limitOk, "platLimitSubmit")}
        <button type="button" data-act="platLimitDefault"${!p.limitBusy && limitHandleOk ? ` class="cnpy-outlinebtn"` : " disabled"} style="${OUTLINE}${!p.limitBusy && limitHandleOk ? "" : ";color:var(--fg-40);border-color:var(--border);cursor:default"}">Use default</button>
      </div>
      ${p.limitError ? `<div role="alert" style="font-size:12px;line-height:1.45;color:var(--red);margin-top:8px">${esc(p.limitError)}</div>` : ""}
      ${p.limitDone ? `<div role="status" style="font-size:12.5px;color:var(--fg-70);margin-top:8px">${esc(p.limitDone)}</div>` : ""}
    </div>`;
}

// ── AUDIT ────────────────────────────────────────────────────────────────────
export function auditTab(p: Pick<PlatState, "audit" | "auditOrg" | "orgs">): string {
  const options = [`<option value=""${p.auditOrg === "" ? " selected" : ""}>All organizations</option>`]
    .concat(p.orgs.data.map((o) => `<option value="${attr(o.slug)}"${p.auditOrg === o.slug ? " selected" : ""}>${esc(o.name)} (${esc(o.slug)})</option>`)).join("");
  const head = `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px">
    <div style="font-size:12.5px;color:var(--fg-55);min-width:0">Who changed what: organizations, members, invites, superadmins, limits and integration secrets. Newest first.</div>
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--fg-55);min-width:0"><span style="white-space:nowrap">Organization</span><select data-act="platAuditOrg" data-field="platAuditOrg" class="cnpy-select" style="max-width:240px;min-width:0;height:32px">${options}</select></label>
  </div>`;
  const body = p.audit.status === "error" ? errorLine("the audit log")
    : p.audit.status !== "ok" && !p.audit.data.length ? loadingLine("the audit log")
    : p.audit.data.length ? auditList(p.audit.data, p.auditOrg === "")
    : emptyCard("No audit entries", p.auditOrg ? "Nothing has been recorded for this organization yet." : "Entries appear here when an organization, a member, an invite or a superadmin changes.");
  return head + body;
}

// ── the page ─────────────────────────────────────────────────────────────────
/** Why the area can't render: still checking, or not a superadmin (main.ts then leaves). */
function gateNotice(p: Pick<PlatState, "superadmin">): string {
  if (p.superadmin === true) return "";
  return `<div style="text-align:center;padding:60px;color:var(--fg-40);font-size:13px">${p.superadmin === null ? "Loading…" : "This page isn't available to your account."}</div>`;
}

export function platformTabBar(tab: PlatTab): string {
  return tabBar({ id: "plat-tab", ariaLabel: "Platform sections", act: "platTab", value: tab, tabs: PLAT_TABS.map((t) => ({ value: t, label: TAB_LABEL[t] })) });
}

export function platformView(p: PlatState, me: string | null = null): string {
  const gate = gateNotice(p);
  if (gate) return gate;
  const body = p.tab === "usage" ? usageView({ status: p.usage.status, usage: p.usage.data, days: p.usageDays, open: p.usageOpen })
    : p.tab === "admins" ? adminsTab(p, me)
    : p.tab === "audit" ? auditTab(p)
    : orgsTab(p);
  return `<div class="plat" data-screen-label="Platform" style="${FRAME}">
    ${platformTabBar(p.tab)}
    <div${tabPanelAttrs("plat-tab", p.tab)} style="padding-top:20px">${body}</div>
  </div>`;
}

/** The header's primary action: Add organization, on the Organizations tab. */
export function platformHeaderControls(p: Pick<PlatState, "superadmin" | "tab">, screen: string): string {
  if (screen !== "platform" || p.superadmin !== true || p.tab !== "orgs") return "";
  return `<button type="button" data-act="platAddOpen" data-plat-add-trigger class="cnpy-accentbtn" style="display:flex;align-items:center;gap:7px;padding:7px 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap;transition:filter .12s ease">${PLUS}Add organization</button>`;
}
/** The detail page's "›" crumb. */
export function platformCrumb(p: Pick<PlatState, "detail" | "orgSlug">): string {
  return p.detail.data && p.detail.data.org.slug === p.orgSlug ? p.detail.data.org.name : p.orgSlug ?? "";
}

/** The standalone page's address — outside `/o/<slug>/`, so it needs no membership. */
export const PLATFORM_PATH = "/platform/";
export const isPlatformPath = (pathname: string): boolean => pathname === "/platform" || pathname.startsWith("/platform/");

/**
 * The Platform area OUTSIDE any organization (`/platform/#platform…`): the same screens in a minimal
 * shell — the mark, the title and crumb, the way back, sign out; no org navigation — so a superadmin
 * who belongs to no organization still reaches them. Linked from the org picker and the switcher's menu.
 */
export function platformPage(p: PlatState, screen: string, me: string | null): string {
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
    <main id="cnpy-main">${child ? platformOrgView(p) : platformView(p, me)}</main>
  </div>`;
}

// ── dialogs (rendered at the app root) ───────────────────────────────────────
const CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

/** "Add organization": name, slug (derived from the name until it is edited), the org admin.
 *  Each field's error sits under it; once created the same dialog says what happened. */
export function addOrgModal(d: AddOrgDraft): string {
  const shell = (inner: string, describedBy = "") => `<div data-overlay="plat-add" class="cnpy-cmodal">
    <div data-act="platAddClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="plat-add" role="dialog" aria-modal="true" aria-labelledby="plat-add-t"${describedBy ? ` aria-describedby="${describedBy}"` : ""} tabindex="-1" data-plat-dialog data-scroll-keep="plat-add" class="cnpy-surface cnpy-cmodal-box cnpy-scroll" style="position:relative;width:min(480px, 100%);max-height:calc(100vh - 32px);overflow-y:auto">
        <button type="button" data-act="platAddClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        ${inner}
      </div>
    </div>
  </div>`;
  if (d.done) {
    return shell(`<div id="plat-add-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere">${esc(d.done.name)} was created</div>
      <p id="plat-add-d" role="status" style="margin:8px 0 0;font-size:13.5px;line-height:1.55;color:var(--fg-70)">${esc(assignmentSentence(d.done.admin))}</p>
      <p style="margin:6px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-55)">Its address is <span style="font-family:var(--code);font-size:12px">${esc(d.done.slug)}</span>. The owner invites the rest of the team and sets up its integrations.</p>
      <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">
        <button type="button" data-act="platOpenOrg" data-arg="${attr(d.done.slug)}" class="cnpy-outlinebtn" style="${OUTLINE}">Open organization</button>
        <button type="button" data-act="platAddClose" data-plat-focus class="cnpy-accentbtn" style="${BTN};background:var(--accent);color:var(--accent-fg)">Done</button>
      </div>`, "plat-add-d");
  }
  const e = d.errors;
  const off = d.busy ? " disabled" : "";
  const input = (id: string, act: string, value: string, err: string | undefined, extra: string) =>
    `<input id="${id}" data-act="${act}" data-field="${act}" data-enter="platAddSubmit" value="${attr(value)}" autocomplete="off" spellcheck="false"${off}${err ? ` aria-invalid="true" aria-describedby="${id}-err"` : ""} ${extra} class="cnpy-input" style="${FIELD}${err ? ";border-color:var(--red)" : ""}" />${fieldError(`${id}-err`, err)}`;
  return shell(`<div id="plat-add-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">Add organization</div>
    <p style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">Create the organization and name its admin. They do the rest.</p>
    <div style="margin-top:16px">
      <label for="plat-add-name" style="${FIELD_LABEL}">Name</label>
      ${input("plat-add-name", "platAddName", d.name, e.name, `maxlength="${ORG_NAME_MAX}" placeholder="Acme Robotics"`)}
    </div>
    <div style="margin-top:14px">
      <label for="plat-add-slug" style="${FIELD_LABEL}">Slug</label>
      ${input("plat-add-slug", "platAddSlug", d.slug, e.slug, `maxlength="39" autocapitalize="off" placeholder="acme-robotics"`).replace(`style="${FIELD}`, `style="${FIELD};font-family:var(--code);font-size:13px`)}
      ${e.slug ? "" : `<div style="${QUIET};margin-top:6px;line-height:1.45">The organization's address. Lowercase letters, digits and hyphens.</div>`}
    </div>
    <fieldset style="margin:18px 0 0;padding:0;border:none;min-width:0">
      <legend style="${FIELD_LABEL};padding:0;margin-bottom:8px">Org admin</legend>
      ${adminField({ segId: "plat-add-kind", kindAct: "platAddKind", valueAct: "platAddAdmin", field: "platAddAdmin", enter: "platAddSubmit", kind: d.adminKind, value: d.adminValue, error: e.admin, disabled: d.busy, inputId: "plat-add-admin" })}
    </fieldset>
    ${e.form ? `<div role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:14px">${esc(e.form)}</div>` : ""}
    <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
      <button type="button" data-act="platAddClose" class="cnpy-outlinebtn"${off} style="${OUTLINE}">Cancel</button>
      ${goBtn(d.busy ? "Creating…" : "Create organization", !d.busy, "platAddSubmit")}
    </div>`);
}

/** Every Platform dialog: the add form, and the confirmations (suspend / unsuspend, remove a superadmin). */
export function platformDialogs(p: PlatState, screen: string): string {
  if (p.superadmin !== true || (screen !== "platform" && screen !== "platformorg")) return "";
  if (screen === "platformorg" && p.suspendArm && p.detail.data) {
    const suspend = p.suspendArm === "suspend";
    const copy = suspendCopy(p.detail.data.org, suspend);
    return confirmModal({
      id: "plat-suspend-confirm", title: copy.title, body: copy.body,
      confirmLabel: suspend ? "Suspend" : "Unsuspend", busyLabel: suspend ? "Suspending…" : "Unsuspending…",
      confirmAct: "platSuspendGo", cancelAct: "platSuspendCancel", busy: p.suspendBusy,
      // Suspending takes access away (red); unsuspending gives it back (the neutral confirm).
      tone: suspend ? "danger" : "neutral",
    });
  }
  if (screen === "platform" && p.revokeArm) {
    return confirmModal({
      id: "plat-revoke-confirm", title: `Remove @${p.revokeArm} as superadmin?`,
      body: "They lose the Platform area: organizations, usage, admins and the audit log. Their own organizations and memberships don't change.",
      confirmLabel: "Remove", busyLabel: "Removing…",
      confirmAct: "platRevokeGo", cancelAct: "platRevokeCancel", arg: p.revokeArm, busy: p.revokeBusy,
    });
  }
  if (screen === "platform" && p.add) return addOrgModal(p.add);
  return "";
}
