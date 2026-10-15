# Render fixtures (#99)

Recorded-SHAPE responses of `api.render.com/v1` (field names from render-oss/cli's generated client; ids, values and timestamps invented, 2026-10-07). Used by `test/hosting.provider.render.test.ts` and as local dev / design stubs.

- `service.json` / `service-worker.json` — `GET /services/{serviceId}` for a `web_service` and a `background_worker` (`branch`, `serviceDetails.url`, `dashboardUrl`, `ownerId`, `suspended`, `type`).
- `deploys.json` — `GET /services/{serviceId}/deploys?limit=20`: `[{ cursor, deploy }]`, one deploy per status Trov maps, an image-backed deploy (no commit), an unknown status and two malformed items (skipped).
- `owners.json` / `owner.json` — `GET /owners?limit=1` and `GET /owners/{ownerId}` (probe without a part).
- `metrics-*.json` — `GET /metrics/{http-requests?aggregateBy=statusCode, http-latency?quantile=0.95, bandwidth, cpu, memory}`: `[{ labels: [{ field, value }], unit, values: [{ timestamp, value }] }]`, with points before, inside and after the window `[09:00, 12:00)` and a few malformed points.
- UNCONFIRMED in these shapes: the `unit` strings (`requests`, `ms`, `MB`, `CPU`, `bytes` are guesses — the provider reads whatever comes), the label field names (`statusCode`, `quantile`, `instance`), whether a timestamp is ISO or epoch, and whether one series per instance comes back for CPU / memory.
