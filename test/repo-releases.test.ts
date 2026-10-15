/**
 * Releases (Repo setups, Phase F; 0074_releases, src/repo/releases.ts): the `release` / `create` capture through the
 * gate's release arm (`ingestRepoRelease`), reconcile's `releases` arm (releases, else tags), and the reads the
 * Overview's facts take — `readRelease` (since, waiting, a feature ONLY by a `feat` prefix or a feature label,
 * cadence), `readTags`, `releaseWeekFigure`.
 */
import { describe, it, expect } from "vitest";
import { SCAN_COST } from "../src/repo/scan";
import { env } from "cloudflare:test";
import type { Env } from "../src/env";
import { all, first, run } from "./helpers/db";
import { ORG_A, ORG_B, systemCtx } from "./helpers/tenant";
import { fakeGithub } from "./helpers/repo";
import { ingestRepoRelease } from "../src/consumer";
import { captureDelivery } from "../src/webhook";
import { reconcileRepo } from "../src/repo/github";
import { reconcileCost, refreshSubrequests } from "../src/repo/cron";
import { LOGO_IMPORT_COST } from "../src/orgs/logo";
import { ORG_TABLES } from "../src/deletion/tables";
import {
  RELEASES_RECONCILE_COST, isFeaturePr, readRelease, readTags, reconcileReleases, releaseEventsFromDelivery,
  releaseNotesText, releaseWeekFigure, tagCapture,
} from "../src/repo/releases";
import type { ReleaseCapture } from "../src/repo/release-store";

const REPO = "acme/ui-kit";
const DAY = 86_400_000;
const NOW = Date.parse("2026-10-14T12:00:00Z");
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");

const ghRelease = (tag: string, daysAgo: number, extra: Record<string, unknown> = {}) => ({
  id: tag.length, tag_name: tag, name: `Release ${tag}`, draft: false, prerelease: false, target_commitish: "main",
  published_at: iso(daysAgo), created_at: iso(daysAgo), author: { login: "meilin-gh" }, body: `Notes for ${tag}.`,
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`, ...extra,
});

const releaseRows = () => all<{ tag: string; source: string; sha: string | null; published_at: string; author: string | null; is_prerelease: number; name: string | null }>(
  env.DB, `SELECT tag, source, sha, published_at, author, is_prerelease, name FROM releases WHERE org_id = ? ORDER BY published_at`, ORG_A);

const capture = (eventName: string, payload: unknown) =>
  captureDelivery(systemCtx(ORG_A, "github-webhook"), env as unknown as Env, { repo: REPO, githubToken: async () => null }, eventName, JSON.stringify(payload));

// ── capture ─────────────────────────────────────────────────────────────────

describe("the release / create capture", () => {
  it("published → a release row; a redelivery → unchanged (the gate's content hash); edited → updated; deleted → gone", async () => {
    const rel = ghRelease("v2.4.0", 9);
    const r1 = await capture("release", { action: "published", release: rel, repository: { full_name: REPO } });
    expect(await r1.json()).toEqual({ ok: true, captured: 0, unchanged: 0, repo: { captured: 1, unchanged: 0 } });
    expect(await releaseRows()).toEqual([{ tag: "v2.4.0", source: "release", sha: null, published_at: iso(9), author: "meilin-gh", is_prerelease: 0, name: "Release v2.4.0" }]);

    const again = await capture("release", { action: "published", release: rel, repository: { full_name: REPO } });
    expect((await again.json() as { repo: unknown }).repo).toEqual({ captured: 0, unchanged: 1 });
    // `released` restates the same release: nothing changed, nothing written.
    expect((await (await capture("release", { action: "released", release: rel })).json() as { repo: unknown }).repo).toEqual({ captured: 0, unchanged: 1 });

    const edited = await capture("release", { action: "edited", release: { ...rel, name: "Range mode", body: "New notes." } });
    expect((await edited.json() as { repo: unknown }).repo).toEqual({ captured: 1, unchanged: 0 });
    expect((await first<{ name: string; notes: string }>(env.DB, `SELECT name, notes FROM releases WHERE tag = 'v2.4.0'`))).toEqual({ name: "Range mode", notes: "New notes." });

    const deleted = await capture("release", { action: "deleted", release: rel });
    expect((await deleted.json() as { repo: unknown }).repo).toEqual({ captured: 1, unchanged: 0 });
    expect(await releaseRows()).toEqual([]);
    // Nothing reached repo_events: a release is its own row, not an append-only event.
    expect(await all(env.DB, `SELECT * FROM repo_events`)).toEqual([]);
  });

  it("a draft is never captured — created, edited, even 'published' with draft: true", async () => {
    const draft = ghRelease("v3.0.0", 1, { draft: true });
    for (const action of ["created", "edited", "published"]) {
      await capture("release", { action, release: draft });
    }
    expect(await releaseRows()).toEqual([]);
    // Unpublished (a release turned back into a draft) removes it.
    await capture("release", { action: "published", release: ghRelease("v3.0.0", 1) });
    await capture("release", { action: "unpublished", release: draft });
    expect(await releaseRows()).toEqual([]);
  });

  it("a prerelease is captured as one (the reads skip it)", async () => {
    await capture("release", { action: "prereleased", release: ghRelease("v3.0.0-rc.1", 1, { prerelease: true }) });
    expect((await releaseRows()).map((r) => [r.tag, r.is_prerelease])).toEqual([["v3.0.0-rc.1", 1]]);
  });

  it("create of a tag → a tag row dated by repository.pushed_at; of a branch → nothing; with no date → nothing", async () => {
    const r = await capture("create", { ref: "v1.8.0", ref_type: "tag", master_branch: "main", repository: { full_name: REPO, pushed_at: iso(6) }, sender: { login: "ana-gh" } });
    expect((await r.json() as { repo: unknown }).repo).toEqual({ captured: 1, unchanged: 0 });
    await capture("create", { ref: "feature/x", ref_type: "branch", repository: { full_name: REPO, pushed_at: iso(1) }, sender: { login: "ana-gh" } });
    await capture("create", { ref: "v1.9.0", ref_type: "tag", repository: { full_name: REPO }, sender: { login: "ana-gh" } });
    expect(await releaseRows()).toEqual([{ tag: "v1.8.0", source: "tag", sha: null, published_at: iso(6), author: "ana-gh", is_prerelease: 0, name: null }]);
    // A push delivery's pushed_at is unix seconds — read too.
    expect(releaseEventsFromDelivery("create", { ref: "v2", ref_type: "tag", repository: { pushed_at: Math.floor(NOW / 1000) } }, REPO)[0]?.publishedAt).toBe(iso(0));
  });

  it("a tag never downgrades a release; a release over a tag row keeps the tag's sha", async () => {
    const ctx = systemCtx(ORG_A);
    const tag: ReleaseCapture = { op: "tag", repo: REPO, tag: "v1.0.0", publishedAt: iso(20), author: "ana-gh", sha: "a".repeat(40), provenance: "backfill" };
    expect((await ingestRepoRelease(ctx, tag)).outcome).toBe("written");
    expect((await ingestRepoRelease(ctx, tag)).outcome).toBe("unchanged");
    const rel = releaseEventsFromDelivery("release", { action: "published", release: ghRelease("v1.0.0", 19) }, REPO)[0];
    expect((await ingestRepoRelease(ctx, rel)).outcome).toBe("written");
    expect(await releaseRows()).toEqual([{ tag: "v1.0.0", source: "release", sha: "a".repeat(40), published_at: iso(19), author: "meilin-gh", is_prerelease: 0, name: "Release v1.0.0" }]);
    // A later create / tag read for the same tag: unchanged, still a release.
    expect((await ingestRepoRelease(ctx, { ...tag, publishedAt: iso(18) })).outcome).toBe("unchanged");
    expect((await releaseRows())[0].source).toBe("release");
    // A remove of a bare tag row is a no-op; of the release it deletes.
    expect((await ingestRepoRelease(ctx, { op: "remove", repo: REPO, tag: "v1.0.0", provenance: "webhook" })).outcome).toBe("written");
    expect((await ingestRepoRelease(ctx, { op: "tag", repo: REPO, tag: "v0.9", publishedAt: iso(40), provenance: "webhook" })).outcome).toBe("written");
    expect((await ingestRepoRelease(ctx, { op: "remove", repo: REPO, tag: "v0.9", provenance: "webhook" })).outcome).toBe("unchanged");
    expect((await releaseRows()).map((r) => r.tag)).toEqual(["v0.9"]);
  });

  it("a release's target_commitish is its sha only when it IS a full sha", () => {
    const sha = "b".repeat(40);
    expect(releaseEventsFromDelivery("release", { action: "published", release: ghRelease("v1", 1, { target_commitish: sha }) }, REPO)[0].sha).toBe(sha);
    expect(releaseEventsFromDelivery("release", { action: "published", release: ghRelease("v1", 1, { target_commitish: "main" }) }, REPO)[0].sha).toBeNull();
  });

  it("each org keeps its own rows (the key binds org_id)", async () => {
    await ingestRepoRelease(systemCtx(ORG_B), { op: "tag", repo: REPO, tag: "v1", publishedAt: iso(1), provenance: "webhook" });
    expect(await releaseRows()).toEqual([]);
    expect(await readRelease(systemCtx(ORG_A), REPO)).toBeNull();
    expect((await readRelease(systemCtx(ORG_B), REPO))?.tag).toBe("v1");
  });
});

// ── the reconcile arm ───────────────────────────────────────────────────────

describe("reconcile's releases arm", () => {
  const opts = (fetchImpl: typeof fetch) => ({ token: "t", repo: REPO, fetchImpl });

  it("releases present: one request, every published one captured (drafts skipped), idempotent; the tags query never runs", async () => {
    const gh = fakeGithub({ "/releases?per_page=30": [ghRelease("v2.4.0", 9), ghRelease("v2.5.0-draft", 1, { draft: true }), ghRelease("v2.3.2", 23)] });
    const first1 = await reconcileReleases(systemCtx(ORG_A), opts(gh.fetchImpl), NOW);
    expect(first1).toEqual({ written: 2, unchanged: 0 });
    expect(gh.calls).toEqual([`https://api.github.com/repos/${REPO}/releases?per_page=30`]);
    expect(gh.graphql).toEqual([]);
    expect((await releaseRows()).map((r) => r.tag)).toEqual(["v2.3.2", "v2.4.0"]);
    expect(await reconcileReleases(systemCtx(ORG_A), opts(gh.fetchImpl), NOW)).toEqual({ written: 0, unchanged: 2 });
    expect(await first(env.DB, `SELECT json FROM repo_snapshots WHERE org_id = ? AND kind = 'releases_reconciled'`, ORG_A)).toEqual({ json: JSON.stringify({ repo: REPO }) });
  });

  it("a list shorter than the page is the whole history: a captured release no longer in it is removed", async () => {
    await ingestRepoRelease(systemCtx(ORG_A), releaseEventsFromDelivery("release", { action: "published", release: ghRelease("v9.9.9", 2) }, REPO)[0]);
    const gh = fakeGithub({ "/releases?per_page=30": [ghRelease("v2.4.0", 9)] });
    expect(await reconcileReleases(systemCtx(ORG_A), opts(gh.fetchImpl), NOW)).toEqual({ written: 2, unchanged: 0 });
    expect((await releaseRows()).map((r) => r.tag)).toEqual(["v2.4.0"]);
  });

  it("no releases: one more request — the tags, with GitHub's dates (annotated: the tagger's; lightweight: the commit's)", async () => {
    const gh = fakeGithub({
      tagsGraphql: { data: { repository: { tags: { nodes: [
        { name: "v1.8.0", target: { __typename: "Tag", oid: "tagobj", tagger: { date: iso(6), user: { login: "ana-gh" } }, target: { oid: "c".repeat(40) } } },
        { name: "v1.7.2", target: { __typename: "Commit", oid: "d".repeat(40), committedDate: iso(19), author: { user: { login: "tom-gh" } } } },
        { name: "broken", target: null },
      ] } } } },
    });
    expect(await reconcileReleases(systemCtx(ORG_A), opts(gh.fetchImpl), NOW)).toEqual({ written: 2, unchanged: 0 });
    expect(gh.calls).toHaveLength(RELEASES_RECONCILE_COST);
    expect(gh.graphql[0].query).toContain('refPrefix:"refs/tags/"');
    expect(gh.graphql[0].variables).toEqual({ owner: "acme", name: "ui-kit" });
    expect(await releaseRows()).toEqual([
      { tag: "v1.7.2", source: "tag", sha: "d".repeat(40), published_at: iso(19), author: "tom-gh", is_prerelease: 0, name: null },
      { tag: "v1.8.0", source: "tag", sha: "c".repeat(40), published_at: iso(6), author: "ana-gh", is_prerelease: 0, name: null },
    ]);
    expect(await reconcileReleases(systemCtx(ORG_A), opts(gh.fetchImpl), NOW)).toEqual({ written: 0, unchanged: 2 });
  });

  it("is an arm of reconcileRepo: its failure is named, the other arms still run", async () => {
    const base = fakeGithub({});
    const failing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("/releases?")) return new Response("{}", { status: 500 });
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    const res = await reconcileRepo(systemCtx(ORG_A), opts(failing), [], NOW);
    expect(res.failed).toEqual(["releases"]);
    expect(base.calls.some((c) => c.includes("/pulls?state=open"))).toBe(true);
    // Healthy: it ran, inside reconcileRepo, through the same gate.
    const gh = fakeGithub({ "/releases?per_page=30": [ghRelease("v2.4.0", 9)] });
    const ok = await reconcileRepo(systemCtx(ORG_A), opts(gh.fetchImpl), [], NOW);
    expect(ok.failed).toEqual([]);
    expect((await releaseRows()).map((r) => r.tag)).toEqual(["v2.4.0"]);
  });

  it("is counted: reconcileCost and the on-demand refresh both carry its 2 requests", () => {
    expect(RELEASES_RECONCILE_COST).toBe(2);
    // 16 + 2N + the promotion chain's max(2, N) + the facts arms' 6 (Phase B) + the releases arm; the cron's unit also
    // budgets the repo scan (Phase D, `SCAN_COST`), which Poll now does not run
    expect(reconcileCost(2)).toBe(16 + 2 * 2 + 2 + 6 + RELEASES_RECONCILE_COST + SCAN_COST + LOGO_IMPORT_COST + 1);
    expect(refreshSubrequests(2)).toBe(3 * 2 + 16 + 2 * 2 + 2 + 6 + RELEASES_RECONCILE_COST);
  });

  it("tagCapture skips a tag with no date", () => {
    expect(tagCapture(REPO, { name: "v1", target: { __typename: "Commit", oid: "x" } })).toBeNull();
  });
});

// ── the reads ───────────────────────────────────────────────────────────────

/** A repo_events row written as capture would, with a chosen `recorded_at` (when capture began matters). */
async function event(kind: "push" | "pr", f: { key: string; ref?: string; sha?: string; number?: number; state?: string; title?: string; login?: string; count?: number; raw?: unknown; at: string; recorded?: string }): Promise<void> {
  await run(env.DB,
    `INSERT INTO repo_events (org_id, repo, semantic_key, kind, ref, sha, number, state, title, actor_login, count, raw, provenance, occurred_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'webhook', ?, ?)`,
    ORG_A, REPO, f.key, kind, f.ref ?? null, f.sha ?? null, f.number ?? null, f.state ?? null, f.title ?? null, f.login ?? null, f.count ?? null,
    JSON.stringify(f.raw ?? {}), f.at, f.recorded ?? iso(60));
}
const merge = (number: number, title: string, daysAgo: number, labels: string[] = [], base = "main") =>
  event("pr", { key: `pr:${number}`, number, state: "merged", title, login: "ana-gh", raw: { action: "closed", base, draft: false, labels }, at: iso(daysAgo) });

async function seedReleases(): Promise<void> {
  const ctx = systemCtx(ORG_A);
  // Six releases, oldest first — and one prerelease newer than all of them, which no read takes.
  for (const [tag, d] of [["v2.1.0", 91], ["v2.2.0", 70], ["v2.3.0", 56], ["v2.3.1", 35], ["v2.3.2", 23], ["v2.4.0", 9]] as const) {
    await ingestRepoRelease(ctx, releaseEventsFromDelivery("release", { action: "published", release: ghRelease(tag, d) }, REPO)[0]);
  }
  await ingestRepoRelease(ctx, releaseEventsFromDelivery("release", { action: "published", release: ghRelease("v2.5.0-rc.1", 2, { prerelease: true }) }, REPO)[0]);
}

describe("readRelease", () => {
  it("the latest non-prerelease release: tag, date, who (a mapped login reads as the handle), notes; cadence = the ones before it, newest last", async () => {
    await run(env.DB, `INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (?, 'meilin-gh', 'meilin', ?, 'seed')`, ORG_A, iso(100));
    await seedReleases();
    const r = await readRelease(systemCtx(ORG_A), REPO);
    expect(r).toMatchObject({ tag: "v2.4.0", at: iso(9), by: "meilin", notes: "Notes for v2.4.0." });
    expect(r!.cadence).toEqual([
      { tag: "v2.1.0", at: iso(91) }, { tag: "v2.2.0", at: iso(70) }, { tag: "v2.3.0", at: iso(56) }, { tag: "v2.3.1", at: iso(35) }, { tag: "v2.3.2", at: iso(23) },
    ]);
  });

  it("cadence keeps at most the 8 before the latest", async () => {
    const ctx = systemCtx(ORG_A);
    for (let i = 0; i < 12; i++) await ingestRepoRelease(ctx, { op: "upsert", repo: REPO, tag: `v1.${i}`, publishedAt: iso(120 - i * 10), provenance: "backfill" });
    const r = await readRelease(ctx, REPO);
    expect(r!.tag).toBe("v1.11");
    expect(r!.cadence.map((c) => c.tag)).toEqual(["v1.3", "v1.4", "v1.5", "v1.6", "v1.7", "v1.8", "v1.9", "v1.10"]);
  });

  it("since: commits pushed and PRs merged into the default branch after it; waiting = those PRs newest first; feature only by prefix or label", async () => {
    await seedReleases();
    await event("push", { key: "push:old", ref: "main", sha: "o1", count: 4, at: iso(12) });          // before the release
    await event("push", { key: "push:a", ref: "main", sha: "a1", count: 11, at: iso(5) });
    await event("push", { key: "push:b", ref: "main", sha: "b1", count: 7, at: iso(2) });
    await event("push", { key: "push:side", ref: "feature/x", sha: "x1", count: 30, at: iso(1) }); // another branch
    await merge(231, "feat: DatePicker range mode", 2);
    await merge(228, "Toast stacking and swipe to dismiss", 4, ["Enhancement"]);
    await merge(230, "fix: Menu keeps scroll position on reopen", 3);
    await merge(227, "docs: theming guide (features too)", 6, ["documentation"]);
    await merge(226, "Feature flags: chore bump", 8);                                              // "Feature" word, no prefix
    await merge(200, "feat: old work", 11);                                                        // before the release
    await merge(240, "feat: other base", 1, [], "develop");                                        // not the default branch
    // A merged PR edited later: its merge is the first merged row.
    await event("pr", { key: "pr:230:edit", number: 230, state: "merged", title: "fix: Menu keeps scroll position on reopen", login: "ana-gh", raw: { action: "edited", base: "main" }, at: iso(1) });

    const r = await readRelease(systemCtx(ORG_A), REPO);
    expect(r!.since).toEqual({ commits: 18, prs: 5 });
    expect(r!.waiting.map((w) => [w.pr, w.feature])).toEqual([[231, true], [230, false], [228, true], [227, false], [226, false]]);
    expect(r!.waiting[1]).toEqual({ pr: 230, title: "fix: Menu keeps scroll position on reopen", by: "ana-gh", mergedAt: iso(3), feature: false });
  });

  it("since counts from the push that carried the tagged commit when one was captured", async () => {
    const ctx = systemCtx(ORG_A);
    await ingestRepoRelease(ctx, { op: "upsert", repo: REPO, tag: "v1", publishedAt: iso(3), sha: "t".repeat(40), provenance: "backfill" });
    await event("push", { key: "push:tagged", ref: "main", sha: "t".repeat(40), count: 2, at: iso(5) });
    await event("push", { key: "push:between", ref: "main", sha: "m1", count: 3, at: iso(4) }); // after the tagged commit, before publish
    await merge(9, "fix: between", 4);
    expect((await readRelease(ctx, REPO))!.since).toEqual({ commits: 3, prs: 1 });
  });

  it("since is null — never 0 — where capture began after the release; the merged PRs it does see are still listed", async () => {
    await seedReleases();
    await event("push", { key: "push:a", ref: "main", sha: "a1", count: 11, at: iso(5), recorded: iso(3) });
    await event("pr", { key: "pr:231", number: 231, state: "merged", title: "feat: DatePicker range mode", login: "ana-gh", raw: { base: "main" }, at: iso(2), recorded: iso(2) });
    const r = await readRelease(systemCtx(ORG_A), REPO);
    expect(r!.since).toEqual({ commits: null, prs: null });
    expect(r!.waiting.map((w) => w.pr)).toEqual([231]);
    // Nothing captured at all: still null.
    await run(env.DB, `DELETE FROM repo_events`);
    expect((await readRelease(systemCtx(ORG_A), REPO))!.since).toEqual({ commits: null, prs: null });
  });

  it("a repository with tags only reads its newest tag (no notes); with releases, stray tags are not releases", async () => {
    const ctx = systemCtx(ORG_A);
    await ingestRepoRelease(ctx, { op: "tag", repo: REPO, tag: "v1.8.0", publishedAt: iso(6), author: "ana-gh", provenance: "webhook" });
    await ingestRepoRelease(ctx, { op: "tag", repo: REPO, tag: "v1.7.2", publishedAt: iso(19), provenance: "webhook" });
    expect(await readRelease(ctx, REPO)).toMatchObject({ tag: "v1.8.0", notes: null, cadence: [{ tag: "v1.7.2", at: iso(19) }] });
    await ingestRepoRelease(ctx, { op: "upsert", repo: REPO, tag: "v1.0.0", publishedAt: iso(50), notes: "Body", provenance: "webhook" });
    expect(await readRelease(ctx, REPO)).toMatchObject({ tag: "v1.0.0", notes: "Body", cadence: [] });
  });

  it("an app whose release_signal is tag:<glob> reads only the tags matching it", async () => {
    const ctx = systemCtx(ORG_A);
    await run(env.DB, `INSERT INTO repo_apps (org_id, key, repo, label, kind, release_signal, created_at, created_by, updated_at, updated_by) VALUES (?, 'mobile', ?, 'Mobile', 'Package', 'tag:mobile@*', ?, 'seed', ?, 'seed')`, ORG_A, REPO, iso(100), iso(100));
    await ingestRepoRelease(ctx, { op: "tag", repo: REPO, tag: "mobile@1.2.0", publishedAt: iso(10), provenance: "webhook" });
    await ingestRepoRelease(ctx, { op: "tag", repo: REPO, tag: "web@3.0.0", publishedAt: iso(2), provenance: "webhook" });
    expect((await readRelease(ctx, REPO, "mobile"))?.tag).toBe("mobile@1.2.0");
    expect((await readRelease(ctx, REPO))?.tag).toBe("web@3.0.0");
    expect((await readRelease(ctx, REPO, "frontend"))?.tag).toBe("web@3.0.0"); // no tag: signal → every release
  });

  it("nothing captured → null", async () => {
    expect(await readRelease(systemCtx(ORG_A), REPO)).toBeNull();
  });
});

describe("a feature claim comes only from a feat prefix or a feature label (guard)", () => {
  it("isFeaturePr", () => {
    expect(isFeaturePr("feat: DatePicker range mode", [])).toBe(true);
    expect(isFeaturePr("feat(picker): range mode", [])).toBe(true);
    expect(isFeaturePr("Feat: capitalised", [])).toBe(true);
    expect(isFeaturePr("Range mode", ["feature"])).toBe(true);
    expect(isFeaturePr("Range mode", ["Enhancement"])).toBe(true);
    // Never otherwise.
    expect(isFeaturePr("Range mode", [])).toBe(false);
    expect(isFeaturePr("New feature: range mode", [])).toBe(false);
    expect(isFeaturePr("feature: range mode", [])).toBe(false);
    expect(isFeaturePr("feat range mode", [])).toBe(false);
    expect(isFeaturePr("fix: feat: nested", [])).toBe(false);
    expect(isFeaturePr("Range mode", ["features", "feature-request", "documentation"])).toBe(false);
    expect(isFeaturePr(null, [])).toBe(false);
  });

  it("readRelease marks waiting PRs by that rule only — labels come from the captured PR", async () => {
    await seedReleases();
    await merge(1, "feat: prefixed", 3);
    await merge(2, "Labelled", 4, ["feature"]);
    await merge(3, "A great new feature", 5, ["bug"]);
    await merge(4, "featuring nothing", 6);
    const r = await readRelease(systemCtx(ORG_A), REPO);
    expect(r!.waiting.map((w) => [w.pr, w.feature])).toEqual([[1, true], [2, true], [3, false], [4, false]]);
  });
});

describe("readTags and the week figure", () => {
  it("readTags: every tag held (releases included), the newest, and the newest four", async () => {
    await seedReleases();
    const t = await readTags(systemCtx(ORG_A), REPO);
    expect(t!.count).toBe(7);
    expect(t!.latest).toEqual({ tag: "v2.5.0-rc.1", at: iso(2), by: "meilin-gh" });
    expect(t!.recent.map((x) => x.tag)).toEqual(["v2.5.0-rc.1", "v2.4.0", "v2.3.2", "v2.3.1"]);
    // nothing held and never read: unknown (null), never "0 tags"
    expect(await readTags(systemCtx(ORG_B), REPO)).toBeNull();
  });

  it("releases this week and the change from last week — null until reconcile has read the list", async () => {
    const ctx = systemCtx(ORG_A);
    await ingestRepoRelease(ctx, { op: "upsert", repo: REPO, tag: "v1", publishedAt: iso(2), provenance: "webhook" });
    expect(await releaseWeekFigure(ctx, REPO, NOW)).toEqual({ key: "releases", value: null, delta: null });
    const gh = fakeGithub({ "/releases?per_page=30": [ghRelease("v1", 2), ghRelease("v0.9", 3), ghRelease("v0.8", 10), ghRelease("v0.8-rc", 1, { prerelease: true })] });
    await reconcileReleases(ctx, { token: "t", repo: REPO, fetchImpl: gh.fetchImpl }, NOW);
    expect(await releaseWeekFigure(ctx, REPO, NOW)).toEqual({ key: "releases", value: 2, delta: 1 });
    // The marker names the repository it read.
    expect(await releaseWeekFigure(ctx, "acme/other", NOW)).toEqual({ key: "releases", value: null, delta: null });
  });
});

describe("notes and deletion", () => {
  it("releaseNotesText drops headings and comments and cuts at a word", () => {
    expect(releaseNotesText("## What's Changed\n<!-- x -->\n* feat: one by @a\n* fix: two")).toBe("* feat: one by @a * fix: two");
    expect(releaseNotesText("# Only a heading")).toBeNull();
    const long = releaseNotesText("word ".repeat(100))!;
    expect(long.length).toBeLessThanOrEqual(281);
    expect(long.endsWith("word…")).toBe(true);
  });

  it("releases is in ORG_TABLES (it goes with the org)", () => {
    expect(ORG_TABLES).toContain("releases");
  });
});
