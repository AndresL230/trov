// Grounding and ref views (docs/architecture/ask.md › Grounding; #12 §2.5–2.6). Two jobs:
//   • which items a tool RETURNED in a thread (`refsFromResult`) — an answer's ref token is linked only when its
//     ref is in the thread's seen set (what a tool returned, or what the person attached);
//   • THE view model of an item (`RefView`): every chip, card, hover card, inspector header, picker row and source
//     row draws from it. Built here from Trov's rows — never model text — and permission-checked for the viewer:
//     an item they cannot see (another person's private artifact, an unknown id) is simply absent, which `peek`
//     answers as `{ ref, hidden: true }`.
// Status words and tips are the design's, over the existing vocabularies (web/src/marks.ts).
import { all, fanOut, first, type TenantContext } from "../../data/sql";
import { askRefTokens, parseAskRef, type AskRefType, type RefStatus, type RefView } from "@shared/ai-ask-core";
import { TICKET_STATUS_LABEL, type TicketStatus } from "@shared/tickets-core";
import { askRepoFacts } from "@shared/ai-ask-core";
import { getRepoDashboard } from "../../tools/repo";
import { orgRepoConfig } from "../../tools/repo-agent";

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null);

const pick = (type: AskRefType, rows: unknown, field: string): string[] =>
  arr(rows).flatMap((r) => {
    const v = obj(r)?.[field];
    const k = num(v) ?? str(v);
    return k === null ? [] : [`${type}:${k}`];
  });

function ticketRefs(t: unknown): string[] {
  const o = obj(t);
  if (!o || num(o.id) === null) return [];
  return [
    `ticket:${o.id}`,
    ...(num(obj(o.sprint)?.id) ? [`sprint:${obj(o.sprint)!.id}`] : []),
    ...(num(obj(o.parent)?.id) ? [`ticket:${obj(o.parent)!.id}`] : []),
    ...pick("ticket", o.children, "id"),
    ...arr(o.assignees).flatMap((a) => (str(a) ? [`person:${a}`] : [])),
    ...pick("artifact", o.artifacts, "slug"),
  ];
}
const sprintRefs = (s: unknown): string[] => {
  const o = obj(s);
  return o && num(o.id) !== null ? [`sprint:${o.id}`, ...pick("ticket", o.tickets, "id")] : [];
};
const one = (type: AskRefType, field: string) => (r: unknown): string[] => {
  const v = obj(r)?.[field];
  const k = num(v) ?? str(v);
  return k === null ? [] : [`${type}:${k}`];
};

/** What each tool's result names, by tool. A tool not listed returns nothing linkable. */
const EXTRACT: Record<string, (r: unknown, args: Record<string, unknown>) => string[]> = {
  query: (r) => [...arr(obj(r)?.primary), ...arr(obj(r)?.pointers)].flatMap((h) => {
    const o = obj(h);
    const type = String(o?.type ?? "");
    const id = String(o?.id ?? "").replace(/^sprint:/, "");
    if (!id) return [];
    if (type === "doc" || type === "artifact" || type === "feed" || type === "decision") return [`${type}:${id}`];
    return type === "sprint" && /^\d+$/.test(id) ? [`sprint:${id}`] : [];
  }),
  get_doc: one("doc", "slug"),
  list_docs: (r) => pick("doc", r, "slug"),
  get_feed: (r) => pick("feed", r, "id"),
  get_roadmap: (r) => arr(obj(r)?.sprints).flatMap(sprintRefs),
  list_tickets: (r) => pick("ticket", r, "id"),
  get_ticket: ticketRefs,
  list_sprints: (r) => arr(r).flatMap(sprintRefs),
  get_sprint: sprintRefs,
  get_my_work: (r) => [...pick("pr", obj(r)?.previousActivity, "number"), ...arr(obj(r)?.tickets).flatMap(ticketRefs)],
  list_people: (r) => pick("person", obj(r)?.people, "handle"),
  get_events: (r) => arr(r).flatMap((e) => {
    const o = obj(e);
    return o && (o.event_type === "pr_merged" || o.event_type === "pr_closed") && num(o.ref_number) ? [`pr:${o.ref_number}`] : [];
  }),
  get_repo_dashboard: (r) => (str(obj(r)?.repo) ? [`repo:${obj(r)!.repo}`] : []),
  artifact_get: one("artifact", "slug"),
  artifact_list: (r) => pick("artifact", obj(r)?.artifacts, "slug"),
  artifact_update: one("artifact", "slug"),
  list_handoffs: (r) => pick("handoff", r, "id"),
  get_handoff: one("handoff", "id"),
  send_handoff: one("handoff", "id"),
  claim_handoff: (_r, a) => (num(a.id) ? [`handoff:${a.id}`] : []),
  expire_handoff: one("handoff", "id"),
  search_prompts: (r) => pick("prompt", r, "slug"),
  get_prompt: one("prompt", "slug"),
  save_prompt: one("prompt", "slug"),
  append_feed: one("feed", "id"),
  propose_doc_update: one("doc", "slug"),
  publish_doc: one("doc", "slug"),
  create_ticket: ticketRefs, edit_ticket: ticketRefs, transition_ticket: ticketRefs, add_ticket_comment: ticketRefs,
  add_ticket_link: ticketRefs, set_ticket_sprint: ticketRefs, set_ticket_parent: ticketRefs, assign_ticket: ticketRefs,
  create_sprint: sprintRefs, set_sprint_active: sprintRefs, complete_sprint: sprintRefs, add_sprint_resource: sprintRefs,
  update_plan: (r) => arr(obj(r)?.sprints).flatMap(sprintRefs),
  save_artifact: one("artifact", "slug"),
  show_items: (r) => arr(obj(r)?.shown).flatMap((x) => (typeof x === "string" ? [x] : [])),
};

/** The refs a tool's result names (deduped, each a valid `type:key`, a person's handle lower-cased). */
export function refsFromResult(tool: string, result: unknown, args: Record<string, unknown> = {}): string[] {
  const fn = EXTRACT[tool];
  if (!fn) return [];
  let refs: string[];
  try { refs = fn(result, args); } catch { return []; }
  return [...new Set(refs.map(normalRef))].filter((r) => parseAskRef(r) !== null);
}

/** A person ref matches whatever the handle's case; every other key is exact. */
export const normalRef = (ref: string): string => (ref.startsWith("person:") ? ref.toLowerCase() : ref);

// ── status words (the design's, over the existing vocabularies) ─────────────

const TICKET_STATUS: Record<TicketStatus, Omit<RefStatus, "word">> = {
  submitted: { mark: "todo", tone: "muted", tip: "Triage. Filed, and waiting for someone to pick it up or decline it." },
  in_progress: { mark: "half", tone: "accent", tip: "In progress. Someone is working on it." },
  testing: { mark: "most", tone: "amber", tip: "Testing. Built, and being checked before it is done." },
  done: { mark: "done", tone: "accent", tip: "Done. Closed as done." },
  declined: { mark: "declined", tone: "faded", tip: "Declined. Closed without doing it." },
};
export const ticketStatus = (s: string): RefStatus | null =>
  s in TICKET_STATUS ? { word: TICKET_STATUS_LABEL[s as TicketStatus], ...TICKET_STATUS[s as TicketStatus] } : null;

const PR_STATUS: Record<string, RefStatus> = {
  draft: { mark: "ring", tone: "muted", word: "Draft", tip: "Not ready for review yet." },
  review: { mark: "ring", tone: "blue", word: "In review", tip: "Waiting on a review." },
  approved: { mark: "dot", tone: "green", word: "Approved", tip: "Approved, not merged yet." },
  merged: { mark: "check", tone: "accent", word: "Merged", tip: "Merged." },
  closed: { mark: "square", tone: "faded", word: "Closed", tip: "Closed without merging." },
};
const DOC_LIVE: RefStatus = { mark: "dot", tone: "green", word: "Live", tip: "Promoted. This is the version agents read." };
const DOC_STAGED: RefStatus = { mark: "ring", tone: "amber", word: "Staged, not approved", tip: "An agent proposed this version. A person has not approved it yet." };
const HANDOFF_STATUS: Record<string, RefStatus> = {
  pending: { mark: "ring", tone: "blue", word: "Pending", tip: "Waiting for a session to claim it. Unclaimed handoffs expire after 7 days." },
  claimed: { mark: "dot", tone: "faded", word: "Claimed", tip: "A session picked it up." },
  expired: { mark: "square", tone: "red", word: "Expired", tip: "Nobody claimed it in time." },
};
const SPRINT_STATUS: Record<string, RefStatus> = {
  in_progress: { mark: "half", tone: "accent", word: "In progress", tip: "The sprint is under way." },
  upcoming: { mark: "ring", tone: "muted", word: "Upcoming", tip: "Not started yet." },
  done: { mark: "check", tone: "accent", word: "Done", tip: "A person completed it." },
};
const DAY = 86_400_000;
export function sprintStatus(status: string, due: string | null, today: string): RefStatus | null {
  if (status !== "done" && due && due < today) {
    const n = Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${due}T00:00:00Z`).getTime()) / DAY);
    return { mark: "warn", tone: "amber", word: `${n} day${n === 1 ? "" : "s"} late`, tip: "At this pace the sprint finishes after its due date." };
  }
  return SPRINT_STATUS[status] ?? null;
}
const ARTIFACT_VIS: Record<string, RefStatus> = {
  private: { mark: "ring", tone: "muted", word: "Private", tip: "Only you can see it." },
  org: { mark: "dot", tone: "blue", word: "Org", tip: "Everyone in the org can see it." },
};

// ── resolution ───────────────────────────────────────────────────────────────

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const firstLine = (s: string): string => (s.split("\n").find((l) => l.trim()) ?? "").replace(/^#+\s*/, "").trim();
const firstPara = (md: string): string => clip((md.split(/\n\s*\n/).find((p) => p.trim() && !/^#/.test(p.trim())) ?? "").replace(/\s+/g, " ").trim(), 280);

/** An item's own words for a card (#178: the single item card): its first paragraph, ≤ 280 chars; null when it has none. */
const excerptOf = (md: string | null | undefined): string | null => (md ? firstPara(md) || null : null);

/**
 * Resolve refs to RefViews, as `viewer` may see them now. A ref that names nothing — or something the viewer may
 * not see — is left out of the map. Batched per type; a failed read leaves that type out rather than failing.
 */
export async function resolveViews(ctx: TenantContext, viewer: string, refs: readonly string[], now: Date = new Date()): Promise<Map<string, RefView>> {
  const byType = new Map<AskRefType, string[]>();
  for (const r of refs) {
    const p = parseAskRef(normalRef(r));
    if (!p) continue;
    const list = byType.get(p.type) ?? [];
    if (!list.includes(p.key)) list.push(p.key);
    byType.set(p.type, list);
  }
  const out = new Map<string, RefView>();
  const put = (v: RefView) => out.set(v.ref, v);
  const ints = (keys: string[]) => keys.filter((k) => /^\d{1,9}$/.test(k)).map(Number);
  const today = now.toISOString().slice(0, 10);
  const guard = async (fn: () => Promise<void>) => { try { await fn(); } catch (e) { console.error("ask refs", e instanceof Error ? e.name : "error"); } };

  await Promise.all([...byType].map(([type, keys]) => guard(async () => {
    switch (type) {
      case "ticket": {
        const rows = await fanOut<{ number: number; title: string; body: string | null; status: string; priority: string; updated_at: string; sprint: string | null; assignees: string | null }>(ctx, ints(keys), (ph) =>
          `SELECT t.number, t.title, t.body, t.status, t.priority, t.updated_at, s.title AS sprint,
                  (SELECT group_concat(a.login, ',') FROM ticket_assignees a WHERE a.ticket_id = t.id AND a.org_id = t.org_id) AS assignees
             FROM tickets t LEFT JOIN sprints s ON s.id = t.sprint_id AND s.org_id = t.org_id
            WHERE t.org_id = ? AND t.number IN (${ph})`, [ctx.orgId]);
        for (const t of rows) {
          const assignees = t.assignees ? t.assignees.split(",") : [];
          put({ ref: `ticket:${t.number}`, type, num: t.number, title: t.title, status: ticketStatus(t.status), owner: assignees[0] ?? null, updated: t.updated_at,
            href: `#tickets/${t.number}`, extra: { priority: t.priority, assignees, sprint: t.sprint, excerpt: excerptOf(t.body) } });
        }
        break;
      }
      case "pr": {
        const nums = ints(keys);
        const sums = await fanOut<{ pr_number: number; title: string | null; repo: string; what: string | null }>(ctx, nums, (ph) =>
          `SELECT pr_number, title, repo, what FROM pr_summaries WHERE org_id = ? AND pr_number IN (${ph})`, [ctx.orgId]);
        const prs = await fanOut<{ number: number; state: string; ref: string | null; sha: string | null; actor_login: string | null; title: string | null; url: string | null; raw: string | null; repo: string; occurred_at: string }>(ctx, nums, (ph) =>
          `SELECT number, state, ref, sha, actor_login, title, url, raw, repo, occurred_at FROM repo_events WHERE org_id = ? AND kind = 'pr' AND number IN (${ph}) ORDER BY occurred_at DESC`, [ctx.orgId]);
        const evs = await fanOut<{ ref_number: number; event_type: string; repo: string; subject_login: string; occurred_at: string | null }>(ctx, nums, (ph) =>
          `SELECT ref_number, event_type, repo, subject_login, occurred_at FROM events WHERE org_id = ? AND event_type IN ('pr_merged', 'pr_closed') AND ref_number IN (${ph})`, [ctx.orgId]);
        const approved = await fanOut<{ number: number }>(ctx, nums, (ph) =>
          `SELECT DISTINCT number FROM repo_events WHERE org_id = ? AND kind = 'review' AND state = 'approved' AND number IN (${ph})`, [ctx.orgId]);
        for (const n of nums) {
          const s = sums.find((x) => x.pr_number === n);
          const p = prs.find((x) => x.number === n);
          const e = evs.find((x) => x.ref_number === n);
          if (!s && !p && !e) continue;
          const repo = s?.repo ?? p?.repo ?? e?.repo ?? "";
          let state = e ? (e.event_type === "pr_merged" ? "merged" : "closed") : p?.state ?? null;
          if (state === "review" && approved.some((a) => a.number === n)) state = "approved";
          const base = (() => { try { return (JSON.parse(p?.raw ?? "{}") as { base?: string }).base ?? null; } catch { return null; } })();
          const checks = p?.sha ? await all<{ name: string; state: string }>(ctx,
            `SELECT name, state FROM repo_events WHERE org_id = ? AND kind = 'check' AND sha = ? ORDER BY occurred_at DESC`, ctx.orgId, p.sha) : [];
          const latest = [...new Map(checks.map((c) => [c.name, c])).values()];
          put({ ref: `pr:${n}`, type, num: n, title: s?.title ?? p?.title ?? `Pull request #${n}`, status: state ? PR_STATUS[state] ?? null : null,
            owner: p?.actor_login ?? e?.subject_login ?? null, updated: p?.occurred_at ?? e?.occurred_at ?? null,
            href: p?.url ?? (repo ? `https://github.com/${repo}/pull/${n}` : null),
            extra: { author: p?.actor_login ?? e?.subject_login ?? null, head: p?.ref ?? null, base, repo, checks: latest.map((c) => ({ name: c.name, state: c.state })), excerpt: excerptOf(s?.what) } });
        }
        break;
      }
      case "doc": {
        const rows = await fanOut<{ slug: string; title: string; body: string; space: string; current_version: number; owner: string | null; updated_at: string | null; staged: number }>(ctx, keys, (ph) =>
          `SELECT d.slug, d.title, d.body, d.space, d.current_version, d.owner, d.updated_at,
                  (SELECT COUNT(*) FROM doc_versions v WHERE v.org_id = d.org_id AND v.slug = d.slug AND v.status = 'staged') AS staged
             FROM docs d WHERE d.org_id = ? AND d.slug IN (${ph})`, [ctx.orgId]);
        for (const d of rows) put({ ref: `doc:${d.slug}`, type, title: d.title || d.slug, status: d.staged ? DOC_STAGED : DOC_LIVE, owner: d.owner, updated: d.updated_at,
          href: null, extra: { space: d.space, version: d.current_version, owner: d.owner, excerpt: firstPara(d.body), staged: d.staged > 0 } });
        // A NEW doc that exists only as a staged proposal.
        const missing = keys.filter((k) => !rows.some((d) => d.slug === k));
        const staged = await fanOut<{ slug: string; body: string; created_by: string; created_at: string; version: number }>(ctx, missing, (ph) =>
          `SELECT slug, body, created_by, created_at, version FROM doc_versions WHERE org_id = ? AND status = 'staged' AND slug IN (${ph}) ORDER BY version DESC`, [ctx.orgId]);
        for (const d of staged) if (!out.has(`doc:${d.slug}`)) put({ ref: `doc:${d.slug}`, type, title: d.slug, status: DOC_STAGED, owner: d.created_by, updated: d.created_at,
          href: null, extra: { space: null, version: d.version, owner: d.created_by, excerpt: firstPara(d.body), staged: true } });
        break;
      }
      case "decision": {
        const rows = await fanOut<{ id: number; title: string; status: string; decision: string | null; context: string | null; created_by: string | null; created_at: string }>(ctx, ints(keys), (ph) =>
          `SELECT id, title, status, decision, context, created_by, created_at FROM adrs WHERE org_id = ? AND id IN (${ph})`, [ctx.orgId]);
        for (const a of rows) put({ ref: `decision:${a.id}`, type, num: a.id, title: a.title, owner: a.created_by, updated: a.created_at, href: null, extra: { excerpt: excerptOf(a.decision) ?? excerptOf(a.context) },
          status: a.status === "ratified" ? { mark: "check", tone: "accent", word: "Ratified", tip: "A person ratified this decision." } : { mark: "ring", tone: "amber", word: "Draft", tip: "Proposed, not ratified yet." } });
        break;
      }
      case "feed": {
        const rows = await fanOut<{ id: number; summary: string; brief: string | null; author: string; created_at: string }>(ctx, ints(keys), (ph) =>
          `SELECT id, summary, brief, author, created_at FROM feed WHERE org_id = ? AND id IN (${ph})`, [ctx.orgId]);
        for (const f of rows) put({ ref: `feed:${f.id}`, type, num: f.id, title: f.summary, status: null, owner: f.author, updated: f.created_at, href: null, extra: { brief: f.brief } });
        break;
      }
      case "sprint": {
        const rows = await fanOut<{ id: number; title: string; status: string; summary: string | null; description: string | null; target_date: string | null; start_date: string | null; lead: string | null; updated_at: string | null; total: number; closed: number }>(ctx, ints(keys), (ph) =>
          `SELECT s.id, s.title, s.status, s.summary, s.description, s.target_date, s.start_date, s.lead, s.updated_at,
                  (SELECT COUNT(*) FROM tickets t WHERE t.sprint_id = s.id AND t.org_id = s.org_id) AS total,
                  (SELECT COUNT(*) FROM tickets t WHERE t.sprint_id = s.id AND t.org_id = s.org_id AND t.status IN ('done', 'declined')) AS closed
             FROM sprints s WHERE s.org_id = ? AND s.id IN (${ph})`, [ctx.orgId]);
        for (const s of rows) put({ ref: `sprint:${s.id}`, type, num: s.id, title: s.title, status: sprintStatus(s.status, s.target_date || null, today), owner: s.lead, updated: s.updated_at,
          href: `#sprints/${s.id}`, extra: { start: s.start_date, due: s.target_date || null, progress: { closed: s.closed, total: s.total }, excerpt: excerptOf(s.summary) ?? excerptOf(s.description) } });
        break;
      }
      case "handoff": {
        const rows = await fanOut<{ number: number; status: string; body: string; sender: string; recipient: string; created_at: string; context: string }>(ctx, ints(keys), (ph) =>
          `SELECT number, status, body, sender, recipient, created_at, context FROM handoffs WHERE org_id = ? AND number IN (${ph})`, [ctx.orgId]);
        for (const h of rows) {
          let task: string | null = null;
          try { task = (JSON.parse(h.context) as { task?: string }).task ?? null; } catch { task = null; }
          put({ ref: `handoff:${h.number}`, type, num: h.number, title: clip(firstLine(h.body), 140), status: HANDOFF_STATUS[h.status] ?? null, owner: h.sender, updated: h.created_at,
            href: `#handoffs/${h.number}`, extra: { from: h.sender, to: h.recipient, task } });
        }
        break;
      }
      case "artifact": {
        // A private page is its author's alone; a deleted or not-yet-uploaded one is nobody's.
        const rows = await fanOut<{ slug: string; title: string; status: string; kind: string; visibility: string; author_id: string; updated_at: string; current_version: number }>(ctx, keys, (ph) =>
          `SELECT slug, title, status, kind, visibility, author_id, updated_at, current_version FROM artifact_pages
            WHERE org_id = ? AND deleted_at IS NULL AND current_version > 0 AND (visibility = 'org' OR author_id = ? COLLATE NOCASE) AND slug IN (${ph})`,
          [ctx.orgId, viewer]);
        for (const a of rows) put({ ref: `artifact:${a.slug}`, type, title: a.title, status: ARTIFACT_VIS[a.visibility] ?? null, owner: a.author_id, updated: a.updated_at,
          href: `#artifacts/${a.slug}`, extra: { kind: a.kind, visibility: a.visibility, version: a.current_version, status: a.status } });
        break;
      }
      case "person": {
        const rows = await fanOut<{ handle: string; name: string | null; role: string | null }>(ctx, keys, (ph) =>
          `SELECT p.handle, p.name, p.role FROM persons p JOIN memberships m ON m.user_id = p.handle COLLATE NOCASE AND m.org_id = ?
            WHERE p.handle COLLATE NOCASE IN (${ph})`, [ctx.orgId]);
        for (const p of rows) {
          const working = await all<{ number: number }>(ctx,
            `SELECT t.number FROM tickets t JOIN ticket_assignees a ON a.ticket_id = t.id AND a.org_id = t.org_id
              WHERE t.org_id = ? AND a.login = ? COLLATE NOCASE AND t.status IN ('in_progress', 'testing') ORDER BY t.updated_at DESC LIMIT 3`, ctx.orgId, p.handle);
          const open = await first<{ n: number }>(ctx,
            `SELECT COUNT(*) AS n FROM tickets t JOIN ticket_assignees a ON a.ticket_id = t.id AND a.org_id = t.org_id
              WHERE t.org_id = ? AND a.login = ? COLLATE NOCASE AND t.status NOT IN ('done', 'declined')`, ctx.orgId, p.handle);
          put({ ref: `person:${p.handle.toLowerCase()}`, type, title: p.name || p.handle, status: null, owner: p.handle, href: null,
            extra: { handle: p.handle, ...(p.role ? { role: p.role } : {}), workingOn: working.map((w) => `ticket:${w.number}`), openTickets: open?.n ?? null } });
        }
        break;
      }
      case "prompt": {
        const rows = await fanOut<{ slug: string; title: string; description: string | null; author: string; updated_at: string; status: string | null }>(ctx, keys, (ph) =>
          `SELECT p.slug, p.title, p.description, p.author, p.updated_at, (SELECT v.status FROM prompt_versions v WHERE v.org_id = p.org_id AND v.slug = p.slug ORDER BY v.version DESC LIMIT 1) AS status
             FROM prompts p WHERE p.org_id = ? AND p.deleted_at IS NULL AND p.slug IN (${ph})`, [ctx.orgId]);
        for (const p of rows) put({ ref: `prompt:${p.slug}`, type, title: p.title, owner: p.author, updated: p.updated_at, href: `#prompts/${encodeURIComponent(p.slug)}`, extra: { excerpt: excerptOf(p.description) },
          status: p.status === "published" ? { mark: "dot", tone: "green", word: "Published", tip: "Settled: published by a person." }
            : p.status === "staged" ? { mark: "ring", tone: "amber", word: "Staged", tip: "Waiting for a person to publish it." } : { mark: "ring", tone: "muted", word: "Draft", tip: "Not published yet." } });
        break;
      }
      case "repo": {
        // #186: a repository is what the Repo Overview says it is — its ONE projection, RepoFacts (the dashboard's
        // own read: D1 only, nothing external). Its state is drawn by the client from the facts with the
        // Overview's verdict and marks; a failed read is `facts: null` (Unknown), never a guess.
        const { envs } = await orgRepoConfig(ctx);
        for (const repo of keys) {
          const known = await first<{ repo_full_name: string }>(ctx, `SELECT repo_full_name FROM org_repos WHERE org_id = ? AND repo_full_name = ? COLLATE NOCASE`, ctx.orgId, repo);
          if (!known) continue;
          const d = await getRepoDashboard(ctx, known.repo_full_name, now.getTime(), envs).catch(() => null);
          const facts = d?.facts ? askRepoFacts(d.facts) : null;
          put({ ref: `repo:${repo}`, type, title: known.repo_full_name, status: null, href: "#repo", updated: d?.generatedAt ?? null, extra: { facts } });
        }
        break;
      }
    }
  })));
  return out;
}

/**
 * An answer's tokens, linked: each ref that is in `seen` AND resolves to something the viewer may see now, as a
 * RefView (in order of first appearance). Everything else stays plain text on screen.
 */
export async function linkAnswer(ctx: TenantContext, viewer: string, text: string, seen: ReadonlySet<string>, now?: Date): Promise<RefView[]> {
  const tokens = askRefTokens(text).map(normalRef).filter((r) => seen.has(r));
  const views = await resolveViews(ctx, viewer, tokens, now);
  return tokens.flatMap((t) => (views.has(t) ? [views.get(t)!] : []));
}
