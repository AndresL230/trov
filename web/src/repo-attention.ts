// Repo › Overview › Needs attention (the design's NeedsAttention.dc.html, `attentionModel` in repo-data.js).
// The server sends attention STRUCTURED (`FactsAttention`: a kind, the app and environment, refs — never a
// sentence); this module words each item from those refs and the facts around them, so the design's sentences
// ("Production deploy e07b3a2 failed 12m ago on Cloudflare. c41e7d9 is still serving.") are read, never stored.
//
// A host's name is the PART's label (`FactsPart.host`, the provider's label in the registry) — found by the item's
// app and environment, or by the provider it names — never a switch on a provider id. Every action that leaves
// Trov (a build log, a host's console, GitHub's compare) is a link only when the facts carry an https address and
// this is not the sample; otherwise it opens the tab that holds the same thing in Trov.
import type { FactsAttention, FactsPart, RepoFacts } from "@shared/repo-facts-core";
import type { RepoTab } from "@shared/repo";
import { esc, attr } from "./ui";
import { markShape, STATE_KIND, type StateKind } from "./marks";
import { ago } from "./repo";
import { short as shortSha } from "./repo-block-kit";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";

/** The mark per kind (the design's `attentionModel`: the kind's own MARK, `waiting` for waiting). */
export const ATTENTION_KIND: Record<FactsAttention["kind"], StateKind> = {
  failed: "bad", previewFailing: "bad", down: "stopped", stale: "waiting",
  outOfStep: "warn", rolledBack: "warn", waiting: "warn", degraded: "warn",
};

export interface AttentionAction {
  label: string;
  /** An https address outside Trov (drawn with ↗ and opened in a new tab), when the facts have one. */
  href: string | null;
  /** Leaves Trov when it can: without an address it opens `tab` instead. */
  external: boolean;
  /** The tab that holds the same thing in Trov. */
  tab: RepoTab | null;
  /** An in-page act instead (See what is waiting). */
  act?: string;
  arg?: string;
}
export interface AttentionLine { kind: StateKind; text: string; action: AttentionAction }

const https = (u: string | null | undefined): string | null => (u && /^https:\/\//i.test(u) ? u : null);
const hostname = (u: string): string => u.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "6 minutes", "1 hour", "3 days" — how long, in words (the design's sentences that say "for …" or "… old"). */
export function longFor(iso: string | undefined, now: number): string {
  const then = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(then)) return "a while";
  const mins = Math.max(1, Math.round((now - then) / 60000));
  if (mins < 60) return plural(mins, "minute");
  const h = Math.round(mins / 60);
  if (h < 24) return plural(h, "hour");
  return plural(Math.round(h / 24), "day");
}

const envName = (f: RepoFacts, key: string | null): string =>
  (key && f.envs.find((e) => e.key === key)?.name) || (key ? key.charAt(0).toUpperCase() + key.slice(1) : "");
const partOf = (f: RepoFacts, a: FactsAttention): FactsPart | undefined =>
  f.parts.find((p) => p.app === a.app && p.env === a.env)
  ?? (a.refs.provider ? f.parts.find((p) => p.provider === a.refs.provider && (a.app === null || p.app === a.app)) ?? f.parts.find((p) => p.provider === a.refs.provider) : undefined);
/** More than one app that deploys: sentences about one app name it first ("api: production deploy …"). */
const manyApps = (f: RepoFacts): boolean => f.allApps.filter((a) => a.kind !== "Package").length > 1;
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** One item as the design's sentence and its action. Pure: the same facts and `now` always word the same. */
export function attentionLine(a: FactsAttention, f: RepoFacts, now: number): AttentionLine {
  const r = a.refs;
  const part = partOf(f, a);
  const host = part?.host ?? null;
  const app = a.app ?? "";
  const Env = envName(f, a.env);
  const env = Env.toLowerCase();
  const lead = (rest: string): string => (manyApps(f) && app ? `${app}: ${rest}` : cap(rest));
  const kind = ATTENTION_KIND[a.kind];
  const ext = (label: string, href: string | null, tab: RepoTab): AttentionAction => ({ label, href: https(href), external: true, tab });
  const onHost = (fallbackTab: RepoTab): AttentionAction => (host
    ? ext(`Open ${app || "it"} on ${host}`, part?.consoleUrl ?? null, fallbackTab)
    : ext("Open the host", null, fallbackTab));

  // A sha in a sentence reads as 7 characters, as everywhere else on the screen (the facts carry GitHub's full 40);
  // a link (Compare) keeps the full ones.
  const sh = (x: string | null | undefined): string | null => (x ? shortSha(x) : null);

  switch (a.kind) {
    case "failed": {
      const serving = r.sha ? `${sh(r.sha)} is still serving.` : "Nothing is serving yet.";
      return { kind, text: `${lead(`${env} deploy ${sh(r.failedSha) ?? "of the newest commit"} failed ${ago(r.since ?? "", now)} ago${host ? ` on ${host}` : ""}.`)} ${serving}`,
        action: ext("View build log", part?.latest?.logUrl ?? part?.consoleUrl ?? null, "ci") };
    }
    case "rolledBack": {
      const by = part?.serving?.by ? ` by ${part.serving.by}` : "";
      const next = r.nextSha && part?.latest?.sha === r.nextSha && (part.latest.state === "building" || part.latest.state === "queued") ? `; ${sh(r.nextSha)} is building` : "";
      const compare = r.sha && r.prevSha ? `https://github.com/${f.repo}/compare/${r.sha}...${r.prevSha}` : null;
      return { kind, text: `${lead(`${env} was rolled back to ${sh(r.sha) ?? "an earlier commit"}${by} ${ago(r.since ?? "", now)} ago.`)}${r.prevSha ? ` ${sh(r.prevSha)} is no longer live${next}.` : ""}`,
        action: ext("Compare", compare, "ci") };
    }
    case "down": {
      const url = r.url ?? part?.health?.url ?? part?.url ?? null;
      const where = url ? hostname(url) : "Its address";
      return { kind, text: `${Env}: ${app || "it"} is down. ${where} has not answered its health check for ${longFor(r.since, now)}.`,
        action: url ? ext(`Open ${hostname(url)}`, url, "usage") : onHost("usage") };
    }
    case "stale": {
      const building = r.nextSha && host && part?.latest?.sha === r.nextSha && (part.latest.state === "building" || part.latest.state === "queued") ? ` ${host} is building ${sh(r.nextSha)}.` : "";
      return { kind, text: `${Env}: ${app || "its"}’s health reading is ${longFor(r.since, now)} old.${building}`, action: onHost("usage") };
    }
    case "outOfStep": {
      const o = f.outOfStep.find((x) => x.env === a.env && x.app === a.app);
      const of = r.of ?? o?.of ?? null;
      const ofSha = o?.ofSha ?? (of ? f.parts.find((p) => p.app === of && p.env === a.env)?.serving?.sha ?? null : null);
      const n = r.behindBy ?? o?.behindBy ?? null;
      const behind = n === null ? "behind" : `${plural(n, "commit")} behind`;
      return { kind, text: `${Env}: ${app} runs ${sh(r.sha ?? o?.sha) ?? "an older commit"}, ${behind}${of ? ` ${of}` : ""}${ofSha ? ` (${sh(ofSha)})` : ""}.${host ? ` ${host} has not deployed ${app} since the last promotion.` : ""}`,
        action: onHost("usage") };
    }
    case "waiting": {
      const n = r.count ?? null;
      const what = n === null ? "Commits" : plural(n, "commit");
      const text = r.sha
        ? lead(`${Env} runs ${sh(r.sha)} from ${longFor(r.since, now)} ago; ${n === null ? "commits are" : `${what} ${n === 1 ? "is" : "are"}`} waiting.`)
        : lead(`${what} merged ${longFor(r.since, now)} ago ${n === 1 ? "is" : "are"} not in ${env}.`);
      return { kind, text, action: { label: "See what is waiting", href: null, external: false, tab: null, act: "repoSeeWaiting", arg: app } };
    }
    case "degraded": {
      const ci = f.ci.find((c) => c.env === a.env);
      const failing = r.count ?? ci?.failing ?? null;
      const total = ci?.total ?? null;
      const branch = f.envs.find((e) => e.key === a.env)?.branch ?? null;
      const checks = failing === null ? "Checks fail" : total === null ? `${plural(failing, "check")} ${failing === 1 ? "fails" : "fail"}` : `${failing} of ${total} checks ${failing === 1 ? "fails" : "fail"}`;
      const check = r.check ?? ci?.names[0] ?? null;
      return { kind, text: `${Env}: ${checks} on ${branch ?? "the branch head"}${check ? ` (${check})` : ""}.`, action: ext("View the run", null, "ci") };
    }
    case "previewFailing": {
      const n = r.count ?? 1;
      const pr = r.pr ? `#${r.pr}` : "a branch";
      const text = n > 1
        ? lead(`preview for ${pr} has failed for ${longFor(r.since, now)}, on the last ${n} builds.`)
        : lead(`preview for ${pr} failed ${ago(r.since ?? "", now)} ago.`);
      return { kind, text, action: ext("View build log", null, "ci") };
    }
  }
}

function actionHtml(a: AttentionAction, sample: boolean): string {
  const btn = "cnpy-outlinebtn repo-att-act";
  const style = "height:30px;padding:0 12px;border-radius:8px;font-size:12.5px;font-weight:500;border:1px solid var(--border-strong);color:var(--fg-70);background:var(--surface);white-space:nowrap;flex:none;display:inline-flex;align-items:center;gap:6px;text-decoration:none";
  if (a.act) return `<button type="button" data-act="${attr(a.act)}" data-arg="${attr(a.arg ?? "")}" class="${btn}" style="${style}">${esc(a.label)}</button>`;
  if (a.href && !sample) return `<a href="${attr(a.href)}" target="_blank" rel="noopener" class="${btn}" style="${style}">${esc(a.label)} <span aria-hidden="true">↗</span></a>`;
  return `<button type="button" data-act="setRepoTab" data-arg="${attr(a.tab ?? "ci")}" class="${btn}" style="${style}">${esc(a.label)}</button>`;
}

/** Needs attention: only when something is wrong, and first (under the state slot). "" when nothing is. */
export const attentionBlock: OverviewBlock = (f: RepoFacts, x: OverviewCtx): string => {
  if (!f.attention.length) return "";
  const rows = f.attention.map((a, i) => {
    const l = attentionLine(a, f, x.now);
    const k = STATE_KIND[l.kind];
    return `<div class="repo-att-row" data-att-kind="${attr(a.kind)}" style="${i ? "border-top:1px solid var(--border);" : ""}">
      <div style="display:flex;align-items:flex-start;gap:12px;flex:1 1 300px;min-width:0">
        <span style="flex:none;display:flex;width:12px;justify-content:center;padding-top:5px">${markShape(k.shape, k.tone, 10)}</span>
        <span data-att-text style="flex:1;min-width:0;font-size:13.5px;line-height:1.5;color:var(--fg);text-wrap:pretty">${esc(l.text)}</span>
      </div>
      ${actionHtml(l.action, x.sample)}
    </div>`;
  }).join("");
  const label = "font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);white-space:nowrap";
  return `<div class="repo-att">
    <div style="display:flex;align-items:baseline;gap:8px"><span style="${label}">Needs attention</span>${f.attention.length > 1 ? `<span style="font-size:11.5px;color:var(--fg-40)">${f.attention.length}</span>` : ""}</div>
    ${rows}
  </div>`;
};
