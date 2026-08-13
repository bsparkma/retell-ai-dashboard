'use strict';

/**
 * The one-shot legacy purge: the ~1,660 Mango rows whose called line was never
 * mapped to an office, and which therefore have no practice to belong to.
 *
 * The two behaviours worth being paranoid about are both here: the dry run is
 * the DEFAULT (so a mis-typed call reports instead of destroying), and the live
 * run will not proceed without a backup on disk.
 *
 * All fixtures synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { beforeEach, afterEach } = test;
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const store = require('./unifiedCallStore');
const legacyPurge = require('./legacyPurge');

let tmpDir;
let originalPersistPath;
let originalTempPath;
let originalRequestPersist;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'callstore-purge-'));
  originalPersistPath = store.persistPath;
  originalTempPath = store.tempPath;
  originalRequestPersist = store.requestPersist;
  store.persistPath = path.join(tmpDir, 'unified_calls.json');
  store.tempPath = `${store.persistPath}.tmp`;
  store.requestPersist = () => {};
  store.clear();
});

afterEach(async () => {
  store.persistPath = originalPersistPath;
  store.tempPath = originalTempPath;
  store.requestPersist = originalRequestPersist;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** A Mango call on an UNMAPPED line → office 'unknown'. The purge target. */
function seedUnknown(id, callDate) {
  return store.addCallInternal({
    id, external_id: id, source: 'mango',
    caller_number: `+1555010${id.slice(-4)}`,
    called_number: '+15550100000', // not in MANGO_LINE_OFFICE
    call_date: callDate,
    summary: 'a synthetic summary',
  });
}

/** A Retell call — always attributable, never a purge target. */
function seedRetell(id, callDate) {
  return store.addCallInternal({
    id, source: 'retell', handler_id: 'agent_3007741dd93381f51675417edb',
    caller_number: `+1555020${id.slice(-4)}`, call_date: callDate,
  });
}

// --- dry run ---------------------------------------------------------------

test('the dry run is the DEFAULT and deletes nothing', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  seedUnknown('mango_call_0002', '2026-02-05T15:00:00.000Z');

  const result = await legacyPurge.runLegacyPurge(store);

  assert.equal(result.dryRun, true);
  assert.equal(result.count, 2);
  assert.equal(result.deleted, 0);
  assert.equal(store.calls.size, 2, 'a dry run must leave the store exactly as it was');
});

test('the dry run reports source and date range so the count can be sanity-checked', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  seedUnknown('mango_call_0002', '2026-02-05T15:00:00.000Z');
  seedUnknown('mango_call_0003', '2026-03-05T15:00:00.000Z');

  const result = await legacyPurge.runLegacyPurge(store);

  assert.deepEqual(result.bySource, { mango: 3 });
  assert.equal(result.dateRange.from, '2026-01-05T15:00:00.000Z');
  assert.equal(result.dateRange.to, '2026-03-05T15:00:00.000Z');
});

test('only unknown-office rows are targeted', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  seedRetell('call_r0001', '2026-01-05T15:00:00.000Z');
  store.addCallInternal({
    id: 'mango_call_mapped', external_id: 'mango_call_mapped', source: 'mango',
    caller_number: '+15550100999', called_number: '+19185036262', // a MAPPED Roland line
    call_date: '2026-01-05T15:00:00.000Z',
  });

  const result = await legacyPurge.runLegacyPurge(store);

  assert.deepEqual(result.ids, ['mango_call_0001']);
});

test('an already-pruned stub is not a purge target — there is nothing left to purge', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  store.stubCalls(['mango_call_0001']);

  const result = await legacyPurge.runLegacyPurge(store);

  assert.equal(result.count, 0);
});

test('a twinned row is REFUSED, not silently taken with its twin', async () => {
  // A Mango leg on an unmapped line can still be twinned to a Retell call that IS
  // attributable. Deleting both to satisfy the twin invariant would destroy a
  // Roland call with a transcript because its PBX leg had an unmapped DID.
  const mango = seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  const retell = seedRetell('call_r0001', '2026-01-05T15:00:05.000Z');
  mango.linked_call_id = retell.id;
  mango.link_role = 'duplicate_leg';
  retell.linked_call_id = mango.id;
  retell.link_role = 'primary';

  const result = await legacyPurge.runLegacyPurge(store);

  assert.equal(result.count, 0);
  assert.deepEqual(result.skippedTwinned, ['mango_call_0001']);
});

// --- live run --------------------------------------------------------------

test('the live run needs an explicit confirmation', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');

  await assert.rejects(
    () => legacyPurge.runLegacyPurge(store, { dryRun: false }),
    /PURGE_NOT_CONFIRMED/
  );
  assert.equal(store.calls.size, 1);
});

test('the live run writes a backup before deleting anything', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');

  const result = await legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' });

  assert.equal(result.deleted, 1);
  assert.ok(result.backupPath, 'the live run must report where the backup landed');
  const backup = JSON.parse(await fs.readFile(result.backupPath, 'utf-8'));
  assert.equal(backup.calls.length, 1, 'the backup holds the PRE-purge store');
  assert.equal(store.calls.size, 0);
});

test('the live run refuses to proceed when the backup cannot be written', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  // A directory that does not exist and cannot be created under a file.
  store.persistPath = path.join(tmpDir, 'unified_calls.json', 'nested', 'store.json');

  await assert.rejects(
    () => legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' }),
    /BACKUP_FAILED/
  );
  assert.equal(store.calls.size, 1, 'nothing may be deleted without a backup');
});

test('the live run tombstones what it deleted, so a re-ingest cannot undo it', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');

  await legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' });
  store.addMangoCalls([{
    id: 'mango_call_0001', external_id: 'mango_call_0001',
    caller_number: '+15550100001', called_number: '+15550100000',
    call_date: '2026-01-05T15:00:00.000Z',
  }]);

  assert.equal(store.getCall('mango_call_0001'), undefined);
});

test('re-running the live purge is a harmless no-op', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  await legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' });

  const second = await legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' });

  assert.equal(second.deleted, 0);
});

// --- the backup, on a filesystem that refuses copyFile -----------------------
//
// The staging rehearsal of the live purge failed with
//   BACKUP_FAILED: could not back up the call store: EPERM: operation not permitted
// out of fs.copyFile against the AzureFile (CIFS) mount at /data. Fail-closed did
// its job — nothing was deleted — but the purge could not run at all.
//
// copyFile leans on kernel copy / permission-preservation paths that the mount
// refuses. Plain readFile/writeFile to that same directory demonstrably work:
// persist() does exactly that, constantly, in prod.

/** Patch one method on node:fs/promises for the duration of a test. */
function patchFs(name, impl) {
  const real = fs[name];
  fs[name] = impl(real);
  return () => { fs[name] = real; };
}

/** Is this the backup file (as opposed to the store persist() writes)? */
const isBackup = (p) => String(p).includes('unified_calls.backup-');

test('the backup never uses copyFile — the AzureFile mount refuses it (EPERM)', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  // Reproduce the mount's behaviour exactly: copyFile is simply not available.
  const restore = patchFs('copyFile', () => async () => {
    const err = new Error('EPERM: operation not permitted, copyfile');
    err.code = 'EPERM';
    throw err;
  });

  try {
    const result = await legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' });

    assert.equal(result.deleted, 1, 'the purge must complete on a mount with no copyFile');
    const backup = JSON.parse(await fs.readFile(result.backupPath, 'utf-8'));
    assert.equal(backup.calls.length, 1);
  } finally {
    restore();
  }
});

test('the backup round-trips the whole store, byte for byte', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  seedUnknown('mango_call_0002', '2026-02-05T15:00:00.000Z');
  seedUnknown('mango_call_0003', '2026-03-05T15:00:00.000Z');

  const result = await legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' });

  const original = await fs.readFile(store.persistPath, 'utf-8');
  const backup = await fs.readFile(result.backupPath, 'utf-8');
  assert.notEqual(original, backup, 'the store was rewritten by the purge; the backup was not');

  const parsed = JSON.parse(backup);
  assert.deepEqual(
    parsed.calls.map((c) => c.id).sort(),
    ['mango_call_0001', 'mango_call_0002', 'mango_call_0003'],
    'the backup holds every pre-purge record'
  );
  assert.deepEqual(parsed.purgedIds, [], 'and the pre-purge tombstone, so a restore is complete');
});

test('a failed backup WRITE aborts the purge and deletes nothing', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  // Fail only the backup write. persist() must keep working, or this would be
  // testing the flush rather than the backup.
  const restore = patchFs('writeFile', (real) => async (file, ...rest) => {
    if (isBackup(file)) {
      const err = new Error('EPERM: operation not permitted, open');
      err.code = 'EPERM';
      throw err;
    }
    return real(file, ...rest);
  });

  try {
    await assert.rejects(
      () => legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' }),
      /BACKUP_FAILED/
    );
  } finally {
    restore();
  }
  assert.equal(store.calls.size, 1, 'nothing may be deleted without a backup');
});

test('a TRUNCATED backup aborts the purge — an unverified backup is no backup', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  // The write "succeeds" but only half the bytes land — the failure mode a
  // network filesystem actually produces, and the one a bare write cannot see.
  const restore = patchFs('writeFile', (real) => async (file, data, ...rest) =>
    isBackup(file) ? real(file, String(data).slice(0, 20), ...rest) : real(file, data, ...rest)
  );

  try {
    await assert.rejects(
      () => legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' }),
      /BACKUP_FAILED/
    );
  } finally {
    restore();
  }
  assert.equal(store.calls.size, 1);
});

test('a ZERO-BYTE backup aborts the purge', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  const restore = patchFs('writeFile', (real) => async (file, data, ...rest) =>
    isBackup(file) ? real(file, '', ...rest) : real(file, data, ...rest)
  );

  try {
    await assert.rejects(
      () => legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' }),
      /BACKUP_FAILED/
    );
  } finally {
    restore();
  }
  assert.equal(store.calls.size, 1);
});

test('a backup with no calls array aborts the purge', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');
  // Parseable JSON, but not a store. Checking "did it parse?" alone would pass
  // this, and we would have deleted 1,660 records against a backup of `{}`.
  const restore = patchFs('writeFile', (real) => async (file, data, ...rest) =>
    isBackup(file) ? real(file, '{"savedAt":"2026-08-13T00:00:00.000Z"}', ...rest) : real(file, data, ...rest)
  );

  try {
    await assert.rejects(
      () => legacyPurge.runLegacyPurge(store, { dryRun: false, confirm: 'DELETE' }),
      /BACKUP_FAILED/
    );
  } finally {
    restore();
  }
  assert.equal(store.calls.size, 1);
});

test('a dry run writes no backup file at all', async () => {
  seedUnknown('mango_call_0001', '2026-01-05T15:00:00.000Z');

  const result = await legacyPurge.runLegacyPurge(store);

  assert.equal(result.backupPath, null);
  const written = (await fs.readdir(tmpDir)).filter(isBackup);
  assert.deepEqual(written, [], 'a dry run must not touch the backup path');
});
