'use strict';

/**
 * Creating a referral (queue items 53 + 54) — the ONE producer, used by:
 *   - TC:      POST /api/tc/referrals             (from a case or a checkout)
 *   - Hygiene: POST /api/hyg/visit/:aptNum/referral  (R3, chairside)
 *   - Voice:   POST /api/unified-calls/:id/referral  (R3, from a call)
 *
 * The CALLER derives the patient — office + PatNum + name — from its own
 * stored record (a case, a checkout, a hygiene visit, a call), never from a
 * request, and hands it here. This module then, in ONE transaction:
 *   1. checks the directory entry is this office's and active;
 *   2. inserts the draft;
 *   3. writes its creating event (null → draft);
 *   4. writes the audit row (a failed audit rolls the referral back).
 * `startReferral` adds the optional submit (the transition engine, its own
 * transaction) and answers with the referral as stored.
 *
 * Gating every caller must have passed first: the practice is entitled to
 * `tc`, and referrals is switched on for THIS office. `referralsGate` checks
 * both, for the non-TC callers whose mount does not.
 *
 * NOTHING SENDS.
 */

const { auditTc, actorEmail } = require('./helpers');
const { withTenantTx } = require('./tx');
const { isEntitledModule } = require('../../middleware/tenantContext');
const tcReferrals = require('../../config/tcReferrals');
const store = require('./referralStore');
const transitions = require('./referralTransitions');

/**
 * Entitled to TC, and referrals on for `office`? null when fine, else the
 * refusal as [status, body].
 */
async function referralsGate(req, office) {
  if (!isEntitledModule(req, 'tc')) {
    return [
      403,
      {
        success: false,
        error: 'MODULE_NOT_ENTITLED',
        code: 'MODULE_NOT_ENTITLED',
        module: 'tc',
        message: "This account is not entitled to the 'tc' module.",
      },
    ];
  }
  if (!(await tcReferrals.isEnabled(office))) {
    return [
      403,
      { success: false, error: 'Referrals are not switched on for this office.', code: 'REFERRALS_DISABLED' },
    ];
  }
  return null;
}

/**
 * The directory entry a referral names must be this office's, and active.
 * null when fine, else [status, message, code].
 */
async function directoryProblem(q, office, entryId) {
  if (!entryId) return null;
  const entry = await store.findEntry(q, office, entryId);
  if (!entry) return [404, "That specialist is not in this office's directory", 'DIRECTORY_ENTRY_NOT_FOUND'];
  if (!entry.active) return [409, 'That specialist is marked inactive', 'DIRECTORY_ENTRY_INACTIVE'];
  return null;
}

/**
 * Inside a transaction: the draft, its event, its audit row.
 *
 * @param {import('express').Request} req
 * @param {object} client  a transaction client
 * @param {{ office: string, patient: { odPatientId: number, patientName: string, tcCaseId: string|null,
 *           sourceKind: string, sourceRef: string }, input: object, at: string }} args
 * @returns {Promise<{ referralId: string } | { refusal: [number, string, string] }>}
 */
async function createDraft(req, client, { office, patient, input, at }) {
  const actor = actorEmail(req);
  const problem = await directoryProblem(client, office, input.directoryEntryId);
  if (problem) return { refusal: problem };
  const row = await store.insertReferral(client, { office, ...patient, input, actor, at });
  if (!row) throw new Error('referral was not stored');
  const referralId = String(row.referral_id);
  await store.insertEvent(client, { office, referralId, from: null, to: 'draft', actor, at, note: '' });
  // In the transaction: no referral exists without its audit row.
  await auditTc(req, 'CREATE', 'tc_referral', referralId, { office, sourceRef: `${patient.sourceKind}:${patient.sourceRef}` });
  return { referralId };
}

/**
 * Create (and optionally submit) a referral for a caller outside TC.
 * Answers like a route: { status, body }.
 */
async function startReferral(req, { office, patient, input, submit }) {
  const at = transitions.clock().toISOString();
  const created = await withTenantTx(req, (client) => createDraft(req, client, { office, patient, input, at }));
  if (created.refusal) {
    const [status, error, code] = created.refusal;
    return { status, body: { success: false, error, code } };
  }
  if (submit) {
    const moved = await transitions.applyVerb(req, { referralId: created.referralId, verb: 'submit', office });
    if (moved.status !== 200) return moved;
    return { status: 201, body: moved.body };
  }
  return { status: 201, body: { success: true, referral: await transitions.readBack(req, created.referralId, office) } };
}

module.exports = { referralsGate, directoryProblem, createDraft, startReferral };
