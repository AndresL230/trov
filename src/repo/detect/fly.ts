// fly.toml — an app on Fly.io: `app` is the part's `app` setting. With `[http_service]` / `[[services]]` it serves
// requests (a Service); with neither it is a worker or a scheduled machine — still a Service (Fly.io reports the same
// for both), never guessed to be a Job.
import { parseToml, str } from "./parse";
import { baseOf, folderOf, fromFile, type Candidate, type Detector } from "./types";

export const fly: Detector = {
  id: "fly",
  patterns: ["**/fly.toml"],
  detect(input) {
    const out: Candidate[] = [];
    for (const [path, text] of input.files) {
      if (baseOf(path) !== "fly.toml") continue;
      const app = str(parseToml(text).app);
      out.push({
        folder: folderOf(path), kind: "Service", provider: "fly", source: "deploy", names: app ? [app] : [],
        evidence: [fromFile(path, app ? `app ${app}` : undefined)], settings: app ? { app } : {},
      });
    }
    return out;
  },
};
