'use strict';

/**
 * Emailing a referral to the specialist (R5) — the ONE place a referral is
 * sent, for both triggers:
 *
 *   manual  POST /api/tc/referrals/:id/send-email (tc.full), a person's click
 *   auto    right after a doctor's approval, when the office's
 *           autosend-on-approval policy is on (routes/tc/referralSignoff.js).
 *           The approval has already committed; whatever happens here cannot
 *           undo it.
 *
 * HONEST ORDERING. Nothing reads as sent before ACS has accepted the email:
 *
 *   1. gates: the office's tc_referral_email_enabled switch; the referral is
 *      approved; no email for it already went out unrecorded (a
 *      send_conflict since its last move refuses — sending again would send
 *      it twice); the directory row names an active specialist with a usable
 *      email; the transport is connected for THIS office with its own sender
 *      and a reply-to; the address has not unsubscribed.
 *   2. the attempt is audited BEFORE anything can leave (fail closed: no
 *      trail, no send).
 *   3. CLAIM the referral (send_attempt_id): two clicks, or a click racing an
 *      auto-send, cannot both email it.
 *   4. read the attached files from storage — a file that cannot be read
 *      stops the send (nothing goes out with a file silently missing).
 *   5. compose the letter and pack the files IN UPLOAD ORDER under a budget
 *      with a safety margin below ACS's cap; files past the first one that
 *      does not fit are NOT dropped silently — the letter lists them as
 *      "additional images available on request".
 *   6. hand it to the email adapter. It resolves only once ACS accepted it.
 *      (R6.3) When the office saved a copy inbox, the SAME message carries it
 *      as a BCC recipient — one request, one message; the specialist never
 *      sees it. The history row says so either way; the copy never changes
 *      what the send reports.
 *   7. THEN, in one transaction: approved → sent (conditional on still
 *      approved AND still this attempt's claim), the `send` history row with
 *      ACS's message id and the recipient, and the audit row (a PHI
 *      disclosure). A failed audit rolls the move back.
 *   8. If step 7 does not land — the referral moved while the email was out,
 *      or the audit failed — the email IS out, so a `send_conflict` row says
 *      so (with the same id and recipient), and the answer is a 409 that
 *      says the email went out. Never hidden, never retried.
 *
 * A failure before ACS accepted moves nothing: the referral stays approved, a
 * `send_failed` row records the cause (always for auto; for a click, once the
 * attempt is claimed), and the hub offers a retry.
 *
 * THE OFFICE comes from the request's server-derived office (requireOffice)
 * or the approval's; the recipient comes from the directory row, never from
 * a request. The send route takes no body (strict: anything in it is a 400).
 *
 * R5b — CLOSING THE LOOP. Two additions, both after the gates above:
 *
 *   LINKS. The letter carries two buttons, "We received this referral" and
 *   "The patient is scheduled": one-time links minted per send
 *   (referralLetter.mintLinks), whose HASHES are stored in step 7's
 *   transaction — a link exists exactly when its email is on the record. A
 *   letter that ends in send_conflict therefore has dead links (they land on
 *   the neutral page); its conflict row already tells staff to check by hand.
 *   The public side is routes/referralLinkWebhooks.js.
 *
 *   THE PATIENT'S NOTICE (notifyPatient). Only once the letter is recorded as
 *   sent, and only where the office's own switch is on
 *   (config/tcReferralPatientEmail.js, default OFF — off is a named skip, and
 *   the letter, its links and buttons are unaffected): one more message, to
 *   the patient. Its address is read from THIS
 *   office's Open Dental, read only (services/tc/referralPatientContact.js —
 *   the send path's only Open Dental access). No address on file, an opt-out,
 *   or Open Dental unreadable → no email and a named `patient_email_skipped`
 *   row; ACS refusing it → `patient_email_failed`; accepted →
 *   `patient_email_sent` (ACS id, address, unsubscribe hash) with its link's
 *   hash and the audit row, in one transaction. NEVER a BCC. Whatever happens
 *   to it, the specialist's send answers as it would have: the notice rides
 *   beside it as `outcome.patientEmail`.
 *
 * So a send is at most TWO messages: one letter to the specialist (with any
 * BCC on that same message), one notice to the patient.
 *
 * OPEN DENTAL: only the one read above, never a write.
 */

const { randomUUID } = require('node:crypto');

const { contract, actorEmail, auditTc } = require('./helpers');
const { audit, AuditError } = require('../../platform/audit');
const tenantDb = require('../../platform/tenantDb');
const { withTenantTx } = require('./tx');
const store = require('./referralStore');
const transitions = require('./referralTransitions');
const letterText = require('./referralLetterText');
const blob = require('../../services/tc/referralAttachmentStore');
const referralLetter = require('../../services/messaging/referralLetter');
const { MessagingError } = require('../../services/messaging/errors');
const patientContact = require('../../services/tc/referralPatientContact');
const tcReferralEmail = require('../../config/tcReferralEmail');
const tcReferralPatientEmail = require('../../config/tcReferralPatientEmail');
const acsConfig = require('../../config/acsEmail');
const odOffices = require('../../config/odOffices');

/** A claim older than this was left by a request that died; a live send takes seconds. */
const CLAIM_STALE_MS = 5 * 60 * 1000;

/**
 * What the packed request may weigh: 85% of ACS's cap. The adapter refuses
 * anything over the cap itself; the margin is for what we cannot measure
 * here (headers ACS adds, a different reading of "10 MB").
 */
const PACKING_BUDGET_BYTES = Math.floor(acsConfig.ACS_MAX_REQUEST_BYTES * 0.85);

/** The office's day, for the letter's date. */
function officeTimeZone() {
  return process.env.OFFICE_TIMEZONE || 'America/Chicago';
}

/** An ACS id safe to carry in audit_log.source_ref, or null. */
function sourceRefOf(operationId) {
  return typeof operationId === 'string' && /^[A-Za-z0-9._:-]{1,120}$/.test(operationId)
    ? `acs_operation:${operationId}`
    : null;
}

/** A refusal, as the route answers it. */
function refusal(status, code, error, extra = {}) {
  return { status, body: { success: false, error, code, ...extra }, outcome: { status: 'failed', message: error, code } };
}

/** Is email on for this office, and if so can it send right now? (GET /status) */
async function emailSendStatus(office) {
  const enabled = await tcReferralEmail.isEnabled(office);
  if (!enabled) return { enabled: false, unavailable: null };
  await referralLetter.refreshTransportSwitch();
  const unavailable = referralLetter.unavailableReason(office);
  if (unavailable === 'office_not_configured') {
    return { enabled: true, unavailable, missing: referralLetter.officeMissing(office) };
  }
  return { enabled: true, unavailable };
}

/** The attachments' rows, in upload order. */
async function attachmentRows(q, office, referralId) {
  const res = await q.query(
    'SELECT attachment_id, file_name, content_type, size_bytes, blob_key FROM tc_referral_attachments WHERE office_id = $1 AND referral_id = $2 ORDER BY uploaded_at ASC',
    [office, referralId]
  );
  return res.rows;
}

/**
 * Read every attached file. Throws a MessagingError when any one cannot be
 * read: the letter would otherwise go out with a file missing and not say so.
 */
async function readFiles(rows) {
  if (rows.length && !blob.isConfigured()) {
    throw new MessagingError('SEND_FAILED', "The attached files could not be read (storage isn't set up here), so nothing was sent.", {
      providerCode: 'ATTACHMENT_STORAGE_UNAVAILABLE',
    });
  }
  const files = [];
  for (const r of rows) {
    let bytes;
    try {
      bytes = await blob.getAttachment(String(r.blob_key));
    } catch {
      throw new MessagingError('SEND_FAILED', 'An attached file could not be read from storage, so nothing was sent. Try again.', {
        providerCode: 'ATTACHMENT_READ_FAILED',
      });
    }
    files.push({
      name: String(r.file_name),
      contentType: blob.contentTypeForKey(r.blob_key) || String(r.content_type),
      contentInBase64: Buffer.from(bytes).toString('base64'),
    });
  }
  return files;
}

/** What the letter signs with, for this office. */
function officeDetails(office) {
  const details = acsConfig.practiceDetailsFor(office);
  return {
    name: acsConfig.practiceNameFor(office) || odOffices.describeOffice(office).officeName,
    address: details.address,
    phone: details.phone,
    replyTo: /** @type {string} */ (acsConfig.replyToFor(office)),
  };
}

/**
 * Compose and pack: the most files that fit, as a PREFIX in upload order.
 * Measured with the transport's own payload builder, so the size is the size
 * of what would go out.
 */
function composeAndPack({ office, row, entry, files, attemptId, recipient, unsubscribeUrl, at, bcc = null, links = [] }) {
  const details = officeDetails(office);
  // The stored row, with teeth read the way every referral read reads them.
  const referral = { ...row, teeth: store.toReferral(row).teeth };
  // (R5b) The two buttons, in the order the brief named them.
  const actions = links.map((l) => ({ label: letterText.SPECIALIST_LINK_LABELS[l.purpose], href: l.url }));
  for (let n = files.length; n >= 0; n -= 1) {
    const attached = files.slice(0, n);
    const onRequest = files.slice(n);
    const composed = letterText.composeReferralLetter({
      referral,
      entry,
      office: details,
      attached: attached.map((f) => f.name),
      onRequest: onRequest.map((f) => f.name),
      at,
      timeZone: officeTimeZone(),
      withLinks: actions.length > 0,
    });
    if (composed.text.length > contract.EMAIL_TEXT_BODY_CEILING) {
      throw new MessagingError('SEND_FAILED', 'The referral letter is too long to email. Shorten the notes, then try again.', {
        providerCode: 'LETTER_TOO_LONG',
      });
    }
    const rendered = referralLetter.render({ office, subject: composed.subject, text: composed.text, unsubscribeUrl, actions });
    const message = referralLetter.messageOf({
      office,
      attemptId,
      toAddress: recipient,
      rendered,
      unsubscribeUrl,
      attachments: attached,
      bccAddress: bcc,
    });
    if (referralLetter.requestBytes(message, office) <= PACKING_BUDGET_BYTES) {
      return { message, attached: attached.length, onRequest: onRequest.length };
    }
  }
  throw new MessagingError('SEND_FAILED', 'The referral letter is larger than the email service accepts, so it was not sent.', {
    providerCode: 'EMAIL_TOO_LARGE',
  });
}

/**
 * (R6.3) The history's words for the blind copy, or '' when there is none.
 * Honest about what is known: ACS accepting the message is accepting it WITH
 * the BCC recipient on it; whether either copy is later delivered is not
 * something ACS's accept tells us, for the copy or for the specialist.
 * @param {string|null} bcc
 * @param {'sent'|'failed'} outcome
 */
function copyPhrase(bcc, outcome) {
  if (!bcc) return '';
  return outcome === 'sent' ? ` A blind copy (BCC) to ${bcc} was on the same message.` : ' No blind copy went out either.';
}

/** "2 files attached; 1 listed as available on request" */
function filesPhrase(attached, onRequest) {
  const a = attached === 0 ? 'no files attached' : `${attached} file${attached === 1 ? '' : 's'} attached`;
  return onRequest ? `${a}; ${onRequest} listed as available on request` : a;
}

/** A MessagingError (or anything) → { status, code, message, extra }. */
function failureOf(err) {
  if (err instanceof MessagingError) {
    const extra = err.extra && typeof err.extra === 'object' ? err.extra : {};
    const code = typeof extra.providerCode === 'string' && extra.providerCode ? extra.providerCode : err.code;
    const { providerCode: _p, ...rest } = extra;
    return { status: err.httpStatus || 502, code, message: err.message, extra: rest };
  }
  if (err instanceof AuditError) {
    return { status: 500, code: 'AUDIT_FAILED', message: 'The send could not be recorded, so nothing was sent.', extra: {} };
  }
  return { status: 500, code: 'SEND_FAILED', message: 'The email could not be sent.', extra: {} };
}

/**
 * Record a failed attempt: release the claim (if this attempt took one) and
 * write the visible `send_failed` row. Bookkeeping only — nothing was sent —
 * so a failure here is logged, not thrown over the real cause.
 */
async function recordFailure(req, { office, referralId, attemptId, auto, failure, bcc = null }) {
  try {
    const status = await tenantDb.withTenantDb(req, async (pool) => {
      if (attemptId) await store.releaseSendClaim(pool, { office, referralId, attemptId });
      // Where it stands NOW: a failure that raced a move is recorded on the
      // status it moved to, never on an `approved` it no longer is.
      const now = await store.findReferral(pool, office, referralId);
      const current = now ? now.status : 'approved';
      await store.insertSendEvent(pool, {
        office,
        referralId,
        from: current,
        to: current,
        actor: actorEmail(req),
        at: transitions.clock().toISOString(),
        note: `${auto ? 'Not sent automatically' : 'Not sent'}: ${failure.message}${copyPhrase(bcc, 'failed')}`,
        verb: 'send_failed',
      });
      return current;
    });
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'tc_referral.email_send_failed',
      resourceId: referralId,
      result: 'ERROR',
      office,
      priorState: status,
    });
  } catch (err) {
    console.error(
      `[tc/referralSend] office=${office} referral=${referralId} could not record a failed send (${failure.code}):`,
      err && err.message ? err.message : err
    );
  }
}

/**
 * The email is OUT but the referral is not marked sent. Say so, on the
 * record: release the claim and write `send_conflict` with the same ACS id,
 * recipient and unsubscribe hash a `send` row would carry.
 */
async function recordConflict(req, { office, referralId, attemptId, accepted, recipient, unsubscribeHash, why, bcc = null }) {
  try {
    await tenantDb.withTenantDb(req, async (pool) => {
      await store.releaseSendClaim(pool, { office, referralId, attemptId });
      const now = await store.findReferral(pool, office, referralId);
      const status = now ? now.status : 'approved';
      await store.insertSendEvent(pool, {
        office,
        referralId,
        from: status,
        to: status,
        actor: actorEmail(req),
        at: transitions.clock().toISOString(),
        note: `Emailed to ${recipient} (the email service accepted it), but the referral could not be marked sent: ${why} Check with the specialist's office, then mark it sent.${copyPhrase(bcc, 'sent')}`,
        verb: 'send_conflict',
        acsMessageId: accepted.providerMessageId,
        recipientAddress: recipient,
        unsubscribeTokenHash: unsubscribeHash,
      });
    });
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'tc_referral.email_send_conflict',
      resourceId: referralId,
      result: 'ERROR',
      office,
      sourceRef: sourceRefOf(accepted.providerMessageId),
      priorState: 'approved',
    });
  } catch (err) {
    // The one thing that must not vanish: an email went out. Loud, no PHI.
    console.error(
      `[tc/referralSend] office=${office} referral=${referralId} attempt=${attemptId} EMAIL WENT OUT but the conflict could not be recorded:`,
      err && err.message ? err.message : err
    );
  }
}

/**
 * Email one referral. See the header for the order.
 * @param {import('express').Request} req
 * @param {{ office: string, referralId: string, trigger: 'manual'|'auto' }} args
 * @returns {Promise<{ status: number, body: object, outcome: { status: string, message: string, code: string|null } }>}
 */
async function sendReferral(req, { office, referralId, trigger }) {
  const auto = trigger === 'auto';

  if (!(await tcReferralEmail.isEnabled(office))) {
    const out = refusal(403, 'REFERRAL_EMAIL_DISABLED', 'Referral email is not switched on for this office.');
    out.outcome = { status: 'skipped', message: out.body.error, code: out.body.code };
    return out;
  }

  const pre = await tenantDb.withTenantDb(req, async (pool) => {
    const row = await store.findReferral(pool, office, referralId);
    if (!row) return null;
    const events = await store.listEvents(pool, office, referralId);
    const entry = row.directory_entry_id ? await store.findEntry(pool, office, String(row.directory_entry_id)) : null;
    return { row, events, entry };
  });
  if (!pre) return refusal(404, 'NOT_FOUND', 'Referral not found');
  const { row, events, entry } = pre;
  if (row.status !== 'approved') {
    const label = (contract.TC_REFERRAL_STATUS_LABELS[row.status] || row.status).toLowerCase();
    return refusal(409, 'REFERRAL_TRANSITION_NOT_ALLOWED', `This referral cannot be emailed: it is ${label}.`, {
      currentStatus: row.status,
    });
  }
  const problem = contract.referralLastSendProblem(events);
  if (problem && problem.kind === 'conflict') {
    return refusal(
      409,
      'REFERRAL_ALREADY_EMAILED',
      'This referral was already emailed but could not be marked sent. Check with the specialist, then mark it sent — it will not be emailed twice.'
    );
  }

  // Everything below can fail for a reason the hub should show: for an
  // auto-send, every such failure is recorded; for a click, from the claim on.
  /** @type {string|null} */
  let attemptId = null;
  /** (R6.3) The office's copy inbox for THIS send, read once; null = no copy. */
  /** @type {string|null} */
  let bcc = null;
  const fail = async (err) => {
    const failure = failureOf(err);
    if (auto || attemptId) await recordFailure(req, { office, referralId, attemptId, auto, failure, bcc });
    return refusal(failure.status, failure.code, failure.message, failure.extra);
  };

  let recipient;
  try {
    if (!entry) {
      throw new MessagingError('MESSAGE_NOT_SENDABLE', 'Choose a specialist for this referral before emailing it.');
    }
    if (entry.active !== true) {
      throw new MessagingError(
        'MESSAGE_NOT_SENDABLE',
        'This specialist is marked inactive in Settings → Referrals, so the referral was not emailed.'
      );
    }
    recipient = referralLetter.recipientOf(entry.email);
    if (!recipient) throw new MessagingError('NO_ADDRESS', `${contract.REFERRAL_NO_EMAIL_COPY}.`);
    await referralLetter.refreshTransportSwitch();
    referralLetter.assertAvailable(office);
    await tenantDb.withTenantDb(req, (pool) => referralLetter.assertMayEmail(pool, { office, address: recipient }));
    bcc = referralLetter.bccFor(office, recipient);
  } catch (err) {
    return fail(err);
  }

  // The attempt is on the record before anything can leave. A failed write
  // throws AuditError: for a click that is a 500 and nothing was sent.
  try {
    await audit(req, {
      action: 'UPDATE',
      resourceType: 'tc_referral.email_send_attempt',
      resourceId: referralId,
      result: 'SUCCESS',
      office,
      priorState: 'approved',
    });
  } catch (err) {
    if (!auto) throw err;
    return fail(err);
  }

  const claimId = randomUUID();
  const now = transitions.clock();
  const claimed = await tenantDb.withTenantDb(req, async (pool) => {
    await store.releaseStaleSendClaim(pool, {
      office,
      referralId,
      staleBefore: new Date(now.getTime() - CLAIM_STALE_MS).toISOString(),
    });
    return store.claimSend(pool, { office, referralId, attemptId: claimId, at: now.toISOString() });
  });
  if (!claimed) {
    return refusal(409, 'REFERRAL_SEND_IN_PROGRESS', 'This referral is already being emailed. Refresh in a moment.');
  }
  attemptId = claimId;

  let packed;
  let unsubscribe;
  /** (R5b) The letter's two links; their hashes are stored with the send. */
  let links = [];
  let accepted;
  try {
    const files = await readFiles(await tenantDb.withTenantDb(req, (pool) => attachmentRows(pool, office, referralId)));
    unsubscribe = referralLetter.mintUnsubscribe();
    links = referralLetter.mintLinks(['received', 'scheduled']);
    packed = composeAndPack({
      office,
      row,
      entry,
      files,
      attemptId,
      recipient,
      unsubscribeUrl: unsubscribe.url,
      at: now,
      bcc,
      links,
    });
    accepted = await referralLetter.transport(packed.message, office);
  } catch (err) {
    return fail(err);
  }

  // ACS accepted it. Only now may the referral read as sent.
  const at = transitions.clock().toISOString();
  const actor = actorEmail(req);
  const note = `Emailed to ${recipient}${auto ? ' automatically on approval' : ''} — ${filesPhrase(packed.attached, packed.onRequest)}. The email service accepted it.${copyPhrase(bcc, 'sent')}`;
  let moved = null;
  let why = 'it changed while the email was going out.';
  try {
    moved = await withTenantTx(req, async (client) => {
      const done = await store.finishSend(client, { office, referralId, attemptId, to: 'sent', actor, at });
      if (!done) return null;
      await store.insertSendEvent(client, {
        office,
        referralId,
        from: 'approved',
        to: 'sent',
        actor,
        at,
        note,
        verb: 'send',
        acsMessageId: accepted.providerMessageId,
        recipientAddress: recipient,
        unsubscribeTokenHash: unsubscribe.hash,
      });
      // (R5b) The letter's links, by hash only, with this email's record.
      await store.insertLinkTokens(client, {
        office,
        referralId,
        audience: 'specialist',
        links: links.map((l) => ({ hash: l.hash, purpose: l.purpose })),
        at,
        expiresAt: linkExpiry(at),
      });
      // The disclosure's trail, INSIDE the transaction: a failed audit write
      // throws, and the throw rolls the move and its row back.
      await auditTc(req, 'UPDATE', 'tc_referral.email_send', referralId, {
        office,
        priorState: 'approved',
        sourceRef: sourceRefOf(accepted.providerMessageId),
      });
      return done;
    });
  } catch (err) {
    moved = null;
    why = err instanceof AuditError ? 'the audit record could not be written.' : 'the database refused the update.';
  }

  if (!moved) {
    await recordConflict(req, {
      office,
      referralId,
      attemptId,
      accepted,
      recipient,
      unsubscribeHash: unsubscribe.hash,
      why,
      bcc,
    });
    const message = `The email went out (the email service accepted it), but the referral could not be marked sent: ${why} It is in the history; check with the specialist's office, then mark it sent.`;
    return {
      status: 409,
      body: { success: false, error: message, code: 'REFERRAL_EMAIL_CONFLICT', referral: await transitions.readBack(req, referralId, office) },
      outcome: { status: 'conflict', message, code: 'REFERRAL_EMAIL_CONFLICT' },
    };
  }

  // (R5b) The letter is on the record; now — and only now — the patient's notice.
  const patientEmail = await notifyPatient(req, { office, row, entry, withFiles: packed.attached > 0 });

  const practice = entry.practice_name ? `${entry.practice_name} (${recipient})` : recipient;
  const message = `Emailed to ${practice} — ${filesPhrase(packed.attached, packed.onRequest)}.`;
  const outcome = { status: 'sent', message, code: null, patientEmail };
  return {
    status: 200,
    body: { success: true, referral: await transitions.readBack(req, referralId, office), outcome },
    outcome,
  };
}

/** (R5b) When a link minted at `at` (ISO) stops working. */
function linkExpiry(at) {
  return new Date(new Date(at).getTime() + referralLetter.LINK_TTL_MS).toISOString();
}

/**
 * (R5b) The history's words for a notice that did not go — "patient has no
 * email on file", and so on. Each names a fact; none guesses.
 */
const PATIENT_SKIP_NOTE = Object.freeze({
  switched_off: 'Patient not emailed: patient email is off for this office.',
  no_email: 'Patient not emailed: the patient has no email on file in Open Dental.',
  not_found: "Patient not emailed: the patient was not found in this office's Open Dental.",
  not_connected: "Patient not emailed: Open Dental isn't connected for this office, so the patient's email could not be looked up.",
  unreadable: "Patient not emailed: Open Dental could not be read, so the patient's email could not be looked up.",
  opted_out: 'Patient not emailed: that email address unsubscribed from our emails.',
  unaudited: 'Patient not emailed: the lookup could not be recorded, so it was not made.',
});

/** What the hub says for each skip (short; the history row has the sentence). */
const PATIENT_SKIP_OUTCOME = Object.freeze({
  switched_off: 'Patient email is off for this office, so no patient email was sent.',
  no_email: 'The patient has no email on file, so no patient email was sent.',
  not_found: "The patient wasn't found in Open Dental, so no patient email was sent.",
  not_connected: "Open Dental isn't connected for this office, so no patient email was sent.",
  unreadable: "Open Dental couldn't be read, so no patient email was sent.",
  opted_out: 'The patient unsubscribed from our emails, so no patient email was sent.',
  unaudited: 'No patient email was sent (the lookup could not be recorded).',
});

/**
 * Write one of the notice's non-move history rows on the status the referral
 * holds now. Bookkeeping: a failure is logged, never thrown over the send.
 */
async function recordPatientEvent(req, { office, referralId, verb, note }) {
  try {
    await tenantDb.withTenantDb(req, async (pool) => {
      const now = await store.findReferral(pool, office, referralId);
      const status = now ? now.status : 'sent';
      await store.insertEvent(pool, {
        office,
        referralId,
        from: status,
        to: status,
        actor: actorEmail(req),
        at: transitions.clock().toISOString(),
        note,
        verb,
      });
    });
  } catch (err) {
    console.error(
      `[tc/referralSend] office=${office} referral=${referralId} could not record ${verb}:`,
      err && err.message ? err.message : err
    );
  }
}

/**
 * (R5b) The patient's notice, after the letter was recorded as sent. NEVER
 * throws, never changes the letter's outcome; returns what happened.
 * @param {import('express').Request} req
 * @param {{ office: string, row: Record<string, unknown>, entry: Record<string, unknown>, withFiles: boolean }} args
 *   `withFiles`: files went WITH the letter (the notice then says "and X-rays").
 * @returns {Promise<{ status: 'sent'|'skipped'|'failed', message: string }>}
 */
async function notifyPatient(req, { office, row, entry, withFiles }) {
  const referralId = String(row.referral_id);
  const skip = async (why) => {
    await recordPatientEvent(req, { office, referralId, verb: 'patient_email_skipped', note: PATIENT_SKIP_NOTE[why] });
    return { status: 'skipped', message: PATIENT_SKIP_OUTCOME[why] };
  };

  // The office's own switch for this email, before anything else: off means
  // no patient email and no Open Dental lookup for one. A failed read is off.
  let patientEmailOn = false;
  try {
    patientEmailOn = await tcReferralPatientEmail.isEnabled(office);
  } catch {
    patientEmailOn = false;
  }
  if (!patientEmailOn) return skip('switched_off');

  // The lookup reads PHI from Open Dental: on the record first, or not at all.
  try {
    await audit(req, {
      action: 'READ',
      resourceType: 'tc_referral.patient_email_lookup',
      resourceId: referralId,
      result: 'SUCCESS',
      office,
    });
  } catch {
    return skip('unaudited');
  }
  // A PatNum that is not a safe integer would read a DIFFERENT patient.
  const patNum = Number(row.od_patient_id);
  if (!Number.isSafeInteger(patNum) || patNum <= 0) return skip('not_found');
  const contact = await patientContact.patientEmailFor(office, patNum);
  if (contact.status !== 'found') return skip(contact.status);
  const address = referralLetter.recipientOf(contact.address);
  if (!address) return skip('no_email');

  let mayEmail;
  try {
    mayEmail = await tenantDb.withTenantDb(req, (pool) => referralLetter.patientMayEmail(pool, { office, address }));
  } catch {
    mayEmail = null;
  }
  if (mayEmail === false) return skip('opted_out');

  let unsubscribe;
  let link;
  let accepted;
  try {
    if (mayEmail !== true) throw new MessagingError('SEND_FAILED', 'Whether the patient may be emailed could not be checked.');
    unsubscribe = referralLetter.mintUnsubscribe();
    [link] = referralLetter.mintLinks(['scheduled']);
    const details = officeDetails(office);
    const composed = letterText.composePatientNotice({
      patientName: String(row.patient_name ?? ''),
      referringProvider: row.referring_provider == null ? null : String(row.referring_provider),
      entry,
      office: { name: details.name, phone: details.phone },
      withFiles,
      sourceKind: String(row.source_kind ?? ''),
    });
    const rendered = referralLetter.renderPatientNotice({
      office,
      subject: composed.subject,
      text: composed.text,
      after: composed.after,
      unsubscribeUrl: unsubscribe.url,
      actions: [{ label: letterText.PATIENT_LINK_LABEL, href: link.url }],
    });
    // Its own message id, and never a BCC — the copy inbox is for the letter only.
    const message = referralLetter.messageOf({
      office,
      attemptId: randomUUID(),
      toAddress: address,
      rendered,
      unsubscribeUrl: unsubscribe.url,
    });
    accepted = await referralLetter.transport(message, office);
  } catch (err) {
    const failure = failureOf(err);
    await recordPatientEvent(req, {
      office,
      referralId,
      verb: 'patient_email_failed',
      note: `Patient email not sent: ${failure.message}`,
    });
    return { status: 'failed', message: `The patient email could not be sent: ${failure.message}` };
  }

  const at = transitions.clock().toISOString();
  try {
    await withTenantTx(req, async (client) => {
      const now = await store.findReferral(client, office, referralId);
      const status = now ? now.status : 'sent';
      await store.insertSendEvent(client, {
        office,
        referralId,
        from: status,
        to: status,
        actor: actorEmail(req),
        at,
        // The address is in recipient_address; the note does not repeat it.
        note: "Patient emailed at the address on file in Open Dental — who they are referred to and the specialist's phone. The email service accepted it.",
        verb: 'patient_email_sent',
        acsMessageId: accepted.providerMessageId,
        recipientAddress: address,
        unsubscribeTokenHash: unsubscribe.hash,
      });
      await store.insertLinkTokens(client, {
        office,
        referralId,
        audience: 'patient',
        links: [{ hash: link.hash, purpose: 'scheduled' }],
        at,
        expiresAt: linkExpiry(at),
      });
      await auditTc(req, 'UPDATE', 'tc_referral.patient_email_send', referralId, {
        office,
        priorState: status,
        sourceRef: sourceRefOf(accepted.providerMessageId),
      });
    });
  } catch (err) {
    // The notice IS out; only its record is incomplete. Say so, loudly, and
    // keep the row if the database will take it (its link stays dead).
    console.error(
      `[tc/referralSend] office=${office} referral=${referralId} the second email WENT OUT but could not be recorded:`,
      err && err.message ? err.message : err
    );
    try {
      await tenantDb.withTenantDb(req, (pool) =>
        store.insertSendEvent(pool, {
          office,
          referralId,
          // The letter was recorded as sent just before this notice went.
          from: 'sent',
          to: 'sent',
          actor: actorEmail(req),
          at,
          note: `Patient emailed at the address on file (the email service accepted it), but the record of it is incomplete, so its "I've scheduled" button will not work.`,
          verb: 'patient_email_sent',
          acsMessageId: accepted.providerMessageId,
          recipientAddress: address,
          unsubscribeTokenHash: unsubscribe.hash,
        })
      );
    } catch {
      // Logged above; nothing more to do without a database.
    }
    return { status: 'sent', message: 'The patient was emailed, but the record of it is incomplete — see the history.' };
  }
  return { status: 'sent', message: 'The patient was emailed who they are referred to and how to schedule.' };
}

/**
 * After a doctor's approval committed: email it if — and only if — email is
 * on for the office AND its policy says to send on approval. Returns null
 * when no auto-send applies. NEVER throws: the approval stands whatever
 * happens here, and the outcome says what did.
 * @param {import('express').Request} req
 * @param {{ office: string, referralId: string }} args
 * @returns {Promise<null | { outcome: { status: string, message: string, code: string|null }, referral: object|null }>}
 */
async function sendAfterApproval(req, { office, referralId }) {
  try {
    if (!(await tcReferralEmail.isEnabled(office))) return null;
    const policyOn = await tenantDb.withTenantDb(req, (pool) => store.sendsOnApproval(pool, office));
    if (!policyOn) return null;
    const out = await sendReferral(req, { office, referralId, trigger: 'auto' });
    return { outcome: out.outcome, referral: await transitions.readBack(req, referralId, office) };
  } catch (err) {
    console.error(
      `[tc/referralSend] office=${office} referral=${referralId} auto-send after approval failed:`,
      err && err.message ? err.message : err
    );
    let referral = null;
    try {
      referral = await transitions.readBack(req, referralId, office);
    } catch {
      referral = null;
    }
    return {
      outcome: { status: 'failed', message: 'The automatic email could not be attempted. Send it from the Referrals hub.', code: 'AUTO_SEND_ERROR' },
      referral,
    };
  }
}

module.exports = {
  CLAIM_STALE_MS,
  PACKING_BUDGET_BYTES,
  emailSendStatus,
  sendReferral,
  sendAfterApproval,
};
