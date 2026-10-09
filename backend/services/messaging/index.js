'use strict';

/**
 * TC messaging service (queue item 38) — drafts, the approval click, consent.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * REVIEW-THEN-SEND, FOR MESSAGES
 * ═════════════════════════════════════════════════════════════════════════════
 * A patient message is like a chart write: NOTHING SENDS WITHOUT A HUMAN
 * CLICKING SEND ON THAT SPECIFIC MESSAGE. There is no auto-send, no scheduled
 * send and no bulk send, and this file has no function that sends more than the
 * one message id it was handed by a request.
 *
 *   draftMessage   → a `draft` row. Address assembled from the CASE ROW.
 *   editDraft      → change a draft's text. Address is never editable.
 *   discardMessage → delete a draft (only a draft).
 *   sendMessage    → THE APPROVAL CLICK, in this order:
 *                      audit the attempt (fail closed: no trail, no send)
 *                      → the row must be an outbound `draft`
 *                      → the case's address must still be the draft's address
 *                      → consent gate (services/messaging/consent.js); a block
 *                        is audited and the row STAYS a draft
 *                      → the channel's adapter must be connected (501 if not;
 *                        row stays a draft — nothing was attempted)
 *                      → draft → sending (conditional UPDATE: a double click
 *                        cannot send twice)
 *                      → adapter.send → `sent`/`queued` only on its confirmation,
 *                        or `failed` with the error preserved. NEVER retried.
 *                      → audit the terminal status
 *   recordInbound  → a `received` row; STOP-family keywords record an opt-out.
 *
 * Honest states: a message is `sent` only after the adapter confirms hand-off.
 * If the adapter confirms and the follow-up write fails, the row stays
 * `sending` — not `sent` (we cannot show it), not `draft` (a second click would
 * double-send). `sending` is not sendable, so nothing retries it.
 *
 * PHI: every address, body and subject stays in Postgres. Nothing here writes
 * to the JSON call store, and no log line or audit row carries an address, a
 * body, or a name — audit rows carry the message id and the office.
 *
 * Every function takes the express `req` (for the tenant pool, the actor, and
 * the audit trail) and the SERVER-DERIVED office (routes/tc helpers.requireOffice).
 */

const crypto = require('node:crypto');

const tenantDb = require('../../platform/tenantDb');
const { audit } = require('../../platform/audit');
const odOffices = require('../../config/odOffices');
const contract = require('../../tc/contract.gen.cjs');
const { MessagingError } = require('./errors');
const { addressFromCase, normalizeAddress } = require('./address');
const consent = require('./consent');
const { isQuietHours } = require('./quietHours');
const adapters = require('./adapters');
const templates = require('./templates');

const MESSAGE_COLS = [
  'message_id',
  'office_id',
  'case_id',
  'direction',
  'channel',
  'to_address',
  'from_address',
  'body',
  'subject',
  'template_id',
  'status',
  'provider',
  'provider_message_id',
  'error',
  'created_by',
  'sent_by',
  'created_at',
  'sent_at',
];

const CONSENT_COLS = [
  'consent_id',
  'office_id',
  'channel',
  'address',
  'state',
  'source',
  'note',
  'updated_by',
  'updated_at',
];

const CHANNELS = Object.freeze(['sms', 'email']);

/**
 * The clock the consent gate reads (quiet hours). A seam for the boundary
 * tests ONLY — there is no request parameter, header or env var that reaches
 * it, so no caller can move "now" out of quiet hours.
 */
let clock = () => new Date();
/** TESTS ONLY. */
function setClockForTests(fn) {
  clock = fn;
}
/** TESTS ONLY. */
function resetClock() {
  clock = () => new Date();
}

/**
 * STOP-family keywords (CTIA). An inbound text that is exactly one of these,
 * ignoring case and surrounding whitespace/punctuation, records an opt-out.
 */
const STOP_KEYWORDS = Object.freeze(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

// ── helpers ─────────────────────────────────────────────────────────────────

function iso(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** DB row → contract entity (parse is the shape guarantee). */
function toMessage(r) {
  return contract.TcMessage.parse({
    messageId: r.message_id,
    officeId: r.office_id,
    caseId: r.case_id ?? null,
    direction: r.direction,
    channel: r.channel,
    toAddress: r.to_address ?? null,
    fromAddress: r.from_address ?? null,
    body: r.body ?? '',
    subject: r.subject ?? null,
    templateId: r.template_id ?? null,
    status: r.status,
    provider: r.provider ?? null,
    providerMessageId: r.provider_message_id ?? null,
    error: r.error ?? null,
    createdBy: r.created_by ?? null,
    sentBy: r.sent_by ?? null,
    createdAt: iso(r.created_at),
    sentAt: iso(r.sent_at),
  });
}

function toConsent(r) {
  return contract.TcContactConsent.parse({
    consentId: r.consent_id,
    officeId: r.office_id,
    channel: r.channel,
    address: r.address,
    state: r.state,
    source: r.source,
    note: r.note ?? null,
    updatedBy: r.updated_by ?? null,
    updatedAt: iso(r.updated_at),
  });
}

function actorOf(req) {
  const email = req && req.user && req.user.email;
  if (!email) throw new Error('[messaging] no SSO identity on request');
  return email;
}

function officeNameOf(office) {
  return odOffices.describeOffice(office).officeName;
}

/** Run `fn(pool)` against the caller's tenant database. */
function db(req, fn) {
  return tenantDb.withTenantDb(req, fn);
}

/**
 * One audit row. `result` is SUCCESS / UNAUTHORIZED (a consent block) /
 * ERROR (an adapter failure). action stays inside the audit_log CHECK
 * (READ | CREATE | UPDATE | DELETE); WHAT happened is the resource_type, so no
 * new audit verb — and no migration of the shared vocabulary — is needed.
 */
async function auditMessage(req, action, resourceType, resourceId, office, result = 'SUCCESS') {
  await audit(req, { action, resourceType, resourceId, result, office });
}

async function loadMessage(q, office, messageId) {
  const res = await q.query(
    `SELECT ${MESSAGE_COLS.join(', ')} FROM tc_messages WHERE office_id = $1 AND message_id = $2`,
    [office, messageId]
  );
  return res.rows.length ? res.rows[0] : null;
}

async function loadCase(q, office, caseId) {
  const res = await q.query(
    `SELECT case_id, office_id, patient_name, phone, email, od_patient_id
       FROM tc_cases WHERE office_id = $1 AND case_id = $2`,
    [office, caseId]
  );
  return res.rows.length ? res.rows[0] : null;
}

async function loadFollowup(q, office, followupId) {
  const res = await q.query(
    `SELECT followup_id, case_id, office_id, kind, channel, nurture_type
       FROM tc_followups WHERE office_id = $1 AND followup_id = $2`,
    [office, followupId]
  );
  return res.rows.length ? res.rows[0] : null;
}

function noAddressError(channel) {
  return new MessagingError(
    'NO_ADDRESS',
    channel === 'sms'
      ? 'This case has no usable mobile number. Add a 10-digit US phone number to the case first.'
      : 'This case has no usable email address. Add one to the case first.'
  );
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * A case's thread, oldest first (outbound and inbound interleaved).
 * @returns {Promise<object[]>}
 */
async function listMessages(req, office, caseId) {
  const rows = await db(req, (q) =>
    q.query(
      `SELECT ${MESSAGE_COLS.join(', ')} FROM tc_messages
        WHERE office_id = $1 AND case_id = $2 ORDER BY created_at`,
      [office, caseId]
    )
  );
  await auditMessage(req, 'READ', 'tc_message', caseId, office);
  return rows.rows.map(toMessage);
}

/** Received messages not yet linked to a case, newest first. */
async function listInbox(req, office) {
  const rows = await db(req, (q) =>
    q.query(
      `SELECT ${MESSAGE_COLS.join(', ')} FROM tc_messages
        WHERE office_id = $1 AND direction = 'inbound' AND status = 'received' AND case_id IS NULL
        ORDER BY created_at DESC LIMIT 200`,
      [office]
    )
  );
  await auditMessage(req, 'READ', 'tc_message_inbox', null, office);
  return rows.rows.map(toMessage);
}

/**
 * What the compose box needs to be honest BEFORE anyone clicks Send: per
 * channel, the server-derived address, whether a provider is connected, and
 * what the consent gate would say right now.
 */
async function getChannelReadiness(req, office, caseId) {
  const now = clock();
  return db(req, async (q) => {
    const tcCase = await loadCase(q, office, caseId);
    if (!tcCase) throw new MessagingError('CASE_NOT_FOUND', 'Case not found');
    const channels = [];
    for (const channel of CHANNELS) {
      const address = addressFromCase(channel, tcCase);
      const adapterEnabled = adapters.isChannelEnabled(channel);
      const quietHours = channel === 'sms' ? isQuietHours(now) : false;
      if (!address) {
        channels.push({
          channel,
          address: null,
          adapterEnabled,
          consentState: 'unknown',
          odTextConsent: 'not_checked',
          quietHours,
          blockCode: null,
        });
        continue;
      }
      const d = await consent.canMessage(q, {
        office,
        channel,
        address,
        odPatientId: tcCase.od_patient_id,
        now,
      });
      channels.push({
        channel,
        address,
        adapterEnabled,
        consentState: d.consentState,
        odTextConsent: d.odTextConsent,
        quietHours: d.quietHours,
        blockCode: d.code,
      });
    }
    // The OD TxtMsgOk read is a PHI read of this case's patient: one row,
    // case id + office, written whether the record came from cache or not.
    await auditMessage(req, 'READ', 'tc_message_consent', caseId, office);
    return channels.map((c) => contract.ChannelReadiness.parse(c));
  });
}

// ── drafts ──────────────────────────────────────────────────────────────────

/**
 * Create a draft for a case. The address is assembled from the case row; a
 * body is the caller's text, or — with `followupId` and no body — the
 * follow-up template filled from the case (no AI).
 */
async function draftMessage(req, office, input) {
  const actor = actorOf(req);
  const { caseId, channel } = input;
  const row = await db(req, async (q) => {
    const tcCase = await loadCase(q, office, caseId);
    if (!tcCase) throw new MessagingError('CASE_NOT_FOUND', 'Case not found');
    const toAddress = addressFromCase(channel, tcCase);
    if (!toAddress) throw noAddressError(channel);

    let body = input.body ?? null;
    let subject = channel === 'email' ? input.subject ?? null : null;
    let templateId = null;
    if (input.followupId) {
      const f = await loadFollowup(q, office, input.followupId);
      if (!f || f.case_id !== caseId) {
        throw new MessagingError('FOLLOWUP_NOT_FOUND', 'Follow-up not found on this case');
      }
      const filled = templates.render(templates.templateFor(f), channel, {
        patientName: tcCase.patient_name,
        officeName: officeNameOf(office),
      });
      templateId = filled.templateId;
      if (body == null) body = filled.body;
      if (channel === 'email' && subject == null) subject = filled.subject;
    }
    if (!body) throw new MessagingError('BODY_REQUIRED', 'A message needs some text.');

    const messageId = crypto.randomUUID();
    await q.query(
      `INSERT INTO tc_messages (message_id, office_id, case_id, direction, channel, to_address,
         body, subject, template_id, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [messageId, office, caseId, 'outbound', channel, toAddress, body, subject, templateId, 'draft', actor]
    );
    return loadMessage(q, office, messageId);
  });
  await auditMessage(req, 'CREATE', 'tc_message', row.message_id, office);
  return toMessage(row);
}

/** Edit a draft's text. Only a draft; the address is never editable. */
async function editDraft(req, office, messageId, input) {
  const row = await db(req, async (q) => {
    const existing = await loadMessage(q, office, messageId);
    if (!existing) throw new MessagingError('MESSAGE_NOT_FOUND', 'Message not found');
    if (existing.status !== 'draft' || existing.direction !== 'outbound') {
      throw new MessagingError('MESSAGE_NOT_EDITABLE', 'Only a draft can be edited.', { status: existing.status });
    }
    const subject = existing.channel === 'email' ? input.subject ?? existing.subject ?? null : null;
    const res = await q.query(
      `UPDATE tc_messages SET body = $1, subject = $2
        WHERE office_id = $3 AND message_id = $4 AND status = 'draft'
        RETURNING ${MESSAGE_COLS.join(', ')}`,
      [input.body, subject, office, messageId]
    );
    if (!res.rows.length) {
      throw new MessagingError('MESSAGE_NOT_EDITABLE', 'Only a draft can be edited.');
    }
    return res.rows[0];
  });
  await auditMessage(req, 'UPDATE', 'tc_message', messageId, office);
  return toMessage(row);
}

/** Discard (delete) a draft. A sent, failed or received message is history and stays. */
async function discardMessage(req, office, messageId) {
  await db(req, async (q) => {
    const existing = await loadMessage(q, office, messageId);
    if (!existing) throw new MessagingError('MESSAGE_NOT_FOUND', 'Message not found');
    if (existing.status !== 'draft') {
      throw new MessagingError('MESSAGE_NOT_EDITABLE', 'Only a draft can be discarded.', { status: existing.status });
    }
    const res = await q.query(
      `DELETE FROM tc_messages WHERE office_id = $1 AND message_id = $2 AND status = 'draft' RETURNING message_id`,
      [office, messageId]
    );
    if (!res.rows.length) throw new MessagingError('MESSAGE_NOT_EDITABLE', 'Only a draft can be discarded.');
  });
  await auditMessage(req, 'DELETE', 'tc_message', messageId, office);
}

// ── THE approval click ──────────────────────────────────────────────────────

/**
 * Send ONE message, because a human clicked Send on it. See the header for
 * the exact order of checks.
 * @param {import('express').Request} req
 * @param {'roland'|'valley'} office
 * @param {string} messageId
 */
async function sendMessage(req, office, messageId) {
  const actor = actorOf(req);
  const now = clock();

  const existing = await db(req, (q) => loadMessage(q, office, messageId));
  if (!existing) throw new MessagingError('MESSAGE_NOT_FOUND', 'Message not found');

  // The attempt is on the record BEFORE anything can leave. Fail closed: if
  // this write fails, AuditError propagates and nothing is sent.
  await auditMessage(req, 'UPDATE', 'tc_message.send_attempt', messageId, office);

  if (existing.direction !== 'outbound' || existing.status !== 'draft') {
    throw new MessagingError('MESSAGE_NOT_SENDABLE', 'Only a draft can be sent.', { status: existing.status });
  }
  if (!existing.case_id) {
    throw new MessagingError('MESSAGE_NOT_SENDABLE', 'This draft is no longer attached to a case.');
  }

  const channel = existing.channel;
  const decision = await db(req, async (q) => {
    const tcCase = await loadCase(q, office, existing.case_id);
    if (!tcCase) throw new MessagingError('MESSAGE_NOT_SENDABLE', 'This draft is no longer attached to a case.');
    // The address was assembled from the case when the draft was written. If
    // the case's contact info has changed since, this draft is aimed at an
    // address the case no longer holds — refuse rather than send to it.
    if (addressFromCase(channel, tcCase) !== existing.to_address) {
      throw new MessagingError(
        'ADDRESS_CHANGED',
        "The case's contact info changed after this draft was written. Discard it and draft again."
      );
    }
    return consent.canMessage(q, {
      office,
      channel,
      address: existing.to_address,
      odPatientId: tcCase.od_patient_id,
      now,
    });
  });

  if (!decision.allowed) {
    await auditMessage(
      req,
      'UPDATE',
      `tc_message.send_blocked.${String(decision.code).toLowerCase()}`,
      messageId,
      office,
      'UNAUTHORIZED'
    );
    throw new MessagingError(decision.code, decision.message, {
      consentState: decision.consentState,
      odTextConsent: decision.odTextConsent,
    });
  }

  const adapter = adapters.getAdapter(channel);
  if (!adapters.isChannelEnabled(channel)) {
    throw new MessagingError(
      'FEATURE_DISABLED',
      channel === 'sms' ? 'Text messaging is not connected yet.' : 'Email sending is not connected yet.',
      { feature: channel === 'sms' ? 'tc_sms_send' : 'tc_email_send' }
    );
  }

  // draft → sending. Conditional on still being a draft, so two clicks (or two
  // tabs) cannot both proceed: exactly one UPDATE matches.
  const claimed = await db(req, (q) =>
    q.query(
      `UPDATE tc_messages SET status = 'sending', sent_by = $1
        WHERE office_id = $2 AND message_id = $3 AND status = 'draft'
        RETURNING ${MESSAGE_COLS.join(', ')}`,
      [actor, office, messageId]
    )
  );
  if (!claimed.rows.length) {
    throw new MessagingError('MESSAGE_NOT_SENDABLE', 'This message is already being sent.');
  }
  const sending = claimed.rows[0];

  /** @type {import('./adapters').AdapterResult | null} */
  let result = null;
  /** @type {string|null} */
  let failure = null;
  let failureCode = null;
  try {
    const raw = await adapter.send(
      {
        messageId: sending.message_id,
        officeId: office,
        caseId: sending.case_id,
        channel,
        toAddress: sending.to_address,
        body: sending.body,
        subject: sending.subject ?? null,
        templateId: sending.template_id ?? null,
      },
      { officeKey: office, officeName: officeNameOf(office) }
    );
    result = adapters.checkResult(raw);
    if (!result) {
      failure = 'The provider returned a response that did not confirm the hand-off.';
      failureCode = 'ADAPTER_BAD_RESPONSE';
    }
  } catch (err) {
    failure = (err && err.message ? String(err.message) : String(err)).slice(0, 2000);
    failureCode = (err && err.code) || 'ADAPTER_ERROR';
  }

  if (!result) {
    const failed = await db(req, (q) =>
      q.query(
        `UPDATE tc_messages SET status = 'failed', error = $1
          WHERE office_id = $2 AND message_id = $3 AND status = 'sending'
          RETURNING ${MESSAGE_COLS.join(', ')}`,
        [failure, office, messageId]
      )
    );
    console.warn(`[messaging] send failed office=${office} message=${messageId} code=${failureCode}`);
    await auditMessage(req, 'UPDATE', 'tc_message.failed', messageId, office, 'ERROR');
    const row = failed.rows[0] || { ...sending, status: 'failed', error: failure };
    throw new MessagingError('SEND_FAILED', 'The message was not sent: ' + failure, {
      providerCode: failureCode,
      message: toMessage(row),
    });
  }

  const done = await db(req, (q) =>
    q.query(
      `UPDATE tc_messages SET status = $1, provider = $2, provider_message_id = $3, from_address = $4, sent_at = now()
        WHERE office_id = $5 AND message_id = $6 AND status = 'sending'
        RETURNING ${MESSAGE_COLS.join(', ')}`,
      [result.status, result.provider, result.providerMessageId, result.fromAddress, office, messageId]
    )
  );
  await auditMessage(req, 'UPDATE', 'tc_message.sent', messageId, office);
  return toMessage(done.rows[0]);
}

// ── consent writes ──────────────────────────────────────────────────────────

/**
 * Upsert a consent row. Internal: the only callers are recordOptOut (a human)
 * and recordInbound (a STOP keyword). There is deliberately no public way to
 * write `opted_in` in this slice — see RecordOptOutBody in shared/tc/messaging.ts.
 */
async function upsertConsent(q, { office, channel, address, state, source, note, updatedBy }) {
  const res = await q.query(
    `INSERT INTO tc_contact_consent (consent_id, office_id, channel, address, state, source, note, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (office_id, channel, address) DO UPDATE SET state = EXCLUDED.state, source = EXCLUDED.source,
       note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
     RETURNING ${CONSENT_COLS.join(', ')}`,
    [crypto.randomUUID(), office, channel, address, state, source, note ?? null, updatedBy, new Date()]
  );
  return res.rows[0];
}

/** A TC records "the patient asked us not to contact them this way". */
async function recordOptOut(req, office, { caseId, channel, note }) {
  const actor = actorOf(req);
  const row = await db(req, async (q) => {
    const tcCase = await loadCase(q, office, caseId);
    if (!tcCase) throw new MessagingError('CASE_NOT_FOUND', 'Case not found');
    const address = addressFromCase(channel, tcCase);
    if (!address) throw noAddressError(channel);
    return upsertConsent(q, {
      office,
      channel,
      address,
      state: 'opted_out',
      source: 'manual',
      note: note || null,
      updatedBy: actor,
    });
  });
  await auditMessage(req, 'UPDATE', 'tc_contact_consent', row.consent_id, office);
  return toConsent(row);
}

/** Is this inbound body a STOP-family keyword? */
function isStopKeyword(body) {
  if (typeof body !== 'string') return false;
  const word = body.trim().replace(/[.!\s]+$/g, '').toUpperCase();
  return STOP_KEYWORDS.includes(word);
}

/**
 * Record an inbound message (item 39's webhook calls this). `office` must be
 * derived by the CALLER from which practice number/address received it —
 * never from the sender. The row lands unlinked (case_id NULL) in the inbox;
 * linking to a case is a human decision, not a phone-number guess.
 * A STOP-family body also records an opt-out for that sender.
 */
async function recordInbound(req, { office, channel, fromAddress, toAddress = null, body, provider = null, providerMessageId = null }) {
  if (!['roland', 'valley'].includes(office)) throw new Error('[messaging] recordInbound needs a frozen office key');
  const from = normalizeAddress(channel, fromAddress);
  if (!from) throw new MessagingError('NO_ADDRESS', 'Inbound message has no usable sender address.');
  const messageId = crypto.randomUUID();
  const out = await db(req, async (q) => {
    await q.query(
      `INSERT INTO tc_messages (message_id, office_id, case_id, direction, channel, to_address, from_address,
         body, status, provider, provider_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [messageId, office, null, 'inbound', channel, toAddress, from, String(body ?? ''), 'received', provider, providerMessageId]
    );
    let optOut = null;
    if (channel === 'sms' && isStopKeyword(body)) {
      optOut = await upsertConsent(q, {
        office,
        channel,
        address: from,
        state: 'opted_out',
        source: 'stop_keyword',
        note: null,
        updatedBy: 'system:inbound',
      });
    }
    return { row: await loadMessage(q, office, messageId), optOut };
  });
  await auditMessage(req, 'CREATE', 'tc_message', messageId, office);
  if (out.optOut) await auditMessage(req, 'UPDATE', 'tc_contact_consent', out.optOut.consent_id, office);
  return { message: toMessage(out.row), optedOut: Boolean(out.optOut) };
}

module.exports = {
  MESSAGE_COLS,
  CONSENT_COLS,
  STOP_KEYWORDS,
  listMessages,
  listInbox,
  getChannelReadiness,
  draftMessage,
  editDraft,
  discardMessage,
  sendMessage,
  recordOptOut,
  recordInbound,
  isStopKeyword,
  setClockForTests,
  resetClock,
};
