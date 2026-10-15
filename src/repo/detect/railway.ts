// railway.json / railway.toml — a Service on Railway (config as code). The file names neither the service nor the
// environment, so there is no part setting to propose from it; the deploy signal Railway reports to GitHub
// (`<service> / <environment>`) does the rest (./match.ts).
import { parseJsonc, parseToml, rec } from "./parse";
import { baseOf, folderOf, fromFile, type Candidate, type Detector } from "./types";

export const railway: Detector = {
  id: "railway",
  patterns: ["**/railway.json", "**/railway.toml"],
  detect(input) {
    const out: Candidate[] = [];
    const done = new Set<string>();
    for (const [path, text] of input.files) {
      const name = baseOf(path);
      if (name !== "railway.json" && name !== "railway.toml") continue;
      const folder = folderOf(path);
      if (done.has(folder)) continue;
      const cfg = name === "railway.json" ? rec(parseJsonc(text)) : parseToml(text);
      if (!cfg) continue;
      done.add(folder);
      out.push({ folder, kind: "Service", provider: "railway", source: "deploy", names: [], evidence: [fromFile(path)], settings: {} });
    }
    return out;
  },
};
