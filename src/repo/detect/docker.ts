// A Dockerfile PLUS a workflow that deploys it — a Service. A Dockerfile alone is not an app (images are built for
// tests, dev containers, CI); it counts only when a workflow under .github/workflows references the Dockerfile's
// folder AND uses a deploy action. The deploy action names the host when it can (Fly.io, Railway, Render, AWS); the
// workflow file is what a `github` part would name.
import type { HostingProviderId } from "@shared/hosting";
import { baseOf, folderOf, fromFile, type Candidate, type Detector } from "./types";

/** Deploy steps, and the host each one deploys to (null = a host Trov has no provider for). */
const DEPLOYS: [RegExp, HostingProviderId | null][] = [
  [/superfly\/flyctl-actions|\bflyctl\s+deploy\b|\bfly\s+deploy\b/, "fly"],
  [/railwayapp\/|\brailway\s+up\b/, "railway"],
  [/api\.render\.com\/deploy|render-deploy|RENDER_DEPLOY_HOOK/i, "render"],
  [/aws-actions\/amazon-ecs-deploy-task-definition|aws-actions\/amazon-ecr-login|\baws\s+ecs\s+update-service\b/, "aws"],
  [/google-github-actions\/deploy-cloudrun|\bgcloud\s+run\s+deploy\b/, null],
  [/azure\/webapps-deploy|azure\/container-apps-deploy-action/i, null],
  [/digitalocean\/app_action|\bdoctl\s+apps\s+create-deployment\b/, null],
  [/kubectl\s+(apply|set\s+image|rollout)|azure\/k8s-deploy|helm\s+upgrade/, null],
];

const isWorkflow = (p: string) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Does the workflow text point at `folder` (its Dockerfile, or a build context there)? */
function references(text: string, folder: string): boolean {
  if (folder === "/") return /(^|[\s"'=:])(\.\/)?Dockerfile\b/m.test(text) || /context:\s*["']?\.\/?["']?\s*$/m.test(text);
  return new RegExp(`(^|[\\s"'=:])(\\./)?${escape(folder)}(/|["'\\s]|$)`, "m").test(text);
}

export const docker: Detector = {
  id: "docker",
  patterns: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  seen: ["Dockerfile"],
  detect(input) {
    const folders = [...new Set(input.tree.filter((p) => baseOf(p) === "Dockerfile").map(folderOf))];
    const workflows = [...input.files].filter(([p]) => isWorkflow(p));
    const out: Candidate[] = [];
    for (const folder of folders) {
      for (const [path, text] of workflows) {
        const deploy = DEPLOYS.find(([re]) => re.test(text));
        if (!deploy || !references(text, folder)) continue;
        const dockerfile = folder === "/" ? "Dockerfile" : `${folder}/Dockerfile`;
        out.push({
          folder, kind: "Service", provider: deploy[1], source: "deploy", names: [], workflow: path,
          evidence: [fromFile(dockerfile), { kind: "file", text: `deployed by ${path}` }], settings: {},
        });
        break; // one workflow is enough
      }
    }
    return out;
  },
};
