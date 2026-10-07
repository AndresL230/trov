// Platform › ACCESS, and an organization's PLAN (shared/plans.ts; /api/platform/grants, …/orgs/:slug/plan):
//   ACCESS       — the grants: who may set up an organization of their own, on which plan, and what
//                  became of each (unused / used → the org / revoked / expired). "Grant an
//                  organization" is the tab's one primary action; Revoke is behind each unused row.
//   CHANGE PLAN  — on an organization's page: its plan and limits, and the dialog that changes them,
//                  which says before it is confirmed what happens if the org is over the new limits.
// The person is named the three ways "Add organization" names an admin (platform.ts `adminField`).
//
// Purely presentational: state in, markup out. Acts start with `platGrant…` / `platPlan…` and are run
// by platform-access-actions.ts. (platform.ts imports this file and this one imports FUNCTIONS from
// it — nothing here touches a platform.ts value at module load.)

import {
  PLANS, PLAN_IDS, LIMIT_KEYS, LIMITS, GRANT_EXPIRY_DAYS, GRANT_NOTE_MAX, formatBytes, formatLimit, formatUse, resolveEntitlements, seatsPhrase,
  type GrantTarget, type LimitKey, type PlanId, type PlanOverrides, type PlatformGrant, type PlatformOrgPlan,
} from "@shared/plans";
import { billingDate } from "@shared/billing";
import { esc, attr, relTime, statusBadge, surface } from "./ui";
import { confirmModal } from "./confirm";
import { dropdown, dropdownMenu, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { tabLead, dangerLink, orgEmpty, loadingNote } from "./org-ui";
import { adminField, adminError, adminTarget, type AdminKind } from "./platform";

// ── state ────────────────────────────────────────────────────────────────────
/** The five limits as the dialogs' text fields: "" = the plan's own value. */
export type LimitDraft = Record<LimitKey, string>;
export const blankLimits = (): LimitDraft => ({ seats: "", repositories: "", environments: "", artifact_bytes: "", agent_connections: "" });

export type ExpiryChoice = "never" | `${(typeof GRANT_EXPIRY_DAYS)[number]}`;
export interface GrantDraft {
  kind: AdminKind;
  value: string;
  plan: PlanId;
  limits: LimitDraft;
  /** The limit fields are shown: always for Enterprise (it is sized per org), on request otherwise. */
  limitsOpen: boolean;
  note: string;
  expiry: ExpiryChoice;
  busy: boolean;
  errors: { to?: string; limits?: string; form?: string };
  /** Set once the grant exists: the dialog says what happens next. */
  done: PlatformGrant | null;
}
export const blankGrant = (): GrantDraft => ({ kind: "github", value: "", plan: "team", limits: blankLimits(), limitsOpen: false, note: "", expiry: "never", busy: false, errors: {}, done: null });

export interface PlanDraft {
  slug: string;
  name: string;
  /** What the org is on now (the comparison the confirmation makes). */
  current: PlatformOrgPlan;
  /** Stored artifact bytes, when the page knows them (the org's usage). */
  artifactBytes: number | null;
  plan: PlanId;
  limits: LimitDraft;
  /** Step two: the confirmation is showing. */
  confirm: boolean;
  busy: boolean;
  error: string | null;
}

export interface AccessState {
  grants: { status: "idle" | "loading" | "ok" | "error"; data: PlatformGrant[] };
  grant: GrantDraft | null;
  /** The grant whose revocation is being confirmed (its id). */
  revokeArm: number | null;
  revokeBusy: boolean;
  plan: PlanDraft | null;
}
export const initialAccess = (): AccessState => ({ grants: { status: "idle", data: [] }, grant: null, revokeArm: null, revokeBusy: false, plan: null });

// ── the limit fields (pure; the server re-checks) ────────────────────────────
const GB = 1024 ** 3;
const UNLIMITED = /^(unlimited|none|∞)$/i;

/** Stored overrides → what the fields show (bytes as GB). */
export function limitDraftOf(o: PlanOverrides): LimitDraft {
  const d = blankLimits();
  for (const k of LIMIT_KEYS) {
    if (!(k in o)) continue;
    const v = o[k];
    d[k] = v === null || v === undefined ? "unlimited" : LIMITS[k].unit === "bytes" ? String(+(v / GB).toFixed(2)) : String(v);
  }
  return d;
}
/** The fields → overrides, or the sentence for the first one that is wrong. A blank field is the plan's own. */
export function parseLimitDraft(d: LimitDraft): { overrides: PlanOverrides } | { error: string } {
  const overrides: PlanOverrides = {};
  for (const k of LIMIT_KEYS) {
    const raw = d[k].trim();
    if (raw === "") continue;
    if (UNLIMITED.test(raw)) { overrides[k] = null; continue; }
    const def = LIMITS[k];
    if (def.unit === "bytes") {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0 || n > 1_000_000) return { error: `${def.label}: enter a size in GB, like 5 or 0.5, or “unlimited”.` };
      overrides[k] = Math.round(n * GB);
      continue;
    }
    if (!/^\d{1,7}$/.test(raw) || Number(raw) < def.min) return { error: `${def.label}: enter a whole number${def.min > 0 ? ` of at least ${def.min}` : ""}, or “unlimited”.` };
    overrides[k] = Number(raw);
  }
  return { overrides };
}

const FIELD = "display:block;width:100%;box-sizing:border-box;height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;font-family:var(--sans);outline:none";
const FIELD_LABEL = "display:block;font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);margin-bottom:7px";
const QUIET = "font-size:11.5px;color:var(--fg-40)";
const BTN = "height:38px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:600;white-space:nowrap";
const OUTLINE = `${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)`;
const ROW = "display:flex;align-items:center;gap:10px 14px;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--border);margin-bottom:-1px";
const CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const PLUS = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>`;
const goBtn = (label: string, on: boolean, act: string, focus = false): string =>
  `<button type="button" data-act="${attr(act)}"${focus ? " data-plat-focus" : ""}${on ? ` class="cnpy-accentbtn"` : " disabled"} style="${BTN};${on ? "border:1px solid transparent;background:var(--accent);color:var(--accent-fg);cursor:pointer" : "border:1px solid var(--border);background:transparent;color:var(--fg-40);cursor:default"}">${esc(label)}</button>`;

/** A plan as a dropdown's option: its name, and what it is in one line. */
const planOption = (id: PlanId) => ({ value: id, label: PLANS[id].name, hint: PLANS[id].description });
export const planDropdown = (id: string, act: string, value: PlanId, disabled = false): DropdownProps =>
  ({ id, act, value, options: PLAN_IDS.map(planOption), labelledBy: `${id}-l`, fill: true, disabled });
const EXPIRY_LABEL = (v: ExpiryChoice): string => (v === "never" ? "Never" : `In ${v} days`);
export const expiryDropdown = (value: ExpiryChoice, disabled = false): DropdownProps => ({
  id: "plat-grant-expiry", act: "platGrantExpiry", value, labelledBy: "plat-grant-expiry-l", fill: true, disabled,
  options: (["never", ...GRANT_EXPIRY_DAYS.map((d) => String(d))] as ExpiryChoice[]).map((v) => ({ value: v, label: EXPIRY_LABEL(v) })),
});

/** The five limit fields. Each shows the plan's own value as its placeholder, so a blank field reads as that. */
function limitFields(o: { idPrefix: string; act: string; plan: PlanId; limits: LimitDraft; error?: string | null; disabled: boolean; enter: string }): string {
  const base = PLANS[o.plan].entitlements;
  const fields = LIMIT_KEYS.map((k) => {
    const id = `${o.idPrefix}-${k}`;
    const unit = LIMITS[k].unit === "bytes" ? " (GB)" : LIMITS[k].per === "person" ? " (per person)" : "";
    const own = base[k] === null ? "Unlimited" : LIMITS[k].unit === "bytes" ? String(+(base[k]! / GB).toFixed(2)) : String(base[k]);
    return `<div style="min-width:0">
      <label for="${attr(id)}" style="${FIELD_LABEL}">${esc(LIMITS[k].label)}${unit}</label>
      <input id="${attr(id)}" data-act="${attr(o.act)}" data-arg="${k}" data-field="${attr(id)}" data-enter="${attr(o.enter)}" value="${attr(o.limits[k])}" placeholder="${attr(own)}" inputmode="decimal" autocomplete="off" autocapitalize="off" spellcheck="false"${o.disabled ? " disabled" : ""}${o.error ? ` aria-invalid="true" aria-describedby="${attr(o.idPrefix)}-err"` : ` aria-describedby="${attr(o.idPrefix)}-help"`} class="cnpy-input" style="${FIELD}" />
    </div>`;
  }).join("");
  return `<div class="plat-limits">${fields}</div>
    ${o.error ? `<div id="${attr(o.idPrefix)}-err" role="alert" style="font-size:12px;line-height:1.45;color:var(--red);margin-top:8px">${esc(o.error)}</div>`
      : `<div id="${attr(o.idPrefix)}-help" style="${QUIET};margin-top:8px;line-height:1.45">Leave a limit blank for the ${esc(PLANS[o.plan].name)} plan's own (shown in the field). Type a number, or “unlimited”.</div>`}`;
}

// ── ACCESS: the grants ───────────────────────────────────────────────────────
const GRANT_STATUS: Record<PlatformGrant["status"], { text: string; tone: string }> = {
  unused: { text: "UNUSED", tone: "var(--amber)" },
  used: { text: "USED", tone: "var(--green)" },
  revoked: { text: "REVOKED", tone: "var(--fg-55)" },
  expired: { text: "EXPIRED", tone: "var(--fg-55)" },
};
/** Who a grant is for, and how they were named. */
export const grantWho = (g: Pick<PlatformGrant, "handle" | "github_login" | "email">): { name: string; kind: string } =>
  g.handle ? { name: `@${g.handle}`, kind: "Trov handle" } : g.github_login ? { name: g.github_login, kind: "GitHub login" } : { name: g.email ?? "", kind: "Email" };
const shortDate = (iso: string): string => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

function grantRow(g: PlatformGrant): string {
  const who = grantWho(g);
  const st = GRANT_STATUS[g.status];
  const limits = LIMIT_KEYS.filter((k) => k in g.overrides).map((k) => `${LIMITS[k].label.toLowerCase()} ${formatLimit(k, g.overrides[k] ?? null).toLowerCase()}`);
  const became = g.status === "used"
    ? (g.org ? `became <button type="button" data-act="platOpenOrg" data-arg="${attr(g.org.slug)}" class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:500;color:var(--fg-70);text-decoration:underline;text-underline-offset:2px">${esc(g.org.name)}</button>${g.used_by ? ` (@${esc(g.used_by)}, ${esc(relTime(g.used_at ?? g.created_at))})` : ""}` : "used")
    : g.status === "revoked" ? `revoked ${g.revoked_at ? esc(relTime(g.revoked_at)) : ""}${g.revoked_by ? ` by @${esc(g.revoked_by)}` : ""}`
    : g.status === "expired" ? `expired ${g.expires_at ? esc(shortDate(g.expires_at)) : ""}`
    : g.expires_at ? `expires ${esc(shortDate(g.expires_at))}` : "does not expire";
  const mail = g.email ? ` &middot; ${g.mail_status === "sent" ? "email sent" : g.mail_status === "failed" ? `<span style="color:var(--red)">email not sent</span>` : "no email sent"}` : "";
  const canRevoke = g.status === "unused" || g.status === "expired";
  return `<li style="${ROW}" data-grant="${g.id}" data-grant-status="${g.status}">
    <div style="flex:1 1 260px;min-width:0;line-height:1.4">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:13.5px;font-weight:600;overflow-wrap:anywhere">${esc(who.name)}</span>${statusBadge(st.text, st.tone)}<span style="font-size:12.5px;font-weight:500;color:var(--fg-70)">${esc(PLANS[g.plan].name)}</span></div>
      <div style="font-size:12px;color:var(--fg-40);overflow-wrap:anywhere;margin-top:2px">${esc(who.kind)} &middot; granted ${esc(relTime(g.created_at))} by ${g.source === "billing" ? "billing" : `@${esc(g.granted_by)}`} &middot; ${became}${mail}${limits.length ? ` &middot; ${esc(limits.join(", "))}` : ""}</div>
      ${g.note ? `<div style="font-size:12px;color:var(--fg-55);overflow-wrap:anywhere;margin-top:2px">${esc(g.note)}</div>` : ""}
    </div>
    ${canRevoke ? dangerLink("Revoke", "platGrantRevokeArm", { arg: String(g.id), field: `platGrantRevoke:${g.id}`, label: `Revoke the grant for ${who.name}` }) : ""}
  </li>`;
}

const GRANT_BTN = `<button type="button" data-act="platGrantOpen" data-plat-grant-trigger class="cnpy-accentbtn" style="display:inline-flex;align-items:center;gap:7px;height:32px;padding:0 13px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-size:12.5px;font-weight:600;white-space:nowrap">${PLUS}Grant an organization</button>`;

export function accessTab(a: AccessState): string {
  const { status, data } = a.grants;
  if (status === "error" && !data.length) return `<div role="alert" style="font-size:13px;color:var(--fg-70);padding:10px 0">Couldn't load the grants. <button type="button" data-act="platReload" class="cnpy-mutelink" style="padding:0;font-size:13px;font-weight:500;color:var(--accent)">Try again</button></div>`;
  if (status !== "ok" && !data.length) return loadingNote("grants");
  const what = "A grant lets one person set up one organization of their own, on the plan you choose.";
  if (!data.length) return `${tabLead(`No grants yet. ${what}`, GRANT_BTN)}${orgEmpty("Nobody has been granted an organization", "To hand someone an organization without creating it for them, grant them one. They name it when they sign in.")}`;
  const unused = data.filter((g) => g.status === "unused").length;
  return `${tabLead(`<strong>${data.length}</strong> ${data.length === 1 ? "grant" : "grants"} &middot; <strong>${unused}</strong> unused. ${what}`, GRANT_BTN)}
    <ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${data.map(grantRow).join("")}</ul>`;
}

// ── the grant dialog ─────────────────────────────────────────────────────────
const GRANT_HELP: Record<AdminKind, string> = {
  handle: "Someone who already has a Trov account. They see it the next time they open Trov.",
  github: "They see it when they sign in with this GitHub account; they need no Trov account yet. No email is sent: tell them it is waiting.",
  email: "Trov emails them. They see it when they sign in with this address (GitHub's verified email, or Google).",
};
export const grantTarget = (d: Pick<GrantDraft, "kind" | "value">): GrantTarget => adminTarget(d.kind, d.value) as GrantTarget;
/** What a grant did, said plainly (the dialog's last screen). */
export function grantSentence(g: PlatformGrant): string {
  const who = grantWho(g).name;
  const plan = PLANS[g.plan].name;
  const told = g.email ? (g.mail_status === "sent" ? "Trov emailed them." : g.mail_status === "failed" ? "The email could not be sent: tell them yourself." : "No email was sent: tell them yourself.")
    : g.github_login ? "No email is sent for a GitHub login: tell them it is waiting." : "They see it the next time they open Trov.";
  return `${who} can now set up one ${plan} organization. ${told}`;
}
export function grantServerError(code: string, d: Pick<GrantDraft, "kind" | "value">): GrantDraft["errors"] {
  if (code === "no_such_person") return { to: `No one has the handle @${d.value.trim().replace(/^@/, "")}. Check the spelling, or grant by GitHub login or email instead.` };
  if (code === "invalid_grant") return { to: adminError(d.kind, d.value) ?? undefined, form: adminError(d.kind, d.value) ? undefined : "That grant wasn't accepted. A superadmin needs none; otherwise check the limits and the note." };
  return { form: "The grant wasn't made. Check your connection and try again." };
}

const shell = (id: string, closeAct: string, labelled: string, inner: string, describedBy = ""): string => `<div data-overlay="${attr(id)}" class="cnpy-cmodal">
    <div data-act="${attr(closeAct)}" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="${attr(id)}" role="dialog" aria-modal="true" aria-labelledby="${attr(labelled)}"${describedBy ? ` aria-describedby="${attr(describedBy)}"` : ""} tabindex="-1" data-plat-dialog data-scroll-keep="${attr(id)}" class="cnpy-surface cnpy-cmodal-box cnpy-scroll" style="position:relative;width:min(520px, 100%);max-height:calc(100vh - 32px);overflow-y:auto">
        <button type="button" data-act="${attr(closeAct)}" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        ${inner}
      </div>
    </div>
  </div>`;

/** "Grant an organization": the person (three ways), the plan, optionally its limits, a note, an expiry. */
export function grantModal(d: GrantDraft, dd: DropdownUi = initialDropdownUi()): string {
  if (d.done) {
    return shell("plat-grant", "platGrantClose", "plat-grant-t", `<div id="plat-grant-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">Organization granted</div>
      <p id="plat-grant-d" role="status" style="margin:8px 0 0;font-size:13.5px;line-height:1.55;color:var(--fg-70);overflow-wrap:anywhere">${esc(grantSentence(d.done))}</p>
      <p style="margin:6px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-55)">They choose its name and address and become its owner. Until they do, you can revoke it here.</p>
      <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px">${goBtn("Done", true, "platGrantClose", true)}</div>`, "plat-grant-d");
  }
  const e = d.errors;
  const off = d.busy ? " disabled" : "";
  const showLimits = d.limitsOpen || d.plan === "enterprise";
  return shell("plat-grant", "platGrantClose", "plat-grant-t", `<div id="plat-grant-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">Grant an organization</div>
    <p style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">They set it up themselves: its name, its address, its team. One grant makes one organization.</p>
    <fieldset style="margin:16px 0 0;padding:0;border:none;min-width:0">
      <legend style="${FIELD_LABEL};padding:0;margin-bottom:8px">Person</legend>
      ${adminField({ segId: "plat-grant-kind", kindAct: "platGrantKind", valueAct: "platGrantValue", field: "platGrantValue", enter: "platGrantSubmit", kind: d.kind, value: d.value, error: e.to, disabled: d.busy, inputId: "plat-grant-to", help: GRANT_HELP, ariaLabel: "How to name the person" })}
    </fieldset>
    <div style="margin-top:16px">
      <div id="plat-grant-plan-l" style="${FIELD_LABEL}">Plan</div>
      ${dropdown(planDropdown("plat-grant-plan", "platGrantPlan", d.plan, d.busy), dd)}
      <div style="${QUIET};margin-top:6px;line-height:1.45">${esc(PLANS[d.plan].name)}: ${esc(seatsPhrase(resolveEntitlements(d.plan).seats))}.${showLimits ? "" : ` <button type="button" data-act="platGrantLimits" data-field="platGrantLimits" aria-expanded="false" aria-controls="plat-grant-limits" class="cnpy-mutelink" style="padding:0;font-size:11.5px;font-weight:500;color:var(--fg-55);text-decoration:underline;text-underline-offset:2px"${off}>Set its limits</button>`}</div>
    </div>
    ${showLimits ? `<fieldset id="plat-grant-limits" style="margin:16px 0 0;padding:0;border:none;min-width:0">
      <legend style="${FIELD_LABEL};padding:0;margin-bottom:8px">Limits for this organization</legend>
      ${limitFields({ idPrefix: "plat-grant-limit", act: "platGrantLimit", plan: d.plan, limits: d.limits, error: e.limits, disabled: d.busy, enter: "platGrantSubmit" })}
    </fieldset>` : ""}
    <div class="plat-inline" style="margin-top:16px;align-items:flex-start">
      <div style="flex:2;min-width:0">
        <label for="plat-grant-note" style="${FIELD_LABEL}">Note <span style="text-transform:none;letter-spacing:0;font-weight:500">(optional)</span></label>
        <input id="plat-grant-note" data-act="platGrantNote" data-field="platGrantNote" data-enter="platGrantSubmit" value="${attr(d.note)}" maxlength="${GRANT_NOTE_MAX}" placeholder="Why, for your own record" autocomplete="off"${off} class="cnpy-input" style="${FIELD};height:36px" />
      </div>
      <div style="flex:1;min-width:0">
        <div id="plat-grant-expiry-l" style="${FIELD_LABEL}">Expires</div>
        ${dropdown(expiryDropdown(d.expiry, d.busy), dd)}
      </div>
    </div>
    ${e.form ? `<div role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:14px">${esc(e.form)}</div>` : ""}
    <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
      <button type="button" data-act="platGrantClose" class="cnpy-outlinebtn"${off} style="${OUTLINE}">Cancel</button>
      ${goBtn(d.busy ? "Granting…" : "Grant organization", !d.busy, "platGrantSubmit")}
    </div>`);
}

// ── an organization's plan (its page) ────────────────────────────────────────
/** "7 of 10" / "7" — the Organizations list's Seats cell. */
export const seatsCell = (p: PlatformOrgPlan): string => formatUse("seats", p.seats_used, p.entitlements.seats);

/** "paid" / "granted" (and what Stripe says of a paid one) — the list's word beside the seats. */
export function planSourceWord(p: PlatformOrgPlan): string {
  if (!p.billing) return p.source === "billing" ? "paid" : "granted";
  return p.status === "canceled" ? "paid, ended" : p.status === "past_due" ? "paid, past due" : p.billing.cancel_at_period_end ? "paid, cancelling" : "paid";
}

/** A paid org's subscription, on its page: Stripe's status, the period, the customer in the Stripe dashboard —
 *  and, when the superadmin set a plan the subscription does not pay for, that it is pinned and how to undo it. */
function billingLine(p: PlatformOrgPlan): string {
  const b = p.billing;
  if (!b) return `<div data-plat-billing="granted" style="font-size:12.5px;color:var(--fg-55);margin-top:8px;line-height:1.5">Granted by Trov: nobody pays for this plan through Stripe.</div>`;
  const date = billingDate(b.period_end);
  const when = !date ? "" : p.status === "canceled" ? ` &middot; ended ${esc(date)}` : b.cancel_at_period_end ? ` &middot; ends ${esc(date)}` : ` &middot; renews ${esc(date)}`;
  const every = b.interval === "year" ? "yearly" : b.interval === "month" ? "monthly" : "";
  const pinned = b.pinned
    ? `<div style="margin-top:8px;display:flex;align-items:center;gap:10px;flex-wrap:wrap"><span style="font-size:12.5px;line-height:1.5;color:var(--fg-70)">You set this plan by hand. The subscription pays for ${esc(PLANS[b.plan].name)}, and its events do not change the plan while it is pinned.</span><button type="button" data-act="platPlanFollow" data-field="platPlanFollow" class="cnpy-outlinebtn" style="${OUTLINE};height:30px">Follow subscription</button></div>`
    : "";
  return `<div data-plat-billing="${b.pinned ? "pinned" : "paid"}" style="margin-top:8px">
    <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55)">Paid through Stripe${every ? `, ${every}` : ""} &middot; Stripe says <strong style="font-weight:500;color:var(--fg-70)">${esc(b.stripe_status.replace(/_/g, " "))}</strong>${when}${b.livemode ? "" : " &middot; test mode"} &middot; <a href="${attr(b.dashboard_url)}" target="_blank" rel="noopener noreferrer" style="color:var(--fg-70)">Open the customer in Stripe</a></div>
    ${pinned}
  </div>`;
}

/** The org page's Plan section: what it is on, its limits, and the way to change them. */
export function orgPlanSection(o: { slug: string; name: string; plan?: PlatformOrgPlan }, artifactBytes: number | null): string {
  const p = o.plan;
  if (!p) return "";
  const def = PLANS[p.plan];
  const status = p.status === "canceled" ? statusBadge("ENDED", "var(--red)") : p.status === "past_due" ? statusBadge("PAST DUE", "var(--amber)") : "";
  const use: Partial<Record<LimitKey, number>> = { seats: p.seats_used, ...(artifactBytes === null ? {} : { artifact_bytes: artifactBytes }) };
  const cells = LIMIT_KEYS.map((k) => {
    const cap = p.entitlements[k];
    const used = use[k];
    const over = cap !== null && used !== undefined && used > cap;
    const value = used === undefined ? formatLimit(k, cap) : cap === null ? `${LIMITS[k].unit === "bytes" ? formatBytes(used) : used} used` : formatUse(k, used, cap);
    return `<div data-limit="${k}" style="min-width:0">
      <div style="${FIELD_LABEL};margin-bottom:3px">${esc(LIMITS[k].label)}${k in p.overrides ? ` <span style="text-transform:none;letter-spacing:0;font-weight:500">&middot; set for this org</span>` : ""}</div>
      <div style="font-size:13.5px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--fg)">${esc(value)}${used === undefined || cap !== null ? "" : ` <span style="font-weight:400;color:var(--fg-40)">&middot; unlimited</span>`}${over ? ` <span style="font-size:12px;color:var(--amber)">over the limit</span>` : ""}</div>
    </div>`;
  }).join("");
  return `<div${surface("padding:16px 20px")} data-plat-plan="${p.plan}">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div style="min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><span style="font-size:15px;font-weight:600">${esc(def.name)}</span>${status}</div>
        <div style="font-size:12.5px;color:var(--fg-55);margin-top:2px;line-height:1.5">${esc(def.description)}</div>
        ${billingLine(p)}
      </div>
      <button type="button" data-act="platPlanOpen" data-plat-plan-trigger class="cnpy-outlinebtn" aria-haspopup="dialog" style="${OUTLINE};height:32px">Change plan</button>
    </div>
    <div class="plat-limits" style="margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">${cells}</div>
  </div>`;
}

/** What changing the plan will do — the confirmation's words. Says, when it applies, that the org is
 *  OVER the new limits and what that means: nothing is removed, additions wait. */
export function planChangeCopy(d: Pick<PlanDraft, "name" | "current" | "plan" | "artifactBytes">, overrides: PlanOverrides): { title: string; body: string } {
  const next = resolveEntitlements(d.plan, overrides);
  const from = PLANS[d.current.plan].name, to = PLANS[d.plan].name;
  const title = d.plan === d.current.plan ? `Change ${d.name}'s limits?` : `Move ${d.name} from ${from} to ${to}?`;
  const over: string[] = [];
  if (next.seats !== null && d.current.seats_used > next.seats) over.push(`${d.current.seats_used} seats (members and pending invitations) where the new limit is ${next.seats}`);
  if (next.artifact_bytes !== null && d.artifactBytes !== null && d.artifactBytes > next.artifact_bytes) over.push(`${formatBytes(d.artifactBytes)} of artifacts where the new limit is ${formatBytes(next.artifact_bytes)}`);
  const seats = `Its seats become ${next.seats === null ? "unlimited" : next.seats}; it uses ${d.current.seats_used}.`;
  const rest = "Nothing is removed and nobody loses access. Anything it already has over a new limit stays, and no more of that kind can be added until it is back under.";
  return { title, body: over.length ? `${d.name} will be over the new limits: it has ${over.join(", and ")}. ${rest}` : `${seats} ${rest}` };
}

/** What Change plan does to an org that PAYS (docs/architecture/billing.md › The superadmin and a paid org). */
export function planModalBillingNote(p: PlatformOrgPlan): string {
  if (!p.billing) return "";
  const text = p.status === "canceled"
    ? "Its subscription has ended. A plan you set here takes the organization back as a granted one: active, and no longer tied to Stripe."
    : `It pays for ${PLANS[p.billing.plan].name} through Stripe. A different plan set here is pinned: the subscription keeps charging what it charges, its status and renewals still apply, and its events stop changing the plan until you choose Follow subscription.`;
  return `<p data-plat-plan-billing role="note" class="cnpy-plan-note" style="border-radius:9px;margin:10px 0 0">${esc(text)}</p>`;
}

/** "Change plan": the plan and the five limits; then the confirmation (`confirm`). */
export function planModal(d: PlanDraft, dd: DropdownUi = initialDropdownUi()): string {
  if (d.confirm) {
    const parsed = parseLimitDraft(d.limits);
    const copy = planChangeCopy(d, "overrides" in parsed ? parsed.overrides : {});
    return confirmModal({ id: "plat-plan-confirm", title: copy.title, body: copy.body, confirmLabel: "Change plan", busyLabel: "Changing…", confirmAct: "platPlanGo", cancelAct: "platPlanBack", busy: d.busy, tone: "neutral" });
  }
  return shell("plat-plan", "platPlanClose", "plat-plan-t", `<div id="plat-plan-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em;overflow-wrap:anywhere">Change ${esc(d.name)}'s plan</div>
    <p style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">It is on ${esc(PLANS[d.current.plan].name)} and uses ${esc(formatUse("seats", d.current.seats_used, d.current.entitlements.seats))} seats. Changing a plan never removes anything from the organization.</p>
    ${planModalBillingNote(d.current)}
    <div style="margin-top:16px">
      <div id="plat-plan-pick-l" style="${FIELD_LABEL}">Plan</div>
      ${dropdown(planDropdown("plat-plan-pick", "platPlanPick", d.plan), dd)}
    </div>
    <fieldset style="margin:16px 0 0;padding:0;border:none;min-width:0">
      <legend style="${FIELD_LABEL};padding:0;margin-bottom:8px">Limits for this organization</legend>
      ${limitFields({ idPrefix: "plat-plan-limit", act: "platPlanLimit", plan: d.plan, limits: d.limits, error: d.error, disabled: false, enter: "platPlanReview" })}
    </fieldset>
    <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
      <button type="button" data-act="platPlanClose" class="cnpy-outlinebtn" style="${OUTLINE}">Cancel</button>
      ${goBtn("Review change", true, "platPlanReview")}
    </div>`);
}

/** The dialogs this file owns, and the open dropdown's menu among them (a root overlay, above the dialog). */
export function accessDialogs(a: AccessState, screen: string, dd: DropdownUi): string {
  if (screen === "platformorg" && a.plan) {
    return planModal(a.plan, dd) + (a.plan.confirm ? "" : dropdownMenu([planDropdown("plat-plan-pick", "platPlanPick", a.plan.plan)], dd));
  }
  if (screen !== "platform") return "";
  if (a.revokeArm !== null) {
    const g = a.grants.data.find((x) => x.id === a.revokeArm);
    return confirmModal({
      id: "plat-grant-revoke", title: `Revoke the grant for ${g ? grantWho(g).name : "this person"}?`,
      body: "They can no longer set up an organization with it. Nothing else changes, and you can grant them another at any time.",
      confirmLabel: "Revoke", busyLabel: "Revoking…", confirmAct: "platGrantRevokeGo", cancelAct: "platGrantRevokeCancel", busy: a.revokeBusy,
    });
  }
  if (a.grant) return grantModal(a.grant, dd) + (a.grant.done ? "" : dropdownMenu([planDropdown("plat-grant-plan", "platGrantPlan", a.grant.plan, a.grant.busy), expiryDropdown(a.grant.expiry, a.grant.busy)], dd));
  return "";
}
