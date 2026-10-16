#!/usr/bin/env node
// `npm run dev:as -- <handle> [--org <slug>] [--url http://localhost:8787]` — the link that signs the browser in as
// that seeded person on the running dev server (src/auth/dev-signin.ts; docs/architecture/local-dev.md). With no
// handle, the people in the local D1 and their orgs. Opening the link makes an ordinary session; `/auth/dev/out`
// goes back to DEV_LOGIN. Local only: the route answers 404 anywhere but a loopback origin with DEV_LOGIN set.
import { localD1 } from "../seed/local-d1.mjs";

const argv = process.argv.slice(2);
if (argv.includes("--remote")) { console.error("dev:as: refusing --remote."); process.exit(1); }
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? "" : null; };
const origin = (arg("--url") || process.env.TROV_URL || "http://localhost:8787").replace(/\/+$/, "");
const handle = argv.find((a, i) => !a.startsWith("--") && !["--org", "--url"].includes(argv[i - 1]));
const org = arg("--org");

if (handle) {
  console.log(`${origin}/auth/dev/as?handle=${encodeURIComponent(handle)}${org ? `&org=${encodeURIComponent(org)}` : ""}`);
  console.log(`(open it in the browser; ${origin}/auth/dev/out goes back to DEV_LOGIN)`);
  process.exit(0);
}
const [rows] = localD1().query([`SELECT p.handle, p.name, o.slug, m.role FROM persons p JOIN memberships m ON m.user_id = p.handle COLLATE NOCASE JOIN orgs o ON o.id = m.org_id ORDER BY o.slug, m.role, p.handle`]);
let last = null;
for (const r of rows) {
  if (r.slug !== last) { console.log(`\n/${r.slug}/`); last = r.slug; }
  console.log(`  ${r.role.padEnd(7)} ${r.handle.padEnd(22)} npm run dev:as -- ${r.handle}${r.slug ? ` --org ${r.slug}` : ""}`);
}
console.log(`\nOr open ${origin}/auth/dev/as and pick.`);
