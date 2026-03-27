# Open Dental Calendar — Backend API Contract Spec

This document defines the **middleware API contract** between the CareIn dashboard frontend and the backend. The backend proxies and normalizes Open Dental (API or direct DB). All calendar-related requests from the frontend go to `GET/POST /api/opendental/...`.

---

## 1. Base URL and auth

- **Base:** `{BACKEND_URL}/api/opendental`
- **Auth:** Backend uses env credentials (OD_API_URL + keys, or OPENDENTAL_DB_URL). Frontend does not send OD credentials.
- **CORS:** Backend must allow the dashboard origin (e.g. `http://localhost:3005`).

---

## 2. Endpoints to implement (contract)

### 2.1 Health

| Method | Path | Purpose | Response |
|--------|------|--------|----------|
| GET | `/health` | Check OD connection and mode | `{ enabled, status, connectionType, message, lastSync, useDatabase }` |

**Existing:** Yes.

---

### 2.2 Bootstrap (fetch order 1–6)

These should be callable in any order; frontend will call in bootstrap order.

| Method | Path | Query | Purpose | Response |
|--------|------|-------|--------|----------|
| GET | `/clinics` | — | List clinics for selector/filter | `{ clinics: Clinic[] }` |
| GET | `/operatories` | `?clinicNum=` | List operatories (calendar columns) | `{ operatories: Operatory[] }` |
| GET | `/providers` | `?clinicNum=`, `?dateTStamp=` | List providers | `{ providers: Provider[] }` |
| GET | `/appointmenttypes` | — | Appointment type list (chips, colors) | `{ appointmentTypes: AppointmentType[] }` |
| GET | `/apptfielddefs` | — | Custom field definitions | `{ apptFieldDefs: ApptFieldDef[] }` |
| GET | `/definitions` | `?category=` | Optional definitions | `{ definitions: Definition[] }` |

**Existing:** Providers and operatories are returned inside `/calendar`. Separate GETs for clinics, appointmenttypes, apptfielddefs, definitions are **to be added** for bootstrap.

**Clinic behavior:** If OD has no clinics, return `clinics: []`. Frontend runs in single-office mode.

---

### 2.3 Schedules and schedule–operatory mapping (fetch order 7–8)

| Method | Path | Query | Purpose | Response |
|--------|------|-------|--------|----------|
| GET | `/schedules` | `date=YYYY-MM-DD` or `dateStart=&dateEnd=` | Schedules for overlay | `{ schedules: Schedule[] }` |
| GET | `/scheduleops` | `?scheduleNum=`, `?operatoryNum=` | Schedule → operatory mapping | `{ scheduleOps: ScheduleOp[] }` |

**Existing:** To be added.

**Rules:** Schedules include blockouts and provider availability. ScheduleOps links each schedule block to operatories for column overlay.

---

### 2.4 Appointments (fetch order 9)

| Method | Path | Query | Purpose | Response |
|--------|------|-------|--------|----------|
| GET | `/calendar` | `date=YYYY-MM-DD`, `providerIds=`, `operatoryIds=`, `clinicNum=` | Single-day calendar payload | See §3.1 |
| GET | `/appointments/range` | `startDate=`, `endDate=`, `providerId=`, `operatoryId=`, `patientId=` | Appointments in range | `{ appointments: Appointment[] }` |
| GET | `/appointments/asap` | `?clinicNum=` | ASAP list | `{ appointments: Appointment[] }` |
| GET | `/appointments/slots` | `date=`, `operatoryNum=`, `providerNum=`, etc. | Open slot candidates | `{ slots: Slot[] }` |
| GET | `/appointments/:id` | — | Single appointment (drawer) | `{ appointment: Appointment }` |

**Existing:** `/calendar` and `/appointments/range` exist. `/appointments/asap` and `/appointments/slots` and GET-by-id are **to be added**.

**Critical:** For `/calendar`, backend must use **dateStart** and **dateEnd** (same day) when calling Open Dental API so only that day’s appointments are returned. Return only appointment records, never a patient list.

---

### 2.5 Appointment custom fields

| Method | Path | Body/Purpose | Response |
|--------|------|--------------|----------|
| GET | `/appointments/:id/fields` | — | All custom field values for one appointment | `{ fields: Record<FieldName, string> }` or `{ apptFields: ApptField[] }` |
| PUT | `/appointments/:id/fields` | `{ fieldName, value }` | Set one custom field (create if missing) | `{ success, value? }` |

**Existing:** To be added. Backend maps to OD `GET/PUT /apptfields?AptNum=&FieldName=`.

---

### 2.6 Patients (lazy / drawer)

| Method | Path | Query | Purpose | Response |
|--------|------|-------|--------|----------|
| GET | `/patients/:id` | — | Patient details for drawer | `{ patient: Patient }` |
| GET | `/patients/search` | `q=` | Patient search | `{ patients: Patient[] }` |

**Existing:** Search exists elsewhere; patient-by-id for drawer enrichment to be added or reused.

**Rule:** Used only for drawer enrichment, not for calendar grid data.

---

### 2.7 Sync and realtime

| Method | Path | Purpose | Response |
|--------|------|--------|----------|
| GET | `/sync/status` | Last sync time, active flag | `{ lastSync, isActive, ... }` |
| POST | `/sync/trigger` | Force full sync | `{ success, timestamp }` |

**Existing:** Yes.

**Future:** Webhook endpoint for Open Dental subscriptions (e.g. `POST /api/opendental/events/appointment`) to receive Events. Backend dedupes, re-fetches changed records from OD, updates store, pushes to frontend (e.g. Socket.IO).

---

## 3. Response shapes (normalized for frontend)

### 3.1 GET /calendar (single-day payload)

Return a single object the frontend can use for one-day bootstrap + grid:

```ts
{
  success: true,
  date: "YYYY-MM-DD",
  appointments: Appointment[];   // only this day; never patient list
  providers: Provider[];
  operatories: Operatory[];
  // Optional when implemented:
  clinics?: Clinic[];
  appointmentTypes?: AppointmentType[];
  schedules?: Schedule[];
  scheduleOps?: ScheduleOp[];
}
```

**Appointment** (minimal for grid + drawer):

```ts
{
  id: number;           // AptNum
  patientId: number;   // PatNum
  patient?: string;    // display name (Preferred or FName LName)
  dateTime: string;    // ISO
  time: string;       // "HH:mm"
  duration: number;    // minutes
  type: string;       // ProcDescript or type name
  status: string;     // mapped: scheduled | complete | unschedList | asap | broken | planned | ...
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
```

**Operatory:**

```ts
{
  id: number;          // OperatoryNum
  name: string;        // OpName
  abbr?: string;       // Abbrev
  itemOrder?: number;
  isHidden?: boolean;
  isHygiene?: boolean;
  clinicNum?: number;
  provDentist?: number;
  provHygienist?: number;
}
```

**Provider:**

```ts
{
  id: number;           // ProvNum
  name: string;        // FName LName or PreferredName
  abbr?: string;        // Abbr
  provColor?: string;
  isHidden?: boolean;
  isHygienist?: boolean;
}
```

---

### 3.2 Clinics, AppointmentTypes, ApptFieldDefs, Schedules, ScheduleOps

When added, use consistent shapes:

- **Clinic:** `{ id: ClinicNum, description, abbr, isHidden? }`
- **AppointmentType:** `{ appointmentTypeNum, appointmentTypeName, appointmentTypeColor, isHidden?, pattern? }`
- **ApptFieldDef:** `{ fieldName, fieldType, pickListValues? }`
- **Schedule:** `{ scheduleNum, schedDate, startTime, stopTime, schedType, provNum?, blockoutType?, note?, operatories?, dateTStamp? }`
- **ScheduleOp:** `{ scheduleOpNum, scheduleNum, operatoryNum }`

---

### 3.3 Slots (open slot search)

```ts
{ slots: { start: string; end: string; operatoryNum?: number; provNum?: number; }[] }
```

---

### 3.4 ASAP

Same `Appointment[]` shape as calendar appointments.

---

## 4. Open Dental API → backend mapping

| Backend contract | Open Dental API (or DB) |
|------------------|-------------------------|
| GET /calendar?date= | GET /appointments?dateStart=&dateEnd= (same day) |
| GET /operatories | GET /operatories (or DB operatory table) |
| GET /providers | GET /providers (or DB provider table) |
| GET /appointmenttypes | GET /appointmenttypes |
| GET /apptfielddefs | GET /apptfielddefs |
| GET /appointments/asap | GET /appointments/ASAP |
| GET /appointments/slots | GET /appointments/Slots |
| GET /schedules?date= | GET /schedules?date= or dateStart/dateEnd |
| GET /scheduleops | GET /scheduleops |
| GET /clinics | GET /clinics |
| GET /appointments/:id/fields | GET /apptfields?AptNum=&FieldName= (per field or batch if supported) |
| PUT /appointments/:id/fields | PUT /apptfields |

---

## 5. Gotchas for backend

1. **Calendar must never return patients as appointments.** Use dateStart/dateEnd for the requested day; filter response to items with appointment id and date matching that day.
2. **Empty clinics:** Return `[]`; do not error. Frontend treats as single-office.
3. **Operatory ItemOrder:** Sort operatories by ItemOrder when returning; frontend uses order for column order.
4. **Hidden operatories/providers:** Return them so frontend can hide by default but still resolve names for past data.
5. **DateTStamp:** Store or return for incremental sync when frontend implements it.
6. **Schedules without ScheduleOps:** Return schedules anyway; frontend handles missing mapping.

---

## 6. Implementation checklist (backend)

- [x] GET /health
- [x] GET /calendar (dateStart/dateEnd; appointments only)
- [x] GET /appointments/range
- [x] GET /sync/status, POST /sync/trigger
- [ ] GET /clinics
- [ ] GET /operatories (standalone; optional clinicNum)
- [ ] GET /providers (standalone; optional clinicNum, dateTStamp)
- [ ] GET /appointmenttypes
- [ ] GET /apptfielddefs
- [ ] GET /schedules
- [ ] GET /scheduleops
- [ ] GET /appointments/asap
- [ ] GET /appointments/slots
- [ ] GET /appointments/:id
- [ ] GET /appointments/:id/fields
- [ ] PUT /appointments/:id/fields
- [ ] GET /patients/:id (or ensure existing patient route is sufficient)
- [ ] (Phase 4) POST /events/appointment (and /events/patient) for OD subscription webhooks

---

## 7. Reference: frontend brief

The frontend follows **docs/OPEN_DENTAL_CALENDAR_CURSOR_BRIEF.md**: fetch order, normalized state, derived selectors, UI rules, and phases. This backend spec is the contract the frontend expects from the middleware.

---

## 8. Unresolved unknowns (TODO)

- **Slots:** This spec assumes `GET /appointments/slots`. Backend currently has `POST /appointments/find-slots`. Align contract (GET vs POST, query vs body) and document exact parameters.
- **Definitions:** Category values and response shape for `GET /definitions?category=` are not specified. Confirm from Open Dental API or mark optional.
- **Events webhook payload:** Structure of Open Dental event payloads for `POST /events/appointment` and `POST /events/patient` is not documented. Required for Phase 4.
- **Sync cursors:** Backend does not yet return `appointmentsServerDateTime` (or equivalent) for incremental sync. Add when implementing DateTStamp-based polling.
