'use strict';

/**
 * EOB document storage — Azure Blob, private, opaque keys.
 *
 * services/blobStore.js already predicted this consumer by name ("Future
 * consumers (EOB PDFs for the RCM module, etc.) reuse this module and its
 * conventions"), so this file is a thin binding of that helper plus the lazy,
 * unconfigured-is-legal behavior tcMediaStore.js established — RCM ships dark,
 * so "no storage account yet" must be a structured 503, never a crash at
 * require time.
 *
 * KEYS ARE OPAQUE, AND THAT IS A HARD RULE, NOT A STYLE CHOICE.
 * The key is `tenant/<slug>/rcm/eob/<uuid>.pdf`. It contains no filename, no
 * patient name, no claim number, no office — nothing derived from the document.
 * EOB filenames routinely carry patient names ("Smith EOB 3-14.pdf"), and a key
 * is not a private thing: it lands in blob inventory, in storage metrics, in
 * diagnostic logs, and in any error string that quotes it. The uploaded
 * filename IS kept — in rcm_eob_uploads.filename, a PHI column in a PHI table,
 * where it is displayed to the user who uploaded it and nowhere else.
 *
 * Note the office is deliberately NOT a key segment either. It is not PHI, but
 * a key that encodes it invites someone to read office FROM the key instead of
 * from the row, and office comes from the validated request (helpers.js), full
 * stop.
 *
 * Auth is AAD only. The platform's storage accounts are provisioned with
 * shared-key auth DISABLED, so there is no connection-string path here and none
 * may be added (PR #26 review item 1).
 *
 * Config (env):
 *   RCM_BLOB_ACCOUNT_URL   https://<acct>.blob.core.windows.net   (shared with ERA)
 *   RCM_EOB_CONTAINER      container name, default 'rcm-eob'
 *
 * The container var is PER-STORE, and that is deliberate. This module and
 * services/rcm/eraFileStore.js originally read ONE `RCM_BLOB_CONTAINER` with
 * DIFFERENT defaults ('rcm-eob' here, 'rcm-era' there) — an arrangement that
 * only works while nobody sets it. The first person to set it "for clarity"
 * would silently route raw 835 files into the EOB container, or EOB PDFs into
 * the ERA one. The ACCOUNT url stays shared because both containers really do
 * live on one storage account; the container names do not.
 */

const crypto = require('crypto');

/** @type {import('@azure/storage-blob').ContainerClient | null} */
let containerClient = null;

/** Is EOB storage configured? Unconfigured is a legal state — RCM ships dark. */
function isConfigured() {
  return Boolean(process.env.RCM_BLOB_ACCOUNT_URL);
}

/**
 * The one place an EOB blob key is built.
 *
 * Takes NO filename, NO patient, NO claim — by signature, so a future caller
 * cannot pass one in "just for readability". The only inputs are the tenant
 * slug (already a key segment convention platform-wide) and an optional id for
 * tests to pin.
 *
 * @param {{ tenantSlug: string, id?: string }} parts
 * @returns {string} `tenant/<slug>/rcm/eob/<uuid>.pdf`
 */
function buildEobKey({ tenantSlug, id }) {
  const { buildBlobKey } = require('../blobStore');
  return buildBlobKey({
    tenantSlug,
    module: 'rcm',
    entity: 'eob',
    ext: 'pdf',
    id: id || crypto.randomUUID(),
  });
}

/** Lazily build the container client (SDK loaded only when RCM storage is used). */
function getContainerClient() {
  if (containerClient) return containerClient;

  const accountUrl = process.env.RCM_BLOB_ACCOUNT_URL;
  if (!accountUrl) {
    const err = new Error('[rcmEobBlobStore] not configured (RCM_BLOB_ACCOUNT_URL)');
    err.code = 'EOB_STORAGE_UNAVAILABLE';
    throw err;
  }

  const { BlobServiceClient } = require('@azure/storage-blob');
  const containerName = process.env.RCM_EOB_CONTAINER || 'rcm-eob';

  // Same credential selection as tcMediaStore/callAnalyzer: managed identity in
  // Azure (explicit, via the platform's AZURE_USE_MANAGED_IDENTITY switch),
  // DefaultAzureCredential on a workstation (az login).
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
 * Store a PDF's bytes under an opaque key.
 *
 * The key is generated here, NOT accepted from the caller — a caller-supplied
 * key is how a filename ends up in a blob path.
 *
 * @param {{ tenantSlug: string, data: Buffer, id?: string }} args
 * @returns {Promise<{ key: string, url: string, bytes: number }>}
 */
async function putEob({ tenantSlug, data, id }) {
  const key = buildEobKey({ tenantSlug, id });
  const container = getContainerClient();
  const blob = container.getBlockBlobClient(key);
  await blob.uploadData(data, { blobHTTPHeaders: { blobContentType: 'application/pdf' } });
  // The URL is stored because rcm_eob_uploads.file_url is NOT NULL (Slice 1
  // schema, inherited from the source). It is an addressable location, not a
  // capability: the container is private and there are no SAS tokens, so this
  // string is useless without an AAD identity that can read the container.
  return { key, url: blob.url, bytes: data.length };
}

/**
 * Read a stored EOB back. The extraction worker's ONLY read path.
 * @param {string} key
 * @returns {Promise<Buffer>}
 */
async function getEob(key) {
  return getContainerClient().getBlockBlobClient(key).downloadToBuffer();
}

/** Test seam — reset the cached client. */
function _resetForTests() {
  containerClient = null;
}

module.exports = { isConfigured, buildEobKey, putEob, getEob, _resetForTests };
