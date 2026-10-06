import { RESET_STATEMENTS } from "./reset.mjs";

// SQL string literal: wrap in single quotes, double any embedded quote. NULL for
// null/undefined. JSON.stringify guarantees no literal newlines in embedded JSON.
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? "NULL" : String(Number(v)));
const jsonLit = (obj) => (obj === null || obj === undefined ? "NULL" : q(JSON.stringify(obj)));

// Provenance stamped on structured summary rows so they read as "done" (My Work's
// Sync skip-check treats a row as generated only when model != 'excerpt' AND
// title IS NOT NULL). Matches GEMINI_MODEL in src/tools/summarize.ts.
const STRUCTURED_MODEL = "gemini-2.5-flash-lite";

/** True iff the loader was asked to touch remote D1 — the loader must refuse. */
export const targetsRemote = (argv) => argv.includes("--remote");

/**
 * Turn parsed fixture objects into standalone, escaped SQL statements (no
 * trailing ";"), reset statements first. FK-safe ordering: events before
 * pr_summaries, sprints before sprint_progress / sprint_resources / tickets,
 * tickets before ticket_assignees / _links / _comments / _events.
 */
export function buildSeedStatements(fx) {
  const s = [...RESET_STATEMENTS];

  // Register every section the doc fixtures reference so the `docs.section`
  // foreign key (→ sections.name) is satisfied for any taxonomy the fixtures
  // use. INSERT OR IGNORE keeps the migration-seeded vocab intact. Local seed
  // only — never runs against remote.
  for (const name of [...new Set((fx.docs?.docs ?? []).map((d) => d.section))]) {
    s.push(`INSERT OR IGNORE INTO sections (name, description) VALUES (${q(name)}, ${q(name)})`);
  }

  for (const d of fx.docs?.docs ?? []) {
    s.push(
      // owner (0035): the fixture's own, else the first version's author, else updated_by — the migration's backfill rule.
      `INSERT INTO docs (slug, section, space, title, body, current_version, updated_at, updated_by, owner) VALUES (` +
        `${q(d.slug)}, ${q(d.section)}, ${q(d.space ?? "canopy")}, ${q(d.title)}, ${q(d.body)}, ${num(d.current_version)}, ${q(d.updated_at)}, ${q(d.updated_by)}, ` +
        `${q(d.owner ?? [...(d.versions ?? [])].sort((a, b) => a.version - b.version)[0]?.created_by ?? d.updated_by)})`
    );
    for (const v of d.versions ?? []) {
      s.push(
        `INSERT INTO doc_versions (slug, version, body, summary, status, confidence, created_at, created_by, change_kind, base_version, low_confidence) VALUES (` +
          `${q(d.slug)}, ${num(v.version)}, ${q(v.body)}, ${q(v.summary)}, ${q(v.status)}, ${q(v.confidence)}, ${q(v.created_at)}, ${q(v.created_by)}, ${q(v.change_kind)}, ${num(v.base_version)}, ${num(v.low_confidence ?? 0)})`
      );
    }
  }

  for (const f of fx.feed?.feed ?? []) {
    s.push(
      `INSERT INTO feed (id, author, summary, body, artifacts, created_at) VALUES (` +
        `${num(f.id)}, ${q(f.author)}, ${q(f.summary)}, ${q(f.body)}, ${jsonLit(f.artifacts)}, ${q(f.created_at)})`
    );
    for (const t of f.tags ?? []) {
      s.push(`INSERT INTO entry_tags (tag, entry_type, entry_id) VALUES (${q(t)}, 'feed', ${q(String(f.id))})`);
    }
  }

  for (const a of fx.adrs?.adrs ?? []) {
    s.push(
      `INSERT INTO adrs (id, title, context, decision, rationale, status, confidence, created_at, created_by) VALUES (` +
        `${num(a.id)}, ${q(a.title)}, ${q(a.context)}, ${q(a.decision)}, ${q(a.rationale)}, ${q(a.status)}, ${q(a.confidence)}, ${q(a.created_at)}, ${q(a.created_by)})`
    );
  }

  for (const t of fx.triage?.needs_triage ?? []) {
    s.push(
      `INSERT INTO needs_triage (raw, reason, source_author, resolved, created_at) VALUES (` +
        `${q(t.raw)}, ${q(t.reason)}, ${q(t.source_author)}, ${num(t.resolved ?? 0)}, ${q(t.created_at)})`
    );
  }

  const rm = fx.roadmap;
  if (rm) {
    s.push(
      `UPDATE plan SET narrative = ${q(rm.narrative)}, current_version = ${num(rm.version)}, updated_at = ${q(rm.updated_at)}, updated_by = ${q(rm.updated_by)} WHERE org_id = 'org_saplinglearn'`
    );
    s.push(
      `INSERT INTO plan_versions (version, narrative, sprints_json, created_at, created_by) VALUES (` +
        `${num(rm.version)}, ${q(rm.narrative)}, ${jsonLit(rm.sprints ?? [])}, ${q(rm.updated_at)}, ${q(rm.updated_by)})`
    );
    for (const sp of rm.sprints ?? []) {
      s.push(
        `INSERT INTO sprints (id, title, description, summary, phase, dates, start_date, target_date, status, urgency, lead, domain, github_ref, created_at, created_by, updated_at) VALUES (` +
          `${num(sp.id)}, ${q(sp.title)}, ${q(sp.description)}, ${q(sp.summary)}, ${q(sp.phase)}, ${q(sp.dates)}, ${q(sp.start_date)}, ${q(sp.target_date)}, ${q(sp.status)}, ${q(sp.urgency ?? "normal")}, ${q(sp.lead)}, ${q(sp.domain)}, ${q(sp.github_ref)}, ${q(sp.created_at)}, ${q(sp.created_by)}, ${q(sp.updated_at)})`
      );
      if (sp.progress) {
        s.push(
          `INSERT INTO sprint_progress (sprint_id, closed, total, source, computed_at) VALUES (` +
            `${num(sp.id)}, ${num(sp.progress.closed)}, ${num(sp.progress.total)}, ${q(sp.progress.source ?? "recompute")}, ${q(sp.progress.computed_at)})`
        );
      }
      // Sprint resources: the links attached to the sprint itself (parsed shape,
      // exactly what shared/tickets.ts parseTicketLink would produce for the url).
      for (const r of sp.resources ?? []) {
        s.push(
          `INSERT INTO sprint_resources (sprint_id, url, kind, label, meta) VALUES (` +
            `${num(sp.id)}, ${q(r.url)}, ${q(r.kind)}, ${q(r.label)}, ${q(r.meta)})`
        );
      }
    }
  }

  // Tickets (0024) — after the sprints above, so `sprint_id` points at a row that
  // exists (it is a soft INTEGER ref, but the seed should still read coherently),
  // and after the person seed in RESET_STATEMENTS (`tickets.requester` FKs
  // persons(handle)). Explicit ids so the fixture can wire parent/child and so
  // the children below can name their ticket.
  //
  // parent_id is set in a SECOND pass: it references tickets(id), which D1
  // enforces, so a child listed before its parent would fail the INSERT. The
  // UPDATE makes the fixture's order irrelevant.
  for (const t of fx.tickets?.tickets ?? []) {
    s.push(
      `INSERT INTO tickets (id, title, body, category, priority, status, requester, parent_id, sprint_id, created_at, updated_at) VALUES (` +
        `${num(t.id)}, ${q(t.title)}, ${q(t.body)}, ${q(t.category)}, ${q(t.priority)}, ${q(t.status)}, ${q(t.requester)}, NULL, ${num(t.sprint_id)}, ${q(t.created_at)}, ${q(t.updated_at)})`
    );
  }
  for (const t of fx.tickets?.tickets ?? []) {
    if (t.parent_id !== null && t.parent_id !== undefined) {
      s.push(`UPDATE tickets SET parent_id = ${num(t.parent_id)} WHERE id = ${num(t.id)}`);
    }
    for (const login of t.assignees ?? []) {
      s.push(`INSERT INTO ticket_assignees (ticket_id, login) VALUES (${num(t.id)}, ${q(login)})`);
    }
    // Links carry the parsed shape shared/tickets.ts parseTicketLink would produce.
    for (const l of t.links ?? []) {
      s.push(
        `INSERT INTO ticket_links (ticket_id, url, kind, label, meta, created_by, created_at) VALUES (` +
          `${num(t.id)}, ${q(l.url)}, ${q(l.kind)}, ${q(l.label)}, ${q(l.meta)}, ${q(l.created_by)}, ${q(l.created_at)})`
      );
    }
    for (const cm of t.comments ?? []) {
      s.push(
        `INSERT INTO ticket_comments (ticket_id, author, body, created_at) VALUES (` +
          `${num(t.id)}, ${q(cm.author)}, ${q(cm.body)}, ${q(cm.created_at)})`
      );
    }
    // The full history, opening row (from_status NULL) included.
    for (const ev of t.events ?? []) {
      s.push(
        `INSERT INTO ticket_events (ticket_id, actor, from_status, to_status, created_at) VALUES (` +
          `${num(t.id)}, ${q(ev.actor)}, ${q(ev.from_status)}, ${q(ev.to_status)}, ${q(ev.created_at)})`
      );
    }
  }

  for (const e of fx.events?.events ?? []) {
    s.push(
      `INSERT INTO events (semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by) VALUES (` +
        `${q(e.semantic_key)}, ${q(e.event_type)}, ${num(e.ref_number)}, ${q(e.subject_login)}, ${jsonLit(e.raw)}, ${q(e.provenance ?? "backfill")}, ${q(e.occurred_at)}, ${q(e.recorded_at)}, ${q(e.recorded_by ?? "github-webhook")})`
    );
    // Structured summaries (0018): fixtures carry an object. PRs are structured-
    // only (the prose `summary` column was dropped in 0019) — title/what/why/impact
    // land in their own columns; issues keep `summary` (issue_summaries). A bare
    // `model:"excerpt"` PR fixture leaves the structured columns null.
    if (e.pr_summary) {
      const p = e.pr_summary;
      const model = p.model ?? STRUCTURED_MODEL;
      s.push(
        `INSERT INTO pr_summaries (semantic_key, pr_number, model, created_at, title, what, why, impact) VALUES (` +
          `${q(e.semantic_key)}, ${num(e.ref_number)}, ${q(model)}, ${q(e.recorded_at)}, ${q(p.title)}, ${q(p.what)}, ${q(p.why)}, ${q(p.impact)})`
      );
    }
    if (e.issue_summary) {
      const i = e.issue_summary;
      const model = i.model ?? STRUCTURED_MODEL;
      s.push(
        `INSERT INTO issue_summaries (issue_number, summary, model, created_at, title, next_step) VALUES (` +
          `${num(e.ref_number)}, ${q(i.summary)}, ${q(model)}, ${q(e.recorded_at)}, ${q(i.title)}, ${q(i.next_step)})`
      );
    }
  }

  // Handoffs + Prompt Library (0028). Their fixtures carry RELATIVE times
  // (`*_ago_min`), stamped against the clock at seed time, so the inbox always
  // reads "8m ago" / "2h ago" the way the design does rather than aging out.
  const now = Date.now();
  const agoIso = (min) => (min === null || min === undefined ? null : new Date(now - Number(min) * 60000).toISOString());
  for (const h of fx.handoffs?.handoffs ?? []) {
    const c = h.context ?? {};
    const context = { repo: c.repo ?? "", branch: c.branch ?? "", task: c.task ?? "", done: c.done ?? [], next: c.next ?? [], files: c.files ?? [] };
    const created = agoIso(h.created_ago_min);
    // A handoff expires 7 days after it was sent (src/tools/handoffs.ts HANDOFF_TTL_MS).
    const expires = new Date(Date.parse(created) + 7 * 24 * 60 * 60 * 1000).toISOString();
    s.push(
      `INSERT INTO handoffs (id, sender, recipient, status, body, context, prompt_title, prompt_body, created_at, claimed_at, claimed_by, claimed_by_session, expires_at) VALUES (` +
        `${num(h.id)}, ${q(h.sender)}, ${q(h.recipient)}, ${q(h.status)}, ${q(h.body)}, ${jsonLit(context)}, ${q(h.prompt?.title)}, ${q(h.prompt?.body)}, ` +
        `${q(created)}, ${q(agoIso(h.claimed_ago_min))}, ${q(h.claimed_by)}, ${q(h.claimed_by_session)}, ${q(expires)})`
    );
  }
  for (const p of fx.prompts?.prompts ?? []) {
    const versions = p.versions ?? [];
    const latest = versions[versions.length - 1];
    s.push(
      // use_count / last_used_ago_min (0035) are optional fixture fields: absent = never used.
      `INSERT INTO prompts (slug, title, description, tags, author, current_version, created_at, updated_at, use_count, last_used_at) VALUES (` +
        `${q(p.slug)}, ${q(p.title)}, ${q(p.description ?? "")}, ${jsonLit(p.tags ?? [])}, ${q(p.author)}, ${num(latest?.version)}, ` +
        `${q(agoIso(versions[0]?.created_ago_min))}, ${q(agoIso(p.updated_ago_min))}, ${num(p.use_count ?? 0)}, ` +
        `${p.last_used_ago_min == null ? "NULL" : q(agoIso(p.last_used_ago_min))})`
    );
    for (const v of versions) {
      s.push(
        `INSERT INTO prompt_versions (slug, version, status, author, summary, body, created_at) VALUES (` +
          `${q(p.slug)}, ${num(v.version)}, ${q(v.status)}, ${q(v.author)}, ${q(v.summary ?? "")}, ${q(v.body)}, ${q(agoIso(v.created_ago_min))})`
      );
    }
  }

  for (const t of fx.identity?.identity_tasks ?? []) {
    s.push(
      `INSERT INTO identity_tasks (login, first_seen, status, resolved_at, resolved_by) VALUES (` +
        `${q(t.login)}, ${q(t.first_seen)}, ${q(t.status ?? "pending")}, ${q(t.resolved_at)}, ${q(t.resolved_by)})`
    );
  }

  return s;
}
