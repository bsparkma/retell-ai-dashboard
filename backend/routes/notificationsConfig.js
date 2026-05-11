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

router.get('/', (req, res) => {
  try {
    res.json({ success: true, config: loadConfig() });
  } catch {
    res.status(500).json({ success: false, error: 'Failed to load notifications config' });
  }
});

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
