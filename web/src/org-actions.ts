// Org settings — the controller: every `org…` act main.ts dispatches lands here, with the
// reads and writes behind them. The views are org-settings.ts and integrations.ts (pure);
// this is the only module of the three that touches the DOM or the network.
//
// A SECRET'S VALUE lives in exactly two places, and only while its form is open: the live
// <input>, and `secretDraft` below — a private variable, NOT a field of AppState, so no
// render ever interpolates it and nothing that serialises state can carry it. `afterPaint`
// puts it back on the input after a repaint (a swap or a morph drops an input's live value),
// and it is cleared on a successful save, on closing the form and on leaving the screen.
// It never reaches the URL, localStorage, a toast or a log line.

import type { AppState } from "./render";
import {
  ApiError, OrgApiError, Unauthorized, rateLimitText,
  resendOrgInvite, getOrgSettings, putOrgSettings, listOrgMembers, updateOrgMember, removeOrgMember, listOrgInvites, createOrgInvite, revokeOrgInvite,
  listOrgRepos, addOrgRepo, removeOrgRepo, listOrgEnvironments, putOrgEnvironment, reorderOrgEnvironments, deleteOrgEnvironment,
  listOrgIntegrations, setOrgIntegration, rotateOrgIntegration, deleteOrgIntegration, putOrgIntegrationConfig, testOrgIntegration, rotateOrgKey, listOrgAudit,
  type OrgEnvironmentWrite,
} from "./api";
import {
  ENV_TEXT_FIELDS, blankEnvFields, currentOrg, effectiveOrgTab, envDraftOk, envFieldLabel, envFieldsOf, initialOrgUi, inviteDraftOk, isOrgTab, lastOwnerSentence,
  repoDraftOk, roleAtLeast, type EnvField, type OrgConfirm, type OrgSlice, type OrgUi,
} from "./org-settings";
import { GENERATED_KINDS, integrationKey, integrationLabel } from "./integrations";
import { isIntegrationKind, type IntegrationDTO, type IntegrationKind } from "@shared/integrations";
import type { OrgInvite, OrgRole } from "@shared/orgs";

export interface OrgHost {
  state: AppState;
  mount: HTMLElement;
  rerender(): void;
  flash(msg: string, ms?: number): void;
  /** The session expired: back to sign-in. */
  unauth(e: unknown): void;
  /** Play the confirmation modal's exit, then run `then`. */
  confirmOut(then: () => void): void;
  /** Read `GET /api/orgs` again — the ONE loader (main.ts `loadMyOrgs`); null when it failed. */
  reloadOrgs(): Promise<unknown>;
  /** The viewer is no longer in the org on screen (they left it): off to the picker. */
  leaveOrg(): void;
}

export interface OrgController {
  /** Run one `org…` act. */
  act(act: string, arg: string | null, value: string | null): void;
  /** Load (or refresh) the current org and everything its screen reads. */
  load(): void;
  /** After every paint: restore the secret input's live value, place focus, drop a stale form. */
  afterPaint(): void;
}

/** 32 random bytes as 64 hex characters, from the browser's CSPRNG. */
export function randomHex32(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const sentence = (s: string): string => {
  const t = s.trim();
  if (!t) return t;
  return `${t[0].toUpperCase()}${t.slice(1)}${/[.!?]$/.test(t) ? "" : "."}`;
};

/** A refusal as words that say what to do next. `detail` is the server's own sentence — it names a rule, never a submitted value. */
export function orgErrorText(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return `${fallback} Check your connection and try again.`;
  const detail = e instanceof OrgApiError ? e.detail : null;
  const limited = rateLimitText(e);
  if (limited) return limited;
  switch (e.message) {
    case "forbidden": return "You don't have permission to do that here. Ask an owner of this org.";
    case "secrets_unavailable": return "Trov can't store or use secrets yet: its encryption key is not configured. Ask whoever runs this Trov to set it, then try again.";
    case "already_configured": return "A value is already set. Close this form and choose Rotate to replace it.";
    case "not_configured": return "Nothing is set yet. Close this form and choose Set.";
    case "unknown_scope": return "That environment or repository no longer exists. Reload the page.";
    case "undecryptable_secret": return "A stored secret could not be decrypted. Delete it and set it again.";
    case "repo_exists": return "That repository is already connected.";
    case "primary_repo": return "Make another repository the primary first, then remove this one.";
    case "invite_exists": return "That person already has a pending invite.";
    case "already_member": return "They are already a member of this org.";
    case "not_found": return "That no longer exists. Reload the page.";
    case "internal": return `${fallback} Something went wrong on the server. Try again in a minute.`;
    default: return detail ? sentence(detail) : `${fallback} Try again.`;
  }
}

export function createOrgController(host: OrgHost): OrgController {
  const { state, mount } = host;
  const ui = (): OrgUi => state.org;
  const org = () => currentOrg(state);
  const rerender = () => host.rerender();

  // ── the secret draft (see the header) ──────────────────────────────────────
  let secretDraft = "";
  /** The `data-field` of the button that opened the form, so focus returns to it. */
  let secretTrigger: string | null = null;
  const dropSecret = (): void => {
    secretDraft = "";
    const el = mount.querySelector<HTMLInputElement>("[data-org-secret-input]");
    if (el) el.value = "";
  };
  const closeSecretForm = (refocus: boolean): void => {
    dropSecret();
    ui().secretForm = null;
    rerender();
    if (refocus && secretTrigger) mount.querySelector<HTMLElement>(`[data-field="${secretTrigger}"]`)?.focus();
    secretTrigger = null;
  };

  const fail = (e: unknown): boolean => {
    if (e instanceof Unauthorized) { host.unauth(e); return true; }
    return false;
  };

  // ── reads ──────────────────────────────────────────────────────────────────
  /** Run one read into its slice; a slice for an org that is no longer current is dropped.
   *  A slice that already holds an answer is REFRESHED: it stays "ok" with what it has until the
   *  fresh answer lands, so coming back to the screen (or a write's follow-up read) never blanks
   *  a tab, flips the setup checklist off and on, or shows "Loading…" over rows already there. */
  function read<T>(get: () => OrgSlice<T>, set: (v: OrgSlice<T>) => void, ask: (slug: string) => Promise<T>): void {
    const slug = ui().slug;
    if (!slug) return;
    const held = get().data;
    if (get().status !== "ok") set({ status: "loading", data: held });
    ask(slug)
      .then((data) => { if (ui().slug !== slug) return; set({ status: "ok", data }); rerender(); })
      .catch((e) => { if (fail(e) || ui().slug !== slug) return; set({ status: "error", data: held, error: e instanceof Error ? e.message : String(e) }); rerender(); });
  }
  const loadSettings = () => read(() => ui().settings, (v) => { ui().settings = v; }, getOrgSettings);
  const loadMembers = () => read(() => ui().members, (v) => { ui().members = v; }, listOrgMembers);
  const loadInvites = () => read(() => ui().invites, (v) => { ui().invites = v; }, listOrgInvites);
  const loadRepos = () => read(() => ui().repos, (v) => { ui().repos = v; }, listOrgRepos);
  const loadEnvs = () => read(() => ui().envs, (v) => { ui().envs = v; }, listOrgEnvironments);
  const loadIntegrations = () => read(() => ui().integrations, (v) => { ui().integrations = v; }, listOrgIntegrations);
  const loadAudit = () => read(() => ui().audit, (v) => { ui().audit = v; }, (slug) => listOrgAudit(slug));
  /** The admin-only reads (their routes answer 403 to a member, so a member never asks). */
  const loadAdmin = () => { if (roleAtLeast(org()?.role, "admin")) { loadInvites(); loadIntegrations(); loadAudit(); } };

  function loadSlices(): void {
    const o = org();
    if (!o) return;
    if (ui().slug !== o.slug) {
      dropSecret();
      state.org = { ...initialOrgUi(), tab: ui().tab, slug: o.slug };
    }
    loadSettings(); loadMembers(); loadRepos(); loadEnvs(); loadAdmin();
  }

  /** My orgs again (a role change, a rename), then this screen's reads. */
  function loadOrgs(then: () => void): void {
    void host.reloadOrgs().then(() => { then(); rerender(); });
  }
  function load(): void {
    loadSlices();
    rerender();
  }

  const replaceIntegration = (i: IntegrationDTO): void => {
    const d = ui().integrations.data;
    if (!d) return;
    const at = d.integrations.findIndex((x) => x.kind === i.kind && x.scope === i.scope);
    // A stored secret nothing expects that was just deleted simply leaves the list.
    if (at < 0) { if (i.configured || i.expected) d.integrations.push(i); }
    else if (!i.configured && !i.expected) d.integrations.splice(at, 1);
    else d.integrations[at] = i;
  };
  const findIntegration = (key: string): IntegrationDTO | null =>
    ui().integrations.data?.integrations.find((x) => integrationKey(x) === key) ?? null;
  /** `<kind>:<scope>` (a scope may itself hold a colon-free id; a kind never holds one). */
  const splitKey = (key: string): { kind: IntegrationKind; scope: string } | null => {
    const at = key.indexOf(":");
    const kind = at < 0 ? key : key.slice(0, at);
    return isIntegrationKind(kind) ? { kind, scope: at < 0 ? "" : key.slice(at + 1) } : null;
  };

  // ── confirmations ──────────────────────────────────────────────────────────
  function closeConfirm(): void {
    const c = ui().confirm;
    if (!c || c.busy) return;
    const back = `orgConfirm:${c.what}:${c.arg}`;
    host.confirmOut(() => {
      ui().confirm = null;
      rerender();
      mount.querySelector<HTMLElement>(`[data-field="${back}"]`)?.focus();
    });
  }
  function runConfirm(): void {
    const c = ui().confirm;
    const o = org();
    if (!c || c.busy || !o) return;
    c.busy = true;
    rerender();
    const done = (msg: string) => { ui().confirm = null; host.flash(msg); };
    const failed = (e: unknown, fallback: string) => { ui().confirm = null; if (fail(e)) return; host.flash(orgErrorText(e, fallback), 6000); };
    const { what, arg } = c as OrgConfirm;
    if (what === "repo") {
      const name = ui().repos.data.find((r) => r.id === arg)?.repo_full_name ?? "the repository";
      removeOrgRepo(o.slug, arg)
        .then((r) => { ui().repos = { status: "ok", data: r.repos }; done(r.removed_secrets.length ? `Removed ${name} and its webhook secret` : `Removed ${name}`); loadAdmin(); })
        .catch((e) => failed(e, `Couldn't remove ${name}.`));
    } else if (what === "env") {
      const label = ui().envs.data.find((x) => x.key === arg)?.label ?? arg;
      deleteOrgEnvironment(o.slug, arg)
        .then((r) => {
          ui().envs = { status: "ok", data: r.environments };
          const n = r.removed_secrets.length;
          done(n ? `Deleted ${label} and ${n === 1 ? "its secret" : `its ${n} secrets`}` : `Deleted ${label}`);
          loadAdmin();
        })
        .catch((e) => failed(e, `Couldn't delete ${label}.`));
    } else if (what === "secret") {
      const k = splitKey(arg);
      const i = findIntegration(arg);
      if (!k) { ui().confirm = null; rerender(); return; }
      const label = i ? integrationLabel(i) : "secret";
      deleteOrgIntegration(o.slug, k.kind, k.scope)
        .then((row) => { replaceIntegration(row); delete ui().tests[arg]; done(`Deleted the ${label}`); loadAudit(); loadRepos(); })
        .catch((e) => failed(e, `Couldn't delete the ${label}.`));
    } else if (what === "member") {
      const m = ui().members.data.find((x) => x.handle.toLowerCase() === arg.toLowerCase());
      const name = m?.name ?? m?.handle ?? arg;
      removeOrgMember(o.slug, arg)
        .then((r) => {
          ui().memberEdit = null;
          done(r.left ? `You left ${o.name}` : `Removed ${name}`);
          // Leaving ends my access to this org: there is nothing of it left to show.
          if (r.left) host.leaveOrg(); else loadMembers();
        })
        .catch((e) => failed(e, e instanceof ApiError && e.message === "last_owner" ? lastOwnerSentence(name) : `Couldn't remove ${name}.`));
    } else {
      rotateOrgKey(o.slug)
        .then((r) => {
          done(r.rotated ? `Encryption key rotated to version ${r.key_version}. ${r.secrets} secret${r.secrets === 1 ? "" : "s"} re-encrypted.` : "There is no key to rotate yet.");
          loadIntegrations(); loadAudit();
        })
        .catch((e) => failed(e, "Couldn't rotate the encryption key."));
    }
  }

  // ── writes ─────────────────────────────────────────────────────────────────
  function saveName(): void {
    const o = org();
    const u = ui();
    const name = (u.nameDraft ?? "").trim();
    if (!o || !name || u.nameSaving || name === u.settings.data?.org.name) return;
    u.nameSaving = true; u.nameError = null;
    rerender();
    putOrgSettings(o.slug, name)
      .then((r) => {
        u.nameSaving = false; u.nameDraft = null;
        if (u.settings.data) u.settings = { status: "ok", data: { ...u.settings.data, org: r.org } };
        const mine = state.myOrgs.data?.orgs.find((x) => x.slug === o.slug);
        if (mine) mine.name = r.org.name;
        host.flash("Org renamed");
      })
      .catch((e) => {
        u.nameSaving = false;
        if (fail(e)) return;
        u.nameError = e instanceof ApiError && e.message === "invalid_name" ? "A name is 1 to 80 characters." : orgErrorText(e, "Couldn't rename the org.");
        rerender();
      });
  }

  function addRepo(name: string, primary: boolean): void {
    const o = org();
    const u = ui();
    if (!o || u.repoBusy) return;
    u.repoBusy = true; u.repoError = null;
    rerender();
    addOrgRepo(o.slug, name, primary ? true : undefined)
      .then((repos) => {
        u.repoBusy = false;
        u.repos = { status: "ok", data: repos };
        if (!primary) u.repoDraft = "";
        host.flash(primary ? `${name} is now the primary repository` : `Connected ${name}`);
        loadAdmin(); // a new repository is a new webhook-secret slot
      })
      .catch((e) => {
        u.repoBusy = false;
        if (fail(e)) return;
        const msg = e instanceof ApiError && e.message === "invalid" ? "Use the form owner/repo, exactly as it appears on GitHub." : orgErrorText(e, "Couldn't connect the repository.");
        if (primary) host.flash(msg, 6000); else { u.repoError = msg; rerender(); }
      });
  }

  function saveEnv(): void {
    const o = org();
    const u = ui();
    const d = u.envEdit;
    if (!o || !d || d.saving || !envDraftOk(d)) return;
    const key = d.key ?? d.keyDraft.trim();
    const current = d.key === null ? null : u.envs.data.find((e) => e.key === d.key) ?? null;
    const base = current ? envFieldsOf(current) : blankEnvFields();
    const body: Record<string, string | null> = {};
    for (const f of ENV_TEXT_FIELDS) {
      const v = d.fields[f].trim();
      // A new environment sends what was filled in; an edit sends only what changed.
      if (current ? v === base[f] : v === "" || (f === "health_path" && v === "/")) continue;
      body[f] = v === "" && (f === "note" || f === "railway_environment_id" || f === "railway_service_id") ? null : v;
    }
    if (current && Object.keys(body).length === 0) { u.envEdit = null; rerender(); return; }
    d.saving = true; d.error = null; d.errorField = null;
    rerender();
    putOrgEnvironment(o.slug, key, body as OrgEnvironmentWrite)
      .then((r) => {
        u.envEdit = null;
        const label = r.environment.label;
        host.flash(r.created ? `Added ${label}` : r.removed_secrets.length ? `Saved ${label}. Its app metrics token was deleted: set a new one in Integrations.` : `Saved ${label}`, r.removed_secrets.length ? 7000 : 2200);
        loadEnvs(); loadAdmin();
      })
      .catch((e) => {
        d.saving = false;
        if (fail(e)) return;
        d.errorField = e instanceof OrgApiError ? e.field : null;
        // The server names the field by its key (`frontend_url: only https…`): say it with the form's label.
        const label = d.errorField ? envFieldLabel(d.errorField) : null;
        d.error = e instanceof OrgApiError && e.message === "invalid" && e.detail && d.errorField && label
          ? sentence(e.detail.replace(new RegExp(`^${d.errorField}:\\s*`), "").replace(new RegExp(`^${d.errorField}\\b`), label))
          : orgErrorText(e, "Couldn't save the environment.");
        if (d.errorField && !["key", "label", "note", "branch", "frontend_url", "api_url", "health_path"].includes(d.errorField)) d.advanced = true;
        rerender();
      });
  }

  function moveEnv(key: string, dir: "up" | "down"): void {
    const o = org();
    const u = ui();
    if (!o || u.envBusy || u.envEdit) return;
    const before = u.envs.data;
    const at = before.findIndex((e) => e.key === key);
    const to = dir === "up" ? at - 1 : at + 1;
    if (at < 0 || to < 0 || to >= before.length) return;
    const next = before.slice();
    [next[at], next[to]] = [next[to], next[at]];
    u.envBusy = true;
    u.envs = { status: "ok", data: next.map((e, i) => ({ ...e, position: i })) }; // shown at once; the answer confirms it
    const refocus = () => {
      const btn = (d: string) => mount.querySelector<HTMLElement>(`[data-field="orgEnvMove:${key}:${d}"]:not([disabled])`);
      (btn(dir) ?? btn(dir === "up" ? "down" : "up"))?.focus();
    };
    rerender();
    reorderOrgEnvironments(o.slug, next.map((e) => e.key))
      .then((envs) => { u.envBusy = false; u.envs = { status: "ok", data: envs }; rerender(); refocus(); })
      .catch((e) => {
        u.envBusy = false; u.envs = { status: "ok", data: before };
        if (fail(e)) return;
        host.flash(orgErrorText(e, "Couldn't reorder the environments."), 6000);
      });
  }

  function saveMember(): void {
    const o = org();
    const u = ui();
    const d = u.memberEdit;
    const m = d ? u.members.data.find((x) => x.handle.toLowerCase() === d.handle.toLowerCase()) : null;
    if (!o || !d || !m || d.saving) return;
    const patch: { role?: OrgRole; title?: string | null; responsibilities?: string | null } = {};
    if (d.role !== m.role) patch.role = d.role;
    if (d.title.trim() !== (m.title ?? "")) patch.title = d.title.trim() || null;
    if (d.responsibilities.trim() !== (m.responsibilities ?? "")) patch.responsibilities = d.responsibilities.trim() || null;
    if (Object.keys(patch).length === 0) { u.memberEdit = null; rerender(); return; }
    d.saving = true; d.error = null;
    rerender();
    const name = m.name ?? m.handle;
    updateOrgMember(o.slug, m.handle, patch)
      .then((members) => {
        u.memberEdit = null;
        u.members = { status: "ok", data: members };
        host.flash(`Saved ${name}`);
        // My own role changed: what I may see here changed with it.
        if (patch.role && m.handle.toLowerCase() === (state.me?.handle ?? "").toLowerCase()) loadOrgs(loadSlices);
      })
      .catch((e) => {
        d.saving = false;
        if (fail(e)) return;
        d.error = e instanceof ApiError && e.message === "last_owner" ? lastOwnerSentence(name)
          : e instanceof ApiError && e.message === "forbidden" ? "Only an owner can change an owner's role, or make someone an owner."
          : orgErrorText(e, `Couldn't save ${name}.`);
        rerender();
      });
  }

  function sendInvite(): void {
    const o = org();
    const u = ui();
    if (!o || u.inviteBusy || !inviteDraftOk(u.inviteBy, u.inviteDraft)) return;
    const who = u.inviteDraft.trim().replace(/^@/, "");
    u.inviteBusy = true; u.inviteError = null;
    rerender();
    const name = u.inviteName.trim();
    createOrgInvite(o.slug, u.inviteBy === "github" ? { github_login: who, role: u.inviteRole } : { email: who, role: u.inviteRole, ...(name ? { name } : {}) })
      .then((invite) => {
        u.inviteBusy = false; u.inviteDraft = ""; u.inviteName = "";
        u.invites = { status: "ok", data: [invite, ...u.invites.data] };
        const whom = invite.github_login ? `@${invite.github_login}` : invite.email ?? who;
        // An e-mail invite is mailed by the same request; a GitHub one never is — Trov knows a login, not an address.
        host.flash(`Invited ${whom} as ${invite.role}. ${mailSentence(invite)}`, 6000);
      })
      .catch((e) => {
        u.inviteBusy = false;
        if (fail(e)) return;
        u.inviteError = e instanceof ApiError && e.message === "invalid_invite"
          ? (u.inviteBy === "github" ? "That is not a GitHub login. Use the name after github.com/, without the @." : e instanceof OrgApiError && e.detail && /name/.test(e.detail) ? sentence(e.detail) : "That is not an email address.")
          : orgErrorText(e, "Couldn't send the invite.");
        rerender();
      });
  }

  /** What became of an invite's e-mail, as a sentence for the toast. */
  const mailSentence = (i: OrgInvite): string =>
    i.github_login ? "They see it the next time they sign in."
      : i.mail_status === "sent" ? `The invitation was emailed to ${i.email}.`
      : `The email to ${i.email} was not sent${i.mail_error ? `: ${i.mail_error}` : ""}. Use Resend email to try again.`;

  function mailInvite(id: number): void {
    const o = org();
    const u = ui();
    if (!o || u.mailBusy !== null) return;
    u.mailBusy = id;
    rerender();
    resendOrgInvite(o.slug, id)
      .then((invite) => {
        u.mailBusy = null;
        u.invites = { ...u.invites, data: u.invites.data.map((i) => (i.id === invite.id ? invite : i)) };
        host.flash(mailSentence(invite), 6000);
      })
      .catch((e) => {
        u.mailBusy = null;
        if (fail(e)) return;
        host.flash(e instanceof ApiError && e.message === "not_found" ? "That invitation is no longer pending, so no email was sent."
          : e instanceof ApiError && e.message === "no_address" ? "That invite has no email address. They see it when they sign in."
          : orgErrorText(e, "The email was not sent."), 6000);
        if (e instanceof ApiError && (e.status === 404 || e.status === 409)) loadInvites(); else rerender();
      });
  }

  function saveSecret(): void {
    const o = org();
    const u = ui();
    const f = u.secretForm;
    if (!o || !f || f.saving) return;
    const i = findIntegration(integrationKey(f));
    if (!i) return;
    const config: Record<string, string> = {};
    for (const c of i.config_fields) { const v = (f.config[c.key] ?? "").trim(); if (v) config[c.key] = v; }
    const hasConfig = i.config_fields.length > 0;
    if (f.mode !== "config" && secretDraft.trim() === "") return;
    f.saving = true; f.error = null; f.errorField = null;
    rerender();
    const label = integrationLabel(i);
    const key = integrationKey(f);
    // Trimmed here, once; the server refuses surrounding whitespace rather than guess.
    const write = f.mode === "config" ? putOrgIntegrationConfig(o.slug, f.kind, f.scope, config)
      : f.mode === "rotate" ? rotateOrgIntegration(o.slug, f.kind, f.scope, secretDraft.trim())
      : setOrgIntegration(o.slug, f.kind, f.scope, secretDraft.trim(), hasConfig ? config : undefined);
    write
      .then((row) => {
        const mode = f.mode;
        dropSecret();                 // gone from the variable and from the live input
        u.secretForm = null;
        replaceIntegration(row);
        delete u.tests[key];
        host.flash(mode === "config" ? `Saved the settings of the ${label}` : mode === "rotate" ? `Rotated the ${label}` : `Saved the ${label}`);
        if (secretTrigger) (mount.querySelector<HTMLElement>(`[data-org-integration="${key}"] button:not([disabled])`))?.focus();
        secretTrigger = null;
        // The list again too: the first secret creates the org's key (`key_version`).
        loadIntegrations(); loadAudit(); loadRepos();
      })
      .catch((e) => {
        f.saving = false;
        if (fail(e)) return;
        const field = e instanceof OrgApiError ? e.field : null;
        f.errorField = field === "secret" || (field?.startsWith("config.") ?? false) ? field : null;
        f.error = e instanceof ApiError && e.message === "invalid_secret" && e instanceof OrgApiError && e.detail
          ? sentence(e.detail.replace(/^secret\b/, "The value"))
          : e instanceof ApiError && e.message === "invalid_config" && e instanceof OrgApiError && e.detail
          ? sentence(i.config_fields.reduce((t, c) => t.replace(new RegExp(`^${c.key}\\b`), c.label), e.detail))
          : orgErrorText(e, "Couldn't save it.");
        rerender();
      });
  }

  function testSecret(key: string): void {
    const o = org();
    const k = splitKey(key);
    const u = ui();
    if (!o || !k || u.tests[key]?.status === "running") return;
    u.tests[key] = { status: "running" };
    rerender();
    testOrgIntegration(o.slug, k.kind, k.scope)
      .then((r) => { u.tests[key] = { status: "done", ok: r.ok, detail: r.detail }; replaceIntegration(r.integration); rerender(); })
      .catch((e) => {
        if (fail(e)) { delete u.tests[key]; return; }
        u.tests[key] = { status: "done", ok: false, detail: orgErrorText(e, "The test could not run.") };
        rerender();
      });
  }

  function copySecret(): void {
    const f = ui().secretForm;
    if (!f || !f.generated || !secretDraft) return;
    const done = (ok: boolean) => { const g = ui().secretForm; if (g) { g.copied = ok ? "yes" : "failed"; rerender(); } };
    // The Clipboard API only: no hidden-textarea fallback for a secret. If it is refused,
    // the form says so and offers Show, to copy by hand.
    if (!navigator.clipboard?.writeText) { done(false); return; }
    navigator.clipboard.writeText(secretDraft).then(() => done(true), () => done(false));
  }

  // ── acts ───────────────────────────────────────────────────────────────────
  function act(name: string, arg: string | null, value: string | null): void {
    const u = ui();
    const o = org();
    const admin = roleAtLeast(o?.role, "admin");
    switch (name) {
      case "orgGo":
        state.screen = "org"; state.personCard = null;
        if (isOrgTab(arg)) u.tab = arg;
        load();
        return;
      case "orgTab":
        if (!isOrgTab(arg)) return;
        u.tab = effectiveOrgTab(arg, o?.role ?? null);
        if (state.screen !== "org") { state.screen = "org"; load(); return; }
        break;
      case "orgReload": loadOrgs(loadSlices); break;

      // General
      case "orgNameDraft": u.nameDraft = value ?? ""; u.nameError = null; break;
      case "orgNameCancel": u.nameDraft = null; u.nameError = null; break;
      case "orgNameSave": saveName(); return;

      // Repositories
      case "orgRepoDraft": u.repoDraft = value ?? ""; u.repoError = null; break;
      case "orgRepoAdd": if (admin && repoDraftOk(u.repoDraft)) addRepo(u.repoDraft.trim(), false); return;
      case "orgRepoPrimary": if (admin && arg) addRepo(arg, true); return;

      // Environments
      case "orgEnvNew":
        if (!admin) return;
        u.envEdit = { key: null, keyDraft: "", fields: blankEnvFields(), advanced: false, saving: false, error: null, errorField: null };
        rerender();
        mount.querySelector<HTMLElement>("#org-env-key")?.focus();
        return;
      case "orgEnvEdit": {
        const e = u.envs.data.find((x) => x.key === arg);
        if (!admin || !e) return;
        u.envEdit = { key: e.key, keyDraft: e.key, fields: envFieldsOf(e), advanced: false, saving: false, error: null, errorField: null };
        rerender();
        mount.querySelector<HTMLElement>("#org-env-label")?.focus();
        return;
      }
      case "orgEnvKey": if (u.envEdit) { u.envEdit.keyDraft = value ?? ""; if (u.envEdit.errorField === "key") { u.envEdit.error = null; u.envEdit.errorField = null; } } break;
      case "orgEnvField":
        if (u.envEdit && arg && (ENV_TEXT_FIELDS as readonly string[]).includes(arg)) {
          u.envEdit.fields[arg as EnvField] = value ?? "";
          if (u.envEdit.errorField === arg) { u.envEdit.error = null; u.envEdit.errorField = null; }
        }
        break;
      case "orgEnvAdvanced": if (u.envEdit) u.envEdit.advanced = !u.envEdit.advanced; break;
      case "orgEnvCancel": {
        const back = u.envEdit?.key ? `orgEnvEdit:${u.envEdit.key}` : "orgEnvNew";
        u.envEdit = null;
        rerender();
        mount.querySelector<HTMLElement>(`[data-field="${back}"]`)?.focus();
        return;
      }
      case "orgEnvSave": saveEnv(); return;
      case "orgEnvMove": {
        const at = (arg ?? "").lastIndexOf(":");
        const dir = (arg ?? "").slice(at + 1);
        if (admin && at > 0 && (dir === "up" || dir === "down")) moveEnv((arg ?? "").slice(0, at), dir);
        return;
      }

      // Members
      case "orgMemberEdit": {
        const m = u.members.data.find((x) => x.handle.toLowerCase() === (arg ?? "").toLowerCase());
        if (!admin || !m) return;
        u.memberEdit = { handle: m.handle, role: m.role, title: m.title ?? "", responsibilities: m.responsibilities ?? "", saving: false, error: null };
        break;
      }
      case "orgMemberCancel": {
        const back = u.memberEdit ? `orgMemberEdit:${u.memberEdit.handle}` : null;
        u.memberEdit = null;
        rerender();
        if (back) mount.querySelector<HTMLElement>(`[data-field="${back}"]`)?.focus();
        return;
      }
      case "orgMemberRole": if (u.memberEdit && (value === "owner" || value === "admin" || value === "member")) { u.memberEdit.role = value; u.memberEdit.error = null; } break;
      case "orgMemberTitle": if (u.memberEdit) u.memberEdit.title = value ?? ""; break;
      case "orgMemberResp": if (u.memberEdit) u.memberEdit.responsibilities = value ?? ""; break;
      case "orgMemberSave": saveMember(); return;
      case "orgInviteBy": if (arg === "github" || arg === "email") { u.inviteBy = arg; u.inviteError = null; } break;
      case "orgInviteDraft": u.inviteDraft = value ?? ""; u.inviteError = null; break;
      case "orgInviteName": u.inviteName = value ?? ""; u.inviteError = null; break;
      case "orgInviteRole": if (value === "member" || value === "admin") u.inviteRole = value; break;
      case "orgInviteSend": sendInvite(); return;
      case "orgInviteMail": {
        const inv = u.invites.data.find((i) => String(i.id) === arg && i.status === "pending");
        if (admin && inv?.email) mailInvite(inv.id);
        return;
      }
      case "orgInviteRevoke": {
        const id = Number(arg);
        if (!o || !admin || !Number.isInteger(id)) return;
        revokeOrgInvite(o.slug, id)
          .then(() => { host.flash("Invite revoked"); loadInvites(); })
          .catch((e) => { if (fail(e)) return; host.flash(orgErrorText(e, "Couldn't revoke the invite."), 6000); loadInvites(); });
        return;
      }

      // Integrations
      case "orgSecretOpen": {
        const at = (arg ?? "").indexOf(":");
        const mode = (arg ?? "").slice(0, at);
        const key = (arg ?? "").slice(at + 1);
        const i = findIntegration(key);
        if (!admin || !i || (mode !== "set" && mode !== "rotate" && mode !== "config")) return;
        secretDraft = "";
        secretTrigger = `orgSecretOpen:${arg}`;
        u.confirm = null;
        u.secretForm = { kind: i.kind, scope: i.scope, mode, config: { ...i.config }, hasValue: false, generated: false, reveal: false, copied: null, saving: false, error: null, errorField: null };
        rerender();
        // After the paint (which hands focus back to the button that was pressed): into the form.
        mount.querySelector<HTMLElement>("#org-secret input:not([disabled])")?.focus();
        return;
      }
      case "orgSecretClose": if (u.secretForm && !u.secretForm.saving) closeSecretForm(true); return;
      case "orgSecretInput": {
        const f = u.secretForm;
        if (!f) return;
        secretDraft = value ?? "";
        const has = secretDraft.trim() !== "";
        // Typing over a generated value makes it the admin's own: no Copy, no Show.
        const changed = has !== f.hasValue || f.generated || (f.error !== null && f.errorField === "secret");
        f.hasValue = has; f.generated = false; f.reveal = false; f.copied = null;
        if (f.errorField === "secret") { f.error = null; f.errorField = null; }
        if (changed) rerender();
        return;
      }
      case "orgSecretConfig": {
        const f = u.secretForm;
        if (!f || !arg) return;
        f.config[arg] = value ?? "";
        if (f.errorField === `config.${arg}`) { f.error = null; f.errorField = null; }
        break;
      }
      case "orgSecretGenerate": {
        const f = u.secretForm;
        if (!f || f.saving || !GENERATED_KINDS.includes(f.kind)) return;
        secretDraft = randomHex32();
        f.hasValue = true; f.generated = true; f.reveal = false; f.copied = null;
        if (f.errorField === "secret") { f.error = null; f.errorField = null; }
        break;
      }
      case "orgSecretCopy": copySecret(); return;
      case "orgSecretReveal": if (u.secretForm?.generated) u.secretForm.reveal = !u.secretForm.reveal; break;
      case "orgSecretSave": saveSecret(); return;
      case "orgSecretTest": if (admin && arg) testSecret(arg); return;
      case "orgAuditToggle": u.auditOpen = !u.auditOpen; break;

      // The confirmation modal
      case "orgConfirm": {
        const at = (arg ?? "").indexOf(":");
        const what = (arg ?? "").slice(0, at);
        if (!admin || at < 0 || !["repo", "env", "secret", "member", "key"].includes(what)) return;
        if (what === "key" && o?.role !== "owner") return;
        u.confirm = { what: what as OrgConfirm["what"], arg: (arg ?? "").slice(at + 1), busy: false };
        rerender();
        mount.querySelector<HTMLElement>("[data-confirm-focus]")?.focus();
        return;
      }
      case "orgConfirmCancel": closeConfirm(); return;
      case "orgConfirmGo": runConfirm(); return;
      default: return;
    }
    rerender();
  }

  function afterPaint(): void {
    const onScreen = state.view === "app" && state.screen === "org";
    const f = onScreen ? ui().secretForm : null;
    if (!f) {
      // Left the screen (or signed out) with the form open: the value goes with it.
      if (secretDraft) secretDraft = "";
      if (!onScreen && (ui().secretForm || ui().confirm)) { ui().secretForm = null; ui().confirm = null; }
      return;
    }
    const el = mount.querySelector<HTMLInputElement>("[data-org-secret-input]");
    if (el && el.value !== secretDraft) el.value = secretDraft;
  }

  // The secret form's keyboard: Escape closes it (not mid-save); Tab stays inside it.
  document.addEventListener("keydown", (e) => {
    if (state.view !== "app" || state.screen !== "org" || !ui().secretForm) return;
    const dlg = mount.querySelector<HTMLElement>("#org-secret");
    if (!dlg) return;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); act("orgSecretClose", null, null); return; }
    if (e.key !== "Tab") return;
    const items = Array.from(dlg.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])"));
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    const cur = document.activeElement as HTMLElement | null;
    if (!cur || !dlg.contains(cur)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
  }, true);

  return { act, load, afterPaint };
}
