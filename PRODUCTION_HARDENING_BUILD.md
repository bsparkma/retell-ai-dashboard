# Production Hardening — Cursor Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before writing any code. Work through each batch in order. Run `npx tsc --noEmit` from `new-dashboard/` after every TypeScript file change. Maximum 20 attempts per audit gate. If you cannot pass a gate after 20 attempts, write `BLOCKED.md` with details and stop.

---

## Overview

This file contains four batches of production-hardening changes stemming from a pre-launch readiness review. Each batch has its own scope and audit gate. Complete them in order — Batch A must ship before the office goes live. Batches B–C are pre-conditions for specific capability unlocks described below.

| Batch | When to run | What it covers |
|---|---|---|
| **A** | Before any staff use | Callback deduplication, backend-down banner, dashboard data states, callbacks UX |
| **B** | Before enabling `bookAppointment` toggle | Booking idempotency, Mango failure alerting |
| **C** | Before adding staff users or Roland location | Access log, callback assignment (claimed_by) |

**PM2 process supervision** is covered in a separate note at the bottom — Beau runs those commands himself, not Cursor.

---

## Batch A — Pre-Launch Fixes

**Files to modify:**
- `backend/routes/retellTools.js`
- `new-dashboard/client/src/components/DashboardLayout.tsx`
- `new-dashboard/client/src/pages/Dashboard.tsx`
- `new-dashboard/client/src/pages/Callbacks.tsx`

---

### A1 — Callback Deduplication (`backend/routes/retellTools.js`)

**Problem:** If Retell retries a `create_callback` tool call (e.g. network timeout, slow response), a second identical callback record is created. Staff would call the same patient back twice.

**Fix:** In the `create_callback` handler, after loading the callbacks store from disk, check if a callback with the same `call_id` already exists. If it does, return the existing callback's ID and the same success message — Retell sees success, no duplicate is created.

Read `backend/routes/retellTools.js` fully before editing. The `create_callback` handler is at the bottom of the file. Make this exact change inside the handler, **after** the store is loaded from disk and `store.callbacks` is an array, but **before** the new callback object is built:

```javascript
// Deduplicate: if Retell retries this call, return the first callback created
if (callbackPayload.call_id) {
  const existing = store.callbacks.find(cb => cb.call_id === callbackPayload.call_id);
  if (existing) {
    return res.json({
      ok: true,
      created: false,
      callback_id: existing.id,
      message: 'Got it. Someone from the office will call you back soon.',
    });
  }
}
```

Place this block immediately after this existing code block:
```javascript
    try {
      const raw = await fs.readFile(file, 'utf8');
      store = JSON.parse(raw);
      if (!Array.isArray(store.callbacks)) store.callbacks = [];
      if (!Number.isInteger(store.idCounter)) store.idCounter = store.callbacks.length + 1;
    } catch (_) {
      /* file may not exist on first call */
    }
```

No other changes to this handler. No new imports needed.

**Audit gate A1:** `node -e "require('./backend/routes/retellTools')"` exits cleanly.

---

### A2 — Backend-Down Banner (`new-dashboard/client/src/components/DashboardLayout.tsx`)

**Problem:** When the backend goes offline, the sidebar footer shows a small "Offline" label, but only after the next 30-second poll. Staff attempting actions in the main content area will see silent failures with no explanation.

**Fix:** Add a full-width amber banner at the top of the main content area that appears immediately when `isConnected === false`. The banner should:
- Span full width above the page content
- Show a `WifiOff` icon (already imported) + message: "Backend is offline — changes won't save until reconnected."
- Use amber background: `bg-amber-50 border-b border-amber-200 text-amber-800`
- Disappear immediately when `isConnected` returns to `true`
- NOT replace the existing sidebar footer indicator — add the banner in addition to it

Read `DashboardLayout.tsx` fully before editing. The `isConnected` state is already wired via a 30-second health check poll. The main area structure is:

```jsx
<div className="flex-1 flex flex-col min-w-0 overflow-hidden">
  {/* Top header */}
  <header ...>...</header>

  {/* Page content */}
  <main className="flex-1 overflow-y-auto">
    ...
  </main>
</div>
```

Insert the banner between the `<header>` and `<main>`:

```jsx
{!isConnected && (
  <div className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs">
    <WifiOff size={13} />
    <span>Backend is offline — changes won't save until reconnected.</span>
  </div>
)}
```

`WifiOff` is already imported at the top of the file. No new imports needed.

**Audit gate A2:** `npx tsc --noEmit` from `new-dashboard/` — zero errors.

---

### A3 — Dashboard KPI "Unavailable" State (`new-dashboard/client/src/pages/Dashboard.tsx`)

**Problem:** When the analytics API call fails, `todayKpis` stays `null` but `loading` becomes `false`. The stats cards show `0` or `—` with no indication that data is unavailable vs. there genuinely being 0 calls today.

**Fix:** Add an `analyticsError` boolean state. Set it to `true` in the analytics `.catch()` handler. Use it in the stats array to show `"—"` as the value and `"Unavailable"` as the sub text for the analytics-sourced KPIs when in error state.

Read `Dashboard.tsx` fully before editing.

**Step 1 — Add state:**
```typescript
const [analyticsError, setAnalyticsError] = useState(false);
```
Place it alongside the other state declarations.

**Step 2 — Update the analytics catch:**

Find this line:
```typescript
    ).catch(() => setHourlyData([])),
```

Replace with:
```typescript
    ).catch(() => { setHourlyData([]); setAnalyticsError(true); }),
```

Also reset `analyticsError` to `false` at the start of the effect, so a successful refresh clears the error:
```typescript
setAnalyticsError(false);
```
Add that line at the top of the `useEffect` body, before the `setLoading(true)` call (or immediately after it, before the `Promise.all`).

**Step 3 — Update the stats array:**

The `stats` array is built from `todayKpis`. For the three analytics-sourced stats ("Today's Calls", "AI Handled", "Avg Call Duration"), when `analyticsError === true` and `todayKpis === null`, show `"—"` as value and `"Unavailable"` as sub text.

Modify the `stats` array entries as follows:

```typescript
{
  label: "Today's Calls",
  value: analyticsError && !todayKpis ? "—" : (todayKpis?.totalCalls ?? recentCalls.length),
  sub: loading ? "Loading..." : analyticsError && !todayKpis ? "Unavailable" : todayKpis ? `${todayKpis.aiHandled} AI handled` : `${recentCalls.filter(c => c.source === "retell").length} AI handled`,
  icon: PhoneCall,
  color: "teal",
},
{
  label: "AI Handled",
  value: analyticsError && !todayKpis ? "—" : (todayKpis ? `${todayKpis.aiHandledPct}%` : "—"),
  sub: analyticsError && !todayKpis ? "Unavailable" : (todayKpis ? `${todayKpis.aiHandled} of ${todayKpis.totalCalls}` : "No data"),
  icon: Bot,
  color: "green",
},
```

And for "Avg Call Duration":
```typescript
{
  label: "Avg Call Duration",
  value: analyticsError && !todayKpis ? "—" : (todayKpis ? formatDuration(todayKpis.avgDurationSec) : "—"),
  sub: analyticsError && !todayKpis ? "Unavailable" : "Today",
  icon: Clock,
  color: "slate",
},
```

No other changes to Dashboard.tsx.

**Audit gate A3:** `npx tsc --noEmit` — zero errors. No `any` types added.

---

### A4 — Callbacks Empty State Improvement (`new-dashboard/client/src/pages/Callbacks.tsx`)

**Problem:** When there are zero pending callbacks, the empty state says "No pending callbacks" — which reads like an error to staff who don't know to expect a success state.

**Fix:** Add a subtitle line below the existing empty state message that reads "All caught up." when the status filter is "pending" or "all" AND `stats?.pending === 0`.

Read `Callbacks.tsx` fully before editing. The current empty state block (find it by searching for `filtered.length === 0`) is:

```jsx
{!loading && filtered.length === 0 && (
  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
    <PhoneIncoming size={36} className="mb-3 opacity-40" />
    <div className="text-sm font-medium">
      {statusFilter === "all" ? "No callbacks" : `No ${statusFilter} callbacks`}
    </div>
  </div>
)}
```

Replace with:
```jsx
{!loading && filtered.length === 0 && (
  <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
    <PhoneIncoming size={36} className="mb-3 opacity-40" />
    <div className="text-sm font-medium">
      {statusFilter === "all" ? "No callbacks" : `No ${statusFilter} callbacks`}
    </div>
    {(statusFilter === "pending" || statusFilter === "all") && (stats?.pending ?? 0) === 0 && (
      <div className="text-xs mt-1 opacity-70">All caught up.</div>
    )}
  </div>
)}
```

**Audit gate A4:** `npx tsc --noEmit` — zero errors.

### Batch A Complete Checklist
- [ ] `node -e "require('./backend/routes/retellTools')"` exits 0
- [ ] `npx tsc --noEmit` exits 0
- [ ] No `any` types in modified files
- [ ] Backend-down banner visible at top of content area when backend is unreachable
- [ ] Backend-down banner disappears when backend comes back
- [ ] Dashboard KPI cards show "—" / "Unavailable" when analytics API is down
- [ ] Dashboard KPI cards show real values when analytics API is up
- [ ] Callbacks empty state shows "All caught up." when pending is 0

**Commit message:**
```
fix: pre-launch hardening — dedup callbacks, backend-down banner, data states
```

---

## Batch B — Pre-bookAppointment Fixes

**Run this batch before enabling the `bookAppointment` toggle in the Agent Tools card.**

**Files to modify:**
- `backend/routes/retellTools.js`
- `backend/services/syncScheduler.js`

---

### B1 — Booking Idempotency (`backend/routes/retellTools.js`)

**Problem:** If Retell retries a `book_appointment` tool call (network timeout, slow OD connector), the appointment could be booked twice. Open Dental would have two identical appointments.

**Fix:** Add an in-memory idempotency cache keyed by `call_id`. If the same `call_id` makes a second booking request within 30 minutes, return the cached result without hitting the OD connector again.

Read `backend/routes/retellTools.js` fully before editing. Make these changes:

**Step 1 — Add the cache and helpers at the top of the file**, after the existing `loadToolsConfig()` function and before the signature verification section:

```javascript
// ---------------------------------------------------------------------------
// Booking idempotency cache
// ---------------------------------------------------------------------------
//
// Retell may retry a tool call if the first response is slow. Cache booking
// results by call_id for 30 minutes so retries return the same outcome
// without hitting Open Dental again.

const _bookingCache = new Map(); // callId → { result, expiresAt }
const BOOKING_CACHE_TTL_MS = 30 * 60 * 1000;

function getBookingCache(callId) {
  const entry = _bookingCache.get(callId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _bookingCache.delete(callId); return null; }
  return entry.result;
}

function setBookingCache(callId, result) {
  _bookingCache.set(callId, { result, expiresAt: Date.now() + BOOKING_CACHE_TTL_MS });
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _bookingCache) {
    if (now > entry.expiresAt) _bookingCache.delete(key);
  }
}, 5 * 60 * 1000).unref();
```

**Step 2 — Update the `book_appointment` handler.** The handler starts with the per-tool config check. After the required-fields validation and before the `appointmentData` object is built, add:

```javascript
  // Idempotency: return cached result if Retell is retrying this call
  const bookCallId = args.call_id || null;
  if (bookCallId) {
    const cached = getBookingCache(bookCallId);
    if (cached) return res.json(cached);
  }
```

Then, after the `openDentalService.bookAppointment()` call resolves, capture the response payload before returning it, and store it in the cache:

When the booking succeeds, find:
```javascript
    if (result.success) {
      return res.json({
        ok: true,
        booked: true,
        appointment_id: result.appointmentId,
        message: `Great — you're booked for ${formatSlotForSpeech(args.date_time)}.`,
      });
    }
```

Replace with:
```javascript
    if (result.success) {
      const payload = {
        ok: true,
        booked: true,
        appointment_id: result.appointmentId,
        message: `Great — you're booked for ${formatSlotForSpeech(args.date_time)}.`,
      };
      if (bookCallId) setBookingCache(bookCallId, payload);
      return res.json(payload);
    }
```

When booking fails (the `return res.json({ ok: true, booked: false, conflicts: ... })` path), also cache the failure so a retry doesn't hit OD again:

```javascript
    const failPayload = {
      ok: true,
      booked: false,
      conflicts: result.conflicts || [],
      alternatives: (result.alternatives || []).slice(0, 3).map(a => ({
        iso: a.dateTime,
        display: formatSlotForSpeech(a.dateTime),
      })),
      message:
        result.message === 'timeout'
          ? "I couldn't confirm that booking with our scheduling system. Let me take a message and have someone call you back."
          : "That time isn't available. Would any of these work instead?",
    };
    if (bookCallId) setBookingCache(bookCallId, failPayload);
    return res.json(failPayload);
```

Do NOT cache the outer `catch` error path — that's a transient server error, not a deterministic booking result.

No new imports needed (Map is built-in).

**Audit gate B1:** `node -e "require('./backend/routes/retellTools')"` exits cleanly.

---

### B2 — Mango Scraper Failure Alerting (`backend/services/syncScheduler.js`)

**Problem:** The Mango Puppeteer scraper can fail silently if the portal changes or the session expires. The error is logged to `console.error` but there is no dashboard-visible indicator. Staff and Beau won't know the sync is broken until they notice stale call records.

**Fix:** Track the last sync result (success/failure + timestamp + error message) in a small in-memory state object and expose it via the admin health endpoint.

Read `backend/services/syncScheduler.js` fully before editing. Read `backend/routes/admin.js` to understand the health response shape.

**Step 1 — Add sync state tracking to syncScheduler.js:**

At the top of the file (after imports), add:

```javascript
// Last sync result — read by admin health endpoint
const _syncState = {
  lastRunAt: null,
  lastSuccess: null,
  lastErrorAt: null,
  lastErrorMessage: null,
};

function getSyncState() { return { ..._syncState }; }
```

In the Mango sync job's success path, after the sync completes successfully, add:
```javascript
_syncState.lastRunAt = new Date().toISOString();
_syncState.lastSuccess = new Date().toISOString();
```

In the Mango sync job's catch block (find the `console.error('❌ Sync job failed:', error.message)` line), add immediately after it:
```javascript
_syncState.lastRunAt = new Date().toISOString();
_syncState.lastErrorAt = new Date().toISOString();
_syncState.lastErrorMessage = error.message;
```

At the bottom of the file (or wherever `module.exports` is), export `getSyncState`:
```javascript
module.exports.getSyncState = getSyncState;
// (keep all existing exports)
```

**Step 2 — Surface in admin health endpoint (`backend/routes/admin.js`):**

Read `backend/routes/admin.js` fully before editing. Find the `GET /health` endpoint. Add the Mango sync state to the response:

```javascript
const syncScheduler = require('../services/syncScheduler');
// (add this require near the top of admin.js, with the other requires)

// In the GET /health handler, add to the response JSON:
mangoSync: syncScheduler.getSyncState ? syncScheduler.getSyncState() : null,
```

The exact JSON path in the response should be at the top level or within a `services` object — match the existing shape of the health response. Read the handler before deciding where to add it.

**Step 3 — Surface in Admin.tsx (Office tab):**

Read `new-dashboard/client/src/pages/Admin.tsx` fully before editing.

In the Office tab, both office cards already show connection status. Add a small Mango sync status line below the existing status items for Valley Family Dental's card only (Mango is one system):

```tsx
{healthData?.mangoSync && (
  <div className={`text-xs mt-2 flex items-center gap-1.5 ${
    healthData.mangoSync.lastErrorAt && (!healthData.mangoSync.lastSuccess || new Date(healthData.mangoSync.lastErrorAt) > new Date(healthData.mangoSync.lastSuccess))
      ? "text-destructive"
      : "text-muted-foreground"
  }`}>
    {healthData.mangoSync.lastErrorAt && (!healthData.mangoSync.lastSuccess || new Date(healthData.mangoSync.lastErrorAt) > new Date(healthData.mangoSync.lastSuccess))
      ? `⚠ Mango sync failed: ${healthData.mangoSync.lastErrorMessage ?? "unknown error"}`
      : healthData.mangoSync.lastSuccess
        ? `Mango sync: last OK ${new Date(healthData.mangoSync.lastSuccess).toLocaleTimeString()}`
        : "Mango sync: not yet run"
    }
  </div>
)}
```

You will also need to add `mangoSync` to the `AdminHealthData` interface in `new-dashboard/client/src/lib/api.ts`:

```typescript
mangoSync?: {
  lastRunAt: string | null;
  lastSuccess: string | null;
  lastErrorAt: string | null;
  lastErrorMessage: string | null;
} | null;
```

**Audit gate B2:** `npx tsc --noEmit` — zero errors. `node -e "require('./backend/services/syncScheduler')"` exits cleanly.

### Batch B Complete Checklist
- [ ] `node -e "require('./backend/routes/retellTools')"` exits 0
- [ ] `node -e "require('./backend/services/syncScheduler')"` exits 0
- [ ] `npx tsc --noEmit` exits 0
- [ ] `GET /api/admin/health` response includes `mangoSync` object
- [ ] Mango sync error appears in Admin → Office tab when last sync failed
- [ ] Booking idempotency cache is present (inspect code — cannot test without live OD)

**Commit message:**
```
feat: booking idempotency + mango sync failure alerting
```

---

## Batch C — Pre-Expansion Fixes

**Run this batch before adding staff user accounts or wiring up Roland Family Dental.**

**Files to modify:**
- `backend/server.js`
- `backend/routes/callbacks.js`
- `new-dashboard/client/src/pages/Callbacks.tsx`
- `new-dashboard/client/src/lib/api.ts`

---

### C1 — API Access Log (`backend/server.js`)

**Problem:** Patient data (call transcripts, patient names, phone numbers) flows through the dashboard. HIPAA requires that access to this data be auditable. Morgan logs to stdout only, which is lost on restart.

**Fix:** Add a structured access log that appends one JSON line per request to `data/access-log.jsonl`. Log only `/api/` requests (skip health, webhook). Each log entry records: timestamp, method, path, status, IP, user-agent, duration.

Read `backend/server.js` fully before editing. Add this middleware **after** the existing `app.use(morgan('combined'))` line:

```javascript
// Structured access log — append-only JSONL for HIPAA audit trail
const _accessLogStream = fs.createWriteStream(
  path.join(__dirname, '..', 'data', 'access-log.jsonl'),
  { flags: 'a' }
);

app.use((req, res, next) => {
  // Skip health + webhook endpoints (those are already covered by Retell/monitor logs)
  if (req.path === '/api/health' || req.path.startsWith('/api/webhooks')) return next();
  const started = Date.now();
  res.on('finish', () => {
    const entry = {
      ts: new Date().toISOString(),
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - started,
      ip: req.ip || req.socket?.remoteAddress || null,
      ua: req.headers['user-agent'] || null,
    };
    _accessLogStream.write(JSON.stringify(entry) + '\n');
  });
  next();
});
```

Add `const fs = require('fs');` at the top of `server.js` if it is not already required. Read the file first to check — do not add a duplicate require.

The log file will be at `data/access-log.jsonl`. It is append-only and grows indefinitely — this is intentional for an audit trail. No rotation is needed for a soft launch.

**Audit gate C1:** `node -e "require('./backend/server')"` exits cleanly (or the server starts without errors).

---

### C2 — Callback Assignment / Claimed-By (`backend/routes/callbacks.js` + frontend)

**Problem:** If two staff members work the callback queue simultaneously, they can both attempt to call the same patient without knowing the other person is on it.

**Fix:** Add a `claimed_by` field to the callback record. Staff can "Claim" a callback (entering their name once, persisted to `localStorage`). Claimed callbacks show the claimer's name badge so others know to skip it.

This is a two-part change: backend PATCH endpoint, then frontend UI.

#### Part 1 — Backend: PATCH /api/callbacks/:id/claim

Read `backend/routes/callbacks.js` fully before editing.

Add a new route after the existing PATCH route:

```javascript
// PATCH /api/callbacks/:id/claim  — claim or release a callback
router.patch('/:id/claim', async (req, res) => {
  const { id } = req.params;
  const { claimed_by } = req.body; // null to release, string to claim

  const idx = callbacks.findIndex(cb => cb.id === id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

  if (typeof claimed_by !== 'string' && claimed_by !== null) {
    return res.status(400).json({ success: false, error: 'claimed_by must be a string or null' });
  }

  callbacks[idx] = {
    ...callbacks[idx],
    claimed_by: claimed_by || null,
    claimed_at: claimed_by ? new Date().toISOString() : null,
    updated_at: new Date().toISOString(),
  };

  await persist();
  return res.json({ success: true, callback: callbacks[idx] });
});
```

#### Part 2 — Frontend API method (`new-dashboard/client/src/lib/api.ts`)

Read `api.ts` fully before editing.

Add `claimed_by` and `claimed_at` to the `CallbackDisplay` interface (or the raw callback type — find where it's defined and add the fields as optional):

```typescript
claimed_by?: string | null;
claimed_at?: string | null;
```

Add a new API method after `deleteCallback()`:

```typescript
async claimCallback(id: string, claimedBy: string | null): Promise<CallbackDisplay> {
  const res = await this.request<{ success: boolean; callback: CallbackDisplay }>(
    `/callbacks/${id}/claim`,
    { method: 'PATCH', body: JSON.stringify({ claimed_by: claimedBy }) }
  );
  return res.callback;
}
```

Also update the `normalizeCallback` function to pass through the new fields (add them to the return object if `normalizeCallback` exists — read the file to confirm).

#### Part 3 — Frontend UI (`new-dashboard/client/src/pages/Callbacks.tsx`)

Read `Callbacks.tsx` fully before editing.

**State to add:**
```typescript
const [myName, setMyName] = useState<string>(() => localStorage.getItem('carein_staff_name') || '');
const [namePromptOpen, setNamePromptOpen] = useState(false);
```

**Claim handler:**
```typescript
const handleClaim = async (cb: CallbackDisplay) => {
  if (!myName) { setNamePromptOpen(true); return; }
  const isAlreadyMine = cb.claimed_by === myName;
  setActionInFlight(cb.id + '-claim');
  try {
    await api.claimCallback(cb.id, isAlreadyMine ? null : myName);
    toast.success(isAlreadyMine ? 'Claim released' : `Claimed by ${myName}`);
    fetchData();
  } catch { toast.error('Failed to update claim'); }
  finally { setActionInFlight(null); }
};
```

**Name prompt:** A simple inline dialog (use shadcn `Dialog` or just a conditional input at the top of the page). When the user submits a name, save it to `localStorage.setItem('carein_staff_name', name)` and set `myName`.

```tsx
{namePromptOpen && (
  <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center">
    <div className="bg-card rounded-xl p-6 shadow-xl w-80 space-y-4">
      <div className="text-sm font-semibold">What's your name?</div>
      <div className="text-xs text-muted-foreground">Used to mark callbacks as "in progress by you." Saved in this browser.</div>
      <input
        className="w-full border border-border rounded-md px-3 py-2 text-sm bg-background"
        placeholder="e.g. Sarah"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const name = (e.target as HTMLInputElement).value.trim();
            if (name) {
              localStorage.setItem('carein_staff_name', name);
              setMyName(name);
              setNamePromptOpen(false);
            }
          }
        }}
      />
      <div className="text-xs text-muted-foreground">Press Enter to save.</div>
    </div>
  </div>
)}
```

**Claim button in each callback card:** In the action buttons section (find the `{!isTerminal && (...)}` block), add a Claim button between "Log Attempt" and "View Call":

```tsx
<Button
  variant={cb.claimed_by === myName ? "secondary" : "ghost"}
  size="sm"
  className="text-xs h-7 gap-1"
  disabled={!!(cb.claimed_by && cb.claimed_by !== myName) || actionInFlight === cb.id + '-claim'}
  onClick={() => handleClaim(cb)}
  title={cb.claimed_by && cb.claimed_by !== myName ? `Claimed by ${cb.claimed_by}` : undefined}
>
  {actionInFlight === cb.id + '-claim' ? <Loader2 size={12} className="animate-spin" /> : null}
  {cb.claimed_by === myName ? 'Release' : cb.claimed_by ? `By ${cb.claimed_by}` : 'Claim'}
</Button>
```

When `claimed_by` is set by someone else, the button is disabled and shows their name. When claimed by the current user, it shows "Release." When unclaimed, it shows "Claim."

**Audit gate C2:** `npx tsc --noEmit` — zero errors. No `any` types.

### Batch C Complete Checklist
- [ ] `npx tsc --noEmit` exits 0
- [ ] `data/access-log.jsonl` is created and receives entries on API calls
- [ ] `PATCH /api/callbacks/:id/claim` sets `claimed_by` and persists to disk
- [ ] Claim button appears on pending callback cards
- [ ] Name prompt opens if no name is stored
- [ ] Claimed callback shows claimer's name; others cannot claim it until released
- [ ] Unclaiming (Release) clears `claimed_by` and `claimed_at`

**Commit message:**
```
feat: access log + callback assignment for multi-staff use
```

---

## PM2 Process Supervision — Beau Runs This (Not Cursor)

This is not a code change — it's a server configuration step Beau does himself once, before go-live.

**Why:** If the Node.js backend process crashes (unhandled error, memory issue, server reboot), the entire dashboard and call handling goes dark. PM2 is a process manager that automatically restarts the backend when it crashes and keeps it running across reboots.

**Steps:**

```bash
# 1. Install PM2 globally (one-time)
npm install -g pm2

# 2. From the repo root, create the PM2 config file
# (do this once — save it as ecosystem.config.cjs in the repo root)
```

Create file `ecosystem.config.cjs` in the repo root:
```javascript
module.exports = {
  apps: [
    {
      name: 'carein-backend',
      script: './backend/server.js',
      cwd: './',
      env_file: './backend/.env',
      restart_delay: 2000,
      max_restarts: 10,
      watch: false,
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
```

```bash
# 3. Start the backend under PM2
pm2 start ecosystem.config.cjs

# 4. Save PM2 process list so it survives reboots
pm2 save

# 5. (Windows only) Set up PM2 to run at startup
pm2-startup install    # follow the instructions it prints

# Useful commands going forward:
pm2 status             # see if carein-backend is running
pm2 logs carein-backend  # tail the logs
pm2 restart carein-backend  # restart after .env changes
pm2 stop carein-backend     # graceful stop
```

---

## Items Not Covered in This File (Beau's Decision or Connector Work)

| Item | What it requires | Owner |
|---|---|---|
| OD connector slot accuracy | Wire real operatory/provider IDs when connector is ready | Beau (connector work) |
| Two-office data partitioning | Architectural decision on ClinicNum routing before Roland goes live | Beau + Cursor (separate design session) |

---

## Files to Create

| File | Created by |
|---|---|
| `data/access-log.jsonl` | Auto-created by backend middleware on first request |
| `ecosystem.config.cjs` | Beau creates (PM2 config, see above) |

## Files to Modify

| File | Batch |
|---|---|
| `backend/routes/retellTools.js` | A1, B1 |
| `backend/routes/callbacks.js` | C2 |
| `backend/routes/admin.js` | B2 |
| `backend/services/syncScheduler.js` | B2 |
| `backend/server.js` | C1 |
| `new-dashboard/client/src/components/DashboardLayout.tsx` | A2 |
| `new-dashboard/client/src/pages/Dashboard.tsx` | A3 |
| `new-dashboard/client/src/pages/Callbacks.tsx` | A4, C2 |
| `new-dashboard/client/src/lib/api.ts` | B2, C2 |
| `new-dashboard/client/src/pages/Admin.tsx` | B2 |

## Files NOT to Touch

- `data/callbacks.json`
- `data/agent-config.json`
- `data/retell-tools-config.json`
- `data/notifications-config.json`
- Any slot marker, calendar, or scheduling files
- `backend/middleware/auth.js`
- Any other page not listed above

---

## Final Audit Gate — Full Checklist

**TypeScript**
- [ ] `npx tsc --noEmit` exits 0 from `new-dashboard/`
- [ ] No `any` types in any modified `.ts` or `.tsx` file

**Backend**
- [ ] `node -e "require('./backend/routes/retellTools')"` exits 0
- [ ] `node -e "require('./backend/services/syncScheduler')"` exits 0
- [ ] Duplicate `create_callback` with same `call_id` returns first callback's ID
- [ ] Duplicate `book_appointment` with same `call_id` returns cached result

**Frontend**
- [ ] Backend-down banner appears and disappears correctly
- [ ] Dashboard KPIs show "—" / "Unavailable" on analytics error
- [ ] Callbacks empty state shows "All caught up." when queue is empty
- [ ] Mango sync error visible in Admin Office tab
- [ ] Callback claim/release works across two browser tabs

**Maximum 20 attempts per gate. Write `BLOCKED.md` if any gate cannot pass.**
