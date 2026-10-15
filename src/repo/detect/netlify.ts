// netlify.toml — a Site on Netlify. `[build] base` moves the app to that folder (relative to the file's own). The
// site id (the part's setting) comes from Netlify itself (`describe`, in the scan).
import { parseToml, rec, str } from "./parse";
import { baseOf, folderOf, fromFile, joinFolder, type Candidate, type Detector } from "./types";

export const netlify: Detector = {
  id: "netlify",
  patterns: ["**/netlify.toml"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (baseOf(path) !== "netlify.toml") continue;
      const cfg = parseToml(text);
      const base = str(rec(cfg.build)?.base);
      const folder = base ? joinFolder(folderOf(path), base) : folderOf(path);
      if (!folder) continue; // a base outside the repository
      out.push({
        folder, kind: "Site", provider: "netlify", source: "deploy", names: [],
        evidence: [fromFile(path, base ? `base ${folder}` : undefined)], settings: {},
      });
    }
    return out;
  },
};
