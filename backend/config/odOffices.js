'use strict';

/**
 * Office-keyed Open Dental connection registry (per-location slice).
 *
 * BEFORE this module there was exactly ONE Open Dental client in the process —
 * the env-configured singleton in ./openDental — and every voice-path OD call
 * (matcher, Pick Patient search, commlog write) used it implicitly. That was
 * correct only while exactly one office was OD-connected (Roland). It is
 * actively DANGEROUS the moment a second office is connected, because
 * **PatNum is per-database, not global**. Verified live on 2026-08-07:
 *
 *     PatNum 7115 in Riley/valley  = "Stedi TestValley"  (the test patient)
 *     PatNum 7115 in Roland        = a different, REAL patient
 *
 * A valley call resolved to PatNum 7115 and written with the Roland client
 * would put a chart note on an unrelated real person's chart. This module
 * exists to make that structurally impossible: OD credentials are resolved
 * BY OFFICE, every client instance is tagged with the office it is bound to,
 * and callers cannot obtain a client without naming the office they mean.
 *
 * Shape of the config below is deliberately DATA (an officeKey → settings map)
 * so a future office-management admin UI can edit the same object, exactly like
 * MANGO_LINE_OFFICE in ./officeAgents.
 *
 * Fail-closed, per office: an office whose customer key is absent is reported
 * as NOT OD-connected and every OD operation for it is refused. A missing
 * valley key can never silently fall back to Roland's key.
 *
 * Secrets: only the NAME of the Key Vault secret / env var appears here. Values
 * are read from process.env, populated at startup by ../config/secrets.js.
 */

const { OFFICES, UNMAPPED_OFFICE } = require('./officeAgents');
const odCloudSingleton = require('./openDental');
const { OpenDentalService } = require('./openDental');

/**
 * Per-office Open Dental connection settings.
 *
 * `commTypeDefNum` is the `definition.DefNum` (Category=27, "CareIN AI Call")
 * used on every commlog this office writes. It is PRACTICE-SPECIFIC — the same
 * logical CommType has a DIFFERENT DefNum in each OD database. Verified live
 * on 2026-08-07 against both practices:
 *
 *     Roland       "CareIN AI Call" = DefNum 486
 *     Riley/valley "CareIN AI Call" = DefNum 451
 *
 * DefNum 486 must therefore NEVER be written to Riley's database (486 is not a
 * CommLogType there at all), and 451 must never be written to Roland's.
 *
 * `odEnabled` is THE reversible switch for the voice module: flip it and that
 * office's calls get the full worklist action set; flip it back and they don't.
 *
 * It lives here rather than on officeAgents.OFFICES[].odConnected — which would
 * have been the smaller edit — because that flag is NOT voice-only. The TC module
 * gates its own Open Dental routes on it (backend/routes/tc/od.js), and TC still
 * reaches OD through the single process-wide client via odAccess. Flipping the
 * shared flag would therefore have opened /api/tc/od/* for valley and served
 * ROLAND's patients, treatment plans, insurance and claims under a Riley office
 * selector — the very contamination this module exists to prevent, in a module
 * that has not been made office-aware. Keeping the two switches separate lets the
 * voice path go live while TC stays honestly refused until its own slice.
 *
 * @typedef {Object} OdOfficeSettings
 * @property {string} officeKey            frozen internal office key
 * @property {boolean} odEnabled           the voice module's reversible OD switch
 * @property {string} customerKeyEnv       process.env key holding the OD customer key
 * @property {string} customerKeySecret    Key Vault secret NAME (never a value)
 * @property {string} commTypeEnv          process.env key overriding commTypeDefNum
 * @property {number} defaultCommTypeDefNum verified default for this practice
 * @type {Readonly<Record<string, OdOfficeSettings>>}
 */
// Outer map frozen (no office may be added or removed at runtime); the entries
// themselves stay mutable so tests can toggle `odEnabled` and assert the machinery
// rather than whichever value currently ships — same pattern as MANGO_LINE_OFFICE.
const OFFICE_OD_SETTINGS = Object.freeze({
  roland: ({
    officeKey: 'roland',
    odEnabled: true,
    customerKeyEnv: 'OPENDENTAL_CUSTOMER_KEY',
    customerKeySecret: 'opendental-customer-key',
    commTypeEnv: 'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM',
    defaultCommTypeDefNum: 486,
  }),
  valley: ({
    officeKey: 'valley',
    odEnabled: false,
    customerKeyEnv: 'OPENDENTAL_CUSTOMER_KEY_VALLEY',
    customerKeySecret: 'opendental-customer-key-valley',
    commTypeEnv: 'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY',
    defaultCommTypeDefNum: 451,
  }),
});

/**
 * Typed refusal so routes can map an office problem to an HTTP status and an
 * honest UI message without leaking internals.
 */
class OdOfficeError extends Error {
  /**
   * @param {string} message internal message (logged)
   * @param {string} code stable machine code
   * @param {string} publicMessage safe message for the client / UI
   * @param {string|null} [officeKey]
   */
  constructor(message, code, publicMessage, officeKey = null) {
    super(message);
    this.name = 'OdOfficeError';
    this.code = code;
    this.publicMessage = publicMessage;
    this.officeKey = officeKey;
  }
}

/** code → HTTP status, for route handlers. */
const STATUS_BY_CODE = Object.freeze({
  OFFICE_UNKNOWN: 409,
  OFFICE_NOT_OD_CONNECTED: 409,
  OFFICE_OD_KEY_MISSING: 503,
  OFFICE_MISMATCH: 409,
});

/**
 * Map an error to an HTTP status. Non-office errors fall through to 500.
 * @param {unknown} err
 * @returns {number}
 */
function httpStatusFor(err) {
  const code = err && /** @type {any} */ (err).code;
  return (code && STATUS_BY_CODE[code]) || 500;
}

/**
 * Per-office OD client cache. Keyed by officeKey. Cleared by resetOdOfficeCache()
 * in tests; in the app it is built once per process, lazily.
 * @type {Map<string, OdOfficeHandle>}
 */
const clientCache = new Map();

/**
 * A resolved, office-BOUND Open Dental connection.
 *
 * The `officeKey` is the whole point: it travels with the client so any code
 * holding a handle can be checked against the office it is supposed to be
 * serving (see assertOfficeMatch). There is no way to construct a handle
 * without naming an office, and no way to change a handle's office afterwards.
 *
 * @typedef {Object} OdOfficeHandle
 * @property {string} officeKey        the office this client is bound to
 * @property {string} officeName       display name (for UI + log lines)
 * @property {number} commTypeDefNum   this practice's "CareIN AI Call" DefNum
 * @property {any}    client           OpenDentalService instance for this office
 */

/**
 * The customer key configured for an office, or null when absent.
 * NEVER logged, never returned to a client — only its presence is reported.
 * @param {OdOfficeSettings} settings
 * @returns {string|null}
 */
function customerKeyFor(settings) {
  const raw = process.env[settings.customerKeyEnv];
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * This office's CareIN commlog CommType DefNum: env override, else the verified
 * per-practice default. A non-numeric override falls back to the default rather
 * than writing NaN into a chart note.
 * @param {OdOfficeSettings} settings
 * @returns {number}
 */
function commTypeDefNumFor(settings) {
  const raw = process.env[settings.commTypeEnv];
  const parsed = parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : settings.defaultCommTypeDefNum;
}

/**
 * Why (if at all) an office cannot reach Open Dental right now. Returns null
 * when the office IS ready. Pure — makes no network call and builds no client,
 * so it is safe for the roster endpoint and the UI.
 * @param {string} officeKey
 * @returns {{ code: string, message: string } | null}
 */
function odBlockReason(officeKey) {
  const officeConfig = OFFICES[officeKey];
  if (!officeConfig || officeKey === UNMAPPED_OFFICE) {
    return {
      code: 'OFFICE_UNKNOWN',
      message: "Can't connect this call to a chart — its office is unknown",
    };
  }

  const settings = OFFICE_OD_SETTINGS[officeKey];
  if (!settings) {
    return {
      code: 'OFFICE_NOT_OD_CONNECTED',
      message: `Open Dental is not configured for ${officeConfig.officeName}`,
    };
  }

  // The voice module's reversible switch (odEnabled above). An office that has
  // not been turned on stays off no matter what credentials exist.
  if (!settings.odEnabled) {
    return {
      code: 'OFFICE_NOT_OD_CONNECTED',
      message: `Open Dental is not connected for ${officeConfig.officeName} yet`,
    };
  }

  // Fail closed PER OFFICE: turning the switch on without shipping the key leaves
  // this office honestly disconnected. It must NEVER inherit another office's
  // credentials — that is precisely the PatNum-collision hazard.
  if (!customerKeyFor(settings)) {
    return {
      code: 'OFFICE_OD_KEY_MISSING',
      message: `Open Dental credentials are not configured for ${officeConfig.officeName}`,
    };
  }

  return null;
}

/**
 * Whether an office can reach Open Dental right now (intent flag AND credentials).
 * @param {string} officeKey
 * @returns {boolean}
 */
function isOdReady(officeKey) {
  return odBlockReason(officeKey) === null;
}

/**
 * Office roster entry for the UI. `odConnected` here is the EFFECTIVE value
 * (configured intent AND credentials present), so flipping the banner on
 * without the key still renders the honest "not connected" state.
 * @param {string} officeKey
 * @returns {{ officeId: string, officeName: string, odConnected: boolean, odBlockedReason: string|null }}
 */
function describeOffice(officeKey) {
  const officeConfig = OFFICES[officeKey];
  const blocked = odBlockReason(officeKey);
  return {
    officeId: officeKey,
    officeName: officeConfig ? officeConfig.officeName : 'Unmapped',
    odConnected: blocked === null,
    odBlockedReason: blocked ? blocked.message : null,
  };
}

/**
 * Resolve the office-bound Open Dental connection for an office. THE seam —
 * voice-path code must obtain its OD client here and nowhere else.
 *
 * Roland reuses the existing env-configured singleton (its env config IS
 * Roland's config), so Roland's behaviour — including the shared request
 * throttle and 429 backoff — is byte-for-byte what it is today. Any other
 * office gets its own instance built from its own customer key, with the
 * background sync loop OFF (that loop is a Roland-singleton concern and must
 * not be duplicated per office).
 *
 * @param {string} officeKey
 * @returns {OdOfficeHandle}
 * @throws {OdOfficeError} when the office is unknown, not connected, or unkeyed
 */
function getOdOffice(officeKey) {
  const key = typeof officeKey === 'string' ? officeKey : '';
  const blocked = odBlockReason(key);
  if (blocked) {
    throw new OdOfficeError(
      `office '${key || '(none)'}' cannot reach Open Dental: ${blocked.code}`,
      blocked.code,
      blocked.message,
      key || null
    );
  }

  const cached = clientCache.get(key);
  if (cached) return cached;

  const settings = OFFICE_OD_SETTINGS[key];
  const customerKey = customerKeyFor(settings);
  const officeConfig = OFFICES[key];

  // Reuse the singleton when it is already bound to THIS office's customer key.
  // Derived from the key itself (not hardcoded to 'roland'), so the day Roland's
  // key moves the reuse follows it — and a mismatched key never reuses.
  const client =
    odCloudSingleton.customerKey && odCloudSingleton.customerKey === customerKey
      ? odCloudSingleton
      : new OpenDentalService({ customerKey, officeKey: key, autoSync: false });

  /** @type {OdOfficeHandle} */
  const handle = Object.freeze({
    officeKey: key,
    officeName: officeConfig.officeName,
    commTypeDefNum: commTypeDefNumFor(settings),
    client,
  });

  clientCache.set(key, handle);
  return handle;
}

/**
 * The cross-contamination guard, and the safety heart of this slice.
 *
 * Asserts that a handle in hand is bound to the office the operation is FOR.
 * This is structural rather than per-call-site discipline: the OD-touching
 * methods in services/openDentalSync.js run every operation through here, so a
 * new call site cannot forget it and a mismatched pair cannot proceed. A
 * mismatch is always a bug or an attempt — it refuses loudly and logs.
 *
 * @param {string} expectedOfficeKey the office the operation belongs to
 * @param {OdOfficeHandle} handle the connection about to be used
 * @returns {OdOfficeHandle} the same handle, for chaining
 * @throws {OdOfficeError} OFFICE_MISMATCH
 */
function assertOfficeMatch(expectedOfficeKey, handle) {
  const actual = handle && handle.officeKey;
  if (!actual || actual !== expectedOfficeKey) {
    console.error(
      `[odOffices] BLOCKED cross-office Open Dental operation: expected office ` +
        `'${expectedOfficeKey}' but held a client bound to '${actual || '(none)'}'`
    );
    throw new OdOfficeError(
      `cross-office OD operation refused: expected '${expectedOfficeKey}', client is '${actual || '(none)'}'`,
      'OFFICE_MISMATCH',
      'This call belongs to a different office — refusing to touch that chart',
      expectedOfficeKey
    );
  }
  return handle;
}

/**
 * Drop cached clients. Tests only — lets a suite re-resolve after changing
 * process.env. The app never calls this.
 * @returns {void}
 */
function resetOdOfficeCache() {
  clientCache.clear();
}

module.exports = {
  OdOfficeError,
  OFFICE_OD_SETTINGS,
  httpStatusFor,
  odBlockReason,
  isOdReady,
  describeOffice,
  getOdOffice,
  assertOfficeMatch,
  resetOdOfficeCache,
  /** Exposed for diagnostics — secret NAMES only, never values. */
  secretNames: Object.values(OFFICE_OD_SETTINGS).map((s) => s.customerKeySecret),
};
