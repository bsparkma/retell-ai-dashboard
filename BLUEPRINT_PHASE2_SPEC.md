# CareIN AI — Blueprint Specification
## Phase 2: Scheduling + Multi-PMS Support
**Status:** SAGE APPROVED — Build may begin  
**Date:** April 10, 2026  
**Version:** 1.0  

---

## QUICK REFERENCE — BUILD SEQUENCE

Build in this order. Each item depends on the prior.

1. **Database migrations** — create tables from SCHEMA section
2. **PMSAdapter interface** — TypeScript interface definition
3. **OpenDentalAdapter** — wraps existing OD connection; implements PMSAdapter
4. **Core scheduling engine** — `runSlotAlgorithm()` shared function
5. **`/api/scheduling` routes** — slots + pending bookings CRUD
6. **Frontend: S-05 Pending Bookings screen**
7. **Frontend: S-01 dashboard additions** (pending bookings widget + schedule summary)
8. **Frontend: S-06 office config additions** (PMS section, providers)
9. **Retell tool call definitions** — configure check_availability + create_pending_booking in Retell dashboard
10. **Pending booking expiry job** — 15-min interval
11. **Emergency notification service** (email/SMS for after-hours emergency bookings)
12. **[GATED] DentrixAdapter** — wait for PARSE to verify API docs
13. **[GATED] EagleSoftAdapter** — wait for PARSE to verify ODBC schema

---

## PART 1: BUSINESS DECISION REGISTER

*Owner: RULE | Every business decision explicitly stated*

### 1.1 Appointment Types and Durations

| ID | Decision | Duration | Provider |
|----|----------|----------|---------|
| R-001 | New adult, last cleaning >12 months → exam + X-rays ONLY (no cleaning) | 60 min | Doctor |
| R-002 | New adult, last cleaning ≤12 months, on recall → exam + X-rays + cleaning | 90 min | Hygienist |
| R-003 | New child (<18) → exam + X-rays + cleaning | 60 min | Hygienist |
| R-004 | Existing adult recall | 60 min | Hygienist |
| R-005 | Existing child recall | 30 min | Hygienist |
| R-006 | Emergency | 60 min | Doctor |
| R-007 | Ortho adjustment | 30 min | Doctor |
| R-008 | New patient exam only | 60 min | Doctor |
| R-009 | Restorative/treatment plan procedures → Phase 2B only, duration from PMS | — | Per procedure |

### 1.2 Patient Classification

| ID | Decision |
|----|----------|
| R-010 | New patient = not found in PMS by phone/name/DOB |
| R-011 | Match confidence <0.7 → treat as new patient; front desk reconciles on arrival |
| R-012 | New vs. existing determines appointment type options only — not fees |

### 1.3 Two-Question Scheduling Script

| ID | Decision |
|----|----------|
| R-013 | Non-emergency calls must ask Q1 (morning/afternoon) then Q2 (early/late week) before offering slots |
| R-014 | Agent offers exactly 2 slot options; if patient rejects both, re-run preferences |
| R-015 | Emergency: offer single earliest emergency slot first; if rejected, run two-question script |
| R-016 | Slots only offered on days when provider schedule exists in PMS AND CareIN Available block exists |

### 1.4 Availability Rules

| ID | Decision |
|----|----------|
| R-017 | Slot bookable only if: (a) CareIN Available block exists, (b) no appointment conflicts, (c) provider scheduled |
| R-018 | Minimum slot granularity: 15 minutes, always on :00/:15/:30/:45 |
| R-019 | Phase 2A: no PMS write — creates PendingBooking record only |
| R-020 | Front desk confirms pending bookings during business hours; after-hours emergency triggers alert |
| R-021 | PendingBooking expires after 24 hours if unconfirmed; surfaces as "expired — contact patient" |
| R-022 | Availability is per-office, per-operatory |

### 1.5 Provider and Operatory Routing

| ID | Decision |
|----|----------|
| R-023 | Hygiene appointments → hygienist only |
| R-024 | Doctor appointments → doctor only |
| R-025 | Default: next available qualified provider; honor stated preference |
| R-026–R-027 | Nitrous/scanner assignment deferred to front desk (Phase 2A) |
| R-028 | Provider roster configurable per office; Roland = 3 doctors, 2 hygienists |

### 1.6 Multi-PMS Architecture

| ID | Decision |
|----|----------|
| R-029 | Phase 2 supports: Open Dental, Dentrix, Eaglesoft |
| R-030 | PMSAdapter interface pattern — scheduling engine is PMS-agnostic |
| R-031 | OD: direct MySQL (LAN) OR eConnector (cloud), per office config |
| R-032 | Dentrix: Enterprise Web API (OAuth 2.0) — [ASSUMPTION: API current URL/scope] |
| R-033 | Eaglesoft: ODBC via node-odbc — [ASSUMPTION: table schema] |
| R-034 | Phase 2A: read-only from PMS. Phase 2B: PMS write |
| R-035 | Patient PII not stored permanently; PMS is source of truth |

### 1.7 Office Configuration

| ID | Decision |
|----|----------|
| R-036 | Office record: name, timezone, PMS type, PMS config, provider roster, Retell agent IDs, phone numbers, business hours, emergency contact |
| R-037 | All times stored UTC; display converted to office local timezone |
| R-038 | Business hours are default floor; CareIN Available blocks are the actual booking gate |
| R-039 | New office onboarding: Office record + CareIN blockout type (OD) + Retell agent + phone number |

### 1.8 Pending Booking Workflow

| ID | Decision |
|----|----------|
| R-040 | PendingBooking fields: patient name/phone/DOB, appt type/duration/datetime, provider preference, PMS patient ID, new patient flag, emergency flag, status, timestamps |
| R-041 | Status machine: pending → confirmed | expired | cancelled |
| R-042 | Front desk: (1) enter in PMS manually, (2) click Confirm in CareIN dashboard |
| R-043 | Dashboard shows: patient name, appt type, preferred time, time since created, expiry countdown, Confirm/Cancel actions |

### 1.9 Phase Scope Boundaries

| ID | Decision |
|----|----------|
| R-046 | Phase 2A: read PMS, 2-question script, PendingBooking, pending bookings dashboard, commlog |
| R-047 | Phase 2B (not this Blueprint): direct PMS write, confirmation SMS, multi-location search |
| R-048 | Insurance, fees, treatment planning: separate modules, not Phase 2 |

---

## PART 2: JOURNEY MAPS

*Owner: FLOW*

### Journey 1: Existing Patient — Scheduling

```
Call → identify scheduling intent → confirm existing patient → PMS lookup
→ appointment type selection → [emergency detected? → J3]
→ capture provider preference if stated
→ TWO-QUESTION SCRIPT (Q1: morning/afternoon, Q2: early/late week)
→ slot search → offer 2 options
→ patient selects → confirm → create PendingBooking
→ "confirmation within 30 minutes" message
→ commlog to PMS
```

**Key branches:**
- PMS match <0.7 confidence → treat as new patient → J2
- No slots available → transfer or offer next available date
- Patient rejects both options → re-run two-question script

### Journey 2: New Patient — Scheduling

```
Call → new patient declaration
→ "What type of appointment?" 
→ if cleaning: "When was your last cleaning?"
   → >12 months → 60-min exam only (doctor) — explicitly no cleaning today
   → ≤12 months → 90-min hygiene full (hygienist)
→ if child → 60-min pediatric (hygienist)
→ capture patient info (name, DOB, phone)
→ TWO-QUESTION SCRIPT
→ slot search → PendingBooking (new_patient_flag=true)
→ "front desk will also collect additional info before your visit"
```

### Journey 3: Emergency

```
Call → emergency keywords detected or stated
→ severity check: "Are you in severe pain right now?"
→ FIRST: offer single earliest emergency slot today
   → patient accepts → PendingBooking (emergency_flag=true, priority=urgent)
   → no slots today → check next 2 days
   → patient rejects → run TWO-QUESTION SCRIPT for nearest available emergency slot
→ if no slots in 3 days → transfer to front desk
→ commlog: CommType=4 (emergency)
→ if after-hours + emergency → trigger notification to emergency contact
```

### Journey 4: Cancel / Reschedule

```
Call → cancel/reschedule intent
→ patient lookup
→ "date and time of your appointment?"
→ if PendingBooking found (unconfirmed) → cancel/reschedule directly
→ if appointment confirmed in PMS → cannot cancel via agent → commlog note for front desk
→ if rescheduling → create new PendingBooking after cancelling old one
```

### Journey 5: Owner — Dashboard Morning Workflow

```
Login → S-01 Today view
→ Check Pending Bookings count
→ Work through each: enter in PMS → click Confirm
→ Check expired bookings → call patients back
→ Navigate to S-02 Availability Manager → adjust green blocks as needed
→ Review calls for unresolved items
```

### Journey 6: Owner — Office Configuration

```
Settings → S-06 Office Config
→ Edit hours, timezone, emergency contact
→ Manage provider roster (add/edit/deactivate)
→ PMS connection: select type → enter config → Test Connection
→ Retell agent assignment per phone number
→ Save → system validates and saves
```

---

## PART 3: SCREEN INVENTORY

*Owner: SCREEN*

### S-01: Dashboard Home (Today View)
**Route:** `/dashboard`  
**3-column layout:**

**Col 1 — Pending Bookings Widget**
- Count badge, list of pending bookings (patient, appt type, preferred time, expiry countdown)
- Confirm (green) + Cancel (outlined red) actions per row
- "View all →" to S-05

**Col 2 — Today's Schedule Summary**
- Mini week heatmap (green = CareIN blocks available, gray = no blocks, blue = booked)
- Counts: open CareIN slots today, appointments today, expired pending (if any)

**Col 3 — Recent Calls**
- Last 5 calls: name/number, outcome badge, time
- "View all →" to S-03

**States:** Loading skeleton | Empty (nothing pending) | PMS offline banner

---

### S-02: Availability Manager
**Route:** `/availability`  
*(Built from CURSOR_AVAILABILITY_MANAGER.md — Phase 2 adds multi-office support via officeId param)*

**Phase 2 additions:**
- Office selector (if multi-office) in header
- All API calls include `officeId`
- Pending Booking holds shown as green dashed blocks (distinct from solid CareIN Available blocks)

---

### S-03: Calls List
**Route:** `/calls`  
*(Phase 1 — no changes in Phase 2)*

---

### S-04: Call Detail
**Route:** `/calls/:callId`  
**Phase 2 additions:**
- Pending Booking panel (if booking was created from this call): shows booking status + Confirm/Cancel
- "Appointment type requested" + "Preferred time stated" fields

---

### S-05: Pending Bookings List
**Route:** `/pending`

**Filter tabs:** Pending | Confirmed | Expired | Cancelled

**Pending tab columns:** Patient name | Appt type | Preferred datetime | Provider preference | New patient | Emergency | Created | Expires In (red if <2h) | Confirm + Cancel + View Call

**Confirm flow modal:**
"Before confirming, please enter the appointment in [PMS name]. Have you added it?"
→ Yes → mark confirmed
→ Not Yet → dismiss (no status change)

**Bulk action:** "Confirm all" for morning rounds

---

### S-06: Settings — Office Configuration
**Route:** `/settings/office`

**Sections:**
1. Office Info (name, address, phone, timezone)
2. Business Hours (day-by-day open/close or Closed)
3. Provider Roster (table: name, role badge, active toggle; add/edit/deactivate)
4. PMS Connection:
   - Type selector → dynamic config fields per PMS
   - OD: MySQL host/port/db/user/pass OR eConnector URL + key
   - Dentrix: API URL + client ID + secret
   - Eaglesoft: ODBC DSN + credentials
   - "Test Connection" → inline result + last successful sync timestamp
5. Retell Integration (agent ID, phone number mapping, webhook URL read-only)
6. Emergency Contact (name, phone, email)

---

### Shared Components
| Component | Used on |
|-----------|---------|
| PendingBookingCard | S-01, S-05 |
| CallSummaryRow | S-01, S-03 |
| AvailabilityBlock | S-02 |
| ProviderColumnHeader | S-02 |
| ConnectionStatusBadge | S-01 sidebar, S-06 |
| OutcomeBadge | S-01, S-03, S-04 |

---

## PART 4: LIFECYCLE MAP

*Owner: FUNNEL*

```
PATIENT CALL
  └─► Intent classification
        └─► Scheduling journeys (J1/J2/J3/J4)
              └─► PendingBooking created (or commlog-only)
                    └─► STATUS: pending (24h TTL)
                          ├─► Front desk confirms → STATUS: confirmed
                          │     └─► Patient arrives → appointment complete
                          ├─► 24h passes → STATUS: expired
                          │     └─► S-01 alert → front desk calls patient
                          │           └─► Rebooked → new PendingBooking
                          └─► Patient cancels → STATUS: cancelled

OWNER DAILY OPS (S-01 morning rounds → S-02 availability → S-03 call review)
  └─► All screens connected, no dead ends
  └─► Socket.IO real-time updates across all screens

SCREEN CONNECTIONS (no orphans):
  S-01 ↔ S-02, S-01 → S-03, S-01 → S-04, S-01 ↔ S-05
  S-05 → S-04, S-04 ↔ S-05
  All → S-06 (settings nav)
```

---

## PART 5: DATA MODEL

*Owner: SCHEMA*

### Database: CareIN PostgreSQL (extend existing)

```sql
-- NEW TABLE: offices
CREATE TABLE offices (
  office_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             VARCHAR(100) NOT NULL,
  address          TEXT,
  phone_primary    VARCHAR(20),
  timezone         VARCHAR(50) NOT NULL DEFAULT 'America/Chicago',
  pms_type         VARCHAR(20) NOT NULL CHECK (pms_type IN ('open_dental','dentrix','eaglesoft')),
  pms_config       JSONB NOT NULL,           -- encrypted at rest; PMS-specific params
  business_hours   JSONB NOT NULL,           -- { "mon":{"open":"08:00","close":"17:00"}, ... }
  emergency_contact_name    VARCHAR(100),
  emergency_contact_phone   VARCHAR(20),
  emergency_contact_email   VARCHAR(150),
  is_active        BOOLEAN DEFAULT true,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- NEW TABLE: providers
CREATE TABLE providers (
  provider_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id        UUID NOT NULL REFERENCES offices(office_id),
  pms_provider_id  VARCHAR(50) NOT NULL,
  first_name       VARCHAR(50) NOT NULL,
  last_name        VARCHAR(50) NOT NULL,
  abbreviation     VARCHAR(10),
  role             VARCHAR(20) NOT NULL CHECK (role IN ('doctor','hygienist')),
  is_active        BOOLEAN DEFAULT true,
  UNIQUE(office_id, pms_provider_id)
);

-- NEW TABLE: appointment_type_catalog
CREATE TABLE appointment_type_catalog (
  type_key         VARCHAR(50) PRIMARY KEY,
  display_name     VARCHAR(100) NOT NULL,
  duration_minutes INTEGER NOT NULL,
  provider_role    VARCHAR(20) NOT NULL CHECK (provider_role IN ('doctor','hygienist','either')),
  patient_class    VARCHAR(20) NOT NULL CHECK (patient_class IN ('new','existing','either')),
  is_emergency     BOOLEAN DEFAULT false
);

-- SEED DATA:
INSERT INTO appointment_type_catalog VALUES
  ('new_patient_exam_xray',    'New Patient Exam + X-Rays',  60, 'doctor',    'new',      false),
  ('new_patient_hygiene_full', 'New Patient Hygiene (Full)', 90, 'hygienist', 'new',      false),
  ('new_patient_pediatric',    'New Patient Pediatric',      60, 'hygienist', 'new',      false),
  ('hygiene_recall_adult',     'Adult Recall Cleaning',      60, 'hygienist', 'existing', false),
  ('hygiene_recall_child',     'Child Recall Cleaning',      30, 'hygienist', 'existing', false),
  ('exam_only',                'Exam Only',                  60, 'doctor',    'either',   false),
  ('emergency',                'Emergency Exam',             60, 'doctor',    'either',   true ),
  ('ortho_adjustment',         'Ortho Adjustment',           30, 'doctor',    'existing', false);

-- NEW TABLE: pending_bookings
CREATE TABLE pending_bookings (
  booking_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id            UUID NOT NULL REFERENCES offices(office_id),
  call_id              VARCHAR(100),
  patient_first_name   VARCHAR(50) NOT NULL,
  patient_last_name    VARCHAR(50) NOT NULL,
  patient_phone        VARCHAR(20) NOT NULL,
  patient_dob          DATE,
  pms_patient_id       VARCHAR(50),
  patient_is_new       BOOLEAN DEFAULT false,
  appointment_type     VARCHAR(50) NOT NULL REFERENCES appointment_type_catalog(type_key),
  duration_minutes     INTEGER NOT NULL,
  preferred_datetime   TIMESTAMPTZ NOT NULL,   -- stored UTC
  provider_id          UUID REFERENCES providers(provider_id),
  emergency_flag       BOOLEAN DEFAULT false,
  status               VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending','confirmed','expired','cancelled')),
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  expires_at           TIMESTAMPTZ NOT NULL,   -- = created_at + interval '24 hours'
  confirmed_at         TIMESTAMPTZ,
  confirmed_by         VARCHAR(100),
  cancelled_at         TIMESTAMPTZ,
  cancelled_reason     VARCHAR(200)
);

CREATE INDEX idx_pending_bookings_office_status ON pending_bookings(office_id, status);
CREATE INDEX idx_pending_bookings_expires_at ON pending_bookings(expires_at) WHERE status = 'pending';

-- NEW TABLE: pms_sync_log
CREATE TABLE pms_sync_log (
  log_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id        UUID NOT NULL REFERENCES offices(office_id),
  sync_type        VARCHAR(30) NOT NULL,
  status           VARCHAR(10) NOT NULL CHECK (status IN ('success','error','partial')),
  error_message    TEXT,
  records_affected INTEGER,
  duration_ms      INTEGER,
  synced_at        TIMESTAMPTZ DEFAULT NOW()
);

-- NEW TABLE: new_patient_temp_records
CREATE TABLE new_patient_temp_records (
  temp_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  office_id        UUID NOT NULL REFERENCES offices(office_id),
  booking_id       UUID REFERENCES pending_bookings(booking_id),
  first_name       VARCHAR(50) NOT NULL,
  last_name        VARCHAR(50) NOT NULL,
  phone            VARCHAR(20) NOT NULL,
  dob              DATE,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  chart_created    BOOLEAN DEFAULT false,
  chart_created_at TIMESTAMPTZ,
  pms_patient_id   VARCHAR(50)
);

-- ALTER existing call_records table (add Phase 2 columns):
ALTER TABLE call_records
  ADD COLUMN IF NOT EXISTS scheduling_intent        BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS appointment_type_requested VARCHAR(50),
  ADD COLUMN IF NOT EXISTS preferred_datetime        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_preference_id    UUID,
  ADD COLUMN IF NOT EXISTS booking_id                UUID,
  ADD COLUMN IF NOT EXISTS patient_is_new            BOOLEAN,
  ADD COLUMN IF NOT EXISTS emergency_flag            BOOLEAN DEFAULT false;
```

### Known Constraint (Phase 2B)
An `operatories` table will be required in Phase 2B for direct PMS write with operatory assignment. For Phase 2A (read-only), operatory is handled by OD's blockout Op column and is not tracked in CareIN's schema.

---

## PART 6: API SURFACE

*Owner: WIRE*

### 6.1 PMSAdapter Interface

```typescript
interface PMSAdapter {
  testConnection(): Promise<{ success: boolean; providerCount: number; error?: string }>;
  
  searchPatients(query: {
    phone?: string; firstName?: string; lastName?: string; dob?: string;
  }): Promise<Array<{
    pmsPatientId: string; firstName: string; lastName: string;
    phone: string; dob?: string; confidence: number;
  }>>;
  
  getProviders(): Promise<Array<{
    pmsProviderId: string; firstName: string; lastName: string;
    abbreviation: string; isHygienist: boolean; isActive: boolean;
  }>>;
  
  getProviderSchedule(params: {
    providerIds: string[]; startDate: string; endDate: string;
  }): Promise<Array<{
    pmsProviderId: string; date: string;
    startTime: string; stopTime: string; isWorking: boolean;
  }>>;
  
  getAppointments(params: {
    providerIds: string[]; startDate: string; endDate: string;
  }): Promise<Array<{
    pmsAptId: string; pmsProviderId: string; patientName: string;
    startDatetimeUTC: string; durationMinutes: number; status: string;
  }>>;
  
  // Optional — OD only
  getCareInBlocks?(params: { startDate: string; endDate: string; }): Promise<Array<{
    blockId: string; pmsProviderId: string; date: string;
    startTime: string; stopTime: string;
  }>>;
  
  writeCommlog(params: {
    pmsPatientId: string; note: string; commType: number; mode: number;
  }): Promise<{ success: boolean; commlogId?: string; error?: string }>;
}
```

**Implementations:**
- `OpenDentalAdapter` — wraps existing MySQL pool / eConnector
- `DentrixAdapter` — [GATED: ASSUMPTION on API URL/auth]
- `EagleSoftAdapter` — [GATED: ASSUMPTION on ODBC table schema]

---

### 6.2 Scheduling Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/scheduling/slots` | Get available slots (called by Retell tool) |
| POST | `/api/scheduling/pending-bookings` | Create pending booking (called by Retell tool) |
| GET | `/api/scheduling/pending-bookings` | List pending bookings for dashboard |
| POST | `/api/scheduling/pending-bookings/:id/confirm` | Confirm a booking |
| POST | `/api/scheduling/pending-bookings/:id/cancel` | Cancel a booking |

**GET /api/scheduling/slots params:**
`officeId, appointmentType, date, preferMorning, preferEarlyWeek, providerPreference`

**Response:**
```json
{
  "officeId": "uuid",
  "date": "2026-04-10",
  "requestedAppointmentType": "hygiene_recall_adult",
  "requestedDuration": 60,
  "requiredProviderRole": "hygienist",
  "availableSlots": [
    {
      "slotId": "uuid",
      "providerId": "uuid",
      "providerName": "Sarah H.",
      "startDatetimeLocal": "2026-04-10T09:00:00",
      "endDatetimeLocal": "2026-04-10T10:00:00",
      "displayText": "Friday April 10th at 9:00 AM with Sarah",
      "score": 0.95
    }
  ],
  "noSlotsReason": null,
  "officeTimezone": "America/Chicago"
}
```

---

### 6.3 Office Config Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/offices` | List offices |
| GET | `/api/offices/:id` | Office detail |
| PUT | `/api/offices/:id` | Update office config |
| POST | `/api/offices/:id/test-connection` | Run PMSAdapter.testConnection() |
| GET | `/api/offices/:id/providers` | Sync + return providers from PMS |
| PUT | `/api/offices/:id/providers/:providerId` | Update local provider record |

---

### 6.4 Retell Tool Call Definitions

Configure these in the Retell agent's tool settings.

**Tool: check_availability**
```json
{
  "name": "check_availability",
  "url": "https://carein-do.flamingketchup.com/api/scheduling/slots",
  "method": "GET",
  "parameters": {
    "appointment_type": {
      "type": "string",
      "enum": ["new_patient_exam_xray","new_patient_hygiene_full","new_patient_pediatric","hygiene_recall_adult","hygiene_recall_child","exam_only","emergency","ortho_adjustment"]
    },
    "prefer_morning": { "type": "boolean" },
    "prefer_early_week": { "type": "boolean" },
    "provider_preference": { "type": "string" }
  }
}
```

**Tool: create_pending_booking**
```json
{
  "name": "create_pending_booking",
  "url": "https://carein-do.flamingketchup.com/api/scheduling/pending-bookings",
  "method": "POST",
  "parameters": {
    "slot_id": { "type": "string" },
    "patient_first_name": { "type": "string" },
    "patient_last_name": { "type": "string" },
    "patient_phone": { "type": "string" },
    "patient_dob": { "type": "string" },
    "pms_patient_id": { "type": "string" },
    "patient_is_new": { "type": "boolean" },
    "emergency_flag": { "type": "boolean" }
  }
}
```

---

### 6.5 Shared Functions

```javascript
// All of these go in backend/utils/scheduling.js

resolveOfficeTimezone(officeId)           // → "America/Chicago"
utcToOfficeLocal(datetime, timezone)      // → "2026-04-10T09:00:00"
buildDisplayText(provider, datetime, tz)  // → "Friday April 10th at 9:00 AM with Sarah"
getPMSAdapter(office)                     // → PMSAdapter instance for office.pms_type
matchPatientWithConfidence(query, results)// → { patient, confidence }
buildCommlogNote(callData, bookingData)   // → formatted commlog string
runSlotAlgorithm(schedule, appointments, careInBlocks, duration, preferences)
// → scored, sorted array of available slots
```

---

### 6.6 Background Jobs

**Pending booking expiry (every 15 minutes):**
```javascript
// In server.js startup, after routes registered:
setInterval(async () => {
  const expired = await db.query(`
    UPDATE pending_bookings 
    SET status = 'expired' 
    WHERE status = 'pending' AND expires_at < NOW()
    RETURNING booking_id, office_id, patient_first_name, patient_last_name
  `);
  if (expired.rows.length > 0) {
    io.emit('bookings:expired', { count: expired.rows.length, bookings: expired.rows });
  }
}, 15 * 60 * 1000);
```

**Emergency after-hours notification:**
```javascript
// In POST /api/scheduling/pending-bookings route, after booking created:
if (booking.emergency_flag) {
  const office = await getOffice(booking.office_id);
  if (isOutsideBusinessHours(new Date(), office)) {
    await sendEmergencyNotification(office.emergency_contact_email, office.emergency_contact_phone, booking);
  }
}
```

---

## PART 7: BREAKOUT AUDIT TRAIL

| Breakout | Verdict | Notes |
|----------|---------|-------|
| Journey Completeness | CONDITIONAL | Provider preference capture added to J1 as known constraint — handled by agent NLU |
| Screen-Rule Alignment | PASS | All business rules map to defined screen elements |
| Schema Integrity | CONDITIONAL | Operatory table deferred to Phase 2B — non-blocking |
| API Completeness | PASS | All screen requirements and Retell tool calls have defined endpoints |

---

## PART 8: OPEN ITEMS BEFORE GATED BUILDS

| Item | Blocks | Owner |
|------|--------|-------|
| Verify current Dentrix Enterprise API URL, auth flow, and appointment/provider/schedule endpoints | DentrixAdapter build | PARSE → report back |
| Verify Eaglesoft ODBC table names for provider, schedule, appointment | EagleSoftAdapter build | PARSE → report back |
| Confirm node-odbc compatible ODBC drivers available on Roland machine | EagleSoftAdapter deployment | REED → ask Beau |
| Confirm Fort Smith provider roster when that office is onboarded | Fort Smith office record | Beau at onboarding |

---

## PART 9: KNOWN CONSTRAINTS (Phase 3 items)

| Constraint | Description |
|-----------|-------------|
| No direct PMS write | Front desk must manually enter confirmed bookings in PMS (Phase 2B) |
| No automated confirmation SMS | Patient receives verbal confirmation only; front desk sends text manually (Phase 2B) |
| No multi-location slot search | Agent cannot say "Fort Smith has earlier availability" (Phase 2B) |
| No custom appointment types via UI | Catalog seeded; new types require dev deployment (Phase 3) |
| No recurring availability block templates | Staff sets blocks day-by-day (Phase 3) |

---

## SAGE RULING

**Status: APPROVED — Build may begin on OD-first build sequence.**

Dentrix and Eaglesoft adapters are gated pending PARSE verification of API documentation.

No blocking issues in this Blueprint. Two conditional breakouts are documented as known constraints. The specification is complete enough that a Build team can execute against it without asking architectural questions.

*Blueprint Specification v1.0 — CareIN AI Phase 2*  
*SAGE approved April 10, 2026*
