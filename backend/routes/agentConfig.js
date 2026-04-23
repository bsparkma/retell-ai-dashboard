/**
 * Agent Config Routes
 *
 * Persists the Agent Builder knowledge base + system prompt to disk so that
 * every staff member on every device sees the same configuration. Previously
 * everything lived in browser localStorage, which meant whichever device
 * published last "won" and any browser-cache clear nuked the practice's
 * carefully tuned knowledge base.
 *
 * Storage:
 *   `data/agent-config.json`, written atomically (tmp file + rename) on every
 *   PUT. A single in-flight guard collapses bursty saves so we never race on
 *   disk. Same pattern as `routes/callbacks.js`.
 *
 * Auth:
 *   Inherits the bearer-token gate mounted in `server.js` at `app.use('/api',
 *   requireDashboardToken(...))`, so unauthenticated callers get 401 from the
 *   middleware before reaching this router.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'agent-config.json');
const CONFIG_TMP_PATH = `${CONFIG_PATH}.tmp`;

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
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    console.error('⚠️  Failed to load agent-config.json — using defaults:', err.message);
    return { ...DEFAULT_CONFIG };
  }
}

let persistInFlight = null;
let persistRequeued = false;
let pendingSnapshot = null;

async function persist(config) {
  pendingSnapshot = config;

  if (persistInFlight) {
    persistRequeued = true;
    return persistInFlight;
  }

  persistInFlight = (async () => {
    try {
      do {
        persistRequeued = false;
        const snapshot = pendingSnapshot;
        await fsp.mkdir(DATA_DIR, { recursive: true });
        await fsp.writeFile(CONFIG_TMP_PATH, JSON.stringify(snapshot, null, 2));
        await fsp.rename(CONFIG_TMP_PATH, CONFIG_PATH);
      } while (persistRequeued);
    } catch (err) {
      console.error('❌ Failed to persist agent-config.json:', err.message);
      try {
        await fsp.unlink(CONFIG_TMP_PATH);
      } catch (_) {
        /* ignore */
      }
    } finally {
      persistInFlight = null;
    }
  })();

  return persistInFlight;
}

/**
 * GET /api/agent-config
 * Return the current persisted config, or defaults if the file is missing.
 */
router.get('/', (req, res) => {
  try {
    const config = loadConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load agent config' });
  }
});

/**
 * PUT /api/agent-config
 * Replace the persisted config with the request body and stamp lastSaved.
 * Body shape mirrors the frontend AgentConfig (name, prompt, knowledge,
 * customSections, retellAgentId, lastPublished).
 */
router.put('/', async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid config body' });
    }

    const current = loadConfig();
    const updated = {
      ...current,
      ...incoming,
      lastSaved: new Date().toISOString(),
    };

    await persist(updated);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save agent config' });
  }
});

module.exports = router;
