// vercel.json — a Site on Vercel. The project's name is rarely in the file (its legacy `name` key, when present, is
// the part's `project` setting); which project builds the folder comes from Vercel itself (`describe`, in the scan).
import { parseJsonc, rec, str } from "./parse";
import { baseOf, folderOf, fromFile, type Candidate, type Detector } from "./types";

export const vercel: Detector = {
  id: "vercel",
  patterns: ["**/vercel.json"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (baseOf(path) !== "vercel.json") continue;
      const cfg = rec(parseJsonc(text));
      if (!cfg) continue; // an unreadable vercel.json is not evidence of anything
      const name = str(cfg.name);
      out.push({
        folder: folderOf(path), kind: "Site", provider: "vercel", source: "deploy", names: name ? [name] : [],
        evidence: [fromFile(path)], settings: name ? { project: name } : {},
      });
    }
    return out;
  },
};
