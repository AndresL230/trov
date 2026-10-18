// LOCAL dev seed — Phase D's Roadmap and doc-drift samples (fixtures/dev/ai-roadmap.json): what the AI pass would
// have written, so the Roadmap (sprint notes, the drift line, an admin's suggestion cards) and Review (a Trov doc
// proposal, low confidence) show them under `npm run dev` with no key. Run by scripts/seed-dev.mjs AFTER the main
// seed (it needs the sprints, tickets and docs). Never remote. Every row is SaplingLearn's.
const ORG = "org_saplinglearn";
const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const num = (v) => (v === null || v === undefined ? "NULL" : String(Number(v)));
const MODEL = "claude-haiku-5-5";

/** The statements, in order. `fx.aiRoadmap` is fixtures/dev/ai-roadmap.json; `fx.docs` the doc fixtures. */
export function aiRoadmapDevStatements(fx, now = Date.now()) {
  const ai = fx.aiRoadmap;
  if (!ai) return [];
  const ago = (min) => new Date(now - Number(min) * 60000).toISOString();
  const s = [];
  // The reserved system person Trov writes as (its row arrives with 0061_ai_digests; until then the sample adds it).
  s.push(`INSERT OR IGNORE INTO persons (handle, name, color, created_at, onboarded_at) VALUES ('trov', 'Trov', 'stone', '2026-10-15T00:00:00Z', '2026-10-15T00:00:00Z')`);

  for (const n of ai.sprint_notes ?? []) {
    s.push(`INSERT INTO org_insights (org_id, kind, key, version, generated_at, model, prompt_version, json) VALUES (` +
      `${q(ORG)}, 'sprint_note', ${q(String(n.sprint_id))}, 1, ${q(ago(n.ago_min))}, ${q(MODEL)}, 'note-1', ${q(JSON.stringify({ text: n.text, cites: n.cites }))})`);
  }
  const d = ai.plan_drift;
  if (d) {
    s.push(`INSERT INTO org_insights (org_id, kind, key, version, generated_at, model, prompt_version, json) VALUES (` +
      `${q(ORG)}, 'plan_drift', '', 1, ${q(ago(d.ago_min))}, ${q(MODEL)}, 'drift-1', ${q(JSON.stringify({ text: d.text, cites: d.cites, windowDays: d.window_days, shares: d.shares }))})`);
  }

  // A few backlog tickets for the sprint draft to group (numbered past the main fixtures').
  for (const t of ai.backlog_tickets ?? []) {
    const at = ago(3 * 24 * 60);
    s.push(`INSERT INTO tickets (org_id, id, number, title, body, category, priority, status, requester, parent_id, sprint_id, created_at, updated_at) VALUES (` +
      `${q(ORG)}, ${num(t.id)}, ${num(t.id)}, ${q(t.title)}, ${q(t.body)}, ${q(t.category)}, ${q(t.priority)}, 'submitted', ${q(t.requester)}, NULL, NULL, ${q(at)}, ${q(at)})`);
    s.push(`INSERT INTO ticket_events (org_id, ticket_id, actor, from_status, to_status, created_at) VALUES (${q(ORG)}, ${num(t.id)}, ${q(t.requester)}, NULL, 'submitted', ${q(at)})`);
  }
  if ((ai.backlog_tickets ?? []).length) {
    s.push(`INSERT INTO org_counters (org_id, name, value) VALUES (${q(ORG)}, 'ticket', (SELECT COALESCE(MAX(number), 0) FROM tickets WHERE org_id = ${q(ORG)})) ` +
      `ON CONFLICT(org_id, name) DO UPDATE SET value = MAX(org_counters.value, excluded.value)`);
  }

  for (const sg of ai.suggestions ?? []) {
    s.push(`INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, confidence, reason, cites_json, model, prompt_version, state, created_at) VALUES (` +
      `${q(ORG)}, 'roadmap', 'org', ${q(sg.kind)}, ${q(JSON.stringify(sg.value))}, NULL, ${q(sg.reason)}, ${q(JSON.stringify(sg.cites))}, ${q(MODEL)}, ${q(sg.kind === "sprint_draft" ? "draft-1" : "narrative-2")}, 'open', ${q(ago(sg.ago_min))})`);
  }

  // Doc drift: the feed entries it compared, then the staged, low-confidence proposal Trov made through the gate.
  for (const f of ai.drift_feed ?? []) {
    s.push(`INSERT INTO feed (org_id, id, author, summary, body, artifacts, created_at) VALUES (` +
      `${q(ORG)}, ${num(f.id)}, ${q(f.author)}, ${q(f.summary)}, ${q(f.body)}, NULL, ${q(ago(f.ago_min))})`);
  }
  const dd = ai.doc_drift;
  const doc = dd && (fx.docs?.docs ?? []).find((x) => x.slug === dd.slug);
  if (doc) {
    let body = doc.body;
    for (const e of dd.edits) {
      if (body.split(e.find).length === 2) body = body.replace(e.find, e.replace);
    }
    if (body !== doc.body) {
      s.push(`INSERT INTO doc_versions (org_id, slug, version, body, summary, status, confidence, created_at, created_by, change_kind, base_version, low_confidence) VALUES (` +
        `${q(ORG)}, ${q(doc.slug)}, ${num(doc.current_version + 1)}, ${q(body)}, ${q(dd.change_summary)}, 'staged', 'low', ${q(ago(dd.ago_min))}, 'trov', 'edit', ${num(doc.current_version)}, 1)`);
    }
  }
  return s;
}
