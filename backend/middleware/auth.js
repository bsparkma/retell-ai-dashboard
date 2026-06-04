/**
 * Dashboard auth middleware.
 *
 * Why this exists
 * ---------------
 * Until now every /api/* route was unauthenticated — anyone who could reach
 * the backend (LAN, Cloudflare tunnel, exposed port) could read live
 * transcripts, callbacks, Open Dental data, and even kick off Mango syncs.
 * For a HIPAA-relevant dental application this is unacceptable.
 *
 * Design
 * ------
 * Single shared bearer token (`DASHBOARD_API_TOKEN`) — small enough for a
 * pilot office (1 backend, 1 dashboard, 1 ops user) and easy to rotate.
 * Webhooks (`/api/webhooks/*`) and `/api/health` are intentionally
 * exempted; webhooks are authenticated by HMAC, and health needs to be
 * reachable by uptime monitors / PM2.
 *
 * Failure mode
 * ------------
 *   - If `DASHBOARD_API_TOKEN` is unset and `NODE_ENV === 'production'`,
 *     every protected request returns 503 with a setup error. This is
 *     fail-closed by design — we'd rather break the dashboard than
 *     silently serve PHI to the open internet.
 *   - If unset in any non-production env, requests are allowed but a
 *     prominent warning logs once at startup so this isn't accidentally
 *     forgotten.
 */

const crypto = require('crypto');

const ENV_KEY = 'DASHBOARD_API_TOKEN';

let warned = false;

function getExpectedToken() {
  return (process.env[ENV_KEY] || '').trim();
}

/** Constant-time comparison to avoid timing attacks. */
function safeEqual(a, b) {
  const bufA = Buffer.from(a || '');
  const bufB = Buffer.from(b || '');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Pull a bearer token from `Authorization: Bearer <token>` or `?token=`. */
function extractToken(req) {
  const header = req.get && req.get('authorization');
  if (header && /^Bearer\s+/i.test(header)) {
    return header.replace(/^Bearer\s+/i, '').trim();
  }
  if (req.query && typeof req.query.token === 'string') {
    return req.query.token.trim();
  }
  return '';
}

/**
 * Express middleware: enforce bearer token on every protected /api/* route.
 *
 * Mount with a path filter so webhooks and health stay open:
 *   app.use('/api', requireDashboardToken({ exempt: [/^\/webhooks/, /^\/health$/] }));
 */
function requireDashboardToken({ exempt = [] } = {}) {
  return function (req, res, next) {
    const expected = getExpectedToken();

    // Allow exempt paths through unauthenticated.
    const subPath = req.path || '';
    for (const rx of exempt) {
      if (rx.test(subPath)) return next();
    }

    if (!expected) {
      if (process.env.NODE_ENV === 'production') {
        return res.status(503).json({
          success: false,
          error:
            `Server misconfigured: ${ENV_KEY} is not set. ` +
            'Set it in the backend environment, then restart the service.',
        });
      }
      if (!warned) {
        warned = true;
        console.warn(
          `⚠️  ${ENV_KEY} is not set — running unauthenticated. ` +
            'This is allowed in non-production environments only. ' +
            'Set the env var before deploying.'
        );
      }
      return next();
    }

    const provided = extractToken(req);
    if (!safeEqual(provided, expected)) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: missing or invalid bearer token',
      });
    }

    return next();
  };
}

/**
 * Express middleware: allow a request through if it carries EITHER a valid
 * Entra SSO session cookie OR the shared dashboard bearer token. This lets the
 * browser dashboard authenticate via SSO cookies while existing token-based
 * integrations (and dev tooling) keep working unchanged.
 *
 * Exempt paths bypass auth entirely (same semantics as requireDashboardToken).
 */
function requireDashboardAuth({ exempt = [] } = {}) {
  const tokenGate = requireDashboardToken({ exempt });
  return function (req, res, next) {
    const subPath = req.path || '';
    for (const rx of exempt) {
      if (rx.test(subPath)) return next();
    }

    // 1) Entra SSO session cookie (set by /auth/callback).
    try {
      // Lazy require so this file has no hard dependency on SSO config.
      const sso = require('../config/sso');
      const token = req.cookies && req.cookies[sso.cookieName];
      if (token) {
        const claims = sso.verifySession(token);
        if (claims) {
          req.user = { email: claims.email, name: claims.name, tenantId: claims.tid };
          return next();
        }
      }
    } catch (_err) {
      // SSO not available/misconfigured — fall through to the bearer token.
    }

    // 2) Shared dashboard bearer token (backward compatible).
    return tokenGate(req, res, next);
  };
}

/** Extract a single cookie value from the Socket.IO handshake headers. */
function readHandshakeCookie(socket, name) {
  const raw =
    socket && socket.handshake && socket.handshake.headers && socket.handshake.headers.cookie;
  if (!raw || typeof raw !== 'string') return '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch (_err) {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return '';
}

/**
 * Socket.IO middleware: authenticate connections the same way as /api/* —
 * a valid Entra SSO session cookie (`carein_sso`) OR the shared dashboard
 * bearer token. This keeps the whole surface on one auth model so dropping
 * DASHBOARD_API_TOKEN later won't silently break live-call sockets.
 *
 * Browser clients get the cookie automatically once signed in (connect with
 * `io(URL, { withCredentials: true })`); token clients still pass
 * `io(URL, { auth: { token: '<DASHBOARD_API_TOKEN>' } })`.
 */
function socketAuth(socket, next) {
  // 1) Entra SSO session cookie from the handshake.
  try {
    const sso = require('../config/sso');
    const sessionToken = readHandshakeCookie(socket, sso.cookieName);
    if (sessionToken) {
      const claims = sso.verifySession(sessionToken);
      if (claims) {
        socket.user = { email: claims.email, name: claims.name, tenantId: claims.tid };
        return next();
      }
    }
  } catch (_err) {
    // SSO not available/misconfigured — fall through to the bearer token.
  }

  // 2) Shared dashboard bearer token (backward compatible).
  const expected = getExpectedToken();
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      return next(new Error('socket auth misconfigured'));
    }
    return next();
  }
  const provided =
    (socket.handshake && socket.handshake.auth && socket.handshake.auth.token) ||
    (socket.handshake && socket.handshake.query && socket.handshake.query.token) ||
    '';
  if (!safeEqual(String(provided), expected)) {
    return next(new Error('Unauthorized'));
  }
  return next();
}

module.exports = { requireDashboardToken, requireDashboardAuth, socketAuth };
