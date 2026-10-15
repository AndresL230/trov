// amplify.yml — a Site on AWS Amplify (a provider Trov lists as `later`: the suggestion names it, an Accept writes the
// app and no part). A monorepo's file lists `applications[].appRoot`.
import { arr, parseYaml, rec, str } from "./parse";
import { baseOf, folderOf, fromFile, joinFolder, type Candidate, type Detector } from "./types";

export const amplify: Detector = {
  id: "amplify",
  patterns: ["**/amplify.yml", "**/amplify.yaml"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (baseOf(path) !== "amplify.yml" && baseOf(path) !== "amplify.yaml") continue;
      const doc = rec(parseYaml(text));
      if (!doc) continue;
      const roots = arr(doc.applications).map((a) => str(rec(a)?.appRoot)).filter((s): s is string => s !== null);
      for (const root of roots.length ? roots : [""]) {
        const folder = joinFolder(folderOf(path), root);
        if (!folder) continue;
        out.push({ folder, kind: "Site", provider: "aws", source: "deploy", names: [], evidence: [fromFile(path, root ? `appRoot ${root}` : undefined)], settings: {} });
      }
    }
    return out;
  },
};
