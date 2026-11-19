'use strict';

/**
 * TESTS ONLY (MT-2d). The pure comparison the retired office-settings parity
 * tripwire (platform/officeSettingsParity.js, MT-2a/MT-2b) ran, kept so the
 * MT-2a backfill proof (officeSettingsSeed.test.js) still has its comparator.
 * Nothing in the running server compares the two tables any more: since MT-2d
 * office_setting is the only table the ten per-office settings are written to
 * and served from, and platform_setting's old rows are inert history.
 *
 * The functions below are the tripwire's platformSideAnswer() and diff(),
 * unchanged: what the PRE-MT-2b reader answered from a platform_setting value,
 * compared with what is served from office_setting.
 */

const { isDeepStrictEqual } = require('node:util');
const { KIND, answerFromRows, normalizeIdentity } = require('./officeSettingKeys');

/**
 * @typedef {Object} Divergence
 * @property {string} settingKey
 * @property {string} officeKey
 * @property {unknown} office     what is SERVED (never set for tc_email_identity)
 * @property {unknown} platform   what platform_setting says (never set for tc_email_identity)
 * @property {string[]} fields    tc_email_identity only: the differing field NAMES
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isMap(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/**
 * What the PRE-MT-2b reader answered from a platform_setting value, for one
 * office. PURE. `value` undefined/null = no row.
 * @param {string} settingKey
 * @param {unknown} value
 * @param {string} officeKey
 * @returns {unknown}
 */
function platformSideAnswer(settingKey, value, officeKey) {
  const kind = KIND[settingKey];
  const map = isMap(value) ? value : null;
  if (kind === 'switch') return map && typeof map[officeKey] === 'boolean' ? map[officeKey] : null;
  if (kind === 'map') return map ? map[officeKey] === true : null;
  if (kind === 'on') return Boolean(map && map[officeKey] === true);
  // identity
  const emailIdentity = require('../config/emailIdentity');
  const entry = map && isMap(map[officeKey]) ? normalizeIdentity(/** @type {Record<string, unknown>} */ (map[officeKey])) : {};
  /** @type {Record<string, string|null>} */
  const out = {};
  for (const f of emailIdentity.STORED_FIELDS) out[f] = typeof entry[f] === 'string' ? entry[f] : null;
  return out;
}

/**
 * The comparison itself. PURE.
 * @param {string} settingKey
 * @param {string[]} offices
 * @param {Map<string, unknown>|null} rows   served office_setting rows for this key
 * @param {unknown} platformValue            platform_setting value (undefined = no row)
 * @returns {Divergence[]}
 */
function diff(settingKey, offices, rows, platformValue) {
  /** @type {Divergence[]} */
  const out = [];
  for (const officeKey of [...offices].sort()) {
    const office = answerFromRows(settingKey, rows, officeKey);
    const platform = platformSideAnswer(settingKey, platformValue, officeKey);
    if (isDeepStrictEqual(office, platform)) continue;
    if (KIND[settingKey] === 'identity') {
      const o = /** @type {Record<string, unknown>} */ (office || {});
      const p = /** @type {Record<string, unknown>} */ (platform || {});
      const fields = [...new Set([...Object.keys(o), ...Object.keys(p)])]
        .filter((f) => !isDeepStrictEqual(o[f] ?? null, p[f] ?? null))
        .sort();
      out.push({ settingKey, officeKey, office: undefined, platform: undefined, fields });
    } else {
      out.push({ settingKey, officeKey, office, platform, fields: [] });
    }
  }
  return out;
}

module.exports = { platformSideAnswer, diff };
