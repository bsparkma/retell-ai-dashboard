'use strict';

/**
 * Print-template logos in Azure Blob (CO-3) — the R4 referral-attachment
 * pattern (services/tc/referralAttachmentStore.js), against its OWN container:
 *
 *   - CONFIGURED BY NAME, NO SECRETS. TC's storage account
 *     (`TC_BLOB_ACCOUNT_URL`), container `TC_PRINT_ASSETS_BLOB_CONTAINER`
 *     (default `print-assets`). Managed identity in Azure
 *     (`AZURE_USE_MANAGED_IDENTITY`), DefaultAzureCredential on a workstation.
 *   - THE CONTAINER DOES NOT EXIST YET in any environment. Unconfigured, or a
 *     write the service refuses as ContainerNotFound / 404, is
 *     PRINT_LOGO_STORAGE_UNAVAILABLE — "Logo storage is not set up for this
 *     environment" — never "uploaded". Templates and printing work fully
 *     without a logo. This module creates nothing.
 *   - PRIVATE, NO SAS. A logo leaves only through the authenticated backend.
 *
 * The SDK is required lazily, so nothing loads it until a logo is used.
 */

const crypto = require('node:crypto');

/** The words every refusal from here carries. */
const UNAVAILABLE_MESSAGE = 'Logo storage is not set up for this environment';

/** @type {import('@azure/storage-blob').ContainerClient | null} */
let containerClient = null;

function isConfigured() {
  return Boolean(process.env.TC_BLOB_ACCOUNT_URL);
}

function containerName() {
  return process.env.TC_PRINT_ASSETS_BLOB_CONTAINER || 'print-assets';
}

function unavailable(detail) {
  const err = /** @type {Error & { code?: string }} */ (new Error(`[printAssetStore] ${detail}`));
  err.code = 'PRINT_LOGO_STORAGE_UNAVAILABLE';
  return err;
}

function getContainerClient() {
  if (containerClient) return containerClient;
  const accountUrl = process.env.TC_BLOB_ACCOUNT_URL;
  if (!accountUrl) throw unavailable('not configured (TC_BLOB_ACCOUNT_URL)');
  const { BlobServiceClient } = require('@azure/storage-blob');
  let credential;
  if (process.env.AZURE_USE_MANAGED_IDENTITY === 'true') {
    const { ManagedIdentityCredential } = require('@azure/identity');
    const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
    credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
  } else {
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  containerClient = new BlobServiceClient(accountUrl, credential).getContainerClient(containerName());
  return containerClient;
}

function isMissingContainer(err) {
  if (!err) return false;
  return err.code === 'ContainerNotFound' || err.statusCode === 404 || err.details?.errorCode === 'ContainerNotFound';
}

/**
 * Store a logo. Resolves only once the service confirmed the write.
 * @returns {Promise<{ key: string }>}
 */
async function putLogo({ tenantSlug, office, data, contentType }) {
  const { buildBlobKey } = require('../blobStore');
  const key = buildBlobKey({
    tenantSlug,
    module: 'tc',
    entity: `print-logo-${office}`,
    ext: contentType === 'image/png' ? 'png' : 'jpg',
    id: crypto.randomUUID(),
  });
  try {
    await getContainerClient()
      .getBlockBlobClient(key)
      .uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  } catch (err) {
    if (isMissingContainer(err)) throw unavailable(`container '${containerName()}' does not exist`);
    throw err;
  }
  return { key };
}

/** Read a logo's bytes back. Throws PRINT_LOGO_STORAGE_UNAVAILABLE when storage is not there. */
async function getLogo(key) {
  try {
    return await getContainerClient().getBlockBlobClient(key).downloadToBuffer();
  } catch (err) {
    if (isMissingContainer(err)) throw unavailable(`container '${containerName()}' does not exist`);
    throw err;
  }
}

/** TESTS ONLY: drop the cached client (a test's env change takes effect). */
function resetForTests() {
  containerClient = null;
}

/** TESTS ONLY: stand in for the container (a missing one, or an in-memory one). */
function setContainerClientForTests(client) {
  containerClient = client;
}

module.exports = { UNAVAILABLE_MESSAGE, isConfigured, containerName, putLogo, getLogo, resetForTests, setContainerClientForTests };
