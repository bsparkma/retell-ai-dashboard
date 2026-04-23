# 05 — Integrations

External services the system depends on, where they are wired, and what could go wrong.

## Integrations at a glance

| Integration | Direction | Where wired | Credentials | Status |
|---|---|---|---|---|
| **Retell AI** (HTTP + webhook) | Both | [`backend/config/retell.js`](../backend/config/retell.js) (axios), [`backend/routes/webhooks.js`](../backend/routes/webhooks.js) (inbound webhook), [`backend/services/syncScheduler.js`](../backend/services/syncScheduler.js) (poll) | `RETELL_API_KEY` env | Active |
| **Open Dental — direct DB** | Read/write | [`backend/config/openDental.js`](../backend/config/openDental.js) via `mysql2` | `OPENDENTAL_DB_URL` | Active |
| **Open Dental — REST** | Read/write | Same config; axios with bearer | `OD_API_URL` (or `OPENDENTAL_API_BASE_URL`) + (`OD_API_KEY` or `OPENDENTAL_DEVELOPER_KEY`+`OPENDENTAL_CUSTOMER_KEY`) | Active (depending on deployment) |
| **Mango Voice** | Inbound (scrape) | [`backend/services/mangoScraper.js`](../backend/services/mangoScraper.js) | `MANGO_USERNAME`, `MANGO_PASSWORD` env | Active, fragile |
| **Deepgram** | Outbound | [`backend/services/transcriptionService.js`](../backend/services/transcriptionService.js) | `DEEPGRAM_API_KEY` | Active |
| **OpenAI** | Outbound | [`backend/services/callAnalyzer.js`](../backend/services/callAnalyzer.js) (`gpt-3.5-turbo`) | `OPENAI_API_KEY` | Active |
| **Cloudflared tunnel** | Inbound traffic | [`cloudflared-config.yml`](../cloudflared-config.yml) | Tunnel cert | Active (`carein-do.flamingketchup.com` → `localhost:5000`) |
| **`od-microservice/`** | — | Standalone Express app | `OD_API_URL`, `OD_API_KEY` for itself | **Orphan** — no caller in `backend/` or `frontend/` |
| **`mcp/retell_mcp.py`** | — | Standalone Python MCP server | `RETELL_API_KEY` ([`mcp/retell_mcp.py:11-13, 44-51`](../mcp/retell_mcp.py)) | Standalone (Claude Desktop helper); not part of the dashboard runtime |

## Retell AI

### Outbound (poll + per-call queries)
- [`backend/config/retell.js`](../backend/config/retell.js) creates an axios instance with `Authorization: Bearer ${RETELL_API_KEY}` against `https://api.retellai.com`. It warns and continues if the key is missing ([`retell.js:6-14`](../backend/config/retell.js)).
- `syncScheduler.runRetellSync({ limit })` fetches lists of recent calls and feeds them into `unifiedCallStore.addRetellCall` + `persist` ([`syncScheduler.js:213-238`](../backend/services/syncScheduler.js)).
- Call detail / transcript / recording fetches are pass-through from `routes/calls.js`.
- `routes/agents.js` reads and **writes** Retell agents via `PATCH /api/agents/:id` (no caller auth).

### Inbound webhook
- [`backend/routes/webhooks.js`](../backend/routes/webhooks.js) `POST /api/webhooks/retell` is the only signed endpoint.
- Signature is HMAC-SHA256 over `JSON.stringify(req.body)` using `RETELL_API_KEY`, compared with `timingSafeEqual` ([`webhooks.js:30-39`](../backend/routes/webhooks.js)).
- **Verification is skipped when `NODE_ENV !== 'production'`** ([`webhooks.js:21-22`](../backend/routes/webhooks.js)) — anything that hits this URL on a dev/staging host is accepted.
- Webhook body is fed to `liveCallManager`, `unifiedCallStore`, and `openDentalSyncService`.
- **Risk**: signing the re-serialized JSON body almost certainly **does not match** Retell's signature over the raw bytes (key ordering, numeric formatting, whitespace). The verification, when active, may reject good calls and may also pass payloads with whitespace/key differences. The route should switch to a raw body parser scoped to this path.

### Open questions
- Are webhook URLs configured in the Retell dashboard pointing at the cloudflared tunnel (`carein-do.flamingketchup.com/api/webhooks/retell`) or directly at the droplet IP? ([`PROGRESS.md:167-168`](../PROGRESS.md) tells operators to set "your-domain.com" without specifying.) Should be documented.

## Open Dental

There are **three** competing surfaces that talk to Open Dental in this repo:

1. The big surface in [`backend/routes/openDental.js`](../backend/routes/openDental.js) (~836 lines) — used by both frontends.
2. [`backend/config/openDental.js`](../backend/config/openDental.js) — picks DB or REST mode based on env, runs its own 3-minute sync interval ([`openDental.js:141-152`](../backend/config/openDental.js)).
3. [`od-microservice/src/`](../od-microservice/src/) — a tiny Express app exposing `/od/slots` and `/od/book` ([`od-microservice/src/index.ts:9-33`](../od-microservice/src/index.ts)) — **no consumer in `backend/`, no consumer in either frontend**. Confirmed dead code.

### Direct DB mode
- `mysql2` pool against `OPENDENTAL_DB_URL`. Inserts use parameterized queries ([`backend/services/openDentalSync.js:462-464`](../backend/services/openDentalSync.js)). Column names come from `SHOW COLUMNS` allowlists rather than from user input. SQL-injection surface is minimal in the code reviewed.
- `commlog` writes happen here. **There is no auth check** — anyone hitting `POST /api/opendental-sync/calls/:id/sync` can append a row to a real PMS database.

### REST mode
- Axios client with bearer header configured in [`backend/config/openDental.js:41-47`](../backend/config/openDental.js).
- The REST endpoints used are documented in [`docs/api-appointments.md`](../docs/api-appointments.md), [`docs/api-patients.md`](../docs/api-patients.md), [`docs/api-providers.md`](../docs/api-providers.md), [`docs/api-operatories.md`](../docs/api-operatories.md), [`docs/api-clinics.md`](../docs/api-clinics.md), [`docs/api-appointment-types.md`](../docs/api-appointment-types.md), [`docs/api-appt-fields.md`](../docs/api-appt-fields.md), [`docs/api-appt-field-defs.md`](../docs/api-appt-field-defs.md), [`docs/api-definitions.md`](../docs/api-definitions.md), [`docs/api-events.md`](../docs/api-events.md), [`docs/api-schedules.md`](../docs/api-schedules.md), [`docs/api-schedule-ops.md`](../docs/api-schedule-ops.md), [`docs/api-subscriptions.md`](../docs/api-subscriptions.md).

### Backend spec gap
[`docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md`](../docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md) defines a fuller contract. The implemented routes cover Health, `/calendar`, `/appointments/range`, sync status/trigger. The spec lists these as **to be added**:

- `GET /clinics`
- `GET /operatories` (standalone; currently only inside `/calendar`)
- `GET /providers` (standalone; currently only inside `/calendar`)
- `GET /appointmenttypes`
- `GET /apptfielddefs`
- `GET /schedules`
- `GET /scheduleops`
- `GET /appointments/asap`
- `GET /appointments/slots`
- `GET /appointments/:id`
- `GET /appointments/:id/fields`, `PUT /appointments/:id/fields`
- (Phase 4) Webhook receivers for OD subscriptions

The new-dashboard calendar already has UI surfaces for Schedules/ScheduleOps overlays and ASAP/Unscheduled/Slots tabs — they render empty until the backend ships these endpoints.

### Slots discrepancy
- Backend has `POST /api/opendental/appointments/find-slots` (used by `new-dashboard`'s Open Slots tab via `findAvailableSlots`).
- The spec [`docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md:284`](../docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md) calls out this method/path mismatch as an unresolved item.

## Mango Voice (scraping)

- Puppeteer-based — no API exists for Mango call data. Hardcoded portal URLs (`https://admin.mangovoice.com`, `https://app.mangovoice.com/...`) in [`backend/config/mango.js:27-38`](../backend/config/mango.js).
- Credentials only via `MANGO_USERNAME`/`MANGO_PASSWORD`; `mangoScraper` throws if missing ([`mangoScraper.js:79-81`](../backend/services/mangoScraper.js)).
- Cron schedule from `MANGO_SYNC_SCHEDULE` (default `15 * * * *`, [`config/mango.js:77`](../backend/config/mango.js)).
- Single shared browser instance; `isRunning` flag in `syncScheduler` prevents overlapping syncs ([`syncScheduler.js:66-70`](../backend/services/syncScheduler.js)).
- Saves debug HTML/PNG/JSON under `data/mango_debug/` ([`mangoScraper.js:851-871`](../backend/services/mangoScraper.js)) — useful for troubleshooting, but accumulates without rotation.
- **Operational fragility**: any Mango portal UI change (selector rename, route change, new MFA prompt) breaks the scraper. The repo's own [`PROGRESS.md:170`](../PROGRESS.md) admits *"may need to adjust CSS selectors in `config/mango.js` based on your portal's UI"*.

## Deepgram + OpenAI

- Deepgram prerecorded transcription — invoked by `transcriptionService.transcribeFile`. Only logs the basename ([`transcriptionService.js:59`](../backend/services/transcriptionService.js)) — minimal PHI in logs from this path.
- OpenAI: `gpt-3.5-turbo` for summary/sentiment/emergency detection. The prompt embeds transcript text and the caller phone number ([`callAnalyzer.js:107-115`](../backend/services/callAnalyzer.js)). The success log includes the extracted caller name ([`callAnalyzer.js:95`](../backend/services/callAnalyzer.js)) — PHI in stdout.
- **PHI flowing to OpenAI** is itself a HIPAA review item — there is no Business Associate Agreement (BAA) language anywhere in the repo. (See `audit/07-security.md`.)

## Sequenced flows (where the integrations meet)

(Detailed Mermaid diagrams live in `audit/06-data-flow.md`.)

- **Inbound Retell call**: Retell webhook → `liveCallManager` → Socket.IO → legacy `/live` page (no equivalent in new-dashboard).
- **Background Retell pull**: every 15 min, `runRetellSync` lists Retell calls and persists summaries.
- **Mango pipeline (cron)**: scrape list → for each new call, download MP3 → Deepgram → OpenAI analyze → persist + emit `mango:sync-complete`.
- **OD calendar read**: frontend → `GET /api/opendental/calendar` → `mysql2` or REST → response shaped per `docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md §3.1`.
- **OD appointment booking** (legacy only): `AppointmentBookingDialog` → `POST /api/opendental/appointments/check-conflicts` → `POST /api/opendental/appointments`.

## `od-microservice/` — verdict

- Two endpoints (`/od/slots`, `/od/book`) duplicating slot-find and booking that already exist in `backend/routes/openDental.js`.
- Has both `.ts` source and apparently committed `.js` siblings.
- `package.json` has `"build": "tsc"` but no `tsconfig.json` exists in the directory — build is broken.
- No `import`, `require`, `fetch`, or env var anywhere in `backend/` or either frontend points at it.
- **Recommendation**: delete this directory. Its presence implies a second booking implementation, which is dangerous if anyone wires it up later.

## `mcp/retell_mcp.py` — verdict

- Python FastMCP server exposing Retell tools to Claude Desktop ([`mcp/retell_mcp.py:36-55`](../mcp/retell_mcp.py)).
- Not referenced in root `package.json`, `ecosystem.config.js`, Dockerfiles, or any backend code.
- Standalone helper for an external AI client; safe to keep but unrelated to the dashboard runtime.
- **Recommendation**: move to its own repo (or `tools/` subdir) and add a one-line README explaining what it is, so audit readers don't waste time wondering whether it's load-bearing.

## Notable integration risks (ranked)

| # | Severity | Risk |
|---|---|---|
| 1 | High | Mango scraper is the only route to staff-call data; no API alternative; portal changes break silently. There is no monitor that pages someone when the scraper produces zero new calls for N intervals. |
| 2 | High | `POST /api/opendental/*` write endpoints are unauthenticated and can mutate a live PMS — see `audit/07-security.md`. |
| 3 | High | OpenAI/Deepgram receive PHI; no BAA language in the repo; no per-tenant data residency or scrubbing. |
| 4 | Med | Three competing OD surfaces (`backend/config/openDental.js` setInterval, `syncScheduler` jobs, `od-microservice`). No global owner of "the OD pipeline." |
| 5 | Med | Retell webhook signature verification is dev-skipped and computed over the parsed body, not the raw bytes. |
| 6 | Med | `/api/agents` PATCH writes Retell agent config (prompts, voice, webhook URLs) without auth — credential or prompt theft surface. |
| 7 | Low | Cloudflared tunnel only fronts the backend on `:5000`; neither frontend is reachable through the tunnel. The legacy frontend is exposed via the droplet IP only (per [`README.md`](../README.md) and [`notes`](../notes)). |
