// Personal Settings: the PLAN of the organization on screen, its LIMITS with my use of them, and
// MY ORGANIZATIONS (docs/architecture/plans.md › Where the plan shows).
//
// A plan belongs to an organization, and its owner pays for every seat — so these tiles say whose
// plan it is, show everyone the same numbers Org settings › General does (GET /api/o/:slug/plan,
// which any member reads), and give the OWNER the same actions right here: every sentence, chip
// and button comes from org-plan.ts (`planParts`), and the buttons are its `orgBilling…` acts.
// Anyone else reads who can change the plan, and a way to Org settings.
//
// Pure markup: nothing here reads the network, and a number that was not read is "—", never 0.

import { LIMIT_KEYS, LIMITS, PLANS, UPGRADE_PLAN, formatLimit, limitNoun, type LimitKey, type OrgPlanView } from "@shared/plans";
import { PRICING, canPurchasePlan, formatPrice } from "@shared/pricing";
import type { MyOrg, MyOrgsResponse, OrgRole } from "@shared/orgs";
import { attr, esc } from "./ui";
import { O_ERR, chip, goLink, quietBtn, type OrgSlice } from "./org-ui";
import { planParts, initialOrgBillingUi, type OrgBillingUi } from "./org-plan";
import { FREE_TAKEN_SENTENCE } from "./org-picker";
import { orgHref } from "./org-context";
import { orgTile } from "./org-logo";
import { skBar, skBox, skLine, skList, skW, skeleton } from "./skeleton";

/** The Settings tiles' eyebrow (render.ts `SECTION_LABEL`). */
const LABEL = "font-size:11px;font-weight:600;font-family:var(--label);text-transform:uppercase;letter-spacing:.1em;color:var(--fg-40)";
const NOTE = "font-size:12.5px;line-height:1.55;color:var(--fg-55)";
const FINE = "font-size:11.5px;line-height:1.5;color:var(--fg-40)";
const ROLE_WORD: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** The public pricing page (web/pricing.html) — a static page, so it opens beside the app. */
export const PRICING_HREF = "/pricing";

export interface SettingsPlanProps {
  /** The organization on screen and my role in it; null before it is known. */
  org: Pick<MyOrg, "slug" | "name" | "role"> | null;
  /** Org settings' own plan slice (`state.org.plan`): the same read, the same answer. */
  plan: OrgSlice<OrgPlanView | null>;
  /** Org settings' billing actions state (`state.org.billing`): the buttons here are the same acts. */
  billing?: OrgBillingUi;
}

const head = (title: string, id: string, aside = ""): string =>
  `<div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:2px 12px;margin-bottom:14px"><h2 id="${id}" style="${LABEL};margin:0">${title}</h2>${aside}</div>`;

/** A read that failed, as a sentence and a way to ask again — never a broken tile. */
const failed = (what: string, act: string): string =>
  `<div role="alert" style="display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;${NOTE}">Couldn't load ${esc(what)}. Check your connection, then ${quietBtn("Try again", act)}</div>`;

/**
 * What the plan COSTS, in the pricing page's own words (shared/pricing.ts) — and only where that is
 * what this organization is charged: one paying by the month for a plan with a monthly price, or by
 * the year for one with a yearly price. A granted or gifted plan, one Trov pinned, and an interval the
 * table has no price for say nothing: a figure nobody is charged would be a guess.
 */
export function planPriceWords(v: OrgPlanView): string {
  const p = PRICING[v.plan];
  const bill = v.billing;
  if (v.source === "billing" && bill?.subscribed && !bill.pinned) {
    if (bill.interval === "year") return p.yearly === null ? "" : `${formatPrice(p.yearly)} ${p.yearlyPer}`;
    return p.price === null || p.price === 0 ? "" : `${formatPrice(p.price)} ${p.per}`;
  }
  // Not self-serve and unpriced (Enterprise): the page's own words for it.
  if (PLANS[v.plan].offered && p.price === null && !p.selfServe && !v.gift_until) return "Custom pricing";
  return "";
}

/** A Free organization's next plan and its price, as one sentence — "" when nothing is on sale. */
export function upgradePriceWords(v: OrgPlanView): string {
  const p = PRICING[UPGRADE_PLAN];
  if (v.plan === UPGRADE_PLAN || v.billing?.subscribed || !canPurchasePlan(UPGRADE_PLAN, p)) return "";
  if (v.plan !== "free") return "";
  return `${PLANS[UPGRADE_PLAN].name} is ${formatPrice(p.price as number)} ${p.per}.`;
}

/** Settings › Plan: whose plan, which plan, what it costs, how it is paid, and what I can do about it. */
export function settingsPlanTile(p: SettingsPlanProps): string {
  const b = p.billing ?? initialOrgBillingUi();
  const compare = `<a href="${PRICING_HREF}" target="_blank" rel="noopener" data-plan-compare class="cnpy-mutelink" style="font-size:12px;font-weight:500;color:var(--fg-55);text-decoration:none">Compare plans &rarr;</a>`;
  const top = head("Plan", "set-plan-t", compare);
  const open = `<section class="cnpy-tile cnpy-surface cnpy-set-plan" aria-labelledby="set-plan-t"`;
  const v = p.plan.data;
  if (!p.org) return `${open} data-set-plan="none">${top}<div style="${NOTE}">Open an organization to see its plan.</div></section>`;
  const whose = `<div data-plan-org style="${NOTE};overflow-wrap:anywhere">${esc(p.org.name)} &middot; you are ${p.org.role === "member" ? "a member" : p.org.role === "owner" ? "an owner" : "an admin"}</div>`;
  if (!v) {
    // The tile's own lines: whose plan, its name, its description, the sentence, the closing line.
    const body = p.plan.status === "error" ? failed("this organization's plan", "orgPlanReload")
      : skeleton("set-plan", "Loading the plan&hellip;", `${skLine(96, 22, 1.25)}<div style="margin-top:4px">${skLine("70%", 12.5, 1.5)}</div><div style="margin-top:10px">${skLine("92%", 12.5, 1.55)}${skLine("64%", 12.5, 1.55)}</div><div style="margin-top:14px">${skBox(128, 32)}</div>`);
    return `${open} data-set-plan="${p.plan.status === "error" ? "error" : "loading"}">${top}${whose}<div style="margin-top:10px">${body}</div></section>`;
  }
  const role = p.org.role;
  const parts = planParts(v, role, b);
  const price = planPriceWords(v);
  const upsell = upgradePriceWords(v);
  // Not an owner: no buttons — who changes it (the Plan block's own sentence), and the way there.
  const where = goLink(role === "owner" ? "Plan and limits in Org settings" : "Org settings", "orgGo", "general");
  return `${open} data-set-plan="${v.plan}" data-set-role="${role}"${parts.state ? ` data-set-billing="${parts.state}"` : ""}>
    ${top}
    ${whose}
    <div style="display:flex;align-items:baseline;gap:6px 10px;flex-wrap:wrap;margin-top:10px">
      <span data-plan-name style="font-size:22px;font-weight:600;letter-spacing:-0.015em;line-height:1.25">${esc(v.name)}</span>
      ${price ? `<span data-plan-price style="font-size:13px;color:var(--fg-55);font-variant-numeric:tabular-nums">${esc(price)}</span>` : ""}
      ${parts.chips ? `<span style="display:inline-flex;gap:6px;flex-wrap:wrap;align-self:center">${parts.chips}</span>` : ""}
    </div>
    <div style="${NOTE};margin-top:2px">${esc(v.description)}</div>
    ${parts.gift}
    ${parts.line ? `<p data-plan-billing style="margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-70)">${esc(parts.line)}${upsell ? ` <span data-plan-upsell>${esc(upsell)}</span>` : ""}</p>` : upsell ? `<p data-plan-upsell style="margin:8px 0 0;font-size:12.5px;line-height:1.55;color:var(--fg-70)">${esc(upsell)}</p>` : ""}
    ${parts.actions ? `<div class="cnpy-plan-actions" data-plan-actions>${parts.actions}</div>` : ""}
    ${parts.actions && b.error ? `<div role="alert" style="${O_ERR}">${esc(b.error)}</div>` : ""}
    <div class="cnpy-set-planfoot">
      <span data-plan-foot style="${FINE}">${esc(parts.foot)}</span>
      ${where}
    </div>
  </section>`;
}

// ── limits ───────────────────────────────────────────────────────────────────

/** A limit's use as the row says it: "2 of 3", "1.2 GB of 5 GB", "12 used · Unlimited" — and "—" for a
 *  use that was not read (never 0: an unread count is unknown, not nothing). */
function useWords(key: LimitKey, used: number | null, cap: number | null): string {
  const u = used === null ? "&mdash;" : esc(formatLimit(key, used));
  if (cap === null) return used === null ? esc(formatLimit(key, null)) : `${u} used &middot; ${esc(formatLimit(key, null))}`;
  return `${u} of ${esc(formatLimit(key, cap))}`;
}

function meterRow(v: OrgPlanView, key: LimitKey): string {
  const d = LIMITS[key];
  const cap = v.entitlements[key];
  const raw: unknown = (v.usage as Partial<Record<LimitKey, unknown>> | undefined)?.[key];
  const used = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  const over = v.over.includes(key);
  const spent = !!d.period && cap !== null && used !== null && used >= cap;
  // What the number counts, in two words: mine (the one per-person limit), or the period.
  const scope = d.per === "person" ? "yours" : d.period === "month" ? "this month" : "";
  const pct = cap === null || used === null ? null : cap <= 0 ? (used > 0 ? 100 : 0) : Math.max(0, Math.min(100, Math.round((used / cap) * 100)));
  const tone = over ? "over" : pct !== null && pct >= 100 ? "full" : "ok";
  // The meter is the row's picture; its words are beside it, so it is described once, there.
  const meter = pct === null
    ? `<div class="cnpy-meter" data-meter="none" aria-hidden="true"></div>`
    : `<div class="cnpy-meter" data-meter="${tone}" role="meter" aria-label="${attr(`${d.label}${scope ? `, ${scope}` : ""}`)}" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${used}" aria-valuetext="${attr(`${formatLimit(key, used)} of ${formatLimit(key, cap)}`)}"><span style="width:${pct}%"></span></div>`;
  const note = over ? `<div data-limit-over style="font-size:11.5px;font-weight:500;color:var(--amber);margin-top:4px">Over the limit</div>`
    : spent && d.atCap ? `<div data-limit-spent style="${FINE};margin-top:4px">${esc(d.atCap)}</div>` : "";
  return `<li class="cnpy-set-limit" data-limit="${key}"${over ? ' data-over="1"' : ""}${used === null ? ' data-unknown="1"' : ""} title="${attr(d.counts)}">
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px">
      <span style="min-width:0;font-size:13px;font-weight:500;color:var(--fg)">${esc(d.label)}${scope ? ` <span style="font-weight:400;color:var(--fg-40)">${scope}</span>` : ""}</span>
      <span data-limit-use style="flex:none;font-size:12.5px;font-variant-numeric:tabular-nums;color:var(--fg-70)">${useWords(key, used, cap)}</span>
    </div>
    ${meter}${note}
  </li>`;
}

/** Settings › Limits: every limit of the plan with the use of it — the org's, and (agent connections) mine. */
export function settingsLimitsTile(p: SettingsPlanProps): string {
  const top = head("Limits", "set-limits-t", p.org ? `<span style="${FINE};overflow-wrap:anywhere">${esc(p.org.name)}</span>` : "");
  const open = `<section class="cnpy-tile cnpy-surface cnpy-set-limits" aria-labelledby="set-limits-t"`;
  const v = p.plan.data;
  if (!p.org) return `${open}>${top}<div style="${NOTE}">Open an organization to see its limits.</div></section>`;
  if (!v) {
    // One limit's row: its name and its use on a line, the meter under it — six of them.
    const row = (i: number) => `<div class="cnpy-set-limit"><div style="display:flex;justify-content:space-between;gap:10px">${skLine(skW(i, [84, 112, 96, 124, 132, 92]), 13, 1.5)}${skLine(56, 12.5, 1.5)}</div>${skBar("100%", 4, "margin-top:7px")}</div>`;
    const body = p.plan.status === "error" ? failed("this organization's limits", "orgPlanReload")
      : skeleton("set-limits", "Loading the limits&hellip;", `<div class="cnpy-set-limits-rows">${skList(LIMIT_KEYS.length, row)}</div>`);
    return `${open}>${top}${body}</section>`;
  }
  const overNames = v.over.map(limitNoun);
  // The Plan block's two notes, shortened to this tile's width: nothing is removed, additions wait.
  const note = v.status === "canceled"
    ? `<div role="status" data-limits-note="ended" class="cnpy-plan-note" style="border-radius:9px;margin:0 0 12px">This plan has ended. Everything stays and keeps working, but nothing a limit covers can be added until it is renewed or upgraded.</div>`
    : overNames.length
      ? `<div role="status" data-limits-note="over" class="cnpy-plan-note" style="border-radius:9px;margin:0 0 12px">Over the plan's ${esc(overNames.join(" and "))}. Nothing was removed; more can be added once it is back under.</div>`
      : "";
  return `${open}>
    ${top}
    ${note}
    <ul class="cnpy-set-limits-rows">${LIMIT_KEYS.map((k) => meterRow(v, k)).join("")}</ul>
  </section>`;
}

// ── my organizations ─────────────────────────────────────────────────────────

export interface SettingsOrgsProps {
  /** `GET /api/orgs` (state.myOrgs): my organizations with each one's plan, and what I may create. */
  orgs: MyOrgsResponse | null;
  /** The session's own list (`me.orgs`), shown until — or if — the read above lands. */
  mine: readonly MyOrg[];
  status: OrgSlice<unknown>["status"];
  /** The organization on screen. */
  current: string | null;
}

/** Who pays, in words — only what the row's data says: `paid` is a live subscription, and an
 *  organization's owners are the ones who manage it. Nothing is said of a Free, granted or gifted org. */
export function paysWords(o: MyOrg): string {
  if (o.paid !== true) return "";
  return o.role === "owner" ? "you manage its billing" : "paid for by its owners";
}

function orgRow(o: MyOrg, here: boolean): string {
  const plan = o.plan ? PLANS[o.plan] : null;
  const pays = paysWords(o);
  return `<li><a href="${attr(orgHref(o.slug))}" class="cnpy-set-org" data-org="${attr(o.slug)}"${here ? ' aria-current="true"' : ""} style="border-radius:9px">
    ${orgTile(o.name, 30, o.logo_url ?? null, 8)}
    <span style="flex:1;min-width:0">
      <span style="display:block;font-size:13.5px;font-weight:500;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(o.name)}</span>
      <span data-org-role style="display:block;${FINE};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ROLE_WORD[o.role]}${here ? " &middot; open now" : ""}${pays ? ` &middot; ${pays}` : ""}</span>
    </span>
    ${plan ? `<span data-org-plan="${plan.id}" style="flex:none;display:inline-flex">${chip(plan.name, o.paid ? "var(--accent)" : "var(--fg-55)")}</span>` : ""}
  </a></li>`;
}

/**
 * Settings › Organizations: every organization I belong to — my role, its plan, and a link that
 * opens it — then the one thing I may do about having more: create one (a grant's, or a Free one of
 * my own), or the sentence that says why not.
 */
export function settingsOrgsTile(p: SettingsOrgsProps): string {
  const list = p.orgs?.orgs ?? p.mine;
  const top = head("Organizations", "set-orgs-t", list.length > 1 ? `<span style="${FINE}">${list.length}</span>` : "");
  const loading = !p.orgs && p.status !== "error" && p.status !== "ok";
  const rows = list.length
    ? `<ul class="cnpy-set-orgs">${list.map((o) => orgRow(o, o.slug === p.current)).join("")}</ul>`
    : loading
      ? skeleton("set-orgs", "Loading your organizations&hellip;", skList(2, (i) => `<div style="display:flex;align-items:center;gap:10px;padding:7px 8px">${skBox(30, 30)}<span class="cnpy-skcol">${skLine(skW(i, ["52%", "40%"]), 13.5, 1.4)}${skLine(skW(i, ["30%", "36%"]), 11.5, 1.5)}</span>${skBox(40, 18)}</div>`))
      : `<div style="${NOTE}">You are not in an organization yet.</div>`;
  const invites = p.orgs?.invites.length ?? 0;
  const invited = invites ? `<div data-orgs-invites style="${NOTE};color:var(--fg-70)">${invites === 1 ? "1 invitation is" : `${invites} invitations are`} waiting. <button type="button" data-act="orgsMenu" class="cnpy-mutelink" style="padding:0;font-size:12.5px;font-weight:500;color:var(--accent)">Answer ${invites === 1 ? "it" : "them"}</button></div>` : "";
  let foot: string;
  if (!p.orgs) {
    foot = p.status === "error" ? failed("what you can create", "orgsReload") : "";
  } else if (p.orgs.can_create) {
    const grant = p.orgs.grants[0] ?? null;
    foot = `<div data-orgs-create style="display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap">
      ${quietBtn("Create organization", "orgsCreateOpen", { field: "setOrgsCreate", extra: "color:var(--fg)" })}
      <span style="flex:1 1 150px;min-width:0;${FINE}">${grant ? `You can set up an organization on ${esc(grant.plan_name)}.` : `A ${esc(PLANS.free.name)} organization of your own: one owned at a time.`}</span>
    </div>`;
  } else if (p.orgs.free?.owned) {
    foot = `<div data-orgs-nocreate style="${FINE}">${esc(FREE_TAKEN_SENTENCE)}</div>`;
  } else if (p.orgs.superadmin) {
    foot = `<div data-orgs-nocreate style="${FINE}">As a superadmin you add organizations in <a href="/platform/" class="cnpy-mutelink" style="color:var(--fg-70);text-decoration:underline;text-underline-offset:2px">Platform</a>.</div>`;
  } else {
    foot = "";
  }
  return `<section class="cnpy-tile cnpy-surface cnpy-set-orgs-tile" aria-labelledby="set-orgs-t">
    ${top}
    ${rows}
    ${invited || foot ? `<div class="cnpy-set-orgsfoot">${invited}${foot}</div>` : ""}
  </section>`;
}
