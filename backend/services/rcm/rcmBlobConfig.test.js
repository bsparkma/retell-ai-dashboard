'use strict';

/**
 * The two RCM blob stores must not share a container env var.
 *
 * WHY THIS TEST EXISTS. `eobBlobStore.js` and `eraFileStore.js` were written a
 * slice apart, and both read `RCM_BLOB_CONTAINER` — with DIFFERENT defaults
 * ('rcm-eob' and 'rcm-era'). That arrangement is correct only for as long as
 * nobody sets the variable. Setting it, which is the obvious thing to do when
 * you are staring at a container name in the portal, silently routes raw 835
 * files into the EOB container or EOB PDFs into the ERA one. Neither corrupts
 * data — the keys still carry `/rcm/era/` and `/rcm/eob/` — but the container
 * separation the storage layout is built on would quietly stop existing.
 *
 * It was caught during the staging storage build-out (2026-08-15) before any
 * environment had the variable set, so nothing was ever mis-filed. The split is
 * what makes that permanent; this test is what keeps it split.
 *
 * The ACCOUNT url is deliberately still shared: both containers live on one
 * storage account (stcareinstaging / stcareinprod), so one url is the truth.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const eobSrc = fs.readFileSync(path.join(__dirname, 'eobBlobStore.js'), 'utf8');
const eraSrc = fs.readFileSync(path.join(__dirname, 'eraFileStore.js'), 'utf8');

/** Every `process.env.X` read in a source file. */
function envReads(src) {
  return [...src.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]);
}

test('neither store reads the old shared RCM_BLOB_CONTAINER', () => {
  for (const [name, src] of [
    ['eobBlobStore.js', eobSrc],
    ['eraFileStore.js', eraSrc],
  ]) {
    assert.ok(
      !envReads(src).includes('RCM_BLOB_CONTAINER'),
      `${name} still reads RCM_BLOB_CONTAINER — the two stores must not share one ` +
        'container variable, or setting it sends both to the same container'
    );
  }
});

test('each store reads its OWN container variable', () => {
  assert.ok(envReads(eobSrc).includes('RCM_EOB_CONTAINER'), 'eobBlobStore.js must read RCM_EOB_CONTAINER');
  assert.ok(envReads(eraSrc).includes('RCM_ERA_CONTAINER'), 'eraFileStore.js must read RCM_ERA_CONTAINER');
});

test('the two stores share NO container variable at all', () => {
  const shared = envReads(eobSrc)
    .filter((v) => v.includes('CONTAINER'))
    .filter((v) => envReads(eraSrc).includes(v));
  assert.deepEqual(shared, [], `container variables read by BOTH stores: ${shared.join(', ')}`);
});

test('they DO still share the account url — one account, one truth', () => {
  assert.ok(envReads(eobSrc).includes('RCM_BLOB_ACCOUNT_URL'));
  assert.ok(envReads(eraSrc).includes('RCM_BLOB_ACCOUNT_URL'));
});

test('the defaults still match the containers provisioned in Azure', () => {
  // stcareinstaging and stcareinprod both hold exactly these two container
  // names (created 2026-08-15). Changing a default here without creating the
  // container there is a 404 at upload time, in an environment where nobody set
  // the override precisely BECAUSE the default was right.
  assert.match(eobSrc, /RCM_EOB_CONTAINER \|\| 'rcm-eob'/);
  assert.match(eraSrc, /RCM_ERA_CONTAINER \|\| 'rcm-era'/);
});

test('unset is still the correct configuration', () => {
  // The whole point of keeping the defaults: staging and prod set only
  // RCM_BLOB_ACCOUNT_URL. If either store ever REQUIRED its container var, a
  // working environment would break on deploy.
  const prior = { ...process.env };
  try {
    delete process.env.RCM_EOB_CONTAINER;
    delete process.env.RCM_ERA_CONTAINER;
    process.env.RCM_BLOB_ACCOUNT_URL = 'https://example.blob.core.windows.net';

    const eob = require('./eobBlobStore');
    const era = require('./eraFileStore');
    assert.equal(eob.isConfigured(), true, 'EOB storage must be configured by the account url alone');
    assert.equal(era.isConfigured(), true, 'ERA storage must be configured by the account url alone');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in prior)) delete process.env[k];
    Object.assign(process.env, prior);
  }
});
