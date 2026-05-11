# Admin Page — Full Wiring & Cleanup Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before writing any code. All decisions are made. Build exactly what is described. Run `npx tsc --noEmit` from `new-dashboard/` after every file change. Maximum 20 attempts per audit gate. If you cannot pass a gate after 20 attempts, write `BLOCKED.md` and stop.

---

## Context

`new-dashboard/client/src/pages/Admin.tsx` has four tabs: Office, Users & Roles, Integrations, and Settings. Several things are broken or incomplete:

1. **Bug:** `GET /api/admin/costs` returns cost values as pre-formatted strings (`"$0.0043"`) but the frontend treats them as numbers and calls `.toFixed()` on them — rendering `$$0.0043` and throwing a TypeError on `.toFixed()`.
2. **Bug:** Clicking "Test" on the Retell AI integration card always returns "Unknown service: retell" because `POST /admin/test-connection` has no `case 'retell':` in the switch.
3. **Bug:** Notification toggles in the Settings tab are hardcoded booleans that never save state. Reloading resets them.
4. **Missing:** The backend already has `GET /admin/sync/history`, `POST /admin/sync/start`, `POST /admin/sync/stop`, `GET /admin/queues`, and `GET /admin/errors` — none of them are surfaced in the UI.
5. **Stub:** Office tab shows a generic "CareIn Dashboard" card. Should show two real office cards: Valley Family Dental and Roland Family Dental.
6. **Stub:** Users tab is a "Coming Soon" placeholder with no useful content.
7. **DashboardLayout:** `isConnected` is hardcoded to `true`. The "Connected" indicator in the sidebar never reflects actual backend status.

---

## What Is In Scope

- Fixes to `backend/routes/admin.js` (costs numbers, Retell test case)
- New `data/notifications-config.json` + `backend/routes/notificationsConfig.js` + route registration
- New and updated methods in `new-dashboard/client/src/lib/api.ts`
- Admin.tsx: all four tabs fully implemented
- `new-dashboard/client/src/components/DashboardLayout.tsx`: real connection status

## What Is NOT In Scope

- Actually sending notification emails/texts — toggles save state only
- Implementing real auth or user sessions — Users tab is a structured placeholder
- Any calendar, slot markers, scheduling, call detail, or agent builder files
- Database changes

---

## Phase 1 — Backend Bug Fixes

### 1A. Fix costs endpoint in `backend/routes/admin.js`

Find the `GET /api/admin/costs` handler. Replace all string template literals that embed `$` with raw numbers. The frontend will handle formatting.

**Before (pattern to replace):**
```javascript
estimated_cost: `$${transcriptionStats.totalCost.toFixed(4)}`,
total_estimated: `$${(transcriptionStats.totalCost + analyzerStats.estimatedCost).toFixed(4)}`,
```

**After:**
```javascript
estimated_cost: transcriptionStats.totalCost,           // raw number
total_estimated: transcriptionStats.totalCost + analyzerStats.estimatedCost,  // raw number
```

Do the same for `analyzerStats.estimatedCost` — remove the `$` string wrapper and return the raw number. The `rate` strings (`'$0.0043/min'`, `'$0.002/1K tokens'`) are informational labels, not computed values — leave those as-is.

### 1B. Add Retell case to test-connection in `backend/routes/admin.js`

Find the `POST /api/admin/test-connection` handler. In the `switch (service)` block, add before `default:`:

```javascript
case 'retell':
  const retellKey = process.env.RETELL_API_KEY;
  result = {
    success: !!retellKey,
    message: retellKey
      ? 'Retell API key is configured'
      : 'RETELL_API_KEY is not set in environment',
  };
  break;
```

### Phase 1 Audit Gate
`node -e "require('./backend/routes/admin')"` — exits cleanly. No syntax errors.

---

## Phase 2 — Notification Config (New Backend)

### 2A. Create `data/notifications-config.json`

```json
{
  "emergencyCallAlerts": true,
  "missedCallNotifications": true,
  "dailyCallSummaryEmail": true,
  "agentErrorAlerts": false,
  "lastSaved": null
}
```

### 2B. Create `backend/routes/notificationsConfig.js`

Follow the `agentConfig.js` pattern exactly — same atomic write (temp + rename), same in-flight coalescing, same default merge on load.

```javascript
// backend/routes/notificationsConfig.js

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/notifications-config.json');

const DEFAULT_CONFIG = {
  emergencyCallAlerts: true,
  missedCallNotifications: true,
  dailyCallSummaryEmail: true,
  agentErrorAlerts: false,
  lastSaved: null,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

let persistInFlight = false;
let persistRequeued = false;

function persistConfig(config) {
  if (persistInFlight) { persistRequeued = true; return; }
  persistInFlight = true;
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFile(tmp, JSON.stringify(config, null, 2), (err) => {
    if (!err) fs.renameSync(tmp, CONFIG_FILE);
    persistInFlight = false;
    if (persistRequeued) { persistRequeued = false; persistConfig(config); }
  });
}

// GET /api/notifications-config
router.get('/', (req, res) => {
  try {
    res.json({ success: true, config: loadConfig() });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load notifications config' });
  }
});

// PUT /api/notifications-config
router.put('/', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid config body' });
    }
    const updated = {
      ...loadConfig(),
      emergencyCallAlerts: !!incoming.emergencyCallAlerts,
      missedCallNotifications: !!incoming.missedCallNotifications,
      dailyCallSummaryEmail: !!incoming.dailyCallSummaryEmail,
      agentErrorAlerts: !!incoming.agentErrorAlerts,
      lastSaved: new Date().toISOString(),
    };
    persistConfig(updated);
    res.json({ success: true, config: updated });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save notifications config' });
  }
});

module.exports = router;
```

### 2C. Register in `backend/server.js`

Find where other routes are registered and add:

```javascript
const notificationsConfigRouter = require('./routes/notificationsConfig');
app.use('/api/notifications-config', notificationsConfigRouter);
```

### Phase 2 Audit Gate
`node -e "require('./backend/routes/notificationsConfig')"` — exits cleanly.
`GET /api/notifications-config` with a Bearer token returns the default config object.

---

## Phase 3 — API Client Updates (`new-dashboard/client/src/lib/api.ts`)

Read the full file before modifying. Add the following items, following the exact same pattern as existing methods.

### 3A. NotificationsConfig interface

Add near the other config interfaces (after `RetellToolsConfig`):

```typescript
export interface NotificationsConfig {
  emergencyCallAlerts: boolean;
  missedCallNotifications: boolean;
  dailyCallSummaryEmail: boolean;
  agentErrorAlerts: boolean;
  lastSaved: string | null;
}
```

### 3B. Typed interfaces for admin data

Replace the current `Record<string, unknown>` return types on the three admin methods with typed versions. Add these interfaces near the top of the file (or alongside `NotificationsConfig`):

```typescript
export interface AdminServiceStatus {
  status: string;
  connected_clients?: number;
  active_calls?: number;
  webhook_configured?: boolean;
  last_sync?: string | null;
  next_sync?: string | null;
  scheduler_running?: boolean;
  connection_type?: string;
  provider?: string;
  stats?: Record<string, unknown>;
}

export interface AdminHealthData {
  status: string;
  timestamp: string;
  services: Record<string, AdminServiceStatus>;
}

export interface AdminCostsData {
  transcription?: {
    provider: string;
    total_minutes: number;
    total_transcriptions: number;
    estimated_cost: number;
    rate: string;
  };
  analysis?: {
    provider: string;
    total_analyses: number;
    total_tokens: number;
    estimated_cost: number;
    rate: string;
  };
  total_estimated: number;
}

export interface AdminConfigData {
  mango?: {
    portal_url?: string;
    sync_schedule?: string;
    max_calls_per_sync?: number;
    download_recordings?: boolean;
    credentials_configured?: boolean;
    enabled?: boolean;
    sync_interval?: string;
    [k: string]: unknown;
  };
  openDental?: {
    enabled?: boolean;
    connection_type?: string;
    api_url_configured?: boolean;
    api_key_configured?: boolean;
    developer_key_configured?: boolean;
    customer_key_configured?: boolean;
    db_url_configured?: boolean;
    api_url?: string;
    [k: string]: unknown;
  };
  transcription?: { provider?: string; configured?: boolean; enabled?: boolean };
  analysis?: { provider?: string; model?: string; configured?: boolean; enabled?: boolean };
}

export interface SyncHistoryEntry {
  id: string;
  started_at: string;
  completed_at?: string;
  calls_processed?: number;
  errors?: string[];
  status?: string;
}

export interface AdminQueuesData {
  transcription: { pending: number; processing: number; completed_today: number };
  analysis: { pending: number; processing: number; completed_today: number };
  open_dental_sync: { pending: number; processing: number; completed_today: number };
}

export interface AdminErrorEntry {
  sync_id: string;
  timestamp: string;
  error: string;
}
```

### 3C. Update existing admin methods and add new ones

Replace the three existing weakly-typed admin methods and add five new ones:

```typescript
async getAdminHealth(): Promise<AdminHealthData> {
  return request<AdminHealthData>('/admin/health');
},

async getAdminConfig(): Promise<{ success: boolean; config: AdminConfigData }> {
  return request<{ success: boolean; config: AdminConfigData }>('/admin/config');
},

async getAdminCosts(): Promise<{ success: boolean; costs: AdminCostsData }> {
  return request<{ success: boolean; costs: AdminCostsData }>('/admin/costs');
},

// Keep existing — no change needed:
// getAdminSyncStatus(), testConnection(), triggerMangoSync()

async getAdminSyncHistory(): Promise<{ success: boolean; history: SyncHistoryEntry[] }> {
  return request<{ success: boolean; history: SyncHistoryEntry[] }>('/admin/sync/history');
},

async startMangoScheduler(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/admin/sync/start', { method: 'POST' });
},

async stopMangoScheduler(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('/admin/sync/stop', { method: 'POST' });
},

async getAdminQueues(): Promise<{ success: boolean; queues: AdminQueuesData }> {
  return request<{ success: boolean; queues: AdminQueuesData }>('/admin/queues');
},

async getAdminErrors(): Promise<{ success: boolean; errors: AdminErrorEntry[] }> {
  return request<{ success: boolean; errors: AdminErrorEntry[] }>('/admin/errors');
},

async getNotificationsConfig(): Promise<NotificationsConfig> {
  const res = await request<{ success: boolean; config: NotificationsConfig }>('/notifications-config');
  return res.config;
},

async saveNotificationsConfig(config: Omit<NotificationsConfig, 'lastSaved'>): Promise<NotificationsConfig> {
  const res = await request<{ success: boolean; config: NotificationsConfig }>(
    '/notifications-config',
    { method: 'PUT', body: JSON.stringify(config) }
  );
  return res.config;
},
```

### Phase 3 Audit Gate
`npx tsc --noEmit` from `new-dashboard/` — zero errors. No `any` types introduced.

---

## Phase 4 — Admin.tsx: Full Rewrite of All Four Tabs

Read the full `Admin.tsx` file before modifying. Keep ALL existing fetch logic, state, and utility functions (`formatTimestamp`, `getIconEmoji`, `INTEGRATION_DEFS`). Only change what is explicitly described below.

### 4A. Update state and imports

Replace the existing three `useState` type imports with the new typed interfaces. Update state declarations:

```typescript
import type {
  AdminHealthData, AdminConfigData, AdminCostsData,
  SyncHistoryEntry, AdminQueuesData, AdminErrorEntry,
  NotificationsConfig,
} from '@/lib/api';
```

Replace state declarations:
```typescript
const [health, setHealth] = useState<AdminHealthData | null>(null);
const [config, setConfig] = useState<AdminConfigData | null>(null);
const [costs, setCosts] = useState<AdminCostsData | null>(null);

// New state:
const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[]>([]);
const [queues, setQueues] = useState<AdminQueuesData | null>(null);
const [adminErrors, setAdminErrors] = useState<AdminErrorEntry[]>([]);
const [notifConfig, setNotifConfig] = useState<NotificationsConfig>({
  emergencyCallAlerts: true,
  missedCallNotifications: true,
  dailyCallSummaryEmail: true,
  agentErrorAlerts: false,
  lastSaved: null,
});
const [notifHasUnsaved, setNotifHasUnsaved] = useState(false);
const [notifSaving, setNotifSaving] = useState(false);
const [startingScheduler, setStartingScheduler] = useState(false);
const [stoppingScheduler, setStoppingScheduler] = useState(false);
const [syncHistoryOpen, setSyncHistoryOpen] = useState(false);
```

### 4B. Update fetchData to load all data sources

Replace the existing `fetchData` callback with this expanded version:

```typescript
const fetchData = useCallback(async () => {
  setLoading(true);
  setError(null);
  try {
    const [healthRes, configRes, costsRes, historyRes, queuesRes, errorsRes, notifRes] =
      await Promise.allSettled([
        api.getAdminHealth(),
        api.getAdminConfig(),
        api.getAdminCosts(),
        api.getAdminSyncHistory(),
        api.getAdminQueues(),
        api.getAdminErrors(),
        api.getNotificationsConfig(),
      ]);

    if (healthRes.status === 'fulfilled') setHealth(healthRes.value);
    if (configRes.status === 'fulfilled') setConfig(configRes.value.config ?? null);
    if (costsRes.status === 'fulfilled') setCosts(costsRes.value.costs ?? null);
    if (historyRes.status === 'fulfilled') setSyncHistory(historyRes.value.history ?? []);
    if (queuesRes.status === 'fulfilled') setQueues(queuesRes.value.queues ?? null);
    if (errorsRes.status === 'fulfilled') setAdminErrors(errorsRes.value.errors ?? []);
    if (notifRes.status === 'fulfilled') setNotifConfig(notifRes.value);

    if (
      healthRes.status === 'rejected' &&
      configRes.status === 'rejected' &&
      costsRes.status === 'rejected'
    ) {
      setError('Unable to reach admin API. Is the backend running?');
    }
  } catch (err) {
    setError(err instanceof Error ? err.message : 'Failed to load admin data');
  } finally {
    setLoading(false);
  }
}, []);
```

### 4C. Add scheduler control handlers

```typescript
const handleStartScheduler = async () => {
  setStartingScheduler(true);
  try {
    const res = await api.startMangoScheduler();
    if (res.success) { toast.success(res.message || 'Scheduler started'); fetchData(); }
    else toast.error(res.message || 'Failed to start scheduler');
  } catch { toast.error('Failed to start scheduler'); }
  finally { setStartingScheduler(false); }
};

const handleStopScheduler = async () => {
  setStoppingScheduler(true);
  try {
    const res = await api.stopMangoScheduler();
    if (res.success) { toast.success(res.message || 'Scheduler stopped'); fetchData(); }
    else toast.error(res.message || 'Failed to stop scheduler');
  } catch { toast.error('Failed to stop scheduler'); }
  finally { setStoppingScheduler(false); }
};
```

### 4D. Add notification save handler

```typescript
const handleSaveNotifications = async () => {
  setNotifSaving(true);
  try {
    const { lastSaved: _ls, ...toSave } = notifConfig;
    const saved = await api.saveNotificationsConfig(toSave);
    setNotifConfig(saved);
    setNotifHasUnsaved(false);
    toast.success('Notification settings saved');
  } catch {
    toast.error('Save failed — try again');
  } finally {
    setNotifSaving(false);
  }
};
```

---

### 4E. Office tab — TWO location cards

Replace the entire `{activeTab === "offices" && ...}` block:

Show two `Card` components side-by-side (`grid grid-cols-1 md:grid-cols-2 gap-4`, max-width `max-w-4xl`), one for each office:

| Field | Valley Family Dental | Roland Family Dental |
|---|---|---|
| Name | Valley Family Dental | Roland Family Dental |
| Location | Fort Smith, AR | Roland, OK |
| Icon | `Building2` | `Building2` |
| Status badge | Pulled from `health?.status` — if `"healthy"` → green "Active", otherwise amber with the status string |
| Service chips | Same chips from the current implementation — iterate `Object.entries(services)` |
| Estimated cost | `costs?.total_estimated` — show the same value on both cards (system-level, not per-office) formatted as `$X.XX` |
| Last checked | `health?.timestamp` formatted with `formatTimestamp` |

Both cards get the same live data (there is one backend for both practices). Make it visually clear this is system-level status shared across offices.

No "Edit" or "Configure" buttons — read-only.

---

### 4F. Users tab — structured placeholder

Replace the entire `{activeTab === "users" && ...}` block with this layout (max-width `max-w-2xl`):

**Section 1 — Current System User (one Card)**

Show a single user card:
- Avatar: `"FD"` initials in a circle with the primary color background
- Name: `"Front Desk"`
- Role badge: `"Administrator"`
- Access: `"All offices"`
- Status badge: `"Active"` in green

**Section 2 — Planned Features (one Card, below)**

Title: "User Management — Coming Soon"
Description line: "Role-based access and team invitations will be available in a future update."

Bullet list of planned features (use `CheckCircle2` icon in muted color for each):
- Invite staff by email
- Role-based access control (Admin, Scheduler, View-only)
- Per-office access restrictions
- Session audit log

Use `ChevronRight` icons or a styled list — do NOT use fake toggle switches or action buttons. This is informational only.

---

### 4G. Integrations tab — Mango card enhancements

The Integrations tab renders a grid of integration cards from `INTEGRATION_DEFS`. Only the Mango card needs changes — all others stay the same.

Find where the Mango card's action buttons are rendered (the `intg.canSync && connected` block). Expand it:

1. **Start/Stop scheduler buttons** — shown when Mango is connected:
   - If `svc?.scheduler_running` is true: show a "Stop" button (variant `"outline"`, red/destructive label, calls `handleStopScheduler`, disabled when `stoppingScheduler`)
   - If `svc?.scheduler_running` is false: show a "Start" button (variant `"outline"`, calls `handleStartScheduler`, disabled when `startingScheduler`)
   - Keep the existing Sync (run once) button

2. **Sync history disclosure** — below the Mango card content, add a toggle button: `"Sync history (${syncHistory.length})"`. When clicked (`syncHistoryOpen` toggle), show a compact list of the last 5 entries from `syncHistory`:
   - Each row: timestamp (`started_at` formatted with `formatTimestamp`), calls processed (`calls_processed ?? 0`), and a green "OK" or red error count badge
   - If `syncHistory` is empty: show `"No sync history yet"`
   - Use `ChevronDown` / `ChevronRight` to indicate open/closed

---

### 4H. Settings tab — fixes and new sections

**Fix cost display (critical bug):**

In the `CostsData`-related rendering, costs are now numbers. Update the display:

```tsx
{/* In the Office tab cost summary: */}
${costs.total_estimated.toFixed(2)}

{/* In the Settings tab transcription block: */}
<div>Estimated cost: ${costs.transcription.estimated_cost.toFixed(4)}</div>

{/* In the Settings tab analysis block: */}
<div>Estimated cost: ${costs.analysis.estimated_cost.toFixed(4)}</div>

{/* In the Settings tab total: */}
<span className="text-lg font-bold">${costs.total_estimated.toFixed(2)}</span>
```

Remove all `typeof ... === "number"` guards — costs are always numbers now.

**Fix notification toggles (critical bug):**

Replace the hardcoded notification toggle array with state-driven toggles. The four toggles map to `notifConfig` keys:

| Display label | Config key |
|---|---|
| Emergency call alerts | `emergencyCallAlerts` |
| Missed call notifications | `missedCallNotifications` |
| Daily call summary email | `dailyCallSummaryEmail` |
| Agent error alerts | `agentErrorAlerts` |

Each toggle:
- `checked` value reads from `notifConfig[key]`
- `onClick` calls `setNotifConfig(prev => ({ ...prev, [key]: !prev[key] }))` and `setNotifHasUnsaved(true)`

Add a Save button below the toggles:
- Label: `notifHasUnsaved ? 'Save changes' : 'Saved'`
- Shows spinner when `notifSaving`
- Calls `handleSaveNotifications()`
- Last saved: small muted text showing `notifConfig.lastSaved ? \`Last saved ${new Date(notifConfig.lastSaved).toLocaleString()}\` : 'Never saved'`

**Add Processing Queues section (new Card, after AI Services):**

```tsx
<Card>
  <CardHeader className="pb-3">
    <CardTitle className="text-base font-semibold">Processing Queues</CardTitle>
  </CardHeader>
  <CardContent>
    {queues ? (
      <div className="space-y-3">
        {([
          { label: 'Transcription', q: queues.transcription },
          { label: 'Call Analysis', q: queues.analysis },
          { label: 'Open Dental Sync', q: queues.open_dental_sync },
        ] as const).map(({ label, q }) => (
          <div key={label} className="flex items-center justify-between">
            <span className="text-sm text-foreground">{label}</span>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {q.pending > 0 && <span className="text-amber-600">{q.pending} pending</span>}
              {q.processing > 0 && <span className="text-blue-600">{q.processing} processing</span>}
              <span>{q.completed_today} today</span>
            </div>
          </div>
        ))}
      </div>
    ) : (
      <p className="text-xs text-muted-foreground">Queue data unavailable</p>
    )}
  </CardContent>
</Card>
```

**Add Recent Errors section (new Card, at bottom of Settings tab):**

Only render this card if `adminErrors.length > 0`. Show the last 10 errors:

```tsx
{adminErrors.length > 0 && (
  <Card>
    <CardHeader className="pb-3">
      <CardTitle className="text-base font-semibold flex items-center gap-2">
        <AlertCircle size={14} className="text-destructive" />
        Recent Sync Errors
        <span className="ml-auto text-xs font-normal text-muted-foreground">{adminErrors.length} total</span>
      </CardTitle>
    </CardHeader>
    <CardContent>
      <div className="space-y-2">
        {adminErrors.slice(0, 10).map((e, i) => (
          <div key={i} className="text-xs p-2 rounded bg-destructive/5 border border-destructive/10">
            <div className="text-muted-foreground mb-0.5">{formatTimestamp(e.timestamp)}</div>
            <div className="text-foreground font-medium truncate">{e.error}</div>
          </div>
        ))}
      </div>
    </CardContent>
  </Card>
)}
```

### Phase 4 Audit Gate
`npx tsc --noEmit` — zero errors. No `any` types. Verify:
- [ ] Office tab shows two cards side by side
- [ ] Users tab shows one user card + planned features card (no action buttons)
- [ ] Integrations tab: Retell test no longer fails; Mango card has Start/Stop buttons
- [ ] Settings tab: cost values render without `$$` double-dollar bug
- [ ] Notification toggles load from backend and save on click

---

## Phase 5 — DashboardLayout: Real Connection Status

Read `new-dashboard/client/src/components/DashboardLayout.tsx` fully before modifying.

### Replace hardcoded `isConnected`

Remove:
```typescript
const [isConnected] = useState(true);
```

Replace with:
```typescript
const [isConnected, setIsConnected] = useState(false);

useEffect(() => {
  let cancelled = false;

  const check = () => {
    api.getAdminHealth()
      .then(() => { if (!cancelled) setIsConnected(true); })
      .catch(() => { if (!cancelled) setIsConnected(false); });
  };

  check(); // immediate first check
  const interval = setInterval(check, 30_000); // then every 30s
  return () => { cancelled = true; clearInterval(interval); };
}, []);
```

Add the `api` import at the top of the file if it is not already imported:
```typescript
import { api } from '@/lib/api';
```

No other changes to DashboardLayout.

### Phase 5 Audit Gate
`npx tsc --noEmit` — zero errors. Sidebar shows "Offline" when backend is not running, "Connected" when it is.

---

## Files to Create

| File | Purpose |
|---|---|
| `data/notifications-config.json` | Notification toggle state |
| `backend/routes/notificationsConfig.js` | GET/PUT route, atomic write |

## Files to Modify

| File | Change |
|---|---|
| `backend/routes/admin.js` | Fix costs (numbers not strings), add Retell test case |
| `backend/server.js` | Register `/api/notifications-config` route |
| `new-dashboard/client/src/lib/api.ts` | New interfaces + 10 new/updated methods |
| `new-dashboard/client/src/pages/Admin.tsx` | Full tab rewrites (Office, Users, Integrations, Settings) |
| `new-dashboard/client/src/components/DashboardLayout.tsx` | Real connection status |

## Files NOT to Touch

- `backend/routes/agentConfig.js` — reference only
- `backend/routes/retellToolsConfig.js` — reference only
- `backend/middleware/auth.js` — import only
- `data/agent-config.json`, `data/retell-tools-config.json` — do not modify
- Any calendar, slot markers, scheduling, or call detail files
- `AgentBuilder.tsx`, `CallDetail.tsx`, `Scheduling.tsx` — do not touch

---

## Final Audit Gate — Full Checklist

**TypeScript**
- [ ] `npx tsc --noEmit` exits 0 from `new-dashboard/`
- [ ] No `any` types introduced in modified files
- [ ] All new interfaces exported from `api.ts`

**Phase 1 fixes**
- [ ] `GET /api/admin/costs` — `estimated_cost` and `total_estimated` are numbers (test with curl)
- [ ] Retell "Test" button shows success toast if `RETELL_API_KEY` is set, error toast if not
- [ ] No `$$` prefix on cost values anywhere in the UI

**Phase 2 notifications**
- [ ] `GET /api/notifications-config` returns boolean toggle state
- [ ] Toggling a switch and saving writes to `data/notifications-config.json`
- [ ] Reload — toggle state persists

**Phase 3 new API methods**
- [ ] No TypeScript errors on new method signatures

**Phase 4 Office tab**
- [ ] Two office cards: Valley Family Dental (Fort Smith, AR) and Roland Family Dental (Roland, OK)
- [ ] Status badge reflects `health?.status`
- [ ] Service chips render on both cards

**Phase 4 Users tab**
- [ ] Front Desk user card with Administrator badge
- [ ] Planned features list with no fake action buttons

**Phase 4 Integrations tab**
- [ ] Mango card: Start/Stop scheduler buttons appear (Start when stopped, Stop when running)
- [ ] Mango sync history toggle shows last 5 entries or "No sync history yet"

**Phase 4 Settings tab**
- [ ] Cost display: no double-dollar sign, correct decimal formatting
- [ ] Notification toggles load from backend and save correctly
- [ ] Processing Queues card shows transcription, analysis, OD sync queue stats
- [ ] Recent Errors card appears only when errors exist

**Phase 5 DashboardLayout**
- [ ] Stop the backend — sidebar shows "Offline" within 30 seconds
- [ ] Start the backend — sidebar shows "Connected" at next check

**Code quality**
- [ ] No `console.log` in production code
- [ ] No `TODO` comments in changed files
- [ ] No hardcoded patient IDs, test values, or credentials

**Maximum 20 attempts per gate. Write `BLOCKED.md` if any gate cannot pass.**

Commit on pass: `feat: admin page full wiring and bug fixes`
