// The organization's tag list — its rules (src/tools/tags.ts) and its cookie routes (src/tags/routes.ts).
// 0054_org_tags; docs/architecture/feed-and-search.md › Tags.
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { PLANS, LIMITS } from "@shared/plans";
import { STARTER_TAGS, type TagListDTO, type TagPageDTO } from "@shared/tags-core";
import { ingestFeedEntry } from "../src/consumer";
import { RoleError } from "../src/data/context";
import { createOrg } from "../src/orgs/repo";
import { PlanLimitError } from "../src/plans/state";
import { get_feed } from "../src/tools/reads";
import {
  TagError, addTag, editTag, listTags, liveTagNames, mergeTag, resolveSuggestion, restoreTag, retireTag, setItemTags, tagPage,
} from "../src/tools/tags";
import { append_feed, assign_triage, route_triage, stage_adr } from "../src/tools/writes";
import { all, first } from "./helpers/db";
import { call } from "./helpers/orgs";
import { cookieFor, FIXTURE_ADMIN } from "./helpers/persons";
import { ORG_A, ORG_B, platformCtx, systemCtx, tenantCtx } from "./helpers/tenant";

const OWNER = "AndresL230";
const MEMBER = "casey";
const artifacts = { prs: [], commits: [], issues: [] };
const entry = (summary: string, tags: string[]) => ({ summary, body: "b", tags, artifacts });
const admin = () => tenantCtx(OWNER);
const feedTags = async (id: number, org = ORG_A) => (await all<{ tag: string }>(env.DB,
  `SELECT tag FROM entry_tags WHERE org_id = ? AND entry_type = 'feed' AND entry_id = ? ORDER BY tag`, org, String(id))).map((r) => r.tag);
const audit = (org = ORG_A) => all<{ actor: string; action: string; target: string; detail: string }>(env.DB,
  `SELECT actor, action, target, detail FROM org_admin_audit WHERE org_id = ? AND action LIKE 'tag.%' ORDER BY id`, org);
const names = async (org = ORG_A) => (await listTags(systemCtx(org))).tags.map((t) => t.name);
const code = async (p: Promise<unknown>): Promise<string> => p.then(() => "ok", (e) => (e instanceof TagError ? e.code : e instanceof RoleError ? "forbidden" : e instanceof PlanLimitError ? "plan_limit" : String(e)));

describe("the list", () => {
  it("every org starts with the six starter tags, and a NEW org gets them when it is created", async () => {
    for (const org of [ORG_A, ORG_B]) {
      const list = await listTags(systemCtx(org));
      expect(list.tags.map(({ name, description, color, starter, retired }) => ({ name, description, color, starter, retired })))
        .toEqual(STARTER_TAGS.map((t) => ({ ...t, starter: true, retired: false })));
      expect(list.used).toBe(6);
    }
    const org = await createOrg(platformCtx(OWNER), { slug: "fresh", name: "Fresh", owner: OWNER, plan: { id: "free", overrides: {}, source: "granted" } });
    const rows = await all<{ name: string; starter: number }>(env.DB, `SELECT name, starter FROM org_tags WHERE org_id = ? ORDER BY id`, org.id);
    expect(rows).toEqual(STARTER_TAGS.map((t) => ({ name: t.name, starter: 1 })));
  });

  it("add: a new tag with its description and colour, audited; a duplicate and a malformed name are refused", async () => {
    const ctx = await admin();
    expect(await addTag(ctx, { name: " Customer Success ", description: "  What   customers ask for ", color: "ochre" })).toEqual({ name: "customer-success" });
    const t = (await listTags(ctx)).tags.find((x) => x.name === "customer-success");
    expect(t).toMatchObject({ description: "What customers ask for", color: "ochre", starter: false, retired: false, counts: { feed: 0, doc: 0, adr: 0 } });
    expect(await audit()).toEqual([{ actor: OWNER, action: "tag.add", target: "customer-success", detail: "{}" }]);

    expect(await code(addTag(ctx, { name: "customer success" }))).toBe("tag_exists");
    expect(await code(addTag(ctx, { name: "no/slashes" }))).toBe("invalid");
    expect(await code(addTag(ctx, { name: "x".repeat(33) }))).toBe("invalid");
    expect(await code(addTag(ctx, { name: "ok", color: "neon" }))).toBe("invalid");
    expect(await code(addTag(ctx, { name: "ok", description: "d".repeat(121) }))).toBe("invalid");
    expect((await audit()).length).toBe(1);
  });

  it("rename keeps every tagged item tagged — a starter too — and moves the feed filter with it", async () => {
    const ctx = await admin();
    const a = await append_feed(systemCtx(), { author: OWNER, summary: "one", tags: ["auth", "ui"] });
    const b = await append_feed(systemCtx(), { author: OWNER, summary: "two", tags: ["auth"] });

    expect(await editTag(ctx, "auth", { name: "Identity", description: "Who you are", color: "moss" })).toEqual({ name: "identity" });
    expect(await feedTags(a)).toEqual(["identity", "ui"]);
    expect(await feedTags(b)).toEqual(["identity"]);
    expect(await names()).toEqual(["identity", "architecture", "infra", "api", "ui", "data"]);
    const t = (await listTags(ctx)).tags[0];
    expect(t).toMatchObject({ name: "identity", description: "Who you are", color: "moss", starter: true, counts: { feed: 2, doc: 0, adr: 0 } });
    expect((await get_feed(systemCtx(), { tags: ["identity"] })).length).toBe(2);
    expect((await get_feed(systemCtx(), { tags: ["auth"] })).length).toBe(0);
    expect((await audit()).map((r) => [r.action, r.target, r.detail])).toEqual([
      ["tag.rename", "identity", JSON.stringify({ from: "auth" })],
      ["tag.edit", "identity", JSON.stringify({ fields: ["description", "color"] })],
    ]);
    // The old word is no longer a tag: an agent that still sends it gets a suggestion.
    expect(await ingestFeedEntry(systemCtx(), entry("late", ["auth"]), OWNER)).toMatchObject({ outcome: "written", tags: [], suggested_tags: ["auth"] });
    expect(await code(editTag(ctx, "identity", { name: "ui" }))).toBe("tag_exists");
    expect(await code(editTag(ctx, "nope", { name: "x" }))).toBe("not_found");
  });

  it("merge moves the items (no duplicates), retires the source pointing at the target; a starter cannot be merged away", async () => {
    const ctx = await admin();
    await addTag(ctx, { name: "login" });
    const both = await append_feed(systemCtx(), { author: OWNER, summary: "both", tags: ["login", "auth"] });
    const one = await append_feed(systemCtx(), { author: OWNER, summary: "one", tags: ["login"] });

    expect(await mergeTag(ctx, "login", "auth")).toEqual({ name: "auth", moved: 2 });
    expect(await feedTags(both)).toEqual(["auth"]);
    expect(await feedTags(one)).toEqual(["auth"]);
    const list = await listTags(ctx);
    expect(list.tags.find((t) => t.name === "login")).toMatchObject({ retired: true, counts: { feed: 0, doc: 0, adr: 0 } });
    expect(list.used).toBe(6); // the merged tag no longer counts
    expect(await first<{ merged_into: string }>(env.DB, `SELECT merged_into FROM org_tags WHERE org_id = ? AND name = 'login'`, ORG_A)).toEqual({ merged_into: "auth" });
    expect((await audit()).at(-1)).toMatchObject({ action: "tag.merge", target: "login", detail: JSON.stringify({ into: "auth", moved: 2 }) });

    expect(await code(mergeTag(ctx, "ui", "auth"))).toBe("starter_tag");
    expect(await code(mergeTag(ctx, "ui", "ui"))).toBe("invalid");
    expect(await code(mergeTag(ctx, "login", "nowhere"))).toBe("unknown_tag");
  });

  it("retire is soft: the tag stays on its items, cannot be picked, and can be restored; a starter cannot be retired", async () => {
    const ctx = await admin();
    await addTag(ctx, { name: "mobile" });
    const id = await append_feed(systemCtx(), { author: OWNER, summary: "phone", tags: ["mobile"] });

    await retireTag(ctx, "mobile");
    expect(await feedTags(id)).toEqual(["mobile"]);               // stays on what already has it
    expect(await liveTagNames(ctx)).not.toContain("mobile");       // can no longer be picked
    expect(await code(setItemTags(ctx, "feed", String(id), ["mobile", "ui"]))).toBe("ok");   // …but an item that has it keeps it
    const other = await append_feed(systemCtx(), { author: OWNER, summary: "other" });
    expect(await code(setItemTags(ctx, "feed", String(other), ["mobile"]))).toBe("unknown_tag");
    expect(await code(addTag(ctx, { name: "mobile" }))).toBe("tag_retired");
    expect(await code(retireTag(ctx, "auth"))).toBe("starter_tag");

    await restoreTag(ctx, "mobile");
    expect(await liveTagNames(ctx)).toContain("mobile");
    expect((await audit()).map((r) => r.action)).toEqual(["tag.add", "tag.retire", "tag.restore"]);
  });

  it("only an admin or an owner changes the list; a member and a system context are refused, and nothing is written", async () => {
    const member = await tenantCtx(MEMBER, "member");
    const adminCtx = await tenantCtx(FIXTURE_ADMIN, "admin");
    await addTag(adminCtx, { name: "kept" });
    await ingestFeedEntry(systemCtx(), entry("s", ["wanted"]), OWNER);
    for (const ctx of [member, systemCtx()]) {
      expect(await code(addTag(ctx, { name: "nope" }))).toBe("forbidden");
      expect(await code(editTag(ctx, "kept", { name: "renamed" }))).toBe("forbidden");
      expect(await code(mergeTag(ctx, "kept", "auth"))).toBe("forbidden");
      expect(await code(retireTag(ctx, "kept"))).toBe("forbidden");
      expect(await code(restoreTag(ctx, "kept"))).toBe("forbidden");
      expect(await code(resolveSuggestion(ctx, "wanted", { resolution: "accept" }))).toBe("forbidden");
    }
    expect(await names()).toEqual([...STARTER_TAGS.map((t) => t.name), "kept"]);
    // A member reads the list, without what agents suggested; an admin sees it.
    expect((await listTags(member)).suggestions).toEqual([]);
    expect((await listTags(adminCtx)).suggestions.map((s) => s.name)).toEqual(["wanted"]);
  });

  it("the plan caps the list (PLANS → requirePlan): at the cap add, restore and accept are 402s; a retired tag frees a place", async () => {
    // The placeholder: the same number on every plan, and never below the six starters.
    expect(Object.values(PLANS).map((p) => p.entitlements.tags)).toEqual([30, 30, 30, 30]);
    expect(LIMITS.tags.min).toBe(6);

    await env.DB.prepare(`UPDATE orgs SET plan_overrides = ? WHERE id = ?`).bind(JSON.stringify({ tags: 7 }), ORG_A).run();
    const ctx = await admin();
    await addTag(ctx, { name: "seventh" });
    expect((await listTags(ctx))).toMatchObject({ used: 7, cap: 7 });
    expect(await code(addTag(ctx, { name: "eighth" }))).toBe("plan_limit");
    await ingestFeedEntry(systemCtx(), entry("s", ["wanted"]), OWNER);
    expect(await code(resolveSuggestion(ctx, "wanted", { resolution: "accept" }))).toBe("plan_limit");
    expect(await names()).not.toContain("wanted");
    // Mapping to an existing tag adds nothing to the list, so the cap does not stop it.
    expect(await code(resolveSuggestion(ctx, "wanted", { resolution: "map", into: "ui" }))).toBe("ok");

    await retireTag(ctx, "seventh");
    await addTag(ctx, { name: "eighth" });
    expect(await code(restoreTag(ctx, "seventh"))).toBe("plan_limit");
    // Another org's cap is its own.
    expect((await listTags(systemCtx(ORG_B)))).toMatchObject({ used: 6, cap: 30 });
  });
});

describe("suggestions", () => {
  const seed = async () => {
    const a = await ingestFeedEntry(systemCtx(), entry("a", ["ui", "billing"]), "casey");
    const b = await ingestFeedEntry(systemCtx(), entry("b", ["billing"]), OWNER);
    const c = await ingestFeedEntry(systemCtx(), entry("c", ["authn"]), OWNER);
    if (a.outcome !== "written" || b.outcome !== "written" || c.outcome !== "written") throw new Error("seed");
    return { a: a.id, b: b.id, c: c.id };
  };

  it("lists who used it, on what and how many times, and names a look-alike on the list", async () => {
    await seed();
    const { suggestions } = await listTags(await admin());
    expect(suggestions.map(({ name, counts, uses, by, similar }) => ({ name, counts, uses, by, similar }))).toEqual([
      { name: "billing", counts: { feed: 2, doc: 0, adr: 0 }, uses: 2, by: ["casey", OWNER], similar: null },
      { name: "authn", counts: { feed: 1, doc: 0, adr: 0 }, uses: 1, by: [OWNER], similar: "auth" },
    ]);
  });

  it("accept: the tag joins the list and is applied to the items that carried it", async () => {
    const { a, b } = await seed();
    const ctx = await admin();
    expect(await resolveSuggestion(ctx, "billing", { resolution: "accept" })).toEqual({ name: "billing", resolution: "accept", applied_to: 2, tag: "billing" });
    expect(await feedTags(a)).toEqual(["billing", "ui"]);
    expect(await feedTags(b)).toEqual(["billing"]);
    const list = await listTags(ctx);
    expect(list.tags.find((t) => t.name === "billing")).toMatchObject({ starter: false, counts: { feed: 2, doc: 0, adr: 0 } });
    expect(list.suggestions.map((s) => s.name)).toEqual(["authn"]);
    expect((await audit()).at(-1)).toMatchObject({ action: "tag.suggestion.accept", target: "billing", detail: JSON.stringify({ uses: 2 }) });
    expect(await code(resolveSuggestion(ctx, "billing", { resolution: "accept" }))).toBe("not_found"); // settled
  });

  it("map: the items get the existing tag instead; the suggested word never joins the list", async () => {
    const { c } = await seed();
    const ctx = await admin();
    expect(await resolveSuggestion(ctx, "authn", { resolution: "map", into: "auth" })).toMatchObject({ resolution: "map", applied_to: 1, tag: "auth" });
    expect(await feedTags(c)).toEqual(["auth"]);
    expect(await names()).not.toContain("authn");
    expect(await code(resolveSuggestion(ctx, "billing", { resolution: "map", into: "nowhere" }))).toBe("unknown_tag");
    expect((await audit()).at(-1)).toMatchObject({ action: "tag.suggestion.map", target: "authn", detail: JSON.stringify({ into: "auth", uses: 1 }) });
  });

  it("dismiss: nothing is tagged; a later use is a new suggestion", async () => {
    const { a } = await seed();
    const ctx = await admin();
    expect(await resolveSuggestion(ctx, "billing", { resolution: "dismiss" })).toMatchObject({ resolution: "dismiss", applied_to: 0, tag: null });
    expect(await feedTags(a)).toEqual(["ui"]);
    expect((await listTags(ctx)).suggestions.map((s) => s.name)).toEqual(["authn"]);
    await ingestFeedEntry(systemCtx(), entry("again", ["billing"]), OWNER);
    expect((await listTags(ctx)).suggestions.find((s) => s.name === "billing")).toMatchObject({ uses: 1 });
  });

  it("adding by hand a tag that agents had suggested applies it too", async () => {
    const { a } = await seed();
    await addTag(await admin(), { name: "billing" });
    expect(await feedTags(a)).toEqual(["billing", "ui"]);
    expect((await listTags(await admin())).suggestions.map((s) => s.name)).toEqual(["authn"]);
  });

  it("isolation: org B's admin never sees or settles org A's suggestions", async () => {
    await seed();
    const b = await tenantCtx("bea", "admin", { orgId: ORG_B });
    expect((await listTags(b)).suggestions).toEqual([]);
    expect(await code(resolveSuggestion(b, "billing", { resolution: "accept" }))).toBe("not_found");
    expect(await names(ORG_B)).not.toContain("billing");
    expect((await listTags(await admin())).suggestions.length).toBe(2);
  });

  it("Unplaced: an old item triaged for an unknown tag is placed as a feed entry, its unknown tag a suggestion; a PICKED tag must be on the list", async () => {
    const id = await route_triage(systemCtx(), { raw: entry("held", ["ui", "billing"]), reason: "unknown tag: billing", source_author: "casey" });
    expect(await code(assign_triage(systemCtx(), id, OWNER, { type: "feed", tags: ["billing"] }))).toMatch(/unknown tag: billing/);
    const res = await assign_triage(systemCtx(), id, OWNER, { type: "feed" });
    const feedId = Number(res.assigned_ref.replace("feed:", ""));
    expect(await feedTags(feedId)).toEqual(["ui"]);
    expect((await listTags(await admin())).suggestions.map((s) => s.name)).toEqual(["billing"]);
  });
});

describe("a tag's page and an item's tags", () => {
  it("groups everything that carries the tag: feed entries, docs, decisions — with what it is seen with and who writes about it", async () => {
    const ctx = await admin();
    const member = await tenantCtx(MEMBER, "member");
    const f = await append_feed(systemCtx(), { author: "casey", summary: "Sign-in fixed", brief: "People with two accounts get in.", tags: ["auth", "ui"] });
    await env.DB.prepare(`INSERT INTO docs (org_id, slug, section, title, body, current_version, updated_at, updated_by) VALUES (?, 'how-sign-in-works', 'reference', 'How sign-in works', 'b', 1, '2026-10-01T00:00:00Z', ?)`).bind(ORG_A, OWNER).run();
    const adr = await stage_adr(systemCtx(), { title: "Sessions live in a cookie", context: "c", decision: "d", rationale: "r", confidence: "high" }, OWNER, "h1");
    // Any member tags an item; the tag must be the org's.
    expect(await setItemTags(member, "doc", "how-sign-in-works", ["Auth"])).toEqual(["auth"]);
    expect(await setItemTags(member, "adr", String(adr), ["auth", "data"])).toEqual(["auth", "data"]);
    expect(await code(setItemTags(member, "doc", "how-sign-in-works", ["made-up"]))).toBe("unknown_tag");
    expect(await code(setItemTags(member, "doc", "no-such-doc", ["auth"]))).toBe("not_found");
    expect(await code(setItemTags(member, "ticket", "1", ["auth"]))).toBe("invalid");

    const page = (await tagPage(ctx, "auth")) as TagPageDTO;
    expect(page.tag).toMatchObject({ name: "auth", counts: { feed: 1, doc: 1, adr: 1 } });
    expect(page.items.feed).toEqual([{ type: "feed", id: String(f), title: "Sign-in fixed", note: "People with two accounts get in.", by: "casey", at: expect.any(String), tags: ["ui"] }]);
    expect(page.items.doc).toEqual([{ type: "doc", id: "how-sign-in-works", title: "How sign-in works", note: "reference", by: OWNER, at: "2026-10-01T00:00:00Z", tags: [] }]);
    expect(page.items.adr).toMatchObject([{ type: "adr", id: String(adr), title: "Sessions live in a cookie", note: "draft", tags: ["data"] }]);
    expect(page.seen_with).toEqual([{ name: "data", count: 1 }, { name: "ui", count: 1 }]);
    // Who wrote what carries it, across the types: the doc's last editor and the decision's author too.
    expect(page.authors).toEqual([{ handle: OWNER, count: 2 }, { handle: "casey", count: 1 }]);
    expect(page.jev_added).toBe(0);
    expect(page.items.doc[0].jev).toBeUndefined();

    // An item Jev added the tag to says so (a run's provenance row), and only while it still has the tag.
    await env.DB.prepare(`INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, reason, suggested_by, suggested_at, state, resolved_to, resolved_at, resolved_by)
      VALUES (?, 'doc', 'how-sign-in-works', 'auth', 'model', 0.86, 'It explains sign-in.', 'system', '2026-10-13T00:00:00Z', 'accepted', 'auth', '2026-10-13T00:00:00Z', 'jev')`).bind(ORG_A).run();
    await env.DB.prepare(`INSERT INTO org_tag_suggestions (org_id, entry_type, entry_id, tag, source, confidence, suggested_by, suggested_at, state, resolved_to, resolved_at, resolved_by)
      VALUES (?, 'doc', 'gone', 'auth', 'model', 0.9, 'system', '2026-10-13T00:00:00Z', 'accepted', 'auth', '2026-10-13T00:00:00Z', 'jev')`).bind(ORG_A).run();
    const withJev = (await tagPage(ctx, "auth")) as TagPageDTO;
    expect(withJev.jev_added).toBe(1);
    expect(withJev.items.doc[0].jev).toEqual({ confidence: 0.86, reason: "It explains sign-in.", at: "2026-10-13T00:00:00Z" });
    expect(withJev.items.feed[0].jev).toBeUndefined();
    expect(((await tagPage(systemCtx(ORG_B), "auth")) as TagPageDTO).jev_added).toBe(0);
    expect(await tagPage(ctx, "nope")).toBeNull();
    // Another org's page of the same starter tag is empty.
    expect(((await tagPage(systemCtx(ORG_B), "auth")) as TagPageDTO).tag.counts).toEqual({ feed: 0, doc: 0, adr: 0 });

    // Replacing an item's tags removes the ones left out.
    expect(await setItemTags(member, "adr", String(adr), [])).toEqual([]);
    expect(((await tagPage(ctx, "auth")) as TagPageDTO).items.adr).toEqual([]);
  });
});

describe("cookie routes", () => {
  const BASE = "/api/o/saplinglearn";

  it("any member reads the list and a tag's page; only an admin gets the suggestions", async () => {
    await ingestFeedEntry(systemCtx(), entry("s", ["wanted"]), OWNER);
    const [member, owner] = [await cookieFor(MEMBER), await cookieFor(OWNER)];
    const asMember = await call<TagListDTO>("GET", `${BASE}/tags`, member);
    expect(asMember.status).toBe(200);
    expect(asMember.json.tags.length).toBe(6);
    expect(asMember.json).toMatchObject({ used: 6, cap: 30, suggestions: [] });
    expect((await call<TagListDTO>("GET", `${BASE}/tags`, owner)).json.suggestions.map((s) => s.name)).toEqual(["wanted"]);
    expect((await call<TagPageDTO>("GET", `${BASE}/tags/auth`, member)).json.tag.name).toBe("auth");
    expect((await call("GET", `${BASE}/tags/nope`, member)).status).toBe(404);
    // The alias for a person with one org answers the same.
    expect((await call<TagListDTO>("GET", `/api/tags`, member)).json.tags.length).toBe(6);
  });

  it("a member's write is a 403 with nothing written; an admin's goes through, at both mounts", async () => {
    const [member, owner] = [await cookieFor(MEMBER), await cookieFor(OWNER)];
    for (const [method, path, body] of [
      ["POST", "/tags", { name: "nope" }], ["PUT", "/tags/auth", { name: "identity" }], ["POST", "/tags/auth/merge", { into: "ui" }],
      ["POST", "/tags/auth/retire", {}], ["POST", "/tags/auth/restore", {}], ["POST", "/tags/suggestions/x/resolve", { resolution: "dismiss" }],
    ] as const) {
      const res = await call(method, `${BASE}${path}`, member, body);
      expect([res.status, res.json], `${method} ${path}`).toEqual([403, { error: "forbidden" }]);
    }
    expect(await names()).toEqual(STARTER_TAGS.map((t) => t.name));

    expect((await call("POST", `${BASE}/tags`, owner, { name: "billing", description: "Invoices" })).status).toBe(201);
    expect((await call("PUT", `/api/tags/billing`, owner, { name: "money" })).json).toEqual({ ok: true, name: "money" });
    expect((await call("POST", `${BASE}/tags/money/retire`, owner, {})).status).toBe(200);
    expect((await call("POST", `${BASE}/tags/money/restore`, owner, {})).status).toBe(200);
    expect((await call("POST", `${BASE}/tags/money/merge`, owner, { into: "data" })).json).toMatchObject({ ok: true, name: "data", moved: 0 });
    expect((await call("POST", `${BASE}/tags/auth/retire`, owner, {})).json).toMatchObject({ error: "starter_tag" });
    expect((await call("POST", `${BASE}/tags`, owner, { name: "bad name!" })).status).toBe(400);
  });

  it("never a token: a request carrying an Authorization header is refused, read or write", async () => {
    const owner = await cookieFor(OWNER);
    const headers = { authorization: "Bearer trov_mcp_whatever" };
    expect((await call("POST", `${BASE}/tags`, owner, { name: "viatoken" }, { headers })).status).toBe(403);
    expect((await call("POST", `${BASE}/item-tags`, owner, { type: "feed", id: "1", tags: [] }, { headers })).status).toBe(403);
    expect(await names()).not.toContain("viatoken");
  });

  it("the plan cap is the app's one 402 body", async () => {
    await env.DB.prepare(`UPDATE orgs SET plan_overrides = ? WHERE id = ?`).bind(JSON.stringify({ tags: 6 }), ORG_A).run();
    const res = await call("POST", `${BASE}/tags`, await cookieFor(OWNER), { name: "seventh" });
    expect(res.status).toBe(402);
    expect(res.json).toMatchObject({ error: "plan_limit", limit: "tags", used: 6, cap: 6 });
  });

  it("a member tags a doc through POST /item-tags, and the doc reads back with its tags", async () => {
    await env.DB.prepare(`INSERT INTO docs (org_id, slug, section, title, body, current_version) VALUES (?, 'd1', 'reference', 'D1', 'b', 1)`).bind(ORG_A).run();
    const member = await cookieFor(MEMBER);
    expect((await call("POST", `${BASE}/item-tags`, member, { type: "doc", id: "d1", tags: ["api", "data"] })).json).toEqual({ ok: true, tags: ["api", "data"] });
    expect((await call<{ tags: string[] }>("GET", `${BASE}/doc/d1`, member)).json.tags).toEqual(["api", "data"]);
    expect((await call("POST", `${BASE}/item-tags`, member, { type: "doc", id: "d1", tags: ["made-up"] })).json).toMatchObject({ error: "unknown_tag" });
  });
});
