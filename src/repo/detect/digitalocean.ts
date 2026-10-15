// .do/app.yaml — a DigitalOcean App Platform spec (a host Trov has no provider for: the suggestion has no host).
// `services` / `workers` → Service, `static_sites` → Site, `jobs` → Job; `source_dir` is the folder.
import type { AppKind } from "@shared/repo-apps-core";
import { arr, parseYaml, rec, str } from "./parse";
import { fromFile, joinFolder, type Candidate, type Detector } from "./types";

const SECTIONS: [string, AppKind][] = [["services", "Service"], ["workers", "Service"], ["static_sites", "Site"], ["jobs", "Job"]];

export const digitalocean: Detector = {
  id: "digitalocean",
  patterns: [".do/app.yaml", ".do/app.yml"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (path !== ".do/app.yaml" && path !== ".do/app.yml") continue;
      const doc = rec(parseYaml(text));
      if (!doc) continue;
      for (const [section, kind] of SECTIONS) {
        for (const c of arr(doc[section])) {
          const comp = rec(c);
          if (!comp) continue;
          const folder = joinFolder("/", str(comp.source_dir) ?? "");
          if (!folder) continue;
          const name = str(comp.name);
          out.push({ folder, kind, provider: null, source: "deploy", names: name ? [name] : [], evidence: [fromFile(path, name ? `${section.replace(/_/g, " ").replace(/s$/, "")} ${name}` : undefined)], settings: {} });
        }
      }
    }
    return out;
  },
};
