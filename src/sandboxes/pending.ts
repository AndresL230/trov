// Sandboxes waiting for their profile's boot to be started (docs/architecture/sandboxes.md › Profiles). An MCP
// sandbox_create from a profile notes its sandbox here; src/index.ts, after the MCP request, runs
// src/sandboxes/boot.ts in `waitUntil` when anything is noted. This module imports nothing, so the MCP graph
// (src/mcp.ts → src/tools/sandboxes.ts) reaches it without reaching src/github-app/ (CLAUDE.md invariant 12).
// A note lost with its isolate is not lost work: the row stays `pending`, and the next drain (another create,
// Refresh on Monitor › Sandboxes, or the repo cron) picks it up.

const pending = new Set<string>();

export function notePendingBoot(orgId: string, sandboxId: string): void {
  pending.add(`${orgId}\u0000${sandboxId}`);
}

/** Whether anything was noted since the last take, clearing the notes. */
export function takePendingBoots(): boolean {
  const any = pending.size > 0;
  pending.clear();
  return any;
}
