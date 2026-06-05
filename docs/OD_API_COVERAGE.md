# Open Dental API Coverage — CareIN tenant (Phase 3 Step 4)

Validation of the CareIN staging tenant against the **live Open Dental cloud API**
(`https://api.opendental.com/api/v1`), **Roland location only**. Read-only Phase B
(2026-06-05). Writes (book/update/cancel) are Phase C — not yet run.

## How it's wired
- `od_primary_mode = 'api'`; `odAccess` → `config/openDental.js` cloud client.
- Auth: `Authorization: ODFHIR {developerKey}/{customerKey}` — keys loaded by the
  managed identity from `kv-carein-staging` (`opendental-developer-key` →
  `OPENDENTAL_DEVELOPER_KEY`, `opendental-customer-key` → `OPENDENTAL_CUSTOMER_KEY`).
- `isEnabled()` = `apiUrl && (developerKey && customerKey)` → **true** after the keys
  landed. `testConnection` = "API connection successful — found **38 providers**".
- `getStatus.enabled === true`, `connectionType: api`, `useDatabase: false`.

## Bottom line — how much of CareIN is API-covered
- **Entity-by-id reads and unparameterised reference lists work against real Roland OD**
  (providers, operatories, patient-by-id, appointment-by-id, provider schedule).
- **Everything that relies on query-param filtering is broken** because the client's
  param names don't match the real OD API contract — proven by OD's own 400s
  (`'search' is not a valid parameter`, `'updatedSince' is not a valid parameter`)
  and by date-range params being silently ignored (returns 2012 records). This hits
  patient search, calendar-by-date, appointments-by-range, patient appt verification,
  and sync. **These need client remediation to the real OD param names** (e.g.
  `dateStart`/`dateEnd`, OD patient search fields) before CareIN's scheduling/lookup
  flows are trustworthy on live OD.
- **slot-markers is connector-only** (no API path) and needs a real on-prem connector.
- **The tenant spans two separate OD databases (Roland + Valley)**; the single-key
  cloud client can only serve one → see the multi-OD-database row.

## Coverage matrix

Legend: **full** = clean 200 from api.opendental.com with **real Roland data** (no mock
fallback); **partial** = 200 but params ignored/filtering broken; **none** = OD rejects
the call (or returns nothing usable); **derived** = computed on top of other reads;
**connector-only** = no API path.

| OD operation | odAccess method | HTTP route | API coverage | Connector-agent? | Evidence / notes |
|---|---|---|---|---|---|
| Connection test | `testConnection` | `GET /opendental/health` | **full** | no | 200 `GET /providers`; "found 38 providers" |
| Status / enabled | `getStatus` | `GET /opendental/health` | **full** | no | `enabled:true`, api mode |
| List providers | `getProviders` | `GET /opendental/providers` | **full** | no | 200; 38 **real** (Beau Sparkman, Melissa Davis, Erin Barker…) — not the 4-name mock |
| List operatories | `getOperatories` | `GET /opendental/operatories` | **full** | no | 200; 24 **real** (Ortho Bay Sparkman, Hyg2, Neumeier…) |
| Patient by id | `getPatientDetails` | `GET /opendental/patients/:id` | **full** | no | 200 `/patients/1001` → real (Cara Davenport, DOB 1962-08-21, Roland OK) |
| Appointment by id | `getAppointmentDetails` | `GET /opendental/appointments/:id` | **full** | no | 200 `/appointments/3` → real appt; ⚠️ `patient` name empty (single-appt payload lacks name fields) |
| Provider working hours | `getProviderWorkingHours` | `GET /opendental/providers/:id/schedule` | **full** | no | 200 `/schedules` → `{startHour:5,endHour:16}` (not the 8–17 default) ⚠️ hour parse may be TZ-affected |
| Patient appt history | `verifyPatientAppointments` | `GET /opendental/patients/:id/appointments` | **partial** | no | 200 + real appts, but a 2012 appt labeled "upcoming" → today/future date filter ignored |
| Calendar (by day) | `getCalendarAppointments` | `GET /opendental/calendar` | **partial** | no | providers/operatories real & 200; **appointments = 0** (records come back dated 2012 → day filter drops them) |
| Appointments by range | `getAppointmentsForDateRange` | `GET /opendental/appointments/range` | **partial** | no | 200 + 100 **real** records, but `startDate`/`endDate` **ignored** → returns 2012 data; `patient` = "Unknown Patient" (includePatientInfo ignored) |
| Patient search | `searchPatients` | `GET /opendental/patients/search` | **none** | no | OD **400 `'search' is not a valid parameter`** → returns empty (not mock; `allSettled` swallows). Search non-functional vs real OD |
| Sync | `performSync` | `POST /opendental/sync/trigger` | **partial** | no | appts/providers/operatories 200; `getRecentPatientUpdates` → OD **400 `'updatedSince' is not a valid parameter`** |
| Scheduling rules | `getSchedulingRules` | *(via conflict check)* | **none (expected)** | no | `GET /preferences` — not isolated this phase; falls back to hardcoded defaults |
| Conflict check | `checkSchedulingConflicts` | `POST /opendental/appointments/check-conflicts` | **derived** | no | computed on `getAppointmentsForDateRange` (partial) → unreliable until range reads fixed |
| Alt slots / day slots | `findAlternativeTimeSlots`, `findAvailableSlotsForDay` | `POST /opendental/appointments/find-slots` | **derived** | no | loops `checkSchedulingConflicts` |
| Slot markers | `getSlotMarkers` | `GET /api/slot-markers` | **none (API)** | **YES — connector-only** | `connectorRequest` → `{connector_url}/api/slot-markers`; staging connector_url is placeholder → 503 |
| Book appointment | `bookAppointment` | `POST /opendental/appointments` | **Phase C (not run)** | no | `POST /appointments` |
| Update appointment | `updateAppointment` | `PUT /opendental/appointments/:id` | **Phase C (not run)** | no | `PUT /appointments/:id` |
| Cancel appointment | `cancelAppointment` | `PATCH /opendental/appointments/:id/status` | **Phase C (not run)** | no | `PUT /appointments/:id {AptStatus:8}` — status change, never a delete |

### Multi-OD-database finding (first-class)
| Concern | Status | Detail |
|---|---|---|
| **Tenant spans separate OD databases (Roland + Valley)** | **single-key model insufficient → needs extension** | The CareIN tenant has clinics 1 (Roland) and 2 (Valley). Each is a **separate Open Dental database with its own Customer Key**. The cloud client holds exactly one `(developerKey, customerKey)` pair → it can serve **only Roland**. OD API reads are **not ClinicNum-scoped** (no clinicNum param) — they return whatever the single key's DB contains. **Valley is intentionally NOT wired this phase** (its key, when added, must live under a distinct secret name and stays inert until a per-location slice). **Remediation:** per-location credentials → multiple cloud clients keyed by ClinicNum, or route per-location OD through the on-prem connector. Until then, only Roland is reachable via API. |

## ClinicNum scoping + audit (verified)
- Entitlement (`requireEntitledClinic`, via slot-markers): clinic **1 & 2 → 503** (pass
  entitlement, then hit the placeholder connector); clinic **999999 → 403 `CLINIC_FORBIDDEN`**.
- **audit_log rows written** for every PHI OD read (e.g. `READ patient id=1001 SUCCESS
  /api/opendental/patients/1001`, `READ appointment id=3 SUCCESS …/appointments/3`,
  `READ patient_appointments id=1001 SUCCESS`, range/calendar `id=null SUCCESS`); slot-marker
  attempts audited as ERROR. Non-PHI reference reads (providers/operatories/schedule/sync/test)
  are intentionally not audited.

## Recommended follow-ups (out of scope for Step 4)
1. **Fix OD client param names** to the real `api.opendental.com/api/v1` contract
   (appointments `dateStart`/`dateEnd`; patient search fields; drop/replace `updatedSince`,
   `search`, `searchType`). This converts the four **partial** + one **none** read into full.
2. **Surface mock fallback** — `getProviders/getOperatories/getCalendarAppointments` silently
   return mock on API error; that masks outages. Make failures explicit in non-dev.
3. **Per-location OD credentials** for the Roland+Valley split (multi-OD-database row).
4. **Real connector** for slot-markers (replace placeholder `connector_url`).
