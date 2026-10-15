# Ask Trov — recorded SSE transcripts

One per design scenario (`Ask Trov.dc.html`), exactly what `POST /api/o/:slug/ask` streams: `event:` + `data:`
per message. Generated from `askTranscript(scenario, 2026-10-15T12:00:00Z)` in `shared/ai-fixtures.ts` ›
Ask Trov; `test/ask.contract.test.ts` fails while a file differs from its fixture. Under `wrangler dev` with
`LOCAL_AI_PREVIEW` set, `GET /api/o/:slug/ai/ask-replay/<scenario>` streams the same at real pacing.

- `live`: no stream (the screen draws from the state, thread and settings fixtures).
- `streaming.sse`: 69 events (thread, activity, text).
- `thinking.sse`: 189 events (thread, activity, thinking, text, block, followups, done).
- `answer.sse`: 187 events (thread, activity, text, block, followups, done).
- `answer-pr.sse`: 187 events (thread, activity, text, block, followups, done).
- `actions-ask.sse`: 21 events (thread, activity, text, action, done).
- `actions-auto.sse`: 23 events (thread, activity, action_result, action, text, done).
- `artifact.sse`: 21 events (thread, activity, block, text, done).
- `artifact-saved.sse`: 22 events (thread, activity, block, text, done, artifact_saved).
- `search.sse`: 82 events (thread, activity, text, block, followups, done).
- `notfound.sse`: 12 events (thread, activity, block, done).
- `cmdj.sse`: 43 events (thread, activity, text, followups, done).
- `ticket`: no stream (the screen draws from the state, thread and settings fixtures).
- `settings`: no stream (the screen draws from the state, thread and settings fixtures).
- `phone.sse`: 187 events (thread, activity, text, block, followups, done).
- `phone-plus.sse`: 187 events (thread, activity, text, block, followups, done).
- `phone-insp.sse`: 187 events (thread, activity, text, block, followups, done).

## live/

`live/fast.sse`, `live/smart.sse`, `live/thinking.sse`: ONE real answer per mode, recorded 2026-10-15 through the real route
against the live Anthropic API (a seeded ticket in the test database; no key or secret in them). `test/ask.contract.test.ts`
checks every event against the contract.
