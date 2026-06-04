'use strict';

/**
 * Entra SSO auth routes (mounted at /auth, OUTSIDE the /api bearer gate).
 *
 *   GET  /auth/login     -> redirect to Microsoft sign-in (auth-code + PKCE)
 *   GET  /auth/callback  -> exchange code, enforce tenant+domain, set session cookie
 *   GET  /auth/me        -> { authenticated, user? } from the session cookie
 *   POST /auth/logout    -> clear the session cookie (JSON)
 *   GET  /auth/logout    -> clear cookie + redirect (browser convenience)
 *
 * Only careindent-tenant accounts on the allowed domain (carein.ai) may sign in.
 */

const express = require('express');
const sso = require('../config/sso');
const { resolveTenantForUser } = require('../middleware/tenantContext');

const router = express.Router();

// Single-process pilot: keep PKCE verifier + state in memory, short-lived.
/** @type {Map<string, { codeVerifier: string, createdAt: number }>} */
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

  // Surface the tenant (practice) so the SPA can show its name. Degrades to null
  // if the control DB is unreachable — auth status must not depend on it.
  let tenant = null;
  try {
    const t = await resolveTenantForUser({ email: claims.email, tenantId: claims.tid });
    if (t) tenant = { slug: t.slug, displayName: t.display_name };
  } catch (_err) {
    // control plane unavailable — return the user without a tenant name
  }

  return res.json({
    authenticated: true,
    user: { name: claims.name, email: claims.email, tenantId: claims.tid },
    tenant,
  });
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
