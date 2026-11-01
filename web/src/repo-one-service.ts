// Org settings › Repositories › a repo › Apps — "What is it?" (#144, narrowed by #153): when what GitHub reported
// says ONE host deploys the repository and the scan found at most one deployable (`RepoAppsSetupDTO.oneService`,
// src/repo/one-service.ts), the page opens with that answer PRE-FILLED — "One service that does everything" — and
// the person confirms it in one step: the host, a name, the production URL, an optional health path, the host's own
// settings (prefilled from the scan: a Worker name, its D1 databases and crons), then the host's credential in its
// own dialog. "Something else" folds it away for the page's suggestions and Add an app. No frontend / backend words
// here: a single-stack repository has neither.
//
// Pure: props in, markup out. Every act starts with `orgAppsOne` and is handled by web/src/repo-apps-actions.ts.
// The SPA never branches on a provider id: a host's words, settings and connection come from the catalogues.

import { esc, attr, surface } from "./ui";
import { O_HELP, O_LABEL, O_ERR, accentBtn, anchoredField, fieldError, orgHead, textField } from "./org-ui";
import { segmented } from "./segmented";
import { dropdown, type DropdownProps, type DropdownUi } from "./dropdown";
import { capabilityChips, fieldOptions, providerOf, providerStatusOf } from "./hosting";
import { PART_KEY_RE, type HostingProviderId, type HostingSetupDTO } from "@shared/hosting";
import type { OneServiceOfferDTO, RepoAppsSetupDTO } from "@shared/repo-scan-core";

/** The step being filled in. Made from the offer on first edit; kept per repository. */
export interface OneServiceDraft {
  repo: string;
  /** The answer to "What is it?": the pre-filled one, or "Something else" (the page's suggestions instead). */
  what: "one" | "other";
  provider: HostingProviderId;
  key: string;
  url: string;
  health: string;
  /** Used only when the environment is created. */
  branch: string;
  settings: Record<string, string>;
  saving: boolean;
  error: string | null;
  /** `key`, `url`, `health_path`, `branch`, `settings.<key>`, `provider`, or null for the whole step. */
  errorField: string | null;
}

/** The draft as the offer pre-fills it. */
export function oneDraftOf(repo: string, o: OneServiceOfferDTO): OneServiceDraft {
  return {
    repo, what: "one", provider: o.provider, key: o.key, url: o.env.url, health: o.env.health_path, branch: o.env.branch,
    settings: { ...o.settings }, saving: false, error: null, errorField: null,
  };
}

/** The draft on screen for this setup: the person's, or the offer's own. null when nothing is offered. */
export function oneDraftFor(d: RepoAppsSetupDTO, held: OneServiceDraft | null): OneServiceDraft | null {
  if (!d.oneService) return null;
  return held && held.repo === d.repo ? held : oneDraftOf(d.repo, d.oneService);
}

const matches = (pattern: string | null, v: string): boolean => {
  if (!pattern) return true;
  try { return new RegExp(pattern).test(v); } catch { return true; }
};

/** What stops the step from being saved, by field — the server checks each again. "" = required, no message yet. */
export function oneProblems(dr: OneServiceDraft, h: HostingSetupDTO | null): Record<string, string> {
  const out: Record<string, string> = {};
  const key = dr.key.trim();
  if (!key) out.key = "";
  else if (!PART_KEY_RE.test(key)) out.key = "1 to 32 characters: a to z, 0 to 9, - or _.";
  const url = dr.url.trim();
  if (!url) out.url = "";
  else if (!/^https:\/\/[^\s/?#]+[^\s?#]*$/i.test(url)) out.url = "An https address with no query string, such as https://example.com.";
  const health = dr.health.trim();
  if (health && !health.startsWith("/")) out.health_path = "Starts with /, such as /api/health.";
  if (/\s/.test(dr.branch.trim())) out.branch = "A branch name has no spaces.";
  const p = h ? providerOf(h, dr.provider) : null;
  if (!p) { out.provider = ""; return out; }
  for (const f of p.part_settings) {
    const v = (dr.settings[f.key] ?? "").trim();
    if (!v) { if (f.required) out[`settings.${f.key}`] = ""; continue; }
    if (!matches(f.pattern, v)) out[`settings.${f.key}`] = `That does not look like a ${f.label}${f.placeholder ? `: for example ${f.placeholder}` : ""}.`;
  }
  return out;
}

/** The host picker: every host Trov can read itself (not "GitHub deployments", which is no host). */
export function oneHostDropdown(d: RepoAppsSetupDTO, dr: OneServiceDraft): DropdownProps {
  const options = (d.providers ?? []).filter((p) => !p.via_github).map((p) => ({
    value: p.id, label: p.label, ...(p.id === d.oneService?.provider ? { hint: "Seen deploying this repository" } : {}),
  }));
  return { id: "org-apps-one-host", act: "orgAppsOneHost", value: dr.provider, options, labelledBy: "org-apps-one-host-l", fill: true, disabled: dr.saving };
}

/** What a one-service setup reads, and what it cannot — one sentence each (also the Guide's subject). */
export const ONE_SERVICE_READS = "Trov reads its deploys from the host, checks the URL every 10 minutes, and reads the usage the host reports; pull requests, commits and CI come from GitHub.";

/** The "What is it?" block: `""` when nothing is offered. `h` is Hosting's read (the host's settings and connection);
 *  while it is out the form waits for it. */
export function oneServiceBlock(d: RepoAppsSetupDTO, held: OneServiceDraft | null, h: HostingSetupDTO | null, dd: DropdownUi): string {
  const o = d.oneService;
  const dr = oneDraftFor(d, held);
  if (!o || !dr) return "";
  const hostWord = (id: HostingProviderId) => d.providers?.find((p) => p.id === id)?.label ?? id;
  const seen = `<p data-one-seen style="margin:0;font-size:13px;line-height:1.6;color:var(--fg-70)">Trov sees one host deploying ${esc(d.repo)}: ${esc(o.evidence)}${o.suggestion ? `, and the scan found one app to deploy (${esc(o.kind)} <code style="font-family:var(--code);font-size:12px">${esc(o.key)}</code>${o.folder === "/" ? "" : ` in ${esc(o.folder)}`})` : ""}. So it looks like one service.</p>`;
  const what = `<div class="cnpy-org-field" style="margin-top:14px"><div id="org-apps-one-what-l" style="${O_LABEL}">What is it?</div>
      <div style="margin-top:7px">${segmented({ id: "org-apps-one-what", ariaLabel: "What is it?", act: "orgAppsOneWhat", value: dr.what, size: "sm", inertOn: true,
        options: [{ value: "one", label: "One service that does everything" }, { value: "other", label: "Something else" }] })}</div>
      <div style="${O_HELP}">${dr.what === "one"
        ? "A Worker or a single app server that serves the site, its API and everything else, deployed to one place."
        : "Set it up app by app below: accept what the scan found, or add an app by hand."}</div>
    </div>`;
  const head = orgHead("Set up", "pre-filled from what GitHub reported", null, "org-apps-one-t");
  if (dr.what === "other") {
    return `<section aria-labelledby="org-apps-one-t" data-apps-group="one-service" data-one="other" style="margin-bottom:30px">${head}<div${surface("padding:16px")}>${seen}${what}</div></section>`;
  }

  const p = h ? providerOf(h, dr.provider) : null;
  const problems = oneProblems(dr, h);
  const errOf = (f: string): string | null => (dr.errorField === f && dr.error ? dr.error : problems[f] || null);
  const live = !!p && !!h && providerStatusOf(h, p.id).live;
  const canSave = !dr.saving && !!p && Object.keys(problems).length === 0;
  const host = `<div class="cnpy-org-field"><div id="org-apps-one-host-l" style="${O_LABEL}">Host</div>
      ${anchoredField(`<div style="margin-top:7px">${dropdown(oneHostDropdown(d, dr), dd)}</div>`, errOf("provider") ? fieldError(null, errOf("provider") ?? "") : "")}
      ${p ? `<div data-one-host-about style="${O_HELP}">${esc(p.summary)}</div>` : ""}
    </div>`;
  const fields = `<div class="cnpy-org-grid" style="margin-top:16px">
      ${textField({ id: "org-apps-one-url", label: "Production URL", act: "orgAppsOneUrl", field: "orgAppsOneUrl", value: dr.url, required: true, max: 500, disabled: dr.saving, enter: "orgAppsOneSave", error: errOf("url"), placeholder: "https://example.com",
        help: "Where people reach it. https only." })}
      ${textField({ id: "org-apps-one-health", label: "Health path", act: "orgAppsOneHealth", field: "orgAppsOneHealth", value: dr.health, max: 200, disabled: dr.saving, enter: "orgAppsOneSave", error: errOf("health_path"), placeholder: "/api/health",
        help: "Optional. Added to the URL for the check every 10 minutes; empty checks the URL itself." })}
      ${textField({ id: "org-apps-one-key", label: "Name", act: "orgAppsOneKey", field: "orgAppsOneKey", value: dr.key, required: true, max: 32, disabled: dr.saving, enter: "orgAppsOneSave", error: errOf("key"), placeholder: "app",
        help: "Its permanent key: lowercase letters, digits, - or _." })}
      ${o.env.exists ? "" : textField({ id: "org-apps-one-branch", label: "Deploys from", act: "orgAppsOneBranch", field: "orgAppsOneBranch", value: dr.branch, max: 255, disabled: dr.saving, enter: "orgAppsOneSave", error: errOf("branch"), placeholder: "main",
        help: "The branch production ships from." })}
    </div>`;
  const settings = !p ? "" : p.part_settings.map((f) => {
    const field = `settings.${f.key}`;
    const value = dr.settings[f.key] ?? "";
    const opts = fieldOptions(f);
    if (opts) {
      const shown = opts.includes(value) ? value : opts.includes(f.placeholder ?? "") ? f.placeholder ?? opts[0] : opts[0];
      return `<div class="cnpy-org-field" data-one-setting="${attr(f.key)}"><div style="${O_LABEL}">${esc(f.label)}</div>
        ${anchoredField(`<div style="margin-top:7px">${segmented({ id: `org-apps-one-set-${f.key}`, ariaLabel: f.label, act: "orgAppsOnePick", value: `${f.key}=${shown}`, size: "sm", inertOn: true, options: opts.map((x) => ({ value: `${f.key}=${x}`, label: x[0].toUpperCase() + x.slice(1) })) })}</div>`, errOf(field) ? fieldError(null, errOf(field) ?? "") : "")}
        <div style="${O_HELP}">${esc(f.description)}</div></div>`;
    }
    return `<div data-one-setting="${attr(f.key)}">${textField({ id: `org-apps-one-set-${f.key}`, label: f.label, act: "orgAppsOneSetting", arg: f.key, field: `orgAppsOneSetting:${f.key}`, value, required: f.required, placeholder: f.placeholder ?? undefined, max: 300, disabled: dr.saving, enter: "orgAppsOneSave", help: esc(f.description), error: errOf(field) })}</div>`;
  }).join("");
  const onHost = settings ? `<div style="${O_LABEL};margin-top:18px">On ${esc(p?.label ?? "")}</div><div class="cnpy-org-grid">${settings}</div>` : "";
  const where = o.env.exists
    ? `It goes in ${esc(o.env.label)}, which deploys from <code style="font-family:var(--code);font-size:12px">${esc(o.env.branch)}</code>.`
    : `Trov makes one environment for it, ${esc(o.env.label)}.`;
  const reads = p ? `<div data-one-reads style="margin-top:16px;font-size:12.5px;line-height:1.6;color:var(--fg-55)">${esc(ONE_SERVICE_READS)} ${where}
      ${capabilityChips(p) ? `<div style="margin-top:6px">${capabilityChips(p)}</div>` : ""}</div>` : "";
  const connect = !p ? "" : live
    ? `<div data-one-connected style="${O_HELP}">${esc(p.label)} is connected.</div>`
    : `<div data-one-connect style="${O_HELP}">${esc(p.label)} isn't connected yet: its dialog opens next, and says exactly which key to make. Trov reads nothing from ${esc(p.label)} until then.</div>`;
  const general = dr.error && (dr.errorField === null || !problemField(dr.errorField, p?.part_settings.map((f) => f.key) ?? []))
    ? `<div role="alert" data-one-error style="${O_ERR};margin-top:12px">${esc(dr.error)}</div>` : "";
  const waiting = !h ? `<div style="${O_HELP}">Reading ${esc(hostWord(dr.provider))}'s settings&hellip;</div>` : "";
  const save = accentBtn(dr.saving ? "Setting up…" : p && !live ? `Set it up and connect ${p.label}` : "Set it up", "orgAppsOneSave",
    { disabled: !canSave, busy: dr.saving, field: "orgAppsOneSave" });
  return `<section aria-labelledby="org-apps-one-t" data-apps-group="one-service" data-one="one" style="margin-bottom:30px">${head}
    <div${surface("padding:16px")}>
      ${seen}${what}
      <div style="height:1px;background:var(--border);margin:16px 0"></div>
      ${host}${fields}${onHost}${waiting}${reads}${general}
      <div style="display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin-top:16px"><div style="flex:1 1 240px;min-width:0">${connect}</div>${save}</div>
    </div>
  </section>`;
}

/** Is this error field one the form shows beside its own input? */
const problemField = (f: string, settingKeys: readonly string[]): boolean =>
  ["key", "url", "health_path", "branch", "provider"].includes(f) || settingKeys.some((k) => f === `settings.${k}`);
