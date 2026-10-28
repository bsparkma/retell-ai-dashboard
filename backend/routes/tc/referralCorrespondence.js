'use strict';

/**
 * R6.9 — the correspondence log: staff (tc.full) recording a contact with the
 * specialist's office or the patient that happened OUTSIDE the app — a call,
 * an email, a fax.
 *
 *   POST /api/tc/referrals/:id/correspondence
 *        { direction: to|from, party: specialist|patient,
 *          channel: phone|email|fax|other, note }        strict; note ≤ 2000
 *
 * It is a HISTORY ROW, NOT A MOVE. The status stays where it is (from = to,
 * pinned by the database); the transition table is not consulted and nothing
 * here can change a status. It sends, faxes, calls and triggers nothing, and
 * reads and writes no Open Dental.
 *
 * In one transaction, like every other referral action:
 *   1. row-lock the referral (an UPDATE takes the lock, as R4's upload does),
 *      so a submit, withdraw or cancel cannot slip between the status read and
 *      the write — the row records the status it really had;
 *   2. read it, office-scoped; refuse a draft (409): nothing has gone anywhere,
 *      so there is no one to have corresponded with about it;
 *   3. write the `correspondence` event (direction, party, channel, note);
 *   4. write the audit_log row — INSIDE the transaction, so a failed audit
 *      write rolls the event back.
 * Then the referral is READ BACK (with its history) and that is the answer.
 *
 * A file that goes with the contact is NOT taken here: the client uploads it
 * through R4's existing route (./referralAttachments.js, unchanged), with its
 * own checks, its status rule and its cap of 5.
 */

const { contract, actorEmail, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const store = require('./referralStore');
const transitions = require('./referralTransitions');

/**
 * Log one contact on one referral, in the office the request was scoped to.
 * @param {import('express').Request} req
 * @param {{ referralId: string, body: { direction: string, party: string, channel: string, note: string }, office?: string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function logCorrespondence(req, { referralId, body, office = req.tcOffice }) {
  const outcome = await withTenantTx(req, async (client) => {
    // The lock first; it also bumps updated_at, as an upload does.
    await client.query('UPDATE tc_referrals SET updated_at = now() WHERE office_id = $1 AND referral_id = $2', [office, referralId]);
    const row = await store.findReferral(client, office, referralId);
    if (!row) return { missing: true };
    if (!contract.referralCanLogCorrespondence(row.status)) return { refused: row };
    await store.insertCorrespondenceEvent(client, {
      office,
      referralId,
      status: row.status,
      actor: actorEmail(req),
      at: transitions.clock().toISOString(),
      note: body.note,
      direction: body.direction,
      party: body.party,
      channel: body.channel,
    });
    // In the transaction: a failed audit write rolls the event back.
    await auditTc(req, 'UPDATE', 'tc_referral', referralId, {
      office,
      priorState: row.status,
      sourceRef: 'referral_correspondence',
    });
    return { logged: true };
  });

  if (outcome.missing) {
    return { status: 404, body: { success: false, error: 'Referral not found', code: 'NOT_FOUND' } };
  }
  if (outcome.refused) {
    return {
      status: 409,
      body: {
        success: false,
        error: 'A draft has not gone anywhere yet, so there is no correspondence to log. Submit it first.',
        code: 'REFERRAL_CORRESPONDENCE_NOT_ALLOWED',
        currentStatus: outcome.refused.status,
      },
    };
  }
  return { status: 201, body: { success: true, referral: await transitions.readBack(req, referralId, office) } };
}

module.exports = { logCorrespondence };
