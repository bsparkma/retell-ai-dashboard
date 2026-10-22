'use strict';

/**
 * (R5) The referral letter's way out: the SAME email transport patient email
 * uses — the ACS adapter (adapters/emailAdapter.js), its kill switch, its
 * account config, the consent gate's opt-out rule, the one-time unsubscribe
 * link and the shared renderer's system footer. There is no second email
 * client and no second path to ACS.
 *
 * This file only TRANSPORTS one letter the caller (routes/tc/referralSend.js)
 * composed and decided to send. Whether to send — a person's click, or the
 * office's auto-send-on-approval policy after a doctor's approval — is decided
 * there, never here: like the rest of services/messaging, nothing in this file
 * schedules, retries or sends on its own.
 *
 * What a referral adds to patient email's gates:
 *   - PER-OFFICE SENDER ONLY. The office must have its own ACS_EMAIL_FROM_<OFFICE>;
 *     the shared ACS_EMAIL_FROM is never used for a referral.
 *   - A REPLY-TO. The letter asks the specialist to reply with findings; a
 *     sender address is not a mailbox, so ACS_EMAIL_REPLY_TO_<OFFICE> is
 *     required.
 * And what it keeps, unweakened:
 *   - the transport's own kill switch and "no unsubscribe config → no send"
 *     (accountConfigured needs TC_EMAIL_PUBLIC_BASE_URL + TC_EMAIL_TENANT_SLUG);
 *   - an opted-out address is refused (consent rule 1) — the specialist's
 *     office can unsubscribe like anyone, and then referrals to that address
 *     go out by hand;
 *   - every email carries a working one-time unsubscribe link. Its hash is
 *     stored on the referral's history row (tc_referral_events), and
 *     recordUnsubscribeLink resolves it there.
 *
 * PHI: the address, letter and attachments travel only in the request. No log
 * line here carries any of them; errors are the adapter's scrubbed sentences.
 */

const crypto = require('node:crypto');

const consent = require('./consent');
const adapters = require('./adapters');
const emailAdapter = require('./adapters/emailAdapter');
const emailContent = require('./emailContent');
const { MessagingError } = require('./errors');
const { normalizeEmail } = require('./address');
const acsConfig = require('../../config/acsEmail');
const tcEmail = require('../../config/tcEmail');
const odOffices = require('../../config/odOffices');

/** @param {string} office */
function suffix(office) {
  return String(office).toUpperCase();
}

/**
 * Why a referral letter cannot go out from this office right now, or null.
 * Synchronous: reads the transport's cached kill switch (call
 * refreshTransportSwitch first on a request path that reports it).
 * @param {string} office
 * @returns {'switched_off'|'not_configured'|'office_not_configured'|null}
 */
function unavailableReason(office) {
  const transport = adapters.channelUnavailableReason('email', office);
  if (transport === 'switched_off' || transport === 'not_configured') return transport;
  if (!acsConfig.ownFromAddressFor(office) || !acsConfig.replyToFor(office)) return 'office_not_configured';
  return transport;
}

/** Setting NAMES (never values) this office is missing for a referral letter. @param {string} office */
function missingFor(office) {
  const missing = [];
  if (!tcEmail.emailEnabled()) missing.push(tcEmail.ENV_KEY);
  missing.push(...acsConfig.missingAccountConfig());
  if (!acsConfig.ownFromAddressFor(office)) missing.push(`ACS_EMAIL_FROM_${suffix(office)}`);
  if (!acsConfig.replyToFor(office)) missing.push(`ACS_EMAIL_REPLY_TO_${suffix(office)}`);
  return missing;
}

/** Re-read the transport's kill switch from the control plane. Never throws. */
async function refreshTransportSwitch() {
  try {
    await tcEmail.refreshFromDb();
  } catch {
    // A failed read keeps the cached answer; the send re-reads it anyway.
  }
}

/** The sentence for each reason, for an honest refusal. */
const UNAVAILABLE_SENTENCE = Object.freeze({
  switched_off: 'Email sending is switched off for the practice right now.',
  not_configured: 'Email sending is not connected yet.',
  office_not_configured: 'This office has no referral sending address (and reply-to) set up yet.',
});

/**
 * Refuse unless a letter can go out from this office. The FEATURE_DISABLED
 * error names the reason and the missing setting names.
 * @param {string} office
 */
function assertAvailable(office) {
  const reason = unavailableReason(office);
  if (!reason) return;
  throw new MessagingError('FEATURE_DISABLED', `${UNAVAILABLE_SENTENCE[reason]} Nothing was sent.`, {
    feature: 'tc_referral_email',
    reason,
    missing: missingFor(office),
  });
}

/**
 * The recipient, normalized, or null when the directory value is not one
 * usable address.
 * @param {unknown} raw
 */
function recipientOf(raw) {
  const v = normalizeEmail(raw);
  return v && acsConfig.isEmailAddress(v) ? v : null;
}

/**
 * Consent rule 1 for the specialist's address: an opt-out refuses. (Email
 * never reads Open Dental; the SMS-only rules do not apply.)
 * @param {{ query: Function }} q
 * @param {{ office: string, address: string }} input
 */
async function assertMayEmail(q, { office, address }) {
  const decision = await consent.canMessage(q, { office, channel: 'email', address });
  if (!decision.allowed) {
    throw new MessagingError(
      decision.code || 'CONSENT_OPTED_OUT',
      "The specialist's office unsubscribed this address from our emails, so it was not sent. Send it another way and mark it sent.",
      { consentState: decision.consentState }
    );
  }
}

/**
 * A fresh one-time unsubscribe link: the token (in the email), its hash (for
 * the history row) and the URL. Same scheme as patient email.
 * @returns {{ hash: string, url: string }}
 */
function mintUnsubscribe() {
  const token = crypto.randomBytes(32).toString('base64url');
  const hash = crypto.createHash('sha256').update(token, 'utf8').digest('hex');
  const url = acsConfig.unsubscribeUrl(token);
  if (!url) {
    // accountConfigured() said the base URL is set; this only fails closed.
    throw new MessagingError('FEATURE_DISABLED', 'Email sending is not connected yet. Nothing was sent.', {
      feature: 'tc_referral_email',
      reason: 'not_configured',
    });
  }
  return { hash, url };
}

/**
 * The AdapterMessage for a letter (attachments optional).
 * @param {{ office: string, attemptId: string, toAddress: string,
 *           rendered: { subject: string, html: string, text: string },
 *           unsubscribeUrl: string, attachments?: Array<{ name: string, contentType: string, contentInBase64: string }> }} input
 */
function messageOf({ office, attemptId, toAddress, rendered, unsubscribeUrl, attachments = [] }) {
  return {
    messageId: attemptId,
    officeId: office,
    caseId: null,
    channel: 'email',
    toAddress,
    body: rendered.text,
    subject: rendered.subject,
    templateId: null,
    html: rendered.html,
    unsubscribeUrl,
    ...(attachments.length ? { attachments } : {}),
  };
}

/**
 * Render the composed letter through the shared renderer.
 * @param {{ office: string, subject: string, text: string, unsubscribeUrl: string }} input
 */
function render(input) {
  return emailContent.renderReferralLetter(input);
}

/**
 * The exact size of the request this message would make (attachments' base64
 * included), measured by the transport's own payload builder.
 * @param {ReturnType<typeof messageOf>} message
 * @param {string} office
 */
function requestBytes(message, office) {
  return emailAdapter.requestBytes(message, office);
}

/**
 * Hand ONE letter to the email adapter. Resolves only on the provider's
 * confirmed hand-off (`sent` or `queued` — ACS accepted it); anything else
 * throws, and nothing was sent.
 * @param {ReturnType<typeof messageOf>} message
 * @param {string} office
 * @returns {Promise<{ provider: string, providerMessageId: string, status: 'sent'|'queued', fromAddress: string|null }>}
 */
async function transport(message, office) {
  assertAvailable(office);
  const adapter = adapters.getAdapter('email');
  const raw = await adapter.send(message, { officeKey: office, officeName: odOffices.describeOffice(office).officeName });
  const result = adapters.checkResult(raw);
  if (!result) {
    throw new MessagingError('SEND_FAILED', 'The email service returned a response that did not confirm the hand-off.', {
      providerCode: 'ADAPTER_BAD_RESPONSE',
    });
  }
  return result;
}

module.exports = {
  unavailableReason,
  missingFor,
  refreshTransportSwitch,
  assertAvailable,
  recipientOf,
  assertMayEmail,
  mintUnsubscribe,
  messageOf,
  render,
  requestBytes,
  transport,
};
