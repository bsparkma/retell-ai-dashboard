'use strict';

/**
 * Blob storage for raw uploaded remittance files (RCM Slice 5).
 *
 * Hard rule 6 of this slice: the raw 835 goes to Blob under an OPAQUE key, the
 * parsed content goes to rows, and the file itself is the audit artifact — the
 * thing you re-read when a posted payment is disputed months later. Nothing
 * downstream re-parses it on the happy path; it exists to be checkable.
 *
 * Same recipe and same platform rules as `services/tcMediaStore.js`:
 *  - AAD only. The storage accounts have shared-key auth DISABLED, so there is
 *    deliberately no connection-string path and no SAS.
 *  - The container is PRIVATE. Bytes reach a user only through an
 *    entitlement-checked backend proxy — never a handed-out URL. Slice 5 writes
 *    the key and serves nothing; the download route is Slice 7's.
 *  - Rows store KEYS. `rcm_eob_uploads.file_url` is NOT NULL in the schema, so
 *    it is written as the empty string: there is no URL, and '' says that
 *    truthfully where a fabricated URL would not.
 *
 * KEYS ARE OPAQUE, AND THAT IS A PHI RULE. The key is
 * `tenant/<slug>/rcm/era/<uuid>.edi` — built by the shared `buildBlobKey`, so
 * it can carry neither the uploaded filename nor a patient name nor an office.
 * Uploaded 835 filenames routinely contain both a payer and a patient
 * ("Delta_Smith_John_0302.edi"); `rcm_eob_uploads.filename` is documented PHI
 * for exactly that reason, and the blob path must not become a second,
 * unguarded copy of it.
 *
 * Config (env):
 *   RCM_BLOB_ACCOUNT_URL  https://<acct>.blob.core.windows.net
 *   RCM_BLOB_CONTAINER    container name, default 'rcm-era'
 *
 * Unconfigured is a legal state — RCM ships dark, and no environment has this
 * container yet. `isConfigured()` gates the upload route into a structured 503
 * rather than a crash at require time.
 */

const crypto = require('crypto');

const { buildBlobKey } = require('../blobStore');

/** @type {import('@azure/storage-blob').ContainerClient | null} */
let containerClient = null;

/** Is ERA blob storage configured in this environment? */
function isConfigured() {
  return Boolean(process.env.RCM_BLOB_ACCOUNT_URL);
}

/** Lazily build the container client (the SDK loads only when ERA is used). */
function getContainerClient() {
  if (containerClient) return containerClient;

  const accountUrl = process.env.RCM_BLOB_ACCOUNT_URL;
  if (!accountUrl) {
    throw new Error('[eraFileStore] not configured (RCM_BLOB_ACCOUNT_URL)');
  }

  const { BlobServiceClient } = require('@azure/storage-blob');
  const containerName = process.env.RCM_BLOB_CONTAINER || 'rcm-era';

  let credential;
  if (process.env.AZURE_USE_MANAGED_IDENTITY === 'true') {
    const { ManagedIdentityCredential } = require('@azure/identity');
    const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
  } else {
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential();
  }

  const service = new BlobServiceClient(accountUrl, credential);
  containerClient = service.getContainerClient(containerName);
  return containerClient;
}

/**
 * SHA-256 of the bytes, hex.
 *
 * Stored in `rcm_eob_uploads.file_hash`, which is INDEXED BUT NOT UNIQUE: it
 * answers "have we seen this exact document before?", which is a different and
 * weaker question than the remittance key's "have we already processed this
 * payment?". The hash changes if a clearinghouse re-emits the same check with
 * one byte of whitespace different; the remittance key does not. Dedupe is the
 * key's job — the hash is a hint for a human.
 *
 * @param {Buffer} bytes
 * @returns {string}
 */
function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/**
 * Store one raw remittance file.
 *
 * @param {{ tenantSlug: string, bytes: Buffer, contentType?: string }} params
 * @returns {Promise<{ key: string, bytes: number, hash: string }>}
 */
async function putEraFile({ tenantSlug, bytes, contentType }) {
  // 'edi' regardless of what the upload was called. The extension describes the
  // content, and the original filename is the one place a patient name could
  // ride into the key.
  const key = buildBlobKey({ tenantSlug, module: 'rcm', entity: 'era', ext: 'edi' });

  const blob = getContainerClient().getBlockBlobClient(key);
  await blob.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: contentType || 'application/edi-x12' },
  });

  return { key, bytes: bytes.length, hash: hashBytes(bytes) };
}

module.exports = { isConfigured, putEraFile, hashBytes };
