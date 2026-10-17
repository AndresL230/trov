// The doc page (`#doc/<slug>`, the screen `docs`; docs/architecture/docs-library.md › The doc page) — design spec §5.
// Above the article, a banner when the page is not simply live (a change waits in Review / it was never approved);
// the breadcrumb (the space, then each page above this one); the title; the status mark ("Live" is said here, the
// one place it is) and who last wrote it; History; the tags; the body — Markdown, with `[[slug]]` links turned into
// links to `#doc/<slug>` BEFORE it renders (shared/docs-links-core.ts `replaceDocLinks`, which never touches code),
// and a link to no page drawn as flagged text with its tooltip; then "Pages under ‹Title›". Beside it the 210px
// sticky rail: On this page (the headings, scroll-spied by main.ts), Owner, Last edited by, Version (+ History),
// Imported from, and Linked from (the live pages that link here). Pure: props in, markup out.
import { replaceDocLinks, type DocLink } from "@shared/docs-links-core";
import { extractOutline } from "@shared/doc-outline";
import type { DocPageDTO, LibraryPageDTO, SpaceDTO } from "@shared/docs-core";
import type { DocRow, DocVersionMetaRow } from "@shared/rows";
import type { PersonSummary } from "@shared/people";
import { esc, attr, surface, hitArea, HITBOX } from "./ui";
import { personLink } from "./people";
import { stateMark, glyphMark, markShape, AUTHORITY_MARK, authorityMark } from "./marks";
import { skeleton, skBar, skBox, skLine, skLines, emptyLayout } from "./skeleton";
import { renderMarkdown } from "./markdown";
import { spaceTile, pageIcon, libraryWhen } from "./library";

export interface DocPageData { doc: DocRow; versions: DocVersionMetaRow[]; tags?: string[]; page?: DocPageDTO }

export interface DocPageProps {
  /** The doc the route names (null: the space's tree is open with no page picked). */
  slug: string | null;
  detail: { status: string; data: DocPageData | null };
  /** The doc's space (the Library's), when known. */
  space: SpaceDTO | null;
  /** The space the empty page offers New page in (no doc picked). */
  emptySpace: string | null;
  persons: readonly PersonSummary[];
  showHistory: boolean;
  /** The doc's Tags row (tags.ts), drawn by render.ts. */
  tagsRow: string;
}

/** What "Live" means, said on the doc page's mark (the design's STATUS_TIP). */
export const LIVE_TIP = "This is the version everyone reads.";
export const REJECTED_TIP = "Someone turned this version down in Review. It never went live.";
/** A link to a page that does not exist. */
export const brokenLinkTip = (slug: string): string => `No page is called “${slug}” yet. The link starts working once one is.`;
/** The doc page with no page picked (a space with no page yet, or a tree with nothing open). */
export const DOC_EMPTY = "Pick a page from the tree, or write the first one. A new page waits in Review until someone approves it.";

const find = (persons: readonly PersonSummary[], h: string | null): PersonSummary | null =>
  h ? persons.find((p) => p.handle.toLowerCase() === h.toLowerCase()) ?? null : null;
const fullName = (persons: readonly PersonSummary[], h: string): string => find(persons, h)?.name || h;
const shortName = (persons: readonly PersonSummary[], h: string): string => fullName(persons, h).split(/\s+/)[0];

const ARROW = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>`;
const CLOCK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>`;

/**
 * The body with its `[[slug]]` links as HTML (inline, so marked keeps them and DOMPurify sanitizes them): a link to a
 * page that exists is `<a class="cnpy-doclink" href="#doc/<slug>">` with its label (else the page's title), one to no
 * page is flagged text (`.cnpy-doclink is-broken`) with a tooltip. Code spans and fenced blocks are left as written.
 */
export function linkedBody(body: string, page: Pick<DocPageDTO, "links" | "broken_links"> | null): string {
  const titles = new Map((page?.links ?? []).map((l) => [l.slug, l]));
  const broken = new Set(page?.broken_links ?? []);
  return replaceDocLinks(body, (l: DocLink) => {
    const hit = titles.get(l.slug);
    if (hit) {
      const where = [...hit.path, hit.title].join(" › ");
      return `<a class="cnpy-doclink" href="#doc/${attr(encodeURIComponent(l.slug))}" data-mtip="${attr(where)}">${esc(l.label ?? hit.title)}</a>`;
    }
    if (broken.has(l.slug) || !page) return `<span class="cnpy-doclink is-broken" data-mtip="${attr(brokenLinkTip(l.slug))}">${esc(l.label ?? l.slug)}</span>`;
    return esc(l.label ?? l.slug);
  });
}

/** The body as the outline reads it: each link as its words (so a heading's id matches the rendered one). */
const outlineBody = (body: string, page: DocPageDTO | null): string => {
  const titles = new Map((page?.links ?? []).map((l) => [l.slug, l.title]));
  return replaceDocLinks(body, (l) => l.label ?? titles.get(l.slug) ?? l.slug);
};

/** The id of "Pages under ‹Title›" (the rail's last entry when there are children). */
export const CHILDREN_ANCHOR = "pages-under";

// ── the parts ────────────────────────────────────────────────────────────────

function banner(page: DocPageDTO): string {
  if (page.authority === "live") return "";
  const pending = page.authority === "staged_pending";
  const text = pending
    ? `You're reading the <strong style="font-weight:600;color:var(--fg)">live</strong> version. A change to this page is waiting for review.`
    : page.info.imported_from
      ? "This page isn't live yet. It was imported and is waiting for someone to approve it."
      : "This page isn't live yet. It is waiting for someone to approve it.";
  const m = AUTHORITY_MARK[page.authority]!;
  return `<div${surface("display:flex;align-items:center;gap:12px;padding:11px 14px;margin-bottom:18px", { cls: "cnpy-dpg-banner" })}>
    ${markShape(m.shape, m.tone, 10)}
    <div style="flex:1;min-width:0;font-size:12.5px;line-height:1.45;color:var(--fg-70)">${text}</div>
    <button type="button" data-act="goReview" class="cnpy-link" style="display:inline-flex;align-items:center;gap:3px;flex:none;padding:0;font-size:12.5px;font-weight:500;color:var(--accent);white-space:nowrap">Open in Review${ARROW}</button>
  </div>`;
}

function crumbs(doc: DocRow, page: DocPageDTO | null, space: SpaceDTO | null): string {
  const sep = `<span class="cnpy-dpg-sep" aria-hidden="true">›</span>`;
  const parts = [
    `<button type="button" data-act="libOpenSpace" data-arg="${attr(doc.space)}" class="cnpy-dpg-crumb">${space ? spaceTile(space, 14) : ""}<span>${esc(space?.name ?? doc.space)}</span></button>`,
    ...(page?.ancestors ?? []).map((a) => `<button type="button" data-act="openDoc" data-arg="${attr(a.slug)}" class="cnpy-dpg-crumb"><span>${esc(a.title)}</span></button>`),
    `<span class="cnpy-dpg-here" aria-current="page">${esc(doc.title)}</span>`,
  ];
  return `<nav class="cnpy-dpg-crumbs" aria-label="Breadcrumb">${parts.join(sep)}</nav>`;
}

/** The meta row's mark: "Live" (the one place it is said), else the page's status. */
function statusMark(page: DocPageDTO | null): string {
  if (!page || page.authority === "live") return stateMark("Live", "var(--green)", "dot", 12.5, LIVE_TIP);
  return authorityMark(page.authority, 12.5);
}

function byline(page: DocPageDTO | null, doc: DocRow, persons: readonly PersonSummary[]): string {
  const who = page?.info.edited_by ?? doc.updated_by;
  const at = page?.info.edited_at ?? doc.updated_at;
  const verb = page?.authority === "unpromoted" ? (page.info.imported_from ? "Imported" : "Proposed") : "Updated";
  if (!who) return `<span>${verb} ${esc(libraryWhen(at))}</span>`;
  return `<span>${verb} ${esc(libraryWhen(at))} by ${esc(shortName(persons, who))}</span>`;
}

function historyPanel(versions: DocVersionMetaRow[], doc: DocRow, persons: readonly PersonSummary[]): string {
  // A rejected version stays listed, muted, with the faded cross (the design's `rejected` shape) and its word.
  const rows = [...versions].sort((a, b) => b.version - a.version).map((v) => {
    const rejected = v.status === "rejected";
    const mark = rejected ? glyphMark("declined", "var(--fg-40)", "Rejected", 11.5, REJECTED_TIP)
      : v.version === doc.current_version ? stateMark("Live", "var(--green)", "dot", 11.5, LIVE_TIP)
      : v.status === "staged" && v.version > doc.current_version ? authorityMark(doc.current_version > 0 ? "staged_pending" : "unpromoted", 11.5) : "";
    const p = find(persons, v.created_by);
    return `<div class="cnpy-dpg-hrow${rejected ? " is-rejected" : ""}">
      <span class="cnpy-dpg-hv">v${v.version}</span>
      <span class="cnpy-dpg-hs">${esc(v.summary || "No summary")}</span>
      <span class="cnpy-dpg-hw">${personLink(p, v.created_by, 16, `${shortName(persons, v.created_by)} · ${libraryWhen(v.created_at)}`, "font-size:11.5px;color:var(--fg-55);white-space:nowrap", 6)}</span>
      <span class="cnpy-dpg-hm">${mark}</span>
    </div>`;
  }).join("");
  return `<div class="cnpy-dpg-hist" data-open="1"><div${surface("padding:0;overflow:hidden", { cls: "cnpy-dpg-hcard" })}>${rows || `<div class="cnpy-dpg-hrow"><span class="cnpy-dpg-hs">No versions yet.</span></div>`}</div></div>`;
}

function childCard(c: LibraryPageDTO, parentTitle: string): string {
  return `<div${surface("padding:12px 14px;display:flex;flex-direction:column;gap:5px", { hover: true, cls: HITBOX })}>
    <div style="display:flex;align-items:center;gap:7px;min-width:0;color:var(--fg-55)">${pageIcon(13)}<span style="font-size:13.5px;font-weight:500;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.title)}</span></div>
    <div style="font-size:12px;line-height:1.45;color:var(--fg-55)">Part of ${esc(parentTitle)}.</div>
    ${c.authority !== "live" ? `<div>${authorityMark(c.authority, 11.5)}</div>` : ""}
    ${hitArea("openDoc", c.slug, `Open ${c.title}`)}
  </div>`;
}

function rail(doc: DocRow, page: DocPageDTO | null, persons: readonly PersonSummary[], outline: { level: number; text: string; id: string }[], showHistory: boolean): string {
  const children = page && page.authority !== "unpromoted" ? page.children : [];
  const toc = [
    ...outline.filter((h) => h.level === 2 || h.level === 3).map((h) => `<button type="button" data-act="docToc" data-arg="${attr(h.id)}" class="cnpy-toc-i${h.level === 3 ? " is-sub" : ""}" data-toc="${attr(h.id)}">${esc(h.text)}</button>`),
    ...(children.length ? [`<button type="button" data-act="docToc" data-arg="${CHILDREN_ANCHOR}" class="cnpy-toc-i" data-toc="${CHILDREN_ANCHOR}">${esc(`Pages under ${doc.title}`)}</button>`] : []),
  ];
  const field = (label: string, value: string, note = "") => `<div class="cnpy-rail-f"><div class="cnpy-rail-l">${esc(label)}</div><div class="cnpy-rail-v">${value}</div>${note ? `<div class="cnpy-rail-note">${note}</div>` : ""}</div>`;
  const person = (h: string | null) => h ? personLink(find(persons, h), h, 18, fullName(persons, h), "font-size:12.5px;color:var(--fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap", 7) : `<span style="color:var(--fg-40)">—</span>`;
  const info = page?.info;
  const version = info ? (info.version > 0 ? info.version : info.pending_version ?? 0) : doc.current_version;
  const versionNote = !info ? "" : info.version === 0 ? "Not approved yet" : info.pending_version ? `Version ${info.pending_version} is waiting for review` : "";
  const versionValue = `<span>Version ${version}</span> <button type="button" data-act="toggleHistory" class="cnpy-link" aria-pressed="${showHistory}" style="padding:0;font-size:12.5px;font-weight:500;color:var(--accent)">History</button>`;
  const imported = info?.imported_from
    ? field("Imported from", `<span style="font-size:11.5px;overflow-wrap:anywhere">${esc(info.imported_from.path)}</span>`, info.imported_from.file_name ? `in ${esc(info.imported_from.file_name)}` : "")
    : "";
  const backs = page?.backlinks ?? [];
  const linked = backs.length
    ? backs.map((b) => `<button type="button" data-act="openDoc" data-arg="${attr(b.slug)}" class="cnpy-rail-link"><span class="cnpy-rail-lt">${esc(b.title)}</span><span class="cnpy-rail-lp">${esc(b.path.length ? b.path.join(" › ") : "Top level")}</span></button>`).join("")
    : `<p class="cnpy-rail-empty">No pages link here yet. Links from other pages show up once ${page?.authority === "unpromoted" ? "this one is approved" : "those pages are approved"}.</p>`;
  return `<aside class="cnpy-dpg-rail" aria-label="About this page">
    ${toc.length ? `<div class="cnpy-rail-g"><div class="cnpy-rail-h">On this page</div><div class="cnpy-toc">${toc.join("")}</div></div>` : ""}
    <div class="cnpy-rail-g">
      ${field("Owner", person(doc.owner))}
      ${field("Last edited by", person(info?.edited_by ?? doc.updated_by), esc(libraryWhen(info?.edited_at ?? doc.updated_at)))}
      ${field("Version", versionValue, esc(versionNote))}
      ${imported}
    </div>
    <div class="cnpy-rail-g"><div class="cnpy-rail-h">Linked from <span class="cnpy-rail-n">${backs.length}</span></div>${linked}</div>
  </aside>`;
}

// ── loading, empty ───────────────────────────────────────────────────────────

const PAGE_FRAME = "cnpy-dpg";
/** The doc page as shapes: the article's crumb, title, meta and prose; the rail's two groups. */
export function docPageShapes(): string {
  const railGroup = (w: number) => `<div style="margin-bottom:22px">${skBar(w, 10)}<div style="margin-top:10px">${skLines(["70%", "52%", "80%", "60%"], 12, 1.7)}</div></div>`;
  return `<div class="cnpy-dpg-grid">
    <div style="min-width:0">${skBar(180, 10)}<div style="margin-top:14px">${skLine("48%", 24, 1.2)}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px">${skBar(240, 10)}<div style="display:flex;gap:8px">${skBox(84, 30)}${skBox(64, 30)}</div></div>
      <div style="margin-top:26px">${skLines(["100%", "94%", "62%"], 15, 1.75)}</div>
      <div style="margin-top:22px">${skLine("34%", 15, 1.4)}</div>
      <div style="margin-top:10px">${skLines(["98%", "90%", "72%"], 15, 1.75)}</div>
      <div style="margin-top:16px">${skBox("100%", 120)}</div>
    </div>
    <div class="cnpy-dpg-rail is-shape">${railGroup(90)}${railGroup(60)}</div>
  </div>`;
}

export function docPageView(p: DocPageProps): string {
  const d = p.detail;
  const data = d.data && (p.slug === null || d.data.doc.slug === p.slug) ? d.data : null;
  if (!data) {
    if (p.slug === null && d.status !== "loading") {
      return `<div class="${PAGE_FRAME}" data-screen-label="Doc">${emptyLayout("doc", {
        text: DOC_EMPTY, action: p.emptySpace ? { label: "New page", act: "libNewPage", arg: p.emptySpace } : null, sayStyle: "margin-bottom:24px", shapes: docPageShapes(),
      })}</div>`;
    }
    if (d.status === "error") return `<div class="${PAGE_FRAME}"><p class="cnpy-dpg-note">Couldn't load this page. Check your connection, then reload.</p></div>`;
    if (d.status === "ok" && d.data === null) return `<div class="${PAGE_FRAME}"><p class="cnpy-dpg-note">There is no page here. It may have been moved, or the link is wrong.</p></div>`;
    return `<div class="${PAGE_FRAME}" data-screen-label="Doc">${skeleton("doc", "Loading the page…", docPageShapes())}</div>`;
  }
  const { doc, versions } = data;
  const page = data.page ?? null;
  const body = page ? page.body : doc.body;
  const outline = extractOutline(outlineBody(body, page));
  const children = page && page.authority !== "unpromoted" ? page.children : [];
  const meta = `<div class="cnpy-dpg-meta">
    <div class="cnpy-dpg-by">${statusMark(page)}<span style="color:var(--fg-40)">·</span>${byline(page, doc, p.persons)}</div>
    <div style="display:flex;align-items:center;gap:8px;flex:none">
      <button type="button" data-act="toggleHistory" class="cnpy-dpg-btn${p.showHistory ? " is-on" : ""}" aria-pressed="${p.showHistory}">${CLOCK}History</button>
    </div>
  </div>`;
  const kids = children.length
    ? `<section class="cnpy-dpg-kids"><h2 id="${CHILDREN_ANCHOR}" class="cnpy-dpg-kh">${esc(`Pages under ${doc.title}`)}</h2>
        <div class="cnpy-dpg-kgrid">${children.map((c) => childCard(c, doc.title)).join("")}</div></section>`
    : "";
  return `<div class="${PAGE_FRAME}" data-screen-label="Doc">
    <div class="cnpy-dpg-grid">
      <article class="cnpy-dpg-art" style="min-width:0">
        ${page ? banner(page) : ""}
        ${crumbs(doc, page, p.space)}
        <h1 class="cnpy-dpg-title">${esc(doc.title)}</h1>
        ${meta}
        ${p.showHistory ? historyPanel(versions, doc, p.persons) : ""}
        ${p.tagsRow}
        <div class="cnpy-md cnpy-dpg-md">${body.trim() ? renderMarkdown(linkedBody(body, page)) : `<p class="cnpy-dpg-note">This page has no text yet.</p>`}</div>
        ${kids}
      </article>
      ${rail(doc, page, p.persons, outline, p.showHistory)}
    </div>
  </div>`;
}
