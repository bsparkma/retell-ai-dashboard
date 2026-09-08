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
 *     HYG_OD_ENABLED_<OFFICE>=false        ← break-glass. Forces OFF. Always.
 *       ↓ (unset, `=true`, or unparseable — none of which can ENABLE anything)
 *     platform_setting['hyg_od_enabled']   ← the console writes this
 *       ↓ (no row, or a row this module cannot parse)
 *     OFFICE_OD_SETTINGS[x].hygOdEnabled   ← hardcoded, and it stays FALSE
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
const { OFFICES } = require('./officeAgents');

/** The `platform_setting` key the whole map is stored under. */
const SETTING_KEY = 'hyg_od_enabled';

/** Per-office break-glass env override, e.g. `HYG_OD_ENABLED_ROLAND`. */
const ENV_PREFIX = 'HYG_OD_ENABLED_';

/**
 * The cached view of the stored row.
 *
 * `loaded` records whether the control DB has EVER been read successfully,
 * which is a different question from whether a row exists. `byOffice: null`
 * with `loaded: true` means "asked, and nobody has chosen" — the state that
 * hands control to the environment. `byOffice: {}` means somebody stored an
 * empty map, which switches every office OFF and is a decision, not an absence.
 *
 * @type {{ loaded: boolean, byOffice: Record<string, boolean>|null,
 *          raw: Record<string, unknown>|null, updatedAt: string|null, updatedBy: string|null }}
 */
let cache = { loaded: false, byOffice: null, raw: null, updatedAt: null, updatedBy: null };

/**
 * The last refresh failure we logged.
 *
 * A DEVIATION from config/retention.js, which logs every failed read. Retention
 * refreshes a handful of times a day (boot, the nightly prune, a settings page
 * view). This one refreshes on a timer forever, so an unreachable control plane
 * would print the same line every few minutes until somebody muted the log —
 * which is how the eConnector alert flood happened. The first occurrence and
 * any CHANGE are still logged; a repeat of the identical message is not.
 * @type {string|null}
 */
let lastLoggedError = null;

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
 * Is this a real office of this practice group?
 *
 * Deliberately `officeAgents.OFFICES` rather than `odOffices.OFFICE_OD_SETTINGS`:
 * odOffices requires THIS module, so reaching back into it would be a cycle.
 * The two maps carry the same keys and officeAgents is the one that defines
 * them.
 *
 * @param {unknown} officeKey
 * @returns {boolean}
 */
function isKnownOffice(officeKey) {
  return (
    typeof officeKey === 'string' &&
    Object.prototype.hasOwnProperty.call(OFFICES, officeKey)
  );
}

/**
 * A stored jsonb value → the per-office map this module will honour.
 *
 * Returns null when the value is not a usable map at all, which is treated
 * exactly like an absent row: the environment and then the hardcoded floor
 * answer instead. Falling back is defined behaviour; guessing is not.
 *
 * A value that IS a map but contains junk is not discarded wholesale — an
 * unknown office key or a non-boolean value is dropped, loudly, and the rest of
 * the map still applies. One typo must not be able to make the whole switch
 * unreadable and take a live pilot office down with it.
 *
 * @param {unknown} value
 * @returns {{ byOffice: Record<string, boolean>, raw: Record<string, unknown> }|null}
 */
function parseStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  /** @type {Record<string, boolean>} */
  const byOffice = {};
  for (const [key, raw] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    if (!isKnownOffice(key)) {
      console.warn(
        `[hygPilot] platform_setting['${SETTING_KEY}'] names '${key}', which is not an office — ignoring that entry`
      );
      continue;
    }
    if (typeof raw !== 'boolean') {
      console.warn(
        `[hygPilot] platform_setting['${SETTING_KEY}']['${key}'] is ${JSON.stringify(raw)}, not a boolean — ` +
          'treating that office as ABSENT, which means OFF'
      );
      continue;
    }
    byOffice[key] = raw;
  }

  return { byOffice, raw: /** @type {Record<string, unknown>} */ (value) };
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
 * Parsing and honouring are kept separate on purpose: the console has to be
 * able to say "you set this to true and it is doing nothing", which it cannot
 * do if an inert value is indistinguishable from an unset one.
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
 * module stay dark with no explanation anywhere. A variable that quietly does
 * nothing is its own incident.
 *
 * Called from server.js at boot, after the first refresh. Idempotent per
 * process — this must not become a line the log prints on a timer.
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
 * Is the hygiene module switched on for this office, right now?
 *
 * THE accessor. Synchronous, over the boot-loaded cache — see the header.
 *
 * `hardcodedFallback` is passed IN rather than read from odOffices, because
 * odOffices requires this module. It is the floor of the precedence chain and
 * it ships `false` for every office; the parameter exists so the layering has
 * no cycle in it, not so anybody can raise the floor.
 *
 * @param {string} officeKey
 * @param {boolean} [hardcodedFallback] `OFFICE_OD_SETTINGS[officeKey].hygOdEnabled`
 * @returns {boolean}
 */
function hygEnabledFor(officeKey, hardcodedFallback = false) {
  // Break-glass, and it only points one way: `=false` forces OFF whatever the
  // stored row says, and no env value can enable anything. See the header.
  if (envOverrideFor(officeKey) === false) return false;

  // A usable stored row answers for EVERY office; absent from it means false.
  if (cache.loaded && cache.byOffice) return cache.byOffice[officeKey] === true;

  return hardcodedFallback === true;
}

/**
 * Which layer answered `hygEnabledFor` for this office.
 *
 * Only a DISABLING env var can be the answer. A `=true` never is — reporting
 * `env` for a value that cannot take effect would tell an operator the app
 * setting is in charge at the exact moment they need to know it is inert.
 *
 * @param {string} officeKey
 * @returns {'db'|'env'|'default'}
 */
function sourceFor(officeKey) {
  if (envOverrideFor(officeKey) === false) return 'env';
  if (cache.loaded && cache.byOffice) return 'db';
  return 'default';
}

/**
 * Has the control DB been read successfully at least once since boot?
 *
 * Reported by the console so "off because somebody turned it off" and "off
 * because we have never been able to ask" are not the same sentence on screen.
 * Unlike retention's `policyKnown()`, nothing REFUSES to act on a false here:
 * the honest response to not knowing is OFF, and OFF is already what the
 * precedence chain produces.
 *
 * @returns {boolean}
 */
function policyKnown() {
  return cache.loaded;
}

/**
 * Re-read the stored map from the control DB.
 *
 * NEVER THROWS. It is called from a timer, from a warm pass, and from request
 * paths that have their own error reporting; an exception here would take down
 * a scheduled job or turn a settings page into a 500 over a transient blip.
 *
 * A failed refresh LEAVES THE PREVIOUS CACHE in place. A database blip must not
 * switch a practice's chairside screen off mid-morning, any more than it should
 * switch one on.
 *
 * @returns {Promise<{ ok: boolean, byOffice: Record<string, boolean>|null, error: string|null }>}
 */
async function refreshFromDb() {
  try {
    const row = await registry.getPlatformSetting(SETTING_KEY);
    lastLoggedError = null;

    if (!row) {
      // Nobody has chosen. Hands control to the environment, then the floor.
      cache = { loaded: true, byOffice: null, raw: null, updatedAt: null, updatedBy: null };
      return { ok: true, byOffice: null, error: null };
    }

    const parsed = parseStored(row.value);
    if (!parsed) {
      console.warn(
        `[hygPilot] platform_setting['${SETTING_KEY}'] holds an unusable value ` +
          `(${JSON.stringify(row.value)}) — ignoring it and falling back to the environment`
      );
      cache = { loaded: true, byOffice: null, raw: null, updatedAt: null, updatedBy: null };
      return { ok: true, byOffice: null, error: null };
    }

    cache = {
      loaded: true,
      byOffice: parsed.byOffice,
      raw: parsed.raw,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      updatedBy: row.updated_by || null,
    };
    return { ok: true, byOffice: parsed.byOffice, error: null };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    // See lastLoggedError: this runs on a timer, so an unreachable control
    // plane must not print the same line every few minutes forever.
    if (message !== lastLoggedError) {
      console.error(`[hygPilot] could not read the hygiene switch: ${message}`);
      lastLoggedError = message;
    }
    return { ok: false, byOffice: cache.byOffice, error: message };
  }
}

/**
 * Store a new value for ONE office and adopt it immediately.
 *
 * READ-MODIFY-WRITE against the DATABASE, not against this module's cache: a
 * runbook may have written the row directly since the last refresh, and
 * flipping roland must not silently revert valley to whatever we last saw.
 * Unknown office keys already in the row are PRESERVED rather than dropped —
 * this module ignores them when reading, which is not the same as being
 * entitled to delete somebody's data.
 *
 * The cache is then refreshed FROM THE DATABASE rather than set from the
 * argument, so what the console reports back is what was actually persisted. A
 * write that succeeded and a write we merely believe succeeded must not look
 * the same. (config/retention.js, same rule, same reason.)
 *
 * @param {string} officeKey
 * @param {boolean} enabled
 * @param {string|null} [updatedBy] actor email
 * @returns {Promise<{ officeKey: string, enabled: boolean, updatedAt: string|null, updatedBy: string|null }>}
 * @throws {Error & { code?: string }} INVALID_OFFICE | INVALID_HYG_ENABLED | HYG_SWITCH_READBACK_FAILED
 */
async function persistHygEnabled(officeKey, enabled, updatedBy = null) {
  if (!isKnownOffice(officeKey)) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`'${officeKey}' is not an office of this practice group`)
    );
    err.code = 'INVALID_OFFICE';
    throw err;
  }
  if (typeof enabled !== 'boolean') {
    const err = /** @type {Error & { code?: string }} */ (
      new Error('enabled must be true or false')
    );
    err.code = 'INVALID_HYG_ENABLED';
    throw err;
  }

  const current = await registry.getPlatformSetting(SETTING_KEY);
  const base =
    current && current.value && typeof current.value === 'object' && !Array.isArray(current.value)
      ? /** @type {Record<string, unknown>} */ ({ ...current.value })
      : {};
  base[officeKey] = enabled;

  await registry.setPlatformSetting(SETTING_KEY, base, updatedBy);

  const refreshed = await refreshFromDb();
  if (!refreshed.ok) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error(`stored the switch but could not read it back: ${refreshed.error}`)
    );
    err.code = 'HYG_SWITCH_READBACK_FAILED';
    throw err;
  }

  return {
    officeKey,
    enabled: hygEnabledFor(officeKey),
    updatedAt: cache.updatedAt,
    updatedBy: cache.updatedBy,
  };
}

/**
 * Everything the console needs to render ONE office honestly, including WHY the
 * effective value is what it is and whether the layers disagree.
 *
 * `envEffect` is the incident field, and it has to be reported rather than
 * derived by the caller, because the two disagreements read in OPPOSITE
 * directions now that the override is one-directional:
 *
 *   `disables` — the var says false, so this office is off no matter what the
 *                stored row says. The app setting is in charge.
 *   `inert`    — the var says true, which can never enable anything. Somebody
 *                set it and is watching nothing happen; say so.
 *
 * `disagreesWithEnv` stays as the narrower "the database answered and the env
 * var says the opposite" fact, which is the pair a console shows side by side.
 *
 * @param {string} officeKey
 * @param {boolean} [hardcodedFallback]
 * `inRow` is the OTHER honest distinction, and it is not cosmetic: a stored row
 * that does not NAME an office reads as `db: false`, exactly like one that says
 * `false` outright. They are the same effective value and a different sentence —
 * "turned off by somebody on Tuesday" is a claim about a person, and printing it
 * over an office nobody has ever touched is a lie the console would tell every
 * time a second office existed.
 *
 * @returns {{ officeKey: string, enabled: boolean, source: 'db'|'env'|'default',
 *             db: boolean|null, inRow: boolean|null, env: boolean|null,
 *             envVar: string, envRaw: string|null, envEffect: 'disables'|'inert'|null,
 *             hardcoded: boolean, disagreesWithEnv: boolean }}
 */
function officeState(officeKey, hardcodedFallback = false) {
  const db = cache.loaded && cache.byOffice ? cache.byOffice[officeKey] === true : null;
  const inRow =
    cache.loaded && cache.byOffice
      ? Object.prototype.hasOwnProperty.call(cache.byOffice, officeKey)
      : null;
  const env = envOverrideFor(officeKey);
  const rawEnv = process.env[envVarFor(officeKey)];
  const enabled = hygEnabledFor(officeKey, hardcodedFallback);

  return {
    officeKey,
    enabled,
    source: sourceFor(officeKey),
    db,
    inRow,
    env,
    envVar: envVarFor(officeKey),
    envRaw: rawEnv === undefined ? null : String(rawEnv),
    envEffect: env === false ? 'disables' : env === true ? 'inert' : null,
    hardcoded: hardcodedFallback === true,
    // The narrower fact: both layers answered and they said different things.
    // Which one is in force is `envEffect`'s job to say.
    disagreesWithEnv: db !== null && env !== null && db !== env,
  };
}

/** Provenance of the stored row, for the console's "who set this" line. */
function settingMeta() {
  return {
    policyKnown: cache.loaded,
    hasRow: Boolean(cache.loaded && cache.byOffice),
    updatedAt: cache.updatedAt,
    updatedBy: cache.updatedBy,
    settingKey: SETTING_KEY,
  };
}

/**
 * Refresh in the background, so a value written straight into the control DB by
 * a runbook reaches the request path without a restart.
 *
 * A console write does NOT depend on this: it refreshes inline and, with
 * `maxReplicas` at 1, is in force for the very next request. This timer is for
 * the other ways the row can change.
 *
 * @returns {boolean} true when a timer was armed by this call
 */
function startRefreshTimer() {
  if (refreshTimer) return false;
  const minutes = refreshMinutes();
  refreshTimer = setInterval(() => {
    refreshFromDb().catch(() => {});
  }, minutes * 60 * 1000);
  // Never the reason a shutdown hangs — the listening socket keeps the process
  // alive, not a settings refresh.
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
 * Drop the cached database view, returning this module to its never-loaded
 * state. FOR TESTS — in the app, forgetting the switch means falling back to
 * the environment and then to a hardcoded `false`, which would turn a live
 * pilot office off.
 * @returns {void}
 */
function resetCacheForTests() {
  cache = { loaded: false, byOffice: null, raw: null, updatedAt: null, updatedBy: null };
  lastLoggedError = null;
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
