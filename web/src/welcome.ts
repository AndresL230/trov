// The guided first-run setup (`#welcome[/<step>]`) — the full page a person lands on the moment
// they create an organization, set up a granted or paid one, or accept an invitation
// (org-picker-actions.ts). One step at a time, each skippable, Back always there:
//   an OWNER or ADMIN:  connect a repository → connect your coding agent → invite your team → done
//   a MEMBER:           connect your coding agent → done
// It is a ROUTE, not server state: a reload stays on the step, and Org settings' checklist and
// Help › Get Started link back to it. Nothing here is stored.
//
// Every step's done-state is DERIVED from reads the SPA already makes — Org settings' slices
// (`OrgUi`: repositories, the GitHub App's connection, members, invitations, the plan) and the
// person's own agent connections (Settings › MCP access's two reads: `GET /auth/oauth-grants`,
// the org's MCP tokens). A read that has not answered, or failed, is "not known yet" — never
// done, never to-do. Nothing on this page calls GitHub: the repository list is Org settings'
// own read, asked by its controller (org-actions.ts), never from a render.
//
// Purely presentational: props in, markup out, in the organization pages' atoms (org-ui.ts) on
// the picker's page frame (`.cnpy-orgs`). Its own acts start with `welcome`
// (welcome-actions.ts); the invite form, the repository picker and the Copy buttons keep the
// acts they have everywhere else.

import { trovMark } from "@shared/mark";
import type { MyOrg, OrgRole } from "@shared/orgs";
import type { McpTokenSummary, OAuthGrantSummary } from "@shared/rows";
import { isSoloPlan } from "@shared/plans";
import { esc, attr, relTime, surface } from "./ui";
import { O_HELP, accentBtn, chip, failedNote, goLink, quietBtn, roleAtLeast, roleChip } from "./org-ui";
import { orgTile } from "./org-logo";
import { skeleton, skLine, skLines, skBox } from "./skeleton";
import { dropdownMenu, initialDropdownUi, type DropdownUi } from "./dropdown";
import { githubOf, inviteMailNote, inviteRoleDropdown, inviteSection, type OrgUi } from "./org-settings";
import { seatsLead } from "./org-plan";
import { NOT_CONFIGURED_LINE, appLeadPhrase, connectLink, connectNotice, existingLink, lostBanner, mismatchBanner, repoPicker, suspendedBanner } from "./github-app";
import { ONE_ORG_NOTE, browserConnectCommand, connectSteps, copyBox, mcpCode, mcpStrong } from "./mcp-connect";

// ── steps and state ──────────────────────────────────────────────────────────

export type WelcomeStep = "github" | "agent" | "team" | "done";
export const WELCOME_STEPS: readonly WelcomeStep[] = ["github", "agent", "team", "done"];
export const isWelcomeStep = (v: unknown): v is WelcomeStep => typeof v === "string" && (WELCOME_STEPS as readonly string[]).includes(v);

/** What the wizard keeps in AppState (`state.welcome`): the step on screen (the route), and the
 *  agent step's by-hand disclosure. */
export interface WelcomeUi { step: WelcomeStep; byHand: boolean }
export const initialWelcomeUi = (): WelcomeUi => ({ step: "github", byHand: false });

/** A step, read off live data: done, still to do — or not known yet (its read is out, or failed). */
export type StepState = "done" | "todo" | "unknown";

/** One read as the wizard needs it (AppState's `Loadable` and Org settings' `OrgSlice` both fit). */
export interface WelcomeRead<T> { status: "idle" | "loading" | "ok" | "error" | "unauth"; data: T; error?: string }

export interface WelcomeProps {
  /** What sits behind the card: the app itself, loading (render.ts `firstRunBackdrop`). */
  backdrop?: string;
  /** The org on screen, with MY role in it (null until `me` / `GET /api/orgs` names it). */
  org: MyOrg | null;
  /** The step the route asks for; the view shows `effectiveWelcomeStep` of it. */
  step: WelcomeStep;
  me: { handle: string; name: string | null; identities: readonly { provider: "github" | "google"; label: string }[] } | null;
  /** Org settings' reads and its invite form (`state.org`). */
  ui: OrgUi;
  /** MY agent connections, every org's (`GET /auth/oauth-grants`). */
  grants: WelcomeRead<OAuthGrantSummary[]>;
  /** MY access tokens for the org on screen (the older, pasted-token setups). */
  tokens: WelcomeRead<McpTokenSummary[]>;
  wel: WelcomeUi;
  dd?: DropdownUi;
}

/** The steps a role walks: a member only connects their agent. A one-person plan has no team to
 *  invite, so that step is not asked (as on Org settings' checklist) — once the plan is known. */
export function welcomeStepsFor(role: OrgRole | null | undefined, ui: Pick<OrgUi, "plan">): WelcomeStep[] {
  if (!roleAtLeast(role, "admin")) return ["agent", "done"];
  const solo = ui.plan.data?.entitlements.seats === 1 && isSoloPlan(ui.plan.data.plan);
  return solo ? ["github", "agent", "done"] : ["github", "agent", "team", "done"];
}
/** The step on screen: the asked one, or — when this person's flow has no such step — its first. */
export function effectiveWelcomeStep(step: WelcomeStep, steps: readonly WelcomeStep[]): WelcomeStep {
  return steps.includes(step) ? step : steps[0];
}

/** A repository is tracked. Known only once the repositories read has answered. */
export function githubStepState(ui: Pick<OrgUi, "repos">): StepState {
  if (ui.repos.data.length > 0) return "done"; // rows held from an earlier answer are still rows
  return ui.repos.status === "ok" ? "todo" : "unknown";
}
/** MY connections into THIS org: the OAuth grants made into it, and my tokens for it. */
export function agentConnections(p: Pick<WelcomeProps, "grants" | "tokens">, slug: string): { grants: OAuthGrantSummary[]; tokens: McpTokenSummary[] } {
  return { grants: p.grants.data.filter((g) => g.org.slug === slug), tokens: p.tokens.data };
}
/** This person has an agent connection for this org. One found is enough; "none" needs BOTH reads to
 *  have answered — a failed or pending read is not a no. */
export function agentStepState(p: Pick<WelcomeProps, "grants" | "tokens">, slug: string): StepState {
  const mine = agentConnections(p, slug);
  if (mine.grants.length > 0 || mine.tokens.length > 0) return "done";
  return p.grants.status === "ok" && p.tokens.status === "ok" ? "todo" : "unknown";
}
/** Someone else is in the org, or has been invited (Org settings' checklist's rule). */
export function teamStepState(ui: Pick<OrgUi, "members" | "invites">): StepState {
  if (ui.members.data.length > 1 || ui.invites.data.some((i) => i.status === "pending")) return "done";
  return ui.members.status === "ok" && ui.invites.status === "ok" ? "todo" : "unknown";
}
/** Every step's state for the org on screen. `done` is done once every step before it is. */
export function welcomeStates(p: Pick<WelcomeProps, "org" | "ui" | "grants" | "tokens">): Record<WelcomeStep, StepState> {
  const steps = welcomeStepsFor(p.org?.role, p.ui);
  const github = githubStepState(p.ui), agent = p.org ? agentStepState(p, p.org.slug) : "unknown", team = teamStepState(p.ui);
  const each: Record<WelcomeStep, StepState> = { github, agent, team, done: "todo" };
  const before = steps.filter((s) => s !== "done").map((s) => each[s]);
  each.done = before.every((s) => s === "done") ? "done" : before.some((s) => s === "unknown") ? "unknown" : "todo";
  return each;
}

// ── atoms ────────────────────────────────────────────────────────────────────

const STEP_LABEL: Record<WelcomeStep, string> = { github: "Repository", agent: "Coding agent", team: "Team", done: "Done" };
const STATE_WORD: Record<StepState, string> = { done: "done", todo: "to do", unknown: "not known yet" };
const CHECK = (size = 13, stroke = "currentColor"): string => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${stroke}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none"><path d="M20 6 9 17l-5-5"></path></svg>`;
const OK_RING = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path></svg>`;
const P = "margin:0;font-size:13px;line-height:1.6;color:var(--fg-70)";
const CARD_T = "font-size:14px;font-weight:600;letter-spacing:-0.005em;color:var(--fg)";

/** The step indicator: every step of this person's flow, in order, each a button to it. The step on
 *  screen is `aria-current="step"`; a finished one carries a check — read off live data, so a step
 *  whose read is still out shows its number, never a check. */
export function welcomeStepper(steps: readonly WelcomeStep[], current: WelcomeStep, states: Record<WelcomeStep, StepState>): string {
  const items = steps.map((s, i) => {
    const cur = s === current;
    // "Done" is where the flow ends, not a task: it is never ticked.
    const st: StepState = s === "done" ? "todo" : states[s];
    const mark = st === "done" ? CHECK(12) : String(i + 1);
    const said = s === "done" ? "" : `, ${STATE_WORD[st]}`;
    return `<li class="cnpy-wel-step${cur ? " is-cur" : ""}" data-step="${s}" data-state="${st}">
      <button type="button" data-act="welcomeGo" data-arg="${s}" data-field="${attr(`welcomeGo:${s}`)}"${cur ? ' aria-current="step"' : ""} aria-label="${attr(`Step ${i + 1} of ${steps.length}: ${STEP_LABEL[s]}${said}`)}" class="cnpy-wel-stepb" style="border-radius:8px">
        <span class="cnpy-wel-mark" aria-hidden="true" style="border-radius:50%">${mark}</span><span class="cnpy-wel-stepl">${esc(STEP_LABEL[s])}</span>
      </button>
    </li>`;
  }).join("");
  return `<nav aria-label="Setup steps"><ol class="cnpy-wel-steps">${items}</ol></nav>`;
}

/** A quiet card that says one thing and offers its one action. */
function sayCard(title: string, body: string, action = "", attrs = ""): string {
  return `<div${surface("padding:18px 20px")}${attrs}>
    <div style="${CARD_T}">${title}</div>
    <p style="${P};margin-top:5px">${body}</p>
    ${action ? `<div class="cnpy-wel-acts">${action}</div>` : ""}
  </div>`;
}

// ── step 1: a repository ─────────────────────────────────────────────────────

/** Connect GitHub and pick the repository to track — or, for a person with no GitHub account linked
 *  (they signed in with Google), link one first: the connect route accepts an approval only from the
 *  GitHub identity linked to this Trov person (src/github-app/connect.ts, `wrong_account`). */
export function githubStep(p: WelcomeProps): string {
  const org = p.org!;
  const ui = p.ui;
  const repos = ui.repos.data;
  const app = githubOf(ui);
  const inst = app?.installation ?? null;
  const live = !!inst && !inst.suspended_at;
  const notice = `${connectNotice(ui.githubNotice, org.slug, org.name)}${lostBanner(app, true)}${suspendedBanner(inst)}${mismatchBanner(app, true, org.slug)}`;
  const byName = goLink("Add a repository by name instead", "orgGo", "repos");

  if (repos.length > 0) {
    const rows = repos.map((r) => `<li class="cnpy-wel-row" data-welcome-repo="${attr(r.repo_full_name)}">${OK_RING}<span style="flex:1 1 200px;min-width:0;font-family:var(--code);font-size:12.5px;color:var(--fg);overflow-wrap:anywhere">${esc(r.repo_full_name)}</span>${r.is_primary ? chip("Primary", "var(--accent)") : ""}</li>`).join("");
    return `${notice}<div${surface("padding:18px 20px")} data-welcome-github="tracked">
      <div style="${CARD_T}">${repos.length === 1 ? "Your repository is connected" : `${repos.length} repositories are connected`}</div>
      <p style="${P};margin-top:5px">Trov reads ${repos.length === 1 ? "its" : "the primary one's"} pull requests, issues, checks and deployments${inst ? ` ${appLeadPhrase(inst)}` : ""}.</p>
      <ul class="cnpy-wel-list">${rows}</ul>
      <div class="cnpy-wel-quiet">${goLink("Track another, or manage them in Org settings", "orgGo", "repos")}</div>
    </div>`;
  }
  // Nothing tracked — and whether that is known, and how GitHub is offered here, is read, not guessed.
  if (ui.repos.status === "error") return `${notice}${failedNote("the repositories")}`;
  if (ui.repos.status !== "ok" || (app === null && ui.github.status !== "error")) {
    return `${notice}<div${surface("padding:18px 20px")} data-welcome-github="loading">${skeleton("wel-github", "Checking the GitHub connection&hellip;", `${skLine("42%", 14, 1.5)}${skLines(["86%", "64%"], 13, 1.6)}<div style="margin-top:14px">${skBox(168, 32)}</div>`)}</div>`;
  }
  if (app === null) return `${notice}${failedNote("the GitHub connection")}<div class="cnpy-wel-quiet">${byName}</div>`;

  if (inst) {
    if (!live) return `${notice}<div class="cnpy-wel-quiet" data-welcome-github="suspended">${byName}</div>`;
    return `${notice}<div data-welcome-github="pick">
      <p style="${P}">GitHub is connected ${appLeadPhrase(inst)}. Pick the repository your team ships from: the first one you track becomes the primary.</p>
      <div style="margin-top:16px">${repoPicker(ui.githubRepos, inst.account_login, { filter: ui.githubFilter, busy: ui.githubBusy })}</div>
    </div>`;
  }
  if (!app.configured) {
    return `${notice}${sayCard("Add your repository by name", esc(NOT_CONFIGURED_LINE), quietBtn("Open Repositories", "orgGo", { arg: "repos", extra: "color:var(--fg)" }), ' data-welcome-github="manual"')}`;
  }
  const hasGithub = !p.me || p.me.identities.some((i) => i.provider === "github");
  if (!hasGithub) {
    const google = p.me?.identities.find((i) => i.provider === "google");
    return `${notice}${sayCard("Link your GitHub account first",
      `You signed in with Google${google ? ` (${esc(google.label)})` : ""}, and no GitHub account is linked to your Trov account yet. Connecting a repository is approved on GitHub, and Trov accepts that approval only from your own linked GitHub account. Link it, and you come straight back to this step.`,
      accentBtn("Link your GitHub account", "welcomeLinkGithub", { field: "welcomeLinkGithub", extra: "height:36px" }),
      ' data-welcome-github="link"')}
      <div class="cnpy-wel-quiet">No GitHub account? Skip this step: an admin who has one can connect the repository later, in Org settings. ${byName}</div>`;
  }
  return `${notice}${sayCard("Install the Trov App on GitHub",
    "GitHub asks which account to install it on and which repositories it may read, then brings you back here to pick the one your team ships from. No token to paste, no webhook to add.",
    connectLink(org.slug, "Connect with GitHub", "welcomeGithubConnect"),
    ' data-welcome-github="connect"')}
    <div class="cnpy-wel-quiet">Already installed the Trov App on GitHub? ${existingLink(org.slug, "Link the existing installation")} &middot; ${byName}</div>`;
}

// ── step 2: your coding agent ────────────────────────────────────────────────

/** Whether THIS person's agent is connected to THIS org, as one status line: connected (and what
 *  is), waiting, still checking, or could not be checked. */
export function agentStatus(p: Pick<WelcomeProps, "grants" | "tokens">, org: Pick<MyOrg, "slug" | "name">): string {
  const st = agentStepState(p, org.slug);
  const mine = agentConnections(p, org.slug);
  const box = (state: string, tone: string, inner: string): string =>
    `<div role="status" aria-live="polite" data-welcome-agent="${state}" class="cnpy-wel-status" style="border:1px solid color-mix(in srgb,${tone} 40%,transparent);background:color-mix(in srgb,${tone} 7%,transparent);border-radius:10px">${inner}</div>`;
  if (st === "done") {
    const g = mine.grants[0];
    const what = g
      ? `${mcpStrong(esc(g.client_name))} is connected to ${mcpStrong(esc(org.name))}${mine.grants.length > 1 ? `, and ${mine.grants.length - 1} more` : ""}. Connected ${esc(relTime(g.created_at))} &middot; ${g.last_used_at ? `last used ${esc(relTime(g.last_used_at))}` : "not used yet"}.`
      : `An access token of yours reaches ${mcpStrong(esc(org.name))}${mine.tokens[0]?.last_used_at ? `, last used ${esc(relTime(mine.tokens[0].last_used_at))}` : ""}.`;
    return box("connected", "var(--green)", `${OK_RING}<div style="min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">Your agent is connected</div><div style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:1px;overflow-wrap:anywhere">${what}</div></div>`);
  }
  if (st === "todo") {
    return box("waiting", "var(--fg-40)", `<span class="cnpy-wel-pulse" aria-hidden="true" style="border-radius:50%"></span><div style="min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">Not connected yet</div><div style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:1px">This page notices by itself once you click Allow in the browser.</div></div>`);
  }
  if (p.grants.status === "error" || p.tokens.status === "error") {
    return box("unknown", "var(--amber)", `<div style="flex:1 1 220px;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--fg)">Couldn't check your connections</div><div style="font-size:12.5px;line-height:1.55;color:var(--fg-70);margin-top:1px">Trov could not read whether an agent of yours is connected. The steps below work either way.</div></div>${quietBtn("Check again", "welcomeRecheck", { field: "welcomeRecheck" })}`);
  }
  return `<div data-welcome-agent="checking" class="cnpy-wel-status" style="border:1px solid var(--border);border-radius:10px">${skeleton("wel-agent", "Checking your connections&hellip;", `${skLine(150, 13, 1.5)}${skLine(260, 12.5, 1.55)}`, "flex:1;min-width:0")}</div>`;
}

/** Connect your coding agent — the SAME three steps Settings › MCP access shows (mcp-connect.ts),
 *  under a live line saying whether this person is connected to this org. Both wizards use it. */
export function agentStep(p: WelcomeProps): string {
  const org = p.org!;
  const open = p.wel.byHand;
  return `${agentStatus(p, org)}
    <div${surface("padding:18px 20px;margin-top:14px")} data-welcome-connect>
      ${connectSteps(org.name, "this page then shows your agent as connected")}
      <div style="font-size:12px;line-height:1.55;color:var(--fg-40);margin-top:12px">${ONE_ORG_NOTE}</div>
    </div>
    <div class="cnpy-wel-quiet">
      <button type="button" data-act="welcomeByHand" data-field="welcomeByHand" aria-expanded="${open}" aria-controls="wel-byhand" class="cnpy-mutelink" style="display:inline-flex;align-items:center;gap:6px;padding:4px 0;font-size:12.5px;font-weight:500;color:var(--fg-55);text-align:left"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true" class="cnpy-xrow-c" style="transform:${open ? "rotate(90deg)" : "none"}"><path d="M9 6l6 6-6 6"></path></svg>Set it up without the plugin</button>
      <div id="wel-byhand"${open ? "" : " hidden"} style="padding-top:4px">
        <div style="font-size:12.5px;line-height:1.55;color:var(--fg-55)">Add the Trov server to Claude Code by hand &mdash; skip this if you installed the plugin, or you'll have two Trov servers.</div>
        ${copyBox(browserConnectCommand(), "copyBrowserConnect", "Copy the command")}
        <div style="font-size:12.5px;line-height:1.55;color:var(--fg-55);margin-top:8px">Then run ${mcpCode("/mcp")}, choose ${mcpStrong("trov")}, then ${mcpStrong("Authenticate")}. Any other agent that signs in through the browser connects to the same address.</div>
      </div>
    </div>`;
}

// ── step 3: the team ─────────────────────────────────────────────────────────

/** Invite your team: Members' own invite form (`inviteSection` — the same call, the same plan and
 *  rate-limit refusals, and at the seat cap the same sentence and upgrade button), and who is
 *  already waiting. */
export function teamStep(p: WelcomeProps): string {
  const org = p.org!;
  const ui = p.ui;
  if (ui.members.status === "error" && ui.members.data.length === 0) return failedNote("the members");
  // The form's gate is the plan's seats: until the plan and the people are read, no form is shown
  // that the server might refuse on arrival.
  if (ui.members.status !== "ok" || (ui.plan.status !== "ok" && ui.plan.status !== "error")) {
    return `<div${surface("padding:18px 20px")} data-welcome-team="loading">${skeleton("wel-team", "Loading your team&hellip;", `${skLine("36%", 13, 1.5)}<div style="margin-top:10px">${skBox("100%", 36)}</div>${skLine("70%", 11.5, 1.5)}`)}</div>`;
  }
  const pending = ui.invites.data.filter((i) => i.status === "pending");
  const others = ui.members.data.length - 1;
  const seats = seatsLead(ui.plan.data);
  const invitesKnown = ui.invites.status === "ok" || pending.length > 0;
  const lead = `<p class="cnpy-lead-t" data-welcome-team="lead" style="margin:0 0 16px">${seats ? `${seats} &middot; ` : ""}${others > 0 ? `<strong>${others}</strong> ${others === 1 ? "person has" : "people have"} joined you` : "Nobody has joined you yet"}${invitesKnown ? ` &middot; ${pending.length ? `<strong>${pending.length}</strong> ${pending.length === 1 ? "invitation" : "invitations"} pending` : "no invitation pending"}` : ""}.</p>`;
  const rows = pending.map((i) => {
    const who = i.github_login ? `@${i.github_login}` : i.email ?? "";
    const mail = inviteMailNote(i);
    return `<li class="cnpy-wel-row" data-welcome-invite="${i.id}">
      <span style="flex:1 1 200px;min-width:0;line-height:1.35"><span style="display:block;font-size:13.5px;font-weight:600;color:var(--fg-70);overflow-wrap:anywhere">${esc(i.name ? `${i.name} · ${who}` : who)}</span><span style="display:block;font-size:12px;color:${mail.bad ? "var(--red)" : "var(--fg-40)"}">${esc(mail.text)}</span></span>
      ${roleChip(i.role)}
    </li>`;
  }).join("");
  const waiting = pending.length ? `<div${surface("padding:6px 20px;margin-top:16px")} data-welcome-pending><ul class="cnpy-wel-list is-flush">${rows}</ul></div>` : "";
  return `${lead}${inviteSection(org, ui, p.dd ?? initialDropdownUi())}${waiting}
    <div class="cnpy-wel-quiet">${goLink("Roles, resending and revoking are in Org settings › Members", "orgGo", "members")}</div>`;
}

// ── the last step ────────────────────────────────────────────────────────────

const PLACES: readonly { act: string; title: string; what: string; icon: string }[] = [
  { act: "goFeed", title: "Feed", what: "What your team and its agents did, newest first.", icon: `<path d="M4 6h16M4 12h16M4 18h10"></path>` },
  { act: "goDocs", title: "Docs", what: "How things work and why. Agents propose changes; a person confirms them.", icon: `<path d="M6 3h9l4 4v14H6z"></path><path d="M14 3v5h5"></path>` },
  { act: "goTickets", title: "Tickets", what: "The queue: what is open, who has it, what is next.", icon: `<rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M8 10h8M8 14h5"></path>` },
  { act: "goRoadmap", title: "Roadmap", what: "The plan and its sprints, against what actually happened.", icon: `<path d="M4 7h9M4 12h14M4 17h6"></path><circle cx="17" cy="7" r="1.6"></circle>` },
];

/** Where things live — the closing step of both wizards. */
export function placesGrid(): string {
  return `<ul class="cnpy-wel-places">${PLACES.map((x) => `<li>
      <button type="button" data-act="${x.act}" data-field="${attr(`welcomePlace:${x.act}`)}"${surface("", { hover: true, cls: "cnpy-wel-place" })} aria-label="${attr(`Open ${x.title}`)}">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex:none;margin-top:1px">${x.icon}</svg>
        <span style="min-width:0"><span style="display:block;font-size:13.5px;font-weight:600;color:var(--fg)">${x.title}</span><span style="display:block;font-size:12.5px;line-height:1.5;color:var(--fg-55);margin-top:1px">${x.what}</span></span>
      </button>
    </li>`).join("")}</ul>`;
}

const RECAP: Record<Exclude<WelcomeStep, "done">, Record<StepState, string>> = {
  github: { done: "A repository is connected", todo: "No repository connected yet", unknown: "Repository: not known yet" },
  agent: { done: "Your coding agent is connected", todo: "Your coding agent is not connected yet", unknown: "Your coding agent: not known yet" },
  team: { done: "Your team is invited", todo: "Nobody invited yet", unknown: "Your team: not known yet" },
};

/** "You're set": what was done and what was skipped (each read off live data, with the way back
 *  to a skipped one), where things live, and the button into the app. */
export function doneStep(steps: readonly WelcomeStep[], states: Record<WelcomeStep, StepState>): string {
  const recap = steps.filter((s): s is Exclude<WelcomeStep, "done"> => s !== "done").map((s) => {
    const st = states[s];
    const icon = st === "done" ? OK_RING : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--fg-40)" stroke-width="2" ${st === "unknown" ? 'stroke-dasharray="3 3.4" ' : ""}aria-hidden="true" style="flex:none;margin-top:1px"><circle cx="12" cy="12" r="9"></circle></svg>`;
    return `<li class="cnpy-wel-row" data-welcome-recap="${s}" data-state="${st}">${icon}<span style="flex:1 1 200px;min-width:0;font-size:13px;color:${st === "done" ? "var(--fg)" : "var(--fg-70)"}">${RECAP[s][st]}</span>${st === "todo" ? quietBtn("Do it now", "welcomeGo", { arg: s, field: `welcomeRecap:${s}`, label: `${STEP_LABEL[s]}: do it now` }) : ""}</li>`;
  }).join("");
  return `<div${surface("padding:6px 20px")} data-welcome-recaps><ul class="cnpy-wel-list is-flush">${recap}</ul></div>
    <h2 style="font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--fg-40);margin:26px 0 9px">Where things live</h2>
    ${placesGrid()}
    <div style="${O_HELP};margin-top:14px">My Work is your own page: what is assigned to you and what is waiting on you. This setup stays in Help &rsaquo; Get Started if you want it again.</div>`;
}

// ── the page ─────────────────────────────────────────────────────────────────

interface StepCopy { title: string; lead: string }
function stepCopy(step: WelcomeStep, org: MyOrg, admin: boolean, states: Record<WelcomeStep, StepState>): StepCopy {
  switch (step) {
    case "github": return { title: "Connect your repository", lead: "Trov reads its pull requests, issues, checks and deployments, so tickets, the Repo dashboard and the feed stay current without anyone pasting links." };
    case "agent": return { title: "Connect your coding agent", lead: `This is what makes Trov useful. Your agent reads ${org.name}'s docs, tickets and roadmap before it starts, and records what it did when it finishes. It acts as you, and only in this organization.` };
    case "team": return { title: "Invite your team", lead: "Each person gets their own sign-in and connects their own agent. They join when they accept." };
    case "done": return {
      title: states.done === "done" ? "You're set" : "You're in",
      lead: states.done === "done" ? `${org.name} is ready. Here is where things live.`
        : admin ? `Here is where things live in ${org.name}. What you skipped is still here, and in Org settings, whenever you want it.`
        : `Here is where things live in ${org.name}. You can connect your agent any time, in Settings.`,
    };
  }
}

/** The guided setup, as a full page (no sidebar: there is nothing to navigate to yet). */
export function welcomeView(p: WelcomeProps): string {
  const brand = `<div style="display:flex;align-items:center;gap:9px;min-width:0">${trovMark(20, "currentColor")}<span style="font-size:15px;font-weight:600;letter-spacing:-0.01em">Trov</span></div>`;
  if (!p.org) {
    // The org in the address bar is not (yet) known to be this person's: nothing is derived for it.
    return `<div class="cnpy-orgs cnpy-org cnpy-wel" data-morph="welcome" data-screen-label="Guided setup" data-welcome="loading">${p.backdrop ?? ""}<div class="cnpy-orgs-col cnpy-wel-col"><div${surface("overflow:hidden", { cls: "cnpy-orgs-card" })}>
      <header class="cnpy-orgs-banner"><div class="cnpy-wel-top">${brand}</div></header>
      <div class="cnpy-orgs-body">${skeleton("wel-org", "Loading your organization&hellip;", `<div style="margin-top:18px">${skLine(280, 24, 1.25)}${skLines(["92%", "60%"], 14, 1.6)}</div>`)}</div>
    </div></div></div>`;
  }
  const org = p.org;
  const admin = roleAtLeast(org.role, "admin");
  const steps = welcomeStepsFor(org.role, p.ui);
  const step = effectiveWelcomeStep(p.step, steps);
  const states = welcomeStates(p);
  const at = steps.indexOf(step);
  const prev = at > 0 ? steps[at - 1] : null;
  const next = at < steps.length - 1 ? steps[at + 1] : null;
  const copy = stepCopy(step, org, admin, states);
  const body = step === "github" ? githubStep(p) : step === "agent" ? agentStep(p) : step === "team" ? teamStep(p) : doneStep(steps, states);
  // ONE accent per step: the step's own action while it is to do (Connect with GitHub, Invite — whose
  // form keeps its accent button), and the way forward once it is done.
  const forward = next === null ? accentBtn("Open Trov", "goMyWork", { field: "welcomeFinish", extra: "height:36px;padding:0 18px" })
    : states[step] === "done" && step !== "team" ? accentBtn("Continue", "welcomeGo", { arg: next, field: "welcomeNext", extra: "height:36px;padding:0 18px" })
    : quietBtn(states[step] === "done" ? "Continue" : "Skip for now", "welcomeGo", { arg: next, field: "welcomeNext", extra: "height:36px;padding:0 16px;color:var(--fg)" });
  const first = (p.me?.name ?? "").trim().split(/\s+/)[0];
  const eyebrow = step === "done" ? `Welcome to ${org.name}` : at === 0 ? `Welcome${first ? `, ${first}` : ""} · step 1 of ${steps.length}` : `Step ${at + 1} of ${steps.length}`;
  // The same card as onboarding and the org picker before it — banner, body, foot — in front of the same
  // backdrop: three steps of one flow. The card carries one view-transition name, so a step of a
  // different height grows or shrinks into the next (transition.ts).
  return `<div class="cnpy-orgs cnpy-org cnpy-wel" data-morph="welcome" data-screen-label="Guided setup" data-welcome="${admin ? "admin" : "member"}" data-welcome-step="${step}">
    ${p.backdrop ?? ""}
    <div class="cnpy-orgs-col cnpy-wel-col"><div${surface("overflow:hidden", { cls: "cnpy-orgs-card" })}>
      <header class="cnpy-orgs-banner">
        <span class="cnpy-orgs-art" aria-hidden="true">${trovMark(230, "currentColor")}</span>
        <div class="cnpy-wel-top">
          ${brand}
          <div style="display:flex;align-items:center;gap:8px;min-width:0;margin-left:auto">${orgTile(org.name, 22, org.logo_url)}<span style="font-size:13px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(org.name)}</span></div>
          ${next === null ? "" : `<button type="button" data-act="goMyWork" data-field="welcomeExit" class="cnpy-mutelink" style="flex:none;padding:0;font-size:12.5px;font-weight:500">Skip setup &rarr;</button>`}
        </div>
        <div data-welcome-eyebrow style="position:relative;margin-top:20px;font-family:var(--label);font-size:10.5px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:rgba(255,255,255,.78)">${esc(eyebrow)}</div>
        <h1 id="wel-t" tabindex="-1" style="position:relative;margin:6px 0 0;font-size:24px;font-weight:600;letter-spacing:-0.02em;line-height:1.25;overflow-wrap:anywhere;outline:none">${esc(copy.title)}</h1>
        <p class="cnpy-orgs-lede" style="position:relative;margin:8px 0 0;font-size:13.5px;line-height:1.55;max-width:520px">${esc(copy.lead)}</p>
      </header>
      <div class="cnpy-orgs-body cnpy-wel-body">
        ${welcomeStepper(steps, step, states)}
        <section class="cnpy-rise" aria-labelledby="wel-t" data-welcome-body="${step}" data-morph-key="wel:${step}">
          ${body}
        </section>
      </div>
      <footer class="cnpy-orgs-foot cnpy-wel-nav">
        ${prev ? quietBtn("Back", "welcomeGo", { arg: prev, field: "welcomeBack", extra: "height:36px;padding:0 16px" }) : "<span></span>"}
        ${forward}
      </footer>
    </div></div>
  </div>`;
}

/** The wizard's one root-level overlay: the invite form's role menu (dropdown.ts). */
export function welcomeOverlays(p: Pick<WelcomeProps, "org" | "step" | "ui" | "dd">): string {
  if (!p.org || !p.dd?.open || !roleAtLeast(p.org.role, "admin")) return "";
  return dropdownMenu([inviteRoleDropdown(p.ui)], p.dd);
}
