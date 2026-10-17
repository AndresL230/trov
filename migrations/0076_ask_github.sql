-- 0076_ask_github — orgs.ai_chat_github, the organization's switch for Ask Trov's GitHub lookups.
--
-- ADDITIVE: one new column, nothing else touched. Ask Trov can read an organization's CONNECTED repositories on
-- GitHub (files, pull requests and their changes, issues, commits, checks) to answer a question, and what it reads
-- goes to Anthropic (docs/architecture/ask.md › GitHub). An admin turns that on or off for the whole organization in
-- Org settings › AI (`PUT /api/o/:slug/ai/settings { chatGithub }`, a cookie route — never MCP), audited
-- `org.ai_chat_github`. It stacks: the AI switch (`ai_automation`) AND this AND each person's own GitHub access.
-- OFF for every org, existing and new: no organization starts sending source code to Anthropic until an admin
-- chooses it.
--
-- Rollback (by hand, with `wrangler rollback` to the Worker from before it; loses the admins' choices):
--   ALTER TABLE orgs DROP COLUMN ai_chat_github;
--   DELETE FROM d1_migrations WHERE name = '0076_ask_github.sql';

ALTER TABLE orgs ADD COLUMN ai_chat_github INTEGER NOT NULL DEFAULT 0 CHECK (ai_chat_github IN (0, 1));
