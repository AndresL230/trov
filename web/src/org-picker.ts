// Organizations, as a person meets them (canopy-multitenancy.md §5.1, §5.3) — three views over
// ONE piece of state (`GET /api/orgs`, loaded at boot into `state.myOrgs`):
//   THE SWITCHER  — in the sidebar's header: the current org's name; its menu lists the person's
//                   orgs with their role, pending invitations (Accept / Decline), Org settings and
//                   Create organization. The menu is a root-level overlay (like every dialog), so
//                   the collapsed rail and the phone drawer cannot clip it.
//   THE PICKER    — the full page at `/` for a person in no org or in several with none
//                   remembered: the same lists, plus what Trov is for someone who has nothing yet.
//   CREATE        — one dialog (name + a slug derived from it), opened from either. Its rules and
//                   its server errors are the superadmin's "Add organization" dialog's (platform.ts).
//                   It is offered to a person who holds a GRANT (shared/plans.ts) — the picker shows
//                   each one as "You can set up an organization — <Plan>", and creating USES it — and
//                   to one who may create a FREE organization (they own none on Free: src/plans/free.ts).
// Purely presentational: props in, markup out. Every act starts with `orgs` and is run by
// web/src/org-picker-actions.ts.

import { trovMark } from "@shared/mark";
import { ORG_NAME_MAX, type MyInvite, type MyOrg, type MyOrgsResponse, type OrgRole } from "@shared/orgs";
import { PLANS, FREE_PLAN, UPGRADE_PLAN, giftLengthWords, seatsPhrase, type MyGrant } from "@shared/plans";
import { BILLING_GRANTER } from "@shared/billing";
import { esc, attr, relTime, surface } from "./ui";
import { accentBtn, quietBtn, orgBanner, roleChip } from "./org-ui";
import { nameError, slugError, addOrgServerError } from "./platform";
import { orgHref } from "./org-context";
import { orgTile } from "./org-logo";
import { skeleton, skLine } from "./skeleton";
export { orgTile };

// ── state ────────────────────────────────────────────────────────────────────
export interface CreateOrgErrors { name?: string; slug?: string; form?: string }
export interface CreateOrgDraft {
  name: string;
  slug: string;
  /** The slug was typed by hand, so the name no longer rewrites it. */
  slugTouched: boolean;
  busy: boolean;
  errors: CreateOrgErrors;
  /** The grant this creation uses (its id and what it gives), or null = the person's oldest. */
  grant: (Pick<MyGrant, "id" | "plan_name" | "entitlements"> & Partial<Pick<MyGrant, "gift_days">>) | null;
  /** No grant: a Free organization of their own (`grant` is then null). */
  free: boolean;
}
export const blankCreateOrg = (grant: CreateOrgDraft["grant"] = null, free = false): CreateOrgDraft => ({ name: "", slug: "", slugTouched: false, busy: false, errors: {}, grant, free: grant === null && free });

/** What the switcher, the picker and the create dialog keep in AppState (`state.orgsUi`). */
export interface OrgsUi {
  /** The switcher's menu is open. */
  menu: boolean;
  create: CreateOrgDraft | null;
  /** The invite being answered (its id), so its two buttons wait. */
  inviteBusy: number | null;
  inviteError: string | null;
  /** The picker's opening sentence: the org the URL named is not this person's. */
  lost: string | null;
}
export const initialOrgsUi = (): OrgsUi => ({ menu: false, create: null, inviteBusy: null, inviteError: null, lost: null });

// ── the create rules (pure; the server re-checks every one) ──────────────────
export function createOrgErrors(d: Pick<CreateOrgDraft, "name" | "slug">): CreateOrgErrors {
  const e: CreateOrgErrors = {};
  const n = nameError(d.name), s = slugError(d.slug);
  if (n) e.name = n;
  if (s) e.slug = s;
  return e;
}
/** Why an organization can't be created (any more): the grant behind it was used, withdrawn or has lapsed. */
export const NO_GRANT_SENTENCE = "You don't have an organization to set up any more: it was already used, or it was withdrawn or has expired. Ask Trov if you need one.";
/** Why a Free organization can't be created: the person already owns one. */
export const FREE_TAKEN_SENTENCE = `You already own a ${PLANS[FREE_PLAN].name} organization, and you can own one at a time. Upgrade it to ${PLANS[UPGRADE_PLAN].name} in its Org settings, or ask Trov if you need another.`;
/** A refused `POST /api/orgs`, as a sentence beside the field it concerns. */
export function createOrgServerError(code: string, d: Pick<CreateOrgDraft, "slug">): CreateOrgErrors {
  if (code === "no_grant") return { form: NO_GRANT_SENTENCE };
  if (code === "free_org_limit") return { form: FREE_TAKEN_SENTENCE };
  const e = addOrgServerError(code, { slug: d.slug, adminKind: "handle", adminValue: "" });
  return { name: e.name, slug: e.slug, form: e.form };
}

// ── atoms ────────────────────────────────────────────────────────────────────
const LABEL = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40)";
const CHECK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M20 6 9 17l-5-5"></path></svg>`;
const UPDOWN = `<svg class="cnpy-lbl" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;color:var(--fg-40)"><path d="m7 9 5-5 5 5"></path><path d="m7 15 5 5 5-5"></path></svg>`;
const PLUS = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" style="flex:none"><path d="M12 5v14M5 12h14"></path></svg>`;
const GEAR = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"></path><path d="M16 9h2a2 2 0 0 1 2 2v10"></path><path d="M2 21h20"></path><path d="M8 7h4M8 11h4M8 15h4"></path></svg>`;
const CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

const ROLE_WORD: Record<OrgRole, string> = { owner: "owner", admin: "admin", member: "member" };
/** "an admin" / "a member" — the role an invite grants, in a sentence. */
const asRole = (r: OrgRole): string => `${r === "member" ? "a" : "an"} ${ROLE_WORD[r]}`;
/** Who invited the person, to what and as what — the line under an invitation. */
/** Where creating an organization lands (a Free one, a granted or a paid one): its guided setup. */
export const createLanding = (slug: string): string => orgHref(slug, "#welcome");
/** Where accepting an invitation lands: the org's guided setup (welcome.ts) — an owner's and an admin's
 *  starts at connecting a repository, a member's at connecting their coding agent. */
export const acceptLanding = (i: Pick<MyInvite, "org" | "role">): string => orgHref(i.org.slug, i.role === "member" ? "#welcome/agent" : "#welcome");
export const inviteSentence = (i: MyInvite): string => `@${i.invited_by} invited you to join as ${asRole(i.role)}`;

function inviteRow(i: MyInvite, ui: Pick<OrgsUi, "inviteBusy">, compact: boolean): string {
  const busy = ui.inviteBusy === i.id;
  const off = ui.inviteBusy !== null;
  const sent = i.github_login ? `to @${i.github_login}` : i.email ? `to ${i.email}` : "";
  return `<li class="cnpy-orgs-inv" style="${compact ? "padding:9px 10px" : "padding:13px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px"}">
    ${orgTile(i.org.name, compact ? 24 : 28, i.org.logo_url)}
    <div style="flex:1 1 160px;min-width:0;line-height:1.35">
      <div style="font-size:13.5px;font-weight:600;overflow-wrap:anywhere">${esc(i.org.name)}</div>
      <div style="font-size:12px;color:var(--fg-55);overflow-wrap:anywhere">${esc(inviteSentence(i))}${compact ? "" : ` &middot; sent ${esc(sent)} ${esc(relTime(i.created_at))}`}</div>
    </div>
    <div style="display:flex;gap:6px;flex:none">
      ${accentBtn(busy ? "Joining…" : "Accept", "orgsInvite", { arg: `accept:${i.id}`, disabled: off, busy, label: `Accept the invitation to ${i.org.name}`, extra: "height:30px;padding:0 12px" })}
      ${quietBtn("Decline", "orgsInvite", { arg: `decline:${i.id}`, disabled: off, label: `Decline the invitation to ${i.org.name}`, extra: "height:30px;padding:0 12px" })}
    </div>
  </li>`;
}

// ── the switcher ─────────────────────────────────────────────────────────────
export interface OrgSwitcherProps {
  /** The org on screen (null only before the first paint has one). */
  org: MyOrg | null;
  open: boolean;
  /** Pending invitations, as a count on the button (0 = none). */
  invites: number;
  /** Logins waiting in Org settings › Members for an admin to match (0 for a member): they
   *  join the button's count, since the menu behind it is the way to Org settings. */
  logins?: number;
  collapsed: boolean;
}
/** What the switcher's count stands for, in words. */
export function orgWaitingTitle(invites: number, logins: number): string {
  const parts = [invites ? `${invites} pending ${invites === 1 ? "invitation" : "invitations"}` : "", logins ? `${logins} ${logins === 1 ? "login" : "logins"} to match in Org settings` : ""].filter(Boolean);
  return parts.join(" · ") || "Nothing waiting";
}
/** The sidebar header's button: the current org's name; it opens the menu (`orgMenu`). Always
 *  emitted — collapsed, the rail keeps the tile and its tooltip names the org. */
export function orgSwitcherButton(p: OrgSwitcherProps): string {
  const name = p.org?.name ?? "Organizations";
  const waiting = p.invites + (p.logins ?? 0);
  return `<div class="cnpy-orgsw" data-tip="${attr(p.org ? `${name}: switch organization` : "Organizations")}">
    <button type="button" data-act="orgsMenu" data-field="orgsMenu" data-orgsw-trigger class="cnpy-orgsw-b${p.open ? " is-open" : ""}" style="border-radius:8px" aria-haspopup="dialog" aria-expanded="${p.open}" aria-controls="orgs-menu" aria-label="${attr(p.org ? `${name}: switch organization` : "Organizations")}">
      ${orgTile(name, 24, p.org?.logo_url)}
      <span class="cnpy-lbl cnpy-orgsw-n">${esc(name)}</span>
      <span class="cnpy-lbl cnpy-badge" data-n="${waiting}" title="${attr(orgWaitingTitle(p.invites, p.logins ?? 0))}">${waiting}</span><span class="cnpy-dot" data-n="${waiting}"></span>
      ${UPDOWN}
    </button>
  </div>`;
}

export interface OrgMenuProps {
  orgs: MyOrgsResponse | null;
  /** `me.orgs` — shown until `GET /api/orgs` lands, so the list is never empty on a signed-in page. */
  mine: readonly MyOrg[];
  current: string | null;
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  ui: OrgsUi;
  /** The viewer is a platform superadmin: the menu ends with a link to the Platform area (`/platform/`). */
  superadmin?: boolean;
  /** Logins waiting to be matched (an admin's count; 0 = none): shown on the Org settings row. */
  logins?: number;
}
/** The Platform area's own page, outside any org (platform.ts `PLATFORM_PATH`) — a plain link, a page load. */
const PLATFORM_HREF = "/platform/";
const SHIELD = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M12 3l7 3v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6z"></path></svg>`;
const MENU_ROW = "display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:6px 10px;border-radius:8px;text-align:left;font-size:13px;font-weight:500;color:var(--fg-70)";

/** The switcher's menu, at the app root: my orgs with my role in each, invitations, Org settings,
 *  Create organization. A dialog rather than a `menu`: it holds Accept / Decline buttons too.
 *  ↑ / ↓ move between its rows, Escape closes it back onto the button (org-picker-actions.ts). */
export function orgMenu(p: OrgMenuProps): string {
  if (!p.ui.menu) return "";
  const orgs = p.orgs?.orgs ?? p.mine;
  const rows = orgs.map((o) => {
    const here = o.slug === p.current;
    return `<li><a href="${attr(orgHref(o.slug))}" data-act="orgsSwitch" data-arg="${attr(o.slug)}" data-orgs-item class="cnpy-menurow${here ? " is-active" : ""}"${here ? ' aria-current="true"' : ""} style="${MENU_ROW};text-decoration:none;box-sizing:border-box">
      ${orgTile(o.name, 24, o.logo_url)}
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg)">${esc(o.name)}</span>
      ${roleChip(o.role)}
      <span style="width:14px;flex:none;display:grid;place-items:center">${here ? CHECK : ""}</span>
    </a></li>`;
  }).join("");
  const invites = p.orgs?.invites ?? [];
  const inviteBlock = invites.length ? `<div style="border-top:1px solid var(--border);padding:8px 6px 4px">
      <div style="${LABEL};padding:2px 10px 4px">Invitations</div>
      <ul style="list-style:none;margin:0;padding:0">${invites.map((i) => inviteRow(i, p.ui, true)).join("")}</ul>
      ${p.ui.inviteError ? `<div role="alert" style="font-size:12px;line-height:1.45;color:var(--red);padding:2px 10px 6px">${esc(p.ui.inviteError)}</div>` : ""}
    </div>` : "";
  const here = orgs.find((o) => o.slug === p.current) ?? null;
  const settings = here ? `<button type="button" data-act="orgsSettings" data-orgs-item class="cnpy-menurow" style="${MENU_ROW}">${GEAR}<span style="flex:1;min-width:0">Org settings</span><span class="cnpy-badge" data-n="${p.logins ?? 0}" title="${p.logins ?? 0} ${p.logins === 1 ? "login" : "logins"} to match">${p.logins ?? 0}</span></button>` : "";
  // "Create organization" is there only for a person who can: a usable grant (their oldest), else Free.
  const create = !p.orgs ? (p.status === "error" ? `<div role="alert" style="font-size:12px;line-height:1.45;color:var(--fg-55);padding:8px 10px">Couldn't load your invitations. <button type="button" data-act="orgsReload" class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:500;color:var(--accent)">Try again</button></div>` : "")
    : p.orgs.can_create ? `<button type="button" data-act="orgsCreateOpen" data-orgs-item class="cnpy-menurow" style="${MENU_ROW}">${PLUS}<span style="flex:1;min-width:0">Create organization</span></button>`
    : "";
  return `<div data-overlay="orgs-menu" class="cnpy-orgmenu-layer">
    <div data-act="orgsMenuClose" class="cnpy-orgmenu-back" aria-hidden="true"></div>
    <div id="orgs-menu" role="dialog" aria-label="Organizations" data-orgs-menu class="cnpy-orgmenu cnpy-scroll" style="border-radius:11px">
      <div style="padding:6px">
        <div style="${LABEL};padding:6px 10px 4px">Your organizations</div>
        <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:1px">${rows}</ul>
      </div>
      ${inviteBlock}
      <div style="border-top:1px solid var(--border);padding:6px;display:flex;flex-direction:column;gap:1px">${settings}${create}${p.superadmin ? `<a href="${PLATFORM_HREF}" data-orgs-item data-orgs-platform class="cnpy-menurow" style="${MENU_ROW};text-decoration:none;box-sizing:border-box">${SHIELD}<span style="flex:1;min-width:0">Platform</span></a>` : ""}</div>
    </div>
  </div>`;
}

// ── the create dialog ────────────────────────────────────────────────────────
const FIELD = "display:block;width:100%;box-sizing:border-box;height:38px;padding:0 12px;border:1px solid var(--border-strong);border-radius:9px;background:transparent;color:var(--fg);font-size:13.5px;font-family:var(--sans);outline:none";
const FIELD_LABEL = "display:block;font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);margin-bottom:7px";
const BTN = "height:38px;padding:0 16px;border-radius:8px;font-size:12.5px;font-weight:600;white-space:nowrap";

/** "Create an organization": a name and its address. The person who creates it is its owner. */
export function createOrgModal(d: CreateOrgDraft): string {
  const e = d.errors;
  const off = d.busy ? " disabled" : "";
  const err = (id: string, msg: string | undefined) => (msg ? `<div id="${id}" role="alert" style="font-size:12px;line-height:1.45;color:var(--red);margin-top:6px">${esc(msg)}</div>` : "");
  const input = (id: string, act: string, value: string, msg: string | undefined, extra: string, style = "") =>
    `<input id="${id}" data-act="${act}" data-field="${act}" data-enter="orgsCreateSubmit" value="${attr(value)}" autocomplete="off" spellcheck="false"${off}${msg ? ` aria-invalid="true" aria-describedby="${id}-err"` : ` aria-describedby="${id}-h"`} ${extra} class="cnpy-input" style="${FIELD}${style}${msg ? ";border-color:var(--red)" : ""}" />${err(`${id}-err`, msg)}`;
  return `<div data-overlay="orgs-create" class="cnpy-cmodal">
    <div data-act="orgsCreateClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="orgs-create" role="dialog" aria-modal="true" aria-labelledby="orgs-create-t" aria-describedby="orgs-create-d" tabindex="-1" data-orgs-create data-scroll-keep="orgs-create" class="cnpy-surface cnpy-cmodal-box cnpy-scroll" style="position:relative;width:min(480px, 100%);max-height:calc(100vh - 32px);overflow-y:auto">
        <button type="button" data-act="orgsCreateClose" aria-label="Close" title="Close" class="cnpy-iconbtn"${off} style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        <div id="orgs-create-t" style="padding-right:32px;font-size:16px;font-weight:600;letter-spacing:-0.01em">Create an organization</div>
        <p id="orgs-create-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">${d.grant
          ? `It will be on the <strong style="font-weight:600;color:var(--fg-70)">${esc(d.grant.plan_name)}</strong> plan, ${esc(seatsPhrase(d.grant.entitlements.seats))}. You become its owner${d.grant.entitlements.seats === 1 ? "" : " and invite everyone else"}.${d.grant.gift_days ? ` It is free for ${esc(giftLengthWords(d.grant.gift_days))} from today, a gift from Trov; after that it moves to Free, and nothing is deleted.` : ""}`
          : d.free ? `It will be on the <strong style="font-weight:600;color:var(--fg-70)">${esc(PLANS[FREE_PLAN].name)}</strong> plan, ${esc(seatsPhrase(PLANS[FREE_PLAN].entitlements.seats))}. You become its owner and invite everyone else; upgrade it to ${esc(PLANS[UPGRADE_PLAN].name)} when you need more.`
          : "An organization is your team's own Trov: its docs, tickets, roadmap and feed. You become its owner and invite everyone else."}</p>
        <div style="margin-top:16px">
          <label for="orgs-create-name" style="${FIELD_LABEL}">Name</label>
          ${input("orgs-create-name", "orgsCreateName", d.name, e.name, `maxlength="${ORG_NAME_MAX}" placeholder="Acme Robotics"`)}
          ${e.name ? "" : `<div id="orgs-create-name-h" style="font-size:11.5px;color:var(--fg-40);margin-top:6px;line-height:1.45">Your team or company. You can rename it later.</div>`}
        </div>
        <div style="margin-top:14px">
          <label for="orgs-create-slug" style="${FIELD_LABEL}">Address</label>
          ${input("orgs-create-slug", "orgsCreateSlug", d.slug, e.slug, `maxlength="39" autocapitalize="off" placeholder="acme-robotics"`, ";font-family:var(--code);font-size:13px")}
          ${e.slug ? "" : `<div id="orgs-create-slug-h" style="font-size:11.5px;color:var(--fg-40);margin-top:6px;line-height:1.45;overflow-wrap:anywhere">Its links start with <span style="font-family:var(--code);font-size:11.5px;color:var(--fg-55)">/${esc(d.slug || "acme-robotics")}/</span>. Lowercase letters, digits and hyphens. It can't be changed later.</div>`}
        </div>
        ${e.form ? `<div role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:14px">${esc(e.form)}</div>` : ""}
        <div class="cnpy-cmodal-btns" style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px">
          <button type="button" data-act="orgsCreateClose" class="cnpy-outlinebtn"${off} style="${BTN};border:1px solid var(--border-strong);font-weight:500;color:var(--fg-70)">Cancel</button>
          <button type="button" data-act="orgsCreateSubmit"${d.busy ? ' disabled aria-busy="true"' : ' class="cnpy-accentbtn"'} style="${BTN};border:1px solid transparent;background:var(--accent);color:var(--accent-fg)">${d.busy ? "Creating…" : "Create organization"}</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ── the picker ───────────────────────────────────────────────────────────────
export interface OrgPickerProps {
  me: { handle: string; name: string | null; identities: { provider: "github" | "google"; label: string }[] } | null;
  /** `me.orgs` (from sign-in), until `GET /api/orgs` lands with the invitations too. */
  mine: readonly MyOrg[];
  orgs: MyOrgsResponse | null;
  status: "idle" | "loading" | "ok" | "error" | "unauth";
  ui: OrgsUi;
  /** The hash to keep when an org is opened (an old deep link, an e-mail link). */
  hash: string;
  /** The viewer is a platform superadmin: the page links to the Platform area, which needs no membership. */
  superadmin?: boolean;
}

/** Why the org in the URL did not open — one plain sentence; it may be any of three things, and
 *  the server (rightly) does not say which. */
export const lostOrgSentence = (slug: string): string =>
  `You don't have access to “${slug}”. It may have been suspended, you may have been removed from it, or the link may be wrong.`;

/** The org picker / first run: your organizations, your invitations, and creating one. */
export function orgPickerView(p: OrgPickerProps): string {
  const orgs = p.orgs?.orgs ?? p.mine;
  const invites = p.orgs?.invites ?? [];
  const loading = !p.orgs && p.status !== "error";
  const nothing = !loading && orgs.length === 0 && invites.length === 0;
  const first = (p.me?.name ?? "").trim().split(/\s+/)[0] || (p.me ? `@${p.me.handle}` : "");
  const title = orgs.length === 0 ? `Welcome to Trov${first ? `, ${first}` : ""}` : "Choose an organization";
  const granted = (p.orgs?.grants ?? []).length > 0;
  const lead = orgs.length > 0 ? "Everything in Trov belongs to an organization. Pick the one you want to work in; you can switch at any time from the sidebar."
    : invites.length > 0 ? (p.orgs?.can_create ? "You've been invited. Accept an invitation to join that team's Trov, or set up an organization of your own." : "You've been invited. Accept an invitation to join that team's Trov.")
    : granted ? (p.orgs!.grants.every((g) => g.granted_by === BILLING_GRANTER)
      ? "Your payment went through. Name your organization, and you are its owner."
      : "You've been given an organization of your own. Name it, and you are its owner.")
    : `Trov is a team's working memory: what its coding agents did, the docs and decisions that came out of it, and the tickets and roadmap that say what's next. Everything in it belongs to an organization${p.orgs?.free?.can_create ? ": create one for your team, or join one you're invited to." : "."}`;
  const sectionHead = (text: string, n: number) => `<h2 style="${LABEL};margin:26px 0 8px;display:flex;align-items:center;gap:8px">${esc(text)}<span class="cnpy-badge" data-n="${n}">${n}</span></h2>`;

  const orgRows = orgs.map((o) => `<li style="border-bottom:1px solid var(--border);margin-bottom:-1px">
      <a href="${attr(orgHref(o.slug, p.hash))}" data-act="orgsSwitch" data-arg="${attr(o.slug)}" class="cnpy-orgs-row" aria-label="Open ${attr(o.name)}" style="text-decoration:none;color:inherit">
        ${orgTile(o.name, 32, o.logo_url)}
        <span style="flex:1;min-width:0;line-height:1.35">
          <span style="display:block;font-size:14px;font-weight:600;overflow-wrap:anywhere">${esc(o.name)}</span>
          <span style="display:block;font-family:var(--code);font-size:11.5px;color:var(--fg-40);overflow-wrap:anywhere">/${esc(o.slug)}/</span>
        </span>
        ${roleChip(o.role)}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;color:var(--fg-40)"><path d="M9 6l6 6-6 6"></path></svg>
      </a>
    </li>`).join("");
  const orgsBlock = orgs.length ? `${sectionHead("Your organizations", orgs.length)}<ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${orgRows}</ul>` : "";
  const invitesBlock = invites.length ? `${sectionHead("Invitations", invites.length)}<ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${invites.map((i) => inviteRow(i, p.ui, false)).join("")}</ul>
      ${p.ui.inviteError ? `<div role="alert" style="font-size:12.5px;line-height:1.5;color:var(--red);margin-top:8px">${esc(p.ui.inviteError)}</div>` : ""}` : "";

  const ids = p.me?.identities ?? [];
  const gh = ids.find((i) => i.provider === "github");
  const google = ids.find((i) => i.provider === "google");
  const askFor = gh && google ? `your GitHub login (${gh.label}) or your email (${google.label})` : gh ? `your GitHub login (${gh.label})` : google ? `your email (${google.label})` : "your GitHub login or email";
  const grants = p.orgs?.grants ?? [];
  // What else can be done from here, in ONE surface: start an organization, wait for an
  // invitation, run the platform. Creating is the page's primary action (the accent button)
  // only for someone with no organization to open; otherwise opening one is, and this is quiet.
  const optRow = (title: string, sub: string, action: string, attrs = "") => `<li class="cnpy-orgs-opt"${attrs}>
      <div style="flex:1 1 240px;min-width:0">
        <div style="font-size:13.5px;font-weight:600">${title}</div>
        <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:1px;overflow-wrap:anywhere">${sub}</div>
      </div>
      ${action}
    </li>`;
  // A GRANT (shared/plans.ts): the right to set up ONE organization on a plan. Each is its own row —
  // the page's primary action for someone with no organization to open, quiet otherwise.
  const grantRow = (g: MyGrant, i: number): string => {
    const label = `Set up your ${g.plan_name} organization`;
    const o = { arg: String(g.id), field: `orgsCreateOpen:${g.id}`, label, extra: "height:36px" };
    const expires = g.expires_at ? ` &middot; use it by ${esc(new Date(g.expires_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }))}` : "";
    return optRow(`You can set up an organization &mdash; ${esc(g.plan_name)}`,
      `${esc(seatsPhrase(g.entitlements.seats, true))}${g.gift_days ? `, free for ${esc(giftLengthWords(g.gift_days))}` : ""}. You choose its name and become its owner. ${g.granted_by === BILLING_GRANTER ? "Paid for" : `Granted by @${esc(g.granted_by)}`} ${esc(relTime(g.created_at))}${expires}.`,
      orgs.length === 0 && i === 0 ? accentBtn("Set up organization", "orgsCreateOpen", o) : quietBtn("Set up organization", "orgsCreateOpen", { ...o, extra: "height:36px;color:var(--fg)" }),
      ` data-orgs-grant="${g.id}"`);
  };
  // FREE (src/plans/free.ts): an organization of one's own with no grant — one owned at a time.
  const free = p.orgs?.free?.can_create ? (() => {
    const def = PLANS[FREE_PLAN];
    const o = { arg: "free", field: "orgsCreateOpen:free", label: `Create a ${def.name} organization`, extra: "height:36px" };
    return optRow(`Create a ${esc(def.name)} organization`,
      `${esc(seatsPhrase(def.entitlements.seats, true))}, free. You choose its name and become its owner. Upgrade to ${esc(PLANS[UPGRADE_PLAN].name)}, paid per seat, when you need more.`,
      orgs.length === 0 && grants.length === 0 ? accentBtn("Create organization", "orgsCreateOpen", o) : quietBtn("Create organization", "orgsCreateOpen", { ...o, extra: "height:36px;color:var(--fg)" }),
      " data-orgs-free");
  })() : "";
  const options = [
    ...grants.map(grantRow),
    free,
    p.orgs && nothing ? optRow(grants.length ? "Or wait for an invitation" : "Wait for an invitation", `If your team already uses Trov, ask one of its admins to invite ${esc(askFor)}. The invitation appears on this page the next time you open it.`, "") : "",
    p.superadmin ? optRow("Platform", "You are a superadmin: add an organization and name its admin, suspend one, and see usage. No membership needed.",
      `<a href="${PLATFORM_HREF}" class="cnpy-outlinebtn" style="display:inline-flex;align-items:center;height:36px;padding:0 14px;border:1px solid var(--border);border-radius:8px;font-size:12.5px;font-weight:500;color:var(--fg-70);text-decoration:none;white-space:nowrap;box-sizing:border-box">Open Platform</a>`, " data-orgs-platform") : "",
  ].filter(Boolean).join("");
  const own = grants.length + (free ? 1 : 0);
  const createBlock = options ? `${sectionHead(own ? (orgs.length || invites.length ? "Set up your own" : "Get started") : orgs.length || invites.length ? "More" : "Get started", own)}<ul${surface("overflow:hidden;list-style:none;margin:0;padding:0")}>${options}</ul>` : "";
  const platformBlock = "";

  const state = loading ? skeleton("orgs", "Loading your organizations&hellip;", skLine(210, 12.5, 1.5), "padding:22px 0 0")
    : p.status === "error" && !p.orgs ? `<div role="alert" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--fg-55);padding:22px 0 0">Couldn't load your invitations. Check your connection, then ${quietBtn("Try again", "orgsReload")}</div>` : "";

  return `<div class="cnpy-orgs" data-screen-label="Organizations">
    <div class="cnpy-orgs-col">
      <div style="display:flex;align-items:center;gap:10px">${trovMark(24)}<span style="font-size:18px;font-weight:600;letter-spacing:-0.02em">Trov</span></div>
      <h1 style="margin:34px 0 0;font-size:24px;font-weight:600;letter-spacing:-0.02em;line-height:1.25;overflow-wrap:anywhere">${esc(title)}</h1>
      <p style="margin:8px 0 0;font-size:14px;line-height:1.6;color:var(--fg-55);max-width:560px">${esc(lead)}</p>
      ${p.ui.lost ? `<div style="margin-top:20px">${orgBanner("That organization didn't open", esc(lostOrgSentence(p.ui.lost)))}</div>` : ""}
      ${orgsBlock}${invitesBlock}${state}${createBlock}${platformBlock}
      <div style="margin-top:34px;padding-top:16px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--fg-55)">
        <span style="min-width:0;overflow-wrap:anywhere">Signed in as <span style="font-weight:500;color:var(--fg-70)">@${esc(p.me?.handle ?? "")}</span></span>
        <span style="display:flex;gap:8px;flex:none">${quietBtn("Sign out", "signOut")}</span>
      </div>
    </div>
  </div>`;
}
