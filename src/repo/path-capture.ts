// The webhook's commit-paths capture (Repo setups, Phase E): one verified `push` delivery → its commits' exact files
// through the gate (`ingestCommitPaths`), and — only when the delivery cut something short — ONE compare
// (before...after) whose files are stored as the PUSH's (./commit-paths.ts says how precise each row is). Off the
// render path: src/webhook.ts runs it after the push's `repo_events` row, the compare under `waitUntil`.
import type { TenantContext } from "../data/sql";
import { ingestCommitPaths } from "../consumer";
import { commitPathsFromPush, pushPathsFromCompare } from "./commit-paths";
import { ghJson, scrubbedMessage, type GhOpts } from "./gh-http";

export interface PushPathsOutcome { written: number; unchanged: number; compared: boolean }

/** Never throws for a malformed payload (nothing to write); a failed compare throws AFTER the exact rows landed. */
export async function commitPathsOnPush(
  ctx: TenantContext, repo: string, payload: unknown, gh: () => Promise<GhOpts | null>,
  /** Runs the compare off the response path when the runtime allows (GitHub gives a hook 10 s). */
  defer?: (p: Promise<unknown>) => void,
): Promise<PushPathsOutcome> {
  const push = commitPathsFromPush(payload);
  const out: PushPathsOutcome = { written: 0, unchanged: 0, compared: false };
  if (!push || !repo) return out;
  const exact = await ingestCommitPaths(ctx, repo, push.rows);
  out.written += exact.written; out.unchanged += exact.unchanged;
  if (!push.needsCompare || push.headListed || !push.before) return out;
  const opts = await gh();
  if (!opts) return out;
  out.compared = true;
  const fill = (async () => {
    const cmp = await ghJson<{ files?: unknown }>(opts, `/compare/${encodeURIComponent(push.before!)}...${encodeURIComponent(push.after)}`);
    await ingestCommitPaths(ctx, repo, pushPathsFromCompare(push, cmp.files));
  })();
  // Deferred, a failure is logged here (the message, the token scrubbed); awaited, it throws to the caller's guard.
  if (defer) defer(fill.catch((e) => console.error("commit paths: compare", scrubbedMessage(e, opts.token), `org=${ctx.orgId}`)));
  else await fill;
  return out;
}
