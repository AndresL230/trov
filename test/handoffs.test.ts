// Handoffs + Prompt Library (0028): the session-cookie routes, the atomic claim,
// the box filters, the expiry sweep, FTS search and the docs/propose route —
// over the dev seed's fixtures (the same ones `npm run seed` loads locally).
import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { app } from "../src/routes";
import { cookieFor } from "./helpers/persons";
import { buildSeedStatements } from "../scripts/seed/build.mjs";
import { all, first, run } from "./helpers/db";
import { handleRepoCron } from "../src/repo/cron";
import { expireDueHandoffs } from "../src/platform/sweeps";
import type { Env } from "../src/env";
import handoffs from "../fixtures/dev/handoffs.json";
import prompts from "../fixtures/dev/prompts.json";
import type { HandoffView, PromptSummary, PromptDetail, PromptVersion } from "../shared/handoffs";
import { platformCtx, systemCtx } from "./helpers/tenant";

beforeEach(async () => {
  for (const stmt of buildSeedStatements({ handoffs, prompts })) await env.DB.prepare(stmt).run();
});

const req = async (path: string, who = "AndresL230", body?: unknown) =>
  app.request(path, body === undefined
    ? { headers: { cookie: await cookieFor(who) } }
    : { method: "POST", headers: { cookie: await cookieFor(who), "content-type": "application/json" }, body: JSON.stringify(body) }, env);
const json = async <T>(res: Response) => (await res.json()) as T;

describe("GET /api/handoffs — boxes", () => {
  it("mine = sent by or left for the caller, newest first, numeric ids, context parsed", async () => {
    const { handoffs: list } = await json<{ handoffs: HandoffView[] }>(await req("/api/handoffs"));
    expect(list.every((h) => typeof h.id === "number")).toBe(true);
    expect(list.every((h) => h.sender === "AndresL230" || h.recipient === "AndresL230")).toBe(true);
    expect(list.map((h) => h.id)).toContain(13);     // sent by me
    expect(list.map((h) => h.id)).not.toContain(15); // Teddy → anyone
    const sorted = [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    expect(list.map((h) => h.id)).toEqual(sorted.map((h) => h.id));
    const quiz = list.find((h) => h.id === 17)!;
    expect(quiz.context.next.length).toBe(4);
    expect(quiz.prompt?.title).toBe("Harden the quiz agent prompt and add an eval");
    expect(Object.keys(quiz).sort()).toEqual(["body", "claimed_at", "claimed_by", "claimed_by_session", "context", "created_at", "id", "prompt", "recipient", "sender", "status"]);
  });

  it("me / anyone / sent each return their slice; an unknown box is a 400", async () => {
    const ids = async (box: string, who = "AndresL230") => (await json<{ handoffs: HandoffView[] }>(await req(`/api/handoffs?box=${box}`, who))).handoffs.map((h) => h.id).sort();
    expect(await ids("me")).toEqual([11, 14, 16, 17]);
    expect(await ids("anyone")).toEqual([15]);
    expect(await ids("sent")).toEqual([12, 13]);
    expect(await ids("anyone", "Darkest-Teddy")).toEqual([12]); // Teddy's own 'anyone' handoff is not in his anyone box
    expect((await req("/api/handoffs?box=nope")).status).toBe(400);
  });

  it("one by id; a non-numeric or unknown id is a 404; no session is a 401", async () => {
    const { handoff } = await json<{ handoff: HandoffView }>(await req("/api/handoffs/14"));
    expect(handoff.claimed_by_session).toBe("sess_01J8ZK4QX2M7");
    expect((await req("/api/handoffs/h_8a47")).status).toBe(404);
    expect((await req("/api/handoffs/999")).status).toBe(404);
    expect((await app.request("/api/handoffs", {}, env)).status).toBe(401);
  });
});

describe("POST /api/handoffs", () => {
  it("creates with the principal as sender (a body `sender` is ignored), defaults, +7d expiry, and a feed entry", async () => {
    const res = await req("/api/handoffs", "Jose-Gael-Cruz-Lopez", { body: "Parser half done.\n\nMore here.", sender: "AndresL230" });
    expect(res.status).toBe(200);
    const { ok, handoff } = await json<{ ok: boolean; handoff: HandoffView }>(res);
    expect(ok).toBe(true);
    expect(handoff.sender).toBe("Jose-Gael-Cruz-Lopez");
    expect(handoff.recipient).toBe("anyone");
    expect(handoff.status).toBe("pending");
    expect(handoff.context).toEqual({ repo: "", branch: "", task: "", done: [], next: [], files: [] });
    expect(handoff.prompt).toBeNull();
    const row = await first<{ created_at: string; expires_at: string }>(env.DB, `SELECT created_at, expires_at FROM handoffs WHERE id = ?`, handoff.id);
    expect(Date.parse(row!.expires_at) - Date.parse(row!.created_at)).toBe(7 * 24 * 60 * 60 * 1000);
    const feed = await first<{ summary: string; author: string }>(env.DB, `SELECT summary, author FROM feed ORDER BY id DESC LIMIT 1`);
    expect(feed).toEqual({ author: "Jose-Gael-Cruz-Lopez", summary: `Jose-Gael-Cruz-Lopez left a handoff for anyone: #${handoff.id} Parser half done.` });
  });

  it("validates recipient, body size, and prompt both-or-neither", async () => {
    expect((await req("/api/handoffs", "AndresL230", { body: "x", recipient: "nobody-here" })).status).toBe(400);
    expect((await req("/api/handoffs", "AndresL230", { body: "" })).status).toBe(400);
    expect((await req("/api/handoffs", "AndresL230", { body: "x".repeat(32 * 1024 + 1) })).status).toBe(400);
    expect((await req("/api/handoffs", "AndresL230", { body: "x", prompt: { title: "only a title" } })).status).toBe(400);
    const ok = await json<{ handoff: HandoffView }>(await req("/api/handoffs", "AndresL230", { body: "x", recipient: "lpcooper-arch", prompt: { title: "T", body: "B" } }));
    expect(ok.handoff.recipient).toBe("lpcooper-arch");
    expect(ok.handoff.prompt).toEqual({ title: "T", body: "B" });
  });

  it("a repeated session + item_index returns the first handoff instead of writing a second", async () => {
    const payload = { body: "Retry me", session: { id: "sess-replay-1" }, item_index: 0 };
    const a = await json<{ handoff: HandoffView }>(await req("/api/handoffs", "AndresL230", payload));
    const b = await json<{ handoff: HandoffView }>(await req("/api/handoffs", "AndresL230", payload));
    expect(b.handoff.id).toBe(a.handoff.id);
    expect((await all(env.DB, `SELECT id FROM handoffs WHERE body = 'Retry me'`)).length).toBe(1);
  });
});

describe("claim / expire", () => {
  it("two concurrent claims: exactly one 200, the other 409 'handoff is claimed'", async () => {
    const [a, b] = await Promise.all([
      req("/api/handoffs/15/claim", "AndresL230", { session: "s-a" }),
      req("/api/handoffs/15/claim", "Jose-Gael-Cruz-Lopez", { session: "s-b" }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(await json(loser)).toEqual({ error: "handoff is claimed" });
    const row = await first<{ status: string; claimed_by_session: string }>(env.DB, `SELECT status, claimed_by_session FROM handoffs WHERE id = 15`);
    expect(row!.status).toBe("claimed");
    expect(["s-a", "s-b"]).toContain(row!.claimed_by_session);
  });

  it("only the recipient (or anyone, or the sender) may claim; others get 403 and nothing changes", async () => {
    expect((await req("/api/handoffs/16/claim", "lpcooper-arch", { session: "x" })).status).toBe(403); // Jose → Andres
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM handoffs WHERE id = 16`))!.status).toBe("pending");
    const own = await req("/api/handoffs/13/claim", "AndresL230", { session: "mine" }); // sender claims their own
    expect(own.status).toBe(200);
    expect((await json<{ handoff: HandoffView }>(own)).handoff.claimed_by).toBe("AndresL230");
    expect((await req("/api/handoffs/999/claim", "AndresL230", { session: "x" })).status).toBe(404);
  });

  it("expire: sender or recipient only, pending only", async () => {
    expect((await req("/api/handoffs/17/expire", "lpcooper-arch", {})).status).toBe(403);
    const ok = await req("/api/handoffs/17/expire", "AndresL230", {});
    expect(ok.status).toBe(200);
    expect((await json<{ handoff: HandoffView }>(ok)).handoff.status).toBe("expired");
    const again = await req("/api/handoffs/17/expire", "AndresL230", {});
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: "handoff is expired" });
  });
});

describe("expiry sweep", () => {
  it("flips pending handoffs past expires_at, leaves the rest", async () => {
    await run(env.DB, `UPDATE handoffs SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 16`);
    expect(await expireDueHandoffs(platformCtx("system"), Date.now())).toBe(1);
    const st = await all<{ id: number; status: string }>(env.DB, `SELECT id, status FROM handoffs WHERE id IN (16, 17) ORDER BY id`);
    expect(st).toEqual([{ id: 16, status: "expired" }, { id: 17, status: "pending" }]);
  });

  it("runs on every repo cron tick (D1 only)", async () => {
    await run(env.DB, `UPDATE handoffs SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = 17`);
    const noFetch = (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch;
    await handleRepoCron({ ...(env as unknown as Env), REPO_ENVIRONMENTS: undefined } as Env, Date.parse("2026-09-23T13:40:00Z"), noFetch);
    expect((await first<{ status: string }>(env.DB, `SELECT status FROM handoffs WHERE id = 17`))!.status).toBe("expired");
  });
});

describe("GET /api/prompts", () => {
  const list = async (qs = "") => (await json<{ prompts: PromptSummary[] }>(await req(`/api/prompts${qs}`))).prompts;

  it("lists the library at each prompt's latest version, excerpted, without bodies", async () => {
    const all8 = await list();
    expect(all8.length).toBe(8);
    const lint = all8.find((p) => p.slug === "lesson-mdx-lint")!;
    expect(lint.version).toBe(3);
    expect(lint.status).toBe("staged");
    expect(lint.excerpt).toBe("Lint the Sapling lesson at {{lesson_path}}.");
    expect(Object.keys(lint).sort()).toEqual(["author", "excerpt", "last_used_at", "slug", "status", "tags", "title", "updated_at", "use_count", "version"]);
  });

  it("q is FTS over slug, title and body; tags are ANDed; sort flips", async () => {
    expect((await list("?q=supabase")).map((p) => p.slug)).toEqual(["supabase-migration-review"]);        // title/slug
    expect((await list("?q=heartbeat")).map((p) => p.slug)).toEqual(["sse-endpoint-review"]);             // body, latest version
    expect((await list("?q=ocr-failure-triage")).map((p) => p.slug)).toContain("ocr-failure-triage");      // slug
    expect((await list("?tags=data,infra")).map((p) => p.slug)).toEqual(["supabase-migration-review"]);
    const asc = await list("?sort=updated_asc");
    expect(asc.map((p) => p.slug)).toEqual((await list()).map((p) => p.slug).reverse());
  });

  it("one prompt, its versions newest first, and 404s", async () => {
    const { prompt } = await json<{ prompt: PromptDetail }>(await req("/api/prompts/sse-endpoint-review"));
    expect(prompt.body).toContain("Last-Event-ID");
    const { versions } = await json<{ versions: PromptVersion[] }>(await req("/api/prompts/sse-endpoint-review/versions"));
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await req("/api/prompts/nope")).status).toBe(404);
    expect((await req("/api/prompts/nope/versions")).status).toBe(404);
  });
});

describe("POST /api/prompts (a person)", () => {
  it("creates v1 as a draft by default, appends versions, may publish directly and rename the slug", async () => {
    const created = await json<{ prompt: PromptDetail }>(await req("/api/prompts", "AndresL230", { slug: "new-one", title: "New one", tags: ["API", "api", " ui "], body: "Do {{x}}." }));
    expect(created.prompt).toMatchObject({ slug: "new-one", version: 1, status: "draft", author: "AndresL230", tags: ["api", "ui"] });
    const v2 = await json<{ prompt: PromptDetail }>(await req("/api/prompts", "Darkest-Teddy", { slug: "renamed-one", base_slug: "new-one", title: "Renamed", tags: [], body: "Do {{y}}.", status: "published" }));
    expect(v2.prompt).toMatchObject({ slug: "renamed-one", version: 2, status: "published", author: "AndresL230" });
    expect((await req("/api/prompts/new-one")).status).toBe(404);
    const versions = (await json<{ versions: PromptVersion[] }>(await req("/api/prompts/renamed-one/versions"))).versions;
    expect(versions.map((v) => [v.version, v.author, v.summary])).toEqual([[2, "Darkest-Teddy", "Edited in Trov"], [1, "AndresL230", "Created in Trov"]]);
    expect((await json<{ prompts: PromptSummary[] }>(await req("/api/prompts?q=renamed"))).prompts.map((p) => p.slug)).toEqual(["renamed-one"]);
  });

  it("a rename onto a taken slug is a 409; a bad slug is a 400", async () => {
    expect((await req("/api/prompts", "AndresL230", { slug: "adr-draft", base_slug: "pr-summary-structured", title: "x", tags: [], body: "b" })).status).toBe(409);
    expect((await req("/api/prompts", "AndresL230", { slug: "Bad Slug", title: "x", tags: [], body: "b" })).status).toBe(400);
  });

  it("tags replaces (normalised); publish flips a staged version, else 409 'not staged'", async () => {
    const t = await json<{ prompt: PromptDetail }>(await req("/api/prompts/adr-draft/tags", "AndresL230", { tags: ["Data", "data", "ui"] }));
    expect(t.prompt.tags).toEqual(["data", "ui"]);
    const pub = await req("/api/prompts/lesson-mdx-lint/publish", "AndresL230", { version: 3 });
    expect(pub.status).toBe(200);
    expect((await json<{ prompt: PromptDetail }>(pub)).prompt.status).toBe("published");
    const again = await req("/api/prompts/lesson-mdx-lint/publish", "AndresL230", { version: 3 });
    expect(again.status).toBe(409);
    expect(await json(again)).toEqual({ error: "not staged" });
  });
});

describe("POST /api/docs/propose", () => {
  it("stages a version-1 'new' proposal through the gate; an existing slug is a 409", async () => {
    const res = await req("/api/docs/propose", "AndresL230", { title: "Handoff etiquette", section: "reference", space: "technical", body: "# Handoff etiquette\n\nOne per session." });
    expect(res.status).toBe(200);
    const { ok, proposal } = await json<{ ok: boolean; proposal: { slug: string; version: number; change_kind: string; status: string } }>(res);
    expect(ok).toBe(true);
    expect(proposal).toMatchObject({ slug: "handoff-etiquette", version: 1, change_kind: "new", status: "staged" });
    const doc = await first<{ current_version: number }>(env.DB, `SELECT current_version FROM docs WHERE slug = 'handoff-etiquette'`);
    expect(doc?.current_version ?? 0).toBe(0); // not live until promoted
    expect((await req("/api/docs/propose", "AndresL230", { title: "Handoff etiquette", section: "reference", space: "technical", body: "again" })).status).toBe(409);
    expect((await req("/api/docs/propose", "AndresL230", { title: "X", section: "not-a-section", space: "technical", body: "b" })).status).toBe(400);
  });
});
