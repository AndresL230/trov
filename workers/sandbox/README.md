# trov-sandbox

Trov's private Daytona runner: the second Worker in this repo, behind Trov's `SANDBOX` Service Binding. The full
reference is `docs/architecture/sandboxes.md`.

```sh
npm run deploy:sandbox                                              # from the repo root
npx wrangler secret put DAYTONA_API_KEY -c workers/sandbox/wrangler.toml
npx vitest run test/sandbox-runner.test.ts                          # its tests run in `npm test` too
```
