import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { all, run, nowIso } from "../src/db";
import { renamePerson, HANDLE_COLUMNS, getPerson } from "../src/auth/persons";
import { seedPerson, cookieFor } from "./helpers/persons";
import { createSession } from "../src/auth/session";
import { mintToken } from "../src/auth/tokens";
import { createInvite, acceptInvite } from "../src/auth/invites";
import { ingestEvent, ingestFeedEntry } from "../src/consumer";
import { createPage as createArtifact, setStatus as setArtifactStatus, ratify as ratifyArtifact, mintUploadToken, deletePage as deleteArtifact } from "../src/tools/artifacts";
import { write_plan } from "../src/tools/plan";
import {
  append_feed, propose_doc_update, stage_adr,
  route_triage, resolve_triage,
  ensure_identity_task, map_identity,
} from "../src/tools/writes";
import { create_ticket, add_ticket_comment } from "../src/tools/tickets";

import { systemCtx } from "./helpers/tenant";
const post = (path: string, c: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { cookie: c, "content-type": "application/json" }, body: JSON.stringify(body) }, env);

/** Seed one row per HANDLE_COLUMNS entry that references `handle` — real writers
 *  where one exists, minimal direct inserts otherwise. */
async function seedEveryHandleColumn(handle: string): Promise<void> {
  await seedPerson(handle); // persons + identities.person (github identity)
  await createSession(env.DB, handle); // sessions.person
  await mintToken(env.DB, handle); // mcp_tokens.person
  await append_feed(env.DB, { author: handle, summary: "did a thing" }); // feed.author
  await propose_doc_update(
    env.DB,
    { slug: "rename-test-doc", section: "reference", title: "T", body: "b", change_summary: "s", confidence: "high" },
    handle
  ); // docs.updated_by + docs.owner (0035) + doc_versions.created_by
  await stage_adr(env.DB, { title: "t", context: "c", decision: "d", rationale: "r", confidence: "high" }, handle); // adrs.created_by
  // sprints.created_by + sprints.lead — the admin plan write is the real writer
  // of both (0025 added `lead`; the proposal path that used to create these rows
  // is gone along with the whole proposal queue).
  await write_plan(
    systemCtx(),
    { narrative: "n", sprints: [{ label: "Rename test sprint", due: "2026-01-01", status: "upcoming", lead: handle }] },
    handle
  );
  const tid = await route_triage(env.DB, { raw: "x", reason: "y" });
  await resolve_triage(env.DB, tid, handle); // needs_triage.resolved_by
  // needs_triage.source_author: route an out-of-vocab feed entry through the REAL
  // gate (src/consumer.ts ingestFeedEntry), not a direct insert — this is the
  // actual writer of that column on every triage-routing path.
  await ingestFeedEntry(
    env.DB,
    { summary: "bad", body: "b", tags: ["not-a-real-tag"], artifacts: { prs: [], commits: [], issues: [] } },
    handle
  ); // needs_triage.source_author
  await ensure_identity_task(env.DB, "unmapped-login-1");
  await map_identity(env.DB, "unmapped-login-1", handle, handle); // identities.linked_by + identity_tasks.resolved_by
  await ingestEvent(
    env.DB,
    { semantic_key: "gh:pr:777:merged", event_type: "pr_merged", ref_number: 777, subject_login: "someone-else", raw: "{}", provenance: "backfill" },
    handle
  ); // events.recorded_by
  await write_plan(systemCtx(), { narrative: "n", sprints: [] }, handle); // plan.updated_by + plan_versions.created_by
  // Tickets (0024): tickets.requester + ticket_assignees.login + ticket_links.created_by
  // + ticket_comments.author + ticket_events.actor — all five through the REAL
  // writers (src/tools/tickets.ts, Phase 2). create_ticket alone covers requester,
  // the assignee, the link and the OPENING event row; the comment writer covers
  // ticket_comments.author.
  const ticketId = await create_ticket(
    systemCtx(),
    {
      title: "Rename test ticket", body: "b", category: "other", priority: "normal",
      assignees: [handle], link: "#1",
    },
    handle
  );
  await add_ticket_comment(systemCtx(), ticketId, "looking into it", handle);
  await run(env.DB, `INSERT INTO notification_policy (kind, default_cadence, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`,
    "rename_test_kind", "off", 1, nowIso(), handle); // notification_policy.updated_by
  await run(env.DB, `INSERT INTO notification_prefs (user_id, kind, cadence, updated_at) VALUES (?, ?, ?, ?)`,
    handle, "rename_test_kind", "off", nowIso()); // notification_prefs.user_id
  await run(env.DB, `INSERT INTO notification_outbox (idempotency_key, user_id, cadence, window_id, kinds, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `${handle}:daily:w1`, handle, "daily", "w1", "[]", "pending", nowIso()); // notification_outbox.user_id
  await createInvite(env.DB, { email: "old-me-invite@test.io", name: null, invitedBy: handle }); // invites.invited_by
  await acceptInvite(env.DB, "old-me-invite@test.io", handle); // invites.accepted_by
  // Artifacts (0030), through the REAL writers (src/tools/artifacts.ts): the create
  // covers artifact_pages.author_id + artifact_versions.created_by + (with a link)
  // artifact_links.created_by; publish + ratify covers ratified_by; a minted upload
  // token covers artifact_upload_tokens.principal.
  const art = await createArtifact(env.DB, {
    title: "Rename test artifact", kind: "markdown", area: "ui", content: "# hi",
    links: [{ target_type: "ticket", target_ref: String(ticketId) }],
  }, handle);
  await setArtifactStatus(env.DB, art.slug, "published", handle);
  await ratifyArtifact(env.DB, art.slug, 1, handle);
  await mintUploadToken(env.DB, { kind: "file", size_bytes: 1, sha256: "e".repeat(64), title: "Rename test upload", area: "ui" }, handle);
  // artifact_pages.deleted_by (0035 PART D): a second page, soft-deleted by the person.
  const gone = await createArtifact(env.DB, { title: "Rename test deleted artifact", kind: "markdown", area: "ui", content: "# bye" }, handle);
  await deleteArtifact(env.DB, gone.slug, handle, false);
  // Handoffs + Prompt Library (0028): direct inserts for sender / recipient /
  // claimed_by and the prompt's author plus its version's (the real writers
  // take the principal from auth, which this seed does not have).
  await run(env.DB, `INSERT INTO handoffs (sender, recipient, status, body, created_at, claimed_at, claimed_by, expires_at) VALUES (?, ?, 'claimed', 'b', ?, ?, ?, ?)`,
    handle, handle, nowIso(), nowIso(), handle, nowIso());
  await run(env.DB, `INSERT INTO prompts (slug, title, author, current_version, created_at, updated_at) VALUES (?, 'T', ?, 1, ?, ?)`, "rename-test", handle, nowIso(), nowIso());
  await run(env.DB, `INSERT INTO prompt_versions (slug, version, status, author, body, created_at) VALUES (?, 1, 'published', ?, 'b', ?)`, "rename-test", handle, nowIso());
  // prompts.deleted_by (0035 PART C): a second prompt, soft-deleted by the person.
  await run(env.DB, `INSERT INTO prompts (slug, title, author, current_version, created_at, updated_at, deleted_at, deleted_by) VALUES (?, 'T', ?, 1, ?, ?, ?, ?)`, "rename-test-deleted", handle, nowIso(), nowIso(), nowIso(), handle);
  // oauth_grants.person + oauth_codes.person (0029) — direct inserts; the writer
  // (issueAuthorization) needs a registered client, seeded here too.
  await run(env.DB, `INSERT OR IGNORE INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ('rename-client', 'C', '["http://localhost/cb"]', ?)`, nowIso());
  const grant = await run(env.DB, `INSERT INTO oauth_grants (person, client_id, client_name, created_at) VALUES (?, 'rename-client', 'C', ?)`, handle, nowIso());
  await run(env.DB, `INSERT INTO oauth_codes (code_hash, client_id, person, grant_id, redirect_uri, code_challenge, created_at, expires_at) VALUES (?, 'rename-client', ?, ?, 'http://localhost/cb', 'x', ?, ?)`,
    `rename-code-${handle}`, handle, grant.meta.last_row_id, nowIso(), nowIso());
  // Multitenancy (0037): every org table that stores a handle — direct inserts; their writers land in
  // later phases. One org the person created, their membership, an invite they sent and answered, an
  // attribution they made, and the integration rows they last touched.
  const org = `org_rename_${handle.replace(/[^a-z0-9]/g, "")}`;
  await run(env.DB, `INSERT INTO orgs (id, slug, name, created_at, created_by) VALUES (?, ?, 'Rename', ?, ?)`, org, `rn-${handle}`, nowIso(), handle);
  await run(env.DB, `INSERT INTO memberships (org_id, user_id, role, created_at, created_by) VALUES (?, ?, 'owner', ?, ?)`, org, handle, nowIso(), handle);
  await run(env.DB, `INSERT INTO org_invites (org_id, github_login, invited_by, status, created_at, responded_at, responded_by) VALUES (?, 'someone', ?, 'accepted', ?, ?, ?)`, org, handle, nowIso(), nowIso(), handle);
  await run(env.DB, `INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, 'rename-gh', ?, ?, ?)`, org, handle, nowIso(), handle);
  await run(env.DB, `INSERT INTO org_repos (id, org_id, repo_full_name, created_at, created_by) VALUES (?, ?, 'o/r', ?, ?)`, `hook_${org}`, org, nowIso(), handle);
  await run(env.DB, `INSERT INTO org_environments (org_id, key, position, label, branch, created_at, updated_at, updated_by) VALUES (?, 'staging', 0, 'staging', 'main', ?, ?, ?)`, org, nowIso(), nowIso(), handle);
  await run(env.DB, `INSERT INTO org_keys (org_id, key_version, wrapped_key, wrap_iv, kek_fingerprint, created_at) VALUES (?, 1, 'k', 'iv', 'fp', ?)`, org, nowIso());
  await run(env.DB, `INSERT INTO org_secrets (org_id, kind, scope, ciphertext, iv, key_version, created_by, created_at) VALUES (?, 'github_token', '', 'c', 'iv', 1, ?, ?)`, org, handle, nowIso());
  await run(env.DB, `INSERT INTO org_integration_config (org_id, kind, scope, config, updated_at, updated_by) VALUES (?, 'cloudflare_analytics', '', '{}', ?, ?)`, org, nowIso(), handle);
  await run(env.DB, `INSERT INTO org_audit (org_id, actor, action, target, at) VALUES (?, ?, 'secret.set', 'github_token:', ?)`, org, handle, nowIso());
  await run(env.DB, `INSERT INTO platform_admins (person, granted_at, granted_by) VALUES (?, ?, ?)`, handle, nowIso(), handle); // 0042
}

describe("renamePerson", () => {
  it("rewrites every HANDLE_COLUMNS entry atomically, and leaves referential integrity intact", async () => {
    await seedEveryHandleColumn("old-me");

    const result = await renamePerson(env.DB, "old-me", "new-me");
    expect(result).toEqual({ ok: true });

    for (const [table, column] of HANDLE_COLUMNS) {
      const oldCount = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, "old-me");
      const newCount = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, "new-me");
      expect(oldCount[0].n, `${table}.${column} still has an old-me row`).toBe(0);
      expect(newCount[0].n, `${table}.${column} has no new-me row`).toBeGreaterThanOrEqual(1);
    }

    expect(await getPerson(env.DB, "new-me")).not.toBeNull();
    expect(await getPerson(env.DB, "old-me")).toBeNull();

    const fkViolations = await all(env.DB, `PRAGMA foreign_key_check`);
    expect(fkViolations).toEqual([]);
  });

  it("rewrites the sprint handle columns (0025): created_by AND the new lead", async () => {
    // Literal, not read out of HANDLE_COLUMNS — same reasoning as the ticket test
    // below. `sprints.lead` is a soft TEXT handle: no FK would catch a miss.
    await seedEveryHandleColumn("old-me");
    for (const column of ["created_by", "lead"] as const) {
      const seeded = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM sprints WHERE ${column} = ?`, "old-me");
      expect(seeded[0].n, `sprints.${column} was never seeded`).toBe(1);
      expect(HANDLE_COLUMNS.some(([t, c]) => t === "sprints" && c === column), `sprints.${column} missing from HANDLE_COLUMNS`).toBe(true);
    }

    expect(await renamePerson(env.DB, "old-me", "new-me")).toEqual({ ok: true });

    for (const column of ["created_by", "lead"] as const) {
      const old = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM sprints WHERE ${column} = ?`, "old-me");
      const now = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM sprints WHERE ${column} = ?`, "new-me");
      expect(old[0].n, `sprints.${column} still points at old-me`).toBe(0);
      expect(now[0].n, `sprints.${column} was not rewritten to new-me`).toBe(1);
    }
  });

  it("rewrites the ticket handle columns (0024)", async () => {
    // Listed literally, NOT read out of HANDLE_COLUMNS: the test above iterates
    // that constant, so dropping an entry from it would silently stop being
    // checked there. Four of these five are soft TEXT handles with no FK to
    // catch them either — this is what makes them revert-sensitive.
    const TICKET_HANDLE_COLUMNS = [
      ["tickets", "requester"],
      ["ticket_assignees", "login"],
      ["ticket_links", "created_by"],
      ["ticket_comments", "author"],
      ["ticket_events", "actor"],
    ] as const;

    await seedEveryHandleColumn("old-me");
    for (const [table, column] of TICKET_HANDLE_COLUMNS) {
      const seeded = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, "old-me");
      expect(seeded[0].n, `${table}.${column} was never seeded`).toBe(1);
      expect(HANDLE_COLUMNS.some(([t, c]) => t === table && c === column), `${table}.${column} missing from HANDLE_COLUMNS`).toBe(true);
    }

    expect(await renamePerson(env.DB, "old-me", "new-me")).toEqual({ ok: true });

    for (const [table, column] of TICKET_HANDLE_COLUMNS) {
      const old = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, "old-me");
      const now = await all<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, "new-me");
      expect(old[0].n, `${table}.${column} still points at old-me`).toBe(0);
      expect(now[0].n, `${table}.${column} was not rewritten to new-me`).toBe(1);
    }
  });

  it("is case-insensitive: a same-value-different-case target is rejected as 'same', a genuinely different value renames", async () => {
    // The default seeded person (test/helpers seed) is "AndresL230" — check the
    // case-insensitive "same" rejection against it before mutating it.
    expect(await renamePerson(env.DB, "andresl230", "AndresL230")).toEqual({ ok: false, reason: "same" });

    expect(await renamePerson(env.DB, "AndresL230", "andres")).toEqual({ ok: true });
    expect(await getPerson(env.DB, "andres")).not.toBeNull();
    expect(await getPerson(env.DB, "AndresL230")).toBeNull();
  });

  it("refuses: taken, invalid, reserved, not_found", async () => {
    await seedPerson("old-me");
    await seedPerson("Taken-Person"); // mixed case, like a migrated GitHub login

    // "taken" is case-insensitive: a validly-formatted (lowercase) target still
    // collides with an existing person stored in a different case.
    expect(await renamePerson(env.DB, "old-me", "taken-person")).toEqual({ ok: false, reason: "taken" });
    expect(await renamePerson(env.DB, "old-me", "Admin")).toEqual({ ok: false, reason: "invalid" });
    expect(await renamePerson(env.DB, "old-me", "admin")).toEqual({ ok: false, reason: "reserved" });
    expect(await renamePerson(env.DB, "no-such-person", "some-new-handle")).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("POST /auth/me/handle", () => {
  it("renames the signed-in person; the same cookie keeps working; then refuses same/taken; 401 without a cookie", async () => {
    const cookie = await cookieFor("old-me");

    const res = await post("/auth/me/handle", cookie, { handle: "new-me" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handle: "new-me" });

    const me = await app.request("/auth/me", { headers: { cookie } }, env);
    expect(me.status).toBe(200);
    expect((await me.json() as { handle: string }).handle).toBe("new-me");

    const same = await post("/auth/me/handle", cookie, { handle: "new-me" });
    expect(same.status).toBe(400);
    expect(await same.json()).toEqual({ error: "handle_same" });

    // "andresl230" is a validly-formatted (lowercase) handle that case-insensitively
    // collides with the default seeded "AndresL230" — a "taken" refusal, not "invalid".
    const taken = await post("/auth/me/handle", cookie, { handle: "andresl230" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "handle_taken" });

    const noCookie = await app.request("/auth/me/handle", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ handle: "whoever" }) }, env);
    expect(noCookie.status).toBe(401);
  });

  it("400 invalid payload on a bad body", async () => {
    const cookie = await cookieFor("old-me");
    const res = await app.request("/auth/me/handle", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "not json" }, env);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid payload" });
  });
});

describe("POST /auth/me/handle — admin guard", () => {
  it("403s when the old handle is admin-allowlisted and the new one isn't; row unchanged", async () => {
    const cookie = await cookieFor("admin-user");
    const res = await post("/auth/me/handle", cookie, { handle: "someone" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "admin_handle_not_allowlisted" });
    expect(await getPerson(env.DB, "admin-user")).not.toBeNull();
    expect(await getPerson(env.DB, "someone")).toBeNull();
  });

  it("the case-insensitive 'same' check runs before the admin guard: an admin re-submitting their own handle gets 400, not 403", async () => {
    const cookie = await cookieFor("admin-user");
    const res = await post("/auth/me/handle", cookie, { handle: "admin-user" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "handle_same" });
  });
});

describe("GET /auth/handle-check (session, no onboard cookie)", () => {
  it("200 with a session cookie; 401 with neither", async () => {
    const cookie = await cookieFor("old-me");
    const res = await app.request("/auth/handle-check?handle=free-handle", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: true });

    const none = await app.request("/auth/handle-check?handle=free-handle", {}, env);
    expect(none.status).toBe(401);
  });
});
