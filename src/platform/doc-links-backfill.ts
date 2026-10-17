// The `doc_links` backfill (0081_docs_library; docs/architecture/docs-library.md › Links between pages). A page's
// links are rebuilt from its live body on every promote (src/tools/doc-tree.ts `linkStmts`), so a page promoted
// BEFORE the table existed has no rows — its `[[slug]]` links work, but the page it links to does not list it under
// "Linked from" until its next promote. This COMPUTED write (no gate: it derives rows from bodies already live)
// fills them in, from the daily cron, bounded per invocation and resumable:
//   • a live page (`current_version > 0`) whose body holds `[[` and that has NO row yet gets the rows `linkStmts`
//     would write (INSERT OR IGNORE — idempotent; a page with rows is never touched, its promote owns them);
//   • at most `DOC_LINKS_PER_RUN` pages (and `DOC_LINKS_READS_PER_RUN` queries) are read per invocation, org by org (the active ones, by id) and slug by
//     slug; where it stopped is kept in `cron_cursor` (job `doc_links_backfill`, `<org>\t<slug>`), and once every
//     org has been read the cursor says `DOC_LINKS_DONE` and the job reads nothing again. Every page promoted
//     since has its rows already, so one pass is all it takes.
// Each org is read as its own system tenant; nothing is read across orgs but the org list and the cursor.
import type { Env } from "../env";
import { extractDocLinks } from "@shared/docs-links-core";
import { platform, systemTenant } from "../data/context";
import { all, batch, stmt, type Stmt } from "../data/sql";
import { listActiveOrgIds, readCursor, writeCursor } from "./jobs";

export const DOC_LINKS_JOB = "doc_links_backfill";
/** The cursor once every org has been read. */
export const DOC_LINKS_DONE = "\u0001done";
/** Pages read per invocation, across every org. */
export const DOC_LINKS_PER_RUN = 300;
/** Reads (D1 queries) per invocation, across every org: what bounds a run over many orgs with nothing to read. */
export const DOC_LINKS_READS_PER_RUN = 60;
const PAGE = 50;

export interface DocLinksBackfill { pages: number; links: number; done: boolean }

export async function backfillDocLinks(env: Env, limit: number = DOC_LINKS_PER_RUN): Promise<DocLinksBackfill> {
  const p = platform(env, "system");
  const cursor = await readCursor(p, DOC_LINKS_JOB);
  if (cursor === DOC_LINKS_DONE) return { pages: 0, links: 0, done: true };
  const tab = cursor.indexOf("\t");
  const fromOrg = tab >= 0 ? cursor.slice(0, tab) : "";
  const fromSlug = tab >= 0 ? cursor.slice(tab + 1) : "";
  let budget = limit;
  let reads = DOC_LINKS_READS_PER_RUN;
  let pages = 0;
  let links = 0;
  for (const org of (await listActiveOrgIds(p)).filter((o) => o >= fromOrg)) {
    const ctx = systemTenant(p, org, "system");
    let after = org === fromOrg ? fromSlug : "";
    for (;;) {
      if (budget <= 0 || reads <= 0) {
        await writeCursor(p, DOC_LINKS_JOB, `${org}\t${after}`);
        return { pages, links, done: false };
      }
      const take = Math.min(PAGE, budget);
      const rows = await all<{ slug: string; body: string }>(ctx,
        `SELECT d.slug AS slug, d.body AS body FROM docs d
          WHERE d.org_id = ? AND d.current_version > 0 AND d.slug > ? AND instr(d.body, '[[') > 0
            AND NOT EXISTS (SELECT 1 FROM doc_links l WHERE l.org_id = ? AND l.from_slug = d.slug)
          ORDER BY d.slug LIMIT ?`, org, after, org, take);
      // The pages actually read are charged (an org with nothing to read costs none), and every query one read.
      budget -= rows.length;
      reads -= 1;
      const stmts: Stmt[] = [];
      for (const r of rows) {
        for (const to of extractDocLinks(r.body).filter((t) => t !== r.slug).slice(0, 500)) {
          stmts.push(stmt(ctx, `INSERT OR IGNORE INTO doc_links (org_id, from_slug, to_slug) VALUES (?, ?, ?)`, org, r.slug, to));
        }
      }
      if (stmts.length) await batch(ctx, stmts);
      pages += rows.length;
      links += stmts.length;
      if (rows.length) after = rows[rows.length - 1].slug;
      if (rows.length < take) break;
    }
  }
  await writeCursor(p, DOC_LINKS_JOB, DOC_LINKS_DONE);
  return { pages, links, done: true };
}
