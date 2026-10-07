// The notification kind registry (canopy-email.md §2). Adding a kind is one
// entry here plus one renderer under ./renderers — no migration: policy rows
// are seeded from this list, and the UIs iterate it.
import type { NotificationKind, NotificationKindMeta } from "@shared/notifications";
import type { TenantContext } from "../data/sql";
import { myWorkKind } from "./renderers/my-work";
import { reviewQueueKind } from "./renderers/review-queue";
import { roadmapPlanKind } from "./renderers/roadmap-plan";
import { ticketQueueKind } from "./renderers/ticket-queue";

export const REGISTRY: readonly NotificationKind<TenantContext>[] = [myWorkKind, reviewQueueKind, roadmapPlanKind, ticketQueueKind];

export function getKind(id: string): NotificationKind<TenantContext> | undefined {
  return REGISTRY.find((k) => k.id === id);
}

/** Metadata only (no renderer) — what the HTTP/web layer sees. */
export function registryMeta(): NotificationKindMeta[] {
  return REGISTRY.map(({ id, label, description, defaultCadence, allowedCadences }) => ({
    id, label, description, defaultCadence, allowedCadences,
  }));
}
