# Open Dental Calendar — Architecture & Implementation Plan

**Source of truth:** Local docs in `docs/` only. No behavior is assumed beyond what is documented in `OPEN_DENTAL_CALENDAR_CURSOR_BRIEF.md` and `OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md`. Unclear or missing items are marked **UNKNOWN** with **TODO**.

---

## 1. Proposed file structure

```
new-dashboard/client/src/
├── pages/
│   └── Calendar.tsx                    # Main calendar page (refactor for operatory-first)
├── features/calendar/                  # NEW: calendar feature module
│   ├── index.ts
│   ├── types.ts                        # All calendar + OD types (§2)
│   ├── api.ts                          # Backend API client for calendar endpoints
│   ├── store/
│   │   ├── calendarStore.ts            # Normalized state + sync metadata
│   │   └── calendarSelectors.ts        # Derived selectors (§5)
│   ├── components/
│   │   ├── CalendarTopBar.tsx          # Clinic, date, filters, metrics
│   │   ├── CalendarGrid.tsx            # Time rail + operatory columns
│   │   ├── OperatoryColumn.tsx         # Single column header + cells
│   │   ├── AppointmentCard.tsx         # Compact card (name, time, type, status, badges)
│   │   ├── ScheduleOverlay.tsx         # Blockout/provider overlay layer
│   │   ├── OpenSlotsOverlay.tsx        # Open slot shading (Phase 3)
│   │   ├── CalendarTabs.tsx           # Day | ASAP | Unscheduled | Open Slots
│   │   └── AppointmentDrawer.tsx      # Right-side drawer (§6)
│   ├── drawer/
│   │   ├── DrawerScheduling.tsx        # Scheduling section
│   │   ├── DrawerVisitProgression.tsx  # Arrived/seated/dismissed
│   │   ├── DrawerPatientContext.tsx    # Patient context section
│   │   ├── DrawerCustomFields.tsx      # Dynamic ApptFieldDefs + ApptFields
│   │   └── DrawerActions.tsx           # Voice-agent action placeholders
│   └── constants/
│       └── calendarColors.ts          # Status fallback colors (single source)
```

**Rationale:** Feature folder keeps calendar types, store, selectors, and UI together. Top bar, grid, overlays, tabs, and drawer are separate components so Phase 1 can ship without drawer/ASAP/slots.

---

## 2. TypeScript types

Types below are derived from **docs only**. Field names and optionality follow `OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md` §3. Where the doc does not specify a field, it is omitted or marked UNKNOWN.

### 2.1 Backend response / normalized entities

```ts
// From Backend Spec §3.1–3.2. Docs are source; no extra fields assumed.

export interface Appointment {
  id: number;
  patientId: number;
  patient?: string;
  dateTime: string;
  time: string;
  duration: number;
  type: string;
  status: string;
  confirmed: boolean;
  operatoryId: number;
  operatoryName: string;
  providerId: number;
  providerName: string;
  clinicNum?: number;
  isNewPatient?: boolean;
  isHygiene?: boolean;
  note?: string;
  dateTStamp?: string;
  dateTimeArrived?: string;
  dateTimeSeated?: string;
  dateTimeDismissed?: string;
  dateTimeAskedToArrive?: string;
  colorOverride?: string;
  appointmentTypeNum?: number;
  priority?: string;
  timeLocked?: boolean;
}

export interface Operatory {
  id: number;
  name: string;
  abbr?: string;
  itemOrder?: number;
  isHidden?: boolean;
  isHygiene?: boolean;
  clinicNum?: number;
  provDentist?: number;
  provHygienist?: number;
}

export interface Provider {
  id: number;
  name: string;
  abbr?: string;
  provColor?: string;
  isHidden?: boolean;
  isHygienist?: boolean;
}

export interface Clinic {
  id: number;
  description: string;
  abbr?: string;
  isHidden?: boolean;
}

export interface AppointmentType {
  appointmentTypeNum: number;
  appointmentTypeName: string;
  appointmentTypeColor?: string;
  isHidden?: boolean;
  pattern?: string; // UNKNOWN: exact OD type. TODO: confirm from OD docs.
}

export interface ApptFieldDef {
  fieldName: string;
  fieldType: string; // Text | PickList per brief
  pickListValues?: string[]; // UNKNOWN: doc says "when applicable". TODO: confirm shape.
}

export interface Schedule {
  scheduleNum: number;
  schedDate: string;
  startTime: string;
  stopTime: string;
  schedType: string; // Practice | Provider | Blockout | Employee per brief
  provNum?: number;
  blockoutType?: string;
  note?: string;
  operatories?: string; // CSV; prefer ScheduleOps for mapping per doc
  dateTStamp?: string;
}

export interface ScheduleOp {
  scheduleOpNum: number;
  scheduleNum: number;
  operatoryNum: number;
}

export interface Patient {
  // Only fields needed for drawer (Backend Spec §3 + brief §6). UNKNOWN: full OD patient shape.
  id: number;
  displayName?: string;
  dateOfBirth?: string;
  language?: string;
  wirelessPhone?: string;
  hmPhone?: string;
  wkPhone?: string;
  email?: string;
  txtMsgOk?: boolean;
  preferConfirmMethod?: string;
  preferContactMethod?: string;
  priProv?: number;
  priProvAbbr?: string;
  clinicNum?: number;
  clinicAbbr?: string;
  premed?: string;
  apptModNote?: string;
  medUrgNote?: string;
  famFinUrgNote?: string;
}

export interface OpenSlotCandidate {
  start: string;
  end: string;
  operatoryNum?: number;
  provNum?: number;
}
```

### 2.2 Normalized state (from Cursor Brief §4 + Backend Spec)

```ts
export interface CalendarState {
  clinicsById: Record<number, Clinic>;
  operatoriesById: Record<number, Operatory>;
  providersById: Record<number, Provider>;
  appointmentTypesById: Record<number, AppointmentType>;
  apptFieldDefsByName: Record<string, ApptFieldDef>;
  apptFieldsByAptNum: Record<number, Record<string, string>>;
  schedulesById: Record<number, Schedule>;
  scheduleOpsByScheduleNum: Record<number, number[]>; // operatory nums per schedule
  appointmentsById: Record<number, Appointment>;
  patientsById: Record<number, Patient>;
  definitionsByCategory?: Record<string, unknown[]>; // Optional; UNKNOWN shape. TODO: from definitions endpoint.
}

export interface CalendarSyncState {
  appointmentsServerDateTime?: string;
  providersServerDateTime?: string;
  patientsServerDateTime?: string;
}

export interface CalendarUIState {
  selectedDate: string;       // YYYY-MM-DD
  selectedClinicNum: number | null;
  selectedAppointmentId: number | null;
  providerFilter: number[];   // ProvNum
  hygieneOnly: boolean;
  doctorOnly: boolean;
  appointmentTypeFilter: number[];
  statusFilter: string[];
  searchQuery: string;
  openSlotsOverlayVisible: boolean;
  activeTab: 'day' | 'asap' | 'unscheduled' | 'openSlots';
}
```

### 2.3 UI view models (from Cursor Brief §12)

```ts
export interface CalendarOperatoryColumn {
  operatory: Operatory;
  appointmentIds: number[];
  scheduleOverlays: CalendarScheduleOverlay[];
  openSlots: OpenSlotCandidate[];
}

export interface CalendarAppointmentCard {
  appointment: Appointment;
  typeColor?: string;   // resolved by color priority
  providerColor?: string;
  statusLabel: string;
  customFieldBadges: { fieldName: string; value: string }[];
}

export interface CalendarScheduleOverlay {
  schedule: Schedule;
  operatoryNum: number;
  startTime: string;
  stopTime: string;
  schedType: string;
  blockoutType?: string;
}

export interface AppointmentDrawerViewModel {
  appointment: Appointment;
  patient: Patient | null;
  appointmentType?: AppointmentType;
  customFields: Record<string, string>;
  provider?: Provider;
  operatory?: Operatory;
  clinic?: Clinic;
}

export interface AttentionQueueItem {
  appointmentId: number;
  reason: string; // e.g. 'unconfirmed' | 'missing_insurance' | 'asap'
}
```

---

## 3. Backend contract assumptions

Frontend **only** calls our middleware at `{BACKEND}/api/opendental`. No direct Open Dental calls from the UI.

### 3.1 Existing routes (verified from codebase)

| Method | Path | Status |
|--------|------|--------|
| GET | `/health` | Exists |
| GET | `/sync/status` | Exists |
| POST | `/sync/trigger` | Exists |
| GET | `/calendar` | Exists (date, providerIds, operatoryIds; returns appointments, providers, operatories) |
| GET | `/appointments/range` | Exists |
| GET | `/appointments/:id` | Exists |
| GET | `/providers` | Exists |
| GET | `/operatories` | Exists |
| GET | `/patients/:id` | Exists |
| GET | `/patients/search` | Exists |

**Note:** Backend has `POST /appointments/find-slots` (not `GET /appointments/slots`). Contract in docs says GET slots; behavior may differ. **TODO:** Align spec with actual backend (GET vs POST, query vs body).

### 3.2 Missing backend routes (from Backend Spec §2 & §6 checklist)

| Method | Path | Purpose |
|--------|------|--------|
| GET | `/clinics` | Bootstrap; clinic selector. Return `[]` if no clinics. |
| GET | `/appointmenttypes` | Bootstrap; type chips and color fallback. |
| GET | `/apptfielddefs` | Bootstrap; dynamic custom field rendering. |
| GET | `/definitions` | Optional; `?category=` for config/labels. **UNKNOWN:** Category values. TODO. |
| GET | `/schedules` | Overlay; `date=` or `dateStart=` / `dateEnd=`. |
| GET | `/scheduleops` | Overlay; map schedules to operatories. `?scheduleNum=` or `?operatoryNum=`. |
| GET | `/appointments/asap` | ASAP tab. `?clinicNum=` optional. |
| GET or POST | `/appointments/slots` | Open Slots tab/overlay. **UNKNOWN:** Exact params. Doc says "date=, operatoryNum=, providerNum=, etc." TODO. |
| GET | `/appointments/:id/fields` | Drawer; all custom field values for one apt. |
| PUT | `/appointments/:id/fields` | Drawer; set one custom field. Body `{ fieldName, value }`. |

**Events (Phase 4):** `POST /events/appointment`, `POST /events/patient` for OD subscription webhooks. **UNKNOWN:** Payload shape. TODO from Events/Subscriptions docs.

---

## 4. Normalized state design

- **Stores:** `CalendarState` (entities by id/name) and `CalendarSyncState` (server DateTStamp / serverDateTime for incremental sync). `CalendarUIState` holds selected date, clinic, filters, selected appointment, active tab, overlay toggles.
- **Hydration:** On load and date change, run bootstrap in doc order: clinics → operatories → providers → appointmenttypes → apptfielddefs → (definitions) → schedules → scheduleops → calendar (appointments for day). Merge into `*ById` / `*ByName`; do not replace entire state with raw API response.
- **Patients:** Lazy. When drawer opens for an appointment, if `patientsById[appointment.patientId]` is missing, call `GET /patients/:id` and store. Option: batch load visible appointment patient ids after day load.
- **Sync metadata:** After fetching appointments (and when backend supports it), store latest `dateTStamp` or server-supplied cursor in `CalendarSyncState` for Phase 4 incremental polling. **UNKNOWN:** Backend does not yet return sync cursors. TODO: add to calendar response or separate endpoint.

---

## 5. Selectors list

From Cursor Brief §5 and §10. All take `CalendarState` + `CalendarUIState` (and optionally `CalendarSyncState`). Implement in `calendarSelectors.ts`.

| Selector | Purpose |
|----------|--------|
| `visibleClinics` | Filter out hidden; used for clinic selector. |
| `visibleOperatoriesForClinic` | Operatories for selected clinic (or all if no clinic); sort by `itemOrder`; exclude hidden by default; used for column model. |
| `visibleProvidersForClinic` | Providers (optional clinic filter); exclude hidden by default. |
| `appointmentsForSelectedDay` | Appointments whose date matches `selectedDate`. |
| `appointmentsGroupedByOperatory` | Map operatoryId → appointment[]. |
| `appointmentCardsByTime` | For grid rendering; appointments with resolved color and badges. |
| `schedulesForSelectedDay` | Schedules for selected date. |
| `schedulesByOperatory` | Using ScheduleOps, map operatoryNum → schedule[]. |
| `blockoutsByOperatory` | Schedules where schedType = Blockout, mapped by operatory. |
| `providerAvailabilityByOperatoryAndTime` | **UNKNOWN:** Doc says "provider availability overlay". TODO: define from Schedule types (Provider) + ScheduleOps. |
| `openSlotsByOperatory` | From slots API response; group by operatoryNum. Phase 3. |
| `asapAppointments` | From ASAP API or filter by priority/status. |
| `unscheduledAppointments` | Filter by status UnschedList / Planned per doc. |
| `appointmentsNeedingAttention` | Derived (e.g. unconfirmed, missing custom flags). |
| `appointmentsMissingCustomFlags` | Compare ApptFields to office-defined “required” flags. **UNKNOWN:** Which fields are “key” per office. TODO. |
| `appointmentsByProvider` | For provider filter. |
| `appointmentsByType` | For appointment type filter. |
| `conflictsAndOverlaps` | Same operatory + overlapping time. |
| `selectedAppointmentViewModel` | Full drawer model: appointment, patient, type, custom fields, provider, operatory, clinic. |
| `topBarMetrics` | total appointments, open slots count, ASAP count, unscheduled count, needing-attention count. |

---

## 6. UI component breakdown

| Component | Responsibility | Phase |
|-----------|-----------------|--------|
| **CalendarTopBar** | Clinic select, date nav (prev/next/today), provider filter, hygiene/doctor toggle, appointment type filter, status filter, patient search, open-slots overlay toggle, metric badges. | 1 |
| **CalendarGrid** | Left time rail (5 or 10 min), operatory columns from selector, render order: ScheduleOverlay → OpenSlotsOverlay → AppointmentCard; sticky current-time line; scroll to current time when day = today. | 1 |
| **OperatoryColumn** | Header: abbr, name, hygiene badge, default dentist/hygienist chips. Body: time cells + overlays + cards. | 1 |
| **AppointmentCard** | Patient name, time, duration, procedure, provider abbr, type chip, status chip, confirmation chip; icons for new patient, hygiene, time locked, ASAP, arrived/seated/dismissed, custom badges. Color from single utility: colorOverride → type → provider → status. | 1 |
| **ScheduleOverlay** | Per operatory; render blockouts and provider availability from schedulesByOperatory / blockoutsByOperatory. | 1 |
| **OpenSlotsOverlay** | Shade open slot candidates when toggle on. | 3 |
| **CalendarTabs** | Day | ASAP | Unscheduled | Open Slots. Content switches view; Day shows grid. | 1 (tabs), 3 (ASAP/Unscheduled/Slots content) |
| **AppointmentDrawer** | Right-side panel; sections: Scheduling, Visit progression, Patient context, Custom fields, Actions. Only mount when `selectedAppointmentId` set. | 2 |
| **DrawerScheduling** | Date/time, duration, operatory, provider, hygienist, clinic, type, status, confirmation, time locked, note, priority. | 2 |
| **DrawerVisitProgression** | Asked to arrive, arrived, seated, dismissed. | 2 |
| **DrawerPatientContext** | Display name, DOB, language, phone, texting, confirm/contact prefs, primary provider, clinic, premed, appt note, urgent notes. | 2 |
| **DrawerCustomFields** | Iterate ApptFieldDefs; for each, show value from ApptFields; support Text and PickList. | 2 |
| **DrawerActions** | Buttons: confirm, reminder, call, text, reschedule, move to ASAP, verify insurance, escalate, mark prep complete. Placeholders allowed. | 2 |

---

## 7. Phased implementation plan

### Phase 1: Read-only day calendar

- **Data:** Call in bootstrap order: clinics (if missing backend, skip or mock empty); operatories; providers; appointmenttypes (if missing, skip); apptfielddefs (if missing, skip); definitions (optional); schedules (if missing, skip); scheduleops (if missing, skip); calendar (date = selected day). Normalize into CalendarState.
- **UI:** Top bar (date, filters; clinic/provider/type/status only if backend exists). Grid with time rail and operatory columns. Sort columns by ItemOrder; hide hidden operatories. Schedule overlays if schedules/scheduleops exist; else no overlay. Appointment cards with color priority and status/confirmation/type chips. Tabs: Day (grid), ASAP/Unscheduled/Open Slots (placeholder content). Selection state: clicking card sets selectedAppointmentId (drawer not yet implemented).
- **Selectors:** visibleOperatoriesForClinic, appointmentsForSelectedDay, appointmentsGroupedByOperatory, appointmentCardsByTime, schedulesForSelectedDay, blockoutsByOperatory (if data exists).
- **Deliverable:** Single-day, operatory-first grid, no patient list, filters and metrics where backend supports them.

### Phase 2: Drawer + patient enrichment

- **Data:** On drawer open, lazy-load patient via GET /patients/:id. Load GET /appointments/:id/fields for custom fields (if backend exists).
- **UI:** AppointmentDrawer with Scheduling, Visit progression, Patient context, Custom fields (from ApptFieldDefs + ApptFields), Actions (placeholders).
- **Selectors:** selectedAppointmentViewModel.
- **Deliverable:** Full drawer; no actions implemented yet.

### Phase 3: Open Slots / ASAP / Unscheduled

- **Data:** GET /appointments/asap; GET or POST /appointments/slots with date (and operatory/provider if supported). Validate slots against clinic, operatories, schedules, blockouts in UI.
- **UI:** ASAP tab = list/cards of ASAP appointments. Unscheduled tab = list of unscheduled/planned. Open Slots tab = slot list or grid; overlay toggle on Day shows open slots on grid.
- **Selectors:** asapAppointments, unscheduledAppointments, openSlotsByOperatory, topBarMetrics (open slots count, ASAP count, unscheduled count).
- **Deliverable:** All four tabs functional; open slot overlay and queues.

### Phase 4: Realtime

- **Data:** Polling with DateTStamp (or serverDateTime) when backend exposes it; then subscription webhooks to POST /events/appointment and /events/patient; backend refetches and pushes to frontend.
- **UI:** No new components; ensure store updates and selectors recompute; optional “last updated” indicator.
- **Deliverable:** Incremental sync and event-driven refresh.

---

## 8. Missing backend routes (summary)

- GET `/clinics`
- GET `/appointmenttypes`
- GET `/apptfielddefs`
- GET `/definitions` (optional)
- GET `/schedules`
- GET `/scheduleops`
- GET `/appointments/asap`
- GET or POST `/appointments/slots` (align with existing find-slots)
- GET `/appointments/:id/fields`
- PUT `/appointments/:id/fields`
- (Phase 4) POST `/events/appointment`, POST `/events/patient`

---

## 9. Unresolved unknowns from the docs

- **AppointmentType.pattern:** Exact type and meaning. TODO: confirm from Open Dental API docs.
- **ApptFieldDef.pickListValues:** Shape (array of strings?). TODO: confirm.
- **Definitions:** Category values and response shape. TODO.
- **Slots endpoint:** GET vs POST; exact query/body params; response shape beyond start/end/operatoryNum/provNum. TODO: align with backend find-slots and doc.
- **Event payload:** Structure of OD Events when sent to our webhook. TODO: from Events/Subscriptions docs.
- **Subscription payload:** Structure when creating/managing subscriptions. TODO.
- **Provider-by-clinic vs global:** Doc warns semantics may differ; exact behavior not specified. TODO.
- **“Appointments needing attention” / “key custom flags”:** Which flags are required per office not defined. TODO: config or ApptFieldDef–based rule.
- **Sync cursors:** Backend does not yet return appointmentsServerDateTime etc. TODO: add to contract and backend.

---

## 10. Color rules (single source)

From Cursor Brief §6 and Backend Spec. Implement in `calendarColors.ts`:

1. **Resolution order:** `appointment.colorOverride` → appointment type color → `provider.provColor` → status fallback.
2. **Status fallback:** Define a fixed map, e.g. `scheduled` → blue, `complete` → green, `unschedList` → gray, `asap` → orange, `broken` → red, `planned` → purple. **UNKNOWN:** Exact OD status enum. TODO: align with backend response values.
3. **Usage:** Single `getAppointmentCardColor(appointment, appointmentType, provider)` used only by AppointmentCard and drawer.

---

*End of architecture document. Implement Phase 1 first; do not build week view or provider-first default.*
