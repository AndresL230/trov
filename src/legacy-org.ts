// Multitenancy Phase 2 (canopy-multitenancy.md §3.2): the schema is per-org, the queries are not yet.
// Until Phase 3 ports every statement to a TenantContext, the few statements that address a per-org
// SINGLETON (the plan row, the notification settings row) or name an org key in an upsert target name
// SaplingLearn's org explicitly — the same org every unported INSERT lands in through the column
// DEFAULT. Phase 3 deletes this module; `grep LEGACY_ORG_ID` is its to-do list.
export const LEGACY_ORG_ID = "org_saplinglearn";
