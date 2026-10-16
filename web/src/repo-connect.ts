// Repo › Overview › the connect card (the design's scenario G card, RepoScreen.dc.html `v.connect`): ONE card above
// the opener when a part's host is not connected (`facts.connect`). The opener still draws below it, with Unknown
// cells and "—" figures, so the repository's shape shows before the host is connected and nothing reads as zero.
//
//   need `deploys`  nothing reports this app's deploys without the host — the design's G card, word for word in
//                   shape — but never "<host> does not report deploys to GitHub" (a host may; Trov saw none): what is true.
//   need `metrics`  deploys already arrive through GitHub deployments ("via GitHub"); the host is asked for CPU and
//                   memory only — the build's one copy change from the design.
//
// The host is named by its parts' label, never by a provider id. Every member sees the card; only an admin gets
// the action, which opens Org settings › Hosting (connecting is a person's act there, never one here).
import type { RepoFacts } from "@shared/repo-facts-core";
import { esc } from "./ui";
import type { OverviewBlock, OverviewCtx } from "./repo-overview-ctx";

const list = (xs: string[], and: string): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} ${and} ${xs[xs.length - 1]}`);

export interface ConnectCopy { title: string; text: string; action: string; note: string }

/** The card's words, from the hint and the parts it names. null = no card. */
export function connectCopy(f: Pick<RepoFacts, "connect" | "parts" | "envs" | "allApps">): ConnectCopy | null {
  const c = f.connect;
  if (!c) return null;
  const parts = f.parts.filter((p) => p.provider === c.provider && c.apps.includes(p.app));
  const host = parts[0]?.host ?? f.parts.find((p) => p.provider === c.provider)?.host ?? "the host";
  const apps = f.allApps.filter((a) => c.apps.includes(a.key));
  const services = apps.length > 0 && apps.every((a) => a.kind === "Service" || a.kind === "Job");
  const noun = services ? "service" : "app";
  const action = `Connect ${host}`;
  const note = "Members see this note too; only an admin can connect a host, in Org settings › Hosting.";
  if (c.need === "deploys") {
    const envs = f.envs.filter((e) => parts.some((p) => p.env === e.key)).map((e) => e.name);
    const where = envs.length ? `in ${list(envs, "or")}` : "anywhere";
    // Never "<host> does not report deploys to GitHub": a host may well post GitHub deployments (Railway does); Trov has
    // just seen none for these. And when the parts still show deploys read before, say what those are — never "cannot
    // see what is running" beside them.
    const seen = parts.some((p) => p.serving || p.latest || p.history.length);
    const where2 = envs.length ? `in ${list(envs, "or")}` : "there";
    return {
      title: "Deploys not connected",
      text: seen
        ? `${host} isn't connected, so what runs ${where2} is as Trov last read it. Connect ${host} once and every ${noun} here stays current, with CPU and memory too.`
        : `${host} isn't connected and GitHub has reported no deploys for these ${noun}s, so Trov cannot see what is running ${where} yet. Connect ${host} once and every ${noun} here fills in, with CPU and memory too.`,
      action, note,
    };
  }
  const names = list(c.apps, "and");
  return {
    title: "CPU and memory not connected",
    text: `Deploys for ${names || `these ${noun}s`} arrive via GitHub. Connect ${host} for CPU and memory; deploys keep coming from GitHub either way.`,
    action, note,
  };
}

export const connectBlock: OverviewBlock = (f: RepoFacts, x: OverviewCtx): string => {
  const c = connectCopy(f);
  if (!c) return "";
  const btn = x.admin
    ? `<button type="button" data-act="orgGo" data-arg="hosting" class="cnpy-accentbtn" style="height:32px;padding:0 14px;border-radius:8px;background:var(--accent);color:var(--accent-fg);border:1px solid transparent;font-size:12.5px;font-weight:600;white-space:nowrap">${esc(c.action)}</button>`
    : `<span data-connect-note style="font-size:12px;color:var(--fg-40);max-width:34ch;line-height:1.45">${esc(c.note)}</span>`;
  return `<div class="repo-connect" data-connect-need="${f.connect?.need ?? ""}">
    <div class="repo-connect-card" style="border-radius:11px">
      <div style="flex:1 1 360px;min-width:0"><div style="font-size:13.5px;font-weight:600">${esc(c.title)}</div><div style="font-size:12.5px;color:var(--fg-55);margin-top:4px;line-height:1.55;max-width:72ch">${esc(c.text)}</div></div>
      ${btn}
    </div>
  </div>`;
};
