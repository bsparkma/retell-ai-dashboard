'use strict';

/**
 * The ten per-office settings that MT-2 moves from platform_setting to
 * office_setting, and how each one's per-office entries are judged.
 *
 * The CLOSED vocabulary is enforced twice: here, and by the CHECK in
 * migrations/1789600000000_office_setting.js. officeSettingKeys.test.js pins
 * that the two lists are the same.
 *
 * NOT HERE, DELIBERATELY: tc_email_enabled, tc_sms_enabled and
 * call_retention_days. They are process-wide and stay in platform_setting.
 *
 * mirrorEntries() is the LIVE twin of the backfill's frozen planBackfill(): the
 * per-office entries of a platform_setting map that the key's own reader would
 * honour today. Anything that reader ignores is not mirrored.
 *
 * NO CYCLE. platform/registry.js requires this module lazily (inside
 * setPlatformSetting), and this module requires the readers' helpers lazily
 * (inside mirrorEntries), because config/emailIdentity.js requires the registry.
 */

/**
 * The tenant every MT-2a dual-write and parity check is for. The per-office
 * maps in platform_setting have no tenant dimension; today they are this
 * tenant's settings, so this is the only tenant they can be mirrored for.
 * Tenant threading through the readers is MT-2b.
 */
const MT2A_TENANT_SLUG = 'carein';

/**
 * @typedef {'switch'|'map'|'on'|'identity'} SettingKind
 *   switch    config/tcOfficeSwitch.js: an office absent from the map is "nobody
 *             chose" (null), and the env fallback answers.
 *   map       config/hygPilot.js: a usable row answers for EVERY office; absent
 *             from it means false. No row means null.
 *   on        config/tcNurture.js / config/tcOpportunities.js: an office is ON
 *             only when mapped to the literal true; everything else is OFF, and
 *             there is no layer below that can tell "absent" from "false".
 *   identity  config/emailIdentity.js: an object of normalized fields.
 */

/** @type {Readonly<Record<string, SettingKind>>} */
const KIND = Object.freeze({
  tc_checkout_enabled: 'switch',
  tc_od_sync_enabled: 'switch',
  tc_auto_checkout_enabled: 'switch',
  tc_referrals_enabled: 'switch',
  tc_referral_email_enabled: 'switch',
  tc_referral_patient_email_enabled: 'switch',
  hyg_od_enabled: 'map',
  tc_nurture_enabled: 'on',
  tc_opportunities_sync: 'on',
  tc_email_identity: 'identity',
});

const OFFICE_SETTING_KEYS = Object.freeze(Object.keys(KIND));

/** @param {unknown} key @returns {boolean} */
function isOfficeSettingKey(key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(KIND, key);
}

/** The practice's real offices (officeAgents.OFFICES minus 'unknown'). @returns {string[]} */
function realOffices() {
  const { OFFICES } = require('../config/officeAgents');
  return Object.keys(OFFICES).filter((k) => k !== 'unknown');
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isMap(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * One office's stored identity, normalized exactly as config/emailIdentity.js
 * parseStored() does for one entry. Fields the reader would drop are dropped.
 * @param {Record<string, unknown>} raw
 * @returns {Record<string, string>}
 */
function normalizeIdentity(raw) {
  const emailIdentity = require('../config/emailIdentity');
  /** @type {Record<string, string>} */
  const out = {};
  for (const [field, v] of Object.entries(raw)) {
    if (!emailIdentity.STORED_FIELDS.includes(field) || v === null) continue;
    // STORED_FIELDS.includes(field) above is what makes `field` a StoredField.
    const clean = emailIdentity.normalizeField(field, v);
    if (clean !== null) out[field] = clean;
  }
  return out;
}

/**
 * The per-office entries of a platform_setting value that this key's reader
 * honours today. Real offices only: 'unknown' never holds a setting.
 *
 * @param {string} settingKey
 * @param {unknown} value
 * @returns {Array<{ officeKey: string, value: boolean | Record<string, string> }>}
 */
function mirrorEntries(settingKey, value) {
  const kind = KIND[settingKey];
  if (!kind || !isMap(value)) return [];
  const offices = realOffices();
  /** @type {Array<{ officeKey: string, value: boolean | Record<string, string> }>} */
  const out = [];
  for (const [officeKey, raw] of Object.entries(value)) {
    if (!offices.includes(officeKey)) continue;
    if (kind === 'identity') {
      if (isMap(raw)) out.push({ officeKey, value: normalizeIdentity(raw) });
      continue;
    }
    if (typeof raw === 'boolean') out.push({ officeKey, value: raw });
  }
  return out;
}

module.exports = {
  MT2A_TENANT_SLUG,
  KIND,
  OFFICE_SETTING_KEYS,
  isOfficeSettingKey,
  realOffices,
  normalizeIdentity,
  mirrorEntries,
};
