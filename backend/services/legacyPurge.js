'use strict';

/**
 * The one-shot legacy purge.
 *
 * WHAT IT TARGETS. Mango rows whose called line was never in MANGO_LINE_OFFICE,
 * so `getOfficeForCall` resolved them to the system bucket 'unknown'. They belong
 * to no practice, they were never actionable (no office ⇒ no Open Dental write
 * path), and there are roughly 1,660 of them. Beau's decision, 2026-08-13: these
 * are DELETED outright rather than reduced to stubs — a stub of a call that never
 * had an office to belong to would record nothing worth keeping.
 *
 * WHY IT IS NOT THE SCHEDULED PRUNER. This runs ONCE, by hand, with a human
 * reading the count first. The pruner is a nightly job that stubs; this deletes.
 * Keeping them apart is what keeps the tombstone in unifiedCallStore bounded — see
 * the comment on `purgedIds`.
 *
 * THE TWO SAFETY PROPERTIES, both tested:
 *   1. `dryRun` DEFAULTS TO TRUE. Calling this function wrong reports; it does not
 *      destroy. The live run additionally needs `confirm: 'DELETE'`.
 *   2. No deletion happens until a backup of the store is on disk. If the backup
 *      throws, so does this, before anything is removed.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { getOfficeForCall, UNMAPPED_OFFICE } = require('../config/officeAgents');
const retention = require('./callRetention');

/** The literal a caller must pass to actually delete. */
const CONFIRM_TOKEN = 'DELETE';

class PurgeError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PurgeError';
    this.code = code;
  }
}

/**
 * Split the store's live records into purge targets and twinned refusals.
 *
 * A twinned row is REFUSED rather than taken. Twins age out as a unit, so
 * deleting an unknown-office Mango leg would drag its Retell twin with it — and
 * that twin IS attributable (Retell calls resolve by agent, never to 'unknown'),
 * carries the transcript, and is not legacy. Losing it because the PBX leg's DID
 * was unmapped would be the purge over-reaching. The dry run names them so the
 * count is explainable rather than mysteriously short.
 *
 * Stubs are excluded: a pruned record has nothing left to purge.
 *
 * @param {{calls: Map<string, any>}} store
 * @returns {{ ids: string[], skippedTwinned: string[] }}
 */
function selectLegacyUnknownOffice(store) {
  const ids = [];
  const skippedTwinned = [];

  for (const call of store.calls.values()) {
    if (retention.isStub(call)) continue;
    if (getOfficeForCall(call) !== UNMAPPED_OFFICE) continue;
    if (call.linked_call_id && store.calls.has(call.linked_call_id)) {
      skippedTwinned.push(call.id);
      continue;
    }
    ids.push(call.id);
  }

  return { ids, skippedTwinned };
}

/**
 * Describe a target set well enough for a human to accept or reject the count:
 * how many, from which source, and over what span of time.
 *
 * Counts and dates only — no caller names or numbers, because this summary is
 * meant to be pasted into a PR and read by more than one person.
 *
 * @param {{calls: Map<string, any>}} store
 * @param {string[]} ids
 */
function summarize(store, ids) {
  const bySource = {};
  let from = null;
  let to = null;

  for (const id of ids) {
    const call = store.calls.get(id);
    if (!call) continue;
    const source = call.source || 'unknown';
    bySource[source] = (bySource[source] || 0) + 1;
    const when = call.call_date;
    if (typeof when === 'string' && when) {
      if (from === null || when < from) from = when;
      if (to === null || when > to) to = when;
    }
  }

  return { count: ids.length, bySource, dateRange: { from, to } };
}

/**
 * Write a timestamped copy of the store file next to it, and return the path.
 *
 * The store is flushed first so the backup reflects the state we are about to
 * delete from rather than whatever the last debounced write happened to catch.
 * Any failure throws BACKUP_FAILED — the caller must not proceed.
 *
 * @param {{persistPath: string, isDirty: boolean, persist: () => Promise<void>}} store
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<string>} the backup path
 */
async function backupStore(store, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const dir = path.dirname(store.persistPath);
  const backupPath = path.join(dir, `unified_calls.backup-${stamp}.json`);

  try {
    // Flush pending in-memory changes so the file we copy is current. On a clean
    // store persist() returns immediately, and the file already matches.
    store.isDirty = true;
    await store.persist();
    await fs.copyFile(store.persistPath, backupPath);
  } catch (err) {
    throw new PurgeError('BACKUP_FAILED', `could not back up the call store: ${err.message}`);
  }

  return backupPath;
}

/**
 * Run the legacy purge.
 *
 * @param {object} store the unified call store
 * @param {{ dryRun?: boolean, confirm?: string, now?: Date }} [opts]
 *   `dryRun` defaults to TRUE. A live run needs `dryRun: false` AND
 *   `confirm: 'DELETE'`; anything else throws PURGE_NOT_CONFIRMED.
 * @returns {Promise<{dryRun: boolean, count: number, deleted: number, ids: string[],
 *                    skippedTwinned: string[], bySource: Record<string, number>,
 *                    dateRange: {from: string|null, to: string|null},
 *                    backupPath: string|null}>}
 */
async function runLegacyPurge(store, { dryRun = true, confirm = null, now = new Date() } = {}) {
  const { ids, skippedTwinned } = selectLegacyUnknownOffice(store);
  const summary = summarize(store, ids);

  if (dryRun) {
    return { dryRun: true, ...summary, ids, skippedTwinned, deleted: 0, backupPath: null };
  }

  if (confirm !== CONFIRM_TOKEN) {
    throw new PurgeError(
      'PURGE_NOT_CONFIRMED',
      `a live purge requires confirm='${CONFIRM_TOKEN}'; ${summary.count} record(s) would have been deleted`
    );
  }

  // Backup FIRST. Nothing below this line is recoverable without it.
  const backupPath = await backupStore(store, { now });

  const result = store.deleteCalls(ids);
  await store.persist();

  console.log(
    `[retention] legacy purge deleted=${result.deleted} skippedTwinned=${skippedTwinned.length} ` +
    `backup=${backupPath}`
  );

  return {
    dryRun: false,
    ...summary,
    ids,
    skippedTwinned,
    deleted: result.deleted,
    backupPath,
  };
}

module.exports = {
  CONFIRM_TOKEN,
  PurgeError,
  selectLegacyUnknownOffice,
  summarize,
  backupStore,
  runLegacyPurge,
};
