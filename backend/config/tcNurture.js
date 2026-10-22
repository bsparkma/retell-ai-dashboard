'use strict';

/**
 * TC nurture campaigns v1 (queue item 47) — the frozen tracks, the boot
 * assertion, and the switch.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE DEFINITIONS ARE NOT HERE, ON PURPOSE
 * ═════════════════════════════════════════════════════════════════════════════
 * The four tracks, their touch libraries, the three presets each, the hard
 * caps and the template copy live in new-dashboard/shared/tc/nurture.ts, so
 * the compile-time totality guarantee (a track or intensity without a schedule
 * fails `tsc --noEmit`) is real. This backend has no build step, so it reads
 * them through the committed contract bundle — the same way every route reads
 * CaseStatus — and re-exports them under the names the engine uses.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE BOOT ASSERTION
 * ═════════════════════════════════════════════════════════════════════════════
 * Requiring this module runs assertPresetsWithinCaps(): every preset is checked
 * against the hard caps (3 per rolling 7 days, 48h apart, 12 per enrollment)
 * and the channel rule (no SMS back to back). A violation THROWS while
 * server.js is loading, so a bad preset is a container that will not start,
 * not a patient who got four texts in a week. The generator checks the caps
 * again on every touch (defence in depth).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SHIPS DARK — THE SWITCH
 * ═════════════════════════════════════════════════════════════════════════════
 *   TC_NURTURE_ENABLED=false                  break-glass. Forces EVERY office
 *                                             OFF, whatever is stored. It can
 *                                             only ever turn nurture off.
 *     ↓ (anything else)
 *   platform_setting['tc_nurture_enabled']    `{"roland": true, "valley": false}`.
 *                                             An office is ON only when mapped
 *                                             to the literal `true`. NO ROW =
 *                                             every office OFF. A non-boolean is
 *                                             OFF. An unreadable control plane is
 *                                             OFF (stuck-off is the safe side).
 *
 * There is deliberately NO env var that turns nurture ON (unlike texting's
 * TC_SMS_ENABLED fallback): absent = off, and the only way on is the stored
 * per-office row. Shaped after config/tcOpportunities.js (the map) with
 * config/tcSms.js's `=false` break-glass.
 *
 * What it gates: the nightly generator (nothing is drafted for an office that
 * is off) and STARTING an enrollment. Pausing and stopping are always allowed —
 * that is the safe direction.
 */

const contract = require('../tc/contract.gen.cjs');
const { OFFICES } = require('./officeAgents');
const odOffices = require('./odOffices');
const acsConfig = require('./acsEmail');

/** The `platform_setting` key. */
const SETTING_KEY = 'tc_nurture_enabled';
/** Break-glass env var. Only `false` means anything. */
const KILL_ENV_KEY = 'TC_NURTURE_ENABLED';

/** 05:00 in the practice's zone. Pure Postgres, so the slot is not OD-budgeted. */
const DEFAULT_SCHEDULE = '0 5 * * *';

const TRACK_KEYS = Object.freeze([...contract.NurtureTrackKey.options]);
const INTENSITIES = Object.freeze([...contract.NurtureIntensity.options]);
const CAPS = contract.NURTURE_CAPS;
const SMS_STOP_SUFFIX = contract.NURTURE_SMS_STOP_SUFFIX;

// Fail loudly at boot: a preset that breaks a cap never runs.
contract.assertPresetsWithinCaps();

/** Is the break-glass pulled? Only the literal 'false' (case/space-insensitive). */
function isKilled() {
  return String(process.env[KILL_ENV_KEY] ?? '').trim().toLowerCase() === 'false';
}

/** Cron expression for the nightly generator. */
function schedule() {
  const s = String(process.env.TC_NURTURE_SCHEDULE ?? '').trim();
  return s || DEFAULT_SCHEDULE;
}

/** The zone the cron, the day offsets and the caps are counted in. */
function timezone() {
  return (
    String(process.env.TC_NURTURE_TZ ?? '').trim() ||
    String(process.env.OFFICE_TIMEZONE ?? '').trim() ||
    'America/Chicago'
  );
}

/**
 * The offices a stored row switches ON. Anything that is not a known office
 * mapped to the literal `true` is OFF.
 * @param {unknown} value
 * @returns {string[]}
 */
function officesOnIn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(/** @type {Record<string, unknown>} */ (value))
    .filter(([k, v]) => Object.prototype.hasOwnProperty.call(OFFICES, k) && v === true)
    .map(([k]) => k)
    .sort();
}

/**
 * The offices switched ON right now, read from the control plane. Never
 * throws: an unreadable control plane is "nothing is on".
 * @param {{ getPlatformSetting: (key: string) => Promise<{ value: unknown }|null> }} registry
 * @returns {Promise<{ offices: string[], reason: string|null }>}
 */
async function switchedOnOffices(registry) {
  if (isKilled()) return { offices: [], reason: 'KILLED_BY_ENV' };
  let row;
  try {
    row = await registry.getPlatformSetting(SETTING_KEY);
  } catch (err) {
    return { offices: [], reason: `CONTROL_PLANE_UNREADABLE: ${(err && err.message) || err}` };
  }
  if (!row) return { offices: [], reason: 'NO_SETTING_ROW' };
  const offices = officesOnIn(row.value);
  return { offices, reason: offices.length ? null : 'NO_OFFICE_SWITCHED_ON' };
}

/**
 * Is nurture on for ONE office? Same rules, same failure direction.
 * @param {Parameters<typeof switchedOnOffices>[0]} registry
 * @param {string} office
 */
async function isOfficeOn(registry, office) {
  const { offices } = await switchedOnOffices(registry);
  return offices.includes(office);
}

/**
 * The merge values for one office's touches. Display name and phone come from
 * CONFIG (config/officeAgents, TC_EMAIL_PRACTICE_PHONE_<OFFICE>) — never from
 * Open Dental. With no phone configured, copy that says "call {{officePhone}}"
 * reads "call the office" rather than "call  and".
 * @param {string} office
 * @returns {{ officeName: string, officePhone: string, phoneConfigured: boolean, telHref: string|null }}
 */
function officeMergeValues(office) {
  const officeName = odOffices.describeOffice(office).officeName;
  const phone = acsConfig.practiceDetailsFor(office).phone;
  const digits = phone ? phone.replace(/\D/g, '') : '';
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  return {
    officeName,
    officePhone: phone || 'the office',
    phoneConfigured: Boolean(phone),
    telHref: ten.length === 10 ? `tel:+1${ten}` : null,
  };
}

module.exports = {
  SETTING_KEY,
  KILL_ENV_KEY,
  DEFAULT_SCHEDULE,
  TRACK_KEYS,
  INTENSITIES,
  CAPS,
  SMS_STOP_SUFFIX,
  TRACKS: contract.NURTURE_TRACKS,
  DEFAULT_INTENSITY: contract.NURTURE_DEFAULT_INTENSITY,
  STOP_CASE_TERMINAL: contract.NURTURE_STOP_CASE_TERMINAL,
  STOP_OPTED_OUT: contract.NURTURE_STOP_OPTED_OUT,
  schedule: contract.nurtureSchedule,
  touch: contract.nurtureTouch,
  templateId: contract.nurtureTemplateId,
  intensityFor: contract.intensityFor,
  presetViolations: contract.presetViolations,
  allPresetViolations: contract.allPresetViolations,
  assertPresetsWithinCaps: contract.assertPresetsWithinCaps,
  isKilled,
  cronSchedule: schedule,
  timezone,
  officesOnIn,
  switchedOnOffices,
  isOfficeOn,
  officeMergeValues,
};
