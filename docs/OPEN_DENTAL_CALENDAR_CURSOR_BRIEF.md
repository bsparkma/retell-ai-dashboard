# Open Dental Calendar — Cursor Master Brief

**Goal:** Build an operatory-first, single-day scheduling console for the voice-agent dashboard. This is not a generic calendar. It must support front desk and AI scheduling actions, multi-clinic, and stay synced with Open Dental.

---

## 1. Core design decision

- **Default view:** Single day.
- **Columns:** Operatories (sorted by `ItemOrder`; hide `IsHidden=true` by default).
- **Rows:** Time increments (5 or 10 min).
- **Cards:** Appointments only (no patient list in the grid).
- **Overlays:** Schedules/blockouts behind appointments; open slots as a toggle.
- **Detail:** Right-side appointment drawer; patient data enriches the drawer, not the grid.
- **Do not** make provider the primary grid dimension; operatory-first avoids bad scheduling UX.

---

## 2. Purpose of each data source

| Source | Purpose |
|--------|--------|
| **Clinics** | Clinic selector; multi-clinic filtering. Empty list = single-office mode. |
| **Operatories** | Column model for the grid. Sort by `ItemOrder`; filter by clinic. |
| **Providers** | Filter, provider chips on cards, schedule overlays, color fallback. |
| **AppointmentTypes** | Type chip, color fallback, filtering. |
| **ApptFieldDefs** | Defines which custom fields exist (dynamic rendering). |
| **ApptFields** | Per-appointment custom values (e.g. Insurance Verified). |
| **Schedules** | Practice/provider/blockout overlays; availability. |
| **ScheduleOps** | Map schedule blocks → operatories (required for blockout columns). |
| **Appointments** | The only cards in the grid; filter by date/clinic/status. |
| **Patients** | Drawer enrichment only (name, language, contact prefs, notes). |
| **Definitions** | Optional config/labels (e.g. blockout types). |
| **Events/Subscriptions** | Realtime later; DB events via API service, UI events need workstation. |

---

## 3. Fetch order (bootstrap)

1. `GET /clinics`
2. `GET /operatories` (optionally by clinic)
3. `GET /providers`
4. `GET /appointmenttypes`
5. `GET /apptfielddefs`
6. `GET /definitions` (if needed)
7. `GET /schedules?date=selectedDate`
8. `GET /scheduleops`
9. `GET /appointments?dateStart=...&dateEnd=...` (single day)
10. Patient details: lazy-load when drawer opens (or batch for visible apts only).

Rationale: resources (clinics, ops, providers) and rendering config (types, field defs) first; then schedules and appointments; patients last.

---

## 4. Normalized client model

```ts
type CalendarState = {
  clinicsById: Record<number, Clinic>;
  operatoriesById: Record<number, Operatory>;
  providersById: Record<number, Provider>;
  appointmentTypesById: Record<number, AppointmentType>;
  apptFieldDefsByName: Record<string, ApptFieldDef>;
  apptFieldsByAptNum: Record<number, Record<string, string>>;
  schedulesById: Record<number, Schedule>;
  scheduleOpsByScheduleNum: Record<number, number[]>;
  appointmentsById: Record<number, Appointment>;
  patientsById: Record<number, Patient>;
};

type SyncState = {
  appointmentsServerDateTime?: string;
  providersServerDateTime?: string;
  patientsServerDateTime?: string;
};
```

---

## 5. Derived selectors (implement these)

- `visibleClinics`, `visibleOperatoriesForClinic`, `visibleProvidersForClinic`
- `appointmentsForSelectedDay`, `appointmentsGroupedByOperatory`, `appointmentCardsByTime`
- `schedulesForSelectedDay`, `schedulesByOperatory`, `blockoutsByOperatory`
- `providerAvailabilityByOperatoryAndTime`, `openSlotsByOperatory`
- `asapAppointments`, `unscheduledAppointments`, `appointmentsNeedingAttention`
- `appointmentsMissingCustomFlags`, `appointmentsByProvider`, `appointmentsByType`
- `conflictsAndOverlaps`, `selectedAppointmentViewModel`

---

## 6. UI render rules

- **Grid:** One day; left rail = time; columns = operatories (ItemOrder); sticky current-time line.
- **Column headers:** Operatory abbr/name; hygiene badge if `IsHygiene`; default dentist/hygienist if available.
- **Cards:** Patient display name, start time, duration, procedure, provider abbr, type chip, status chip, confirmation chip; icons for new patient, hygiene, time locked, ASAP, arrived/seated/dismissed, custom fields. Keep compact; notes via tooltip/expand.
- **Color priority:** (1) appointment `colorOverride`, (2) appointment type color, (3) provider `provColor`, (4) status fallback.
- **Overlay order:** Schedules/blockouts → open slots → appointment cards → selection outline.
- **Drawer:** Scheduling (apt, time, op, provider, type, status, confirmation, note); visit progression (arrived/seated/dismissed); patient (name, DOB, language, phone, contact prefs); custom fields from defs + ApptFields; actions (confirm, reschedule, ASAP, verify insurance, etc.).

---

## 7. Slot / availability

- Use `GET /appointments/Slots` for candidate openings.
- Validate against clinic, operatory, provider filters, schedule overlays, and blockouts. Do not treat slot API as the only source of truth for display.

---

## 8. Realtime strategy

- **Phase 1:** Polling + `DateTStamp` incremental refresh (e.g. appointments every 15–30 s for active day).
- **Phase 2:** Backend webhook for Open Dental subscriptions (Appointment, Patient; optional Provider). Dedupe events; re-fetch changed records from OD; update store and push to frontend.
- **Rule:** DB events = OpenDentalAPIService.exe; UI events = OpenDental.exe on workstation. Always set `Workstation` in subscriptions to avoid duplicate events across machines.

---

## 9. Gotchas (will break the scheduler if ignored)

1. Empty Clinics list = no Clinics feature; do not break.
2. Hidden operatories/providers: hide from column/filter lists but keep in historical records when referenced.
3. Some schedules have no ScheduleOps; handle missing mapping.
4. Use ScheduleOps for schedule→operatory mapping; do not rely only on `operatories` CSV on schedules.
5. Provider-by-clinic vs global provider sync can differ; do not assume identical semantics.
6. Patients: lazy enrichment only; do not flood the grid.
7. Custom fields are office-specific; rendering must be driven by ApptFieldDefs.
8. Open Dental UI events ≠ database events; choose the right subscription type.
9. Omit `Workstation` in subscriptions only for localhost; otherwise expect duplicate events.
10. Store `DateTStamp`/serverDateTime for incremental sync correctly.

---

## 10. Implementation phases

| Phase | Scope |
|-------|--------|
| **1** | Read-only day calendar: clinics, operatories, providers, appointment types, schedules, scheduleops, appointments; basic card rendering and filters. |
| **2** | Drawer + patient enrichment: lazy patient load, drawer sections, custom appt field rendering, communication/status chips. |
| **3** | Open slots + ASAP: open slot overlay, ASAP tab, unscheduled/planned tab, action panel. |
| **4** | Realtime: DateTStamp incremental sync, subscriptions/webhook backend, push to frontend. |

---

## 11. Appointments API usage

- **Read:** `GET /appointments?dateStart=YYYY-MM-DD&dateEnd=YYYY-MM-DD` (and optional `ClinicNum`, `Op`, `AptStatus`, `DateTStamp`, etc.).
- **Also:** `GET /appointments/ASAP`, `GET /appointments/Slots`.
- **Store:** AptNum, PatNum, AptStatus, Pattern, Confirmed, TimeLocked, Op, ProvNum, provAbbr, AptDateTime, ProcDescript, IsNewPatient, ClinicNum, IsHygiene, DateTStamp, DateTimeArrived/Seated/Dismissed/AskedToArrive, colorOverride, AppointmentTypeNum, Priority, etc.
- Use `Op` as the operatory column key; use `DateTStamp` for incremental sync.

---

## 12. TypeScript interfaces to define

- **OD API:** OpenDentalAppointment, OpenDentalAppointmentType, OpenDentalApptFieldDef, OpenDentalOperatory, OpenDentalProvider, OpenDentalSchedule, OpenDentalScheduleOp, OpenDentalClinic, OpenDentalPatient, OpenDentalDefinition, OpenDentalSubscription, OpenDentalEventPayload.
- **UI:** CalendarOperatoryColumn, CalendarAppointmentCard, CalendarScheduleOverlay, AppointmentDrawerViewModel, OpenSlotCandidate, AttentionQueueItem.

---

## 13. Final standard

The result should feel faster and clearer than Open Dental for schedule review; make room/provider/blockout reality obvious; surface communication and scheduling context; support AI-assisted scheduling; and avoid generic calendar patterns that ignore operatory-based dental workflow.

For full endpoint details, field lists, and Open Dental doc links, see the full spec in this repo. For what the backend must expose to the frontend, see `OPEN_DENTAL_CALENDAR_BACKEND_SPEC.md`.
