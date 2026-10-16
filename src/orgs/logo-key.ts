// Where an org's image lives in R2 (`org-logos/<sha256>`, content-addressed). Its own leaf module so the deletion
// sweep (src/deletion/r2.ts) — reachable from Ask's routes — never imports ./logo.ts, which reaches GitHub (the
// owner-avatar import) and, from there, the credential resolver (test/secrets.mcp.test.ts › Ask's boundary).
export const orgLogoKey = (sha: string): string => `org-logos/${sha}`;
