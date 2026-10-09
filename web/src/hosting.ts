// Org settings › Hosting (docs/architecture/hosting-providers.md) — which host runs each part of each
// environment, and how the organization is connected to those hosts. Admins only (its API is).
//
// ONE read, `GET /api/o/:slug/hosting` (`HostingSetupDTO`), drawn in the page's one idiom (org-ui.ts): a lead
// with the tab's one accent action, eyebrow sections, rows that open, destructive actions as quiet text.
//   • the return notice (`?hosting=<outcome>`), the lost banner, the "secrets can't be saved" banner;
//   • the setup checklist the server generates from what the parts USE (gone once every step is done);
//   • "Detected: <provider>" — a host the captured GitHub activity already shows (src/hosting/detect.ts);
//   • ENVIRONMENTS: a tile per environment (the General tab's bento tiles), its parts as rows;
//   • PROVIDERS: the catalogue with each provider's connection — Vercel, Render, Netlify, Fly.io; then
//     Cloudflare and Railway (legacy: their part lives in the environment's own fields); then AWS (later).
// …and three dialogs, each a root-level `data-overlay` (so a keystroke patches it — morph.ts): the part
// editor, the "you are about to leave for <provider>" confirmation of an install / OAuth connection, and the
// paste-a-token form.
//
// THE RULE OF integrations.ts HOLDS HERE: a credential's value is never in the markup. The token input has NO
// `value` attribute in any state; hosting-actions.ts keeps the draft in a private variable. After a save the
// screen can show `hint_last4` and nothing else.
//
// Pure: props in, markup out. Every act starts with `orgHx` and is dispatched (main.ts → org-actions.ts) to
// web/src/hosting-actions.ts.

import { esc, attr, relTime, surface } from "./ui";
import {
  O_LABEL, O_FIELD, O_HELP, O_ERR, accentBtn, quietBtn, dangerLink, goLink, orgHead, orgBanner, failedNote,
  tabLead, leadFlag, openRow, chip, textField, type OrgSlice,
} from "./org-ui";
import { segmented } from "./segmented";
import { dropdown, initialDropdownUi, type DropdownProps, type DropdownUi } from "./dropdown";
import { howToHtml, type TestState } from "./integrations";
import { emptyLayout, skBox, skCard, skLine, skRowsShape, skeleton } from "./skeleton";
import type { MyOrg } from "@shared/orgs";
import type { OrgUi } from "./org-settings";
import {
  HOSTING_METRICS, MAX_PARTS_PER_ENVIRONMENT, PART_KEY_RE, hostingRevokedReasonText, metricsForRole,
  type ConnectionMethodDTO, type ConnectionStatus, type EnvironmentPartDTO, type HostingChecklistItem, type HostingConnectOutcome,
  type HostingConnectionDTO, type HostingDetectionDTO, type HostingEnvironmentDTO, type HostingFieldDTO, type HostingMetric,
  type HostingProviderDTO, type HostingProviderId, type HostingSetupDTO, type PartRole,
} from "@shared/hosting";

// ── state ────────────────────────────────────────────────────────────────────

/** The sample states "Preview with sample data" can show (web/src/hosting-sample.ts `HOSTING_SAMPLES`). */
export const HOSTING_SAMPLE_KEYS = ["mixed", "no_parts", "fresh", "revoked", "secrets_locked"] as const;
export type HostingSampleKey = (typeof HOSTING_SAMPLE_KEYS)[number];
export const isHostingSampleKey = (v: unknown): v is HostingSampleKey => typeof v === "string" && (HOSTING_SAMPLE_KEYS as readonly string[]).includes(v);
const SAMPLE_LABEL: Record<HostingSampleKey, string> = { mixed: "Mid-setup", no_parts: "No parts", fresh: "New org", revoked: "Removed", secrets_locked: "Locked" };

/** What came back from a provider (`?hosting=<outcome>&provider=<id>` on the page the callback redirects to). */
export interface HostingNotice { outcome: HostingConnectOutcome; provider: HostingProviderId | null }

/** The part editor's draft. `key` null = adding (its key is `keyDraft`). */
export interface PartDraft {
  env: string;
  key: string | null;
  keyDraft: string;
  label: string;
  provider: HostingProviderId | null;
  role: PartRole;
  settings: Record<string, string>;
  saving: boolean;
  error: string | null;
  /** `provider`, `part` (the key), `label`, `role`, `settings.<key>`, or null for the whole form. */
  errorField: string | null;
}

/** The "about to leave for <provider>" confirmation of an install / OAuth connection. */
export interface ConnectDraft { provider: HostingProviderId; busy: boolean; error: string | null }

/** The paste-a-token form. It never holds the token's value (only `hasValue`). */
export interface TokenForm {
  provider: HostingProviderId;
  scope: string;
  /** set = a first credential (with its settings); rotate = replace it; config = the non-secret settings alone. */
  mode: "set" | "rotate" | "config";
  config: Record<string, string>;
  hasValue: boolean;
  saving: boolean;
  error: string | null;
  /** `secret`, `config.<key>`, or null. */
  errorField: string | null;
}

/** Everything the Hosting tab keeps in `state.org.hosting`. */
export interface HostingUi {
  setup: OrgSlice<HostingSetupDTO | null>;
  /** "Preview with sample data": which state is shown, and its payload. null = the org's own data. */
  sample: HostingSampleKey | null;
  sampleData: HostingSetupDTO | null;
  notice: HostingNotice | null;
  part: PartDraft | null;
  connect: ConnectDraft | null;
  token: TokenForm | null;
  /** Test connection, by `<provider>:<scope>`; one part's test by `part:<env>/<part>`. */
  tests: Record<string, TestState>;
  /** The checklist's finished steps are shown. */
  doneOpen: boolean;
  /** "Detected" suggestions this browser dismissed. */
  dismissed: HostingProviderId[];
}

export function initialHostingUi(): HostingUi {
  return {
    setup: { status: "idle", data: null }, sample: null, sampleData: null, notice: null, part: null, connect: null, token: null,
    tests: {}, doneOpen: false, dismissed: [],
  };
}

/** The payload on screen: the sample's while previewing, else the org's own. */
export const hostingData = (h: HostingUi): HostingSetupDTO | null => (h.sample ? h.sampleData : h.setup.data);

export const connKey = (c: { provider: string; scope: string }): string => `${c.provider}:${c.scope}`;
export const partRef = (p: { env: string; key: string }): string => `${p.env}/${p.key}`;
export const providerOf = (d: HostingSetupDTO, id: HostingProviderId | null): HostingProviderDTO | null => d.providers.find((p) => p.id === id) ?? null;
export const connectionOf = (d: HostingSetupDTO, provider: HostingProviderId, scope: string): HostingConnectionDTO | null =>
  d.connections.find((c) => c.provider === provider && c.scope === scope) ?? null;
/** The credential scope a part's provider is connected at: "" org-wide, or the part's environment (Railway). */
export const scopeFor = (p: HostingProviderDTO, env: string): string => (p.credential_scope === "environment" ? env : "");

// ── vocabulary ───────────────────────────────────────────────────────────────

const GLYPH: Record<HostingProviderId, string> = { cloudflare: "CF", railway: "RW", vercel: "V", render: "R", netlify: "N", fly: "F", aws: "AW" };
/** A provider's mark: a monochrome letterform in a small square — never a logo, never a brand colour. */
export function providerGlyph(id: HostingProviderId, size = 20): string {
  return `<span aria-hidden="true" data-hx-glyph="${attr(id)}" style="flex:none;display:inline-grid;place-items:center;width:${size}px;height:${size}px;border-radius:5px;border:1px solid var(--border-strong);background:var(--hover);font-family:var(--label);font-size:${Math.round(size * 0.46)}px;font-weight:700;letter-spacing:.01em;line-height:1;color:var(--fg-70)">${GLYPH[id]}</span>`;
}

const ROLE_WORD: Record<PartRole, string> = { web: "Web", service: "Service" };
const ROLE_HINT: Record<PartRole, string> = {
  web: "Serves HTTP to people: requests, server errors, latency and bandwidth.",
  service: "A long-running process: CPU and memory.",
};
const METRIC_CHIP: Record<HostingMetric, string> = {
  requests: "Requests", errors: "Errors", latency_p50_ms: "Latency p50", latency_p95_ms: "Latency", bandwidth_bytes: "Bandwidth", cpu: "CPU", mem_mb: "Memory",
};

const STATUS_WORD: Record<ConnectionStatus, string> = { connected: "Connected", error: "Error", not_connected: "Not connected", revoked: "Removed" };
const STATUS_TONE: Record<ConnectionStatus, string> = { connected: "var(--green)", error: "var(--red)", not_connected: "var(--fg-40)", revoked: "var(--amber)" };

/** Was this connection ended on the PROVIDER's side (uninstalled there, or the grant refused) — not by an admin here? */
export function lostOnProvider(c: HostingConnectionDTO, label: string): boolean {
  return c.status === "revoked" && (c.revoked_reason === hostingRevokedReasonText("uninstalled", label) || c.revoked_reason === hostingRevokedReasonText("refused", label));
}
/** A connection's status as the row says it: an admin's own Disconnect reads "Not connected", never "Removed". */
export function connectionStatus(c: HostingConnectionDTO, label: string): { word: string; tone: string; state: ConnectionStatus } {
  const state: ConnectionStatus = c.status === "revoked" && !lostOnProvider(c, label) ? "not_connected"
    : c.status === "not_connected" && c.legacy_fallback ? "connected" : c.status;
  return { word: STATUS_WORD[state], tone: STATUS_TONE[state], state };
}

/** A status as a dot and a word. The dot is an element (the corners layer shapes it), the word carries the meaning. */
export function statusDot(state: ConnectionStatus, word = STATUS_WORD[state]): string {
  return `<span data-hx-status="${state}" style="display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:500;color:var(--fg-55);white-space:nowrap"><span aria-hidden="true" style="flex:none;width:7px;height:7px;border-radius:50%;background:${STATUS_TONE[state]}"></span>${esc(word)}</span>`;
}

/** The first method this Trov can offer for a provider (the catalogue lists them best first), or null. */
export const bestMethod = (p: HostingProviderDTO): ConnectionMethodDTO | null => p.connection_methods.find((m) => m.available) ?? null;
export const tokenMethod = (p: HostingProviderDTO): ConnectionMethodDTO | null => p.connection_methods.find((m) => m.method === "token" && m.available) ?? null;
const isRedirect = (m: ConnectionMethodDTO | null): boolean => m?.method === "install" || m?.method === "oauth";
/** What the pasted value is called: "API key", "access token", "read-only token" — the method's own label, minus "Paste a". */
export function tokenWord(p: HostingProviderDTO): string {
  const label = p.connection_methods.find((m) => m.method === "token")?.label ?? "";
  return label.replace(/^Paste an? /i, "") || "token";
}
const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);

/** "Sent only to api.vercel.com" — the ONLY hosts the credential is ever sent to. */
export const sentOnlyTo = (p: HostingProviderDTO): string =>
  `Sent only to ${p.api_hosts.length > 1 ? `${p.api_hosts.slice(0, -1).join(", ")} and ${p.api_hosts[p.api_hosts.length - 1]}` : p.api_hosts[0] ?? "the provider"}.`;

/** What a provider can show, as small quiet chips. A metric it cannot read is simply absent. */
export function capabilityChips(p: HostingProviderDTO): string {
  const shown = (m: HostingMetric): boolean => m !== "latency_p50_ms";
  const words = [...(p.capabilities.deploys ? ["Deploys"] : []), ...p.capabilities.metrics.filter(shown).map((m) => METRIC_CHIP[m])];
  if (!words.length) return "";
  return `<ul data-hx-caps aria-label="What ${attr(p.label)} can show" style="display:flex;gap:5px;flex-wrap:wrap;list-style:none;margin:0;padding:0">${words.map((w) => `<li style="font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.03em;color:var(--fg-55);border:1px solid var(--border);border-radius:5px;padding:1px 6px">${esc(w)}</li>`).join("")}</ul>`;
}

const EXT = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M14 4h6v6"></path><path d="M20 4 10 14"></path><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"></path></svg>`;
const LINK_BTN = "display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border-radius:8px;font-size:12.5px;white-space:nowrap;text-decoration:none;box-sizing:border-box";
/** A captured URL must be https — never `javascript:` / `data:`. */
const safeUrl = (u: string | null): string | null => (u && /^https:\/\//i.test(u) ? u : null);
/** A quiet link out to the provider's own page, in a new tab. */
function outLink(text: string, href: string | null, label?: string): string {
  const url = safeUrl(href);
  return url ? `<a href="${attr(url)}" target="_blank" rel="noopener noreferrer"${label ? ` aria-label="${attr(label)}"` : ""} class="cnpy-ghostbtn" style="${LINK_BTN};font-weight:500;border:1px solid var(--border);color:var(--fg-70)">${esc(text)}${EXT}</a>` : "";
}

const OK_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M20 6 9 17l-5-5"></path></svg>`;
const FAIL_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const box = (tone: string) => `border:1px solid color-mix(in srgb,${tone} 40%,transparent);background:color-mix(in srgb,${tone} 7%,transparent);border-radius:8px;padding:9px 11px;display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.5;color:var(--fg-70)`;
const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";
const B = (s: string): string => `<strong style="font-weight:600;color:var(--fg)">${esc(s)}</strong>`;

/** A test's answer, always visible under its row. */
function testAnswer(t: TestState | undefined): string {
  if (!t || t.status !== "done") return "";
  return `<div role="status" aria-live="polite" data-org-test="${t.ok ? "ok" : "failed"}" style="${box(t.ok ? "var(--green)" : "var(--red)")};margin-top:10px">${t.ok ? OK_ICON : FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">${t.ok ? "Connection works." : "Test failed."}</strong> ${esc(t.detail)}</div></div>`;
}

const WHY_LOCKED = "Credentials can't be saved right now: the platform key is missing";

// ── the return from a provider ───────────────────────────────────────────────

export interface NoticeCopy { tone: "ok" | "amber" | "red"; title: string; body: string }

/** Each outcome of `/hosting/<provider>/callback` as words: what happened, and what to do next. Nothing the
 *  provider said is in it — the callback carries a code from ONE vocabulary and nothing else. Pure. */
export function hostingNoticeCopy(n: HostingNotice, provider: HostingProviderDTO | null, orgName: string): NoticeCopy {
  const name = provider?.label ?? "the host";
  const org = esc(orgName);
  const reads = provider ? (provider.capabilities.metrics.length ? "deploys and usage" : "deploys") : "deploys";
  const paste = provider && tokenMethod(provider) ? ` Or connect with ${esc(/^[aeiou]/i.test(tokenWord(provider)) ? "an" : "a")} ${esc(tokenWord(provider))} instead.` : "";
  switch (n.outcome) {
    case "connected": return { tone: "ok", title: `${name} is connected.`, body: `Trov now reads the ${reads} of every part of ${org} hosted on ${esc(name)}: no token to paste. The next hourly poll fills them in, or press Poll now on the Repo dashboard.` };
    case "expired": return { tone: "amber", title: "That took too long, or was not started here.", body: `Trov could not match the return from ${esc(name)} to a request from this browser, so nothing was connected. Start again from this page.` };
    case "wrong_person": return { tone: "red", title: "Nothing was connected.", body: `The person signed in to Trov when ${esc(name)} returned is not the one who started. Start again from this page.` };
    case "not_admin": return { tone: "red", title: "Nothing was connected.", body: `Only an admin or an owner of ${org} can connect a host.` };
    case "denied": return { tone: "amber", title: `You cancelled on ${name}.`, body: "Nothing was connected, and nothing changed here." };
    case "taken": return { tone: "red", title: "Nothing was connected.", body: `That ${esc(name)} installation is already connected to another Trov organization. It can belong to one at a time: disconnect it there first.` };
    case "not_configured": return { tone: "amber", title: `This Trov can't connect ${name} that way yet.`, body: `Whoever runs this Trov has not set up its ${esc(name)} integration.${paste}` };
    case "exchange_failed": return { tone: "red", title: `${name} refused the connection.`, body: `Nothing was connected. Try again.${paste}` };
    case "secrets_unavailable": return { tone: "red", title: "Nothing was connected.", body: "Credentials can't be saved right now: the platform's encryption key is missing. Ask whoever runs this Trov, then try again." };
    case "unknown_provider": return { tone: "red", title: "Nothing was connected.", body: "The return named a host Trov does not connect that way. Start again from this page." };
    case "failed": return { tone: "red", title: "Something went wrong.", body: "Nothing was connected. Try again in a minute." };
  }
}

const NOTICE_ICON: Record<NoticeCopy["tone"], string> = {
  ok: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path></svg>`,
  amber: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`,
  red: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M12 8v5"></path><path d="M12 16.5h.01"></path><circle cx="12" cy="12" r="9"></circle></svg>`,
};
const TONE_VAR: Record<NoticeCopy["tone"], string> = { ok: "var(--green)", amber: "var(--amber)", red: "var(--red)" };

/** The notice across the Hosting tab, dismissible — the GitHub App's (`connectNotice`), for a hosting provider. */
export function hostingNotice(n: HostingNotice | null, d: HostingSetupDTO | null, orgName: string): string {
  if (!n) return "";
  const c = hostingNoticeCopy(n, d ? providerOf(d, n.provider) : null, orgName);
  const tone = TONE_VAR[c.tone];
  return `<div role="${c.tone === "red" ? "alert" : "status"}" data-org-hosting-notice="${attr(n.outcome)}" style="border:1px solid color-mix(in srgb,${tone} 45%,transparent);background:color-mix(in srgb,${tone} 9%,transparent);border-radius:10px;padding:12px 14px;display:flex;gap:10px;align-items:flex-start;margin:0 0 20px">
    ${NOTICE_ICON[c.tone]}
    <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">${esc(c.title)}</div><div style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:2px">${c.body}</div></div>
    <button type="button" data-act="orgHxNoticeClose" data-field="orgHxNoticeClose" aria-label="Dismiss" title="Dismiss" class="cnpy-iconbtn" style="flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
  </div>`;
}

/** "Staging › Web app" for each part a connection serves. */
function userNames(d: HostingSetupDTO, c: HostingConnectionDTO): string[] {
  return c.used_by.map((u) => {
    const env = d.environments.find((e) => e.key === u.env);
    const part = env?.parts.find((p) => p.key === u.part);
    return `${env?.label ?? u.env} › ${part?.label ?? u.part}`;
  });
}
const listed = (names: string[]): string => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** A connection the PROVIDER ended, and nothing replaced: said until it is reconnected. Never after an admin's own Disconnect. */
export function hostingLostBanners(d: HostingSetupDTO): string {
  return d.connections.map((c) => {
    const p = providerOf(d, c.provider);
    if (!p || !lostOnProvider(c, p.label)) return "";
    const users = userNames(d, c);
    const uninstalled = c.revoked_reason === hostingRevokedReasonText("uninstalled", p.label);
    const why = uninstalled ? `The ${esc(p.label)} connection${c.account?.label ? ` to ${B(c.account.label)}` : ""} was removed on ${esc(p.label)}.`
      : `${esc(p.label)} refused Trov's access${c.account?.label ? ` to ${B(c.account.label)}` : ""}: the grant was revoked or removed there.`;
    const stops = users.length ? ` ${p.capabilities.metrics.length ? "Deploys and usage" : "Deploys"} for ${esc(listed(users))} have stopped updating.` : " No part uses it.";
    return `<div style="margin-bottom:20px" data-org-hosting-lost="${attr(c.provider)}">${orgBanner(`${p.label} is no longer connected`, `${why}${stops} Connect again to resume.`)}</div>`;
  }).join("");
}

// ── the setup checklist ──────────────────────────────────────────────────────

const STEP_DONE = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path></svg>`;
const STEP_TODO = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle></svg>`;

type Btn = typeof quietBtn;
/** A checklist step's button: where the step is done. `where` keeps two renders of it (the lead's, the list's) apart. */
function stepButton(item: HostingChecklistItem, d: HostingSetupDTO, btn: Btn, where: string): string {
  const a = item.action;
  const field = `orgHxStep:${where}:${item.id}`;
  const locked = !d.secrets_available;
  switch (a.kind) {
    case "none": return "";
    case "add_environment": return btn("Add an environment", "orgTab", { arg: "environments", field });
    case "add_part": return btn("Add a part", "orgHxPartNew", { arg: a.env, field, label: item.title });
    case "edit_part": return btn("Edit the part", "orgHxPartEdit", { arg: `${a.env}/${a.part}`, field, label: item.title });
    case "connect": {
      const p = providerOf(d, a.provider);
      return btn(`Connect ${p?.label ?? a.provider}`, "orgHxConnect", { arg: `${a.provider}:${a.scope}`, field, disabled: locked, title: locked ? WHY_LOCKED : undefined, label: item.title });
    }
    case "configure": return btn("Set it", "orgHxToken", { arg: `config:${a.provider}:${a.scope}`, field, label: item.title });
    case "test": return btn("Test connection", "orgHxTest", { arg: `${a.provider}:${a.scope}`, field, label: item.title });
  }
}

/** The tab's own checklist — generated by the server from what the parts USE — until every step is done.
 *  Steps still to do are listed; the finished ones fold behind one toggle. */
export function hostingChecklist(d: HostingSetupDTO, h: HostingUi): string {
  const items = d.checklist;
  const todo = items.filter((i) => !i.done);
  if (!items.length || !todo.length) return "";
  const done = items.length - todo.length;
  const row = (i: HostingChecklistItem): string => `<li class="cnpy-hx-step" data-hx-step="${attr(i.id)}" data-done="${i.done ? "1" : "0"}">
      ${i.done ? STEP_DONE : STEP_TODO}
      <div style="flex:1 1 240px;min-width:0"><div style="font-size:13px;font-weight:${i.done ? 500 : 600};color:${i.done ? "var(--fg-55)" : "var(--fg)"};overflow-wrap:anywhere">${esc(i.title)}${i.done ? `<span class="cnpy-sr">: done</span>` : ""}</div>${i.detail ? `<div style="font-size:12px;line-height:1.5;color:var(--fg-40);margin-top:1px;overflow-wrap:anywhere">${esc(i.detail)}</div>` : ""}</div>
      ${i.done ? "" : `<div class="cnpy-org-actions is-inline" style="align-items:center">${stepButton(i, d, quietBtn, "list")}</div>`}
    </li>`;
  const shown = h.doneOpen ? items : todo;
  return `<section${surface("padding:0;margin-bottom:24px;overflow:hidden")} data-org-hosting-setup aria-labelledby="org-hx-setup-t">
    <div style="display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border)">
      <h2 id="org-hx-setup-t" style="margin:0;font-size:13.5px;font-weight:600;letter-spacing:-0.005em">Set up hosting</h2>
      <span style="font-size:12px;color:var(--fg-55)" data-hx-progress>${done} of ${items.length} done</span>
      ${done ? `<button type="button" data-act="orgHxDoneToggle" data-field="orgHxDoneToggle" aria-expanded="${h.doneOpen}" class="cnpy-mutelink" style="margin-left:auto;padding:0;font-size:12px;font-weight:500;color:var(--fg-55)">${h.doneOpen ? "Hide what is done" : `Show the ${done} done`}</button>` : ""}
    </div>
    <ol style="list-style:none;margin:0;padding:0">${shown.map(row).join("")}</ol>
  </section>`;
}

// ── "Detected: <provider>" ───────────────────────────────────────────────────

/** The suggestions worth showing: seen on GitHub, not used by any part yet, choosable, not dismissed here. */
export function shownDetections(d: HostingSetupDTO, h: Pick<HostingUi, "dismissed">): HostingDetectionDTO[] {
  return (d.detected ?? []).filter((x) => !x.in_use && !h.dismissed.includes(x.provider) && providerOf(d, x.provider)?.status === "available");
}

/** "Detected: Vercel" — a host the captured GitHub activity already shows. It preselects the provider in the
 *  part editor; it connects nothing (the credential is still the admin's to give). */
export function hostingDetected(d: HostingSetupDTO, h: HostingUi): string {
  const list = shownDetections(d, h);
  if (!list.length) return "";
  // The environment the part editor opens on: the first with no part yet, else the first.
  const env = d.environments.find((e) => e.parts.length === 0) ?? d.environments[0] ?? null;
  return list.map((x) => {
    const p = providerOf(d, x.provider)!;
    const full = !!env && env.parts.length >= MAX_PARTS_PER_ENVIRONMENT;
    return `<div${surface("display:flex;align-items:center;gap:10px 12px;flex-wrap:wrap;padding:10px 14px;margin-bottom:12px")} role="status" data-org-hosting-detected="${attr(x.provider)}">
      ${providerGlyph(x.provider, 22)}
      <div style="flex:1 1 280px;min-width:0;font-size:12.5px;line-height:1.5;color:var(--fg-55)"><strong style="font-weight:600;color:var(--fg)">Detected: ${esc(p.label)}</strong> &middot; Trov saw ${esc(x.evidence)} on your repository, last ${esc(relTime(x.last_seen))}. Nothing is connected yet.</div>
      ${env ? quietBtn(`Add a ${p.label} part`, "orgHxPartNew", { arg: `${env.key}|${x.provider}`, field: `orgHxDetected:${x.provider}`, disabled: full, title: full ? `${env.label} already has ${MAX_PARTS_PER_ENVIRONMENT} parts` : undefined, label: `Add a ${p.label} part to ${env.label}` }) : goLink("Add an environment first", "orgTab", "environments")}
      <button type="button" data-act="orgHxDetectDismiss" data-arg="${attr(x.provider)}" data-field="${attr(`orgHxDetectDismiss:${x.provider}`)}" aria-label="Dismiss the ${attr(p.label)} suggestion" title="Dismiss" class="cnpy-iconbtn" style="flex:none;width:26px;height:26px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg></button>
    </div>`;
  }).join("");
}

// ── environments and their parts ─────────────────────────────────────────────

/** A part's identifying setting: the value of its provider's FIRST `part_settings` field (the project / service / site / app). */
export function partIdentity(part: EnvironmentPartDTO, p: HostingProviderDTO | null): string {
  const first = p?.part_settings[0];
  return first ? part.settings[first.key] ?? "" : "";
}

/** The metrics a provider could not read for a part, as calm sentences — never an error, never a zero. When
 *  every figure of the part's role is unavailable it is ONE line ("Usage isn't available from Vercel: …"). */
export function unavailableLines(unavailable: readonly { metric: HostingMetric; reason: string }[], role: PartRole, providerLabel: string): string[] {
  if (!unavailable.length) return [];
  const headline = metricsForRole(role).filter((m) => m !== "latency_p50_ms");
  const all = headline.every((m) => unavailable.some((u) => u.metric === m));
  if (all) return [`Usage isn't available from ${providerLabel}: ${unavailable[0].reason}.`.replace(/\.\.$/, ".")];
  const byReason = new Map<string, HostingMetric[]>();
  for (const u of unavailable) byReason.set(u.reason, [...(byReason.get(u.reason) ?? []), u.metric]);
  return [...byReason.entries()].map(([reason, metrics]) => `${listed(metrics.map((m) => HOSTING_METRICS[m].label))} ${metrics.length === 1 ? "isn't" : "aren't"} available from ${providerLabel}: ${reason}.`.replace(/\.\.$/, "."));
}

interface TabCtx { d: HostingSetupDTO; ui: OrgUi; h: HostingUi }

function partRow(x: TabCtx, env: HostingEnvironmentDTO, part: EnvironmentPartDTO): string {
  const { d, ui, h } = x;
  const p = providerOf(d, part.provider);
  const label = p?.label ?? part.provider;
  const ref = partRef(part);
  const key = `part:${ref}`;
  const id = partIdentity(part, p);
  const poll = part.last_poll;
  const failed = poll?.status === "failed"
    ? `<div data-hx-pollfail style="${box("var(--red)")}">${FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">Last poll failed ${esc(relTime(poll.at))}.</strong> ${esc(poll.detail ?? "The provider did not answer.")}</div></div>` : "";
  const test = h.tests[key];
  const running = test?.status === "running";
  const pollLine = !poll ? (part.legacy ? "Read by the hourly usage poll." : "Not polled yet. Polls run every hour; Poll now on the Repo dashboard runs one.")
    : poll.status === "ok" ? `Polled ${relTime(poll.at)}${poll.detail ? `: ${poll.detail}` : ""}.`
    : poll.status === "skipped" ? `Last poll skipped ${relTime(poll.at)}${poll.detail ? `: ${poll.detail}` : ""}.`
    : `Last good poll ${poll.last_ok_at ? relTime(poll.last_ok_at) : "never"}.`;
  const settings = (p?.part_settings ?? []).map((f) => {
    const v = part.settings[f.key];
    return v ? `<div style="margin-top:4px">${esc(f.label)}: <code style="font-family:var(--code);font-size:12px;color:var(--fg-70);overflow-wrap:anywhere">${esc(v)}</code></div>` : "";
  }).join("");
  const quiet = unavailableLines(poll?.unavailable ?? [], part.role, label).map((line) => `<div data-hx-unavailable style="margin-top:6px;color:var(--fg-55)">${esc(line)}</div>`).join("");
  const legacy = part.legacy ? `<div data-hx-legacy style="margin-top:6px">Its key is fixed. Also editable under ${goLink("Environments", "orgTab", "environments")}</div>` : "";
  const actions = `<div class="cnpy-xrow-acts">
      ${outLink(`Open in ${label}`, part.console_url, `Open ${env.label} › ${part.label} in ${label}`)}
      ${quietBtn(running ? "Testing…" : "Test this part", "orgHxTestPart", { arg: ref, disabled: running, busy: running, field: `orgHxTestPart:${ref}`, label: `Test ${label} for ${env.label} › ${part.label}` })}
      ${dangerLink("Remove", "orgConfirm", { arg: `part:${ref}`, label: `Remove ${env.label} › ${part.label}`, field: `orgConfirm:part:${ref}` })}
    </div>`;
  const answer = testAnswer(test);
  return openRow({
    key, open: ui.openRows.includes(key), act: "orgRowToggle", label: `${env.label}, ${part.label}: ${ROLE_WORD[part.role].toLowerCase()} on ${label}, ${STATUS_WORD[part.connection].toLowerCase()}`,
    head: `${providerGlyph(part.provider)}<span>${esc(part.label)}</span>${chip(ROLE_WORD[part.role], "var(--fg-55)")}${statusDot(part.connection)}`,
    meta: `${esc(label)}${id ? ` &middot; ${esc(id)}` : ""}`,
    action: quietBtn("Edit", "orgHxPartEdit", { arg: ref, label: `Edit ${env.label} › ${part.label}`, field: `orgHxPartEdit:${ref}` }),
    always: failed || answer ? `${failed}${answer}` : "",
    body: `<div>Key <code style="font-family:var(--code);font-size:12px;color:var(--fg-70)">${esc(part.key)}</code> &middot; ${esc(ROLE_HINT[part.role])}</div>
      ${settings}
      <div style="font-size:12px;color:var(--fg-40);margin-top:6px">${esc(pollLine)}${part.updated_by ? ` Last changed by ${esc(part.updated_by)}${part.updated_at ? ` ${esc(relTime(part.updated_at))}` : ""}.` : ""}</div>
      ${quiet}${legacy}${actions}`,
    attrs: ` data-org-part="${attr(ref)}" data-provider="${attr(part.provider)}" data-connection="${part.connection}"`,
  });
}

// ── shapes: ONE builder for the tab's loading skeleton and its empty layouts (web-ui.md › Empty layouts) ──

/** A part's row as a shape: a name over its host, and the row's one action. Never data: boxes only. */
export const partRowsShape = (n = 2): string => skRowsShape(n, { trail: 52, pad: "12px 16px" });
/** One environment's tile as a shape: its head (a name, the Add part button), then its part rows. */
export const envTileShape = (rows = 2): string =>
  skCard(`<div class="cnpy-hx-envhead">${skLine(96, 13.5, 1.4)}<span style="margin-left:auto">${skBox(72, 30)}</span></div>${partRowsShape(rows)}`, "padding:0;overflow:hidden;min-width:0");
/** The Environments region: tiles side by side, on the grid the real tiles use. */
export const envTilesShape = (tiles = 2): string => `<div class="cnpy-hx-envs">${Array.from({ length: tiles }, () => envTileShape()).join("")}</div>`;
/** The whole tab while its one read is out: a lead line, the environment tiles, the provider rows. */
const hostingTabShape = (): string =>
  `${skLine("62%", 13, 1.55, "margin-bottom:24px")}${skLine(110, 10.5, 1.9, "margin-bottom:9px")}${envTilesShape()}${skLine(90, 10.5, 1.9, "margin:30px 0 9px")}${skCard(skRowsShape(4, { trail: 110, pad: "12px 16px" }), "padding:0;overflow:hidden")}`;
/** What each empty region says (exported: the tests and the Guide read the same words). */
export const HOSTING_ENVS_EMPTY = "Each environment gets a tile here, with the parts it runs: the web app, the API, a worker. Add the places your app runs first, such as staging and production.";
export const HOSTING_PARTS_EMPTY = "No parts yet. Add the web app, API or worker this environment runs.";

/** One environment: a tile holding its parts as rows. */
function envTile(x: TabCtx, env: HostingEnvironmentDTO): string {
  const full = env.parts.length >= MAX_PARTS_PER_ENVIRONMENT;
  const n = env.parts.length;
  return `<section${surface("padding:0;overflow:hidden;min-width:0")} data-org-hosting-env="${attr(env.key)}" aria-labelledby="${attr(`org-hx-env-${env.key}`)}">
    <div class="cnpy-hx-envhead">
      <h3 id="${attr(`org-hx-env-${env.key}`)}" style="margin:0;font-size:13.5px;font-weight:600;letter-spacing:-0.005em;overflow-wrap:anywhere">${esc(env.label)}</h3>
      <code title="The branch this environment deploys from" style="font-family:var(--code);font-size:11.5px;color:var(--fg-55)">${esc(env.branch)}</code>
      <span style="font-size:12px;color:var(--fg-40)">${n === 0 ? "No parts" : `${n} ${n === 1 ? "part" : "parts"}`}</span>
      <span style="margin-left:auto">${quietBtn("Add part", "orgHxPartNew", { arg: env.key, field: `orgHxPartNew:${env.key}`, disabled: full, title: full ? `An environment has at most ${MAX_PARTS_PER_ENVIRONMENT} parts` : undefined, label: `Add a part to ${env.label}` })}</span>
    </div>
    ${n ? `<ul style="${LIST}">${env.parts.map((p) => partRow(x, env, p)).join("")}</ul>`
      // Loaded, and this environment holds nothing: its rows drawn empty, under the one sentence (the tile's
      // own Add part button, above, is the action).
      : `<div data-hx-noparts>${emptyLayout(`org-hosting-parts-${env.key}`, { text: HOSTING_PARTS_EMPTY, plain: true, sayStyle: "padding:14px 16px 2px", shapes: partRowsShape(2) })}</div>`}
  </section>`;
}

// ── providers and their connections ──────────────────────────────────────────

/** How a connection is held, as the row's quiet metadata. */
function howConnected(c: HostingConnectionDTO, p: HostingProviderDTO): string {
  if (c.method === "install") return "Installed";
  if (c.method === "oauth") return "Connected with OAuth";
  if (c.method === "token") return c.hint_last4 ? `${cap(tokenWord(p))} &bull;&bull;&bull;&bull;${esc(c.hint_last4)}` : cap(tokenWord(p));
  if (c.method === "assume_role") return "Read-only role";
  return "";
}

/** A (provider, scope) no part uses and nothing is stored for: what its row is drawn from. */
const blankConnection = (provider: HostingProviderId, scope = "", scope_label: string | null = null): HostingConnectionDTO => ({
  provider, scope, scope_label, status: "not_connected", method: null, account: null, external_id: null, config: {}, hint_last4: "",
  connected_by: null, connected_at: null, last_used_at: null, last_error: null, legacy_fallback: false, revoked_reason: null, manage_url: null, used_by: [],
});

/** The connections drawn for one provider: its real ones, or — when it has none — one not-connected row. An
 *  environment-scoped provider (Railway) with no connection has no row to connect: a token belongs to a part's environment. */
export function connectionsFor(d: HostingSetupDTO, p: HostingProviderDTO): HostingConnectionDTO[] {
  const own = d.connections.filter((c) => c.provider === p.id);
  if (own.length) return own;
  return p.credential_scope === "org" ? [blankConnection(p.id)] : [];
}

function connectionRow(x: TabCtx, p: HostingProviderDTO, c: HostingConnectionDTO, accentTaken: boolean): string {
  const { d, ui, h } = x;
  const st = connectionStatus(c, p.label);
  const key = `hx:${connKey(c)}`;
  const ck = connKey(c);
  const locked = !d.secrets_available;
  const why = locked ? WHY_LOCKED : undefined;
  const best = bestMethod(p);
  const token = tokenMethod(p);
  const stored = c.status === "connected" || c.status === "error";
  const live = stored || c.legacy_fallback;
  const test = h.tests[ck];
  const running = test?.status === "running";
  const users = userNames(d, c);
  const who = c.scope_label ?? c.account?.label ?? "";
  const name = `<span>${esc(p.label)}${who ? ` <span style="font-weight:500;color:var(--fg-55)">&middot; ${esc(who)}</span>` : ""}</span>`;

  const meta: string[] = [];
  if (stored) {
    const how = howConnected(c, p);
    if (how) meta.push(how);
    meta.push(c.used_by.length ? `used by ${c.used_by.length} ${c.used_by.length === 1 ? "part" : "parts"}` : "not used by a part");
    if (c.connected_by) meta.push(`connected by ${esc(c.connected_by)}`);
  } else if (c.status === "revoked" && c.revoked_reason) meta.push(esc(c.revoked_reason));
  else if (c.legacy_fallback) meta.push("Using the platform's old secret");
  else if (best && isRedirect(best)) meta.push("Recommended: no token to paste");
  else if (best) meta.push(esc(best.label));
  else meta.push("Not available on this Trov");

  // The row's ONE visible action: check it once it is connected, connect it while it is not.
  const connectBtn = best ? quietBtn(st.state === "revoked" ? `Connect ${p.label} again` : isRedirect(best) ? best.label : `Connect ${p.label}`, "orgHxConnect", {
    arg: ck, disabled: locked, title: why, field: `orgHxConnect:${ck}`, label: `${st.state === "revoked" ? "Connect again" : "Connect"}: ${p.label}${c.scope_label ? ` for ${c.scope_label}` : ""}`,
    extra: accentTaken ? "" : "color:var(--fg);border-color:var(--border-strong)",
  }) : "";
  const testBtn = quietBtn(running ? "Testing…" : "Test connection", "orgHxTest", { arg: ck, disabled: running, busy: running, field: `orgHxTest:${ck}`, label: `Test the ${p.label} connection${c.scope_label ? ` for ${c.scope_label}` : ""}` });
  const action = live ? testBtn : connectBtn;

  const error = c.last_error ? `<div data-org-lasterror style="${box("var(--red)")}">${FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">Last error.</strong> ${esc(c.last_error)}</div></div>` : "";
  const answer = testAnswer(test);
  const fallback = c.legacy_fallback && !stored ? `<div data-org-legacy style="font-size:12.5px;color:var(--fg-70)">Using the platform's old secret. Save your own to take over.</div>` : "";

  // Behind the row: what the connection is and what Trov reads with it, then the less-used actions.
  const method = p.connection_methods.find((m) => m.method === c.method) ?? best;
  const grants = method?.grants.length ? `<div style="margin-top:8px"><span style="${O_LABEL};font-size:10px">${stored ? "What this connection can do" : `What ${esc(p.label)} grants`}</span><ul style="margin:4px 0 0;padding-left:18px">${method.grants.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>` : "";
  const facts = stored ? `<div style="font-size:12px;color:var(--fg-40);margin-top:6px">Connected${c.connected_by ? ` by ${esc(c.connected_by)}` : ""}${c.connected_at ? ` ${esc(relTime(c.connected_at))}` : ""} &middot; ${c.last_used_at ? `last used ${esc(relTime(c.last_used_at))}` : "not used yet"}</div>` : "";
  const usedBy = users.length ? `<div style="margin-top:6px">Used by ${esc(listed(users))}.</div>` : stored ? `<div style="margin-top:6px">No part uses it: it can be disconnected without breaking anything.</div>` : "";
  const config = stored ? p.org_config_fields.map((f) => {
    const v = c.config[f.key];
    return `<div style="margin-top:4px">${esc(f.label)}: ${v ? `<code style="font-family:var(--code);font-size:12px;color:var(--fg-70);overflow-wrap:anywhere">${esc(v)}</code>` : `<span style="color:var(--fg-40)">not set${f.required ? " (required)" : ""}</span>`}</div>`;
  }).join("") : "";
  const unavailable = p.connection_methods.filter((m) => !m.available && m.unavailable_reason && m.method !== "assume_role")
    .map((m) => `<div data-hx-method-off style="margin-top:6px;color:var(--fg-40)">${esc(m.label)} is not offered here: ${esc(m.unavailable_reason ?? "")}.</div>`).join("");

  const more: string[] = [];
  if (stored && c.manage_url) more.push(outLink(`Manage on ${p.label}`, c.manage_url, `Manage this connection on ${p.label}`));
  if (live && connectBtn && isRedirect(best)) more.push(quietBtn("Connect a different account", "orgHxConnect", { arg: ck, disabled: locked, title: why, field: `orgHxReconnect:${ck}` }));
  if (stored && c.method === "token" && token) more.push(quietBtn("Rotate", "orgHxToken", { arg: `rotate:${ck}`, disabled: locked, title: why, field: `orgHxToken:rotate:${ck}`, label: `Rotate the ${p.label} ${tokenWord(p)}` }));
  if (stored && p.org_config_fields.length) more.push(quietBtn("Edit settings", "orgHxToken", { arg: `config:${ck}`, field: `orgHxToken:config:${ck}`, label: `Edit the ${p.label} settings` }));
  if (!live && token && isRedirect(best)) more.push(quietBtn(cap(token.label), "orgHxToken", { arg: `set:${ck}`, disabled: locked, title: why, field: `orgHxToken:set:${ck}` }));
  if (c.legacy_fallback && !stored && token) more.push(quietBtn(cap(token.label), "orgHxToken", { arg: `set:${ck}`, disabled: locked, title: why, field: `orgHxToken:set:${ck}` }));
  if (stored) more.push(dangerLink("Disconnect", "orgConfirm", { arg: `hosting:${ck}`, label: `Disconnect ${p.label}${c.scope_label ? ` for ${c.scope_label}` : ""}`, field: `orgConfirm:hosting:${ck}` }));

  const row = openRow({
    key, open: ui.openRows.includes(key), act: "orgRowToggle", label: `${p.label}${who ? `, ${who}` : ""}, ${st.word.toLowerCase()}`,
    head: `${providerGlyph(p.id)}${name}${chip(st.word, st.tone)}`,
    meta: meta.join(" &middot; "), action,
    always: error || answer || fallback ? `${fallback}${error}${answer}` : "",
    body: `<div style="max-width:680px">${esc(p.summary)}</div>
      ${p.plan_note ? `<div style="margin-top:6px;max-width:680px;color:var(--fg-40)">${esc(p.plan_note)}</div>` : ""}
      <div style="margin-top:8px">${capabilityChips(p)}</div>
      ${facts}${usedBy}${config}${grants}
      <div data-hx-sentto style="margin-top:8px;color:var(--fg-40)">${esc(sentOnlyTo(p))}</div>
      ${unavailable}
      ${more.length ? `<div class="cnpy-xrow-acts">${more.join("")}</div>` : ""}`,
    attrs: ` data-org-hosting-conn="${attr(ck)}" data-state="${st.state}"`,
  });

  // Connected by install / OAuth: the paste-a-token form is NOT offered beside it — it folds under it, as
  // GitHub's token and webhook rows fold under the App (integrations.ts `githubGroup`).
  const manualKey = `hx-manual:${ck}`;
  const manual = stored && (c.method === "install" || c.method === "oauth") && token ? openRow({
    key: manualKey, open: ui.openRows.includes(manualKey), act: "orgRowToggle", label: `Manual connection, not needed while ${p.label} is connected`,
    head: `<span>Manual connection</span>`, meta: `Not needed while ${esc(p.label)} is connected`,
    body: `<div style="max-width:680px">${cap(/^[aeiou]/i.test(tokenWord(p)) ? "an" : "a")} ${esc(tokenWord(p))}: how ${esc(p.label)} is connected without ${c.method === "install" ? "the integration" : "signing in"}. Pasting one REPLACES the current connection.</div>
      <div class="cnpy-xrow-acts">${quietBtn(cap(token.label), "orgHxToken", { arg: `rotate:${ck}`, disabled: locked, title: why, field: `orgHxToken:manual:${ck}` })}</div>`,
    attrs: ` data-org-hosting-manual="${attr(p.id)}"`,
  }) : "";
  return row + manual;
}

/** A provider Trov describes but cannot connect yet (AWS): visible, disabled, with what it will need. */
function laterRow(x: TabCtx, p: HostingProviderDTO): string {
  const key = `hx:${p.id}:later`;
  const m = p.connection_methods[0];
  return openRow({
    key, open: x.ui.openRows.includes(key), act: "orgRowToggle", label: `${p.label}, coming later`,
    head: `${providerGlyph(p.id)}<span style="color:var(--fg-55)">${esc(p.label)}</span>${chip("Coming later", "var(--fg-55)")}`,
    meta: m ? esc(m.label) : "",
    body: `<div style="max-width:680px">${esc(p.summary)}</div>
      ${p.plan_note ? `<div style="margin-top:6px;max-width:680px;color:var(--fg-40)">${esc(p.plan_note)}</div>` : ""}
      <div style="margin-top:8px">${capabilityChips(p)}</div>
      ${m ? `<div style="margin-top:8px"><span style="${O_LABEL};font-size:10px">What it will need</span><ul style="margin:4px 0 0;padding-left:18px">${m.grants.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>` : ""}`,
    attrs: ` data-org-hosting-conn="${attr(`${p.id}:`)}" data-state="later"`,
  });
}

/** An environment-scoped provider (Railway) nobody uses yet: there is no credential to give until a part names its environment. */
function scopedHintRow(p: HostingProviderDTO): string {
  return `<li class="cnpy-org-row" style="align-items:center" data-org-hosting-conn="${attr(`${p.id}:`)}" data-state="unused">
    ${providerGlyph(p.id)}
    <div style="flex:1 1 260px;min-width:0"><div style="display:flex;align-items:center;gap:6px 9px;flex-wrap:wrap"><span style="font-size:13.5px;font-weight:600">${esc(p.label)}</span>${chip("Not connected", "var(--fg-55)")}</div>
      <div style="font-size:12px;color:var(--fg-40);margin-top:2px">${esc(cap(tokenWord(p)))} per environment: add a ${esc(p.label)} part to an environment, then connect it there.</div></div>
  </li>`;
}

// ── the tab ──────────────────────────────────────────────────────────────────

/** The lead's sentence: how much is set up, and what needs attention. */
function hostingLead(d: HostingSetupDTO, action: string): string {
  const parts = d.environments.reduce((n, e) => n + e.parts.length, 0);
  const envs = d.environments.length;
  const used = d.connections.filter((c) => c.used_by.length > 0);
  const live = used.filter((c) => c.status === "connected" || (c.status === "not_connected" && c.legacy_fallback)).length;
  const errors = d.connections.filter((c) => c.status === "error").length;
  const lost = d.connections.filter((c) => { const p = providerOf(d, c.provider); return !!p && lostOnProvider(c, p.label); }).length;
  const failed = d.environments.reduce((n, e) => n + e.parts.filter((p) => p.last_poll?.status === "failed").length, 0);
  if (envs === 0) return tabLead("No environment yet. An environment is a branch that deploys somewhere; its parts are what runs it, each on its own host.", action);
  const bits = [
    parts === 0 ? `No parts yet in <strong>${envs}</strong> ${envs === 1 ? "environment" : "environments"}` : `<strong>${parts}</strong> ${parts === 1 ? "part" : "parts"} in <strong>${envs}</strong> ${envs === 1 ? "environment" : "environments"}`,
    ...(used.length ? [`<strong>${live} of ${used.length}</strong> ${used.length === 1 ? "connection" : "connections"} working`] : []),
    ...(errors ? [leadFlag(`${errors} with an error`)] : []),
    ...(lost ? [leadFlag(`${lost} removed on the provider`, "amber")] : []),
    ...(failed ? [leadFlag(`${failed} ${failed === 1 ? "part's" : "parts'"} last poll failed`, "amber")] : []),
  ];
  return tabLead(`${bits.join(" &middot; ")}. Trov reads each part's deploys and usage from its host every hour.`, action);
}

const INFO = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="1.8" aria-hidden="true" style="flex:none"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>`;
/** While previewing: what is shown, which state, and the way back. */
function sampleBar(h: HostingUi): string {
  return `<div data-org-hosting-sample="${attr(h.sample ?? "")}" style="display:flex;align-items:center;gap:8px 12px;flex-wrap:wrap;margin:0 0 18px;font-size:12.5px;color:var(--fg-55)">${INFO}
    <span><span style="font-family:var(--label);font-size:11.5px;color:var(--fg);background:var(--hover);border:1px solid var(--border);border-radius:4px;padding:0 5px">sample data</span> &mdash; placeholder values, not this organization's. Nothing you do here is saved.</span>
    ${segmented({ id: "org-hx-sample", ariaLabel: "Sample state", act: "orgHxSample", value: h.sample ?? "mixed", size: "xs", inertOn: true, options: HOSTING_SAMPLE_KEYS.map((k) => ({ value: k, label: SAMPLE_LABEL[k] })) })}
    <button type="button" data-act="orgHxSample" data-arg="off" data-field="orgHxSampleOff" class="cnpy-mutelink" style="margin-left:auto;padding:0;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap">Back to live data</button>
  </div>`;
}
const sampleFoot = (): string => `<div style="display:flex;align-items:center;gap:9px;margin-top:22px;font-size:12px;color:var(--fg-40)">${INFO}<span>Want to see every state of this page?</span>
    <button type="button" data-act="orgHxSample" data-arg="mixed" data-field="orgHxSampleOn" class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:500;color:var(--accent);white-space:nowrap">Preview with sample data</button></div>`;

export function hostingTab(org: MyOrg, ui: OrgUi): string {
  const h = ui.hosting;
  const d = hostingData(h);
  if (!d) {
    // The read is out, or failed: the notice still says what the return was, and the way to the sample is kept.
    const note = h.sample ? skeleton("org-hosting-sample", "Loading the sample&hellip;", hostingTabShape())
      : h.setup.status === "error" ? failedNote("hosting", "orgHxReload")
      : skeleton("org-hosting", "Loading hosting&hellip;", hostingTabShape());
    return `${hostingNotice(h.notice, null, org.name)}${note}${h.setup.status === "error" && !h.sample ? sampleFoot() : ""}`;
  }
  const x: TabCtx = { d, ui, h };
  const locked = d.secrets_available ? "" : `<div style="margin-bottom:20px" data-org-unavailable>${orgBanner(
    "Credentials can't be saved right now",
    "The platform key is missing, so this Trov cannot store or use a credential for any organization. Connecting, rotating and pasting a token are off until whoever runs this Trov sets it. Parts can still be added and edited; nothing you set earlier is lost.",
  )}</div>`;

  // The tab's ONE accent action: the next step of the checklist.
  const next = d.checklist.find((i) => !i.done) ?? null;
  const lead = hostingLead(d, next ? stepButton(next, d, accentBtn, "lead") : "");

  const envs = d.environments.length === 0
    ? emptyLayout("org-hosting-envs", {
      title: "No environments yet", text: HOSTING_ENVS_EMPTY, cls: "cnpy-org-empty", sayStyle: "margin-bottom:14px",
      actionHtml: quietBtn("Open Environments", "orgTab", { arg: "environments", field: "orgHxEnvs" }), shapes: envTilesShape(),
    })
    : `<div class="cnpy-hx-envs">${d.environments.map((e) => envTile(x, e)).join("")}</div>`;

  const available = d.providers.filter((p) => p.status === "available");
  const modern = available.filter((p) => p.legacy_part_key === null);
  const legacy = available.filter((p) => p.legacy_part_key !== null);
  const later = d.providers.filter((p) => p.status === "later");
  const accentIsConnect = next?.action.kind === "connect";
  const rowsOf = (list: HostingProviderDTO[]): string => list.map((p) => {
    const cs = connectionsFor(d, p);
    return cs.length ? cs.map((c) => connectionRow(x, p, c, accentIsConnect)).join("") : scopedHintRow(p);
  }).join("");
  const connected = (list: HostingProviderDTO[]): number => list.filter((p) => d.connections.some((c) => c.provider === p.id && (c.status === "connected" || c.status === "error"))).length;

  return `${h.sample ? sampleBar(h) : ""}${hostingNotice(h.notice, d, org.name)}${hostingLostBanners(d)}${locked}${lead}
    ${hostingChecklist(d, h)}
    ${hostingDetected(d, h)}
    <section aria-labelledby="org-hx-envs-t" data-org-group="hosting-envs">
      ${orgHead("Environments", d.environments.length > 1 ? "in drift order: the first deploys from the head branch, the last is production" : "", d.environments.length, "org-hx-envs-t")}
      ${envs}
    </section>
    <section aria-labelledby="org-hx-prov-t" data-org-group="hosting-providers">
      ${orgHead("Providers", `${connected(modern)} of ${modern.length} connected`, null, "org-hx-prov-t")}
      <ul${surface(LIST)}>${rowsOf(modern)}</ul>
    </section>
    ${legacy.length ? `<section aria-labelledby="org-hx-legacy-t" data-org-group="hosting-legacy">
      ${orgHead("Legacy", "the first two hosts Trov read: one part per environment, kept in the environment's own fields", null, "org-hx-legacy-t")}
      <ul${surface(LIST)}>${rowsOf(legacy)}</ul>
    </section>` : ""}
    ${later.length ? `<section aria-labelledby="org-hx-later-t" data-org-group="hosting-later">
      ${orgHead("Later", "described, not connectable yet", null, "org-hx-later-t")}
      <ul${surface(LIST)}>${later.map((p) => laterRow(x, p)).join("")}</ul>
    </section>` : ""}
    ${h.sample ? "" : sampleFoot()}`;
}

/** What the tab bar's badge counts on Hosting: connections with an error, or ended on the provider's side. */
export function hostingTodo(h: HostingUi): number {
  const d = h.setup.data;
  if (!d) return 0;
  return d.connections.filter((c) => { const p = providerOf(d, c.provider); return c.status === "error" || (!!p && lostOnProvider(c, p.label)); }).length;
}

// ── the part editor ──────────────────────────────────────────────────────────

/** A setting whose pattern is a short list of words (`^(?:production|preview)$`) is a pick-one, not a text field. */
export function fieldOptions(f: HostingFieldDTO): string[] | null {
  const m = /^\^\((?:\?:)?([a-z0-9_-]+(?:\|[a-z0-9_-]+)+)\)\$$/.exec(f.pattern ?? "");
  return m ? m[1].split("|") : null;
}
function matches(pattern: string | null, value: string): boolean {
  if (!pattern) return true;
  try { return new RegExp(pattern).test(value); } catch { return true; }
}

/** The key a draft will be saved under: fixed for a legacy provider, the stored one when editing, else what was typed. */
export function draftKey(dr: PartDraft, p: HostingProviderDTO | null): string {
  return dr.key ?? p?.legacy_part_key ?? dr.keyDraft.trim();
}

/** What stops a draft from being saved, by field — the checks the server makes again. Empty = it can be saved. */
export function partDraftProblems(dr: PartDraft, d: HostingSetupDTO): Record<string, string> {
  const out: Record<string, string> = {};
  const p = providerOf(d, dr.provider);
  if (!p) { out.provider = "Pick the host this part runs on."; return out; }
  if (p.status !== "available") out.provider = `${p.label} is not supported yet.`;
  const env = d.environments.find((e) => e.key === dr.env);
  const key = draftKey(dr, p);
  if (dr.key === null) {
    if (!PART_KEY_RE.test(key)) out.part = key ? "1 to 32 characters: a to z, 0 to 9, - or _." : "";
    else if (env?.parts.some((x) => x.key === key)) out.part = p.legacy_part_key ? `${env.label} already has a ${p.label} part. Edit that one.` : `${env.label} already has a part with this key.`;
  }
  if (!p.legacy_part_key && dr.label.trim().length > 60) out.label = "At most 60 characters.";
  for (const f of p.part_settings) {
    const v = (dr.settings[f.key] ?? "").trim();
    if (!v) { if (f.required) out[`settings.${f.key}`] = ""; continue; }
    if (!matches(f.pattern, v)) out[`settings.${f.key}`] = `That does not look like a ${f.label}${f.placeholder ? `: for example ${f.placeholder}` : ""}.`;
  }
  return out;
}

/** The provider picker (dropdown.ts — never a native select). Legacy providers are offered only where their fixed key is free. */
export function partProviderDropdown(dr: PartDraft, d: HostingSetupDTO): DropdownProps {
  const env = d.environments.find((e) => e.key === dr.env);
  const current = dr.key === null ? null : env?.parts.find((p) => p.key === dr.key) ?? null;
  const options = d.providers.filter((p) => p.status === "available").filter((p) => {
    if (current?.legacy) return p.id === current.provider;            // a legacy part's host is its key
    if (current) return p.legacy_part_key === null;                    // a stored part cannot become a legacy one
    return true;
  }).map((p) => ({
    value: p.id, label: p.label,
    hint: `${p.roles.map((r) => ROLE_WORD[r]).join(" or ")} · ${[...(p.capabilities.deploys ? ["deploys"] : []), ...(p.capabilities.metrics.length ? ["usage"] : [])].join(" and ") || "nothing yet"}`,
  }));
  return {
    id: "org-hx-provider", act: "orgHxPartProvider", value: dr.provider ?? "", options: dr.provider ? options : [{ value: "", label: "Pick a host", shown: "Pick a host" }, ...options],
    labelledBy: "org-hx-provider-l", fill: true, disabled: dr.saving || !!current?.legacy,
  };
}

export function partEditorModal(d: HostingSetupDTO, dr: PartDraft, h: HostingUi, dd: DropdownUi = initialDropdownUi()): string {
  const env = d.environments.find((e) => e.key === dr.env);
  const p = providerOf(d, dr.provider);
  const adding = dr.key === null;
  const current = adding ? null : env?.parts.find((x) => x.key === dr.key) ?? null;
  const problems = partDraftProblems(dr, d);
  const errOf = (field: string): string | null => (dr.errorField === field && dr.error ? dr.error : problems[field] || null);
  const canSave = !dr.saving && Object.keys(problems).length === 0;
  const detected = (d.detected ?? []).find((x) => x.provider === dr.provider && !x.in_use);
  const later = d.providers.filter((x) => x.status === "later");

  const providerBlock = `<div class="cnpy-org-field">
      <div id="org-hx-provider-l" style="${O_LABEL}">Host</div>
      <div style="margin-top:7px">${dropdown(partProviderDropdown(dr, d), dd)}</div>
      ${errOf("provider") ? `<div role="alert" style="${O_ERR}">${esc(errOf("provider") ?? "")}</div>` : ""}
      ${p ? `<div data-hx-provider-about style="margin-top:9px;font-size:12.5px;line-height:1.55;color:var(--fg-55)">${detected ? `<div data-hx-detected-hint style="margin-bottom:5px;color:var(--fg-70)"><strong style="font-weight:600;color:var(--fg)">Detected.</strong> Trov saw ${esc(detected.evidence)} on your repository.</div>` : ""}${esc(p.summary)}
          <div style="margin-top:7px">${capabilityChips(p)}</div>
          ${p.plan_note ? `<div style="margin-top:7px;color:var(--fg-40)">${esc(p.plan_note)}</div>` : ""}</div>`
        : `<div style="${O_HELP}">${later.length ? `${esc(listed(later.map((x) => x.label)))}: coming later.` : ""}</div>`}
    </div>`;

  const roleBlock = !p ? "" : p.roles.length > 1
    ? `<div class="cnpy-org-field"><div id="org-hx-role-l" style="${O_LABEL}">Role</div>
        <div style="margin-top:7px">${segmented({ id: "org-hx-role", ariaLabel: "Role", act: "orgHxPartRole", value: dr.role, size: "sm", inertOn: true, options: p.roles.map((r) => ({ value: r, label: ROLE_WORD[r] })) })}</div>
        <div style="${O_HELP}">${esc(ROLE_HINT[dr.role])}</div></div>`
    : `<div class="cnpy-org-field"><div style="${O_LABEL}">Role</div><div data-hx-role-fixed style="margin-top:7px;font-size:13.5px">${esc(ROLE_WORD[p.roles[0]])}</div><div style="${O_HELP}">${esc(ROLE_HINT[p.roles[0]])} ${esc(p.label)} serves only this role.</div></div>`;

  const legacyKey = p?.legacy_part_key ?? null;
  const fixedKey = !adding || !!legacyKey;
  const keyBlock = !p ? "" : `<div class="cnpy-org-grid">
      ${textField({ id: "org-hx-key", label: "Key", act: "orgHxPartKey", field: "orgHxPartKey", value: fixedKey ? draftKey(dr, p) : dr.keyDraft, max: 32, required: !fixedKey, disabled: fixedKey || dr.saving, placeholder: "web", enter: "orgHxPartSave", error: errOf("part"),
        help: fixedKey ? (legacyKey ? `A ${esc(p.label)} part's key is always <code style="font-family:var(--code)">${esc(legacyKey)}</code>.` : "A part's key is permanent.") : "Its permanent id: lowercase letters, digits, - or _. For example <code style=\"font-family:var(--code)\">web</code> or <code style=\"font-family:var(--code)\">api</code>." })}
      ${textField({ id: "org-hx-label", label: "Label", act: "orgHxPartLabel", field: "orgHxPartLabel", value: legacyKey ? (legacyKey === "frontend" ? "Frontend" : "Backend") : dr.label, max: 60, disabled: !!legacyKey || dr.saving, placeholder: "Web app", enter: "orgHxPartSave", error: errOf("label"),
        help: legacyKey ? "Fixed for this host." : "The name on its dashboard card. Left empty, it is the key." })}
    </div>`;

  const settings = !p ? "" : p.part_settings.map((f) => {
    const field = `settings.${f.key}`;
    const opts = fieldOptions(f);
    const value = dr.settings[f.key] ?? "";
    if (opts) {
      const shown = opts.includes(value) ? value : opts.includes(f.placeholder ?? "") ? f.placeholder ?? opts[0] : opts[0];
      return `<div class="cnpy-org-field" data-hx-setting="${attr(f.key)}"><div style="${O_LABEL}">${esc(f.label)}</div>
        <div style="margin-top:7px">${segmented({ id: `org-hx-set-${f.key}`, ariaLabel: f.label, act: "orgHxPartPick", value: `${f.key}=${shown}`, size: "sm", inertOn: true, options: opts.map((o) => ({ value: `${f.key}=${o}`, label: cap(o) })) })}</div>
        <div style="${O_HELP}">${esc(f.description)}</div>
        ${errOf(field) ? `<div role="alert" style="${O_ERR}">${esc(errOf(field) ?? "")}</div>` : ""}</div>`;
    }
    return `<div data-hx-setting="${attr(f.key)}">${textField({ id: `org-hx-set-${f.key}`, label: f.label, act: "orgHxPartSetting", arg: f.key, field: `orgHxPartSetting:${f.key}`, value, required: f.required, placeholder: f.placeholder ?? undefined, max: 300, disabled: dr.saving, enter: "orgHxPartSave", help: esc(f.description), error: errOf(field) })}</div>`;
  }).join("");

  // Is this provider connected for this part's scope? Saving is allowed before connecting; the checklist reminds.
  const conn = p ? connectionOf(d, p.id, scopeFor(p, dr.env)) : null;
  const connected = !!conn && (conn.status === "connected" || conn.status === "error" || conn.legacy_fallback);
  const best = p ? bestMethod(p) : null;
  const hint = !p || connected ? "" : `<div data-hx-connect-hint style="${box("var(--fg-40)")};margin-top:16px;align-items:center;flex-wrap:wrap">
      <div style="flex:1 1 240px;min-width:0"><strong style="font-weight:600;color:var(--fg)">${esc(p.label)} is not connected yet${p.credential_scope === "environment" && env ? ` for ${esc(env.label)}` : ""}.</strong> You can save the part now and connect after: it reads nothing until then.</div>
      ${best ? quietBtn("Save and connect", "orgHxPartSave", { arg: "connect", disabled: !canSave || !d.secrets_available, busy: dr.saving, field: "orgHxPartSaveConnect", title: d.secrets_available ? undefined : WHY_LOCKED }) : ""}
    </div>`;

  const general = dr.error && (dr.errorField === null || !["provider", "part", "label"].includes(dr.errorField) && !(p?.part_settings ?? []).some((f) => `settings.${f.key}` === dr.errorField));
  const title = adding ? `Add a part to ${env?.label ?? dr.env}` : `Edit ${env?.label ?? dr.env} › ${current?.label ?? dr.key ?? ""}`;
  return `<div data-overlay="org-hx-part" class="cnpy-cmodal">
    <div data-act="orgHxPartClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="org-hx-part" role="dialog" aria-modal="true" aria-labelledby="org-hx-part-t" aria-describedby="org-hx-part-d" tabindex="-1" data-hx-dialog data-org-part-editor="${adding ? "add" : "edit"}" data-scroll-keep="org-hx-part" class="cnpy-surface cnpy-cmodal-box cnpy-org-secret cnpy-hx-dialog cnpy-scroll" style="position:relative">
        <button type="button" data-act="orgHxPartClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        <h2 id="org-hx-part-t" style="margin:0;padding-right:36px;font-size:16px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;overflow-wrap:anywhere">${esc(title)}</h2>
        <p id="org-hx-part-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">A part is one deployable of the environment, such as its web app, its API or a worker, and the host it runs on.</p>
        <div class="cnpy-hx-form">
          ${providerBlock}${roleBlock}${keyBlock}
          ${settings ? `<div style="${O_LABEL};margin-top:4px">On ${esc(p?.label ?? "")}</div><div class="cnpy-org-grid">${settings}</div>` : ""}
        </div>
        ${hint}
        ${general ? `<div role="alert" style="${O_ERR};margin-top:14px">${esc(dr.error ?? "")}</div>` : ""}
        <div class="cnpy-cmodal-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:20px">
          ${accentBtn(dr.saving ? "Saving…" : adding ? "Add part" : "Save changes", "orgHxPartSave", { disabled: !canSave, busy: dr.saving, field: "orgHxPartSave", extra: "height:36px" })}
          ${quietBtn("Cancel", "orgHxPartClose", { disabled: dr.saving, extra: "height:36px" })}
          ${current ? dangerLink("Remove part", "orgConfirm", { arg: `part:${dr.env}/${current.key}`, disabled: dr.saving, field: `orgConfirm:part:${dr.env}/${current.key}:editor`, extra: "margin-left:auto;height:36px" }) : ""}
        </div>
      </div>
    </div>
  </div>`;
}

// ── connecting: the install / OAuth confirmation ─────────────────────────────

export function connectModal(d: HostingSetupDTO, cd: ConnectDraft): string {
  const p = providerOf(d, cd.provider);
  const m = p ? bestMethod(p) : null;
  if (!p || !m) return "";
  const conn = connectionOf(d, p.id, "");
  const replacing = !!conn && (conn.status === "connected" || conn.status === "error");
  const held = conn?.account?.label ? `the connection to ${conn.account.label}` : conn?.method === "token" && conn.hint_last4 ? `the ${tokenWord(p)} ending in ${conn.hint_last4}` : "the current connection";
  const token = tokenMethod(p);
  return `<div data-overlay="org-hx-connect" class="cnpy-cmodal">
    <div data-act="orgHxConnectClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="org-hx-connect" role="dialog" aria-modal="true" aria-labelledby="org-hx-connect-t" aria-describedby="org-hx-connect-d" tabindex="-1" data-hx-dialog data-org-hosting-connect="${attr(p.id)}" data-method="${attr(m.method)}" data-scroll-keep="org-hx-connect" class="cnpy-surface cnpy-cmodal-box cnpy-org-secret cnpy-hx-dialog cnpy-scroll" style="position:relative">
        <button type="button" data-act="orgHxConnectClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        <h2 id="org-hx-connect-t" style="margin:0;padding-right:36px;font-size:16px;font-weight:600;letter-spacing:-0.01em;line-height:1.35">${esc(m.label)}</h2>
        <p id="org-hx-connect-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">You leave Trov for ${esc(p.label)}, approve there, and come back to this page. No token to paste.</p>
        ${replacing ? `<div data-hx-replaces style="${box("var(--amber)")};margin-top:14px"><div style="min-width:0"><strong style="font-weight:600;color:var(--fg)">This replaces ${esc(held)}.</strong> The old one is ended${conn?.method === "token" ? " here" : ` and removed on ${esc(p.label)}`} once the new one is connected.</div></div>` : ""}
        <div style="margin-top:16px"><div style="${O_LABEL}">${esc(p.label)} will ask for</div>
          <ul data-hx-grants style="margin:7px 0 0;padding-left:18px;font-size:13px;line-height:1.6;color:var(--fg-70)">${m.grants.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>
        <p style="margin:12px 0 0;font-size:12.5px;line-height:1.65;color:var(--fg-55);overflow-wrap:anywhere">${howToHtml(m.how_to)}</p>
        <p data-hx-sentto style="margin:10px 0 0;font-size:12px;color:var(--fg-40)">${esc(sentOnlyTo(p))}</p>
        ${cd.error ? `<div role="alert" style="${O_ERR};margin-top:12px">${esc(cd.error)}</div>` : ""}
        <div class="cnpy-cmodal-btns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:20px">
          ${accentBtn(cd.busy ? `Opening ${p.label}…` : `Continue to ${p.label}`, "orgHxConnectGo", { disabled: cd.busy, busy: cd.busy, field: "orgHxConnectGo", extra: "height:36px" })}
          ${quietBtn("Cancel", "orgHxConnectClose", { disabled: cd.busy, extra: "height:36px" })}
          ${token && !replacing ? `<button type="button" data-act="orgHxToken" data-arg="${attr(`set:${p.id}:`)}" data-field="orgHxConnectToken"${cd.busy ? " disabled" : ""} class="cnpy-mutelink" style="margin-left:auto;padding:0 2px;height:36px;font-size:12.5px;font-weight:500;color:var(--fg-55)">${esc(cap(token.label))} instead</button>` : ""}
        </div>
      </div>
    </div>
  </div>`;
}

// ── connecting: the paste-a-token form ───────────────────────────────────────

/** Can the form be saved? (`set` needs the value and the required settings; `rotate` the value; `config` the settings.) */
export function tokenFormOk(p: HostingProviderDTO, f: TokenForm): boolean {
  const required = p.org_config_fields.filter((c) => c.required).every((c) => (f.config[c.key] ?? "").trim() !== "");
  const shaped = p.org_config_fields.every((c) => { const v = (f.config[c.key] ?? "").trim(); return !v || matches(c.pattern, v); });
  if (f.saving) return false;
  return f.mode === "rotate" ? f.hasValue : f.mode === "config" ? required && shaped : f.hasValue && required && shaped;
}

/**
 * The focused form (`.cnpy-cmodal`, a bottom sheet at phone width): the value on the left, where to get it and
 * WHAT IT CAN DO on the right — said plainly, in the provider's own words (`grants`: "Render API keys have no
 * scopes…"). The password input has NO `value` attribute, in any state — `data-hx-secret-input` is how
 * hosting-actions.ts finds the live element.
 */
export function tokenModal(d: HostingSetupDTO, f: TokenForm): string {
  const p = providerOf(d, f.provider);
  const m = p?.connection_methods.find((x) => x.method === "token") ?? null;
  if (!p || !m) return "";
  const word = tokenWord(p);
  const conn = connectionOf(d, p.id, f.scope);
  const scopeLabel = f.scope ? d.environments.find((e) => e.key === f.scope)?.label ?? f.scope : "";
  const forScope = scopeLabel ? ` for ${scopeLabel}` : "";
  const over = f.mode === "rotate" && conn && (conn.method === "install" || conn.method === "oauth");
  const title = f.mode === "config" ? `${p.label} settings${forScope}` : f.mode === "rotate" ? (over ? `${p.label}: ${lowerFirst(m.label)}` : `Rotate the ${p.label} ${word}${forScope}`) : `${p.label}: ${lowerFirst(m.label)}${forScope}`;
  const secretErr = f.error && f.errorField === "secret" ? f.error : null;
  const formErr = f.error && (f.errorField === null || (f.errorField !== "secret" && !p.org_config_fields.some((c) => `config.${c.key}` === f.errorField))) ? f.error : null;
  const secretField = f.mode === "config" ? "" : `<div class="cnpy-org-field">
      <label for="org-hx-secret" style="${O_LABEL}">${esc(f.mode === "rotate" && !over ? `New ${word}` : cap(word))}</label>
      <input id="org-hx-secret" data-hx-secret-input data-act="orgHxTokenInput" data-field="orgHxTokenValue" data-enter="orgHxTokenSave" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true"${f.saving ? " disabled" : ""}${secretErr ? ' aria-invalid="true"' : ""} aria-describedby="org-hx-secret-h${secretErr ? " org-hx-secret-e" : ""}" placeholder="Paste it here" class="cnpy-input" style="${O_FIELD};margin-top:7px;font-family:var(--code);font-size:12.5px;${secretErr ? "border-color:var(--red);" : ""}" />
      ${secretErr ? `<div id="org-hx-secret-e" role="alert" style="${O_ERR}">${esc(secretErr)}</div>` : ""}
      <div id="org-hx-secret-h" style="${O_HELP}">${over ? `It replaces the ${conn?.method === "install" ? "installed integration" : "OAuth connection"} the moment you save. ` : f.mode === "rotate" ? `It replaces the current value${conn?.hint_last4 ? ` (ends in ${esc(conn.hint_last4)})` : ""} the moment you save. ` : ""}Spaces around a pasted value are removed. It is encrypted before it is stored, and Trov never shows it again: only its last four characters. To change it, rotate it.</div>
    </div>`;
  const configFields = f.mode === "rotate" ? "" : p.org_config_fields.map((c) => {
    const v = f.config[c.key] ?? "";
    const bad = f.errorField === `config.${c.key}` ? f.error : v.trim() && !matches(c.pattern, v.trim()) ? `That does not look like a ${c.label}${c.placeholder ? `: for example ${c.placeholder}` : ""}.` : null;
    return `<div style="margin-top:${f.mode === "config" ? "0" : "16px"}">${textField({ id: `org-hx-cfg-${c.key}`, label: c.label, act: "orgHxTokenConfig", arg: c.key, field: `orgHxTokenConfig:${c.key}`, value: v, help: esc(c.description), required: c.required, placeholder: c.placeholder ?? undefined, disabled: f.saving, enter: "orgHxTokenSave", error: bad })}</div>`;
  }).join("");
  const saveLabel = f.saving ? "Saving…" : f.mode === "config" ? "Save settings" : f.mode === "rotate" ? `Replace ${over ? "connection" : word}` : `Save ${word}`;
  const how = `<aside class="cnpy-org-how" aria-labelledby="org-hx-how">
      <div id="org-hx-how" style="${O_LABEL}">${f.mode === "config" ? "About these settings" : "Where to get it"}</div>
      <p style="margin:8px 0 0;font-size:12.5px;line-height:1.65;color:var(--fg-70);overflow-wrap:anywhere">${howToHtml(m.how_to)}</p>
      ${m.grants.length ? `<div style="${O_LABEL};margin-top:16px">What this ${esc(word)} can do</div>
      <ul data-hx-grants style="margin:8px 0 0;padding-left:18px;font-size:12.5px;line-height:1.6;color:var(--fg-70)">${m.grants.map((g) => `<li>${esc(g)}</li>`).join("")}</ul>` : ""}
    </aside>`;
  return `<div data-overlay="org-hx-token" class="cnpy-cmodal">
    <div data-act="orgHxTokenClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="org-hx-token" role="dialog" aria-modal="true" aria-labelledby="org-hx-token-t" aria-describedby="org-hx-token-d" tabindex="-1" data-hx-dialog data-org-hosting-token="${attr(f.mode)}" data-provider="${attr(p.id)}" data-scroll-keep="org-hx-token" class="cnpy-surface cnpy-cmodal-box cnpy-org-secret cnpy-scroll" style="position:relative">
        <button type="button" data-act="orgHxTokenClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        <h2 id="org-hx-token-t" style="margin:0;padding-right:36px;font-size:16px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;overflow-wrap:anywhere">${esc(title)}</h2>
        <p id="org-hx-token-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">${esc(p.summary)}</p>
        <div class="cnpy-org-secretgrid">
          <div style="min-width:0">
            ${secretField}${configFields}
            ${formErr ? `<div role="alert" style="${O_ERR};margin-top:12px">${esc(formErr)}</div>` : ""}
            <div class="cnpy-cmodal-btns" style="display:flex;gap:8px;margin-top:20px">
              ${accentBtn(saveLabel, "orgHxTokenSave", { disabled: !tokenFormOk(p, f), busy: f.saving, field: "orgHxTokenSave", extra: "height:36px" })}
              ${quietBtn("Cancel", "orgHxTokenClose", { disabled: f.saving, extra: "height:36px" })}
            </div>
            <p data-hx-sentto style="margin:14px 0 0;font-size:12px;color:var(--fg-40)">${esc(sentOnlyTo(p))}</p>
          </div>
          ${how}
        </div>
      </div>
    </div>
  </div>`;
}

// ── confirmations ────────────────────────────────────────────────────────────

export interface ConfirmCopy { title: string; body: string; confirmLabel: string; busyLabel: string }

/** Remove a part (`<env>/<part>`): what goes with it, and what stays. Pure. */
export function partConfirmCopy(d: HostingSetupDTO, ref: string): ConfirmCopy | null {
  const at = ref.indexOf("/");
  const env = d.environments.find((e) => e.key === ref.slice(0, at));
  const part = env?.parts.find((p) => p.key === ref.slice(at + 1));
  if (!env || !part) return null;
  const p = providerOf(d, part.provider);
  return {
    title: `Remove ${env.label} › ${part.label}?`,
    body: part.legacy
      ? `${env.label}'s ${p?.label ?? part.provider} fields are cleared, here and under Environments, so the Repo dashboard stops reading it. Past figures stay until they age out.`
      : "Its deploy history and poll state go with it; past figures stay until they age out.",
    confirmLabel: "Remove part", busyLabel: "Removing…",
  };
}

/** Disconnect a provider (`<provider>:<scope>`): what stops, and what happens on the provider's side. Pure. */
export function disconnectConfirmCopy(d: HostingSetupDTO, key: string, orgName: string): ConfirmCopy | null {
  const at = key.indexOf(":");
  const provider = key.slice(0, at) as HostingProviderId;
  const p = providerOf(d, provider);
  const c = p ? connectionOf(d, p.id, key.slice(at + 1)) : null;
  if (!p || !c) return null;
  const users = userNames(d, c);
  const reads = p.capabilities.metrics.length ? "Deploys and usage" : "Deploys";
  const stops = users.length ? `${reads} of ${listed(users)} stop updating.` : "No part uses it, so nothing stops updating.";
  const upstream = c.method === "install" ? ` Trov also asks ${p.label} to remove its integration.`
    : c.method === "oauth" ? ` Trov also asks ${p.label} to end the grant.`
    : ` The stored ${tokenWord(p)} is erased here; delete it on ${p.label} too if you no longer need it.`;
  return {
    title: `Disconnect ${p.label}${c.scope_label ? ` for ${c.scope_label}` : ""} from ${orgName}?`,
    body: `${stops}${upstream} The parts stay, and read again once ${p.label} is connected.`,
    confirmLabel: "Disconnect", busyLabel: "Disconnecting…",
  };
}

// ── overlays ─────────────────────────────────────────────────────────────────

/** The dropdowns the open dialog shows (the part editor's host picker) — what `orgOverlays` renders the open menu from. */
export function hostingDropdowns(h: HostingUi): DropdownProps[] {
  const d = hostingData(h);
  return d && h.part ? [partProviderDropdown(h.part, d)] : [];
}

/** The Hosting tab's open dialog, if any (one at a time). */
export function hostingOverlay(h: HostingUi, dd: DropdownUi = initialDropdownUi()): string {
  const d = hostingData(h);
  if (!d) return "";
  if (h.token) return tokenModal(d, h.token);
  if (h.connect) return connectModal(d, h.connect);
  if (h.part) return partEditorModal(d, h.part, h, dd);
  return "";
}
