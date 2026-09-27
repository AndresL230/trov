-- 0036_person_profiles — person profiles (2026-09-27), in ONE migration. Two parts:
--   PART A — a custom avatar photo, a role, and responsibilities.
--   PART B — the provider picture's owner: persons.avatar_source + its conservative backfill.
-- Tests re-run PART B's backfill by cutting the file at its marker line below.

-- ═══ PART A: avatar photo, role, responsibilities ═══════════════════════════════
-- All three are nullable and never backfilled.
--
--   avatar_sha        the SHA-256 (64 lowercase hex) of an avatar the person UPLOADED. The bytes
--                     live in R2 (ARTIFACTS_BUCKET) at `avatars/<sha>` and are served by
--                     `GET /avatar/<sha>`. It OUTRANKS `avatar_url` (the provider's picture, which
--                     `recordSignIn` refreshes only from its owner — PART B): the DTO's `avatar_url` is
--                     `/avatar/<avatar_sha>` when set, else `avatar_url`. Clearing it falls back to
--                     the provider picture, then to initials.
--   role              a short title shown on the profile and the people list ("Backend engineer").
--   responsibilities  what the person owns and should be assigned, in plain words. NOT shown on
--                     the profile — it is for agents (MCP `list_people` / `get_person`) deciding
--                     whom to assign, and for the person and admins who edit it.
ALTER TABLE persons ADD COLUMN avatar_sha TEXT CHECK (avatar_sha IS NULL OR (length(avatar_sha) = 64 AND avatar_sha NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE persons ADD COLUMN role TEXT;
ALTER TABLE persons ADD COLUMN responsibilities TEXT;

-- ═══ PART B: the provider picture's owner ═══════════════════════════════════════
-- A person with a GitHub AND a Google identity used to get the picture of whichever
-- provider they signed in with last: `recordSignIn` wrote `avatar_url` on every sign-in.
-- Now the picture belongs to ONE provider:
--
--   avatar_source  'github' | 'google' — the provider whose picture `avatar_url` is. Set by
--                  onboarding (`createPerson`) and by the first sign-in that fills a NULL
--                  picture. A sign-in with THAT provider may refresh the picture (their GitHub
--                  avatar changed); a sign-in with the OTHER provider never touches it. NULL =
--                  unknown owner, so the next sign-in with a picture claims it. Unlinking the
--                  owning provider resets it to NULL, so the remaining one takes over.
ALTER TABLE persons ADD COLUMN avatar_source TEXT CHECK (avatar_source IS NULL OR avatar_source IN ('github', 'google'));

-- Backfill, conservatively, from the picture's HOST (the text between `https://` and the next
-- `/`): GitHub serves avatars from avatars.githubusercontent.com, Google from a
-- *.googleusercontent.com host (lh3. today). Anything else — no picture, another host, not
-- https — stays NULL, and that person's next sign-in claims the picture.
UPDATE persons SET avatar_source = CASE
    WHEN lower(substr(avatar_url, 9, instr(substr(avatar_url, 9), '/') - 1)) = 'avatars.githubusercontent.com' THEN 'github'
    WHEN lower(substr(avatar_url, 9, instr(substr(avatar_url, 9), '/') - 1)) LIKE '%.googleusercontent.com' THEN 'google'
  END
  WHERE avatar_source IS NULL AND lower(substr(avatar_url, 1, 8)) = 'https://';
