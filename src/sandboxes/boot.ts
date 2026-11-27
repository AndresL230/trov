// Starting profile boots (docs/architecture/sandboxes.md › Profiles). A sandbox created from a profile is left
// `pending` by src/tools/sandboxes.ts; this drain claims it (`booting`), mints a GitHub token scoped to the
// profile's repository when the org has one that reaches it (resolveGithubCredential: a system context is served,
// a bearer never), and asks the runner to start the boot script. How the boot goes is read later, by
// `pollBoots` (src/tools/sandboxes.ts), on sandbox_get / sandbox_list and on Refresh.
//
// It lives outside the MCP import graph on purpose: src/index.ts runs it in `waitUntil` after an MCP request
// that noted a boot, the Monitor's Refresh route runs it, and so does the repo cron, for a note an isolate lost.
import type { Env } from "../env";
import { platform, systemTenant } from "../data/context";
import { first, run } from "../data/sql";
import { listPendingBoots } from "../platform/jobs";
import { resolveGithubCredential } from "../github-app/credential";
import { callRunner, profileRow, recordEvent, scrubOutput, type SandboxRow } from "../tools/sandboxes";

const ROW_COLS = `sandbox_id, name, created_by, created_at, profile_key, boot_state, boot_detail`;

/** Start every pending boot (at most 20 a run), or only `orgId`'s. Never throws. */
export async function drainBoots(env: Env, opts: { orgId?: string; fetchImpl?: typeof fetch } = {}): Promise<number> {
  if (!env.SANDBOX) return 0;
  const p = platform(env, "system");
  let started = 0;
  let units: { org_id: string; sandbox_id: string }[];
  try { units = await listPendingBoots(p, opts.orgId); } catch (e) { console.error("sandbox boots: list", e instanceof Error ? e.message : String(e)); return 0; }
  for (const u of units) {
    const ctx = systemTenant(p, u.org_id, "system");
    try {
      // Claim it: two drains at once start it once.
      const claim = await run(ctx, `UPDATE org_sandboxes SET boot_state = 'booting' WHERE org_id = ? AND sandbox_id = ? AND boot_state = 'pending' AND deleted_at IS NULL`, ctx.orgId, u.sandbox_id);
      if ((claim.meta?.changes ?? 0) !== 1) continue;
      const row = await first<SandboxRow>(ctx, `SELECT ${ROW_COLS} FROM org_sandboxes WHERE org_id = ? AND sandbox_id = ?`, ctx.orgId, u.sandbox_id);
      const profile = row?.profile_key ? await profileRow(ctx, row.profile_key) : null;
      if (!row || !profile) {
        await run(ctx, `UPDATE org_sandboxes SET boot_state = 'failed' WHERE org_id = ? AND sandbox_id = ?`, ctx.orgId, u.sandbox_id);
        if (row) await recordEvent(ctx, u.sandbox_id, { tool: "boot_step", subject: "profile", failed: true, output: "The profile this sandbox was created from was deleted before it booted.", source: "boot" });
        continue;
      }
      const detail = JSON.parse(row.boot_detail ?? "{}") as { branch?: string | null };
      const branch = detail.branch ?? profile.branch;
      let token: string | null = null;
      if (profile.repo) {
        const cred = await resolveGithubCredential(ctx, env, { repo: profile.repo, fetchImpl: opts.fetchImpl }).catch(() => null);
        token = cred ? cred.token.reveal() : null;
      }
      const clean = profile.repo ? `https://github.com/${profile.repo}.git` : null;
      try {
        await callRunner(env.SANDBOX, ctx, "boot", {
          sandbox: u.sandbox_id,
          clone: clean ? { url: token ? `https://x-access-token:${token}@github.com/${profile.repo}.git` : clean, clean_url: clean, branch } : null,
          setup: JSON.parse(profile.setup || "[]"),
          start: profile.start_cmd ? { cmd: profile.start_cmd, port: profile.port } : null,
        });
        started++;
      } catch (e) {
        const message = scrubOutput(e instanceof Error ? e.message : String(e), token ? [token] : []);
        await run(ctx, `UPDATE org_sandboxes SET boot_state = 'failed' WHERE org_id = ? AND sandbox_id = ?`, ctx.orgId, u.sandbox_id);
        await recordEvent(ctx, u.sandbox_id, { tool: "boot_step", subject: "start the boot", failed: true, output: message, source: "boot" });
      }
    } catch (e) {
      console.error("sandbox boots", e instanceof Error ? e.message : String(e), `org=${u.org_id}`);
    }
  }
  return started;
}
