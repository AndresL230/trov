// Local-only rows for Repo › Planning's "Where the work went" (fixtures/dev/themes.json): merged PRs over the last
// twelve weeks with their cards, four ACTIVE themes with each PR's theme (one chosen by a person), a caption, and
// one PROPOSED theme with its open suggestion — so the section draws from real tables under `wrangler dev`
// without LOCAL_AI_PREVIEW, and an admin can try Accept / Rename / Remove. Appended by scripts/seed-dev.mjs AFTER
// the shared seed — never part of the test reset. Times are relative to the clock at seed time.
//
// The themes belong to the org's PRIMARY repository; when the seed org has none (the reset clears org_repos), the
// repository its events came from (`SaplingLearn/sapling`) is made primary.

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const DAY_MS = 86_400_000;
const ORG = "org_saplinglearn";
const REPO_SQL = `(SELECT repo_full_name FROM org_repos WHERE org_id = '${ORG}' AND is_primary = 1)`;
const themeId = (name) => `(SELECT id FROM repo_themes WHERE org_id = '${ORG}' AND name = ${q(name)} AND status <> 'removed')`;

export function themesDevStatements(fx, now = new Date()) {
  const s = [];
  const iso = (daysAgo) => new Date(now.getTime() - daysAgo * DAY_MS).toISOString();
  s.push(`INSERT INTO org_repos (id, org_id, repo_full_name, is_primary, created_at, created_by)
    SELECT 'hook_saplinglearn_sapling', '${ORG}', 'SaplingLearn/sapling', 1, ${q(iso(90))}, 'seed'
    WHERE NOT EXISTS (SELECT 1 FROM org_repos WHERE org_id = '${ORG}' AND is_primary = 1)`);

  for (const p of fx.prs ?? []) {
    const at = iso(p.days_ago);
    const key = `gh:pr:${p.number}:merged`;
    const raw = { pr: { number: p.number, title: p.title, html_url: `https://github.com/AndresL230/trov/pull/${p.number}`, merged: true, merged_at: at, base: { ref: "main" }, user: { login: "AndresL230" } } };
    s.push(`INSERT OR IGNORE INTO events (org_id, semantic_key, event_type, ref_number, subject_login, raw, provenance, occurred_at, recorded_at, recorded_by)
      VALUES ('${ORG}', ${q(key)}, 'pr_merged', ${Number(p.number)}, 'AndresL230', ${q(JSON.stringify(raw))}, 'backfill', ${q(at)}, ${q(at)}, 'github-webhook')`);
    s.push(`INSERT OR REPLACE INTO pr_summaries (org_id, semantic_key, pr_number, model, created_at, title, what, why, impact)
      VALUES ('${ORG}', ${q(key)}, ${Number(p.number)}, 'claude-haiku-5-5', ${q(at)}, ${q(p.title)}, ${q(p.what)}, NULL, NULL)`);
  }

  for (const [i, t] of (fx.themes ?? []).entries()) {
    const proposed = t.status === "proposed";
    s.push(`INSERT INTO repo_themes (org_id, repo, name, description, color_key, status, position, seed_prs, model, prompt_version, created_by, created_at, decided_by, decided_at)
      SELECT '${ORG}', ${REPO_SQL}, ${q(t.name)}, ${q(t.description)}, ${q(t.color)}, ${q(t.status)}, ${i}, ${q(JSON.stringify(t.seed_prs ?? []))},
             'claude-haiku-5-5', 'propose-1', 'trov', ${q(iso(proposed ? 2 : 60))}, ${proposed ? "NULL" : "'AndresL230'"}, ${proposed ? "NULL" : q(iso(59))}`);
    if (proposed) {
      s.push(`INSERT INTO ai_suggestions (org_id, item_type, item_ref, kind, value_json, confidence, reason, cites_json, model, prompt_version, state, created_at)
        SELECT '${ORG}', 'theme', ${REPO_SQL} || '#' || ${themeId(t.name)}, 'themes.propose', ${q(JSON.stringify({ name: t.name, description: t.description }))},
               NULL, ${q(t.description)}, ${q(JSON.stringify((t.seed_prs ?? []).slice(0, 3).map((n) => ({ ref: `pr:${n}`, label: `#${n}`, href: `https://github.com/AndresL230/trov/pull/${n}` }))))},
               'claude-haiku-5-5', 'propose-1', 'open', ${q(iso(2))}`);
    }
  }

  for (const p of fx.prs ?? []) {
    if (!p.theme) continue;
    const person = p.person ?? null;
    s.push(`INSERT OR REPLACE INTO pr_themes (org_id, repo, pr_number, theme_id, source, confidence, model, prompt_version, set_by, set_at)
      SELECT '${ORG}', ${REPO_SQL}, ${Number(p.number)}, ${themeId(p.theme)}, ${person ? "'person'" : "'ai'"}, ${person ? "NULL" : "0.92"},
             ${person ? "NULL" : "'jev-1.13.0'"}, ${person ? "NULL" : "'pr-theme-1'"}, ${q(person)}, ${q(iso(Math.max(0, p.days_ago - 0.01)))}`);
  }

  if (fx.caption) {
    const named = (fx.themes ?? []).filter((t) => t.status === "active" && fx.caption.includes(t.name)).map((t) => themeId(t.name));
    s.push(`INSERT INTO repo_theme_captions (org_id, repo, range, caption, theme_ids, basis_hash, model, prompt_version, generated_at)
      SELECT '${ORG}', ${REPO_SQL}, '8w', ${q(fx.caption)}, json_array(${named.join(", ")}), 'seed', 'claude-haiku-5-5', 'caption-1', ${q(iso(0.1))}`);
  }
  return s;
}
