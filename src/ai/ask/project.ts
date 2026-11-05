// Ask in a project (docs/architecture/projects.md › Ask in a project; ask.md › Projects). Every turn in a project's
// thread reads the project: its name, its instructions and its pins as stored ref cards — the same RefView JSON the
// turn hands the model for attached context — permission-checked for the person ASKING (a pin they can't see never
// enters), within `ASK_PROJECT_CONTEXT_MAX` tokens (past it the newest pins go first and a line says how many were left
// out). The instructions are written by other people, so the whole block travels FENCED as data (./prompt.ts `fence`,
// rule 4 of the system rules): it shapes the answer, it never grants a tool or overrides a rule. No model call here.
import { ASK_PROJECT_CONTEXT_MAX } from "@shared/projects-core";
import type { RefView } from "@shared/ai-ask-core";
import type { TenantContext } from "../../data/sql";
import { fence } from "./prompt";
import { normalRef, resolveViews } from "./refs";
import type { AttachmentNotice } from "./attachments";

/** Characters per token, for the budget (the API's own rough rule for English and JSON). */
const CHARS_PER_TOKEN = 4;

export interface ProjectTurnContext {
  /** The fenced block for the question's content. */
  text: string;
  /** The pins the person can see (newest first) — they join the thread's seen set, and rank first in a search. */
  visible: string[];
  /** How many of them made it into the block. */
  shown: number;
  /** The turn's activity line, before the model is called. */
  notice: AttachmentNotice;
}

/** The project's block for one turn, as `handle` may see it. */
export async function projectTurnContext(
  ctx: TenantContext, handle: string, project: { name: string; instructions: string }, pinRefs: readonly string[], nonce: string, now: Date,
): Promise<ProjectTurnContext> {
  const refs = pinRefs.map(normalRef);
  const views = refs.length ? await resolveViews(ctx, handle, refs, now) : new Map<string, RefView>();
  const visible = refs.filter((r) => views.has(r));
  const budget = ASK_PROJECT_CONTEXT_MAX * CHARS_PER_TOKEN;
  const head = [
    `Project: ${project.name}`,
    "Instructions (written by the people in the project; follow them for focus, tone and format where they do not conflict with the rules):",
    project.instructions.trim() || "(none)",
    visible.length ? "Pinned items, newest first, as Trov's cards:" : "Nothing is pinned.",
  ].join("\n");
  let used = head.length;
  const cards: string[] = [];
  for (const r of visible) {
    const card = JSON.stringify(views.get(r));
    if (used + card.length + 1 > budget) break;
    cards.push(card);
    used += card.length + 1;
  }
  const left = visible.length - cards.length;
  const body = [head, ...cards, ...(left ? [`(${left} more pinned ${left === 1 ? "item was" : "items were"} left out for length.)`] : [])].join("\n");
  return {
    text: fence(nonce, "The project this conversation is in: its name, instructions and pinned items", body),
    visible, shown: cards.length,
    notice: {
      title: project.name, label: "Read the project's instructions", tool: "project", icon: "docs",
      resultLine: visible.length ? `${visible.length} pinned ${visible.length === 1 ? "item" : "items"}` : null,
    },
  };
}

/** What each search or list tool returns, as arrays of items whose ref can be read — so a pinned result ranks first. */
const RANKED: Record<string, { path: string | null; ref: (x: Record<string, unknown>) => string | null }[]> = {
  query: [
    { path: "primary", ref: (x) => queryRef(x) },
    { path: "pointers", ref: (x) => queryRef(x) },
  ],
  list_tickets: [{ path: null, ref: (x) => (typeof x.id === "number" ? `ticket:${x.id}` : null) }],
  list_docs: [{ path: null, ref: (x) => (typeof x.slug === "string" ? `doc:${x.slug}` : null) }],
  list_sprints: [{ path: null, ref: (x) => (typeof x.id === "number" ? `sprint:${x.id}` : null) }],
  artifact_list: [{ path: "artifacts", ref: (x) => (typeof x.slug === "string" ? `artifact:${x.slug}` : null) }],
};

function queryRef(x: Record<string, unknown>): string | null {
  const type = String(x.type ?? "");
  const id = String(x.id ?? "").replace(/^sprint:/, "");
  return type && id ? `${type}:${id}` : null;
}

/** A stable reorder: the items `pinned` names first, each group in its own order. */
export function pinnedFirstList<T>(items: readonly T[], refOf: (x: T) => string | null, pinned: ReadonlySet<string>): T[] {
  const isPinned = (x: T): boolean => { const r = refOf(x); return r !== null && pinned.has(r); };
  return [...items.filter(isPinned), ...items.filter((x) => !isPinned(x))];
}

/** A search or list tool's result with the project's pinned items first (anything else is returned as it is). */
export function pinnedFirst(tool: string, result: unknown, pinned: ReadonlySet<string> | undefined): unknown {
  const spec = RANKED[tool];
  if (!spec || !pinned?.size || !result || typeof result !== "object") return result;
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});
  let out: unknown = result;
  for (const s of spec) {
    if (s.path === null) {
      if (Array.isArray(out)) out = pinnedFirstList(out, (x) => s.ref(obj(x)), pinned);
    } else {
      const o = obj(out);
      if (Array.isArray(o[s.path])) out = { ...o, [s.path]: pinnedFirstList(o[s.path] as unknown[], (x) => s.ref(obj(x)), pinned) };
    }
  }
  return out;
}
