'use strict';

/**
 * EMAIL IDENTITY per office, editable in the app (R5c).
 *
 * The three contact details outbound email carries, which until now could only
 * be changed as Azure app settings:
 *
 *   field           saved in the app             app setting (the fallback)
 *   replyTo         platform_setting, below      ACS_EMAIL_REPLY_TO_<OFFICE>
 *   practiceName                                 TC_EMAIL_PRACTICE_NAME_<OFFICE>
 *   practicePhone                                TC_EMAIL_PRACTICE_PHONE_<OFFICE>
 *
 * PRECEDENCE, per field, read at send time by config/acsEmail.js (which owns
 * the env half, unchanged from before this file existed):
 *
 *     platform_setting['tc_email_identity'][<office>][<field>]   <- saved in the app
 *       | (no row, no entry for the office, the field absent / null / unusable)
 *     the app setting above                                     <- the env FALLBACK
 *       | (unset / unusable)
 *     not set   -> reply-to: the existing "not configured" refusal for a referral;
 *                  name: the office label; phone: left out of the footer
 *
 * This is the opposite of the kill switches (config/tcEmail.js), and on purpose:
 * a switch lets the env force the SAFE direction; an identity has no safe
 * direction, so what the office saved in the app wins, and the env answers only
 * when nobody has.
 *
 * ONE IDENTITY PER OFFICE, NOT PER FEATURE: the TC patient email and the
 * referral letter read the same values (services/messaging/emailContent.js).
 *
 * WHY platform_setting AND NOT A TENANT TABLE. The values this replaces are
 * PROCESS-WIDE app settings keyed by office, and every reader is a synchronous
 * config lookup with no tenant connection in hand (the email adapter, the
 * renderers, the nurture generator). An office key is global to the deployment
 * (config/officeAgents.js), exactly like the env var it shadows. The change
 * HISTORY (who replaced which value with which) does live per tenant, in
 * tc_email_identity_changes, because audit_log.prior_state can only hold a
 * slug (1788000000000) and these prior values are addresses and names.
 *
 * NOT HERE, DELIBERATELY: the FROM address. It is bound to the DNS-verified
 * sending domain and stays an app setting (ACS_EMAIL_FROM_<OFFICE>).
 *
 * FRESHNESS. A synchronous cache, loaded at boot, refreshed every 5 minutes
 * (TC_EMAIL_REFRESH_MINUTES, the same knob as the email kill switch), and
 * refreshed INLINE by a save so the next request sees it. A failed read keeps
 * the previous cache; never read at all => the env fallback answers.
 */

const registry = require('../platform/registry');
const { OFFICES } = require('./officeAgents');

const SETTING_KEY = 'tc_email_identity';

/** The fields, their app-setting prefixes, and their caps (shared/tc/emailIdentity.ts). */
const FIELDS = Object.freeze({
  replyTo: Object.freeze({ envPrefix: 'ACS_EMAIL_REPLY_TO_', max: 254 }),
  practiceName: Object.freeze({ envPrefix: 'TC_EMAIL_PRACTICE_NAME_', max: 120 }),
  practicePhone: Object.freeze({ envPrefix: 'TC_EMAIL_PRACTICE_PHONE_', max: 40 }),
});
const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));

/**
 * R6.3: the referral copy inbox. Saved in the same row as the three above and
 * recorded in the same history, but with NO app-setting fallback: an empty
 * value means no copy, so nothing outside this setting can switch copies on.
 * The only reader that acts on it is the referral send (routes/tc/referralSend.js).
 */
const REFERRAL_BCC = 'referralBcc';
const REFERRAL_BCC_MAX = 254;

/** Everything saved per office: the identity fields plus the copy inbox. */
const STORED_FIELDS = Object.freeze([...FIELD_NAMES, REFERRAL_BCC]);

/** @typedef {'replyTo'|'practiceName'|'practicePhone'} IdentityField */
/** @typedef {IdentityField|'referralBcc'} StoredField */
/** @typedef {Partial<Record<StoredField, string>>} OfficeIdentity */

/** @type {{ loaded: boolean, byOffice: Record<string, OfficeIdentity>, updatedAt: string|null, updatedBy: string|null }} */
let cache = { loaded: false, byOffice: {}, updatedAt: null, updatedBy: null };
let loadedAt = 0;
/** @type {string|null} */
let lastLoggedError = null;
/** @type {NodeJS.Timeout|null} */
let refreshTimer = null;

/** @param {unknown} officeKey */
function isRealOffice(officeKey) {
  return (
    typeof officeKey === 'string' &&
    officeKey !== 'unknown' &&
    Object.prototype.hasOwnProperty.call(OFFICES, officeKey)
  );
}

/** One address, no display name, no list (the same rule as config/acsEmail.js). @param {unknown} v */
function isEmailAddress(v) {
  return typeof v === 'string' && v.length <= 254 && /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/.test(v);
}

/**
 * A STORED field's value made safe to use, or null when it is not usable, so a
 * saved value can never put a line break in a header or an over-long string in
 * a footer. (The env fallback keeps config/acsEmail.js's own long-standing
 * rules; this file does not re-judge it.)
 * @param {StoredField} field
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeField(field, raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  const max = field === REFERRAL_BCC ? REFERRAL_BCC_MAX : FIELDS[field].max;
  if (!v || v.length > max) return null;
  if (/[\u0000-\u001f\u007f]/.test(v)) return null;
  if (field === 'replyTo' || field === REFERRAL_BCC) return isEmailAddress(v) ? v.toLowerCase() : null;
  return v;
}

/**
 * A stored jsonb value -> the per-office identities. Junk is dropped loudly;
 * the rest still applies.
 * @param {unknown} value
 * @returns {Record<string, OfficeIdentity>|null}
 */
function parseStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  /** @type {Record<string, OfficeIdentity>} */
  const byOffice = {};
  for (const [office, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (!isRealOffice(office) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
      console.warn(`[emailIdentity] platform_setting['${SETTING_KEY}']['${office}'] is ignored (not an office, or not a map)`);
      continue;
    }
    /** @type {OfficeIdentity} */
    const identity = {};
    for (const [field, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
      if (!STORED_FIELDS.includes(field) || v === null) continue;
      const clean = normalizeField(/** @type {StoredField} */ (field), v);
      if (clean === null) {
        console.warn(
          `[emailIdentity] platform_setting['${SETTING_KEY}']['${office}'].${field} is not usable; ${
            field === REFERRAL_BCC ? 'no copy is sent' : 'the app setting answers'
          }`
        );
        continue;
      }
      identity[/** @type {StoredField} */ (field)] = clean;
    }
    byOffice[office] = identity;
  }
  return byOffice;
}

/**
 * The value SAVED IN THE APP for one office's field, from the cache, or null.
 * Synchronous; this is what config/acsEmail.js consults first.
 * @param {string} officeKey
 * @param {StoredField} field
 * @returns {string|null}
 */
function storedValue(officeKey, field) {
  if (!isRealOffice(officeKey) || !cache.loaded) return null;
  const identity = cache.byOffice[officeKey];
  return identity && typeof identity[field] === 'string' ? /** @type {string} */ (identity[field]) : null;
}

/**
 * R6.3: the inbox this office's referral letters are blind-copied to, or null
 * for no copy. Saved value only — there is no fallback, by design.
 * @param {string} officeKey
 * @returns {string|null}
 */
function referralBccFor(officeKey) {
  return storedValue(officeKey, REFERRAL_BCC);
}

/** The app setting's NAME for one office's field. @param {string} officeKey @param {IdentityField} field */
function envVarFor(officeKey, field) {
  return FIELDS[field].envPrefix + String(officeKey).toUpperCase();
}

/**
 * Re-read the stored identities. NEVER THROWS; a failed read keeps the cache.
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function refreshFromDb() {
  try {
    const row = await registry.getPlatformSetting(SETTING_KEY);
    lastLoggedError = null;
    const byOffice = row ? parseStored(row.value) : null;
    if (row && byOffice === null) {
      console.warn(`[emailIdentity] platform_setting['${SETTING_KEY}'] is not a map — ignoring it (the app settings answer)`);
    }
    cache = {
      loaded: true,
      byOffice: byOffice || {},
      updatedAt: row && byOffice && row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row && byOffice ? row.updated_by || null : null,
    };
    loadedAt = Date.now();
    return { ok: true, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (message !== lastLoggedError) {
      console.error(`[emailIdentity] could not read the saved email identity: ${message}`);
      lastLoggedError = message;
    }
    return { ok: false, error: message };
  }
}

/** Minutes a cached read stays fresh (default 5). */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_EMAIL_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Re-read when the cache is older than the refresh window (or was never read). */
async function ensureFresh() {
  if (cache.loaded && Date.now() - loadedAt < refreshMinutes() * 60 * 1000) return;
  await refreshFromDb();
}

/** Start the background refresh. Idempotent. Unref'd so it never holds the process open. */
function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    void refreshFromDb();
  }, refreshMinutes() * 60 * 1000);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function stopRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * What is SAVED for one office, read from the DATABASE (not the cache). Throws
 * when the control plane cannot be read: a save must not guess what it replaces.
 * @param {string} officeKey
 * @returns {Promise<{ all: Record<string, unknown>, office: Record<StoredField, string|null> }>}
 */
async function readStoredFromDb(officeKey) {
  const row = await registry.getPlatformSetting(SETTING_KEY);
  const all =
    row && row.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? { .../** @type {Record<string, unknown>} */ (row.value) }
      : {};
  const parsed = parseStored({ [officeKey]: all[officeKey] && typeof all[officeKey] === 'object' ? all[officeKey] : {} });
  const mine = (parsed && parsed[officeKey]) || {};
  /** @type {Record<StoredField, string|null>} */
  const office = { replyTo: null, practiceName: null, practicePhone: null, referralBcc: null };
  for (const f of STORED_FIELDS) office[/** @type {StoredField} */ (f)] = mine[/** @type {StoredField} */ (f)] ?? null;
  return { all, office };
}

/**
 * Save ONE office's whole identity (null = clear that field), then re-read it
 * FROM the database and compare, so what is reported is what was persisted.
 * The values must already be validated (the route's strict contract); they are
 * normalized again here so nothing unusable is ever written.
 *
 * Read-modify-write of the one jsonb row: the other office's entry is carried
 * through untouched.
 *
 * @param {string} officeKey
 * @param {Record<StoredField, string|null>} values  every stored field; null = not saved
 * @param {string|null} updatedBy
 * @returns {Promise<void>}
 */
async function persist(officeKey, values, updatedBy) {
  if (!isRealOffice(officeKey)) {
    const err = /** @type {Error & { code?: string }} */ (new Error(`'${officeKey}' is not an office`));
    err.code = 'INVALID_OFFICE';
    throw err;
  }
  /** @type {OfficeIdentity} */
  const next = {};
  for (const f of STORED_FIELDS) {
    const field = /** @type {StoredField} */ (f);
    if (values[field] === null || values[field] === undefined) continue;
    const clean = normalizeField(field, values[field]);
    if (clean === null) {
      const err = /** @type {Error & { code?: string }} */ (new Error(`${field} is not usable`));
      err.code = 'INVALID_BODY';
      throw err;
    }
    next[field] = clean;
  }
  const { all } = await readStoredFromDb(officeKey);
  all[officeKey] = next;
  await registry.setPlatformSetting(SETTING_KEY, all, updatedBy);

  const read = await refreshFromDb();
  const mismatch =
    !read.ok || STORED_FIELDS.some((f) => storedValue(officeKey, /** @type {StoredField} */ (f)) !== (next[/** @type {StoredField} */ (f)] ?? null));
  if (mismatch) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error('The email identity was written but could not be read back as saved')
    );
    err.code = 'IDENTITY_READBACK_FAILED';
    throw err;
  }
}

/** Whether the saved values have been read since boot, and when they last changed. */
function meta() {
  return { policyKnown: cache.loaded, updatedAt: cache.updatedAt, updatedBy: cache.updatedBy };
}

/** TESTS ONLY. */
function resetCacheForTests() {
  cache = { loaded: false, byOffice: {}, updatedAt: null, updatedBy: null };
  loadedAt = 0;
  lastLoggedError = null;
}

module.exports = {
  SETTING_KEY,
  FIELDS,
  FIELD_NAMES,
  REFERRAL_BCC,
  STORED_FIELDS,
  normalizeField,
  storedValue,
  referralBccFor,
  envVarFor,
  refreshFromDb,
  ensureFresh,
  startRefreshTimer,
  stopRefreshTimer,
  readStoredFromDb,
  persist,
  meta,
  resetCacheForTests,
};
