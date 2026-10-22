'use strict';

/**
 * /api/webhooks/referral-link — the PUBLIC links in a sent referral email
 * (R5b, closing the loop).
 *
 *   GET  /r?t=<token>   the landing page for one link. Reads, never writes
 *                       (a mail scanner or link prefetcher that GETs every
 *                       link in an email changes nothing). A live link shows
 *                       one button — and, for "scheduled", an optional date.
 *   POST /r             the button (form fields `t`, and `date` for a
 *                       "scheduled" link). Acts, ONCE.
 *
 * The links (minted by services/messaging/referralLetter.js, sent by
 * routes/tc/referralSend.js):
 *
 *   specialist  received   "We received this referral" → the EXISTING
 *                          mark_acknowledged move (sent → acknowledged),
 *                          attributed to `system:specialist-link`, its note
 *                          saying it came from the specialist's link. No new
 *                          status. Already acknowledged or further along →
 *                          nothing to move; the click is still used up.
 *   specialist  scheduled  "The patient is scheduled" ┐ a `patient_scheduled`
 *   patient     scheduled  "I've scheduled my         │ history row (no move),
 *                           appointment"              ┘ and scheduled_date
 *                          when a date is given.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * SECURITY (each line is pinned by routes/tc/tcReferralLinks.test.js)
 * ═════════════════════════════════════════════════════════════════════════════
 *   - The token is the whole credential: 32 random bytes, base64url, minted
 *     per link per sent email. Only its SHA-256 is stored, so a copy of the
 *     database yields no usable link. There is no office, referral, name or
 *     address in the URL.
 *   - OFFICE AND REFERRAL COME FROM THE TOKEN ROW, never from the request. The
 *     only things read from a request are the token and, for a "scheduled"
 *     link, a date. Anything else in it is ignored.
 *   - Unknown, used, expired, malformed and missing tokens all get the SAME
 *     page, byte for byte, on GET and on POST (NEUTRAL_PAGE): no oracle.
 *   - SINGLE USE: the POST consumes the token with a conditional UPDATE
 *     (unused AND unexpired) inside the tenant transaction that writes the
 *     event and the audit row. Of two clicks exactly one acts; a failed
 *     audit rolls everything back, the token included.
 *   - 60-day expiry, checked by that same UPDATE (and by the GET).
 *   - RATE LIMITED: per client (IPv6 by /64) and a ceiling for all clients
 *     together, on GET and POST alike. A throttled client gets 429 and a
 *     plain page, and the FIRST throttled hit of each window is audited (one
 *     row per client per window, not one per hit — auditing a flood hit by
 *     hit would make the flood write to the database).
 *   - AUDITED: every hit that is not throttled writes an audit row — a view
 *     (READ) or a use (UPDATE), SUCCESS for a live link, UNAUTHORIZED for
 *     everything the neutral page answers, ERROR for a refused date. The
 *     endpoint is recorded without its query string, so no token is in the
 *     trail. A failed audit write answers 503 and acts on nothing.
 *   - MINIMUM PHI on the pages: the patient's FIRST name, the practice and
 *     specialist names. No surname, DOB, reason, teeth, notes or files.
 *   - A date must be a real calendar date from 30 days ago to a year ahead
 *     (office time zone); anything else re-asks and uses nothing up.
 *
 * WHERE THIS SITS: like the unsubscribe link (routes/emailWebhooks.js) it is
 * mounted inside the /api/webhooks exemption from the SSO gate, the tenant
 * gate and the app-wide limiter, because a specialist's or patient's browser
 * carries no user identity — which is why it carries its OWN limiter. Its
 * tenant is TC_EMAIL_TENANT_SLUG, resolved through the registry (active and
 * entitled to 'tc'); anything else is 503 and nothing is read or written.
 *
 * PHI: no log line here carries a token, a name or an address.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const { audit } = require('../platform/audit');
const { normalizeIp } = require('../middleware/rateLimit');
const acsConfig = require('../config/acsEmail');
const odOffices = require('../config/odOffices');
const referralLetter = require('../services/messaging/referralLetter');
const { withTenantTx } = require('./tc/tx');
const store = require('./tc/referralStore');
const transitions = require('./tc/referralTransitions');
const letterText = require('./tc/referralLetterText');
const contract = require('../tc/contract.gen.cjs');

/** The actor on rows a hit writes before the token says whose link it is. Not a person. */
const LINK_ACTOR = 'system:referral-link';
/** Who a link's click is attributed to, by the link's audience (shared/tc/referrals.ts). */
const AUDIENCE_ACTOR = contract.REFERRAL_LINK_ACTORS;

/** A token as minted: 32 bytes of base64url. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
/** A date as an <input type="date"> sends it. */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** How far back, and ahead, an appointment date may be. */
const DATE_PAST_DAYS = 30;
const DATE_FUTURE_DAYS = 365;

const WINDOW_MS = 15 * 60 * 1000;
/** Per client: a real click is a GET and a POST (and perhaps a re-asked date). */
const PER_CLIENT_MAX = 20;
/** All clients together: far above any office's real traffic, a ceiling on guessing. */
const ALL_CLIENTS_MAX = 600;

// ── pages ───────────────────────────────────────────────────────────────────

const PAGE_CSS =
  'body{margin:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#0f172a}' +
  'main{max-width:480px;margin:64px auto;padding:32px;background:#fff;border-radius:8px}' +
  'h1{font-size:20px;margin:0 0 12px}p{font-size:15px;line-height:1.6;margin:0 0 16px}' +
  'label{display:block;font-size:14px;margin:0 0 6px}input{font-size:15px;padding:8px;margin:0 0 16px;border:1px solid #cbd5e1;border-radius:6px}' +
  '.err{color:#b91c1c}' +
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

/** Escape for text and attribute values. @param {unknown} v */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The ONE answer for every link that is not live. Names nobody. */
const NEUTRAL_PAGE = page(
  'Referral',
  '<h1>This link is no longer active</h1>' +
    '<p>It may have been used already, or it has expired. If you need to reach the office, please call them.</p>' +
    '<p>You can close this page.</p>'
);

const UNAVAILABLE_PAGE = page(
  'Referral',
  '<h1>We could not process that right now</h1><p>Please try the link again later, or call the office.</p>'
);

const BUSY_PAGE = page('Referral', '<h1>Too many requests</h1><p>Please wait a few minutes, then try the link again.</p>');

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

// ── dates ───────────────────────────────────────────────────────────────────

function officeTimeZone() {
  return process.env.OFFICE_TIMEZONE || 'America/Chicago';
}

/** 'YYYY-MM-DD' for an instant in the office's day. @param {Date} at */
function officeDay(at) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: officeTimeZone(), year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** 'YYYY-MM-DD' ± days, calendar arithmetic. @param {string} ymd @param {number} days */
function addDays(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The window a date may fall in, from the office's today. @param {Date} at */
function dateWindow(at) {
  const today = officeDay(at);
  return { min: addDays(today, -DATE_PAST_DAYS), max: addDays(today, DATE_FUTURE_DAYS) };
}

/**
 * A date from the form: '' / absent → null (no date given, which is fine);
 * a real calendar date inside the window → it; anything else → 'invalid'.
 * @param {unknown} raw @param {Date} at
 * @returns {string|null|'invalid'}
 */
function readDate(raw, at) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return 'invalid';
  const v = raw.trim();
  if (!v) return null;
  const m = DATE_RE.exec(v);
  if (!m) return 'invalid';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const asDate = new Date(Date.UTC(y, mo - 1, d));
  if (asDate.getUTCFullYear() !== y || asDate.getUTCMonth() !== mo - 1 || asDate.getUTCDate() !== d) return 'invalid';
  const { min, max } = dateWindow(at);
  return v < min || v > max ? 'invalid' : v;
}

/** "Tuesday, November 3, 2026" for a 'YYYY-MM-DD'. @param {string} ymd */
function longDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(
    new Date(Date.UTC(y, m - 1, d))
  );
}

// ── what a live link's pages say ────────────────────────────────────────────

/** The names a page may show: first name, practice names. Nothing else. */
function namesOf(office, referral, entry) {
  return {
    first: letterText.nameParts(referral.patient_name).first || 'the patient',
    office: acsConfig.practiceNameFor(office) || odOffices.describeOffice(office).officeName,
    practice: (entry && (entry.practice_name || entry.specialist_name)) || 'the specialist',
  };
}

/** The landing page for a live link, optionally re-asking with an error. */
function landingPage(token, link, names, at, error = '') {
  const hidden = `<input type="hidden" name="t" value="${esc(token)}">`;
  const err = error ? `<p class="err">${esc(error)}</p>` : '';
  if (link.purpose === 'received') {
    return page(
      'Referral received',
      `<h1>Confirm you received this referral</h1>` +
        `<p>${esc(names.office)} sent your office a referral for ${esc(names.first)}. Tap the button to let them know it arrived.</p>` +
        `<form method="post" action="r">${hidden}<button type="submit">${esc(letterText.SPECIALIST_LINK_LABELS.received)}</button></form>`
    );
  }
  const { min, max } = dateWindow(at);
  const dateField =
    '<label for="date">Appointment date (optional)</label>' +
    `<input type="date" id="date" name="date" min="${min}" max="${max}">`;
  if (link.audience === 'patient') {
    return page(
      'Appointment scheduled',
      `<h1>Hi ${esc(names.first)} — thanks for letting us know</h1>` +
        `<p>Tap the button to tell ${esc(names.office)} you've scheduled your appointment with ${esc(names.practice)}.</p>` +
        err +
        `<form method="post" action="r">${hidden}${dateField}<button type="submit">${esc(letterText.PATIENT_LINK_LABEL)}</button></form>`
    );
  }
  return page(
    'Patient scheduled',
    `<h1>Let ${esc(names.office)} know the patient is scheduled</h1>` +
      `<p>For the referral of ${esc(names.first)} to ${esc(names.practice)}.</p>` +
      err +
      `<form method="post" action="r">${hidden}${dateField}<button type="submit">${esc(letterText.SPECIALIST_LINK_LABELS.scheduled)}</button></form>`
  );
}

/** The page after a use. */
function donePage(link, names, { date = null, alreadyMarked = false } = {}) {
  if (link.purpose === 'received') {
    return page(
      'Thank you',
      '<h1>Thank you</h1>' +
        `<p>${alreadyMarked ? `${esc(names.office)} already had this referral marked as received.` : `${esc(names.office)} now knows the referral arrived.`}</p>` +
        '<p>You can close this page.</p>'
    );
  }
  const when = date ? ` for ${esc(longDate(date))}` : '';
  return page('Thank you', `<h1>Thank you</h1><p>${esc(names.office)} now knows the appointment is scheduled${when}.</p><p>You can close this page.</p>`);
}

/** The history row's words for a "scheduled" click. */
function scheduledNote(audience, date) {
  const who = audience === 'patient' ? 'The patient' : "The specialist's office";
  const where = audience === 'patient' ? 'the link in the email we sent them' : 'the link in the referral email';
  return `${who} said the patient is scheduled${date ? ` for ${longDate(date)}` : ''}, from ${where}.`;
}

const RECEIVED_NOTE = "The specialist's office confirmed it received the referral, from the link in the referral email.";

// ── tenant, token, audit ────────────────────────────────────────────────────

/**
 * Resolve the deployment's tenant (the same rule as routes/emailWebhooks.js)
 * and attach it. Returns false when it cannot.
 * @param {import('express').Request} req
 */
async function attachTenant(req) {
  if (req.tenant) return true;
  const slug = acsConfig.tenantSlug();
  if (!slug) {
    console.warn('[referral-link] REFUSED (503): TC_EMAIL_TENANT_SLUG is not configured');
    return false;
  }
  let tenant;
  let modules;
  try {
    tenant = await registry.getTenantBySlug(slug);
    modules = tenant ? await registry.getEnabledModules(tenant.tenant_id) : [];
  } catch (err) {
    console.error('[referral-link] REFUSED (503): control plane unreachable:', err && err.message ? err.message : err);
    return false;
  }
  if (!tenant || tenant.status !== 'active') {
    console.warn('[referral-link] REFUSED (503): the configured tenant is not found or not active');
    return false;
  }
  if (!Array.isArray(modules) || !modules.includes('tc')) {
    console.warn("[referral-link] REFUSED (503): the configured tenant is not entitled to 'tc'");
    return false;
  }
  req.tenant = { id: tenant.tenant_id, slug: tenant.slug, modules, clinics: [] };
  req.user = { email: LINK_ACTOR };
  return true;
}

/** The token from the form body, else the query string. Never logged. @param {import('express').Request} req */
function tokenOf(req) {
  const b = req.body && typeof req.body === 'object' ? req.body.t : undefined;
  if (typeof b === 'string' && b) return b;
  const q = req.query && req.query.t;
  return typeof q === 'string' ? q : '';
}

/**
 * The live link a token names, with its referral and directory entry, or null
 * for every kind of not-live. Read only.
 * @param {import('express').Request} req @param {string} token @param {Date} at
 */
async function liveLink(req, token, at) {
  if (!TOKEN_RE.test(token)) return null;
  const hash = referralLetter.hashLinkToken(token);
  return tenantDb.withTenantDb(req, async (pool) => {
    const link = await store.findLinkToken(pool, hash);
    if (!link || link.used_at != null || !(new Date(link.expires_at).getTime() > at.getTime())) return null;
    const referral = await store.findReferral(pool, link.office_id, String(link.referral_id));
    if (!referral) return null;
    const entry = referral.directory_entry_id ? await store.findEntry(pool, link.office_id, String(referral.directory_entry_id)) : null;
    return { hash, link, referral, entry };
  });
}

/** One audit row for a hit. Throws AuditError on a failed write. */
function auditHit(req, { action, resourceType, result, live = null }) {
  return audit(req, {
    action,
    resourceType,
    resourceId: live ? String(live.link.referral_id) : null,
    result,
    office: live ? live.link.office_id : null,
    endpoint: req.baseUrl + req.path,
  });
}

// ── the router ──────────────────────────────────────────────────────────────

/**
 * The throttle's answer. The FIRST throttled hit of a window (used = limit + 1)
 * is audited; later ones are not (see the header).
 */
function throttled(scope) {
  return async (req, res, _next, options) => {
    const info = req.rateLimit;
    if (info && info.used === info.limit + 1) {
      try {
        if (await attachTenant(req)) {
          await audit(req, {
            action: 'READ',
            resourceType: 'tc_referral.link_throttled',
            resourceId: null,
            result: 'UNAUTHORIZED',
            office: null,
            endpoint: req.baseUrl + req.path,
          });
        }
      } catch (err) {
        console.error('[referral-link] could not audit a throttled client:', err && err.message ? err.message : err);
      }
      console.warn(`[referral-link] THROTTLED (${scope})`);
    }
    res.set('Retry-After', String(Math.ceil(options.windowMs / 1000)));
    send(res, 429, BUSY_PAGE);
  };
}

/**
 * Build the router. A factory so each test gets clean rate-limit buckets; the
 * app mounts the single instance below (maxReplicas=1 — process memory is the
 * shared view, as for the app-wide limiter).
 * @param {{ perClientMax?: number, allClientsMax?: number }} [opts]
 */
function createReferralLinkRouter({ perClientMax = PER_CLIENT_MAX, allClientsMax = ALL_CLIENTS_MAX } = {}) {
  const router = express.Router();

  router.use(
    rateLimit({
      windowMs: WINDOW_MS,
      limit: perClientMax,
      keyGenerator: (req) => `ip:${normalizeIp(req.ip)}`,
      standardHeaders: true,
      legacyHeaders: false,
      handler: throttled('client'),
    })
  );
  router.use(
    rateLimit({
      windowMs: WINDOW_MS,
      limit: allClientsMax,
      keyGenerator: () => 'all',
      standardHeaders: false,
      legacyHeaders: false,
      handler: throttled('all'),
    })
  );

  // ── GET: show, never act ──────────────────────────────────────────────────
  router.get('/r', async (req, res) => {
    if (!(await attachTenant(req))) return send(res, 503, UNAVAILABLE_PAGE);
    const at = transitions.clock();
    const token = tokenOf(req);
    try {
      const live = await liveLink(req, token, at);
      await auditHit(req, { action: 'READ', resourceType: 'tc_referral.link_view', result: live ? 'SUCCESS' : 'UNAUTHORIZED', live });
      if (!live) return send(res, 200, NEUTRAL_PAGE);
      const names = namesOf(live.link.office_id, live.referral, live.entry);
      return send(res, 200, landingPage(token, live.link, names, at));
    } catch (err) {
      console.error('[referral-link] view FAILED (503):', err && err.message ? err.message : err);
      return send(res, 503, UNAVAILABLE_PAGE);
    }
  });

  // ── POST: act, once ───────────────────────────────────────────────────────
  router.post('/r', async (req, res) => {
    if (!(await attachTenant(req))) return send(res, 503, UNAVAILABLE_PAGE);
    const at = transitions.clock();
    const token = tokenOf(req);
    let live;
    try {
      live = await liveLink(req, token, at);
      if (!live) {
        await auditHit(req, { action: 'UPDATE', resourceType: 'tc_referral.link_use', result: 'UNAUTHORIZED' });
        return send(res, 200, NEUTRAL_PAGE);
      }
    } catch (err) {
      console.error('[referral-link] use FAILED (503):', err && err.message ? err.message : err);
      return send(res, 503, UNAVAILABLE_PAGE);
    }

    const { link, referral, entry, hash } = live;
    const office = link.office_id;
    const referralId = String(link.referral_id);
    const names = namesOf(office, referral, entry);

    // A "scheduled" link may carry a date; a bad one re-asks and uses nothing up.
    let date = null;
    if (link.purpose === 'scheduled') {
      date = readDate(req.body && typeof req.body === 'object' ? req.body.date : undefined, at);
      if (date === 'invalid') {
        try {
          await auditHit(req, { action: 'UPDATE', resourceType: 'tc_referral.link_use', result: 'ERROR', live });
        } catch {
          return send(res, 503, UNAVAILABLE_PAGE);
        }
        const { min, max } = dateWindow(at);
        return send(
          res,
          422,
          landingPage(token, link, names, at, `Please enter a date between ${longDate(min)} and ${longDate(max)}, or leave it blank.`)
        );
      }
    }

    // From here the click is attributed to the link, not to a person.
    req.user = { email: AUDIENCE_ACTOR[link.audience] || LINK_ACTOR };
    let done;
    try {
      done = await withTenantTx(req, async (client) => {
        const used = await store.consumeLinkToken(client, { hash, at: at.toISOString() });
        if (!used) return { gone: true };
        const now = await store.findReferral(client, office, referralId);
        if (!now) return { gone: true };

        if (link.purpose === 'received') {
          let alreadyMarked = true;
          if (now.status === 'sent') {
            const moved = await transitions.moveInTx(req, client, { office, referralId, verb: 'mark_acknowledged', note: RECEIVED_NOTE });
            alreadyMarked = !moved.moved;
          }
          await auditTcUse(req, { live, priorState: now.status });
          return { alreadyMarked };
        }

        await store.insertEvent(client, {
          office,
          referralId,
          from: now.status,
          to: now.status,
          actor: req.user.email,
          at: at.toISOString(),
          note: scheduledNote(link.audience, date),
          verb: 'patient_scheduled',
        });
        if (date) await store.setScheduledDate(client, { office, referralId, date });
        // Inside the transaction: a failed audit write rolls the event, the
        // date and the token's use back.
        await auditTcUse(req, { live, priorState: now.status });
        return { date };
      });
    } catch (err) {
      console.error('[referral-link] use FAILED (503):', err && err.message ? err.message : err);
      return send(res, 503, UNAVAILABLE_PAGE);
    }

    if (done.gone) {
      // Raced another click (or expired between the read and the write).
      try {
        req.user = { email: LINK_ACTOR };
        await auditHit(req, { action: 'UPDATE', resourceType: 'tc_referral.link_use', result: 'UNAUTHORIZED' });
      } catch {
        return send(res, 503, UNAVAILABLE_PAGE);
      }
      return send(res, 200, NEUTRAL_PAGE);
    }
    console.log(`[referral-link] used office=${office} purpose=${link.purpose} audience=${link.audience}`);
    return send(res, 200, donePage(link, names, done));
  });

  return router;
}

/** The use's audit row, inside the transaction. */
function auditTcUse(req, { live, priorState }) {
  return audit(req, {
    action: 'UPDATE',
    resourceType: 'tc_referral.link_use',
    resourceId: String(live.link.referral_id),
    result: 'SUCCESS',
    office: live.link.office_id,
    endpoint: req.baseUrl + req.path,
    priorState,
  });
}

module.exports = createReferralLinkRouter();
module.exports.createReferralLinkRouter = createReferralLinkRouter;
module.exports.NEUTRAL_PAGE = NEUTRAL_PAGE;
module.exports.LINK_ACTOR = LINK_ACTOR;
module.exports.AUDIENCE_ACTOR = AUDIENCE_ACTOR;
module.exports.readDate = readDate;
module.exports.PER_CLIENT_MAX = PER_CLIENT_MAX;
module.exports.ALL_CLIENTS_MAX = ALL_CLIENTS_MAX;
