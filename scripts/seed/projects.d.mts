// Type surface for projects.mjs (see build.d.mts): the team scenario's Projects (0086_projects).
export const PROJECT_IDS: { hosting: number; teacher: number; gradebook: number; exam: number; streak: number };
export const HOSTING_THREADS: number[];
export const HOSTING_INSTRUCTIONS: string;
export function projectStatements(now?: Date): string[];
export const PROJECT_CHECKS: [label: string, sql: string, want: number][];
