// Type surface for ai-showcase.mjs (see build.d.mts): the local AI showcase seed's statement builders. Rows read
// from D1 are passed through as wrangler returns them, so the honest public shape is a permissive record.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface ShowcasePre { N: Record<"A" | "B" | "C" | "D" | "E" | "F" | "G" | "H", number>; HN: number; pr185At: string | null; tables: Set<string>; member: boolean }
export type ShowcaseSnapshot = Record<string, Row[] | Row | string>;
export const SHOWCASE_ORG: string;
export const IDS: Record<string, unknown>;
export const PRE_SQL: string[];
export const SNAP_SQL: string[];
export const CHECKS: [what: string, sql: string, least: number][];
export function preFrom(results: Row[][]): ShowcasePre;
export function snapFrom(results: Row[][]): ShowcaseSnapshot;
export function deleteStatements(clock: Row): string[];
export function contentStatements(pre: ShowcasePre, now?: Date, image?: { sha: string; size: number } | null): string[];
export function showcaseRefs(pre: ShowcasePre, snap: ShowcaseSnapshot, now?: Date): string[];
export function aiStatements(pre: ShowcasePre, snap: ShowcaseSnapshot, views: Record<string, unknown>, now?: Date, opts?: { origin?: string; image?: { sha: string; size: number } }): { statements: string[]; unresolved: string[] };
