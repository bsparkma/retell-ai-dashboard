# Retell Tools Config UI — Cursor Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before writing any code. All decisions are made. Build exactly what is described. Run `npx tsc --noEmit` from `new-dashboard/` after every file change. Maximum 20 attempts per audit gate. If you cannot pass a gate after 20 attempts, write `BLOCKED.md` and stop.

---

## Context

The backend has four Retell custom function ("tool") endpoints in `backend/routes/retellTools.js`:

| Tool key | What it does |
|---|---|
| `lookupPatient` | Looks up a patient by phone or name before offering a slot |
| `findAvailableSlots` | Finds open appointment slots via the slot marker system |
| `bookAppointment` | Books the appointment directly into Open Dental |
| `createCallback` | Drops a callback request for staff to follow up |

Currently all four are enabled or disabled together via the `RETELL_TOOLS_ENABLED` env var — it is a global on/off switch. There is no way to enable patient lookup but disable live booking, for example.

**The goal:** Add a per-tool enable/disable config stored in the backend (JSON file, same pattern as `data/agent-config.json`), a backend route to read/write it, and a UI card on the Agent Builder page so staff can toggle each tool without touching env vars.

---

## What Is In Scope

- `data/retell-tools-config.json` — new JSON config file
- `backend/routes/retellToolsConfig.js` — GET/PUT route for tool config (same atomic-write pattern as `agentConfig.js`)
- Route registration in `backend/server.js`
- `backend/routes/retellTools.js` — per-tool enable check added to each handler
- Frontend `api.ts` — two new methods: `getRetellToolsConfig()` and `saveRetellToolsConfig()`
- `AgentBuilder.tsx` — new "Agent Tools" card at the bottom of the page
- TypeScript interface `RetellToolsConfig` in `api.ts`

## What Is NOT In Scope

- Do not change the global `RETELL_TOOLS_ENABLED` env var behavior — it remains the master on/off. Per-tool config only matters when `RETELL_TOOLS_ENABLED=true`.
- Do not change any existing tool logic, timeouts, signatures, or response shapes
- Do not create a new page — the card lives on the existing Agent Builder page
- No Retell API calls — this is local config only
- No changes to slot markers, calendar, or any other feature

---

## Phase 1 — Backend Config File and Route

### Step 1A: Create `data/retell-tools-config.json`

```json
{
  "lookupPatient": true,
  "findAvailableSlots": true,
  "bookAppointment": false,
  "createCallback": true,
  "lastSaved": null
}
```

Note: `bookAppointment` defaults to `false` — live booking requires the Open Dental connector to be fully configured. Staff must explicitly enable it.

### Step 1B: Create `backend/routes/retellToolsConfig.js`

Follow the `agentConfig.js` pattern exactly. Use atomic write (temp + rename) and in-flight coalescing.

```javascript
// backend/routes/retellToolsConfig.js

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '../../data/retell-tools-config.json');

const DEFAULT_CONFIG = {
  lookupPatient: true,
  findAvailableSlots: true,
  bookAppointment: false,
  createCallback: true,
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

// GET /api/retell-tools-config
router.get('/', (req, res) => {
  try {
    res.json({ success: true, config: loadConfig() });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load tools config' });
  }
});

// PUT /api/retell-tools-config
router.put('/', (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid config body' });
    }
    const updated = {
      ...loadConfig(),
      lookupPatient: !!incoming.lookupPatient,
      findAvailableSlots: !!incoming.findAvailableSlots,
      bookAppointment: !!incoming.bookAppointment,
      createCallback: !!incoming.createCallback,
      lastSaved: new Date().toISOString(),
    };
    persistConfig(updated);
    res.json({ success: true, config: updated });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to save tools config' });
  }
});

module.exports = router;
```

**Note:** This route does NOT use `authenticateToken` middleware — the backend uses a global `requireDashboardToken()` applied to all `/api` routes in `server.js`. Do not add per-route auth. Follow the same pattern as `agentConfig.js`.

### Step 1C: Register in `backend/server.js`

Find where other routes are registered and add:

```javascript
const retellToolsConfigRouter = require('./routes/retellToolsConfig');
app.use('/api/retell-tools-config', retellToolsConfigRouter);
```

### Phase 1 Audit Gate
`GET /api/retell-tools-config` returns `{ success: true, config: { lookupPatient, findAvailableSlots, bookAppointment, createCallback, lastSaved } }` (test with curl or Postman with Bearer token).

---

## Phase 2 — Per-Tool Enable Check in retellTools.js

Read `backend/routes/retellTools.js` fully before modifying.

Add a `loadToolsConfig()` helper at the top of the file (after the existing imports):

```javascript
const path = require('path');
const fs = require('fs');

const TOOLS_CONFIG_FILE = path.join(__dirname, '../../data/retell-tools-config.json');

function loadToolsConfig() {
  try {
    const raw = fs.readFileSync(TOOLS_CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { lookupPatient: true, findAvailableSlots: true, bookAppointment: false, createCallback: true };
  }
}
```

**Do not check if `path` or `fs` are already required** — if they are, do not add duplicate requires. Only add the missing ones.

Then add a per-tool guard at the START of each handler, before any logic:

```javascript
// In router.post('/lookup_patient', ...)
const toolsConfig = loadToolsConfig();
if (!toolsConfig.lookupPatient) {
  return res.json({ ok: false, message: 'Patient lookup is currently disabled.' });
}

// In router.post('/find_available_slots', ...)
if (!toolsConfig.findAvailableSlots) {
  return res.json({ ok: false, message: 'Slot finder is currently disabled.' });
}

// In router.post('/book_appointment', ...)
if (!toolsConfig.bookAppointment) {
  return res.json({ ok: false, message: 'Live booking is currently disabled. I will take a message instead.', booked: false });
}

// In router.post('/create_callback', ...)
if (!toolsConfig.createCallback) {
  return res.json({ ok: true, created: false, message: 'Callback logging is currently disabled.' });
}
```

**Important:** These checks run AFTER the existing global middleware (which verifies `RETELL_TOOLS_ENABLED` and the request signature). Do not move or bypass that middleware.

Update the `/health` endpoint to include per-tool status:

```javascript
router.get('/health', (_req, res) => {
  const toolsConfig = loadToolsConfig();
  res.json({
    ok: true,
    enabled: process.env.RETELL_TOOLS_ENABLED === 'true',
    tools: {
      lookup_patient: toolsConfig.lookupPatient,
      find_available_slots: toolsConfig.findAvailableSlots,
      book_appointment: toolsConfig.bookAppointment,
      create_callback: toolsConfig.createCallback,
    },
  });
});
```

### Phase 2 Audit Gate
No TypeScript — just verify the JS is syntactically valid. `node -e "require('./backend/routes/retellTools')"` should exit cleanly.

---

## Phase 3 — Frontend Types and API Methods

Read `new-dashboard/client/src/lib/api.ts` fully before modifying.

### Add `RetellToolsConfig` interface

Add near the other interfaces (after `OdPatient` or near `AgentConfig`):

```typescript
export interface RetellToolsConfig {
  lookupPatient: boolean;
  findAvailableSlots: boolean;
  bookAppointment: boolean;
  createCallback: boolean;
  lastSaved: string | null;
}
```

### Add two API methods

Follow the exact same pattern as `getAgentConfig()` and `saveAgentConfig()`:

```typescript
async getRetellToolsConfig(): Promise<RetellToolsConfig> {
  const res = await this.request<{ success: boolean; config: RetellToolsConfig }>('/retell-tools-config');
  return res.config;
}

async saveRetellToolsConfig(config: Omit<RetellToolsConfig, 'lastSaved'>): Promise<RetellToolsConfig> {
  const res = await this.request<{ success: boolean; config: RetellToolsConfig }>(
    '/retell-tools-config',
    { method: 'PUT', body: JSON.stringify(config) }
  );
  return res.config;
}
```

### Phase 3 Audit Gate
`npx tsc --noEmit` — zero errors.

---

## Phase 4 — Agent Tools Card in AgentBuilder.tsx

Read `AgentBuilder.tsx` fully before modifying.

### State to add

```typescript
const [toolsConfig, setToolsConfig] = useState<RetellToolsConfig>({
  lookupPatient: true,
  findAvailableSlots: true,
  bookAppointment: false,
  createCallback: true,
  lastSaved: null,
});
const [toolsHasUnsaved, setToolsHasUnsaved] = useState(false);
const [toolsSaving, setToolsSaving] = useState(false);
```

Import `RetellToolsConfig` from `@/lib/api` at the top of the file.

### Load effect (runs once on mount, alongside existing agent config load)

```typescript
useEffect(() => {
  api.getRetellToolsConfig()
    .then((cfg) => setToolsConfig(cfg))
    .catch(() => {
      // Backend unavailable — stay on defaults, no toast (agent config already shows one)
    });
}, []);
```

### Toggle handler

```typescript
function handleToolToggle(key: keyof Omit<RetellToolsConfig, 'lastSaved'>) {
  setToolsConfig((prev) => ({ ...prev, [key]: !prev[key] }));
  setToolsHasUnsaved(true);
}
```

### Save handler

```typescript
async function handleSaveTools() {
  setToolsSaving(true);
  try {
    const { lastSaved: _ls, ...toSave } = toolsConfig;
    const saved = await api.saveRetellToolsConfig(toSave);
    setToolsConfig(saved);
    setToolsHasUnsaved(false);
    toast.success('Tool settings saved');
  } catch {
    toast.error('Save failed — try again');
  } finally {
    setToolsSaving(false);
  }
}
```

### Agent Tools Card

Add this card at the bottom of the Agent Builder page, after the existing knowledge section cards and before any footer/publish controls. Use the same `Card`, `CardHeader`, `CardTitle`, `CardContent` components already on the page.

**Card title:** "Agent Tools"

**Card description (small muted text below title):** "Control which live-call tools the AI agent can use. The global `RETELL_TOOLS_ENABLED` env var must also be `true` for any tool to fire."

**Tool rows** — one per tool, in this order:

| Toggle key | Display name | Description |
|---|---|---|
| `lookupPatient` | Patient Lookup | Lets the agent find an existing patient record by phone number before offering an appointment |
| `findAvailableSlots` | Slot Finder | Lets the agent offer specific open time slots from the schedule |
| `bookAppointment` | Live Booking | Lets the agent book directly into Open Dental. **Only enable when the OD connector is fully configured.** Shown with an amber warning badge: "Requires OD connector" |
| `createCallback` | Callback Creation | Lets the agent drop a callback request into the staff queue when it can't resolve the caller's need |

Each row layout:
- Left: tool name (semibold) + description (muted small text)
- Right: a `Switch` component (from `@/components/ui/switch`) — checked when enabled

The `bookAppointment` row shows an amber badge (`bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded`) reading "Requires OD connector" below the description. It is not disabled — staff can toggle it, but they are warned.

**Below the tool rows:** a `Save` button (same style as the main agent config Save button):
- Label: `toolsHasUnsaved ? 'Save changes' : 'Saved'`
- Shows spinner when `toolsSaving`
- Calls `handleSaveTools()`
- On the right side of the card footer

**Last saved timestamp:** Small muted text: `toolsConfig.lastSaved ? \`Last saved ${new Date(toolsConfig.lastSaved).toLocaleString()}\` : 'Never saved'`

### Phase 4 Audit Gate
`npx tsc --noEmit` — zero errors. No `any` types.

Verify manually:
- [ ] Agent Builder page loads — "Agent Tools" card appears at bottom
- [ ] Each toggle reflects the saved state from the JSON file
- [ ] Toggling a switch sets unsaved indicator
- [ ] Save button calls `PUT /api/retell-tools-config` and shows success toast
- [ ] After save, `data/retell-tools-config.json` reflects the new values
- [ ] `bookAppointment` row shows amber badge

---

## Files to Create

| File | Purpose |
|---|---|
| `data/retell-tools-config.json` | Per-tool enable/disable state |
| `backend/routes/retellToolsConfig.js` | GET/PUT route |

## Files to Modify

| File | Change |
|---|---|
| `backend/server.js` | Register `/api/retell-tools-config` route |
| `backend/routes/retellTools.js` | Add `loadToolsConfig()` + per-tool guards + health update |
| `new-dashboard/client/src/lib/api.ts` | Add `RetellToolsConfig` interface + two methods |
| `new-dashboard/client/src/pages/AgentBuilder.tsx` | Add tools state, load effect, handlers, Agent Tools card |

## Files NOT to Touch

- `backend/middleware/auth.js`
- `data/agent-config.json`
- `data/callbacks.json`
- `backend/routes/agentConfig.js`
- Any calendar, slot marker, or scheduling files
- Any other page

---

## Final Audit Gate — Full Checklist

**TypeScript**
- [ ] `npx tsc --noEmit` exits 0 from `new-dashboard/`
- [ ] No `any` types in modified files
- [ ] `RetellToolsConfig` exported from `api.ts`

**Backend**
- [ ] `GET /api/retell-tools-config` returns tool states (with Bearer token)
- [ ] `GET /api/retell-tools-config` returns 401 without token
- [ ] `PUT /api/retell-tools-config` updates `data/retell-tools-config.json` on disk
- [ ] `PUT /api/retell-tools-config` sets `lastSaved` to ISO timestamp
- [ ] Toggling a tool to `false` causes `retellTools.js` to return the disabled message for that tool
- [ ] Global `RETELL_TOOLS_ENABLED=false` still blocks ALL tools regardless of per-tool state

**Frontend**
- [ ] Agent Tools card appears on Agent Builder page
- [ ] All four toggles render correctly and reflect saved state
- [ ] `bookAppointment` row has amber "Requires OD connector" badge
- [ ] Toggle → unsaved indicator → Save button → success toast → `hasUnsaved` resets
- [ ] Last saved timestamp updates after save
- [ ] Rest of Agent Builder page unchanged (knowledge sections, Publish still work)

**Code quality**
- [ ] No `console.log` in production code (Node console.error for tool errors is fine)
- [ ] No `TODO` comments in changed files
- [ ] No hardcoded tool state or test values

**Maximum 20 attempts per gate. Write `BLOCKED.md` if any gate cannot pass.**

Commit on pass: `feat: retell tools per-tool enable/disable config UI`
