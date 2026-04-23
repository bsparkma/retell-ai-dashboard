# 03 — Frontend (legacy `frontend/`)

CRA + React 18 + MUI 5. This is the **only frontend currently in production** (per [`README.md`](../README.md) and [`cloudflared-config.yml`](../cloudflared-config.yml)).

## Build & runtime

| Aspect | Value |
|---|---|
| Build tool | Create React App / `react-scripts 5` |
| React | 18.2 |
| UI kit | `@mui/material 5`, `@mui/x-data-grid`, `@mui/x-date-pickers` |
| Calendar | FullCalendar (`@fullcalendar/react` + `resource-time-grid` + `interaction`) |
| Routing | `react-router-dom 6` |
| HTTP | `axios` (instance in `services/api.js`) |
| Realtime | `socket.io-client 4` via `contexts/SocketContext.js` |
| Charts | `recharts` |
| Date libs | `date-fns 2.29` directly + `moment` transitively (via `@mui/x-date-pickers`) — both ship in the bundle |
| API base | `REACT_APP_API_URL` or `http://localhost:5000/api` ([`config/env.js:1-4`](../frontend/src/config/env.js)) |
| Dev proxy | `"proxy": "http://localhost:5000"` in [`frontend/package.json:51`](../frontend/package.json) |
| Docker | Multi-stage Node 18 build → `nginx:alpine` on port **3000**; nginx proxies `/api/` to `http://backend-dev:5000/api/` ([`frontend/nginx.conf:26-33`](../frontend/nginx.conf)) |
| Auth | **None.** Axios interceptor has a placeholder for a token but never sets one ([`services/api.js:12-16`](../frontend/src/services/api.js)). |

## Routes ([`src/App.js:43-51`](../frontend/src/App.js))

| Path | Component | Notes |
|---|---|---|
| `/` | `Dashboard.js` | Unified call list, stats, filters, drawer detail |
| `/live` | `LiveMonitor.js` | Active calls via Socket.IO |
| `/calendar` | `Calendar.js` | OD calendar wrapper |
| `/calls/:id` | `CallDetails.js` | Full call view |
| `/agents` | `Agents.js` | Retell agent management |
| `/analytics` | `Analytics.js` | **Mock data only** — no API calls |
| `/callbacks` | `Callbacks.js` | Callback queue |
| `/admin` | `Admin.js` | Sync controls, costs, errors |

**Broken navigation defects:**
- `CallDetails.js` calls `navigate('/dashboard')` for "not found" and back-button ([`CallDetails.js:356, 737`](../frontend/src/pages/CallDetails.js)) — there is no `/dashboard` route, only `/`.
- `PatientCallHistory.js:323` navigates to `/patients/:id/calls` — also undefined in `App.js`.

## Pages — concrete behavior

### `Dashboard.js`
- Always uses unified API (the legacy/unified toggle is dead — no UI exposes it).
- Endpoints: `GET /api/unified-calls`, `GET /api/agents`.
- On fetch failure, **silently falls back to large inline mock calls** ([`Dashboard.js:255-259`](../frontend/src/pages/Dashboard.js)) with example.com recording URLs. Users cannot tell real data from fallback.
- Uses `Math.random` to fake hourly activity for the chart ([`Dashboard.js:281-294`](../frontend/src/pages/Dashboard.js)).
- Imports unused MUI `Container`.

### `CallDetails.js`
- Endpoints: `GET /api/unified-calls/:id`, `GET /api/calls/:id` (+ `/transcript`, `/recording` fallback), `GET /api/opendental-sync/calls/:id/status`, `POST /api/opendental-sync/calls/:id/sync`, `POST /api/mango/fetch/:mangoCallId`.
- OD sync status failure swallowed via `console.log` only ([`CallDetails.js:86-88`](../frontend/src/pages/CallDetails.js)) — UI shows nothing wrong.
- Hosts `PatientLinkDialog`.

### `Calendar.js`
- Endpoints: `GET /api/opendental/calendar?date=`, `GET /api/opendental/appointments/range?startDate=&endDate=`.
- Error UI mentions `OPENDENTAL_DB_URL` (a backend env var) directly in the user-facing copy ([`Calendar.js:211-213`](../frontend/src/pages/Calendar.js)) — internal detail leakage to end users.

### `Agents.js`
- Endpoints: `GET /api/agents`, `PATCH /api/agents/:id`.
- Stats are **mock** (`generateMockStats`, [`Agents.js:115-127`](../frontend/src/pages/Agents.js)). "Test agent" button is a `setTimeout` simulation ([`Agents.js:309-316`](../frontend/src/pages/Agents.js)) — no actual call is placed.
- Falls back to mock agents on error ([`Agents.js:105-109`](../frontend/src/pages/Agents.js)).

### `Analytics.js`
- **Has no API integration.** Comment at [`Analytics.js:52`](../frontend/src/pages/Analytics.js) shows `callsApi` is intentionally not wired. Charts/CSV come from `generateMockAnalytics`. PDF export is an `alert()` placeholder.

### `LiveMonitor.js`
- Lists active calls from the `useLiveCalls` hook (which talks Socket.IO).
- No REST involvement for the list itself.

### `Admin.js`
- Endpoints (via raw `fetch`, not the axios `api`): `GET /api/admin/health`, `GET /api/admin/sync-status`, `GET /api/admin/costs`, `GET /api/admin/sync/history`, `GET /api/admin/errors`, `POST /api/admin/sync/start`, `POST /api/admin/sync/stop`, `POST /api/admin/sync/run`, `POST /api/admin/test-connection`.
- **No `response.ok` checks** anywhere — non-2xx responses can throw or silently produce misleading state.

### `Callbacks.js`
- Endpoints: `GET /api/callbacks?status=`, `GET /api/callbacks/stats`, `POST /api/callbacks/:id/attempt`.
- Subscribes to `callback:created`, `callback:updated`, `callback:deleted`, `callbacks:stats-updated` ([`Callbacks.js:265-280`](../frontend/src/pages/Callbacks.js)).

## Components

| Path | Notes |
|---|---|
| [`Header.js`](../frontend/src/components/Header.js) | App name, dark-mode toggle, `NotificationCenter`, placeholder avatar — no auth surface |
| [`Sidebar.js`](../frontend/src/components/Sidebar.js) | Navigation. **Bug**: `useLiveCalls()` is called inside a `try/catch` block ([`Sidebar.js:56-64`](../frontend/src/components/Sidebar.js)) — this **violates the Rules of Hooks** and is a real source of subtle React errors. Settings row has no `onClick`. |
| [`OpenDentalCalendar.js`](../frontend/src/components/OpenDentalCalendar.js) | FullCalendar `resourceTimeGrid` with provider/operatory view modes; refresh interval; sync trigger; opens `AppointmentBookingDialog`. Logs at lines 167–185. |
| [`AppointmentBookingDialog.js`](../frontend/src/components/AppointmentBookingDialog.js) | Multi-step booking; calls `POST /api/opendental/appointments/check-conflicts` then `POST /api/opendental/appointments` to write into Open Dental ([`AppointmentBookingDialog.js:198-234`](../frontend/src/components/AppointmentBookingDialog.js)). |
| `LiveCalls/` | Cards, transcript panel, sentiment gauge — presentational |
| `OpenDental/PatientLinkDialog.js` | Patient search + link |
| `OpenDental/PatientCallHistory.js` | Lists prior calls; broken `/patients/:id/calls` navigation (see Routes) |
| `OpenDental/SyncStatusBadge.js` | Sync indicator |
| `Transcript/AudioSyncPlayer.js`, `ChatBubbleTranscript.js` | Audio + transcript UI |
| `common/Breadcrumbs.js`, `FloatingActionMenu.js`, `NotificationCenter.js`, `FilterBar.js`, `ChartBlocks.js`, `SkeletonLoaders.js` | FAB downloads a fake CSV; notifications come from a mock interval (`NotificationContext.js`) |

## API client — [`services/api.js`](../frontend/src/services/api.js)

The file exports a comprehensive set of API surfaces:
- `callsApi`, `unifiedCallsApi`, `agentsApi`, `healthApi`, `mangoApi`, `openDentalApi`, `openDentalSyncApi`.
- ~85 named methods total.
- A response interceptor logs every error via `console.error` then rethrows ([`services/api.js:23-29`](../frontend/src/services/api.js)).

**Dead surface:** ~half of the methods are never imported elsewhere in `frontend/src` — examples: `healthApi`, `unifiedCallsApi.getStats` and `searchCalls` and `syncRetell`, most of `openDentalApi.smartBook`, `ai.smartBook`, `ai.verifyAppointment`, `ai.getScheduleOverview`, `isOpenDentalEnabled`. The file is kept far ahead of actual UI consumption — fine, but worth pruning when confidence is low about which calls are tested.

## API consumption (what this app actually hits)

```
GET  /api/unified-calls
GET  /api/unified-calls/:id
GET  /api/calls           (legacy fallback)
GET  /api/calls/:id
GET  /api/calls/:id/transcript
GET  /api/calls/:id/recording
GET  /api/agents
PATCH /api/agents/:id
POST /api/mango/fetch/:mangoCallId
GET  /api/opendental/calendar
GET  /api/opendental/appointments/range
GET  /api/opendental/providers
GET  /api/opendental/sync/status
POST /api/opendental/sync/trigger
GET  /api/opendental/patients/search
POST /api/opendental/appointments/check-conflicts
POST /api/opendental/appointments
GET  /api/opendental-sync/calls/:id/status
POST /api/opendental-sync/calls/:id/sync
GET  /api/opendental-sync/patients/search
POST /api/opendental-sync/calls/:id/link
GET  /api/opendental-sync/patients/:id/calls
GET  /api/admin/health, /sync-status, /costs, /sync/history, /errors
POST /api/admin/sync/start, /stop, /run, /test-connection
GET  /api/callbacks, /callbacks/stats
POST /api/callbacks/:id/attempt
```

Socket.IO events consumed: `live-calls:update`, `call:started`, `call:updated`, `call:ended`, `callback:*`, `callbacks:stats-updated`.

## Notable issues

| # | Severity | Item | Evidence |
|---|---|---|---|
| 1 | Bug (High) | Rules-of-Hooks violation — `useLiveCalls()` inside `try/catch` | [`Sidebar.js:56-64`](../frontend/src/components/Sidebar.js) |
| 2 | Bug (High) | `navigate('/dashboard')` to a non-existent route | [`CallDetails.js:356, 737`](../frontend/src/pages/CallDetails.js) |
| 3 | Bug (Med) | `navigate('/patients/:id/calls')` to a non-existent route | [`PatientCallHistory.js:323`](../frontend/src/components/OpenDental/PatientCallHistory.js) |
| 4 | UX (High) | Fetch failures fall back to fictional mock data — users believe it's real | [`Dashboard.js:255-259`](../frontend/src/pages/Dashboard.js); [`Agents.js:105-109`](../frontend/src/pages/Agents.js) |
| 5 | UX (Med) | Analytics page is **entirely mock** | [`Analytics.js:52`](../frontend/src/pages/Analytics.js) |
| 6 | UX (Med) | "Test agent" is fake (`setTimeout`) | [`Agents.js:309-316`](../frontend/src/pages/Agents.js) |
| 7 | Robustness (Med) | Admin uses raw `fetch` with no `response.ok` checks | [`Admin.js`](../frontend/src/pages/Admin.js) |
| 8 | UX (Low) | Error copy mentions backend env var name to end users | [`Calendar.js:211-213`](../frontend/src/pages/Calendar.js) |
| 9 | Perf (Med) | Two date libraries (`date-fns` + transitive `moment`) ship in the bundle | [`frontend/package.json`](../frontend/package.json) + lockfile |
| 10 | Code health (Low) | ~half of `services/api.js` methods are unreferenced from `src` | [`services/api.js`](../frontend/src/services/api.js) |
| 11 | Logging (Low) | Many `console.log`/`console.error`/`console.warn` reach production | `SocketContext.js`, `OpenDentalCalendar.js`, etc. |
| 12 | A11y (Low) | Emojis embedded in page titles can be noisy for screen readers | [`Calendar.js:184`](../frontend/src/pages/Calendar.js); [`LiveMonitor.js:130`](../frontend/src/pages/LiveMonitor.js) |

## What's load-bearing

If `new-dashboard/` were deleted today, the only working UI for these flows would still be `frontend/`:
- Live call monitoring (`/live` + `LiveMonitor`)
- Callback queue (`/callbacks`)
- AppointmentBookingDialog (the only place in the repo where booking actually writes back to OD)
- LiveCalls + transcript components
- The Mango "fetch this call's recording on demand" button on `CallDetails`

These features have **no equivalent** in `new-dashboard/` (see `audit/04-frontend-new.md`).

## Recommended changes (proposals only)

1. Fix the Rules-of-Hooks violation in `Sidebar.js` and the two broken `navigate()` calls — these are hour-long fixes that prevent real failures.
2. Replace the silent mock-data fallbacks with explicit error states. If the backend is unreachable, say so; do not surface invented patient names.
3. Either wire `Analytics.js` to `/api/analytics/summary` (which exists) or hide the page until it's real.
4. Replace the "Test agent" simulated handler with a real Retell test call, or remove the button.
5. Add `response.ok` checks to all `Admin.js` `fetch` calls and surface failures.
6. Move `console.log`/`console.error` behind a single logger that respects `NODE_ENV` so production builds don't flood the browser console.
7. Consider whether the legacy `frontend/` is worth maintaining at all — `audit/04-frontend-new.md` and `audit/01-architecture.md` discuss the migration question.
