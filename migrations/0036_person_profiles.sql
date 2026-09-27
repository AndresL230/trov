-- 0036_person_profiles — person profiles (2026-09-27): a custom avatar photo, a role, and
-- responsibilities. All three are nullable and never backfilled.
--
--   avatar_sha        the SHA-256 (64 lowercase hex) of an avatar the person UPLOADED. The bytes
--                     live in R2 (ARTIFACTS_BUCKET) at `avatars/<sha>` and are served by
--                     `GET /avatar/<sha>`. It OUTRANKS `avatar_url` (the provider's picture, which
--                     `recordSignIn` still refreshes at every sign-in): the DTO's `avatar_url` is
--                     `/avatar/<avatar_sha>` when set, else `avatar_url`. Clearing it falls back to
--                     the provider picture, then to initials.
--   role              a short title shown on the profile and the people list ("Backend engineer").
--   responsibilities  what the person owns and should be assigned, in plain words. NOT shown on
--                     the profile — it is for agents (MCP `list_people` / `get_person`) deciding
--                     whom to assign, and for the person and admins who edit it.
ALTER TABLE persons ADD COLUMN avatar_sha TEXT CHECK (avatar_sha IS NULL OR (length(avatar_sha) = 64 AND avatar_sha NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE persons ADD COLUMN role TEXT;
ALTER TABLE persons ADD COLUMN responsibilities TEXT;
