'use strict';

/**
 * TC media store — Azure Blob access for gallery / smile-sim images (Slice 3).
 *
 * Blob BYTES live in Azure Blob Storage (provisioned by Slice 2 alongside the
 * importer); tc_* tables store blob KEYS only. This service is the backend's
 * ONLY read path to those bytes: the media proxy route streams a blob through
 * the API (auth gate + module guard + key-must-exist-in-DB check) — a public
 * or SAS URL is never handed to the client.
 *
 * Auth is AAD ONLY. The Slice 2 storage account has shared-key auth DISABLED,
 * so there is deliberately no connection-string path — a connection string is
 * a credential that cannot exist for this account (PR #26 review item 1).
 *
 * Config (env):
 *   TC_BLOB_ACCOUNT_URL  https://<acct>.blob.core.windows.net
 *   TC_BLOB_CONTAINER    container name, default 'tc-media'
 *
 * Credential: managed identity in Azure (same convention as config/secrets.js:
 * AZURE_USE_MANAGED_IDENTITY + AZURE_MANAGED_IDENTITY_CLIENT_ID/AZURE_CLIENT_ID);
 * DefaultAzureCredential locally (az login).
 *
 * Unconfigured is a legal state (TC ships dark) — isConfigured() gates the
 * route into a structured 503, never a crash at require time.
 */

/** @type {import('@azure/storage-blob').ContainerClient | null} */
let containerClient = null;

function isConfigured() {
  return Boolean(process.env.TC_BLOB_ACCOUNT_URL);
}

/** Lazily build the container client (SDK loaded only when TC media is used). */
function getContainerClient() {
  if (containerClient) return containerClient;

  const accountUrl = process.env.TC_BLOB_ACCOUNT_URL;
  if (!accountUrl) {
    throw new Error('[tcMediaStore] not configured (TC_BLOB_ACCOUNT_URL)');
  }

  const { BlobServiceClient } = require('@azure/storage-blob');
  const containerName = process.env.TC_BLOB_CONTAINER || 'tc-media';

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
 * Open a download stream for a blob key.
 * @param {string} key
 * @returns {Promise<{ stream: NodeJS.ReadableStream, contentType: string|null, contentLength: number|null } | null>}
 *          null if the blob does not exist.
 */
async function openBlob(key) {
  const blobClient = getContainerClient().getBlobClient(key);
  try {
    const download = await blobClient.download();
    return {
      stream: download.readableStreamBody,
      contentType: download.contentType || null,
      contentLength: typeof download.contentLength === 'number' ? download.contentLength : null,
    };
  } catch (err) {
    if (err && (err.statusCode === 404 || err.code === 'BlobNotFound')) return null;
    throw err;
  }
}

/** Test seam — reset the cached client. */
function _resetForTests() {
  containerClient = null;
}

module.exports = { isConfigured, openBlob, _resetForTests };
