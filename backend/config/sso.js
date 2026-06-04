'use strict';

/**
 * Microsoft Entra single sign-on configuration for the CareIN dashboard.
 *
 * Auth model: OAuth2 authorization-code flow (with PKCE) via @azure/msal-node,
 * implemented server-side as a confidential client (CareIN-Dashboard-SSO app
 * registration). After a successful sign-in we mint our OWN short-lived session
 * JWT and set it as an HttpOnly cookie; the Microsoft tokens are not exposed to
 * the browser.
 *
 * Secrets (client secret + session signing key) come ONLY from process.env,
 * which in production is populated from Key Vault by config/secrets.js. The
 * non-secret identifiers (client/tenant IDs, redirect URI) may come from env or
 * fall back to the known dev values below — they are NOT secrets.
 */

const msal = require('@azure/msal-node');
const jwt = require('jsonwebtoken');

// Non-secret identifiers (safe to default for dev; override via env in prod).
const TENANT_ID_DEFAULT = 'fb0713b3-53e4-426a-8b0f-e444441bfc29'; // careindent
const CLIENT_ID_DEFAULT = 'd30ab7dd-5fcf-41d0-97a2-3f7b39bce07f'; // CareIN-Dashboard-SSO

const tenantId = process.env.DASHBOARD_SSO_TENANT_ID || process.env.AZURE_TENANT_ID || TENANT_ID_DEFAULT;
const clientId = process.env.DASHBOARD_SSO_CLIENT_ID || CLIENT_ID_DEFAULT;

// Secrets — never defaulted. Empty => SSO not configured (see isConfigured()).
const clientSecret = process.env.DASHBOARD_SSO_CLIENT_SECRET || '';
const sessionSecret = process.env.DASHBOARD_SESSION_SECRET || '';

const redirectUri = process.env.DASHBOARD_SSO_REDIRECT_URI || 'http://localhost:5103/auth/callback';

// Authorization rules: only this tenant, and (optionally) only this email domain.
const allowedTenantId = (process.env.DASHBOARD_SSO_ALLOWED_TENANT_ID || tenantId).toLowerCase();
const allowedDomain = (process.env.DASHBOARD_SSO_ALLOWED_DOMAIN || 'carein.ai').trim().toLowerCase();

// Where to send the browser after a successful sign-in (the SPA origin).
const postLoginRedirect =
  process.env.DASHBOARD_POST_LOGIN_URL ||
  (process.env.NODE_ENV === 'production' ? '/' : 'http://localhost:3005');

const cookieName = process.env.DASHBOARD_SSO_COOKIE || 'carein_sso';
const cookieSecure = process.env.NODE_ENV === 'production';
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8h
const SCOPES = ['User.Read'];
const ISSUER = 'carein-dashboard';

/** @type {import('@azure/msal-node').ConfidentialClientApplication | null} */
let cachedClient = null;
/** @type {import('@azure/msal-node').CryptoProvider | null} */
let cachedCrypto = null;

/** SSO is usable only when both the client secret and session key are present. */
function isConfigured() {
  return Boolean(clientId && tenantId && clientSecret && sessionSecret);
}

/** Lazily build the MSAL confidential client. */
function getClient() {
  if (!cachedClient) {
    cachedClient = new msal.ConfidentialClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
        clientSecret,
      },
      system: {
        loggerOptions: {
          // Never log PII (tokens, emails). Keep MSAL quiet at Warning+.
          loggerCallback: () => {},
          piiLoggingEnabled: false,
          logLevel: msal.LogLevel.Warning,
        },
      },
    });
  }
  return cachedClient;
}

/** Shared CryptoProvider for PKCE + state generation. */
function getCryptoProvider() {
  if (!cachedCrypto) cachedCrypto = new msal.CryptoProvider();
  return cachedCrypto;
}

/**
 * @typedef {Object} SessionClaims
 * @property {string} sub   homeAccountId
 * @property {string} oid   localAccountId (object id)
 * @property {string} name  display name
 * @property {string} email userPrincipalName / email (lowercased)
 * @property {string} tid   tenant id
 */

/**
 * Mint a signed session JWT.
 * @param {SessionClaims} claims
 * @returns {string}
 */
function issueSession(claims) {
  return jwt.sign(claims, sessionSecret, {
    algorithm: 'HS256',
    expiresIn: SESSION_TTL_SECONDS,
    issuer: ISSUER,
  });
}

/**
 * Verify a session JWT. Returns the decoded claims or null if invalid/expired.
 * @param {string} token
 * @returns {SessionClaims | null}
 */
function verifySession(token) {
  if (!token || !sessionSecret) return null;
  try {
    const decoded = jwt.verify(token, sessionSecret, {
      algorithms: ['HS256'],
      issuer: ISSUER,
    });
    return /** @type {SessionClaims} */ (decoded);
  } catch (_err) {
    return null;
  }
}

module.exports = {
  isConfigured,
  getClient,
  getCryptoProvider,
  issueSession,
  verifySession,
  // config (non-secret) for routes/middleware
  clientId,
  tenantId,
  redirectUri,
  allowedTenantId,
  allowedDomain,
  postLoginRedirect,
  cookieName,
  cookieSecure,
  scopes: SCOPES,
  sessionTtlSeconds: SESSION_TTL_SECONDS,
};
