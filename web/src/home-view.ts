// Home's props, composed from what the app already reads plus `GET /home` (shared/home-core.ts). The markup is
// web/src/home.ts; main.ts's `loadHomeIfNeeded` starts every read this needs.
//
// The order never changes (the design's rule): head → bar → Repositories, Roadmap, For you → Activity → Latest beside
// Team. A list with nothing in it yet is its ghost; a figure the server has not counted is "—".

import type { FeedRow, PersonColor } from "@shared/rows";
import type { QuickSearchResult } from "@shared/quick-search";
import type { GithubAppStatusDTO } from "@shared/github-app";
import type { RefView } from "@shared/ai-ask-core";
import { HOME_DAYS, homeRangeDays, homeSum, type HomeData, type HomeRange } from "@shared/home-core";
import { sprintDueState } from "@shared/sprints-core";
import { TICKET_STATUS_LABEL } from "@shared/tickets-core";
import type { AppState, Loadable } from "./render";
import { triageCounts, viewerIsAdmin } from "./render";
import { handoffsForMe } from "./mywork";
import { reviewHeadsFromReads } from "./triage-map";
import { feedKind } from "./feed-kind";
import { personChip } from "./people";
import { relTime } from "./ui";
import { STATE_KIND, type StateKind } from "./marks";
import { quickGroups, type QuickRow } from "./quicksearch";
import { homeAnswerView } from "./home";
import type { HomeAttnRow, HomeCard, HomeCol, HomeFeedRow, HomeIcon, HomeMark, HomeProps, HomeRow, HomeSearchItem, HomeTeamItem } from "./home";

/** Home's own state: its two reads and the bar. */
export interface HomeUi {
  data: Loadable<HomeData | null>;
  /** The org's newest Feed entries (`GET /feed?limit=5`), Home's own read. */
  feed: Loadable<FeedRow[]>;
  /** The GitHub App's state (`GET /github`, every member may read it): suspended or uninstalled is a row. */
  github: Loadable<GithubAppStatusDTO | null>;
  range: HomeRange;
  q: string;
  mode: "search" | "ask";
  focused: boolean;
  /** The highlighted row of the dropdown. */
  active: number;
  /** The quick-search answer for `q` (null: none yet). */
  results: QuickSearchResult | null;
  attnOpen: boolean;
  /** Which headline of the pool; moves on every entry to Home. */
  headIdx: number;
  /** The question asked from the bar and its answer, streaming under it (null: none). */
  answer: HomeAnswer | null;
}
/** An Ask Trov answer under the bar (`POST /ask` on a new thread; Ask's own SSE contract). */
export interface HomeAnswer {
  q: string;
  /** The answer's text so far (Ask's markdown, `[[type:key]]` refs in it). */
  text: string;
  phase: "thinking" | "streaming" | "done" | "error";
  error: string | null;
  threadId: number | null;
  messageId: number | null;
  cites: RefView[];
  /** Wrong?: closed, its three reasons open, or sent. */
  wrong: "closed" | "open" | "sent";
}
export function initialHomeUi(): HomeUi {
  return { data: { status: "idle", data: null }, feed: { status: "idle", data: [] }, github: { status: "idle", data: null }, range: "7", q: "", mode: "search", focused: false, active: 0, results: null, attnOpen: false, headIdx: 0, answer: null };
}

const mk = (k: StateKind): HomeMark => ({ shape: STATE_KIND[k].shape, tone: STATE_KIND[k].tone });
const REVIEW_MARK: HomeMark = { shape: "ring", tone: "var(--accent)" };
const PENDING_MARK: HomeMark = { shape: "ring", tone: "var(--blue)" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (ymd: string): string => { const [, m, d] = ymd.split("-").map(Number); return `${MONTHS[m - 1]} ${d}`; };
/** "12m", "3h", "2d" — the design's terse ages. */
const age = (iso: string | null): string => relTime(iso).replace(/ ago$/, "");
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const daysSince = (iso: string): number => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));

/** The rows that wait on someone, most urgent first: failing, then what waits on the viewer, then the rest. */
function attentionRows(s: AppState): { rows: (HomeAttnRow & { urg: number })[]; failing: string | null } {
  const rows: (HomeAttnRow & { urg: number })[] = [];
  let failing: string | null = null;
  const facts = s.repo.data?.facts ?? null;
  if (facts) {
    for (const a of facts.attention) {
      if (a.kind !== "failed" && a.kind !== "down") continue;
      const where = [a.app, a.env].filter(Boolean).join(" in ");
      const title = a.kind === "down" ? `${where || "An app"} is down` : `Deploy of ${where || "an app"} failed`;
      failing ??= title;
      rows.push({ mark: mk("bad"), title, meta: a.refs.since ? `Since ${relTime(a.refs.since)}` : facts.repo, action: { label: "Open Repo", act: "goRepo" }, urg: 0 });
    }
    const head = facts.ci.find((c) => c.state === "fail");
    if (head) {
      const title = `${head.env} is red`;
      failing ??= title;
      rows.push({ mark: mk("bad"), title, meta: `${head.failing ? plural(head.failing, "check") + " failing" : "Checks failing"}${head.sha ? ` on ${head.sha.slice(0, 7)}` : ""}`, action: { label: "Open Repo", act: "goRepo", arg: "ci" }, urg: 0 });
    }
  }
  // Connections: an admin can fix them (first, with Fix); a member sees a calm row with nothing to press.
  const admin = viewerIsAdmin(s);
  const conn = (title: string, meta: string, fixTab: string, calmTitle: string, calmMeta: string): void => {
    if (admin) rows.push({ mark: mk("bad"), title, meta, action: { label: "Fix", act: "orgGo", arg: fixTab }, urg: 0 });
    else rows.push({ mark: mk("waiting"), title: calmTitle, meta: calmMeta, action: null, urg: 9 });
  };
  const gh = s.home.github.data;
  if (gh?.installation?.suspended_at) {
    conn("GitHub is suspended", `The Trov App was suspended on GitHub ${relTime(gh.installation.suspended_at)}. Repo updates stopped.`, "integrations",
      "Repo updates are paused", "An admin is fixing the GitHub connection. Nothing is lost.");
  } else if (gh && !gh.installation && gh.lost) {
    conn("The Trov App was uninstalled on GitHub", `Repo updates stopped ${relTime(gh.lost.at)}.`, "integrations",
      "Repo updates are paused", "An admin is reconnecting GitHub.");
  }
  for (const r of s.home.data.data?.repos ?? []) {
    if (r.accessLost) conn(`Access to ${r.repo} was removed`, "Its updates stopped.", "repos", `Updates from ${r.repo} are paused`, "An admin is restoring access.");
  }
  // A host whose token stopped working (the Repo dashboard's parts carry each connection's status).
  const broken = new Map<string, string>();
  for (const p of facts?.parts ?? []) if (p.connection === "error" || p.connection === "revoked") broken.set(p.provider, p.host);
  for (const host of broken.values()) {
    conn(`${host} connection stopped working`, "Deploys and health from it are unknown until it is reconnected.", "hosting", `${host} readings are paused`, `An admin is reconnecting ${host}.`);
  }
  // Review's queue and Unplaced (its other view): one row, both counted.
  const tc = triageCounts(s);
  const review = tc.review + tc.maintenance;
  if (review > 0) {
    const parts = [tc.review ? `${tc.review} to review` : "", tc.maintenance ? `${tc.maintenance} unplaced` : ""].filter(Boolean).join(" · ");
    rows.push({ mark: REVIEW_MARK, title: `${review} waiting in Review`, meta: parts, action: { label: "Open Review", act: tc.review ? "goReview" : "goMaintenance" }, urg: 2 });
  }
  const me = s.me?.handle ?? "";
  for (const h of handoffsForMe(s.handoffs.data, me).slice(0, 2)) {
    const d = daysSince(h.created_at);
    rows.push({ mark: PENDING_MARK, title: `Handoff from @${h.sender} waiting ${d === 0 ? "since today" : plural(d, "day")}`, meta: (h.body.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").slice(0, 90), action: { label: "Open", act: "openHandoff", arg: String(h.id) }, urg: 2 });
  }
  for (const sp of s.sprints.data) {
    if (sp.status === "done" || !sp.due) continue;
    const st = sprintDueState(sp.due, Date.now());
    if (!st?.overdue) continue;
    rows.push({ mark: mk("warn"), title: `Sprint ${sp.label} is ${plural(st.daysLate, "day")} overdue`, meta: `${sp.progress.closed} of ${sp.progress.total} done · was due ${shortDate(sp.due.slice(0, 10))}`, action: { label: "Open sprint", act: "openSprint", arg: String(sp.id) }, urg: 3 });
  }
  const triage = s.home.data.data?.triage;
  if (triage && triage.count > 0) {
    rows.push({ mark: mk("waiting"), title: `${plural(triage.count, "ticket")} in Triage with no assignee`, meta: triage.oldest ? `The oldest was filed ${relTime(triage.oldest)}` : "Nobody has picked them up", action: { label: "Triage", act: "goTickets" }, urg: 4 });
  }
  rows.sort((a, b) => a.urg - b.urg);
  return { rows, failing };
}

/** The headline: a greeting or a question, picked per entry; the page on fire asks what to fix. */
function headline(s: AppState, fire: boolean, clear: boolean, empty: boolean): string {
  const hr = new Date().getHours();
  const name = (s.me?.name ?? "").trim().split(/\s+/)[0] || (s.me ? `@${s.me.handle}` : "");
  const greet = `${hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening"}${name ? `, ${name}` : ""}.`;
  const pool = empty ? ["Let's get set up.", "Where should we start?", "What are we building first?"]
    : fire ? ["What needs fixing first?", "What broke, and who's on it?"]
    : clear ? [greet, "All quiet. What's next?", "Nothing's on fire. What are we shipping?", "Where did we leave off?"]
    : [greet, "What's on the agenda?", "Where did we leave off?", "What are we shipping today?", "What's the team up to?", "What needs a decision?"];
  return pool[s.home.headIdx % pool.length];
}

function repositoriesCol(s: AppState, admin: boolean): HomeCol {
  const me = s.orgMe.data;
  const homeRepos = s.home.data.data?.repos ?? null;
  const names = homeRepos?.map((r) => r.repo) ?? me?.repos.all ?? [];
  const known = s.orgMe.status === "ok" || homeRepos !== null;
  const facts = s.repo.data?.facts ?? null;
  const failingApps = new Set((facts?.attention ?? []).filter((a) => a.kind === "failed" || a.kind === "down").map((a) => a.app));
  const rows: HomeRow[] = [];
  for (const name of names) {
    const r = homeRepos?.find((x) => x.repo === name) ?? null;
    rows.push({ icon: "repo", title: name, act: "goRepoFor", arg: name,
      // "No pushes yet" only where pushes are captured (the primary); another repository's silence is not known.
      trail: r?.accessLost ? "Access removed" : r?.lastPush ? `${age(r.lastPush)} ago` : r?.primary ? "No pushes yet" : "",
      mark: r?.accessLost ? mk("warn") : null });
    if (facts && facts.repo === name) {
      for (const app of facts.allApps) {
        // Its part in the last environment of the promotion order (production), else any.
        const prodEnv = [...facts.envs].sort((a, b) => b.position - a.position)[0]?.key;
        const part = facts.parts.find((p) => p.app === app.key && p.env === prodEnv) ?? facts.parts.find((p) => p.app === app.key) ?? null;
        const fail = failingApps.has(app.key);
        rows.push({ icon: "app", title: app.label, post: part?.host ?? "", act: "goRepoApp", arg: `${name}\n${app.key}`,
          trail: fail ? "Failing" : part && part.connection !== "connected" && !part.viaGithub && part.reportsDeploys ? "Not connected" : "",
          trailTone: fail ? "var(--red)" : undefined, mark: fail ? mk("bad") : null });
      }
    }
  }
  return {
    title: "Repositories", count: names.length || null, act: "goRepo", rows: known ? rows.slice(0, 4) : null,
    ghost: known && names.length === 0
      ? { text: admin ? "No repository yet. Connect one and its deploys and checks show here." : "No repository yet. An admin connects one.", action: admin ? { label: "Connect a repository", act: "orgGo", arg: "repos" } : null }
      : null,
  };
}

function roadmapCol(s: AppState, admin: boolean): HomeCol {
  const known = s.sprints.status === "ok" || s.sprints.data.length > 0;
  const open = s.sprints.data.filter((sp) => sp.status !== "done")
    .sort((a, b) => (a.active === b.active ? (a.due ?? "9999").localeCompare(b.due ?? "9999") : a.active ? -1 : 1));
  const rows: HomeRow[] = open.slice(0, 3).map((sp) => {
    const st = sp.due ? sprintDueState(sp.due, Date.now()) : null;
    const due = sp.due ? shortDate(sp.due.slice(0, 10)) : "";
    return { icon: "sprint", title: sp.label, post: sp.progress.total ? `${sp.progress.closed} of ${sp.progress.total}` : "No tickets", act: "openSprint", arg: String(sp.id),
      trail: st?.overdue ? `${plural(st.daysLate, "day")} overdue` : due ? `Due ${due}` : "",
      trailTone: st?.overdue ? "var(--amber)" : st?.soon ? "var(--fg-70)" : undefined, mark: st?.overdue ? mk("warn") : null };
  });
  const backlog = s.home.data.data?.backlog;
  if (backlog !== undefined && rows.length < 4) rows.push({ icon: "ticket", title: "Backlog", post: plural(backlog, "ticket"), act: "goTickets" });
  return {
    title: "Roadmap", count: open.length || null, act: "goRoadmap", rows: known ? rows : null,
    ghost: known && open.length === 0 && backlog === undefined
      ? { text: "No sprints yet. A sprint has dates and tickets; its progress shows here.", action: admin ? { label: "New sprint", act: "goRoadmap" } : null }
      : null,
  };
}

function forYouCol(s: AppState): HomeCol {
  const d = s.mywork.data;
  const known = !!d;
  const sprintDue = new Map(s.sprints.data.map((sp) => [sp.id, sp.due]));
  const tickets: HomeRow[] = (d?.tickets ?? []).slice(0, 3).map((t) => {
    const due = t.sprint ? sprintDue.get(t.sprint.id) : null;
    const st = due ? sprintDueState(due, Date.now()) : null;
    return { icon: "ticket", title: t.title, post: TICKET_STATUS_LABEL[t.status], act: "openTicket", arg: String(t.id),
      trail: st ? (st.overdue ? "Overdue" : `Due ${shortDate(due!.slice(0, 10))}`) : "",
      trailTone: st?.overdue ? "var(--red)" : st?.soon ? "var(--amber)" : undefined };
  });
  const reviews = reviewHeadsFromReads(s.proposals.data, s.draftAdrs.data);
  const review: HomeRow[] = reviews.slice(0, 1).map((r) => ({ icon: "review", title: r.title, post: r.kind === "decision" ? "Decision" : "Proposal", trail: age(r.time), mark: REVIEW_MARK, act: "openReviewItem", arg: r.id }));
  const total = Math.max(d?.ticketsTotal ?? 0, tickets.length) + reviews.length;
  const rows = review.concat(tickets).slice(0, 4);
  return {
    title: "For you", count: total || null, act: "mwAllTickets", rows: known ? rows : null,
    ghost: known && rows.length === 0 ? { text: "Nothing assigned to you yet. Your open tickets and the reviews waiting on you show here.", action: { label: "New ticket", act: "newTicket" } } : null,
  };
}

/** Activity's four cards for the range: each the sum over the range, its delta against the range before, and one bar
 *  per day (per week on 90 days). Null figures (not counted) draw "—". */
function activityCards(data: HomeData | null, range: HomeRange): HomeCard[] | null {
  if (!data) return null;
  const n = homeRangeDays(range);
  const days = data.days;
  const defs: [HomeCard["label"], "tickets" | "handoffs" | "docs" | "sessions", string, string | undefined][] = [
    ["Tickets done", "tickets", "goTickets", undefined], ["Handoffs claimed", "handoffs", "goRelay", undefined],
    ["Docs promoted", "docs", "goLibrary", undefined], ["Sessions recorded", "sessions", "goFeed", undefined],
  ];
  const weekly = n === 90;
  return defs.map(([label, key, act, arg]) => {
    const cur = homeSum(days, key, n);
    const prev = days.length >= HOME_DAYS ? homeSum(days, key, n, n) : null;
    const delta = cur === null || prev === null ? null
      : cur > prev ? { text: `+${cur - prev} vs previous ${n} days`, tone: "var(--green)" }
      : cur < prev ? { text: `−${prev - cur} vs previous ${n} days`, tone: "var(--amber)" }
      : { text: `Same as previous ${n} days`, tone: "var(--fg-55)" };
    const window = days.slice(days.length - n);
    const buckets: { v: number | null; tip: string }[] = [];
    if (weekly) {
      for (let i = 0; i < window.length; i += 7) {
        const wk = window.slice(i, i + 7);
        const v = wk.some((x) => x[key] === null) ? null : wk.reduce((a, x) => a + (x[key] ?? 0), 0);
        buckets.push({ v, tip: `Week of ${shortDate(wk[0].date)}` });
      }
    } else for (const x of window) buckets.push({ v: x[key], tip: shortDate(x.date) });
    const mx = Math.max(1, ...buckets.map((b) => b.v ?? 0));
    return {
      label, n: cur, delta, act, arg,
      bars: cur === null ? null : buckets.map((b) => ({ h: (b.v ?? 0) / mx, tip: `${b.tip} · ${b.v === null ? "—" : b.v}` })),
    };
  });
}

const avatarOf = (s: AppState, handle: string, size: number): string => {
  const p = s.persons.data.find((x) => x.handle.toLowerCase() === handle.toLowerCase());
  return personChip(p ? { handle: p.handle, name: p.name, color: p.color, avatar_url: p.avatar_url } : null, size, handle);
};
const colorOf = (s: AppState, handle: string): string => {
  const c: PersonColor | undefined = s.persons.data.find((x) => x.handle.toLowerCase() === handle.toLowerCase())?.color;
  return c ? `var(--p-${c})` : "var(--fg)";
};

function latestRows(s: AppState): HomeFeedRow[] | null {
  const f = s.home.feed;
  if (f.status !== "ok" && f.data.length === 0) return f.status === "error" ? [] : null;
  return f.data.slice(0, 5).map((e) => {
    const { kind, rest } = feedKind(e.summary);
    const trov = e.ai?.origin === "ai";
    const imp = e.importance === "breaking" ? mk("warn") : e.importance === "notable" ? ({ shape: "dot", tone: "var(--accent)" } as HomeMark) : null;
    return { trov, avatar: trov ? "" : avatarOf(s, e.author, 16), kind: kind ?? "", text: (kind ? rest : e.summary).replace(/\*\*|`/g, ""), mark: imp, at: age(e.created_at), act: "goFeed" };
  });
}

function teamRows(s: AppState): HomeTeamItem[] | null {
  const me = (s.me?.handle ?? "").toLowerCase();
  const team = s.home.data.data?.team ?? null;
  if (!team && s.persons.status !== "ok" && s.persons.data.length === 0) return null;
  const base = team ?? s.persons.data.map((p) => ({ handle: p.handle, on: null, at: null, invited: false }));
  const live = (iso: string | null): boolean => !!iso && Date.now() - Date.parse(iso) < 15 * 60_000;
  return [...base]
    .sort((a, b) => (a.handle.toLowerCase() === me ? -1 : b.handle.toLowerCase() === me ? 1 : (b.at ?? "").localeCompare(a.at ?? "")))
    .slice(0, 5)
    .map((t) => ({ avatar: avatarOf(s, t.handle, 18), handle: t.handle, color: colorOf(s, t.handle), you: t.handle.toLowerCase() === me,
      on: t.invited ? "" : t.on ?? "", at: t.invited ? "Invited" : t.at ? age(t.at) : "", live: live(t.at), act: "openPerson", arg: t.handle }));
}

const ICON_OF: Record<string, HomeIcon> = { screen: "recent", ticket: "ticket", doc: "doc", decision: "decision", sprint: "sprint", artifact: "artifact", prompt: "prompt", handoff: "handoff", person: "person", feed: "feed", all: "recent" };
const GROUP_LABEL: Record<string, string> = { screen: "Jump to", ticket: "Tickets", doc: "Docs", decision: "Decisions", sprint: "Roadmap", artifact: "Artifacts", prompt: "Prompts", handoff: "Handoffs", person: "People", feed: "Feed" };

/** The dropdown's rows in keyboard order (main.ts runs `pick` for the one chosen). */
export function homeDropRows(s: AppState): { label: string; rows: QuickRow[] }[] {
  const h = s.home;
  if (h.mode === "ask") {
    const q = h.q.trim();
    if (q) return [{ label: "Ask Trov", rows: [{ group: "all", title: q, context: "From your organization's pushes, tickets and docs", meta: "", pick: { kind: "go", steps: [["homeSubmit", null]] } }] }];
    const tries = ["What shipped this week?", "What is the team working on?", "Which handoffs are waiting?"];
    return [{ label: "Try asking", rows: tries.map((t) => ({ group: "all", title: t, context: "", meta: "", pick: { kind: "go", steps: [["homeAsk", t]] } })) }];
  }
  if (!h.q.trim()) {
    const jump = (title: string, context: string, act: string): QuickRow => ({ group: "screen", title, context, meta: "", pick: { kind: "go", steps: [[act, null]] } });
    return [{ label: "Jump to", rows: [
      jump("New ticket", "File it to the queue, or into a sprint", "newTicket"),
      jump("New doc", "A page in one of the Library's spaces", "newDoc"),
      jump("New handoff", "A note for whoever picks this up next", "newHandoff"),
      jump("Open Review", `${triageCounts(s).review} waiting`, "goReview"),
    ] }];
  }
  const groups = quickGroups(h.q, h.results).map((g) => ({ label: GROUP_LABEL[g.id] ?? g.id, rows: g.rows.slice(0, 3) }));
  return groups;
}

export function homeProps(s: AppState, mac: boolean, answer: string): HomeProps {
  const admin = viewerIsAdmin(s);
  const { rows, failing } = attentionRows(s);
  const actionable = rows.filter((r) => r.action).length;
  const empty = s.orgMe.status === "ok" && !(s.orgMe.data?.repos.all.length) && s.sprints.status === "ok" && s.sprints.data.length === 0 && s.mywork.status === "ok" && !(s.mywork.data?.tickets.length);
  // The status line claims only what has landed: the review counts (badges at boot) and the handoffs read.
  const known = s.badges.proposals !== undefined || s.proposals.status === "ok";
  const status = !known ? null
    : failing ? { mark: mk("bad"), text: `${failing} · ${actionable} need${actionable === 1 ? "s" : ""} you` }
    : actionable > 0 ? { mark: rows[0].mark, text: `${plural(actionable, "thing")} need${actionable === 1 ? "s" : ""} you` }
    // A member's calm rows only (repo updates paused): the first one says what, with no count to act on.
    : rows.length > 0 ? { mark: rows[0].mark, text: rows[0].title }
    : empty ? { mark: mk("waiting"), text: s.orgMe.data?.repos.primary ? "Waiting for the first push" : "No repository connected yet" }
    : { mark: mk("done"), text: "All clear · nothing needs you" };
  const shown = rows.slice(0, 5);
  // A failing row never falls behind "N more".
  for (const r of rows.slice(5)) if (r.urg === 0) shown.push(r);

  const dropGroups = s.home.focused ? homeDropRows(s) : null;
  let i = 0;
  const groups = dropGroups?.filter((g) => g.rows.length).map((g) => ({
    label: g.label,
    items: g.rows.map((r): HomeSearchItem => {
      const at = i++;
      return { icon: ICON_OF[r.group] ?? "recent", title: r.title, meta: r.context || r.meta, active: at === s.home.active, q: s.home.q.trim(), act: "homePick", arg: String(at) };
    }),
  })) ?? null;
  const none = !!s.home.q.trim() && s.home.mode === "search" && s.home.results !== null && (groups?.length ?? 0) === 0;

  const range = s.home.range;
  const nBars = range === "90" ? 13 : homeRangeDays(range);
  const data = s.home.data;
  const cards = data.status === "error" && !data.data ? "failed" as const : activityCards(data.data, range);
  const lastDay = data.data?.days.at(-1)?.date;
  const from = lastDay ? shortDate(data.data!.days[data.data!.days.length - homeRangeDays(range)].date) : "";

  const feedToday = s.home.feed.data.filter((e) => new Date(e.created_at).toDateString() === new Date().toDateString()).length;
  const team = teamRows(s);
  return {
    head: { headline: headline(s, !!failing, rows.length === 0, empty), status, attn: { open: s.home.attnOpen, rows: shown, more: rows.length - shown.length, countText: actionable ? `${actionable} need${actionable === 1 ? "s" : ""} you` : "" } },
    search: { q: s.home.q, mode: s.home.mode, askAvail: askAvailable(s), focused: s.home.focused, groups, none, mac },
    answer: s.home.answer ? homeAnswerView(s.home.answer) : answer,
    cols: [repositoriesCol(s, admin), roadmapCol(s, admin), forYouCol(s)],
    activity: { range, cards, from, nBars },
    latest: { rows: latestRows(s), sub: s.home.feed.status === "ok" && feedToday ? `${feedToday} today` : "" },
    team: { rows: team, count: s.home.data.data?.team.length ?? (s.persons.data.length || null), invite: admin && (team?.length ?? 0) === 1 },
  };
}

/** Ask Trov is usable here: its state read (Relay's slim copy, `loadRelayAsk`) says it is on, with a key, not capped. */
export function askAvailable(s: AppState): boolean {
  const st = s.relayAsk.data;
  return !!st && st.enabled && st.eligibility === "ok";
}

