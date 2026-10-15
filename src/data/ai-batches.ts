// The AI pass's Message Batches (0059_ai_batches; docs/architecture/ai.md › Batches). A PLATFORM module: a batch
// carries requests from several organizations, so `ai_batches` / `ai_batch_requests` have no `org_id` — a request
// names its organization only inside `custom_id` (`<org>:<scope>:<key>:<prompt version>`). Every request row is
// deleted when its batch is collected, so nothing here outlives a batch. Nothing here calls a model.
import { all, batch, chunked, ph, run, stmt, type PlatformContext } from "./platform-sql";

export interface OpenBatch { id: string; submitted_at: string }
export interface BatchRequestRow { request_id: string; custom_id: string; job: string }
export interface BatchCounts { succeeded: number; errored: number; canceled: number; expired: number }

/** Batches still open, oldest first. */
export function openBatches(p: PlatformContext, limit: number): Promise<OpenBatch[]> {
  return all<OpenBatch>(p, `SELECT id, submitted_at FROM ai_batches WHERE state = 'submitted' ORDER BY submitted_at, id LIMIT ?`, limit);
}

/** The custom ids of every request still in flight — what the pass must not submit a second time. */
export async function inFlightCustomIds(p: PlatformContext): Promise<Set<string>> {
  const rows = await all<{ custom_id: string }>(p,
    `SELECT r.custom_id FROM ai_batch_requests r JOIN ai_batches b ON b.id = r.batch_id WHERE b.state = 'submitted'`);
  return new Set(rows.map((r) => r.custom_id));
}

export function batchRequests(p: PlatformContext, batchId: string): Promise<BatchRequestRow[]> {
  return all<BatchRequestRow>(p, `SELECT request_id, custom_id, job FROM ai_batch_requests WHERE batch_id = ?`, batchId);
}

/** Record a batch the provider accepted, with its requests, in ONE batch. */
export async function recordBatch(p: PlatformContext, id: string, requests: readonly BatchRequestRow[], at: string): Promise<void> {
  await batch(p, [
    stmt(p, `INSERT INTO ai_batches (id, provider, state, requests, submitted_at) VALUES (?, 'claude', 'submitted', ?, ?)`, id, requests.length, at),
    ...requests.map((r) => stmt(p, `INSERT INTO ai_batch_requests (batch_id, request_id, custom_id, job) VALUES (?, ?, ?, ?)`, id, r.request_id, r.custom_id, r.job)),
  ]);
}

/** The provider said it is not ended yet (or could not be asked). */
export async function batchChecked(p: PlatformContext, id: string, at: string): Promise<void> {
  await run(p, `UPDATE ai_batches SET checked_at = ? WHERE id = ?`, at, id);
}

/** Collected (or `lost`: the provider no longer knows it): its counts, and its request rows go. */
export async function closeBatch(
  p: PlatformContext, id: string, state: "collected" | "lost", at: string, counts: BatchCounts | null, written: number | null,
): Promise<void> {
  await batch(p, [
    stmt(p, `UPDATE ai_batches SET state = ?1, checked_at = ?2, ended_at = COALESCE(ended_at, ?2), collected_at = ?2,
                    succeeded = ?3, errored = ?4, canceled = ?5, expired = ?6, written = ?7 WHERE id = ?8`,
      state, at, counts?.succeeded ?? null, counts?.errored ?? null, counts?.canceled ?? null, counts?.expired ?? null, written, id),
    stmt(p, `DELETE FROM ai_batch_requests WHERE batch_id = ?`, id),
  ]);
}

/** Which of these organizations exist, are not suspended, and have the AI switch ON — the only ones a batch result
 *  may write to. An org that was deleted, suspended or switched off since the submit is simply not in the set. */
export async function orgsStillOn(p: PlatformContext, orgIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const ids of chunked([...new Set(orgIds)])) {
    const rows = await all<{ id: string }>(p, `SELECT id FROM orgs WHERE id IN (${ph(ids.length)}) AND suspended_at IS NULL AND ai_automation = 1`, ...ids);
    for (const r of rows) out.add(r.id);
  }
  return out;
}

/** The daily retention: collected / lost batch rows (counts only) older than `days`. */
export async function pruneBatches(p: PlatformContext, before: string): Promise<void> {
  await run(p, `DELETE FROM ai_batches WHERE state <> 'submitted' AND submitted_at < ? AND NOT EXISTS (SELECT 1 FROM ai_batch_requests r WHERE r.batch_id = ai_batches.id)`, before);
}
