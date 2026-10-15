// The AI pass, as its tests see it (docs/architecture/ai.md › The pass): both providers stubbed at the `Response`
// level and COUNTED — Anthropic's Messages API and its Message Batches, TypeSafe's Jev — plus stand-in jobs and
// `ai_dirty` fixtures. Never the network.
import { env } from "cloudflare:test";
import { z } from "zod";
import type { Env } from "../../src/env";
import type { ClaudeJob, JevJob, JobItem, JevGate } from "../../src/ai/jobs";
import type { AiScope } from "@shared/ai-core";
import { first, run } from "./db";
import { FAKE_ANTHROPIC_KEY, messageBody } from "./anthropic";

export const FAKE_TYPESAFE_KEY = "ts-FAKE_key_for_tests_0123456789";
/** The env with both keys (or the ones given). */
export const keyedEnv = (over: Partial<Env> = {}): Env =>
  ({ ...(env as unknown as Env), ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, TYPESAFE_API_KEY: FAKE_TYPESAFE_KEY, ...over });

/** What a Haiku stub answers: the request's own body in, the JSON text (or a status) out. */
export type ClaudeReply = (body: { system: { text: string }[]; messages: { content: { text: string; cache_control?: unknown }[] }[] }) => string | { status: number } | { stop: "refusal" | "max_tokens"; text?: string };
/** What a Jev stub answers per request: the noul probability of every question (or a status). */
export type JevReply = (body: { state: string; questions: Record<string, unknown> }) => number | { status: number };

export interface Stub {
  fetchImpl: typeof fetch;
  /** Messages API calls (direct Haiku calls). */
  haiku: number;
  /** Jev requests. */
  jev: number;
  batchCreates: number;
  batchRetrieves: number;
  batchResults: number;
  other: number;
  /** Every Haiku request body, in order. */
  haikuBodies: Record<string, unknown>[];
  /** Every batch create body. */
  batchBodies: { requests: { custom_id: string; params: Record<string, unknown> }[] }[];
  /** The batch the stub holds: what `retrieve` and `results` answer. */
  batch: { id: string; ended: boolean; results: Record<string, unknown>[] | null; gone?: boolean };
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for every provider. `claude` answers direct calls; `jev` answers Jev; anything else is 200 "ok". */
export function stubProviders(o: { claude?: ClaudeReply; jev?: JevReply } = {}): Stub {
  const s: Stub = {
    haiku: 0, jev: 0, batchCreates: 0, batchRetrieves: 0, batchResults: 0, other: 0, haikuBodies: [], batchBodies: [],
    batch: { id: "msgbatch_test1", ended: false, results: null },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.startsWith("https://api.typesafe.ai/")) {
        s.jev++;
        const r = (o.jev ?? (() => 0.9))(body);
        if (typeof r !== "number") return json({ error: "no" }, r.status);
        return json({ model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: "noul", noul: r }])), usage: { input_tokens: 50, output_tokens: 1 } });
      }
      if (url === "https://api.anthropic.com/v1/messages") {
        s.haiku++;
        s.haikuBodies.push(body);
        const r = (o.claude ?? (() => JSON.stringify({ ok: true })))(body);
        if (typeof r === "string") return json(messageBody(r, { usage: { input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 40 } }));
        if ("status" in r) return json({ type: "error", error: { type: "api_error", message: "no" } }, r.status);
        return json(messageBody(r.text ?? "{}", { stop_reason: r.stop }));
      }
      if (url === "https://api.anthropic.com/v1/messages/batches") {
        s.batchCreates++;
        s.batchBodies.push(body);
        return json(batchObject(s.batch.id, false, body.requests.length));
      }
      const m = /^https:\/\/api\.anthropic\.com\/v1\/messages\/batches\/([^/?]+)(\/results)?/.exec(url);
      if (m) {
        if (s.batch.gone || m[1] !== s.batch.id) return json({ type: "error", error: { type: "not_found_error", message: "no" } }, 404);
        if (m[2]) {
          s.batchResults++;
          return new Response((s.batch.results ?? []).map((l) => JSON.stringify(l)).join("\n"), { status: 200, headers: { "content-type": "application/binary" } });
        }
        s.batchRetrieves++;
        return json(batchObject(s.batch.id, s.batch.ended, s.batch.results?.length ?? 0));
      }
      s.other++;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch,
  };
  return s;
}

function batchObject(id: string, ended: boolean, n: number): Record<string, unknown> {
  return {
    id, type: "message_batch", processing_status: ended ? "ended" : "in_progress",
    request_counts: ended ? { processing: 0, succeeded: n, errored: 0, canceled: 0, expired: 0 } : { processing: n, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    created_at: "2026-10-14T12:00:00Z", expires_at: "2026-10-15T12:00:00Z", ended_at: ended ? "2026-10-14T13:00:00Z" : null,
    archived_at: null, cancel_initiated_at: null,
    results_url: ended ? `https://api.anthropic.com/v1/messages/batches/${id}/results` : null,
  };
}

/** One JSONL result line: a succeeded message whose text is `text`. */
export const succeededLine = (customId: string, text: string): Record<string, unknown> =>
  ({ custom_id: customId, result: { type: "succeeded", message: messageBody(text, { usage: { input_tokens: 80, output_tokens: 5, cache_read_input_tokens: 20 } }) } });

/** A stale scope, written straight into `ai_dirty` (a fixture: production marks through the router). */
export async function markRow(orgId: string, scope: AiScope, key: string, at: string, o: { urgent?: boolean; attempts?: number; markedAt?: string } = {}): Promise<void> {
  await run(env.DB, `INSERT INTO ai_dirty (org_id, scope, scope_key, dirty_since, marked_at, attempts, urgent) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, scope, scope_key) DO UPDATE SET dirty_since = excluded.dirty_since, marked_at = excluded.marked_at, attempts = excluded.attempts, urgent = excluded.urgent, last_run_at = NULL`,
  orgId, scope, key, at, o.markedAt ?? at, o.attempts ?? 0, o.urgent ? 1 : 0);
}

export interface DirtyRowView { scope: string; scope_key: string; dirty_since: string; marked_at: string | null; last_run_at: string | null; attempts: number; last_error: string | null; urgent: number }
export const dirtyRow = (orgId: string, scope: string, key: string) =>
  first<DirtyRowView>(env.DB, `SELECT scope, scope_key, dirty_since, marked_at, last_run_at, attempts, last_error, urgent FROM ai_dirty WHERE org_id = ? AND scope = ? AND scope_key = ?`, orgId, scope, key);

/** A Jev card job over `card:<prefix>…`: one `noul` question; records what it wrote. */
export function jevCardJob(prefix = "ticket:", o: { write?: boolean } = {}): JevJob<string> & { wrote: string[] } {
  const wrote: string[] = [];
  return {
    provider: "jev", kind: "tag.fit", name: `test.jev.${prefix}`, scope: "card", keyPrefix: prefix, promptVersion: "t1", wrote,
    input: async (_ctx, s) => `item ${s.key}`,
    ask: (item: JobItem<string>) => ({ state: item.input, questions: { notable: { type: "noul", instructions: "Is it notable?" } } }),
    write: async (_ctx, item) => { if (o.write === false) return false; wrote.push(item.scope.key); return true; },
  };
}

const OkSchema = z.object({ items: z.array(z.object({ key: z.string(), text: z.string() })) });

/** A Haiku job over `scope` with `group` items per call; it answers for every key it is given unless told
 *  otherwise, and records what it wrote and every call's item count. */
export function claudeJob(scope: AiScope, o: { group?: number; batch?: boolean; gate?: JevGate<string>; keyPrefix?: string; name?: string; write?: (keys: string[]) => string[] } = {}):
  ClaudeJob<string, z.infer<typeof OkSchema>> & { wrote: string[]; calls: number[] } {
  const wrote: string[] = [];
  const calls: number[] = [];
  return {
    provider: "claude", kind: "summary_pr", name: o.name ?? `test.claude.${scope}`, scope, keyPrefix: o.keyPrefix, promptVersion: "t1",
    group: o.group ?? 1, batch: o.batch, gate: o.gate, schema: OkSchema, maxTokens: 400, wrote, calls,
    input: async (_ctx, s) => `input for ${s.key}`,
    prompt: (items) => { calls.push(items.length); return { system: "test system", input: JSON.stringify(items.map((i) => ({ key: i.scope.key, input: i.input }))) }; },
    write: async (_ctx, items, out) => {
      const keys = out.items.map((i) => i.key).filter((k) => items.some((it) => it.scope.key === k));
      const done = o.write ? o.write(keys) : keys;
      wrote.push(...done);
      return done;
    },
  };
}

/** A Haiku answer naming every key of the request's input (the stub's default for `claudeJob`). */
export const answerEveryKey: ClaudeReply = (body) => {
  const input = body.messages[0].content.at(-1)!.text;
  const items = JSON.parse(input) as { key: string }[];
  return JSON.stringify({ items: items.map((i) => ({ key: i.key, text: `about ${i.key}` })) });
};

/** A session gate: substantive when Jev's probability ≥ 0.5; the plain rule passes a burst with a PR or ≥3 commits. */
export function sessionGate(fallback = false): JevGate<string> & { skipped: string[] } {
  const skipped: string[] = [];
  return {
    kind: "tag.fit", skipped,
    ask: (item) => ({ state: item.input, questions: { substantive: { type: "noul", instructions: "Is this burst substantive?" } } }),
    pass: (a) => { const x = a.answers.substantive; return !!x && x.type === "noul" && x.p >= 0.5; },
    fallback: () => fallback,
    skip: async (_ctx, item) => { skipped.push(item.scope.key); },
  };
}
