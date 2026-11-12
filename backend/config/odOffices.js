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

const officeAgents = require('./officeAgents');
const { OFFICES, UNMAPPED_OFFICE } = officeAgents;
// The hygiene switch's run-time layers (control DB → env). It deliberately does
// NOT require this module back: the hardcoded floor below is passed IN to it, so
// the dependency runs one way and there is no cycle. See config/hygPilot.js.
const hygPilot = require('./hygPilot');
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
 * `referralCommTypeDefNum` (R6.10) is the same kind of number for a second
 * type, "Referral" — the commlog type a referral milestone's chart note is
 * written with. Same mechanism exactly (env override, else the verified
 * per-practice default), verified live on 2026-10-28 against both practices:
 *
 *     Roland       "Referral" = DefNum 491
 *     Riley/valley "Referral" = DefNum 452
 *
 * Same rule: 491 never goes to Riley's database, 452 never to Roland's. An
 * office with no referral DefNum configured (no default, no override) gets
 * null, and a referral chart note there is REFUSED with a named reason — it
 * never falls back to the call-note type or any other.
 *
 * `tcCommTypeDefNum` (AT-2) is a third type, "CareIN TC" — the commlog type a
 * TC activity-feed item is charted with ("Log to chart"). Same mechanism, read
 * live (GET /definitions?Category=27, includeHidden) on 2026-11-12 against both
 * practices — exactly one visible "CareIN TC" in each:
 *
 *     Roland       "CareIN TC" = DefNum 492
 *     Riley/valley "CareIN TC" = DefNum 453
 *
 * Three families per office, no number shared across offices or families:
 * call 486/451, referral 491/452, TC 492/453. An unconfigured office gets null
 * and a TC chart note there is REFUSED (TC_COMMTYPE_NOT_CONFIGURED) — never a
 * fallback to the call or referral type. An env override naming a number that
 * another (office, type) already owns is refused the same way, not served.
 *
 * `odEnabled` is THE reversible switch for an office's Open Dental access: flip it
 * and that office's calls get the full worklist action set and its TC screens read
 * its charts; flip it back and neither does.
 *
 * It is now the ONLY such switch. There was briefly a second one —
 * officeAgents.OFFICES[].odConnected — because the TC module gated
 * /api/tc/od/* on it while still reaching Open Dental through the single
 * process-wide client (platform/odAccess) built from ROLAND's key. Flipping one
 * shared flag would then have served Roland's patients, treatment plans, insurance
 * and claims under a Riley office selector: the exact contamination this module
 * exists to prevent. TC has since been moved onto this registry, so the second
 * flag protected nothing and was retired rather than left to drift. Both modules
 * now ask `isOdReady(officeKey)` — intent AND credentials, per office.
 *
 * @typedef {Object} OdOfficeSettings
 * @property {string} officeKey            frozen internal office key
 * @property {boolean} odEnabled           the reversible OD switch for this office
 * @property {boolean} hygOdEnabled        the HYGIENE module's own per-office switch
 * @property {string} customerKeyEnv       process.env key holding the OD customer key
 * @property {string} customerKeySecret    Key Vault secret NAME (never a value)
 * @property {string} commTypeEnv          process.env key overriding commTypeDefNum
 * @property {number} defaultCommTypeDefNum verified default for this practice
 * @property {string} referralCommTypeEnv  process.env key overriding the referral DefNum
 * @property {number|null} defaultReferralCommTypeDefNum verified "Referral" DefNum; null = none configured
 * @property {string} tcCommTypeEnv        process.env key overriding the "CareIN TC" DefNum
 * @property {number|null} defaultTcCommTypeDefNum verified "CareIN TC" DefNum; null = none configured
 * @type {Readonly<Record<string, OdOfficeSettings>>}
 */
// Outer map frozen (no office may be added or removed at runtime); the entries
// themselves stay mutable so tests can toggle `odEnabled` and assert the machinery
// rather than whichever value currently ships — same pattern as MANGO_LINE_OFFICE.
const OFFICE_OD_SETTINGS = Object.freeze({
  roland: ({
    officeKey: 'roland',
    odEnabled: true,
    // THE FLOOR, AND IT STAYS `false`. This is no longer where the pilot switch
    // is turned on — it is the bottom of a precedence chain (control DB → here)
    // and it is what answers when nothing else has. Flipping it would mean the
    // OFF direction needs a deploy again, which is the whole thing
    // config/hygPilot.js exists to fix. Turn an office ON from the Platform
    // Console; HYG_OD_ENABLED_<OFFICE> can only turn one OFF.
    // See hygOdBlockReason() below for why this is a SECOND flag at all and not
    // a reuse of odEnabled.
    hygOdEnabled: false,
    customerKeyEnv: 'OPENDENTAL_CUSTOMER_KEY',
    customerKeySecret: 'opendental-customer-key',
    commTypeEnv: 'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM',
    defaultCommTypeDefNum: 486,
    referralCommTypeEnv: 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM',
    defaultReferralCommTypeDefNum: 491,
    tcCommTypeEnv: 'OPENDENTAL_TC_COMMTYPE_DEFNUM',
    defaultTcCommTypeDefNum: 492,
  }),
  valley: ({
    officeKey: 'valley',
    odEnabled: true,
    hygOdEnabled: false,
    customerKeyEnv: 'OPENDENTAL_CUSTOMER_KEY_VALLEY',
    customerKeySecret: 'opendental-customer-key-valley',
    commTypeEnv: 'OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY',
    defaultCommTypeDefNum: 451,
    referralCommTypeEnv: 'OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM_VALLEY',
    defaultReferralCommTypeDefNum: 452,
    tcCommTypeEnv: 'OPENDENTAL_TC_COMMTYPE_DEFNUM_VALLEY',
    defaultTcCommTypeDefNum: 453,
  }),
});

// ── Serving from the office registry (MT-1b) ─────────────────────────────────
// The control-plane `office` table now ANSWERS for some of the fields above.
// Final precedence, per field, as found and kept (nothing that existed before
// MT-1b moved down; the registry slots in BETWEEN the env and the code):
//
//   field                    precedence (first that applies)
//   -----------------------  ----------------------------------------------------
//   call CommType DefNum     env OPENDENTAL_CAREIN_COMMTYPE_DEFNUM[_<OFFICE>]
//                            (any integer, exactly as before) > registry
//                            commtype_defnums.call > defaultCommTypeDefNum
//   referral CommType DefNum env OPENDENTAL_REFERRAL_COMMTYPE_DEFNUM[_<OFFICE>]
//                            (positive integer, as before) > registry
//                            commtype_defnums.referral > default > null (refuse)
//   TC CommType DefNum       env OPENDENTAL_TC_COMMTYPE_DEFNUM[_<OFFICE>]
//   (AT-2)                   (positive AND non-crossing, else refused) > registry
//                            commtype_defnums.tc > default > null (refuse)
//   odEnabled                registry od_enabled > code  (there is no env layer)
//   hygOdEnabled (floor)     unchanged chain in config/hygPilot.js: a disabling
//                            HYG_OD_ENABLED_<OFFICE> > platform_setting > floor,
//                            where the floor is now code AND registry. The
//                            registry can LOWER the floor, never raise it:
//                            hygPilot's rule is that nobody raises the floor.
//   customer key env/secret  CODE ONLY. The key VALUE still comes from
//                            process.env[customerKeyEnv], loaded by
//                            config/secrets.js from its own fixed list; letting
//                            the registry rename the variable could point an
//                            office at ANOTHER office's key. Parity still checks
//                            the names.
//   office display name      via officeAgents.officeNameFor (registry > code)
//
// "registry" means officeAgents.servedRegistryOffice(): the last read succeeded,
// is under 15 minutes old, and the office's row is active. Otherwise every
// value above is the code's, exactly as before MT-1b.
//
// A registry DefNum is served only if it has the shape the schema CHECK
// enforces (a positive integer; mapRow turns anything else into null) AND it
// does not CROSS: it may not equal a DefNum that the code defaults, or another
// office's registry row, assign to a DIFFERENT (office, type). So 486 and 491
// can never be served to valley, nor 451 and 452 to roland, nor a call DefNum
// as a referral one. A crossing value is refused and the code default is
// served instead; the parity warning for that field names the crossing.

/** @typedef {'call'|'referral'|'tc'} CommTypeKind */

/** Every commlog-type family an office configures (AT-2 added 'tc'). */
const COMMTYPE_KINDS = /** @type {ReadonlyArray<CommTypeKind>} */ (Object.freeze(['call', 'referral', 'tc']));

/** @param {OdOfficeSettings} s @param {CommTypeKind} kind @returns {number|null} */
function codeDefaultDefNum(s, kind) {
  const v =
    kind === 'call'
      ? s.defaultCommTypeDefNum
      : kind === 'referral'
        ? s.defaultReferralCommTypeDefNum
        : s.defaultTcCommTypeDefNum;
  return Number.isInteger(v) && v > 0 ? v : null;
}

/** @param {unknown} v @returns {number|null} */
function positiveInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

/**
 * Which (office, type) pair other than this one already owns `value`, or null.
 * Checked against every code default AND every other office's registry value.
 * @param {string} officeKey @param {CommTypeKind} kind @param {number} value
 * @returns {string|null}  e.g. "roland call"
 */
function defNumCrossing(officeKey, kind, value) {
  for (const s of Object.values(OFFICE_OD_SETTINGS)) {
    const r = officeAgents.servedRegistryOffice(s.officeKey);
    for (const k of COMMTYPE_KINDS) {
      if (s.officeKey === officeKey && k === kind) continue;
      if (codeDefaultDefNum(s, k) === value) return `${s.officeKey} ${k}`;
      if (r && positiveInt(r.commTypeDefNums[k]) === value) return `${s.officeKey} ${k}`;
    }
  }
  return null;
}

/**
 * The registry's DefNum for an office and type, or null (serve the code).
 * @param {string} officeKey @param {CommTypeKind} kind
 * @returns {{ value: number|null, reason: string|null }}
 */
function registryDefNum(officeKey, kind) {
  const r = officeAgents.servedRegistryOffice(officeKey);
  if (!r) return { value: null, reason: 'the office has no active registry row' };
  const v = positiveInt(r.commTypeDefNums[kind]);
  if (v === null) return { value: null, reason: 'the registry value is unconfigured' };
  const owner = defNumCrossing(officeKey, kind, v);
  // Not logged here: a refused value always differs from this office's code
  // default (or is that default), so the parity warning already names it and
  // gives this reason. This sits on the chart-note path; it must stay quiet.
  if (owner) return { value: null, reason: `DefNum ${v} belongs to ${owner}; DefNums never cross` };
  return { value: v, reason: null };
}

/**
 * The voice module's OD switch for an office: registry > code.
 * @param {OdOfficeSettings} settings @returns {boolean}
 */
function odEnabledFor(settings) {
  const r = officeAgents.servedRegistryOffice(settings.officeKey);
  // The code branch is the pre-MT-1b test exactly: `if (!settings.odEnabled)`.
  return r ? r.odEnabled === true : Boolean(settings.odEnabled);
}

/**
 * The hygiene FLOOR handed to config/hygPilot: code AND registry. The registry
 * may only lower it (see the precedence table above).
 * @param {OdOfficeSettings} settings @returns {boolean}
 */
function hygFloorFor(settings) {
  const r = officeAgents.servedRegistryOffice(settings.officeKey);
  return r ? settings.hygOdEnabled === true && r.hygOdEnabled === true : settings.hygOdEnabled;
}

/**
 * The display name served for an office (registry > code), for messages.
 * @param {string} officeKey @returns {string|undefined}
 */
function nameOf(officeKey) {
  const served = officeAgents.officeNameFor(officeKey);
  if (served !== undefined) return served;
  const c = OFFICES[officeKey];
  return c ? c.officeName : undefined;
}

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
  // The hygiene module's own per-office switch is off. 409 rather than 403 for
  // the same reason OFFICE_NOT_OD_CONNECTED is: the caller is entitled and the
  // request is well-formed, the OFFICE is simply not serving this module yet.
  // 403 is reserved for entitlement and permission, which are answered upstream.
  OFFICE_HYG_NOT_ENABLED: 409,
  OFFICE_OD_KEY_MISSING: 503,
  OFFICE_MISMATCH: 409,
  // A stored patient link that disagrees with the office an operation resolved to.
  // 409 for the same reason OFFICE_MISMATCH is: the request is well-formed and the
  // caller is allowed, but the state on the call contradicts it and only a human
  // can say which one is wrong.
  PATIENT_OFFICE_MISMATCH: 409,
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
 * @property {number|null} referralCommTypeDefNum this practice's "Referral" DefNum; null = not configured
 * @property {number|null} tcCommTypeDefNum this practice's "CareIN TC" DefNum; null = not configured
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
 * This office's CareIN commlog CommType DefNum: env override, else the
 * registry's (MT-1b, non-crossing), else the verified per-practice default. A
 * non-numeric override falls through rather than writing NaN into a chart note.
 * @param {OdOfficeSettings} settings
 * @returns {number}
 */
function commTypeDefNumFor(settings) {
  const raw = process.env[settings.commTypeEnv];
  const parsed = parseInt(raw, 10);
  if (Number.isInteger(parsed)) return parsed;
  const fromRegistry = registryDefNum(settings.officeKey, 'call').value;
  return fromRegistry !== null ? fromRegistry : settings.defaultCommTypeDefNum;
}

/**
 * This office's "Referral" commlog DefNum (R6.10): env override, else the
 * verified per-practice default — the mechanism commTypeDefNumFor uses. A
 * non-numeric or non-positive override falls back to the default; an office
 * with neither gets null, which the caller must treat as a refusal.
 * @param {OdOfficeSettings|undefined} settings
 * @returns {number|null}
 */
function referralCommTypeDefNumFor(settings) {
  if (!settings) return null;
  const parsed = parseInt(process.env[settings.referralCommTypeEnv], 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  // MT-1b: the registry's, between the env and the code default.
  const fromRegistry = registryDefNum(settings.officeKey, 'referral').value;
  if (fromRegistry !== null) return fromRegistry;
  const fallback = settings.defaultReferralCommTypeDefNum;
  return Number.isInteger(fallback) && fallback > 0 ? fallback : null;
}

/**
 * This office's "CareIN TC" commlog DefNum (AT-2), with the reason when there
 * is none: env override, else the registry's (non-crossing), else the verified
 * per-practice default, else null.
 *
 * Stricter than the two older types on ONE point, on purpose: an env override
 * naming a DefNum another (office, type) already owns is REFUSED (null), not
 * served. A valley number configured for roland is exactly the misconfig that
 * would file a note under the wrong practice's type, and this type is new, so
 * nothing depends on the looser behaviour. A non-numeric or non-positive
 * override falls through to the registry/default, like the referral type's.
 *
 * @param {OdOfficeSettings|undefined} settings
 * @returns {{ value: number|null, reason: string|null }}
 */
function tcCommTypeResolution(settings) {
  if (!settings) return { value: null, reason: 'the office has no Open Dental settings' };
  const parsed = parseInt(process.env[settings.tcCommTypeEnv], 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    const owner = defNumCrossing(settings.officeKey, 'tc', parsed);
    if (owner) {
      return { value: null, reason: `${settings.tcCommTypeEnv}=${parsed} is the ${owner} DefNum; DefNums never cross` };
    }
    return { value: parsed, reason: null };
  }
  const fromRegistry = registryDefNum(settings.officeKey, 'tc').value;
  if (fromRegistry !== null) return { value: fromRegistry, reason: null };
  const fallback = settings.defaultTcCommTypeDefNum;
  return Number.isInteger(fallback) && fallback > 0
    ? { value: fallback, reason: null }
    : { value: null, reason: 'no "CareIN TC" DefNum is configured' };
}

/** @param {OdOfficeSettings|undefined} settings @returns {number|null} */
function tcCommTypeDefNumFor(settings) {
  return tcCommTypeResolution(settings).value;
}

/**
 * Why (if at all) a TC activity item cannot be charted for an office right now
 * (AT-2): the office's own Open Dental readiness first, then a configured,
 * non-crossing "CareIN TC" DefNum. Pure — no network, no client — so the feed
 * can show the reason beside a disabled button.
 * @param {string} officeKey
 * @returns {{ code: string, message: string } | null}
 */
function tcChartNoteBlockReason(officeKey) {
  const blocked = odBlockReason(officeKey);
  if (blocked) return blocked;
  if (tcCommTypeDefNumFor(OFFICE_OD_SETTINGS[officeKey]) === null) {
    return {
      code: 'TC_COMMTYPE_NOT_CONFIGURED',
      message: `No "CareIN TC" chart note type is configured for ${nameOf(officeKey)}, so nothing can be written to its charts`,
    };
  }
  return null;
}

/**
 * Why (if at all) a referral chart note cannot be written for an office right
 * now: the office's own Open Dental readiness first, then a configured
 * "Referral" DefNum. Pure — no network, no client built — so the detail read
 * can show the reason beside a disabled button.
 * @param {string} officeKey
 * @returns {{ code: string, message: string } | null}
 */
function referralChartNoteBlockReason(officeKey) {
  const blocked = odBlockReason(officeKey);
  if (blocked) return blocked;
  if (referralCommTypeDefNumFor(OFFICE_OD_SETTINGS[officeKey]) === null) {
    return {
      code: 'REFERRAL_COMMTYPE_NOT_CONFIGURED',
      message: `No "Referral" chart note type is configured for ${nameOf(officeKey)}, so nothing can be written to its charts`,
    };
  }
  return null;
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
      message: `Open Dental is not configured for ${nameOf(officeKey)}`,
    };
  }

  // The voice module's reversible switch (odEnabled above). An office that has
  // not been turned on stays off no matter what credentials exist.
  if (!odEnabledFor(settings)) {
    return {
      code: 'OFFICE_NOT_OD_CONNECTED',
      message: `Open Dental is not connected for ${nameOf(officeKey)} yet`,
    };
  }

  // Fail closed PER OFFICE: turning the switch on without shipping the key leaves
  // this office honestly disconnected. It must NEVER inherit another office's
  // credentials — that is precisely the PatNum-collision hazard.
  if (!customerKeyFor(settings)) {
    return {
      code: 'OFFICE_OD_KEY_MISSING',
      message: `Open Dental credentials are not configured for ${nameOf(officeKey)}`,
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
 * Why (if at all) an office cannot serve the HYGIENE module right now.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY A SECOND FLAG, WHEN THE LAST SECOND FLAG WAS A BUG
 * ─────────────────────────────────────────────────────────────────────────────
 * The header above records that `officeAgents.OFFICES[].odConnected` was retired
 * because it "protected nothing": TC gated its routes on that flag while
 * actually reaching Open Dental through a process-wide client built from
 * ROLAND's key, so flipping it for valley served Roland's charts under a Riley
 * selector. The flag and the credential it claimed to describe were not
 * connected to each other.
 *
 * `hygOdEnabled` is not that. It COMPOSES with odBlockReason rather than
 * standing beside it: this function asks odBlockReason first and can only ever
 * narrow the answer. There is no state in which the hygiene module reaches an
 * office that the voice module could not, and no path by which one office's
 * credentials serve another — the client still comes from getOdOffice(), which
 * is unchanged.
 *
 * What it buys is the thing a new clinical module actually needs: a per-office
 * switch that starts OFF while the module is validated, and that can be turned
 * off for one office without taking that office's voice worklist and TC screens
 * down with it. Expressing "hygiene is not live at Riley yet" by flipping
 * `odEnabled` would do exactly that.
 *
 * Returns null when the office IS ready. Pure — no network call, no client
 * construction — so a roster endpoint and the UI can both ask it.
 *
 * @param {string} officeKey
 * @returns {{ code: string, message: string } | null}
 */
function hygOdBlockReason(officeKey) {
  // Everything the voice path refuses, the hygiene path refuses identically and
  // with the same code: unknown office, no registry entry, switch off, no key.
  const base = odBlockReason(officeKey);
  if (base) return base;

  const settings = OFFICE_OD_SETTINGS[officeKey];
  // Read at RUN TIME, through the precedence chain in config/hygPilot.js:
  // a disabling HYG_OD_ENABLED_<OFFICE> narrows first, then platform_setting,
  // then the hardcoded floor passed in here. (Nothing in the environment can
  // ENABLE an office — see that module's header.) Synchronous over a cached
  // value, because this function is on every
  // /api/hyg request. A console write updates that cache inline, so an office
  // turned OFF is refused on the VERY NEXT request — which is the only thing
  // that makes this a kill switch rather than a deployment.
  if (!hygPilot.hygEnabledFor(officeKey, hygFloorFor(settings))) {
    return {
      code: 'OFFICE_HYG_NOT_ENABLED',
      message: `The hygiene module is not switched on for ${nameOf(officeKey)} yet`,
    };
  }

  return null;
}

/**
 * The hygiene switch for every office, with the reason behind each value.
 *
 * THE COMPOSITION POINT, and the only place that knows all three layers: this
 * module owns the hardcoded floor and the office registry, config/hygPilot.js
 * owns the stored row and the environment, and neither can answer alone. A
 * route that assembled this itself would be a second implementation of the
 * precedence rule, and the direction that kind of disagreement fails in is a
 * console reporting one thing while the request path does another.
 *
 * `blockedBy` is the OTHER honest half: an office can be switched ON here and
 * still refuse every hygiene request because the voice path already refuses it
 * (no credentials, `odEnabled` off). The console must show that rather than a
 * green toggle over a 503.
 *
 * @returns {Array<{ officeKey: string, officeName: string, enabled: boolean,
 *                   source: 'db'|'env'|'default', db: boolean|null, env: boolean|null,
 *                   envVar: string, envRaw: string|null, hardcoded: boolean,
 *                   disagreesWithEnv: boolean, ready: boolean,
 *                   blockedBy: { code: string, message: string }|null }>}
 */
function hygSwitchState() {
  return Object.keys(OFFICE_OD_SETTINGS).map((officeKey) => {
    const settings = OFFICE_OD_SETTINGS[officeKey];
    const state = hygPilot.officeState(officeKey, hygFloorFor(settings));
    // Everything the VOICE path already refuses, independent of this switch.
    const base = odBlockReason(officeKey);
    return {
      ...state,
      officeName: describeOffice(officeKey).officeName,
      ready: isHygOdReady(officeKey),
      blockedBy: base,
    };
  });
}

/**
 * Whether an office can serve the hygiene module right now.
 * Strictly narrower than isOdReady() — see hygOdBlockReason.
 * @param {string} officeKey
 * @returns {boolean}
 */
function isHygOdReady(officeKey) {
  return hygOdBlockReason(officeKey) === null;
}

/**
 * Whether `officeKey` names a real office of this practice group.
 *
 * THE definition of "an office you may aim a chart action at", used by both the
 * route that validates a client-supplied `target_office` and the service that
 * resolves a stored `od_patient_office`. One definition on purpose: two would
 * eventually disagree, and the direction that disagreement fails in is a chart
 * write landing somewhere nobody named.
 *
 * `unknown` is excluded. It is the bucket for calls whose line we cannot
 * attribute; it has no Open Dental database, so it is not somewhere a note can
 * go. Note this is a REGISTRY question, not a readiness one — an office that is
 * switched off or unkeyed is still one of ours, and refusing it is odBlockReason's
 * job (with its own, more specific code) rather than this function's.
 *
 * @param {unknown} officeKey
 * @returns {boolean}
 */
function isChartTargetOffice(officeKey) {
  return (
    typeof officeKey === 'string' &&
    officeKey.length > 0 &&
    officeKey !== UNMAPPED_OFFICE &&
    Object.prototype.hasOwnProperty.call(OFFICES, officeKey)
  );
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
    officeName: officeConfig ? nameOf(officeKey) : 'Unmapped',
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
 * office gets its own instance built from its own customer key.
 *
 * There is no longer a background loop to opt out of: the client polled itself
 * every 3 minutes into an event nobody listened for, and that loop is gone. An
 * OpenDentalService now makes a request only when asked. Per-office
 * reachability is watched by services/odHealthCheck.js, which probes THROUGH
 * this function so it observes exactly the clients the real operations use.
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

  const settings = OFFICE_OD_SETTINGS[key];
  // The SERVED values, resolved on every call (pure, no I/O). While they match
  // the cached handle the cached handle is returned, the same frozen object as
  // before MT-1b; when a registry read changes one, a new handle is frozen
  // around the SAME client. The client depends only on the customer key, which
  // the registry never serves.
  const officeName = nameOf(key);
  const commTypeDefNum = commTypeDefNumFor(settings);
  const referralCommTypeDefNum = referralCommTypeDefNumFor(settings);
  const tcCommTypeDefNum = tcCommTypeDefNumFor(settings);

  const cached = clientCache.get(key);
  if (
    cached &&
    cached.officeName === officeName &&
    cached.commTypeDefNum === commTypeDefNum &&
    cached.referralCommTypeDefNum === referralCommTypeDefNum &&
    cached.tcCommTypeDefNum === tcCommTypeDefNum
  ) {
    return cached;
  }

  let client = cached ? cached.client : null;
  if (!client) {
    const customerKey = customerKeyFor(settings);
    // Reuse the singleton when it is already bound to THIS office's customer key.
    // Derived from the key itself (not hardcoded to 'roland'), so the day Roland's
    // key moves the reuse follows it — and a mismatched key never reuses.
    client =
      odCloudSingleton.customerKey && odCloudSingleton.customerKey === customerKey
        ? odCloudSingleton
        : new OpenDentalService({ customerKey, officeKey: key });
  }

  /** @type {OdOfficeHandle} */
  const handle = Object.freeze({
    officeKey: key,
    officeName: /** @type {string} */ (officeName),
    commTypeDefNum,
    referralCommTypeDefNum,
    tcCommTypeDefNum,
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

// ── Office registry parity tripwire (MT-1a, two-way since MT-1b) ─────────────
// Same as officeAgents' check, over the Open Dental fields this module owns.
// It still only LOGS; what is served is decided by the helpers above, and each
// warning says which side won and why. Compares the code DEFAULT DefNums: an
// env override is a deploy-time choice that outranks both, not something the
// registry is meant to mirror. Only secret NAMES are compared or logged, never
// a value.
const officeRegistry = require('../platform/officeRegistry');

/**
 * Why a divergent field is served from the CODE, or null when the registry wins.
 * @param {import('../platform/officeRegistry').Divergence} d
 * @returns {string|null}
 */
function servedCodeReason(d) {
  if (d.field === 'odCustomerKeySecret' || d.field === 'odCustomerKeyEnv') {
    return 'credential names are code-only; config/secrets.js loads a fixed list';
  }
  const settings = OFFICE_OD_SETTINGS[d.officeKey];
  if (!settings) return 'the office has no Open Dental settings';
  const r = officeAgents.servedRegistryOffice(d.officeKey);
  if (!r) return 'the office has no active registry row';
  switch (d.field) {
    case 'commTypeDefNums.call':
      return registryDefNum(d.officeKey, 'call').reason;
    case 'commTypeDefNums.referral':
      return registryDefNum(d.officeKey, 'referral').reason;
    case 'commTypeDefNums.tc':
      return registryDefNum(d.officeKey, 'tc').reason;
    case 'hygOdEnabled':
      return r.hygOdEnabled === true && settings.hygOdEnabled !== true
        ? 'the registry can only lower the hygiene floor, never raise it'
        : null;
    default:
      return null;
  }
}

const registryParity = officeRegistry.createParityCheck({
  label: 'odOffices',
  servedCode: servedCodeReason,
  fields: [
    'odCustomerKeySecret',
    'odCustomerKeyEnv',
    'commTypeDefNums.call',
    'commTypeDefNums.referral',
    'commTypeDefNums.tc',
    'odEnabled',
    'hygOdEnabled',
  ],
});
officeRegistry.onRefresh((offices, tenantSlug) => {
  if (tenantSlug === officeRegistry.CODE_MAP_TENANT_SLUG) registryParity.check(offices);
});

module.exports = {
  OdOfficeError,
  OFFICE_OD_SETTINGS,
  httpStatusFor,
  odBlockReason,
  isOdReady,
  hygOdBlockReason,
  isHygOdReady,
  hygSwitchState,
  isChartTargetOffice,
  referralChartNoteBlockReason,
  tcChartNoteBlockReason,
  COMMTYPE_KINDS,
  describeOffice,
  getOdOffice,
  assertOfficeMatch,
  resetOdOfficeCache,
  /** Parity tripwire (MT-1a). Logs only; returns the divergences it found. */
  checkRegistryParity: registryParity.check,
  /** TESTS ONLY: forget which divergences were already warned about. */
  resetRegistryParityForTests: registryParity.resetForTests,
  /** Exposed for diagnostics — secret NAMES only, never values. */
  secretNames: Object.values(OFFICE_OD_SETTINGS).map((s) => s.customerKeySecret),
};
