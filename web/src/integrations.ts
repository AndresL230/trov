// Org settings › Integrations — the org's credentials (canopy-multitenancy.md §8.7).
//
// Every integration the org is EXPECTED to have is listed, set or not, grouped: GitHub
// (the token, one webhook secret per repository), Cloudflare, then one group per
// environment (Railway, app metrics). The tab reads top-down as a summary: a lead line
// (how many are set, how many have an error), then per group a list of ROWS that each show
// a name, its status in words and ONE action — Set while it has no value, Test once it
// does. A row opens (org-ui.ts `openRow`) to the rest: what the credential is for, who set
// it and when, its settings, its webhook URL, and Edit settings / Rotate / Delete. A last
// error and a test's answer show without opening it. The org's encryption key and the
// history are two more rows at the foot, not sections of their own.
//
// THE RULE OF THIS FILE: a secret's value is never in the markup. The API is write-only, so
// nothing here could show a stored one; and the value being typed is not in the props either
// — `SecretFormState` carries only `hasValue`. The password input is rendered with NO `value`
// attribute; org-actions.ts keeps the draft in a private variable, puts it back on the live
// input after each paint, and drops it on save and on close. After a save the screen can
// show the last four characters (`hint_last4`, from the server) and nothing else.
//
// Pure: props in, markup out. Acts are dispatched in main.ts to org-actions.ts.

import { esc, attr, relTime, surface } from "./ui";
import {
  O_LABEL, O_FIELD, O_HELP, O_ERR, accentBtn, quietBtn, dangerLink, goLink, orgHead, orgEmpty, orgBanner, roleAtLeast, sliceNote, textField,
  tabLead, leadFlag, openRow, chip,
} from "./org-ui";
import type { MyOrg } from "@shared/orgs";
import type { IntegrationDTO, IntegrationKind, OrgAuditDTO } from "@shared/integrations";
import type { OrgUi } from "./org-settings";

// ── state shapes ─────────────────────────────────────────────────────────────

/** The open Set / Rotate / Edit-settings form. It never holds the secret's value. */
export interface SecretFormState {
  kind: IntegrationKind;
  scope: string;
  /** set = store a first value (with its settings); rotate = replace it; config = the non-secret settings alone. */
  mode: "set" | "rotate" | "config";
  /** The non-secret settings beside the credential (Cloudflare's Account ID). */
  config: Record<string, string>;
  /** The input holds something to save. The value itself lives only in the input. */
  hasValue: boolean;
  /** The value came from Generate (so it can be copied, and shown for a copy by hand). */
  generated: boolean;
  reveal: boolean;
  copied: "yes" | "failed" | null;
  saving: boolean;
  error: string | null;
  /** `secret`, `config.<key>`, or null for a refusal about the whole form. */
  errorField: string | null;
}

/** A Test connection in flight, or its answer (the server's scrubbed `detail`). */
export type TestState = { status: "running" } | { status: "done"; ok: boolean; detail: string };

export const integrationKey = (i: { kind: string; scope: string }): string => `${i.kind}:${i.scope}`;

// ── vocabulary ───────────────────────────────────────────────────────────────

/** The kinds whose value the admin makes up — the form offers Generate for them. */
export const GENERATED_KINDS: readonly IntegrationKind[] = ["github_webhook", "metrics_endpoint"];
/** The per-repository webhook handler is live (`POST /webhook/github/<id>`, Phase 5b): the row
 *  shows the URL to paste into GitHub and "Check deliveries" reports the last verified one.
 *  `false` was the cut-over state — the URL shown as "available soon", with nothing to check. */
export const WEBHOOKS_LIVE = true;

/** Each kind's name when the list no longer carries it (the history of a deleted one) — the catalog's own labels. */
const KIND_NAME: Record<IntegrationKind, string> = {
  github_token: "GitHub token", github_webhook: "GitHub webhook secret", cloudflare_analytics: "Cloudflare analytics",
  railway: "Railway project token", metrics_endpoint: "App metrics endpoint",
};
/** What the field holds, in the form's own words. */
const VALUE_WORD: Record<IntegrationKind, string> = {
  github_token: "Token", github_webhook: "Secret", cloudflare_analytics: "API token", railway: "Project token", metrics_endpoint: "Token",
};
/** What stops working when the credential is deleted — the confirmation's first sentence. */
export const SECRET_DELETE_EFFECT: Record<IntegrationKind, string> = {
  github_token: "Sync GitHub, the scheduled reconcile and the Repo dashboard's reads of the primary repository stop until a new token is set.",
  github_webhook: "Deliveries to this repository's webhook can no longer be verified, so they are rejected until a new secret is set.",
  cloudflare_analytics: "Requests and error rate for every environment's frontend stop updating.",
  railway: "CPU and memory for this environment's backend stop updating.",
  metrics_endpoint: "Active users and product counters for this environment stop updating.",
};

/** An integration named in a sentence: "GitHub token", "Railway project token for Staging". */
export function integrationLabel(i: Pick<IntegrationDTO, "label" | "scope_label">): string {
  return i.scope_label ? `${i.label} for ${i.scope_label}` : i.label;
}

export type IntegrationState = "unset" | "set" | "legacy" | "error" | "orphan";
/** One status per row, in words (a colour only ever repeats what the words say). */
export function integrationStatus(i: IntegrationDTO): { state: IntegrationState; word: string; tone: string } {
  if (i.configured && !i.expected) return { state: "orphan", word: "No longer used", tone: "var(--fg-55)" };
  if (i.configured && i.last_error) return { state: "error", word: "Error", tone: "var(--red)" };
  if (i.configured) return { state: "set", word: "Set", tone: "var(--green)" };
  if (i.legacy_fallback) return { state: "legacy", word: "Using legacy credential", tone: "var(--amber)" };
  return { state: "unset", word: "Not set", tone: "var(--fg-55)" };
}
/** The tab's figures: how many expected credentials are set (a legacy fallback counts as
 *  answered), how many of those report an error, and how many are stored for nothing. */
export function integrationCounts(list: IntegrationDTO[]): { expected: number; set: number; errors: number; orphans: number } {
  const expected = list.filter((i) => i.expected);
  return {
    expected: expected.length,
    set: expected.filter((i) => i.configured || i.legacy_fallback).length,
    errors: expected.filter((i) => i.configured && i.last_error).length,
    orphans: list.filter((i) => !i.expected).length,
  };
}

export interface IntegrationGroup { key: string; title: string; hint: string; rows: IntegrationDTO[] }
/** The page's groups, in order: GitHub, Cloudflare, one per environment, then stored secrets nothing claims. */
export function groupIntegrations(list: IntegrationDTO[]): IntegrationGroup[] {
  const expected = list.filter((i) => i.expected);
  const groups: IntegrationGroup[] = [
    { key: "github", title: "GitHub", hint: "Reading the primary repository, and checking each repository's webhook deliveries.", rows: expected.filter((i) => i.kind === "github_token" || i.kind === "github_webhook") },
    { key: "cloudflare", title: "Cloudflare", hint: "Requests and error rate for every environment's frontend Worker.", rows: expected.filter((i) => i.kind === "cloudflare_analytics") },
  ];
  for (const i of expected.filter((x) => x.scope_type === "environment")) {
    const key = `env:${i.scope}`;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, title: `${i.scope_label ?? i.scope} environment`, hint: "This environment's backend metrics and product counters.", rows: [] }; groups.push(g); }
    g.rows.push(i);
  }
  const orphans = list.filter((i) => !i.expected);
  if (orphans.length) groups.push({ key: "orphans", title: "No longer used", hint: "Stored for an environment or repository that is gone. Each can only be deleted.", rows: orphans });
  return groups.filter((g) => g.rows.length > 0);
}

// ── a row ────────────────────────────────────────────────────────────────────

const OK_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M20 6 9 17l-5-5"></path></svg>`;
const FAIL_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--red)" stroke-width="2.4" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:2px"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;
const box = (tone: string) => `margin-top:10px;border:1px solid color-mix(in srgb,${tone} 40%,transparent);background:color-mix(in srgb,${tone} 7%,transparent);border-radius:8px;padding:9px 11px;display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.5;color:var(--fg-70)`;

const WAIT_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:2px"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>`;
/** A test's answer. A webhook secret has nothing to call: its "test" reports the last delivery
 *  GitHub signed with it, so "none yet" is something to wait for (amber), not a failure (red). */
function testResult(t: TestState | undefined, kind: IntegrationKind): string {
  if (!t || t.status === "running") return "";
  const hook = kind === "github_webhook";
  const tone = t.ok ? "var(--green)" : hook ? "var(--amber)" : "var(--red)";
  const title = hook ? (t.ok ? "Deliveries are arriving." : "Nothing has arrived yet.") : t.ok ? "Connection works." : "Test failed.";
  return `<div role="status" aria-live="polite" data-org-test="${t.ok ? "ok" : hook ? "waiting" : "failed"}" style="${box(tone)}">
    ${t.ok ? OK_ICON : hook ? WAIT_ICON : FAIL_ICON}
    <div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">${title}</strong> ${esc(t.detail)}</div>
  </div>`;
}

export interface RowOpts { secretsAvailable: boolean; test?: TestState; open?: boolean }

export function integrationRow(i: IntegrationDTO, o: RowOpts): string {
  const st = integrationStatus(i);
  const key = integrationKey(i);
  const name = i.label;
  const full = integrationLabel(i);
  const meta: string[] = [];
  if (i.configured) {
    meta.push(`Set by ${esc(i.created_by ?? "someone")}${i.created_at ? ` ${esc(relTime(i.created_at))}` : ""}`);
    if (i.rotated_at) meta.push(`rotated ${esc(relTime(i.rotated_at))}`);
    meta.push(i.last_used_at ? `last used ${esc(relTime(i.last_used_at))}` : "not used yet");
  }
  const settings = i.config_fields.map((f) => {
    const v = i.config[f.key];
    return `<div style="margin-top:6px">${esc(f.label)}: ${v ? `<code style="font-family:var(--code);font-size:12px;color:var(--fg-70);overflow-wrap:anywhere">${esc(v)}</code>` : `<span style="color:var(--fg-40)">${st.state === "legacy" ? "the platform's, until you set your own" : `not set${f.required ? " (required)" : ""}`}</span>`}</div>`;
  }).join("");
  const legacy = st.state === "legacy"
    ? `<div data-org-legacy style="color:var(--fg-70);margin-top:6px">Using the platform's legacy credential &mdash; set your own to replace it.</div>` : "";
  const error = i.last_error
    ? `<div data-org-lasterror style="${box("var(--red)")};margin-top:0">${FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">Last error.</strong> ${esc(i.last_error)}</div></div>` : "";
  const orphan = st.state === "orphan"
    ? `<div style="margin-top:6px">Its environment or repository no longer exists, so nothing reads it. Delete it.</div>` : "";
  const hook = i.kind !== "github_webhook" || !i.webhook_url ? ""
    : WEBHOOKS_LIVE
    ? `<div data-org-hookurl style="margin-top:10px">
        <span style="${O_LABEL};font-size:10px">Webhook URL</span>
        <code class="cnpy-org-code">${esc(i.webhook_url)}</code>
        <span style="display:block;font-size:12px;color:var(--fg-40)">${i.configured ? "The Payload URL of this repository's webhook on GitHub. Every delivery must be signed with this secret; anything else is rejected." : st.state === "legacy" ? "This repository's own Payload URL. Its current GitHub webhook keeps working with the platform's credential; to move it here, set a secret, then point the webhook at this URL with the same secret." : "Set the secret first, then add a webhook on GitHub with this Payload URL and the same secret. Until then deliveries to it are rejected."}</span>
      </div>`
    : `<div style="margin-top:10px">
        <span style="${O_LABEL};font-size:10px">Webhook URL &middot; available soon</span>
        <code class="cnpy-org-code">${esc(i.webhook_url)}</code>
        <span style="display:block;font-size:12px;color:var(--fg-40)">Per-repository webhooks are not live yet. You can save the secret now; leave your GitHub webhook as it is.</span>
      </div>`;

  const off = !o.secretsAvailable;
  const why = off ? "Secrets can't be saved until the platform's encryption key is configured" : undefined;
  const testable = (i.configured || i.legacy_fallback) && i.expected && (i.kind !== "github_webhook" || WEBHOOKS_LIVE);
  const running = o.test?.status === "running";
  // A webhook secret is checked by what GitHub has delivered, not by a call Trov makes.
  const hookTest = i.kind === "github_webhook";
  const testBtn = testable ? quietBtn(running ? (hookTest ? "Checking…" : "Testing…") : hookTest ? "Check deliveries" : "Test connection", "orgSecretTest", { arg: key, disabled: off || running, busy: running, label: hookTest ? `Check deliveries for the ${full}` : `Test the ${full}`, field: `orgSecretTest:${key}`, title: why }) : "";
  // The row's ONE visible action: give it a value while it has none (the page's accent
  // button is the lead's; this one is quiet), check it once it has one.
  const setBtn = !i.configured ? quietBtn(st.state === "legacy" ? "Set your own" : "Set", "orgSecretOpen", { arg: `set:${key}`, disabled: off, label: `Set the ${full}`, field: `orgSecretOpen:set:${key}`, title: why, extra: "color:var(--fg);border-color:var(--border-strong)" }) : "";
  const lead = setBtn || testBtn;
  // Behind the row: the less-used actions, the destructive one last and as text.
  const more: string[] = [];
  if (setBtn && testBtn) more.push(testBtn);
  if (i.configured && i.expected && i.config_fields.length) more.push(quietBtn("Edit settings", "orgSecretOpen", { arg: `config:${key}`, label: `Edit the settings of the ${full}`, field: `orgSecretOpen:config:${key}` }));
  if (i.configured && i.expected) more.push(quietBtn("Rotate", "orgSecretOpen", { arg: `rotate:${key}`, disabled: off, label: `Rotate the ${full}`, field: `orgSecretOpen:rotate:${key}`, title: why }));
  if (i.configured) more.push(dangerLink("Delete", "orgConfirm", { arg: `secret:${key}`, label: `Delete the ${full}`, field: `orgConfirm:secret:${key}` }));

  const quiet = [i.hint_last4 ? `ends in ${esc(i.hint_last4)}` : "", i.configured && i.last_used_at ? `used ${esc(relTime(i.last_used_at))}` : ""].filter(Boolean).join(" &middot; ");
  const answer = testResult(o.test, i.kind);
  return openRow({
    key, open: o.open === true, act: "orgRowToggle", label: `${full}, ${st.word.toLowerCase()}`,
    // Under GITHUB a webhook secret is named by its repository; the group says the rest.
    head: `${i.kind === "github_webhook" && i.scope_label ? `<span>Webhook secret <span style="font-weight:500;color:var(--fg-55)">&middot; ${esc(i.scope_label)}</span></span>` : `<span>${esc(name)}</span>`}${chip(st.word, st.tone)}`,
    meta: quiet, action: lead,
    always: error || answer ? `${error}${answer}` : "",
    body: `<div style="max-width:680px">${esc(i.description)}</div>
      ${meta.length ? `<div style="font-size:12px;color:var(--fg-40);margin-top:6px">${meta.join(" &middot; ")}</div>` : ""}
      ${settings}${orphan}${hook}${legacy}
      ${more.length ? `<div class="cnpy-xrow-acts">${more.join("")}</div>` : ""}`,
    attrs: ` data-org-integration="${attr(key)}" data-state="${st.state}"`,
  });
}

// ── the encryption key, and the history ──────────────────────────────────────

/** The org's encryption key, as one row: its version, and (opened) what rotating does and the
 *  owner's Rotate. */
function keyRow(org: MyOrg, ui: OrgUi): string {
  const d = ui.integrations.data;
  if (!d) return "";
  const owner = org.role === "owner";
  const none = d.key_version === null;
  return openRow({
    key: "key", open: ui.openRows.includes("key"), act: "orgRowToggle", label: `Encryption key, ${none ? "not created yet" : `version ${d.key_version}`}`,
    head: `<span>Encryption key</span>`, meta: none ? "Created with the first secret" : `Version ${d.key_version}`,
    body: `<div style="max-width:680px">
        <p style="margin:0">Every secret here is encrypted with a key that belongs to this org${none ? "" : ` (now version ${d.key_version})`}. Rotating makes a new key and re-encrypts every stored secret with it. Your integrations keep working and no value is shown.</p>
        <p style="margin:6px 0 0">${none ? "There is no key yet. It is created when the first secret is saved." : "Rotate it if someone who could reach the key has left, or on whatever schedule your policy asks for."}${owner ? "" : " Only an owner can rotate it."}</p>
      </div>
      ${owner ? `<div class="cnpy-xrow-acts">${quietBtn("Rotate encryption key", "orgConfirm", { arg: "key:", disabled: none || !d.secrets_available, field: "orgConfirm:key:", title: none ? "Nothing to rotate yet" : undefined })}</div>` : ""}`,
    attrs: " data-org-key",
  });
}

const REASON: Record<string, string> = {
  repo_removed: " when its repository was removed",
  environment_deleted: " when its environment was deleted",
  api_url_changed: " when the environment's API URL moved to another host",
};
/** One history line as a sentence: who did what to which integration. Never a value — the
 *  audit row holds none; the last four characters are the most it can say. */
export function auditSentence(a: OrgAuditDTO, list: IntegrationDTO[]): string {
  const d = a.detail;
  if (a.action === "key.rotate") {
    const n = typeof d.secrets === "number" ? d.secrets : null;
    return `rotated the encryption key${typeof d.key_version === "number" ? ` to version ${d.key_version}` : ""}${n === null ? "" : ` (${n} secret${n === 1 ? "" : "s"} re-encrypted)`}`;
  }
  // Settings changes (repositories, environments): the target is the repository or the environment key.
  if (a.action === "repo.add") return `connected the repository ${a.target}${d.primary === true ? " as the primary" : ""}`;
  if (a.action === "repo.remove") return `removed the repository ${a.target}`;
  if (a.action === "repo.primary") return `made ${a.target} the primary repository`;
  if (a.action === "environment.set") return `${d.created === true ? "added" : "changed"} the ${a.target} environment`;
  if (a.action === "environment.delete") return `deleted the ${a.target} environment`;
  if (a.action === "environment.reorder") return "reordered the environments";
  const at = a.target.indexOf(":");
  const kind = at < 0 ? a.target : a.target.slice(0, at);
  const scope = at < 0 ? "" : a.target.slice(at + 1);
  const known = list.find((i) => i.kind === kind && i.scope === scope);
  const base = (KIND_NAME as Record<string, string>)[kind] ?? kind;
  // A repository's scope is its opaque hook id — never worth printing once the repo is gone.
  const what = known ? integrationLabel(known) : scope && kind !== "github_webhook" ? `${base} for ${scope}` : scope ? `${base} of a removed repository` : base;
  const hint = typeof d.hint_last4 === "string" && d.hint_last4 ? ` (ends in ${d.hint_last4})` : "";
  if (a.action === "secret.set") return `set the ${what}${hint}`;
  if (a.action === "secret.rotate") return `rotated the ${what}${hint}`;
  if (a.action === "secret.delete") return `deleted the ${what}${hint}${typeof d.reason === "string" ? REASON[d.reason] ?? "" : ""}`;
  return `changed the settings of the ${what}`;
}

const AUDIT_SHORT = 8;
/** The history, as one row: how many changes and when the last was; opened, who did what. */
function auditRow(ui: OrgUi): string {
  const rows = ui.audit.data;
  const list = ui.integrations.data?.integrations ?? [];
  const note = sliceNote(ui.audit, "the history", rows.length > 0 || ui.audit.status === "ok");
  const shown = ui.auditOpen ? rows : rows.slice(0, AUDIT_SHORT);
  const body = note ? note
    : rows.length === 0 ? `<div style="color:var(--fg-40)">Nothing yet. Every secret set, rotated or deleted is recorded here.</div>`
    : `<ol class="cnpy-org-audit" style="list-style:none;margin:0;padding:0">${shown.map((a) => `<li style="display:flex;align-items:baseline;gap:4px 14px;flex-wrap:wrap;padding:7px 0;border-top:1px solid var(--border)">
        <div style="flex:1 1 260px;min-width:0;color:var(--fg-70);overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">${esc(a.actor)}</strong> ${esc(auditSentence(a, list))}</div>
        <time datetime="${attr(a.at)}" title="${attr(a.at)}" style="flex:none;font-size:12px;color:var(--fg-40)">${esc(relTime(a.at))}</time>
      </li>`).join("")}</ol>
      ${rows.length > AUDIT_SHORT ? `<button type="button" data-act="orgAuditToggle" data-field="orgAuditToggle" aria-expanded="${ui.auditOpen}" class="cnpy-mutelink" style="margin-top:8px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55)">${ui.auditOpen ? "Show fewer" : `Show all ${rows.length}`}</button>` : ""}`;
  return openRow({
    key: "history", open: ui.openRows.includes("history"), act: "orgRowToggle", label: `History, ${rows.length} ${rows.length === 1 ? "change" : "changes"}`,
    head: `<span>History</span>`, meta: rows.length ? `${rows.length}${rows.length >= 50 ? "+" : ""} ${rows.length === 1 ? "change" : "changes"} &middot; last ${esc(relTime(rows[0].at))}` : "Nothing yet",
    body: `<div style="margin-bottom:8px">Who set, rotated or deleted what, newest first. Values are never recorded.</div>${body}`,
    attrs: " data-org-history",
  });
}

// ── the tab ──────────────────────────────────────────────────────────────────

const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";

export function integrationsTab(org: MyOrg, ui: OrgUi): string {
  if (!roleAtLeast(org.role, "admin")) return orgEmpty("Admins only", "Integrations hold the org's credentials, so only an admin or an owner can open them.");
  const d = ui.integrations.data;
  if (!d) return sliceNote(ui.integrations, "integrations", false);
  const banner = d.secrets_available ? "" : `<div style="margin-bottom:20px" data-org-unavailable>${orgBanner(
    "Secrets can't be saved yet",
    "This Trov's encryption key is not configured, so it cannot store or use a credential for any org. Ask whoever runs this Trov to set <code style=\"font-family:var(--code)\">TROV_KEK</code>, then reload this page. Nothing you set earlier is lost.",
  )}</div>`;
  const groups = groupIntegrations(d.integrations);
  const n = integrationCounts(d.integrations);
  const noRepo = ui.repos.status === "ok" && ui.repos.data.length === 0;
  const noEnv = ui.envs.status === "ok" && ui.envs.data.length === 0;
  // The lead: the state of the whole tab in one sentence. Its action is the one credential
  // nothing works without — the GitHub token — while that has no value.
  const token = d.integrations.find((i) => i.kind === "github_token" && i.expected);
  const needToken = !!token && !token.configured && !token.legacy_fallback;
  const lead = tabLead(
    `<strong>${n.set} of ${n.expected}</strong> ${n.expected === 1 ? "credential" : "credentials"} set${n.errors ? ` &middot; ${leadFlag(`${n.errors} with an error`)}` : ""}${n.orphans ? ` &middot; ${n.orphans} no longer used` : ""}. A saved value is never shown again, only its last four characters.`,
    needToken && token ? accentBtn("Set the GitHub token", "orgSecretOpen", { arg: `set:${integrationKey(token)}`, disabled: !d.secrets_available, field: "orgLeadToken", label: "Set the GitHub token" }) : "",
  );
  const sections = groups.map((g) => {
    const done = g.rows.filter((i) => i.configured || i.legacy_fallback).length;
    const extra = g.key === "github" && noRepo
      ? `<li class="cnpy-org-row" style="align-items:center"><div style="flex:1 1 260px;min-width:0;font-size:12.5px;color:var(--fg-55)">Each repository gets its own webhook secret. None is connected yet.</div><div class="cnpy-org-actions">${goLink("Connect a repository", "orgTab", "repos")}</div></li>` : "";
    return `<section aria-labelledby="org-int-${attr(g.key)}" data-org-group="${attr(g.key)}">
      ${orgHead(g.title, g.key === "orphans" ? "can only be deleted" : `${done} of ${g.rows.length} set`, null, `org-int-${g.key}`)}
      <ul${surface(LIST)}>${g.rows.map((i) => integrationRow(i, { secretsAvailable: d.secrets_available, test: ui.tests[integrationKey(i)], open: ui.openRows.includes(integrationKey(i)) })).join("")}${extra}</ul>
    </section>`;
  }).join("");
  const envHint = noEnv ? `<div style="margin-top:30px">${orgEmpty("No environment tokens yet", "Each environment gets a Railway project token and an app metrics token. Add an environment first.", quietBtn("Open Environments", "orgTab", { arg: "environments" }))}</div>` : "";
  return `${banner}${lead}${sections}${envHint}
    <section aria-labelledby="org-int-safe" data-org-group="safe">
      ${orgHead("Key and history", "", null, "org-int-safe")}
      <ul${surface(LIST)}>${keyRow(org, ui)}${auditRow(ui)}</ul>
    </section>`;
}

// ── the Set / Rotate / Edit-settings form ────────────────────────────────────

/** `how_to` as markup: escaped, with `backticked` runs as code. */
export function howToHtml(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, `<code style="font-family:var(--code);font-size:11.5px;color:var(--fg)">$1</code>`);
}

const CLOSE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"></path></svg>`;

/**
 * The focused form, as a modal (`.cnpy-cmodal`, a bottom sheet at phone width): the value
 * on the left, where to get it on the right. The password input has NO `value` attribute,
 * in any state — `data-org-secret-input` is how org-actions.ts finds the live element.
 */
export function secretFormModal(i: IntegrationDTO, f: SecretFormState): string {
  const full = integrationLabel(i);
  const word = VALUE_WORD[i.kind];
  const title = f.mode === "set" ? `Set the ${full}` : f.mode === "rotate" ? `Rotate the ${full}` : `Settings of the ${full}`;
  const canGenerate = f.mode !== "config" && GENERATED_KINDS.includes(i.kind);
  const secretErr = f.error && f.errorField === "secret" ? f.error : null;
  const formErr = f.error && (f.errorField === null || (f.errorField !== "secret" && !i.config_fields.some((c) => `config.${c.key}` === f.errorField))) ? f.error : null;

  const generated = f.generated
    ? `<div role="status" aria-live="polite" style="${box("var(--accent)")};flex-direction:column;gap:8px">
        <div><strong style="font-weight:600;color:var(--fg)">A 64-character value is in the field.</strong> Copy it now and put it where it is needed: after you save, Trov never shows it again.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${quietBtn(f.copied === "yes" ? "Copied" : "Copy value", "orgSecretCopy", { field: "orgSecretCopy", disabled: f.saving })}
          ${quietBtn(f.reveal ? "Hide" : "Show", "orgSecretReveal", { field: "orgSecretReveal", disabled: f.saving, label: f.reveal ? "Hide the generated value" : "Show the generated value" })}
          ${f.copied === "yes" ? `<span style="font-size:12px;color:var(--fg-55)">Copied to the clipboard.</span>` : ""}
        </div>
        ${f.copied === "failed" ? `<div role="alert" style="color:var(--red)">Couldn't reach the clipboard. Choose Show, then select the value and copy it yourself.</div>` : ""}
      </div>` : "";

  const secretField = f.mode === "config" ? "" : `<div class="cnpy-org-field">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
        <label for="org-secret-value" style="${O_LABEL}">${f.mode === "rotate" ? `New ${word.toLowerCase()}` : word}</label>
        ${canGenerate ? `<button type="button" data-act="orgSecretGenerate" data-field="orgSecretGenerate"${f.saving ? " disabled" : ""} class="cnpy-mutelink" style="padding:0;font-size:12px;font-weight:600;color:var(--accent)">${f.generated ? "Generate another" : "Generate"}</button>` : ""}
      </div>
      <input id="org-secret-value" data-org-secret-input data-act="orgSecretInput" data-field="orgSecretValue" data-enter="orgSecretSave" type="${f.reveal && f.generated ? "text" : "password"}" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false" data-1p-ignore data-lpignore="true"${f.saving ? " disabled" : ""}${secretErr ? ' aria-invalid="true"' : ""} aria-describedby="org-secret-h${secretErr ? " org-secret-e" : ""}" placeholder="${canGenerate ? "Paste a value, or generate one" : "Paste it here"}" class="cnpy-input" style="${O_FIELD};margin-top:7px;font-family:var(--code);font-size:12.5px;${secretErr ? "border-color:var(--red);" : ""}" />
      ${secretErr ? `<div id="org-secret-e" role="alert" style="${O_ERR}">${esc(secretErr)}</div>` : ""}
      <div id="org-secret-h" style="${O_HELP}">${f.mode === "rotate" ? `It replaces the current value${i.hint_last4 ? ` (ends in ${esc(i.hint_last4)})` : ""} the moment you save. ` : ""}Spaces around a pasted value are removed. It is encrypted before it is stored, and Trov only ever shows its last four characters.</div>
      ${generated}
    </div>`;

  const configFields = f.mode === "rotate" ? "" : i.config_fields.map((c) => `<div style="margin-top:${f.mode === "config" ? "0" : "16px"}">${textField({
    id: `org-secret-cfg-${c.key}`, label: c.label, act: "orgSecretConfig", arg: c.key, field: `orgSecretConfig:${c.key}`, value: f.config[c.key] ?? "",
    help: esc(c.description), required: c.required, disabled: f.saving, enter: "orgSecretSave", error: f.errorField === `config.${c.key}` ? f.error : null,
  })}</div>`).join("");

  const required = i.config_fields.filter((c) => c.required).every((c) => (f.config[c.key] ?? "").trim() !== "");
  const canSave = !f.saving && (f.mode === "config" ? required : f.mode === "rotate" ? f.hasValue : f.hasValue && required);
  const saveLabel = f.saving ? "Saving…" : f.mode === "set" ? `Save ${word.toLowerCase()}` : f.mode === "rotate" ? `Replace ${word.toLowerCase()}` : "Save settings";

  const soon = i.kind === "github_webhook" && !WEBHOOKS_LIVE
    ? `<div style="${box("var(--amber)")};margin:8px 0 4px"><div style="min-width:0"><strong style="font-weight:600;color:var(--fg)">The webhook URL is not live yet.</strong> Save the secret now and keep a copy of it. Leave your GitHub webhook as it is until Trov tells you the URL is ready; the steps below are for then.</div></div>` : "";
  const how = `<aside class="cnpy-org-how" aria-labelledby="org-secret-how">
      <div id="org-secret-how" style="${O_LABEL}">${f.mode === "config" ? "About these settings" : "Where to get it"}</div>
      ${soon}
      <p style="margin:8px 0 0;font-size:12.5px;line-height:1.65;color:var(--fg-70);overflow-wrap:anywhere">${howToHtml(i.how_to)}</p>
    </aside>`;

  return `<div data-overlay="org-secret" class="cnpy-cmodal">
    <div data-act="orgSecretClose" class="cnpy-cmodal-back" aria-hidden="true"></div>
    <div class="cnpy-cmodal-wrap">
      <div id="org-secret" role="dialog" aria-modal="true" aria-labelledby="org-secret-t" aria-describedby="org-secret-d" tabindex="-1" data-org-secret="${attr(f.mode)}" data-scroll-keep="org-secret" class="cnpy-surface cnpy-cmodal-box cnpy-org-secret cnpy-scroll" style="position:relative">
        <button type="button" data-act="orgSecretClose" aria-label="Close" title="Close" class="cnpy-iconbtn" style="position:absolute;top:12px;right:12px;width:28px;height:28px;display:grid;place-items:center;border-radius:7px;color:var(--fg-40)">${CLOSE}</button>
        <h2 id="org-secret-t" style="margin:0;padding-right:36px;font-size:16px;font-weight:600;letter-spacing:-0.01em;line-height:1.35;overflow-wrap:anywhere">${esc(title)}</h2>
        <p id="org-secret-d" style="margin:6px 0 0;font-size:13px;line-height:1.55;color:var(--fg-55)">${esc(i.description)}</p>
        <div class="cnpy-org-secretgrid">
          <div style="min-width:0">
            ${secretField}${configFields}
            ${formErr ? `<div role="alert" style="${O_ERR};margin-top:12px">${esc(formErr)}</div>` : ""}
            <div class="cnpy-cmodal-btns" style="display:flex;gap:8px;margin-top:20px">
              ${accentBtn(saveLabel, "orgSecretSave", { disabled: !canSave, busy: f.saving, field: "orgSecretSave", extra: "height:36px" })}
              ${quietBtn("Cancel", "orgSecretClose", { disabled: f.saving, extra: "height:36px" })}
            </div>
          </div>
          ${how}
        </div>
      </div>
    </div>
  </div>`;
}
