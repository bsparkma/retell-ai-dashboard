'use strict';

/**
 * Twilio message status → tc_messages status, and the ORDER statuses may move
 * in (queue item 39). Pure functions; the write lives in ../index.js.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE MAPPING
 * ═════════════════════════════════════════════════════════════════════════════
 *   accepted, scheduled, queued, sending   → queued     (Twilio has it; not yet out)
 *   sent                                   → sent       (handed to the carrier)
 *   delivered, read                        → delivered  (the carrier confirmed it)
 *   undelivered, failed, canceled          → failed     (+ the error code as text)
 *   receiving, received, anything else     → ignored    (not an outbound status)
 *
 * Twilio's own "sending" maps to OUR `queued`, not our `sending`: ours means
 * "a human clicked Send and the adapter has not answered", a state owned by
 * the in-flight request. A callback never touches a row in that state.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * MONOTONIC: A STATUS ONLY EVER MOVES UP THIS LADDER
 * ═════════════════════════════════════════════════════════════════════════════
 *     queued (1)  <  sent (2)  <  failed (3)  <  delivered (4)
 *
 * Callbacks arrive out of order and are re-delivered. The rule is: apply an
 * incoming status only if it ranks STRICTLY higher than the stored one.
 *
 *   - delivered is the top: nothing regresses it. A stale `sent` or `failed`
 *     that arrives after `delivered` is a no-op.
 *   - failed outranks sent: `undelivered` after `sent` is the real carrier
 *     outcome and must show.
 *   - delivered outranks failed: a carrier delivery receipt is proof the text
 *     arrived, so an out-of-order `delivered` after `failed` wins.
 *   - the same status twice is a no-op (idempotent re-delivery), including a
 *     second `failed` with a different error code — the first reason stands.
 */

/** Our statuses a callback may move between, by rank. */
const RANK = Object.freeze({ queued: 1, sent: 2, failed: 3, delivered: 4 });

/** @type {Readonly<Record<string, 'queued'|'sent'|'delivered'|'failed'>>} */
const TWILIO_TO_OURS = Object.freeze({
  accepted: 'queued',
  scheduled: 'queued',
  queued: 'queued',
  sending: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'delivered',
  undelivered: 'failed',
  failed: 'failed',
  canceled: 'failed',
});

/**
 * Plain-language meaning of the Twilio error codes a TC is most likely to see.
 * Unknown codes still show the number, so nothing is hidden.
 */
const ERROR_TEXT = Object.freeze({
  '30003': 'the phone is unreachable or switched off',
  '30004': 'the message was blocked by the carrier or the recipient',
  '30005': 'the number is unknown or no longer in service',
  '30006': 'the number is a landline or cannot receive texts',
  '30007': 'the carrier filtered the message as possible spam',
  '30008': 'the carrier reported an unknown error',
  '30034': 'the sending number is not yet registered for business texting (A2P 10DLC)',
  '21610': 'the recipient has replied STOP to this number',
  '21408': 'texting to this region is not enabled on the account',
  '21614': 'the number is not a mobile number',
});

/**
 * @param {unknown} twilioStatus
 * @returns {'queued'|'sent'|'delivered'|'failed'|null}
 */
function mapStatus(twilioStatus) {
  if (typeof twilioStatus !== 'string') return null;
  return TWILIO_TO_OURS[twilioStatus.trim().toLowerCase()] || null;
}

/**
 * The adapter's answer when Twilio accepts a create-message request. The
 * adapter contract allows only 'sent' | 'queued' here; anything else is not a
 * confirmed hand-off.
 * @param {unknown} twilioStatus
 * @returns {'sent'|'queued'|null}
 */
function mapCreateStatus(twilioStatus) {
  const ours = mapStatus(twilioStatus);
  return ours === 'queued' || ours === 'sent' ? ours : null;
}

/**
 * Statuses a row may be in for `incoming` to replace it — i.e. every status
 * ranked strictly below it. Used as `status = ANY($n)` in a conditional
 * UPDATE, so ordering is enforced by the database, not by a read-then-write.
 * @param {'queued'|'sent'|'delivered'|'failed'} incoming
 * @returns {string[]}
 */
function replaceableBy(incoming) {
  const r = RANK[incoming];
  return Object.keys(RANK).filter((s) => RANK[/** @type {keyof typeof RANK} */ (s)] < r);
}

/**
 * The text stored in tc_messages.error for a failed callback. Never PHI.
 * @param {unknown} code
 * @param {string} twilioStatus
 * @returns {string}
 */
function errorText(code, twilioStatus) {
  // Twilio error codes are 5-digit numbers. Anything else is not a code and is
  // not echoed (a malformed field must not smuggle digits into the row).
  const raw = code == null ? '' : String(code).trim();
  const c = /^\d{1,6}$/.test(raw) ? raw : null;
  const what = c && ERROR_TEXT[c] ? ERROR_TEXT[c] : null;
  if (c) return `Not delivered (Twilio error ${c}${what ? `: ${what}` : ''}).`;
  return `Not delivered (Twilio reported "${String(twilioStatus).slice(0, 20)}").`;
}

module.exports = { RANK, TWILIO_TO_OURS, ERROR_TEXT, mapStatus, mapCreateStatus, replaceableBy, errorText };
