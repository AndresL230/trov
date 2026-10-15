// GitHub deployments (repo setups, Phase A) — a part whose deploys Trov learns from GITHUB, not from a host's
// API: an app deployed by GitHub Actions (scenario H), or any host Trov has no credential for yet that reports
// to GitHub (a deployment environment, a check run).
//
//   credential   NONE of its own (`credential: "github_app"`): it uses the org's GitHub connection. It offers
//                no connection method, the poll framework never resolves a credential for it, and anything it
//                ever reads from GitHub goes through `resolveGithubCredential` (it reads nothing today).
//   part         exactly ONE of (`checkSettings`):
//                  environment   a GitHub deployment environment name, exactly as GitHub shows it
//                                ("Production – web", "web / production", "main - api");
//                  check_app +   a check run: the slug of the GitHub App that posts it and the check's name
//                  check_name    ("cloudflare-workers-and-pages" + "Workers Builds: web");
//                  workflow      a workflow file: `.github/workflows/<file>.yml` (or just `<file>.yml`) — every
//                                completed run of it on the environment's branch is a deploy.
//   deploys      written from the webhook capture (src/hosting/github-deploys.ts) when a captured signal
//                matches the part's setting — never polled: `poll` is never run (`pollCost` 0) and writes nothing.
//   metrics      none: GitHub reports no traffic. Every metric of the part's role is "not available".
import { metricsForRole } from "@shared/hosting";
import type { HostingProvider, PollResult } from "../types";

/** One line of display text: no control character, ≤ 200 (GitHub environment and check names carry spaces,
 *  en dashes and slashes, so nothing narrower). */
const LINE = /^[^\u0000-\u001f\u007f]{1,200}$/;
/** A GitHub App's slug, as `check_run.app.slug` carries it. */
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** A workflow file — `.github/workflows/<file>.yml|yaml`, or the file name alone. */
const WORKFLOW = /^(?:\.github\/workflows\/)?[A-Za-z0-9._-]{1,100}\.ya?ml$/;

export const NO_GITHUB_METRICS = "GitHub reports deploys only, no traffic or resources — connect the host itself to read them";

/** The workflow file a setting names, as GitHub's `workflow_run.path` / `workflow.path` spells it. */
export const workflowPath = (setting: string): string =>
  setting.startsWith(".github/workflows/") ? setting : `.github/workflows/${setting}`;

export const github: HostingProvider = {
  id: "github",
  label: "GitHub deployments",
  status: "available",
  summary: "An app deployed from GitHub. Trov reads its deploys from GitHub: a deployment environment, a check run or a workflow.",
  roles: ["web", "service"],
  // Nothing is fetched (deploys come from the capture). The only host it could ever talk to is GitHub's, and
  // only through the org's GitHub connection — never with a credential of its own.
  apiHosts: ["api.github.com"],
  docsUrl: "https://docs.github.com/en/actions/deployment/about-deployments",
  credential: "github_app",
  connectionMethods: [],
  orgConfigFields: [],
  partSettings: [
    { key: "environment", label: "Deployment environment", description: "A GitHub deployment environment, exactly as GitHub names it (Repository › Deployments), e.g. Production – web.", required: false, placeholder: "Production – web", pattern: LINE },
    { key: "check_app", label: "Check run app", description: "With Check run name: the GitHub App that posts the check (its slug), e.g. cloudflare-workers-and-pages.", required: false, placeholder: "cloudflare-workers-and-pages", pattern: APP_SLUG },
    { key: "check_name", label: "Check run name", description: "With Check run app: the check's name as the commit's checks list shows it.", required: false, placeholder: "Workers Builds: web", pattern: LINE },
    { key: "workflow", label: "Workflow file", description: "A GitHub Actions workflow whose completed runs on the environment's branch are the deploys, e.g. .github/workflows/deploy.yml.", required: false, placeholder: ".github/workflows/deploy.yml", pattern: WORKFLOW },
  ],
  capabilities: { deploys: true, metrics: [] },
  planNote: "GitHub reports deploys only: no traffic, CPU or memory.",
  pollCost: 0,

  checkSettings(values) {
    const env = !!values.environment, check = !!(values.check_app || values.check_name), wf = !!values.workflow;
    if ([env, check, wf].filter(Boolean).length !== 1) {
      return { field: "settings", message: "set exactly one of: a deployment environment, a check run (app and name), or a workflow file" };
    }
    if (check && !values.check_app) return { field: "settings.check_app", message: "Check run app is required with Check run name" };
    if (check && !values.check_name) return { field: "settings.check_name", message: "Check run name is required with Check run app" };
    return null;
  },

  consoleUrl() {
    return null; // the repository's own pages are linked by the Repo screen, which knows the repository
  },

  async probe() {
    return { ok: true, detail: "GitHub deployments are read from the organization's GitHub connection — there is nothing of its own to test." };
  },

  // Never run by the framework (`credential: "github_app"`, `pollCost` 0): deploys come from the capture.
  async poll(_pc, part): Promise<PollResult> {
    return { deploys: [], points: [], unavailable: metricsForRole(part.role).map((metric) => ({ metric, reason: NO_GITHUB_METRICS })), covered: null };
  },
};
