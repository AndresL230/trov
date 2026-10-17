// Org settings › AI (`#org/ai`) — the organization's switch for everything Trov's AI does (Sift included), the
// Auto switch for Ask Trov, whether each provider's key is set, this month's use of each of the four AI allowances,
// and what is sent to whom
// (organizations.md › Org settings › AI). Everyone reads the tab; only an admin or an owner flips a switch
// (`PUT /ai/settings`), and a member sees their state as words. Pure markup over `GET /ai/settings`
// (shared/ai-core.ts `AiSettings`); the acts are org-actions.ts's (`orgAiToggle`, `orgAiChatAutoToggle`).
//
// The providers are named by their legal names (Anthropic, TypeSafe AI) only where the tab is about the deployment's
// account with each — its key ("Providers") and what is SENT; TypeSafe AI's model is "Sift" everywhere else, never its
// own name.

import { AI_ALLOWANCE_KEYS, AI_PROVIDER_NAMES, type AiAllowanceKey, type AiAllowanceUse, type AiSettings } from "@shared/ai-core";
import type { MyOrg } from "@shared/orgs";
import { esc, attr, surface } from "./ui";
import { goLink, orgHead, tabLead, sliceNote, type OrgSlice } from "./org-ui";
import { switchBtn } from "./notifications";
import { kindMark, aiMark } from "./marks";
import { aiDay } from "./ai-ui";
import { capReached, formatCount, meterPct } from "@shared/plans";

const LIST = "overflow:hidden;list-style:none;margin:0;padding:0";
const ROW = "display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-bottom:1px solid var(--border);margin-bottom:-1px";
const TITLE = "font-size:13.5px;font-weight:600";
const SUB = "font-size:12.5px;color:var(--fg-55);margin-top:3px;line-height:1.55";

/** Each provider's key on this Trov (owner ruling Q8): what it powers, and — when it is missing — what that stops,
 *  said as a fact, never as an error. The providers by their legal names: this is about the deployment's account with
 *  each, as "What is sent" is. */
const PROVIDERS: { key: keyof AiSettings["keys"]; name: string; powers: string; missing: string }[] = [
  { key: "anthropic", name: "Anthropic", powers: "Summaries, briefs, notes, typed filters and Ask Trov.",
    missing: "This Trov has no Anthropic key, so nothing is written whatever the switch says. Whoever runs this Trov can add one." },
  { key: "typesafe", name: "TypeSafe AI", powers: "Sift: tagging existing items, and sorting and checking items.",
    missing: "This Trov has no TypeSafe AI key, so Sift tags, sorts and checks nothing whatever the switch says. Whoever runs this Trov can add one." },
];
/** A canceled plan (owner ruling Q10): AI is paused until the plan is renewed, not until a date. */
export const planEndedLine = (plan: string): string => `This organization's ${plan} plan has ended, so Trov's AI is paused until it is renewed.`;

/** Each allowance in product words: its name, what one of it is, and what stops when it is used up. */
const ALLOWANCE: Record<AiAllowanceKey, { name: string; unit: [one: string, many: string]; what: string; stops: string }> = {
  ai_summaries: { name: "Summaries", unit: ["summary", "summaries"], what: "A summary of each new pull request and issue.", stops: "new pull requests and issues show an excerpt" },
  ai_runs: { name: "Written by Trov", unit: ["run", "runs"], what: "Briefs, repository state, themes and feed entries Trov writes on its own.", stops: "Trov writes nothing new" },
  jev_checks: { name: "Sift", unit: ["check", "checks"], what: "Checks of whether an existing item fits a tag.", stops: "Sift stops looking for items that fit a tag" },
  ai_chat: { name: "Ask Trov", unit: ["question", "questions"], what: "Questions asked of Trov. A Thinking question counts as 5.", stops: "Ask Trov pauses" },
};

/** "12 of 300 runs this month" / "12 runs this month (unlimited)". */
export function allowanceLine(key: AiAllowanceKey, r: AiAllowanceUse): string {
  const [one, many] = ALLOWANCE[key].unit;
  return r.cap === null
    ? `${formatCount(r.used)} ${r.used === 1 ? one : many} this month (unlimited)`
    : `${formatCount(r.used)} of ${formatCount(r.cap)} ${many} this month`;
}

/** One allowance's row: its name and what it counts, this month's use, a meter, and the day it resumes. */
function allowanceRow(key: AiAllowanceKey, r: AiAllowanceUse): string {
  const a = ALLOWANCE[key];
  const line = allowanceLine(key, r);
  // ONE cap test (Q11, shared/plans.ts `capReached`): the meter is full exactly when the "Used up" line shows.
  const used = capReached(r.used, r.cap);
  const pct = meterPct(r.used, r.cap);
  const meter = r.cap === null ? "" : `<div class="cnpy-meter" data-meter="${used ? "full" : "ok"}" role="meter" aria-label="${attr(`${a.name} this month`)}" aria-valuemin="0" aria-valuemax="${r.cap}" aria-valuenow="${Math.min(r.used, r.cap)}" aria-valuetext="${attr(line)}"><span style="width:${pct}%"></span></div>`;
  const resume = used && r.resumesOn
    ? `<div style="font-size:12.5px;color:var(--amber);margin-top:8px">Used up for this month: ${esc(a.stops)} until ${esc(aiDay(r.resumesOn))}.</div>` : "";
  return `<li style="${ROW};flex-direction:column;gap:0" data-ai-allowance="${key}">
      <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;width:100%">
        <span style="${TITLE}">${esc(a.name)}</span>
        <span data-ai-use style="font-size:13px;font-weight:500;font-variant-numeric:tabular-nums">${esc(line)}</span>
      </div>
      <div style="${SUB};width:100%">${esc(a.what)}</div>
      <div style="width:100%">${meter}${resume}</div>
    </li>`;
}

/** A switch an admin flips, or its state as a word for a member. */
function control(a: AiSettings, act: string, on: boolean, label: string, id: string, saving: boolean): string {
  return a.canEdit
    ? `<span style="display:inline-flex;align-items:center;gap:10px"${saving ? ' aria-busy="true"' : ""}><span id="${id}" style="font-size:12.5px;color:var(--fg-55)">${on ? "On" : "Off"}</span>${switchBtn(act, null, on, label, saving)}</span>`
    : `<span style="font-size:13px;font-weight:500;color:var(--fg-70)">${on ? "On" : "Off"}</span>`;
}

export function aiTab(org: MyOrg, slice: OrgSlice<AiSettings | null>, saving: boolean): string {
  const a = slice.data;
  if (!a) return sliceNote(slice, "the AI settings", false, { form: true }) || "";
  const on = a.enabled;
  const lead = tabLead(`Trov's AI is <strong>${on ? "on" : "off"}</strong> for ${esc(org.name)}: it summarizes new pull requests and issues, writes briefs, the Repo dashboard's state and themes, and feed entries from your work, suggests values a person accepts, and runs Sift on your tags.${a.canEdit ? "" : " Only an admin or an owner can change this."}`);

  // The switch every AI feature sits under — an admin's; a member reads its state as words. An ended plan says so
  // under it, with the way to the plan (Org settings › General).
  const ended = a.planEnded
    ? `<div data-ai-plan-ended style="font-size:12.5px;color:var(--fg-70);margin-top:6px;line-height:1.55">${kindMark("Ended", "stopped", 12)} ${esc(planEndedLine(a.planEnded))} ${goLink("Plan and billing", "orgGo", "general")}</div>`
    : "";
  const automation = `<section aria-labelledby="org-ai-auto" data-org-ai="${on ? "on" : "off"}">
      ${orgHead("Automation", "", null, "org-ai-auto")}
      <ul${surface(LIST)}><li style="${ROW}">
        <span style="flex:none;margin-top:2px">${aiMark(15)}</span>
        <div style="flex:1 1 260px;min-width:0">
          <div style="${TITLE}">AI for this organization</div>
          <div style="${SUB}">Off stops every new summary, brief, state, theme, feed entry and suggestion, and Sift; what was already written stays until it is replaced.</div>
          ${ended}
        </div>
        <div style="flex:none">${control(a, "orgAiToggle", on, "Trov's AI for this organization", "org-ai-switch-l", saving)}</div>
      </li>
      <li style="${ROW}" data-ai-chat-auto="${a.chatAuto ? "on" : "off"}">
        <div style="flex:1 1 260px;min-width:0">
          <div style="${TITLE}">Auto mode in Ask Trov</div>
          <div style="${SUB}">On lets a person have Ask Trov make changes without confirming each one, with Undo; every change is still recorded. Off means each change waits for the person to confirm it.</div>
        </div>
        <div style="flex:none">${control(a, "orgAiChatAutoToggle", a.chatAuto, "Auto mode in Ask Trov for this organization", "org-ai-chat-auto-l", saving)}</div>
      </li>
      <li style="${ROW}" data-ai-chat-github="${a.chatGithub ? "on" : "off"}">
        <div style="flex:1 1 260px;min-width:0">
          <div style="${TITLE}">GitHub lookups in Ask Trov</div>
          <div style="${SUB}">On lets Ask Trov read your connected repositories on GitHub when a question needs it: files, pull requests, issues, commits and checks, sent to Anthropic to answer. Each person only gets what their own linked GitHub account can read. Off by default.</div>
        </div>
        <div style="flex:none">${control(a, "orgAiChatGithubToggle", a.chatGithub, "GitHub lookups in Ask Trov for this organization", "org-ai-chat-github-l", saving)}</div>
      </li></ul>
    </section>`;

  // Each provider's key on this Trov: set (a plain fact), or missing (the mark, and what that stops).
  const providers = `<section aria-labelledby="org-ai-keys" style="margin-top:22px">
      ${orgHead("Providers", "", null, "org-ai-keys")}
      <ul${surface(LIST)} data-ai-keys>${PROVIDERS.map((p) => {
        const set = a.keys[p.key];
        return `<li style="${ROW}" data-ai-key="${p.key}" data-set="${set ? "1" : "0"}">
          <div style="flex:1 1 260px;min-width:0">
            <div style="${TITLE}">${esc(p.name)}</div>
            <div style="${SUB}">${esc(p.powers)}</div>
            ${set ? "" : `<div style="font-size:12.5px;color:var(--fg-70);margin-top:6px;line-height:1.55">${esc(p.missing)}</div>`}
          </div>
          <div style="flex:none;font-size:13px;font-weight:500;color:var(--fg-70)">${set ? "Key set" : kindMark("No key", "waiting", 12)}</div>
        </li>`;
      }).join("")}</ul>
    </section>`;

  // This month's use of each allowance.
  const month = `<section aria-labelledby="org-ai-month" style="margin-top:22px">
      ${orgHead("This month", "", null, "org-ai-month")}
      <ul${surface(LIST)} data-ai-allowances>${AI_ALLOWANCE_KEYS.map((k) => allowanceRow(k, a.allowances[k])).join("")}</ul>
      <div style="font-size:12px;color:var(--fg-55);margin-top:8px">Counted per calendar month (UTC), against this organization's plan.</div>
    </section>`;

  // What leaves Trov, and to whom — one list per provider, so it grows as features land.
  const sendRow = (s: AiSettings["sends"][number]) =>
    `<li style="${ROW}"><div style="min-width:0"><div style="font-size:13.5px;line-height:1.5">${esc(s.what)}</div><div style="font-size:12px;color:var(--fg-55);margin-top:2px">For ${esc(/^(Sift|Ask Trov)\b/.test(s.for) ? s.for : s.for.charAt(0).toLowerCase() + s.for.slice(1))}</div></div></li>`;
  const byProvider = AI_PROVIDER_NAMES.map((p) => {
    const lines = a.sends.filter((s) => s.provider === p);
    const body = lines.length ? lines.map(sendRow).join("") : `<li style="${ROW}"><span style="font-size:13px;color:var(--fg-55)">Nothing is sent yet.</span></li>`;
    return `<div style="margin-top:10px"><div style="font-size:12px;font-weight:600;color:var(--fg-55);margin:0 0 6px">To ${esc(p)}</div>
        <ul${surface(LIST)} data-ai-sends="${attr(p)}">${body}</ul></div>`;
  }).join("");
  const sent = `<section aria-labelledby="org-ai-sent" style="margin-top:22px">
      ${orgHead("What is sent", "", null, "org-ai-sent")}
      ${byProvider}
      <ul${surface(`${LIST};margin-top:10px`)}>
        <li style="${ROW}"><div style="min-width:0"><div style="font-size:12px;font-weight:600;color:var(--fg-55)">Never sent</div><div style="font-size:13.5px;line-height:1.5;margin-top:2px">${esc(a.neverSent)}</div></div></li>
      </ul>
    </section>`;
  return `${lead}${automation}${providers}${month}${sent}`;
}
