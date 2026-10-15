'use strict';

/**
 * ACS SMS delivery report → tc_messages status (queue item 48). Pure
 * functions; the write is messaging.applyStatusCallback, the same monotonic
 * conditional UPDATE Twilio's callbacks use.
 *
 *   deliveryStatus "Delivered"   → delivered
 *   deliveryStatus "Failed"      → failed     (+ an honest reason, below)
 *   anything else                → ignored    (Microsoft documents only these two)
 *
 * The SEND's 202 is mapped by the adapter, not here: a 202 means ACS QUEUED
 * the text (`queued`). `delivered` and `failed` come only from these reports.
 *
 * THE LADDER IS TWILIO'S, NOT A COPY: RANK and replaceableBy are
 * ../twilio/status.js's own, so the two providers can never disagree about
 * which status may replace which (queued < sent < failed < delivered).
 *
 * A FAILED REPORT IS NEVER A SILENT DROP. ACS's `deliveryStatusDetails` is
 * free text. The phrasings that mean "this recipient blocked this sender"
 * (ACS's own toll-free opt-out enforcement, a carrier block) get a
 * plain-language sentence; everything else is shown scrubbed. Either way the
 * row reads `failed` with a reason a human can act on. Our consent layer stays
 * the sole authority for opt-outs: this text only EXPLAINS a provider block,
 * it does not record consent (the patient's STOP, arriving as an inbound
 * message, is what does).
 */

const { RANK, replaceableBy } = require('../twilio/status');
const { scrubNumbers } = require('./smsClient');

/** @type {Readonly<Record<string, 'delivered'|'failed'>>} */
const ACS_TO_OURS = Object.freeze({ delivered: 'delivered', failed: 'failed' });

/** "The recipient (or the carrier on their behalf) has blocked this sender." */
const BLOCKED_PATTERN = /opt(ed)?[\s-]?out|unsubscribed|\bSTOP\b|blocked|blacklist|deny[\s-]?list|suppress/i;

/**
 * @param {unknown} deliveryStatus
 * @returns {'delivered'|'failed'|null}
 */
function mapStatus(deliveryStatus) {
  if (typeof deliveryStatus !== 'string') return null;
  return ACS_TO_OURS[deliveryStatus.trim().toLowerCase()] || null;
}

/**
 * The text stored in tc_messages.error for a failed report. Never PHI.
 * Same (detail, providerStatus) signature as twilio/status.js errorText, so
 * applyStatusCallback can call whichever provider's mapper it was handed.
 * @param {unknown} details  ACS deliveryStatusDetails
 * @param {string} deliveryStatus
 * @returns {string}
 */
function errorText(details, deliveryStatus) {
  const d = typeof details === 'string' ? details.trim() : '';
  if (d && BLOCKED_PATTERN.test(d)) {
    return `Not delivered: the recipient's carrier or the texting service blocked this sender for this number (ACS: ${scrubNumbers(d).slice(0, 200)}).`;
  }
  if (d) return `Not delivered (ACS: ${scrubNumbers(d).slice(0, 200)}).`;
  return `Not delivered (ACS reported "${String(deliveryStatus).slice(0, 20)}" with no detail).`;
}

module.exports = { RANK, ACS_TO_OURS, BLOCKED_PATTERN, mapStatus, errorText, replaceableBy };
