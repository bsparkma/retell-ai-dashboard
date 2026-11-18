'use strict';

/**
 * The hygiene module's per-office pilot switch, at RUN TIME.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS: A KILL SWITCH THAT NEEDS A DEPLOY IS NOT A KILL SWITCH
 * ═════════════════════════════════════════════════════════════════════════════
 * `OFFICE_OD_SETTINGS[x].hygOdEnabled` shipped as a hardcoded `false` in source.
 * Turning hygiene on for Roland meant editing a file, building a container,
 * deploying, and riding a promotion train. **Turning it OFF meant the same.**
 *
 * Pilot morning, a hygienist hits a problem at 9am with a patient in the chair.
 * Switching that office off has to take under a minute, and it has to be a
 * click. That is what this module buys, and it is a safety property rather than
 * a convenience one.
 *
 * It also unblocks two things that were stuck behind the constant: the Day
 * View's staging measurement (which needed a second deploy just to flip this),
 * and services/hygDayWarm.js, which had never executed anywhere because every
 * office was false — its first real run would otherwise have been pilot morning
 * in production.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * PRECEDENCE
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *     HYG_OD_ENABLED_<OFFICE>=false        ← break-glass. Forces OFF. Always,
 *                                            for every tenant's office with that key.
 *       ↓ (unset, `=true`, or unparseable — none of which can ENABLE anything)
 *     office_setting(tenant, *, 'hyg_od_enabled')
 *                                          ← MT-2b: the SERVED stored layer. The
 *                                            console still writes platform_setting
 *                                            too, in the same transaction.
 *       ↓ (the tenant holds no row, or nothing is served: never read, last read
 *          failed, or stale — platform/officeSettings.js)
 *     OFFICE_OD_SETTINGS[x].hygOdEnabled   ← hardcoded, and it stays FALSE.
 *                                            Tenant 'carein' only (its code map);
 *                                            every other tenant's floor is OFF.
 *
 * MT-2b, READ FIRST: every accessor takes the TENANT first. An office is one of
 * tenant T's only if T has an active office row (platform/officeRegistry
 * tenantOfficeKeys); anything else is OFF. "Keep using what we read" in FAIL
 * CLOSED below still holds, now BOUNDED: a failed control-plane read keeps
 * serving the last good read until it is older than three refresh windows;
 * after that (or never read) the answer is "nobody chose", which is the floor,
 * which is OFF. The office_setting cache is
 * shared by all ten readers (platform/officeSettings.js) and refreshed for
 * every active tenant by this module's timer. "A row" below now means the
 * tenant's office_setting rows for the key: when it holds ANY, an office
 * without one is OFF, exactly as an office absent from the old map was.
 *
 * Shaped after config/retention.js, which already solved this for the call
 * retention window and is proven in production. Read that file first; the
 * differences below each carry their reason.
 *
 * **A ROW THAT EXISTS ANSWERS FOR EVERY OFFICE.** Once the setting row is
 * present and usable, an office ABSENT from it is `false` — not "unset", not
 * "inherit from the environment". That is exactly the retention module's
 * `days: null` behaviour generalised to a map, and it means an environment the
 * console has never touched behaves exactly as it did before this module
 * existed. The migration seeds no row on purpose.
 *
 * **THE ENV OVERRIDE IS ONE-DIRECTIONAL: IT CAN ONLY TURN AN OFFICE OFF.**
 * Break-glass exists for "the console is unreachable and I need to kill this."
 * There is no incident whose correct response is turning a module ON while the
 * control plane is down. So:
 *
 *   - `HYG_OD_ENABLED_ROLAND=false` forces roland OFF, whatever the stored row
 *     says. It wins over nothing — it only ever NARROWS, exactly the way
 *     `odOffices.hygOdBlockReason()` narrows `odBlockReason()`.
 *   - `HYG_OD_ENABLED_ROLAND=true` is accepted as input and cannot enable
 *     anything. It is reported at boot and shown in the console as inert,
 *     because somebody set it expecting an effect and a variable that quietly
 *     does nothing is its own incident.
 *   - Anything else (`yes`, ``, `1`) is not a boolean and is ignored, loudly.
 *
 * That makes the fast always-available path the SAFE one — the same rule the
 * console already follows by confirming an on-flip and never an off-flip.
 *
 * The consequence to know before debugging: a stale `=true` left over from an
 * earlier incident CANNOT re-enable an office somebody deliberately turned off,
 * not even on a boot where the control DB is unreachable and nothing is cached.
 * That was the hole this rule closes.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY ONE ROW, KEYED BY OFFICE, RATHER THAN A KEY PER OFFICE
 * ═════════════════════════════════════════════════════════════════════════════
 * `{"roland": true, "valley": false}` in a single `platform_setting` row.
 *
 *   - **One atomic write.** A change touching two offices cannot half-apply;
 *     there is no window in which one office has moved and the other has not.
 *   - **One audit target.** Every flip files against the same `resource_id`,
 *     so "show me every time the hygiene switch moved" is one query rather than
 *     a query per office that has ever existed.
 *   - **One read.** The request path asks this module on every `/api/hyg`
 *     request; a key per office would be a row per office per refresh.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THE ACCESSOR IS SYNCHRONOUS
 * ═════════════════════════════════════════════════════════════════════════════
 * `hygEnabledFor()` is read from `odOffices.hygOdBlockReason()`, which is sync
 * and is called from `resolveHygOd()`, which is sync, on every request. Making
 * that path async to fetch a boolean that changes roughly never would thread a
 * promise through the whole hygiene module for nothing.
 *
 * So the DB value is CACHED here and refreshed explicitly: at boot, immediately
 * after a console write, before every morning warm, and on a modest timer. The
 * request path reads a value that is at most one refresh interval old — and,
 * because `maxReplicas` is 1, a console write in this process is in force for
 * the very next request with no interval at all. That last property is the one
 * the OFF-is-instant test pins.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FAIL CLOSED, IN BOTH DIRECTIONS
 * ═════════════════════════════════════════════════════════════════════════════
 *   - Control DB never read since boot AND no env override → the hardcoded
 *     `false` answers. **OFF.** We never assume the last thing we saw, because
 *     we have seen nothing.
 *   - Control DB read once and then unreachable → keep using what we read. A
 *     database blip must not switch a practice's chairside screen off mid-morning
 *     any more than it should switch one on.
 *
 * This module can only ever NARROW what the voice path allows:
 * `odOffices.hygOdBlockReason()` asks `odBlockReason()` FIRST and only then
 * consults this. There is no value of this setting that reaches an office the
 * voice module could not. `odOffices.test.js` pins that.
 */

const registry = require('../platform/registry');
const officeSettings = require('../platform/officeSettings');
const officeRegistry = require('../platform/officeRegistry');
const { MT2A_TENANT_SLUG, answerFromRows } = require('../platform/officeSettingKeys');
const { OFFICES } = require('./officeAgents');

/** The setting key the per-office values are stored under. */
const SETTING_KEY = 'hyg_od_enabled';

/** Per-office break-glass env override, e.g. `HYG_OD_ENABLED_ROLAND`. */
const ENV_PREFIX = 'HYG_OD_ENABLED_';

/** @type {NodeJS.Timeout|null} */
let refreshTimer = null;

/**
 * Have we already said that an enabling env override is inert?
 * One line per process, at boot — see warnAboutInertEnvOverrides.
 * @type {boolean}
 */
let inertEnvWarned = false;

/** Minutes between background refreshes. @returns {number} */
function refreshMinutes() {
  const raw = Number(String(process.env.HYG_PILOT_REFRESH_MINUTES ?? '').trim());
  return Number.isFinite(raw) && raw > 0 ? raw : 5;
}

/**
 * Is this one of tenant T's real offices (MT-1c)? 'unknown' never is.
 * @param {unknown} tenantSlug
 * @param {unknown} officeKey
 * @returns {boolean}
 */
function isKnownOffice(tenantSlug, officeKey) {
  return officeRegistry.isTenantOffice(tenantSlug, officeKey);
}

/** The env var name for an office. @param {string} officeKey @returns {string} */
function envVarFor(officeKey) {
  return ENV_PREFIX + String(officeKey).toUpperCase();
}

/**
 * What the ENVIRONMENT says about one office, ignoring the database entirely.
 *
 * Returns null for unset and for anything that is not plainly true or false —
 * a `HYG_OD_ENABLED_ROLAND=yes` must not read as "on" for a switch that turns
 * a real practice's chart data on. The raw string is surfaced by
 * `officeState()` so the console can show that somebody tried.
 *
 * This reports what was SET, not what takes effect. `true` is a legal value
 * here and still cannot enable an office — see `hygEnabledFor` and the header.
 *
 * @param {string} officeKey
 * @returns {boolean|null}
 */
function envOverrideFor(officeKey) {
  const raw = process.env[envVarFor(officeKey)];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/**
 * Say, once, that an enabling env override is doing nothing.
 *
 * `HYG_OD_ENABLED_ROLAND=true` is accepted as input and cannot turn anything
 * on. Silently ignoring it would be the worse failure of the two: somebody set
 * it during an incident, expecting an effect, and would be left watching a
 * module stay dark with no explanation anywhere.
 *
 * Called from server.js at boot. Idempotent per process.
 *
 * @returns {string[]} the offices warned about (empty when there are none)
 */
function warnAboutInertEnvOverrides() {
  if (inertEnvWarned) return [];
  inertEnvWarned = true;

  const inert = Object.keys(OFFICES).filter((officeKey) => envOverrideFor(officeKey) === true);
  for (const officeKey of inert) {
    console.warn(
      `[hygPilot] ${envVarFor(officeKey)}=true is set, and it is doing nothing: this variable ` +
        `can only DISABLE an office, never enable one. Turn hygiene on for '${officeKey}' from ` +
        'the platform console (Platform → Hygiene).'
    );
  }
  return inert;
}

/**
 * The SERVED stored-layer answer for one office: when the tenant holds ANY
 * served row for the key, an office without one is false; no served rows at
 * all is null ("nobody chose"). Synchronous.
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @returns {boolean|null}
 */
function storedFor(tenantSlug, officeKey) {
  const answer = answerFromRows(SETTING_KEY, officeSettings.servedRows(tenantSlug, SETTING_KEY), officeKey);
  return typeof answer === 'boolean' ? answer : null;
}

/**
 * Is the hygiene module switched on for this tenant's office, right now?
 *
 * THE accessor. Synchronous, over the shared office_setting cache.
 *
 * `hardcodedFallback` is passed IN rather than read from odOffices, because
 * odOffices requires this module. It is the floor of the precedence chain, it
 * ships `false` for every office, and it is tenant 'carein's code map — so it
 * is honoured for 'carein' only. Every other tenant's floor is OFF.
 *
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {boolean} [hardcodedFallback] `OFFICE_OD_SETTINGS[officeKey].hygOdEnabled`
 * @returns {boolean}
 */
function hygEnabledFor(tenantSlug, officeKey, hardcodedFallback = false) {
  if (!isKnownOffice(tenantSlug, officeKey)) return false;
  // Break-glass, and it only points one way: `=false` forces OFF whatever the
  // stored rows say, and no env value can enable anything. See the header.
  if (envOverrideFor(officeKey) === false) return false;

  const stored = storedFor(tenantSlug, officeKey);
  if (stored !== null) return stored;

  return tenantSlug === MT2A_TENANT_SLUG && hardcodedFallback === true;
}

/**
 * Which layer answered `hygEnabledFor` for this office.
 *
 * Only a DISABLING env var can be the answer. A `=true` never is.
 *
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @returns {'db'|'env'|'default'}
 */
function sourceFor(tenantSlug, officeKey) {
  if (envOverrideFor(officeKey) === false) return 'env';
  if (isKnownOffice(tenantSlug, officeKey) && storedFor(tenantSlug, officeKey) !== null) return 'db';
  return 'default';
}

/**
 * Is the tenant's office_setting read being SERVED right now (read, last read
 * succeeded, fresh)? Reported by the console so "off because somebody turned it
 * off" and "off because we cannot ask" are not the same sentence on screen.
 *
 * @param {string} tenantSlug
 * @returns {boolean}
 */
function policyKnown(tenantSlug) {
  return officeSettings.isServed(tenantSlug);
}

/**
 * Re-read the tenant's office_setting rows from the control DB.
 *
 * NEVER THROWS. It is called from a timer, from a warm pass, and from request
 * paths that have their own error reporting.
 *
 * `byOffice` is the SERVED stored layer after the read: the tenant's offices
 * that hold a row, office -> boolean, or null when it holds none (or nothing
 * is served) — the same shape this returned before MT-2b.
 *
 * @param {string} tenantSlug
 * @returns {Promise<{ ok: boolean, byOffice: Record<string, boolean>|null, error: string|null }>}
 */
async function refreshFromDb(tenantSlug) {
  if (tenantSlug !== officeRegistry.CODE_MAP_TENANT_SLUG && typeof tenantSlug === 'string' && tenantSlug) {
    await officeRegistry.refreshFromDb(tenantSlug).catch(() => {});
  }
  const read = await officeSettings.refreshFromDb(tenantSlug);
  const rows = officeSettings.servedRows(tenantSlug, SETTING_KEY);
  /** @type {Record<string, boolean>|null} */
  let byOffice = null;
  if (rows && rows.size > 0) {
    byOffice = {};
    for (const [officeKey, value] of rows) if (typeof value === 'boolean') byOffice[officeKey] = value;
  }
  return { ok: read.ok, byOffice, error: read.error };
}

/**
 * Store a new value for ONE office and adopt it immediately.
 *
 * READ-MODIFY-WRITE against the DATABASE, not against a cache: a runbook may
 * have written the row directly since the last refresh, and flipping roland
 * must not silently revert valley to whatever we last saw. Unknown office keys
 * already in the platform_setting map are PRESERVED rather than dropped.
 *
 * The registry writes platform_setting AND office_setting in one transaction
 * (MT-2a, kept for rollback). The cache is then refreshed FROM office_setting
 * and the served row must read back as asked, so what the console reports is
 * what is served.
 *
 * Tenant 'carein' only until MT-2d: platform_setting holds no other tenant's
 * settings, and writing another tenant's switch into it would write carein's.
 *
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {boolean} enabled
 * @param {string|null} [updatedBy] actor email
 * @returns {Promise<{ officeKey: string, enabled: boolean, updatedAt: string|null, updatedBy: string|null }>}
 * @throws {Error & { code?: string }} OFFICE_SETTING_TENANT_NOT_WRITABLE | INVALID_OFFICE |
 *         INVALID_HYG_ENABLED | HYG_SWITCH_READBACK_FAILED
 */
async function persistHygEnabled(tenantSlug, officeKey, enabled, updatedBy = null) {
  if (tenantSlug !== MT2A_TENANT_SLUG) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`per-office settings can only be written for tenant '${MT2A_TENANT_SLUG}' until MT-2d`)
    );
    err.code = 'OFFICE_SETTING_TENANT_NOT_WRITABLE';
    throw err;
  }
  if (!isKnownOffice(tenantSlug, officeKey)) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`'${officeKey}' is not an office of this practice group`)
    );
    err.code = 'INVALID_OFFICE';
    throw err;
  }
  if (typeof enabled !== 'boolean') {
    const err = /** @type {Error & { code?: string }} */ (new Error('enabled must be true or false'));
    err.code = 'INVALID_HYG_ENABLED';
    throw err;
  }

  const current = await registry.getPlatformSetting(SETTING_KEY);
  const base =
    current && current.value && typeof current.value === 'object' && !Array.isArray(current.value)
      ? /** @type {Record<string, unknown>} */ ({ ...current.value })
      : {};
  base[officeKey] = enabled;

  await registry.setPlatformSetting(SETTING_KEY, base, updatedBy, { officeKey });

  const refreshed = await refreshFromDb(tenantSlug);
  if (!refreshed.ok || storedFor(tenantSlug, officeKey) !== enabled) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(
        `stored the switch but could not read it back: ${refreshed.error || 'office_setting does not hold it'}`
      )
    );
    err.code = 'HYG_SWITCH_READBACK_FAILED';
    throw err;
  }

  const cell = officeSettings.servedCell(tenantSlug, officeKey, SETTING_KEY);
  return {
    officeKey,
    enabled: hygEnabledFor(tenantSlug, officeKey),
    updatedAt: cell ? cell.updatedAt : null,
    updatedBy: cell ? cell.updatedBy : null,
  };
}

/**
 * Everything the console needs to render ONE office honestly, including WHY the
 * effective value is what it is and whether the layers disagree.
 *
 * `envEffect`: `disables` — the var says false, so this office is off no matter
 * what is stored; `inert` — the var says true, which can never enable anything.
 *
 * `inRow`: whether the tenant holds a served row FOR THIS office. A tenant
 * holding rows that do not name an office reads as `db: false`, exactly like
 * one that says `false` outright; they are the same effective value and a
 * different sentence.
 *
 * @param {string} tenantSlug
 * @param {string} officeKey
 * @param {boolean} [hardcodedFallback]
 * @returns {{ officeKey: string, enabled: boolean, source: 'db'|'env'|'default',
 *             db: boolean|null, inRow: boolean|null, env: boolean|null,
 *             envVar: string, envRaw: string|null, envEffect: 'disables'|'inert'|null,
 *             hardcoded: boolean, disagreesWithEnv: boolean }}
 */
function officeState(tenantSlug, officeKey, hardcodedFallback = false) {
  const known = isKnownOffice(tenantSlug, officeKey);
  const db = known ? storedFor(tenantSlug, officeKey) : null;
  const rows = officeSettings.servedRows(tenantSlug, SETTING_KEY);
  const inRow = known && rows && rows.size > 0 ? rows.has(officeKey) : null;
  const env = envOverrideFor(officeKey);
  const rawEnv = process.env[envVarFor(officeKey)];
  const enabled = hygEnabledFor(tenantSlug, officeKey, hardcodedFallback);

  return {
    officeKey,
    enabled,
    source: sourceFor(tenantSlug, officeKey),
    db,
    inRow,
    env,
    envVar: envVarFor(officeKey),
    envRaw: rawEnv === undefined ? null : String(rawEnv),
    envEffect: env === false ? 'disables' : env === true ? 'inert' : null,
    hardcoded: hardcodedFallback === true,
    disagreesWithEnv: db !== null && env !== null && db !== env,
  };
}

/**
 * Provenance of the stored rows, for the console's "who set this" line: the
 * most recently changed of the tenant's served rows for this key.
 * @param {string} tenantSlug
 */
function settingMeta(tenantSlug) {
  const rows = officeSettings.servedRows(tenantSlug, SETTING_KEY);
  /** @type {{ updatedAt: string|null, updatedBy: string|null }} */
  let latest = { updatedAt: null, updatedBy: null };
  for (const officeKey of rows ? rows.keys() : []) {
    const cell = officeSettings.servedCell(tenantSlug, officeKey, SETTING_KEY);
    if (cell && cell.updatedAt && (!latest.updatedAt || cell.updatedAt > latest.updatedAt)) {
      latest = { updatedAt: cell.updatedAt, updatedBy: cell.updatedBy };
    }
  }
  return {
    policyKnown: policyKnown(tenantSlug),
    hasRow: Boolean(rows && rows.size > 0),
    updatedAt: latest.updatedAt,
    updatedBy: latest.updatedBy,
    settingKey: SETTING_KEY,
  };
}

/**
 * Refresh every ACTIVE tenant's office_setting read in the background, so a
 * value written straight into the control DB by a runbook reaches the
 * synchronous request path without a restart, and no tenant's served read goes
 * stale (stale = OFF).
 *
 * @returns {boolean} true when a timer was armed by this call
 */
function startRefreshTimer() {
  if (refreshTimer) return false;
  const minutes = refreshMinutes();
  refreshTimer = setInterval(() => {
    officeSettings.refreshActiveTenants().catch(() => {});
  }, minutes * 60 * 1000);
  if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  return true;
}

/** Disarm the background refresh (SIGTERM / SIGINT / tests). @returns {void} */
function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

/**
 * Drop every cached office_setting read, returning to the never-loaded state.
 * FOR TESTS.
 * @returns {void}
 */
function resetCacheForTests() {
  officeSettings.resetCacheForTests();
  inertEnvWarned = false;
  stopRefreshTimer();
}

module.exports = {
  SETTING_KEY,
  ENV_PREFIX,
  envVarFor,
  envOverrideFor,
  warnAboutInertEnvOverrides,
  hygEnabledFor,
  sourceFor,
  policyKnown,
  refreshFromDb,
  persistHygEnabled,
  officeState,
  settingMeta,
  startRefreshTimer,
  stopRefreshTimer,
  resetCacheForTests,
  refreshMinutes,
};
