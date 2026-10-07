import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import type { Env } from "./env";
import type { Principal } from "./auth/principal";
import { hasRole, type TenantContext } from "./data/context";
import { appBase, orgSlugOf } from "./tools/org-links";
import { get_doc, list_docs, get_feed, query, list_tickets, get_ticket, list_sprints, get_sprint } from "./tools/reads";
import {
  TicketSeg, TicketAssigneeFilter, TicketCategory,
  TicketCreate, TicketEdit, TicketTransition, TicketCommentAdd, TicketLinkAdd, TicketSprintSet, TicketParentSet,
  TicketAssigneeToggle,
} from "@shared/tickets";
import { TicketError } from "./tools/tickets";
import { PersonError } from "./auth/persons";
import {
  SprintError, create_sprint, set_sprint_active, complete_sprint, add_sprint_resource, delete_sprint,
} from "./tools/sprints";
import { SprintCreate, PlanNarrative, PlanSprintEntry, PLAN_NARRATIVE_MAX } from "@shared/sprints";
import {
  agentCreateTicket, agentEditTicket, agentTransitionTicket, agentAddTicketComment,
  agentAddTicketLink, agentSetTicketSprint, agentSetTicketParent, agentAssignTicket,
} from "./tools/tickets-agent";
import { getMyWork, list_events } from "./tools/mywork";
import { listPeopleForAgents } from "./tools/people";
import { getRepoDashboardForAgent, orgRepoConfig } from "./tools/repo-agent";
import { REPO_RANGES, REPO_TAB_SECTIONS, type RepoTab } from "@shared/repo";
import { ingestFeedEntry, ingestDocProposal, recordBatch } from "./consumer";
import { feedEntryFromMcpArgs } from "./mcp-args";
import { FEED_BRIEF_MAX, IngestPayload, QueryType } from "@shared/contract";
import { ArtifactError } from "./tools/artifacts";
import { PlanLimitError } from "./plans/state";
import {
  agentUploadAsset, agentArtifactUpdate, agentArtifactGet, agentArtifactList, artifactsForTicket, artifactOrigin,
} from "./tools/artifacts-agent";
import {
  ARTIFACT_AREAS, ARTIFACT_KINDS, ARTIFACT_STATUSES, ARTIFACT_SUMMARY_MAX, ARTIFACT_TITLE_MAX, ARTIFACT_VISIBILITIES,
  ArtifactLinkInputSchema,
} from "@shared/artifacts";
import { write_plan, get_plan, type PlanWrite } from "./tools/plan";
import {
  listHandoffs, getHandoff, createHandoff, claimHandoff, expireHandoff, handoffAsTask, HandoffCreateInput, HandoffError,
} from "./tools/handoffs";
import { listPrompts, getPrompt, recordPromptUse, savePrompt, PromptSaveInput, PromptError } from "./tools/prompts";
import { detectVars, fillVars, firstLine, type HandoffView } from "@shared/handoffs";

const asText = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

// Each MCP write tool is a one-item batch with an ephemeral session id, so it
// funnels through the SAME reconciling gate as /ingest — no second write path.
// A fresh uuid never collides in the replay ledger, so each call is reconciled
// on its own merits (vocab/confidence/content-hash dedupe still apply).
const ephemeralLedger = () => ({ sessionId: crypto.randomUUID(), itemIndex: 0 });

async function runTool(fn: () => Promise<unknown>) {
  try {
    return asText(await fn());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A TicketError's CODE is the actionable half for an agent, so it travels with
    // the message: `forbidden` means "outside your lane — a person has to do this",
    // `conflict` means "the shared rule says no" (an illegal move, a nesting break),
    // `bad_request` means "your input is wrong". The cookie routes map the same
    // codes onto HTTP statuses; this is the MCP spelling of it.
    // An ArtifactError travels the same way. Its not_found message IS "not_found", so a
    // missing slug, a private page and a version-0 page all read exactly
    // { error: "not_found", code: "not_found" } — the check is never an existence oracle.
    // A plan refusal (0044_plans, e.g. the org's artifact storage is full) reads `code: "plan_limit"`: no retry helps.
    const code = err instanceof TicketError || err instanceof PersonError || err instanceof SprintError || err instanceof ArtifactError || err instanceof HandoffError || err instanceof PromptError || err instanceof PlanLimitError ? err.code : undefined;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(code ? { error: message, code } : { error: message }) }],
      isError: true as const,
    };
  }
}

/**
 * Build a fully-registered Trov MCP server bound to one (user, org) — the bearer TenantContext
 * (src/data/bearer.ts); the principal is its `userId`. Exported so tests
 * can drive the REAL registered tools (e.g. over an in-memory transport) rather
 * than re-implementing the tool bodies — the same closures production runs.
 *
 * A fresh McpServer per request is required (SDK 1.26+ guards against reuse), so
 * this must NOT be hoisted to global scope.
 */
export function buildTrovMcpServer(env: Env, ctx: TenantContext, opts: { origin?: string; orgSlug?: string | null } = {}): McpServer {
  const principal: Principal = { handle: ctx.userId };
  const server = new McpServer({ name: "trov", version: "1.0.0" });
  // Absolute links in artifact results: PUBLIC_ORIGIN, else the /mcp request's origin.
  // COOKIE_SECRET is only the ROOT of the download-URL key (derived with a purpose label).
  const artifactCtx = {
    tenant: ctx, handle: principal.handle, origin: artifactOrigin(env.PUBLIC_ORIGIN, opts.origin), orgSlug: opts.orgSlug, downloadSecret: env.COOKIE_SECRET,
  };

  server.tool(
    "query",
    "Retrieve assembled context from the team brain (Trov): whole authoritative bodies for the top hits plus ranked pointers to the rest, over docs, decisions, feed, sprints and artifacts (an artifact's id is its slug — open it with artifact_get; its body starts `Status: <draft|published|ratified> · v<n>`). Each result is flagged live / staged_pending / unpromoted / draft — treat anything not 'live' as not-yet-settled. Use this to orient before working an existing area and ALWAYS before proposing a doc change. Read-only and safe to call freely.",
    {
      q: z.string().optional(),
      types: z.array(QueryType).optional(),
      section: z.string().optional(),
      space: z.enum(["technical", "product"]).optional(),
      include_staged: z.boolean().optional(),
      limit: z.number().optional(),
      pointer_limit: z.number().optional(),
    },
    // Agent default include_staged:true — the agent should see staged/unpromoted
    // context (flagged), unlike the human Search which defaults false.
    // The bearer principal is the viewer: a private artifact reaches only its author.
    async (args) => runTool(() => query(ctx, { ...args, q: args.q ?? "", include_staged: args.include_staged ?? true }, principal.handle)),
  );

  server.tool("get_doc", "Get a doc and all its versions by slug.", { slug: z.string() }, async ({ slug }) =>
    runTool(() => get_doc(ctx, slug))
  );

  server.tool("list_docs", "List docs, optionally filtered by section.", { section: z.string().optional() }, async ({ section }) =>
    runTool(() => list_docs(ctx, section))
  );

  server.tool(
    "get_feed",
    "Read the feed with optional author/tags/since/limit filters.",
    { author: z.string().optional(), tags: z.array(z.string()).optional(), since: z.string().optional(), limit: z.number().optional() },
    async (args) => runTool(() => get_feed(ctx, args))
  );

  server.tool(
    "append_feed",
    "Append a feed entry through the vocabulary gate (an out-of-vocab tag routes the entry to needs_triage). `summary` is the one-line title. `brief` is what PEOPLE read in the Feed: 1–2 plain sentences (≤ 280 characters) on the problem solved and who it helps — no file names, PR/issue numbers or jargon. `body` is the full record agents read (what changed, why, evidence, follow-ups). Optional prs/commits/issues record the artifacts (PR urls, commit shas, GitHub issue numbers) this session observed.",
    {
      summary: z.string(),
      brief: z.string().trim().min(1).max(FEED_BRIEF_MAX).optional(),
      body: z.string().optional(),
      tags: z.array(z.string()).optional(),
      prs: z.array(z.string()).optional(),
      commits: z.array(z.string()).optional(),
      issues: z.array(z.number()).optional(),
    },
    async ({ summary, brief, body, tags, prs, commits, issues }) =>
      // Thin adapter: feedEntryFromMcpArgs shapes the args into a FeedEntry
      // (carrying prs/commits/issues), then the gate decides write-vs-triage.
      runTool(() =>
        ingestFeedEntry(
          ctx,
          feedEntryFromMcpArgs({ summary, brief, body, tags, prs, commits, issues }),
          principal.handle,
          ephemeralLedger()
        )
      )
  );

  server.tool(
    "propose_doc_update",
    "Propose a doc version through the reconciling gate. Images: embed only uploaded doc images, as `![what it shows](/img/<sha256>)` — upload each first with upload_asset (destination \"doc\"); a body with a not-yet-uploaded /img ref or any other image source (external URL, data: URI) is REFUSED ({ outcome: \"refused\", reason }), nothing staged. Out-of-vocab section or low confidence on a NEW slug routes to needs_triage; an unchanged body is dropped; otherwise staged non-destructively (current_version untouched) and classified new/edit/rewrite. Pass base_version (the current_version you read) so a stale edit is flagged, space ('technical' for engineering docs or 'product' for product docs; defaults 'technical') to place a new doc, and force to stage an identical body.",
    {
      slug: z.string(),
      section: z.string(),
      title: z.string().optional(),
      body: z.string(),
      change_summary: z.string(),
      confidence: z.enum(["high", "low"]),
      space: z.enum(["technical", "product"]).optional(),
      base_version: z.number().optional(),
      force: z.boolean().optional(),
    },
    async (proposal) => runTool(() => ingestDocProposal(ctx, proposal, principal.handle, ephemeralLedger()))
  );

  server.tool(
    "get_roadmap",
    "Read the roadmap plan: admin narrative + sprints in target-date order with their progress — `progress` is the sprint's TICKETS (done + declined over total), `issues` the cached GitHub issue counts behind it (no live GitHub). Each sprint carries label, summary, phase, dates, due, status, active, urgency, lead and domain.",
    {},
    async () => runTool(() => get_plan(ctx))
  );

  // ── Tickets + sprints: READS, for every principal ──────────────────────────
  //
  // Not admin-gated — every bearer principal gets all four. The write counterpart
  // below is scoped (see the note there); these reads are not, because seeing the
  // org's queue is how an agent orients before it does anything.
  server.tool(
    "list_tickets",
    "Read-only: the org's ticket queue. Tickets are Trov D1 rows the whole org files into (ADR-007, amended): a ticket may LINK to GitHub or Figma work, and may be SOURCED from a GitHub issue, but is never the issue itself. A mirrored ticket has source 'github' and source_ref 'owner/repo#n'; its title/body/assignees were copied at import and are Trov's since, while closing or reopening the issue on GitHub closes or reopens it. Its source link is locked (never removable). Filter with seg ('open' = submitted + in_progress + testing, the default / 'closed' = done + declined / 'all'), assignee ('anyone' default, 'me' = you, the bearer principal, 'unassigned') and category. Newest-updated first; each row carries its assignees, link/sub-ticket counts and sprint label. Reading is unscoped: you see the whole org's queue. WRITING is scoped to your own lane — see create_ticket and transition_ticket.",
    {
      seg: TicketSeg.optional(),
      assignee: TicketAssigneeFilter.optional(),
      category: TicketCategory.optional(),
    },
    // `me` is bound to the authenticated bearer principal, never a client
    // argument — the same rule the cookie route applies to its session.
    async (args) => runTool(() => list_tickets(ctx, { ...args, me: principal.handle })),
  );

  server.tool(
    "get_ticket",
    "Read-only: one whole ticket by id — a ticket's `id` is its NUMBER within your organization (`#12`), here and in every ticket tool's arguments and results (`parent_id`, sub-tickets, `ticket_id`) — body, category, priority, status, requester, assignees, linked work, comments, the full status history, its parent and sub-tickets, its sprint, and `artifacts` ([{slug, title, kind, status, version}] — the artifact pages linked to it that you can see; open one with artifact_get). A ticket is a Trov D1 row that may be sourced from a GitHub issue but is never the issue itself (ADR-007, amended) — `source`, `source_ref` and each link's `locked` say whether it is mirrored and which link is its source. Read this BEFORE any write: its `assignees` tell you whether the ticket is in your lane at all.",
    { id: z.number() },
    async ({ id }) =>
      runTool(async () => {
        const ticket = await get_ticket(ctx, id);
        if (!ticket) throw new Error(`no such ticket: ${id}`);
        return { ...ticket, artifacts: await artifactsForTicket(ctx, id, principal.handle) };
      }),
  );

  server.tool(
    "list_sprints",
    "Read-only: every sprint in roadmap order. Sprints are the roadmap's containers — a sprint holds tickets, and its `progress` is its TICKETS only (closed/total/pct, where closed = done + declined). The GitHub issues behind a sprint are a separate `issues` field, the cached closed/total from its github_ref (null when it has no cache row); no live GitHub at read time. Each carries label, summary, phase, dates (a free-text label), start and due (YYYY-MM-DD or null), status/active, urgency, lead, domain and members (the handles assigned to its tickets). Sprint writes (create_sprint / set_sprint_active / complete_sprint / add_sprint_resource / delete_sprint) are open to every principal; only the bulk plan write update_plan is admin-only.",
    {},
    async () => runTool(() => list_sprints(ctx)),
  );

  server.tool(
    "get_sprint",
    "Read-only: one sprint by id, with its tickets ordered roots-then-sub-tickets and its resources (the sprint's own links merged with its tickets', deduped by url), on top of everything list_sprints returns including the tickets-only `progress` and the separate cached `issues` counts. A sprint is completed by a person (complete_sprint), never inferred from its tickets resolving.",
    { id: z.number() },
    async ({ id }) =>
      runTool(async () => {
        const sprint = await get_sprint(ctx, id);
        if (!sprint) throw new Error(`no such sprint: ${id}`);
        return sprint;
      }),
  );

  // ── Tickets: WRITES, scoped to the bearer's own lane ───────────────────────
  //
  // Every tool below is a thin adapter over src/tools/tickets-agent.ts, which is
  // the ONE place the lane rule is drawn: a ticket write is permitted exactly when
  // the bearer principal is already an assignee of that ticket. Filing (create_ticket)
  // is the one unscoped write. The actor is ALWAYS `principal.handle` — there is no
  // client-supplied writer, exactly as with /ingest's advisory session.author.
  //
  // These are DIRECT AUTHORED WRITES in the promote class, the same class the cookie
  // routes write in: no consume(), no gate, no staging, no proposals. The bearer token
  // IS the person, so inside the lane the parity with the ticket screen is total —
  // `done` and `declined` included. Nothing here INFERS a resolution; a person, through
  // their own token, asks for it.
  //
  // Assignment (assign_ticket, issue #90) is the one write the lane cannot scope — it is
  // how a ticket gets INTO a lane — so it has its own rule in tickets-agent.ts: an admin,
  // the ticket's requester or a current assignee. That reverses the old "web-only,
  // forever" (design D3), which left leads assigning agent-split work by hand.

  /** Every write returns the whole ticket, exactly like the cookie routes do. */
  const ticketDetail = async (id: number) => {
    const ticket = await get_ticket(ctx, id);
    if (!ticket) throw new TicketError("not_found", `no such ticket: ${id}`);
    return ticket;
  };

  server.tool(
    "create_ticket",
    "File a ticket. THE ONE UNSCOPED WRITE — you may file freely; every other ticket write requires the ticket to be assigned to you already. The requester is YOU (the bearer principal); a client-supplied requester is ignored. `assignees` (person handles) — call `list_people` first and match the work to each person's role and responsibilities. After filing, assign_ticket adds or removes one assignee (as the ticket's requester you may, so you can route it later). Optional `link` takes a bare issue number ('#214'), a GitHub/Figma URL, or any URL. `sprint_id` omitted = the backlog. Returns the whole ticket. Confirm the exact fields with the person before calling — a ticket is org-visible the moment it exists.",
    TicketCreate.shape,
    async (input) => runTool(async () => ticketDetail(await agentCreateTicket(ctx, TicketCreate.parse(input), principal.handle))),
  );

  server.tool(
    "edit_ticket",
    "Edit a ticket's title and/or body (markdown). SCOPED: only on a ticket already assigned to you, else `forbidden` and nothing is written. Pass at least one of `title` / `body`; the other is left as it is. A ticket mirrored from a GitHub issue is editable too — its title and body were copied from the issue when it was imported and are Trov's from then on (GitHub edits never overwrite them). Records no history row (history is status moves). Returns the whole ticket.",
    { id: z.number(), ...TicketEdit.shape },
    async ({ id, title, body }) => runTool(async () => {
      await agentEditTicket(ctx, env, id, { title, body }, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "transition_ticket",
    "Move a ticket's status. SCOPED: only on a ticket already assigned to you, else `forbidden` and nothing is written. Any status may move to any other — done and declined included, so a resolved ticket can be moved back (only a move to the status it already has is `conflict`, and writes nothing). `done`/`declined` resolve the ticket for the whole org, so confirm with the person first. Appends a ticket_events row attributed to you.",
    { id: z.number(), ...TicketTransition.shape },
    async ({ id, to }) => runTool(async () => {
      await agentTransitionTicket(ctx, env, id, to, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "add_ticket_comment",
    "Append a comment to a ticket. SCOPED: only on a ticket already assigned to you. Raw text — mentions are a rendering concern, not a write one. Bumps the ticket's updated_at (the queue's sort key), and is attributed to you with nothing marking it as agent-written, so say so in the text if the team wants that.",
    { id: z.number(), ...TicketCommentAdd.shape },
    async ({ id, body }) => runTool(async () => {
      await agentAddTicketComment(ctx, env, id, body, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "add_ticket_link",
    "Attach linked work to a ticket (GitHub issue/PR, Figma file, or any URL). SCOPED: only on a ticket already assigned to you. `raw` is parsed by the same parser the web UI uses: a bare '#214' or '214' resolves against the org's primary repository, github.com and figma.com URLs are labelled by kind, anything else is a plain link. An unusable input is `bad_request`.",
    { id: z.number(), ...TicketLinkAdd.shape },
    async ({ id, raw }) => runTool(async () => {
      await agentAddTicketLink(ctx, env, id, raw, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "set_ticket_sprint",
    "Move a ticket into a sprint, or back to the backlog with sprint_id null. SCOPED to a ticket assigned to you — with ONE exception: an ADMIN may re-home any ticket, because composing a sprint is sprint management. This is the only ticket verb an admin may use outside their own lane; it moves the ticket and nothing else. An unknown sprint is `not_found`, and nothing is written.",
    { id: z.number(), ...TicketSprintSet.shape },
    async ({ id, sprint_id }) => runTool(async () => {
      await agentSetTicketSprint(ctx, env, id, sprint_id, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "set_ticket_parent",
    "Nest `child_id` under ticket `id`. SCOPED on BOTH tickets — the call re-homes the child and changes the parent's shape, so both must already be assigned to you. Tickets nest EXACTLY ONE level: it is a `conflict` (writing nothing) if the parent already has a parent, the child already has a parent, the child is done/declined, or the child has sub-tickets of its own.",
    { id: z.number(), ...TicketParentSet.shape },
    async ({ id, child_id }) => runTool(async () => {
      await agentSetTicketParent(ctx, env, id, child_id, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "assign_ticket",
    "Add (`on: true`) or remove (`on: false`) ONE assignee on an existing ticket. `login` is a person HANDLE — take it from `list_people`, matching the work to each person's role and responsibilities; an unknown handle is `bad_request`. SCOPED by its own rule, not the lane: only an ADMIN, the ticket's REQUESTER or one of its CURRENT assignees may (re)assign it, else `forbidden` and nothing is written. Idempotent: adding someone already assigned, or removing someone who isn't, succeeds and writes nothing. It never changes status (assigning a submitted ticket does not start it — use transition_ticket), and records no history row — history is status moves, so nothing records who (un)assigned, exactly as with the web UI's picker. Works on a ticket mirrored from a GitHub issue — its assignees are Trov's after import. Removing yourself takes the ticket out of your lane. Returns the whole ticket; read `assignees` back. Confirm who with the person before calling.",
    { id: z.number(), ...TicketAssigneeToggle.shape },
    async ({ id, login, on }) => runTool(async () => {
      await agentAssignTicket(ctx, env, id, login, on, principal.handle);
      return ticketDetail(id);
    }),
  );

  server.tool(
    "get_my_work",
    "Your personal My Work projection (D1 only, no live GitHub): previous-activity (your most recent summarized merged/closed PRs), to-do (your open assigned GitHub issues), and tickets (your open assigned tickets, native AND mirrored from GitHub issues — `source: \"github\"` marks a mirrored one, whose issue may also be in to-do; capped, with `ticketsTotal` the full count). Read-only.",
    {},
    async () => runTool(() => getMyWork(ctx, principal.handle))
  );

  // ── People: ONE read, for every principal (0036) ─────────────────────────────
  //
  // An agent reads who does what — handle, name, role, responsibilities — and nothing
  // else about a person: no profile, no avatar, no load. Profiles are written only by
  // the person or an admin, over session-cookie routes; there is NO people write here.
  server.tool(
    "list_people",
    "Read-only: every person in the org as { handle, name, role, responsibilities }. Call this BEFORE choosing `assignees` on create_ticket: match the work to each person's `role` and `responsibilities` and use their `handle`. `role` / `responsibilities` may be null — that means unknown, never guess what someone owns from their name or handle; if nobody clearly fits, file the ticket unassigned (or ask the person you are working for) rather than pick someone. Returns { people }.",
    {},
    async () => runTool(async () => ({ people: await listPeopleForAgents(ctx) })),
  );

  server.tool(
    "get_events",
    "Recent captured GitHub events (raw log behind My Work and roadmap progress). Filter by type/subject. Read-only.",
    { type: z.enum(["pr_merged", "pr_closed", "issue"]).optional(), subject: z.string().optional(), limit: z.number().optional() },
    async (args) => runTool(() => list_events(ctx, args))
  );

  // ── The Repo dashboard: a READ, for every principal ────────────────────────
  //
  // Not admin-gated, like the ticket/sprint reads: it exposes nothing a signed-in
  // member cannot already see at #repo, and nothing per-user. It is the SAME
  // projection GET /repo/dashboard serves (getRepoDashboard — D1 only, nothing on
  // that path fetches), reshaped for an agent's context in tools/repo-agent.ts.
  // READ-ONLY: "Poll now" (POST /admin/poll; the older POST /admin/poll-usage) and Sync GitHub
  // (POST /admin/backfill) stay session-cookie + admin routes, NEVER MCP tools.
  server.tool(
    "get_repo_dashboard",
    "The Repo dashboard for the org's main repository: environments and deploys, CI, code activity, usage (requests, errors, hosting, active users), each hosting provider part's deploys / traffic / resources (`providers`: one entry per part of each environment — Vercel, Render, Netlify, Fly.io, and the Cloudflare frontend / Railway backend — with its `status`, `tone`, `last_poll` and the metrics the provider cannot read in `unavailable`), the app's product metrics, and planning — read from Trov's own database, never live GitHub or a live provider. Every section is `ok`, `empty` (connected, nothing to show) or `not_connected` (never captured): treat anything not `ok` as unknown, never as zero. The same holds INSIDE an `ok` section: a `null` figure (`usage[].requests` / `errorRate` / `users`, a `providers[].traffic` figure or `resources.cpu` / `mem_mb`, a `product` value, `contributors[].reviews`, `ciFailures.rate`, `prs.openCount` (open PRs not captured yet), a `null` or empty delta, a `null` sha or checks) is unknown / not captured — never zero — and `usage[].seen` / `providers[].seen` say whether that source has EVER reported (`null` + not seen = not connected; `null` + seen = no recent reading). Optional `tab` (overview | code | ci | usage | planning) returns only the sections that tab shows; `range` (24h | 7d | 30d, default 7d) picks the one view the usage / cloudflare / product sections and each provider part's `traffic` return; `include_trends` (default false) adds the sparkline `trend` arrays, the full drift breakdown and every provider deploy — without it `drift.groups` is the first 20 groups, each with a `commitCount` instead of its commits, and `drift.groupCount` is the full number, and each `providers[]` entry lists its newest 2 deploys with `deployCount` the full number; with `include_trends: true` every group is returned with its commits, and every part with all its deploys (up to 10). Leave it off unless you need the series. Returns { repo, generatedAt, degraded, tab, range, sections }; `degraded: true` means a database read failed and the sections fell back. Read-only and safe to call freely.",
    {
      tab: z.enum(Object.keys(REPO_TAB_SECTIONS) as [RepoTab, ...RepoTab[]]).optional(),
      range: z.enum(REPO_RANGES).optional(),
      include_trends: z.boolean().optional(),
    },
    // Which repository and which environments is the ORG's configuration (`org_repos` /
    // `org_environments`), never the Worker's `GITHUB_REPO` / `REPO_ENVIRONMENTS`: a token bound to
    // another org must not be told org #1's repository name or environment list.
    async ({ tab, range, include_trends }) =>
      runTool(async () => {
        const { repo, envs } = await orgRepoConfig(ctx);
        return getRepoDashboardForAgent(ctx, repo, envs, { tab, range, includeTrends: include_trends });
      }),
  );

  server.tool(
    "record_session",
    "Record a whole Claude Code session into Trov in ONE reconciled batch: pass a full IngestPayload (session + feed_entries / doc_proposals / adr_drafts / needs_triage, and optional artifact_links). A doc proposal may embed only uploaded doc images (`![alt](/img/<sha256>)`, uploaded with upload_asset destination \"doc\" BEFORE this call); one that breaks that rule is listed under `refused` with its reason and is not ledgered, so re-sending the same batch after uploading stages it. Routes through the SAME gate as /ingest — drops no-ops, stages real deltas, classifies each doc change, and is replay-safe on session.id. The author is your authenticated bearer principal; session.author is advisory and ignored. Returns per-type outcome counts. `artifact_links` ([{slug, target_type: ticket|sprint|pr|issue, target_ref}], for artifacts this session produced) are NOT staged: after the batch is reconciled each is linked directly, as you, and reported in `artifact_links` as linked / not_found / error (idempotent — a replay re-links nothing). Used by the record-session skill at session end; you only ever stage knowledge — humans confirm.",
    IngestPayload.shape,
    // Same reconciling path as the cookie /ingest route: forward the full payload to
    // consume() under the bearer principal already in scope. Re-parse with the contract
    // so defaults (empty arrays) are applied and the type is exactly IngestPayload —
    // the SDK already validated against IngestPayload.shape, so this never throws.
    // recordBatch = consume() (the gate) + the post-batch artifact_links step — the same
    // function /ingest calls, so the two surfaces cannot drift.
    async (payload) => runTool(() => recordBatch(ctx, IngestPayload.parse(payload), principal)),
  );

  // ── Artifacts: for every principal (issue #52; docs/artifact-contract.md) ─────
  //
  // Thin adapters over src/tools/artifacts-agent.ts, which calls the artifacts
  // repository with the BEARER principal as author and viewer — the same permission
  // checks as the HTTP API: whoever can read a page can version it; a private page is
  // its author's alone; missing / private / version-0 are ONE not_found. Direct
  // authored writes in the promote class, like tickets: no gate, nothing staged.
  // There is deliberately NO ratify tool — ratifying is a person's act on the web
  // (a session-cookie route), exactly like promoting a doc or ratifying an ADR.

  const artifactPageShape = {
    title: z.string().min(1).max(ARTIFACT_TITLE_MAX),
    kind: z.enum(ARTIFACT_KINDS),
    area: z.enum(ARTIFACT_AREAS),
    repo: z.string(),
    visibility: z.enum(ARTIFACT_VISIBILITIES),
  };
  const binaryShape = {
    // No .max: over the cap is the repository's too_large, not an input-validation error (Track E).
    size_bytes: z.number().int().min(1).optional(),
    sha256: z.string().optional(),
    content_type: z.string().max(255).optional(),
    filename: z.string().max(255).optional(),
  };

  server.tool(
    "upload_asset",
    "Put something into Trov: an ARTIFACT page, or an IMAGE for a doc. `destination` picks which (default \"artifact\").\n\n" +
      "destination \"doc\" — an image a doc embeds. Pass `sha256` (hex, `shasum -a 256 img.png`), `size_bytes` and `content_type` (image/png | image/jpeg | image/gif | image/webp; ≤ 10 MB); `kind` may be omitted (it is always image) and page fields (title, area, …) are refused. → { destination, ref: \"/img/<sha256>\", markdown, sha256, uploaded }. uploaded: true = that exact image is already stored, nothing to PUT. Otherwise also { upload_url, expires_at }: PUT the exact bytes (single use, 5 minutes, e.g. `curl -X PUT --data-binary @img.png -H \"Content-Type: image/png\" \"<upload_url>\"`). THEN reference it in the doc body as `![what it shows](/img/<sha256>)` and propose the doc (propose_doc_update / record_session). The doc gate REFUSES a body whose image is not uploaded yet, and any other image source (an external URL, a data: URI) — upload first, then propose. Images are immutable: a new picture is a new sha256.\n\n" +
      "destination \"artifact\" (default) — create an artifact page (v1, status draft): a rendered HTML page, markdown doc, SVG, mermaid diagram, image, PDF or file the team keeps and versions. Needs `title`, `kind`, `area`, `repo`, `visibility`. Text kinds (html | markdown | svg | mermaid; ≤ 750 KB): pass `content` → { id, slug, url, version }. Binary kinds (image | pdf | file; ≤ 10 MB): pass `size_bytes` and `sha256`, NOT content → { id, slug, url, upload_url, expires_at }; then PUT the exact bytes to upload_url (single use, 5 minutes) — the page does not exist to anyone until that PUT lands. `area` is one of auth | architecture | infra | api | ui | data; `repo` is owner/repo or \"\"; `visibility` org (the whole org) or private (only you). Optional `links` ([{target_type: ticket|sprint|pr|issue, target_ref}]) and `summary`. You author it; a PERSON ratifies it on the web — there is no ratify tool. Contract: docs/artifact-contract.md.\n\n" +
      "Every result has `warnings` — non-empty when artifact content calls something only claude.ai has (window.claude, window.storage, api.anthropic.com); the page is still created.",
    {
      destination: z.enum(["artifact", "doc"]).optional(),
      title: artifactPageShape.title.optional(),
      kind: artifactPageShape.kind.optional(),
      area: artifactPageShape.area.optional(),
      repo: artifactPageShape.repo.optional(),
      visibility: artifactPageShape.visibility.optional(),
      content: z.string().optional(),
      links: z.array(ArtifactLinkInputSchema).max(50).optional(),
      summary: z.string().max(ARTIFACT_SUMMARY_MAX).optional(),
      ...binaryShape,
    },
    async (input) => runTool(() => agentUploadAsset(artifactCtx, input)),
  );

  server.tool(
    "artifact_update",
    "Add a version to an artifact you can see (any org page, or your own private one). A new version is `published` and clears any ratification. Text kinds: pass `content` (the whole new body) OR `old_str` + `new_str` (an exact edit of the latest version — old_str must occur EXACTLY once) → { id, slug, url, version, unchanged } (unchanged: true = identical to the latest, nothing written). Binary kinds: pass `size_bytes` + `sha256` (+ optional content_type / filename) → { id, slug, url, upload_url, expires_at }, then PUT the bytes (single use, 5 minutes). `summary` says what changed. Every result has `warnings` (claude.ai-only calls in the content — a warning, never a rejection). An unknown or private-to-someone-else slug is { error: \"not_found\", code: \"not_found\" }.",
    {
      slug: z.string().min(1),
      summary: z.string().max(ARTIFACT_SUMMARY_MAX),
      content: z.string().optional(),
      old_str: z.string().optional(),
      new_str: z.string().optional(),
      ...binaryShape,
    },
    async (input) => runTool(() => agentArtifactUpdate(artifactCtx, input)),
  );

  server.tool(
    "artifact_get",
    "Read one artifact: metadata (title, kind, area, repo, author, status draft | published | ratified, visibility, versions, links, ratified_version) plus, for text kinds, `content` of the requested version (binary kinds: `content` is null). A text version over 64 KB is NOT inlined: `content` is null and `content_omitted` is true — pull it with `download_url` and grep / read the slices you need, or pass `include_content: true` only when you genuinely need the whole text in context (`content_omitted` is false on every other result). To get the FILE — any kind, binary included — use `download_url`: absolute, signed for you, reusable for 5 minutes (`download_expires_at`), no header needed: `curl -fsSL \"$download_url\" -o <path>` returns the exact stored bytes as an attachment named `download_filename`. Verify it against `sha256` / `size_bytes` (this version's; `shasum -a 256 <path>`). Expired → HTTP 410: call artifact_get again. `raw_url` is the browser view (signed-in session only — it does not take your bearer). `slug` may name a version (`slug@v3` or `slug/v3`), or pass `version`; default the latest. `url` is the page in the Trov web app — share that when a person just wants the link. `warnings` flags claude.ai-only calls in the content. Only `ratified` is team-confirmed; draft / published are one person's word. An unknown, private-to-someone-else or not-yet-uploaded slug is { error: \"not_found\", code: \"not_found\" }.",
    { slug: z.string().min(1), version: z.number().int().min(1).optional(), include_content: z.boolean().optional() },
    async (input) => runTool(() => agentArtifactGet(artifactCtx, input)),
  );

  server.tool(
    "artifact_list",
    "Read-only: the artifact pages you can see (every org page, plus your own private ones), newest first — the same filters as the web library. All optional: `q` (full text over title / summary / body, or a title / slug substring), `kind` (html | markdown | svg | mermaid | image | pdf | file), `area` (auth | architecture | infra | api | ui | data), `author` (a handle), `status` (draft | published | ratified), `ticket` / `sprint` (an id — pages linked to it), `limit` (default 25, max 100). → { artifacts: [{ slug, title, kind, status, version, updated_at, url, area, author, visibility }], total, truncated }. Open one with artifact_get (its `download_url` fetches the file). Only `ratified` is team-confirmed.",
    {
      q: z.string().max(200).optional(),
      kind: z.enum(ARTIFACT_KINDS).optional(),
      area: z.enum(ARTIFACT_AREAS).optional(),
      author: z.string().max(80).optional(),
      status: z.enum(ARTIFACT_STATUSES).optional(),
      ticket: z.union([z.number().int().min(1), z.string().max(20)]).optional(),
      sprint: z.union([z.number().int().min(1), z.string().max(20)]).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async (input) => runTool(() => agentArtifactList(artifactCtx, input)),
  );

  // ── Sprints: WRITES, open to every principal ─────────────────────────────
  //
  // Thin adapters over the same writers the Roadmap's cookie routes call —
  // direct promote-class writes, never the ingestion gate, nothing staged.
  // Registered for EVERY principal, matching the web, where every sprint route
  // sits under the blanket sessionGate with no adminGate. Only the whole-plan
  // rewrite (update_plan, below) stays admin-only.
  //
  // Inputs speak the DTO vocabulary (`label` / `due` / `active`), never the column
  // names (`title` / `target_date` / `status`) — only src/tools/ speaks columns.

  server.tool(
    "create_sprint",
    "Create a sprint. It lands INACTIVE and unscheduled — status 'upcoming', phase 'Unscheduled' unless you pass one, and no `due` stores an empty target date that reads back as due: null (those sort last on the Roadmap). `start` and `due` are real calendar days written YYYY-MM-DD, start on or before due — anything else (\"Oct 17\", 2026-02-30) is refused and nothing is written. `dates` is only an optional free-text display label. `label` is the sprint name; `lead` is a person handle. Which TICKETS are in the sprint is not set here — that is set_ticket_sprint. Direct promote-class write, not staged.",
    SprintCreate.shape,
    async (input) => runTool(() => create_sprint(ctx, SprintCreate.parse(input), principal.handle)),
  );

  server.tool(
    "set_sprint_active",
    "Move a sprint between the Roadmap's In Progress and Upcoming groups. `active` is DERIVED from status, never stored: true → 'in_progress' (from ANY status, including 'done' — that is re-opening a sprint that turned out not to be finished); false → 'upcoming', EXCEPT on a done sprint where it is a NO-OP, because clearing 'active' must never un-finish a sprint.",
    { id: z.number(), active: z.boolean() },
    async ({ id, active }) => runTool(() => set_sprint_active(ctx, id, active)),
  );

  server.tool(
    "complete_sprint",
    "Flip a sprint to 'done'. A sprint is completed by a PERSON — 'done' is NEVER inferred from its tickets resolving or its GitHub issues closing, not by the cron, not by the webhook, not by this tool being available. Confirm with the person before calling: it is how the Roadmap reports the sprint finished. Already-done is an error, not a silent no-op.",
    { id: z.number() },
    async ({ id }) => runTool(() => complete_sprint(ctx, id)),
  );

  server.tool(
    "delete_sprint",
    "Delete a sprint for good (hard delete). Its tickets are NOT deleted — they move to the backlog (no sprint) and keep all their history; the sprint's own resources go with it. Answers with the label and how many tickets moved. Confirm with the person before calling: the Roadmap loses the sprint and it cannot be undone.",
    { id: z.number() },
    async ({ id }) => runTool(() => delete_sprint(ctx, id)),
  );

  server.tool(
    "add_sprint_resource",
    "Attach a resource link to the sprint itself (as opposed to one of its tickets). `raw` goes through the SAME parser as ticket links, so '#214' means the same thing wherever it is typed. Idempotent on url. The sprint's read model merges these with its tickets' links, deduped by url.",
    { id: z.number(), raw: z.string().min(1) },
    async ({ id, raw }) => runTool(() => add_sprint_resource(ctx, id, raw)),
  );

  // ── Handoffs (0028): addressed messages between sessions ──────────────────
  //
  // Direct writers in src/tools/handoffs.ts, NOT the ingestion gate — a handoff is
  // not knowledge. The bearer principal is the sender / claimer, never an input.
  // `session` on send_handoff is the replay key (processed_items, item index 0),
  // so a retried call returns the first call's handoff instead of a second row.
  // A link into the TOKEN'S org (src/tools/org-links.ts): `<origin>/o/<slug>/#handoffs/<number>`.
  const handoffUrl = (id: number) => `${appBase(artifactOrigin(env.PUBLIC_ORIGIN, opts.origin), opts.orgSlug)}/#handoffs/${id}`;
  const handoffLine = (h: HandoffView) => ({
    id: h.id, sender: h.sender, recipient: h.recipient, status: h.status, created_at: h.created_at,
    task: h.context.task, excerpt: firstLine(h.body),
  });

  server.tool(
    "send_handoff",
    "Leave a handoff for the next session: where a task stands when you stop mid-way (context running out, switching person, ending the session). Send exactly ONE per session and tell the person its id as #N. `recipient` is a person handle, or omit it for 'anyone' (the first session to claim it gets it). Keep `body` under 300 words — its first line is the title, the rest says where things stand. ALWAYS fill `context` with the fixed shape { repo, branch, task, done[], next[], files[] }: repo from the git remote (owner/name), branch from HEAD, task as one line, done/next as short items, files from `git diff --name-only` against main. Long step-by-step instructions for the claiming session go in `prompt.body` (with a `prompt.title`), not in body. Pass your session id as `session` so a retry does not send twice. Returns { id, url }.",
    {
      body: z.string().min(1),
      recipient: z.string().optional(),
      context: z.object({
        repo: z.string().optional(), branch: z.string().optional(), task: z.string().optional(),
        done: z.array(z.string()).optional(), next: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
      }).optional(),
      prompt: z.object({ title: z.string(), body: z.string() }).optional(),
      session: z.string().optional(),
    },
    async (args) => runTool(async () => {
      const input = HandoffCreateInput.parse({ body: args.body, recipient: args.recipient, context: args.context, prompt: args.prompt ?? null });
      const ledger = args.session ? { sessionId: args.session, itemIndex: 0 } : undefined;
      const { handoff, replayed } = await createHandoff(ctx, principal.handle, input, ledger);
      return { id: handoff.id, url: handoffUrl(handoff.id), ...(replayed ? { replayed: true } : {}) };
    }),
  );

  server.tool(
    "list_handoffs",
    "List handoffs waiting for you. With no `box`, returns the PENDING ones left for you ('me') plus open 'anyone' handoffs from other people — call this at session start and tell the person what is waiting; never claim one without asking. box: 'me' (left for you), 'anyone' (open to all, from others), 'mine' (sent by or left for you), 'sent' (what you sent — the only box that includes claimed and expired ones). Returns id, sender, recipient, status, created_at, task and a one-line excerpt. Read-only.",
    { box: z.enum(["mine", "me", "anyone", "sent"]).optional() },
    async ({ box }) => runTool(async () => {
      if (box === "sent") return (await listHandoffs(ctx, principal.handle, "sent")).map(handoffLine);
      if (box) return (await listHandoffs(ctx, principal.handle, box, ["pending"])).map(handoffLine);
      const [me, anyone] = await Promise.all([
        listHandoffs(ctx, principal.handle, "me", ["pending"]),
        listHandoffs(ctx, principal.handle, "anyone", ["pending"]),
      ]);
      return [...me, ...anyone].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map(handoffLine);
    }),
  );

  server.tool(
    "get_handoff",
    "Read one handoff in full by its numeric id — its number within your organization, as send_handoff and list_handoffs return it (body, context, inline prompt, status). Read-only: it does NOT claim it — use claim_handoff once the person has chosen to pick it up.",
    { id: z.number().int() },
    async ({ id }) => runTool(async () => {
      const h = await getHandoff(ctx, id);
      if (!h) throw new HandoffError("not_found", "handoff not found");
      return h;
    }),
  );

  server.tool(
    "claim_handoff",
    "Claim a pending handoff for this session — only after the person chose it. Atomic: if another session already took it you get an error naming its current status (tell the person someone else has it). Pass your session id as `session`. On success returns ONE markdown block to act on: the handoff's prompt (if any), then '## Handoff summary', then '## Context' (repo, branch, task, done, next, files). Treat it as your task and confirm the current git branch matches the context before touching code.",
    { id: z.number().int(), session: z.string().min(1) },
    async ({ id, session }) => {
      try {
        const h = await claimHandoff(ctx, id, principal.handle, session);
        return { content: [{ type: "text" as const, text: `# Handoff #${h.id} — claimed\n\n${handoffAsTask(h)}` }] };
      } catch (err) {
        if (err instanceof HandoffError) {
          const current = await getHandoff(ctx, id);
          const body = { error: err.message, code: err.code, ...(current ? { status: current.status, claimed_by: current.claimed_by } : {}) };
          return { content: [{ type: "text" as const, text: JSON.stringify(body) }], isError: true as const };
        }
        return runTool(async () => { throw err; });
      }
    },
  );

  server.tool(
    "expire_handoff",
    "Expire a PENDING handoff you sent or that was left for you, so nobody picks it up (the work was finished another way, or it no longer applies). Pending handoffs also expire on their own 7 days after they were sent. A claimed or already-expired handoff is an error naming its status.",
    { id: z.number().int() },
    async ({ id }) => runTool(() => expireHandoff(ctx, id, principal.handle)),
  );

  // ── Prompt Library (0028) ──────────────────────────────────────────────────
  server.tool(
    "search_prompts",
    "Search the team's Prompt Library for a reusable prompt. `q` is full-text over slug, title, description, body and tags; `tags` must ALL match. Returns summaries (slug, title, tags, author, version, status, updated_at, excerpt) — prefer 'published' ones; 'staged' and 'draft' are not settled yet. Use get_prompt to read one. Read-only.",
    { q: z.string().optional(), tags: z.array(z.string()).optional() },
    async ({ q, tags }) => runTool(() => listPrompts(ctx, { q, tags })),
  );

  server.tool(
    "get_prompt",
    "Read a library prompt by slug, with its {{variables}} filled from `vars`. The response lists `variables` (every one the prompt uses) and `unfilled` (the ones still left as {{placeholders}}) — ASK the person for any unfilled value instead of guessing it. Each call counts as one USE of the prompt (`use_count` / `last_used_at`, which the library's most-used sort reads); it changes nothing else.",
    { slug: z.string(), vars: z.record(z.string(), z.string()).optional() },
    async ({ slug, vars }) => runTool(async () => {
      // One conditional UPDATE: counts this call once, and writes nothing for an unknown slug.
      await recordPromptUse(ctx, slug);
      const p = await getPrompt(ctx, slug);
      if (!p) throw new PromptError("not_found", "prompt not found");
      const variables = detectVars(p.body);
      const values = vars ?? {};
      return { ...p, body: fillVars(p.body, values), variables, unfilled: variables.filter((v) => !values[v]?.trim()) };
    }),
  );

  server.tool(
    "save_prompt",
    "Stage a prompt in the team's Prompt Library — a new slug creates v1, an existing slug appends the next version. ALWAYS lands as 'staged' (whatever you intend): a human must publish it in Trov before it is settled, and you cannot rename a slug. Only save instructions you have had to write out twice; the slug is 2–60 chars of a-z, 0-9 and '-'. Write {{name}} for anything the caller fills in. Pass `branch` (your git branch) for the default version note. Returns { slug, version, status }.",
    {
      slug: z.string(), title: z.string(), body: z.string(),
      tags: z.array(z.string()).optional(), summary: z.string().optional(), branch: z.string().optional(),
    },
    async ({ slug, title, body, tags, summary, branch }) => runTool(async () => {
      const p = await savePrompt(ctx, principal.handle, PromptSaveInput.parse({ slug, title, body, tags, summary }), "agent", { branch });
      return { slug: p.slug, version: p.version, status: p.status };
    }),
  );

  // ADMIN-only: the plan write surface — non-admin principals don't even see the tool
  // (conditional registration means it's absent from tools/list and calling it by
  // name errors tool-not-found, since a fresh server is built per request with the
  // context already in scope). "Admin" is the bearer's role IN THE TOKEN'S ORG today (§7.2) —
  // admin or owner there; a role change shows on the very next request.
  if (hasRole(ctx, "admin")) {
    server.tool(
      "update_plan",
      `ADMIN plan write: replace the roadmap narrative and create/update sprints (including status 'done') in one direct, non-destructively versioned write — same authored-write class as promote, NOT the ingestion gate. Sprints not listed are untouched. \`label\` is the sprint name, \`start\` its start date and \`due\` its target date — each a real calendar day written YYYY-MM-DD (\`due\` may be "" for unscheduled; \`start\` omitted keeps the stored one, null clears it), start on or before due, else the whole call is refused and nothing is written. \`dates\` is only a free-text display label. Which tickets are IN a sprint is set from the Tickets UI, not here. The narrative is SHORT — 2–3 sentences up to two short paragraphs (Now / Next / Later), at most ${PLAN_NARRATIVE_MAX} characters after trimming; leave out sprint-by-sprint detail, issue lists, dated status logs and ops steps (the sprints and the timeline carry those). Over the cap the whole call is refused and nothing is written — plan, versions and sprints alike. The narrative is always a full replacement, so an over-cap narrative already stored must be shortened, not resent. Use via the update-plan skill.`,
      {
        narrative: PlanNarrative.describe(
          `The whole roadmap narrative (markdown), replacing the current one. SHORT: 2–3 sentences to two short paragraphs — what is happening now, next, later — at most ${PLAN_NARRATIVE_MAX} characters after trimming. No sprint-by-sprint detail; the sprints and the timeline carry it.`
        ),
        // One entry per sprint (shared/sprints.ts `PlanSprintEntry`): `due` and `start`
        // are real YYYY-MM-DD days (or "" / null), start <= due — the ONE sprint-date rule.
        sprints: z.array(PlanSprintEntry).default([]),
      },
      async (input) => runTool(() => write_plan(ctx, input as PlanWrite, principal.handle))
    );
  }

  return server;
}

export async function handleMcp(request: Request, env: Env, exec: ExecutionContext, ctx: TenantContext): Promise<Response> {
  // The org's slug, for the links tool results carry (`<origin>/o/<slug>/#…`): the org on the token's own row.
  const server = buildTrovMcpServer(env, ctx, { origin: new URL(request.url).origin, orgSlug: await orgSlugOf(ctx) });
  // createMcpHandler wraps @modelcontextprotocol/sdk over Streamable HTTP, stateless (no McpAgent/DO).
  const handler = createMcpHandler(server, { route: "/mcp" });
  return handler(request, env, exec);
}
