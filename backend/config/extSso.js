'use strict';

/**
 * The EXTERNAL sign-in door: an Entra External ID (CIAM) tenant where people
 * outside the careindent organization sign in with Google or an email
 * one-time passcode. It sits BESIDE config/sso.js (staff Microsoft sign-in),
 * never in place of it, and shares only the session signing key — an external
 * sign-in mints the same carein_sso cookie, marked idp:'external'.
 *
 * SHIPS DARK. Every value below may be absent, and none is defaulted or
 * invented: a missing value means isConfigured() is false, the /auth/ext
 * routes 404, /auth/providers says external:false, and the SPA shows no
 * button. Unlike config/sso.js there are NO known-good fallback ids here —
 * a guessed tenant or client id would point real people at the wrong
 * directory.
 *
 *   DASHBOARD_EXTSSO_TENANT_ID      the External ID tenant (GUID)
 *   DASHBOARD_EXTSSO_SUBDOMAIN      its <subdomain>.ciamlogin.com host label
 *   DASHBOARD_EXTSSO_CLIENT_ID      the app registration in THAT tenant
 *   DASHBOARD_EXTSSO_CLIENT_SECRET  🔒 Key Vault `dashboard-extsso-client-secret`
 *                                   (config/secrets.js), never a plain setting
 *
 * The redirect URI is not a fifth setting: it is the staff callback's own
 * origin with the external path (`/auth/ext/callback`), so the two doors can
 * never disagree about which host they live on. The external app registration
 * must list that URI.
 *
 * Read at CALL time, not captured at module load, so a test (or a Key Vault
 * load that lands after this module is first required) sees the live values.
 */

const msal = require('@azure/msal-node');
const sso = require('./sso');

const GUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A DNS label: the part before .ciamlogin.com. Anything else could aim the authority elsewhere. */
const SUBDOMAIN_RX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** OIDC scopes only — this door needs an identity, not a Graph token. */
const SCOPES = Object.freeze(['openid', 'profile', 'email']);

/** The identity-provider marker an external session carries in its JWT. */
const IDP = 'external';

function env(name) {
  return String(process.env[name] || '').trim();
}

/** @returns {{ tenantId: string, subdomain: string, clientId: string, clientSecret: string }} */
function readConfig() {
  return {
    tenantId: env('DASHBOARD_EXTSSO_TENANT_ID').toLowerCase(),
    subdomain: env('DASHBOARD_EXTSSO_SUBDOMAIN').toLowerCase(),
    clientId: env('DASHBOARD_EXTSSO_CLIENT_ID'),
    clientSecret: env('DASHBOARD_EXTSSO_CLIENT_SECRET'),
  };
}

/**
 * Usable only when all four values are present AND well-formed, and the shared
 * session key exists (without it there is no cookie to mint). A malformed
 * tenant id or subdomain reads as "not configured" rather than as a URL built
 * from garbage.
 * @returns {boolean}
 */
function isConfigured() {
  const c = readConfig();
  return Boolean(
    GUID_RX.test(c.tenantId) &&
      SUBDOMAIN_RX.test(c.subdomain) &&
      c.clientId &&
      c.clientSecret &&
      process.env.DASHBOARD_SESSION_SECRET
  );
}

/** https://<SUBDOMAIN>.ciamlogin.com/<TENANT_ID>, or null when not configured. */
function authority() {
  if (!isConfigured()) return null;
  const c = readConfig();
  return `https://${c.subdomain}.ciamlogin.com/${c.tenantId}`;
}

/** The External ID tenant id, or null when not configured. Stamped as the session's `tid`. */
function tenantId() {
  return isConfigured() ? readConfig().tenantId : null;
}

/** The staff callback's origin + /auth/ext/callback. */
function redirectUri() {
  return new URL('/auth/ext/callback', sso.redirectUri).toString();
}

/** @type {{ key: string, client: import('@azure/msal-node').ConfidentialClientApplication } | null} */
let cached = null;

/**
 * The MSAL confidential client for the external authority. Rebuilt if the
 * configuration changes underneath it (a rotated secret, a test), never shared
 * with the staff client.
 * @returns {import('@azure/msal-node').ConfidentialClientApplication}
 */
function getClient() {
  if (!isConfigured()) throw new Error('[extSso] not configured');
  const c = readConfig();
  const key = [c.tenantId, c.subdomain, c.clientId, c.clientSecret].join('|');
  if (!cached || cached.key !== key) {
    cached = {
      key,
      client: new msal.ConfidentialClientApplication({
        auth: {
          clientId: c.clientId,
          authority: `https://${c.subdomain}.ciamlogin.com/${c.tenantId}`,
          clientSecret: c.clientSecret,
          // A ciamlogin.com authority is not on MSAL's built-in known list.
          knownAuthorities: [`${c.subdomain}.ciamlogin.com`],
        },
        system: {
          loggerOptions: {
            // Never log PII (tokens, emails). Same posture as the staff client.
            loggerCallback: () => {},
            piiLoggingEnabled: false,
            logLevel: msal.LogLevel.Warning,
          },
        },
      }),
    };
  }
  return cached.client;
}

module.exports = {
  isConfigured,
  authority,
  tenantId,
  redirectUri,
  getClient,
  scopes: SCOPES,
  IDP,
};
