// STUB (Phase D2) — D1's module replaces this file at merge.
import type { SeenSignal } from "@shared/repo-scan-core";
import type { TenantContext } from "../data/sql";
export async function seenSignals(_ctx: TenantContext, _repo: string, _sinceDays = 30): Promise<SeenSignal[]> { return []; }
