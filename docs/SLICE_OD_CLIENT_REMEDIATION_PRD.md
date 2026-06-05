# Slice: OD Cloud Client Remediation — CC-ready PRD

_Drafted 2026-06-04. Port `backend/config/openDental.js` from its DB/MySQL-era shape to the real
`api.opendental.com` contract. Step 4 proved a single root cause: reads-by-id work (no params), but
param-filtered reads and ALL writes are DB-shaped and wrong, and mock fallbacks hide the read
failures. This slice fixes that. It is the **first real code change to ride the CI/CD pipeline**
(branch off `develop` → CI gate → staging) and it **gates Step 5** (booking can't go to Azure prod
until the API write path works). Does not threaten current LAN prod (today's live CareIN = calls /
commlogs / reads-by-id, not booking) — but see §4 (commlog path is untested)._

## Root cause (from Step 4 — `docs/OD_API_COVERAGE.md`)
The client speaks the old DB contract: integer `AptStatus`, DB-era query param names, silent mock
fallbacks. The real OD cloud API wants string enums and different param names. Symptoms proven on live
Roland OD: writes 400 on `AptStatus is invalid`; `searchPatients` 400 on `search`; date/range/calendar
reads return unfiltered 2012 data; `updatedSince` 400; mock data masks the read errors.

---

## STEP 0 — pull the authoritative OD API contract FIRST (do not guess against a live practice)
Using Beau's OD Developer account / OD API docs, capture the exact real-API contract and write it to
`docs/OD_API_CONTRACT.md`:
- **Patient search** params (what replaces `search` — e.g. `LName`/`FName`/`Phone`/`Birthdate`).
- **Appointment query/filter** params (the correct `dateStart`/`dateEnd` vs `startDate`/`endDate`, and
  whether range vs single-day differ).
- **`AptStatus` string enum values** (`Scheduled`, `Complete`, `Broken`, `UnschedList`, etc. — exact
  spellings) and which one represents a cancellation (Phase C 400 already implies `Broken`, not a
  numeric 8).
- **Appointment create/update** required field shapes (`POST`/`PUT /appointments`).
- The correct **recent-updates / changed-since** mechanism (what replaces `updatedSince`, or confirm
  none exists).
Report this reference and STOP for a quick confirm before editing code — every fix below keys off it.

## Scope — all in `backend/config/openDental.js` (+ its mapping helpers)
**1. Writes — `AptStatus` integer → string enum**
- `prepareAppointmentForOD` (~L733): `AptStatus: 1` → the string `"Scheduled"` (per contract).
- `cancelAppointment` (~L837): `AptStatus: 8` → the cancel enum (likely `"Broken"`); confirm it is an
  UPDATE that sets status, never a delete.
- `mapStatusToOD` (used by `updateAppointment` ~L820): emit string enums; ensure `mapAppointmentStatus`
  (reads, ~L392/L418/L1607) correctly maps the string enums back. Centralize the int↔string mapping in
  these two helpers so there are no stray integer literals.

**2. Reads — correct the param names + mappings**
- `searchPatients` (~L873, api path): replace the `search` param with the real OD patient-search
  param(s) from the contract.
- `getAppointmentsForDateRange` (~L359, sends `startDate/endDate`) and `getCalendarAppointments`
  (~L242, sends `dateStart/dateEnd`): standardize BOTH to the correct contract params so date filtering
  actually applies (no more unfiltered 2012 data).
- `getRecentPatientUpdates` (~L1469, `updatedSince`): fix to the correct param, or remove the call from
  `performSync` (~L215) if the API has no equivalent — don't leave a guaranteed 400 in the sync loop.
- Fix the **"Unknown Patient"** field mapping in appointment-list payloads and the
  **working-hours TZ/hour parse** (`getProviderWorkingHours` returned `{5,16}` — verify the real field).

**3. Safety — remove / hard-gate the mock fallbacks (prod hazard)**
- `getMockCalendarData`/`getMockProviders`/`getMockOperatories`/`getMockPatients`/`getMockAppointments`
  are returned on API error throughout (e.g. ~L233/263/275/355/931/977/1118/1140/1176/1204/1241).
- In **api mode against a real practice, an API error MUST surface as an error** — never silently
  return mock providers/appointments/patients (a real office could be shown phantom data). Remove the
  api-mode fallbacks, or hard-gate them behind an explicit dev-only flag (e.g.
  `OPENDENTAL_ALLOW_MOCK==='true'` AND `NODE_ENV!=='production'`). DB-mode (`*FromDB`) paths untouched.

**4. Validate the commlog-write path (the live MVP's actual write — currently untested)**
- Locate the commlog write used by the retell-tools path (tenant-exempt; writes call summaries to OD).
  Confirm it targets the real OD commlog create endpoint with the correct field shape; fix if DB-era.
  This is what offices rely on TODAY — confirm it works or document the gap explicitly.

## Verification (the gate)
- **Unit:** enum mapping (book→`Scheduled`, cancel→`Broken`, status round-trip), corrected param
  construction; mock fallback does NOT fire in api mode on error (it throws).
- **Pipeline:** land on `feature/od-client-port` off `develop` → CI build-test gate green → auto-deploy
  to staging (this is the pipeline's first real feature run).
- **Live re-validation on staging (controlled, Beau's go + designated values — same protocol as Phase C):**
  - Reads: `searchPatients` for a known Roland patient → real match (not empty/mock);
    calendar/date-range for a CURRENT date → real, correctly-filtered appts (not 2012, not mock).
  - Write cycle: re-run `book → verify → update → cancel` on **PatNum 1 (*Patient Test)**,
    Op 9, ProvNum 1, a far-future Sunday, note `CAREIN STEP4 RETEST — DELETE` → now expect ALL GREEN;
    end cancelled, nothing left active.
  - Confirm an induced API error surfaces (no mock masking).
- Update `docs/OD_API_COVERAGE.md`: move the remediated rows to **full**; note what (if anything) the
  API still can't do.

## Out of scope (separate slices — name, don't build here)
- `slot-markers` (genuinely connector-only → Phase-2 connector agent).
- Per-location / multi-OD-database customer keys (Valley) — its own slice.
- Module-entitlement, Slice 4b Retell — unrelated parked slices.

## Handling / risk
- Branch `feature/od-client-port` off `develop`; PR → pipeline → staging. **Do not touch `main`/LAN
  prod.** Live-OD writes ONLY via the controlled protocol with Beau's explicit go (same as Phase C).
- This edits the SAME `config/openDental.js` that LAN prod runs, but only on a branch → staging; prod
  is unaffected until a future `develop→main` promotion. Flag at that promotion: the mock-removal
  changes prod error behavior (errors surface instead of silently mocking — desired) and the enum/param
  fixes change OD call behavior — so validate thoroughly on staging before that promotion.
- STEP 0 reference confirm → code → CI/staging → controlled re-validation. Report at the STEP 0 stop.
