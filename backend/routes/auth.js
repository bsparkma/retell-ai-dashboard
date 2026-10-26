'use strict';

/**
 * Entra SSO auth routes (mounted at /auth, OUTSIDE the /api bearer gate).
 *
 *   GET  /auth/login     -> redirect to Microsoft sign-in (auth-code + PKCE)
 *   GET  /auth/callback  -> exchange code, enforce tenant+domain, set session cookie
 *   GET  /auth/me        -> { authenticated, user?, tenant?, role, isSuperAdmin, homeOffice,
 *                            permissions[] } from the session cookie
 *   POST /auth/logout    -> clear the session cookie (JSON)
 *   GET  /auth/logout    -> clear cookie + redirect (browser convenience)
 *
 * Only careindent-tenant accounts on the allowed domain (carein.ai) may sign in.
 *
 * The EXTERNAL door (S2b) sits beside it — Entra External ID, where people
 * outside careindent sign in with Google or an email one-time code:
 *
 *   GET  /auth/providers     -> { microsoft: true, external: boolean } (no auth, no secrets)
 *   GET  /auth/ext/login     -> redirect to the External ID authority (auth-code + PKCE)
 *   GET  /auth/ext/callback  -> verified email → app_user row → bind → session cookie
 *
 * SHIPS DARK: until config/extSso.js is fully configured the two /ext routes
 * 404 and /auth/providers says external:false. The staff routes above do not
 * change in behavior.
 */

const express = require('express');
const sso = require('../config/sso');
const extSso = require('../config/extSso');
const { resolveUserContext } = require('../middleware/tenantContext');
const { permissionsForRole } = require('../config/permissions');
const registry = require('../platform/registry');
const userContext = require('../platform/userContext');
const { auditForTenant } = require('../platform/audit');
const { isVoiceLabEnabled } = require('../config/voiceLab');
const { isHygVoiceEnabled } = require('../config/hygVoice');

const router = express.Router();

// Single-process pilot: keep PKCE verifier + state in memory, short-lived.
// `door` is set only by /ext/login, so a state is redeemable at exactly one callback.
/** @type {Map<string, { codeVerifier: string, createdAt: number, door?: 'external' }>} */
const pendingAuth = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function cleanupPending() {
  const now = Date.now();
  for (const [state, entry] of pendingAuth) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingAuth.delete(state);
  }
}

router.get('/login', async (req, res) => {
  if (!sso.isConfigured()) {
    return res.status(503).send('SSO is not configured on this server.');
  }
  try {
    cleanupPending();
    const crypto = sso.getCryptoProvider();
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    pendingAuth.set(state, { codeVerifier: verifier, createdAt: Date.now() });

    const authUrl = await sso.getClient().getAuthCodeUrl({
      scopes: sso.scopes,
      redirectUri: sso.redirectUri,
      responseMode: 'query',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
      prompt: 'select_account',
    });
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[sso] /login error:', err && err.message ? err.message : err);
    return res.status(500).send('Unable to start sign-in.');
  }
});

router.get('/callback', async (req, res) => {
  if (!sso.isConfigured()) {
    return res.status(503).send('SSO is not configured on this server.');
  }
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (req.query.error) {
    // User cancelled or consent failure — don't leak details.
    return res.status(401).send('Sign-in was cancelled or failed.');
  }

  const pending = state ? pendingAuth.get(state) : undefined;
  if (!code || !pending) {
    return res.status(400).send('Invalid or expired sign-in request. Please try again.');
  }
  pendingAuth.delete(state);

  try {
    const result = await sso.getClient().acquireTokenByCode({
      code,
      scopes: sso.scopes,
      redirectUri: sso.redirectUri,
      codeVerifier: pending.codeVerifier,
    });

    const account = result && result.account;
    if (!account) {
      return res.status(401).send('Sign-in failed: no account returned.');
    }

    // Enforce single tenant (careindent).
    if (String(account.tenantId || '').toLowerCase() !== sso.allowedTenantId) {
      return res.status(403).send('This account is not part of the CareIN organization.');
    }

    const email = String(account.username || '').toLowerCase();
    if (sso.allowedDomain && !email.endsWith('@' + sso.allowedDomain)) {
      return res.status(403).send(`Only @${sso.allowedDomain} accounts may sign in.`);
    }

    const token = sso.issueSession({
      sub: account.homeAccountId,
      oid: account.localAccountId,
      name: account.name || email,
      email,
      tid: account.tenantId,
    });

    res.cookie(sso.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: sso.cookieSecure,
      maxAge: sso.sessionTtlSeconds * 1000,
      path: '/',
    });

    return res.redirect(sso.postLoginRedirect);
  } catch (err) {
    console.error('[sso] /callback error:', err && err.message ? err.message : err);
    return res.status(401).send('Sign-in failed.');
  }
});

router.get('/me', async (req, res) => {
  const token = req.cookies ? req.cookies[sso.cookieName] : undefined;
  const claims = token ? sso.verifySession(token) : null;
  if (!claims) {
    return res.status(401).json({ authenticated: false });
  }

  // Surface the tenant (practice) so the SPA can show its name, plus its
  // enabled modules so the shell knows which products to render, plus the
  // caller's role and the actions it holds so the shell can hide what they
  // cannot do. Degrades to null/[] if the control DB is unreachable — auth
  // status must not depend on it.
  //
  // ALL OF THIS IS UI HIDING ONLY. The server-side requireModule() and
  // requirePermission() 403s are the source of truth; a client that ignores
  // `permissions` gains nothing.
  let tenant = null;
  let role = null;
  let isSuperAdmin = false;
  let homeOffice = null;
  try {
    const resolved = await resolveUserContext({
      email: claims.email,
      tenantId: claims.tid,
      // Absent on every staff session; 'external' keeps an external-door
      // session away from the staff bootstrap fallback.
      idp: claims.idp,
    });
    role = resolved.role;
    isSuperAdmin = resolved.isSuperAdmin;
    homeOffice = resolved.homeOffice;
    if (resolved.tenant) {
      let modules = [];
      try {
        modules = await registry.getEnabledModules(resolved.tenant.tenant_id);
      } catch (_err) {
        // modules lookup failed — degrade to an empty list, keep auth working
      }
      tenant = { slug: resolved.tenant.slug, displayName: resolved.tenant.display_name, modules };
    }
  } catch (_err) {
    // control plane unavailable — return the user without tenant/role context.
    // permissions below is then [], which hides everything rather than
    // optimistically showing actions the server would refuse.
  }

  return res.json({
    authenticated: true,
    user: { name: claims.name, email: claims.email, tenantId: claims.tid },
    tenant,
    role,
    isSuperAdmin,
    permissions: permissionsForRole(role, { isSuperAdmin }),
    // Which office to DEFAULT their picker to. Unlike `permissions` this hides
    // nothing and grants nothing — every office stays reachable, so a client
    // that ignores it simply starts on "all offices".
    homeOffice,
    // Whether the staging-only voice lab is mounted on THIS server (queue item
    // 34). The same decision the mount used, so the link can never point at a
    // 404 — and in production it is false whatever VOICE_LAB says.
    voiceLab: isVoiceLabEnabled(),
    // Whether perio voice entry answers on THIS server (queue item 35): the
    // same per-request predicate the token route checks, so the perio sheet
    // never offers an Arm button that would 404. HYG_VOICE must be exactly '1'.
    hygVoice: isHygVoiceEnabled(),
  });
});

// ── the external door (S2b) ─────────────────────────────────────────────────

/**
 * Which sign-in buttons the SPA should draw. No auth, no secrets — booleans
 * only. `external` is false until every external setting is present, so the
 * button never points at a 404.
 */
router.get('/providers', (req, res) => {
  return res.json({ microsoft: true, external: extSso.isConfigured() });
});

const PAGE_TEXT = Object.freeze({
  notConfigured: 'Not found.',
  cancelled: 'Sign-in was cancelled or failed.',
  expired: 'Invalid or expired sign-in request. Please try again.',
  failed: 'Sign-in failed.',
  noAccount: 'Sign-in failed: no account returned.',
  unverified:
    "We couldn't confirm the email address on that account. Sign in with an account whose email address is verified.",
  noAccess: "This email doesn't have access yet. Ask your practice administrator to add you.",
  conflict:
    "This account can't be used to sign in here. If you think that's a mistake, ask your practice administrator.",
  unavailable: 'Sign-in is temporarily unavailable. Please try again in a few minutes.',
});

/**
 * A plain refusal page — the same few words a person needs, a way back to the
 * sign-in screen, and nothing else: no stack, no claim values, no hint about
 * what is stored for the address. Every message is one of PAGE_TEXT's fixed
 * strings, so nothing request-supplied is ever written into the HTML.
 * @param {import('express').Response} res
 * @param {number} status
 * @param {keyof typeof PAGE_TEXT} key
 */
function refusalPage(res, status, key) {
  const message = PAGE_TEXT[key];
  return res
    .status(status)
    .type('html')
    .send(
      '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>CareIN Dashboard</title>' +
        '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
        'font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#f6f7f9;color:#1f2933;padding:16px}' +
        '.card{max-width:24rem;background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:32px;text-align:center}' +
        'h1{font-size:1.25rem;margin:0 0 12px}p{font-size:.9rem;line-height:1.45;color:#52606d;margin:0 0 20px}' +
        'a{color:#0f766e;font-size:.9rem}</style></head><body><div class="card">' +
        '<h1>CareIN Dashboard</h1>' +
        `<p>${message}</p>` +
        `<a href="${sso.postLoginRedirect}">Back to sign-in</a>` +
        '</div></body></html>'
    );
}

/**
 * TRUST ONLY VERIFIED EMAILS. The External ID token must carry an `email`
 * claim and a `sub`; and an `email_verified` of false (boolean or string) is a
 * refusal. Federated sign-ins (Google) are where that claim can say false;
 * an email one-time code proves the mailbox by construction. Either way, an
 * address we cannot trust never reaches the app_user lookup.
 * @param {Record<string, unknown>} claims the ID token claims
 * @returns {{ email: string, sub: string, oid: string, name: string } | null}
 */
function verifiedIdentity(claims) {
  const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!email || !email.includes('@') || !sub) return null;
  if (claims.email_verified === false || claims.email_verified === 'false') return null;
  return {
    email,
    sub,
    oid: typeof claims.oid === 'string' ? claims.oid : sub,
    name: typeof claims.name === 'string' && claims.name ? claims.name : email,
  };
}

/**
 * BIND ON FIRST SIGN-IN, or check the binding on every later one.
 *
 *   'entra' row                  → refuse: a staff Microsoft account is never
 *                                  taken over through this door. Every row
 *                                  that existed before S2b is 'entra' (the
 *                                  1789300000000 backfill), so ONLY a row
 *                                  added after it can ever be bound here.
 *   unbound (auth_provider NULL) → bind to this sub (atomic; a lost race is
 *                                  re-read and judged like any other row)
 *   bound to this sub            → ok
 *   bound to a different sub     → refuse
 *   the sub already owns a row   → refuse (unique index, pg 23505)
 *
 * @returns {Promise<'ok' | 'refuse' | 'gone'>}
 */
async function bindExternalIdentity(tenantId, email, sub) {
  const judge = (b) => (b.auth_provider === 'external' && b.external_sub === sub ? 'ok' : 'refuse');

  const binding = await registry.getExternalBinding(tenantId, email);
  if (!binding) return 'gone';
  if (binding.auth_provider === 'entra') return 'refuse';
  if (binding.external_sub !== null) return judge(binding);

  try {
    if (await registry.bindExternalSub(tenantId, email, sub)) return 'ok';
  } catch (err) {
    if (err && err.code === '23505') return 'refuse';
    throw err;
  }
  const again = await registry.getExternalBinding(tenantId, email);
  return again ? judge(again) : 'gone';
}

router.get('/ext/login', async (req, res) => {
  if (!extSso.isConfigured()) {
    return res.status(404).send(PAGE_TEXT.notConfigured);
  }
  try {
    cleanupPending();
    const crypto = sso.getCryptoProvider();
    const { verifier, challenge } = await crypto.generatePkceCodes();
    const state = crypto.createNewGuid();
    // Same store and TTL as the staff door, tagged so a state minted here can
    // only ever be redeemed at /ext/callback.
    pendingAuth.set(state, { codeVerifier: verifier, createdAt: Date.now(), door: 'external' });

    const authUrl = await extSso.getClient().getAuthCodeUrl({
      scopes: [...extSso.scopes],
      redirectUri: extSso.redirectUri(),
      responseMode: 'query',
      codeChallenge: challenge,
      codeChallengeMethod: 'S256',
      state,
      prompt: 'select_account',
    });
    return res.redirect(authUrl);
  } catch (err) {
    console.error('[extsso] /ext/login error:', err && err.message ? err.message : err);
    return res.status(500).send('Unable to start sign-in.');
  }
});

router.get('/ext/callback', async (req, res) => {
  if (!extSso.isConfigured()) {
    return res.status(404).send(PAGE_TEXT.notConfigured);
  }

  // a. state / code exchange — the staff callback's handling and wording.
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (req.query.error) {
    return refusalPage(res, 401, 'cancelled');
  }
  const pending = state ? pendingAuth.get(state) : undefined;
  if (!code || !pending || pending.door !== 'external') {
    return refusalPage(res, 400, 'expired');
  }
  pendingAuth.delete(state);

  /** @type {Record<string, unknown> | undefined} */
  let claims;
  try {
    const result = await extSso.getClient().acquireTokenByCode({
      code,
      scopes: [...extSso.scopes],
      redirectUri: extSso.redirectUri(),
      codeVerifier: pending.codeVerifier,
    });
    claims = result && result.idTokenClaims ? result.idTokenClaims : undefined;
  } catch (err) {
    console.error('[extsso] /ext/callback error:', err && err.message ? err.message : err);
    return refusalPage(res, 401, 'failed');
  }
  if (!claims) {
    return refusalPage(res, 401, 'noAccount');
  }

  // b. only a verified email is trusted.
  const identity = verifiedIdentity(claims);
  if (!identity) {
    return refusalPage(res, 403, 'unverified');
  }

  try {
    // c. the app_user row is the SOLE gate on this door: no bootstrap
    //    fallback, no domain rule. No row and a disabled row read the same.
    const { appUser } = await userContext.getUserContext(identity.email);
    if (!appUser || appUser.status === 'disabled') {
      return refusalPage(res, 403, 'noAccess');
    }

    // d. bind on first sign-in; refuse a different identity, or a staff row.
    const bound = await bindExternalIdentity(appUser.tenant_id, identity.email, identity.sub);
    if (bound === 'gone') {
      return refusalPage(res, 403, 'noAccess');
    }
    if (bound === 'refuse') {
      try {
        // Actor = the address that tried. resource_id = the row it tried for.
        req.user = { email: identity.email };
        await auditForTenant(req, appUser.tenant_id, {
          action: 'UPDATE',
          resourceType: 'app_user',
          resourceId: identity.email,
          result: 'UNAUTHORIZED',
        });
      } catch (auditErr) {
        // The sign-in is refused either way; nothing is granted on this path.
        console.error(
          '[extsso] refusal audit failed:',
          auditErr && auditErr.message ? auditErr.message : auditErr
        );
      }
      return refusalPage(res, 409, 'conflict');
    }

    // e. the SAME session shape as the staff door, marked idp:'external'.
    const token = sso.issueSession({
      sub: identity.sub,
      oid: identity.oid,
      name: identity.name,
      email: identity.email,
      tid: extSso.tenantId(),
      idp: extSso.IDP,
    });
    userContext.stampLoginIfDue(appUser);

    res.cookie(sso.cookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: sso.cookieSecure,
      maxAge: sso.sessionTtlSeconds * 1000,
      path: '/',
    });
    return res.redirect(sso.postLoginRedirect);
  } catch (err) {
    // Control DB unreachable (or any other failure past the exchange): fail
    // closed — an honest 503 and never a session.
    console.error('[extsso] /ext/callback authorization failed:', err && err.message ? err.message : err);
    return refusalPage(res, 503, 'unavailable');
  }
});

function clearSession(res) {
  res.clearCookie(sso.cookieName, { path: '/', sameSite: 'lax', secure: sso.cookieSecure, httpOnly: true });
}

router.post('/logout', (req, res) => {
  clearSession(res);
  return res.json({ success: true });
});

router.get('/logout', (req, res) => {
  clearSession(res);
  return res.redirect(sso.postLoginRedirect);
});

module.exports = router;
