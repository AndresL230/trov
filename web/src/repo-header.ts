// The Repo screen's header when the dashboard carries `facts` (the design's RepoScreen header and ScopeMenu.dc.html):
//
//   • the repository menu — a `dropdown()` of the org's repositories (`facts.repos`), only when there are two or
//     more; otherwise the repository's name as quiet text, as today;
//   • the App menu — monorepos only (`facts.allApps.length >= 2`): All apps, each app with its folder and its open
//     pull requests, and "Repo-wide only" (files outside every app). Picking one narrows every tab (`narrowFacts`);
//   • the environment pills — each environment's verdict (repo-verdict.ts `envVerdict`, the same function the
//     environment cards use) as a dot whose shape-bearing mark is in its tooltip;
//   • Group by — `segmented()`, Environment | App, only when the layout can draw either (`layout.canGroup`), above
//     the panel. After a flip an admin is offered "Make this the default" (`repo_settings.overview_group`).
//
// Repo and app live in the address (`#repo?repo=…&app=…`, hash.ts) and go to `GET /repo/dashboard?repo=&app=`;
// Group by is the session's (main.ts), defaulting to `facts.groupDefault`.
import { REPO_WIDE, type RepoFacts } from "@shared/repo-facts-core";
import type { RepoLayout } from "@shared/repo-layout-core";
import { esc, attr } from "./ui";
import { dropdown, type DropdownProps, type DropdownUi } from "./dropdown";
import { segmented } from "./segmented";
import { envVerdict } from "./repo-verdict";

/** The App menu's value for "All apps" (a dropdown option needs a string). */
export const ALL_APPS = "__all";

const prs = (n: number | null): string => (n === null ? "" : `${n} open ${n === 1 ? "pull request" : "pull requests"}`);

/** The repository menu, or null when the org has one repository (the name is then plain text). */
export function repoMenuDropdown(f: Pick<RepoFacts, "repo" | "repos">): DropdownProps | null {
  if (f.repos.length < 2) return null;
  return {
    id: "repo-scope-repo", act: "repoPickRepo", value: f.repo, size: "sm", ariaLabel: "Repository",
    options: f.repos.map((r) => ({ value: r, label: r })),
  };
}

/** The App menu (monorepos only), or null. */
export function appMenuDropdown(f: Pick<RepoFacts, "app" | "allApps">): DropdownProps | null {
  if (f.allApps.length < 2) return null;
  const counts = f.allApps.map((a) => a.openPrs);
  const total = counts.every((n): n is number => n !== null) ? counts.reduce((x, n) => x + n, 0) : null;
  return {
    id: "repo-scope-app", act: "repoPickApp", value: f.app ?? ALL_APPS, size: "sm", ariaLabel: "App",
    options: [
      { value: ALL_APPS, label: "All apps", hint: prs(total) || undefined },
      ...f.allApps.map((a) => ({ value: a.key, label: a.label, hint: [a.folder, prs(a.openPrs)].filter(Boolean).join(" · ") })),
      { value: REPO_WIDE, label: "Repo-wide only", hint: "Files outside every app" },
    ],
  };
}

/** Every dropdown the header can show — what the screen's root overlays render the open menu from. */
export const repoHeaderDropdowns = (f: RepoFacts): DropdownProps[] =>
  [repoMenuDropdown(f), appMenuDropdown(f)].filter((d): d is DropdownProps => d !== null);

/** The crumb beside the title: the repository (a menu, or its name) and, for a monorepo, "/" and the App menu. */
export function repoScopeHtml(f: RepoFacts, dd: DropdownUi): string {
  const rm = repoMenuDropdown(f);
  const am = appMenuDropdown(f);
  const repo = rm
    ? `<span class="repo-scope-dd" data-repo-menu>${dropdown(rm, dd)}</span>`
    : `<span style="font-family:var(--label);font-size:11px;color:var(--fg-40);white-space:nowrap;min-width:0;overflow:hidden;text-overflow:ellipsis">${esc(f.repo)}</span>`;
  const app = am ? `<span aria-hidden="true" style="color:var(--fg-40);font-size:13px">/</span><span class="repo-scope-dd" data-app-menu>${dropdown(am, dd)}</span>` : "";
  return `<span class="repo-scope" style="display:inline-flex;align-items:center;gap:8px;min-width:0">${repo}${app}</span>`;
}

/** The environment pills: one per environment in view, its verdict's tone on the dot (pulsing when it is not
 *  fine or waiting) and the verdict in its tooltip. None when nothing deploys (the design's `headerPills`). */
export function envPillsHtml(f: RepoFacts): string {
  if (!f.envs.length || !f.parts.length) return "";
  return f.envs.map((e) => {
    const v = envVerdict(f, e.key);
    const k = { tone: v.tone, shape: v.shape };
    const calm = k.shape === "dot" || k.shape === "ring";
    return `<span data-env-pill="${attr(e.key)}" data-verdict="${v.key}" data-mtip="${attr(`${e.name}: ${v.word}. ${v.tip}`)}" style="display:inline-flex;align-items:center;gap:7px;font-size:12px;white-space:nowrap;color:var(--fg-70)"><span class="repo-envdot${calm ? "" : " repo-pulse"}" style="--c:${k.tone};width:7px;height:7px;border-radius:50%;background:${k.tone};box-shadow:0 0 0 3px color-mix(in srgb,${k.tone} 16%,transparent)"></span>${esc(e.name)}</span>`;
  }).join("");
}

export interface GroupByOpts {
  /** An admin, not in the sample, who flipped the switch this session to something other than the default. */
  offerDefault: boolean;
}

/** Group by, above the panel — only when the layout can draw either grouping. "" otherwise. */
export function groupByHtml(layout: RepoLayout, o: GroupByOpts): string {
  if (!layout.canGroup) return "";
  const sw = segmented({
    id: "repo-group", ariaLabel: "Group by", act: "repoGroup", value: layout.group, size: "xs", inertOn: true,
    options: [{ value: "env", label: "Environment" }, { value: "app", label: "App" }],
  });
  const def = o.offerDefault
    ? `<button type="button" data-act="repoGroupDefault" class="repo-textbtn" style="font-size:12px;font-weight:500;color:var(--accent);padding:0;white-space:nowrap">Make this the default</button>`
    : "";
  return `<div class="repo-groupby" data-repo-groupby>${def}<span style="display:inline-flex;align-items:center;gap:8px"><span style="font-size:12px;color:var(--fg-55);white-space:nowrap">Group by</span>${sw}</span></div>`;
}
