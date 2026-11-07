// Grounding and ref views (docs/architecture/ask.md › Grounding; #12 §2.5–2.6). Two jobs:
//   • which items a tool RETURNED in a thread (`refsFromResult`) — an answer's ref token is linked only when its
//     ref is in the thread's seen set (what a tool returned, or what the person attached);
//   • THE view model of an item (`RefView`): every chip, card, hover card, inspector header, picker row and source
//     row draws from it, permission-checked for the viewer — an item they cannot see is simply absent, which `peek`
//     answers as `{ ref, hidden: true }`. It lives in src/tools/ref-views.ts (`resolveViews`, the status words),
//     outside src/ai/, so the MCP server can draw a project's pins with it; it is re-exported here for Ask's modules.
import { askRefTokens, parseAskRef, type AskRefType, type RefView } from "@shared/ai-ask-core";
import type { TenantContext } from "../../data/sql";
import { normalRef, resolveViews } from "../../tools/ref-views";

export { normalRef, resolveViews, ticketStatus, sprintStatus } from "../../tools/ref-views";

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
  // Agent links: the link (its two people only — resolveViews hides it from anyone else).
  list_links: (r) => ["waiting", "mine", "open", "unbound"].flatMap((box) => pick("link", obj(r)?.[box], "id")),
  request_link: one("link", "id"), join_link: one("link", "id"), close_link: one("link", "id"),
  send_link_note: (r, a) => (num(obj(r)?.link) ? [`link:${obj(r)!.link}`] : num(a.id) ? [`link:${a.id}`] : []),
  // The GitHub tools (./github.ts): a pull request of the PRIMARY repository is the one Trov captures (its keys carry
  // no repository), so it links as `pr:N`; another repository's stays plain text. Nothing else they read is an item.
  github_pull_request: (r) => (obj(r)?.primary === true ? one("pr", "number")(r) : []),
  github_list: (r) => (obj(r)?.primary === true && obj(r)?.what === "pulls" ? pick("pr", obj(r)?.items, "number") : []),
};

/** The refs a tool's result names (deduped, each a valid `type:key`, a person's handle lower-cased). */
export function refsFromResult(tool: string, result: unknown, args: Record<string, unknown> = {}): string[] {
  const fn = EXTRACT[tool];
  if (!fn) return [];
  let refs: string[];
  try { refs = fn(result, args); } catch { return []; }
  return [...new Set(refs.map(normalRef))].filter((r) => parseAskRef(r) !== null);
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
