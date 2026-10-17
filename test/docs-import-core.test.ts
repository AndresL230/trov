import { describe, it, expect } from "vitest";
import {
  MAX_FILES, MAX_TOTAL_BYTES, MAX_MD_BYTES, MAX_IMAGE_BYTES, SKIP_REASONS,
  importKind, normalizeImportPath, naturalCompare, titleFromName, slugFromName, renameSuggestion, titleFromMarkdown,
  planImport, applyConflictChoices, commonChoice, planSummary, prepareBody, imagePathsUsed, resolveImportTarget,
  type ImportFile, type ImportPlan, type PlanOptions,
} from "@shared/docs-import-core";
import { DOC_SLUG_RE } from "@shared/docs-links-core";

// The import planner — pure. The browser runs it for the Preview and the Worker re-runs it over the manifest,
// so these cases (built on the design's handbook.zip, §13.6) are the contract for both.

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// handbook.zip → Engineering. [path, H1 title (null = no heading), size]
const HANDBOOK: Array<[string, string | null, number]> = [
  ["handbook/README.md", "Engineering handbook", 900],
  ["handbook/onboarding/first-week.md", "Your first week", 1200],
  ["handbook/onboarding/local-setup.md", "Local setup", 800],
  ["handbook/onboarding/accounts.md", "Accounts and access", 700],
  ["handbook/onboarding/who-to-ask.md", "Who to ask", 300],
  ["handbook/practices/code-review.md", "Code review", 1000],
  ["handbook/practices/testing.md", "Testing", 1000],
  ["handbook/practices/tickets.md", "Writing good tickets", 1000],
  ["handbook/practices/pairing.md", "Pairing", 1000],
  ["handbook/practices/releases.md", "Release process", 1000],
  ["handbook/operations/deploys.md", "Deploys", 1000],
  ["handbook/operations/migrations.md", "Database migrations", 1000],
  ["handbook/operations/feature-flags.md", "Feature flags", 1000],
  ["handbook/operations/paging.md", "Paging and escalation", 1000],
  ["handbook/operations/incident-reviews.md", "Incident reviews", 1000],
  ["handbook/systems.md", "Systems", 400],                         // merges with handbook/systems/
  ["handbook/systems/services.md", "Services", 1000],
  ["handbook/systems/queues.md", "Queues and jobs", 1000],
  ["handbook/systems/storage.md", "Storage", 1000],
  ["handbook/systems/caching.md", "Caching", 1000],
  ["handbook/glossary.md", null, 500],                             // no heading: the file name
  ["handbook/drafts/empty.md", null, 0],
];
const OTHER: Array<[string, ImportFile["kind"], number]> = [
  ["handbook/design/logo.sketch", "other", 40_000],
  ["handbook/notes/.DS_Store", "other", 6_148],
  ["handbook/attachments/arch.png", "image", 50_000],
  ["handbook/attachments/flow.webp", "image", 20_000],
  ["handbook/onboarding/desk.jpg", "image", 30_000],
];
const files = (titles = true): ImportFile[] => [
  ...HANDBOOK.map(([path, title, size]) => ({ path, size, kind: "md" as const, ...(titles ? { title } : {}) })),
  ...OTHER.map(([path, kind, size]) => ({ path, kind, size })),
];
const OPTS: PlanOptions = {
  existingTitles: new Map([["local setup", "local-setup"], ["deploys", "deploys"], ["paging and escalation", "paging"]]),
  existingSlugs: new Set(["local-setup", "deploys", "paging", "testing", "architecture"]),
};
const page = (plan: ImportPlan, key: string) => plan.pages.find((p) => p.key === key)!;
const outline = (plan: ImportPlan) => plan.pages.map((p) => `${"  ".repeat(p.depth)}${p.title}`);

describe("planImport — the handbook", () => {
  const plan = planImport(files(), OPTS);

  it("makes the design's 24 pages, folders nested, README as the folder's body", () => {
    expect(plan.error).toBeNull();
    expect(plan.pages).toHaveLength(24);
    expect(plan.roots).toEqual(["handbook/"]);
    expect(outline(plan)).toEqual([
      "Engineering handbook",
      "  Glossary",
      "  Onboarding",
      "    Accounts and access", "    Your first week", "    Local setup", "    Who to ask",
      "  Operations",
      "    Deploys", "    Feature flags", "    Incident reviews", "    Database migrations", "    Paging and escalation",
      "  Practices",
      "    Code review", "    Pairing", "    Release process", "    Testing", "    Writing good tickets",
      "  Systems",
      "    Caching", "    Queues and jobs", "    Services", "    Storage",
    ]);
    const root = page(plan, "handbook/");
    expect(root).toMatchObject({ path: "handbook/README.md", folder: "handbook", parent: null, parentSlug: null, titlePending: false });
    expect(page(plan, "handbook/onboarding/")).toMatchObject({ path: null, folder: "handbook/onboarding", title: "Onboarding", parentSlug: root.slug });
  });

  it("merges name.md beside name/ into one page", () => {
    const systems = page(plan, "handbook/systems/");
    expect(systems.path).toBe("handbook/systems.md");
    expect(systems.children).toEqual(["handbook/systems/caching.md", "handbook/systems/queues.md", "handbook/systems/services.md", "handbook/systems/storage.md"]);
    expect(plan.pages.some((p) => p.key === "handbook/systems.md")).toBe(false);
  });

  it("collects images (attachments and loose), and lists what won't be imported with the design's reasons", () => {
    expect(plan.images.map((i) => [i.path, i.type])).toEqual([
      ["handbook/attachments/arch.png", "image/png"],
      ["handbook/attachments/flow.webp", "image/webp"],
      ["handbook/onboarding/desk.jpg", "image/jpeg"],
    ]);
    expect(plan.skipped).toEqual([
      { path: "handbook/design/logo.sketch", code: "not_markdown", reason: "Not a Markdown file" },
      { path: "handbook/drafts/empty.md", code: "empty", reason: "The file is empty" },
      { path: "handbook/notes/.DS_Store", code: "hidden", reason: "Hidden system file" },
    ]);
    expect(plan.pages.some((p) => p.folder === "handbook/attachments" || p.folder === "handbook/design" || p.folder === "handbook/drafts")).toBe(false);
  });

  it("flags titles that already exist in the space", () => {
    expect(plan.conflicts).toEqual([
      { key: "handbook/onboarding/local-setup.md", path: "handbook/onboarding/local-setup.md", title: "Local setup", existingSlug: "local-setup" },
      { key: "handbook/operations/deploys.md", path: "handbook/operations/deploys.md", title: "Deploys", existingSlug: "deploys" },
      { key: "handbook/operations/paging.md", path: "handbook/operations/paging.md", title: "Paging and escalation", existingSlug: "paging" },
    ]);
  });

  it("proposes slugs from the path, valid and unique against the org and the plan", () => {
    const slugs = plan.pages.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) { expect(s).toMatch(DOC_SLUG_RE); expect(OPTS.existingSlugs.has(s)).toBe(false); }
    expect(page(plan, "handbook/practices/testing.md").slug).toBe("testing-2");
    expect(page(plan, "handbook/onboarding/local-setup.md").slug).toBe("local-setup-2");
    expect(page(plan, "handbook/onboarding/first-week.md").slug).toBe("first-week");
    expect(plan.pathToSlug.get("handbook/onboarding")).toBe(page(plan, "handbook/onboarding/").slug);
    expect(plan.pathToSlug.get("handbook/systems.md")).toBe(plan.pathToSlug.get("handbook/systems"));
  });

  it("is deterministic: the same files in any order give the same plan", () => {
    const shuffled = [...files()].reverse();
    const again = planImport(shuffled, OPTS);
    const flat = (p: ImportPlan) => JSON.stringify({ ...p, pathToSlug: [...p.pathToSlug] });
    expect(flat(again)).toBe(flat(plan));
  });

  it("without titles, pages carry the file name and are titlePending", () => {
    const p = planImport(files(false), OPTS);
    expect(page(p, "handbook/onboarding/first-week.md")).toMatchObject({ title: "First week", titlePending: true });
    expect(page(p, "handbook/onboarding/")).toMatchObject({ title: "Onboarding", titlePending: false });
    expect(page(p, "handbook/")).toMatchObject({ title: "Handbook", titlePending: true });
    expect(page(p, "handbook/operations/deploys.md").slug).toBe(page(plan, "handbook/operations/deploys.md").slug);   // slugs never wait on titles
  });

  it("goes under a parent page when one is given", () => {
    const p = planImport(files(), { ...OPTS, parentSlug: "architecture", parentDepth: 0 });
    expect(page(p, "handbook/").parentSlug).toBe("architecture");
    expect(page(p, "handbook/onboarding/").parentSlug).toBe(page(p, "handbook/").slug);
  });
});

describe("planImport — conflicts", () => {
  const plan = planImport(files(), OPTS);

  it("defaults every conflict to a new version, which keeps the existing page in place", () => {
    const writes = applyConflictChoices(plan, {});
    expect(writes).toHaveLength(24);
    expect(writes.find((w) => w.key === "handbook/operations/deploys.md")).toEqual({ key: "handbook/operations/deploys.md", path: "handbook/operations/deploys.md", mode: "version", slug: "deploys", title: "Deploys" });
    expect(commonChoice(plan, {})).toBe("version");
    expect(planSummary(plan)).toEqual({ pages: 24, newPages: 21, versions: 3, conflicts: 3, skipped: 3, images: 3 });
  });

  it("skip drops a page from the count; rename makes it new with the suggested title", () => {
    const writes = applyConflictChoices(plan, { "handbook/operations/deploys.md": "skip", "handbook/onboarding/local-setup.md": { choice: "rename" } }, "handbook.zip");
    expect(writes.find((w) => w.key === "handbook/operations/deploys.md")).toEqual({ key: "handbook/operations/deploys.md", path: "handbook/operations/deploys.md", mode: "skip", slug: "deploys" });
    const renamed = writes.find((w) => w.key === "handbook/onboarding/local-setup.md");
    expect(renamed).toMatchObject({ mode: "new", title: "Local setup (handbook)", slug: "local-setup-2", parent_slug: page(plan, "handbook/onboarding/").slug });
    expect(applyConflictChoices(plan, { "handbook/onboarding/local-setup.md": { choice: "rename", title: "  Laptop setup " } }).find((w) => w.key === "handbook/onboarding/local-setup.md"))
      .toMatchObject({ title: "Laptop setup" });
    expect(commonChoice(plan, { "handbook/operations/deploys.md": "skip" })).toBeNull();
    expect(planSummary(plan, { "handbook/operations/deploys.md": "skip" }).pages).toBe(23);
  });

  it("a skipped or versioned FOLDER page's children go under the existing page; a folder with no file is never a version", () => {
    const p = planImport(files(), { ...OPTS, existingTitles: new Map([["onboarding", "onboarding-old"]]) });
    for (const choice of ["skip", "version"] as const) {
      const writes = applyConflictChoices(p, { "handbook/onboarding/": choice });
      expect(writes.find((w) => w.key === "handbook/onboarding/")).toEqual({ key: "handbook/onboarding/", path: null, mode: "skip", slug: "onboarding-old" });
      expect(writes.find((w) => w.key === "handbook/onboarding/first-week.md")).toMatchObject({ mode: "new", parent_slug: "onboarding-old" });
    }
    expect(commonChoice(p, { "handbook/onboarding/": "skip" })).toBe("skip");
  });
});

describe("planImport — refusals, caps and safety", () => {
  const empty: PlanOptions = { existingTitles: new Map(), existingSlugs: new Set() };

  it("caps: files, total size, nothing to import", () => {
    const many = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `p${i}.md`, size: 10, kind: "md" as const }));
    expect(planImport(many, empty).error).toBe("too_many_files");
    expect(planImport(many.slice(0, MAX_FILES), empty).error).toBeNull();
    const big = [{ path: "a.md", size: 10, kind: "md" as const }, { path: "b.png", size: MAX_TOTAL_BYTES, kind: "image" as const }];
    expect(planImport(big, empty).error).toBe("too_large");
    expect(planImport([{ path: "x.pdf", size: 10, kind: "other" }], empty).error).toBe("no_markdown");
    expect(planImport([], empty).error).toBe("no_markdown");
  });

  it("per-file caps skip the file", () => {
    const p = planImport([
      { path: "ok.md", size: MAX_MD_BYTES, kind: "md" },
      { path: "huge.md", size: MAX_MD_BYTES + 1, kind: "md" },
      { path: "huge.png", size: MAX_IMAGE_BYTES + 1, kind: "image" },
      { path: "fake.md", size: 10, kind: "image" },
      { path: "notes.txt", size: 10, kind: "md" },
      { path: "pic.svg", size: 10, kind: "image" },
    ], empty);
    expect(p.pages.map((x) => x.key)).toEqual(["ok.md"]);
    expect(p.skipped.map((s) => [s.path, s.code])).toEqual([
      ["fake.md", "not_markdown"], ["huge.md", "too_large"], ["huge.png", "too_large"], ["notes.txt", "not_markdown"], ["pic.svg", "not_markdown"],
    ]);
    // Owner ruling IW51: an over-limit message names the limit.
    expect(p.skipped.find((s) => s.path === "huge.md")!.reason).toContain("1 MB");
    expect(p.skipped.find((s) => s.path === "huge.png")!.reason).toContain("10 MB");
    expect(SKIP_REASONS.too_large).toMatch(/1 MB.*10 MB/);
  });

  it("path safety: traversal, absolute, NUL refused; separators normalized; system files hidden", () => {
    expect(normalizeImportPath("../evil.md")).toMatchObject({ ok: false, code: "bad_path" });
    expect(normalizeImportPath("a/../../evil.md")).toMatchObject({ ok: false, code: "bad_path" });
    expect(normalizeImportPath("/etc/passwd")).toMatchObject({ ok: false, code: "bad_path" });
    expect(normalizeImportPath("C:\\Users\\x.md")).toMatchObject({ ok: false, code: "bad_path" });
    expect(normalizeImportPath("a\u0000b.md")).toMatchObject({ ok: false, code: "bad_path" });
    expect(normalizeImportPath("")).toMatchObject({ ok: false, code: "bad_path" });
    expect(normalizeImportPath("docs\\guide\\intro.md")).toEqual({ ok: true, path: "docs/guide/intro.md" });
    expect(normalizeImportPath("./a//b/./c.md")).toEqual({ ok: true, path: "a/b/c.md" });
    expect(normalizeImportPath("Cafe\u0301.md")).toEqual({ ok: true, path: "Café.md" });   // NFC
    expect(normalizeImportPath(".git/config")).toMatchObject({ ok: false, code: "hidden" });
    expect(normalizeImportPath("notes/Thumbs.db")).toMatchObject({ ok: false, code: "hidden" });
  });

  it("__MACOSX is one row; duplicates after normalizing are skipped", () => {
    const p = planImport([
      { path: "a.md", size: 5, kind: "md" },
      { path: "./a.md", size: 5, kind: "md" },
      { path: "__MACOSX/._a.md", size: 5, kind: "md" },
      { path: "__MACOSX/sub/._b.md", size: 5, kind: "md" },
      { path: "../up.md", size: 5, kind: "md" },
    ], empty);
    expect(p.skipped).toEqual([
      { path: "../up.md", code: "bad_path", reason: SKIP_REASONS.bad_path },
      { path: "__MACOSX/", code: "hidden", reason: "Hidden system file" },
      { path: "a.md", code: "duplicate", reason: SKIP_REASONS.duplicate },
    ]);
    expect(p.pages.map((x) => x.key)).toEqual(["a.md"]);
  });

  it("Markdown inside an attachments folder is not a page", () => {
    const p = planImport([{ path: "docs/attachments/readme.md", size: 5, kind: "md" }, { path: "docs/guide.md", size: 5, kind: "md" }], empty);
    expect(p.pages.map((x) => x.key)).toEqual(["docs/", "docs/guide.md"]);
    expect(p.skipped[0]).toMatchObject({ path: "docs/attachments/readme.md", code: "in_attachments" });
  });

  it("depth: pages past MAX_DEPTH (counted from the parent page) are skipped with their files; folders are levels", () => {
    expect(SKIP_REASONS.too_deep).toBe("Nested more than 6 levels deep");
    const chain: ImportFile[] = [];
    let dir = "";
    for (let i = 0; i < 12; i++) { dir = dir ? `${dir}/l${i}` : `l${i}`; chain.push({ path: `${dir}/page.md`, size: 5, kind: "md" }); }
    const p = planImport(chain, empty);
    expect(Math.max(...p.pages.map((x) => x.depth))).toBe(5);
    expect(p.skipped.every((s) => s.code === "too_deep")).toBe(true);
    expect(p.skipped.length).toBeGreaterThan(0);
    const under = planImport(chain, { ...empty, parentSlug: "deep", parentDepth: 2 });
    expect(Math.max(...under.pages.map((x) => x.depth))).toBe(2);                // 2 + 1 + 2 = 5
    // under the deepest page (depth 5) nothing fits
    expect(planImport(chain, { ...empty, parentSlug: "deepest", parentDepth: 5 }).pages).toEqual([]);
  });

  it("depth: the seed's fixtures — five folders and a file is exactly the cap; six folders and a file is one past it", () => {
    const atCap = planImport([{ path: "d1/d2/d3/d4/d5/at-cap.md", size: 5, kind: "md" }], empty);
    expect(atCap.pages.map((x) => [x.key, x.depth])).toEqual([["d1/", 0], ["d1/d2/", 1], ["d1/d2/d3/", 2], ["d1/d2/d3/d4/", 3], ["d1/d2/d3/d4/d5/", 4], ["d1/d2/d3/d4/d5/at-cap.md", 5]]);
    expect(atCap.skipped).toEqual([]);
    const past = planImport([{ path: "d1/d2/d3/d4/d5/d6/deep.md", size: 5, kind: "md" }, { path: "shallow.md", size: 5, kind: "md" }], empty);
    expect(Math.max(...past.pages.map((x) => x.depth))).toBe(5);                 // d6/ is the deepest page
    expect(past.skipped).toEqual([expect.objectContaining({ path: "d1/d2/d3/d4/d5/d6/deep.md", code: "too_deep" })]);
    expect(past.pages.some((x) => x.key === "shallow.md")).toBe(true);
  });

  it("orders siblings naturally", () => {
    const p = planImport(["10-last.md", "2-second.md", "1-first.md", "b.md", "A.md"].map((path) => ({ path, size: 5, kind: "md" as const })), empty);
    expect(p.pages.map((x) => x.title)).toEqual(["First", "Second", "Last", "A", "B"]);
    expect(naturalCompare("file2", "file10")).toBeLessThan(0);
  });
});

describe("names", () => {
  it("kinds, titles, slugs, rename", () => {
    expect([importKind("a.MD"), importKind("a.markdown"), importKind("x.JPEG"), importKind("x.svg"), importKind("README")]).toEqual(["md", "md", "image", "other", "other"]);
    expect(titleFromName("01-first-week.md")).toBe("First week");
    expect(titleFromName("code_review.md")).toBe("Code review");
    expect(titleFromName("2024.md")).toBe("2024");
    expect(slugFromName("Ünïcode Notes!.md")).toBe("unicode-notes");
    expect(slugFromName("日本語.md")).toBe("page");
    expect(renameSuggestion("Local setup", "handbook.zip")).toBe("Local setup (handbook)");
    expect(renameSuggestion("Local setup", null)).toBe("Local setup (imported)");
    expect(titleFromMarkdown("\uFEFF---\ntitle: x\n# not this\n---\n\n```\n# nor this\n```\n# The *real* one #\n")).toBe("The real one");
    expect(titleFromMarkdown("## only h2\n#nospace")).toBeNull();
  });
});

describe("prepareBody", () => {
  const plan = planImport(files(), OPTS);
  const imagePathToSha = new Map([["handbook/attachments/arch.png", SHA_A], ["handbook/onboarding/desk.jpg", SHA_B]]);
  const ctx = { path: "handbook/onboarding/first-week.md", pathToSlug: plan.pathToSlug, imagePathToSha };

  it("takes the first H1 out as the title and rewrites links and images", () => {
    const text = [
      "# Your first week",
      "",
      "Start with [local setup](./local-setup.md) and [the review guide](../practices/code-review.md#checklist).",
      "See [Operations](../operations/) and [the systems page](<../systems.md>).",
      "Old: [archive](../old/thing.md). Web: [Trov](https://trov.dev). Here: [top](#top).",
      "![Architecture](../attachments/arch.png \"The big picture\") ![desk](desk.jpg)",
      "![missing](../attachments/gone.png) ![remote](https://example.com/x.png)",
      "<img src=\"../attachments/arch.png\" alt=\"arch\"> <img src=\"nope.png\" alt=\"no\">",
      "`[code](./local-setup.md)` and [[glossary]].",
      "```",
      "[fenced](./local-setup.md)",
      "```",
    ].join("\r\n");
    const r = prepareBody(text, ctx);
    const setup = plan.pathToSlug.get("handbook/onboarding/local-setup.md");
    const review = plan.pathToSlug.get("handbook/practices/code-review.md");
    const ops = plan.pathToSlug.get("handbook/operations");
    const systems = plan.pathToSlug.get("handbook/systems.md");
    expect(r.title).toBe("Your first week");
    expect(r.body).toBe([
      `Start with [[${setup}|local setup]] and [[${review}|the review guide]].`,
      `See [[${ops}|Operations]] and [[${systems}|the systems page]].`,
      "Old: archive. Web: [Trov](https://trov.dev). Here: [top](#top).",
      `![Architecture](/img/${SHA_A} "The big picture") ![desk](/img/${SHA_B})`,
      "missing [remote](https://example.com/x.png)",
      `<img src="/img/${SHA_A}" alt="arch"> no`,
      "`[code](./local-setup.md)` and [[glossary]].",
      "```",
      "[fenced](./local-setup.md)",
      "```",
    ].join("\n"));
    expect(r.links).toEqual([setup, review, ops, systems, "glossary"]);
    expect(r.images).toEqual([SHA_A, SHA_B]);
    expect(r.unmatchedLinks).toEqual(["../old/thing.md"]);
    expect(r.unmatchedImages).toEqual(["../attachments/gone.png", "https://example.com/x.png", "nope.png"]);
    expect(r.empty).toBe(false);
  });

  it("URL-encoded paths, extensionless links, reference-style links and images", () => {
    const pathToSlug = new Map([["docs/Feature Flags.md", "feature-flags"], ["docs/setup.md", "setup"]]);
    const shas = new Map([["docs/img/a b.png", SHA_A]]);
    const text = "[flags](Feature%20Flags.md) [setup](setup) [ref link][s] ![ref img][pic] [gone][g]\n\n[s]: ./setup.md\n[pic]: <img/a b.png>\n[g]: ../nowhere.md\n";
    const r = prepareBody(text, { path: "docs/index.md", pathToSlug, imagePathToSha: shas });
    expect(r.body).toBe(`[[feature-flags|flags]] [[setup]] [[setup|ref link]] ![ref img][pic] gone\n\n[s]: ./setup.md\n[pic]: /img/${SHA_A}\n[g]: ../nowhere.md\n`);
    expect(r.title).toBeNull();
    expect(r.unmatchedLinks).toEqual(["../nowhere.md"]);
  });

  it("adjacent links both rewrite; a link escaping the zip is plain text", () => {
    const r = prepareBody("[a](./local-setup.md)[b](./who-to-ask.md) [up](../../../x.md)", ctx);
    expect(r.body).toBe(`[[${plan.pathToSlug.get("handbook/onboarding/local-setup.md")}|a]][[${plan.pathToSlug.get("handbook/onboarding/who-to-ask.md")}|b]] up`);
    expect(r.unmatchedLinks).toEqual(["../../../x.md"]);
  });

  it("an empty file and a heading-only file", () => {
    expect(prepareBody("  \n\n", ctx)).toMatchObject({ empty: true, title: null, body: "  \n\n" });
    expect(prepareBody("# Only a title\n", ctx)).toMatchObject({ empty: false, title: "Only a title", body: "" });
  });

  it("is deterministic", () => {
    const t = "# T\n\n[a](./local-setup.md) ![x](../attachments/arch.png)";
    expect(prepareBody(t, ctx)).toEqual(prepareBody(t, ctx));
  });

  it("imagePathsUsed lists the import's images a page uses, in order", () => {
    const text = "![b](desk.jpg) <img src='../attachments/arch.png'> ![b again](./desk.jpg) ![x](missing.png) [pdf](../attachments/arch.png)";
    expect(imagePathsUsed(text, ctx.path, plan.images.map((i) => i.path))).toEqual(["handbook/onboarding/desk.jpg", "handbook/attachments/arch.png"]);
  });

  it("resolveImportTarget", () => {
    expect(resolveImportTarget("https://x.dev/a.md", "a/b.md")).toEqual({ kind: "external", url: "https://x.dev/a.md" });
    expect(resolveImportTarget("mailto:a@b.c", "a/b.md").kind).toBe("external");
    expect(resolveImportTarget("#x", "a/b.md")).toEqual({ kind: "anchor" });
    expect(resolveImportTarget(`/img/${SHA_A}`, "a/b.md")).toEqual({ kind: "trov" });
    expect(resolveImportTarget("../c/d.md?x=1#y", "a/b/e.md")).toEqual({ kind: "local", path: "a/c/d.md" });
    expect(resolveImportTarget("/root.md", "a/b/e.md")).toEqual({ kind: "local", path: "root.md" });
    expect(resolveImportTarget("../../x.md", "a/e.md")).toEqual({ kind: "outside" });
    expect(resolveImportTarget("%E0%A4%A.md", "e.md")).toEqual({ kind: "local", path: "%E0%A4%A.md" });   // bad escape: as written
  });
});
