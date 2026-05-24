# Changelog — new-dashboard

## [Unreleased] — 2026-05-23

### Added

#### Server-side (`server/lib/`)
- **`types.ts`** — Canonical `Call` record, `RetellWebhookPayload`,
  `OpenDentalCommlogWriter` interface, `AnalyticsResult`, `CallFilters`,
  `CommlogStatus` types.
- **`ingestion.ts`** — Pure ingestion pipeline: `validateWebhookPayload`,
  `normalizeRetellCall`, `ingestRetellWebhook`. Includes office mapping from
  DNIS, tag/outcome/routing derivation, name extraction, quality scoring.
- **`commlog.ts`** — `OpenDentalCommlogWriter` interface + `MockCommlogWriter`
  (configurable success/failure/network_error behaviors per call ID).
  `createCommlogWriter()` factory always returns mock (no live credentials).
- **`analytics.ts`** — Pure aggregation functions: `countByTag`, `countByOutcome`,
  `countByOffice`, `sentimentDistribution`, `dailyVolume`, `avgQualityScore`,
  `commlogStats`, `filterCalls`, `computeAnalytics`.
- **`store.ts`** — In-memory JSON call store with async file persistence to
  `data/calls.json`. `loadStore`, `seedStore`, `queryCalls`, `insertCall`,
  `updateCall`, `upsertCall`, `getOffices`, `getTags`.
- **`seed.ts`** — 15 synthetic fixture calls across 4 offices (Downtown Dental,
  Scottsdale North, Mesa East, Surprise West) with varied tags, commlog
  statuses, and sentiments. No real PHI.

#### Server routes (`server/index.ts`)
- `POST /api/webhook/retell` — Retell call-ended webhook ingestion with
  validation, deduplication, async commlog write.
- `GET  /api/calls` — List calls with filters (office, date range, tag,
  outcome, commlog_status, search), pagination. Returns offices + tags for
  filter dropdowns.
- `GET  /api/calls/:id` — Single call detail.
- `POST /api/calls/:id/retry-commlog` — Retry commlog write for failed/pending.
- `GET  /api/analytics/calls` — Full analytics aggregation (by tag, outcome,
  office, daily volume, sentiment, commlog stats, quality score).
- `GET  /api/calls/meta` — Available offices + tags for filter UIs.
- `POST /api/dev/seed` — Reset to seed data (dev only).

#### Client (`client/src/`)
- **`lib/api.ts`** additions: `careInApi` client with `getCalls`, `getCall`,
  `retryCommlog`, `getAnalytics` methods. `CareInCall`, `CareInAnalytics`,
  `CareInCommlogStatus`, `CareInSentiment` types.
- **`pages/CareInCallDetail.tsx`** — New detail page at `/carein-calls/:id`.
  Shows: caller, office, tag, routing, AI summary, transcript, sentiment,
  quality score (0–100), commlog status card with retry button.
- **`pages/Calls.tsx`** additions: "CareIN Log" third tab with office filter,
  commlog status filter, tag filter, search, and per-row sentiment + commlog
  badge. Loading/empty/error states.
- **`pages/Analytics.tsx`** additions: `CareInAnalyticsSection` component with
  KPIs (total, quality, duration, offices), commlog status breakdown (written/
  pending/failed), calls-by-office bar chart, top call types list.
- **`App.tsx`**: Added `/carein-calls/:id` route.

#### Tests (`tests/`)
- **`tests/ingestion.test.ts`** — 59 tests covering all ingestion functions,
  validation paths, field derivations, error cases.
- **`tests/analytics.test.ts`** — 51 tests covering all aggregation functions,
  filter logic, edge cases (empty arrays, boundary dates, etc.).
- **`tests/commlog.test.ts`** — 11 tests covering MockCommlogWriter behaviors,
  overrides, delay simulation, createCommlogWriter factory.
- **`tests/fixture-ingestion.test.ts`** — 15 regression tests against committed
  fixture payload (`tests/fixtures/retell-webhook-call-ended.json`).
- **`vitest.config.ts`** — Test config with v8 coverage on core modules.
- `package.json`: Added `test` and `test:coverage` scripts.

### Changed
- **`server/index.ts`** — Extended from a 33-line static file server to a full
  Express API server with all CareIN routes. Static serving behaviour preserved.
- **`package.json`** — Added `@vitest/coverage-v8@2.1.9` devDependency, `test`
  and `test:coverage` scripts.

### Not Changed
- All existing client pages (Dashboard, Admin, AgentBuilder, Scheduling,
  Calendar, Callbacks) — untouched.
- All existing API methods in `api.ts` — untouched.
- The real backend at port 5000 — untouched.
- `vite.config.ts`, `tsconfig.json`, UI components, features, hooks, contexts.
