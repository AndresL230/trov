// Ask Trov's tools (docs/architecture/ask.md › Tools): the MCP catalog, minus a short list, plus Ask's own.
//
//   • Definitions — names, descriptions and input schemas — come from shared/mcp-tools.generated.ts, exactly what
//     an MCP client is served (less the connection's own `repo` / `org` arguments, and `session`, which Ask fills).
//   • Implementations call the SAME src/tools/* functions src/mcp.ts calls, with the cookie person's tenant
//     context. This module NEVER imports src/mcp.ts (test/secrets.mcp.test.ts walks the import graph both ways).
//   • A mode's tools (ASK_MODES): Fast gets the search and list tools plus the stored cards (`index`); Smart and
//     Thinking the full catalog. Admin-only tools (`update_plan`) are offered only to an admin, as MCP lists them.
//   • Reads run freely. Every WRITE is a card (./actions.ts). The exclusions are `ASK_EXCLUDED_TOOLS`;
//     test/ask.parity.test.ts fails while an MCP tool is neither wired here nor excluded there.
import { z } from "zod";
import { hasRole, type TenantContext } from "../../data/context";
import { all, first } from "../../data/sql";
import { MCP_TOOLS } from "@shared/mcp-tools.generated";
import {
  ASK_CHART_QUERIES, ASK_DIAGRAM_NODES_MAX, ASK_EXCLUDED_TOOLS, ASK_REFS_MAX, askMode, parseAskRef,
  type AskActivityIcon, type AskBlock, type AskDiagram, type AskMode,
} from "@shared/ai-ask-core";
import { AI_THEME_RANGES } from "@shared/ai-core";
import { get_doc, list_docs, get_feed, query, list_tickets, get_ticket, list_sprints, get_sprint } from "../../tools/reads";
import { TicketSeg, TicketAssigneeFilter, TicketCategory } from "@shared/tickets";
import { TicketError } from "../../tools/tickets";
import { SprintError } from "../../tools/sprints";
import { getMyWork, list_events } from "../../tools/mywork";
import { listPeopleForAgents } from "../../tools/people";
import { getRepoDashboardForAgent, orgRepoConfig } from "../../tools/repo-agent";
import { REPO_RANGES, REPO_TAB_SECTIONS, type RepoTab } from "@shared/repo";
import { listTagRefs } from "../../tools/tags";
import { QueryType } from "@shared/contract";
import { agentArtifactGet, agentArtifactList, artifactsForTicket } from "../../tools/artifacts-agent";
import { ARTIFACT_AREAS, ARTIFACT_KINDS, ARTIFACT_STATUSES } from "@shared/artifacts";
import { get_plan } from "../../tools/plan";
import { listHandoffs, getHandoff, HandoffError } from "../../tools/handoffs";
import { listPrompts, getPrompt, recordPromptUse, PromptError } from "../../tools/prompts";
import { detectVars, fillVars, firstLine, type HandoffView } from "@shared/handoffs";
import { threadAttachment } from "../../data/ask";
import { artifactCtxOf, type AskToolCtx, type SearchArea } from "./context";
import { searchDocs } from "./docs";
import { resolveViews, normalRef } from "./refs";
import { runChart, weekStarts, shortDay } from "./charts";
import { WRITES, type WriteSpec } from "./actions";
import { readAttachmentBlocks } from "./attachments";

export type { AskToolCtx } from "./context";

/** A read: validated input in, a JSON-able result out (handed to the model fenced). `content` is a read that
 *  answers with content blocks of its own (an attachment's image or PDF). */
export interface ReadSpec<A> {
  kind: "read";
  input: z.ZodType<A>;
  icon: AskActivityIcon;
  /** The areas a search looks in (for "What I searched"). */
  searches?: (a: A) => [SearchArea, string | null][];
  run: (c: AskToolCtx, a: A) => Promise<unknown>;
}
/** A show tool: the server builds a block the screen draws; the model is told only what was shown. */
export interface ShowSpec<A> {
  kind: "show";
  input: z.ZodType<A>;
  icon: AskActivityIcon;
  show: (c: AskToolCtx, a: A) => Promise<{ block: AskBlock; shown: string[]; note: string }>;
}
export type ToolSpec = ReadSpec<any> | ShowSpec<any> | (WriteSpec<any> & { kind: "write" }); // eslint-disable-line @typescript-eslint/no-explicit-any

const id = z.number();
const read = <A>(input: z.ZodType<A>, icon: AskActivityIcon, run: (c: AskToolCtx, a: A) => Promise<unknown>, searches?: (a: A) => [SearchArea, string | null][]): ReadSpec<A> =>
  ({ kind: "read", input, icon, run, searches });

const QUERY_AREAS: Record<string, SearchArea> = { doc: "docs", decision: "decisions", feed: "feed", sprint: "sprints", artifact: "artifacts" };

/** The READ tools of the MCP catalog — the same calls src/mcp.ts makes, with the cookie person's context. */
const READS: Record<string, ReadSpec<any>> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  query: read(z.object({
    q: z.string().optional(), types: z.array(QueryType).optional(), section: z.string().optional(),
    space: z.enum(["technical", "product"]).optional(), include_staged: z.boolean().optional(),
    limit: z.number().optional(), pointer_limit: z.number().optional(),
  }), "search", (c, a) => query(c.ctx, { ...a, q: a.q ?? "", include_staged: a.include_staged ?? true }, c.handle),
  (a) => (a.types?.length ? a.types : ["doc", "decision", "feed", "sprint", "artifact"]).map((t: string) => [QUERY_AREAS[t], null] as [SearchArea, null])),
  get_doc: read(z.object({ slug: z.string() }), "docs", (c, a) => get_doc(c.ctx, a.slug)),
  list_docs: read(z.object({ section: z.string().optional() }), "docs", (c, a) => list_docs(c.ctx, a.section), () => [["docs", null]]),
  get_feed: read(z.object({ author: z.string().optional(), tags: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional() }),
    "feed", (c, a) => get_feed(c.ctx, a), (a) => [["feed", a.since ?? null]]),
  list_tags: read(z.object({}), "read", (c) => listTagRefs(c.ctx)),
  get_roadmap: read(z.object({}), "sprint", (c) => get_plan(c.ctx), () => [["sprints", null]]),
  list_tickets: read(z.object({ seg: TicketSeg.optional(), assignee: TicketAssigneeFilter.optional(), category: TicketCategory.optional() }),
    "tickets", (c, a) => list_tickets(c.ctx, { ...a, me: c.handle }), () => [["tickets", null]]),
  get_ticket: read(z.object({ id }), "tickets", async (c, a) => {
    const ticket = await get_ticket(c.ctx, a.id);
    if (!ticket) throw new TicketError("not_found", `no such ticket: ${a.id}`);
    return { ...ticket, artifacts: await artifactsForTicket(c.ctx, a.id, c.handle) };
  }),
  list_sprints: read(z.object({}), "sprint", (c) => list_sprints(c.ctx), () => [["sprints", null]]),
  get_sprint: read(z.object({ id }), "sprint", async (c, a) => {
    const sprint = await get_sprint(c.ctx, a.id);
    if (!sprint) throw new SprintError("not_found", `no such sprint: ${a.id}`);
    return sprint;
  }),
  get_my_work: read(z.object({}), "tickets", (c) => getMyWork(c.ctx, c.handle)),
  list_people: read(z.object({}), "read", async (c) => ({ people: await listPeopleForAgents(c.ctx) })),
  get_events: read(z.object({ type: z.enum(["pr_merged", "pr_closed", "issue"]).optional(), subject: z.string().optional(), limit: z.number().optional() }),
    "pr", (c, a) => list_events(c.ctx, a)),
  get_repo_dashboard: read(z.object({
    tab: z.enum(Object.keys(REPO_TAB_SECTIONS) as [RepoTab, ...RepoTab[]]).optional(), range: z.enum(REPO_RANGES).optional(), include_trends: z.boolean().optional(),
    // MCP's `app` narrowing (#186): an app key, or `__repo`; unknown reads as every app.
    app: z.string().max(40).optional(),
  }), "ci", async (c, a) => {
    const { repo, envs } = await orgRepoConfig(c.ctx);
    return getRepoDashboardForAgent(c.ctx, repo, envs, { tab: a.tab, range: a.range, includeTrends: a.include_trends, app: a.app ?? null });
  }),
  artifact_get: read(z.object({ slug: z.string().min(1), version: z.number().int().min(1).optional(), include_content: z.boolean().optional(), include_file: z.boolean().optional() }),
    // `include_file` is MCP's shape; Ask attaches no file (the person opens the artifact itself).
    "read", async (c, a) => ({ ...(await agentArtifactGet(artifactCtxOf(c), { slug: a.slug, version: a.version, include_content: a.include_content })), ...(a.include_file ? { file: "unavailable" } : {}) })),
  artifact_list: read(z.object({
    q: z.string().max(200).optional(), kind: z.enum(ARTIFACT_KINDS).optional(), area: z.enum(ARTIFACT_AREAS).optional(), author: z.string().max(80).optional(),
    status: z.enum(ARTIFACT_STATUSES).optional(), ticket: z.union([z.number().int().min(1), z.string().max(20)]).optional(),
    sprint: z.union([z.number().int().min(1), z.string().max(20)]).optional(), limit: z.number().int().min(1).max(100).optional(),
  }), "read", (c, a) => agentArtifactList(artifactCtxOf(c), a), () => [["artifacts", null]]),
  list_handoffs: read(z.object({ box: z.enum(["mine", "me", "anyone", "sent"]).optional() }), "handoffs", async (c, a) => {
    const line = (h: HandoffView) => ({ id: h.id, sender: h.sender, recipient: h.recipient, status: h.status, created_at: h.created_at, task: h.context.task, excerpt: firstLine(h.body) });
    if (a.box === "sent") return (await listHandoffs(c.ctx, c.handle, "sent")).map(line);
    if (a.box) return (await listHandoffs(c.ctx, c.handle, a.box, ["pending"])).map(line);
    const [me, anyone] = await Promise.all([listHandoffs(c.ctx, c.handle, "me", ["pending"]), listHandoffs(c.ctx, c.handle, "anyone", ["pending"])]);
    return [...me, ...anyone].sort((x, y) => (x.created_at < y.created_at ? 1 : -1)).map(line);
  }, () => [["handoffs", null]]),
  get_handoff: read(z.object({ id: z.number().int() }), "handoffs", async (c, a) => {
    const h = await getHandoff(c.ctx, a.id);
    if (!h) throw new HandoffError("not_found", "handoff not found");
    return h;
  }),
  search_prompts: read(z.object({ q: z.string().optional(), tags: z.array(z.string()).optional() }), "search", (c, a) => listPrompts(c.ctx, a), () => [["prompts", null]]),
  get_prompt: read(z.object({ slug: z.string(), vars: z.record(z.string(), z.string()).optional() }), "read", async (c, a) => {
    await recordPromptUse(c.ctx, a.slug);
    const p = await getPrompt(c.ctx, a.slug);
    if (!p) throw new PromptError("not_found", "prompt not found");
    const variables = detectVars(p.body);
    const values = a.vars ?? {};
    return { ...p, body: fillVars(p.body, values), variables, unfilled: variables.filter((v) => !values[v]?.trim()) };
  }),
  // ── Ask only ──
  trov_docs: read(z.object({ q: z.string().min(1).max(300) }), "docs", async (c, a) => {
    const full = await c.docs();
    if (!full) return { error: "Trov's docs are not available right now.", sections: [] };
    const { sections } = searchDocs(full, a.q);
    return sections.length ? { sections } : { sections: [], note: "Nothing in Trov's docs matched those words." };
  }, () => [["trov_docs", null]]),
  // An attachment of THIS thread, read again in a later turn (#12 §2.13). Only the person's own thread's.
  read_attachment: read(z.object({ id: z.number().int().positive() }), "read", async (c, a) => {
    const row = await threadAttachment(c.ctx, c.threadId, a.id);
    if (!row) throw new TicketError("not_found", "There is no such attachment in this thread.");
    // A thread shared to continue (0077): a file someone else attached stays private to them — the private artifact's
    // own rule (readRaw) would refuse it too; this says why.
    if (row.author_id && row.author_id.toLowerCase() !== c.handle.toLowerCase()) {
      throw new TicketError("forbidden", "That file was attached by someone else and is private to them: you can see its name, not what is in it.");
    }
    return { __blocks: await readAttachmentBlocks(c.ctx, c.env.ARTIFACTS_BUCKET, c.handle, row.artifact_id) };
  }),
};

// ── show tools ──────────────────────────────────────────────────────────────

const DiagramIn = z.object({
  title: z.string().min(1).max(120),
  caption: z.string().max(200).optional(),
  nodes: z.array(z.object({ id: z.string().min(1).max(40), label: z.string().min(1).max(120), eyebrow: z.string().max(40).optional(), ref: z.string().max(110).optional() })).min(1).max(ASK_DIAGRAM_NODES_MAX),
  edges: z.array(z.tuple([z.string(), z.string()])).max(ASK_DIAGRAM_NODES_MAX * 2).default([]),
});

/** Can the client draw it as a graph? Every edge names two different known nodes and nothing loops (the client lays any
 *  such graph out in lanes, web/src/ask-diagram.ts); otherwise it is drawn as a list. */
export function diagramDrawable(nodes: { id: string }[], edges: [string, string][]): boolean {
  const ids = new Set(nodes.map((n) => n.id));
  if (edges.some(([a, b]) => !ids.has(a) || !ids.has(b) || a === b)) return false;
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const [, b] of edges) indeg.set(b, indeg.get(b)! + 1);
  const ready = nodes.filter((n) => !indeg.get(n.id)).map((n) => n.id);
  let seen = 0;
  while (ready.length) {
    const id = ready.pop()!;
    seen++;
    for (const [a, b] of edges) if (a === id) { indeg.set(b, indeg.get(b)! - 1); if (!indeg.get(b)) ready.push(b); }
  }
  return seen === nodes.length;
}

/** A chain when the edges walk every node once, start to end (`layout: "chain"`); anything else is `"list"` — which the
 *  client still draws as a graph when `diagramDrawable`. */
export function chainOrder(nodes: { id: string }[], edges: [string, string][]): string[] | null {
  const ids = new Set(nodes.map((n) => n.id));
  if (edges.some(([a, b]) => !ids.has(a) || !ids.has(b) || a === b)) return null;
  const next = new Map<string, string>();
  const hasIn = new Set<string>();
  for (const [a, b] of edges) {
    if (next.has(a) || hasIn.has(b)) return null;
    next.set(a, b);
    hasIn.add(b);
  }
  const starts = nodes.filter((n) => !hasIn.has(n.id));
  if (starts.length !== 1) return null;
  const order: string[] = [];
  for (let at: string | undefined = starts[0].id; at && !order.includes(at); at = next.get(at)) order.push(at);
  return order.length === nodes.length ? order : null;
}

const SEARCH_LABEL: Record<SearchArea, string> = {
  docs: "Docs", tickets: "Tickets and comments", feed: "Feed", artifacts: "Artifacts", decisions: "Decisions", sprints: "Sprints",
  prompts: "Prompt Library", handoffs: "Handoffs", trov_docs: "Trov's docs",
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "What I searched": each area this turn's search calls looked in, with the counts the server computes. */
async function searchedScopes(c: AskToolCtx): Promise<{ area: string; scope: string }[]> {
  const out: { area: string; scope: string }[] = [];
  const n = async (sql: string, ...p: unknown[]) => Number((await first<{ n: number }>(c.ctx, sql, ...p))?.n ?? 0);
  for (const [area, since] of c.searched) {
    let scope = "";
    switch (area) {
      case "docs": {
        const spaces = await all<{ space: string; n: number }>(c.ctx, `SELECT space, COUNT(*) AS n FROM docs WHERE org_id = ? GROUP BY space`, c.ctx.orgId);
        const total = spaces.reduce((a, s) => a + Number(s.n), 0);
        const names = spaces.map((s) => (s.space === "product" ? "Product" : "Technical")).sort((a, b) => (a === "Technical" ? -1 : b === "Technical" ? 1 : 0));
        scope = `${names.length ? `${names.join(" and ")}, ` : ""}${plural(total, "doc")}`;
        break;
      }
      case "tickets":
        scope = `${plural(await n(`SELECT COUNT(*) AS n FROM tickets WHERE org_id = ?`, c.ctx.orgId), "ticket")}, ${plural(await n(`SELECT COUNT(*) AS n FROM ticket_comments WHERE org_id = ?`, c.ctx.orgId), "comment")}`;
        break;
      case "feed":
        scope = since
          ? `${plural(await n(`SELECT COUNT(*) AS n FROM feed WHERE org_id = ? AND created_at >= ?`, c.ctx.orgId, since), "entry", "entries")} since ${shortDay(since.slice(0, 10))}`
          : plural(await n(`SELECT COUNT(*) AS n FROM feed WHERE org_id = ?`, c.ctx.orgId), "entry", "entries");
        break;
      case "artifacts":
        scope = plural(await n(`SELECT COUNT(*) AS n FROM artifact_pages WHERE org_id = ? AND deleted_at IS NULL AND current_version > 0 AND (visibility = 'org' OR author_id = ? COLLATE NOCASE)`, c.ctx.orgId, c.handle), "artifact");
        break;
      case "decisions": scope = plural(await n(`SELECT COUNT(*) AS n FROM adrs WHERE org_id = ?`, c.ctx.orgId), "decision"); break;
      case "sprints": scope = plural(await n(`SELECT COUNT(*) AS n FROM sprints WHERE org_id = ?`, c.ctx.orgId), "sprint"); break;
      case "prompts": scope = plural(await n(`SELECT COUNT(*) AS n FROM prompts WHERE org_id = ? AND deleted_at IS NULL`, c.ctx.orgId), "prompt"); break;
      case "handoffs": scope = plural(await n(`SELECT COUNT(*) AS n FROM handoffs WHERE org_id = ?`, c.ctx.orgId), "handoff"); break;
      case "trov_docs": scope = "Trov's own help pages"; break;
    }
    out.push({ area: SEARCH_LABEL[area], scope });
  }
  return out;
}

/** Ask's show tools: the model names WHAT to show; the server reads every value. */
const SHOWS: Record<string, ShowSpec<any>> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  show_items: {
    kind: "show", icon: "read",
    input: z.object({ refs: z.array(z.string()).min(1).max(ASK_REFS_MAX) }),
    async show(c, a: { refs: string[] }) {
      const refs = [...new Set(a.refs.map(normalRef))].filter((r) => parseAskRef(r) !== null);
      const views = await resolveViews(c.ctx, c.handle, refs, c.now());
      const items = refs.flatMap((r) => (views.has(r) ? [views.get(r)!] : []));
      const missing = refs.filter((r) => !views.has(r));
      return { block: { kind: "items", items }, shown: items.map((i) => i.ref), note: `Shown ${items.length} item card(s)${missing.length ? `; not found: ${missing.join(", ")}` : ""}.` };
    },
  },
  show_chart: {
    kind: "show", icon: "pr",
    input: z.object({ query: z.enum(ASK_CHART_QUERIES), weeks: z.number().int().min(1).max(26).optional(), repo: z.string().max(200).optional(), sprint_id: z.number().int().optional() }),
    async show(c, a) {
      const { query: q, ...params } = a;
      const chart = await runChart(c.ctx, q, params, c.now());
      return {
        block: { kind: "chart", chart },
        shown: q === "sprint_burndown" && a.sprint_id ? [`sprint:${a.sprint_id}`] : [],
        note: chart.rows.length ? `Shown "${chart.title}": ${chart.total} ${chart.unit} in all. The person sees every number on the chart; do not repeat them as fact beyond the total.` : `Shown "${chart.title}": there is nothing to chart yet.`,
      };
    },
  },
  show_themes: {
    kind: "show", icon: "pr",
    input: z.object({ repo: z.string().max(200).optional(), range: z.enum(AI_THEME_RANGES).optional() }),
    async show(c, a) {
      const weeks = weekStarts(c.now(), a.range === "quarter" ? 13 : 8).map(shortDay);
      // Themes are written by the AI pass (Phase D). Until an org has them the strip has no lanes. The caption says
      // what the data really is: shares of merged PRs (agent sessions are not themed yet).
      return {
        block: { kind: "themes", themes: { title: "Where the time went, by theme", caption: "Share of merged PRs", weeks, lanes: [] } },
        shown: [], note: "Shown the theme strip: this organization has no themes yet, so it is empty. Say so.",
      };
    },
  },
  show_diagram: {
    kind: "show", icon: "read",
    input: DiagramIn,
    async show(c, a: z.infer<typeof DiagramIn>) {
      const refs = a.nodes.flatMap((n) => (n.ref && parseAskRef(normalRef(n.ref)) ? [normalRef(n.ref)] : []));
      const views = await resolveViews(c.ctx, c.handle, refs, c.now());
      const order = chainOrder(a.nodes, a.edges);
      const byId = new Map(a.nodes.map((n) => [n.id, n]));
      const nodes = (order ?? a.nodes.map((n) => n.id)).map((nid) => {
        const n = byId.get(nid)!;
        const ref = n.ref ? normalRef(n.ref) : null;
        const v = ref ? views.get(ref) ?? null : null;
        return { id: n.id, label: n.label, eyebrow: n.eyebrow ?? null, ref: v ? ref : null, view: v };
      });
      const diagram: AskDiagram = { title: a.title, caption: a.caption ?? null, nodes, edges: a.edges, layout: order ? "chain" : "list" };
      return { block: { kind: "diagram", diagram }, shown: nodes.flatMap((n) => (n.ref ? [n.ref] : [])), note: `Shown the diagram "${a.title}"${order || diagramDrawable(a.nodes, a.edges) ? "" : " as a list (its edges loop or name a node that isn't there)"}.` };
    },
  },
  // "I couldn't find that in Trov": the server fills what this turn searched, with counts.
  show_not_found: {
    kind: "show", icon: "search",
    input: z.object({ query: z.string().min(1).max(200), tries: z.array(z.string().min(1).max(120)).max(2).default([]) }),
    async show(c, a) {
      return { block: { kind: "not_found", notFound: { query: a.query, tries: a.tries, searched: await searchedScopes(c) } }, shown: [], note: "Shown the not-found card with what you searched. Add at most one short sentence." };
    },
  },
};

/** EVERY tool Ask can wire, by name (`save_artifact` is the turn's own: it shows the save form, or saves in Auto). */
export const ASK_TOOLS: Record<string, ToolSpec> = {
  ...READS,
  ...SHOWS,
  ...Object.fromEntries(Object.entries(WRITES).map(([n, w]) => [n, { ...w, kind: "write" as const }])),
  save_artifact: { kind: "show", icon: "read", input: z.object({ title: z.string().trim().min(1).max(200).optional(), kind: z.enum(["markdown", "html"]).optional(), scope: z.enum(["answer", "thread"]).optional(), which: z.enum(["this", "previous"]).optional() }),
    show: async () => { throw new Error("save_artifact is handled by the turn"); } },
};

/** Fast's tools (`index`): the search and list tools, the stored cards, and the person's own attachments. */
export const INDEX_TOOLS = new Set([
  "query", "list_docs", "get_feed", "list_tags", "get_roadmap", "list_tickets", "list_sprints", "get_my_work", "list_people", "get_events",
  "artifact_list", "list_handoffs", "search_prompts", "trov_docs", "read_attachment", "show_items", "show_chart", "show_themes", "show_not_found",
]);

/** Ask-only tools' definitions (the MCP ones come from the generated catalog). */
const ASK_ONLY_DEFS: { name: string; description: string; input_schema: Record<string, unknown> }[] = [
  {
    name: "trov_docs",
    description: "Search Trov's own public docs (how Trov works: setup, connecting agents, concepts, the MCP tools, pricing, the changelog). Use it for questions about Trov itself, never about the team's own work. Returns the best-matching sections as Markdown. Read-only.",
    input_schema: { type: "object", properties: { q: { type: "string", description: "What to look up, in a few words." } }, required: ["q"] },
  },
  {
    name: "read_attachment",
    description: "Read again a file the person attached earlier in THIS thread (each earlier attachment is named in the conversation with its id). A file is sent to you whole only in the turn it was attached; call this when the person asks about it later. Read-only.",
    input_schema: { type: "object", properties: { id: { type: "integer", description: "The attachment's id." } }, required: ["id"] },
  },
  {
    name: "save_artifact",
    description: "When the person asks to save something from this conversation as a doc or artifact: shows a Save form under your answer (title, kind Markdown or HTML page, who can see it). The SERVER writes the artifact from an answer; you never write its content. In Auto mode it is saved as private at once. `scope`: \"answer\" (one answer, the default) or \"thread\" (the whole conversation). `which` (for scope answer): \"previous\" — your earlier answer the person means (\"save that\"), or \"this\" — the answer you are writing now; by default the server saves this answer when it has content of its own, else your most recent earlier answer that has.",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", maxLength: 200 }, kind: { type: "string", enum: ["markdown", "html"] }, scope: { type: "string", enum: ["answer", "thread"] }, which: { type: "string", enum: ["this", "previous"] } },
    },
  },
  {
    name: "publish_doc",
    description: "Offer to publish (promote) a doc's STAGED version, making it live for the organization. A person's step: it becomes a card the person confirms in the thread; it never runs by itself, even in Auto. Pass the doc's slug, and the staged version if you know it (default the newest staged one).",
    input_schema: { type: "object", properties: { slug: { type: "string" }, version: { type: "integer" } }, required: ["slug"] },
  },
  {
    name: "show_items",
    description: `Show item cards for up to ${ASK_REFS_MAX} items the person should see (tickets, PRs, docs, decisions, feed entries, sprints, handoffs, artifacts, people, prompts, the repo), by ref: "ticket:14", "pr:173", "doc:<slug>", "decision:<id>", "feed:<id>", "sprint:<id>", "handoff:<number>", "artifact:<slug>", "person:<handle>", "prompt:<slug>", "repo:<owner/name>". The server reads each item's live title and status. Returns which were shown.`,
    input_schema: { type: "object", properties: { refs: { type: "array", items: { type: "string" }, minItems: 1, maxItems: ASK_REFS_MAX } }, required: ["refs"] },
  },
  {
    name: "show_chart",
    description: "Show one of Trov's fixed charts; the server runs the query and draws it, so never write its numbers yourself. `query`: merged_prs_by_week (optional weeks 1-26, repo), tickets_by_status, ci_failures_by_week (optional weeks, repo), theme_shares, sprint_burndown (needs sprint_id). Returns what was shown and the total.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string", enum: [...ASK_CHART_QUERIES] }, weeks: { type: "integer", minimum: 1, maximum: 26 }, repo: { type: "string" }, sprint_id: { type: "integer" } },
      required: ["query"],
    },
  },
  {
    name: "show_themes",
    description: "Show the \"where the time went, by theme\" strip: each week's share of merged PRs by theme, for the org's main repository (or `repo`) over 8 weeks or a quarter. Returns what was shown.",
    input_schema: { type: "object", properties: { repo: { type: "string" }, range: { type: "string", enum: [...AI_THEME_RANGES] } } },
  },
  {
    name: "show_diagram",
    description: `Show a small diagram of what waits on what: up to ${ASK_DIAGRAM_NODES_MAX} nodes, each { id, label, eyebrow? (a short kind word like "Ticket"), ref? (an item ref, so its live status shows) }, and edges [[from, to], …]. An edge [a, b] means b waits on a. Any graph without a loop is drawn left to right, branches as parallel lanes and the roots (what nothing else waits before) emphasised as the blockers; a loop is shown as a list.`,
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" }, caption: { type: "string" },
        nodes: { type: "array", maxItems: ASK_DIAGRAM_NODES_MAX, items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" }, eyebrow: { type: "string" }, ref: { type: "string" } }, required: ["id", "label"] } },
        edges: { type: "array", items: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 } },
      },
      required: ["title", "nodes"],
    },
  },
  {
    name: "show_not_found",
    description: "When nothing you found answers the question: show the not-found card. `query` is what you looked for (a few words); `tries` are two rephrased questions the person could ask instead, about things Trov keeps. The server adds what you searched, with counts.",
    input_schema: { type: "object", properties: { query: { type: "string" }, tries: { type: "array", items: { type: "string" }, maxItems: 2 } }, required: ["query"] },
  },
];

/** Arguments the MCP connection adds (`repo`, `org`) and the ones Ask fills itself (`session`) — never offered. */
const NOT_OFFERED_ARGS = new Set(["repo", "org", "session"]);

/** An MCP input schema as Ask offers it: without the connection's arguments and the `$schema` key. */
export function askInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _s, properties, required, ...rest } = schema as { $schema?: unknown; properties?: Record<string, unknown>; required?: string[] };
  const props = Object.fromEntries(Object.entries(properties ?? {}).filter(([k]) => !NOT_OFFERED_ARGS.has(k)));
  const req = (required ?? []).filter((k) => !NOT_OFFERED_ARGS.has(k));
  return { ...rest, type: "object", properties: props, ...(req.length ? { required: req } : {}) };
}

export interface OfferedTool { name: string; description: string; input_schema: Record<string, unknown> }

/**
 * The tools offered to THIS person in THIS mode, in a stable order (the cache prefix): the MCP catalog in its
 * registration order — minus the exclusions, the admin-only ones for a non-admin, and (Fast) everything outside
 * the index — then Ask's own.
 */
export function offeredTools(ctx: TenantContext, mode: AskMode): OfferedTool[] {
  const admin = hasRole(ctx, "admin");
  const index = askMode(mode).tools === "index";
  const ok = (name: string) => !index || INDEX_TOOLS.has(name);
  const mcp = MCP_TOOLS
    .filter((t) => !(t.name in ASK_EXCLUDED_TOOLS) && (admin || !t.admin) && t.name in ASK_TOOLS && ok(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: askInputSchema(t.inputSchema) }));
  return [...mcp, ...ASK_ONLY_DEFS.filter((d) => ok(d.name))];
}

/** One quiet line per step, with its icon. Built from the tool and its arguments; never the result. */
export function activityLabel(tool: string, a: Record<string, unknown>): string {
  const q = (v: unknown) => (typeof v === "string" ? `'${v.length > 60 ? `${v.slice(0, 59)}…` : v}'` : "");
  const n = (v: unknown) => (typeof v === "number" ? `#${v}` : "");
  const L: Record<string, () => string> = {
    query: () => (a.q ? `Searched ${a.types && (a.types as string[]).length === 1 && (a.types as string[])[0] === "doc" ? "docs" : "Trov"} for ${q(a.q)}` : "Searched Trov"),
    get_doc: () => `Read the doc ${q(a.slug)}`,
    list_docs: () => "Listed docs",
    get_feed: () => (a.since ? `Read the feed since ${typeof a.since === "string" ? shortDay(a.since.slice(0, 10)) : ""}` : "Read the feed"),
    list_tags: () => "Read the tag list",
    get_roadmap: () => "Read the roadmap",
    list_tickets: () => "Searched tickets",
    get_ticket: () => `Read ticket ${n(a.id)}`,
    list_sprints: () => "Looked at the sprints",
    get_sprint: () => "Looked at the sprint",
    get_my_work: () => "Read your work",
    list_people: () => "Read who does what",
    get_events: () => "Checked merged PRs",
    get_repo_dashboard: () => "Checked CI and deploys",
    artifact_get: () => `Read the artifact ${q(a.slug)}`,
    artifact_list: () => "Searched artifacts",
    list_handoffs: () => "Read your handoffs",
    get_handoff: () => `Read handoff ${n(a.id)}`,
    search_prompts: () => (a.q ? `Searched prompts for ${q(a.q)}` : "Listed prompts"),
    get_prompt: () => `Read the prompt ${q(a.slug)}`,
    trov_docs: () => `Looked up ${q(a.q)} in Trov's docs`,
    read_attachment: () => "Read the attachment again",
    show_items: () => "Showed items",
    show_chart: () => "Drew a chart",
    show_themes: () => "Showed where the time went",
    show_diagram: () => "Drew a diagram",
    show_not_found: () => "Checked what was searched",
    save_artifact: () => "Prepared a save form",
  };
  return L[tool]?.() ?? `Prepared ${tool.replace(/_/g, " ")}`;
}

/** A write card's icon, by its kind. */
export const WRITE_ICON: Record<string, AskActivityIcon> = { ticket: "tickets", move: "tickets", handoff: "handoffs", doc_edit: "docs", publish: "review", sprint: "sprint", other: "read" };
