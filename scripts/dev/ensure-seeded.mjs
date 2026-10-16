#!/usr/bin/env node
// Run by `npm run dev` before `wrangler dev` (docs/architecture/local-dev.md): a working local app from ONE command,
// in a fresh clone or a fresh git worktree (each worktree has its own `.wrangler/state`, so its own empty D1).
//
//   1. `.dev.vars` — when missing, copied from the main checkout's (a worktree), else written from
//      `.dev.vars.example` with a random COOKIE_SECRET / TROV_KEK and DEV_LOGIN=AndresL230. Never overwritten.
//   2. the LOCAL migrations applied (`wrangler d1 migrations apply DB --local`).
//   3. the dev seed (`npm run seed`, every scenario) when the local D1 has no organization members yet — or always,
//      with `--force` (`npm run dev:seeded`).
//
// LOCAL ONLY: it refuses --remote, and every wrangler call it makes is `--local`.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
if (argv.includes("--remote")) {
  console.error("ensure-seeded: refusing --remote. The dev seed only ever targets LOCAL D1.");
  process.exit(1);
}
const i = argv.indexOf("--persist-to");
const persist = i >= 0 && argv[i + 1] ? [`--persist-to=${argv[i + 1]}`] : []; // wrangler's state dir (default .wrangler/state)
const ENV = { ...process.env, CI: "true", npm_config_loglevel: "error" }; // CI: wrangler applies migrations without asking
const say = (m) => console.log(`dev: ${m}`);

// 1. .dev.vars
if (!existsSync(".dev.vars")) {
  let main = null;
  try {
    main = dirname(resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim()));
  } catch { /* not a git checkout */ }
  if (main && resolve(main) !== resolve(".") && existsSync(join(main, ".dev.vars"))) {
    copyFileSync(join(main, ".dev.vars"), ".dev.vars");
    say(`copied .dev.vars from the main checkout (${main})`);
  } else if (existsSync(".dev.vars.example")) {
    let text = readFileSync(".dev.vars.example", "utf8")
      .replace(/^COOKIE_SECRET=.*$/m, `COOKIE_SECRET=${randomBytes(32).toString("hex")}`)
      .replace(/^TROV_KEK=.*$/m, `TROV_KEK=${randomBytes(32).toString("base64")}`);
    if (!/^DEV_LOGIN=/m.test(text)) text += "\n# LOCAL DEV ONLY: act as this seeded person (docs/architecture/local-dev.md). Never a deployed var.\nDEV_LOGIN=AndresL230\n";
    writeFileSync(".dev.vars", text);
    say("wrote .dev.vars from .dev.vars.example (random COOKIE_SECRET and TROV_KEK, DEV_LOGIN=AndresL230)");
  }
}

// 2. the local migrations
say("applying the local D1 migrations…");
execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "DB", "--local", ...persist], { stdio: ["ignore", "ignore", "inherit"], env: ENV });

// 3. the seed, when there is nothing yet (or always, with --force)
let members = 0;
try {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", ...persist, "--json", "--command=SELECT COUNT(*) AS n FROM memberships"], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], env: ENV });
  members = Number(JSON.parse(out)[0]?.results?.[0]?.n ?? 0);
} catch { members = 0; }
if (members === 0 || argv.includes("--force")) {
  say(members === 0 ? "the local D1 is empty — seeding every scenario (npm run seed)…" : "reseeding every scenario (npm run seed)…");
  execFileSync("node", ["scripts/seed-dev.mjs", ...(members === 0 ? ["--reset"] : []), ...(persist.length ? ["--persist-to", argv[i + 1]] : [])], { stdio: "inherit", env: { ...process.env } });
} else {
  say(`the local D1 has data (${members} memberships) — \`npm run seed\` reseeds, \`npm run seed -- --reset\` wipes and reseeds.`);
}
