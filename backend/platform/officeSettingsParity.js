'use strict';

/**
 * The office settings parity tripwire (MT-2a). It only ever LOGS.
 *
 * Each of the ten per-office readers, after a SUCCESSFUL read of
 * platform_setting, hands this module its resolved stored-layer answer per
 * office. This module reads office_setting (platform/officeSettings.js), works
 * out what THAT table would answer under the same reader's rules, and compares.
 *
 *   - Divergent (key, office): console.warn ONCE per process, with the phrase
 *     "office settings parity" and the side that is SERVED, which in MT-2a is
 *     always platform_setting.
 *   - Every key compared clean and nothing ever divergent: ONE line per
 *     process, "office settings parity OK — <n> office(s), <m> setting(s)".
 *   - office_setting unreadable: no comparison (the reader in
 *     platform/officeSettings.js logs the failure once).
 *
 * It never changes an answer. It never throws into a reader. Values are logged
 * for the nine booleans (true / false / null) and NEVER for tc_email_identity,
 * which holds email addresses and practice names: for it the warning names the
 * differing FIELDS only.
 *
 * WHAT "ANSWER" MEANS, PER KIND (platform/officeSettingKeys.js KIND). The
 * office_setting side is evaluated with the reader's OWN absence rule, so a
 * difference is a difference the reader would actually serve:
 *
 *   switch    the office's row value, or null (nobody chose -> env fallback).
 *   map       hygPilot: when the tenant holds ANY hyg_od_enabled row, an office
 *             without one is false (a usable platform row answers for every
 *             office); no rows at all is null.
 *   on        nurture / opportunities: true only for a row holding true;
 *             everything else is false, exactly as officesOnIn() reads.
 *   identity  the four stored fields, each normalized by emailIdentity's own
 *             normalizeField, or null.
 *
 * ARMED BY server.js. Until arm() is called, compare() does nothing, so the
 * unit suites that stub the platform_setting half of the registry never reach
 * a real control plane through this module.
 *
 * CONFIRM BEFORE WARNING. A reader that just read platform_setting fresh could
 * be compared with an office_setting read up to one refresh window old (a
 * runbook that wrote both tables in between). So a divergence is re-checked
 * against a FRESH office_setting read before it is reported.
 */

const officeSettings = require('./officeSettings');
const { KIND, MT2A_TENANT_SLUG, OFFICE_SETTING_KEYS, normalizeIdentity } = require('./officeSettingKeys');
const { isDeepStrictEqual } = require('node:util');

const SERVED = 'platform_setting';

let armed = false;
/** @type {Set<string>} `${settingKey}/${officeKey}` already warned */
const warned = new Set();
/** @type {Set<string>} keys that have compared clean at least once */
const cleanKeys = new Set();
/** @type {Set<string>} offices compared */
const comparedOffices = new Set();
let reportedClean = false;
/** @type {Set<Promise<unknown>>} */
const pending = new Set();
/** @type {Map<string, Divergence[]>} */
const lastResults = new Map();

/**
 * @typedef {Object} Divergence
 * @property {string} settingKey
 * @property {string} officeKey
 * @property {unknown} platform   (never set for tc_email_identity)
 * @property {unknown} office     (never set for tc_email_identity)
 * @property {string[]} fields    tc_email_identity only: the differing field NAMES
 */

/**
 * What office_setting answers for one office, under the key's reader's rules.
 * @param {string} settingKey
 * @param {Map<string, unknown>} rows officeKey -> stored value, for this key
 * @param {string} officeKey
 * @returns {unknown}
 */
function officeSideAnswer(settingKey, rows, officeKey) {
  const kind = KIND[settingKey];
  const raw = rows.has(officeKey) ? rows.get(officeKey) : undefined;
  if (kind === 'switch') return typeof raw === 'boolean' ? raw : null;
  if (kind === 'map') return rows.size > 0 ? raw === true : null;
  if (kind === 'on') return raw === true;
  // identity
  const emailIdentity = require('../config/emailIdentity');
  const identity =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? normalizeIdentity(/** @type {Record<string, unknown>} */ (raw))
      : {};
  /** @type {Record<string, string|null>} */
  const out = {};
  for (const f of emailIdentity.STORED_FIELDS) out[f] = typeof identity[f] === 'string' ? identity[f] : null;
  return out;
}

/**
 * The comparison itself. PURE.
 * @param {string} settingKey
 * @param {Record<string, unknown>} platformAnswers officeKey -> the reader's resolved stored-layer answer
 * @param {Map<string, unknown>} rows office_setting rows for this key
 * @returns {Divergence[]}
 */
function diff(settingKey, platformAnswers, rows) {
  /** @type {Divergence[]} */
  const out = [];
  for (const officeKey of Object.keys(platformAnswers).sort()) {
    const platform = platformAnswers[officeKey];
    const office = officeSideAnswer(settingKey, rows, officeKey);
    if (isDeepStrictEqual(platform, office)) continue;
    if (KIND[settingKey] === 'identity') {
      const p = /** @type {Record<string, unknown>} */ (platform || {});
      const o = /** @type {Record<string, unknown>} */ (office || {});
      const fields = [...new Set([...Object.keys(p), ...Object.keys(o)])]
        .filter((f) => !isDeepStrictEqual(p[f] ?? null, o[f] ?? null))
        .sort();
      out.push({ settingKey, officeKey, platform: undefined, office: undefined, fields });
    } else {
      out.push({ settingKey, officeKey, platform, office, fields: [] });
    }
  }
  return out;
}

/** @param {Divergence} d @returns {string} */
function describe(d) {
  if (KIND[d.settingKey] === 'identity') {
    return `field(s) ${d.fields.join(', ') || '(none)'} differ`;
  }
  return `platform_setting=${JSON.stringify(d.platform)} office_setting=${JSON.stringify(d.office)}`;
}

/**
 * Compare one reader's answers with office_setting. Never throws.
 * @param {string} settingKey
 * @param {Record<string, unknown>} platformAnswers
 * @returns {Promise<Divergence[]|null>} null = not compared (unarmed, or office_setting unreadable)
 */
async function runCompare(settingKey, platformAnswers) {
  try {
    if (!KIND[settingKey]) return null;
    const read = await officeSettings.ensureFresh(MT2A_TENANT_SLUG);
    if (!read.ok) return null;
    let divergences = diff(settingKey, platformAnswers, officeSettings.rowsForKey(MT2A_TENANT_SLUG, settingKey));
    if (divergences.length) {
      // Confirm against a fresh read before saying anything.
      const fresh = await officeSettings.refreshFromDb(MT2A_TENANT_SLUG);
      if (!fresh.ok) return null;
      divergences = diff(settingKey, platformAnswers, officeSettings.rowsForKey(MT2A_TENANT_SLUG, settingKey));
    }
    lastResults.set(settingKey, divergences);
    for (const officeKey of Object.keys(platformAnswers)) comparedOffices.add(officeKey);

    for (const d of divergences) {
      const id = `${d.settingKey}/${d.officeKey}`;
      if (warned.has(id)) continue;
      warned.add(id);
      console.warn(
        `[officeSettings] office settings parity: '${d.settingKey}' for '${d.officeKey}' differs — ` +
          `${describe(d)}. Serving ${SERVED} (MT-2a).`
      );
    }
    if (divergences.length === 0) cleanKeys.add(settingKey);

    if (
      !reportedClean &&
      warned.size === 0 &&
      OFFICE_SETTING_KEYS.every((k) => cleanKeys.has(k))
    ) {
      reportedClean = true;
      console.log(
        `[officeSettings] office settings parity OK — ${comparedOffices.size} office(s), ` +
          `${OFFICE_SETTING_KEYS.length} setting(s)`
      );
    }
    return divergences;
  } catch (err) {
    console.error(
      `[officeSettings] office settings parity check failed: ${err && err.message ? err.message : String(err)}`
    );
    return null;
  }
}

/**
 * Fire-and-forget entry point for the readers. Returns the promise so a test
 * can await it; a reader must NOT await it on its request path.
 * @param {string} settingKey
 * @param {Record<string, unknown>} platformAnswers
 * @returns {Promise<Divergence[]|null>}
 */
function compare(settingKey, platformAnswers) {
  if (!armed) return Promise.resolve(null);
  const p = runCompare(settingKey, platformAnswers);
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => {});
  return p;
}

/** Turn the tripwire on (server.js, at boot). @returns {void} */
function arm() {
  armed = true;
}

/** @returns {boolean} */
function isArmed() {
  return armed;
}

/** Wait for every comparison in flight (tests, and the boot sweep). @returns {Promise<void>} */
async function settled() {
  while (pending.size) await Promise.allSettled([...pending]);
}

/** The last comparison's divergences for one key, or undefined. @param {string} settingKey */
function lastResult(settingKey) {
  return lastResults.get(settingKey);
}

/** TESTS ONLY. @returns {void} */
function resetForTests() {
  armed = false;
  warned.clear();
  cleanKeys.clear();
  comparedOffices.clear();
  reportedClean = false;
  pending.clear();
  lastResults.clear();
}

module.exports = {
  SERVED,
  officeSideAnswer,
  diff,
  compare,
  arm,
  isArmed,
  settled,
  lastResult,
  resetForTests,
};
