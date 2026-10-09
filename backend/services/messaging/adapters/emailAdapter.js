'use strict';

/**
 * Email channel adapter: Azure Communication Services Email (queue item 40).
 *
 * Contract: ./index.js. This module only makes the adapter real. The approval
 * click, the consent gate (opt-out, the unsubscribe link, the legacy nurture
 * unsubscribe) and the content assembly stay in ../index.js, ../consent.js and
 * ../emailContent.js, and all of them run BEFORE this is ever called. Email is
 * exempt from quiet hours (../consent.js).
 *
 * Connected for an office only when ALL of these hold (enabledFor):
 *   1. the kill switch says on        config/tcEmail.js (platform_setting
 *                                     'tc_email_enabled' -> env -> OFF)
 *   2. the account is configured      config/acsEmail.js accountConfigured():
 *                                     auth mode + endpoint (or connection
 *                                     string), the public base URL and the
 *                                     tenant slug the unsubscribe link needs
 *   3. THIS office has a sender       ACS_EMAIL_FROM_<OFFICE>, else the shared
 *                                     ACS_EMAIL_FROM
 * Any one missing => that office is FEATURE_DISABLED (501, draft stays a draft).
 *
 * send():
 *   - re-reads the kill switch from the control DB first;
 *   - refuses a message without the html and unsubscribe link the service
 *     assembles (an email with no working unsubscribe link is not sent);
 *   - POSTs once with Operation-Id = our message id (no duplicate at ACS);
 *   - then reads the operation status a few BOUNDED times inside this request:
 *       Succeeded          -> 'sent'   (ACS handed it on. NOT "delivered":
 *                                       basic ACS has no delivery receipt here)
 *       Failed / Canceled  -> throw SEND_FAILED (ACS_<code>), the row is `failed`
 *       still running      -> 'queued' (accepted; we stopped asking)
 *     A status read that fails after the 202 is NOT a failure of the send:
 *     ACS accepted the email, so the row is honestly 'queued'.
 */

const { MessagingError } = require('../errors');
const acsConfig = require('../../../config/acsEmail');
const tcEmail = require('../../../config/tcEmail');
const client = require('../acs/client');

/**
 * Pauses before each status read, in ms. Bounded: at most ~6 s on top of the
 * send itself, inside the TC's own click.
 */
const POLL_DELAYS_MS = Object.freeze([1000, 2000, 3000]);

/**
 * Why email is not available (for an office, when given), or null when it is.
 * Synchronous, no I/O.
 * @param {string} [officeKey]
 * @returns {'switched_off'|'not_configured'|'office_not_configured'|null}
 */
function unavailableReason(officeKey) {
  if (!tcEmail.emailEnabled()) return 'switched_off';
  if (!acsConfig.accountConfigured()) return 'not_configured';
  if (officeKey !== undefined && !acsConfig.fromAddressFor(officeKey)) return 'office_not_configured';
  return null;
}

const DISABLED_SENTENCE = Object.freeze({
  switched_off: 'Email sending is switched off.',
  not_configured: 'Email sending is not connected yet.',
  office_not_configured: 'This office has no sending address set up yet.',
});

/**
 * Map ACS's operation status to ours, or null for "still going".
 * @param {string} status
 * @returns {'sent'|'failed'|null}
 */
function mapOperationStatus(status) {
  if (status === 'Succeeded') return 'sent';
  if (status === 'Failed' || status === 'Canceled') return 'failed';
  return null;
}

module.exports = {
  channel: 'email',
  provider: 'acs',
  POLL_DELAYS_MS,
  mapOperationStatus,

  /** Deployment-level: switched on and the account is configured. @returns {boolean} */
  enabled() {
    return unavailableReason() === null;
  },

  /**
   * Office-level: the above AND this office has a sender.
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
    await tcEmail.refreshFromDb();
    const reason = unavailableReason(office.officeKey);
    if (reason) {
      throw new MessagingError('FEATURE_DISABLED', `${DISABLED_SENTENCE[reason]} Nothing was sent.`, {
        feature: 'tc_email_send',
        reason,
      });
    }
    const cfg = acsConfig.accountConfig();
    const from = acsConfig.fromAddressFor(office.officeKey);
    if (!cfg.mode || !cfg.endpoint || !from) {
      // unavailableReason() said yes a line ago; this only narrows the types.
      throw new MessagingError('FEATURE_DISABLED', 'Email sending is not connected yet. Nothing was sent.', {
        feature: 'tc_email_send',
      });
    }
    if (!message.html || !message.unsubscribeUrl || !message.subject) {
      throw new MessagingError(
        'SEND_FAILED',
        'The email was not assembled with a subject, a body and an unsubscribe link, so it was not sent.',
        { providerCode: 'EMAIL_CONTENT_MISSING' }
      );
    }

    const acsCfg = { mode: cfg.mode, endpoint: cfg.endpoint, accessKey: cfg.accessKey };
    const replyTo = acsConfig.replyToFor(office.officeKey);
    const payload = {
      senderAddress: from,
      recipients: { to: [{ address: message.toAddress }] },
      content: { subject: message.subject, plainText: message.body, html: message.html },
      ...(replyTo ? { replyTo: [{ address: replyTo }] } : {}),
      headers: {
        'List-Unsubscribe': `<${message.unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      // No open/click tracking on a patient email.
      userEngagementTrackingDisabled: true,
    };

    const accepted = await client.sendEmail({ cfg: acsCfg, operationId: message.messageId, payload });

    let final = mapOperationStatus(accepted.status);
    let failure = null;
    if (final === null) {
      for (const slot of POLL_DELAYS_MS) {
        let op;
        try {
          await client.waitMs(slot);
          op = await client.getOperation({ cfg: acsCfg, operationId: accepted.operationId });
        } catch {
          // ACS accepted the email; not being able to READ its status is not
          // a failed send. Stop asking and say what we know: queued.
          break;
        }
        final = mapOperationStatus(op.status);
        if (final === 'failed') failure = op;
        if (final) break;
      }
    }
    if (final === 'failed') {
      const code = (failure && failure.errorCode) || (failure && failure.status) || accepted.status;
      const why = failure && failure.errorMessage ? `: ${failure.errorMessage}` : '.';
      throw new MessagingError('SEND_FAILED', `The email service did not send it (${code})${why}`, {
        providerCode: `ACS_${code}`,
      });
    }
    return {
      provider: 'acs',
      providerMessageId: accepted.operationId,
      status: final === 'sent' ? 'sent' : 'queued',
      fromAddress: from,
    };
  },
};
