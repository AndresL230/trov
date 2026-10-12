// The Guide screenshots' DEMO dataset (scripts/capture-guide.mjs): the dev seed's content with every
// person, the organization and the product it describes swapped for made-up ones, so a published
// figure shows no real person's name, handle or address and no real company. Capture-only: the tests
// and `npm run seed` keep using fixtures/dev/*.json and scripts/seed/reset.mjs unchanged.
//
//   node scripts/seed-dev.mjs --guide-demo     (then DEV_LOGIN=maya-chen in .dev.vars)
//
// How: the same statements as the dev seed (`buildSeedStatements`), built from the fixtures after a
// string rewrite (`DEMO_REWRITES`), with the reset's people, identities, memberships, login map and
// superadmin replaced by `DEMO_PEOPLE` before any content row is written. The organization keeps its
// internal id (`org_saplinglearn` is every tenant table's transitional DEFAULT, and no screen shows it);
// its name and slug are the demo's. No avatar is stored, so every picture is the person's initials.
import { RESET_STATEMENTS } from "./reset.mjs";
import { buildSeedStatements } from "./build.mjs";

const q = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

export const DEMO_ORG = { id: "org_saplinglearn", name: "Mossgrove", slug: "mossgrove" };
export const DEMO_LOGIN = "maya-chen";
const MAIL = "mossgrove.example"; // RFC 2606: a domain that can never be anyone's

/** The made-up team. `from` / `first` name the dev seed's person and first name each one stands in for. */
export const DEMO_PEOPLE = [
  { from: "AndresL230", first: "Andres", handle: "maya-chen", name: "Maya Chen", color: "moss", github: true, mail: "maya",
    role: "Founding engineer", responsibilities: "The platform: the API, database migrations, agent tooling and auth. Deploys and production incidents." },
  { from: "Jose-Gael-Cruz-Lopez", first: "Jose", handle: "jweber", name: "Jonas Weber", color: "sky", github: true,
    role: "Backend engineer", responsibilities: "The Mossgrove API: the tutor, quizzes and the retrieval pipeline. LLM cost and backend errors." },
  { from: "lpcooper-arch", first: "Luke", handle: "priyar", name: "Priya Raman", color: "fern", github: true,
    role: "Frontend engineer", responsibilities: "The Mossgrove web app: study screens, flashcards, onboarding, accessibility and bundle size." },
  { from: "Darkest-Teddy", first: "Jack", handle: "tortega", name: "Tomás Ortega", color: "plum", github: true,
    role: "Infrastructure engineer", responsibilities: "CI, the Workers builds, environments and health checks, the metrics endpoint." },
  { from: "meilin", first: "Meilin", handle: "amina-y", name: "Amina Yusuf", color: "rose", mail: "amina",
    role: "Product manager", responsibilities: "The roadmap and sprint planning, user research, triage of incoming requests." },
  { from: "sanaok", first: "Sana", handle: "kofi-m", name: "Kofi Mensah", color: "ochre", mail: "kofi",
    role: "Community lead", responsibilities: "Student and teacher support, community content, bug reports from users." },
];

const word = (w) => new RegExp(`\\b${w}\\b`, "g");
/** Applied in order to every string in the fixtures: longest and most specific first. */
export const DEMO_REWRITES = [
  [/SaplingLearn\/sapling/g, "mossgrove/mossgrove"],
  [/saplinglearn\.(com|org)/gi, MAIL],
  [/SaplingLearn/g, DEMO_ORG.name],
  [/saplinglearn/gi, DEMO_ORG.slug],
  [/SAPLING/g, "MOSSGROVE"],
  [/Sapling/g, "Mossgrove"],
  [/sapling/g, "mossgrove"],
  [/CANOPY/g, "TROV"],
  [/Canopy/g, "Trov"],
  [/canopy/g, "trov"],
  ...DEMO_PEOPLE.map((p) => [word(p.from), p.handle]),
  ...DEMO_PEOPLE.map((p) => [word(p.first), p.name.split(" ")[0]]),
  [word("Zhao"), "Yusuf"],
  [word("Okafor"), "Mensah"],
];

export const demoText = (s) => DEMO_REWRITES.reduce((t, [re, to]) => t.replace(re, to), s);

// The fixtures read as of 2026-07-07 (their newest activity is the day before). Every date in them moves
// forward by whole days so that day is yesterday: a figure then shows this week's feed and the sprints
// at the stage the fixtures describe, not months overdue, and nothing past lands in the future.
const DAY = 86_400_000;
const FIXTURES_AS_OF = Date.parse("2026-07-07T00:00:00Z");
export const demoShiftDays = (now = Date.now()) => Math.max(0, Math.floor((now - FIXTURES_AS_OF) / DAY));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const plusDays = (y, m, d, days) => new Date(Date.UTC(y, m, d) + days * DAY);
/** `2026-07-05` / `2026-07-05T14:00:00Z` → the same format, `days` later (the time of day is unchanged). */
const shiftIso = (s, days) => s.replace(/\b(\d{4})-(\d{2})-(\d{2})(?=T|\b)/g, (_, y, m, d) =>
  plusDays(+y, +m - 1, +d, days).toISOString().slice(0, 10));
/** A sprint's free-text `dates` label, "May 1 – Jun 10" → the same, `days` later. */
const shiftLabel = (s, days) => s.replace(new RegExp(`\\b(${MONTHS.join("|")}) (\\d{1,2})\\b`, "g"), (_, mon, d) => {
  const t = plusDays(2026, MONTHS.indexOf(mon), +d, days);
  return `${MONTHS[t.getUTCMonth()]} ${t.getUTCDate()}`;
});

/** Every string in a parsed fixture, rewritten and its dates moved `days` on (keys are left alone). */
export function demoFixture(v, days = demoShiftDays(), key = "") {
  if (typeof v === "string") return key === "dates" ? shiftLabel(v, days) : shiftIso(demoText(v), days);
  if (Array.isArray(v)) return v.map((x) => demoFixture(x, days, key));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, demoFixture(x, days, k)]));
  return v;
}

/** The demo team and organization, written over the reset's (before any row references a person). */
function demoPeopleStatements() {
  const at = "2026-01-01T00:00:00Z";
  const s = [
    "DELETE FROM platform_admins",
    "DELETE FROM org_login_map",
    "DELETE FROM memberships",
    "DELETE FROM identities",
    "DELETE FROM persons WHERE handle <> 'github-webhook'",
    `UPDATE orgs SET name = ${q(DEMO_ORG.name)}, slug = ${q(DEMO_ORG.slug)} WHERE id = ${q(DEMO_ORG.id)}`,
  ];
  for (const p of DEMO_PEOPLE) {
    const email = p.mail ? `${p.mail}@${MAIL}` : null;
    s.push(`INSERT INTO persons (handle, name, color, email, created_at, onboarded_at, role, responsibilities) VALUES (${q(p.handle)}, ${q(p.name)}, ${q(p.color)}, ${q(email)}, ${q(at)}, ${q(at)}, ${q(p.role)}, ${q(p.responsibilities)})`);
    if (p.github) {
      s.push(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by) VALUES ('github', ${q(p.handle)}, ${q(p.handle)}, ${q(p.handle)}, ${q(at)}, 'seed')`);
      s.push(`INSERT INTO org_login_map (org_id, github_login, person, mapped_at, mapped_by) VALUES (${q(DEMO_ORG.id)}, ${q(p.handle)}, ${q(p.handle)}, ${q(at)}, 'seed')`);
    }
    if (email) {
      s.push(`INSERT INTO identities (provider, subject, label, person, linked_at, linked_by, verified_email) VALUES ('google', ${q(`google-sub-${p.handle}`)}, ${q(email)}, ${q(p.handle)}, ${q(at)}, 'seed', ${q(email)})`);
    }
    s.push(`INSERT INTO memberships (org_id, user_id, role, title, responsibilities, created_at, created_by) VALUES (${q(DEMO_ORG.id)}, ${q(p.handle)}, ${q(p.handle === DEMO_LOGIN ? "owner" : "member")}, ${q(p.role)}, ${q(p.responsibilities)}, ${q(at)}, 'seed')`);
  }
  return s;
}

/** The whole demo seed, in order: reset, the demo team, then the rewritten fixtures' rows. */
export function guideDemoStatements(fx) {
  const built = buildSeedStatements(demoFixture(fx));
  const n = RESET_STATEMENTS.length;
  return [...built.slice(0, n), ...demoPeopleStatements(), ...built.slice(n)];
}
