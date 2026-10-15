// The Code and CI tabs under the App menu (Repo setups, Phase E — the design's RepoScreen Code / CI tabs under an
// app): the scope line over a narrowed tab ("Pull requests that touch apps/api/** or packages/db/**" + Show all
// apps), the "touches" cell of a pull request ("api, jobs" / "via packages/db"), a CI failure's apps, and the deploy
// strips grouped per app. Worded here from the facts' apps (labels, folders, watch paths, a Package's users); the
// Worker narrows the rows (src/tools/repo-scope.ts) and sends app KEYS only. The rules are shared/repo-scope-core.ts.
//
// Unknown is unknown: a PR whose files were never read (`touches: null`) has an empty cell, never a guess.
import { REPO_WIDE, type FactsApp, type RepoFacts } from "@shared/repo-facts-core";
import type { RepoCiFailure, RepoPr } from "@shared/repo";
import { viaPackages, type ScopeApp } from "@shared/repo-scope-core";
import { esc, attr } from "./ui";
import { ALL_APPS } from "./repo-header";

/** The facts say this repository has two or more apps (the App menu shows). */
export const isMulti = (f: Pick<RepoFacts, "allApps"> | null | undefined): boolean => (f?.allApps.length ?? 0) >= 2;

const scopeApps = (f: Pick<RepoFacts, "allApps">): ScopeApp[] => f.allApps.map((a) => ({ key: a.key, kind: a.kind, usedBy: a.usedBy }));
const labelOf = (f: Pick<RepoFacts, "allApps">, key: string): string => f.allApps.find((a) => a.key === key)?.label ?? key;
const folderOf = (a: FactsApp): string => (a.folder === "/" ? a.label : a.folder.replace(/\/+$/, ""));

/** A watch path as the scope line shows it: a folder gains `/**`; the root is the whole repository. */
const globText = (g: string): string => {
  const t = g.trim().replace(/^\/+|\/+$/g, "");
  if (t === "" || t === "." || t === "**") return "the whole repository";
  return /[*?]/.test(t) ? t : `${t}/**`;
};
const orList = (xs: string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);

/** What the narrowed tab shows, in a sentence: its own watch paths and those of the Packages it uses. */
export function scopeSentence(f: Pick<RepoFacts, "allApps">, app: string, what: "code" | "ci"): string {
  if (app === REPO_WIDE) return what === "code" ? "Pull requests and commits that touch no app" : "CI runs that touch no app";
  const a = f.allApps.find((x) => x.key === app);
  if (!a) return "";
  const pkgs = f.allApps.filter((p) => p.kind === "Package" && p.usedBy?.includes(app));
  const globs = [...new Set([...a.watch, ...pkgs.flatMap((p) => p.watch)].map(globText))];
  return what === "code" ? `Pull requests that touch ${orList(globs)}` : `CI runs whose workflow or head commit touches ${orList(globs)}`;
}

/** The line over a tab narrowed to one app (or Repo-wide only), with "Show all apps"; "" under All apps. */
export function scopeStrip(f: RepoFacts | null, app: string | null | undefined, what: "code" | "ci"): string {
  if (!f || !isMulti(f) || !app) return "";
  const text = scopeSentence(f, app, what);
  if (!text) return "";
  return `<div data-repo-scope-line="${attr(app)}" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:11px 20px;border-bottom:1px solid var(--border);background:color-mix(in srgb,var(--accent) 4%,var(--surface));font-size:12.5px;color:var(--fg-70)">
    <span>${esc(text)}</span>
    <button type="button" data-act="repoPickApp" data-arg="${ALL_APPS}" class="repo-textbtn" style="margin-left:auto;font-size:12.5px;font-weight:500;color:var(--accent);padding:0;white-space:nowrap">Show all apps</button>
  </div>`;
}

/** A PR's two "touches" lines, or null when nothing is known (`touches` absent or null). Line one: the apps it reaches
 *  — those it touches and those that use a Package it touches — or "Repo-wide" when it touches none. Line two: "via
 *  packages/ui" — under one app, only when that app is reached through a Package alone; under All apps, every
 *  Package it touches (the design's shared column). */
export function touchLines(f: Pick<RepoFacts, "allApps">, pr: Pick<RepoPr, "touches" | "packages">, app: string | null | undefined): { touches: string; via: string } | null {
  if (pr.touches === undefined || pr.touches === null) return null;
  const pkgs = pr.packages ?? [];
  const sapps = scopeApps(f);
  const reached = [...new Set([...pr.touches, ...pkgs.flatMap((k) => sapps.find((a) => a.key === k)?.usedBy ?? [])])];
  const via = app && app !== REPO_WIDE ? viaPackages({ touches: pr.touches, packages: pkgs }, app, sapps) : pkgs;
  const folders = via.map((k) => f.allApps.find((a) => a.key === k)).filter((a): a is FactsApp => !!a).map(folderOf);
  return {
    touches: reached.length ? reached.map((k) => labelOf(f, k)).join(", ") : pkgs.length ? "" : "Repo-wide",
    via: folders.length ? `via ${folders.join(", ")}` : "",
  };
}

/** The touches cell of a PR row (the design's 170px column): always emitted in a monorepo, empty when unknown. */
export function touchCell(f: Pick<RepoFacts, "allApps">, pr: RepoPr, app: string | null | undefined): string {
  const l = touchLines(f, pr, app);
  return `<span class="repo-touch" data-touch="${l ? "known" : "unknown"}" style="width:170px;flex:none;display:flex;flex-direction:column;gap:1px;min-width:0">${l
    ? `<span style="font-size:12px;color:var(--fg-70);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.touches)}</span>${l.via ? `<span style="font-family:var(--label);font-size:10.5px;color:var(--fg-40);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.via)}</span>` : ""}`
    : ""}</span>`;
}

/** A failure's apps, quietly after its workflow ("· api"), under All apps; "" when unknown or with one app. A run
 *  attributed from its PUSH's files (its own commit listed none) says so in its tooltip. */
export function failureApps(f: Pick<RepoFacts, "allApps"> | null, r: RepoCiFailure, app: string | null | undefined): string {
  if (!f || !isMulti(f) || app || r.apps === undefined || r.apps === null) return "";
  const words = r.apps.length ? r.apps.map((k) => labelOf(f, k)).join(", ") : "repo-wide";
  const tip = r.approx ? ` data-mtip="${attr("Read from its push's changed files — its own commit listed none.")}"` : "";
  return `<span data-fail-apps${tip} style="font-size:11.5px;color:var(--fg-40);white-space:nowrap;flex:none">· ${esc(words)}</span>`;
}

/** The deploy strips' rows grouped per app, in the facts' app order (the part key IS the app key). */
export function groupDeployRows<R extends { part: string }>(f: Pick<RepoFacts, "allApps">, rows: readonly R[]): { app: string; label: string; rows: R[] }[] {
  const order = new Map(f.allApps.map((a, i) => [a.key, i]));
  const keys = [...new Set(rows.map((r) => r.part))].sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  return keys.map((k) => ({ app: k, label: labelOf(f, k), rows: rows.filter((r) => r.part === k) }));
}
