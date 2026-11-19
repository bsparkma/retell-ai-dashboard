'use strict';

/**
 * The after-Send addendum (hyg-pa-details-addendum).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * BEAU'S RULINGS
 * ═════════════════════════════════════════════════════════════════════════════
 *   - ANYONE on the team: any signed-in user the hygiene module lets write
 *     (hyg.write — admin, office, hygiene). Not only the note's author.
 *   - SAME DAY only: from the moment the visit note is in the chart until the
 *     end of that office-local calendar day. After that the addenda are
 *     read-only forever — no new ones, and none sent.
 *   - ADDITIVE: the original note is never edited. Each addendum is its own
 *     unsigned GroupNote, and the visit record keeps every one, sent or not.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * REVIEW-THEN-SEND, UNCHANGED
 * ═════════════════════════════════════════════════════════════════════════════
 * Adding an addendum writes NOTHING to Open Dental. It composes the preview
 * (stagedWriteComposer.composeAddendum — the visit note's own choke point) and
 * stores it. Only a human pressing "Send addendum", naming the fingerprint of
 * the preview they read, reaches the chart — through the SAME writer the visit
 * note uses (odWriter.readAppointmentProcedures + writeGroupNote: read first so
 * a retry cannot file a second permanent copy, then read back). There is no new
 * Open Dental write path here, and no automatic one anywhere.
 *
 * Fail closed: the ROUTE resolves the office's Open Dental handle exactly as the
 * visit Send does (resolveAppointment → assertOfficeMatch), so an office that is
 * switched off, unkeyed or unreachable refuses before this file runs.
 */

const odWriter = require('./odWriter');
const visitStore = require('./visitStore');
const composer = require('./stagedWriteComposer');
const { localDayKey } = require('../localDayClock');
const { refuseUnlessTestPatient } = require('../../config/hygFixtureGate');

/** The visit note's Written row, or null. */
function writtenNote(visit) {
  const staged = visit && Array.isArray(visit.stagedWrites) ? visit.stagedWrites : [];
  return staged.find((w) => w && w.kind === 'note' && w.state === 'Written' && w.sentAt) || null;
}

/**
 * May an addendum be added or sent right now? PURE: the clock is a parameter.
 *
 * The day is the office-local calendar day the VISIT NOTE WAS SENT ON — the
 * addendum is "after Send", so Send is what opens the window.
 *
 * @param {Record<string, any>|null} visit the contract's HygVisit
 * @param {{ now: Date, timeZone: string }} clock
 * @returns {{ open: boolean, reason: 'note_not_sent'|'day_closed'|null, day: string|null }}
 */
function addendumWindow(visit, { now, timeZone }) {
  const note = writtenNote(visit);
  if (!note) return { open: false, reason: 'note_not_sent', day: null };
  const sent = new Date(note.sentAt);
  if (Number.isNaN(sent.getTime())) return { open: false, reason: 'note_not_sent', day: null };
  const day = localDayKey(timeZone, sent);
  if (localDayKey(timeZone, now) !== day) return { open: false, reason: 'day_closed', day };
  return { open: true, reason: null, day };
}

/** The refusal a closed window answers with, in words. */
function windowRefusal(window) {
  if (window.reason === 'note_not_sent') {
    return {
      status: 409,
      code: 'ADDENDUM_NOTE_NOT_SENT',
      error:
        'There is nothing to add to yet: this visit’s note is not in the chart. Send the visit ' +
        'note first; an addendum follows it.',
    };
  }
  return {
    status: 409,
    code: 'ADDENDUM_WINDOW_CLOSED',
    error:
      `Addenda can only be added on the day the visit note was sent (${window.day}). ` +
      'That day has ended, so this visit’s addenda are read-only.',
  };
}

/**
 * `2026-11-19 14:05 CST` — the office-local time an addendum was entered, for
 * its typed-name line. The zone's short name rides along so the line is not
 * ambiguous when read from another office or another season.
 *
 * @param {string} timeZone @param {Date} now @returns {string}
 */
function officeStamp(timeZone, now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).formatToParts(now);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${localDayKey(timeZone, now)} ${get('hour')}:${get('minute')} ${get('timeZoneName')}`.trim();
}

/** `GroupNote 406901` out of the visit note's writtenRef, or null. */
function noteRefOf(note) {
  const m = note && typeof note.writtenRef === 'string' ? /GroupNote (\d+)/.exec(note.writtenRef) : null;
  return m ? `GroupNote ${m[1]}` : null;
}

/**
 * Add one addendum. Composes, stores, returns it. WRITES NOTHING TO OPEN DENTAL.
 *
 * @returns {Promise<{ ok: true, addendum: object } | { ok: false, status: number, code: string, error: string }>}
 */
async function addAddendum(pool, { office, visit, text, author, now, timeZone }) {
  const window = addendumWindow(visit, { now, timeZone });
  if (!window.open) return { ok: false, ...windowRefusal(window) };
  const { preview } = composer.composeAddendum({
    visitDate: visit.visitDate,
    noteRef: noteRefOf(writtenNote(visit)),
    text,
    author,
    enteredAt: officeStamp(timeZone, now),
  });
  const addendum = await visitStore.addAddendum(pool, {
    office,
    visitId: visit.visitId,
    text,
    author,
    preview,
  });
  return { ok: true, addendum };
}

/**
 * Send one addendum to the chart — the human-approved write.
 *
 * Every refusal below happens BEFORE anything is written, in this order:
 * the test-patient rail, the addendum exists on THIS visit, the window is
 * open, it is sendable (Staged, or Failed and being sent again), and the
 * fingerprint is the stored preview's. Then the row is claimed (Sending,
 * persisted before the call), the note writer runs, and the row lands
 * Written only after the read-back — or Failed with the reason.
 *
 * @returns {Promise<{ ok: true, outcome: { state: string, writtenRef: string|null, errorMessage: string|null, code: string|null } }
 *          | { ok: false, status: number, code: string, error: string }>}
 */
async function sendAddendum({ pool, office, visit, appointment, od, odGet, actor, addendumId, previewFingerprint, now, timeZone }) {
  const gated = refuseUnlessTestPatient({ office, patNum: visit.patNum });
  if (gated) return gated;

  const addendum = await visitStore.getAddendum(pool, { office, visitId: visit.visitId, addendumId });
  if (!addendum) {
    return { ok: false, status: 404, code: 'ADDENDUM_NOT_FOUND', error: 'No such addendum on this visit' };
  }

  const window = addendumWindow(visit, { now, timeZone });
  if (!window.open) return { ok: false, ...windowRefusal(window) };

  if (addendum.state !== 'Staged' && addendum.state !== 'Failed') {
    return {
      ok: false,
      status: 409,
      code: 'ADDENDUM_NOT_SENDABLE',
      error:
        addendum.state === 'Written'
          ? 'This addendum is already in the chart.'
          : 'This addendum is already being sent.',
    };
  }

  // THE PREVIEW IS THE WRITE. The preview is write-once in the database, so a
  // mismatch means the person confirmed something other than this addendum.
  if (addendum.previewFingerprint !== previewFingerprint) {
    return {
      ok: false,
      status: 409,
      code: 'PREVIEW_CHANGED',
      error: 'What you confirmed is not this addendum. Nothing was sent. Read it again and confirm.',
    };
  }

  const claimed = await visitStore.markAddendumSending(pool, { office, visitId: visit.visitId, addendumId });
  if (!claimed) {
    return { ok: false, status: 409, code: 'ADDENDUM_NOT_SENDABLE', error: 'Another send is already handling this addendum.' };
  }

  let result;
  try {
    result = await writeAddendum({ visit, appointment, od, odGet, text: addendum.preview.join('\n') });
  } catch (err) {
    // A throw is a failure like any other: the row must not be left Sending.
    result = { ok: false, code: 'SEND_THREW', error: (err && err.message) || String(err) };
  }

  if (result.ok) {
    await visitStore.markAddendumWritten(pool, {
      office,
      visitId: visit.visitId,
      addendumId,
      actor,
      writtenRef: result.writtenRef,
    });
    return { ok: true, outcome: { state: 'Written', writtenRef: result.writtenRef, errorMessage: null, code: null } };
  }
  await visitStore.markAddendumFailed(pool, { office, visitId: visit.visitId, addendumId, error: result.error });
  return { ok: true, outcome: { state: 'Failed', writtenRef: null, errorMessage: result.error, code: result.code } };
}

/**
 * The visit note's own write, for an addendum: the appointment's procedures,
 * then an unsigned GroupNote across them, read before and read back. Same
 * function, same refusals (no procedures → refused, never invented).
 */
async function writeAddendum({ visit, appointment, od, odGet, text }) {
  const procedures = await odWriter.readAppointmentProcedures(odGet, visit.aptNum);
  if (!procedures.ok) return procedures;
  if (procedures.procNums.length === 0) {
    return {
      ok: false,
      code: 'NO_PROCEDURES',
      error:
        'This appointment has no procedures in Open Dental, so there is nothing for an addendum ' +
        'to attach to. Add the procedures in Open Dental and send it again.',
    };
  }
  const written = await odWriter.writeGroupNote(od, odGet, {
    patNum: visit.patNum,
    procNums: procedures.procNums,
    note: text,
    provNum: appointment.provHyg ?? appointment.provNum ?? null,
  });
  if (!written.ok) return written;
  const head = written.groupProcNum ? `GroupNote ${written.groupProcNum}` : 'GroupNote';
  return {
    ok: true,
    writtenRef: written.alreadyPresent ? `${head} (addendum) — already on the chart` : `${head} (addendum)`,
  };
}

module.exports = {
  addendumWindow,
  windowRefusal,
  officeStamp,
  noteRefOf,
  addAddendum,
  sendAddendum,
};
