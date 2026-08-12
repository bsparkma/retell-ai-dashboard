'use strict';

/**
 * API rate limiting, keyed on WHO is asking rather than which proxy relayed it.
 *
 * THE INCIDENT (2026-08-12, prod): the dashboard showed its backend-offline banner
 * repeatedly during morning use. The backend never went down — it was answering 429 to
 * every request the dashboard made. The old limiter was
 *
 *     rateLimit({ windowMs: 15 * 60 * 1000, max: 100 })   // production
 *
 * mounted globally and keyed (by default) on `req.ip`. Behind Container Apps ingress →
 * Caddy → backend, `trust proxy: 1` was one hop short, so `req.ip` resolved to Caddy's
 * internal address for EVERY request. The whole practice therefore shared a single bucket
 * of 100 requests per 15 minutes — about 6.7 requests a minute for all users and all
 * tabs — which a polling dashboard exhausts in roughly two minutes of each window.
 *
 * Two things fix that, and the first is the one that matters:
 *
 * 1. KEY ON THE AUTHENTICATED USER. Two signed-in people get two budgets no matter how
 *    many proxies sit in front, so the limiter's correctness no longer depends on getting
 *    the hop count exactly right. That is deliberate: `trust proxy` is a deployment
 *    detail that changes when the topology changes, and a mistake there should cost an
 *    imprecise anonymous bucket, never a practice-wide outage.
 *
 * 2. A budget sized for a polling dashboard. 600/15min per user is ~40 requests a minute
 *    — generous for a handful of tabs refreshing lists, still a real ceiling. Anonymous
 *    callers keep a much tighter bucket, since a request with no identity is either a
 *    sign-in attempt or something that has no business here.
 *
 * EXEMPTIONS ARE THE SAFETY-CRITICAL PART. The old limiter was mounted above the auth
 * gate and the tenant gate, both of which carefully exempt webhooks, health and the live
 * Retell tools path. The limiter exempted nothing, so a burst of dashboard polling could
 * have 429'd an inbound `call_analyzed` webhook — and a dropped webhook is a call that
 * silently never reaches a chart, which is a worse failure than the one this file fixes.
 * It never actually happened (verified: zero webhook/health 429s in the 48h before the
 * fix) but only because the office's browsers happened not to exhaust the bucket in the
 * seconds a webhook was arriving. That is luck, not design.
 */

const rateLimit = require('express-rate-limit');

const WINDOW_MS = 15 * 60 * 1000;

/**
 * Per-signed-in-user budget. ~40 req/min sustained. The dashboard's steady state is a
 * connectivity ping plus a freshness poll plus list refreshes on navigation; this leaves
 * room for several tabs and a burst of page loads without ever being the reason someone
 * sees an error.
 */
const AUTHENTICATED_MAX = 600;

/**
 * Anonymous budget, keyed on client IP. Deliberately much tighter: everything the
 * dashboard does is authenticated, so this covers sign-in redirects and unattributed
 * traffic. Kept above a handful so a genuine sign-in flow (several redirects) is never
 * throttled.
 */
const ANONYMOUS_MAX = 60;

/**
 * Paths the limiter must NEVER touch. Same set the auth gate and tenantContext exempt
 * (backend/server.js), for the same reasons, and they must stay in step:
 *
 *   /api/webhooks/*     Retell + Mango call events. HMAC-verified, not user traffic.
 *                       A 429 here is a permanently lost call event.
 *   /api/health         Uptime monitors and the dashboard's connectivity probe. A
 *                       throttled health check reports an outage that isn't happening.
 *   /api/retell-tools/* The LIVE voice agent calling back mid-call. HMAC-verified.
 *                       A 429 here degrades a real patient conversation.
 *
 * Matched against the full request path, because this middleware is mounted app-wide.
 */
const EXEMPT_PATHS = [
  /^\/api\/webhooks(\/|$)/,
  /^\/api\/health\/?$/,
  /^\/api\/retell-tools(\/|$)/,
];

/** Request path without the query string. */
function pathOf(req) {
  const raw = req.originalUrl || req.url || '';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/** Is this a path the limiter must not apply to? */
function isExempt(req) {
  const p = pathOf(req);
  return EXEMPT_PATHS.some((rx) => rx.test(p));
}

/**
 * Who is making this request?
 *
 * Resolved independently of the auth gate so the limiter can sit ABOVE it and still
 * bucket per user — `req.user` is only populated on /api, and /auth needs limiting too.
 * Order mirrors requireDashboardAuth: SSO session cookie first, shared bearer second.
 *
 * @returns {{ kind: 'user'|'token'|'anon', key: string }}
 */
function principalOf(req) {
  // Already resolved upstream (limiter mounted below the auth gate, or in tests).
  if (req.user && req.user.email) {
    return { kind: 'user', key: `user:${String(req.user.email).toLowerCase()}` };
  }

  // Entra SSO session cookie — the normal dashboard path.
  try {
    const sso = require('../config/sso');
    const token = req.cookies && req.cookies[sso.cookieName];
    if (token) {
      const claims = sso.verifySession(token);
      if (claims && claims.email) {
        return { kind: 'user', key: `user:${String(claims.email).toLowerCase()}` };
      }
    }
  } catch (_err) {
    // SSO not configured (dev/test) — fall through.
  }

  // Shared dashboard bearer token: a legitimate non-browser principal (scripts, the
  // send-to-TC loopback). It gets the authenticated budget but its OWN bucket, so a
  // runaway script cannot spend a person's allowance or vice versa.
  const header = req.get && req.get('authorization');
  const expected = (process.env.DASHBOARD_API_TOKEN || '').trim();
  if (expected && header && /^Bearer\s+/i.test(header)) {
    const presented = header.replace(/^Bearer\s+/i, '').trim();
    if (presented === expected) return { kind: 'token', key: 'token:dashboard' };
  }

  // Nobody we recognize. `req.ip` is only as good as `trust proxy`, which is exactly
  // why identified callers above never depend on it.
  return { kind: 'anon', key: `ip:${normalizeIp(req.ip)}` };
}

/**
 * Collapse an IPv6 address to its /64 prefix so one allocation is one bucket.
 *
 * A residential IPv6 assignment is typically a whole /64, so keying on the full address
 * would let a single subscriber rotate through billions of addresses and never be
 * limited. IPv4 is returned unchanged. (express-rate-limit ships an `ipKeyGenerator`
 * helper for this, but not in the 7.5.x we pin — hence doing it here.)
 * @param {string|undefined} ip
 * @returns {string}
 */
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  // IPv4, or IPv4-mapped IPv6 (::ffff:1.2.3.4) — use as-is.
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const groups = ip.split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}

/**
 * Build a limiter with its OWN counter store.
 *
 * A factory rather than a bare singleton because the store is in-memory and per-instance:
 * tests need a clean bucket per case, and sharing one instance across them makes each
 * test's outcome depend on which tests ran before it. (In production the single instance
 * below is correct — the app runs at maxReplicas=1, so process memory IS the shared view.
 * If that ever changes, this is where a shared store would be injected.)
 */
function createApiRateLimiter() {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit: (req) => (principalOf(req).kind === 'anon' ? ANONYMOUS_MAX : AUTHENTICATED_MAX),
    keyGenerator: (req) => principalOf(req).key,
    skip: isExempt,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const retryAfter = Math.ceil(WINDOW_MS / 1000);
      res.set('Retry-After', String(retryAfter));
      // A structured code so the dashboard can render "busy, retrying" instead of
      // "the backend is offline" — being throttled is not being down, and telling a
      // user the wrong one sends them to restart something that is working fine.
      res.status(429).json({
        success: false,
        error: 'Too many requests — slow down and try again shortly.',
        code: 'RATE_LIMITED',
        retryAfter,
      });
    },
  });
}

/** The instance server.js mounts. */
const apiRateLimiter = createApiRateLimiter();

module.exports = {
  apiRateLimiter,
  createApiRateLimiter,
  // Exported for tests and for anyone auditing the exemption set.
  principalOf,
  isExempt,
  normalizeIp,
  WINDOW_MS,
  AUTHENTICATED_MAX,
  ANONYMOUS_MAX,
  EXEMPT_PATHS,
};
