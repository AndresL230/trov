// THE BRIEF (Feature C, #163; docs/architecture/ai.md › The brief; the decided build's Phase D, "The brief"): My Work's
// "Your brief" for one person, written by the AI pass on the scope `person:<handle>` — ONE Haiku call per person,
// led by the cached org prefix, its answer structured and cited.
//
//   • NOW       — their open pull requests (and what is failing on them) and their latest `Status:` note.
//   • RECENTLY  — the last 7 days of their session notes and merged-PR CARDS (the summaries; never a raw PR body).
//   • NEXT      — ONLY items the server OFFERS (assigned open tickets, handoffs left for them, failing runs on their
//                 open PRs, sprint tickets due soon), ORDERED BY THE SERVER by plain rules — overdue, then blocked,
//                 then someone waiting, then due soon, then the rest. The model adds one line, the "why", per item;
//                 an item it returns that was not offered is dropped, a missing or bad "why" is the server's own
//                 plain sentence, and every title is the item's own.
//
// NEVER GUESS: a cite that is not in the input is dropped and a line with no valid cite is not written; a line or a
// "why" with a number the input does not have, or over its length, is dropped (never cut); a `refusal` or an answer
// cut at `max_tokens` writes nothing (the client returns no answer). ONLY FOR PEOPLE who opened My Work in the last 14
// days or who receive the digest (src/data/person-brief.ts `briefWanted`). An unchanged input calls nothing.
//
// The stored brief (`person_brief`, 0063) is what My Work, MCP `get_my_work` and — from Phase E — the e-mail read
// (src/tools/mywork.ts `storedBrief`): none of them calls a model, and none imports this file. The pure half — the
// input's shape, the order, the prompt, the answer's checks — is ./brief-core.ts.
import { AI_LIST_MAX, type AiBrief, type AiCite } from "@shared/ai";
import { sprintDueState } from "@shared/sprints-core";
import { all, nowIso, ph, type TenantContext } from "../data/sql";
import { briefAudience, briefWanted, latestBrief, storeBrief } from "../data/person-brief";
import { memberGithubLogins, memberPerson } from "../auth/persons";
import { primaryRepo } from "../integrations/settings";
import { listAssignedTickets } from "../tools/mywork";
import type { DirtyScope } from "../data/ai-dirty";
import type { ClaudeJob, JobItem } from "./jobs";
import { keep } from "./sections";
import {
  BRIEF_JOB, BRIEF_PROMPT_VERSION, BRIEF_RECENT_DAYS, BRIEF_SYSTEM, BriefAnswerSchema, briefFromAnswer, briefIsEmpty, briefPromptInput, orderNext,
  type BriefAnswer, type BriefCard, type BriefInput, type BriefNote, type BriefPr, type NextOffer, type NextRule,
} from "./brief-core";

export * from "./brief-core";

const DAY_MS = 24 * 60 * 60 * 1000;
/** How far back an open PR's last event may be and still count as open work. */
const OPEN_PR_DAYS = 60;
/** Caps on what one prompt carries (a brief is a few thousand tokens at most). */
const MAX_OPEN_PRS = 8;
const MAX_NOTES = 10;
const MAX_CARDS = 10;
const MAX_TICKETS = 30;
const MAX_HANDOFFS = 10;

const clip = (s: string | null | undefined, max: number): string => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const firstLine = (s: string): string => (s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").replace(/^#+\s*/, "");
const day = (iso: string | null | undefined): string => (iso ?? "").slice(0, 10);

const prCite = (n: number, url: string | null): AiCite => ({ ref: `pr:${n}`, label: `#${n}`, href: url });
const runCite = (id: number, url: string | null): AiCite => ({ ref: `run:${id}`, label: `CI run ${id}`, href: url });
const ticketCite = (n: number): AiCite => ({ ref: `ticket:${n}`, label: `#${n}`, href: `#tickets/${n}` });
const handoffCite = (n: number): AiCite => ({ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` });
const feedCite = (id: number, summary: string): AiCite => ({ ref: `feed:${id}`, label: clip(summary, 48) || `feed entry ${id}`, href: "#feed" });

const FAILED_RUN = ["failure", "timed_out"];
const RED_CHECK = ["failure", "timed_out", "action_required"];
/** The line the handoff writer puts in the feed for every handoff (src/tools/handoffs.ts) — not a session note. */
const HANDOFF_LINE = /^\S+ left a handoff for \S+: #\d+ /;
const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
const STATUS_RANK: Record<string, number> = { in_progress: 0, testing: 1, submitted: 2 };
const STATUS_WORD: Record<string, string> = { in_progress: "in progress", testing: "in testing", submitted: "not started" };

/**
 * The person's brief input, from D1 only (no model, no network). Null = not a member of this org. ONE org: every
 * read goes through `ctx`. GitHub activity is the org's PRIMARY repository's (what the router marks), so a PR's ref
 * is `pr:<n>` unambiguously.
 */
export async function buildBriefInput(ctx: TenantContext, handle: string, now: Date = new Date()): Promise<BriefInput | null> {
  const me = await memberPerson(ctx, handle);
  if (!me) return null;
  const [repo, logins] = await Promise.all([primaryRepo(ctx), memberGithubLogins(ctx, me.handle)]);
  const cites: Record<string, AiCite> = {};
  const cite = (c: AiCite): AiCite => (cites[c.ref] = c);
  const nowIsoStr = now.toISOString();
  const recentSince = new Date(now.getTime() - BRIEF_RECENT_DAYS * DAY_MS).toISOString();

  // ── open PRs, what fails on them ──
  const prs: BriefPr[] = [];
  const failingOffers: NextOffer[] = [];
  if (repo && logins.length) {
    const open = await all<{ number: number; title: string | null; url: string | null; ref: string | null; sha: string | null; state: string; occurred_at: string }>(ctx,
      `SELECT number, title, url, ref, sha, state, occurred_at FROM (
         SELECT number, title, url, ref, sha, state, actor_login, occurred_at,
                ROW_NUMBER() OVER (PARTITION BY number ORDER BY occurred_at DESC, id DESC) AS rn
           FROM repo_events WHERE org_id = ? AND repo = ? AND kind = 'pr' AND number IS NOT NULL AND occurred_at > ?)
        WHERE rn = 1 AND state IN ('draft', 'review') AND actor_login IN (${ph(logins.length)})
        ORDER BY occurred_at DESC LIMIT ${MAX_OPEN_PRS}`,
      ctx.orgId, repo, new Date(now.getTime() - OPEN_PR_DAYS * DAY_MS).toISOString(), ...logins);
    const branches = [...new Set(open.map((p) => p.ref).filter((b): b is string => !!b))];
    const shas = [...new Set(open.map((p) => p.sha).filter((s): s is string => !!s))];
    const runs = branches.length
      ? await all<{ number: number; name: string | null; title: string | null; url: string | null; ref: string; occurred_at: string }>(ctx,
        `SELECT number, name, title, url, ref, state, occurred_at FROM (
           SELECT number, name, title, url, ref, state, occurred_at,
                  ROW_NUMBER() OVER (PARTITION BY ref, COALESCE(name, '') ORDER BY occurred_at DESC, id DESC) AS rn
             FROM repo_events WHERE org_id = ? AND repo = ? AND kind = 'run' AND number IS NOT NULL AND ref IN (${ph(branches.length)}))
          WHERE rn = 1 AND state IN (${ph(FAILED_RUN.length)}) ORDER BY occurred_at DESC`,
        ctx.orgId, repo, ...branches, ...FAILED_RUN)
      : [];
    const checks = shas.length
      ? await all<{ name: string; sha: string }>(ctx,
        `SELECT name, sha FROM (
           SELECT name, sha, state, ROW_NUMBER() OVER (PARTITION BY sha, name ORDER BY occurred_at DESC, id DESC) AS rn
             FROM repo_events WHERE org_id = ? AND repo = ? AND kind = 'check' AND name IS NOT NULL AND sha IN (${ph(shas.length)}))
          WHERE rn = 1 AND state IN (${ph(RED_CHECK.length)}) ORDER BY name`,
        ctx.orgId, repo, ...shas, ...RED_CHECK)
      : [];
    for (const p of open) {
      const pc = cite(prCite(p.number, p.url));
      const title = clip(p.title, 200) || `#${p.number}`;
      const failing = runs.filter((r) => r.ref === p.ref);
      prs.push({
        ref: pc.ref, title, branch: p.ref, draft: p.state === "draft",
        failing: failing.map((r) => ({ ref: cite(runCite(r.number, r.url)).ref, name: clip(r.title ?? r.name, 120) || "CI" })),
        redChecks: checks.filter((c) => c.sha === p.sha).map((c) => clip(c.name, 80)),
      });
      for (const r of failing) {
        const name = clip(r.title ?? r.name, 200) || `CI run ${r.number}`;
        failingOffers.push({
          ref: `run:${r.number}`, kind: "failing", rule: "blocked", title: name,
          facts: `its last run failed on ${day(r.occurred_at)}, on your pull request #${p.number} "${title}"`,
          fallback: `It is failing on your pull request #${p.number}.`,
          cites: [runCite(r.number, r.url), pc], order: [-Date.parse(r.occurred_at) || 0, 0, String(r.number)],
        });
      }
    }
  }

  // ── session notes: the latest Status, and the last 7 days ──
  // SEAM: Phase D's session digests (0061) are written by `trov` FOR a person (`feed.subject`); once that column
  // exists, `author = handle OR (author = 'trov' AND subject = handle)`. Until then a person's notes are their own.
  const notesRows = await all<{ id: number; summary: string; brief: string | null; created_at: string }>(ctx,
    `SELECT id, summary, brief, created_at FROM feed WHERE org_id = ? AND author = ? COLLATE NOCASE AND created_at > ?
      ORDER BY created_at DESC, id DESC LIMIT ${MAX_NOTES * 2}`, ctx.orgId, me.handle, recentSince);
  const notesAll = notesRows.filter((n) => !HANDOFF_LINE.test(n.summary));
  const statusRow = notesAll.find((n) => /^status:/i.test(n.summary.trim())) ?? null;
  const note = (n: { id: number; summary: string; brief: string | null; created_at: string }): BriefNote =>
    ({ ref: cite(feedCite(n.id, n.summary)).ref, at: day(n.created_at), summary: clip(n.summary, 200), brief: n.brief ? clip(n.brief, 280) : null });
  const status = statusRow ? note(statusRow) : null;
  const notes = notesAll.filter((n) => n !== statusRow).slice(0, MAX_NOTES).map(note);

  // ── merged-PR cards of the last 7 days (the summary; the PR's own title and link — never its body) ──
  const cards: BriefCard[] = [];
  if (repo && logins.length) {
    const rows = await all<{ number: number; raw: string; at: string; s_title: string | null; what: string | null; impact: string | null }>(ctx,
      `SELECT e.ref_number AS number, e.raw, COALESCE(e.occurred_at, e.recorded_at) AS at, s.title AS s_title, s.what, s.impact
         FROM events e LEFT JOIN pr_summaries s ON s.org_id = ? AND s.repo = e.repo AND s.semantic_key = e.semantic_key
        WHERE e.org_id = ? AND e.repo = ? AND e.event_type = 'pr_merged' AND e.subject_login IN (${ph(logins.length)})
          AND COALESCE(e.occurred_at, e.recorded_at) > ?
        ORDER BY at DESC, e.id DESC LIMIT ${MAX_CARDS}`,
      ctx.orgId, ctx.orgId, repo, ...logins, recentSince);
    for (const r of rows) {
      let title = "";
      let url: string | null = null;
      try {
        const pr = (JSON.parse(r.raw) as { pr?: { title?: unknown; html_url?: unknown } }).pr;
        title = typeof pr?.title === "string" ? pr.title : "";
        url = typeof pr?.html_url === "string" ? pr.html_url : null;
      } catch { /* a malformed raw: the summary's title stands in */ }
      const c = cite(prCite(r.number, url));
      cards.push({ ref: c.ref, at: day(r.at), title: clip(r.s_title ?? title, 200) || `#${r.number}`, what: r.what ? clip(r.what, 300) : null, impact: r.impact ? clip(r.impact, 200) : null });
    }
  }

  // ── what is offered for Next ──
  const offers: NextOffer[] = [...failingOffers];
  const tickets = await listAssignedTickets(ctx, me.handle, { sources: "all", limit: MAX_TICKETS });
  const sprintIds = [...new Set(tickets.map((t) => t.sprint?.id).filter((x): x is number => typeof x === "number"))];
  const sprints = sprintIds.length
    ? await all<{ id: number; title: string; target_date: string | null; status: string }>(ctx,
      `SELECT id, title, target_date, status FROM sprints WHERE org_id = ? AND id IN (${ph(sprintIds.length)})`, ctx.orgId, ...sprintIds)
    : [];
  for (const t of tickets) {
    const s = t.sprint ? sprints.find((x) => x.id === t.sprint!.id) : undefined;
    const due = s && s.status !== "done" ? sprintDueState(s.target_date, now) : null;
    const rule: NextRule = due?.overdue ? "overdue" : due?.soon ? "due soon" : "assigned";
    const facts = [
      s ? `in sprint "${clip(s.title, 80)}"${s.target_date ? `, due ${s.target_date}` : ""}${due?.overdue ? " (passed)" : ""}` : "in no sprint",
      STATUS_WORD[t.status] ?? t.status,
      `priority ${t.priority}`,
      t.requester.toLowerCase() !== me.handle.toLowerCase() ? `requested by ${t.requester}` : "filed by you",
    ].join("; ");
    const fallback = due?.overdue ? `Its sprint, ${clip(s!.title, 60)}, was due ${s!.target_date}.`
      : due?.soon ? `Its sprint, ${clip(s!.title, 60)}, is due ${s!.target_date}.`
        : t.status === "in_progress" ? "You have it in progress." : "It is assigned to you.";
    offers.push({
      ref: `ticket:${t.id}`, kind: rule === "assigned" ? "ticket" : "due", rule, title: clip(t.title, 300) || `#${t.id}`, facts, fallback,
      cites: [cite(ticketCite(t.id))],
      order: rule === "assigned"
        ? [STATUS_RANK[t.status] ?? 9, PRIORITY_RANK[t.priority] ?? 9, String(9e15 - (Date.parse(t.updatedAt) || 0)).padStart(16, "0")]
        : [due?.overdue ? -(due.daysLate) : due?.daysLeft ?? 0, PRIORITY_RANK[t.priority] ?? 9, String(t.id).padStart(9, "0")],
    });
  }
  const handoffs = await all<{ number: number; sender: string; recipient: string; body: string; prompt_title: string | null; created_at: string }>(ctx,
    `SELECT number, sender, recipient, body, prompt_title, created_at FROM handoffs
      WHERE org_id = ?1 AND status = 'pending' AND expires_at > ?2 AND number IS NOT NULL
        AND (recipient = ?3 COLLATE NOCASE OR (recipient = 'anyone' AND sender != ?3 COLLATE NOCASE))
      ORDER BY created_at ASC, id ASC LIMIT ${MAX_HANDOFFS}`,
    ctx.orgId, nowIsoStr, me.handle);
  for (const h of handoffs) {
    const forYou = h.recipient.toLowerCase() !== "anyone";
    const fromYou = h.sender.toLowerCase() === me.handle.toLowerCase(); // a note to your next session
    offers.push({
      // Someone else's handoff is someone waiting; one you left for yourself is your own queue.
      ref: `handoff:${h.number}`, kind: "handoff", rule: fromYou ? "assigned" : "waiting",
      title: clip(firstLine(h.body) || h.prompt_title || `Handoff #${h.number}`, 300),
      facts: `left by ${fromYou ? "you" : h.sender} for ${fromYou ? "yourself" : forYou ? "you" : "anyone"} on ${day(h.created_at)}; nobody has claimed it`,
      fallback: fromYou ? "You left it for yourself to pick up." : forYou ? `${h.sender} left it for you.` : `${h.sender} left it for anyone to pick up.`,
      cites: [cite(handoffCite(h.number))], order: fromYou ? [1, 0, h.created_at] : [forYou ? 0 : 1, Date.parse(h.created_at) || 0, String(h.number)],
    });
  }
  for (const o of offers) for (const c of o.cites) cites[c.ref] = c;

  return {
    handle: me.handle, name: me.name ?? null, today: day(nowIsoStr),
    now: { prs, status }, recently: { cards, notes },
    next: orderNext(offers).slice(0, AI_LIST_MAX),
    cites,
  };
}

const EMPTY_CONTENT: Pick<AiBrief, "now" | "recently" | "next"> = { now: null, recently: null, next: { items: [] } };

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// ── the job ──────────────────────────────────────────────────────────────────

export interface BriefJobInput { brief: BriefInput; hash: string }

export const briefJob: ClaudeJob<BriefJobInput, BriefAnswer> = {
  provider: "claude",
  kind: "brief.person",
  name: BRIEF_JOB,
  scope: "person",
  promptVersion: BRIEF_PROMPT_VERSION,
  group: 1, // one Haiku call per person
  schema: BriefAnswerSchema,
  maxTokens: 2000,
  /** Null — and NO call — for someone who is not a member, who neither opened My Work in 14 days nor gets the
   *  digest, whose input has not changed since their last brief, or who has nothing to brief on (then, when their
   *  last brief said something, an EMPTY one replaces it, so My Work stops showing what is no longer true). */
  async input(ctx: TenantContext, scope: DirtyScope): Promise<BriefJobInput | null> {
    const now = new Date();
    if (!briefWanted(await briefAudience(ctx, scope.key), now)) return null;
    const brief = await buildBriefInput(ctx, scope.key, now);
    if (!brief) return null;
    const hash = await sha256(`${BRIEF_PROMPT_VERSION}\n${briefPromptInput(brief)}`);
    const last = await latestBrief(ctx, brief.handle);
    if (last && last.input_hash === hash) return null;
    if (briefIsEmpty(brief)) {
      if (last && last.model !== null) {
        await storeBrief(ctx, brief.handle, { generatedAt: nowIso(), model: null, promptVersion: BRIEF_PROMPT_VERSION, inputHash: hash, briefJson: JSON.stringify(EMPTY_CONTENT) });
      }
      return null;
    }
    return { brief, hash };
  },
  prompt(items: readonly JobItem<BriefJobInput>[]) {
    return { system: BRIEF_SYSTEM, input: briefPromptInput(items[0].input.brief) };
  },
  async write(ctx, items, output, meta) {
    const written: string[] = [];
    for (const it of items) {
      const content = briefFromAnswer(it.input.brief, keep(output).kept);
      if (!content.now && !content.recently && !content.next.items.length) continue; // nothing valid: nothing written
      await storeBrief(ctx, it.input.brief.handle, {
        generatedAt: nowIso(), model: meta.model, promptVersion: BRIEF_PROMPT_VERSION, inputHash: it.input.hash, briefJson: JSON.stringify(content),
      });
      written.push(it.scope.key);
    }
    return written;
  },
};
