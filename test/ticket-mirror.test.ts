import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { all, first, run } from "../src/db";
import type { Env } from "../src/env";
import { handleGithubWebhook } from "../src/webhook";
import { ticketFromIssue, mirrorIssue } from "../src/tools/ticket-mirror";
import { runBackfill } from "../src/tools/backfill";
import { listOpenAssignedIssues } from "../src/tools/mywork";
import { transition_ticket } from "../src/tools/tickets";

// The GitHub issue → ticket mirror (0032). Every assertion reads ROWS — tickets,
// ticket_links, ticket_events, ticket_assignees, events — never a mock call.

const SECRET = "test-webhook-secret"; // matches vitest.config.ts binding
const REPO = "SaplingLearn/sapling";  // wrangler.toml's GITHUB_REPO, which the pool env carries

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "sha256=" + [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function deliver(payload: unknown, e: Env = env as unknown as Env, opts?: Parameters<typeof handleGithubWebhook>[2]): Promise<Response> {
  const body = JSON.stringify(payload);
  const req = new Request("https://x/webhook/github", {
    method: "POST",
    headers: { "x-github-event": "issues", "x-hub-signature-256": await sign(body), "content-type": "application/json" },
    body,
  });
  return handleGithubWebhook(req, e, { summarizer: null, issueSummarizer: null, ...opts });
}

interface IssueOpts {
  number?: number; title?: string; body?: string | null; state?: "open" | "closed"; state_reason?: string | null;
  updated_at?: string; author?: string; assignees?: string[]; labels?: string[]; repo?: string | null; pr?: boolean;
}
function issuePayload(action: string, o: IssueOpts = {}) {
  const number = o.number ?? 214;
  const repo = o.repo === undefined ? REPO : o.repo;
  return {
    action,
    ...(repo === null ? {} : { repository: { full_name: repo } }),
    issue: {
      number,
      title: o.title ?? "[P1] Login page times out",
      body: o.body === undefined ? "Steps to reproduce…" : o.body,
      html_url: `https://github.com/${repo ?? REPO}/issues/${number}`,
      state: o.state ?? "open",
      state_reason: o.state_reason ?? null,
      updated_at: o.updated_at ?? "2026-09-20T10:00:00Z",
      user: { login: o.author ?? "AndresL230" },
      assignees: (o.assignees ?? []).map((login) => ({ login })),
      labels: (o.labels ?? []).map((name) => ({ name })),
      milestone: null,
      ...(o.pr ? { pull_request: { url: "x" } } : {}),
    },
  };
}

interface T { id: number; title: string; body: string; status: string; priority: string; category: string; requester: string; source: string; source_ref: string | null; source_author: string | null; source_updated_at: string | null }
const tickets = () => all<T>(env.DB, `SELECT * FROM tickets ORDER BY id`);
const links = () => all<{ ticket_id: number; url: string; kind: string; label: string; locked: number; created_by: string }>(env.DB, `SELECT * FROM ticket_links ORDER BY id`);
const events = () => all<{ ticket_id: number; actor: string; from_status: string | null; to_status: string }>(env.DB, `SELECT * FROM ticket_events ORDER BY id`);
const assignees = () => all<{ ticket_id: number; login: string }>(env.DB, `SELECT ticket_id, login FROM ticket_assignees ORDER BY login`);
const counts = async () => ({ tickets: (await tickets()).length, links: (await links()).length, events: (await events()).length, assignees: (await assignees()).length });

describe("ticketFromIssue — the pure mapping", () => {
  it("strips the priority tag and maps P0/P1 → high, P2 → normal, P3 → low, none → normal", () => {
    const map = (title: string) => ticketFromIssue(issuePayload("opened", { title }))!;
    expect(map("[P0] a")).toMatchObject({ title: "a", priority: "high" });
    expect(map("[P1] b")).toMatchObject({ title: "b", priority: "high" });
    expect(map("[P2] c")).toMatchObject({ title: "c", priority: "normal" });
    expect(map("[P3] d")).toMatchObject({ title: "d", priority: "low" });
    expect(map("plain")).toMatchObject({ title: "plain", priority: "normal" });
    // No title tag: a P-label stands in (the repo tags priority by label too).
    expect(ticketFromIssue(issuePayload("opened", { title: "e", labels: ["P3"] }))!.priority).toBe("low");
  });

  it("maps label bug → bug, question → question, else other; body null → ''", () => {
    expect(ticketFromIssue(issuePayload("opened", { labels: ["Bug"] }))!.category).toBe("bug");
    expect(ticketFromIssue(issuePayload("opened", { labels: ["question"] }))!.category).toBe("question");
    expect(ticketFromIssue(issuePayload("opened", { labels: ["backend"] }))!.category).toBe("other");
    expect(ticketFromIssue(issuePayload("opened", { body: null }))!.body).toBe("");
  });

  it("final: completed → done, not_planned → declined, deleted/transferred → declined, open → null", () => {
    expect(ticketFromIssue(issuePayload("closed", { state: "closed", state_reason: "completed" }))!.final).toBe("done");
    expect(ticketFromIssue(issuePayload("closed", { state: "closed", state_reason: "not_planned" }))!.final).toBe("declined");
    expect(ticketFromIssue(issuePayload("deleted"))!.final).toBe("declined");
    expect(ticketFromIssue(issuePayload("transferred"))!.final).toBe("declined");
    expect(ticketFromIssue(issuePayload("opened"))!.final).toBeNull();
  });

  it("returns null for a PR on the issues event, a missing repository, or a non-object", () => {
    expect(ticketFromIssue(issuePayload("opened", { pr: true }))).toBeNull();
    expect(ticketFromIssue(issuePayload("opened", { repo: null }))).toBeNull();
    expect(ticketFromIssue("nope")).toBeNull();
  });
});

describe("the mirror, through the webhook", () => {
  it("an opened delivery creates exactly one ticket, one locked link and one opening event", async () => {
    const res = await deliver(issuePayload("opened"));
    expect(res.status).toBe(200);

    const [t] = await tickets();
    expect(await counts()).toEqual({ tickets: 1, links: 1, events: 1, assignees: 0 });
    expect(t).toMatchObject({
      title: "Login page times out", body: "Steps to reproduce…", priority: "high", category: "other",
      status: "submitted", requester: "AndresL230", source: "github", source_ref: `${REPO}#214`,
      source_author: "AndresL230", source_updated_at: "2026-09-20T10:00:00Z",
    });
    expect((await links())[0]).toMatchObject({
      ticket_id: t.id, url: `https://github.com/${REPO}/issues/214`, kind: "github", label: "sapling #214", locked: 1, created_by: "github-webhook",
    });
    expect((await events())[0]).toMatchObject({ ticket_id: t.id, actor: "github-webhook", from_status: null, to_status: "submitted" });
  });

  it("a redelivery of the same payload leaves every row count unchanged", async () => {
    await deliver(issuePayload("opened"));
    const before = await counts();
    await deliver(issuePayload("opened"));
    await deliver(issuePayload("opened"));
    expect(await counts()).toEqual(before);
  });

  it("an OLDER updated_at after a newer one writes nothing (the ordering guard)", async () => {
    await deliver(issuePayload("opened", { updated_at: "2026-09-20T10:00:00Z" }));
    await deliver(issuePayload("closed", { state: "closed", state_reason: "completed", updated_at: "2026-09-22T10:00:00Z" }));
    const before = { rows: await counts(), t: (await tickets())[0] };
    expect(before.t.status).toBe("done");

    // A reopen stamped BEFORE the close arrives late: it must not reopen.
    await deliver(issuePayload("reopened", { updated_at: "2026-09-21T10:00:00Z" }));
    expect(await counts()).toEqual(before.rows);
    expect((await tickets())[0]).toEqual(before.t);
  });

  it("closed+completed → done, not_planned → declined, reopened → submitted — each one github-webhook event row", async () => {
    await deliver(issuePayload("opened", { updated_at: "2026-09-20T10:00:00Z" }));
    await deliver(issuePayload("closed", { state: "closed", state_reason: "completed", updated_at: "2026-09-20T11:00:00Z" }));
    expect((await tickets())[0].status).toBe("done");
    await deliver(issuePayload("reopened", { updated_at: "2026-09-20T12:00:00Z" }));
    expect((await tickets())[0].status).toBe("submitted");
    await deliver(issuePayload("closed", { state: "closed", state_reason: "not_planned", updated_at: "2026-09-20T13:00:00Z" }));
    expect((await tickets())[0].status).toBe("declined");

    expect((await events()).map((e) => [e.actor, e.from_status, e.to_status])).toEqual([
      ["github-webhook", null, "submitted"],
      ["github-webhook", "submitted", "done"],
      ["github-webhook", "done", "submitted"],
      ["github-webhook", "submitted", "declined"],
    ]);
  });

  it("reopens a ticket with a mapped assignee to submitted too (Triage), from done", async () => {
    await deliver(issuePayload("opened", { assignees: ["Jose-Gael-Cruz-Lopez"], updated_at: "2026-09-20T10:00:00Z" }));
    expect((await tickets())[0].status).toBe("in_progress");
    await deliver(issuePayload("closed", { state: "closed", state_reason: "completed", assignees: ["Jose-Gael-Cruz-Lopez"], updated_at: "2026-09-20T11:00:00Z" }));
    await deliver(issuePayload("reopened", { assignees: ["Jose-Gael-Cruz-Lopez"], updated_at: "2026-09-20T12:00:00Z" }));
    expect((await tickets())[0].status).toBe("submitted");
  });

  it("a delivery from another repo, or with GITHUB_REPO unset, creates no ticket", async () => {
    await deliver(issuePayload("opened", { repo: "someone/else" }));
    await deliver(issuePayload("opened"), { ...(env as unknown as Env), GITHUB_REPO: undefined });
    await deliver(issuePayload("opened", { repo: null }));
    expect(await tickets()).toHaveLength(0);
    // …and the events capture still ran for all three.
    expect((await all(env.DB, `SELECT id FROM events`)).length).toBeGreaterThan(0);
  });

  it("an unmapped author files as github-webhook, and source_author keeps the raw login", async () => {
    await deliver(issuePayload("opened", { author: "some-outsider" }));
    expect((await tickets())[0]).toMatchObject({ requester: "github-webhook", source_author: "some-outsider" });
  });

  it("a mapped GitHub assignee lands as the person's handle; an unmapped one is dropped", async () => {
    await run(env.DB, `UPDATE identities SET subject = 'jose-gh' WHERE person = 'Jose-Gael-Cruz-Lopez' AND provider = 'github'`);
    await deliver(issuePayload("opened", { assignees: ["jose-gh", "stranger"] }));
    expect(await assignees()).toEqual([{ ticket_id: (await tickets())[0].id, login: "Jose-Gael-Cruz-Lopez" }]);
    expect((await tickets())[0].status).toBe("in_progress");
  });

  it("an open issue with only unmapped assignees is submitted", async () => {
    await deliver(issuePayload("opened", { assignees: ["stranger"] }));
    expect((await tickets())[0].status).toBe("submitted");
    expect(await assignees()).toEqual([]);
  });

  it("a mirror that throws still leaves the events row written and answers 200", async () => {
    const res = await deliver(issuePayload("opened"), env as unknown as Env, {
      mirror: async () => { throw new Error("D1 is on fire"); },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, captured: 1 });
    expect(await all(env.DB, `SELECT id FROM events WHERE ref_number = 214`)).toHaveLength(1);
    expect(await tickets()).toHaveLength(0);
  });

  it("heals on redelivery: a later delivery restores a missing locked link and opening row", async () => {
    await deliver(issuePayload("opened"));
    const before = await counts();
    await run(env.DB, `DELETE FROM ticket_links`);
    await run(env.DB, `DELETE FROM ticket_events`);
    await deliver(issuePayload("opened"));
    expect(await counts()).toEqual(before);
  });

  it("a deleted / transferred issue declines its ticket; one never mirrored creates nothing", async () => {
    await deliver(issuePayload("opened", { number: 1, updated_at: "2026-09-20T10:00:00Z" }));
    await deliver(issuePayload("deleted", { number: 1, updated_at: "2026-09-20T11:00:00Z" }));
    await deliver(issuePayload("transferred", { number: 2 }));
    const rows = await tickets();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("declined");
  });

  it("title, body, assignees and a person's status are Canopy's after import — later deliveries never overwrite them", async () => {
    await deliver(issuePayload("opened", { updated_at: "2026-09-20T10:00:00Z" }));
    const id = (await tickets())[0].id;
    await run(env.DB, `UPDATE tickets SET title = 'Canopy title', body = 'Canopy body' WHERE id = ?`, id);
    await transition_ticket(env.DB, id, "in_progress", "meilin");

    await deliver(issuePayload("edited", { title: "[P3] GitHub retitled", body: "GitHub body", updated_at: "2026-09-20T11:00:00Z" }));
    await deliver(issuePayload("assigned", { assignees: ["Darkest-Teddy"], updated_at: "2026-09-20T12:00:00Z" }));

    expect((await tickets())[0]).toMatchObject({ title: "Canopy title", body: "Canopy body", status: "in_progress", priority: "high", source_updated_at: "2026-09-20T12:00:00Z" });
    expect(await assignees()).toEqual([]);
  });

  it("a redelivery of an already-applied close does not undo a later status change in Canopy", async () => {
    await deliver(issuePayload("opened", { updated_at: "2026-09-20T10:00:00Z" }));
    await deliver(issuePayload("closed", { state: "closed", state_reason: "completed", updated_at: "2026-09-20T11:00:00Z" }));
    const id = (await tickets())[0].id;
    // A correction made in D1 after the close (done is terminal for the person-facing writers).
    await run(env.DB, `UPDATE tickets SET status = 'in_progress' WHERE id = ?`, id);
    const before = await counts();
    await deliver(issuePayload("closed", { state: "closed", state_reason: "completed", updated_at: "2026-09-20T11:00:00Z" }));
    expect((await tickets())[0].status).toBe("in_progress");
    expect(await counts()).toEqual(before);
  });
});

describe("capture changes for deleted / transferred", () => {
  it("a deleted issue leaves the To-do even though its snapshot still reads open", async () => {
    await deliver(issuePayload("assigned", { assignees: ["AndresL230"], updated_at: "2026-09-20T10:00:00Z" }));
    expect(await listOpenAssignedIssues(env.DB, ["AndresL230"])).toHaveLength(1);
    await deliver(issuePayload("deleted", { assignees: ["AndresL230"], updated_at: "2026-09-20T11:00:00Z" }));
    expect(await listOpenAssignedIssues(env.DB, ["AndresL230"])).toHaveLength(0);
  });

  it("the raw snapshot carries state_reason", async () => {
    await deliver(issuePayload("closed", { state: "closed", state_reason: "not_planned" }));
    const row = await first<{ raw: string }>(env.DB, `SELECT raw FROM events WHERE ref_number = 214`);
    expect(JSON.parse(row!.raw).issue.state_reason).toBe("not_planned");
  });
});

describe("mirrorIssue directly", () => {
  it("matches GITHUB_REPO without case, and keys the webhook's and a backfill's spelling to ONE ticket", async () => {
    // GitHub's own full_name for this repo is "SaplingLearn/Sapling"; wrangler.toml says "SaplingLearn/sapling".
    expect(await mirrorIssue(env.DB, REPO, issuePayload("opened", { repo: "SaplingLearn/Sapling" }))).toBe("created");
    expect(await mirrorIssue(env.DB, REPO, issuePayload("opened", { repo: REPO }))).toBe("unchanged");
    expect((await tickets()).map((t) => t.source_ref)).toEqual([`${REPO}#214`]);
  });

  it("is out of scope for an unset repo and a foreign one", async () => {
    expect(await mirrorIssue(env.DB, undefined, issuePayload("opened"))).toBe("out_of_scope");
    expect(await mirrorIssue(env.DB, "o/r", issuePayload("opened"))).toBe("out_of_scope");
    expect(await mirrorIssue(env.DB, REPO, issuePayload("opened"))).toBe("created");
    expect(await mirrorIssue(env.DB, REPO, issuePayload("opened"))).toBe("unchanged");
  });
});

describe("backfill hook", () => {
  function stubFetch(issues: unknown[]): typeof fetch {
    return (async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes("/issues") ? issues : [];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }
  const listItem = (number: number, state: "open" | "closed") => ({
    number, title: `Issue ${number}`, body: "b", html_url: `https://github.com/o/r/issues/${number}`, state,
    state_reason: state === "closed" ? "completed" : null, updated_at: "2026-09-20T10:00:00Z",
    user: { login: "AndresL230" }, assignees: [], labels: [], milestone: null,
  });

  it("mirrors open issues and skips closed ones", async () => {
    const e: Env = { ...(env as unknown as Env), GITHUB_SERVICE_TOKEN: "svc", GITHUB_REPO: "o/r" };
    const res = await runBackfill(e, "admin-user", {
      fetchImpl: stubFetch([listItem(1, "open"), listItem(2, "closed")]),
      summarizer: null, issueSummarizer: null, summaryCallDelayMs: 0,
    });
    expect(res.ok).toBe(true);
    expect((await tickets()).map((t) => t.source_ref)).toEqual(["o/r#1"]);
    expect(await links()).toHaveLength(1);
    // A second Sync over the same state writes nothing new.
    const before = await counts();
    await runBackfill(e, "admin-user", { fetchImpl: stubFetch([listItem(1, "open")]), summarizer: null, issueSummarizer: null, summaryCallDelayMs: 0 });
    expect(await counts()).toEqual(before);
  });
});
