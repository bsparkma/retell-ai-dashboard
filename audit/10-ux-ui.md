# 10 — UX / UI

This file evaluates the user-facing surfaces. Two parallel UIs exist; both are partly built and neither is whole.

## 1. The two-UI problem

| | Legacy `frontend/` | New `new-dashboard/` |
|---|---|---|
| **Stack** | CRA + React 18 + MUI 5 + FullCalendar | Vite + React 19 + shadcn/ui + Tailwind 4 + wouter |
| **Status in prod** | Currently deployed at `159.89.82.167` | Not deployed (PM2 entry broken — see audit/09) |
| **Use real backend?** | Yes (mostly) | Only the calendar route; everything else is mock data |
| **Routing** | `react-router-dom` v6 with documented routes | `wouter`; several pages exist but are not routed |
| **Auth UI** | None | None |
| **Design language** | MUI's stock theme, custom palette | shadcn/ui + Tailwind, more polished |

A user signing into either has no idea the other exists. Neither UI links to the other. There is no shared design system, no shared components, no shared types. **Whatever is fixed in one will not flow to the other.**

The product implication: every change costs 2x. The audit's recommendation throughout is "pick one and delete the other." Both reports (`03-frontend-legacy.md`, `04-frontend-new.md`) lean toward keeping the new dashboard because the legacy one carries a Rules-of-Hooks violation, large chunks of mock-fallback data, and a heavy MUI bundle.

## 2. Information architecture (legacy)

Top-level routes from `frontend/src/App.js`:

| Route | Purpose | Real data? |
|---|---|---|
| `/` | Dashboard (cards + recent calls) | Real, with mock fallback on error |
| `/calls` | Calls table | Real |
| `/calls/:id` | Call detail (transcript, audio) | Real |
| `/live` | Live monitor (Socket.IO) | Real |
| `/calendar` | FullCalendar of Open Dental appointments | Real |
| `/agents` | Retell agent list/edit | Real |
| `/analytics` | Analytics dashboard | **Entirely mock** |
| `/settings` | Settings | **Stub** |

Issues:
- The Dashboard silently swaps to mock data on any backend error, which means a user staring at the screen has no signal that "the backend is down" — they see plausible numbers and assume things are fine.
- Analytics is entirely mock data. The page has charts (recharts) drawn from a hardcoded array. There is no `/api/analytics/*` call from this page (the route exists in the backend but only the new dashboard would use it).
- Settings is a placeholder.
- Navigation: there is a sidebar with the routes above; some sidebar items navigate to routes that throw on click (the audit recon found at least one broken `<Link to>` target — see `audit/03-frontend-legacy.md`).

## 3. Information architecture (new dashboard)

Routes wired in `new-dashboard/client/src/App.tsx`:

- Calendar (the only fully built feature)
- Agents (list + builder, builder persists only to `localStorage`)
- A few stubs

Pages that exist as files but are **not routed**:
- `client/src/pages/Home.tsx`
- `client/src/pages/Calendar.tsx` (an older calendar page; the routed one is in `features/calendar/`)
- Several other `pages/*.tsx` files that the user can never reach

Issues:
- Dead pages confuse contributors and inflate the bundle.
- The Agents builder writes to `localStorage`. Any user on a different browser/incognito sees no agents. There is no backend persistence and no warning to the user that their work won't sync.
- No live monitor page in the new dashboard. `socket.io-client` is in `package.json` but unused (`audit/04-frontend-new.md`). A user moving from the legacy UI to the new one loses the live call monitor entirely.

## 4. Calendar — the only feature both UIs ship

### Legacy
- Built on FullCalendar v6 with `dayGridPlugin`, `timeGridPlugin`, `interactionPlugin`.
- Booking dialog (`AppointmentBookingDialog.js`) calls `POST /api/opendental/appointments/check-conflicts` then `POST /api/opendental/appointments`.
- Filters by provider and operatory.
- Heavy bundle (FullCalendar + plugins + MUI).
- The Rules-of-Hooks violation lives here: a `useState` is called inside a conditional in one of the dialog components.

### New dashboard
- Custom-built grid in `client/src/features/calendar/components/CalendarGrid.tsx` plus `EventCard.tsx`, `OperatoryHeader.tsx`, `TimeColumn.tsx`.
- Read-only Phase 1 (no booking, no drag/drop).
- Filters in `useCalendarFilters.ts`; reducer in `calendarReducer.ts`.
- Visually cleaner; matches dental scheduling conventions (operatories as columns).
- Loads `GET /api/opendental/calendar` directly via `lib/api.ts`.

The new calendar is the better starting point. The booking flow that the legacy version has would need to be ported.

## 5. Cross-cutting UX issues (both UIs)

- **No empty states.** Tables and lists render `[]` as a blank screen with no "no calls today" message. First-time users assume the page is broken.
- **No loading states.** The legacy dashboard shows nothing while fetching — the page just appears late. The new dashboard does better in `features/calendar/` but most other pages don't show a skeleton.
- **No error states.** Errors are either swallowed (legacy `catch { console.error(); setData(MOCK); }`) or surface as raw alert boxes.
- **No toast/notification system in the new dashboard** for backend events. The legacy app has nothing for this either. A user pressing "Sync now" has no feedback that anything happened.
- **No confirmation modals** for destructive actions. `PATCH /api/agents/:id` (legacy agent editor) saves on blur in some fields. There is no "are you sure?" before overwriting a Retell agent prompt.
- **No keyboard shortcuts** anywhere.
- **Accessibility:** neither UI has been audited. `aria-*` attributes are sparse; FullCalendar in the legacy app is notoriously hard for screen readers. The new dashboard inherits Radix UI primitives via shadcn, which gives it a head start — but custom components like `CalendarGrid` are hand-rolled and likely fail on focus order.
- **Responsive:** the legacy dashboard breaks below ~1024px (sidebar + table). The new dashboard does slightly better via Tailwind responsive utilities but the calendar grid is desktop-only.
- **Time zones:** unclear from code which time zone calendar events render in. The backend returns ISO strings; the legacy uses `date-fns` (often with `moment` transitively from FullCalendar); the new dashboard uses date-fns. Bookings around DST transitions are a ticking bug.

## 6. Visual consistency

- **Colors:** the new dashboard uses Tailwind's neutral palette + shadcn defaults. Coherent.
- **Spacing:** the legacy uses MUI's spacing scale (`theme.spacing(2)` etc.); the new dashboard uses Tailwind utilities. Different mental models. A combined product would have to settle on one.
- **Typography:** the legacy uses MUI's default Roboto stack; the new dashboard uses Tailwind/shadcn defaults. Different.
- **Iconography:** the legacy uses `@mui/icons-material`; the new dashboard uses `lucide-react`. Different.
- **Density:** the new dashboard is denser and more "tool-like"; the legacy is airier and more "dashboard-like." Both could work for the audience (dental front desk + ops); they just shouldn't co-exist.

## 7. Specific UI bugs found in recon

### Legacy
- Rules-of-Hooks violation in a calendar dialog component (will warn in dev, breaks reordering of state in some renders).
- Dashboard silently swaps to mock data — masks backend outages.
- Some sidebar links navigate to routes that 404 in dev because the matching component throws (no error boundary).
- Settings is a `<div>Coming soon</div>`-style stub.
- Audio playback in the call detail page sometimes shows a controls bar with no source when `recording_url` is missing — there is no "no recording available" state.

### New dashboard
- Multiple unrouted pages still in `pages/`.
- `socket.io-client` imported as a dependency, never used. Dead code in the bundle.
- Agent builder persists to `localStorage` only. Different browsers see different agents. No "save to server" affordance.
- No live monitor page. The user is silently downgraded compared to the legacy app.
- No global error boundary.

## 8. UX risk register (ranked)

| # | Issue | Severity | Where |
|---|---|---|---|
| 1 | Two parallel UIs, neither complete; users see different products | High | repo-wide |
| 2 | Analytics page is entirely mock data | High | `frontend/src/pages/Analytics.js` |
| 3 | Dashboard masks outages by silent fallback to mock data | High | `frontend/src/pages/Dashboard.js` |
| 4 | Agent builder in new dashboard saves only to `localStorage` | High | `new-dashboard/.../agents/*` |
| 5 | No live monitor in new dashboard | Medium | new dashboard |
| 6 | No empty/loading/error states in most pages | Medium | both |
| 7 | No confirmation before mutating agent prompts | Medium | legacy agents page |
| 8 | Rules-of-Hooks violation in legacy calendar dialog | Medium | `frontend/src/components/AppointmentBookingDialog.js` (or sibling) |
| 9 | Calendar grid not keyboard-accessible | Medium | new dashboard `CalendarGrid.tsx` |
| 10 | DST/time zone handling unverified | Medium | both calendars |
| 11 | Dead unrouted pages in new dashboard | Low | `new-dashboard/client/src/pages/` |
| 12 | No design tokens / no shared component library | Low | repo-wide |

## 9. Recommendations

1. **Decide.** Pick the new dashboard as the canonical UI. Port the calendar booking flow from the legacy app, build the live monitor, then delete `frontend/`. This is the single biggest UX cleanup in the repo.
2. **Remove all silent mock-data fallbacks.** Show an honest error state. A blank dashboard with "API unreachable" is better than fake numbers.
3. **Move the new-dashboard agent builder to the backend.** A frontend-only `localStorage` store is a data-loss bug, not a UX feature.
4. **Add empty / loading / error states to every async page** before adding any new feature.
5. **Run an a11y pass** with axe / Lighthouse on both UIs as a forcing function for what to keep.
