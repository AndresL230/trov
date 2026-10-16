// Type surface for scenarios.mjs (see build.d.mts): the local dev seed's named scenarios, importable from a Worker
// test (test/seed-scenarios.test.ts) without allowJs.
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface SeedDb { query(sqls: string[]): Promise<Row[][]>; apply(label: string, statements: string[]): Promise<void> }
export interface Scenario { name: string; org: string; slug: string; what: string; signIn: [handle: string, role: string][]; statements(now: Date, opts?: { reset?: boolean }): string[]; showcase?: boolean }
export const SCENARIOS: Scenario[];
export const DEV_FIXTURES: Record<string, unknown>;
export const ORG_TABLES_SQL: string[];
export function scenarioNames(): string[];
export function orgTablesInOrder(rows: Row[]): string[];
export function orgWipeStatements(orgId: string, tables: string[]): string[];
export function teamBaseStatements(now?: Date, opts?: { reset?: boolean }): string[];
export function teamShowcase(db: SeedDb, opts?: { now?: Date; image?: { sha: string; size: number } | null; views?: ((refs: string[]) => Promise<Record<string, unknown>>) | null; origin?: string }): Promise<{ unresolved: string[] }>;
export function loadScenarios(db: SeedDb, names: string[], opts?: { now?: Date; reset?: boolean; image?: { sha: string; size: number } | null; views?: ((refs: string[]) => Promise<Record<string, unknown>>) | null; origin?: string; log?: (line: string) => void }): Promise<Record<string, { unresolved: string[] }>>;
