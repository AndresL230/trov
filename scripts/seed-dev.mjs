#!/usr/bin/env node
// Local-only seed loader. Reads fixtures/dev/*.json, builds escaped SQL via the
// shared builder, and applies it to LOCAL D1 through wrangler. Never touches
// remote D1 — it refuses --remote outright.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildSeedStatements, targetsRemote } from "./seed/build.mjs";

const argv = process.argv.slice(2);
if (targetsRemote(argv)) {
  console.error("seed-dev: refusing --remote. This seed only ever targets LOCAL D1.");
  process.exit(1);
}

const dir = fileURLToPath(new URL("../fixtures/dev/", import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(dir, name), "utf8"));
const fx = {
  docs: load("docs.json"),
  feed: load("feed.json"),
  adrs: load("adrs.json"),
  triage: load("triage.json"),
  roadmap: load("roadmap.json"),
  tickets: load("tickets.json"),
  events: load("events.json"),
  identity: load("identity.json"),
  handoffs: load("handoffs.json"),
  prompts: load("prompts.json"),
};

const statements = buildSeedStatements(fx);
const sql = statements.map((s) => s + ";").join("\n");

const file = join(mkdtempSync(join(tmpdir(), "trov-seed-")), "seed.sql");
writeFileSync(file, sql, "utf8");

console.log(`seed-dev: applying ${statements.length} statements to LOCAL D1…`);
execFileSync("npx", ["wrangler", "d1", "execute", "canopy", "--local", `--file=${file}`], { stdio: "inherit" });
console.log("seed-dev: done — local D1 seeded for every surface. Set DEV_LOGIN=AndresL230 and run `npm run dev`.");
