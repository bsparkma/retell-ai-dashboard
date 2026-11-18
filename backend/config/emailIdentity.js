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
 *   practiceAddress                              TC_EMAIL_PRACTICE_ADDRESS_<OFFICE>
 *                                                (the one field that may span lines)
 *
 * PRECEDENCE, per field, read at send time by config/acsEmail.js (which owns
 * the env half), for ONE TENANT's office (MT-2b):
 *
 *     office_setting(tenant, office, 'tc_email_identity')[<field>]  <- saved in the app
 *       | (no row, the field absent / null / unusable, or nothing is served:
 *       |  never read, or no good read in 3 refresh windows — platform/officeSettings.js;
 *       |  a failed refresh keeps serving the last good read until then)
 *     the app setting above                                     <- the env FALLBACK,
 *       |                                                          tenant 'carein' ONLY
 *       | (unset / unusable / any other tenant)
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
 * MT-2b: the values are SERVED from the control-plane office_setting table,
 * keyed by (tenant, office), and platform_setting is still written alongside
 * in the same transaction so a rollback is a source flip. The env fallback is
 * tenant 'carein's (the app settings are keyed by office key alone, and are
 * this deployment's settings for carein's offices): another tenant with an
 * office keyed 'roland' must never sign its email with Roland's name, address
 * or reply-to. Writes are refused for any tenant but 'carein' until MT-2d.
 *
 * (HISTORY, pre-MT-2b) WHY platform_setting AND NOT A TENANT TABLE. The values this replaces are
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
 * refreshed INLINE by a save so the next request sees it. MT-2b: the cache is
 * the shared office_setting read (platform/officeSettings.js), refreshed for
 * every active tenant; a failed or stale read is NOT served on, so the env
 * fallback answers (tenant 'carein' only), then "not set".
 */

const registry = require('../platform/registry');
const officeSettings = require('../platform/officeSettings');
const officeRegistry = require('../platform/officeRegistry');
const { MT2A_TENANT_SLUG } = require('../platform/officeSettingKeys');

const SETTING_KEY = 'tc_email_identity';

/** The fields, their app-setting prefixes, and their caps (shared/tc/emailIdentity.ts). */
const FIELDS = Object.freeze({
  replyTo: Object.freeze({ envPrefix: 'ACS_EMAIL_REPLY_TO_', max: 254 }),
  practiceName: Object.freeze({ envPrefix: 'TC_EMAIL_PRACTICE_NAME_', max: 120 }),
  practicePhone: Object.freeze({ envPrefix: 'TC_EMAIL_PRACTICE_PHONE_', max: 40 }),
  // Setup polish: the letterhead / footer address. MULTI-LINE (a street line and
  // a city line), so it is the one field whose normalizer keeps line breaks.
  practiceAddress: Object.freeze({ envPrefix: 'TC_EMAIL_PRACTICE_ADDRESS_', max: 300, multiline: true }),
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

/** @typedef {'replyTo'|'practiceName'|'practicePhone'|'practiceAddress'} IdentityField */
/** @typedef {IdentityField|'referralBcc'} StoredField */
/** @typedef {Partial<Record<StoredField, string>>} OfficeIdentity */

/** @type {NodeJS.Timeout|null} */
let refreshTimer = null;

/**
 * One of tenant T's real offices (MT-1c)? 'unknown' never is.
 * @param {unknown} tenantSlug
 * @param {unknown} officeKey
 */
function isRealOffice(tenantSlug, officeKey) {
  return officeRegistry.isTenantOffice(tenantSlug, officeKey);
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
  const spec = field === REFERRAL_BCC ? null : FIELDS[field];
  const multiline = Boolean(spec && 'multiline' in spec && spec.multiline);
  // A multi-line field (the address) keeps its line breaks as plain \n, each
  // line trimmed and blank lines dropped; every other control character is
  // still refused, so nothing but a line break can reach a footer.
  const v = multiline
    ? raw
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join('\n')
    : raw.trim();
  const max = spec ? spec.max : REFERRAL_BCC_MAX;
  if (!v || v.length > max) return null;
  if (multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/.test(v) : /[\u0000-\u001f\u007f]/.test(v)) return null;
  if (field === 'replyTo' || field === REFERRAL_BCC) return isEmailAddress(v) ? v.toLowerCase() : null;
  return v;
}

/**
 * One office's stored identity object -> its usable fields. Junk is dropped
 * (field NAMES may be logged; values never are).
 * @param {unknown} raw
 * @returns {OfficeIdentity}
 */
function parseIdentity(raw) {
  /** @type {OfficeIdentity} */
  const identity = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return identity;
  for (const [field, v] of Object.entries(/** @type {Record<string, unknown>} */ (raw))) {
    if (!STORED_FIELDS.includes(field) || v === null) continue;
    const clean = normalizeField(/** @type {StoredField} */ (field), v);
    if (clean !== null) identity[/** @type {StoredField} */ (field)] = clean;
  }
  return identity;
}

/**
 * The value SAVED IN THE APP for one tenant's office's field, from the SERVED
 * office_setting read (MT-2b), or null. Synchronous; this is what
 * config/acsEmail.js consults first. Not served (never read, or no good read
 * in 3 refresh windows; a failed refresh keeps serving the last good read until
 * then) => null, and the app setting answers for tenant 'carein' only.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {StoredField} field
 * @returns {string|null}
 */
function storedValue(tenantSlug, officeKey, field) {
  if (!isRealOffice(tenantSlug, officeKey)) return null;
  const cell = officeSettings.servedCell(tenantSlug, officeKey, SETTING_KEY);
  if (!cell) return null;
  const identity = parseIdentity(cell.value);
  return typeof identity[field] === 'string' ? /** @type {string} */ (identity[field]) : null;
}

/**
 * R6.3: the inbox this office's referral letters are blind-copied to, or null
 * for no copy. Saved value only — there is no fallback, by design.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @returns {string|null}
 */
function referralBccFor(tenantSlug, officeKey) {
  return storedValue(tenantSlug, officeKey, REFERRAL_BCC);
}

/** The app setting's NAME for one office's field. @param {string} officeKey @param {IdentityField} field */
function envVarFor(officeKey, field) {
  return FIELDS[field].envPrefix + String(officeKey).toUpperCase();
}

/**
 * Re-read the tenant's office_setting rows. NEVER THROWS.
 * @param {string} tenantSlug
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function refreshFromDb(tenantSlug) {
  if (tenantSlug !== officeRegistry.CODE_MAP_TENANT_SLUG && typeof tenantSlug === 'string' && tenantSlug) {
    await officeRegistry.refreshFromDb(tenantSlug).catch(() => {});
  }
  return officeSettings.refreshFromDb(tenantSlug);
}

/** Minutes between background refreshes (default 5). */
function refreshMinutes() {
  const raw = Number(String(process.env.TC_EMAIL_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/** Re-read when the tenant's read is older than the window (or was never read). @param {string} tenantSlug */
async function ensureFresh(tenantSlug) {
  await officeSettings.ensureTenantFresh(tenantSlug);
}

/**
 * Start the background refresh of every ACTIVE tenant's office_setting read.
 * Idempotent. Unref'd so it never holds the process open.
 */
function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    officeSettings.refreshActiveTenants().catch(() => {});
  }, refreshMinutes() * 60 * 1000);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
}

function stopRefreshTimer() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/**
 * @param {string} message
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function codedError(message, code) {
  const err = /** @type {Error & { code: string }} */ (new Error(message));
  err.code = code;
  return err;
}

/**
 * What is SAVED for one office, read from the DATABASE (not the cache). Throws
 * when the control plane cannot be read: a save must not guess what it replaces.
 *
 * `office` (what the history records as replaced) is read from office_setting,
 * the SERVED table. `all` is the platform_setting map the dual-write replaces
 * whole (MT-2a, kept for rollback). Tenant 'carein' only until MT-2d.
 *
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @returns {Promise<{ all: Record<string, unknown>, office: Record<StoredField, string|null> }>}
 */
async function readStoredFromDb(tenantSlug, officeKey) {
  if (tenantSlug !== MT2A_TENANT_SLUG) {
    throw codedError(
      `the email identity can only be written for tenant '${MT2A_TENANT_SLUG}' until MT-2d`,
      'OFFICE_SETTING_TENANT_NOT_WRITABLE'
    );
  }
  const [row, rows] = await Promise.all([
    registry.getPlatformSetting(SETTING_KEY),
    registry.listOfficeSettings(tenantSlug),
  ]);
  const all =
    row && row.value && typeof row.value === 'object' && !Array.isArray(row.value)
      ? { .../** @type {Record<string, unknown>} */ (row.value) }
      : {};
  const served = (rows || []).find((r) => r.office_key === officeKey && r.setting_key === SETTING_KEY);
  const mine = parseIdentity(served ? served.value : null);
  /** @type {Record<StoredField, string|null>} */
  const office = { replyTo: null, practiceName: null, practicePhone: null, practiceAddress: null, referralBcc: null };
  for (const f of STORED_FIELDS) office[/** @type {StoredField} */ (f)] = mine[/** @type {StoredField} */ (f)] ?? null;
  return { all, office };
}

/**
 * Save ONE office's whole identity (null = clear that field), then re-read it
 * FROM office_setting and compare, so what is reported is what is served.
 * The values must already be validated (the route's strict contract); they are
 * normalized again here so nothing unusable is ever written.
 *
 * Read-modify-write of the one platform_setting jsonb map (the registry mirrors
 * it into office_setting in the same transaction): the other office's entry is
 * carried through untouched. Tenant 'carein' only until MT-2d.
 *
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {Record<StoredField, string|null>} values  every stored field; null = not saved
 * @param {string|null} updatedBy
 * @returns {Promise<void>}
 */
async function persist(tenantSlug, officeKey, values, updatedBy) {
  if (tenantSlug !== MT2A_TENANT_SLUG) {
    throw codedError(
      `the email identity can only be written for tenant '${MT2A_TENANT_SLUG}' until MT-2d`,
      'OFFICE_SETTING_TENANT_NOT_WRITABLE'
    );
  }
  if (!isRealOffice(tenantSlug, officeKey)) {
    throw codedError(`'${officeKey}' is not an office`, 'INVALID_OFFICE');
  }
  /** @type {OfficeIdentity} */
  const next = {};
  for (const f of STORED_FIELDS) {
    const field = /** @type {StoredField} */ (f);
    if (values[field] === null || values[field] === undefined) continue;
    const clean = normalizeField(field, values[field]);
    if (clean === null) throw codedError(`${field} is not usable`, 'INVALID_BODY');
    next[field] = clean;
  }
  const { all } = await readStoredFromDb(tenantSlug, officeKey);
  all[officeKey] = next;
  // The registry writes platform_setting AND office_setting in one
  // transaction, and refuses (OFFICE_SETTING_READBACK_MISMATCH) if either
  // table does not read back as asked.
  await registry.setPlatformSetting(SETTING_KEY, all, updatedBy, { officeKey });

  const read = await refreshFromDb(tenantSlug);
  const mismatch =
    !read.ok ||
    STORED_FIELDS.some(
      (f) =>
        storedValue(tenantSlug, officeKey, /** @type {StoredField} */ (f)) !==
        (next[/** @type {StoredField} */ (f)] ?? null)
    );
  if (mismatch) {
    throw codedError('The email identity was written but could not be read back as saved', 'IDENTITY_READBACK_FAILED');
  }
}

/**
 * Whether the tenant's saved values are being served, and when this office's
 * last changed.
 * @param {string} tenantSlug
 * @param {string} officeKey
 */
function meta(tenantSlug, officeKey) {
  const cell = isRealOffice(tenantSlug, officeKey) ? officeSettings.servedCell(tenantSlug, officeKey, SETTING_KEY) : null;
  return {
    policyKnown: officeSettings.isServed(tenantSlug),
    updatedAt: cell ? cell.updatedAt : null,
    updatedBy: cell ? cell.updatedBy : null,
  };
}

/** TESTS ONLY: forget every tenant's office_setting read. */
function resetCacheForTests() {
  officeSettings.resetCacheForTests();
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
