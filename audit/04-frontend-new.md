# 04 — Frontend (`new-dashboard/`)

Vite + React 19 + shadcn/ui + Tailwind 4 + wouter. Intended as a rewrite of the legacy `frontend/`. Currently **local-dev only** — not deployed and not reachable through the cloudflared tunnel.

## Build & runtime

| Aspect | Value |
|---|---|
| Bundler | Vite 7 (root `client/`, output `dist/public`, dev port **3005**) ([`vite.config.ts:17-25`](../new-dashboard/vite.config.ts)) |
| React | 19.2 |
| UI | shadcn/ui ("new-york" style, CSS variables) on Tailwind 4 ([`components.json:1-18`](../new-dashboard/components.json)) |
| Routing | `wouter 3.7.1` with a **pnpm patch** that exposes `window.__WOUTER_ROUTES__` ([`new-dashboard/patches/wouter@3.7.1.patch`](../new-dashboard/patches/wouter@3.7.1.patch)) |
| State | Local React state; calendar uses `useReducer` + Context ([`features/calendar/store/CalendarContext.tsx:13-21`](../new-dashboard/client/src/features/calendar/store/CalendarContext.tsx)) — no Zustand, no React Query |
| HTTP | `fetch` wrapper in [`client/src/lib/api.ts`](../new-dashboard/client/src/lib/api.ts) (axios is in deps but unused) |
| Aliases | `@/*` → `client/src`, `@shared/*` → `shared` ([`tsconfig.json:18-20`](../new-dashboard/tsconfig.json)) |
| TS | Strict, `noEmit` (Vite handles transpile) |
| Server | [`server/index.ts`](../new-dashboard/server/index.ts) — Express that **only serves static files + SPA fallback**; no API proxy, no socket server |
| Production server expected by PM2 | `node_modules/.bin/next start` ([`ecosystem.config.js:24`](../ecosystem.config.js)) — **but this is a Vite app, not Next.js** ⚠️ |
| API base | `VITE_API_URL` or default `http://localhost:5000/api` ([`lib/api.ts:6-27`](../new-dashboard/client/src/lib/api.ts)). [`new-dashboard/.env.example`](../new-dashboard/.env.example) suggests `5001` (port mismatch) |
| Auth | None |
| Socket.IO | `socket.io-client` is a dep but **not imported anywhere in `client/src`** |

## Routes ([`client/src/App.tsx:19-28`](../new-dashboard/client/src/App.tsx))

| Path | Component | Implementation status | Data source |
|---|---|---|---|
| `/` | `Dashboard` | ~85% — stats, hourly chart, recent calls, callbacks, today's schedule | `getCallbacks`, `getUnifiedCalls`, `getAnalyticsSummary`, `getOpenDentalCalendar` |
| `/calls` | `Calls` | ~85% — call log + callbacks tabs, sync Retell | `getUnifiedCalls`, `getCallbacks` |
| `/calls/:id` | `CallDetail` | ~80% — transcript, audio, analysis | `getUnifiedCall` |
| `/agents` | `AgentBuilder` | ~70% — UI for prompts/KB only; **persists to `localStorage`**, no backend write ([`AgentBuilder.tsx:191-300`](../new-dashboard/client/src/pages/AgentBuilder.tsx)) |
| `/scheduling` | `Scheduling` | Rules tab ~40% (toast-only "save"); Calendar tab ~75% (day grid + Open Slots) ([`Scheduling.tsx:146-283, 292-379`](../new-dashboard/client/src/pages/Scheduling.tsx)) |
| `/analytics` | `Analytics` | ~85% — real `/api/analytics/summary` |
| `/admin` | `Admin` | ~75% — integrations + settings real; Users tab is a placeholder ([`Admin.tsx:310-318`](../new-dashboard/client/src/pages/Admin.tsx)) |
| `/404` and default | `NotFound` | OK |

**Page files that exist but are NOT in the router:**
- `pages/Home.tsx` — boilerplate "Example Page" ([`Home.tsx:5-21`](../new-dashboard/client/src/pages/Home.tsx)).
- `pages/Calendar.tsx` — duplicate of the `Scheduling` calendar tab; orphaned. ([`Calendar.tsx:1-72`](../new-dashboard/client/src/pages/Calendar.tsx))

The legacy app has `/live` (LiveMonitor), `/callbacks` (its own page), and `/calendar` as first-class routes — **none of those exist in `new-dashboard`**. Callbacks live as a tab inside `/calls`; live calls have no surface at all.

## Calendar feature deep-dive

The calendar is the most-built feature in `new-dashboard/`.

```
new-dashboard/client/src/features/calendar/
├── api.ts                # calendarApi.getCalendar() + getPatient()
├── types.ts              # Appointment, Operatory, Provider, Schedule, ApptField, etc.
├── index.ts
├── constants/
├── store/                # useReducer + CalendarContext
├── components/           # CalendarTopBar, CalendarGrid, OperatoryColumn, AppointmentCard, ScheduleOverlay, CalendarTabs
└── drawer/               # DrawerScheduling, DrawerVisitProgression, DrawerPatientContext, DrawerCustomFields, DrawerActions
```

- The shape mirrors [`docs/PHASE1_SPEC.md`](../docs/PHASE1_SPEC.md) (Phase 1 = read-only operatory-first day grid). Implementation matches the spec.
- Data path is **only** the backend — `features/calendar/api.ts` imports the shared `api` from `@/lib/api` and hits `GET /api/opendental/calendar` and `GET /api/opendental/patients/:id` (lazy on drawer open). It does **not** talk to `od-microservice` directly.
- "Open Slots" tab uses `POST /api/opendental/appointments/find-slots` and `GET /api/opendental/ai/schedule-overview` (real endpoints; both implemented in `routes/openDental.js`).
- ASAP and Unscheduled tabs are **placeholders** marked "Phase 3" ([`CalendarTabs.tsx:40-50`](../new-dashboard/client/src/features/calendar/components/CalendarTabs.tsx)).

**vs legacy `OpenDentalCalendar.js`:**
| Capability | Legacy | New |
|---|---|---|
| Library | FullCalendar | Custom operatory grid |
| Provider vs operatory view modes | Yes | Operatory-only (per Phase 1 spec) |
| Refresh interval | Yes | No |
| In-app booking | Yes (`AppointmentBookingDialog`) | **No — Phase 1 is read-only** |
| Open slots view | No | Yes (Phase 1 extension) |
| Schedule overlay (practice/provider/blockout) | No | Yes (UI ready; data depends on `/schedules`/`/scheduleops` which are noted as "to be added" in [`docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md:50-53`](../docs/OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md)) |

The new calendar is **better organized** (typed, normalized store, clean component boundaries) but **less capable** today. Adopting it for production would require Phase 2+ (mutations, ASAP, Unscheduled, full overlays).

## API client — [`client/src/lib/api.ts`](../new-dashboard/client/src/lib/api.ts)

- Real `fetch` wrapper around `VITE_API_URL`. Methods present include `getUnifiedCalls`, `getUnifiedCall`, `getCallbacks`, `createCallback`, `getAgents`, `getAdminHealth`, `getAdminConfig`, `getAdminCosts`, `getAnalyticsSummary`, `getOpenDentalCalendar`, `getOpenDentalPatient`, `findAvailableSlots`, `getScheduleOverview`, `syncRetell`, etc.
- **Not** stubs — `lib/mockData.ts` exists with fixtures but **has zero importers under `client/src`**. The app runs on real backend data.

## Layout & navigation

- [`DashboardLayout.tsx`](../new-dashboard/client/src/components/DashboardLayout.tsx) — fixed navy sidebar + header. Items: Dashboard, Calls, Agent Builder, Scheduling, Analytics, Admin. **No Live Monitor, no Callbacks, no Calendar (calendar lives inside Scheduling).** ([`DashboardLayout.tsx:29-36`](../new-dashboard/client/src/components/DashboardLayout.tsx))
- "Connected" indicator is hardcoded `useState(true)` — fake ([`DashboardLayout.tsx:52-53`](../new-dashboard/client/src/components/DashboardLayout.tsx)).
- Office dropdown lists two static offices.
- Hardcoded logo CDN URL ([`DashboardLayout.tsx:27`](../new-dashboard/client/src/components/DashboardLayout.tsx)).

## Notable issues

| # | Severity | Item | Evidence |
|---|---|---|---|
| 1 | Critical | PM2 production entry runs `node_modules/.bin/next start`, but project is Vite — there is no `next` binary. Service will crash on `pm2 start`. | [`ecosystem.config.js:24`](../ecosystem.config.js) vs [`package.json`](../new-dashboard/package.json) |
| 2 | High | API default `5000` in code vs `5001` in `.env.example` | [`lib/api.ts:6`](../new-dashboard/client/src/lib/api.ts); [`.env.example:10`](../new-dashboard/.env.example) |
| 3 | High | Socket.IO dependency present but **never imported** — no live data anywhere | grep `client/src` |
| 4 | High | No live monitor page despite legacy having `/live` and `LiveCallManager` being part of the system | [`App.tsx`](../new-dashboard/client/src/App.tsx) |
| 5 | High | Connection indicator is fake (`useState(true)`) | [`DashboardLayout.tsx:52-53`](../new-dashboard/client/src/components/DashboardLayout.tsx) |
| 6 | High | Agent Builder writes only to `localStorage` — does not call `/api/agents` | [`AgentBuilder.tsx:191-300`](../new-dashboard/client/src/pages/AgentBuilder.tsx) |
| 7 | Med | "Save Rules" in Scheduling fires a toast only; not persisted | [`Scheduling.tsx:274-282`](../new-dashboard/client/src/pages/Scheduling.tsx) |
| 8 | Med | `Calendar.tsx` and `Home.tsx` exist but are unrouted — confusing dead code | [`App.tsx`](../new-dashboard/client/src/App.tsx) |
| 9 | Med | `sonner.tsx` imports `useTheme` from `next-themes`, but the app uses a custom `ThemeContext` and never wraps in a `next-themes` provider; toast theming will not track the toggle | [`components/ui/sonner.tsx:1-8`](../new-dashboard/client/src/components/ui/sonner.tsx) |
| 10 | Med | Two lockfiles: `package-lock.json` AND `pnpm-lock.yaml` — `packageManager` field says pnpm; mixed installs will silently drift dep trees | [`new-dashboard/`](../new-dashboard/) |
| 11 | Low | OAuth helper `getLoginUrl()` exists in `const.ts` but is never imported — dead | [`client/src/const.ts:4-16`](../new-dashboard/client/src/const.ts) |
| 12 | Low | `index.html` uses Umami placeholders `%VITE_ANALYTICS_ENDPOINT%` / `%VITE_ANALYTICS_WEBSITE_ID%`; without Vite's HTML transform setup the script tag will be broken at runtime | [`client/index.html:14-17`](../new-dashboard/client/index.html) |

## Gaps vs legacy frontend

Capability missing in `new-dashboard/`:
- LiveMonitor page (`/live`)
- Live call cards / sentiment gauge / live transcript components
- Standalone Callbacks page (only a tab inside `/calls`)
- AppointmentBookingDialog (no in-app booking — Phase 1 calendar is read-only)
- Mango "fetch this call's recording on demand" (no UI hook for `POST /api/mango/fetch/:id`)
- OD sync UI on call detail (no consumer for `/api/opendental-sync/calls/:id/status`)
- PatientLinkDialog
- AppointmentBookingDialog write-back path

## What's notable in a good way

- **Strict TypeScript** with `noEmit`, modern tooling, organized feature folder, clean shadcn theming, normalized calendar store with typed selectors. The architecture template is sound.
- The [`new-dashboard/plan.md`](../new-dashboard/plan.md) is an unusually clear, honest operational backlog and matches what's actually built.
- Calendar follows the spec ([`docs/PHASE1_SPEC.md`](../docs/PHASE1_SPEC.md)) — rare in this repo.

## Recommended changes (proposals only)

1. **Decide whether this app ships.** If yes, fix the PM2 entry (Vite preview server or static-serve via `server/index.ts`), front it with nginx, and finish parity-blocking features (LiveMonitor, booking, callbacks page). If no, archive the directory until staffed; keep two parallel apps no longer than necessary.
2. Fix [`ecosystem.config.js:24`](../ecosystem.config.js) to actually run this app — change `script` to `node_modules/.bin/vite` (`args: 'preview --port 3005'`) for the simple case, or to `node` running the bundled `server/index.ts` once `dashboard:build` is wired into deploy.
3. Reconcile the `5000` vs `5001` API base.
4. Pick one package manager (pnpm per the manifest); delete `package-lock.json`.
5. Wire Agent Builder to `PATCH /api/agents/:id` and Rules tab to a real endpoint, or hide both behind a "preview" badge.
6. Either delete `Calendar.tsx`/`Home.tsx` or route them.
7. Remove `socket.io-client` from deps until something uses it.
