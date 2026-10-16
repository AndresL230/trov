// wrangler.toml / wrangler.json / wrangler.jsonc — a Cloudflare Worker (or a Pages site).
//   `name`                      → a Worker on Cloudflare (part setting `worker`)
//   `pages_build_output_dir`    → a Site on Cloudflare Pages (no Worker name to read, so no part setting)
//   `d1_databases[].database_id`, `triggers.crons` → extras on the proposed part settings (`d1_database_ids`,
//                                 `crons`), for the Usage tab's storage and schedules (Phase G); an Accept keeps
//                                 them on the suggestion and writes only the provider's own settings.
//   `[env.<name>]`              → that environment's Worker: its own `name`, else wrangler's `<name>-<env>`.
import { parseJsonc, parseToml, rec, str, arr, type Rec } from "./parse";
import { baseOf, folderOf, fromFile, type Candidate, type Detector } from "./types";

const FILES = ["wrangler.toml", "wrangler.json", "wrangler.jsonc"];

/** The Cloudflare part settings' own bounds (src/hosting/providers/cloudflare.ts `D1_IDS` / `CRONS`): past them the
 *  pattern refuses the setting, and a refused setting would drop the whole suggestion — so keep the first ones. */
export const WRANGLER_MAX_D1 = 5;
export const WRANGLER_MAX_CRONS = 10;

function extras(cfg: Rec): Record<string, string> {
  const out: Record<string, string> = {};
  const d1 = arr(cfg.d1_databases).map((d) => str(rec(d)?.database_id)).filter((s): s is string => s !== null);
  if (d1.length) out.d1_database_ids = [...new Set(d1)].slice(0, WRANGLER_MAX_D1).join(",");
  const crons = arr(rec(cfg.triggers)?.crons).map(str).filter((s): s is string => s !== null);
  if (crons.length) out.crons = [...new Set(crons)].slice(0, WRANGLER_MAX_CRONS).join(";");
  return out;
}

export const wrangler: Detector = {
  id: "wrangler",
  patterns: FILES.map((f) => `**/${f}`),
  detect(input) {
    const out: Candidate[] = [];
    const done = new Set<string>();
    for (const [path, text] of input.files) {
      if (!FILES.includes(baseOf(path))) continue;
      const folder = folderOf(path);
      if (done.has(folder)) continue; // one config per folder: .toml, then .json, then .jsonc (read order)
      const cfg = baseOf(path) === "wrangler.toml" ? parseToml(text) : rec(parseJsonc(text));
      if (!cfg) continue;
      const name = str(cfg.name);
      const pages = str(cfg.pages_build_output_dir);
      if (!name && !pages) continue;
      done.add(folder);
      if (pages) {
        out.push({
          folder, kind: "Site", provider: "cloudflare", source: "deploy", names: name ? [name] : [],
          evidence: [fromFile(path, `Pages output ${pages.replace(/^\.\//, "")}`)], settings: extras(cfg),
        });
        continue;
      }
      const envSettings: Record<string, Record<string, string>> = {};
      for (const [env, body] of Object.entries(rec(cfg.env) ?? {})) {
        const e = rec(body);
        if (!e) continue;
        // wrangler: bindings (d1_databases) are NOT inherited by an environment; triggers are.
        envSettings[env] = { worker: str(e.name) ?? `${name}-${env}`, ...extras({ d1_databases: e.d1_databases, triggers: e.triggers ?? cfg.triggers }) };
      }
      out.push({
        folder, kind: "Worker", provider: "cloudflare", source: "deploy", names: [name!, ...Object.values(envSettings).map((s) => s.worker)],
        evidence: [fromFile(path, `Worker ${name}`)], settings: { worker: name!, ...extras(cfg) },
        ...(Object.keys(envSettings).length ? { envSettings } : {}),
      });
    }
    return out;
  },
};
