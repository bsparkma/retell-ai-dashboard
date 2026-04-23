# Cursor Prompt — CareIN Availability Manager (OD Blockout Integration)

## CONTEXT
This app is CareIN AI — a dental practice dashboard built with Node.js/Express backend
and a React/Next.js frontend (in /new-dashboard). It connects directly to an Open Dental
MySQL database. We are building a two-way availability system where:

1. Staff can paint "CareIN AI Available" time blocks in Open Dental's native schedule view
2. Those same blocks appear in the CareIN dashboard calendar (green blocks)
3. Staff can also add/remove blocks from the CareIN dashboard (writes back to OD)
4. The Retell AI voice agent calls a `check_availability` API endpoint to get real open slots
5. 3 providers + 2 hygienists at one office location

The OD database uses these tables:
- `blockouttype` — defines named blockout categories (Lunch, Meeting, etc.)
- `blockout` — actual blockout records (date, start/stop time, operatory, type)
- `appointment` — booked appointments (read-only overlay)
- `schedule` — when each provider is working
- `scheduleop` — operatory assignments per schedule
- `provider` — provider list

---

## WHAT TO BUILD

### STEP 1: One-time Setup Endpoint — Create CareIN Blockout Type

In `backend/config/openDental.js`, add a new method `ensureCareInBlockoutType()`:

```
- Query: SELECT BlockoutTypeNum, ItemColor FROM blockouttype WHERE BlockoutType = 'CareIN AI Available'
- If not found: INSERT INTO blockouttype (BlockoutType, ItemColor, IsHidden, BooleanIsRestricted)
  VALUES ('CareIN AI Available', 16711680, 0, 0)
  (16711680 is bright green in OD's integer color format: RGB 0,255,0)
- Return the BlockoutTypeNum (store it in memory / env for use in other queries)
- This should be called once on server startup in server.js
- Log: ✅ CareIN blockout type ready (ID: X)
```

Also add a method `getCareInBlockoutTypeId()` that returns the cached ID.

---

### STEP 2: Backend API — Availability Routes

Create a new file `backend/routes/availability.js` with these endpoints:

#### GET /api/availability/slots
Returns all time slots for a given date range, broken out by provider/hygienist.
Query params: `startDate` (YYYY-MM-DD), `endDate` (YYYY-MM-DD), `providerNums` (comma-separated, optional)

Response shape:
```json
{
  "date": "2026-04-10",
  "providers": [
    {
      "providerNum": 1,
      "abbr": "DrS",
      "fname": "Beau",
      "lname": "Sparkman",
      "isHygienist": false,
      "schedule": { "startTime": "08:00", "stopTime": "17:00", "isWorking": true },
      "appointments": [
        { "aptNum": 123, "startTime": "09:00", "stopTime": "10:00", "patientName": "John Smith", "aptStatus": 1 }
      ],
      "careInBlocks": [
        { "blockoutNum": 456, "startTime": "08:00", "stopTime": "12:00" },
        { "blockoutNum": 457, "startTime": "13:00", "stopTime": "17:00" }
      ]
    }
  ]
}
```

SQL for appointments:
```sql
SELECT a.AptNum, a.AptDateTime, a.Pattern, a.ProvNum, a.Op,
       CONCAT(p.LName, ', ', p.FName) as patientName, a.AptStatus
FROM appointment a
JOIN patient p ON a.PatNum = p.PatNum
WHERE DATE(a.AptDateTime) BETWEEN ? AND ?
  AND a.AptStatus NOT IN (5, 6)  -- exclude deleted/missed
  AND a.ProvNum IN (?)
ORDER BY a.AptDateTime
```

SQL for CareIN blocks:
```sql
SELECT b.BlockoutNum, b.SchedDate, b.StartTime, b.StopTime, b.Op, b.Note
FROM blockout b
WHERE b.SchedDate BETWEEN ? AND ?
  AND b.BlockoutType = ?  -- CareIN blockout type ID
ORDER BY b.SchedDate, b.StartTime
```

SQL for provider schedule:
```sql
SELECT s.SchedNum, s.SchedDate, s.StartTime, s.StopTime, s.ProvNum, s.SchedType
FROM schedule s
WHERE s.SchedDate BETWEEN ? AND ?
  AND s.ProvNum IN (?)
  AND s.SchedType = 1  -- provider schedule type
```

---

#### POST /api/availability/blocks
Create a new CareIN Available block in OD.

Request body:
```json
{
  "providerNum": 1,
  "date": "2026-04-10",
  "startTime": "09:00",
  "stopTime": "12:00",
  "operatoryNum": 0,
  "note": "CareIN AI Available"
}
```

SQL:
```sql
INSERT INTO blockout (BlockoutType, SchedDate, StartTime, StopTime, Op, Note, DateTStamp)
VALUES (?, ?, ?, ?, ?, 'CareIN AI Available', NOW())
```

Return: `{ "blockoutNum": 789, "success": true }`

---

#### DELETE /api/availability/blocks/:blockoutNum
Delete a CareIN block. Only allow deletion of blocks with the CareIN blockout type — never other types.

```sql
DELETE FROM blockout WHERE BlockoutNum = ? AND BlockoutType = ?
```

Return: `{ "success": true }`

---

#### GET /api/availability/open-slots
This is the endpoint the Retell AI agent calls via tool. Returns specific bookable time slots.

Query params:
- `date` (YYYY-MM-DD) — specific date requested
- `duration` (minutes) — appointment duration needed (30, 60, 90)
- `appointmentType` (string) — e.g., "new_patient_exam", "cleaning", "emergency"
- `preferMorning` (boolean) — from 2-question script answer
- `preferEarlyWeek` (boolean) — from 2-question script answer

Logic:
1. Get provider schedule for the date (who is working)
2. Get existing appointments for those providers
3. Get CareIN Available blocks for those providers
4. For each CareIN Available block: subtract existing appointment times
5. Generate time slots of `duration` minutes within remaining open windows
6. Filter by morning/afternoon preference if provided
7. Return top 4 slots (2 options for each of 2 providers, or best matches)

Response:
```json
{
  "date": "2026-04-10",
  "availableSlots": [
    {
      "providerNum": 1,
      "providerName": "Dr. Sparkman",
      "startTime": "09:00",
      "endTime": "10:00",
      "displayText": "Tuesday April 10th at 9:00 AM with Dr. Sparkman"
    },
    {
      "providerNum": 3,
      "providerName": "Sarah (Hygiene)",
      "startTime": "14:00",
      "endTime": "14:30",
      "displayText": "Tuesday April 10th at 2:00 PM with Sarah"
    }
  ],
  "noSlotsReason": null
}
```

If no slots available, return `noSlotsReason: "no_carein_blocks_set"` or `"fully_booked"` or `"provider_not_working"`.

---

#### GET /api/availability/providers
Returns the list of providers and hygienists for the UI column headers.

```sql
SELECT ProvNum, Abbr, FName, LName, IsHygienist, IsHidden
FROM provider
WHERE IsHidden = 0
ORDER BY ItemOrder
```

Return with a flag for hygienist vs. provider so the UI can render them in correct column groups.

---

### STEP 3: Register the Route

In `backend/server.js`:
```javascript
const availabilityRouter = require('./routes/availability');
app.use('/api/availability', availabilityRouter);
```

Also in the startup sequence, after unifiedCallStore.initialize(), call:
```javascript
const openDentalService = require('./config/openDental');
if (openDentalService.isEnabled()) {
  openDentalService.ensureCareInBlockoutType().catch(err =>
    console.error('CareIN blockout type setup error:', err.message)
  );
}
```

---

### STEP 4: Frontend — Availability Manager Page

Create a new page in `new-dashboard/src/app/availability/page.tsx` (or .jsx if not TypeScript).

#### Layout:
- Full-width page
- Header: "Availability Manager" | Date navigation (← Week → ) | "Today" button | Sync indicator ("Last synced: 2m ago")
- 5 columns: one per provider/hygienist (fetched from /api/availability/providers)
- Hygienists grouped on the right with a subtle separator
- Rows: 15-minute time slots from 7:00 AM to 6:00 PM

#### Block types (render as colored divs absolutely positioned within their time column):
- 🔵 **Appointment** — blue, read-only, shows patient initials + appointment type abbreviation
- 🟢 **CareIN Available** — bright green with subtle grid pattern or "AI" label, draggable/deletable
- ⬜ **Outside schedule hours** — light gray, not interactive
- ⬛ **Other OD blockout** — dark gray, read-only (lunch, meetings — not the CareIN type)

#### Interactions:
- **Click + drag down** on an empty slot within schedule hours → creates a new CareIN Available block → calls POST /api/availability/blocks → optimistic UI update
- **Click the × on a green block** → deletes it → calls DELETE /api/availability/blocks/:id
- **Hover on an appointment block** → tooltip showing patient name, appointment type, duration
- **Auto-refresh** every 60 seconds by re-fetching /api/availability/slots for the visible week
- **Socket.IO listener** on a new `availability:updated` event (emit this from the POST/DELETE routes)

#### State:
- Selected week (starts at current week)
- providers list (fetched once on mount)
- slotsData (fetched on week change and auto-refresh)
- dragState (start time, column being dragged)
- isLoading, lastSyncTime

#### Emit Socket.IO event from backend:
In the POST and DELETE availability routes, after DB write, emit:
```javascript
req.app.get('io').emit('availability:updated', { date, providerNum });
```

---

### STEP 5: Navigation

Add "Availability" to the sidebar/nav in the new-dashboard. Icon suggestion: a calendar with a green dot or a clock icon. Place it between "Dashboard" and "Calls" in the nav order.

---

### STEP 6: Add to README_AGENT_FILTERING or create AVAILABILITY.md

Document the one-time OD setup staff need to do:
1. The CareIN blockout type is created automatically on first server start
2. In Open Dental: go to Setup → Schedule → you will see "CareIN AI Available" as a new block color (bright green)
3. Staff can paint green blocks on the OD schedule view the same way they paint lunch blocks
4. Those blocks automatically appear in the CareIN dashboard and the AI agent uses them

---

## IMPLEMENTATION NOTES

- The MySQL connection is already set up in `backend/config/openDental.js` — use `this.pool.query()` for all queries
- Time values in OD are stored as seconds-since-midnight (TimeSpan). Convert: `seconds / 3600 = hours`. Example: 32400 = 9:00 AM. Handle this in the backend and return HH:MM strings to the frontend.
- OD's `ItemColor` is stored as a Windows COLORREF integer (BGR not RGB). Bright green (0,255,0) = 65280 decimal. Pure green for CareIN blocks.
- The `Pattern` field on appointments encodes duration: each `/` or `X` = 10 minutes. Count characters × 10 for duration.
- Check existing `backend/routes/openDental.js` for patterns already used — follow the same error handling and response format.
- Use the existing `openDentalService.pool` — do not create a new connection.
- All routes should have try/catch with consistent error responses matching the existing route patterns.

---

## DO NOT:
- Do not modify existing openDental.js routes
- Do not change the schema of existing tables
- Do not write to the `appointment` table (Phase B only)
- Do not add any new npm dependencies — use only what's already in package.json

---

## SUCCESS CRITERIA:
✅ GET /api/availability/providers returns provider list from OD  
✅ GET /api/availability/slots returns appointments + CareIN blocks for a date range  
✅ POST /api/availability/blocks creates a green block in OD  
✅ DELETE /api/availability/blocks/:id removes a CareIN block  
✅ GET /api/availability/open-slots returns bookable slots with display text  
✅ CareIN blockout type auto-created on server startup  
✅ Availability Manager page shows 5-column day view  
✅ Drag to create green blocks, × to remove them  
✅ Blue appointment blocks visible as read-only overlay  
✅ Auto-refreshes every 60 seconds  
✅ Socket.IO pushes live updates when any client modifies availability  
✅ No linter errors
