/**
 * Hand-written declarations for services/blobStore.js so TypeScript consumers
 * (the tc-import CLI in new-dashboard) get the platform API typed. Keep in
 * sync with the JSDoc in blobStore.js.
 */

export interface BlobKeyParts {
  tenantSlug: string;
  module: string;
  entity: string;
  ext: string;
  id?: string;
}

export interface BlobStore {
  accountName: string;
  containerName: string;
  buildBlobKey(parts: BlobKeyParts): string;
  upload(key: string, data: Buffer, contentType: string): Promise<{ key: string; bytes: number }>;
  exists(key: string): Promise<boolean>;
  download(key: string): Promise<Buffer>;
  list(prefix: string): Promise<Array<{ key: string; bytes: number }>>;
}

export function createBlobStore(opts: {
  accountName: string;
  containerName: string;
}): BlobStore;

export function buildBlobKey(parts: BlobKeyParts): string;
