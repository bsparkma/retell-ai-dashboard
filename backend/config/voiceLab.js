'use strict';

/**
 * The voice lab's on/off switch: staging only, impossible in production.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THE LAB IS
 * ═════════════════════════════════════════════════════════════════════════════
 * A measurement page (queue item 34). Someone in an operatory says digit words
 * into the browser; the browser streams them straight to Azure Speech with a
 * short-lived token this backend mints. The backend never sees audio or text.
 * No patient, no Open Dental, no model.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO CONDITIONS, BOTH REQUIRED
 * ═════════════════════════════════════════════════════════════════════════════
 *   1. `VOICE_LAB` is exactly the string '1'. Anything else ('true', 'on', a
 *      typo) is OFF.
 *   2. The process is NOT production. Setting the flag on prod does nothing.
 *
 * HOW PRODUCTION IS RECOGNISED. NODE_ENV cannot do it alone, because staging
 * runs with NODE_ENV=production too (that is how it loads Key Vault — see
 * docs/PHASE3_STEP2_STAGING_NOTES.md). What differs is the Key Vault the
 * container reads: `kv-carein-staging` vs `kv-carein-prod`
 * (docs/ARCHITECTURE.md). That is the marker `config/hygFixtureGate.js`
 * `isStaging()` already uses, and it is reused here rather than copied.
 *
 * Production is assumed — the lab refuses — when EITHER:
 *   - the vault name contains 'prod', or
 *   - NODE_ENV is 'production' and the vault is not positively a staging vault
 *     (that includes a production process with no vault name set at all).
 *
 * A developer box (NODE_ENV unset/development, no vault) may run the lab with
 * the flag; it has no Key Vault and so no speech key unless one is set locally.
 */

const { isStaging } = require('./hygFixtureGate');

const FLAG_ENV = 'VOICE_LAB';

/**
 * Is this process production, by either marker? Errs towards YES.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isProductionEnvironment(env = process.env) {
  const vault = String(env.AZURE_KEY_VAULT_NAME || '').trim().toLowerCase();
  if (vault.includes('prod')) return true;
  if (String(env.NODE_ENV || '').trim() === 'production' && !isStaging(env)) return true;
  return false;
}

/**
 * Resolve the switch, with the reason, so the boot log can say WHY it is off.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ enabled: boolean, reason: 'enabled' | 'flag_off' | 'production' }}
 */
function resolveVoiceLab(env = process.env) {
  if (env[FLAG_ENV] !== '1') return { enabled: false, reason: 'flag_off' };
  if (isProductionEnvironment(env)) return { enabled: false, reason: 'production' };
  return { enabled: true, reason: 'enabled' };
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isVoiceLabEnabled(env = process.env) {
  return resolveVoiceLab(env).enabled;
}

module.exports = {
  FLAG_ENV,
  isProductionEnvironment,
  resolveVoiceLab,
  isVoiceLabEnabled,
};
