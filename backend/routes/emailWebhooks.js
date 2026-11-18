'use strict';

/**
 * /api/webhooks/email — the PUBLIC unsubscribe link in every TC email
 * (queue item 40).
 *
 *   GET  /unsubscribe?t=<token>   a confirmation page with one button. Reads
 *                                 nothing and writes nothing, so a mail
 *                                 scanner or link prefetcher that GETs every
 *                                 link in an email cannot unsubscribe anyone.
 *   POST /unsubscribe             the button (form field `t`), or a mail
 *                                 client's RFC 8058 one-click POST
 *                                 (`List-Unsubscribe=One-Click`, token in the
 *                                 query string). Records the opt-out.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THIS SITS, AND WHY
 * ═════════════════════════════════════════════════════════════════════════════
 * Mounted at /api/webhooks/email in server.js, i.e. INSIDE the existing
 * /api/webhooks exemption from the SSO gate, the tenant gate and the rate
 * limiter, beside /api/webhooks/twilio and for the same reason: the caller (a
 * patient's browser or mail client) carries no user identity. It is NOT under
 * /api/tc and carries no module guard (backend/test/moduleGateWiring.test.js
 * pins that). No exempt list widened for it.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT A CALLER CAN LEARN: NOTHING
 * ═════════════════════════════════════════════════════════════════════════════
 *   - The token is the whole credential: 32 random bytes, base64url, minted
 *     per sent email. The database stores only its SHA-256. There is no
 *     office, address, name or message id in the URL.
 *   - Every token outcome (recorded, already unsubscribed, unknown, malformed,
 *     missing) gets the SAME 200 page, byte for byte. A caller cannot tell a
 *     live token from a guess.
 *   - The page never names the practice or the address.
 *   - The ONLY other answer is 503 "could not process", and it depends on the
 *     DEPLOYMENT (control plane or database unreachable), never on the token.
 *     An unknown token, or one whose tenant is not active or not entitled to
 *     'tc', gets the SAME 200 page as a bad token (MT-3).
 *   - Fails closed: a bad token records nothing; a failure records nothing.
 *   - Idempotent: a second click changes nothing (services/messaging
 *     recordUnsubscribeLink leaves an existing opt-out untouched).
 *
 * TENANT (MT-3): a public request has no SSO user, so the TOKEN names the
 * tenant. Its hash is looked up in the control-plane public_link_index
 * (platform/publicLinkIndex.js), written when the email was sent; the tenant
 * must be active and entitled to 'tc'. Anything else records nothing and gets
 * the same page as a bad token. Never a guessed tenant. Links sent before the
 * index existed fall back to TC_EMAIL_TENANT_SLUG, logged, only while that
 * setting is present (see publicLinkIndex.js for when it is removed).
 *
 * The kill switch does NOT gate this. An unsubscribe arriving while email is
 * switched off must still be recorded (see config/tcEmail.js).
 *
 * PHI: no log line here carries the token, an address or a name. Log lines
 * carry the outcome and, when recorded, the office only.
 */

const express = require('express');

const publicLinkIndex = require('../platform/publicLinkIndex');
const messaging = require('../services/messaging');

const router = express.Router();

/** The actor recorded on the audit rows a click writes. Not a person. */
const WEBHOOK_ACTOR = 'system:email-unsubscribe';

const PAGE_CSS =
  'body{margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a}' +
  'main{max-width:480px;margin:64px auto;padding:32px;background:#fff;border-radius:8px}' +
  'h1{font-size:20px;margin:0 0 12px}p{font-size:15px;line-height:1.6;margin:0 0 16px}' +
  'button{font-size:15px;padding:10px 20px;border:0;border-radius:6px;background:#0f172a;color:#fff;cursor:pointer}';

/** @param {string} title @param {string} inner */
function page(title, inner) {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    `<title>${title}</title><style>${PAGE_CSS}</style></head><body><main>${inner}</main></body></html>`
  );
}

/** Escape for an attribute value. The token is base64url when valid, but this page echoes whatever came in. */
function attr(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const DONE_PAGE = page(
  'Unsubscribe',
  '<h1>Your request has been received</h1>' +
    '<p>If this link came from one of our emails, that email address will not get any more emails from that office.</p>' +
    '<p>You can close this page.</p>'
);

const UNAVAILABLE_PAGE = page(
  'Unsubscribe',
  '<h1>We could not confirm that request right now</h1>' +
    '<p>Please try the link again later, or call the office and ask them to stop emailing you.</p>'
);

/** @param {import('express').Response} res @param {number} status @param {string} html */
function send(res, status, html) {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    })
    .send(html);
}

/** The token from the form body, else the query string. Never logged. @param {import('express').Request} req */
function tokenOf(req) {
  const b = req.body && typeof req.body === 'object' ? req.body.t : undefined;
  if (typeof b === 'string' && b) return b;
  const q = req.query && req.query.t;
  return typeof q === 'string' ? q : '';
}

/**
 * Resolve the tenant the token names (platform/publicLinkIndex.js) and attach
 * it. 'neutral' for every token that names no usable tenant.
 * @param {import('express').Request} req
 */
function attachTenant(req) {
  return publicLinkIndex.attachLinkTenant(req, {
    token: tokenOf(req),
    kind: 'unsubscribe',
    actor: WEBHOOK_ACTOR,
    logTag: '[email-unsubscribe]',
  });
}

// ── GET: confirm, never act ─────────────────────────────────────────────────

router.get('/unsubscribe', (req, res) => {
  const t = tokenOf(req);
  send(
    res,
    200,
    page(
      'Unsubscribe',
      '<h1>Stop getting these emails?</h1>' +
        '<p>Click the button to stop emails from this office to the address this email was sent to.</p>' +
        '<form method="post" action="">' +
        `<input type="hidden" name="t" value="${attr(t.slice(0, 200))}">` +
        '<button type="submit">Unsubscribe</button></form>'
    )
  );
});

// ── POST: record it ─────────────────────────────────────────────────────────

router.post('/unsubscribe', async (req, res) => {
  const tenant = await attachTenant(req);
  if (tenant === 'unavailable') return send(res, 503, UNAVAILABLE_PAGE);
  if (tenant === 'neutral') {
    // The same page a bad token gets: nothing to record, nothing to say.
    console.log('[email-unsubscribe] outcome=no_match');
    return send(res, 200, DONE_PAGE);
  }
  let outcome;
  try {
    outcome = await messaging.recordUnsubscribeLink(req, tokenOf(req));
  } catch (err) {
    console.error('[email-unsubscribe] FAILED (503):', err && err.message ? err.message : err);
    return send(res, 503, UNAVAILABLE_PAGE);
  }
  console.log(`[email-unsubscribe] outcome=${outcome}`);
  return send(res, 200, DONE_PAGE);
});

module.exports = router;
module.exports.WEBHOOK_ACTOR = WEBHOOK_ACTOR;
module.exports.DONE_PAGE = DONE_PAGE;
