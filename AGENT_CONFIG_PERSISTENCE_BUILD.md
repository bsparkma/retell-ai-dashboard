# Agent Knowledge Base Persistence — Cursor Build Prompt

> **Instructions for Claude in Cursor:** Read this entire file before writing any code. All decisions are made. Build exactly what is described. Run `tsc --noEmit` from `new-dashboard/` after every file change. Maximum 20 attempts per audit gate. If you cannot pass a gate after 20 attempts, write `BLOCKED.md` and stop.

---

## Context

The Agent Builder page (`new-dashboard/client/src/pages/AgentBuilder.tsx`) allows staff to edit 6 knowledge sections (office hours, locations, providers, services, insurance, policies) and custom sections, then publish a compiled prompt to Retell AI.

**The problem:** Everything is saved to `localStorage` only. Different staff members on different devices see different configs. If a browser is cleared, all configuration is lost. The knowledge base is never reliably injected into the Retell agent because whichever device published last wins.

**The fix:** Move storage to a backend JSON file (same pattern as `data/callbacks.json`) and sync on load. localStorage becomes a write-through cache only.

---

## What Is In Scope

- Backend: `GET /api/agent-config` and `PUT /api/agent-config` endpoints
- Backend: JSON file storage at `data/agent-config.json` with atomic writes
- Frontend: Replace localStorage-primary reads/writes with API calls
- Frontend: Unsaved changes indicator + explicit Save button (separate from Publish)
- Frontend: Loading state on initial fetch

## What Is NOT In Scope

- Database (Postgres, SQLite, etc.) — JSON file is sufficient for a single-practice config
- Authentication or per-user config — one config per installation
- Any changes to the Publish flow — publish still compiles and sends to Retell exactly as today
- Any changes to Retell API calls
- Any changes to the 6 knowledge section content or structure
- New knowledge sections or UI redesign

---

## Current State (read before touching anything)

### Frontend: `new-dashboard/client/src/pages/AgentBuilder.tsx`

- `AgentConfig` interface: `{ name, prompt, knowledge: KnowledgeSection[], customSections, lastSaved, retellAgentId, lastPublished }`
- `KnowledgeSection`: `{ id, title, value, icon? }`
- Config loaded from `localStorage` key `"carein-agent-config"` on mount (lines ~220-230)
- Config saved to `localStorage` on every change via a `useEffect`
- `DEFAULT_KNOWLEDGE` defines the 6 built-in sections with placeholder content
- `handlePublish()` compiles knowledge into prompt and calls `api.publishAgent(agentId, { prompt, agent_name })`
- `lastSaved` is set to current ISO timestamp when saved to localStorage

### Backend: existing patterns to follow

- Callbacks use `data/callbacks.json` with atomic write (temp file + rename)
- `backend/routes/callbacks.js` — use this file as the pattern for new route
- Auth middleware: `authenticateToken` (Bearer token) — import from `backend/middleware/auth.js`
- All routes registered in `backend/server.js`

### Frontend API client: `new-dashboard/client/src/lib/api.ts`

- All API calls go through this file
- Add two new methods: `getAgentConfig()` and `saveAgentConfig(config)`
- Base URL pattern already established — follow existing methods exactly

---

## Backend Build

### Step 1: Create `data/agent-config.json`

Create this file with empty initial state:

```json
{
  "name": "",
  "prompt": "",
  "knowledge": [],
  "customSections": [],
  "lastSaved": null,
  "retellAgentId": null,
  "lastPublished": null
}
```

### Step 2: Create `backend/routes/agentConfig.js`

Follow the `callbacks.js` pattern exactly for file loading, atomic persistence, and error handling.

```javascript
// backend/routes/agentConfig.js

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { authenticateToken } = require('../middleware/auth');

const CONFIG_FILE = path.join(__dirname, '../../data/agent-config.json');

const DEFAULT_CONFIG = {
  name: '',
  prompt: '',
  knowledge: [],
  customSections: [],
  lastSaved: null,
  retellAgentId: null,
  lastPublished: null,
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

// GET /api/agent-config
router.get('/', authenticateToken, (req, res) => {
  try {
    const config = loadConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load agent config' });
  }
});

// PUT /api/agent-config
router.put('/', authenticateToken, (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ success: false, error: 'Invalid config body' });
    }
    const current = loadConfig();
    const updated = {
      ...current,
      ...incoming,
      lastSaved: new Date().toISOString(),
    };
    persistConfig(updated);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save agent config' });
  }
});

module.exports = router;
```

### Step 3: Register the route in `backend/server.js`

Find where other routes are registered (e.g., `app.use('/api/callbacks', ...)`) and add:

```javascript
const agentConfigRouter = require('./routes/agentConfig');
app.use('/api/agent-config', agentConfigRouter);
```

---

## Frontend Build

### Step 4: Add API methods to `new-dashboard/client/src/lib/api.ts`

Read the existing file first. Add two methods following the exact same pattern as existing methods:

```typescript
async getAgentConfig(): Promise<AgentConfig> {
  const res = await this.request<{ success: boolean; config: AgentConfig }>('/agent-config');
  return res.config;
}

async saveAgentConfig(config: AgentConfig): Promise<AgentConfig> {
  const res = await this.request<{ success: boolean; config: AgentConfig }>(
    '/agent-config',
    { method: 'PUT', body: JSON.stringify(config) }
  );
  return res.config;
}
```

**Note:** `AgentConfig` is currently defined inside `AgentBuilder.tsx`. If it is not already exported, export it from that file and import it in `api.ts`. Do not duplicate the type.

### Step 5: Update `AgentBuilder.tsx`

Read the entire file before modifying. Make the minimum changes needed:

**A. On mount — load from backend, fall back to localStorage if backend unavailable:**

```typescript
useEffect(() => {
  api.getAgentConfig()
    .then((serverConfig) => {
      // If server has knowledge content, use it; otherwise keep localStorage default
      if (serverConfig.knowledge && serverConfig.knowledge.length > 0) {
        setConfig(serverConfig);
      } else {
        // Server is empty — push localStorage content up to server
        const local = localStorage.getItem('carein-agent-config');
        if (local) {
          const parsed = JSON.parse(local) as AgentConfig;
          setConfig(parsed);
          api.saveAgentConfig(parsed).catch(() => {}); // best-effort migration
        }
      }
    })
    .catch(() => {
      // Backend unavailable — stay on localStorage, show warning toast
      toast.warning('Could not reach backend — changes will only save locally');
    });
}, []);
```

**B. Remove the auto-save to localStorage on every change.** Find the `useEffect` that saves to `localStorage` on every config change and remove it (or keep it as a silent write-through cache — your call, but it must no longer be the primary storage).

**C. Add an explicit Save button** — separate from the Publish button. The save button calls `api.saveAgentConfig(config)` and shows a "Saved" confirmation. Publish continues to work exactly as today.

Add unsaved changes tracking:

```typescript
const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
const [saving, setSaving] = useState(false);
```

Set `hasUnsavedChanges = true` whenever any field in `config` changes after the initial load.

The Save button:
- Label: "Save" when clean, "Save changes" when `hasUnsavedChanges`
- Shows a spinner when `saving`
- On success: `hasUnsavedChanges = false`, toast "Configuration saved"
- On error: toast "Save failed — changes are stored locally only"

**D. The Publish button** — unchanged. Still compiles and sends to Retell. On publish success, also call `saveAgentConfig` to persist `retellAgentId` and `lastPublished` to the backend.

**E. Show last saved time** — replace or supplement the existing localStorage-based timestamp display with `config.lastSaved` from the server.

---

## TypeScript Requirements

- Strict mode is on — no `any` types
- `AgentConfig` and `KnowledgeSection` interfaces must be exported if used in `api.ts`
- `api.ts` additions must match existing method signatures exactly
- Run `npx tsc --noEmit` from `new-dashboard/` after every file change

---

## Files to Create

| File | Action |
|---|---|
| `data/agent-config.json` | Create with empty default state |
| `backend/routes/agentConfig.js` | Create (JS — backend is not TypeScript) |

## Files to Modify

| File | Change |
|---|---|
| `backend/server.js` | Register `/api/agent-config` route |
| `new-dashboard/client/src/lib/api.ts` | Add `getAgentConfig()` and `saveAgentConfig()` |
| `new-dashboard/client/src/pages/AgentBuilder.tsx` | Swap localStorage for API, add Save button, unsaved state |

## Files NOT to Touch

- `backend/routes/callbacks.js` — reference only
- `backend/middleware/auth.js` — import only
- Any calendar, slot markers, or scheduling files
- Any other page or feature

---

## Audit Gate — Pass Criteria

Run `npx tsc --noEmit` from `new-dashboard/`. Zero errors required.

Then verify manually (spin up backend + new-dashboard dev server):

- [ ] `GET /api/agent-config` returns `{ success: true, config: {...} }` with Bearer token
- [ ] `GET /api/agent-config` returns 401 without token
- [ ] `PUT /api/agent-config` with valid body updates `data/agent-config.json` on disk
- [ ] `PUT /api/agent-config` sets `lastSaved` to current ISO timestamp
- [ ] Agent Builder page loads config from backend on mount (not localStorage)
- [ ] If backend is unavailable, localStorage fallback works and toast appears
- [ ] Editing any field sets `hasUnsavedChanges = true`
- [ ] Save button calls `PUT /api/agent-config` and shows "Configuration saved" toast
- [ ] After save, `hasUnsavedChanges` resets to false
- [ ] Publish still works exactly as before — prompt sent to Retell
- [ ] After publish, `retellAgentId` and `lastPublished` saved to backend
- [ ] Restart the backend server — config is still there (file-backed)
- [ ] Open the app in a second browser — same config loads
- [ ] No `any` types in modified files
- [ ] No `console.log` left in production code

**Maximum 20 attempts. If you cannot pass after 20, write `BLOCKED.md` and stop.**

Commit on pass: `feat: agent knowledge base backend persistence`
