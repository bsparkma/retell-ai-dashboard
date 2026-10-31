'use strict';

/**
 * The Open Dental-driven pipeline sync's per-office switch (CO-4b), and its
 * tunables. DEFAULT OFF.
 *
 *     TC_OD_SYNC_ENABLED_<OFFICE>=false             <- break-glass, OFF. Supreme.
 *     platform_setting['tc_od_sync_enabled'][office] <- {"roland": true}
 *     TC_OD_SYNC_ENABLED_<OFFICE>=true              <- fallback only
 *     false                                         <- the floor
 *
 * Exactly the tc_checkout_enabled pattern (config/tcCheckout.js): see
 * config/tcOfficeSwitch.js for the precedence rules. Off for an office means
 * the sweep reads NOTHING from that office's Open Dental and writes NOTHING —
 * not a run row, not a flag — for "Sync now" and for the nightly pass alike.
 */

const { createOfficeSwitch } = require('./tcOfficeSwitch');

const officeSwitch = createOfficeSwitch({
  settingKey: 'tc_od_sync_enabled',
  envPrefix: 'TC_OD_SYNC_ENABLED_',
  label: 'tcOdSync',
});

/**
 * Open Dental's documented rate is one request per second per credential, and
 * the slot is shared with voice, TC, hygiene and RCM. A sweep is a batch, so it
 * holds the slot at RCM's D-8 spacing (1200 ms), like the Opportunities sync —
 * never less. A lower env value is raised to it.
 */
const MIN_INTERVAL_FLOOR_MS = 1200;

/** @param {string} name @param {number} fallback @param {number} min */
function intEnv(name, fallback, min) {
  const text = String(process.env[name] ?? '').trim();
  const raw = Number(text);
  if (text === '' || !Number.isFinite(raw) || Math.floor(raw) < min) return fallback;
  return Math.floor(raw);
}

/** Appointment reads per office per run (default 200). The rest wait for the next run. */
function maxPerRun() {
  return intEnv('TC_OD_SYNC_MAX_PER_RUN', 200, 1);
}

/** Spacing per Open Dental request, never below the floor. */
function minIntervalMs() {
  return Math.max(MIN_INTERVAL_FLOOR_MS, intEnv('TC_OD_SYNC_MIN_INTERVAL_MS', MIN_INTERVAL_FLOOR_MS, 0));
}

/** Per-request timeout. */
function callTimeoutMs() {
  return intEnv('TC_OD_SYNC_CALL_TIMEOUT_MS', 15000, 1000);
}

/** "Sync now" may run once per this many minutes per office (default 5). */
function manualCooldownMinutes() {
  return intEnv('TC_OD_SYNC_COOLDOWN_MINUTES', 5, 1);
}

module.exports = Object.freeze({
  ...officeSwitch,
  MIN_INTERVAL_FLOOR_MS,
  maxPerRun,
  minIntervalMs,
  callTimeoutMs,
  manualCooldownMinutes,
});
