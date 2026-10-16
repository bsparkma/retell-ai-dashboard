'use strict';

/**
 * Moving a referral between statuses (queue item 53, R2) — the ONE place it
 * happens, used by the TC routes (submit / withdraw / cancel) and the sign-off
 * routes (approve / decline).
 *
 * In one transaction:
 *   1. read the referral (office-scoped) and the office's policies;
 *   2. ask the shared transition table (contract.referralNextStatus) where the
 *      verb leads from here — null is a 409, never a guess;
 *   3. move it CONDITIONALLY on the status read in 1, so two people acting at
 *      once cannot both win (the loser gets the same 409, naming where it
 *      stands now);
 *   4. write the transition to tc_referral_events (from, to, actor, when, note);
 *   5. write the audit_log row — INSIDE the transaction, so a failed audit
 *      write rolls the transition back. A referral never moves without a
 *      recorded trail.
 * Then the referral is READ BACK and that is what the caller reports.
 *
 * NOTHING SENDS. `approved` is where R2 stops.
 */

const { contract, actorEmail, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./referralStore');

/** The clock, swappable in tests. */
let clock = () => new Date();
function setClockForTests(fn) {
  clock = fn || (() => new Date());
}

/** What the transition table should say to a person, per verb. */
const VERB_WORDS = Object.freeze({
  submit: 'submitted',
  withdraw: 'withdrawn',
  cancel: 'cancelled',
  approve: 'approved',
  decline: 'declined',
});

function refusal(row, verb) {
  const label = contract.TC_REFERRAL_STATUS_LABELS[row.status] || row.status;
  return {
    status: 409,
    body: {
      success: false,
      error: `This referral cannot be ${VERB_WORDS[verb]}: it is ${label.toLowerCase()}.`,
      code: 'REFERRAL_TRANSITION_NOT_ALLOWED',
      currentStatus: row.status,
    },
  };
}

/**
 * Apply `verb` to one referral.
 *
 * @param {import('express').Request} req
 * @param {{ referralId: string, verb: string, note?: string, office?: string }} args
 *        `office` defaults to req.tcOffice (the TC routes); a caller outside
 *        TC (the hygiene visit, a call) passes the office IT derived.
 * @returns {Promise<{ status: number, body: object }>}
 */
async function applyVerb(req, { referralId, verb, note = '', office = req.tcOffice }) {
  const outcome = await withTenantTx(req, (client) => moveInTx(req, client, { office, referralId, verb, note }));
  return answer(req, outcome, { referralId, verb, office });
}

/**
 * Steps 1–5 of the header, INSIDE a caller's transaction, so a producer can
 * create and submit atomically (item 54). Returns { missing } | { refused: row }
 * | { moved: true }; the caller decides what a refusal does to its transaction.
 */
async function moveInTx(req, client, { office, referralId, verb, note = '' }) {
  const actor = actorEmail(req);
  const at = clock().toISOString();
  const row = await store.findReferral(client, office, referralId);
  if (!row) return { missing: true };
  const policies = await store.effectivePolicies(client, office);
  const to = contract.referralNextStatus(row.status, verb, {
    signoffRequired: policies.signoffRequired.value,
  });
  if (!to) return { refused: row };

  const moved = await store.casStatus(client, { office, referralId, from: row.status, to, actor, at });
  if (!moved) {
    const now = await store.findReferral(client, office, referralId);
    return now ? { refused: now } : { missing: true };
  }
  const autoApproved = verb === 'submit' && to === 'approved';
  await store.insertEvent(client, {
    office,
    referralId,
    from: row.status,
    to,
    actor,
    at,
    note: autoApproved ? "Sign-off isn't required for this office" : note,
  });
  // Inside the transaction ON PURPOSE: a failed audit write throws, and the
  // throw rolls the status change and its event back.
  await auditTc(req, 'UPDATE', 'tc_referral', referralId, { office, priorState: row.status });
  return { moved: true };
}

/** A move's outcome as a route answer, the referral read back after commit. */
async function answer(req, outcome, { referralId, verb, office }) {
  if (outcome.missing) {
    return { status: 404, body: { success: false, error: 'Referral not found', code: 'NOT_FOUND' } };
  }
  if (outcome.refused) return refusal(outcome.refused, verb);
  return { status: 200, body: { success: true, referral: await readBack(req, referralId, office) } };
}

/** The referral as stored now, with its practice name and its history. */
async function readBack(req, referralId, office = req.tcOffice) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const row = await store.findReferral(pool, office, referralId);
    if (!row) return null;
    const names = await store.practiceNames(pool, office, [row]);
    const events = await store.listEvents(pool, office, referralId);
    return store.toReferral(row, names.get(String(row.directory_entry_id)) ?? null, events);
  });
}

module.exports = { applyVerb, moveInTx, readBack, setClockForTests, clock: () => clock() };
