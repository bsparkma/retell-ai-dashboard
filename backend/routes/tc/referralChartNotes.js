'use strict';

/**
 * R6.10 — chart notes: a referral milestone written to the patient's Open
 * Dental chart as a commlog, ONLY by a person (tc.full) who has seen the exact
 * text.
 *
 *   POST /api/tc/referrals/:id/chart-notes
 *        { milestone: sent|received|scheduled|seen|declined|closed, note }
 *        strict; note ≤ 2000 and already OD-safe
 *
 * NOTHING WRITES ON ITS OWN. This module is reached from exactly one place, the
 * route above, which a person's click calls. No milestone, timer, event, link
 * or approval calls it, and routes/tc/tcReferralChartNotes.test.js fails the
 * build if anything else requires it (or the Open Dental half it drives).
 *
 * WHAT THE CLIENT SAYS, AND WHAT IT CANNOT. The body is the milestone and the
 * approved words — nothing else (any other field is a 400). The PatNum comes
 * from the referral row, the office from the request's server-derived office
 * (and the row is read in that office only), the commlog type from THAT
 * office's configuration (config/odOffices: roland 491, valley 452 — never
 * crossed, never a fallback), and the commlog's date from the moment it is
 * written, as the office's wall clock (not the milestone's date).
 *
 * WHAT A PERSON APPROVES IS WHAT IS WRITTEN. The note must already be what
 * Open Dental will store (contract.referralChartNoteOdSafe, a pinned mirror of
 * the writer's own sanitizer); a note the sanitizer would still change is a
 * 400, because the person would not have seen the text that lands.
 *
 * In order — the first refusal stops everything, and nothing before step 5
 * touches a chart:
 *   1. the environment's write switch (OPENDENTAL_WRITE_DISABLED) → 403;
 *   2. the office's Open Dental readiness and its configured "Referral" type
 *      → its named refusal (409/503);
 *   3. the text is OD-safe → else 400;
 *   4. in one tenant transaction, holding the referral's row lock across the
 *      Open Dental call (so two clicks cannot both write): read it in this
 *      office; the milestone must be REACHED and not already WRITTEN (from the
 *      history, the same pure function the client draws from); the configured
 *      type must be in THIS office's own commlog-type list;
 *   5. the Open Dental half (services/tc/referralChartNote.js): an identical
 *      note already on the chart refuses; the voice module's writer creates the
 *      commlog; it is READ BACK and must match before anything is claimed;
 *   6. THEN the `chart_note_written` history row (milestone, CommlogNum, type,
 *      the exact text) and the audit row (CREATE commlog), in that transaction.
 *
 * A failure at 5 writes no history row and claims nothing; it is audited as a
 * failed attempt and answered with its own named code. A write that landed but
 * could not be recorded at 6 says so (500 CHART_NOTE_WRITTEN_UNRECORDED, with
 * the CommlogNum) — and a retry is then refused at 5, because the note is
 * already on the chart.
 */

const { contract, actorEmail, auditTc } = require('./helpers');
const { audit } = require('../../platform/audit');
const { withTenantTx } = require('./tx');
const store = require('./referralStore');
const transitions = require('./referralTransitions');
const odOffices = require('../../config/odOffices');
const commlogTypes = require('../../services/commlogTypes');
const { isOdWriteDisabled } = require('../../middleware/envGuards');
const chartNote = require('../../services/tc/referralChartNote');

/** The Open Dental half's failure codes → HTTP status. */
const WRITE_FAILURE_STATUS = Object.freeze({
  CHART_NOTE_API_MODE_ONLY: 409,
  CHART_NOTE_ALREADY_IN_CHART: 409,
  CHART_NOTE_UNVERIFIABLE: 502,
  CHART_NOTE_WRITE_FAILED: 502,
  CHART_NOTE_UNCONFIRMED: 502,
});

/** The Open Dental write landed; recording it did not. Carries the CommlogNum out of the rolled-back transaction. */
class WrittenUnrecordedError extends Error {
  constructor(commLogNum, cause) {
    super(`chart note ${commLogNum} written but not recorded: ${cause && cause.message}`);
    this.commLogNum = commLogNum;
  }
}

const refuse = (status, code, error, extra = {}) => ({ status, body: { success: false, error, code, ...extra } });

/**
 * A failed chart write is still a chart write somebody asked for — recorded
 * like the voice path records its refused ones, so the trail shows the attempt.
 */
async function auditAttempt(req, office, referralId, result) {
  await audit(req, {
    action: 'CREATE',
    resourceType: 'commlog',
    resourceId: referralId,
    office,
    sourceRef: 'referral_chart_note',
    result,
  });
}

/**
 * Write one milestone's approved note to the referral's patient's chart.
 * @param {import('express').Request} req
 * @param {{ referralId: string, body: { milestone: string, note: string }, office?: string }} args
 * @returns {Promise<{ status: number, body: object }>}
 */
async function writeChartNote(req, { referralId, body, office = req.tcOffice }) {
  // 1. The environment's switch. A dev box shares the practices' credentials.
  if (isOdWriteDisabled()) {
    return refuse(403, 'OD_WRITE_DISABLED', 'Open Dental writes are switched off in this environment');
  }

  // 2. Can this office's charts take a referral note at all?
  const blocked = odOffices.referralChartNoteBlockReason(office);
  if (blocked) {
    const status = blocked.code === 'REFERRAL_COMMTYPE_NOT_CONFIGURED' ? 409 : odOffices.httpStatusFor({ code: blocked.code });
    return refuse(status, blocked.code, blocked.message);
  }

  // 3. The person must have seen the text that lands.
  if (contract.referralChartNoteOdSafe(body.note) !== body.note) {
    return refuse(
      400,
      'CHART_NOTE_NOT_OD_SAFE',
      'The note has characters Open Dental would change (curly quotes, long dashes). Review the text shown and write it again.'
    );
  }

  let outcome;
  try {
    outcome = await withTenantTx(req, async (client) => {
      // 4. The lock first, held across the Open Dental call below.
      await client.query('UPDATE tc_referrals SET updated_at = now() WHERE office_id = $1 AND referral_id = $2', [office, referralId]);
      const row = await store.findReferral(client, office, referralId);
      if (!row) return { missing: true };

      const events = await store.listEvents(client, office, referralId);
      const state = contract.referralChartMilestones(events).find((m) => m.milestone === body.milestone);
      if (!state) return { notReached: true, status: row.status };
      if (state.written) return { alreadyWritten: state.written };

      const od = odOffices.assertOfficeMatch(office, odOffices.getOdOffice(office));
      const commType = await commlogTypes.assertAllowed(od, od.referralCommTypeDefNum);

      // 5. The chart write, read back. Dated NOW — when a person wrote it —
      // not at the milestone: a note written today for a referral sent last
      // week filed itself under last week in the chart, where nobody looks
      // for today's work. The milestone's own date stays in the history.
      const writtenAt = transitions.clock().toISOString();
      const written = await chartNote.writeChartNote(od, {
        patNum: Number(row.od_patient_id),
        note: body.note,
        commType,
        at: writtenAt,
      });
      if (!written.ok) return { failed: written };

      // 6. Recorded only now. Anything that fails here rolls the row back, but
      // the note IS on the chart — carried out so the answer says so.
      try {
        await store.insertChartNoteEvent(client, {
          office,
          referralId,
          status: row.status,
          actor: actorEmail(req),
          at: writtenAt,
          note: body.note,
          milestone: body.milestone,
          commLogNum: written.commLogNum,
          commType,
        });
        await auditTc(req, 'CREATE', 'commlog', String(written.commLogNum), {
          office,
          priorState: row.status,
          sourceRef: 'referral_chart_note',
        });
      } catch (err) {
        throw new WrittenUnrecordedError(written.commLogNum, err);
      }
      return { written: written.commLogNum };
    });
  } catch (err) {
    if (err instanceof WrittenUnrecordedError) {
      console.error(`[referralChartNotes] ${office}: ${err.message}`);
      return refuse(
        500,
        'CHART_NOTE_WRITTEN_UNRECORDED',
        `The note was written to the chart (Open Dental note ${err.commLogNum}) but could not be recorded here. Do not write it again.`,
        { commLogNum: err.commLogNum }
      );
    }
    if (err instanceof commlogTypes.CommlogTypeError) {
      await auditAttempt(req, office, referralId, err.code === 'COMMLOG_TYPE_UNVERIFIABLE' ? 'ERROR' : 'UNAUTHORIZED');
      return err.code === 'COMMLOG_TYPE_UNVERIFIABLE'
        ? refuse(503, err.code, err.publicMessage)
        : refuse(
            409,
            'REFERRAL_COMMTYPE_INVALID',
            'The "Referral" chart note type configured for this office is not one of its Open Dental commlog types, so nothing was written.'
          );
    }
    if (err instanceof odOffices.OdOfficeError) {
      return refuse(odOffices.httpStatusFor(err), err.code, err.publicMessage);
    }
    throw err;
  }

  if (outcome.missing) return refuse(404, 'NOT_FOUND', 'Referral not found');
  if (outcome.notReached) {
    return refuse(409, 'CHART_NOTE_MILESTONE_NOT_REACHED', 'This referral has not reached that milestone, so there is nothing to note.', {
      currentStatus: outcome.status,
    });
  }
  if (outcome.alreadyWritten) {
    return refuse(409, 'CHART_NOTE_ALREADY_WRITTEN', 'A chart note for this milestone was already written.', {
      writtenAt: outcome.alreadyWritten.at,
      writtenBy: outcome.alreadyWritten.actor,
      commLogNum: outcome.alreadyWritten.commLogNum,
    });
  }
  if (outcome.failed) {
    await auditAttempt(req, office, referralId, 'ERROR');
    const f = outcome.failed;
    return refuse(WRITE_FAILURE_STATUS[f.code] || 502, f.code, f.error, {
      ...(f.commLogNum !== undefined ? { commLogNum: f.commLogNum } : {}),
    });
  }
  return {
    status: 201,
    body: {
      success: true,
      milestone: body.milestone,
      commLogNum: outcome.written,
      referral: await transitions.readBack(req, referralId, office),
    },
  };
}

module.exports = { writeChartNote };
