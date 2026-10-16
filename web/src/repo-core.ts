// The Repo screen's eager part (web-ui.md › The app's bundles): what main.ts needs whether or not the
// screen has been opened — the "Poll now" result's lifetime, the header's "updated …" label it re-ticks,
// the count-up's number format — and the App menu's "All apps" value. Everything else of the screen is
// repo.ts and its blocks, the lazy Repo chunk (repo-lazy.ts); repo.ts re-exports all of this.
import type { RepoRefreshResult } from "@shared/repo";
import type { RepoProps } from "./repo";

/** The App menu's value for "All apps" (a dropdown option needs a string). */
export const ALL_APPS = "__all";

/** "Poll now" (POST /admin/poll): in flight, its per-source outcomes, a 409 (another refresh holds the lock), or a failed request. */
export type RepoPollState = { status: "polling" } | { status: "done"; result: RepoRefreshResult } | { status: "busy" } | { status: "error" };

/** Short age: "just now" is "0m" in a dense column, so floor at 1m. */
export function ago(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.max(1, Math.round((now - then) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** "updated just now" / "updated 4m ago" — main.ts re-ticks this node in place. */
export function repoUpdatedLabel(p: Pick<RepoProps, "repo" | "fetchedAt">, now: number = Date.now()): string {
  if (p.repo.status === "loading") return p.repo.data ? "refreshing…" : "loading…";
  if (p.fetchedAt === null) return "";
  const mins = Math.max(0, Math.round((now - p.fetchedAt) / 60000));
  return mins < 1 ? "updated just now" : `updated ${mins}m ago`;
}

/** A figure as `countUp` (main.ts) writes it mid-animation — it mirrors the
 *  Worker's `compact` / `productValue` for the frames in between only: the last
 *  frame restores the DTO's own string, so the two can never disagree on screen. */
export function formatCount(n: number, fmt: string | undefined): string {
  const compact = (v: number): string =>
    v >= 999_995_000_000 ? `${(v / 1e12).toFixed(2)}T` : v >= 999_995_000 ? `${(v / 1e9).toFixed(2)}B`
    : v >= 999_950 ? `${(v / 1e6).toFixed(2)}M` : v >= 1_000 ? `${(v / 1e3).toFixed(1)}K` : String(Math.round(v));
  if (fmt === "usd") return n >= 1_000_000 ? `$${compact(n / 100)}` : (n / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return fmt === "compact" ? compact(n) : String(Math.round(n));
}

/** The poll result belongs to the Repo SCREEN, not to one of its tabs: it is kept
 *  while the person is anywhere on Repo and dropped the moment they are not
 *  (main.ts applies this on every rerender, so an in-flight poll's answer is
 *  dropped on arrival too). */
export const repoPollFor = (poll: RepoPollState | null, onRepoScreen: boolean): RepoPollState | null => (onRepoScreen ? poll : null);
