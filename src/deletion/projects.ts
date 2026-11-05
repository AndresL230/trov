// Deleting a project (docs/architecture/projects.md › Deleting; the spec's Deleting section). CLAUDE.md invariant 11:
// the project itself is SOFT — its row stays, marked `deleted_at`, so its slug stays reserved — and goes in ONE batch
// with its pins and members, its artifacts' link to it cleared (they stay in Artifacts, each with its own visibility).
// Its THREADS are hard-deleted, every one of them — the owner's, other members' own, and those shared with others —
// each through Ask's own thread deletion (`deleteAskThread`, ./ask.ts: the thread's rows and the attachments that go
// with it, a file a ticket or a doc refers to kept; R2 freed after the commit). The tickets, docs and PRs it pinned
// are not touched.
//
// Order: the project's batch FIRST, so from that moment nobody can open it, start a thread in it or move one into it;
// then its threads. A thread a failure leaves behind still names a deleted project, which every read treats as no
// project (src/tools/projects.ts `projectMarks` / `projectForTurn`).
import type { PlatformContext } from "../data/context";
import { batch, type TenantContext } from "../data/sql";
import { projectArtifactCount, projectDeleteStatements, projectThreadOwners } from "../data/projects";
import { deleteAskThread } from "./ask";

export interface DeletedProject { chats: number; artifacts: number }

/** Delete the project with this id (the caller checked the person may: its owner, or an org admin who can open it). */
export async function deleteProject(ctx: TenantContext, p: PlatformContext, bucket: R2Bucket | undefined, projectId: number): Promise<DeletedProject> {
  const artifacts = await projectArtifactCount(ctx, projectId);
  await batch(ctx, projectDeleteStatements(ctx, projectId));
  // Read after the batch: no thread can join the project once it is deleted.
  const threads = await projectThreadOwners(ctx, projectId);
  let chats = 0;
  for (const t of threads) if (await deleteAskThread(ctx, p, bucket, t.handle, t.id)) chats++;
  return { chats, artifacts };
}
