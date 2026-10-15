# Repo scan fixtures

Hand-written repositories in the shapes the detectors read (src/repo/detect/), for `test/repo-detect.test.ts` and
`test/repo-scan.test.ts`. A folder named `_github` / `_do` stands for `.github` / `.do` (the tests' loader maps
them back), so the glob that loads them needs no dotfile support.

- `storefront/` — acme/storefront, the design's OrgSetup scenario: a pnpm monorepo with a Vercel site (`apps/web`), a
  Render service (`apps/api`, from the root `render.yaml`), a Cloudflare Pages site (`apps/docs`), a Fly.io app
  deployed by a workflow (`apps/jobs`) and a package two apps use (`packages/ui`).
- `singles/` — one file per detector that `storefront` does not exercise: Trov's own wrangler.toml (a Worker with
  D1, crons and an `[env.preview]`), netlify.toml with a `[build] base`, railway.json, amplify.yml, `.do/app.yaml`,
  a Procfile, a Dockerfile deployed by a workflow, go.work, a Cargo workspace, lerna.json.
