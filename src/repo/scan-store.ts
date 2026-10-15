// STUB (Phase D2) — D1's module replaces this file at merge.
import type { AppSuggestionDTO, RepoScanDTO } from "@shared/repo-scan-core";
import type { TenantContext } from "../data/sql";
import type { Env } from "../env";
export async function listSuggestions(_ctx: TenantContext, _repo: string): Promise<AppSuggestionDTO[]> { return []; }
export async function readScan(_ctx: TenantContext, _repo: string): Promise<RepoScanDTO> { return { treeSha: null, scannedAt: null, looked: [], error: null }; }
export async function acceptSuggestion(_ctx: TenantContext, _handle: string, _id: string): Promise<{ undo: string }> { return { undo: "" }; }
export async function undoAccept(_ctx: TenantContext, _handle: string, _undoToken: string): Promise<void> { return; }
export async function ignoreSuggestion(_ctx: TenantContext, _handle: string, _id: string): Promise<void> { return; }
export async function runScanNow(_env: Env, _ctx: TenantContext): Promise<void> { return; }
