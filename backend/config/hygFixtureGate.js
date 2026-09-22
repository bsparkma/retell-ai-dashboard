'use strict';

/**
 * Staging refuses every hygiene Open Dental write for anyone but the test patients.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY — AN INCIDENT, NOT A HYPOTHETICAL
 * ═════════════════════════════════════════════════════════════════════════════
 * On 2026-09-21 a staging visit send put a routing-slip PDF into a real
 * patient's chart. Staging's office keys open the LIVE Open Dental databases,
 * and "designated test patients only" was a rule people kept, not one the app
 * enforced. This is the rail.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE SWITCH, READ AT RUN TIME
 * ═════════════════════════════════════════════════════════════════════════════
 *
 *     HYG_OD_WRITES_FIXTURES_ONLY=off   → gate OFF (today's behaviour exactly)
 *     HYG_OD_WRITES_FIXTURES_ONLY=on    → gate ON
 *     HYG_OD_WRITES_FIXTURES_ONLY=<anything else, including empty>
 *                                       → gate ON, and said once in the log
 *     unset, and the process is staging → gate ON
 *     unset, anywhere else              → gate OFF (prod, dev boxes, tests)
 *
 * **An unrecognised value is ON.** `MANGO_INGEST_MODE` resolves every typo to
 * `off` silently; for a rail whose whole job is refusing, that is backwards. A
 * person who set this variable wanted a rail, and a typo must not remove it.
 * `on`/`off` are matched ignoring case and surrounding spaces; `true`, `false`,
 * `1`, `0`, `yes` are NOT recognised and so mean ON.
 *
 * **How staging knows it is staging.** Staging runs `NODE_ENV=production` too
 * (that is what turns on Key Vault loading), so NODE_ENV cannot tell the two
 * apart. The marker the platform already carries is the Key Vault the process
 * loads its secrets from: `AZURE_KEY_VAULT_NAME` is `kv-carein-staging` on
 * staging and `kv-carein-prod` on prod (both read off the container apps on
 * 2026-09-21). services/rcm/postingDrain.js reads the same variable for the same
 * reason. The staging default here is POSITIVE identification — the vault name
 * must say `staging` — so prod, which must keep writing to real patients, can
 * only be gated by someone setting the variable on purpose.
 *
 * Read on every call, never cached at boot (the kill-switch doctrine in
 * config/hygPilot.js). On Azure Container Apps an env change rolls a new
 * revision anyway; reading per call means nothing in this code can hold on to
 * the old answer, and tests can flip it without re-requiring modules.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE IT BITES
 * ═════════════════════════════════════════════════════════════════════════════
 * Every hygiene entry point that can lead to an Open Dental write, at the
 * SERVICE, so a future route that calls the service cannot forget it:
 *
 *   services/hyg/sendVisit.js   sendVisit             note, slip, TC handoff, perio
 *   services/hyg/perioSend.js   startPerioSend        the chart page's Send
 *                               stepPerioSend         every step after the first
 *                               deletePerioExamForSend
 *                               beginAmendment
 *                               removeReplacedExam
 *   routes/hyg/visit.js         staged-writes/:kind/retry   (writes nothing to Open
 *                               Dental itself; refused so a non-test patient's
 *                               failed write cannot be re-armed either)
 *
 * The gate keys on (office, PatNum). The office is `req.hygOffice`, derived
 * server-side; the PatNum is the stored visit's, which every write route has
 * already checked against Open Dental's own appointment.
 *
 * The hyg module only. Voice commlogs and RCM posting are other modules; the
 * same rail there is a platform decision, not built here.
 */

const { isDesignatedTestPatient, describeTestPatients } = require('./testPatients');

const SWITCH_ENV = 'HYG_OD_WRITES_FIXTURES_ONLY';
const REFUSAL_CODE = 'HYG_TEST_PATIENTS_ONLY';

/** Unrecognised values already reported, so a bad value is said once, not per request. */
const warned = new Set();

/** Test seam: the once-per-value warning is process-wide. */
function _resetWarningsForTests() {
  warned.clear();
}

/**
 * Is this process staging, by its Key Vault? Positive identification only.
 *
 * @param {NodeJS.ProcessEnv} env
 */
function isStaging(env) {
  const vault = String(env.AZURE_KEY_VAULT_NAME || '').trim().toLowerCase();
  return vault.includes('staging');
}

/**
 * Resolve the switch. Returned with its reason so a refusal and a report can
 * both say WHY the gate is on.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ on: boolean, source: 'env' | 'env-unrecognized' | 'staging-default' | 'default-off', raw: string | null }}
 */
function resolveFixturesOnly(env = process.env) {
  if (Object.prototype.hasOwnProperty.call(env, SWITCH_ENV) && env[SWITCH_ENV] !== undefined) {
    const raw = String(env[SWITCH_ENV]);
    const value = raw.trim().toLowerCase();
    if (value === 'on') return { on: true, source: 'env', raw };
    if (value === 'off') return { on: false, source: 'env', raw };
    if (!warned.has(raw)) {
      warned.add(raw);
      console.warn(
        `[hyg] ${SWITCH_ENV}=${JSON.stringify(raw)} is not "on" or "off" — treating it as ON ` +
          '(hygiene Open Dental writes are limited to the designated test patients).'
      );
    }
    return { on: true, source: 'env-unrecognized', raw };
  }
  if (isStaging(env)) return { on: true, source: 'staging-default', raw: null };
  return { on: false, source: 'default-off', raw: null };
}

/**
 * The gate. `null` means go ahead; otherwise the refusal every entry point
 * returns as-is — the same `{ ok, status, code, error }` shape the services
 * already use, so the routes need no new branch to say it.
 *
 * @param {{ office: string, patNum: number, env?: NodeJS.ProcessEnv }} args
 * @returns {null | { ok: false, status: 422, code: string, error: string }}
 */
function refuseUnlessTestPatient({ office, patNum, env = process.env }) {
  if (!resolveFixturesOnly(env).on) return null;
  if (isDesignatedTestPatient(office, patNum)) return null;
  return {
    ok: false,
    status: 422,
    code: REFUSAL_CODE,
    error:
      'This environment only writes to the designated test patients ' +
      `(${describeTestPatients()}), and this patient is not one of them. ` +
      'Nothing was sent to Open Dental.',
  };
}

module.exports = {
  SWITCH_ENV,
  REFUSAL_CODE,
  resolveFixturesOnly,
  refuseUnlessTestPatient,
  isStaging,
  _resetWarningsForTests,
};
