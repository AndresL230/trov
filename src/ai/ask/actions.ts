// Ask Trov's WRITES (docs/architecture/ask.md › Write cards; #12 §2.12). A write tool never runs when the model
// calls it: the turn stores a `chat_actions` row and streams a card whose preview the SERVER builds here from
// Trov's rows. Confirm (a cookie route) runs it AS the person through the SAME lane-scoped writers MCP uses
// (src/tools/tickets-agent.ts and the rest) — so Ask can never do what the person's own MCP connection could not.
//
//   • Editable before Confirm: a card edits only the fields its tool's input takes (`editable`); `confirm { args }`
//     applies them, re-validates against the input schema and rebuilds the preview.
//   • Auto mode runs a write at once (state `auto`), at most ASK_AUTO_WRITES_MAX per answer; past it, and for a
//     Confirm-only write (`update_plan`, completing a sprint, publishing a doc, every agent-link card), the card
//     WAITS (`waiting`).
//   • Agent links (0078): the thread is a side, its session `ask-thread-<thread id>` (`askThreadSession`). Every link
//     card runs as the CONFIRMER — the cookie person who presses Confirm — never whoever made the card or the thread.
//     Confirming `request_link` is the Send step (`requestLinkFromAsk`: requested, or open for a link with oneself);
//     there is no draft. A note goes to someone else's agent, so a person always clicks: never Auto.
//   • Undo writes back what was there — but first checks that nobody changed the item since (`changed`).
//   • Publishing a staged doc is a human step drawn in the thread: Confirm calls the web promote path as the
//     person, only when they may promote; it never runs in Auto and does not count toward the cap.
// Feed entries and doc proposals still go through the gate (src/consumer.ts) and are only staged. Rejecting,
// ratifying, publishing a prompt, accepting a suggestion and any delete are not tools at all.
import { z } from "zod";
import {
  TicketCreate, TicketEdit, TicketTransition, TicketCommentAdd, TicketLinkAdd, TicketSprintSet, TicketParentSet, TicketAssigneeToggle,
} from "@shared/tickets";
import { TICKET_CATEGORIES, TICKET_PRIORITIES, TICKET_STATUS_LABEL, type TicketStatus } from "@shared/tickets-core";
import { SprintCreate, PlanNarrative, PlanSprintEntry } from "@shared/sprints";
import { FEED_BRIEF_MAX } from "@shared/contract";
import { ARTIFACT_SUMMARY_MAX } from "@shared/artifacts";
import { ASK_AUTO_WRITES_MAX, ASK_EXCLUDED_TOOLS, type AskActionKind, type AskActionPreview, type RefView } from "@shared/ai-ask-core";
import { MCP_TOOLS } from "@shared/mcp-tools.generated";
import { hasRole, platform, type TenantContext } from "../../data/context";
import { first } from "../../data/sql";
import { get_ticket, get_sprint, get_doc } from "../../tools/reads";
import { TicketError, ticketByNumber, transition_ticket, add_ticket_comment } from "../../tools/tickets";
import {
  agentCreateTicket, agentEditTicket, agentTransitionTicket, agentAddTicketComment, agentAddTicketLink, agentSetTicketSprint,
  agentSetTicketParent, agentAssignTicket, assertTicketWritable, assertTicketAssignable, type AgentVerb,
} from "../../tools/tickets-agent";
import { SprintError, create_sprint, set_sprint_active, complete_sprint, add_sprint_resource, delete_sprint } from "../../tools/sprints";
import { write_plan, type PlanWrite } from "../../tools/plan";
import { promote_doc } from "../../tools/writes";
import { ingestFeedEntry, ingestDocProposal } from "../../consumer";
import { feedEntryFromMcpArgs } from "../../mcp-args";
import { agentArtifactUpdate } from "../../tools/artifacts-agent";
import { ArtifactError } from "../../tools/artifacts";
import { createHandoff, claimHandoffWithReading, readingListAsMarkdown, expireHandoff, handoffAsTask, getHandoff, HandoffCreateInput, HandoffError } from "../../tools/handoffs";
import { savePrompt, dropStagedVersion, PromptSaveInput } from "../../tools/prompts";
import { firstLine } from "@shared/handoffs";
import { LINK_NOTE_MAX, LINK_REASON_MAX, linkTopicLabel, type LinkView } from "@shared/links";
import {
  LinkError, askThreadSession, closeLink, getLink, joinLink, previewLinkRequest, requestLinkFromAsk, sendLinkNote,
} from "../../tools/links";
import { requireMember } from "../../auth/persons";
import { artifactCtxOf, type AskToolCtx } from "./context";
import { resolveViews } from "./refs";
import { applyHunkEdits, docHunks } from "./diff";

export interface WriteRun {
  result: unknown;
  /** The item the done line links to. */
  ref: string | null;
  /** What Undo writes back and the item's state right after the write (Undo refuses when it changed). null: none. */
  undo: unknown | null;
}

/** Thrown by Undo when someone changed the item since: "Changed since. Undo it by hand." */
export class ChangedSince extends Error {
  readonly code = "changed" as const;
  constructor(readonly ref: string | null) { super("Changed since. Undo it by hand."); }
}

export interface WriteSpec<A> {
  input: z.ZodType<A>;
  card: AskActionKind;
  /** The fields a person may edit on the card before Confirm. */
  editable?: readonly string[];
  /** Apply the card's edited fields to the arguments (then re-validated with `input`). */
  edit?: (c: AskToolCtx, a: A, fields: Record<string, unknown>) => Promise<unknown> | unknown;
  /** The card's field values (what `editable` names, and what else the card shows). */
  fields?: (a: A) => Record<string, unknown>;
  /** The card, from Trov's rows. Throws the writer's own refusal (not_found, forbidden…) when the write could not
   *  apply as asked — the model is told, and no card is made. */
  preview: (c: AskToolCtx, a: A) => Promise<AskActionPreview>;
  run: (c: AskToolCtx, a: A) => Promise<WriteRun>;
  undo?: (c: AskToolCtx, data: any) => Promise<unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Confirm-only: Auto never runs it; the card waits, with this note. */
  confirmOnly?: string;
  /** Does not count toward the Auto cap (it never runs in Auto anyway). */
  outsideCap?: boolean;
  /** It acts AS the thread's side of an agent link (binds it, or writes from it): with the org's AI switch off there
   *  is no Ask, so no Ask side — Confirm refuses it then (routes.ts; invariant 15). */
  asSide?: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const clip = (s: string, n = 280): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ephemeralLedger = () => ({ sessionId: crypto.randomUUID(), itemIndex: 0 });
const line = (label: string, value: string | null | undefined): { label: string; value: string }[] =>
  value === null || value === undefined || value === "" ? [] : [{ label, value }];
const card = (title: string, lines: { label: string; value: string }[], item: RefView | null = null, extra: Partial<AskActionPreview> = {}): AskActionPreview =>
  ({ title, lines, item, ...extra });

async function view(c: AskToolCtx, ref: string): Promise<RefView | null> {
  return (await resolveViews(c.ctx, c.handle, [ref], c.now())).get(ref) ?? null;
}

/** The ticket — and the lane check the write will make, so a card is never shown for a write bound to be refused. */
async function laneTicket(c: AskToolCtx, id: number, verb: AgentVerb | "assign") {
  if (verb === "assign") await assertTicketAssignable(c.ctx, c.env, id, c.handle);
  else await assertTicketWritable(c.ctx, c.env, id, c.handle, verb);
  return ticketDetail(c, id);
}
async function ticketDetail(c: AskToolCtx, id: number) {
  const t = await get_ticket(c.ctx, id);
  if (!t) throw new TicketError("not_found", `no such ticket: ${id}`);
  return t;
}
async function sprintOrThrow(c: AskToolCtx, id: number) {
  const s = await get_sprint(c.ctx, id);
  if (!s) throw new SprintError("not_found", `no such sprint: ${id}`);
  return s;
}
const sprintName = async (c: AskToolCtx, id: number | null | undefined): Promise<string> =>
  id === null || id === undefined ? "Backlog" : (await sprintOrThrow(c, id)).label;
const statusWord = (s: string): string => TICKET_STATUS_LABEL[s as TicketStatus] ?? s;

/** A ticket's fingerprint right after a write: Undo refuses when it moved on since. */
const ticketStamp = async (c: AskToolCtx, id: number): Promise<string | null> => (await ticketByNumber(c.ctx, id))?.updated_at ?? null;
async function unchangedTicket(c: AskToolCtx, id: number, stamp: string | null): Promise<void> {
  if ((await ticketStamp(c, id)) !== stamp) throw new ChangedSince(`ticket:${id}`);
}

/** May this person promote a staged doc version? Exactly the web's rule for POST /doc/:slug/promote: a
 *  signed-in member of the org (the Review page's approve). A bearer or a system context never may. */
export function mayPromote(ctx: TenantContext): boolean {
  return ctx.via === "session" && (ctx.role === "owner" || ctx.role === "admin" || ctx.role === "member");
}

const idShape = { id: z.number() };
const CreateTicketIn = TicketCreate;
const EditTicketIn = z.object({ ...idShape, ...TicketEdit.shape });
const TransitionIn = z.object({ ...idShape, ...TicketTransition.shape });
const CommentIn = z.object({ ...idShape, ...TicketCommentAdd.shape });
const LinkIn = z.object({ ...idShape, ...TicketLinkAdd.shape });
const SprintSetIn = z.object({ ...idShape, ...TicketSprintSet.shape });
const ParentIn = z.object({ ...idShape, ...TicketParentSet.shape });
const AssignIn = z.object({ ...idShape, ...TicketAssigneeToggle.shape });
const binaryShape = {
  size_bytes: z.number().int().min(1).optional(), sha256: z.string().optional(), content_type: z.string().max(255).optional(),
  filename: z.string().max(255).optional(), content_base64: z.string().optional(),
};
/** Why Ask refuses send_handoff's upload form. */
export const ASK_NO_PROMPT_UPLOAD = "Ask can't upload a file: send the prompt inline as { title, body }, without sha256 or size_bytes.";
const HandoffIn = z.object({
  body: z.string().min(1),
  recipient: z.string().optional(),
  context: z.object({
    repo: z.string().optional(), branch: z.string().optional(), task: z.string().optional(),
    done: z.array(z.string()).optional(), next: z.array(z.string()).optional(), files: z.array(z.string()).optional(),
  }).optional(),
  // MCP also takes an UPLOAD form ({ title, sha256, size_bytes }, then a PUT from a shell). Ask has no shell, so
  // its card only ever carries the prompt inline: the upload form's keys are refused, not dropped.
  prompt: z.strictObject({ title: z.string(), body: z.string() }, ASK_NO_PROMPT_UPLOAD).optional(),
});
const DocProposalIn = z.object({
  slug: z.string(), section: z.string(), title: z.string().optional(), body: z.string(), change_summary: z.string(),
  confidence: z.enum(["high", "low"]), space: z.string().optional(), parent_slug: z.string().optional(), base_version: z.number().optional(), force: z.boolean().optional(),
});
const PublishIn = z.object({ slug: z.string().min(1), version: z.number().int().optional() });

/** The staged version a Publish card names: the one given, else the newest staged one. */
async function stagedVersion(c: AskToolCtx, slug: string, version?: number) {
  const v = await first<{ version: number; body: string; created_by: string; summary: string | null }>(c.ctx,
    `SELECT version, body, created_by, summary FROM doc_versions WHERE org_id = ? AND slug = ? AND status = 'staged'${version !== undefined ? " AND version = ?" : ""} ORDER BY version DESC LIMIT 1`,
    ...[c.ctx.orgId, slug, ...(version !== undefined ? [version] : [])]);
  if (!v) throw new TicketError("not_found", `no staged version of ${slug}${version !== undefined ? ` v${version}` : ""}`);
  return v;
}

// ── agent links (src/tools/links.ts) ──
const LinkTargetIn = z.object({
  pr: z.number().int().optional(), branch: z.string().optional(), ticket: z.number().int().optional(), person: z.string().optional(),
});
const LinkRequestIn = z.object({ target: LinkTargetIn, reason: z.string().optional() });
const LinkJoinIn = z.object({ id: z.number().int(), side: z.enum(["requester", "recipient"]).optional() });
const LinkNoteIn = z.object({ id: z.number().int(), body: z.string() });
const LinkCloseIn = z.object({ id: z.number().int(), reason: z.string().optional() });

const sameHandle = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** The other side's person, as the viewer sees the link (themself on a link with themself). */
const linkOther = (l: Pick<LinkView, "requester" | "recipient">, me: string): string =>
  sameHandle(l.requester.handle, me) ? l.recipient.handle : l.requester.handle;
const withWords = (l: Pick<LinkView, "requester" | "recipient" | "self">, me: string): string =>
  l.self ? "You (another session of yours)" : `@${linkOther(l, me)}`;
/** Which side of the link THIS thread is, for the viewer: the side bound to its session, or null. */
function threadSide(l: Pick<LinkView, "requester" | "recipient">, me: string, threadId: number): "requester" | "recipient" | null {
  const s = askThreadSession(threadId);
  if (sameHandle(l.requester.handle, me) && l.requester.session === s) return "requester";
  if (sameHandle(l.recipient.handle, me) && l.recipient.session === s) return "recipient";
  return null;
}
/** A link as Ask's model and the done line get it: never another side's session id. */
const linkResult = (l: LinkView, me: string, threadId: number) => ({
  id: l.id, state: l.state, url: `#links/${l.id}`, with: linkOther(l, me), self: l.self, topic: linkTopicLabel(l.topic.kind, l.topic.ref),
  reason: l.reason, this_thread: threadSide(l, me, threadId), expires_at: l.expires_at,
});
/** The link the card is about — only for its two people (anyone else reads it as absent), and only while it is open. */
async function openLinkOf(c: AskToolCtx, id: number) {
  const l = await getLink(c.ctx, c.handle, id);
  if (!l) throw new LinkError("not_found", "link not found");
  if (l.state !== "open") throw new LinkError("conflict", l.state === "draft" || l.state === "requested" ? `link #${id} is ${l.state}: it opens once it is accepted` : `link #${id} is ${l.state}`);
  return l;
}

export const WRITES: Record<string, WriteSpec<any>> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  // ── tickets (the lane: src/tools/tickets-agent.ts) ──
  create_ticket: {
    input: CreateTicketIn, card: "ticket",
    editable: ["title", "category", "priority", "assignee"],
    fields: (a: z.infer<typeof CreateTicketIn>) => ({
      title: a.title, body: a.body ?? "", category: a.category ?? "other", priority: a.priority ?? "normal",
      assignee: a.assignees?.[0] ?? null, sprint_id: a.sprint_id ?? null,
    }),
    edit: (_c, a: z.infer<typeof CreateTicketIn>, f) => ({
      ...a,
      ...(f.title !== undefined ? { title: f.title } : {}),
      ...(f.category !== undefined ? { category: f.category } : {}),
      ...(f.priority !== undefined ? { priority: f.priority } : {}),
      ...(f.assignee !== undefined ? { assignees: f.assignee ? [f.assignee] : [] } : {}),
    }),
    async preview(c, a: z.infer<typeof CreateTicketIn>) {
      const who: string[] = [];
      for (const h of a.assignees ?? []) who.push(await requireMember(c.ctx, h));
      return card("New ticket", [
        ...line("Title", a.title), ...line("Description", a.body ? clip(a.body) : null),
        ...line("Category", a.category ?? "other"), ...line("Priority", a.priority ?? "normal"),
        ...line("Assignee", who.length ? who.map((h) => `@${h}`).join(", ") : "Unassigned"),
        ...line("Sprint", await sprintName(c, a.sprint_id)), ...line("Link", a.link),
      ]);
    },
    async run(c, a) {
      const n = await agentCreateTicket(c.ctx, TicketCreate.parse(a), c.handle);
      return { result: await ticketDetail(c, n), ref: `ticket:${n}`, undo: { id: n, stamp: await ticketStamp(c, n) } };
    },
    // A created ticket is declined, with "Undone in Trov" — the person's own web writers (the cookie authority).
    async undo(c, d: { id: number; stamp: string | null }) {
      await unchangedTicket(c, d.id, d.stamp);
      await transition_ticket(c.ctx, d.id, "declined", c.handle);
      await add_ticket_comment(c.ctx, d.id, "Undone in Trov", c.handle);
      return ticketDetail(c, d.id);
    },
  },
  edit_ticket: {
    input: EditTicketIn, card: "ticket", editable: ["title"],
    fields: (a: z.infer<typeof EditTicketIn>) => ({ title: a.title ?? null, body: a.body ?? null }),
    edit: (_c, a, f) => ({ ...a, ...(typeof f.title === "string" ? { title: f.title } : {}) }),
    async preview(c, a: z.infer<typeof EditTicketIn>) {
      if (a.title === undefined && a.body === undefined) throw new TicketError("bad_request", "pass a title, a body, or both");
      const t = await laneTicket(c, a.id, "edit_ticket");
      return card(`Edit #${a.id}`, [...(a.title !== undefined ? line("Title", `${t.title} → ${a.title}`) : []), ...(a.body !== undefined ? line("Description", clip(a.body)) : [])],
        await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      const before = await ticketDetail(c, a.id);
      await agentEditTicket(c.ctx, c.env, a.id, { title: a.title, body: a.body }, c.handle);
      return {
        result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`,
        undo: { id: a.id, stamp: await ticketStamp(c, a.id), ...(a.title !== undefined ? { title: before.title } : {}), ...(a.body !== undefined ? { body: before.body } : {}) },
      };
    },
    async undo(c, d: { id: number; stamp: string | null; title?: string; body?: string }) {
      await unchangedTicket(c, d.id, d.stamp);
      await agentEditTicket(c.ctx, c.env, d.id, { title: d.title, body: d.body }, c.handle);
      return ticketDetail(c, d.id);
    },
  },
  // Moving a ticket to Done is an ordinary write in Ask (#12 §2.12): by Confirm, or Auto as the person asked.
  transition_ticket: {
    input: TransitionIn, card: "move",
    fields: (a: z.infer<typeof TransitionIn>) => ({ to: a.to }),
    async preview(c, a: z.infer<typeof TransitionIn>) {
      const t = await laneTicket(c, a.id, "transition_ticket");
      if (t.status === a.to) throw new TicketError("conflict", `ticket ${a.id} is already ${statusWord(a.to)}`);
      return card(`Move #${a.id} to ${statusWord(a.to)}`, line("Status", `${statusWord(t.status)} → ${statusWord(a.to)}`), await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      const before = await ticketDetail(c, a.id);
      await agentTransitionTicket(c.ctx, c.env, a.id, a.to, c.handle);
      return { result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`, undo: { id: a.id, to: before.status, stamp: await ticketStamp(c, a.id) } };
    },
    async undo(c, d: { id: number; to: TicketStatus; stamp: string | null }) {
      await unchangedTicket(c, d.id, d.stamp);
      await agentTransitionTicket(c.ctx, c.env, d.id, d.to, c.handle);
      return ticketDetail(c, d.id);
    },
  },
  add_ticket_comment: {
    input: CommentIn, card: "ticket",
    async preview(c, a: z.infer<typeof CommentIn>) {
      await laneTicket(c, a.id, "add_ticket_comment");
      return card(`Comment on #${a.id}`, line("Comment", clip(a.body, 600)), await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      await agentAddTicketComment(c.ctx, c.env, a.id, a.body, c.handle);
      return { result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`, undo: null };
    },
  },
  add_ticket_link: {
    input: LinkIn, card: "ticket",
    async preview(c, a: z.infer<typeof LinkIn>) {
      await laneTicket(c, a.id, "add_ticket_link");
      return card(`Link work to #${a.id}`, line("Link", a.raw), await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      await agentAddTicketLink(c.ctx, c.env, a.id, a.raw, c.handle);
      return { result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`, undo: null };
    },
  },
  set_ticket_sprint: {
    input: SprintSetIn, card: "move",
    async preview(c, a: z.infer<typeof SprintSetIn>) {
      const t = await laneTicket(c, a.id, "set_ticket_sprint");
      const to = await sprintName(c, a.sprint_id);
      return card(a.sprint_id === null ? `Move #${a.id} to the backlog` : `Move #${a.id} to ${to}`, line("Sprint", `${t.sprint?.label ?? "Backlog"} → ${to}`), await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      const before = await ticketDetail(c, a.id);
      await agentSetTicketSprint(c.ctx, c.env, a.id, a.sprint_id, c.handle);
      return { result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`, undo: { id: a.id, sprint_id: before.sprint?.id ?? null, stamp: await ticketStamp(c, a.id) } };
    },
    async undo(c, d: { id: number; sprint_id: number | null; stamp: string | null }) {
      await unchangedTicket(c, d.id, d.stamp);
      await agentSetTicketSprint(c.ctx, c.env, d.id, d.sprint_id, c.handle);
      return ticketDetail(c, d.id);
    },
  },
  set_ticket_parent: {
    input: ParentIn, card: "ticket",
    async preview(c, a: z.infer<typeof ParentIn>) {
      await laneTicket(c, a.id, "set_ticket_parent");
      const child = await laneTicket(c, a.child_id, "set_ticket_parent");
      return card(`Nest #${a.child_id} under #${a.id}`, line("Sub-ticket", `#${a.child_id} ${child.title}`), await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      await agentSetTicketParent(c.ctx, c.env, a.id, a.child_id, c.handle);
      return { result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`, undo: null };
    },
  },
  // The card draws the assignment itself (ask-actions.ts `assignBody`): the ticket and its status from `item`, who is
  // on it now from `item.extra.assignees`, and who comes or goes from `fields` — `login`, the one field a person
  // may change before Confirm (the agent tool's args are unchanged).
  assign_ticket: {
    input: AssignIn, card: "ticket", editable: ["login"],
    fields: (a: z.infer<typeof AssignIn>) => ({ id: a.id, login: a.login, on: a.on }),
    edit: (_c, a: z.infer<typeof AssignIn>, f) => ({ ...a, ...(typeof f.login === "string" && f.login.trim() ? { login: f.login.trim() } : {}) }),
    async preview(c, a: z.infer<typeof AssignIn>) {
      await laneTicket(c, a.id, "assign");
      const h = await requireMember(c.ctx, a.login);
      return card(a.on ? `Assign @${h} to #${a.id}` : `Remove @${h} from #${a.id}`, line("Assignee", `${a.on ? "Add" : "Remove"} @${h}`), await view(c, `ticket:${a.id}`));
    },
    async run(c, a) {
      const before = await ticketDetail(c, a.id);
      const had = before.assignees.some((h) => h.toLowerCase() === a.login.toLowerCase());
      await agentAssignTicket(c.ctx, c.env, a.id, a.login, a.on, c.handle);
      return { result: await ticketDetail(c, a.id), ref: `ticket:${a.id}`, undo: had === a.on ? null : { id: a.id, login: a.login, on: !a.on, stamp: await ticketStamp(c, a.id) } };
    },
    // "As the write left it" is THAT person's assignment, not the ticket's `updated_at`: a replacement is two writes
    // to one ticket (one group, one Undo), and undoing the first touches the ticket — a stamp check refused the
    // second every time. Someone who since put the person back on (or took them off) still stops it.
    async undo(c, d: { id: number; login: string; on: boolean; stamp: string | null }) {
      const t = await ticketDetail(c, d.id);
      if (t.assignees.some((h) => h.toLowerCase() === d.login.toLowerCase()) === d.on) throw new ChangedSince(`ticket:${d.id}`);
      await agentAssignTicket(c.ctx, c.env, d.id, d.login, d.on, c.handle);
      return ticketDetail(c, d.id);
    },
  },

  // ── the gate: staged only (src/consumer.ts) ──
  append_feed: {
    input: z.object({
      summary: z.string(), brief: z.string().trim().min(1).max(FEED_BRIEF_MAX).optional(), body: z.string().optional(), tags: z.array(z.string()).optional(),
      prs: z.array(z.string()).optional(), commits: z.array(z.string()).optional(), issues: z.array(z.number()).optional(),
    }),
    card: "other",
    async preview(_c, a) {
      return card("New feed entry", [...line("Summary", a.summary), ...line("Brief", a.brief), ...line("Tags", (a.tags ?? []).join(", "))]);
    },
    async run(c, a) {
      const r = await ingestFeedEntry(c.ctx, feedEntryFromMcpArgs(a), c.handle, ephemeralLedger());
      return { result: r, ref: r.outcome === "written" ? `feed:${r.id}` : null, undo: null };
    },
  },
  // A doc edit: changed hunks (≤ 3 with their heading), each editable; it goes to Review. No withdraw path exists
  // in the store, so a doc proposal has no Undo.
  propose_doc_update: {
    input: DocProposalIn, card: "doc_edit", editable: ["hunks"],
    fields: (a: z.infer<typeof DocProposalIn>) => ({ slug: a.slug, section: a.section, title: a.title ?? null, change_summary: a.change_summary }),
    async edit(c, a: z.infer<typeof DocProposalIn>, f) {
      if (typeof f.body === "string") return { ...a, body: f.body };
      if (!Array.isArray(f.hunks)) return a;
      const live = (await get_doc(c.ctx, a.slug))?.doc?.body ?? "";
      const body = applyHunkEdits(live, a.body, f.hunks as { index: number; after: string }[]);
      if (body === null) throw new TicketError("bad_request", "an edited hunk does not match the proposal");
      return { ...a, body };
    },
    async preview(c, a: z.infer<typeof DocProposalIn>) {
      const doc = (await get_doc(c.ctx, a.slug))?.doc ?? null;
      const hunks = docHunks(doc?.body ?? "", a.body);
      return card(doc ? `Doc edit: ${doc.title}` : `New doc: ${a.title ?? a.slug}`, [
        ...line("Doc", doc?.title ?? a.title ?? a.slug),
        ...line("Version", doc ? `v${doc.current_version} → v${doc.current_version + 1}` : "v1"),
        ...line("Change", a.change_summary),
        ...(hunks.length > 3 ? line("More", `${hunks.length - 3} more change${hunks.length - 3 === 1 ? "" : "s"}`) : []),
      ], doc ? await view(c, `doc:${a.slug}`) : null, { hunks: hunks.slice(0, 3) });
    },
    async run(c, a) {
      const r = await ingestDocProposal(c.ctx, a, c.handle, ephemeralLedger());
      return { result: r, ref: `doc:${a.slug}`, undo: null };
    },
  },
  // Publish a staged doc: the web promote path, as the person. Never in Auto, never counted toward the cap.
  publish_doc: {
    input: PublishIn, card: "publish", confirmOnly: "Publishing waits for you, even on Auto.", outsideCap: true,
    fields: (a: z.infer<typeof PublishIn>) => ({ slug: a.slug, version: a.version ?? null }),
    async preview(c, a: z.infer<typeof PublishIn>) {
      const v = await stagedVersion(c, a.slug, a.version);
      const doc = (await get_doc(c.ctx, a.slug))?.doc ?? null;
      return card(`Publish ${doc?.title ?? a.slug}`, [
        ...line("Version", `v${v.version}`), ...line("Staged by", `@${v.created_by}`),
        ...line("What it does", `Publishing makes v${v.version} live for the org. Agents read it from then on.`),
      ], await view(c, `doc:${a.slug}`), { canPublish: mayPromote(c.ctx), hunks: docHunks(doc?.body ?? "", v.body).slice(0, 3) });
    },
    async run(c, a) {
      if (!mayPromote(c.ctx)) throw new TicketError("forbidden", "You can't publish docs here. Open it in Review.");
      const v = await stagedVersion(c, a.slug, a.version);
      const res = await promote_doc(c.ctx, a.slug, v.version, c.handle);
      return { result: res, ref: `doc:${a.slug}`, undo: null };
    },
  },

  // ── artifacts ──
  artifact_update: {
    input: z.object({ slug: z.string().min(1), summary: z.string().max(ARTIFACT_SUMMARY_MAX), content: z.string().optional(), old_str: z.string().optional(), new_str: z.string().optional(), ...binaryShape }),
    card: "other",
    async preview(c, a) {
      const item = await view(c, `artifact:${a.slug}`);
      if (!item) throw new ArtifactError("not_found", "not_found");
      return card(`New version of ${item.title}`, [...line("What changed", a.summary), ...line("Change", a.content !== undefined ? "The whole text" : a.old_str !== undefined ? "An exact edit" : "A file")], item);
    },
    async run(c, a) {
      return { result: await agentArtifactUpdate(artifactCtxOf(c), a), ref: `artifact:${a.slug}`, undo: null };
    },
  },

  // ── sprints (open to every member) ──
  create_sprint: {
    input: SprintCreate, card: "sprint",
    async preview(_c, a: z.infer<typeof SprintCreate>) {
      return card(`New sprint: ${a.label}`, [...line("Start", a.start), ...line("Due", a.due), ...line("Lead", a.lead ? `@${a.lead}` : null), ...line("Urgency", a.urgency), ...line("Summary", a.summary)]);
    },
    async run(c, a) {
      const s = await create_sprint(c.ctx, SprintCreate.parse(a), c.handle);
      return { result: s, ref: `sprint:${s.id}`, undo: { id: s.id } };
    },
    // A created sprint is deleted only while it is still empty.
    async undo(c, d: { id: number }) {
      const s = await get_sprint(c.ctx, d.id);
      if (!s) throw new SprintError("not_found", `no such sprint: ${d.id}`);
      if (s.tickets.length || s.resources.length) throw new ChangedSince(`sprint:${d.id}`);
      return delete_sprint(c.ctx, d.id);
    },
  },
  set_sprint_active: {
    input: z.object({ id: z.number(), active: z.boolean() }), card: "sprint",
    async preview(c, a) {
      const s = await sprintOrThrow(c, a.id);
      return card(a.active ? `Start ${s.label}` : `Move ${s.label} to Upcoming`, line("Status", `${s.status} → ${a.active ? "in_progress" : "upcoming"}`), await view(c, `sprint:${a.id}`));
    },
    async run(c, a) {
      return { result: await set_sprint_active(c.ctx, a.id, a.active), ref: `sprint:${a.id}`, undo: null };
    },
  },
  complete_sprint: {
    input: z.object({ id: z.number() }), card: "sprint", confirmOnly: "Completing a sprint waits for you, even on Auto.",
    async preview(c, a) {
      const s = await sprintOrThrow(c, a.id);
      if (s.status === "done") throw new SprintError("conflict", `${s.label} is already done`);
      return card(`Complete ${s.label}`, line("Status", `${s.status} → done`), await view(c, `sprint:${a.id}`));
    },
    async run(c, a) {
      return { result: await complete_sprint(c.ctx, a.id), ref: `sprint:${a.id}`, undo: null };
    },
  },
  add_sprint_resource: {
    input: z.object({ id: z.number(), raw: z.string().min(1) }), card: "sprint",
    async preview(c, a) {
      const s = await sprintOrThrow(c, a.id);
      return card(`Add a link to ${s.label}`, line("Link", a.raw), await view(c, `sprint:${a.id}`));
    },
    async run(c, a) {
      return { result: await add_sprint_resource(c.ctx, a.id, a.raw), ref: `sprint:${a.id}`, undo: null };
    },
  },

  // ── handoffs and prompts ──
  send_handoff: {
    input: HandoffIn, card: "handoff", editable: ["recipient", "task"],
    fields: (a: z.infer<typeof HandoffIn>) => ({
      recipient: a.recipient ?? "anyone", task: a.context?.task ?? firstLine(a.body), done: a.context?.done ?? [], next: a.context?.next ?? [], files: a.context?.files ?? [],
    }),
    edit: (_c, a: z.infer<typeof HandoffIn>, f) => ({
      ...a,
      ...(typeof f.recipient === "string" ? { recipient: f.recipient === "anyone" ? undefined : f.recipient } : {}),
      ...(typeof f.task === "string" ? { context: { ...(a.context ?? {}), task: f.task } } : {}),
    }),
    async preview(c, a: z.infer<typeof HandoffIn>) {
      const to = a.recipient && a.recipient !== "anyone" ? `@${await requireMember(c.ctx, a.recipient)}` : "anyone";
      return card("New handoff", [
        ...line("From", `@${c.handle}`), ...line("To", to === "anyone" ? "Anyone · any agent session can claim it" : to),
        ...line("Task", a.context?.task ?? firstLine(a.body)), ...line("Done", (a.context?.done ?? []).join("; ")),
        ...line("Next", (a.context?.next ?? []).join("; ")), ...line("Files", (a.context?.files ?? []).join(", ")),
      ]);
    },
    async run(c, a: z.infer<typeof HandoffIn>) {
      const input = HandoffCreateInput.parse({ body: a.body, recipient: a.recipient, context: a.context, prompt: a.prompt ?? null });
      const { handoff } = await createHandoff(c.ctx, c.handle, input);
      return { result: { id: handoff.id, recipient: handoff.recipient, url: `#handoffs/${handoff.id}` }, ref: `handoff:${handoff.id}`, undo: { id: handoff.id } };
    },
    // Undo expires it — only while nobody has claimed it.
    async undo(c, d: { id: number }) {
      const h = await getHandoff(c.ctx, d.id);
      if (!h) throw new HandoffError("not_found", "handoff not found");
      if (h.status !== "pending") throw new ChangedSince(`handoff:${d.id}`);
      return expireHandoff(c.ctx, d.id, c.handle);
    },
  },
  claim_handoff: {
    input: z.object({ id: z.number().int() }), card: "handoff",
    async preview(c, a) {
      const h = await getHandoff(c.ctx, a.id);
      if (!h) throw new HandoffError("not_found", "handoff not found");
      if (h.status !== "pending") throw new HandoffError("conflict", `handoff #${a.id} is ${h.status}`);
      return card(`Claim handoff #${a.id}`, [...line("Title", firstLine(h.body)), ...line("From", `@${h.sender}`)], await view(c, `handoff:${a.id}`));
    },
    async run(c, a) {
      const { handoff: h, reading_list } = await claimHandoffWithReading(c.ctx, a.id, c.handle, `ask-thread-${c.threadId}`);
      const reading = readingListAsMarkdown(reading_list);
      return { result: { id: h.id, task: `# Handoff #${h.id} — claimed\n\n${handoffAsTask(h)}${reading ? `\n\n${reading}` : ""}` }, ref: `handoff:${h.id}`, undo: null };
    },
  },
  expire_handoff: {
    input: z.object({ id: z.number().int() }), card: "handoff",
    async preview(c, a) {
      const h = await getHandoff(c.ctx, a.id);
      if (!h) throw new HandoffError("not_found", "handoff not found");
      return card(`Expire handoff #${a.id}`, line("Title", firstLine(h.body)), await view(c, `handoff:${a.id}`));
    },
    async run(c, a) {
      return { result: await expireHandoff(c.ctx, a.id, c.handle), ref: `handoff:${a.id}`, undo: null };
    },
  },
  save_prompt: {
    input: z.object({ slug: z.string(), title: z.string(), body: z.string(), tags: z.array(z.string()).optional(), summary: z.string().optional(), branch: z.string().optional() }),
    card: "other",
    async preview(_c, a) {
      return card(`Stage the prompt ${a.slug}`, [...line("Title", a.title), ...line("Tags", (a.tags ?? []).join(", ")), ...line("Prompt", clip(a.body))]);
    },
    async run(c, a) {
      const p = await savePrompt(c.ctx, c.handle, PromptSaveInput.parse({ slug: a.slug, title: a.title, body: a.body, tags: a.tags, summary: a.summary }), "agent", { branch: a.branch });
      return { result: { slug: p.slug, version: p.version, status: p.status }, ref: `prompt:${p.slug}`, undo: { slug: p.slug, version: p.version } };
    },
    async undo(c, d: { slug: string; version: number }) {
      try {
        return await dropStagedVersion(c.ctx, d.slug, d.version, c.handle);
      } catch (e) {
        if ((e as { code?: string }).code === "conflict") throw new ChangedSince(`prompt:${d.slug}`);
        throw e;
      }
    },
  },

  // ── agent links: the thread is a side (Confirm-only, every one; run as the CONFIRMER) ──
  // Confirming a request is the Send step: sent at once (`requested`), or open for a link with oneself.
  request_link: {
    input: LinkRequestIn, card: "handoff", confirmOnly: "Sending a link request waits for you, even on Auto.", outsideCap: true, asSide: true,
    fields: (a: z.infer<typeof LinkRequestIn>) => ({ target: a.target, reason: a.reason }),
    async preview(c, a: z.infer<typeof LinkRequestIn>) {
      if ((a.reason ?? "").trim().length > LINK_REASON_MAX) throw new LinkError("bad_request", `reason over ${LINK_REASON_MAX} characters`);
      const p = await previewLinkRequest(c.ctx, c.handle, { target: a.target, reason: a.reason });
      return card(p.self ? "Open a link with your other session" : `Link request to @${p.recipient}`, [
        ...line("With", p.self ? "You (another session of yours)" : `@${p.recipient}`),
        ...line("About", p.topic.kind === "person" ? null : linkTopicLabel(p.topic.kind, p.topic.ref)),
        ...line("Reason", p.reason || null),
        ...line("What it does", p.self
          ? "Confirm opens it at once, with this thread as one side."
          : `Confirm sends it. @${p.recipient} accepts or declines it in Trov; once open, their agent's notes reach this thread.`),
      ]);
    },
    async run(c, a: z.infer<typeof LinkRequestIn>) {
      const l = await requestLinkFromAsk(c.ctx, c.handle, c.threadId, { target: a.target, reason: a.reason });
      return { result: linkResult(l, c.handle, c.threadId), ref: `link:${l.id}`, undo: null };
    },
  },
  join_link: {
    input: LinkJoinIn, card: "handoff", confirmOnly: "Joining a link waits for you, even on Auto.", outsideCap: true, asSide: true,
    fields: (a: z.infer<typeof LinkJoinIn>) => ({ id: a.id }),
    async preview(c, a: z.infer<typeof LinkJoinIn>) {
      const l = await openLinkOf(c, a.id);
      if (!sameHandle(l.requester.handle, c.handle) && !sameHandle(l.recipient.handle, c.handle)) throw new LinkError("forbidden", "only the link's two people can join it");
      return card(`Join link #${a.id} from this thread`, [
        ...line("With", withWords(l, c.handle)),
        ...line("About", l.topic.kind === "person" ? null : linkTopicLabel(l.topic.kind, l.topic.ref)),
        ...line("What it does", "Notes from the other side reach this thread at the start of your next question, and this thread can leave notes for their agent."),
      ], await view(c, `link:${a.id}`));
    },
    async run(c, a: z.infer<typeof LinkJoinIn>) {
      const l = await joinLink(c.ctx, c.handle, { id: a.id, session: askThreadSession(c.threadId), side: a.side }, "ask");
      return { result: linkResult(l, c.handle, c.threadId), ref: `link:${l.id}`, undo: null };
    },
  },
  send_link_note: {
    input: LinkNoteIn, card: "handoff", confirmOnly: "A note to someone else's agent waits for you, even on Auto.", outsideCap: true, asSide: true,
    fields: (a: z.infer<typeof LinkNoteIn>) => ({ id: a.id, body: a.body }),
    async preview(c, a: z.infer<typeof LinkNoteIn>) {
      if (!a.body.trim()) throw new LinkError("bad_request", "body required");
      if (a.body.trim().length > LINK_NOTE_MAX) throw new LinkError("bad_request", `body over ${LINK_NOTE_MAX} characters`);
      const l = await openLinkOf(c, a.id);
      if (!threadSide(l, c.handle, c.threadId)) throw new LinkError("forbidden", `this thread has not joined link #${a.id}: join it first`);
      return card(`Note on link #${a.id}`, [
        ...line("To", l.self ? "Your other session" : `@${linkOther(l, c.handle)}'s side`),
        ...line("Note", a.body.trim()),
      ], await view(c, `link:${a.id}`));
    },
    async run(c, a: z.infer<typeof LinkNoteIn>) {
      const n = await sendLinkNote(c.ctx, platform(c.env, c.handle), c.handle, { id: a.id, session: askThreadSession(c.threadId), body: a.body }, "ask");
      return { result: { link: a.id, note: n.id, side: n.side, created_at: n.created_at }, ref: `link:${a.id}`, undo: null };
    },
  },
  close_link: {
    input: LinkCloseIn, card: "handoff", confirmOnly: "Closing a link waits for you, even on Auto.", outsideCap: true,
    fields: (a: z.infer<typeof LinkCloseIn>) => ({ id: a.id, reason: a.reason ?? null }),
    async preview(c, a: z.infer<typeof LinkCloseIn>) {
      const l = await openLinkOf(c, a.id);
      return card(`Close link #${a.id}`, [
        ...line("With", withWords(l, c.handle)), ...line("Reason", a.reason),
        ...line("What it does", "Both sides stop getting notes. Its thread stays readable in Trov."),
      ], await view(c, `link:${a.id}`));
    },
    async run(c, a: z.infer<typeof LinkCloseIn>) {
      const l = await closeLink(c.ctx, c.handle, { id: a.id, reason: a.reason, session: askThreadSession(c.threadId) }, "ask");
      return { result: linkResult(l, c.handle, c.threadId), ref: `link:${l.id}`, undo: null };
    },
  },

  // ── admin: the whole plan (Confirm-only) ──
  update_plan: {
    input: z.object({ narrative: PlanNarrative, sprints: z.array(PlanSprintEntry).default([]) }), card: "sprint",
    confirmOnly: "Changing the roadmap plan waits for you, even on Auto.",
    async preview(_c, a) {
      return card("Update the roadmap plan", [...line("Narrative", clip(a.narrative, 400)), ...line("Sprints", a.sprints.map((s: { label: string }) => s.label).join(", "))]);
    },
    async run(c, a) {
      // MCP registers this tool for an admin only; a card made while the person was one is not a licence now (Q57).
      if (!hasRole(c.ctx, "admin")) throw new TicketError("forbidden", "Only an admin can change the roadmap plan.");
      return { result: await write_plan(c.ctx, a as PlanWrite, c.handle), ref: null, undo: null };
    },
  },
};

/** The MCP tools only an admin is offered (MCP registers them for an admin only; Ask offers them likewise). */
const ADMIN_TOOLS: ReadonlySet<string> = new Set(MCP_TOOLS.filter((t) => t.admin).map((t) => t.name));

/**
 * May THIS person run this write NOW — exactly as if they called the tool themselves (the owner's ruling Q57,
 * 2026-10-16)? A card is a proposal: it never carries the proposer's rights forward. Confirm (and Auto, at once)
 * asks this with the confirmer's own context before anything runs; past it, each writer applies its own rule as it
 * would over MCP — the ticket lane and the assignment rule (src/tools/tickets-agent.ts, re-read on the write),
 * a handoff's sender / recipient, Publish's `mayPromote`, an artifact's author. Throws the writer-style
 * `forbidden` (the card's line then says "Didn't work" with the reason); nothing is written.
 */
export function assertMayRunNow(ctx: TenantContext, tool: string): void {
  if (!(tool in WRITES) || tool in ASK_EXCLUDED_TOOLS) throw new TicketError("forbidden", "Ask can't make that change.");
  if (ADMIN_TOOLS.has(tool) && !hasRole(ctx, "admin")) throw new TicketError("forbidden", "Only an admin can make that change.");
}

/** Why a WAITING card waits, rebuilt for the thread read (no column keeps it; Q55): a Confirm-only write's own note,
 *  else the Auto cap — the only two reasons a card is stored `waiting` (turn.ts). Not waiting → null. */
export function waitingNote(tool: string, state: string): string | null {
  if (state !== "waiting") return null;
  return WRITES[tool]?.confirmOnly ?? `Auto runs up to ${ASK_AUTO_WRITES_MAX} changes per answer.`;
}

/** The agent-link writes: a person always clicks them, whatever the thread's Auto (a note goes to someone else's
 *  agent). Each also carries `confirmOnly`; this list is the second lock, so a link card never runs under Auto even
 *  if its note were dropped. */
export const LINK_WRITES: ReadonlySet<string> = new Set(["request_link", "join_link", "send_link_note", "close_link"]);

/** May Auto mode run this write (beyond the thread's toggle, the org's switch and the per-answer cap)? */
export function autoAllowedFor(tool: string): boolean {
  const spec = WRITES[tool];
  return !!spec && !spec.confirmOnly && !LINK_WRITES.has(tool);
}

/** The card's fields and which of them may be edited. */
export function cardFields(tool: string, args: unknown): { fields: Record<string, unknown>; editable: string[] } {
  const spec = WRITES[tool];
  return { fields: spec?.fields ? spec.fields(args) : {}, editable: [...(spec?.editable ?? [])] };
}

export { TICKET_CATEGORIES, TICKET_PRIORITIES };
