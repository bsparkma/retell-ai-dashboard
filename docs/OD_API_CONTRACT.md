# Open Dental Cloud API — Authoritative Contract (CareIN)

**Purpose:** Pin the *real* `https://api.opendental.com/api/v1` contract before remediating
`backend/config/openDental.js`. Every param/field name and enum below is taken from Open
Dental's published API docs — **not guessed against live OD**. This is the reference the
OD Client Remediation slice (`feature/od-client-port`) is implemented and re-validated against.

**Sources (Open Dental Developer docs, public):**
- Appointments — https://www.opendental.com/site/apiappointments.html (mirrored in [docs/api-appointments.md](api-appointments.md))
- Patients — https://www.opendental.com/site/apipatients.html (mirrored in [docs/api-patients.md](api-patients.md))
- Auth header: `Authorization: ODFHIR {DeveloperKey}/{CustomerKey}` (one Customer Key = one OD database).

**Pulled:** 2026-06-04. Captures the Step-4 failures recorded in [docs/OD_API_COVERAGE.md](OD_API_COVERAGE.md)
(OD's own 400s: `'search' is not a valid parameter`, `'updatedSince' is not a valid parameter`,
`AptStatus is invalid`).

> ⚠️ Versioned params are annotated with the OD version that introduced them. Confirm the
> CareIN tenant's OD server version covers the ones we depend on (esp. `AptStatus` filter
> v22.4.28+, `Op` filter v23.2.27+) during STEP 2 live re-validation.

---

## 1. AptStatus — the canonical string enum

OD's API uses a **string enum** for `AptStatus` on both reads and writes. **There is no
integer form and no `"Cancelled"` value.** This is the root cause of the blocked write path
(client posts integer `AptStatus:1` / `AptStatus:8`).

Valid values:

| String | Meaning | OD integer (DB only, NOT the API) |
|---|---|---|
| `"Scheduled"` | Scheduled appointment | 1 |
| `"Complete"` | Completed | 2 |
| `"UnschedList"` | Unscheduled list | 3 |
| `"ASAP"` | ASAP list | (Priority, see note) |
| `"Broken"` | Broken / cancelled | 5 |
| `"Planned"` | Planned | 6 |
| `"PtNote"` | Patient note row | 7 |
| `"PtNoteCompleted"` | Completed patient note | 8 |

- **There is NO `"Cancelled"` status.** To cancel, use **`"Broken"`** (or the dedicated
  Break endpoint, §4.3). The current client's integer `AptStatus:8` is wrong twice over:
  wrong type (int vs string) **and** wrong meaning (DB 8 = `PtNoteCompleted`, not cancelled).
- **POST create** defaults `AptStatus` to `"Scheduled"` and only accepts a subset on create:
  `"Scheduled"`, `"Complete"`, `"UnschedList"`, `"PtNote"`, `"PtNoteCompleted"`.
- OD has **no `Confirmed`/`Arrived`/`NoShow` AptStatus.** Those concepts are modeled elsewhere:
  - **Confirmed** → `Confirmed` field = a `definition.DefNum` (FK), NOT a boolean.
  - **Arrived/Seated/Dismissed** → `DateTimeArrived` / `DateTimeSeated` / `DateTimeDismissed`.
  - **No-show / cancellation** → Break endpoint with `breakType` `"Missed"` or `"Cancelled"`.

  → The remediated `mapStatusToOD` must collapse our internal vocab onto real OD semantics
  (see §5), not invent statuses.

---

## 2. Appointments — reads (`GET /appointments`)

Exact query parameters (names + casing are significant):

| Param | Type | Notes / version |
|---|---|---|
| `date` | string `yyyy-MM-dd` | single-day load |
| `dateStart` | string `yyyy-MM-dd` | range start (inclusive) |
| `dateEnd` | string `yyyy-MM-dd` | range end (inclusive) |
| `PatNum` | integer | filter by patient (v21.4+) |
| `Op` | integer | filter by **one** operatory (v23.2.27+) |
| `ClinicNum` | integer | clinic scope; `0` = non-clinic |
| `AptStatus` | string enum (§1) | work-queue filter (v22.4.28+) |
| `AppointmentTypeNum` | integer | type filter (v24.4.22+) |
| `DateTStamp` | string `yyyy-MM-dd HH:mm:ss` | **changed-since cursor** (§6) |
| `Offset` | integer | pagination |

**No** `startDate`/`endDate`, **no** `providerIds`/`operatoryIds`, **no** `includePatientInfo`/
`includeProviderInfo`/`includeOperatoryInfo`. Those are fabricated by the current client and
are silently ignored by OD → why date filtering "doesn't take" and returns stale (2012) rows.

- **Provider filtering is not a GET param.** Filter by provider **client-side** after the
  range read (OD only exposes `Op`, `ClinicNum`, `PatNum`, `AptStatus`, `AppointmentTypeNum`).
- Single-day calendar: send `date=` (or `dateStart=dateEnd=` the same day). Range: `dateStart`+`dateEnd`.

**Code deltas this implies**
- `getAppointmentsForDateRange` (openDental.js:359) sends `startDate`/`endDate` → **rename to
  `dateStart`/`dateEnd`**.
- `getCalendarAppointments` (openDental.js:231) already uses `dateStart`/`dateEnd` ✅ but also
  sends fabricated `include*`/`providerIds`/`operatoryIds` → **drop them**; move provider filter
  client-side. (Confirm in STEP 2 whether the fabricated params were the cause of the 2012 rows.)

---

## 3. Appointments — create (`POST /appointments`)

**Required:** `PatNum` (int), `Op` (int), `AptDateTime` (string `yyyy-MM-dd HH:mm:ss`).

**Optional (relevant):** `AptStatus` (string, defaults `"Scheduled"`), `Pattern` (`X`/`/` only),
`Confirmed` (**`definition.DefNum`**), `Note`, `ProvNum` (int), `ProvHyg` (int), `ClinicNum` (int),
`IsHygiene` (string `"true"`/`"false"`), `IsNewPatient` (string `"true"`/`"false"`),
`Priority` (`"Normal"`/`"ASAP"`), `AppointmentTypeNum` (int), `colorOverride` (`"R,G,B"`).

**Code deltas (`prepareAppointmentForOD`, openDental.js:733)**
- `AptStatus: 1` → `AptStatus: "Scheduled"`.
- `AptDateTime` must be `yyyy-MM-dd HH:mm:ss` (no `T`/`Z`) — format ISO input before send.
- `Confirmed: false` (boolean) is the wrong type — `Confirmed` is a **DefNum**. **Omit it on
  create** unless we have a real DefNum (do not send a boolean).
- `IsNewPatient` / `IsHygiene` should be the strings `"true"`/`"false"`, not JS booleans.

---

## 4. Appointments — update & cancel

### 4.1 `PUT /appointments/{AptNum}` (update)
All fields optional; updatable: `AptStatus` (string), `AptDateTime`, `Pattern`, `Op`, `ProvNum`,
`ProvHyg`, `Note` (overwrites), `Confirmed` (DefNum), `ClinicNum`, `IsHygiene`, `IsNewPatient`,
`Priority`, `AppointmentTypeNum`, `UnschedStatus` (v22.2+), `colorOverride` (v22.3.9+),
`DateTimeArrived`/`Seated`/`Dismissed` (v25.2.10+).

A notes-only update (`{ Note }`) is safe and omits `AptStatus` — consistent with the coverage
doc's note that update *may* work where create/cancel were blocked.

### 4.2 Cancel via status — **the chosen approach (per PRD §1)**
`PUT /appointments/{AptNum}` with `AptStatus: "Broken"`. This is an **UPDATE that sets the
status — never a delete/DELETE**. Replaces the current broken `AptStatus: 8` integer. The PRD
specifies the cancel enum is `"Broken"` and that cancel must remain a status-setting UPDATE.

### 4.3 Cancel via dedicated Break endpoint (OD-faithful alternative — NOT this slice)
`PUT /appointments/{AptNum}/Break`
- **Required:** `sendToUnscheduledList` (string `"true"`/`"false"`).
- **Optional:** `breakType` — `"Missed"` or `"Cancelled"` (associates D9986 / D9987 procedure
  codes the way the OD UI does).

> This is the more OD-faithful long-term path (matches the UI, adds D9986/D9987) but is **out of
> scope for this slice** — the PRD scopes cancel to the `AptStatus:"Broken"` status UPDATE.
> Captured here so a future slice can adopt `/Break` if/when we want UI-parity break bookkeeping.

---

## 5. Internal status ↔ OD enum mapping (to centralize)

`mapStatusToOD` / `mapAppointmentStatus` (openDental.js:1315–1344) are currently integer-based.
Replace with string-enum mapping that respects §1 (OD has no Confirmed/Arrived/NoShow status):

| CareIN internal | → OD write | OD read → internal |
|---|---|---|
| `scheduled` | `"Scheduled"` | `"Scheduled"` → `scheduled` |
| `confirmed` | `"Scheduled"` + set `Confirmed` DefNum | (read `Confirmed` DefNum, not status) |
| `arrived` | `"Scheduled"` + `DateTimeArrived` | (read `DateTimeArrived`) |
| `completed` | `"Complete"` | `"Complete"` → `completed` |
| `cancelled` | `PUT {AptStatus:"Broken"}` (status UPDATE, §4.2) | `"Broken"` → `cancelled` |
| `no_show` | `PUT {AptStatus:"Broken"}` (status UPDATE) | `"Broken"` → `no_show`* |
| `broken` | `"Broken"` | `"Broken"` → `broken` |
| — | — | `"UnschedList"` → `unscheduled`; `"ASAP"`/`"Planned"`/`"PtNote"`/`"PtNoteCompleted"` → pass-through |

\* OD can't distinguish no-show vs cancel on read (both are `"Broken"`); keep `no_show` only as a
write-side intent via `breakType:"Missed"`. Centralize int↔string in one place so writes never
emit integers again.

---

## 6. Changed-since (incremental sync) — the real mechanism

There is **no `updatedSince` param.** OD uses **`DateTStamp`** + a returned **`serverDateTime`**
cursor:

1. Read with `DateTStamp={lastServerDateTime}` in `yyyy-MM-dd HH:mm:ss` (only rows altered after
   that instant come back).
2. Persist the `serverDateTime` field returned on the response (OD 21.2+) and reuse it as the next
   `DateTStamp`.

**Code deltas**
- `getRecentPatientUpdates` (openDental.js:1469) sends `updatedSince` → OD 400. Either **drop it
  from `performSync`/`getSyncData`** (openDental.js:206–216) or re-implement against
  `GET /patients/Simple?DateTStamp=…` (§7) and store the `serverDateTime` cursor.
- Same `DateTStamp` cursor applies to `GET /appointments` for incremental appointment sync.

---

## 7. Patients — search & lookup

**There is no `search` or `searchType` param.** Both list endpoints use explicit field filters.

### `GET /patients` (multi-result)
Params: `LName`, `FName` (partial, case-insensitive), `Phone`, `Birthdate` (`yyyy-MM-dd`),
`Email`, `Address`, `City`, `State`, `SSN`, `ChartNumber`, `SubscriberId`, `clinicNums`
(CSV), `hideInactive`, `showArchived`, `guarOnly`, `Offset`.

### `GET /patients/Simple` (recommended for list/search — mirrors the Patient Select window)
Params: `LName`, `FName`, `Birthdate`, `PatStatus` (`"Patient"|"NonPatient"|"Inactive"|"Archived"|"Deceased"|"Prospective"`),
`Gender`, `HmPhone`, `WkPhone`, `WirelessPhone`, `Guarantor`, `PriProv`, `ClinicNum`, `HasIns`,
`DateTStamp` (`yyyy-MM-dd HH:mm:ss`), `Offset`. Returns fewer fields than `/patients`.

**Code deltas (`searchPatients`, openDental.js:873)**
- Replace `{ search: query, searchType: 'name' }` with **name parsing → `LName`/`FName`** (and/or
  use `/patients/Simple`).
- Phone search: param is **`Phone`** on `/patients` (capital P), or `WirelessPhone`/`HmPhone`/
  `WkPhone` on `/patients/Simple` — not lowercase `phone`.
- Birthdate search: param is **`Birthdate`**, value formatted `yyyy-MM-dd` — not lowercase
  `birthdate` with the raw user string.
- Keep `Promise.allSettled` for the multi-strategy fan-out, but **a rejected lane must not be
  silently swallowed into a mock result** (see §8).

---

## 8. Safety — no silent mock fallback in `api` mode

In `api` mode (`od_primary_mode='api'`), these currently `catch → return getMock*`, masking OD
outages/contract errors as "success with fake data":
- `searchPatients` → `getMockPatients` (openDental.js:875, 931)
- `getCalendarAppointments` → `getMockCalendarData` (openDental.js:233, 263, 275)
- `getProviders` → `getMockProviders` (openDental.js:1118, 1140, 1176)
- `getOperatories` → `getMockOperatories` (openDental.js:1182, 1204, 1241)

**Requirement:** mock is permissible only when **not enabled / explicit dev flag** (e.g.
`!this.enabled` or an explicit `OD_ALLOW_MOCK`/dev guard). When `enabled && api` and OD errors,
**the error must surface** (throw / structured error), never a mock payload. This is what makes
STEP 2's "induced API error surfaces" check meaningful.

---

## 9. Provider working hours (`GET /schedules`) — secondary

Coverage shows this returns real data (`startHour:5,endHour:16`) but flags a **TZ risk** in hour
parsing (`new Date(date).toISOString()` + `timeToHour`, openDental.js:1245–1282). Treat as a
read-correctness fix (parse OD local time without UTC shifting), not a contract mismatch. Confirm
the exact `/schedules` param/field names against the OD schedules doc during STEP 1 if we touch it.

---

## 10. Commlog write — located, contract captured, gap fixed (STEP 1)

**Where it lives:** the call-summary commlog write is in
`backend/services/openDentalSync.js` (`syncCallToCommLog` / `formatCommLogEntry` /
`insertCommLogToDatabase`) and is triggered by the post-call webhook
`backend/routes/webhooks.js` (`call_analyzed`). (`docs/retell-tools.md` documents the
live-call tools but not this path — it's webhook-driven.)

**Real `POST /commlogs` contract** (https://www.opendental.com/site/apicommlogs.html):
- **Required:** `PatNum` (int), `Note` (string).
- **Optional:** `CommDateTime` (`yyyy-MM-dd HH:mm:ss`, defaults now), `CommType`
  (**integer `definition.DefNum` where `Category=27`**, defaults to Misc; or string
  `commType` = the definition's `ItemName`), `Mode_` (**string enum**), `SentOrReceived`
  (**string enum**), plus `CommSource`/`ProgramNum` in responses.
- **`Mode_` enum:** `"None"|"Email"|"Mail"|"Phone"|"In Person"|"Text"|"Email and Text"|"Phone and Text"`.
- **`SentOrReceived` enum:** `"Neither"|"Sent"|"Received"`.
- Returns **201**; full commlog object in response on 23.3.7+ / 25.2.21+.

**The gap (now fixed):**
1. **api-mode commlog never wrote.** `webhooks.js` called `insertCommLogToDatabase`
   **directly** — a DB-only path. In api mode (`pool === null`) it returned
   `{success:false,'Database pool not available'}` and the summary was dropped. Fixed by
   routing through a new `createCommLog(patientId, entry)` that branches DB vs API.
2. **Integer enums on the API path.** The old API branch posted the DB-shaped integers
   (`Mode_:3`, `SentOrReceived:1`) → wrong types (same class as `AptStatus`). Fixed by
   `buildCommLogApiPayload` → `Mode_:"Phone"`, `SentOrReceived:"Received"`,
   `CommDateTime` formatted, `CommType` = configured DefNum.
3. **CommType DefNum is practice-specific.** `CommType` is a `Category=27` `definition.DefNum`
   that differs per OD database. Set via `OPENDENTAL_CAREIN_COMMTYPE_DEFNUM` (default **486**,
   the CareIN convention). **⚠️ Must be verified to exist in Roland's DB during STEP 2**, and a
   distinct value resolved for Valley when that location is wired (ties into per-location work).

**DB-mode untouched:** `insertCommLogToDatabase` and `formatCommLogEntry`'s integer shape are
unchanged, so direct-DB tenants behave exactly as before; only the api-mode path is new.

---

## Summary of contract-driven fixes (feeds the PRD / STEP 1)

| Area | Current (wrong) | Real OD contract |
|---|---|---|
| Book status | `AptStatus: 1` (int) | `AptStatus: "Scheduled"` (string) |
| Cancel | `PUT {AptStatus: 8}` (int) | `PUT {AptStatus:"Broken"}` (status UPDATE, not delete) |
| Range read | `startDate`/`endDate` | `dateStart`/`dateEnd` |
| Calendar extras | `includePatientInfo`, `providerIds`, … | drop; filter providers client-side |
| Patient search | `search`, `searchType`, `phone`, `birthdate` | `LName`/`FName`, `Phone`, `Birthdate` (or `/patients/Simple`) |
| Changed-since | `updatedSince` | `DateTStamp` + `serverDateTime` cursor |
| AptDateTime fmt | ISO `…THH:mm:ssZ` | `yyyy-MM-dd HH:mm:ss` |
| Confirmed | boolean | `definition.DefNum` (omit if none) |
| Mock on error (api mode) | silent `getMock*` | surface error; mock only when not enabled / dev |
