/**
 * Retell Tools Config Routes
 *
 * Per-tool enable/disable flags for the four Retell custom-function
 * endpoints in `backend/routes/retellTools.js`. Lets staff toggle
 * individual tools (e.g. live booking) without flipping the global
 * `RETELL_TOOLS_ENABLED` env var.
 *
 * Storage:
 *   `data/retell-tools-config.json`, written atomically (tmp + rename)
 *   on every PUT. A single in-flight guard collapses bursty saves so
 *   we never race on disk. Same pattern as `routes/agentConfig.js`.
 *
 * Auth:
 *   Inherits the bearer-token gate mounted in `server.js` at
 *   `app.use('/api', requireDashboardToken(...))`. The exempt regex
 *   `^\/retell-tools(\/|$)/` does NOT match `/retell-tools-config` (the
 *   `-config` suffix is neither `/` nor end-of-string), so this router
 *   is gated like other dashboard endpoints.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'retell-tools-config.json');
const CONFIG_TMP_PATH = `${CONFIG_PATH}.tmp`;

const DEFAULT_CONFIG = {
  lookupPatient: true,
  findAvailableSlots: true,
  bookAppointment: false,
  createCallback: true,
  lastSaved: null,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch (err) {
    console.error('⚠️  Failed to load retell-tools-config.json — using defaults:', err.message);
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
      console.error('❌ Failed to persist retell-tools-config.json:', err.message);
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
 * GET /api/retell-tools-config
 * Return the current persisted config, or defaults if the file is missing.
 */
router.get('/', (req, res) => {
  try {
    const config = loadConfig();
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to load tools config' });
  }
});

/**
 * PUT /api/retell-tools-config
 * Replace the four tool flags from the request body and stamp `lastSaved`.
 * Booleans are coerced with `!!` so the client can't poison the file with
 * non-boolean values.
 */
router.put('/', async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
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

    await persist(updated);
    res.json({ success: true, config: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to save tools config' });
  }
});

module.exports = router;
