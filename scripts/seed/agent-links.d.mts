// Type surface for agent-links.mjs (the agent-links e2e seed) so a TypeScript test can import it under
// tsconfig.worker.json without allowJs.
export function insert(table: string, row: Record<string, unknown>): string;
export function deleteStatements(): string[];
export function agentLinksStatements(now?: Date): string[];
export const CHECKS: [what: string, sql: string, want: number][];
