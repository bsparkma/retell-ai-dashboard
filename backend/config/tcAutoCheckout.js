'use strict';

/**
 * Checkout cards from today's schedule (CO-5b): the per-office switch and its
 * tunables. DEFAULT OFF; Roland pilots.
 *
 *     TC_AUTO_CHECKOUT_ENABLED_<OFFICE>=false             <- break-glass, OFF. Supreme.
 *     platform_setting['tc_auto_checkout_enabled'][office] <- {"roland": true}
 *     TC_AUTO_CHECKOUT_ENABLED_<OFFICE>=true              <- fallback only
 *     false                                               <- the floor
 *
 * Exactly the tc_checkout_enabled pattern (config/tcCheckout.js): see
 * config/tcOfficeSwitch.js for the precedence rules. Off for an office means
 * the sweep reads NOTHING from that office's Open Dental and writes NOTHING.
 * The checkout switch itself must also be on — a card on a Checkout page the
 * office cannot open would be work nobody can see.
 */

const { createOfficeSwitch } = require('./tcOfficeSwitch');

const officeSwitch = createOfficeSwitch({
  settingKey: 'tc_auto_checkout_enabled',
  envPrefix: 'TC_AUTO_CHECKOUT_ENABLED_',
  label: 'tcAutoCheckout',
});

/**
 * Open Dental serves one request a second per credential, and the slot is
 * shared with voice, TC, hygiene and RCM. The sweep is a batch, so it holds
 * the slot at RCM's D-8 spacing (1200 ms), like the pipeline sync — never less.
 */
const MIN_INTERVAL_FLOOR_MS = 1200;

/** @param {string} name @param {number} fallback @param {number} min */
function intEnv(name, fallback, min) {
  const text = String(process.env[name] ?? '').trim();
  const raw = Number(text);
  if (text === '' || !Number.isFinite(raw) || Math.floor(raw) < min) return fallback;
  return Math.floor(raw);
}

/** Cards one sweep of one office may make (default 100). The rest wait for the next sweep. */
function maxCreatePerSweep() {
  return intEnv('TC_AUTO_CHECKOUT_MAX_PER_SWEEP', 100, 1);
}

/** How long one office's schedule read stays fresh, in seconds (default 60). */
function cacheTtlSeconds() {
  return intEnv('TC_AUTO_CHECKOUT_CACHE_SECONDS', 60, 15);
}

/** Spacing per Open Dental request, never below the floor. */
function minIntervalMs() {
  return Math.max(MIN_INTERVAL_FLOOR_MS, intEnv('TC_AUTO_CHECKOUT_MIN_INTERVAL_MS', MIN_INTERVAL_FLOOR_MS, 0));
}

/** Per-request timeout. */
function callTimeoutMs() {
  return intEnv('TC_AUTO_CHECKOUT_CALL_TIMEOUT_MS', 15000, 1000);
}

module.exports = Object.freeze({
  ...officeSwitch,
  MIN_INTERVAL_FLOOR_MS,
  maxCreatePerSweep,
  cacheTtlSeconds,
  minIntervalMs,
  callTimeoutMs,
});
