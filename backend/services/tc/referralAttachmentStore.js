'use strict';

/**
 * Referral attachments in Azure Blob (queue item 55, R4) — X-rays, photos and
 * PDFs a referral carries to the specialist.
 *
 * The eobBlobStore pattern, exactly:
 *   - CONFIGURED BY NAME, NO SECRETS. The account is TC's own storage account
 *     (`TC_BLOB_ACCOUNT_URL`, already set wherever TC media works), the
 *     container is `TC_REFERRAL_BLOB_CONTAINER` (default `tc-referrals`).
 *     Credentials: managed identity in Azure (`AZURE_USE_MANAGED_IDENTITY`),
 *     DefaultAzureCredential (az login) on a workstation. Nothing in the repo,
 *     nothing in a request.
 *   - UNCONFIGURED IS A LEGAL STATE. `isConfigured()` false → the routes refuse
 *     with an honest 503 before a byte is read.
 *   - THE CONTAINER MAY NOT EXIST YET. A write that the service refuses for
 *     that reason (ContainerNotFound / 404) is turned into
 *     REFERRAL_STORAGE_UNAVAILABLE, never into "uploaded".
 *   - PRIVATE CONTAINER, NO SAS. A key is a location, not a capability; bytes
 *     leave only through the authenticated, audited backend route.
 *
 * The SDK is required lazily, so nothing loads it until an attachment is used.
 */

const crypto = require('crypto');

/** @type {import('@azure/storage-blob').ContainerClient | null} */
let containerClient = null;

/** Is attachment storage configured here? */
function isConfigured() {
  return Boolean(process.env.TC_BLOB_ACCOUNT_URL);
}

/** The container name in force. */
function containerName() {
  return process.env.TC_REFERRAL_BLOB_CONTAINER || 'tc-referrals';
}

/**
 * The content type each extension is SERVED as. The key's extension is ours
 * (minted here from the sniffed bytes), so it — never a client's claimed
 * multipart type — decides what a browser is told.
 */
const CONTENT_TYPE_BY_EXT = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
});

const EXT_BY_CONTENT_TYPE = Object.freeze(
  Object.fromEntries(Object.entries(CONTENT_TYPE_BY_EXT).map(([ext, type]) => [type, ext]))
);

/**
 * What the BYTES are, from their magic numbers — or null when they are none of
 * the five accepted types. The client's declared type and filename are never
 * trusted for this.
 *
 * @param {Buffer} buf
 * @returns {string|null} a content type
 */
function sniffContentType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 6).toString('latin1') === 'GIF87a' || buf.subarray(0, 6).toString('latin1') === 'GIF89a') {
    return 'image/gif';
  }
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** The content type a stored key is served as (null for a key we did not mint). */
function contentTypeForKey(key) {
  const m = /\.([a-z]+)$/.exec(String(key));
  return (m && CONTENT_TYPE_BY_EXT[m[1]]) || null;
}

function buildKey({ tenantSlug, contentType, id }) {
  const { buildBlobKey } = require('../blobStore');
  return buildBlobKey({
    tenantSlug,
    module: 'tc',
    entity: 'referral',
    ext: EXT_BY_CONTENT_TYPE[contentType],
    id: id || crypto.randomUUID(),
  });
}

function getContainerClient() {
  if (containerClient) return containerClient;
  const accountUrl = process.env.TC_BLOB_ACCOUNT_URL;
  if (!accountUrl) {
    const err = /** @type {Error & { code?: string }} */ (
      new Error('[referralAttachmentStore] not configured (TC_BLOB_ACCOUNT_URL)')
    );
    err.code = 'REFERRAL_STORAGE_UNAVAILABLE';
    throw err;
  }
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

/** A storage-side refusal that means "the container is not there (yet)". */
function isMissingContainer(err) {
  if (!err) return false;
  return err.code === 'ContainerNotFound' || err.statusCode === 404 || err.details?.errorCode === 'ContainerNotFound';
}

/**
 * Store the bytes. Resolves ONLY once the service has confirmed the write;
 * anything else throws, with `code: 'REFERRAL_STORAGE_UNAVAILABLE'` when the
 * container is missing or storage is unconfigured.
 *
 * @returns {Promise<{ key: string, bytes: number }>}
 */
async function putAttachment({ tenantSlug, data, contentType }) {
  const key = buildKey({ tenantSlug, contentType });
  try {
    await getContainerClient()
      .getBlockBlobClient(key)
      .uploadData(data, { blobHTTPHeaders: { blobContentType: contentType } });
  } catch (err) {
    if (isMissingContainer(err)) {
      const e = /** @type {Error & { code?: string }} */ (
        new Error(`[referralAttachmentStore] container '${containerName()}' does not exist`)
      );
      e.code = 'REFERRAL_STORAGE_UNAVAILABLE';
      throw e;
    }
    throw err;
  }
  return { key, bytes: data.length };
}

/** Read the bytes back (for the authenticated, audited view route). */
async function getAttachment(key) {
  return getContainerClient().getBlockBlobClient(key).downloadToBuffer();
}

/** Test seam — reset the cached client. */
function _resetForTests() {
  containerClient = null;
}

module.exports = {
  CONTENT_TYPE_BY_EXT,
  isConfigured,
  containerName,
  sniffContentType,
  contentTypeForKey,
  buildKey,
  isMissingContainer,
  putAttachment,
  getAttachment,
  _resetForTests,
};
