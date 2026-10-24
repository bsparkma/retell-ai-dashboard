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
 * NOTHING HERE SENDS. `approved` is where R2 stops. R6 (item 56) adds `reopen`,
 * `return` and four MANUAL marks (mark_sent, mark_acknowledged,
 * mark_patient_seen, close) — a person's attestation of something that
 * happened outside the app. They move a status and write a history line;
 * they email, fax and trigger nothing. R5's `send` (approved → sent) is the
 * other way into sent: it is performed only by ./referralSend.js, after ACS
 * accepted the email, never through applyVerb.
 *
 * R6 also adds FIELD EDITS (editFieldsInTx): the same five steps, except the
 * status does not move — the UPDATE is conditional on the status read in
 * step 1, so an edit cannot race a transition — and the event row records
 * from = to with verb `edit` (staff) or `doctor_edit` (at sign-off).
 */

const { contract, actorEmail, auditTc } = require('./helpers');
const { withTenantTx } = require('./tx');
const tenantDb = require('../../platform/tenantDb');
const store = require('./referralStore');

/** referralCreate requires this module, so its directory check is resolved at call time. */
const directoryProblem = (...args) => require('./referralCreate').directoryProblem(...args);

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
  reopen: 'reopened for editing',
  return: 'sent back',
  mark_sent: 'marked sent',
  mark_acknowledged: 'marked acknowledged',
  mark_patient_seen: 'marked patient seen',
  close: 'closed',
  // R5: performed only by routes/tc/referralSend.js, after ACS accepted the email.
  send: 'emailed',
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
  // R5: a send is recorded only by referralSend.js, after ACS accepted the
  // email. Nothing may claim one through a generic move.
  if (verb === 'send') throw new Error('referralTransitions: `send` moves only through referralSend.js');
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
    verb,
  });
  // Inside the transaction ON PURPOSE: a failed audit write throws, and the
  // throw rolls the status change and its event back.
  await auditTc(req, 'UPDATE', 'tc_referral', referralId, { office, priorState: row.status });
  return { moved: true, from: row.status, to };
}

/** The refusal for an edit where this status does not allow one. */
function editRefusal(row, kind) {
  const label = (contract.TC_REFERRAL_STATUS_LABELS[row.status] || row.status).toLowerCase();
  let error;
  if (kind === 'doctor_edit') error = `Only a referral awaiting sign-off can be edited here: it is ${label}.`;
  else if (row.status === 'approved') error = 'This referral is approved. Reopen it for re-approval to edit it.';
  else error = `This referral can no longer be edited: it is ${label}.`;
  return {
    status: 409,
    body: { success: false, error, code: 'REFERRAL_TRANSITION_NOT_ALLOWED', currentStatus: row.status },
  };
}

/**
 * Change some fields of one referral INSIDE a caller's transaction (R6).
 *
 *   kind 'edit'         staff (tc.full): draft or pending_signoff
 *   kind 'doctor_edit'  the doctor (tc.referral_signoff): pending_signoff only
 *
 * Returns { missing } | { refused: row } | { problem: [status, error, code] }
 * | { unchanged: true } | { edited: true }. A no-op edit writes nothing — no
 * event, no audit — because nothing happened.
 */
async function editFieldsInTx(req, client, { office, referralId, fields, kind }) {
  const allowed =
    kind === 'doctor_edit' ? contract.REFERRAL_DOCTOR_EDITABLE_STATUSES : contract.REFERRAL_FIELD_EDITABLE_STATUSES;
  const row = await store.findReferral(client, office, referralId);
  if (!row) return { missing: true };
  if (!allowed.includes(row.status)) return { refused: row };

  // A blank doctor's note is no note.
  const change = { ...fields };
  if (change.doctorNote !== undefined && (change.doctorNote === null || change.doctorNote.trim() === '')) {
    change.doctorNote = null;
  }
  // Nor is a blank reason in plain words: the patient email keeps its generic phrase.
  if (change.patientReason !== undefined && (change.patientReason === null || change.patientReason.trim() === '')) {
    change.patientReason = null;
  }
  if (change.directoryEntryId) {
    const problem = await directoryProblem(client, office, change.directoryEntryId);
    if (problem) return { problem };
  }
  const before = store.toReferral(row);
  const changed = contract.referralEditSummary(before, change);
  if (changed.length === 0) return { unchanged: true };

  const after = await store.updateFields(client, { office, referralId, status: row.status, fields: change });
  if (!after) {
    // It moved between the read and the write: the edit loses, honestly.
    const now = await store.findReferral(client, office, referralId);
    return now ? { refused: now } : { missing: true };
  }
  await store.insertEvent(client, {
    office,
    referralId,
    from: row.status,
    to: row.status,
    actor: actorEmail(req),
    at: clock().toISOString(),
    note: `Changed ${changed.join(', ')}`,
    verb: kind,
  });
  // In the transaction: a failed audit write rolls the edit and its event back.
  await auditTc(req, 'UPDATE', 'tc_referral', referralId, { office, priorState: row.status });
  return { edited: true };
}

/** An edit's (or a reopen's) outcome as a route answer, read back after commit. */
async function answerEdit(req, outcome, { referralId, office = req.tcOffice, kind = 'edit', verb = null }) {
  if (outcome.missing) {
    return { status: 404, body: { success: false, error: 'Referral not found', code: 'NOT_FOUND' } };
  }
  if (outcome.problem) {
    const [status, error, code] = outcome.problem;
    return { status, body: { success: false, error, code } };
  }
  if (outcome.refused) return verb ? refusal(outcome.refused, verb) : editRefusal(outcome.refused, kind);
  return { status: 200, body: { success: true, referral: await readBack(req, referralId, office) } };
}

/** Staff or doctor field edit, in its own transaction. */
async function editFields(req, { referralId, fields, kind, office = req.tcOffice }) {
  const outcome = await withTenantTx(req, (client) => editFieldsInTx(req, client, { office, referralId, fields, kind }));
  return answerEdit(req, outcome, { referralId, office, kind });
}

/** Thrown inside reopen's transaction to roll the reopen back with a refused edit. */
class ReopenRolledBack extends Error {
  constructor(outcome) {
    super('reopen rolled back');
    this.outcome = outcome;
  }
}

/**
 * Reopen an approved referral (approved → pending_signoff) and, in the SAME
 * transaction, apply the edit that is the reason for reopening. If the edit
 * is refused (an inactive specialist, say) the reopen rolls back with it —
 * the referral stays approved rather than sitting back in sign-off for
 * nothing.
 */
async function reopen(req, { referralId, fields, office = req.tcOffice }) {
  let outcome;
  try {
    outcome = await withTenantTx(req, async (client) => {
      const moved = await moveInTx(req, client, { office, referralId, verb: 'reopen' });
      if (!moved.moved) return { ...moved, stage: 'move' };
      if (!fields) return moved;
      const edited = await editFieldsInTx(req, client, { office, referralId, fields, kind: 'edit' });
      if (edited.problem || edited.refused || edited.missing) throw new ReopenRolledBack(edited);
      return moved;
    });
  } catch (err) {
    if (err instanceof ReopenRolledBack) outcome = err.outcome;
    else throw err;
  }
  // A refusal of the MOVE names the reopen; a refusal of the edit is the edit's.
  return answerEdit(req, outcome, { referralId, office, verb: outcome.stage === 'move' ? 'reopen' : null });
}

/** A move's outcome as a route answer, the referral read back after commit. */
async function answer(req, outcome, { referralId, verb, office }) {
  if (outcome.missing) {
    return { status: 404, body: { success: false, error: 'Referral not found', code: 'NOT_FOUND' } };
  }
  if (outcome.refused) return refusal(outcome.refused, verb);
  return { status: 200, body: { success: true, referral: await readBack(req, referralId, office) } };
}

/** The referral as stored now, with its practice name, its history and (R5) its specialist's email. */
async function readBack(req, referralId, office = req.tcOffice) {
  return tenantDb.withTenantDb(req, async (pool) => {
    const row = await store.findReferral(pool, office, referralId);
    if (!row) return null;
    const names = await store.practiceNames(pool, office, [row]);
    const emails = await store.directoryEmails(pool, office, [row]);
    const events = await store.listEvents(pool, office, referralId);
    const out = store.toReferral(row, names.get(String(row.directory_entry_id)) ?? null, events);
    out.specialistEmail = emails.get(String(row.directory_entry_id)) ?? null;
    return out;
  });
}

module.exports = {
  applyVerb,
  moveInTx,
  editFieldsInTx,
  editFields,
  reopen,
  readBack,
  setClockForTests,
  clock: () => clock(),
};
