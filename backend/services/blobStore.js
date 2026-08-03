'use strict';

/**
 * Azure Blob Storage helper — THE platform pattern for private media.
 *
 * First consumer: TC media (gallery photos, smile-sim images) via the Slice 2
 * importer. Future consumers (EOB PDFs for the RCM module, etc.) reuse this
 * module and its conventions rather than growing their own storage code.
 *
 * Platform rules (do not relax):
 *  - Auth is ALWAYS Azure AD via DefaultAzureCredential: managed identity in
 *    Azure (user-assigned MI resolves through the standard AZURE_CLIENT_ID
 *    env var), `az login` on a workstation. Storage accounts are provisioned
 *    with shared-key auth DISABLED — there are no account keys or SAS tokens
 *    anywhere, and none may be introduced.
 *  - Containers are PRIVATE (public blob access is disabled account-wide).
 *    Bytes reach users only through an entitlement-checked backend proxy
 *    (Slice 3/4), never by handing out blob URLs.
 *  - Rows store blob KEYS, never URLs. Keys are multi-tenant-safe by
 *    construction: tenant/<tenantSlug>/<module>/<entity>/<uuid>.<ext>
 *    (e.g. tenant/carein/tc/gallery/6f9c….jpg). Keys never embed patient
 *    names or legacy filenames.
 *
 * Staging account: stcareinstaging / container tc-media (rg-carein-staging).
 * The prod account is created on the prod promotion path at cutover.
 */

const crypto = require('crypto');
const { BlobServiceClient } = require('@azure/storage-blob');
const { DefaultAzureCredential } = require('@azure/identity');

const KEY_SEGMENT_RE = /^[a-z0-9][a-z0-9-]*$/;
const EXT_RE = /^[a-z0-9]{2,5}$/;

/**
 * Build a platform blob key: tenant/<tenantSlug>/<module>/<entity>/<uuid>.<ext>.
 * Every segment is validated — a malformed slug or extension throws rather
 * than producing a key outside the tenant prefix.
 *
 * @param {{ tenantSlug: string, module: string, entity: string, ext: string, id?: string }} parts
 * @returns {string}
 */
function buildBlobKey({ tenantSlug, module, entity, ext, id }) {
  const cleanExt = String(ext).toLowerCase().replace(/^\./, '');
  for (const [name, val] of [
    ['tenantSlug', tenantSlug],
    ['module', module],
    ['entity', entity],
  ]) {
    if (!KEY_SEGMENT_RE.test(String(val))) {
      throw new Error(`[blobStore] invalid key segment ${name}='${val}'`);
    }
  }
  if (!EXT_RE.test(cleanExt)) {
    throw new Error(`[blobStore] invalid extension '${ext}'`);
  }
  const uuid = id || crypto.randomUUID();
  return `tenant/${tenantSlug}/${module}/${entity}/${uuid}.${cleanExt}`;
}

/**
 * Create a blob store bound to one account + container.
 *
 * @param {{ accountName: string, containerName: string }} opts
 */
function createBlobStore({ accountName, containerName }) {
  if (!accountName || !containerName) {
    throw new Error('[blobStore] accountName and containerName are required');
  }
  const service = new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );
  const container = service.getContainerClient(containerName);

  return {
    accountName,
    containerName,
    buildBlobKey,

    /**
     * Upload a buffer. Overwrites an existing blob at the same key (keys are
     * uuid-based, so collisions only happen on a deliberate re-upload).
     * @param {string} key
     * @param {Buffer} data
     * @param {string} contentType
     * @returns {Promise<{ key: string, bytes: number }>}
     */
    async upload(key, data, contentType) {
      const blob = container.getBlockBlobClient(key);
      await blob.uploadData(data, {
        blobHTTPHeaders: { blobContentType: contentType || 'application/octet-stream' },
      });
      return { key, bytes: data.length };
    },

    /**
     * @param {string} key
     * @returns {Promise<boolean>}
     */
    async exists(key) {
      return container.getBlockBlobClient(key).exists();
    },

    /**
     * Download a blob's bytes (the future serving proxy streams instead —
     * this is for tooling and verification).
     * @param {string} key
     * @returns {Promise<Buffer>}
     */
    async download(key) {
      return container.getBlockBlobClient(key).downloadToBuffer();
    },

    /**
     * List keys under a prefix (verification/reconciliation tooling).
     * @param {string} prefix
     * @returns {Promise<Array<{ key: string, bytes: number }>>}
     */
    async list(prefix) {
      const out = [];
      for await (const item of container.listBlobsFlat({ prefix })) {
        out.push({ key: item.name, bytes: item.properties.contentLength || 0 });
      }
      return out;
    },
  };
}

module.exports = { createBlobStore, buildBlobKey };
