/**
 * Callbacks Routes
 *
 * Manages the callback queue — calls that need staff follow-up.
 *
 * Persistence:
 *   The queue is loaded from `data/callbacks.json` at startup and written
 *   back atomically (tmp + rename) on every mutation. The previous
 *   implementation kept callbacks only in memory and seeded fake demo data
 *   on every server start; that meant real callbacks were lost on restart
 *   and fake ones reappeared, both of which are unacceptable when the office
 *   is using this list to call patients back.
 */

const express = require('express');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

const router = express.Router();

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CALLBACKS_PATH = path.join(DATA_DIR, 'callbacks.json');
const CALLBACKS_TMP_PATH = `${CALLBACKS_PATH}.tmp`;

let callbacks = [];
let callbackIdCounter = 1;

// Concurrency guard so two simultaneous mutations don't race on disk.
let persistInFlight = null;
let persistRequeued = false;

function loadFromDisk() {
  try {
    if (!fs.existsSync(CALLBACKS_PATH)) {
      callbacks = [];
      callbackIdCounter = 1;
      return;
    }
    const raw = fs.readFileSync(CALLBACKS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    callbacks = Array.isArray(parsed.callbacks) ? parsed.callbacks : [];
    callbackIdCounter =
      Number.isInteger(parsed.idCounter) && parsed.idCounter > 0
        ? parsed.idCounter
        : Math.max(1, callbacks.length + 1);
    console.log(`✅ Callbacks loaded: ${callbacks.length} entries`);
  } catch (err) {
    console.error('⚠️ Failed to load callbacks.json — starting empty:', err.message);
    callbacks = [];
    callbackIdCounter = 1;
  }
}

async function persist() {
  if (persistInFlight) {
    persistRequeued = true;
    return persistInFlight;
  }

  persistInFlight = (async () => {
    try {
      do {
        persistRequeued = false;
        await fsp.mkdir(DATA_DIR, { recursive: true });
        const snapshot = JSON.stringify(
          {
            callbacks,
            idCounter: callbackIdCounter,
            savedAt: new Date().toISOString(),
          },
          null,
          2,
        );
        await fsp.writeFile(CALLBACKS_TMP_PATH, snapshot);
        await fsp.rename(CALLBACKS_TMP_PATH, CALLBACKS_PATH);
      } while (persistRequeued);
    } catch (err) {
      console.error('❌ Failed to persist callbacks:', err.message);
      try {
        await fsp.unlink(CALLBACKS_TMP_PATH);
      } catch (_) {
        /* ignore */
      }
    } finally {
      persistInFlight = null;
    }
  })();

  return persistInFlight;
}

loadFromDisk();

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * GET /api/callbacks
 * List callbacks, optionally filtered by status / priority.
 */
router.get('/', (req, res) => {
  try {
    const { status, priority } = req.query;
    let filtered = [...callbacks];

    if (status) filtered = filtered.filter(cb => cb.status === status);
    if (priority) filtered = filtered.filter(cb => cb.priority === priority);

    const priorityOrder = { emergency: 0, high: 1, medium: 2, low: 3 };
    filtered.sort((a, b) => {
      const diff = priorityOrder[a.priority] - priorityOrder[b.priority];
      if (diff !== 0) return diff;
      return new Date(a.due_at) - new Date(b.due_at);
    });

    res.json({ success: true, count: filtered.length, callbacks: filtered });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/callbacks/stats
 */
router.get('/stats', (req, res) => {
  try {
    const pending = callbacks.filter(cb => cb.status === 'pending');
    const overdue = pending.filter(cb => new Date(cb.due_at) < new Date());

    const stats = {
      total: callbacks.length,
      pending: pending.length,
      completed: callbacks.filter(cb => cb.status === 'completed').length,
      overdue: overdue.length,
      by_priority: {
        emergency: pending.filter(cb => cb.priority === 'emergency').length,
        high: pending.filter(cb => cb.priority === 'high').length,
        medium: pending.filter(cb => cb.priority === 'medium').length,
        low: pending.filter(cb => cb.priority === 'low').length,
      },
    };

    res.json({ success: true, stats });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/callbacks/:id
 */
router.get('/:id', (req, res) => {
  try {
    const callback = callbacks.find(cb => cb.id === req.params.id);
    if (!callback) {
      return res
        .status(404)
        .json({ success: false, error: 'Callback not found' });
    }
    res.json({ success: true, callback });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/callbacks
 */
router.post('/', async (req, res) => {
  try {
    const {
      call_id,
      caller_name,
      caller_number,
      reason,
      priority = 'medium',
      due_at,
      assigned_to,
      notes,
    } = req.body;

    const callback = {
      id: `cb_${callbackIdCounter++}`,
      call_id,
      caller_name: caller_name || 'Unknown',
      caller_number,
      reason,
      priority,
      status: 'pending',
      due_at: due_at || new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      assigned_to,
      notes,
      attempts: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    callbacks.push(callback);
    await persist();

    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:created', callback);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }

    res.status(201).json({ success: true, callback });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * PATCH /api/callbacks/:id
 */
router.patch('/:id', async (req, res) => {
  try {
    const index = callbacks.findIndex(cb => cb.id === req.params.id);
    if (index === -1) {
      return res
        .status(404)
        .json({ success: false, error: 'Callback not found' });
    }

    callbacks[index] = {
      ...callbacks[index],
      ...req.body,
      updated_at: new Date().toISOString(),
    };
    await persist();

    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:updated', callbacks[index]);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }

    res.json({ success: true, callback: callbacks[index] });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/callbacks/:id/attempt
 */
router.post('/:id/attempt', async (req, res) => {
  try {
    const index = callbacks.findIndex(cb => cb.id === req.params.id);
    if (index === -1) {
      return res
        .status(404)
        .json({ success: false, error: 'Callback not found' });
    }

    const { result, notes } = req.body;
    const cb = callbacks[index];

    cb.attempts++;
    cb.last_attempt_at = new Date().toISOString();
    cb.updated_at = new Date().toISOString();

    if (result === 'completed') {
      cb.status = 'completed';
      cb.completed_at = new Date().toISOString();
    } else if (result === 'no_answer' && cb.attempts >= 3) {
      cb.status = 'failed';
    }

    if (notes) cb.resolution_notes = notes;

    await persist();

    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:updated', cb);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }

    res.json({ success: true, callback: cb });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/callbacks/:id
 */
router.delete('/:id', async (req, res) => {
  try {
    const index = callbacks.findIndex(cb => cb.id === req.params.id);
    if (index === -1) {
      return res
        .status(404)
        .json({ success: false, error: 'Callback not found' });
    }

    callbacks.splice(index, 1);
    await persist();

    const liveCallManager = require('../services/liveCallManager');
    if (liveCallManager.io) {
      liveCallManager.io.emit('callback:deleted', req.params.id);
      liveCallManager.io.emit('callbacks:stats-updated', getStats());
    }

    res.json({ success: true, message: 'Callback deleted' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getStats() {
  const pending = callbacks.filter(cb => cb.status === 'pending');
  return {
    total: callbacks.length,
    pending: pending.length,
    overdue: pending.filter(cb => new Date(cb.due_at) < new Date()).length,
  };
}

module.exports = router;
