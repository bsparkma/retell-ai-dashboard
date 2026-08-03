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
 * Config (env):
 *   TC_BLOB_CONNECTION_STRING  dev/local — full connection string (Azurite ok)
 *   TC_BLOB_ACCOUNT_URL        cloud — https://<acct>.blob.core.windows.net
 *                              (auth via managed identity, same convention as
 *                              config/secrets.js: AZURE_USE_MANAGED_IDENTITY +
 *                              AZURE_MANAGED_IDENTITY_CLIENT_ID/AZURE_CLIENT_ID)
 *   TC_BLOB_CONTAINER          container name, default 'tc-media'
 *
 * Unconfigured is a legal state (TC ships dark) — isConfigured() gates the
 * route into a structured 503, never a crash at require time.
 */

/** @type {import('@azure/storage-blob').ContainerClient | null} */
let containerClient = null;

function isConfigured() {
  return Boolean(process.env.TC_BLOB_CONNECTION_STRING || process.env.TC_BLOB_ACCOUNT_URL);
}

/** Lazily build the container client (SDK loaded only when TC media is used). */
function getContainerClient() {
  if (containerClient) return containerClient;

  const { BlobServiceClient } = require('@azure/storage-blob');
  const containerName = process.env.TC_BLOB_CONTAINER || 'tc-media';

  let service;
  if (process.env.TC_BLOB_CONNECTION_STRING) {
    service = BlobServiceClient.fromConnectionString(process.env.TC_BLOB_CONNECTION_STRING);
  } else if (process.env.TC_BLOB_ACCOUNT_URL) {
    let credential;
    if (process.env.AZURE_USE_MANAGED_IDENTITY === 'true') {
      const { ManagedIdentityCredential } = require('@azure/identity');
      const clientId = process.env.AZURE_MANAGED_IDENTITY_CLIENT_ID || process.env.AZURE_CLIENT_ID;
      credential = new ManagedIdentityCredential(clientId ? { clientId } : {});
    } else {
      const { DefaultAzureCredential } = require('@azure/identity');
      credential = new DefaultAzureCredential();
    }
    service = new BlobServiceClient(process.env.TC_BLOB_ACCOUNT_URL, credential);
  } else {
    throw new Error('[tcMediaStore] not configured (TC_BLOB_CONNECTION_STRING or TC_BLOB_ACCOUNT_URL)');
  }

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
