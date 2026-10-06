// Canonical data-table reset for Trov, shared by the test harness
// (test/apply-migrations.ts) and the dev seed loader. FK-safe delete order;
// re-seeds the people identity map. When a migration adds a data table, add
// its DELETE here.
export const RESET_STATEMENTS = [
  // Multitenancy (0037–0040): the org platform tables clear FIRST — memberships, invites and the
  // attribution map reference persons, every org_* table references orgs. The two SEED orgs are kept
  // (every tenant table's transitional org_id DEFAULT points at org_saplinglearn); any org a test
  // created is removed once its rows are gone (the per-org singletons are trimmed further down).
  "DELETE FROM org_usage_daily",
  "DELETE FROM org_admin_audit",
  "UPDATE orgs SET suspended_at = NULL, suspended_by = NULL",
  "DELETE FROM org_audit",
  "DELETE FROM org_secrets",
  "DELETE FROM org_keys",
  "DELETE FROM org_integration_config",
  "DELETE FROM org_environments",
  "DELETE FROM org_repos",
  "DELETE FROM org_login_map",
  "DELETE FROM org_invites",
  "DELETE FROM memberships",
  "DELETE FROM org_counters",
  "DELETE FROM platform_admins",
  "UPDATE cron_cursor SET last_key = ''",
  // Tickets (0024) first: the ticket_* children reference tickets, and tickets
  // references persons(handle) (and, from 0025, sprints(id)) — so the whole tree
  // clears before anything it points at. tickets_fts needs no DELETE: the
  // tickets_fts_ad trigger cascades the `DELETE FROM tickets` into the index.
  "DELETE FROM ticket_events",
  "DELETE FROM ticket_comments",
  "DELETE FROM ticket_links",
  "DELETE FROM ticket_assignees",
  "DELETE FROM tickets",
  // Artifacts (0030): children first — versions, links and upload tokens all
  // reference artifact_pages(id). artifacts_fts needs no DELETE: the
  // artifacts_fts_ad trigger cascades the page DELETE into the index.
  "DELETE FROM artifact_upload_tokens",
  "DELETE FROM doc_image_upload_tokens",
  "DELETE FROM doc_images",
  "DELETE FROM artifact_links",
  "DELETE FROM artifact_versions",
  "DELETE FROM artifact_pages",
  "DELETE FROM processed_items",
  // Handoffs + Prompt Library (0028): prompt_versions references prompts(slug).
  "DELETE FROM handoffs",
  "DELETE FROM prompt_versions",
  "DELETE FROM prompts",
  "DELETE FROM pr_summaries",
  "DELETE FROM issue_summaries",
  "DELETE FROM events",
  // Repo dashboard capture (0027) — no FKs in or out.
  "DELETE FROM repo_events",
  "DELETE FROM repo_snapshots",
  "DELETE FROM repo_metrics",
  "DELETE FROM sprint_progress",
  "DELETE FROM plan_versions",
  "DELETE FROM plan WHERE org_id <> 'org_saplinglearn'",
  "INSERT OR IGNORE INTO plan (org_id, narrative, current_version) VALUES ('org_saplinglearn', '', 0)",
  "UPDATE plan SET narrative = '', current_version = 0, updated_at = NULL, updated_by = NULL",
  // sprint_resources references sprints(id), so it clears first (as do the
  // tickets above, whose soft sprint_id points here). milestone_proposals is
  // gone — 0025 dropped the table with the whole proposal surface.
  "DELETE FROM sprint_resources",
  "DELETE FROM sprints",
  "DELETE FROM doc_versions",
  "DELETE FROM docs",
  "DELETE FROM feed",
  "DELETE FROM entry_tags",
  "DELETE FROM adrs",
  "DELETE FROM needs_triage",
  "DELETE FROM identity_tasks",
  "DELETE FROM notification_outbox_bodies",
  "DELETE FROM notification_outbox",
  "DELETE FROM notification_prefs",
  "DELETE FROM notification_policy",
  "DELETE FROM notification_settings WHERE org_id <> 'org_saplinglearn'",
  "INSERT OR IGNORE INTO notification_settings (org_id, send_hour, timezone, from_address) VALUES ('org_saplinglearn', 8, 'America/New_York', 'Trov <hello@trov.dev>')",
  "UPDATE notification_settings SET send_hour = 8, timezone = 'America/New_York', from_address = 'Trov <hello@trov.dev>' WHERE org_id = 'org_saplinglearn'",
  "DELETE FROM oauth_tokens",
  "DELETE FROM oauth_codes",
  "DELETE FROM oauth_grants",
  "DELETE FROM oauth_clients",
  "DELETE FROM sessions",
  "DELETE FROM mcp_tokens",
  "DELETE FROM identities",
  "DELETE FROM invites",
  "DELETE FROM orgs WHERE id NOT IN ('org_saplinglearn', 'org_b')",
  "DELETE FROM persons",
  // The dev/test person seed (was the `people` map): the four engineers, each with their github identity…
  "INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('AndresL230', 'Andres', 'moss', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('Jose-Gael-Cruz-Lopez', 'Jose', 'sky', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('lpcooper-arch', 'Luke', 'fern', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('Darkest-Teddy', 'Jack', 'plum', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  "INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', 'AndresL230', 'AndresL230', 'AndresL230', '2026-01-01T00:00:00Z', 'seed'), ('github', 'Jose-Gael-Cruz-Lopez', 'Jose-Gael-Cruz-Lopez', 'Jose-Gael-Cruz-Lopez', '2026-01-01T00:00:00Z', 'seed'), ('github', 'lpcooper-arch', 'lpcooper-arch', 'lpcooper-arch', '2026-01-01T00:00:00Z', 'seed'), ('github', 'Darkest-Teddy', 'Darkest-Teddy', 'Darkest-Teddy', '2026-01-01T00:00:00Z', 'seed')",
  // …plus two NON-ENGINEER staff (the tickets build): Google-only, so they have
  // no github identity and can never collide with an event's subject_login. They
  // are the queue's requesters — the people filing tickets who don't ship code.
  "INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('meilin', 'Meilin Zhao', 'rose', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('sanaok', 'Sana Okafor', 'ochre', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
  "INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('google', 'google-sub-meilin', 'meilin@saplinglearn.org', 'meilin', '2026-01-01T00:00:00Z', 'seed'), ('google', 'google-sub-sanaok', 'sanaok@saplinglearn.org', 'sanaok', '2026-01-01T00:00:00Z', 'seed')",
  // …each with a profile (0036): a role, and the responsibilities an agent reads through
  // MCP `list_people` when it chooses assignees. Illustrative, not the real team's.
  "UPDATE persons SET role = 'Founding engineer', responsibilities = 'Trov itself: the Worker, D1 migrations, MCP tools and auth. Deploys and production incidents.' WHERE handle = 'AndresL230'",
  "UPDATE persons SET role = 'Backend engineer', responsibilities = 'The Sapling API on Railway: the tutor, quizzes and the RAG pipeline. LLM cost and backend errors.' WHERE handle = 'Jose-Gael-Cruz-Lopez'",
  "UPDATE persons SET role = 'Frontend engineer', responsibilities = 'The Sapling web app: study screens, flashcards, onboarding, accessibility and bundle size.' WHERE handle = 'lpcooper-arch'",
  "UPDATE persons SET role = 'Infrastructure engineer', responsibilities = 'CI, the Cloudflare Workers builds, environments and health checks, the metrics endpoint.' WHERE handle = 'Darkest-Teddy'",
  "UPDATE persons SET role = 'Product manager', responsibilities = 'The roadmap and sprint planning, user research, triage of incoming requests.' WHERE handle = 'meilin'",
  "UPDATE persons SET role = 'Community lead', responsibilities = 'Student and teacher support, community content, bug reports from users.' WHERE handle = 'sanaok'",
  // …and the system person 0032 seeds: the GitHub mirror's fallback requester.
  // The DELETE FROM persons above wipes the migration's row, so it is re-seeded here.
  "INSERT INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('github-webhook', 'GitHub', 'stone', '2026-09-24T00:00:00Z', '2026-09-24T00:00:00Z')",
  // The two seed orgs (multitenancy): SaplingLearn holds the six persons above — what 0037 produces from
  // them, AndresL230 its owner — and `org_b` (Acme) is the empty neighbour the isolation suite fills.
  "INSERT OR IGNORE INTO orgs (id, slug, name, created_at, created_by) VALUES ('org_saplinglearn', 'saplinglearn', 'SaplingLearn', '2026-10-06T00:00:00.000Z', 'migration'), ('org_b', 'acme', 'Acme', '2026-10-06T00:00:00.000Z', 'migration')",
  "INSERT INTO memberships (org_id, user_id, role, title, responsibilities, created_at, created_by) SELECT 'org_saplinglearn', handle, CASE WHEN handle = 'AndresL230' THEN 'owner' ELSE 'member' END, role, responsibilities, created_at, 'seed' FROM persons WHERE handle <> 'github-webhook'",
  "INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) SELECT 'org_saplinglearn', subject, person, linked_at, 'seed' FROM identities WHERE provider = 'github'",
  "UPDATE identities SET verified_email = lower(label) WHERE provider = 'google'",
  // …and the one superadmin (0042), as production has it: the SaplingLearn owner.
  "INSERT INTO platform_admins (person, granted_at, granted_by) VALUES ('AndresL230', '2026-10-06T00:00:00.000Z', 'seed')",
];
