'use strict';

/**
 * /api/webhooks/twilio — Twilio's two webhooks for TC text messaging (item 39).
 *
 *   POST /inbound          a patient texted one of the practice numbers
 *   POST /status/:office   a delivery report for a text we sent
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THIS SITS, AND WHY
 * ═════════════════════════════════════════════════════════════════════════════
 * Mounted at /api/webhooks/twilio in server.js, i.e. INSIDE the existing
 * /api/webhooks exemption from the SSO gate, the tenant gate and the rate
 * limiter — the same place the Retell webhook lives, and for the same reason:
 * the caller is a vendor carrying no user identity. It is NOT under /api/tc and
 * carries no module guard (backend/test/moduleGateWiring.test.js pins that).
 *
 * In exchange it authenticates EVERY request itself, in this order, before any
 * body field is read:
 *
 *   1. X-Twilio-Signature, validated against TWILIO_AUTH_TOKEN over the URL
 *      rebuilt from TWILIO_WEBHOOK_BASE_URL + the request path (never the Host
 *      header: behind ACA ingress + Caddy it is not the URL Twilio called) and
 *      the RAW form body. Missing / invalid / unconfigured ⇒ 403 + a warn line.
 *   2. The tenant. A webhook has no SSO user for tenantContext to resolve, so
 *      TWILIO_TENANT_SLUG names it and the control-plane registry resolves it —
 *      active, and entitled to 'tc' (requireModule's rule, applied here). Any
 *      failure ⇒ refused, nothing recorded. Never a guessed tenant.
 *   3. The office, from OUR side of the conversation: the receiving number (To)
 *      for inbound, the office segment of the callback URL we signed for
 *      status. An unknown receiving number is dropped with a warn and a 200
 *      (empty TwiML), so Twilio does not retry it — and nothing is recorded.
 *
 * PHI: an inbound body and both phone numbers are PHI. They go to Postgres via
 * services/messaging and NOWHERE else — no log line here carries a number or a
 * body. Log lines carry the office and Twilio's message SID only.
 *
 * Nothing here sends a text. Replies to STOP / HELP are Twilio Advanced
 * Opt-Out's job; this route always answers with empty TwiML.
 */

const express = require('express');

const registry = require('../platform/registry');
const twilioConfig = require('../config/twilio');
const messaging = require('../services/messaging');
const { MessagingError } = require('../services/messaging/errors');
const { normalizePhone } = require('../services/messaging/address');
const { parseForm, isValidSignature } = require('../services/messaging/twilio/signature');

const router = express.Router();

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/** The actor recorded on audit rows a webhook writes. Not a person. */
const WEBHOOK_ACTOR = 'system:twilio';

function twiml(res, status = 200) {
  res.status(status).type('text/xml').send(EMPTY_TWIML);
}

/**
 * The full URL Twilio requested, from the CONFIGURED public base. null when the
 * base is not configured (⇒ every request is refused).
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function publicUrlOf(req) {
  const base = twilioConfig.webhookBaseUrl();
  if (!base) return null;
  return base + req.originalUrl;
}

/** First value per name, for reading fields AFTER the signature has passed. */
function fieldsOf(pairs) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of pairs) if (!(k in out)) out[k] = v;
  return out;
}

// ── 1. signature, before anything else ─────────────────────────────────────

router.use((req, res, next) => {
  const pairs = parseForm(typeof req.rawBody === 'string' ? req.rawBody : '');
  const ok = isValidSignature({
    authToken: twilioConfig.authToken(),
    signature: req.get('X-Twilio-Signature'),
    url: publicUrlOf(req),
    pairs,
  });
  if (!ok) {
    const why = !twilioConfig.authToken()
      ? 'TWILIO_AUTH_TOKEN not configured'
      : !twilioConfig.webhookBaseUrl()
        ? 'TWILIO_WEBHOOK_BASE_URL not configured'
        : req.get('X-Twilio-Signature')
          ? 'signature mismatch'
          : 'no X-Twilio-Signature header';
    console.warn(`[twilio] webhook REFUSED (403) path=${req.path} reason=${why}`);
    return res.status(403).json({ success: false, error: 'Invalid Twilio signature', code: 'TWILIO_SIGNATURE_INVALID' });
  }
  const fields = fieldsOf(pairs);
  // The signature proves the token holder sent it; the account check proves it
  // is OUR account's event and not a sub-account sharing a token by mistake.
  const accountSid = twilioConfig.accountConfig().accountSid;
  if (accountSid && fields.AccountSid && fields.AccountSid !== accountSid) {
    console.warn(`[twilio] webhook REFUSED (403) path=${req.path} reason=account mismatch`);
    return res.status(403).json({ success: false, error: 'Wrong Twilio account', code: 'TWILIO_ACCOUNT_MISMATCH' });
  }
  req.twilioFields = fields;
  return next();
});

// ── 2. the tenant, from the registry, never guessed ────────────────────────

/**
 * Resolve the tenant this deployment's Twilio account belongs to, exactly the
 * shape tenantContext builds, and attach it. Returns false (having answered)
 * when it cannot.
 */
async function attachTenant(req, res) {
  const slug = twilioConfig.tenantSlug();
  if (!slug) {
    console.warn('[twilio] webhook REFUSED (503): TWILIO_TENANT_SLUG is not configured');
    res.status(503).json({ success: false, error: 'Texting is not configured', code: 'TWILIO_TENANT_UNRESOLVED' });
    return false;
  }
  let tenant;
  let modules;
  try {
    tenant = await registry.getTenantBySlug(slug);
    modules = tenant ? await registry.getEnabledModules(tenant.tenant_id) : [];
  } catch (err) {
    console.error(
      '[twilio] webhook REFUSED (503): control plane unreachable:',
      err && err.message ? err.message : err
    );
    res.status(503).json({ success: false, error: 'Control plane unavailable', code: 'TWILIO_TENANT_UNRESOLVED' });
    return false;
  }
  if (!tenant || tenant.status !== 'active') {
    console.warn(`[twilio] webhook REFUSED (503): tenant '${slug}' not found or not active`);
    res.status(503).json({ success: false, error: 'Texting is not configured', code: 'TWILIO_TENANT_UNRESOLVED' });
    return false;
  }
  if (!Array.isArray(modules) || !modules.includes('tc')) {
    console.warn(`[twilio] webhook REFUSED (403): tenant '${slug}' is not entitled to 'tc'`);
    res.status(403).json({ success: false, error: 'MODULE_NOT_ENTITLED', module: 'tc' });
    return false;
  }
  req.tenant = { id: tenant.tenant_id, slug: tenant.slug, modules, clinics: [] };
  req.user = { email: WEBHOOK_ACTOR };
  return true;
}

// ── POST /inbound ───────────────────────────────────────────────────────────

/** Attachments are never fetched or shown; the thread says so honestly. */
function inboundBody(fields) {
  const text = typeof fields.Body === 'string' ? fields.Body : '';
  const media = Number.parseInt(fields.NumMedia || '0', 10);
  if (!Number.isFinite(media) || media <= 0) return text;
  const note =
    media === 1
      ? '[The patient also sent a picture or file. CareIN does not display attachments.]'
      : `[The patient also sent ${media} pictures or files. CareIN does not display attachments.]`;
  return text ? `${text}\n${note}` : note;
}

router.post('/inbound', async (req, res) => {
  const f = req.twilioFields || {};
  const sid = typeof f.MessageSid === 'string' ? f.MessageSid : typeof f.SmsSid === 'string' ? f.SmsSid : null;
  const to = normalizePhone(f.To);
  const office = twilioConfig.officeForReceivingNumber(to);
  if (!office) {
    // Fail closed: never guess which practice a text was meant for. 200 so
    // Twilio does not retry a message no configuration will ever accept.
    console.warn(`[twilio] inbound DROPPED: receiving number is not an office's (sid=${sid || 'none'})`);
    return twiml(res);
  }
  if (!(await attachTenant(req, res))) return undefined;

  try {
    const r = await messaging.recordInbound(req, {
      office,
      channel: 'sms',
      fromAddress: f.From,
      toAddress: to,
      body: inboundBody(f),
      provider: 'twilio',
      providerMessageId: sid,
      linkOpenCase: true,
    });
    console.log(
      `[twilio] inbound recorded office=${office} sid=${sid || 'none'} linked=${r.message.caseId ? 'yes' : 'no'}` +
        `${r.duplicate ? ' duplicate=yes' : ''}${r.keyword ? ` keyword=${r.keyword}` : ''}`
    );
    return twiml(res);
  } catch (err) {
    if (err instanceof MessagingError && err.code === 'NO_ADDRESS') {
      // A sender we cannot normalize (short code, non-US) — there is no
      // address to key consent or a thread on. Dropped, loudly.
      console.warn(`[twilio] inbound DROPPED office=${office} sid=${sid || 'none'}: unusable sender number`);
      return twiml(res);
    }
    console.error(
      `[twilio] inbound FAILED office=${office} sid=${sid || 'none'}:`,
      err && err.message ? err.message : err
    );
    return res.status(500).json({ success: false, error: 'Could not record the message', code: 'TWILIO_INBOUND_FAILED' });
  }
});

// ── POST /status/:office ────────────────────────────────────────────────────

router.post('/status/:office', async (req, res) => {
  const office = req.params.office;
  if (!twilioConfig.isKnownOffice(office)) {
    console.warn('[twilio] status callback DROPPED: unknown office in callback path');
    return res.status(404).json({ success: false, error: 'Unknown office', code: 'INVALID_OFFICE' });
  }
  const f = req.twilioFields || {};
  const sid = typeof f.MessageSid === 'string' ? f.MessageSid : typeof f.SmsSid === 'string' ? f.SmsSid : null;
  const status = typeof f.MessageStatus === 'string' ? f.MessageStatus : typeof f.SmsStatus === 'string' ? f.SmsStatus : null;
  if (!sid || !status) {
    console.warn(`[twilio] status callback DROPPED office=${office}: no MessageSid/MessageStatus`);
    return res.status(200).end();
  }
  if (!(await attachTenant(req, res))) return undefined;
  try {
    const r = await messaging.applyStatusCallback(req, office, {
      provider: 'twilio',
      providerMessageId: sid,
      providerStatus: status,
      errorCode: f.ErrorCode ?? null,
    });
    if (r.outcome !== 'applied') {
      console.log(`[twilio] status ${status} for sid=${sid} office=${office}: ${r.outcome}`);
    }
    return res.status(200).end();
  } catch (err) {
    console.error(
      `[twilio] status callback FAILED office=${office} sid=${sid}:`,
      err && err.message ? err.message : err
    );
    return res.status(500).json({ success: false, error: 'Could not record the status', code: 'TWILIO_STATUS_FAILED' });
  }
});

module.exports = router;
module.exports.WEBHOOK_ACTOR = WEBHOOK_ACTOR;
