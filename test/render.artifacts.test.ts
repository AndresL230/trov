/**
 * The Artifacts screens (web/src/artifacts.ts) — pure render + reducer tests over
 * inline wire DTOs (shared/artifacts-core.ts), no network.
 *
 * What matters here: each screen renders from the API's DTOs; every kind is shown
 * the way the spec mandates (html in an allow-scripts-only sandbox loaded from the
 * raw route — never srcdoc, never allow-same-origin; svg only through the
 * sanitizer; image/pdf/file from the raw route); the reducer's gates hold and its
 * writes come out as effects (PATCH status / visibility, POST ratify, POST links,
 * the create body — JSON for text, multipart for binary); and the caps are
 * per-kind (750 KB text, 10 MB binary).
 */
import { describe, it, expect, vi } from "vitest";

// marked + DOMPurify need DOM globals this pool does not have (as in render.docs.test.ts):
// the stand-ins mark that a body went through the markdown / svg sanitizer.
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (b: string) => `<div data-md>${b.length}</div>`,
  renderMarkdownInline: (t: string) => t,
  sanitizeSvg: (s: string) => `<div data-svg-clean>${s.length}</div>`,
}));
import {
  artifactsView, artifactsHeader, artifactsDialogs, artifactsAct, libraryRows, parseArtLink, createBytes,
  ticketArtifactsBlock, artAcceptFile, artAcceptNvFile, artFileName, detailKey, diffKey, initialArtUi, ART_ROUTE_NONE,
  type ArtProps, type ArtUi, type ArtRoute, type ArtScreen,
} from "../web/src/artifacts";
import { render, initialState } from "../web/src/render";
import type { ArtifactSummaryDTO, ArtifactDetailDTO, ArtifactVersionDTO, ArtifactKind, ArtifactDiffDTO } from "@shared/artifacts-core";
import { ARTIFACT_TEXT_CAP } from "@shared/artifacts-core";
import { canDeleteArtifact } from "../web/src/artifacts";
import artifactsSrc from "../web/src/artifacts.ts?raw";
import mainSrc from "../web/src/main.ts?raw";

/** The one `.cnpy-sfbar` (search + Filter) element in `html`, balanced by its divs — or null. */
function sfbar(html: string): string | null {
  const start = html.indexOf('<div class="cnpy-sfbar"');
  if (start < 0 || html.indexOf('<div class="cnpy-sfbar"', start + 1) >= 0) return null;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index + 6);
  }
  return null;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

const T0 = "2026-09-20T10:00:00.000Z";
function ver(n: number, over: Partial<ArtifactVersionDTO> = {}): ArtifactVersionDTO {
  return { version_no: n, summary: `v${n} summary`, created_by: "AndresL230", created_at: T0, size_bytes: 1200, content_type: "text/html; charset=utf-8", sha256: "ab".repeat(32), ...over };
}
function summary(slug: string, over: Partial<ArtifactSummaryDTO> = {}): ArtifactSummaryDTO {
  return {
    id: 1, slug, title: slug.replace(/-/g, " "), kind: "html", area: "ui", repo: "SaplingLearn/canopy", author_id: "AndresL230",
    status: "published", visibility: "org", current_version: 1, updated_at: T0, published_at: T0, size_bytes: 1200, excerpt: null,
    ticket_ids: [], sprint_ids: [], ...over,
  };
}
function detail(slug: string, kind: ArtifactKind, over: Partial<ArtifactDetailDTO> = {}, versions = 3, at = versions): ArtifactDetailDTO {
  const vs = Array.from({ length: versions }, (_, i) => ver(i + 1));
  return {
    ...summary(slug, { kind, current_version: versions }),
    ratified_version: null, ratified_by: null, ratified_at: null,
    versions: vs, links: [], version: vs[at - 1], content: kind === "html" ? "<h1>hi</h1>" : kind === "markdown" ? "# Title" : kind === "svg" ? "<svg></svg>" : kind === "mermaid" ? "graph TD; A-->B" : null,
    raw_url: `/raw/a/${slug}@v${at}`, ...over,
  };
}
const LIST: ArtifactSummaryDTO[] = [
  summary("google-signin-design", { kind: "html", author_id: "Jose-Gael-Cruz-Lopez", ticket_ids: [10], sprint_ids: [14], updated_at: "2026-09-22T10:00:00.000Z", current_version: 3 }),
  summary("auth-audit-sep-2026", { kind: "markdown", area: "auth", ticket_ids: [9], excerpt: "# Auth audit\n\nFindings", updated_at: "2026-09-21T10:00:00.000Z" }),
  summary("session-flow", { kind: "mermaid", area: "architecture", status: "ratified", excerpt: "graph TD\n  A-->B", updated_at: "2026-09-19T10:00:00.000Z" }),
  summary("login-mock", { kind: "image", status: "draft", visibility: "private", updated_at: "2026-09-18T10:00:00.000Z" }),
  summary("rfc-pdf", { kind: "pdf", area: "infra", size_bytes: 2 * 1024 * 1024, updated_at: "2026-09-17T10:00:00.000Z" }),
];
const SPRINTS = [{ id: 14, label: "Sprint 14", dates: "Sep 14 – Sep 27", active: true }, { id: 13, label: "Sprint 13", dates: null, active: false }];
const TICKETS = [{ id: 10, title: "Google sign-in for staff", status: "in_progress" }, { id: 9, title: "Review session security", status: "submitted" }, { id: 7, title: "Sign-in loop", status: "done" }];

function ui(over: Partial<ArtUi> = {}): ArtUi {
  return { ...initialArtUi(), list: { status: "ok", data: LIST.map((x) => ({ ...x })) }, ...over };
}
function props(screen: ArtScreen, route: ArtRoute = ART_ROUTE_NONE, over: Partial<ArtProps> = {}): ArtProps {
  return { screen, route, ui: ui(), me: "AndresL230", admin: false, persons: [], host: "canopy.test", theme: "dark", tickets: TICKETS, sprints: SPRINTS, ...over };
}
const view = (slug: string, v: number | null = null): ArtRoute => ({ slug, v, diff: null });
/** Props for the viewer with one detail loaded under the route's key. */
function viewer(d: ArtifactDetailDTO, v: number | null = null, over: Partial<ArtProps> = {}): ArtProps {
  const p = props("artifact", view(d.slug, v), over);
  p.ui.details[detailKey(d.slug, v)] = { status: "ok", data: d };
  return p;
}
const ctx = (p: ArtProps) => ({ screen: p.screen, route: p.route, me: p.me, admin: p.admin, host: "https://canopy.test", sprints: p.sprints });

// ── library ──────────────────────────────────────────────────────────────────

describe("artifacts — library", () => {
  it("renders the list as cards, newest first, with no preview strip", () => {
    const html = artifactsView(props("artifacts"));
    expect(html).not.toContain("PREVIEW");
    expect((html.match(/data-act="artOpen"/g) ?? []).length).toBe(5);
    expect(html).toContain("5 shown · 5 total");
    expect(html.indexOf("google-signin-design")).toBeLessThan(html.indexOf("auth-audit-sep-2026"));
    expect(html).not.toMatch(/undefined|NaN|\[object/);
  });

  it("thumbnails per kind: html framed from the raw route at its latest version with scripts (never same-origin), svg in an empty sandbox, image as an image, text as the excerpt, pdf as its icon", () => {
    const html = artifactsView(props("artifacts"));
    expect(html).toContain('src="/raw/a/google-signin-design@v3" sandbox="allow-scripts" tabindex="-1" loading="lazy"');
    expect(html).not.toContain("srcdoc");
    expect(html).not.toContain("allow-same-origin");
    const withSvg = props("artifacts");
    withSvg.ui.list = { status: "ok", data: [summary("logo-mark", { kind: "svg", current_version: 2 })] };
    expect(artifactsView(withSvg)).toContain('src="/raw/a/logo-mark@v2" sandbox="" tabindex="-1" loading="lazy"');
    expect(html).toContain('<img src="/raw/a/login-mock@v1"');
    expect(html).toContain("Auth audit\nFindings");
    expect(html).toContain("PDF · 2.00 MB");
  });

  it("filters client-side by the popover and by search (a ticket number or title finds what's attached)", () => {
    const p = props("artifacts");
    artifactsAct(p.ui, ctx(p), "artFilterPick", "kind:markdown", null);
    expect(libraryRows(p).map((a) => a.slug)).toEqual(["auth-audit-sep-2026"]);
    artifactsAct(p.ui, ctx(p), "artFilterClear", null, null);
    artifactsAct(p.ui, ctx(p), "artFilterPick", "sprint:14", null);
    expect(libraryRows(p).map((a) => a.slug)).toEqual(["google-signin-design"]);
    artifactsAct(p.ui, ctx(p), "artFilterClear", null, null);
    artifactsAct(p.ui, ctx(p), "artQ", null, "#9");
    expect(libraryRows(p).map((a) => a.slug)).toEqual(["auth-audit-sep-2026"]);
    artifactsAct(p.ui, ctx(p), "artQ", null, "staff");
    expect(libraryRows(p).map((a) => a.slug)).toEqual(["google-signin-design"]);
    artifactsAct(p.ui, ctx(p), "artQ", null, "zzz-nothing");
    expect(artifactsView(p)).toContain("No artifacts match these filters.");
  });

  it("the filter popover counts each option and offers every kind and the known sprints", () => {
    const p = props("artifacts");
    p.ui.filterOpen = true;
    // Every category's panel is rendered (only the current one shown), so switching
    // category never needs a rerender.
    const html = artifactsView(p);
    for (const k of ["html", "markdown", "svg", "mermaid", "image", "pdf", "file"]) expect(html).toContain(`data-arg="kind:${k}"`);
    expect(html).toContain("Sprint 14");
    expect(html).toContain('data-fm-panel="area" class="fm-panel">');
    expect(html).toContain('data-fm-panel="kind" class="fm-panel" hidden>');
  });

  it("search and Filter are ONE combined control: the input and the Filter toggle inside a single .cnpy-sfbar", () => {
    const p = props("artifacts");
    p.ui.q = "auth";
    const bar = sfbar(artifactsView(p));
    expect(bar).not.toBeNull();
    expect(bar).toContain('data-act="artQ" data-field="artQ"');
    expect(bar).toContain('placeholder="Search by title, area, kind or ticket"');
    expect(bar).toContain('data-act="artClearQ"');
    expect(bar).toContain('data-act="fmToggle" data-arg="art"');
    expect(bar).not.toContain('class="cnpy-search"');
  });

  it("the filter menu opens on hover and its categories switch on hover", () => {
    const p = props("artifacts");
    expect(artifactsView(p)).toContain('data-hover-menu="art"');
    p.ui.filterOpen = true;
    const html = artifactsView(p);
    for (const k of ["area", "kind", "author", "status", "sprint"]) {
      expect(html).toContain(`data-act="fmCat" data-hover="fmCat" data-arg="art:${k}"`);
    }
    // The click-outside backdrop sits OUTSIDE the hover wrapper, or leaving could never close it.
    expect(html.indexOf('data-act="fmClose" data-arg="art" style="position:fixed')).toBeLessThan(html.indexOf('data-hover-menu="art"'));
  });

  it("plays the menu's entrance only on the render that opens it", () => {
    const p = props("artifacts");
    p.ui.filterOpen = true;
    expect(artifactsView({ ...p, fmOpening: "art" })).toContain("fm-pop is-opening");
    expect(artifactsView({ ...p, fmOpening: null })).not.toContain("is-opening");
  });

  it("loading, error and empty states", () => {
    expect(artifactsView(props("artifacts", ART_ROUTE_NONE, { ui: initialArtUi() }))).toContain("Loading artifacts");
    expect(artifactsView(props("artifacts", ART_ROUTE_NONE, { ui: { ...initialArtUi(), list: { status: "error", data: null } } }))).toContain("Couldn't load artifacts.");
    expect(artifactsView(props("artifacts", ART_ROUTE_NONE, { ui: { ...initialArtUi(), list: { status: "ok", data: [] } } }))).toContain("No artifacts yet.");
  });

  it("puts New artifact in the header", () => {
    expect(artifactsHeader(props("artifacts")).controls).toContain('data-act="artNew"');
  });
});

// ── viewer ───────────────────────────────────────────────────────────────────

describe("artifacts — viewer per kind", () => {
  it("html: an iframe on the raw route, scripts allowed, never same-origin, never srcdoc", () => {
    const html = artifactsView(viewer(detail("google-signin-design", "html")));
    expect(html).toContain('src="/raw/a/google-signin-design@v3" sandbox="allow-scripts"');
    expect(html).toContain('class="art-frame" data-art-key="google-signin-design@3"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).not.toContain("srcdoc");
  });

  it("svg: inlined only through the sanitizer", () => {
    const html = artifactsView(viewer(detail("logo", "svg", { content: `<svg><script>alert(1)</script></svg>` })));
    expect(html).toContain('<div class="art-svg"');
    expect(html).toContain("<div data-svg-clean>");
    expect(html).not.toContain("<script>");
  });

  it("markdown through renderMarkdown; mermaid waits for the post-paint renderer", () => {
    expect(artifactsView(viewer(detail("auth-audit", "markdown")))).toContain('<div class="cnpy-md" style="max-width:760px;margin:0 auto"><div data-md>');
    const mm = artifactsView(viewer(detail("session-flow", "mermaid")));
    expect(mm).toContain('data-art-mermaid="session-flow@3|dark"');
    expect(mm).toContain("Rendering diagram…");
  });

  it("image as <img>, pdf in an unsandboxed frame (Chrome draws no PDF in a sandbox) with a new-tab link, file as a download card", () => {
    expect(artifactsView(viewer(detail("login-mock", "image")))).toContain('<img src="/raw/a/login-mock@v3" alt="login mock"');
    const pdf = artifactsView(viewer(detail("rfc", "pdf")));
    expect(pdf).toContain('src="/raw/a/rfc@v3" style=');
    expect(pdf).not.toMatch(/src="\/raw\/a\/rfc@v3"[^>]*sandbox/);
    expect(pdf).toContain("Open PDF in a new tab");
    const f = detail("bundle", "file");
    f.version = ver(3, { content_type: "application/zip", size_bytes: 3 * 1024 * 1024 });
    const file = artifactsView(viewer(f));
    expect(file).toContain("bundle-v3.bin");
    expect(file).toContain("3.00 MB · application/zip");
    expect(file).toContain('data-act="artDownload"');
    // A stored filename wins when the API sends one.
    expect(artFileName("bundle", "file", { ...ver(2), filename: "report.zip" } as ArtifactVersionDTO)).toBe("report.zip");
    expect(artFileName("rfc", "pdf", ver(2, { content_type: "application/pdf" }))).toBe("rfc-v2.pdf");
    expect(artFileName("page", "html", ver(4))).toBe("page-v4.html");
  });
});

describe("artifacts — viewer chrome", () => {
  it("an older version says so and offers the compare", () => {
    const html = artifactsView(viewer(detail("google-signin-design", "html", {}, 3, 1), 1));
    expect(html).toContain("older version");
    expect(html).toContain('data-act="artDiff" data-arg="google-signin-design:1..3"');
    expect(html).toContain("/#artifacts/google-signin-design/v1");
  });

  it("a private page carries no standing banner; the not-found page answers a 404", () => {
    expect(artifactsView(viewer(detail("mine", "html", { visibility: "private", status: "draft" })))).not.toContain("Only you can see this artifact.");
    const p = props("artifact", view("nope"));
    p.ui.details[detailKey("nope", null)] = { status: "missing", data: null };
    expect(artifactsView(p)).toContain("This artifact isn't available.");
    expect(artifactsHeader(p).crumb).toContain("Not found");
  });

  it("shows linked work from the DTO's links", () => {
    const d = detail("x", "html", {
      links: [
        { target_type: "ticket", target_ref: "10", label: null, meta: null },
        { target_type: "sprint", target_ref: "14", label: "Sprint 14", meta: null },
        { target_type: "pr", target_ref: "SaplingLearn/canopy#212", label: null, meta: null },
      ],
    });
    const html = artifactsView(viewer(d));
    expect(html).toContain('data-act="openTicket" data-arg="10"');
    expect(html).toContain("Google sign-in for staff");
    expect(html).toContain("TICKET #10 · IN PROGRESS");
    expect(html).toContain("SEP 14 – SEP 27 · ACTIVE");
    expect(html).toContain('href="https://github.com/SaplingLearn/canopy/pull/212"');
  });

  it("names the artifact in the header crumb, and Compare on a diff", () => {
    expect(artifactsHeader(viewer(detail("auth-audit", "markdown", { title: "Auth audit report" }))).crumb).toContain("Auth audit report");
    const p = props("artifact", { slug: "auth-audit", v: null, diff: { a: 1, b: 2 } });
    p.ui.details[detailKey("auth-audit", null)] = { status: "ok", data: detail("auth-audit", "markdown") };
    const c = artifactsHeader(p).crumb;
    expect(c).toContain('data-act="artOpen"');
    expect(c).toContain("Compare");
  });
});

// ── reducer: writes come out as effects ──────────────────────────────────────

describe("artifacts — reducer", () => {
  it("draft ⇄ published is a PATCH; ratified opens the dialog only on the latest published version", () => {
    const p = viewer(detail("a", "html"));
    expect(artifactsAct(p.ui, ctx(p), "artStatus", "draft", null)).toEqual({ write: { op: "patch", slug: "a", body: { status: "draft" }, flash: "Moved back to draft" } });
    expect(artifactsAct(p.ui, ctx(p), "artStatus", "ratified", null)).toBeNull();
    expect(p.ui.ratifyOpen).toBe(true);
    expect(artifactsDialogs(p)).toContain("Ratify v3");
    expect(artifactsAct(p.ui, ctx(p), "artRatifyConfirm", null, null)).toEqual({ write: { op: "ratify", slug: "a", version: 3, flash: "Ratified v3" } });

    const old = viewer(detail("a", "html", {}, 3, 1), 1);
    artifactsAct(old.ui, ctx(old), "artStatus", "ratified", null);
    expect(old.ui.ratifyOpen).toBe(false);
    const draft = viewer(detail("a", "html", { status: "draft" }));
    artifactsAct(draft.ui, ctx(draft), "artStatus", "ratified", null);
    expect(draft.ui.ratifyOpen).toBe(false);
    // A write in flight holds the controls.
    p.ui.busy = true;
    expect(artifactsAct(p.ui, ctx(p), "artStatus", "draft", null)).toBeNull();
  });

  it("only the author may make an org artifact private; anyone who sees a private one may publish it", () => {
    const theirs = viewer(detail("a", "html", { author_id: "Jose-Gael-Cruz-Lopez" }));
    expect(artifactsAct(theirs.ui, ctx(theirs), "artVis", null, null)).toBeNull();
    const mine = viewer(detail("a", "html"));
    expect(artifactsAct(mine.ui, ctx(mine), "artVis", null, null)).toMatchObject({ write: { op: "patch", body: { visibility: "private" }, flash: expect.stringContaining("Only you can see this artifact."), flashMs: 3000 } });
    const priv = viewer(detail("a", "html", { visibility: "private" }));
    expect(artifactsAct(priv.ui, ctx(priv), "artVis", null, null)).toMatchObject({ write: { op: "patch", body: { visibility: "org" }, flash: "Published to the org" } });
  });

  it("attaches a ticket once, as a POST link", () => {
    const p = viewer(detail("a", "html", { links: [{ target_type: "ticket", target_ref: "10", label: null, meta: null }] }));
    artifactsAct(p.ui, ctx(p), "artAttachOpen", null, null);
    expect(artifactsDialogs(p)).toContain("ATTACHED");
    artifactsAct(p.ui, ctx(p), "artAttachPick", "10", null); // already attached
    expect(p.ui.attachPick).toBeNull();
    artifactsAct(p.ui, ctx(p), "artAttachPick", "7", null);
    expect(artifactsAct(p.ui, ctx(p), "artAttachConfirm", null, null)).toEqual({ write: { op: "link", slug: "a", target_type: "ticket", target_ref: "7", flash: "Attached to ticket #7" } });
  });

  it("open in a new tab and download go to the raw route", () => {
    const p = viewer(detail("a", "html", {}, 3, 2), 2);
    expect(artifactsAct(p.ui, ctx(p), "artOpenTab", null, null)).toEqual({ openUrl: "/raw/a/a@v2" });
    expect(artifactsAct(p.ui, ctx(p), "artDownload", null, null)).toEqual({ download: { url: "/raw/a/a@v2?download=1", name: "a-v2.html" } });
  });

  it("navigates: both version spellings, and a diff pair from the selects", () => {
    const p = props("artifacts");
    expect(artifactsAct(p.ui, ctx(p), "artOpen", "a-page@v3", null)).toEqual({ nav: { screen: "artifact", route: { slug: "a-page", v: 3, diff: null } } });
    expect(artifactsAct(p.ui, ctx(p), "artOpen", "a-page", null)).toEqual({ nav: { screen: "artifact", route: { slug: "a-page", v: null, diff: null } } });
    const d = props("artifact", { slug: "a-page", v: null, diff: { a: 1, b: 3 } });
    expect(artifactsAct(d.ui, ctx(d), "artDiffA", "a-page", "2", )).toEqual({ nav: { screen: "artifact", route: { slug: "a-page", v: null, diff: { a: 2, b: 3 } } } });
  });
});

// ── delete (0035 PART D): author / admin only, the shared in-app confirm, an Undo toast ──

describe("artifacts — delete", () => {
  const open = (p: ArtProps) => { artifactsAct(p.ui, ctx(p), "artDotMenu", null, null); return artifactsView(p); };

  it("offers Delete artifact in the … menu only to its author or an admin (case-insensitive)", () => {
    const d = detail("a", "html", { author_id: "Jose-Gael-Cruz-Lopez" });
    expect(canDeleteArtifact(d, "jose-gael-cruz-lopez", false)).toBe(true);
    expect(canDeleteArtifact(d, "someone", true)).toBe(true);
    expect(canDeleteArtifact(d, "someone", false)).toBe(false);
    expect(canDeleteArtifact(d, "", false)).toBe(false);
    expect(open(viewer(d))).not.toContain("artDeleteArm"); // AndresL230, not an admin
    expect(open(viewer(d, null, { admin: true }))).toContain('data-act="artDeleteArm"');
    const mine = open(viewer(detail("a", "html")));
    expect(mine).toContain('data-act="artDeleteArm"');
    expect(mine).toContain("Delete artifact");
    expect(mine).not.toContain('role="alertdialog"'); // the confirm opens only when armed
    // A stranger cannot arm it through the reducer either.
    const theirs = viewer(d);
    expect(artifactsAct(theirs.ui, ctx(theirs), "artDeleteArm", null, null)).toBeNull();
    expect(theirs.ui.deleteArm).toBe(false);
  });

  it("confirms in the shared MODAL — Delete focused so Enter confirms, once — never window.confirm", () => {
    const p = viewer(detail("a", "html", { title: "Sign-in flow" }));
    artifactsAct(p.ui, ctx(p), "artDotMenu", null, null);
    expect(artifactsDialogs(p)).toBe(""); // nothing until armed
    expect(artifactsAct(p.ui, ctx(p), "artDeleteArm", null, null)).toEqual({ focus: "[data-confirm-focus]" });
    expect(p.ui.dotMenu).toBe(false);
    expect(artifactsView(p)).not.toContain('role="alertdialog"'); // the modal is an app-root overlay, not in the page
    const html = artifactsDialogs(p);
    expect(html).toContain('data-overlay="confirm-art-delete-confirm"');
    expect(html).toContain('id="art-delete-confirm" role="alertdialog" aria-modal="true" aria-labelledby="art-delete-confirm-t" aria-describedby="art-delete-confirm-d" tabindex="-1" data-confirm-dialog data-confirm-act="artDelete" data-confirm-cancel="artDeleteCancel" class="cnpy-surface cnpy-cmodal-box"');
    expect(html).toMatch(/<div data-act="artDeleteCancel" class="cnpy-cmodal-back" aria-hidden="true">/);
    expect(html).toContain("Delete “Sign-in flow”?");
    expect(html).toContain("All 3 versions are kept and you can undo.");
    expect(html).toMatch(/data-act="artDelete" data-confirm-focus class="cnpy-confirm-go"[^>]*>Delete</);
    expect(html).toMatch(/data-act="artDeleteCancel" class="cnpy-outlinebtn"[^>]*>Cancel</);
    expect(artifactsView(p)).toMatch(/data-act="artDotMenu"[^>]*data-confirm-trigger/); // focus returns here on cancel
    // …and it reaches the page through render()'s root.
    const one = viewer(detail("b", "html", {}, 1));
    artifactsAct(one.ui, ctx(one), "artDeleteArm", null, null);
    expect(artifactsDialogs(one)).toContain("Its one version is kept and you can undo.");
    // Enter / the Delete click → ONE write; busy holds every further press and says so.
    expect(artifactsAct(p.ui, ctx(p), "artDelete", null, null)).toEqual({ write: { op: "delete", slug: "a" } });
    expect(p.ui.deleteBusy).toBe(true);
    expect(artifactsAct(p.ui, ctx(p), "artDelete", null, null)).toBeNull();
    const busy = artifactsDialogs(p);
    expect(busy).toContain("Deleting…");
    expect(busy).toMatch(/data-confirm-dialog [^>]*data-busy/);
    expect(artifactsAct(p.ui, ctx(p), "artDeleteCancel", null, null)).toBeNull(); // Escape can't cancel mid-write
    // Escape / the backdrop / Cancel close it and return focus to the … button.
    p.ui.deleteBusy = false;
    expect(artifactsAct(p.ui, ctx(p), "artDeleteCancel", null, null)).toEqual({ focus: "[data-confirm-trigger]" });
    expect(artifactsDialogs(p)).toBe("");
    // A stranger's viewer never renders it, even if armed by hand.
    const theirs = viewer(detail("c", "html", { author_id: "Jose-Gael-Cruz-Lopez" }));
    theirs.ui.deleteArm = true;
    expect(artifactsDialogs(theirs)).toBe("");
    for (const src of [artifactsSrc, mainSrc]) {
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, ""); // comments may NAME it
      // A bare confirm( / alert( — not a method like the icon helper `I.alert(`.
      expect(code).not.toMatch(/window\.confirm|(?<![.\w])confirm\(|(?<![.\w])alert\(/);
    }
  });

  it("the toast's Undo restores it, from any screen", () => {
    const p = props("artifacts");
    expect(artifactsAct(p.ui, ctx(p), "artRestore", "a", null)).toEqual({ write: { op: "restore", slug: "a" } });
    const html = render({
      ...initialState(), view: "app", me: { handle: "alice", name: null, avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin: false },
      toast: "Deleted “Sign-in flow”", toastAction: { label: "Undo", act: "artRestore", arg: "sign-in-flow" }, toastAt: Date.now(), toastMs: 8000,
    });
    expect(html).toContain('data-act="artRestore" data-arg="sign-in-flow" class="cnpy-toast-act"');
  });
});

// ── new version ──────────────────────────────────────────────────────────────

describe("artifacts — new version", () => {
  it("the toolbar opens an editor seeded with the shown version; an untouched edit can't be saved", () => {
    const p = viewer(detail("auth-flow", "html"));
    expect(artifactsView(p)).toContain('data-act="artNvOpen"');
    expect(artifactsAct(p.ui, ctx(p), "artNvOpen", null, null)).toBeNull();
    const dlg = artifactsDialogs(p);
    expect(dlg).toContain("New version · v4");
    expect(dlg).toContain("&lt;h1&gt;hi&lt;/h1&gt;</textarea>");
    expect(dlg).toContain("Save v4");
    expect(artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null)).toBeNull();

    artifactsAct(p.ui, ctx(p), "artNvText", null, "<h1>hello</h1>");
    artifactsAct(p.ui, ctx(p), "artNvSummary", null, "  Say hello  ");
    expect(artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null)).toEqual({
      write: { op: "version", slug: "auth-flow", body: { content: "<h1>hello</h1>", summary: "Say hello" } },
    });
    expect(p.ui.nv?.submitting).toBe(true);
    // A second click while saving does nothing, and the dialog can't be dismissed mid-save.
    expect(artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null)).toBeNull();
    artifactsAct(p.ui, ctx(p), "artCloseDialogs", null, null);
    expect(p.ui.nv).not.toBeNull();
  });

  it("from an older version the untouched text is a restore, and says so", () => {
    const p = viewer(detail("auth-flow", "html", {}, 3, 1), 1);
    artifactsAct(p.ui, ctx(p), "artNvOpen", null, null);
    expect(artifactsDialogs(p)).toContain("Starting from v1, an older version.");
    expect(artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null)).toMatchObject({ write: { op: "version", body: { content: "<h1>hi</h1>" } } });
  });

  it("a replacement file must sit on the page's side (text / binary); a bundled export warns to flatten", () => {
    const p = viewer(detail("auth-flow", "html"));
    artifactsAct(p.ui, ctx(p), "artNvOpen", null, null);
    artifactsAct(p.ui, ctx(p), "artNvTab", "file", null);
    expect(artifactsDialogs(p)).toContain('data-art-drop="nv"');
    artAcceptNvFile(p.ui, "html", { name: "shot.png", size: 10, text: null, blob: new Blob([new Uint8Array(10)]) });
    expect(p.ui.nv?.file).toBeNull();
    expect(artifactsDialogs(p)).toContain("replaced by a .html file, not shot.png");

    const bundled = `<html><script type="__bundler/manifest">{}</script></html>`;
    artAcceptNvFile(p.ui, "html", { name: "export.html", size: bundled.length, text: bundled, blob: null });
    expect(artifactsDialogs(p)).toContain("FLATTEN FIRST");
    expect(artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null)).toMatchObject({ write: { op: "version", body: { content: bundled, summary: "" } } });
  });

  it("a binary page offers only an upload and sends the file multipart", () => {
    const p = viewer(detail("login-mock", "image", { content: null }));
    artifactsAct(p.ui, ctx(p), "artNvOpen", null, null);
    expect(p.ui.nv?.tab).toBe("file");
    artifactsAct(p.ui, ctx(p), "artNvTab", "edit", null);
    expect(p.ui.nv?.tab).toBe("file");
    const blob = new Blob([new Uint8Array(2048)], { type: "image/png" });
    artAcceptNvFile(p.ui, "image", { name: "mock-v2.png", size: 2048, text: null, blob });
    const fx = artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null) as { write: { op: string; body: { file: Blob; filename: string } } };
    expect(fx.write.op).toBe("version");
    expect(fx.write.body.file).toBe(blob);
    expect(fx.write.body.filename).toBe("mock-v2.png");
  });

  it("over the cap can't be saved", () => {
    const p = viewer(detail("auth-flow", "html"));
    artifactsAct(p.ui, ctx(p), "artNvOpen", null, null);
    artifactsAct(p.ui, ctx(p), "artNvText", null, "x".repeat(ARTIFACT_TEXT_CAP + 1));
    expect(artifactsDialogs(p)).toContain("Over the 750 KB cap.");
    expect(artifactsAct(p.ui, ctx(p), "artNvSubmit", null, null)).toBeNull();
  });
});

// ── diff ─────────────────────────────────────────────────────────────────────

describe("artifacts — diff", () => {
  const pair = (kind: ArtifactKind, a: string | null, b: string | null, over: Partial<ArtifactVersionDTO> = {}): ArtifactDiffDTO => ({
    kind, a: { ...ver(1), content: a, raw_url: "/raw/a/x@v1" }, b: { ...ver(2, over), content: b, raw_url: "/raw/a/x@v2" },
  });
  function diffProps(kind: ArtifactKind, dto: ArtifactDiffDTO | null): ArtProps {
    const p = props("artifact", { slug: "x", v: null, diff: { a: 1, b: 2 } });
    p.ui.details[detailKey("x", null)] = { status: "ok", data: detail("x", kind, {}, 2) };
    if (dto) p.ui.diffs[diffKey("x", 1, 2)] = { status: "ok", data: dto };
    return p;
  }
  it("text kinds: a line diff with counts", () => {
    const html = artifactsView(diffProps("markdown", pair("markdown", "a\nb\nc", "a\nB\nc")));
    expect(html).toContain("+1");
    expect(html).toContain("−1");
    expect(html).toContain("Compare versions");
  });
  it("image side by side; pdf/file metadata only; loading until it lands", () => {
    const img = artifactsView(diffProps("image", pair("image", null, null)));
    expect(img).toContain('<img src="/raw/a/x@v1"');
    expect(img).toContain('<img src="/raw/a/x@v2"');
    const pdf = artifactsView(diffProps("pdf", pair("pdf", null, null, { sha256: "cd".repeat(32), size_bytes: 4096 })));
    expect(pdf).toContain("can't be compared line by line");
    expect(pdf).toContain("SHA-256");
    expect(artifactsView(diffProps("markdown", null))).toContain("Loading the comparison");
  });
});

// ── new artifact ─────────────────────────────────────────────────────────────

describe("artifacts — new artifact", () => {
  it("parses the link forms the field accepts, sprints by label", () => {
    expect(parseArtLink("#10")).toMatchObject({ kind: "ticket", target_type: "ticket", target_ref: "10" });
    expect(parseArtLink("Sprint 14", SPRINTS)).toMatchObject({ kind: "sprint", target_type: "sprint", target_ref: "14" });
    expect(parseArtLink("Sprint 99", SPRINTS)).toBeNull();
    expect(parseArtLink("https://github.com/SaplingLearn/canopy/pull/212")).toMatchObject({ kind: "PR", target_type: "pr", target_ref: "SaplingLearn/canopy#212" });
    expect(parseArtLink("https://github.com/SaplingLearn/sapling/issues/9")).toMatchObject({ kind: "issue", target_ref: "SaplingLearn/sapling#9" });
    expect(parseArtLink("pr 12")).toMatchObject({ target_type: "pr", target_ref: "#12" });
    expect(parseArtLink("hello")).toBeNull();
  });

  it("offers every kind; a binary kind moves to the file tab and shows the 10 MB cap", () => {
    const p = props("artifactnew");
    const html = artifactsView(p);
    for (const k of ["html", "markdown", "svg", "mermaid", "image", "pdf", "file"]) expect(html).toContain(`data-act="artCKind" data-arg="${k}"`);
    expect(html).toContain("/ 750 KB");
    artifactsAct(p.ui, ctx(p), "artCKind", "pdf", null);
    expect(p.ui.c.tab).toBe("file");
    expect(artifactsView(p)).toContain("/ 10 MB");
    // Paste and URL are text-only.
    artifactsAct(p.ui, ctx(p), "artCTab", "paste", null);
    expect(p.ui.c.tab).toBe("file");
  });

  it("blocks an upload over the text cap and warns on claude.ai-only calls", () => {
    const p = props("artifactnew");
    p.ui.c.title = "Big";
    p.ui.c.paste = "x".repeat(750 * 1024 + 1);
    expect(artifactsView(p)).toContain("Over the 750 KB cap.");
    expect(artifactsAct(p.ui, ctx(p), "artCSubmit", null, null)).toBeNull();
    p.ui.c.paste = "<script>window.claude.complete('x')</script>";
    expect(artifactsView(p)).toContain("CLAUDE.AI ONLY");
  });

  it("warns that a bundled Claude Design export must be flattened, and still lets it upload", () => {
    const p = props("artifactnew");
    p.ui.c.title = "Restyle";
    p.ui.c.paste = `<html><body><script>/* loader */</script><script type="__bundler/manifest">{}</script></body></html>`;
    expect(artifactsView(p)).toContain("FLATTEN FIRST");
    expect(artifactsAct(p.ui, ctx(p), "artCSubmit", null, null)).not.toBeNull();
    p.ui.c.paste = "<html><body><script>render()</script></body></html>";
    expect(artifactsView(p)).not.toContain("FLATTEN FIRST");
  });

  it("a picked file sets the kind from its extension; a binary one is sent multipart", () => {
    const p = props("artifactnew");
    const blob = new Blob([new Uint8Array(2048)], { type: "image/png" });
    artAcceptFile(p.ui, { name: "login-mock.png", size: 2048, text: null, blob });
    expect(p.ui.c.kind).toBe("image");
    expect(p.ui.c.title).toBe("login mock");
    expect(createBytes(p.ui.c)).toBe(2048);
    const fx = artifactsAct(p.ui, ctx(p), "artCSubmit", null, null);
    expect(fx).toMatchObject({ write: { op: "create", content: null, filename: "login-mock.png", fields: { kind: "image", title: "login mock" } } });
    expect((fx as { write: { file: Blob } }).write.file).toBe(blob);
    expect(p.ui.c.submitting).toBe(true);
    // A binary file over 10 MB is refused.
    const q = props("artifactnew");
    artAcceptFile(q.ui, { name: "huge.pdf", size: 11 * 1024 * 1024, text: null, blob });
    expect(artifactsView(q)).toContain("Over the 10 MB cap.");
    expect(artifactsAct(q.ui, ctx(q), "artCSubmit", null, null)).toBeNull();
  });

  it("a text upload is a JSON body with its links", () => {
    const p = props("artifactnew");
    p.ui.c.title = "Retro board";
    p.ui.c.paste = "# Retro";
    artifactsAct(p.ui, ctx(p), "artCKind", "markdown", null);
    artifactsAct(p.ui, ctx(p), "artCLinkDraft", null, "#10");
    artifactsAct(p.ui, ctx(p), "artCLinkAdd", null, null);
    expect(artifactsAct(p.ui, ctx(p), "artCSubmit", null, null)).toEqual({
      write: {
        op: "create",
        fields: { title: "Retro board", kind: "markdown", area: "ui", repo: "SaplingLearn/canopy", visibility: "org", summary: "Uploaded from Canopy" },
        content: "# Retro", file: null, filename: null, links: [{ target_type: "ticket", target_ref: "10" }],
      },
    });
  });

  it("the URL tab asks the fetch route and shows the returned text", () => {
    const p = props("artifactnew");
    artifactsAct(p.ui, ctx(p), "artCTab", "url", null);
    artifactsAct(p.ui, ctx(p), "artCUrl", null, "https://example.com/page.html");
    expect(artifactsAct(p.ui, ctx(p), "artCFetch", null, null)).toEqual({ write: { op: "fetchUrl", url: "https://example.com/page.html" } });
    expect(artifactsView(p)).toContain("Fetching…");
    p.ui.c.fetching = false;
    p.ui.c.urlFetched = { text: "<h1>fetched page</h1>" };
    expect(artifactsView(p)).toContain("&lt;h1&gt;fetched page&lt;/h1&gt;");
  });
});

// ── the ticket detail's block ────────────────────────────────────────────────

describe("artifacts — on the ticket detail", () => {
  it("lists what's attached, or says how to attach one", () => {
    const html = ticketArtifactsBlock({ status: "ok", data: [LIST[0]] });
    expect(html).toContain('data-act="artOpen" data-arg="google-signin-design"');
    expect(html).toContain("HTML · V3 · @JOSE-GAEL-CRUZ-LOPEZ");
    expect(html).toContain("PUBLISHED");
    expect(ticketArtifactsBlock({ status: "ok", data: [] })).toContain("No artifacts attached.");
    expect(ticketArtifactsBlock(undefined)).toContain("Loading artifacts");
  });
});

// ── search results (GET /search `type: "artifact"`, id = slug) ────────────────

describe("artifacts — in Search", () => {
  function searchHtml(over: Partial<ReturnType<typeof initialState>> = {}): string {
    return render({
      ...initialState(), view: "app", screen: "search",
      searchResults: {
        status: "ok",
        data: {
          primary: [{
            type: "artifact", id: "google-signin-design", title: "Google sign-in design page",
            section: null, space: null, body: "Status: published · v3", authority: "live",
            current_version: null, pending_version: null, staged_body: null, confidence: null,
            updated_at: null, updated_by: null, score: 1,
          }],
          pointers: [{ type: "artifact", id: "auth-audit-sep-2026", title: "Auth audit", snippet: "…", authority: "draft", score: 1 }],
          meta: { engine: "fts5", total: 2 },
        },
      },
      ...over,
    });
  }

  it("QueryType carries artifact, and an artifact hit opens the viewer through artOpen, not the doc route", () => {
    const html = searchHtml();
    expect(html).toContain('data-act="artOpen" data-arg="google-signin-design"');
    expect(html).toContain('data-act="artOpen" data-arg="auth-audit-sep-2026"');
    expect(html).not.toContain('data-act="openDocFrom"');
    // …and artOpen with that id lands on #artifacts/<slug>.
    const p = props("artifacts");
    expect(artifactsAct(p.ui, ctx(p), "artOpen", "google-signin-design", null)).toEqual({ nav: { screen: "artifact", route: { slug: "google-signin-design", v: null, diff: null } } });
  });

  it("labels an artifact result like the other types", () => {
    expect(searchHtml()).toMatch(/<path d="M3 4h18v16H3zM3 9h18M7 13\.5h6M7 16\.5h9"><\/path><\/svg>Artifact<\/span>/);
  });

  it("the type filter offers Artifacts and keeps only artifact hits", () => {
    expect(searchHtml()).toContain('data-act="setSearchType" data-arg="artifact"');
    const docOnly = searchHtml({ searchType: "doc" });
    expect(docOnly).not.toContain('data-arg="google-signin-design"');
    expect(searchHtml({ searchType: "artifact" })).toContain('data-arg="google-signin-design"');
  });
});

// ── in the app shell ─────────────────────────────────────────────────────────

describe("artifacts — in the app shell", () => {
  it("renders through render() with the sidebar lighting Artifacts", () => {
    const s = { ...initialState(), view: "app" as const, screen: "artifacts" as const, art: ui() };
    const html = render(s);
    expect(html).toContain('class="cnpy-navrow n-artifacts is-active"');
    expect(html).toContain("New artifact");
  });

  it("escapes a hostile title", () => {
    const p = props("artifacts");
    p.ui.list.data![0].title = `<img src=x onerror=alert(1)>`;
    expect(artifactsView(p)).not.toContain("<img src=x");
  });
});

// ── segmented switches — the shared `segmented()` component ──────────────────

describe("artifacts — segmented switches", () => {
  /** The `.cnpy-seg` group carrying `data-seg="<id>"`, up to its closing </div>. */
  const segOf = (html: string, id: string): string => {
    const at = html.indexOf(`data-seg="${id}"`);
    expect(at).toBeGreaterThan(-1);
    return html.slice(html.lastIndexOf("<div", at), html.indexOf("</div>", at) + 6);
  };

  it("the viewer's status switch: xs, every option keeps its act, ratified is the accent option with the shield", () => {
    const seg = segOf(artifactsView(viewer(detail("a", "html"))), "art-status");
    expect(seg).toContain('class="cnpy-seg cnpy-seg--xs"');
    expect(seg).toContain('aria-label="Status"');
    expect(seg).toMatch(/class="cnpy-seg-btn is-on" data-act="artStatus" data-arg="published" aria-pressed="true">Published</);
    expect(seg).toContain('data-act="artStatus" data-arg="draft" aria-pressed="false">Draft<');
    expect(seg).toMatch(/data-act="artStatus" data-arg="ratified" data-tone="accent" aria-pressed="false" title="Ratify v3"><svg[^]*<\/svg>Ratified</);
  });

  it("a ratified option that cannot be ratified is locked — no act, disabled, with its hint", () => {
    const seg = segOf(artifactsView(viewer(detail("a", "html", { status: "draft" }))), "art-status");
    expect(seg).not.toContain('data-arg="ratified"');
    expect(seg).toMatch(/<button type="button" class="cnpy-seg-btn" disabled data-tone="accent" aria-pressed="false" title="[^"]+">/);
    expect(seg).toContain('data-act="artStatus" data-arg="published"');
  });

  it("the create form's Kind, Visibility and Content source are segmented switches with their acts", () => {
    const p = props("artifactnew");
    const html = artifactsView(p);
    const kind = segOf(html, "art-create-kind");
    for (const k of ["html", "markdown", "svg", "mermaid", "image", "pdf", "file"]) expect(kind).toContain(`data-act="artCKind" data-arg="${k}"`);
    const vis = segOf(html, "art-create-vis");
    expect(vis).toMatch(/class="cnpy-seg-btn is-on" data-act="artCVis" data-arg="org" aria-pressed="true">Org</);
    expect(vis).toContain('data-act="artCVis" data-arg="private" aria-pressed="false">Private<');
    expect(segOf(html, "art-create-source")).toContain('data-act="artCTab" data-arg="url"');
    // A binary kind locks Paste and From URL (text kinds only).
    artifactsAct(p.ui, ctx(p), "artCKind", "pdf", null);
    const src = segOf(artifactsView(p), "art-create-source");
    expect(src).not.toContain('data-arg="paste"');
    expect(src).not.toContain('data-arg="url"');
    expect((src.match(/disabled aria-pressed="false" title="Text kinds only"/g) ?? []).length).toBe(2);
    expect(src).toMatch(/class="cnpy-seg-btn is-on" data-act="artCTab" data-arg="file"/);
  });
});

describe("artifacts — surface cards", () => {
  const OLD_TINT = "color-mix(in srgb,var(--fg) 2.5%";
  const surfaces = (html: string): number => (html.match(/class="cnpy-surface[ "]/g) ?? []).length;

  it("library cards are clickable surfaces that keep their rise, with no inline card chrome", () => {
    const html = artifactsView(props("artifacts"));
    expect((html.match(/class="cnpy-surface cnpy-card cnpy-rise" style="--i:\d+;padding:0;display:flex/g) ?? []).length).toBe(5);
    expect(html).not.toContain(OLD_TINT);
    expect(html).not.toContain("border-radius:14px");
  });

  it("the viewer's content card (strong edge kept) and both detail panels are surfaces; a file card inside the content is not", () => {
    const html = artifactsView(viewer(detail("x", "html")));
    expect(html).toContain('class="cnpy-surface" style="margin-top:22px;border-color:var(--border-strong)"');
    expect(html).toContain('class="cnpy-surface art-b-props" style="padding:16px 18px;min-width:0"');
    expect(html).toContain('class="cnpy-surface art-b-links" style="padding:16px 18px;min-width:0"');
    expect(html).not.toContain(OLD_TINT);
    const file = artifactsView(viewer(detail("f", "file", { content: null })));
    expect(surfaces(file)).toBe(3);
    expect(file).not.toContain(OLD_TINT);
  });

  it("the diff: version cards and the comparison body are surfaces", () => {
    const pd = (kind: ArtifactKind, a: string | null, b: string | null): ArtProps => {
      const p = props("artifact", { slug: "x", v: null, diff: { a: 1, b: 2 } });
      p.ui.details[detailKey("x", null)] = { status: "ok", data: detail("x", kind, {}, 2) };
      p.ui.diffs[diffKey("x", 1, 2)] = { status: "ok", data: { kind, a: { ...ver(1), content: a, raw_url: "/raw/a/x@v1" }, b: { ...ver(2), content: b, raw_url: "/raw/a/x@v2" } } };
      return p;
    };
    const text = artifactsView(pd("markdown", "a\nb", "a\nB"));
    expect(surfaces(text)).toBe(3); // two version cards + the line diff
    expect(text).not.toContain(OLD_TINT);
    expect(surfaces(artifactsView(pd("image", null, null)))).toBe(4); // + two image panes
    expect(surfaces(artifactsView(pd("pdf", null, null)))).toBe(3);
  });

  it("the not-found card, a picked file on the create form, and the dialogs are surfaces", () => {
    const nf = props("artifact", view("nope"));
    nf.ui.details[detailKey("nope", null)] = { status: "missing", data: null };
    expect(artifactsView(nf)).toContain('class="cnpy-surface" style="width:420px;max-width:100%;padding:34px;');

    const c = props("artifactnew");
    artAcceptFile(c.ui, { name: "mock.png", size: 2048, text: null, blob: new Blob([new Uint8Array(2048)], { type: "image/png" }) });
    const form = artifactsView(c);
    expect(form).toContain('class="cnpy-surface" style="display:flex;align-items:center;gap:12px;padding:12px 14px"');
    expect(form).not.toContain(OLD_TINT);

    const p = viewer(detail("login-mock", "image", { content: null }));
    artifactsAct(p.ui, ctx(p), "artNvOpen", null, null);
    artAcceptNvFile(p.ui, "image", { name: "mock-v2.png", size: 2048, text: null, blob: new Blob([new Uint8Array(2048)], { type: "image/png" }) });
    const dlg = artifactsDialogs(p);
    // The floating layer keeps its strong edge and deep shadow; the picked file inside it is NOT a second surface.
    expect(dlg).toMatch(/role="dialog"[^>]*class="cnpy-surface" style="[^"]*border:1px solid var\(--border-strong\);box-shadow:0 20px 60px/);
    expect(surfaces(dlg)).toBe(1);
    expect(dlg).not.toContain(OLD_TINT);
    expect(dlg).not.toContain("background:var(--bg);box-shadow");
  });
});
