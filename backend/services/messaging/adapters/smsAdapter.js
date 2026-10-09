'use strict';

/**
 * SMS channel adapter — STUB in item 38. Item 39 (Twilio) replaces the body of
 * `send` and flips `enabled`; nothing else in the messaging layer changes.
 *
 * Contract: see ./index.js. In this slice there is NO external provider, so
 * `enabled()` is false and `send()` THROWS FEATURE_DISABLED — fail closed even
 * if a caller forgot to ask `enabled()` first.
 */

const { MessagingError } = require('../errors');

module.exports = {
  channel: 'sms',
  provider: null,
  /** @returns {boolean} */
  enabled() {
    return false;
  },
  /**
   * @param {import('./index').AdapterMessage} _message
   * @param {import('./index').AdapterOffice} _office
   * @returns {Promise<import('./index').AdapterResult>}
   */
  async send(_message, _office) {
    throw new MessagingError('FEATURE_DISABLED', 'Text messaging is not connected yet.', {
      feature: 'tc_sms_send',
    });
  },
};
