'use strict';

/**
 * The one error type the messaging service throws for a REFUSAL.
 *
 * Every refusal carries a distinct `code` and the HTTP status the route should
 * answer with, so routes/tc/messages.js maps it mechanically and the UI can
 * switch on `code` to render an honest sentence. Anything that is not a
 * MessagingError is a bug and becomes a 500 in the route wrapper.
 *
 * `message` is a sentence for a person. It NEVER contains an address, a body,
 * a patient name, or any other PHI — it is logged and returned verbatim.
 */

/** code → HTTP status. One table so a code cannot drift between call sites. */
const HTTP_STATUS = Object.freeze({
  // consent gate (shared/tc/messaging.ts MessageBlockCode) — all audited
  CONSENT_OPTED_OUT: 403,
  OD_TEXT_CONSENT_NO: 403,
  OD_CONSENT_UNAVAILABLE: 503,
  QUIET_HOURS: 403,
  // lifecycle
  MESSAGE_NOT_FOUND: 404,
  CASE_NOT_FOUND: 404,
  FOLLOWUP_NOT_FOUND: 404,
  MESSAGE_NOT_SENDABLE: 409,
  MESSAGE_NOT_EDITABLE: 409,
  NO_ADDRESS: 409,
  ADDRESS_CHANGED: 409,
  BODY_REQUIRED: 400,
  // adapters
  FEATURE_DISABLED: 501,
  SEND_FAILED: 502,
});

class MessagingError extends Error {
  /**
   * @param {keyof typeof HTTP_STATUS} code
   * @param {string} message a person-readable sentence; never PHI
   * @param {Record<string, unknown>} [extra] extra JSON fields for the response (never PHI)
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'MessagingError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code] || 500;
    this.extra = extra;
  }
}

/** The consent-gate codes — the set that is audited as a BLOCK. */
const BLOCK_CODES = Object.freeze([
  'CONSENT_OPTED_OUT',
  'OD_TEXT_CONSENT_NO',
  'OD_CONSENT_UNAVAILABLE',
  'QUIET_HOURS',
]);

module.exports = { MessagingError, HTTP_STATUS, BLOCK_CODES };
