# 02 — Backend

Scope: `backend/` — Express 4 + Socket.IO 4 server (`server.js`), 11 routers, 7 services, socket layer, 4 configs, Dockerfile.

## Server bootstrap ([`backend/server.js`](../backend/server.js))

- Express + `http.Server` + `socket.io` server.
- CORS allowlist from `CORS_ORIGIN` env (split by comma); falls back to localhost ports 3000/3001/3004/3005 ([`server.js:35-37`](../backend/server.js)).
- Socket.IO uses the same allowlist, `pingTimeout: 60000`, `pingInterval: 25000`, `credentials: true`.
- Middleware order: `helmet` (with `crossOriginResourcePolicy: cross-origin`, `crossOriginEmbedderPolicy: false`) → `cors` → `morgan('combined')` → `express-rate-limit` → JSON / urlencoded body parsers ([`server.js:71-86`](../backend/server.js)).
- **No auth middleware is mounted.** No `passport`, no JWT, no API-key check, no session, nothing.
- Routers mounted under `/api/*`:

  | Mount | File |
  |---|---|
  | `/api/calls` | `routes/calls.js` |
  | `/api/agents` | `routes/agents.js` |
  | `/api/health` (and root `/`) | inline in `server.js` |
  | `/api/webhooks` | `routes/webhooks.js` |
  | `/api/live-calls` | `routes/liveCalls.js` |
  | `/api/admin` | `routes/admin.js` |
  | `/api/mango` | `routes/mango.js` |
  | `/api/callbacks` | `routes/callbacks.js` |
  | `/api/opendental` | `routes/openDental.js` |
  | `/api/opendental-sync` | `routes/openDentalSync.js` |
  | `/api/unified-calls` | `routes/unifiedCalls.js` |
  | `/api/analytics` | `routes/analytics.js` |

- After `unifiedCallStore.initialize()` resolves, `server.listen(PORT)` and three background tasks fire:
  1. `syncScheduler.runRetellSync({ limit: 200 })` immediately, then every `RETELL_SYNC_INTERVAL_MS` (default 15 min) ([`server.js:162-172`](../backend/server.js)).
  2. `syncScheduler.start()` to register the Mango cron ([`server.js:176`](../backend/server.js)).
  3. `setTimeout(10000, …)` to backfill Mango transcriptions ([`server.js:180-184`](../backend/server.js)).
- Central error handler logs full stack to `console` ([`server.js:134-140`](../backend/server.js)) — fine in dev, noisy and PII-leaky in prod logs.

## Routers — surface, auth, validation, issues

Auth is uniformly **None** unless noted; the table calls out validation and concrete defects.

### `/api/calls` — [`routes/calls.js`](../backend/routes/calls.js)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Lists calls; supports `agentId`, `office`, `limit`, etc. Falls back to **fictional mock data** with PII-shaped fields when Retell unreachable ([`calls.js:189-294`](../backend/routes/calls.js)). Mock fallback masks failures from users. |
| GET | `/:id` | **Defect**: references undefined symbol `extractCallerName` at [`calls.js:450`](../backend/routes/calls.js); only `extractCallerNameBasic` and `extractCallerNameAdvanced` are defined in the file. Will throw `ReferenceError` whenever the non-mock Retell branch executes. |
| GET | `/:id/transcript`, `GET /:id/recording` | Pass-through to Retell. |
| POST | `/search` | In-memory filter over Retell list. |
| POST | `/test-patient-lookup` | Debug endpoint exposed in production unless gated externally ([`calls.js:654-658`](../backend/routes/calls.js)). |
| GET | `/patient-suggestions/:query` | Min length 2 ([`calls.js:697-699`](../backend/routes/calls.js)). |

### `/api/agents` — [`routes/agents.js`](../backend/routes/agents.js)

| Method | Path | Notes |
|---|---|---|
| GET | `/` | Lists Retell agents. |
| GET | `/:id` | Single agent. |
| **PATCH** | **`/:id`** | Allowlists fields ([`agents.js:181-195`](../backend/routes/agents.js)) — but writes back to Retell with no auth. **Anyone with network reach can change agent prompts, voice, webhook URLs.** |
| GET | `/:id/phone-numbers` | — |
| POST | `/:id/test` | — |

### `/api/analytics` — [`routes/analytics.js`](../backend/routes/analytics.js)

- `GET /summary` aggregates from `unifiedCallStore`. Days param clamped via `Math.max(1, ...)`.

### `/api/callbacks` — [`routes/callbacks.js`](../backend/routes/callbacks.js)

- CRUD over an **in-memory `callbacks` array** ([`callbacks.js:10-12`](../backend/routes/callbacks.js)) — **all data lost on restart**.
- Emits Socket.IO events through `liveCallManager.io` ([`callbacks.js:134-137`](../backend/routes/callbacks.js)).
- Seeded with sample PII at startup ([`callbacks.js:261-329`](../backend/routes/callbacks.js)).

### `/api/live-calls` — [`routes/liveCalls.js`](../backend/routes/liveCalls.js)

- Reads `liveCallManager.activeCalls`. Static paths registered before dynamic `/:id`, so order is correct.

### `/api/mango` — [`routes/mango.js`](../backend/routes/mango.js)

- `POST /fetch/:mangoCallId` — triggers a Puppeteer login + recording download + Deepgram transcribe + persist. Path param validated as digits only ([`mango.js:20-22`](../backend/routes/mango.js)). **No auth.** A hostile caller can drive scraper load and burn Deepgram credits.

### `/api/opendental` — [`routes/openDental.js`](../backend/routes/openDental.js)

- ~836 lines of routes. Health, sync trigger/status, calendar, appointments, patients, providers, operatories, AI helpers, smart-book, etc. **All unauthenticated.**
- Includes write paths: `POST /appointments` (book), `PUT /appointments/:id`, `PATCH /appointments/:id/status`, `DELETE /appointments/:id` (cancel), `POST /patient` (create patient).
- Several endpoints validate required fields and return 400 (e.g. [`openDental.js:125-130, 204-213, 257-262, 324-334, 402-407, 474-482`](../backend/routes/openDental.js)) — good — but the **whole route group writes to a live PMS with no caller authentication**.

### `/api/opendental-sync` — [`routes/openDentalSync.js`](../backend/routes/openDentalSync.js)

- `POST /calls/:callId/sync` (writes a `commlog` row to OD), `POST /calls/:callId/link`, `DELETE /calls/:callId/link`, `GET /pending-links`, `POST /sync-all`, `POST /match-all` (mutates `unifiedCallStore` for every call).
- Batch endpoints have no rate guard beyond the global `express-rate-limit`.

### `/api/unified-calls` — [`routes/unifiedCalls.js`](../backend/routes/unifiedCalls.js)

- Read endpoints over `unifiedCallStore`.
- `POST /sync-retell` triggers a Retell pull ([`unifiedCalls.js:341-371`](../backend/routes/unifiedCalls.js)) — any client can fire it.
- `PATCH /:id` has a field allowlist ([`unifiedCalls.js:384-401`](../backend/routes/unifiedCalls.js)).

### `/api/webhooks` — [`routes/webhooks.js`](../backend/routes/webhooks.js)

| Method | Path | Notes |
|---|---|---|
| POST | `/retell` | **Has** HMAC verification — but only when `NODE_ENV === 'production'`. In dev/test the verifier returns `true` immediately ([`webhooks.js:21-22`](../backend/routes/webhooks.js)). Signature is computed over `JSON.stringify(req.body)` ([`webhooks.js:30-39`](../backend/routes/webhooks.js)) — see "Webhook signature gotcha" below. |
| GET | `/retell` | Webhook health probe. |
| POST | `/test` | Disabled in production ([`webhooks.js:346-349`](../backend/routes/webhooks.js)). |

**Webhook signature gotcha:** Retell's documented practice is to sign the **raw** request body. Re-serializing `req.body` after `express.json()` parses it can produce a different byte stream (key ordering, whitespace, number formatting). Verification can fail in production for legitimate webhooks, or — worse — pass for unintended payloads. To be safe the route should use a raw body parser scoped to this path and feed the raw `Buffer` to the HMAC.

### `/api/admin` — [`routes/admin.js`](../backend/routes/admin.js)

- High-impact controls — sync start/stop/run, mango download, OD test-connection, queues, costs, errors. **None authenticated.**
- `GET /config` returns the configured `OD_API_URL` and surrounding configuration ([`admin.js:373-406`](../backend/routes/admin.js)) — leaks integration topology to anyone who can reach the box.

## Services

### `services/unifiedCallStore.js`

The most important persistence concern in the system.

- In-memory `Map` of calls plus several indexes; lazy `initialize()` reads `data/unified_calls.json` ([`unifiedCallStore.js:32`](../backend/services/unifiedCallStore.js)).
- Persistence: `await fs.writeFile(this.persistPath, JSON.stringify(...))` ([`unifiedCallStore.js:472-485`](../backend/services/unifiedCallStore.js)).
- **Not atomic.** No write-to-temp-then-rename. A crash mid-write leaves a truncated JSON file; on next boot, `JSON.parse` fails and the catch block silently starts with an empty store ([`unifiedCallStore.js:56-76`](../backend/services/unifiedCallStore.js)) — **all call history can be silently lost**.
- **No mutex.** `persist()` is called from webhooks, sync scheduler, HTTP handlers, and the call analyzer. Concurrent invocations can interleave writes and produce invalid JSON.
- The sole copy of the data lives on the single droplet's disk — see `audit/08-production-readiness.md`.

### `services/liveCallManager.js`

- Singleton; in-memory `Map<callId, callPayload>`.
- Holds a `this.io` reference assigned by the socket layer ([`socketHandler.js:16`](../backend/socket/socketHandler.js)).
- Mutators emit `call:started`, `call:updated`, `call:transcript`, `call:ended`, `live-calls:update` to all connected clients ([`liveCallManager.js:48-50, 83-86, 129-136, 174-176`](../backend/services/liveCallManager.js)).
- Logs caller phone number on call start ([`liveCallManager.js:53`](../backend/services/liveCallManager.js)) — PHI in stdout.
- Restart loses every active-call entry.

### `services/syncScheduler.js`

| Trigger | Source | Effect |
|---|---|---|
| Cron `MANGO_SYNC_SCHEDULE` (default `15 * * * *`) | `start()` reads `mangoConfig.sync.schedule` ([`syncScheduler.js:44-46`](../backend/services/syncScheduler.js); [`config/mango.js:77`](../backend/config/mango.js)) | `runSync()` → Mango Puppeteer scrape → Deepgram transcribe → OpenAI analyze → `unifiedCallStore.addMangoCalls` + `persist` |
| Startup | `server.js:162-164` | `runRetellSync({ limit: 200 })` |
| Every `RETELL_SYNC_INTERVAL_MS` | `server.js:167-172` | `runRetellSync({ limit: 100 })` |
| `setTimeout` 10s post-startup | `server.js:180-184` | `transcribeUntranscribedMango({ maxCalls: 10 })` |

A single `isRunning` flag gates Mango sync ([`syncScheduler.js:66-70`](../backend/services/syncScheduler.js)) but **not the Retell sync interval** — back-to-back Retell pulls can overlap if a previous one is still running. There is also a third periodic sync set up inside [`config/openDental.js:141-152`](../backend/config/openDental.js) — `setInterval` every 3 min calling `performSync()`. Three independent schedulers operate without coordination.

### `services/mangoScraper.js`

- Puppeteer-driven login to `https://admin.mangovoice.com`; downloads MP3s; writes them under `data/recordings/`; saves debug HTML/PNG/JSON in `data/mango_debug/` ([`mangoScraper.js:851-871`](../backend/services/mangoScraper.js)).
- Credentials only via env (`MANGO_USERNAME` / `MANGO_PASSWORD`); throws if missing ([`mangoScraper.js:79-81`](../backend/services/mangoScraper.js)).
- Mango portal hostnames are hardcoded in [`backend/config/mango.js:27-38`](../backend/config/mango.js).
- Single shared browser instance — concurrent calls serialize through it.
- Production risk: any Mango UI change (the docs even say *"may need to adjust CSS selectors in `config/mango.js` based on your portal's UI"* — [`PROGRESS.md:170`](../PROGRESS.md)) breaks the scraper silently.

### `services/transcriptionService.js`

- Deepgram prerecorded API. Reads `DEEPGRAM_API_KEY`. In-memory stats only.

### `services/callAnalyzer.js`

- OpenAI `gpt-3.5-turbo` over transcripts; produces sentiment, summary, emergency flag.
- Logs caller name on success ([`callAnalyzer.js:95`](../backend/services/callAnalyzer.js)) — PHI in stdout.
- `fallbackAnalysis` is heuristic-only; safe to keep as a degraded mode.

### `services/openDentalSync.js`

- Patient match heuristics (phone / name / DOB) and `commlog` write.
- Insert is **parameterized** with `?` placeholders ([`openDentalSync.js:462-464`](../backend/services/openDentalSync.js)); column names come from `SHOW COLUMNS` allowlist (also safe).

## Sockets — [`backend/socket/socketHandler.js`](../backend/socket/socketHandler.js)

- `initializeSocketHandlers(io)` calls `liveCallManager.setSocketIO(io)` so the manager broadcasts on every state change.
- **No connect-time auth.** Any origin permitted by CORS can establish a socket and subscribe to live call streams (which contain caller phone numbers and transcripts).
- Events handled: `live-calls:get`, `call:get`, `call:subscribe`, `call:unsubscribe`, `ping`.
- Emits flowing through this surface: `call:started`, `call:updated`, `call:transcript`, `call:ended`, `live-calls:update`, `callback:created`, `callback:updated`, `callback:deleted`, `callbacks:stats-updated`, `mango:sync-complete`, `call:analyzed`.

## Configs

| File | Notes |
|---|---|
| [`config/retell.js`](../backend/config/retell.js) | Reads `RETELL_API_KEY`; warns and continues if missing ([`retell.js:6-8`](../backend/config/retell.js)). Base URL `https://api.retellai.com`. |
| [`config/mango.js`](../backend/config/mango.js) | Defaults the scraper schedule to `15 * * * *`; throws if `MANGO_USERNAME`/`MANGO_PASSWORD` missing only when used. |
| [`config/openDental.js`](../backend/config/openDental.js) | Picks DB (`OPENDENTAL_DB_URL`) or REST (`OD_API_URL` + keys); **starts a `setInterval` every 3 min on construction** ([`openDental.js:141-152`](../backend/config/openDental.js)) — surprising side-effect for a "config" module. |
| [`config/officeAgents.js`](../backend/config/officeAgents.js) | Static map of office IDs to Retell agent IDs; must be kept in sync with the frontend's office config (drift risk). |

## Dockerfile

- [`backend/Dockerfile`](../backend/Dockerfile): `node:18-alpine`, `npm ci --only=production`, `EXPOSE 5000`.
- `HEALTHCHECK` uses `curl` ([`Dockerfile:18-19`](../backend/Dockerfile)) — **alpine has no `curl` by default**, so the healthcheck silently fails unless `apk add --no-cache curl` is added. (See `audit/09-deploy-ops.md`.)

## Cross-cutting backend findings

| Area | Finding |
|---|---|
| Auth | None on REST or Socket.IO; only `express-rate-limit` and Helmet stand between the internet and write endpoints. |
| Persistence | Single JSON file, non-atomic writes, no lock, no backup. |
| Scheduling | Three independent timers (Retell `setInterval`, Mango cron, OD config `setInterval`) with no global coordinator and no overlap protection between Retell pulls. |
| Logging | `morgan('combined')` plus per-handler `console.log` of phone numbers and patient names — PHI in stdout. |
| Error handling | Central handler logs stacks; many handlers swallow into 500s with raw error messages. |
| Validation | Most write endpoints validate required fields but few reject extra/unexpected fields; PATCH endpoints use allowlists (good). |
| Webhook signing | Skipped in non-production; in production, computed over re-serialized JSON which can mismatch Retell's raw-body signature. |
| Admin surface | Open in production — anyone reaching `/api/admin/*` can start/stop sync, fetch costs, trigger downloads, fetch config. |
| Defects | `extractCallerName` ReferenceError in [`calls.js:450`](../backend/routes/calls.js); broken Docker healthcheck. |

## Recommended remediations (proposals only)

1. Add a **single auth layer** for `/api/*` — at minimum a shared bearer token validated by middleware mounted before all routers in [`server.js`](../backend/server.js). Carve out `/api/webhooks/retell` for HMAC, `/api/health` for unauth, and require token everywhere else.
2. Webhook hardening: switch to `express.raw({type:'application/json'})` scoped to `/api/webhooks/retell`, verify HMAC against the raw `Buffer`, and **never** skip verification on env (replace the `NODE_ENV !== 'production'` short-circuit with a default-deny). 
3. Atomic writes for `unifiedCallStore`: write to `unified_calls.json.tmp`, `fs.rename` over the target, take a `proper-lockfile` (or in-process mutex) around `persist()` calls.
4. Move callbacks out of the in-memory array — put them in the same JSON store or a SQLite file so restarts don't lose data.
5. Fix the `extractCallerName` ReferenceError in [`calls.js:450`](../backend/routes/calls.js) and add a smoke test to prevent regression.
6. Remove the 3-minute `setInterval` from [`config/openDental.js`](../backend/config/openDental.js) and centralize all sync timers in `syncScheduler` with `isRunning`-style overlap guards on every pipeline.
7. Add `apk add --no-cache curl` (or switch to a `node` HTTP probe) in [`backend/Dockerfile`](../backend/Dockerfile) to make the healthcheck functional.
8. Strip PHI from `console.log` calls — phone numbers, names. Send through a logger that scrubs configured fields.
