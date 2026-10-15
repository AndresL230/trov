// Procfile — a process app (Heroku and the hosts that read the same file): a Service. No host is named by the file.
import { baseOf, folderOf, fromFile, type Candidate, type Detector } from "./types";

export const procfile: Detector = {
  id: "procfile",
  patterns: ["**/Procfile"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (baseOf(path) !== "Procfile") continue;
      const types = text.split(/\r?\n/).map((l) => /^([A-Za-z0-9_-]+):\s*\S/.exec(l)?.[1]).filter((t): t is string => !!t);
      if (!types.length) continue;
      out.push({ folder: folderOf(path), kind: "Service", provider: null, source: "deploy", names: [], evidence: [fromFile(path, `processes ${types.slice(0, 4).join(", ")}`)], settings: {} });
    }
    return out;
  },
};
