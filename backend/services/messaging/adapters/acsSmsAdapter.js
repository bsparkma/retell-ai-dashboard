'use strict';

/**
 * SMS channel adapter — Azure Communication Services (queue item 48).
 *
 * Contract: ./index.js, the same one the Twilio adapter (./smsAdapter.js)
 * implements. The approval click, the consent gate (opt-out > all, OD
 * TxtMsgOk, TCPA quiet hours) and the kill switch semantics stay in ../index.js
 * and ../consent.js and run BEFORE this is ever called.
 *
 * Connected for an office only when ALL of these hold (enabledFor):
 *   1. the kill switch says on        config/tcSms.js ('tc_sms_enabled' → env → OFF)
 *   2. the ACS account is configured  config/acsSms.js accountConfigured()
 *   3. THIS office has an ACS number  TC_SMS_ACS_FROM_<OFFICE>, valid E.164
 * Any one missing ⇒ that office is FEATURE_DISABLED (draft stays a draft).
 * Valley with no number never borrows Roland's.
 *
 * send():
 *   - re-reads the kill switch from the control DB first, so a switch written
 *     a moment ago stops this send rather than the next timer tick;
 *   - sends from the office's own number with delivery reports ON, tagged with
 *     the office key (the report's sender number is still what decides the
 *     office; the tag is only a breadcrumb);
 *   - resolves only on ACS's per-recipient acceptance, with ACS's messageId as
 *     providerMessageId and status 'queued' — never 'sent', never 'delivered':
 *     a 202 means ACS has it, and only a delivery report says more.
 *
 * Provider-side opt-out (ACS enforces it for US toll-free; undocumented for
 * 10DLC) is NOT relied on: our consent layer is the sole authority and has
 * already said yes by the time this runs. If ACS blocks anyway, the delivery
 * report maps to failed-with-reason (../acs/smsStatus.js).
 */

const { MessagingError } = require('../errors');
const acsSms = require('../../../config/acsSms');
const tcSms = require('../../../config/tcSms');
const client = require('../acs/smsClient');

/**
 * Why SMS is not available (for an office, when given) right now, or null.
 * Synchronous, no I/O.
 * @param {string} [officeKey]
 * @returns {'switched_off'|'not_configured'|'office_not_configured'|null}
 */
function unavailableReason(officeKey) {
  if (!tcSms.smsEnabled()) return 'switched_off';
  if (!acsSms.accountConfigured()) return 'not_configured';
  if (officeKey !== undefined && !acsSms.fromNumberFor(officeKey)) return 'office_not_configured';
  return null;
}

/**
 * The FEATURE_DISABLED sentence, naming what is missing (setting NAMES, never
 * values) so whoever reads the error knows which Key Vault entry to create.
 * @param {'switched_off'|'not_configured'|'office_not_configured'} reason
 * @param {string} officeKey
 */
function disabledSentence(reason, officeKey) {
  if (reason === 'switched_off') return 'Text messaging is switched off. Nothing was sent.';
  if (reason === 'office_not_configured') {
    return `No ACS sender is configured for this office (${acsSms.fromEnvVarFor(officeKey)}). Nothing was sent.`;
  }
  return `Text messaging is not connected yet: the ACS account is not configured (${acsSms.missingAccountConfig().join(', ')}). Nothing was sent.`;
}

module.exports = {
  channel: 'sms',
  provider: 'acs',

  /** Deployment-level: switched on and the ACS account is configured. */
  enabled() {
    return unavailableReason() === null;
  },

  /** Office-level: the above AND this office has its own ACS number. @param {string} officeKey */
  enabledFor(officeKey) {
    return unavailableReason(officeKey) === null;
  },

  unavailableReason,

  /** What is missing, by setting name, for a status line. @param {string} officeKey */
  missingFor(officeKey) {
    return acsSms.missingFor(officeKey);
  },

  /**
   * @param {import('./index').AdapterMessage} message
   * @param {import('./index').AdapterOffice} office
   * @returns {Promise<import('./index').AdapterResult>}
   */
  async send(message, office) {
    await tcSms.refreshFromDb();
    const reason = unavailableReason(office.officeKey);
    if (reason) {
      throw new MessagingError('FEATURE_DISABLED', disabledSentence(reason, office.officeKey), {
        feature: 'tc_sms_send',
        reason,
        missing: acsSms.missingFor(office.officeKey),
      });
    }
    const cfg = acsSms.accountConfig();
    const from = acsSms.fromNumberFor(office.officeKey);
    if (!from || !cfg.mode || !cfg.endpoint) {
      // unavailableReason() said yes a line ago; this only narrows the types.
      throw new MessagingError('FEATURE_DISABLED', 'Text messaging is not connected yet. Nothing was sent.', {
        feature: 'tc_sms_send',
      });
    }

    const res = await client.sendSms({
      cfg: { mode: cfg.mode, endpoint: cfg.endpoint, accessKey: cfg.accessKey },
      from,
      to: message.toAddress,
      message: message.body,
      repeatabilityRequestId: message.messageId,
      tag: office.officeKey,
    });
    return { provider: 'acs', providerMessageId: res.messageId, status: 'queued', fromAddress: from };
  },
};
