// Org settings › Repositories › a repo › Apps (repo setups, Phase D2): the rules the read (src/repo/apps-setup.ts)
// and the screen (web/src/repo-apps.ts) share about GitHub deploy signals — which `github` part setting a seen
// signal would fill, whether a part's setting names a signal, and which signals are "unassigned deploy names".
// Zod-free: the SPA imports it as values.
//
// The identity is the one `signalMatchesPart` (src/hosting/github-deploys.ts) holds a captured signal to, minus the
// branch: an exact deployment environment name, an exact check app + name, the same workflow file. A commit status
// can name no `github` part (the provider has no setting for one), so it is never offered as a part's setting.
import type { AppSuggestionDTO, SeenSignal } from "./repo-scan-core";

/** How many days back the deploy-signal picker and the unassigned list look. */
export const SIGNAL_WINDOW_DAYS = 30;

/** The workflow file a setting or a signal names, as GitHub's `workflow_run.path` spells it. */
const workflowPath = (v: string): string => (v.startsWith(".github/workflows/") ? v : `.github/workflows/${v}`);
/** The `github` provider's own workflow pattern (src/hosting/providers/github.ts `WORKFLOW`). */
const WORKFLOW = /^(?:\.github\/workflows\/)?[A-Za-z0-9._-]{1,100}\.ya?ml$/;

/** A stable id for a seen signal (its kind, its source and its name). */
export const signalKey = (s: Pick<SeenSignal, "kind" | "name" | "source">): string => `${s.kind}:${s.source ?? ""}:${s.name}`;

/** The `github` part settings that would read this signal — or null when no setting can name it (a commit status;
 *  a check run whose posting App is unknown; a workflow whose file is not a workflow file). */
export function signalSettings(s: SeenSignal): Record<string, string> | null {
  if (s.kind === "deployment") return s.name ? { environment: s.name } : null;
  if (s.kind === "check") return s.source && s.name ? { check_app: s.source, check_name: s.name } : null;
  if (s.kind === "workflow") {
    const file = s.source ?? s.name;
    return WORKFLOW.test(file) ? { workflow: file } : null;
  }
  return null;
}

/** Does a `github` part's settings name this signal? Exact, as the capture's matcher is. */
export function settingsNameSignal(settings: Readonly<Record<string, string>>, s: SeenSignal): boolean {
  if (settings.environment) return s.kind === "deployment" && s.name === settings.environment;
  if (settings.check_app && settings.check_name) return s.kind === "check" && s.source === settings.check_app && s.name === settings.check_name;
  if (settings.workflow) {
    if (s.kind !== "workflow") return false;
    const file = s.source ?? s.name;
    return WORKFLOW.test(file) && workflowPath(file) === workflowPath(settings.workflow);
  }
  return false;
}

/** A deploy NAME worth listing on its own: a GitHub deployment environment, or a check / status posted by a host
 *  Trov knows. A plain CI check or a workflow run is not a deploy name (it is still offered in the picker, where a
 *  person chooses). */
export const isDeployName = (s: SeenSignal): boolean => s.kind === "deployment" || ((s.kind === "check" || s.kind === "status") && s.provider !== null);

/**
 * "Unassigned deploy names": the deploy names seen in the window that no `github` part's setting names and no
 * pending suggestion already carries. `partSettings` are the settings of every `github` part of the org.
 */
export function unassignedSignals(
  signals: readonly SeenSignal[], partSettings: readonly Readonly<Record<string, string>>[], suggestions: readonly Pick<AppSuggestionDTO, "state" | "signals">[],
): SeenSignal[] {
  const carried = new Set(suggestions.filter((x) => x.state === "pending").flatMap((x) => (x.signals ?? []).map(signalKey)));
  return signals.filter((s) => isDeployName(s) && !carried.has(signalKey(s)) && !partSettings.some((p) => settingsNameSignal(p, s)));
}

/** The signals a `github` part could be set to: seen in the window, and nameable by a setting. Most seen first. */
export function pickableSignals(signals: readonly SeenSignal[]): SeenSignal[] {
  return signals.filter((s) => signalSettings(s) !== null).sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
}

/** An app key from a deploy name — "Production – storefront-admin" (Vercel), "api / production" (Railway),
 *  "main - api" (Render), "docs (Production)" — lowercased to the part-key alphabet, ≤ 32. "" when nothing is left. */
export function keyFromSignalName(name: string): string {
  let n = name.trim();
  n = n.replace(/^(?:production|preview|staging|development)\s+[–-]\s+/i, "");
  n = n.replace(/\s+\/\s+[^/]+$/, "");
  n = n.replace(/^[^\s]+\s+-\s+/, "");
  n = n.replace(/\s*\([^)]*\)\s*$/, "");
  n = n.replace(/\.ya?ml$/i, "");
  return n.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
}
