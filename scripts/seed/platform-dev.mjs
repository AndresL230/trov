// Local-only demo rows for the Platform (superadmin) screens: metered usage for the two seed
// orgs, an owner for Acme, and a few audit entries. Appended by scripts/seed-dev.mjs AFTER the
// shared seed (scripts/seed/build.mjs, which the tests pin) — never part of the test reset.
// Deterministic for a given day: the figures come from a fixed sequence, not Math.random.

const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const DAY_MS = 86_400_000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** A small fixed pseudo-random sequence in [0, 1). */
function sequence(seed) {
  let x = seed;
  return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
}

const TOOLS = ["get_feed", "query", "get_doc", "list_tickets", "record_session", "get_my_work", "create_ticket"];

export function platformDevStatements(now = new Date()) {
  const s = [];
  const rnd = sequence(42);
  const rows = [];
  const usage = (org, day, metric, actor, count) => {
    if (count > 0) rows.push(`(${q(org)}, ${q(day)}, ${q(metric)}, ${q(actor)}, ${count}, ${q(`${day}T00:05:00.000Z`)})`);
  };

  // SaplingLearn: 45 days, busier on weekdays, four people and their agents.
  const people = ["AndresL230", "Jose-Gael-Cruz-Lopez", "lpcooper-arch", "meilin"];
  for (let back = 44; back >= 0; back--) {
    const ms = now.getTime() - back * DAY_MS;
    const day = dayOf(ms);
    const weekend = [0, 6].includes(new Date(ms).getUTCDay());
    for (const [i, who] of people.entries()) {
      if (rnd() < (weekend ? 0.7 : 0.15)) continue;
      const scale = (weekend ? 0.3 : 1) * (1 - i * 0.18);
      usage("org_saplinglearn", day, "api_read", who, Math.round((40 + rnd() * 160) * scale));
      usage("org_saplinglearn", day, "api_write", who, Math.round((4 + rnd() * 22) * scale));
      if (i < 3) {
        usage("org_saplinglearn", day, "mcp_request", who, Math.round((10 + rnd() * 60) * scale));
        for (const [t, tool] of TOOLS.entries()) usage("org_saplinglearn", day, `mcp_tool:${tool}`, who, Math.round((rnd() * 14 * scale) / (1 + t * 0.5)));
      }
    }
  }
  // Acme: a new org — an owner, and a first few quiet days.
  s.push(`INSERT OR IGNORE INTO memberships (org_id, user_id, role, title, responsibilities, created_at, created_by) VALUES ('org_b', 'sanaok', 'owner', 'Founder', NULL, ${q(new Date(now.getTime() - 6 * DAY_MS).toISOString())}, 'AndresL230')`);
  for (const back of [5, 3, 2, 0]) {
    const day = dayOf(now.getTime() - back * DAY_MS);
    usage("org_b", day, "api_read", "sanaok", 6 + back * 3);
    usage("org_b", day, "api_write", "sanaok", 1 + back);
  }
  // A multi-row INSERT per 50 rows: several hundred single statements make the file too big for one local execute.
  for (let i = 0; i < rows.length; i += 50) {
    s.push(`INSERT OR REPLACE INTO org_usage_daily (org_id, day, metric, actor, count, last_at) VALUES ${rows.slice(i, i + 50).join(", ")}`);
  }
  // The administration trail behind that.
  const audit = (org, action, target, detail, back) =>
    s.push(`INSERT INTO org_admin_audit (org_id, actor, action, target, detail, at) VALUES (${org ? q(org) : "NULL"}, 'AndresL230', ${q(action)}, ${q(target)}, ${q(JSON.stringify(detail))}, ${q(new Date(now.getTime() - back * DAY_MS).toISOString())})`);
  audit("org_b", "org.create", "acme", { name: "Acme" }, 6);
  audit("org_b", "member.add", "sanaok", { role: "owner" }, 6);
  audit(null, "platform.org_limit", "meilin", { limit: 5 }, 2);
  return s;
}
