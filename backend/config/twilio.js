'use strict';

/**
 * Twilio configuration for TC text messaging (queue item 39).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHERE THE VALUES COME FROM
 * ═════════════════════════════════════════════════════════════════════════════
 * Secrets come from Key Vault ONLY (config/secrets.js SECRET_MAP), never from a
 * committed file. In dev they would be process.env, but no dev box should hold
 * a live Twilio credential — the code ships dark and is exercised in tests with
 * a fake client.
 *
 *   TWILIO_ACCOUNT_SID            twilio-account-sid             the account (AC…)
 *   TWILIO_API_KEY_SID            twilio-api-key-sid             REST auth user (SK…)
 *   TWILIO_API_KEY_SECRET         twilio-api-key-secret          REST auth password
 *   TWILIO_AUTH_TOKEN             twilio-auth-token              webhook SIGNATURE key
 *   TWILIO_MESSAGING_SERVICE_SID  twilio-messaging-service-sid   the Messaging Service (MG…)
 *   TWILIO_FROM_ROLAND            twilio-from-roland             Roland's sender, E.164
 *   TWILIO_FROM_VALLEY            twilio-from-valley             Valley's sender, E.164
 *
 * Why an AUTH TOKEN as well as an API key: Twilio signs webhooks
 * (X-Twilio-Signature) with the ACCOUNT auth token. An API key secret cannot
 * validate them. The item-39 spec listed only the API key pair, which is enough
 * to SEND but not to trust a single inbound request — so the token is a fourth
 * secret, and without it every webhook is refused (fail closed).
 *
 * Non-secret configuration (plain app settings, not Key Vault):
 *
 *   TWILIO_WEBHOOK_BASE_URL   the PUBLIC origin Twilio calls, e.g.
 *                             https://<dashboard host>. The signature covers the
 *                             full URL Twilio requested, and behind Container
 *                             Apps ingress + Caddy the Host header and protocol
 *                             this process sees are not that URL. So the URL is
 *                             rebuilt from THIS value + req.originalUrl and the
 *                             request's own Host / X-Forwarded-* headers are never
 *                             trusted for it. Also the base of the statusCallback
 *                             URL handed to Twilio on every send.
 *   TWILIO_TENANT_SLUG        which tenant's database a webhook writes to. A
 *                             webhook carries no SSO identity, so tenantContext
 *                             cannot resolve one; this names it explicitly. It is
 *                             resolved through the control-plane registry, never
 *                             guessed. Unset ⇒ every webhook is refused.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * FAIL CLOSED, PER OFFICE
 * ═════════════════════════════════════════════════════════════════════════════
 * Same shape as config/odOffices.js: the account credentials are process-wide,
 * the SENDER is per office, and a missing sender for one office disables that
 * office only. Valley can never borrow Roland's number. A from-number that is
 * not a plausible E.164 string is treated as missing, not "fixed up".
 *
 * Everything here is read from process.env AT CALL TIME, so a test (or a Key
 * Vault rotation followed by a restart) never sees a boot-time snapshot.
 */

const { OFFICES } = require('./officeAgents');

/** Per-office sender env var: roland → TWILIO_FROM_ROLAND. */
function fromEnvVarFor(officeKey) {
  return 'TWILIO_FROM_' + String(officeKey).toUpperCase();
}

/** A trimmed env value, or null when unset/blank. */
function envValue(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const v = String(raw).trim();
  return v === '' ? null : v;
}

/** Strict E.164: + then 8–15 digits, first digit non-zero. */
function isE164(v) {
  return typeof v === 'string' && /^\+[1-9]\d{7,14}$/.test(v);
}

/** Is this a real office of this practice group (officeAgents.OFFICES)? */
function isKnownOffice(officeKey) {
  return typeof officeKey === 'string' && Object.prototype.hasOwnProperty.call(OFFICES, officeKey);
}

/**
 * The account-level values needed to SEND. Null fields are missing.
 * @returns {{ accountSid: string|null, apiKeySid: string|null, apiKeySecret: string|null,
 *             messagingServiceSid: string|null, webhookBaseUrl: string|null }}
 */
function accountConfig() {
  return {
    accountSid: envValue('TWILIO_ACCOUNT_SID'),
    apiKeySid: envValue('TWILIO_API_KEY_SID'),
    apiKeySecret: envValue('TWILIO_API_KEY_SECRET'),
    messagingServiceSid: envValue('TWILIO_MESSAGING_SERVICE_SID'),
    webhookBaseUrl: webhookBaseUrl(),
  };
}

/**
 * The public origin, without a trailing slash, or null. Must be https — Twilio
 * signs the URL it called, and a plain-http base here would mean either a
 * misconfiguration or a webhook travelling unencrypted with PHI in it.
 * @returns {string|null}
 */
function webhookBaseUrl() {
  const raw = envValue('TWILIO_WEBHOOK_BASE_URL');
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.search || u.hash) return null;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** @returns {string|null} the webhook signature key */
function authToken() {
  return envValue('TWILIO_AUTH_TOKEN');
}

/** @returns {string|null} */
function tenantSlug() {
  return envValue('TWILIO_TENANT_SLUG');
}

/**
 * Which account-level values are missing, by env var NAME (never a value).
 * @returns {string[]}
 */
function missingAccountConfig() {
  const c = accountConfig();
  const missing = [];
  if (!c.accountSid) missing.push('TWILIO_ACCOUNT_SID');
  if (!c.apiKeySid) missing.push('TWILIO_API_KEY_SID');
  if (!c.apiKeySecret) missing.push('TWILIO_API_KEY_SECRET');
  if (!c.messagingServiceSid) missing.push('TWILIO_MESSAGING_SERVICE_SID');
  if (!c.webhookBaseUrl) missing.push('TWILIO_WEBHOOK_BASE_URL');
  return missing;
}

/** Is everything account-level present to send? @returns {boolean} */
function accountConfigured() {
  return missingAccountConfig().length === 0;
}

/**
 * This office's sender (E.164), or null. Never another office's.
 * @param {string} officeKey
 * @returns {string|null}
 */
function fromNumberFor(officeKey) {
  if (!isKnownOffice(officeKey)) return null;
  const v = envValue(fromEnvVarFor(officeKey));
  return isE164(v) ? v : null;
}

/**
 * The office a RECEIVING number belongs to — inbound texts derive their office
 * from the To, never the sender. Null when no office (or more than one, which
 * would be a configuration error that must not be resolved by picking one)
 * claims it.
 * @param {string|null} e164
 * @returns {string|null}
 */
function officeForReceivingNumber(e164) {
  if (!isE164(e164)) return null;
  const owners = Object.keys(OFFICES).filter((k) => fromNumberFor(k) === e164);
  return owners.length === 1 ? owners[0] : null;
}

/**
 * The statusCallback URL handed to Twilio for an office's sends. The office is
 * in the PATH, and Twilio's signature covers the path, so a callback can only
 * claim the office we put there.
 * @param {string} officeKey
 * @returns {string|null}
 */
function statusCallbackUrl(officeKey) {
  const base = webhookBaseUrl();
  if (!base || !isKnownOffice(officeKey)) return null;
  return `${base}/api/webhooks/twilio/status/${officeKey}`;
}

module.exports = {
  fromEnvVarFor,
  isE164,
  isKnownOffice,
  accountConfig,
  webhookBaseUrl,
  authToken,
  tenantSlug,
  missingAccountConfig,
  accountConfigured,
  fromNumberFor,
  officeForReceivingNumber,
  statusCallbackUrl,
};
