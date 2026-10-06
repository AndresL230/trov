// Org settings › Integrations — the org's credentials (canopy-multitenancy.md §8.7).
//
// Every integration the org is EXPECTED to have is listed, set or not, grouped: GitHub
// (the token, one webhook secret per repository), Cloudflare, then one group per
// environment (Railway, app metrics). Each row says what the credential is for, its status
// in words, who set it and when, when it was last used, and its last error — and offers
// Set / Rotate / Delete / Test connection.
//
// THE RULE OF THIS FILE: a secret's value is never in the markup. The API is write-only, so
// nothing here could show a stored one; and the value being typed is not in the props either
// — `SecretFormState` carries only `hasValue`. The password input is rendered with NO `value`
// attribute; org-actions.ts keeps the draft in a private variable, puts it back on the live
// input after each paint, and drops it on save and on close. After a save the screen can
// show the last four characters (`hint_last4`, from the server) and nothing else.
//
// Pure: props in, markup out. Acts are dispatched in main.ts to org-actions.ts.

import { esc, attr, relTime, surface, statusBadge } from "./ui";
import {
  O_LABEL, O_FIELD, O_HELP, O_ERR, accentBtn, quietBtn, dangerBtn, goLink, orgHead, orgEmpty, orgBanner, roleAtLeast, sliceNote, textField,
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
/** The per-repository webhook handler is not live yet (the routes return its URL already):
 *  the URL is shown as "available soon", nothing tells the admin to change GitHub, and there
 *  is no delivery to test. Flip this when `/webhook/github/<id>` answers. */
export const WEBHOOKS_LIVE = false;

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
  const tail = i.hint_last4 ? ` · ends in ${i.hint_last4}` : "";
  if (i.configured && !i.expected) return { state: "orphan", word: `No longer used${tail}`, tone: "var(--fg-55)" };
  if (i.configured && i.last_error) return { state: "error", word: `Error${tail}`, tone: "var(--red)" };
  if (i.configured) return { state: "set", word: `Set${tail}`, tone: "var(--green)" };
  if (i.legacy_fallback) return { state: "legacy", word: "Using legacy credential", tone: "var(--amber)" };
  return { state: "unset", word: "Not set", tone: "var(--fg-55)" };
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

function testResult(t: TestState | undefined): string {
  if (!t || t.status === "running") return "";
  return `<div role="status" aria-live="polite" data-org-test="${t.ok ? "ok" : "failed"}" style="${box(t.ok ? "var(--green)" : "var(--red)")}">
    ${t.ok ? OK_ICON : FAIL_ICON}
    <div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">${t.ok ? "Connection works." : "Test failed."}</strong> ${esc(t.detail)}</div>
  </div>`;
}

export interface RowOpts { secretsAvailable: boolean; test?: TestState }

export function integrationRow(i: IntegrationDTO, o: RowOpts): string {
  const st = integrationStatus(i);
  const key = integrationKey(i);
  const name = i.kind === "github_webhook" && i.scope_label ? `${i.label} · ${i.scope_label}` : i.label;
  const full = integrationLabel(i);
  const meta: string[] = [];
  if (i.configured) {
    meta.push(`Set by ${esc(i.created_by ?? "someone")}${i.created_at ? ` ${esc(relTime(i.created_at))}` : ""}`);
    if (i.rotated_at) meta.push(`rotated ${esc(relTime(i.rotated_at))}`);
    meta.push(i.last_used_at ? `last used ${esc(relTime(i.last_used_at))}` : "not used yet");
  }
  const settings = i.config_fields.map((f) => {
    const v = i.config[f.key];
    return `<div style="font-size:12px;color:var(--fg-55);margin-top:4px">${esc(f.label)}: ${v ? `<code style="font-family:var(--code);color:var(--fg-70);overflow-wrap:anywhere">${esc(v)}</code>` : `<span style="color:var(--fg-40)">not set${f.required ? " (required)" : ""}</span>`}</div>`;
  }).join("");
  const legacy = st.state === "legacy"
    ? `<div style="${box("var(--amber)")}"><div style="min-width:0">Using the platform's legacy credential &mdash; set your own to replace it.</div></div>` : "";
  const error = i.last_error
    ? `<div data-org-lasterror style="${box("var(--red)")}">${FAIL_ICON}<div style="min-width:0;overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">Last error.</strong> ${esc(i.last_error)}</div></div>` : "";
  const orphan = st.state === "orphan"
    ? `<div style="font-size:12px;color:var(--fg-40);margin-top:6px">Its environment or repository no longer exists, so nothing reads it. Delete it.</div>` : "";
  const hook = i.kind === "github_webhook" && i.webhook_url && !WEBHOOKS_LIVE
    ? `<div style="margin-top:8px;font-size:12px;line-height:1.5;color:var(--fg-55)">
        <span style="${O_LABEL};font-size:10px">Webhook URL &middot; available soon</span>
        <code class="cnpy-org-code">${esc(i.webhook_url)}</code>
        <span style="display:block;color:var(--fg-40)">Per-repository webhooks are not live yet. You can save the secret now; leave your GitHub webhook as it is.</span>
      </div>` : "";

  const off = !o.secretsAvailable;
  const why = off ? "Secrets can't be saved until the platform's encryption key is configured" : undefined;
  const testable = (i.configured || i.legacy_fallback) && i.expected && (i.kind !== "github_webhook" || WEBHOOKS_LIVE);
  const running = o.test?.status === "running";
  const actions: string[] = [];
  if (testable) actions.push(quietBtn(running ? "Testing…" : "Test connection", "orgSecretTest", { arg: key, disabled: off || running, busy: running, label: `Test the ${full}`, field: `orgSecretTest:${key}`, title: why }));
  if (i.configured && i.expected && i.config_fields.length) actions.push(quietBtn("Edit settings", "orgSecretOpen", { arg: `config:${key}`, label: `Edit the settings of the ${full}`, field: `orgSecretOpen:config:${key}` }));
  if (i.configured && i.expected) actions.push(quietBtn("Rotate", "orgSecretOpen", { arg: `rotate:${key}`, disabled: off, label: `Rotate the ${full}`, field: `orgSecretOpen:rotate:${key}`, title: why }));
  if (!i.configured) actions.push(accentBtn(st.state === "legacy" ? "Set your own" : "Set", "orgSecretOpen", { arg: `set:${key}`, disabled: off, label: `Set the ${full}`, field: `orgSecretOpen:set:${key}`, title: why }));
  if (i.configured) actions.push(dangerBtn("Delete", "orgConfirm", { arg: `secret:${key}`, label: `Delete the ${full}`, field: `orgConfirm:secret:${key}` }));

  return `<li class="cnpy-org-row" data-org-integration="${attr(key)}" data-state="${st.state}">
    <div style="flex:1 1 320px;min-width:0">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-size:13.5px;font-weight:600;overflow-wrap:anywhere">${esc(name)}</span>
        ${statusBadge(st.word, st.tone, "font-size:10.5px;border-radius:5px;padding:2px 7px")}
      </div>
      <div style="font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:4px;max-width:680px">${esc(i.description)}</div>
      ${meta.length ? `<div style="font-size:12px;color:var(--fg-40);margin-top:5px">${meta.join(" &middot; ")}</div>` : ""}
      ${settings}${orphan}${hook}${legacy}${error}${testResult(o.test)}
    </div>
    <div class="cnpy-org-actions">${actions.join("")}</div>
  </li>`;
}

// ── the encryption key, and the history ──────────────────────────────────────

function keySection(org: MyOrg, ui: OrgUi): string {
  const d = ui.integrations.data;
  if (!d) return "";
  const owner = org.role === "owner";
  const none = d.key_version === null;
  return `<section style="margin-top:32px" aria-labelledby="org-key-t">
    <div class="cnpy-org-head"><h2 id="org-key-t" style="margin:0;font-size:14px;font-weight:600">Encryption key</h2></div>
    <div${surface("padding:16px 18px;margin-top:10px")}>
      <div class="cnpy-org-row" style="padding:0;border:0;margin:0">
        <div style="flex:1 1 320px;min-width:0;font-size:12.5px;line-height:1.6;color:var(--fg-70);max-width:680px">
          <p style="margin:0">Every secret here is encrypted with a key that belongs to this org${none ? "" : ` (now version ${d.key_version})`}. Rotating makes a new key and re-encrypts every stored secret with it. Your integrations keep working and no value is shown.</p>
          <p style="margin:6px 0 0;color:var(--fg-55)">${none ? "There is no key yet. It is created when the first secret is saved." : "Rotate it if someone who could reach the key has left, or on whatever schedule your policy asks for."}${owner ? "" : " Only an owner can rotate it."}</p>
        </div>
        ${owner ? `<div class="cnpy-org-actions">${quietBtn("Rotate encryption key", "orgConfirm", { arg: "key:", disabled: none || !d.secrets_available, field: "orgConfirm:key:", title: none ? "Nothing to rotate yet" : undefined })}</div>` : ""}
      </div>
    </div>
  </section>`;
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
function auditSection(ui: OrgUi): string {
  const rows = ui.audit.data;
  const list = ui.integrations.data?.integrations ?? [];
  const note = sliceNote(ui.audit, "the history", rows.length > 0 || ui.audit.status === "ok");
  const shown = ui.auditOpen ? rows : rows.slice(0, AUDIT_SHORT);
  const body = note ? note
    : rows.length === 0 ? `<div style="font-size:12.5px;color:var(--fg-40);margin-top:8px">Nothing yet. Every secret set, rotated or deleted is recorded here.</div>`
    : `<ol${surface("overflow:hidden;list-style:none;margin:10px 0 0;padding:0")}>${shown.map((a) => `<li class="cnpy-org-row" style="padding-top:9px;padding-bottom:9px;align-items:baseline">
        <div style="flex:1 1 260px;min-width:0;font-size:12.5px;line-height:1.5;color:var(--fg-70);overflow-wrap:anywhere"><strong style="font-weight:600;color:var(--fg)">${esc(a.actor)}</strong> ${esc(auditSentence(a, list))}</div>
        <time datetime="${attr(a.at)}" title="${attr(a.at)}" style="flex:none;font-size:12px;color:var(--fg-40)">${esc(relTime(a.at))}</time>
      </li>`).join("")}</ol>
      ${rows.length > AUDIT_SHORT ? `<button type="button" data-act="orgAuditToggle" data-field="orgAuditToggle" aria-expanded="${ui.auditOpen}" class="cnpy-mutelink" style="margin-top:10px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55)">${ui.auditOpen ? "Show fewer" : `Show all ${rows.length}`}</button>` : ""}`;
  return `<section style="margin-top:32px" aria-labelledby="org-audit-t">
    <div class="cnpy-org-head"><h2 id="org-audit-t" style="margin:0;font-size:14px;font-weight:600">History</h2><p style="margin:3px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg-55)">Who set, rotated or deleted what, newest first. Values are never recorded.</p></div>
    ${body}
  </section>`;
}

// ── the tab ──────────────────────────────────────────────────────────────────

export function integrationsTab(org: MyOrg, ui: OrgUi): string {
  if (!roleAtLeast(org.role, "admin")) return orgEmpty("Admins only", "Integrations hold the org's credentials, so only an admin or an owner can open them.");
  const d = ui.integrations.data;
  if (!d) return sliceNote(ui.integrations, "integrations", false);
  const banner = d.secrets_available ? "" : `<div style="margin-bottom:20px" data-org-unavailable>${orgBanner(
    "Secrets can't be saved yet",
    "This Trov's encryption key is not configured, so it cannot store or use a credential for any org. Ask whoever runs this Trov to set <code style=\"font-family:var(--code)\">TROV_KEK</code>, then reload this page. Nothing you set earlier is lost.",
  )}</div>`;
  const groups = groupIntegrations(d.integrations);
  const noRepo = ui.repos.status === "ok" && ui.repos.data.length === 0;
  const noEnv = ui.envs.status === "ok" && ui.envs.data.length === 0;
  const sections = groups.map((g) => {
    const extra = g.key === "github" && noRepo
      ? `<li class="cnpy-org-row" style="align-items:center"><div style="flex:1 1 260px;min-width:0;font-size:12.5px;color:var(--fg-55)">Each repository gets its own webhook secret. None is connected yet.</div><div class="cnpy-org-actions">${goLink("Connect a repository", "orgTab", "repos")}</div></li>` : "";
    return `<section style="margin-bottom:26px" aria-labelledby="org-int-${attr(g.key)}">
      <div class="cnpy-org-head"><h2 id="org-int-${attr(g.key)}" style="margin:0;font-size:14px;font-weight:600">${esc(g.title)}</h2><p style="margin:3px 0 0;font-size:12.5px;line-height:1.5;color:var(--fg-55)">${esc(g.hint)}</p></div>
      <ul${surface("overflow:hidden;list-style:none;margin:10px 0 0;padding:0")}>${g.rows.map((i) => integrationRow(i, { secretsAvailable: d.secrets_available, test: ui.tests[integrationKey(i)] })).join("")}${extra}</ul>
    </section>`;
  }).join("");
  const envHint = noEnv ? `<div style="margin-bottom:26px">${orgEmpty("No environment tokens yet", "Each environment gets a Railway project token and an app metrics token. Add an environment first.", quietBtn("Open Environments", "orgTab", { arg: "environments" }))}</div>` : "";
  return `${banner}${sections}${envHint}${keySection(org, ui)}${auditSection(ui)}`;
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
