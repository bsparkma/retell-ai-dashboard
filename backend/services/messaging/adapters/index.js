'use strict';

/**
 * The channel adapter registry — the ONE seam a provider plugs into.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE ADAPTER CONTRACT (items 39 SMS and 40 email implement exactly this)
 * ═════════════════════════════════════════════════════════════════════════════
 * An adapter is a module exporting:
 *
 *   channel   'sms' | 'email'            — the registry key
 *   provider  string | null              — e.g. 'twilio', 'acs'; null while a stub
 *   enabled() → boolean                  — is the provider configured AND switched
 *                                          on for this deployment? Synchronous,
 *                                          no I/O.
 *   enabledFor(officeKey) → boolean      — OPTIONAL (added in item 39). Is it
 *                                          connected for THIS office — e.g. does
 *                                          the office have its own sender? When
 *                                          present it is what readiness and the
 *                                          send path ask, so one office with no
 *                                          from-number is FEATURE_DISABLED while
 *                                          the other sends. Must imply enabled().
 *                                          Synchronous, no I/O.
 *   unavailableReason(officeKey) → ChannelUnavailableReason | null
 *                                        — OPTIONAL (item 39). WHY it is off, for
 *                                          an honest sentence in the compose box.
 *   send(message, office) → Promise<AdapterResult>
 *
 * INPUT
 *   message  the tc_messages row being sent, as AdapterMessage below. The
 *            address is the server-assembled, normalized one (E.164 / lower-
 *            cased email). The adapter must not re-derive or alter it.
 *   office   { officeKey, officeName } — the frozen office key the message
 *            belongs to. A provider with per-office senders (from-numbers,
 *            from-addresses) selects by officeKey and THROWS if it has none for
 *            that office. It never falls back to another office's sender.
 *
 * OUTPUT (resolve)
 *   { provider, providerMessageId, status, fromAddress? }
 *     provider           non-empty string
 *     providerMessageId  non-empty string — the provider's id, used later to
 *                        correlate status callbacks
 *     status             'sent' | 'queued' — the provider ACCEPTED the hand-off.
 *                        Resolve ONLY once the provider has confirmed; the row
 *                        is marked with this status verbatim.
 *     fromAddress        optional — the sender the provider used
 *
 * OUTPUT (reject)
 *   Throw. Preferably a MessagingError (../errors.js) with a code; any throw is
 *   caught by the service, which marks the row `failed` and stores the error's
 *   message in tc_messages.error. The service NEVER retries — a failed message
 *   stays failed until a human drafts again. So: do not retry internally
 *   either, beyond what the provider SDK does for a single request. The error
 *   message is stored and shown; it MUST NOT contain the body.
 *
 * A result that does not match the shape above is treated as a failure
 * (`ADAPTER_BAD_RESPONSE`), never as success: a hand-off we cannot prove is not
 * a send.
 *
 * @typedef {{
 *   messageId: string, officeId: string, caseId: string|null, channel: 'sms'|'email',
 *   toAddress: string, body: string, subject: string|null, templateId: string|null,
 * }} AdapterMessage
 * @typedef {{ officeKey: string, officeName: string }} AdapterOffice
 * @typedef {{ provider: string, providerMessageId: string, status: 'sent'|'queued', fromAddress?: string|null }} AdapterResult
 */

const smsAdapter = require('./smsAdapter');
const emailAdapter = require('./emailAdapter');

/** @type {Record<'sms'|'email', { channel: string, provider: string|null, enabled: () => boolean, enabledFor?: (office: string) => boolean, unavailableReason?: (office: string) => string|null, send: Function }>} */
const DEFAULT_ADAPTERS = Object.freeze({ sms: smsAdapter, email: emailAdapter });

let adapters = { ...DEFAULT_ADAPTERS };

/**
 * @param {'sms'|'email'} channel
 */
function getAdapter(channel) {
  const a = adapters[channel];
  if (!a) throw new Error(`[messaging] no adapter registered for channel '${channel}'`);
  return a;
}

/**
 * Is this channel's provider connected — for `office` when given? Never
 * throws — a broken adapter reads as off. An adapter with `enabledFor` is asked
 * per office (and must also say enabled()); one without it answers for every
 * office alike.
 * @param {'sms'|'email'} channel
 * @param {string} [office]
 */
function isChannelEnabled(channel, office) {
  try {
    const a = getAdapter(channel);
    if (!a.enabled()) return false;
    if (office !== undefined && typeof a.enabledFor === 'function') return Boolean(a.enabledFor(office));
    return true;
  } catch {
    return false;
  }
}

/** The closed set an adapter may give as its reason (shared/tc/messaging.ts ChannelUnavailableReason). */
const UNAVAILABLE_REASONS = Object.freeze(['switched_off', 'not_configured', 'office_not_configured']);

/**
 * Why a channel is off for an office, or null when it is connected. An adapter
 * that gives no reason (or an unknown one) reads as 'not_configured'.
 * @param {'sms'|'email'} channel
 * @param {string} office
 * @returns {'switched_off'|'not_configured'|'office_not_configured'|null}
 */
function channelUnavailableReason(channel, office) {
  if (isChannelEnabled(channel, office)) return null;
  try {
    const a = getAdapter(channel);
    const r = typeof a.unavailableReason === 'function' ? a.unavailableReason(office) : null;
    return UNAVAILABLE_REASONS.includes(r) ? r : 'not_configured';
  } catch {
    return 'not_configured';
  }
}

/**
 * Validate an adapter's resolved value against the contract.
 * @param {unknown} r
 * @returns {AdapterResult|null}
 */
function checkResult(r) {
  if (!r || typeof r !== 'object') return null;
  const o = /** @type {Record<string, unknown>} */ (r);
  if (typeof o.provider !== 'string' || !o.provider) return null;
  if (typeof o.providerMessageId !== 'string' || !o.providerMessageId) return null;
  if (o.status !== 'sent' && o.status !== 'queued') return null;
  const fromAddress = typeof o.fromAddress === 'string' && o.fromAddress ? o.fromAddress : null;
  return { provider: o.provider, providerMessageId: o.providerMessageId, status: o.status, fromAddress };
}

/** TESTS ONLY: register a fake adapter for a channel. */
function setAdapterForTests(channel, adapter) {
  adapters[channel] = adapter;
}
/** TESTS ONLY: restore the real adapters. */
function resetAdapters() {
  adapters = { ...DEFAULT_ADAPTERS };
}

module.exports = {
  getAdapter,
  isChannelEnabled,
  channelUnavailableReason,
  UNAVAILABLE_REASONS,
  checkResult,
  setAdapterForTests,
  resetAdapters,
};
