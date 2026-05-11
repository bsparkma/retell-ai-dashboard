# CareIN Slot Markers — New Claude Code Session Handoff

> **How to use this:** Open a NEW Claude Code session pointed at `C:/od-connector`. Paste the entire contents of this file as your first message. The new session has NO context from prior conversations — everything it needs is in this file.

---

## Context

Dr. Beau Sparkman runs Valley Family Dental and Roland Family Dental. He has a working on-premises TypeScript/Express connector at `C:/od-connector` that bridges Open Dental MySQL to his cloud apps. **This connector is working and in production — do not break it.**

The CareIN AI dashboard (`c:\Users\beau\carein cursor dashboard`) has a **Slot Markers** feature. Slot markers are placeholder appointments in Open Dental (OD) that hold time slots for specific appointment types (new patient, emergency, hygiene, etc.). They are booked under a special "CareIN Block" patient (PatNum `13290` at Valley Family Dental). The feature is in mock mode right now — this work wires it to real OD data.

---

## What You Are Building

1. A `carein/slot-markers` git branch on `C:/od-connector`
2. A new `GET /api/slot-markers` endpoint on that branch — reads OD appointment data, returns typed slot marker objects
3. The branched connector runs on port **8444** alongside the existing connector on **8443** — they never interfere
4. A `GET /api/slot-markers` route in the CareIN dashboard backend that calls the connector
5. A Vite dev proxy so the frontend can reach it in development
6. Flip `USE_MOCK_SLOT_MARKERS = false` as the final step

**You are working in two repos:**

| Repo | Path |
|---|---|
| od-connector (existing, working) | `C:/od-connector` |
| CareIN dashboard | `c:\Users\beau\carein cursor dashboard` |

---

## od-connector — What You Already Know

You can read these files but here is the summary so you don't have to:

**Structure:**
```
C:/od-connector/src/
  app.ts          ← Express app factory, registers all routes
  server.ts       ← HTTPS/HTTP server startup
  config/index.ts ← Config loaded from .env (PORT defaults to 8443)
  services/
    database.ts   ← MySQL pool, exports: query<T>(), queryOne<T>(), executeRaw()
    logger.ts     ← Winston logger, exports: logger, auditLog()
  middleware/
    index.ts      ← exports: authenticate, errorHandler, notFoundHandler, requestLogger, createRateLimiter
    errorHandler.ts ← exports ApiError class
  routes/
    index.ts      ← barrel re-exports all routers
    patients.ts   ← example route to copy pattern from
    (others...)
  types/
    api.ts        ← ApiResponse<T> interface
```

**Auth:** All `/api/*` routes are gated by the `authenticate` middleware (checks `Authorization: Bearer <key>` against `API_KEYS` env var).

**Route pattern** (copy this exactly):
```typescript
import { Router, Request, Response, NextFunction } from 'express';
import Joi from 'joi';
import { query } from '../services/database.js';
import { logger } from '../services/logger.js';
import { ApiError } from '../middleware/errorHandler.js';
import type { RowDataPacket } from 'mysql2';
import type { ApiResponse } from '../types/api.js';

const router = Router();

// Joi validation schema
const querySchema = Joi.object({ ... });

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = querySchema.validate(req.query);
    if (error) throw new ApiError(error.details[0].message, 400);

    const rows = await query<RowDataPacket[]>(`SELECT ...`, [value.param]);

    const response: ApiResponse<RowDataPacket[]> = {
      success: true,
      data: rows,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

export default router;
```

**Package.json scripts:**
- `npm run dev` — tsx watch (development, hot reload)
- `npm run build` — tsc → dist/
- `npm start` — node dist/server.js (production)

---

## Phase 1 — Create the Branch

From `C:/od-connector`:

```bash
git checkout main
git pull
git checkout -b carein/slot-markers
```

All changes in this repo go on `carein/slot-markers`. **Never commit to main.**

---

## Phase 2 — Add the Slot Markers Route

### Step 2A — Create `src/routes/slot-markers.ts`

This route reads CareIN Block placeholder appointments from OD and returns them as typed slot marker objects.

**Validation schema:**
```typescript
const querySchema = Joi.object({
  startDate: Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  endDate:   Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).required(),
  clinicNum: Joi.number().integer().positive().required(),
  category:  Joi.string().valid(
    'new-patient', 'emergency', 'hygiene', 'asap',
    'restorative-fillings', 'restorative-production',
    'restorative-extractions', 'restorative-pediatric'
  ).optional(),
});
```

**SlotCategory type** (define locally in the route file — do not import from the CareIN repo):
```typescript
type SlotCategory =
  | 'new-patient' | 'emergency' | 'hygiene' | 'asap'
  | 'restorative-fillings' | 'restorative-production'
  | 'restorative-extractions' | 'restorative-pediatric';
```

**SlotMarker shape** (what the CareIN frontend expects):
```typescript
interface SlotMarker {
  id: number;
  date: string;          // YYYY-MM-DD
  startTime: string;     // HH:MM (24-hour)
  duration: number;      // minutes
  operatoryId: number;
  operatoryName: string;
  providerId?: number;
  providerName?: string;
  category: SlotCategory;
  clinicNum: number;
}
```

**The OD query:**
```sql
SELECT
  a.AptNum,
  DATE(a.AptDateTime)        AS date,
  TIME(a.AptDateTime)        AS startTime,
  a.Pattern,
  a.Op                       AS operatoryId,
  COALESCE(o.OpName, '')     AS operatoryName,
  a.ProvNum                  AS providerId,
  CONCAT(pr.FName, ' ', pr.LName) AS providerName,
  a.AptTypeNum,
  a.ClinicNum
FROM appointment a
LEFT JOIN operatory o  ON a.Op      = o.OperatoryNum
LEFT JOIN provider  pr ON a.ProvNum = pr.ProvNum
WHERE a.PatNum     = ?
  AND a.AptStatus  IN (1, 3)
  AND DATE(a.AptDateTime) BETWEEN ? AND ?
  AND a.ClinicNum  = ?
ORDER BY a.AptDateTime
```

- `PatNum = ?` → use the `CAREIN_BLOCK_PATNUM` env var (default `13290`)
- `AptStatus IN (1, 3)` → 1 = Scheduled, 3 = Unscheduled/available
- This is a read-only SELECT — no writes to OD

**Helper: duration from Pattern**
Open Dental stores duration as a pattern string where each `X` = 10-minute increment (e.g. `"/X/X/X/"` = 30 min).
```typescript
function parseDuration(pattern: string | null): number {
  if (!pattern) return 30;
  return (pattern.match(/X/g) || []).length * 10;
}
```

**Helper: AptTypeNum → SlotCategory**
The mapping is configured via an env var (`CAREIN_APPT_TYPE_MAP`) as a JSON string so Beau can update it without rebuilding. Default to `"new-patient"` for unmapped types and log a warning.
```typescript
function loadCategoryMap(): Record<number, SlotCategory> {
  const raw = process.env.CAREIN_APPT_TYPE_MAP;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    logger.warn('[slot-markers] CAREIN_APPT_TYPE_MAP is not valid JSON — using empty map');
    return {};
  }
}

function mapCategory(aptTypeNum: number, categoryMap: Record<number, SlotCategory>): SlotCategory {
  const mapped = categoryMap[aptTypeNum];
  if (!mapped) {
    logger.warn(`[slot-markers] Unmapped AptTypeNum: ${aptTypeNum} — defaulting to "new-patient"`);
    return 'new-patient';
  }
  return mapped;
}
```

**Full route handler:**
```typescript
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value } = querySchema.validate(req.query);
    if (error) throw new ApiError(error.details[0].message, 400);

    const { startDate, endDate, clinicNum, category } = value;
    const careInPatNum = parseInt(process.env.CAREIN_BLOCK_PATNUM || '13290', 10);
    const categoryMap = loadCategoryMap();

    const rows = await query<RowDataPacket[]>(
      `SELECT
        a.AptNum,
        DATE(a.AptDateTime)             AS date,
        TIME(a.AptDateTime)             AS startTime,
        a.Pattern,
        a.Op                            AS operatoryId,
        COALESCE(o.OpName, '')          AS operatoryName,
        a.ProvNum                       AS providerId,
        CONCAT(pr.FName, ' ', pr.LName) AS providerName,
        a.AptTypeNum,
        a.ClinicNum
      FROM appointment a
      LEFT JOIN operatory o  ON a.Op      = o.OperatoryNum
      LEFT JOIN provider  pr ON a.ProvNum = pr.ProvNum
      WHERE a.PatNum    = ?
        AND a.AptStatus IN (1, 3)
        AND DATE(a.AptDateTime) BETWEEN ? AND ?
        AND a.ClinicNum = ?
      ORDER BY a.AptDateTime`,
      [careInPatNum, startDate, endDate, clinicNum]
    );

    let markers: SlotMarker[] = rows.map(row => ({
      id:            Number(row.AptNum),
      date:          String(row.date).substring(0, 10),
      startTime:     String(row.startTime).substring(0, 5),
      duration:      parseDuration(row.Pattern as string | null),
      operatoryId:   Number(row.operatoryId),
      operatoryName: String(row.operatoryName),
      providerId:    row.providerId ? Number(row.providerId) : undefined,
      providerName:  row.providerName ? String(row.providerName).trim() || undefined : undefined,
      category:      mapCategory(Number(row.AptTypeNum), categoryMap),
      clinicNum:     Number(row.ClinicNum),
    }));

    // Apply category filter post-mapping (can't filter by category at SQL level)
    if (category) {
      markers = markers.filter(m => m.category === category);
    }

    logger.info(`[slot-markers] Returned ${markers.length} markers`, { startDate, endDate, clinicNum });

    const response: ApiResponse<SlotMarker[]> = {
      success: true,
      data: markers,
      timestamp: new Date().toISOString(),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});
```

### Step 2B — Export from `src/routes/index.ts`

Add to the existing barrel file:
```typescript
export { default as slotMarkersRouter } from './slot-markers.js';
```

### Step 2C — Register in `src/app.ts`

Add the import alongside the other route imports:
```typescript
import {
  // ...existing imports...
  slotMarkersRouter,
} from './routes/index.js';
```

Add the mount under the existing `/api` routes:
```typescript
app.use('/api/slot-markers', slotMarkersRouter);
```

Also add it to the `/api` root endpoint list (the object that documents all routes):
```typescript
slotMarkers: {
  'GET /api/slot-markers': 'Get CareIN slot marker appointments by date range and clinic',
},
```

**Phase 2 audit gate:**
```bash
cd C:/od-connector
npm run typecheck   # must exit 0
```

---

## Phase 3 — Run on Port 8444

The existing connector runs on port 8443. The CareIN branch runs on 8444 in parallel.

Create `.env.carein` in `C:/od-connector/`:
```
# CareIN branch config — copy all vars from .env and change PORT
PORT=8444
# CAREIN_BLOCK_PATNUM=13290   (uncomment and change if Roland uses a different PatNum)
# CAREIN_APPT_TYPE_MAP={}     (fill in with real AptTypeNum→category mapping when ready)
```

**Tell Beau:** Copy your existing `.env` file to `.env.carein` and add the two CareIN-specific vars above. Change `PORT` to `8444`. Do not commit `.env.carein`.

**To start the CareIN branch alongside the existing connector:**
```bash
# In one terminal — existing connector (unchanged, port 8443):
cd C:/od-connector
npm start

# In a second terminal — CareIN branch (port 8444):
cd C:/od-connector
node --env-file=.env.carein dist/server.js
# or for development with hot reload:
PORT=8444 npm run dev
```

**Phase 3 audit gate:**
```bash
# With the branch running on 8444 and your API key:
curl -k "https://localhost:8444/api/slot-markers?startDate=2026-04-01&endDate=2026-04-30&clinicNum=1" \
  -H "Authorization: Bearer <YOUR_API_KEY>"
# Should return { success: true, data: [...], timestamp: "..." }
# data may be an empty array if no slot markers exist yet — that is correct
```

---

## Phase 4 — CareIN Dashboard Backend Route

Now switch to the CareIN dashboard repo: `c:\Users\beau\carein cursor dashboard`.

### Step 4A — Create `backend/routes/slotMarkers.js`

This is a plain JS file (the CareIN backend is not TypeScript). It proxies the request to the od-connector and returns the result.

```javascript
// backend/routes/slotMarkers.js

const express = require('express');
const router = express.Router();

const CONNECTOR_BASE = process.env.OD_CONNECTOR_URL || 'http://localhost:8444';
const CONNECTOR_API_KEY = process.env.OD_CONNECTOR_API_KEY || '';

// GET /api/slot-markers
router.get('/', async (req, res) => {
  const { startDate, endDate, clinicNum, category } = req.query;

  if (!startDate || !endDate || !clinicNum) {
    return res.status(400).json({ success: false, error: 'startDate, endDate, and clinicNum are required' });
  }

  try {
    const url = new URL('/api/slot-markers', CONNECTOR_BASE);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('clinicNum', clinicNum);
    if (category) url.searchParams.set('category', category);

    const upstream = await fetch(url.toString(), {
      headers: { 'Authorization': `Bearer ${CONNECTOR_API_KEY}` },
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error('[slot-markers] Connector error:', upstream.status, text);
      return res.status(502).json({ success: false, error: 'Connector returned an error' });
    }

    const json = await upstream.json();
    // The connector returns { success, data, timestamp } — pass data through directly
    return res.json(Array.isArray(json.data) ? json.data : []);
  } catch (err) {
    console.error('[slot-markers] Failed to reach connector:', err.message);
    return res.status(503).json({ success: false, error: 'Could not reach OD connector' });
  }
});

module.exports = router;
```

Note: `fetch` is available natively in Node 18+. The CareIN backend targets Node 18+ (check `package.json` `engines` field — if below 18, use `node-fetch` or `axios` instead of native fetch, following the existing pattern in other route files).

### Step 4B — Register in `backend/server.js`

Read `backend/server.js` first. Find where other routes are registered and add:

```javascript
const slotMarkersRouter = require('./routes/slotMarkers');
app.use('/api/slot-markers', slotMarkersRouter);
```

Place it with the other route registrations. The `/api` bearer-token gate in `server.js` already covers this route — no additional auth needed on this file.

Also add two env vars to `backend/.env` (tell Beau to add these himself — do not read or modify `.env` files):
```
OD_CONNECTOR_URL=http://localhost:8444
OD_CONNECTOR_API_KEY=<same key as the connector's API_KEYS>
```

### Step 4C — Add Vite Dev Proxy

The slot markers frontend code calls `/api/slot-markers` using `window.location.origin` (same-origin). In development the frontend runs on port 3005 and the backend on port 5000 — without a proxy the call fails.

Read `c:\Users\beau\carein cursor dashboard\new-dashboard\vite.config.ts` before editing. Add a `server.proxy` config:

```typescript
server: {
  port: 3005,
  strictPort: false,
  host: true,
  allowedHosts: ["localhost", "127.0.0.1"],
  // Add this:
  proxy: {
    '/api/slot-markers': {
      target: 'http://localhost:5000',
      changeOrigin: true,
    },
  },
  fs: {
    strict: true,
    deny: ["**/.*"],
  },
},
```

**Phase 4 audit gate — TypeScript:**
```bash
cd "c:\Users\beau\carein cursor dashboard\new-dashboard"
npx tsc --noEmit   # must exit 0
```

**Phase 4 audit gate — end-to-end:**
```bash
# With both servers running (backend on 5000, CareIN connector branch on 8444):
curl "http://localhost:5000/api/slot-markers?startDate=2026-04-01&endDate=2026-04-30&clinicNum=1" \
  -H "Authorization: Bearer <DASHBOARD_API_TOKEN>"
# Should return a JSON array (empty is fine if no markers exist yet)
```

---

## Phase 5 — Flip Mock Mode Off (Last Step Only)

**Do this only after Phase 4 passes and the endpoint returns real data.**

In `c:\Users\beau\carein cursor dashboard\new-dashboard\client\src\features\slotMarkers\config.ts`:

Change:
```typescript
export const USE_MOCK_SLOT_MARKERS = true;
```

To:
```typescript
export const USE_MOCK_SLOT_MARKERS = false;
```

---

## What Beau Must Do Manually (Tell Him, Don't Guess)

At the end of each phase, give Beau explicit instructions for these items — do not attempt them yourself:

1. **Copy `.env` to `.env.carein`** and change `PORT=8444`. Add `CAREIN_BLOCK_PATNUM` and `CAREIN_APPT_TYPE_MAP` lines.
2. **Add to `backend/.env`:** `OD_CONNECTOR_URL=http://localhost:8444` and `OD_CONNECTOR_API_KEY=<key>`.
3. **Confirm PatNum for Roland:** Is the CareIN Block patient also PatNum 13290 at Roland, or different? Check in OD.
4. **Fill in `CAREIN_APPT_TYPE_MAP`:** In OD → Setup → Appointment Types, find the numeric IDs for each type. The JSON format is: `{"42": "new-patient", "17": "emergency", "8": "hygiene"}` — the keys are the AptTypeNum values as strings.

---

## Commit Messages

```
feat: add GET /api/slot-markers endpoint for CareIN slot marker integration
```

```
feat: add slot-markers proxy route and vite dev proxy to CareIN dashboard
```

---

## Files to Create

| File | Repo |
|---|---|
| `src/routes/slot-markers.ts` | `C:/od-connector` (on `carein/slot-markers` branch) |
| `.env.carein` | `C:/od-connector` (Beau creates manually — not committed) |
| `backend/routes/slotMarkers.js` | `c:\Users\beau\carein cursor dashboard` |

## Files to Modify

| File | Change |
|---|---|
| `src/routes/index.ts` | Export `slotMarkersRouter` |
| `src/app.ts` | Import and mount `slotMarkersRouter` at `/api/slot-markers` |
| `backend/server.js` | Register `/api/slot-markers` route |
| `new-dashboard/vite.config.ts` | Add `/api/slot-markers` proxy |
| `new-dashboard/client/src/features/slotMarkers/config.ts` | Flip `USE_MOCK_SLOT_MARKERS = false` (Phase 5 only) |

## Files NOT to Touch

- `main` branch of `C:/od-connector` — all connector changes on `carein/slot-markers` branch only
- Any existing connector routes or services in `C:/od-connector`
- `new-dashboard/client/src/features/slotMarkers/types.ts` — do not change the interface
- `new-dashboard/client/src/features/slotMarkers/api.ts` — do not change the frontend API call
- Any other CareIN dashboard pages, routes, or features

---

## Final Checklist

- [ ] `carein/slot-markers` branch exists in `C:/od-connector`
- [ ] `npm run typecheck` passes in `C:/od-connector`
- [ ] Connector starts on port 8444 without errors
- [ ] `GET /api/slot-markers` returns `{ success: true, data: [] }` with valid auth (empty is fine before markers exist)
- [ ] `GET /api/slot-markers` returns `401` without auth header
- [ ] `GET /api/slot-markers` without `clinicNum` returns `400`
- [ ] CareIN backend `/api/slot-markers` proxies correctly to connector
- [ ] `npx tsc --noEmit` passes in `new-dashboard/`
- [ ] Vite proxy routes `/api/slot-markers` in dev mode
- [ ] `USE_MOCK_SLOT_MARKERS = false` and Scheduling page loads without errors
