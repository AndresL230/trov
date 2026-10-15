-- 0074_releases — a repository's releases and tags (Repo setups, Phase F).
--
-- ADDITIVE: one new table, no rebuild, nothing removed. What it holds and who writes it:
--
--   releases   one row per (org, repository, tag): a published GitHub release (`source = 'release'`) or a bare
--              tag with no release (`source = 'tag'`). Captured ONLY through the gate (`ingestRepoRelease`,
--              src/consumer.ts — content-hash dedupe: a redelivery, an edit that changes nothing or a reconcile
--              that re-reads the same list writes nothing):
--                • the `release` webhook — published / released / prereleased / edited → upsert; deleted /
--                  unpublished → the row goes; a DRAFT is never captured;
--                • the `create` webhook with ref_type `tag` → a tag row, unless a release row already holds it
--                  (a release is never downgraded to a tag);
--                • reconcile's `releases` arm (src/repo/releases.ts) — the 30 newest releases, and, when the
--                  repository has none, its 30 newest tags (one GraphQL request: REST /tags carries no date).
--              `published_at` is GitHub's own instant (a release's `published_at`, an annotated tag's tagger
--              date, a lightweight tag's commit date, a `create` delivery's `repository.pushed_at`) — never the
--              time Trov saw it. `author` is a GitHub LOGIN, exactly like `repo_events.actor_login` — NOT a
--              handle, so it is not in HANDLE_COLUMNS (the read maps it to a person through `identities` /
--              `org_login_map`). `notes` is the release body, cut to 4,000 characters; the read shortens it.
--              `sha` is the tagged commit when GitHub said it (a tag's target; a release whose
--              `target_commitish` is a full sha), else NULL. `content_hash` is the gate's dedupe key.
--
-- Read by `readRelease` / `readTags` / `releaseWeekFigure` (src/repo/releases.ts) for the Repo Overview's facts.
-- Goes with the org (src/deletion/tables.ts ORG_TABLES). Rollback: DROP TABLE releases;

CREATE TABLE IF NOT EXISTS releases (
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  repo           TEXT NOT NULL COLLATE NOCASE,      -- `owner/name` as org_repos.repo_full_name spells it
  tag            TEXT NOT NULL,                     -- the git tag, case-sensitive like git's
  name           TEXT,                              -- the release's title (NULL for a bare tag)
  published_at   TEXT NOT NULL,
  author         TEXT,                              -- a GitHub login (not a handle column)
  notes          TEXT,
  is_prerelease  INTEGER NOT NULL DEFAULT 0 CHECK (is_prerelease IN (0, 1)),
  is_draft       INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
  sha            TEXT,
  source         TEXT NOT NULL CHECK (source IN ('release', 'tag')),
  content_hash   TEXT NOT NULL,
  captured_at    TEXT NOT NULL,
  PRIMARY KEY (org_id, repo, tag)
);
CREATE INDEX IF NOT EXISTS idx_releases_published ON releases(org_id, repo, published_at);
