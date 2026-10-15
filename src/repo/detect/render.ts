// render.yaml (a Render Blueprint) — one app per service: `rootDir` is its folder (relative to the repository root),
// `type` its kind (web / pserv / worker → Service, cron → Job, a static site → Site), `name` what the host calls it.
// The service id (the part's setting) comes from Render itself (`describe`, in the scan).
import type { AppKind } from "@shared/repo-apps-core";
import { arr, parseYaml, rec, str } from "./parse";
import { baseOf, fromFile, joinFolder, type Candidate, type Detector } from "./types";

const kindOf = (type: string | null, runtime: string | null): AppKind | null => {
  if (type === "cron") return "Job";
  if (type === "static" || runtime === "static") return "Site";
  if (type === "web" || type === "pserv" || type === "worker" || type === "private_service" || type === "background_worker") return "Service";
  return null; // a database or a key-value store is not an app
};

export const render: Detector = {
  id: "render",
  patterns: ["render.yaml", "render.yml"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (!["render.yaml", "render.yml"].includes(baseOf(path)) || path.includes("/")) continue; // a Blueprint lives at the root
      for (const s of arr(rec(parseYaml(text))?.services)) {
        const svc = rec(s);
        if (!svc) continue;
        const kind = kindOf(str(svc.type), str(svc.runtime) ?? str(svc.env));
        if (!kind) continue;
        const name = str(svc.name);
        const folder = joinFolder("/", str(svc.rootDir) ?? "");
        if (!folder) continue;
        out.push({
          folder, kind, provider: "render", source: "deploy", names: name ? [name] : [],
          evidence: [fromFile(path, name ? `service ${name}` : undefined)], settings: {},
        });
      }
    }
    return out;
  },
};
