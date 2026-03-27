# Phase 1 — Read-Only Calendar (Locked Scope)

## Scope (in)

- Read-only single-day calendar
- Operatory-first columns
- Top bar: filters and metrics
- Schedule/blockout overlays (UI ready; data when backend provides it)
- Appointment cards (contract frozen below)
- Appointment selection
- Right-side drawer shell (sections + lazy patient when drawer opens)

## Scope (out)

- No mutations
- No open slots workflow
- No ASAP workflow
- No unscheduled workflow
- No webhook/events or realtime subscriptions
- No patient batch preload beyond visible cards/drawer (lazy only)

---

## 1. Final file tree (Phase 1)

```
new-dashboard/client/src/
├── pages/
│   └── Calendar.tsx                      # Orchestrates feature; layout + CalendarTabs
├── features/calendar/
│   ├── index.ts                          # Public exports
│   ├── types.ts                          # Appointment, Operatory, Provider, Schedule, etc. + UI state types
│   ├── api.ts                            # calendarApi.getCalendar(), getPatient()
│   ├── constants/
│   │   └── calendarColors.ts             # getAppointmentCardColor(); status fallbacks
│   ├── store/
│   │   ├── calendarStore.ts              # Normalized state + setCalendarData, setSelectedId, setPatient, setUI
│   │   └── calendarSelectors.ts         # visibleOperatories, appointmentsForDay, appointmentsByOperatory, etc.
│   ├── components/
│   │   ├── CalendarTopBar.tsx            # Date nav, provider filter, metrics badges
│   │   ├── CalendarGrid.tsx              # Time rail + operatory columns; overlays then cards
│   │   ├── OperatoryColumn.tsx           # Column header + time cells + ScheduleOverlay + cards
│   │   ├── AppointmentCard.tsx           # Frozen contract (§2)
│   │   ├── ScheduleOverlay.tsx           # Practice banner, Provider band, Blockout blocks; Employee ignored
│   │   ├── CalendarTabs.tsx             # Day (grid) | ASAP | Unscheduled | Open Slots (placeholders)
│   │   └── AppointmentDrawer.tsx        # Shell: Scheduling, Visit progression, Patient (lazy), Custom (placeholder), Actions (placeholder)
│   └── drawer/
│       ├── DrawerScheduling.tsx          # Date/time, duration, operatory, provider, type, status, confirmation, note
│       ├── DrawerVisitProgression.tsx    # Asked to arrive, arrived, seated, dismissed
│       ├── DrawerPatientContext.tsx      # Lazy-loaded patient; display name, DOB, language, phone, etc.
│       ├── DrawerCustomFields.tsx        # Placeholder "No custom fields" for Phase 1
│       └── DrawerActions.tsx             # Placeholder action buttons (read-only)
```

---

## 2. Appointment card contract (frozen)

Each card shows:

- **Patient display name**
- **Start time**
- **Duration**
- **Procedure description**
- **Provider abbreviation**
- **Appointment type chip**
- **Appointment status chip**
- **Confirmation chip**
- **Icons/badges:** new patient, hygiene, time locked, arrived, seated, dismissed, custom appointment flags (when we have appt fields in a later phase; Phase 1 can show none or placeholder)

---

## 3. Overlay rules (frozen)

- **Practice schedules** → office-wide banner/overlay
- **Provider schedules** → availability band
- **Blockout schedules** → hard blocked overlay
- **Employee schedules** → ignore in Phase 1 (unless trivial to show)

---

## 4. Component list

| Component | Responsibility |
|-----------|----------------|
| **CalendarTopBar** | Date picker, prev/next/today; provider filter (multiselect or dropdown); metrics: total appointments, confirmed, unconfirmed (and placeholders for open slots, ASAP, unscheduled when backend exists). No clinic filter if no clinics API. |
| **CalendarGrid** | Left time rail (e.g. 8–17, 10-min steps); N operatory columns; render order: ScheduleOverlay layer → AppointmentCard layer. Sticky current-time line when day = today. |
| **OperatoryColumn** | Header: abbr, name, hygiene badge; body: time cells, ScheduleOverlay for this op, then AppointmentCards for this op. |
| **AppointmentCard** | Implements frozen contract; compact; color from calendarColors. |
| **ScheduleOverlay** | Given schedules + scheduleOps; renders Practice as banner, Provider as band, Blockout as blocked segment. No Employee. |
| **CalendarTabs** | Tabs: Day \| ASAP \| Unscheduled \| Open Slots. Day shows CalendarGrid; others show placeholder copy. |
| **AppointmentDrawer** | Right-side sheet/drawer; when selectedAppointmentId set, show DrawerScheduling, DrawerVisitProgression, DrawerPatientContext (fetch patient on open), DrawerCustomFields (placeholder), DrawerActions (placeholder). |
| **DrawerScheduling** | Read-only: date/time, duration, operatory, provider, type, status, confirmation, note. |
| **DrawerVisitProgression** | Read-only: asked to arrive, arrived, seated, dismissed (from appointment). |
| **DrawerPatientContext** | Lazy GET /patients/:id; show display name, DOB, language, phone, texting, prefs, premed, notes. Loading/empty state. |
| **DrawerCustomFields** | Placeholder: "No custom fields" or empty. |
| **DrawerActions** | Placeholder buttons (Confirm, Reschedule, etc.); no handlers. |

---

## 5. Store and selectors (Phase 1)

### Store (calendarStore)

- **State:** Normalized: `appointmentsById`, `operatoriesById`, `providersById`, `schedulesById`, `scheduleOpsByScheduleNum`, `patientsById`. UI: `selectedDate`, `selectedAppointmentId`, `providerFilter` (array of ProvNum), `loading`, `error`. Optional: `clinicsById` if we add clinic filter later.
- **Actions:** `setCalendarData({ appointments, operatories, providers, schedules?, scheduleOps? })`, `setSelectedDate`, `setSelectedAppointmentId`, `setProviderFilter`, `setPatient(patientId, patient)`, `setLoading`, `setError`.

### Selectors (calendarSelectors)

- **visibleOperatories** — From operatoriesById; sort by itemOrder; filter isHidden; optionally by clinic. Used for column order.
- **appointmentsForSelectedDay** — Appointments on selectedDate.
- **appointmentsGroupedByOperatory** — Map operatoryId → appointment[].
- **appointmentCardsForColumn(operatoryId)** — Cards for one column with resolved color (for AppointmentCard).
- **schedulesForSelectedDay** — Schedules for selected date (empty if no schedules).
- **blockoutsByOperatory** — Schedules with schedType Blockout, mapped to operatories via scheduleOps.
- **providerAvailabilityByOperatory** — Schedules with schedType Provider, mapped to operatories (for band).
- **practiceSchedulesForDay** — Schedules with schedType Practice for selected day (for banner).
- **selectedAppointment** — Appointment for selectedAppointmentId.
- **topBarMetrics** — total appointments, confirmed, unconfirmed (and placeholder counts for ASAP/unscheduled/open slots if needed).

---

## 6. Backend routes used in Phase 1

| Method | Path | When |
|--------|------|------|
| GET | `/api/opendental/calendar?date=YYYY-MM-DD` | On load and date change; optional `providerIds`, `operatoryIds`. |
| GET | `/api/opendental/patients/:id` | When drawer opens and selected appointment has patientId; lazy once per patient. |

**Optional (not implemented on backend yet):**

- GET `/api/opendental/schedules?date=` — Would populate schedule overlays. If absent, overlays are empty.
- GET `/api/opendental/scheduleops?scheduleNum=` or `?operatoryNum=` — Would map schedules to operatories. If absent, overlays are empty.

---

## 7. Backend gaps blocking Phase 1

**None.** Phase 1 works with existing `/calendar` and `/patients/:id`. Schedule/blockout overlays are built so they render when data exists; without `/schedules` and `/scheduleops` the overlay layer is simply empty.

**Nice-to-have for full overlay in Phase 1:** Implement GET `/schedules` and GET `/scheduleops` so Practice/Provider/Blockout overlays show real data.
