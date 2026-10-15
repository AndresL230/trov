// THE JOB INTERFACE of the AI pass (docs/architecture/ai.md › Jobs). A job is one KIND of work over one scope (or a
// key prefix of it): it reads its item's input from D1, says what to ask, and writes what came back. It never
// decides eligibility, the allowance, the caps, metering, grouping, the prefix, batching or clearing — the pass
// (./pass.ts, ./batches.ts) does, the same way for every job. Phase B ships the interface and NO producer: Phases C
// and D register them in `AI_JOBS` (./pass.ts); the tests register stand-ins.
import type { z } from "zod";
import type { AiScope } from "@shared/ai-core";
import type { DirtyScope, ScopeKey } from "../data/ai-dirty";
import type { TenantContext } from "../data/sql";
import type { ClaudeKind, JevAnswer, JevKind, JevQuestion } from "./client";

/** One stale scope and the input its job read for it. */
export interface JobItem<I> { scope: DirtyScope; input: I }

/** One Jev request: the item's text (`state`) and the questions about it. */
export interface JevRequest { state: string; questions: Record<string, JevQuestion> }
/** What Jev answered: per question, the parsed answer or null (malformed — never a guess). */
export interface JevAnswers { model: string; answers: Record<string, JevAnswer | null> }

interface JobBase<I> {
  /** Unique. What a batch request names, and what the logs say. */
  name: string;
  /** The scope it works through… */
  scope: AiScope;
  /** …and, for a `card` (or any scope shared by several jobs), the key prefix it takes (`ticket:`). */
  keyPrefix?: string;
  /** Recorded with what it writes, and the last part of a batch request's `custom_id`. `[A-Za-z0-9_.-]+`. */
  promptVersion: string;
  /** The item's input, from D1 only (no model, no network). `null` = nothing to send: the scope is written as it
   *  is (cleared) without a call — the item is gone, or has nothing worth asking about. */
  input(ctx: TenantContext, scope: DirtyScope): Promise<I | null>;
}

/** A Jev job: ONE item per request (Jev reads one `state` at a time), several questions allowed. */
export interface JevJob<I = unknown> extends JobBase<I> {
  provider: "jev";
  kind: JevKind;
  ask(item: JobItem<I>): JevRequest;
  /** Store what Jev said. true = written (the scope clears); false = nothing written (a failed attempt). */
  write(ctx: TenantContext, item: JobItem<I>, answer: JevAnswers): Promise<boolean>;
}

/** A Jev GATE before a Haiku call: "is this worth a Haiku call?". One Jev request per item. When Jev is unavailable
 *  (no key, the allowance spent, the provider stopped, or a malformed answer) the plain rule `fallback` decides. */
export interface JevGate<I = unknown> {
  kind: JevKind;
  ask(item: JobItem<I>): JevRequest;
  /** true = past the gate: the item goes to Haiku. */
  pass(answer: JevAnswers): boolean;
  fallback(item: JobItem<I>): boolean;
  /** What a gated-out item writes (a session's `skipped` status, say). The scope clears after it. */
  skip?(ctx: TenantContext, item: JobItem<I>): Promise<void>;
}

/** A Haiku job: up to `group` items (≤ HAIKU_GROUP_MAX) per call, every prompt led by the cached org prefix. */
export interface ClaudeJob<I = unknown, O = unknown> extends JobBase<I> {
  provider: "claude";
  kind: ClaudeKind;
  /** Items per call, 1–20. A batch job sends one item per request. */
  group: number;
  /** Non-urgent: submitted through the Message Batches API and written when a later tick collects it. */
  batch?: boolean;
  gate?: JevGate<I>;
  /** The answer's shape — `sections(...)` (./sections.ts) so one bad section or item drops alone. */
  schema: z.ZodType<O>;
  maxTokens: number;
  /** The scope's part of the prompt (the org prefix is the pass's, sent before `input`). */
  prompt(items: readonly JobItem<I>[]): { system: string; input: string };
  /** Store what the answer says. Returns the scope KEYS it wrote: those clear; the call's other items failed. */
  write(ctx: TenantContext, items: readonly JobItem<I>[], output: O, meta: { model: string }): Promise<readonly string[]>;
}

// A registry holds jobs of every input and output type; each is used only with its own items.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AiJob = JevJob<any> | ClaudeJob<any, any>;

/** The most items one Haiku call carries. */
export const HAIKU_GROUP_MAX = 20;
const PROMPT_VERSION = /^[A-Za-z0-9_.-]{1,40}$/;

/** Items per request: Jev always 1, a batch request 1, a Haiku call 1–20. */
export function groupOf(job: AiJob): number {
  if (job.provider === "jev" || job.batch) return 1;
  return Math.max(1, Math.min(HAIKU_GROUP_MAX, Math.floor(Number(job.group) || 1)));
}

/** Does `job` work through this scope? */
export const takes = (job: AiJob, s: ScopeKey): boolean => job.scope === s.scope && (!job.keyPrefix || s.key.startsWith(job.keyPrefix));

/** A job whose prompt version could not be read back out of a batch `custom_id` is not run at all. */
export const validJob = (job: AiJob): boolean => PROMPT_VERSION.test(job.promptVersion) && !!job.name;

/** `<org>:<scope>:<key>:<prompt version>` — a batch request's own record of what it is for. */
export const customIdOf = (orgId: string, s: ScopeKey, promptVersion: string): string => `${orgId}:${s.scope}:${s.key}:${promptVersion}`;

/** The parts of a `custom_id` (a key may itself contain `:`), or null. */
export function parseCustomId(id: string): { orgId: string; scope: AiScope; key: string; promptVersion: string } | null {
  const parts = id.split(":");
  if (parts.length < 4) return null;
  return { orgId: parts[0], scope: parts[1] as AiScope, key: parts.slice(2, -1).join(":"), promptVersion: parts[parts.length - 1] };
}
