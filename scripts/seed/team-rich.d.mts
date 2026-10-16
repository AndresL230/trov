// Type surface for team-rich.mjs (see build.d.mts): the team scenario's rich layer.
export const ORG: string;
export const LOGIN: Record<string, string>;
export const CHECKS: [what: string, sql: string, least: number][];
export function insert(table: string, row: Record<string, unknown>, verb?: string): string;
export function insertMany(table: string, rows: Record<string, unknown>[], per?: number, verb?: string): string[];
export function makeClock(now?: Date): { t: number; days(d: number): string; date(d: number): string; hourFloor(ms: number): string };
export function deleteStatements(): string[];
export function plumbingDeleteStatements(): string[];
export function teamRichStatements(now?: Date): string[];
export const CANONICAL_SPRINT_DATES: [id: number, start: number, due: number, status: string, doneAgo?: number][];
export interface DatedSprint { id: number; start_date: string; target_date: string; status: string; dates: string | null; updated_at?: string | null }
export function datedRoadmap<R extends { sprints?: unknown[] }>(roadmap: R, now?: Date): Omit<R, "sprints"> & { sprints: (DatedSprint & Record<string, unknown>)[] };
