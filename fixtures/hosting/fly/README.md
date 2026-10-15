Fly.io API responses in their recorded shape, for test/hosting.provider.fly.test.ts and as local design stubs (window: 2026-10-07 09:00–12:00 UTC).

- `app.json` — Machines API `GET https://api.machines.dev/v1/apps/{app}` (fly-go `flaps.App`; documented).
- `releases.json` — `GET https://api.fly.io/api/v1/apps/{app}/releases?limit=20`: flyctl's own REST route (`internal/uiex/releases.go`), UNDOCUMENTED. `user` is a string there (an email); the status set beyond flyctl's own `running` / `complete` / `failed` / `interrupted` is UNCONFIRMED.
- `prom-*.json` — Prometheus HTTP API at `https://api.fly.io/prometheus/{org}/api/v1/query_range` (one per query; sample `[T, "v"]` describes the hour before T), `prom-instant-up.json` the probe's `/api/v1/query`, `prom-error.json` a refused query (served with a 400).
- UNCONFIRMED: that a READ-ONLY token may read Prometheus and the releases route, and that the edge counter's `status` label holds exact codes ("503", not "5xx").
