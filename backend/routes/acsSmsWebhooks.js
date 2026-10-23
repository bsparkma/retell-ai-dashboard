'use strict';

/**
 * /api/webhooks/acs-sms — Azure Event Grid delivery of ACS SMS events for TC
 * text messaging (queue item 48).
 *
 *   POST /   one Event Grid delivery: an ARRAY of events (Event Grid schema).
 *            Microsoft.EventGrid.SubscriptionValidationEvent       the handshake
 *            Microsoft.Communication.SMSReceived                   a patient texted us
 *            Microsoft.Communication.SMSDeliveryReportReceived     the carrier outcome
 *                                                                   of a text we sent
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THIS SITS, AND WHY
 * ═════════════════════════════════════════════════════════════════════════════
 * Mounted at /api/webhooks/acs-sms in server.js, ahead of /api/webhooks and
 * INSIDE its exemption from the SSO gate, the tenant gate and the rate limiter
 * — exactly like the Twilio webhook, for the same reason: the caller is a
 * vendor carrying no user identity. No module guard (moduleGateWiring.test.js
 * pins that). The subscription must use the EVENT GRID schema, not
 * CloudEvents.
 *
 * In exchange it authenticates EVERY request itself, in this order, before any
 * event is read:
 *
 *   1. X-CareIN-Webhook-Token, compared in constant time against
 *      TC_SMS_ACS_WEBHOOK_TOKEN (Key Vault). Event Grid sends it as a static,
 *      SECRET delivery property — including on the validation handshake.
 *      Missing / wrong / unconfigured ⇒ 401, a warn line naming only the
 *      reason, and NOTHING read, recorded or opened. The handshake is not
 *      answered either: a subscription without the token cannot be created.
 *      A token in the query string is NOT accepted, so the secret never sits
 *      in a URL that some proxy logs.
 *   2. The tenant, from TC_SMS_ACS_TENANT_SLUG through the control-plane
 *      registry — active and entitled to 'tc'. Opened only when at least one
 *      event in the delivery will actually be recorded.
 *   3. The office, from OUR side of the conversation: the number a text was
 *      sent TO (SMSReceived), the number we sent FROM (delivery report). A
 *      number that is no office's is dropped with a warn and a 200, nothing
 *      recorded — Event Grid would otherwise retry it for a day.
 *
 * AT-LEAST-ONCE: Event Grid redelivers. An inbound message whose ACS
 * messageId is already stored is not stored again (messaging.recordInbound,
 * plus the unique (provider, provider_message_id) index as the backstop for
 * two deliveries racing); a delivery report is a monotonic conditional UPDATE,
 * so a repeat changes nothing. Any unexpected failure answers 500 so Event
 * Grid retries the delivery, which is safe for exactly those reasons.
 *
 * NOTHING HERE SENDS. Not a reply to STOP, not to HELP, not ever. And inbound
 * recording deliberately ignores the `tc_sms_enabled` switch: a STOP that
 * arrives while texting is switched off must still land in consent.
 *
 * PHI: inbound bodies and both numbers are PHI. They go to Postgres via
 * services/messaging and NOWHERE else. Log lines carry the office, the event
 * type and ACS's message id only.
 */

const crypto = require('node:crypto');
const express = require('express');

const registry = require('../platform/registry');
const acsSms = require('../config/acsSms');
const messaging = require('../services/messaging');
const { MessagingError } = require('../services/messaging/errors');
const { normalizePhone } = require('../services/messaging/address');

const router = express.Router();

/** The actor recorded on audit rows this webhook writes. Not a person. */
const WEBHOOK_ACTOR = 'system:acs-sms';
/** The header Event Grid's delivery property carries the shared secret in. */
const TOKEN_HEADER = 'X-CareIN-Webhook-Token';

const EVENT_VALIDATION = 'Microsoft.EventGrid.SubscriptionValidationEvent';
const EVENT_RECEIVED = 'Microsoft.Communication.SMSReceived';
const EVENT_DELIVERY = 'Microsoft.Communication.SMSDeliveryReportReceived';

/** Constant-time compare of two strings of possibly different length. */
function tokenMatches(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !presented || !expected) return false;
  const a = crypto.createHash('sha256').update(presented, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

// ── 1. the shared secret, before anything else ─────────────────────────────

router.use((req, res, next) => {
  const expected = acsSms.webhookToken();
  const presented = req.get(TOKEN_HEADER);
  if (!tokenMatches(presented, expected)) {
    const why = !expected ? 'TC_SMS_ACS_WEBHOOK_TOKEN not configured' : presented ? 'token mismatch' : `no ${TOKEN_HEADER} header`;
    console.warn(`[acs-sms] webhook REFUSED (401) reason=${why}`);
    return res.status(401).json({ success: false, error: 'Unauthorized', code: 'ACS_WEBHOOK_UNAUTHORIZED' });
  }
  return next();
});

// ── 2. the tenant, from the registry, never guessed ────────────────────────

/** Resolve and attach the tenant; false (having answered) when it cannot. */
async function attachTenant(req, res) {
  const slug = acsSms.tenantSlug();
  if (!slug) {
    console.warn('[acs-sms] webhook REFUSED (503): TC_SMS_ACS_TENANT_SLUG is not configured');
    res.status(503).json({ success: false, error: 'Texting is not configured', code: 'ACS_TENANT_UNRESOLVED' });
    return false;
  }
  let tenant;
  let modules;
  try {
    tenant = await registry.getTenantBySlug(slug);
    modules = tenant ? await registry.getEnabledModules(tenant.tenant_id) : [];
  } catch (err) {
    console.error('[acs-sms] webhook REFUSED (503): control plane unreachable:', err && err.message ? err.message : err);
    res.status(503).json({ success: false, error: 'Control plane unavailable', code: 'ACS_TENANT_UNRESOLVED' });
    return false;
  }
  if (!tenant || tenant.status !== 'active') {
    console.warn(`[acs-sms] webhook REFUSED (503): tenant '${slug}' not found or not active`);
    res.status(503).json({ success: false, error: 'Texting is not configured', code: 'ACS_TENANT_UNRESOLVED' });
    return false;
  }
  if (!Array.isArray(modules) || !modules.includes('tc')) {
    console.warn(`[acs-sms] webhook REFUSED (403): tenant '${slug}' is not entitled to 'tc'`);
    res.status(403).json({ success: false, error: 'MODULE_NOT_ENTITLED', module: 'tc' });
    return false;
  }
  req.tenant = { id: tenant.tenant_id, slug: tenant.slug, modules, clinics: [] };
  req.user = { email: WEBHOOK_ACTOR };
  return true;
}

// ── reading events ──────────────────────────────────────────────────────────

/** @param {unknown} v @returns {Record<string, unknown>} */
function obj(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, unknown>} */ (v) : {};
}

/** @param {unknown} v @returns {string|null} */
function str(v) {
  return typeof v === 'string' && v ? v : null;
}

/** ACS message ids are GUID-ish; anything else is not echoed into a log. @param {string|null} id */
function logId(id) {
  return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : 'none';
}

/** Postgres unique-violation (two deliveries of the same inbound racing). */
function isUniqueViolation(err) {
  return Boolean(err && err.code === '23505');
}

/**
 * Turn one event into a unit of work, or a drop. Pure: no I/O, no tenant.
 * @param {Record<string, unknown>} ev
 */
function plan(ev) {
  const type = str(ev.eventType);
  const data = obj(ev.data);
  const messageId = str(data.messageId);
  if (type === EVENT_RECEIVED) {
    const office = acsSms.officeForReceivingNumber(data.to);
    if (!office) return { kind: 'drop', why: 'receiving number is not an office’s', type, messageId };
    return { kind: 'inbound', office, type, messageId, data };
  }
  if (type === EVENT_DELIVERY) {
    // A delivery report's `from` is OUR number: the office that sent it.
    const office = acsSms.officeForReceivingNumber(data.from);
    if (!office) return { kind: 'drop', why: 'sending number is not an office’s', type, messageId };
    if (!messageId || !str(data.deliveryStatus)) return { kind: 'drop', why: 'no messageId/deliveryStatus', type, messageId };
    return { kind: 'delivery', office, type, messageId, data };
  }
  return { kind: 'ignore', type, messageId };
}

// ── POST / ──────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const events = Array.isArray(req.body) ? req.body.map(obj) : null;
  if (!events) {
    console.warn('[acs-sms] webhook payload is not an Event Grid event array (is the subscription on the CloudEvents schema?)');
    return res.status(400).json({ success: false, error: 'Expected an Event Grid event array', code: 'ACS_BAD_EVENT' });
  }

  // The handshake. Answered only after the token passed, and only with the
  // code Event Grid sent — the response carries nothing of ours.
  const validation = events.find((e) => e.eventType === EVENT_VALIDATION);
  if (validation) {
    const code = str(obj(validation.data).validationCode);
    if (!code) return res.status(400).json({ success: false, error: 'No validation code', code: 'ACS_BAD_EVENT' });
    console.log('[acs-sms] Event Grid subscription validation answered');
    return res.status(200).json({ validationResponse: code });
  }

  const work = events.map(plan);
  for (const w of work) {
    if (w.kind === 'drop') console.warn(`[acs-sms] ${w.type} DROPPED (id=${logId(w.messageId)}): ${w.why}`);
  }
  const actionable = work.filter((w) => w.kind === 'inbound' || w.kind === 'delivery');
  if (!actionable.length) return res.status(200).end();
  if (!(await attachTenant(req, res))) return undefined;

  for (const w of actionable) {
    const id = logId(w.messageId);
    try {
      if (w.kind === 'inbound') {
        const r = await messaging.recordInbound(req, {
          office: w.office,
          channel: 'sms',
          fromAddress: str(w.data.from),
          toAddress: normalizePhone(str(w.data.to) || ''),
          body: typeof w.data.message === 'string' ? w.data.message : '',
          provider: 'acs',
          providerMessageId: w.messageId,
          linkOpenCase: true,
        });
        console.log(
          `[acs-sms] inbound recorded office=${w.office} id=${id} linked=${r.message.caseId ? 'yes' : 'no'}` +
            `${r.duplicate ? ' duplicate=yes' : ''}${r.keyword ? ` keyword=${r.keyword}` : ''}`
        );
      } else {
        const status = /** @type {string} */ (str(w.data.deliveryStatus));
        const r = await messaging.applyStatusCallback(req, w.office, {
          provider: 'acs',
          providerMessageId: /** @type {string} */ (w.messageId),
          providerStatus: status,
          errorCode: typeof w.data.deliveryStatusDetails === 'string' ? w.data.deliveryStatusDetails : null,
        });
        if (r.outcome !== 'applied') console.log(`[acs-sms] delivery report for id=${id} office=${w.office}: ${r.outcome}`);
      }
    } catch (err) {
      if (w.kind === 'inbound' && err instanceof MessagingError && err.code === 'NO_ADDRESS') {
        // A sender we cannot normalize (short code, non-US): there is no
        // address to key consent or a thread on. Dropped, loudly.
        console.warn(`[acs-sms] inbound DROPPED office=${w.office} id=${id}: unusable sender number`);
        continue;
      }
      if (w.kind === 'inbound' && isUniqueViolation(err)) {
        console.log(`[acs-sms] inbound office=${w.office} id=${id}: duplicate delivery (already stored)`);
        continue;
      }
      console.error(`[acs-sms] ${w.type} FAILED office=${w.office} id=${id}:`, err && err.message ? err.message : err);
      // 500: Event Grid redelivers the whole batch; dedup + monotonic make that safe.
      return res.status(500).json({ success: false, error: 'Could not record the event', code: 'ACS_EVENT_FAILED' });
    }
  }
  return res.status(200).end();
});

module.exports = router;
module.exports.WEBHOOK_ACTOR = WEBHOOK_ACTOR;
module.exports.TOKEN_HEADER = TOKEN_HEADER;
