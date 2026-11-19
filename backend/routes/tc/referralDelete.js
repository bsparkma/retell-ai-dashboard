'use strict';

/**
 * Deleting a referral (referral-manual-moves) — ONLY a draft that never
 * reached outside the app. Everything else is cancelled, never deleted: the
 * route refuses (409) whatever the UI did or did not offer.
 *
 * In one transaction:
 *   1. lock the referral row (office-scoped; FOR UPDATE, so a submit, a send's
 *      claim or an upload's FK check waits behind this);
 *   2. apply the shared rule (contract.referralDeleteBlocker): the status is
 *      draft AND no history verb in REFERRAL_DELETE_BLOCKING_EVENT_VERBS — a
 *      send attempted, a "sent", a link click, a patient email, a logged
 *      contact, a chart note. An approve in the history does not block;
 *   3. refuse a live email claim (a stale one is no claim);
 *   4. read the attachments' storage keys, then delete the row CONDITIONAL on
 *      it still being an unclaimed draft — its events, attachment rows and
 *      link tokens go with it;
 *   5. write the audit row (DELETE, prior state `draft`, the actor) INSIDE
 *      the transaction: a failed audit write rolls the delete back.
 *
 * AFTER the commit, the attachment files are deleted from storage. Storage is
 * not transactional, and the upload path's rule holds here too: a file left
 * behind with no row (findable, served by nothing) is acceptable; a row
 * pointing at a file that is gone is not. A file storage did not confirm
 * removing is counted (filesLeft) and logged by count and referral id only.
 *
 * Writes nothing to Open Dental and sends nothing.
 */

const { contract, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const store = require('./referralStore');
const blob = require('../../services/tc/referralAttachmentStore');
const transitions = require('./referralTransitions');

/** The refusal, in words a person can act on. */
function refusal(code, row) {
  const label = (contract.TC_REFERRAL_STATUS_LABELS[row.status] || row.status).toLowerCase();
  const error =
    code === 'REFERRAL_DELETE_HAS_HISTORY'
      ? 'This draft was sent, emailed, logged or charted before, so it is kept. Cancel it instead.'
      : code === 'REFERRAL_SEND_IN_PROGRESS'
        ? 'An email for this referral is going out right now. Refresh in a moment.'
        : `Only a draft can be deleted: this referral is ${label}. Cancel it instead.`;
  return { status: 409, body: { success: false, error, code, currentStatus: row.status } };
}

/**
 * @param {import('express').Request} req
 * @param {{ referralId: string, office?: string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function deleteDraft(req, { referralId, office = req.tcOffice }) {
  const outcome = await withTenantTx(req, async (client) => {
    const claim = await store.lockSendClaim(client, office, referralId);
    if (!claim) return { missing: true };
    const blocker = contract.referralDeleteBlocker(claim.status, await store.eventVerbs(client, office, referralId));
    if (blocker === 'not_draft') return { refused: 'REFERRAL_DELETE_NOT_DRAFT', row: claim };
    if (blocker === 'has_history') return { refused: 'REFERRAL_DELETE_HAS_HISTORY', row: claim };
    const now = transitions.clock();
    if (store.sendClaimIsLive(claim, now)) return { refused: 'REFERRAL_SEND_IN_PROGRESS', row: claim };
    if (claim.send_attempt_id != null) {
      await store.releaseStaleSendClaim(client, { office, referralId, staleBefore: store.sendClaimStaleBefore(now) });
    }

    const keys = await store.attachmentBlobKeys(client, office, referralId);
    if (!(await store.deleteDraftReferral(client, office, referralId))) {
      // Unreachable under the row lock; answered honestly all the same.
      return { refused: 'REFERRAL_DELETE_NOT_DRAFT', row: claim };
    }
    // Inside the transaction ON PURPOSE: a failed audit write rolls the delete back.
    await auditTc(req, 'DELETE', 'tc_referral', referralId, { office, priorState: 'draft' });
    return { deleted: true, keys };
  });

  if (outcome.missing) {
    return { status: 404, body: { success: false, error: 'Referral not found', code: 'NOT_FOUND' } };
  }
  if (outcome.refused) return refusal(outcome.refused, outcome.row);

  let filesRemoved = 0;
  let filesLeft = 0;
  for (const key of outcome.keys) {
    try {
      if (await blob.deleteAttachment(key)) filesRemoved += 1;
      else filesLeft += 1;
    } catch {
      filesLeft += 1;
    }
  }
  if (filesLeft > 0) {
    console.warn(`[referralDelete] draft ${referralId} deleted; ${filesLeft} attachment file(s) left in storage`);
  }
  return { status: 200, body: { success: true, referralId, filesRemoved, filesLeft } };
}

module.exports = { deleteDraft };
