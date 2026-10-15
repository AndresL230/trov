// Type surface for server-ai-e2e.mjs so TypeScript test files importing it type-check under tsconfig.worker.json
// (which includes test/) without allowJs.
export interface SeedFixture { section: string; name: string; what: string; checks: [string, number][] }
export interface SeedSection { id: string; title: string; branch: string; migration: string; needs: Record<string, string[]> }
export const SECTIONS: SeedSection[];
export const SCHEMA_SQL: string;
export const TEST_BEARER: string;
export function insert(table: string, row: Record<string, unknown>, verb?: string): string;
export function schemaFromRows(rows: { t: string; c: string }[]): Map<string, Set<string>>;
export function missingFrom(schema: Map<string, Set<string>>, needs: Record<string, string[]>): string | null;
export function isoWeekId(d: Date): string;
export function allFixtures(now?: Date): SeedFixture[];
export function serverAiE2eStatements(
  schema: Map<string, Set<string>>,
  opts?: { now?: Date; base?: boolean; fx?: Record<string, unknown> | null },
): { statements: string[]; sections: (SeedSection & { ran: boolean; missing: string | null; count?: number })[]; fixtures: SeedFixture[]; unreset: string[] };
