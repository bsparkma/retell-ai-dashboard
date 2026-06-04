'use strict';

/**
 * Secret loader for the CareIN backend.
 *
 * Production (NODE_ENV=production):
 *   - Authenticates to Azure Key Vault `kv-carein-core` using the
 *     CareIN-Connector-OnPrem app registration's CERTIFICATE
 *     (ClientCertificateCredential).
 *   - The certificate is read from the Windows certificate store
 *     (LocalMachine\My) BY THUMBPRINT and exported to an in-memory PEM.
 *     The .pfx file + password on disk are NOT used.
 *   - Each kebab-case vault secret is fetched and written onto the
 *     process.env key the rest of the app already reads.
 *
 * Non-production:
 *   - No Azure calls. Relies on .env / process.env (loaded by dotenv in
 *     server.js) so local development is unchanged.
 *
 * Safety:
 *   - Secret VALUES are never logged or written to disk.
 *   - Any debug output is masked.
 *   - Missing / not-yet-created secrets (HTTP 404) are treated as OPTIONAL
 *     and skipped, so an absent secret (e.g. stedi-api-key) never blocks
 *     startup.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Mapping of Key Vault secret name (kebab-case) -> process.env key the app
 * already consumes. Order is not significant; every entry is optional.
 * @typedef {{ secretName: string, envKey: string }} SecretMapping
 * @type {ReadonlyArray<SecretMapping>}
 */
// NOTE: Open Dental runs in API mode (OPENDENTAL_INTEGRATION_MODE=api). The API
// base URL (OPENDENTAL_API_BASE_URL), the integration mode, and the images path
// (OPENDENTAL_IMAGES_PATH) are NON-secret configuration and come from
// .env/process.env in both dev and prod — they are intentionally NOT in this
// map and never fetched from Key Vault. Only the OD developer/customer keys are
// secrets.
const SECRET_MAP = Object.freeze([
  { secretName: 'od-api-key', envKey: 'OD_API_KEY' },
  { secretName: 'opendental-developer-key', envKey: 'OPENDENTAL_DEVELOPER_KEY' },
  { secretName: 'opendental-customer-key', envKey: 'OPENDENTAL_CUSTOMER_KEY' },
  { secretName: 'retell-api-key', envKey: 'RETELL_API_KEY' },
  { secretName: 'mango-username', envKey: 'MANGO_USERNAME' },
  { secretName: 'mango-password', envKey: 'MANGO_PASSWORD' },
  { secretName: 'deepgram-api-key', envKey: 'DEEPGRAM_API_KEY' },
  { secretName: 'openai-api-key', envKey: 'OPENAI_API_KEY' },
  { secretName: 'od-connector-api-key', envKey: 'OD_CONNECTOR_API_KEY' },
  // Control plane: Postgres connection string for the `carein_control`
  // database (migrations + control-plane data). Dev reads CONTROL_DB_URL from
  // .env; prod fetches it from Key Vault here. Absent in the vault -> skipped.
  { secretName: 'control-db-url', envKey: 'CONTROL_DB_URL' },
  // Entra SSO (CareIN-Dashboard-SSO): confidential-client secret + the
  // server-side session/JWT signing key. Both live ONLY in Key Vault.
  { secretName: 'dashboard-sso-client-secret', envKey: 'DASHBOARD_SSO_CLIENT_SECRET' },
  { secretName: 'dashboard-session-secret', envKey: 'DASHBOARD_SESSION_SECRET' },
  // Optional / not yet wired into this backend. Absent in the vault -> skipped.
  { secretName: 'stedi-api-key', envKey: 'STEDI_API_KEY' },
]);

const DEFAULT_VAULT_NAME = 'kv-carein-core';

/** @type {boolean} */
let loaded = false;

/**
 * Cached Key Vault SecretClient (cert auth). Built once per process in
 * production; never created in non-production.
 * @type {import('@azure/keyvault-secrets').SecretClient | null}
 */
let vaultClient = null;

/**
 * Mask a secret for safe (optional) debug output. Never reveals the value.
 * @param {string | undefined} value
 * @returns {string}
 */
function mask(value) {
  if (!value) return '(empty)';
  const len = String(value).length;
  return `***(${len} chars)`;
}

/**
 * @typedef {Object} CertAuthConfig
 * @property {string} appId          App (client) ID of CareIN-Connector-OnPrem.
 * @property {string} tenantId       Entra tenant ID.
 * @property {string} thumbprint     Cert thumbprint (hex, no spaces).
 * @property {string} storeLocation  'LocalMachine' or 'CurrentUser'.
 * @property {string} vaultName      Key Vault name.
 */

/**
 * Resolve cert-auth config from machine env vars first, then fall back to the
 * gitignored .local/entra-app.json (a developer convenience). Nothing is
 * hardcoded.
 * @returns {CertAuthConfig}
 */
function resolveCertConfig() {
  /** @type {Record<string, any>} */
  let appJson = {};
  const jsonPath =
    process.env.ENTRA_APP_JSON ||
    path.join(__dirname, '..', '..', '.local', 'entra-app.json');
  try {
    if (fs.existsSync(jsonPath)) {
      appJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    }
  } catch (_err) {
    // Ignore a malformed/absent file; env vars are the source of truth in prod.
  }

  const auth = (appJson && appJson.auth) || {};
  const appId = process.env.AZURE_CLIENT_ID || appJson.appId;
  const tenantId = process.env.AZURE_TENANT_ID || appJson.tenantId;
  const thumbprint =
    process.env.AZURE_CLIENT_CERTIFICATE_THUMBPRINT || auth.certThumbprint;
  const storeLocation =
    process.env.AZURE_CLIENT_CERTIFICATE_STORE_LOCATION || 'LocalMachine';
  const vaultName = process.env.AZURE_KEY_VAULT_NAME || DEFAULT_VAULT_NAME;

  /** @type {string[]} */
  const missing = [];
  if (!appId) missing.push('AZURE_CLIENT_ID (or appId)');
  if (!tenantId) missing.push('AZURE_TENANT_ID (or tenantId)');
  if (!thumbprint) missing.push('AZURE_CLIENT_CERTIFICATE_THUMBPRINT (or auth.certThumbprint)');
  if (missing.length) {
    throw new Error(
      `[secrets] missing certificate-auth configuration: ${missing.join(', ')}`
    );
  }

  return {
    appId: String(appId),
    tenantId: String(tenantId),
    thumbprint: String(thumbprint).replace(/[^a-fA-F0-9]/g, '').toUpperCase(),
    storeLocation: String(storeLocation),
    vaultName: String(vaultName),
  };
}

/**
 * Export the certificate (public cert + private key) from the Windows cert
 * store by thumbprint as an in-memory PEM string. Requires PowerShell 7+
 * (RSACertificateExtensions.ExportPkcs8PrivateKey) and an exportable key.
 * The PEM is held in memory only and is never written to disk or logged.
 * @param {string} thumbprint
 * @param {string} storeLocation 'LocalMachine' | 'CurrentUser'
 * @returns {string} PEM containing CERTIFICATE and PRIVATE KEY blocks.
 */
function exportCertPemFromStore(thumbprint, storeLocation) {
  const script = [
    "$ErrorActionPreference='Stop';",
    `$c=Get-Item ('Cert:\\' + '${storeLocation}' + '\\My\\' + '${thumbprint}');`,
    '$rsa=[System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($c);',
    'if($null -eq $rsa){throw "No exportable RSA private key for thumbprint"};',
    "$key=[Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey(),'InsertLineBreaks');",
    "$cer=[Convert]::ToBase64String($c.RawData,'InsertLineBreaks');",
    "Write-Output '-----BEGIN CERTIFICATE-----';Write-Output $cer;Write-Output '-----END CERTIFICATE-----';",
    "Write-Output '-----BEGIN PRIVATE KEY-----';Write-Output $key;Write-Output '-----END PRIVATE KEY-----';",
  ].join('');

  // Prefer pwsh (PowerShell 7+); fall back to Windows PowerShell if present.
  const candidates = ['pwsh', 'powershell'];
  /** @type {Error | undefined} */
  let lastError;
  for (const exe of candidates) {
    try {
      const pem = execFileSync(
        exe,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
      );
      if (pem && pem.includes('BEGIN CERTIFICATE') && pem.includes('BEGIN PRIVATE KEY')) {
        return pem;
      }
      lastError = new Error('certificate export produced no PEM');
    } catch (err) {
      lastError = /** @type {Error} */ (err);
    }
  }
  throw new Error(
    `[secrets] failed to export certificate from ${storeLocation}\\My store ` +
      `(need PowerShell 7+ and an exportable key): ${lastError ? lastError.message : 'unknown error'}`
  );
}

/**
 * @typedef {Object} LoadResult
 * @property {string[]} loaded   process.env keys populated from the vault.
 * @property {string[]} skipped  process.env keys with no secret present.
 */

/**
 * Fetch every mapped secret from Key Vault using certificate auth and write it
 * onto process.env. Missing secrets (404) are skipped; auth/network failures
 * propagate so we never start half-configured against an unreachable vault.
 * @returns {Promise<LoadResult>}
 */
/**
 * Build (once) and return the cert-auth Key Vault client. Lazy-requires the
 * Azure SDKs so non-production never loads them. Shared by the startup batch
 * loader and the per-secret resolver below.
 * @returns {import('@azure/keyvault-secrets').SecretClient}
 */
/**
 * Build the Key Vault credential for production.
 *
 * Two mutually-exclusive paths, selected by env so the SAME code runs on-prem
 * and in Azure with no source changes:
 *
 *   1. Azure-hosted (Container Apps) — env-gated by AZURE_USE_MANAGED_IDENTITY.
 *      Uses the Container App's USER-ASSIGNED managed identity. No certificate,
 *      no .pfx, no Windows cert store — the platform brokers the token. The
 *      identity's clientId comes from AZURE_MANAGED_IDENTITY_CLIENT_ID (falls
 *      back to AZURE_CLIENT_ID for convenience).
 *
 *   2. On-prem prod (DEFAULT, unchanged) — ClientCertificateCredential built
 *      from the certificate in the Windows cert store (see exportCertPemFromStore).
 *
 * Local/dev never reaches here: loadSecrets() short-circuits in non-production.
 * @returns {import('@azure/identity').TokenCredential}
 */
function buildCredential() {
  if (process.env.AZURE_USE_MANAGED_IDENTITY === 'true') {
    const { ManagedIdentityCredential } = require('@azure/identity');
    const miClientId =
      process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    if (!miClientId) {
      throw new Error(
        '[secrets] AZURE_USE_MANAGED_IDENTITY=true but no managed-identity clientId ' +
          'is set (AZURE_MANAGED_IDENTITY_CLIENT_ID or AZURE_CLIENT_ID).'
      );
    }
    console.log('[secrets] credential: user-assigned ManagedIdentityCredential (Azure-hosted)');
    return new ManagedIdentityCredential({ clientId: miClientId });
  }

  // On-prem prod — certificate from the Windows cert store (unchanged path).
  const { ClientCertificateCredential } = require('@azure/identity');
  const cfg = resolveCertConfig();
  const pem = exportCertPemFromStore(cfg.thumbprint, cfg.storeLocation);
  console.log('[secrets] credential: ClientCertificateCredential (on-prem cert store)');
  return new ClientCertificateCredential(cfg.tenantId, cfg.appId, {
    certificate: pem,
  });
}

function getVaultClient() {
  if (vaultClient) return vaultClient;

  const { SecretClient } = require('@azure/keyvault-secrets');

  // Vault name is non-secret config: AZURE_KEY_VAULT_NAME (e.g. kv-carein-staging
  // in Azure) or the on-prem default (kv-carein-core). Resolved independently of
  // the cert config so the managed-identity path doesn't require cert settings.
  const vaultName = process.env.AZURE_KEY_VAULT_NAME || DEFAULT_VAULT_NAME;
  const credential = buildCredential();
  vaultClient = new SecretClient(
    `https://${vaultName}.vault.azure.net`,
    credential
  );
  return vaultClient;
}

async function loadFromKeyVault() {
  const client = getVaultClient();

  /** @type {LoadResult} */
  const result = { loaded: [], skipped: [] };

  for (const { secretName, envKey } of SECRET_MAP) {
    try {
      const secret = await client.getSecret(secretName);
      if (secret && typeof secret.value === 'string' && secret.value.length > 0) {
        process.env[envKey] = secret.value;
        result.loaded.push(envKey);
      } else {
        result.skipped.push(envKey);
      }
    } catch (err) {
      const statusCode = err && /** @type {any} */ (err).statusCode;
      const code = err && /** @type {any} */ (err).code;
      const isNotFound =
        statusCode === 404 ||
        code === 'SecretNotFound' ||
        (err && /not found|was not found/i.test(String(err.message || '')));
      if (isNotFound) {
        // Optional/commented-out secret — skip without crashing.
        result.skipped.push(envKey);
      } else {
        throw err; // auth/network/permission failure — fail fast.
      }
    }
  }

  return result;
}

/**
 * Load secrets exactly once. In production this pulls from Key Vault via the
 * connector certificate; otherwise it leaves the existing .env/process.env in
 * place. Safe to call multiple times (subsequent calls are no-ops).
 * @returns {Promise<void>}
 */
async function loadSecrets() {
  if (loaded) return;

  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    loaded = true;
    console.log(
      '[secrets] non-production: using .env / process.env (Key Vault not contacted)'
    );
    return;
  }

  const vaultName = process.env.AZURE_KEY_VAULT_NAME || DEFAULT_VAULT_NAME;
  const result = await loadFromKeyVault();
  loaded = true;

  console.log(
    `[secrets] production: loaded ${result.loaded.length} secret(s) from ` +
      `Key Vault '${vaultName}', skipped ${result.skipped.length} optional/absent`
  );

  if (process.env.SECRETS_DEBUG === 'true') {
    for (const key of result.loaded) {
      console.log(`[secrets:debug] ${key} = ${mask(process.env[key])}`);
    }
    if (result.skipped.length) {
      console.log(`[secrets:debug] skipped (absent): ${result.skipped.join(', ')}`);
    }
  }
}

/**
 * Deterministic mapping from a kebab-case Key Vault secret NAME to the
 * SCREAMING_SNAKE_CASE env var used in development. e.g.
 *   'tenant-carein-db-url' -> 'TENANT_CAREIN_DB_URL'
 *   'control-db-url'       -> 'CONTROL_DB_URL'
 * @param {string} secretName
 * @returns {string}
 */
function secretNameToEnvKey(secretName) {
  return String(secretName).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

/**
 * Resolve a SINGLE secret value by its Key Vault NAME, for dynamic secrets that
 * aren't part of the fixed startup SECRET_MAP — notably per-tenant data-plane
 * connection strings (tenant_database.kv_conn_secret).
 *
 *   - Development: read the derived env var (secretNameToEnvKey) from
 *     process.env / backend/.env. No Azure calls.
 *   - Production:  fetch the secret from Key Vault by name using the same
 *     certificate auth as the batch loader. Missing (404) -> null.
 *
 * Returns null when the secret is absent/empty so callers can fail closed with
 * a helpful message rather than connecting to the wrong place.
 * @param {string} secretName kebab-case Key Vault secret name
 * @returns {Promise<string|null>}
 */
async function getSecretValue(secretName) {
  if (!secretName) return null;

  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    const envKey = secretNameToEnvKey(secretName);
    const val = process.env[envKey];
    return typeof val === 'string' && val.length > 0 ? val : null;
  }

  try {
    const client = getVaultClient();
    const secret = await client.getSecret(secretName);
    return secret && typeof secret.value === 'string' && secret.value.length > 0
      ? secret.value
      : null;
  } catch (err) {
    const statusCode = err && /** @type {any} */ (err).statusCode;
    const code = err && /** @type {any} */ (err).code;
    const isNotFound =
      statusCode === 404 ||
      code === 'SecretNotFound' ||
      (err && /not found|was not found/i.test(String(err.message || '')));
    if (isNotFound) return null;
    throw err; // auth/network/permission failure — surface it.
  }
}

module.exports = {
  loadSecrets,
  getSecretValue,
  secretNameToEnvKey,
  /** Exposed for diagnostics/tests — names only, never values. */
  secretNames: SECRET_MAP.map((m) => m.secretName),
};
