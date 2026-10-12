'use strict';

/**
 * SMS channel adapter — Twilio (queue item 39).
 *
 * Contract: ./index.js. This module only makes the adapter real; the approval
 * click, the consent gate and quiet hours stay in ../index.js and ../consent.js
 * exactly as item 38 left them, and run BEFORE this is ever called.
 *
 * Connected for an office only when ALL of these hold (enabledFor):
 *   1. the kill switch says on        config/tcSms.js (platform_setting
 *                                     'tc_sms_enabled' → env → OFF)
 *   2. the account is configured      config/twilio.js accountConfigured()
 *   3. THIS office has a sender       TWILIO_FROM_<OFFICE>, valid E.164
 * Any one missing ⇒ that office is FEATURE_DISABLED (501, draft stays a draft).
 * Valley with no number never borrows Roland's.
 *
 * send():
 *   - re-reads the kill switch from the control DB first, so a switch written
 *     a moment ago stops this send rather than the next timer tick;
 *   - sends with BOTH the Messaging Service and the office's From (Twilio then
 *     uses exactly that number, which must belong to the service);
 *   - sets the statusCallback to /api/webhooks/twilio/status/<office>;
 *   - resolves only on Twilio's confirmation, with Twilio's SID as
 *     providerMessageId and 'queued' / 'sent' per ../twilio/status.js.
 */

const { MessagingError } = require('../errors');
const twilioConfig = require('../../../config/twilio');
const tcSms = require('../../../config/tcSms');
const client = require('../twilio/client');
const { mapCreateStatus } = require('../twilio/status');

/**
 * Why SMS is not available (for an office, when given) right now, or null when
 * it is. Synchronous, no I/O.
 * @param {string} [officeKey]
 * @returns {'switched_off'|'not_configured'|'office_not_configured'|null}
 */
function unavailableReason(officeKey) {
  if (!tcSms.smsEnabled()) return 'switched_off';
  if (!twilioConfig.accountConfigured()) return 'not_configured';
  if (officeKey !== undefined && !twilioConfig.fromNumberFor(officeKey)) return 'office_not_configured';
  return null;
}

const DISABLED_SENTENCE = Object.freeze({
  switched_off: 'Text messaging is switched off.',
  not_configured: 'Text messaging is not connected yet.',
  office_not_configured: 'This office has no texting number set up yet.',
});

module.exports = {
  channel: 'sms',
  provider: 'twilio',

  /** Deployment-level: switched on and the account is configured. @returns {boolean} */
  enabled() {
    return unavailableReason() === null;
  },

  /**
   * Office-level: the above AND this office has its own sender.
   * @param {string} officeKey
   * @returns {boolean}
   */
  enabledFor(officeKey) {
    return unavailableReason(officeKey) === null;
  },

  unavailableReason,

  /**
   * @param {import('./index').AdapterMessage} message
   * @param {import('./index').AdapterOffice} office
   * @returns {Promise<import('./index').AdapterResult>}
   */
  async send(message, office) {
    await tcSms.refreshFromDb();
    const reason = unavailableReason(office.officeKey);
    if (reason) {
      throw new MessagingError('FEATURE_DISABLED', `${DISABLED_SENTENCE[reason]} Nothing was sent.`, {
        feature: 'tc_sms_send',
        reason,
      });
    }
    const cfg = twilioConfig.accountConfig();
    const from = twilioConfig.fromNumberFor(office.officeKey);
    const statusCallback = twilioConfig.statusCallbackUrl(office.officeKey);
    if (!from || !statusCallback || !cfg.accountSid || !cfg.apiKeySid || !cfg.apiKeySecret || !cfg.messagingServiceSid) {
      // unavailableReason() said yes a line ago; this only narrows the types.
      throw new MessagingError('FEATURE_DISABLED', 'Text messaging is not connected yet. Nothing was sent.', {
        feature: 'tc_sms_send',
      });
    }

    const res = await client.createMessage({
      accountSid: cfg.accountSid,
      apiKeySid: cfg.apiKeySid,
      apiKeySecret: cfg.apiKeySecret,
      messagingServiceSid: cfg.messagingServiceSid,
      from,
      to: message.toAddress,
      body: message.body,
      statusCallback,
    });

    const status = mapCreateStatus(res.status);
    if (!status) {
      throw new MessagingError(
        'SEND_FAILED',
        `Twilio answered with status "${String(res.status).slice(0, 20)}", which is not a confirmed hand-off.`,
        { providerCode: 'TWILIO_UNEXPECTED_STATUS' }
      );
    }
    return { provider: 'twilio', providerMessageId: res.sid, status, fromAddress: from };
  },
};
