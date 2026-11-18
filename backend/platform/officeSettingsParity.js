'use strict';

/**
 * The office settings parity tripwire, INVERTED in MT-2b. It only ever LOGS.
 *
 * MT-2a served platform_setting and compared office_setting against it. Since
 * MT-2b the ten readers SERVE office_setting (platform/officeSettings.js), and
 * platform_setting is still written in the same transaction so that a
 * rollback is a source flip, not a data repair. This tripwire now checks that
 * the rollback target is still a faithful copy:
 *
 *   - After every SUCCESSFUL office_setting read of the dual-write tenant
 *     ('carein' — platform_setting has no tenant dimension and holds only its
 *     settings), it reads platform_setting for each of the ten keys and works
 *     out what the PRE-MT-2b reader would have answered from it, per office.
 *   - It compares that with what is SERVED (officeSettingKeys.answerFromRows
 *     over the served rows — the very function the readers answer through).
 *   - Divergent (key, office): console.warn ONCE per process, with the phrase
 *     "office settings parity" and the side that is SERVED, office_setting.
 *   - Every key compared clean and nothing ever divergent: ONE line per
 *     process, "office settings parity OK — <n> office(s), <m> setting(s)".
 *   - Either table unreadable, or office_setting not currently served: no
 *     comparison.
 *
 * It never changes an answer. It never throws into a reader. Values are logged
 * for the nine booleans (true / false / null) and NEVER for tc_email_identity,
 * which holds email addresses and practice names: for it the warning names the
 * differing FIELDS only.
 *
 * WHAT "ANSWER" MEANS, PER KIND, ON THE platform_setting SIDE — the rules of
 * the readers as they were at 82c7a5a, so a difference is one a rollback would
 * actually serve:
 *
 *   switch    the map's boolean for the office, else null (nobody chose).
 *   map       hygPilot: a usable map answers for EVERY office (absent = false);
 *             no usable map is null.
 *   on        nurture / opportunities: true only for a literal true.
 *   identity  the stored fields of the office's entry, normalized, or null.
 *
 * ARMED BY server.js. Until arm() is called nothing is compared, so the unit
 * suites that stub the registry never reach a real control plane through here.
 *
 * CONFIRM BEFORE WARNING. A divergence is re-checked against a FRESH read of
 * BOTH tables (straight from the registry, not the cache) before it is
 * reported: a write that committed between the two reads is not a divergence.
 */

const registry = require('./registry');
const officeSettings = require('./officeSettings');
const officeRegistry = require('./officeRegistry');
const {
  KIND,
  MT2A_TENANT_SLUG,
  OFFICE_SETTING_KEYS,
  answerFromRows,
  normalizeIdentity,
} = require('./officeSettingKeys');
const { isDeepStrictEqual } = require('node:util');

/** The side the readers serve (MT-2b). */
const SERVED = 'office_setting';

let armed = false;
let listening = false;
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

/** The SERVED side for one office. Same rule the readers serve. */
const officeSideAnswer = answerFromRows;

/**
 * The comparison itself. PURE.
 * @param {string} settingKey
 * @param {string[]} offices
 * @param {Map<string, unknown>} rows   served office_setting rows for this key
 * @param {unknown} platformValue       platform_setting value (undefined = no row)
 * @returns {Divergence[]}
 */
function diff(settingKey, offices, rows, platformValue) {
  /** @type {Divergence[]} */
  const out = [];
  for (const officeKey of [...offices].sort()) {
    const office = officeSideAnswer(settingKey, rows, officeKey);
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

/** @param {Divergence} d @returns {string} */
function describe(d) {
  if (KIND[d.settingKey] === 'identity') {
    return `field(s) ${d.fields.join(', ') || '(none)'} differ`;
  }
  return `office_setting=${JSON.stringify(d.office)} platform_setting=${JSON.stringify(d.platform)}`;
}

/**
 * A fresh office_setting read straight from the registry (no cache, no
 * listeners), restricted to the tenant's own offices, for one key.
 * @param {string} settingKey
 * @returns {Promise<Map<string, unknown>>}
 */
async function freshRows(settingKey) {
  const rows = await registry.listOfficeSettings(MT2A_TENANT_SLUG);
  /** @type {Map<string, unknown>} */
  const out = new Map();
  for (const r of rows) {
    if (r.setting_key !== settingKey) continue;
    if (!officeRegistry.isTenantOffice(MT2A_TENANT_SLUG, r.office_key)) continue;
    out.set(r.office_key, r.value);
  }
  return out;
}

/** @param {string} settingKey @returns {Promise<unknown>} */
async function platformValue(settingKey) {
  const row = await registry.getPlatformSetting(settingKey);
  return row ? row.value : undefined;
}

/**
 * Compare one key. Never throws.
 * @param {string} settingKey
 * @returns {Promise<Divergence[]|null>} null = not compared
 */
async function runCompare(settingKey) {
  try {
    if (!KIND[settingKey]) return null;
    const rows = officeSettings.servedRows(MT2A_TENANT_SLUG, settingKey);
    if (rows === null) return null; // nothing is served: nothing to compare
    const offices = officeRegistry.tenantOfficeKeys(MT2A_TENANT_SLUG);
    let divergences = diff(settingKey, offices, rows, await platformValue(settingKey));
    if (divergences.length) {
      // Confirm against a fresh read of BOTH tables before saying anything.
      divergences = diff(settingKey, offices, await freshRows(settingKey), await platformValue(settingKey));
    }
    lastResults.set(settingKey, divergences);
    for (const officeKey of offices) comparedOffices.add(officeKey);

    for (const d of divergences) {
      const id = `${d.settingKey}/${d.officeKey}`;
      if (warned.has(id)) continue;
      warned.add(id);
      console.warn(
        `[officeSettings] office settings parity: '${d.settingKey}' for '${d.officeKey}' differs — ` +
          `${describe(d)}. Serving ${SERVED} (MT-2b); platform_setting is the rollback copy.`
      );
    }
    if (divergences.length === 0) cleanKeys.add(settingKey);

    if (!reportedClean && warned.size === 0 && OFFICE_SETTING_KEYS.every((k) => cleanKeys.has(k))) {
      reportedClean = true;
      console.log(
        `[officeSettings] office settings parity OK — ${comparedOffices.size} office(s), ` +
          `${OFFICE_SETTING_KEYS.length} setting(s) (serving ${SERVED})`
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
 * Compare one key, fire-and-forget. Returns the promise so a test can await
 * it; nothing on a request path awaits it.
 * @param {string} settingKey
 * @returns {Promise<Divergence[]|null>}
 */
function compare(settingKey) {
  if (!armed) return Promise.resolve(null);
  const p = runCompare(settingKey);
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => {});
  return p;
}

/**
 * Compare all ten keys, one after another. Fire-and-forget.
 * @returns {Promise<void>}
 */
function compareAll() {
  if (!armed) return Promise.resolve();
  const p = (async () => {
    for (const key of OFFICE_SETTING_KEYS) await runCompare(key);
  })();
  pending.add(p);
  p.finally(() => pending.delete(p)).catch(() => {});
  return p;
}

/** @param {string} tenantSlug */
function onOfficeSettingsRead(tenantSlug) {
  if (!armed || tenantSlug !== MT2A_TENANT_SLUG) return;
  void compareAll();
}

/** Turn the tripwire on (server.js, at boot). @returns {void} */
function arm() {
  armed = true;
  if (!listening) {
    listening = true;
    officeSettings.onRefresh(onOfficeSettingsRead);
  }
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

/** TESTS ONLY. The refresh listener stays registered (it does nothing unarmed). @returns {void} */
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
  platformSideAnswer,
  officeSideAnswer,
  diff,
  compare,
  compareAll,
  arm,
  isArmed,
  settled,
  lastResult,
  resetForTests,
};
