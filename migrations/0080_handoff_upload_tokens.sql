-- 0080_handoff_upload_tokens — a handoff whose prompt is UPLOADED instead of typed into the tool call.
--
-- ADDITIVE: one new table and one index; nothing existing is touched. MCP `send_handoff` with the upload form
-- (`prompt: { title, sha256, size_bytes }`) writes NO handoff: it stores the whole pending handoff here — the
-- sender (the bearer principal), the recipient, body, context, the prompt's title and the declared sha256 +
-- size of its text, the session ledger key — and returns a single-use PUT link. `PUT /api/artifacts/upload/
-- <token>` (the route artifacts and doc images already use; src/artifacts/upload.ts) checks the bytes against
-- the declared size and sha256 and only then creates the handoff (src/tools/handoffs.ts
-- `consumeHandoffUploadToken`), so a half-made handoff is never in anyone's inbox. Only the token's SHA-256 is
-- stored, as for `artifact_upload_tokens`; the TTL is the artifact uploads' (5 minutes).
--
-- Org-keyed (ORG_TABLES), `principal` is a handle (HANDLE_COLUMNS). Rows go once their window has closed, used
-- or not: the repo cron's every-tick sweep (`pruneHandoffUploadTokens`, src/platform/sweeps.ts).
--
-- Rollback: DROP TABLE IF EXISTS handoff_upload_tokens;

CREATE TABLE IF NOT EXISTS handoff_upload_tokens (
  token_hash   TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  principal    TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  body         TEXT NOT NULL,
  context      TEXT NOT NULL,
  prompt_title TEXT NOT NULL,
  sha256       TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes   INTEGER NOT NULL CHECK (size_bytes >= 1 AND size_bytes <= 32768),
  session_id   TEXT,
  link_base    TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  used_at      TEXT,
  created_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_handoff_upload_tokens_expires ON handoff_upload_tokens(expires_at);
