// Org settings › Hosting — the controller behind web/src/hosting.ts: every `orgHx…` act (org-actions.ts hands
// them over), the one read (`GET /api/o/:slug/hosting`) and the writes behind the part editor, the connect
// flow, Test connection, Disconnect and Remove.
//
// A TOKEN'S VALUE lives in exactly two places, and only while its form is open: the live <input>, and
// `secretDraft` below — a private variable, never a field of AppState (the rule of org-actions.ts). It is put
// back on the input after a repaint and dropped on save, on close and on leaving the tab. It never reaches the
// URL, localStorage, a toast or a log line. The part editor's app metrics token follows the same rule
// (`metricsDraft`).
//
// "Preview with sample data" (web/src/hosting-sample.ts, a dynamic import — never in the main bundle) shows
// every state of the tab without a provider credential. While it is on NOTHING is sent: a save, a connect, a
// test and a disconnect each answer from the sample and say so.

import type { AppState } from "./render";
import {
  ApiError, OrgApiError, Unauthorized, rateLimitText,
  deleteEnvironmentPart, disconnectHosting, getHostingSetup, putEnvironmentPart, putOrgIntegrationConfig, removeHostingLeftovers, rotateOrgIntegration, setOrgIntegration,
  startHostingConnect, testHosting, testOrgIntegration,
} from "./api";
import { notConnectedSentence } from "@shared/hosting-status-core";
import { currentOrg, effectiveOrgTab, roleAtLeast } from "./org-settings";
import {
  bestMethod, connKey, connectionOf, draftKey, fieldOptions, hostingData, isHostingSampleKey, isHostingStackKey, leftoversOf, partDraftProblems, providerOf, providerStatusOf, scopeFor,
  tokenFormOk, tokenMethod, tokenWord, type HostingUi, type PartDraft,
} from "./hosting";
import {
  HOSTING_INTEGRATION_KIND, isHostingProvider, isPartRole,
  type EnvironmentPartDTO, type HostingConnectionDTO, type HostingProviderDTO, type HostingProviderId, type HostingSetupDTO, type PartWrite,
} from "@shared/hosting";

export interface HostingHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  unauth(e: unknown): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** What else on Org settings a hosting write changed: the environments, the
   *  Integrations list (a hosting credential is one of its rows) and the history. */
  reloadSettings(): void;
  /** Leave for the provider (a full navigation). Injected so a test can watch it. */
  go?(url: string): void;
}

export interface HostingActions {
  /** Run one `orgHx…` act; false when the act is not one of them. */
  act(name: string, arg: string | null, value: string | null): boolean;
  /** Read (or refresh) the org's Hosting setup. */
  load(): void;
  /** The confirmation modal said yes: remove a part (`part`, arg `<env>/<part>`), disconnect (`hosting`, arg
   *  `<provider>:<scope>`) or remove a provider's old per-environment tokens (`leftovers`, arg `<provider>`). */
  runConfirm(what: "part" | "hosting" | "leftovers", arg: string, done: (msg: string, ms?: number) => void, failed: (e: unknown, fallback: string) => void): void;
  afterPaint(): void;
}

const DISMISS_KEY = (slug: string): string => `trov.hosting.dismissed.${slug}`;
const SAMPLE_SAYS = "Sample data: nothing was sent or saved.";

const sentence = (s: string): string => {
  const t = s.trim();
  return t ? `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}` : t;
};

/** A hosting refusal as words that say what to do next. `detail` is the server's own sentence (it names a rule, never a submitted value). */
export function hostingErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  const limited = rateLimitText(e);
  if (limited) return limited;
  const detail = e instanceof OrgApiError ? e.detail : null;
  switch (e.message) {
    case "forbidden": return "Only an admin or an owner of this organization can change its hosting.";
    case "secrets_unavailable": return "Credentials can't be saved right now: the platform key is missing. Ask whoever runs this Trov, then try again.";
    case "too_many_parts": return "This environment already has 6 parts, the most one can have. Remove one first.";
    case "part_conflict": return detail ? sentence(detail) : "That key belongs to this environment's Cloudflare or Railway part.";
    case "not_found": return "That no longer exists. Reload the page.";
    case "not_connected": return "It is no longer connected here. Reload the page.";
    case "not_available": case "not_installable": case "not_configured": return detail ? sentence(detail) : "This Trov can't connect that host this way. Paste a token instead.";
    case "already_configured": return "A credential is already stored. Close this form and choose Rotate to replace it.";
    case "internal": return `${fallback} Something went wrong on the server. Try again in a minute.`;
    default: return detail ? sentence(detail) : `${fallback} Try again.`;
  }
}

export function createHostingActions(host: HostingHost): HostingActions {
  const { state, mount } = host;
  const h = (): HostingUi => state.org.hosting;
  const org = () => currentOrg(state);
  const admin = (): boolean => roleAtLeast(org()?.role, "admin");
  const data = (): HostingSetupDTO | null => hostingData(h());
  const rerender = (): void => host.rerender();
  const fail = (e: unknown): boolean => { if (e instanceof Unauthorized) { host.unauth(e); return true; } return false; };
  const go = (url: string): void => { if (host.go) host.go(url); else window.location.assign(url); };

  // ── the token drafts (see the header) ──────────────────────────────────────
  let secretDraft = "";
  /** The part editor's app metrics token, while it is open. Never in AppState. */
  let metricsDraft = "";
  const dropMetrics = (): void => {
    metricsDraft = "";
    const el = mount.querySelector<HTMLInputElement>("[data-hx-metrics-input]");
    if (el) el.value = "";
  };
  /** The `data-field` of the control that opened the dialog on screen, so focus returns to it. */
  let trigger: string | null = null;
  const dropSecret = (): void => {
    secretDraft = "";
    const el = mount.querySelector<HTMLInputElement>("[data-hx-secret-input]");
    if (el) el.value = "";
  };
  const refocus = (): void => {
    const field = trigger;
    trigger = null;
    if (field) mount.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`)?.focus();
  };
  const focusDialog = (): void => {
    mount.querySelector<HTMLElement>("[data-hx-dialog] input:not([disabled]), [data-hx-dialog] .cnpy-dd:not([disabled])")?.focus();
  };
  const activeField = (): string | null => (document.activeElement as HTMLElement | null)?.getAttribute?.("data-field") ?? null;
  const closeDialogs = (): void => { dropSecret(); dropMetrics(); const u = h(); u.part = null; u.connect = null; u.token = null; u.manage = null; };

  // ── the read ───────────────────────────────────────────────────────────────
  function load(): void {
    const o = org();
    const slug = state.org.slug;
    if (!o || !slug || !admin()) return;
    const u = h();
    try {
      const raw = JSON.parse(localStorage.getItem(DISMISS_KEY(slug)) ?? "[]") as unknown;
      u.dismissed = Array.isArray(raw) ? raw.filter(isHostingProvider) : [];
    } catch { /* no storage: nothing was dismissed */ }
    const held = u.setup.data;
    if (u.setup.status !== "ok") u.setup = { status: "loading", data: held };
    getHostingSetup(slug)
      .then((setup) => { if (state.org.slug !== slug) return; h().setup = { status: "ok", data: setup }; rerender(); })
      .catch((e) => {
        if (fail(e) || state.org.slug !== slug) return;
        h().setup = { status: "error", data: held, error: e instanceof Error ? e.message : String(e) };
        rerender();
      });
  }

  // ── sample data ────────────────────────────────────────────────────────────
  function sample(arg: string | null): void {
    const u = h();
    closeDialogs();
    u.tests = {};
    if (!isHostingSampleKey(arg)) { u.sample = null; u.sampleData = null; rerender(); return; }
    u.sample = arg;
    u.sampleData = null;
    rerender();
    void import("./hosting-sample").then((m) => {
      if (h().sample !== arg) return; // picked another, or went back to live data, mid-flight
      // A copy: nothing done to the preview may reach the module's own constants.
      h().sampleData = m.hostingScenario(arg, h().sampleStack);
      rerender();
    }).catch(() => { if (h().sample === arg) { h().sample = null; host.flash("Couldn't load the sample data."); } });
  }

  // ── the part editor ────────────────────────────────────────────────────────
  /** A key to start from, when it is free in the environment: `web` for a web part, `api` for a service. */
  const suggestKey = (d: HostingSetupDTO, env: string, p: HostingProviderDTO | null, role: string): string => {
    if (!p) return "";
    const want = role === "service" ? "api" : "web";
    return d.environments.find((e) => e.key === env)?.parts.some((x) => x.key === want) ? "" : want;
  };
  function openPart(draft: PartDraft): void {
    closeDialogs();
    trigger = activeField();
    state.org.confirm = null;
    h().part = draft;
    rerender();
    focusDialog();
  }
  function newPart(arg: string): void {
    const d = data();
    const [env, pick] = arg.split("|");
    if (!d || !d.environments.some((e) => e.key === env)) return;
    const p = providerOf(d, isHostingProvider(pick) ? pick : null);
    const role = p?.roles[0] ?? "web";
    openPart({ env, key: null, keyDraft: suggestKey(d, env, p, role), label: "", provider: p?.id ?? null, role, settings: {}, saving: false, error: null, errorField: null });
  }
  function editPart(ref: string): void {
    const d = data();
    const at = ref.indexOf("/");
    const part = d?.environments.find((e) => e.key === ref.slice(0, at))?.parts.find((p) => p.key === ref.slice(at + 1));
    if (!d || !part) return;
    openPart({ env: part.env, key: part.key, keyDraft: part.key, label: part.label, provider: part.provider, role: part.role, settings: { ...part.settings }, saving: false, error: null, errorField: null });
  }
  const clearError = (dr: PartDraft, field: string): void => { if (dr.errorField === field || dr.errorField === null) { dr.error = null; dr.errorField = null; } };

  function savePart(thenConnect: boolean): void {
    const o = org();
    const u = h();
    const d = data();
    const dr = u.part;
    if (!o || !d || !dr || dr.saving) return;
    const p = providerOf(d, dr.provider);
    if (!p || Object.keys(partDraftProblems(dr, d)).length) return;
    const key = draftKey(dr, p);
    const envLabel = d.environments.find((e) => e.key === dr.env)?.label ?? dr.env;
    const settings: Record<string, string> = {};
    for (const f of p.part_settings) { const v = (dr.settings[f.key] ?? "").trim(); if (v) settings[f.key] = v; }
    const body: PartWrite = { provider: p.id, role: dr.role, settings, ...(dr.label.trim() ? { label: dr.label.trim() } : {}) };
    // The app metrics token, when one was typed: the environment's own (`metrics_endpoint`, scoped to it), written
    // through the same write-only Integrations API it always was — replaced when one is stored already.
    const metrics = metricsDraft.trim();
    const stored = d.environments.find((e) => e.key === dr.env)?.app_metrics?.configured === true;
    const after = (part: Pick<EnvironmentPartDTO, "label">, created: boolean): void => {
      dropMetrics();
      u.part = null;
      host.flash(`${created ? "Added" : "Saved"} ${envLabel} › ${part.label}${metrics ? ", and its app metrics token" : ""}`);
      refocus();
      if (thenConnect) openConnect(p.id, scopeFor(p, dr.env));
    };
    if (u.sample) { after({ label: dr.label.trim() || key }, dr.key === null); host.flash(SAMPLE_SAYS); rerender(); return; }
    dr.saving = true; dr.error = null; dr.errorField = null;
    rerender();
    const rotate = (): Promise<unknown> => rotateOrgIntegration(o.slug, "metrics_endpoint", dr.env, metrics);
    const saveMetrics = (): Promise<unknown> => !metrics ? Promise.resolve()
      : stored ? rotate()
      : setOrgIntegration(o.slug, "metrics_endpoint", dr.env, metrics).catch((e) => { if (e instanceof ApiError && e.message === "already_configured") return rotate(); throw e; });
    putEnvironmentPart(o.slug, dr.env, key, body)
      .then((r) => saveMetrics()
        .then(() => { after(r.part, r.created); rerender(); load(); host.reloadSettings(); })
        .catch((e) => {
          // The part is saved; the token is not. The editor stays open on the token, now editing the stored part.
          dr.saving = false;
          dr.key = key;
          if (fail(e)) return;
          dr.errorField = "metrics";
          dr.error = e instanceof OrgApiError && e.message === "invalid_secret" && e.detail ? sentence(e.detail.replace(/^secret\b/, "The token"))
            : hostingErrorText(e, "The part is saved, but its app metrics token is not.");
          rerender(); load(); host.reloadSettings();
        }))
      .catch((e) => {
        dr.saving = false;
        if (fail(e)) return;
        const field = e instanceof OrgApiError ? e.field : null;
        const mine = field !== null && (["provider", "part", "label", "role"].includes(field) || p.part_settings.some((f) => `settings.${f.key}` === field));
        dr.errorField = mine ? (field === "role" ? null : field) : null;
        // The server names the field by its key (`settings.project must be …`): say it with the form's own label.
        const label = field?.startsWith("settings.") ? p.part_settings.find((f) => `settings.${f.key}` === field)?.label ?? null : field === "part" ? "The key" : null;
        dr.error = e instanceof OrgApiError && e.message === "invalid" && e.detail
          ? sentence(label && field ? e.detail.replace(new RegExp(`^${field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b:?\\s*`), `${label} `) : e.detail)
          : hostingErrorText(e, "Couldn't save the part.");
        rerender();
      });
  }

  // ── connecting ─────────────────────────────────────────────────────────────
  /** Connect a provider by its best available method: an install / OAuth confirmation, else the token form. */
  function openConnect(provider: HostingProviderId, scope: string): void {
    const d = data();
    const p = d ? providerOf(d, provider) : null;
    const m = p ? bestMethod(p) : null;
    if (!d || !p || !m) return;
    if (m.method === "install" || m.method === "oauth") {
      closeDialogs();
      trigger = trigger ?? activeField();
      state.org.confirm = null;
      h().connect = { provider, busy: false, error: null };
      rerender();
      mount.querySelector<HTMLElement>('[data-field="orgHxConnectGo"]')?.focus();
      return;
    }
    const c = connectionOf(d, provider, scope);
    openToken(c && (c.status === "connected" || c.status === "error") ? "rotate" : "set", provider, scope);
  }
  function startConnect(): void {
    const o = org();
    const u = h();
    const cd = u.connect;
    if (!o || !cd || cd.busy) return;
    if (u.sample) { cd.error = "Sample data: this is where your browser would leave for the provider. Nothing was sent."; rerender(); return; }
    cd.busy = true; cd.error = null;
    rerender();
    startHostingConnect(o.slug, cd.provider)
      .then((r) => { go(r.url); })   // a full navigation: the page is gone; `busy` stays so nothing is pressed twice
      .catch((e) => {
        cd.busy = false;
        if (fail(e)) return;
        cd.error = hostingErrorText(e, "Couldn't start the connection.");
        rerender();
        if (e instanceof ApiError && e.status === 409) load(); // the method is no longer offered: the catalogue says so
      });
  }

  function openToken(mode: string, provider: HostingProviderId, scope: string): void {
    const d = data();
    const p = d ? providerOf(d, provider) : null;
    if (!d || !p || !tokenMethod(p) || (mode !== "set" && mode !== "rotate" && mode !== "config")) return;
    if (mode === "config" && !p.org_config_fields.length) return;
    const c = connectionOf(d, provider, scope);
    const keep = trigger;
    closeDialogs();
    trigger = keep ?? activeField();
    state.org.confirm = null;
    h().token = { provider, scope, mode, config: { ...(c?.config ?? {}) }, hasValue: false, saving: false, error: null, errorField: null };
    rerender();
    focusDialog();
  }
  function saveToken(): void {
    const o = org();
    const u = h();
    const d = data();
    const f = u.token;
    const p = d && f ? providerOf(d, f.provider) : null;
    if (!o || !d || !f || !p || !tokenFormOk(p, f)) return;
    if (f.mode !== "config" && secretDraft.trim() === "") return;
    const kind = HOSTING_INTEGRATION_KIND[p.id];
    const word = tokenWord(p);
    const ck = connKey(f);
    const config: Record<string, string> = {};
    for (const c of p.org_config_fields) { const v = (f.config[c.key] ?? "").trim(); if (v) config[c.key] = v; }
    const hasConfig = p.org_config_fields.length > 0;
    const mode = f.mode;
    const saved = (): void => {
      dropSecret();                 // gone from the variable and from the live input
      u.token = null;
      delete u.tests[ck];
      if (!state.org.openRows.includes(`hx:${ck}`)) state.org.openRows = [...state.org.openRows, `hx:${ck}`];
      host.flash(mode === "config" ? `Saved the ${p.label} settings` : `${mode === "rotate" ? "Replaced" : "Saved"} the ${p.label} ${word}. Test the connection to check it.`, mode === "config" ? 2200 : 6000);
      u.manage = mode === "config" ? u.manage : ck;   // back in its Manage dialog, on Test connection
      trigger = `orgHxTest:${ck}`;   // straight to Test connection, the next thing to do
      rerender();
      refocus();
    };
    if (u.sample) { saved(); host.flash(SAMPLE_SAYS); return; }
    f.saving = true; f.error = null; f.errorField = null;
    rerender();
    const value = secretDraft.trim(); // trimmed here, once; the server refuses surrounding whitespace rather than guess
    // A credential already stored (an install, an older token) is REPLACED, never set over: `set` answers
    // `already_configured`, so a stale form falls back to the same rotate the Rotate button makes.
    const rotate = (): Promise<unknown> => rotateOrgIntegration(o.slug, kind, f.scope, value)
      .then(() => (hasConfig && mode === "set" ? putOrgIntegrationConfig(o.slug, kind, f.scope, config) : undefined));
    const write: Promise<unknown> = mode === "config" ? putOrgIntegrationConfig(o.slug, kind, f.scope, config)
      : mode === "rotate" ? rotate()
      : setOrgIntegration(o.slug, kind, f.scope, value, hasConfig ? config : undefined)
        .catch((e) => { if (e instanceof ApiError && e.message === "already_configured") return rotate(); throw e; });
    write
      .then(() => { saved(); load(); host.reloadSettings(); })
      .catch((e) => {
        f.saving = false;
        if (fail(e)) return;
        const field = e instanceof OrgApiError ? e.field : null;
        f.errorField = field === "secret" || (field?.startsWith("config.") ?? false) ? field : null;
        f.error = e instanceof ApiError && e.message === "invalid_secret" && e instanceof OrgApiError && e.detail ? sentence(e.detail.replace(/^secret\b/, "The value"))
          : e instanceof ApiError && e.message === "invalid_config" && e instanceof OrgApiError && e.detail ? sentence(p.org_config_fields.reduce((t, c) => t.replace(new RegExp(`^${c.key}\\b`), c.label), e.detail))
          : hostingErrorText(e, "Couldn't save it.");
        rerender();
      });
  }

  // ── Test connection ────────────────────────────────────────────────────────
  /** Put a connection the server just described back into the payload on screen. */
  const adopt = (c: HostingConnectionDTO): void => {
    const d = h().setup.data;
    if (!d) return;
    const at = d.connections.findIndex((x) => x.provider === c.provider && x.scope === c.scope);
    if (at >= 0) d.connections[at] = c; else d.connections.push(c);
  };
  function test(key: string, provider: HostingProviderId, target: { scope?: string; env?: string; part?: string }): void {
    const o = org();
    const u = h();
    const d = data();
    if (!o || !d || u.tests[key]?.status === "running") return;
    const p = providerOf(d, provider);
    if (!p) return;
    // Not connected (THE status function — what its card and its parts say): nothing is sent; the answer says so.
    if (!providerStatusOf(d, provider).live) {
      u.tests[key] = { status: "done", ok: false, detail: notConnectedSentence(p.label) };
      rerender();
      return;
    }
    if (u.sample) {
      const c = connectionOf(d, provider, target.scope ?? "");
      u.tests[key] = { status: "running" };
      rerender();
      void import("./hosting-sample").then((m) => {
        const ok = !!c && c.status === "connected";
        u.tests[key] = { status: "done", ok, detail: ok ? (provider === "fly" ? m.HOSTING_SAMPLE_TEST_OK.detail : `${p.label} answered.`) : m.HOSTING_SAMPLE_TEST_FAILED.detail };
        rerender();
      });
      return;
    }
    u.tests[key] = { status: "running" };
    rerender();
    testHosting(o.slug, provider, target)
      .then((r) => { u.tests[key] = { status: "done", ok: r.ok, detail: r.detail }; adopt(r.connection); rerender(); load(); })
      .catch((e) => {
        if (fail(e)) { delete u.tests[key]; return; }
        u.tests[key] = { status: "done", ok: false, detail: hostingErrorText(e, "The test could not run.") };
        rerender();
      });
  }

  /** An environment's app metrics token, tested from the part editor (the Integrations test — it records its outcome). */
  function testMetrics(envKey: string): void {
    const o = org();
    const u = h();
    const d = data();
    const key = `metrics:${envKey}`;
    if (!o || !d || u.tests[key]?.status === "running" || !d.environments.some((e) => e.key === envKey)) return;
    if (u.sample) { u.tests[key] = { status: "done", ok: true, detail: "The metrics endpoint answered with active users. (Sample data: nothing was sent.)" }; rerender(); return; }
    u.tests[key] = { status: "running" };
    rerender();
    testOrgIntegration(o.slug, "metrics_endpoint", envKey)
      .then((r) => { u.tests[key] = { status: "done", ok: r.ok, detail: r.detail }; rerender(); load(); host.reloadSettings(); })
      .catch((e) => {
        if (fail(e)) { delete u.tests[key]; return; }
        u.tests[key] = { status: "done", ok: false, detail: hostingErrorText(e, "The test could not run.") };
        rerender();
      });
  }

  // ── confirmations (the shared modal: org-settings.ts `orgConfirmCopy`) ──────
  function runConfirm(what: "part" | "hosting" | "leftovers", arg: string, done: (msg: string, ms?: number) => void, failed: (e: unknown, fallback: string) => void): void {
    const o = org();
    const u = h();
    const d = data();
    if (!o || !d) { done(""); return; }
    if (what === "leftovers") {
      if (!isHostingProvider(arg)) { done(""); return; }
      const label = providerOf(d, arg)?.label ?? arg;
      const n = leftoversOf(d, arg).length;
      if (u.sample) { done(SAMPLE_SAYS); return; }
      removeHostingLeftovers(o.slug, arg)
        .then((r) => {
          adopt(r.connection);
          done(`Removed ${r.removed === 1 ? "the old" : `${r.removed} old`} ${label} ${r.removed === 1 ? "token" : "tokens"}`);
          load(); host.reloadSettings();
        })
        .catch((e) => { failed(e, `Couldn't remove the old ${label} ${n === 1 ? "token" : "tokens"}.`); load(); });
      return;
    }
    if (what === "part") {
      const at = arg.indexOf("/");
      const envKey = arg.slice(0, at), partKey = arg.slice(at + 1);
      const env = d.environments.find((e) => e.key === envKey);
      const name = `${env?.label ?? envKey} › ${env?.parts.find((p) => p.key === partKey)?.label ?? partKey}`;
      if (u.sample) { u.part = null; done(SAMPLE_SAYS); return; }
      deleteEnvironmentPart(o.slug, envKey, partKey)
        .then(() => {
          u.part = null;
          delete u.tests[`part:${arg}`];
          done(`Removed ${name}`);
          load(); host.reloadSettings();
        })
        .catch((e) => { failed(e, `Couldn't remove ${name}.`); load(); });
      return;
    }
    const at = arg.indexOf(":");
    const provider = arg.slice(0, at), scope = arg.slice(at + 1);
    if (!isHostingProvider(provider)) { done(""); return; }
    const p = providerOf(d, provider);
    const label = p?.label ?? provider;
    const before = connectionOf(d, provider, scope);
    if (u.sample) { done(SAMPLE_SAYS); return; }
    disconnectHosting(o.slug, provider, scope)
      .then((r) => {
        adopt(r.connection);
        delete u.tests[arg];
        // `upstream` says whether the provider's side went too: said only when there is something left to do there.
        if (r.upstream === "failed") done(`Trov forgot the credential, but ${label} did not confirm removing the ${before?.method === "oauth" ? "grant" : "integration"}. Remove it on ${label} yourself.`, 9000);
        else if (r.upstream === "none") done(`Disconnected ${label}. Also delete the ${p ? tokenWord(p) : "token"} on ${label} if you no longer need it.`, 7000);
        else done(`Disconnected ${label}`);
        load(); host.reloadSettings();
      })
      .catch((e) => { failed(e, `Couldn't disconnect ${label}.`); load(); });
  }

  // ── acts ───────────────────────────────────────────────────────────────────
  function act(name: string, arg: string | null, value: string | null): boolean {
    // Disconnect asks the page's confirmation (org-actions.ts handles it): the Manage dialog closes under it.
    if (name === "orgConfirm" && /^(?:hosting|leftovers):/.test(arg ?? "")) h().manage = null;
    if (!name.startsWith("orgHx")) return false;
    const u = h();
    if (!admin()) return true;
    const d = data();
    const dr = u.part;
    switch (name) {
      case "orgHxReload": load(); break;
      case "orgHxSample": sample(arg); return true;
      // The sample's second switcher: the same flow, on another stack.
      case "orgHxSampleStack": if (isHostingStackKey(value) && u.sample) { u.sampleStack = value; sample(u.sample); } return true;
      case "orgHxNoticeClose": u.notice = null; break;
      case "orgHxDoneToggle": u.doneOpen = !u.doneOpen; break;
      case "orgHxDetectDismiss":
        if (isHostingProvider(arg) && !u.dismissed.includes(arg)) {
          u.dismissed = [...u.dismissed, arg];
          try { if (state.org.slug && !u.sample) localStorage.setItem(DISMISS_KEY(state.org.slug), JSON.stringify(u.dismissed)); } catch { /* this session only */ }
        }
        break;

      // The part editor
      case "orgHxPartNew": if (arg) newPart(arg); return true;
      case "orgHxPartEdit": if (arg) editPart(arg); return true;
      case "orgHxPartClose": if (dr && !dr.saving) { dropMetrics(); u.part = null; rerender(); refocus(); } return true;
      case "orgHxPartProvider": {
        const p = d && isHostingProvider(value) ? providerOf(d, value) : null;
        if (!dr || !d || !p || p.status !== "available" || dr.saving) return true;
        const was = suggestKey(d, dr.env, providerOf(d, dr.provider), dr.role);
        dr.provider = p.id;
        dr.role = p.roles.includes(dr.role) ? dr.role : p.roles[0];
        dr.settings = {};
        // A suggested key follows the pick; a typed one is the person's.
        if (dr.key === null && (dr.keyDraft === "" || dr.keyDraft === was)) dr.keyDraft = suggestKey(d, dr.env, p, dr.role);
        dr.error = null; dr.errorField = null;
        break;
      }
      case "orgHxPartRole": if (dr && isPartRole(arg) && !dr.saving) { dr.role = arg; clearError(dr, "role"); } break;
      case "orgHxPartKey": if (dr && dr.key === null) { dr.keyDraft = value ?? ""; clearError(dr, "part"); } break;
      case "orgHxPartLabel": if (dr) { dr.label = value ?? ""; clearError(dr, "label"); } break;
      case "orgHxPartSetting": if (dr && arg) { dr.settings[arg] = value ?? ""; clearError(dr, `settings.${arg}`); } break;
      case "orgHxPartPick": {
        // `<key>=<option>` from a setting drawn as a switch: only an option its own pattern lists.
        const at = (arg ?? "").indexOf("=");
        const key = (arg ?? "").slice(0, at), opt = (arg ?? "").slice(at + 1);
        const f = d && dr ? providerOf(d, dr.provider)?.part_settings.find((x) => x.key === key) : null;
        if (!dr || !f || dr.saving || !(fieldOptions(f) ?? []).includes(opt)) return true;
        dr.settings[key] = opt;
        clearError(dr, `settings.${key}`);
        break;
      }
      case "orgHxPartSave": savePart(arg === "connect"); return true;
      // The part editor's app metrics token: the value stays in `metricsDraft` (see the header), never in AppState.
      case "orgHxPartMetrics": {
        if (!dr) return true;
        metricsDraft = value ?? "";
        const has = metricsDraft.trim() !== "";
        const changed = has !== (dr.metricsHasValue ?? false) || dr.errorField === "metrics";
        dr.metricsHasValue = has;
        if (dr.errorField === "metrics") { dr.error = null; dr.errorField = null; }
        if (changed) rerender();
        return true;
      }
      case "orgHxMetricsTest": if (arg) testMetrics(arg); return true;
      case "orgHxMetricsDelete": {
        // The page's confirmation, as Integrations' Delete was (org-actions.ts runs it, and reloads this tab).
        if (!arg || !d?.environments.some((e) => e.key === arg)) return true;
        if (u.sample) { host.flash(SAMPLE_SAYS); return true; }
        state.org.confirm = { what: "secret", arg: `metrics_endpoint:${arg}`, busy: false };
        rerender();
        mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        return true;
      }

      // Connecting
      case "orgHxConnect": {
        const at = (arg ?? "").indexOf(":");
        const provider = (arg ?? "").slice(0, at);
        if (at > 0 && isHostingProvider(provider) && d?.secrets_available) { trigger = null; openConnect(provider, (arg ?? "").slice(at + 1)); }
        return true;
      }
      // A connected card's Manage dialog: everything that is not on the card, and every action on it.
      case "orgHxManage": if (arg && /^[a-z]+:/.test(arg)) { trigger = activeField(); u.manage = arg; rerender(); mount.querySelector<HTMLElement>("#org-hx-manage button:not([disabled]):not([data-act=\"orgHxManageClose\"])")?.focus(); } return true;
      case "orgHxManageClose": if (u.manage) { u.manage = null; rerender(); refocus(); } return true;
      case "orgHxConnectClose": if (u.connect && !u.connect.busy) { u.connect = null; rerender(); refocus(); } return true;
      case "orgHxConnectGo": startConnect(); return true;
      case "orgHxToken": {
        // `<mode>:<provider>:<scope>`
        const [mode, provider, ...rest] = (arg ?? "").split(":");
        if (!isHostingProvider(provider) || (mode !== "config" && !d?.secrets_available)) return true;
        // Opened from the connect dialog ("… instead"): focus goes back to what opened THAT.
        if (!u.connect) trigger = null;
        openToken(mode, provider, rest.join(":"));
        return true;
      }
      case "orgHxTokenClose": if (u.token && !u.token.saving) { dropSecret(); u.token = null; rerender(); refocus(); } return true;
      case "orgHxTokenInput": {
        const f = u.token;
        if (!f) return true;
        secretDraft = value ?? "";
        const has = secretDraft.trim() !== "";
        const changed = has !== f.hasValue || (f.error !== null && f.errorField === "secret");
        f.hasValue = has;
        if (f.errorField === "secret") { f.error = null; f.errorField = null; }
        if (changed) rerender();
        return true;
      }
      case "orgHxTokenConfig": {
        const f = u.token;
        if (!f || !arg) return true;
        f.config[arg] = value ?? "";
        if (f.errorField === `config.${arg}`) { f.error = null; f.errorField = null; }
        break;
      }
      case "orgHxTokenSave": saveToken(); return true;

      // Test connection
      case "orgHxTest": {
        const at = (arg ?? "").indexOf(":");
        const provider = (arg ?? "").slice(0, at), scope = (arg ?? "").slice(at + 1);
        if (at > 0 && isHostingProvider(provider)) test(arg ?? "", provider, scope ? { scope } : {});
        return true;
      }
      case "orgHxTestPart": {
        const at = (arg ?? "").indexOf("/");
        const part = d?.environments.find((e) => e.key === (arg ?? "").slice(0, at))?.parts.find((p) => p.key === (arg ?? "").slice(at + 1));
        const p = d && part ? providerOf(d, part.provider) : null;
        if (!part || !p) return true;
        const scope = scopeFor(p, part.env);
        // The test's answer shows under the part: open or not, it is always visible there.
        test(`part:${arg}`, part.provider, { env: part.env, part: part.key, ...(scope ? { scope } : {}) });
        return true;
      }
      default: return true;
    }
    rerender();
    return true;
  }

  /** While Trov is still looking for the host (a sync running, or none run yet), the tab reads itself again every
   *  20 seconds — so "Looking for your host" turns into the suggestion without a reload. One timer at a time; not
   *  for the sample, not off the tab, not while a dialog is open. */
  let lookAgain: ReturnType<typeof setTimeout> | null = null;
  const LOOK_AGAIN_MS = 20_000;

  function afterPaint(): void {
    const onTab = state.view === "app" && state.screen === "org" && effectiveOrgTab(state.org.tab, org()?.role ?? null) === "hosting";
    const u = h();
    if (onTab && !u.sample && !lookAgain && u.setup.status === "ok" && u.setup.data?.detection?.state === "looking" && !u.part && !u.connect && !u.token && !u.manage) {
      lookAgain = setTimeout(() => { lookAgain = null; if (h().setup.data?.detection?.state === "looking" && !h().sample) load(); }, LOOK_AGAIN_MS);
    }
    if (!onTab) {
      // Left the tab (or the screen) with a dialog open: the dialog and the value go with it.
      if (secretDraft) secretDraft = "";
      if (metricsDraft) metricsDraft = "";
      if (u.part || u.connect || u.token || u.manage) { u.part = null; u.connect = null; u.token = null; u.manage = null; }
      return;
    }
    // The part editor's app metrics token: put back on its input after a repaint; gone once the editor is.
    if (!u.part) { if (metricsDraft) metricsDraft = ""; }
    else {
      const mel = mount.querySelector<HTMLInputElement>("[data-hx-metrics-input]");
      if (mel && mel.value !== metricsDraft) mel.value = metricsDraft;
    }
    if (!u.token) { if (secretDraft) secretDraft = ""; return; }
    const el = mount.querySelector<HTMLInputElement>("[data-hx-secret-input]");
    if (el && el.value !== secretDraft) el.value = secretDraft;
  }

  // A dialog's keyboard: Escape closes it (not mid-write, and not while its dropdown is open — that Escape is
  // the dropdown's); Tab stays inside it.
  document.addEventListener("keydown", (e) => {
    if (state.view !== "app" || state.screen !== "org") return;
    const u = h();
    if (!u.part && !u.connect && !u.token && !u.manage) return;
    if (state.org.confirm || state.dd.open) return;
    const dlg = mount.querySelector<HTMLElement>("[data-hx-dialog]");
    if (!dlg) return;
    if (e.key === "Escape") {
      e.preventDefault(); e.stopPropagation();
      act(u.token ? "orgHxTokenClose" : u.connect ? "orgHxConnectClose" : u.part ? "orgHxPartClose" : "orgHxManageClose", null, null);
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), a[href]"));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !dlg.contains(cur)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
  }, true);

  return { act, load, runConfirm, afterPaint };
}
