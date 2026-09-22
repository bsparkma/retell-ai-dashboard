'use strict';

/**
 * THE designated test patients — the one list, office-keyed.
 *
 * Staging talks to the LIVE Open Dental databases. The only charts anything on
 * staging may write to are these, and until item 20 that rule lived only in
 * people and in prompts: four probe scripts each carried a private copy of this
 * list, and the app itself carried none. This file is the single copy. The probe
 * scripts and the hygiene write gate (config/hygFixtureGate.js) both read it, and
 * backend/test/testPatients.test.js fails if a second copy appears.
 *
 * A PatNum means nothing without its office — numbering restarts in every Open
 * Dental database, and PatNum 7115 in Roland is a different, real person from
 * the valley fixture. So membership is always asked as (office, PatNum), never
 * as a bare number.
 *
 *   roland 12827  "Test 2, Stedi"     resolve/preview fixture
 *   roland 12828  "Test, MangoTest"   TC test patient + Mango staging seed
 *   valley 7115   "Stedi TestValley"  the valley fixture
 *
 * 11373 was REJECTED as a fixture (a shared family phone) and must never be
 * added here.
 *
 * This file requires nothing, on purpose: the probe scripts load it before they
 * decide whether to load secrets at all.
 */

const DESIGNATED_TEST_PATIENTS = Object.freeze({
  roland: Object.freeze([12827, 12828]),
  valley: Object.freeze([7115]),
});

/**
 * Is (office, patNum) one of the designated test patients?
 *
 * @param {string} office
 * @param {number|string} patNum
 * @returns {boolean}
 */
function isDesignatedTestPatient(office, patNum) {
  const n = typeof patNum === 'string' && /^\d+$/.test(patNum.trim()) ? Number(patNum.trim()) : patNum;
  if (!Number.isSafeInteger(n)) return false;
  const list = Object.prototype.hasOwnProperty.call(DESIGNATED_TEST_PATIENTS, office)
    ? DESIGNATED_TEST_PATIENTS[office]
    : null;
  return Boolean(list) && list.includes(n);
}

/** "roland 12827, 12828; valley 7115" — for refusal messages and script usage. */
function describeTestPatients() {
  return Object.entries(DESIGNATED_TEST_PATIENTS)
    .map(([office, pats]) => `${office} ${pats.join(', ')}`)
    .join('; ');
}

module.exports = { DESIGNATED_TEST_PATIENTS, isDesignatedTestPatient, describeTestPatients };
