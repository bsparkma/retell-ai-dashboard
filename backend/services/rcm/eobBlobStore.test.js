'use strict';

/**
 * EOB blob keys are OPAQUE.
 *
 * The rule this pins: a blob key contains no filename, no patient name, no
 * claim number, no office — nothing derived from the document. EOB filenames
 * routinely carry patient names ("Smith EOB 3-14.pdf"), and a key is not a
 * private thing: it appears in blob inventory, storage metrics, diagnostic
 * logs, and any error message that quotes it.
 *
 * The strongest guarantee is structural rather than assertive — buildEobKey
 * takes NO filename parameter, so there is nothing to pass in even by mistake.
 * These tests pin that the signature stays that way and that what comes out is
 * a uuid under the tenant prefix.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { buildEobKey, isConfigured } = require('./eobBlobStore');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

test('a key is tenant/<slug>/rcm/eob/<uuid>.pdf and nothing else', () => {
  const key = buildEobKey({ tenantSlug: 'carein' });
  const parts = key.split('/');
  assert.equal(parts.length, 5);
  assert.deepEqual(parts.slice(0, 4), ['tenant', 'carein', 'rcm', 'eob']);
  const [uuid, ext] = parts[4].split('.');
  assert.match(uuid, UUID_RE, `expected a uuid, got '${uuid}'`);
  assert.equal(ext, 'pdf');
});

test('two uploads of the same document get different keys', () => {
  const a = buildEobKey({ tenantSlug: 'carein' });
  const b = buildEobKey({ tenantSlug: 'carein' });
  assert.notEqual(a, b, 'keys are minted per upload, never derived from content');
});

test('buildEobKey accepts NO filename — the signature is the guarantee', () => {
  // A key builder that took a filename would be one careless call away from
  // putting a patient name in a blob path. It does not take one, and an extra
  // property is ignored rather than honored.
  const key = buildEobKey({
    tenantSlug: 'carein',
    filename: 'Testpatient Alpha EOB 3-14.pdf',
    patientName: 'Testpatient, Alpha',
    office: 'roland',
  });
  assert.ok(!/Testpatient/i.test(key));
  assert.ok(!/Alpha/i.test(key));
  assert.ok(!/EOB.*3-14/i.test(key));
  assert.ok(!/roland|valley/i.test(key), 'not even the office belongs in a key');
  assert.equal(key.split('/').length, 5);
});

test('the source function has no filename-shaped parameter at all', () => {
  const src = fs.readFileSync(path.join(__dirname, 'eobBlobStore.js'), 'utf8');
  const signature = src.match(/function buildEobKey\(\{([^}]*)\}\)/);
  assert.ok(signature, 'buildEobKey must keep its destructured-object signature');
  const params = signature[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(params, ['tenantSlug', 'id'], `unexpected parameters: ${params.join(', ')}`);
});

test('putEob mints the key itself — a caller cannot supply one', () => {
  const src = fs.readFileSync(path.join(__dirname, 'eobBlobStore.js'), 'utf8');
  const signature = src.match(/async function putEob\(\{([^}]*)\}\)/);
  assert.ok(signature, 'putEob must keep its destructured-object signature');
  const params = signature[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(!params.includes('key'), 'putEob must not accept a caller-supplied key');
  assert.ok(!params.includes('filename'), 'putEob must not accept a filename');
});

test('a malformed tenant slug throws rather than producing a key outside the prefix', () => {
  for (const slug of ['../escape', 'CareIN', 'care in', '', 'tenant/x']) {
    assert.throws(() => buildEobKey({ tenantSlug: slug }), /invalid key segment/, `slug '${slug}'`);
  }
});

test('unconfigured is a legal state, reported rather than thrown at require time', () => {
  const prior = process.env.RCM_BLOB_ACCOUNT_URL;
  try {
    delete process.env.RCM_BLOB_ACCOUNT_URL;
    assert.equal(isConfigured(), false);
    process.env.RCM_BLOB_ACCOUNT_URL = 'https://example.blob.core.windows.net';
    assert.equal(isConfigured(), true);
  } finally {
    if (prior === undefined) delete process.env.RCM_BLOB_ACCOUNT_URL;
    else process.env.RCM_BLOB_ACCOUNT_URL = prior;
  }
});

test('there is no shared-key or SAS path in this module', () => {
  // The platform's storage accounts have shared-key auth DISABLED, so a
  // connection string is a credential that cannot exist for them. A helpful
  // future edit adding one would be a real regression, not a convenience.
  const src = fs.readFileSync(path.join(__dirname, 'eobBlobStore.js'), 'utf8');
  for (const forbidden of [
    'StorageSharedKeyCredential',
    'fromConnectionString',
    'generateBlobSASQueryParameters',
    'AZURE_STORAGE_CONNECTION_STRING',
  ]) {
    assert.ok(!src.includes(forbidden), `eobBlobStore.js must not use ${forbidden}`);
  }
});
