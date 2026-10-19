#!/usr/bin/env node
// `npm run seed` — the LOCAL dev seed (docs/architecture/local-dev.md). Loads the named scenarios of
// scripts/seed/scenarios.mjs into LOCAL D1 through wrangler; it refuses --remote outright and never reaches a network
// (but the running dev server, below).
//
//   npm run seed                              every scenario (team, empty, free-at-cap, pro, hosting), each rewriting
//                                             its own org — other orgs and your sessions are kept
//   npm run seed -- --reset                   wipe every data table first (the canonical reset), then every scenario
//   npm run seed -- --scenario team,hosting   only these
//   npm run seed -- --list                    the scenarios, their orgs and who to sign in as; touches nothing
//   npm run seed -- --server http://localhost:8787
//                                             the RUNNING dev server: the AI showcase's Ask answers store each chip as
//                                             that server's `/ask/peek` RefView (without it the answers keep their
//                                             words but no chips). Default: tried at :8787, skipped if nothing answers.
//   --persist-to <dir>                        wrangler's local state directory (default: its own .wrangler/state)
//
// `--guide-demo` loads the Guide screenshots' made-up dataset instead (scripts/seed/guide-demo.mjs: the same
// fixtures with a fictional team, organization and product); sign in as DEV_LOGIN=maya-chen.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { targetsRemote } from "./seed/build.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("seed-dev: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}
const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] ?? "" : null; };
const persistTo = arg("--persist-to");

if (argv.includes("--guide-demo")) {
  // The Guide demo: the canonical reset and the fixtures with a fictional team (unchanged by the scenarios).
  const { guideDemoStatements, DEMO_LOGIN } = await import("./seed/guide-demo.mjs");
  const dir = fileURLToPath(new URL("../fixtures/dev/", import.meta.url));
  const load = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
  const fx = { docs: load("docs.json"), feed: load("feed.json"), adrs: load("adrs.json"), triage: load("triage.json"), roadmap: load("roadmap.json"), tickets: load("tickets.json"),
    events: load("events.json"), identity: load("identity.json"), handoffs: load("handoffs.json"), prompts: load("prompts.json"), themes: load("themes.json") };
  const statements = guideDemoStatements(fx);
  const file = join(mkdtempSync(join(tmpdir(), "trov-seed-")), "seed.sql");
  console.log(`seed-dev: applying ${statements.length} statements (the Guide demo) to LOCAL D1…`);
  for (let i = 0; i < statements.length; i += 8) {
    writeFileSync(file, statements.slice(i, i + 8).map((s) => s + ";").join("\n"), "utf8");
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", ...(persistTo ? [`--persist-to=${persistTo}`] : []), `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"] });
  }
  console.log(`seed-dev: done — the Guide demo dataset. Set DEV_LOGIN=${DEMO_LOGIN} and run \`npm run dev\`.`);
  process.exit(0);
}

const { SCENARIOS, scenarioNames, loadScenarios } = await import("./seed/scenarios.mjs");
if (argv.includes("--list")) {
  for (const s of SCENARIOS) {
    console.log(`${s.name.padEnd(12)} /${s.slug}/  ${s.what}`);
    for (const [h, role] of s.signIn) console.log(`${"".padEnd(14)}sign in: npm run dev:as -- ${h}   (${role})`);
  }
  process.exit(0);
}
const pick = arg("--scenario");
const names = pick ? pick.split(",").map((x) => x.trim()).filter(Boolean) : scenarioNames();
const unknown = names.filter((n) => !scenarioNames().includes(n));
if (unknown.length) { console.error(`seed-dev: unknown scenario ${unknown.join(", ")} — one of ${scenarioNames().join(", ")}`); process.exit(1); }

const { localD1 } = await import("./seed/local-d1.mjs");
const raw = localD1({ persistTo });
const db = { query: async (sqls) => raw.query(sqls), apply: async (label, statements) => raw.apply(label, statements) };

// The migrations must be applied (npm run dev does it; a bare `npm run seed` on a fresh state says so).
try {
  const [t] = raw.query(["SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('orgs', 'repo_apps', 'chat_threads')"]);
  if (t.length < 3) throw new Error("missing tables");
} catch {
  console.error("seed-dev: this local D1 has no (or an old) schema — apply the migrations first: npx wrangler d1 migrations apply DB --local");
  process.exit(1);
}

// The showcase's Ask chips: the running dev server's RefViews, when one answers (signed in by DEV_LOGIN).
const server = (arg("--server") || "http://localhost:8787").replace(/\/+$/, "");
let views = null;
if (names.includes("team")) {
  try {
    const res = await fetch(`${server}/api/o/saplinglearn/ask/peek`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refs: ["ticket:1"] }), signal: AbortSignal.timeout(2500) });
    if (res.ok) {
      views = async (refs) => {
        const out = {};
        for (let i = 0; i < refs.length; i += 50) {
          const r = await fetch(`${server}/api/o/saplinglearn/ask/peek`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refs: refs.slice(i, i + 50) }) });
          if (!r.ok) continue;
          for (const it of (await r.json()).items ?? []) if (!it.hidden) out[it.ref] = it;
        }
        return out;
      };
      console.log(`seed-dev: Ask chips from the running server at ${server}`);
    }
  } catch { /* no server: the answers keep their words, without chips */ }
}
// The image an Ask question attached (the showcase): its bytes go to the LOCAL R2 bucket the Worker reads.
let image = null;
if (names.includes("team")) {
  try {
    const pngPath = fileURLToPath(new URL("../fixtures/dev/ai-showcase/railway-build-log.png", import.meta.url));
    const png = readFileSync(pngPath);
    image = { sha: createHash("sha256").update(png).digest("hex"), size: png.length };
    const bucket = (readFileSync("wrangler.toml", "utf8").match(/binding\s*=\s*"ARTIFACTS_BUCKET"\s*\n\s*bucket_name\s*=\s*"([^"]+)"/) ?? [])[1] ?? "trov-artifacts";
    execFileSync("npx", ["wrangler", "r2", "object", "put", `${bucket}/artifacts/${image.sha}`, "--local", ...(persistTo ? [`--persist-to=${persistTo}`] : []), `--file=${pngPath}`, "--content-type=image/png"], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (e) { image = null; console.log(`seed-dev: the showcase's attached image is skipped (${e instanceof Error ? e.message.split("\n")[0] : e})`); }
}

const reset = argv.includes("--reset");
console.log(`seed-dev: ${reset ? "wiping every data table, then " : ""}loading ${names.join(", ")} into LOCAL D1…`);
const out = await loadScenarios(db, names, { reset, views, image, origin: server, log: (line) => console.log(`\n${line}`) });
// Home's Docs promoted (0077_home): the seeded versions were never promoted through promote_doc, so they carry no
// promotion time — the dev data stands in with its staging time, and every dev org counts as timed from the start.
// DEV DATA ONLY: production never backfills (the staging time is not the promotion time).
await db.apply("home: promotion times", [
  "UPDATE doc_versions SET promoted_at = created_at WHERE status = 'promoted' AND promoted_at IS NULL",
  "UPDATE orgs SET promotions_timed_at = '2000-01-01T00:00:00.000Z'",
]);
if (out.team?.unresolved?.length) console.log(`\n(Ask answers name ${out.team.unresolved.length} item(s) without a chip — rerun with the dev server up for chips.)`);

console.log("\nseed-dev: done. Open:");
for (const s of SCENARIOS.filter((x) => names.includes(x.name))) {
  console.log(`  ${s.name.padEnd(12)} ${server}/${s.slug}/   sign in: ${s.signIn.map(([h, r]) => `${h} (${r})`).join(", ")}`);
}
console.log("Sign in as anyone: npm run dev:as -- <handle>   (or open /auth/dev/as on the dev server)");
