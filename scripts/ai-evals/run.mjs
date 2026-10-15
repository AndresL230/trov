#!/usr/bin/env node
// Bundles scripts/ai-evals/run.ts (the card modules, the eval sets' helpers and the Jev provider) with esbuild and
// runs it: `node scripts/ai-evals/run.mjs record` (LIVE — needs TYPESAFE_API_KEY in the environment; a few cents) or
// `node scripts/ai-evals/run.mjs score` (offline). Never part of `npm test`.
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = join(mkdtempSync(join(tmpdir(), "trov-evals-")), "run.mjs");
await build({
  entryPoints: [join(root, "scripts/ai-evals/run.ts")], bundle: true, platform: "node", format: "esm", outfile: out,
  alias: { "@shared": join(root, "shared") }, external: ["cloudflare:*"], logLevel: "warning",
});
process.env.EVAL_ROOT = root;
// `--vars <file>`: read TYPESAFE_API_KEY from a .dev.vars file (KEY=value lines) without printing it.
const at = process.argv.indexOf("--vars");
if (at > 0 && !process.env.TYPESAFE_API_KEY) {
  const { readFileSync } = await import("node:fs");
  const line = readFileSync(process.argv[at + 1], "utf8").split("\n").find((l) => /^\s*TYPESAFE_API_KEY\s*=/.test(l));
  if (line) process.env.TYPESAFE_API_KEY = line.replace(/^\s*TYPESAFE_API_KEY\s*=\s*/, "").trim().replace(/^["']|["']$/g, "");
}
await import(pathToFileURL(out).href);
