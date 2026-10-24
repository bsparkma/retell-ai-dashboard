'use strict';

/**
 * The patient's insurance on file, for a referral letter's "Insurance on
 * file" section — read from THAT office's Open Dental, READ ONLY, at send
 * time. Never from a request, the referral row or a TC case.
 *
 * The reads, all GETs through the office's own client
 * (assertOfficeMatch(office, getOdOffice(office))) — PatNum, InsSubNum and
 * PlanNum numbering all restart in every database:
 *
 *   GET /patplans?PatNum          which plans, and primary vs secondary
 *   per plan (primary, secondary):
 *     GET /inssubs/{InsSubNum}    subscriber ID, and who the subscriber is
 *     GET /insplans/{PlanNum}     group name and number
 *     GET /carriers/{CarrierNum}  carrier name
 *     GET /patients/{Subscriber}  the subscriber's NAME, only when the
 *                                 subscriber is someone other than the patient
 *
 * This is deliberately NOT odReads.getInsuranceSnapshot: that read also pulls
 * benefits and every claim the patient ever had (for the TC money panel). A
 * letter needs none of it.
 *
 * Every outcome is a value, never a throw, so the specialist's send is
 * unaffected:
 *
 *   { status: 'found', plans: [{ ordinal: 1|2, carrier, groupName, groupNum,
 *                                subscriberId, subscriberIdWithheld,
 *                                subscriber: null | { name, relationship } }] }
 *        each text field a value or null ("not on file"); `subscriber` is
 *        null when the patient is their own subscriber
 *   { status: 'none' }            Open Dental has no plan on file for the patient
 *   { status: 'not_connected' }   this office's Open Dental is not connected
 *   { status: 'unreadable' }      any read in the chain failed — fail closed:
 *                                 a half-read plan is never shown as if the
 *                                 missing half were "not on file"
 *
 * NO SSN, EVER. Nothing reads the SSN field: the subscriber's record is
 * plucked for FName and LName only. And because practices have historically
 * keyed a subscriber ID on the subscriber's SSN, an ID shaped like one
 * (nine digits, with or without dashes or spaces) is withheld from the letter
 * (`subscriberIdWithheld`), never printed.
 *
 * PHI: the values are returned to the caller only. No log line here carries
 * them, the PatNum or a name.
 */

const odOffices = require('../../config/odOffices');
const odReads = require('../../routes/tc/odReads');

/** Per-call timeout, the same budget TC's other Open Dental reads use. */
const OD_CALL_TIMEOUT_MS = Number(process.env.TC_OD_CALL_TIMEOUT_MS || 30000);

/** A subscriber ID that could be a Social Security number. */
const SSN_SHAPE = /^\d{3}[-\s]?\d{2}[-\s]?\d{4}$/;

/**
 * patplan.Relationship, in words. The OD API sends the enum NAME; the DB
 * integer (0–8, same order) is accepted too. Anything else is "not on file".
 */
const RELATIONSHIP_WORDS = Object.freeze({
  Self: 'self',
  Spouse: 'spouse',
  Child: 'child',
  Employee: 'employee',
  HandicapDep: 'handicapped dependent',
  SignifOther: 'significant other',
  InjuredPlaint: 'injured plaintiff',
  LifePartner: 'life partner',
  Dependent: 'dependent',
});
const RELATIONSHIP_BY_INT = Object.freeze(Object.values(RELATIONSHIP_WORDS));

/** @param {unknown} v */
function textOrNull(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s ? s : null;
}

/** @param {unknown} v */
function relationshipOf(v) {
  const s = String(v ?? '').trim();
  if (/^\d+$/.test(s)) return RELATIONSHIP_BY_INT[Number(s)] || null;
  return Object.prototype.hasOwnProperty.call(RELATIONSHIP_WORDS, s) ? RELATIONSHIP_WORDS[s] : null;
}

/** A single-record GET's body (OD sometimes wraps one row in an array). */
function one(data) {
  return Array.isArray(data) ? data[0] : data;
}

class Unreadable extends Error {}

/**
 * @param {(path: string, params?: object) => Promise<{ ok: boolean, status: number, data: any }>} get
 * @param {string} path
 */
async function mustGet(get, path) {
  const res = await get(path);
  if (!res.ok) throw new Unreadable(path);
  const row = one(res.data);
  if (!row || typeof row !== 'object') throw new Unreadable(path);
  return row;
}

/**
 * One plan's letter fields.
 * @param {(path: string, params?: object) => Promise<any>} get
 * @param {number} patNum
 * @param {Record<string, unknown>} pp a patplan row
 */
async function planOf(get, patNum, pp) {
  const sub = await mustGet(get, `/inssubs/${Number(pp.InsSubNum)}`);
  let groupName = null;
  let groupNum = null;
  let carrier = null;
  const planNum = Number(sub.PlanNum);
  if (Number.isSafeInteger(planNum) && planNum > 0) {
    const plan = await mustGet(get, `/insplans/${planNum}`);
    groupName = textOrNull(plan.GroupName);
    groupNum = textOrNull(plan.GroupNum);
    const carrierNum = Number(plan.CarrierNum);
    if (Number.isSafeInteger(carrierNum) && carrierNum > 0) {
      carrier = textOrNull((await mustGet(get, `/carriers/${carrierNum}`)).CarrierName);
    }
  }

  const rawId = textOrNull(sub.SubscriberID);
  const subscriberIdWithheld = rawId !== null && SSN_SHAPE.test(rawId);

  const relationship = relationshipOf(pp.Relationship);
  const subscriberNum = Number(sub.Subscriber);
  const known = Number.isSafeInteger(subscriberNum) && subscriberNum > 0;
  let subscriber = null;
  if (known ? subscriberNum !== patNum : relationship !== null && relationship !== 'self') {
    let name = null;
    if (known) {
      const res = await get(`/patients/${subscriberNum}`);
      if (res.ok) {
        const p = one(res.data) || {};
        // Names only. The rest of the record (SSN, birthdate, address) is never read.
        name = textOrNull(`${p.FName ?? ''} ${p.LName ?? ''}`);
      } else if (res.status !== 404) {
        throw new Unreadable('/patients/{subscriber}');
      }
    }
    subscriber = { name, relationship };
  }

  return {
    ordinal: Number(pp.Ordinal),
    carrier,
    groupName,
    groupNum,
    subscriberId: subscriberIdWithheld ? null : rawId,
    subscriberIdWithheld,
    subscriber,
  };
}

/**
 * @param {string} office
 * @param {number} patNum
 * @returns {Promise<{ status: 'found', plans: object[] } | { status: 'none'|'not_connected'|'unreadable' }>}
 */
async function patientInsuranceFor(office, patNum) {
  let od;
  try {
    od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
  } catch {
    return { status: 'not_connected' };
  }
  const get = (path, params = {}) =>
    od.client.apiGetRaw(path, params, { timeoutMs: OD_CALL_TIMEOUT_MS, module: 'tc' });
  try {
    const res = await get('/patplans', { PatNum: patNum });
    if (!res.ok) throw new Unreadable('/patplans');
    // Keep only THIS patient's rows: a list filter Open Dental ignored must
    // never put another patient's plan into this letter.
    const byOrdinal = new Map();
    for (const pp of odReads.asArray(res.data)) {
      const ordinal = Number(pp && pp.Ordinal);
      if (Number(pp.PatNum) !== patNum || (ordinal !== 1 && ordinal !== 2) || byOrdinal.has(ordinal)) continue;
      if (!Number.isSafeInteger(Number(pp.InsSubNum)) || Number(pp.InsSubNum) <= 0) continue;
      byOrdinal.set(ordinal, pp);
    }
    if (byOrdinal.size === 0) return { status: 'none' };
    const plans = [];
    for (const ordinal of [1, 2]) {
      if (byOrdinal.has(ordinal)) plans.push(await planOf(get, patNum, byOrdinal.get(ordinal)));
    }
    return { status: 'found', plans };
  } catch {
    // Unreadable or anything unexpected: an honest "could not read", never a throw.
    console.error(`[tc/referralPatientInsurance] office=${office} Open Dental insurance read failed`);
    return { status: 'unreadable' };
  }
}

module.exports = { patientInsuranceFor, relationshipOf, SSN_SHAPE };
