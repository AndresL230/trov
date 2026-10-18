// A busy day for one person, seeded through the real writers — what the digest length test, the "only when
// something needs me" test and the Phase E guards measure the daily email on. The window is the 24h ending
// Friday 2026-09-11T12:00Z (08:00 in New York, the default send hour).
import { env } from "cloudflare:test";
import { platformCtx, systemCtx } from "./tenant";
import { run } from "./db";
import { seedPerson } from "./persons";
import { ingestAdrDraft, ingestDocProposal, ingestEvent } from "../../src/consumer";
import { promote_doc } from "../../src/tools/writes";
import { storePrSummary, type PrSummary, type Summarizer } from "../../src/tools/summarize";
import { create_ticket } from "../../src/tools/tickets";
import { create_sprint, set_sprint_active } from "../../src/tools/sprints";
import { write_plan } from "../../src/tools/plan";
import { TicketCreate } from "@shared/tickets";
import { SprintCreate } from "@shared/sprints";
import type { CapturedEvent } from "@shared/contract";
import type { Window } from "@shared/notifications";
import { narr } from "./plan";

export const BUSY_LOGIN = "AndresL230";
export const BUSY_EMAIL = "andres@example.com";
/** The send instant (Fri 08:00 New York) and its daily window. */
export const BUSY_NOW = new Date("2026-09-11T12:00:00.000Z");
export const BUSY_WINDOW: Window = { cadence: "daily", start: new Date("2026-09-10T12:00:00.000Z"), end: BUSY_NOW, id: "2026-09-11" };
const IN = (h: number) => new Date(BUSY_NOW.getTime() - h * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z");

const prEvent = (n: number, login: string, at: string, title: string): CapturedEvent => ({
  semantic_key: `gh:pr:${n}:merged`, event_type: "pr_merged", ref_number: n, subject_login: login,
  raw: JSON.stringify({ pr: { number: n, title, body: "b", html_url: `https://github.com/o/r/pull/${n}`, merged: true, merged_at: at, user: { login }, base: { ref: "main" } } }),
  provenance: "webhook", occurred_at: at,
});
const issueEvent = (n: number, login: string, at: string, title: string, labels: string[]): CapturedEvent => ({
  semantic_key: `gh:issue:${n}:open:${at}`, event_type: "issue", ref_number: n, subject_login: login,
  raw: JSON.stringify({ action: "assigned", issue: { number: n, title, html_url: `https://github.com/o/r/issues/${n}`, state: "open", updated_at: at, user: { login }, assignees: [{ login }], labels, milestone: null } }),
  provenance: "webhook", occurred_at: at,
});
const summarizer = (s: PrSummary): Summarizer<PrSummary> => ({ model: "stub", summarize: async () => s });

/** Seeds the busy day and gives the person an address. Returns the sprint's id. */
export async function seedBusyDay(): Promise<{ sprintId: number }> {
  const ctx = systemCtx();
  const p = platformCtx();
  await run(env.DB, `UPDATE persons SET email = ?, email_unsubscribed = 0 WHERE handle = ?`, BUSY_EMAIL, BUSY_LOGIN);
  await seedPerson("meilin", { github: false });

  // Three merged PRs with full summaries (the old email's What / Why / Impact cards).
  const prs: [number, string, PrSummary][] = [
    [171, "Hosting providers", { title: "Netlify and Vercel as hosting providers", what: "Each environment can name a hosting provider; deploys are polled every hour at :40 and shown on the Repo screen.", why: "Teams deploy from more than Cloudflare.", impact: "Admins connect a provider in Org settings; nothing changes for anyone else." }],
    [172, "Repo setups", { title: "Repository setups", what: "A repository can carry a setup: environments, the branch each deploys, and the checks that gate it.", why: "The Repo screen guessed environments from branch names.", impact: "Existing repositories keep working; an admin can now set them up." }],
    [173, "Fix the sidebar flicker", { title: "The sidebar no longer flickers", what: "The sidebar keeps its nodes across renders; only attributes change.", why: "Typing in a filter rebuilt the sidebar.", impact: "No visible change except the flicker is gone." }],
  ];
  for (const [n, raw, s] of prs) {
    await ingestEvent(ctx, p, prEvent(n, BUSY_LOGIN, IN(4 + n - 171), raw), "github-webhook");
    await storePrSummary(ctx, summarizer(s), { semantic_key: `gh:pr:${n}:merged`, pr_number: n, title: raw, body: "b" });
  }
  // Sift rated one of them breaking (0060_ai_importance).
  await run(env.DB, `UPDATE pr_summaries SET importance = 'breaking' WHERE semantic_key = 'gh:pr:172:merged'`);
  await run(env.DB, `UPDATE pr_summaries SET importance = 'routine' WHERE semantic_key IN ('gh:pr:171:merged', 'gh:pr:173:merged')`);
  // Two open assigned GitHub issues with labels (the old email's issue rows).
  await ingestEvent(ctx, p, issueEvent(201, BUSY_LOGIN, IN(30), "Netlify test failing on preview deploys", ["ci", "hosting"]), "github-webhook");
  await ingestEvent(ctx, p, issueEvent(202, BUSY_LOGIN, IN(50), "Document the hosting job", ["docs"]), "github-webhook");

  // A sprint in progress, due Friday the 18th, with five tickets — two done.
  const sprint = await create_sprint(ctx, SprintCreate.parse({ label: "Hosting", due: "2026-09-18" }), BUSY_LOGIN);
  await set_sprint_active(ctx, sprint.id, true);
  const ticket = async (title: string, o: { assignees?: string[]; status?: string; sprint?: boolean; at: string; requester?: string }) => {
    const id = await create_ticket(ctx, TicketCreate.parse({ title, assignees: o.assignees ?? [], sprint_id: o.sprint ? sprint.id : null }), o.requester ?? BUSY_LOGIN);
    await run(env.DB, `UPDATE tickets SET status = ?, created_at = ?, updated_at = ? WHERE org_id = 'org_saplinglearn' AND id = ?`, o.status ?? "submitted", o.at, o.at, id);
    return id;
  };
  await ticket("Netlify test failing", { assignees: [BUSY_LOGIN], status: "in_progress", sprint: true, at: IN(2) });
  await ticket("Poll Vercel deploys", { assignees: [BUSY_LOGIN], status: "submitted", sprint: true, at: IN(20) });
  await ticket("Hosting docs page", { assignees: [BUSY_LOGIN], status: "submitted", at: IN(40) });
  await ticket("Provider connection card", { assignees: ["lpcooper-arch"], status: "done", sprint: true, at: IN(60) });
  await ticket("Deploy list on Repo", { assignees: ["lpcooper-arch"], status: "done", sprint: true, at: IN(70) });
  // Two unassigned tickets in the queue.
  await ticket("Gradebook export comes back empty", { requester: "meilin", at: IN(3) });
  await ticket("Access to the staging dashboard", { requester: "meilin", at: IN(26) });

  // Review: one staged doc version over a live one, one draft decision.
  await ingestDocProposal(ctx, { slug: "hosting", section: "reference", title: "Hosting", body: "v1", change_summary: "init", confidence: "high" }, "lpcooper-arch");
  await promote_doc(ctx, "hosting", 1, BUSY_LOGIN);
  await ingestDocProposal(ctx, { slug: "hosting", section: "reference", title: "Hosting", body: "v2", change_summary: "the :40 job", confidence: "high" }, "lpcooper-arch");
  await ingestAdrDraft(ctx, { title: "Poll hosts, never call them on render", context: "c", decision: "d", rationale: "r", confidence: "high" }, "lpcooper-arch");

  // A plan change in the window (the old email's full plan diff).
  await write_plan(ctx, { ...narr("n"), sprints: [{ label: "Pricing page", due: "2026-10-01", status: "upcoming" }] }, BUSY_LOGIN);
  await run(env.DB, `UPDATE plan_versions SET created_at = ? WHERE version = (SELECT MAX(version) FROM plan_versions)`, IN(5));

  // A notable session note of the person's own (Sift rated it).
  await run(env.DB,
    `INSERT INTO feed (org_id, author, summary, brief, body, artifacts, created_at, importance) VALUES ('org_saplinglearn', ?, ?, ?, NULL, ?, ?, 'notable')`,
    BUSY_LOGIN, "Hosting deploys now poll every hour", "The :40 job reads each provider's deploys.", JSON.stringify({ prs: ["171"], commits: [], issues: [] }), IN(6));
  return { sprintId: sprint.id };
}

/** Words in a plain-text body (what a reader reads). */
export const wordCount = (text: string): number => (text.match(/\S+/g) ?? []).length;

/** Words a reader sees in an HTML body: no head, no style, no preheader, no tags. */
export const htmlWordCount = (html: string): number =>
  wordCount(html.replace(/<head>[\s\S]*?<\/head>/, " ").replace(/<div style="display:none[^"]*">[\s\S]*?<\/div>/, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " "));
