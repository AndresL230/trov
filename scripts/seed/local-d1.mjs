// The one way the layered dev seeds reach LOCAL D1: `wrangler d1 execute DB --local`, in the folder whose
// `.wrangler/state` the running `wrangler dev` serves (the current directory). Node only — a Worker test never
// imports this file; it runs the same statements through `env.DB` instead (test/seed-scenarios.test.ts).
//
// There is no remote path here on purpose: the binding is always `--local`, and every caller refuses `--remote`
// before it gets this far (`targetsRemote`, scripts/seed/build.mjs).
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ENV = { ...process.env, npm_config_loglevel: "error" };
const LOCAL = ["d1", "execute", "DB", "--local"];

/** `{ query, apply }` over local D1. `persistTo` is wrangler's `--persist-to` (default: its own `.wrangler/state`). */
export function localD1({ persistTo = null, quiet = false } = {}) {
  const extra = persistTo ? [`--persist-to=${persistTo}`] : [];
  /** Run read statements; one result array per statement. */
  const query = (sqls) => {
    const out = execFileSync("npx", ["wrangler", ...LOCAL, ...extra, "--json", `--command=${sqls.join(";\n")}`], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024, env: ENV });
    return JSON.parse(out).map((r) => r.results ?? []);
  };
  /** Apply statements in files of at most ~80 KB (one huge file is refused by the local execute: SQLITE_TOOBIG). */
  const apply = (label, statements) => {
    const chunks = [[]];
    let size = 0;
    for (const st of statements) {
      if (size + st.length > 80_000 && chunks.at(-1).length) { chunks.push([]); size = 0; }
      chunks.at(-1).push(st);
      size += st.length;
    }
    const file = join(mkdtempSync(join(tmpdir(), "trov-seed-")), "seed.sql");
    if (!quiet) console.log(`  ${label}: ${statements.length} statements in ${chunks.length} file${chunks.length === 1 ? "" : "s"}`);
    for (const chunk of chunks) {
      if (!chunk.length) continue;
      writeFileSync(file, chunk.map((st) => st + ";").join("\n"), "utf8");
      execFileSync("npx", ["wrangler", ...LOCAL, ...extra, `--file=${file}`], { stdio: ["ignore", "ignore", "inherit"], env: ENV });
    }
  };
  return { query, apply };
}
