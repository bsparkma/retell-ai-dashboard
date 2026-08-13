'use strict';

/**
 * Call retention — the stub shape, the cutoff, and the pruner.
 *
 * WHY THIS EXISTS. The unified call store is one JSON file that only ever grew:
 * every persist() synchronously stringifies the whole thing onto an AzureFile
 * mount, and there has never been a delete primitive, so the cost of a single
 * worklist click has been rising monotonically since day one. This slice is an
 * availability fix first and a data-hygiene feature second.
 *
 * THE POLICY (locked by Beau, 2026-08-13, do not relitigate here):
 *   - After 30 days a call's full record is replaced BY A THIN AUDIT STUB.
 *   - A stub carries the call id, the office, and the actions people took on it
 *     with actor + timestamp. NOTHING ELSE.
 *   - Worked and unworked calls age out on the same schedule. There is no hold
 *     state and no expiry warning.
 *
 * WHAT A STUB DELIBERATELY DOES NOT CARRY, and where the trail survives instead:
 *   - `od_commlog_num` — the chart note itself is the record, in Open Dental.
 *   - `tc_case_id`     — a TC case stores its own `source_call_id`, so the link
 *                        is still traversable from the TC side.
 *   - `disposition`    — the enum values characterise the CALLER ('spam',
 *                        'personal'), so the value is content, not bookkeeping.
 *                        That somebody dispositioned the call still survives.
 *
 * Two fields are in the stub that a strict reading of "id, office, actions"
 * would not put there, and both are load-bearing rather than convenience:
 *   - `call_date`  the pruner, the date index and the sort order all need it,
 *                  and without it a stub would be re-evaluated forever. A bare
 *                  timestamp with no identity attached is not PHI.
 *   - `source` + twin linkage — see stubbing rules in unifiedCallStore: twins
 *                  age out as a unit, and a `linked_call_id` pointing at nothing
 *                  is the one broken state this slice must not create.
 */

const { getOfficeForCall } = require('../config/officeAgents');
const { normalizeActor } = require('../utils/callDispositions');

/** Marks a record that has been reduced to its audit stub. */
const RECORD_KIND_STUB = 'stub';
/** Marks a full, live call record. Absent on rows written before this slice. */
const RECORD_KIND_CALL = 'call';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How a live record's `<field>_by` / `<field>_at` pairs map onto stub actions.
 * Order here is the order they are emitted in when timestamps tie.
 * @type {ReadonlyArray<{ action: string, by: string, at: string }>}
 */
const ACTION_SOURCES = Object.freeze([
  { action: 'transcribed', by: 'transcribed_by', at: 'transcribed_at' },
  { action: 'triaged', by: 'triage_by', at: 'triage_at' },
  { action: 'sent_to_chart', by: 'sent_by', at: 'sent_at' },
  { action: 'sent_to_tc', by: 'tc_sent_by', at: 'tc_sent_at' },
  { action: 'dispositioned', by: 'disposition_by', at: 'disposition_at' },
  { action: 'resolved', by: 'resolved_by', at: 'resolved_at' },
]);

/**
 * Is this record already a stub?
 *
 * Everything that mutates the store consults this, so it must be total: null,
 * undefined and non-objects all answer false rather than throwing.
 *
 * @param {unknown} record
 * @returns {boolean}
 */
function isStub(record) {
  return Boolean(
    record && typeof record === 'object' && record.record_kind === RECORD_KIND_STUB
  );
}

/**
 * The actions taken on a call, oldest first.
 *
 * An action is emitted only when it has BOTH a timestamp and the field it came
 * from — "handled by nobody at no time" is not a thing we record. A note
 * contributes one `note_added` entry carrying its author and creation time; its
 * text never leaves this function.
 *
 * @param {Record<string, any>} call
 * @returns {Array<{ action: string, actor: {name: string|null, email: string|null}|null, at: string }>}
 */
function actionsFor(call) {
  const actions = [];

  for (const { action, by, at } of ACTION_SOURCES) {
    const when = call[at];
    if (typeof when !== 'string' || !when) continue;
    actions.push({ action, actor: normalizeActor(call[by]), at: when });
  }

  if (Array.isArray(call.notes)) {
    for (const note of call.notes) {
      if (!note || typeof note !== 'object') continue;
      const when = note.created_at;
      if (typeof when !== 'string' || !when) continue;
      actions.push({ action: 'note_added', actor: normalizeActor(note.author), at: when });
    }
  }

  return actions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/**
 * Reduce a live call to its audit stub.
 *
 * IDEMPOTENT BY CONTRACT: handed a stub it returns that same stub untouched,
 * including its original `pruned_at`. The pruner is re-runnable and may die
 * mid-run, so "prune what is already pruned" is the normal case, not the edge
 * case — and a second pass must not rewrite history to claim the record was
 * pruned later than it was.
 *
 * @param {Record<string, any>} call
 * @param {{ now?: Date }} [opts]
 * @returns {Record<string, any>} the stub
 */
function toStub(call, { now = new Date() } = {}) {
  if (isStub(call)) return call;

  return {
    id: call.id,
    record_kind: RECORD_KIND_STUB,
    // Source and office are identifiers, not content. The office MUST be frozen
    // here: it is derived from called_number / handler_id, both of which the
    // stub drops, so deriving it later would be impossible.
    source: call.source || null,
    office: getOfficeForCall(call),
    call_date: call.call_date || null,
    pruned_at: now.toISOString(),
    // Twin linkage survives so the pair stays coherent — see stubCalls().
    linked_call_id: call.linked_call_id ?? null,
    link_role: call.link_role ?? null,
    actions: actionsFor(call),
  };
}

/**
 * The instant before which a call is past retention.
 * @param {Date} now
 * @param {number} retentionDays
 * @returns {Date}
 */
function cutoffFor(now, retentionDays) {
  return new Date(now.getTime() - retentionDays * MS_PER_DAY);
}

/**
 * Is this call old enough to be reduced to a stub?
 *
 * FAIL-SAFE, and the direction matters: a missing or unparseable `call_date`
 * answers **false**. Pruning is irreversible, so a malformed timestamp must
 * cost us disk, never data. `retentionDays <= 0` disables pruning entirely,
 * which is what makes CALL_RETENTION_DAYS=0 a real kill switch rather than a
 * "prune everything" foot-gun.
 *
 * @param {{ call_date?: unknown }} call
 * @param {Date} now
 * @param {number} retentionDays
 * @returns {boolean}
 */
function isPastRetention(call, now, retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return false;
  const raw = call && call.call_date;
  if (typeof raw !== 'string' || !raw) return false;
  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) return false;
  return when.getTime() < cutoffFor(now, retentionDays).getTime();
}

/**
 * Every live record in the store that is past retention.
 *
 * Selection is a separate pass from mutation on purpose: it snapshots the ids
 * BEFORE anything changes, so the loop that follows is not iterating a map it is
 * also writing to. Already-stubbed rows are excluded here rather than skipped
 * later, which is what makes a resumed run report an honest `stubbed` count
 * instead of counting the work the previous run already did.
 *
 * @param {{ calls: Map<string, any> }} store
 * @param {{ now: Date, retentionDays: number }} opts
 * @returns {string[]}
 */
function selectExpired(store, { now, retentionDays }) {
  const ids = [];
  for (const call of store.calls.values()) {
    if (isStub(call)) continue;
    if (!isPastRetention(call, now, retentionDays)) continue;
    ids.push(call.id);
  }
  return ids;
}

/**
 * One prune pass: reduce every call past retention to its audit stub.
 *
 * IDEMPOTENT AND RESUMABLE. Each record is swapped by a single synchronous
 * `stubCalls` call, so there is no window in which a record is half-converted —
 * a process that dies mid-run leaves every row either fully live or fully
 * stubbed, and the next run picks up exactly the remainder.
 *
 * The store is written ONCE, at the end, and not at all when nothing changed.
 * Per-record persistence would mean thousands of whole-store writes to AzureFile
 * in a single job, which is the cost this slice exists to remove, not add to.
 *
 * @param {object} store the unified call store
 * @param {{ now?: Date, retentionDays: number, onProgress?: (id: string) => void }} opts
 *   `onProgress` is called after each record is stubbed; tests use it to simulate
 *   a mid-run death, and the caller can use it for progress logging.
 * @returns {Promise<{scanned: number, stubbed: number, alreadyStubbed: number,
 *                    cutoff: string|null, durationMs: number}>}
 */
async function runPrune(store, { now = new Date(), retentionDays, onProgress } = {}) {
  const startedAt = Date.now();
  const expired = selectExpired(store, { now, retentionDays });

  let stubbed = 0;
  let alreadyStubbed = 0;
  try {
    for (const id of expired) {
      // One id at a time. stubCalls still expands twins, so the other leg goes
      // with it even when that leg is younger than the cutoff.
      const result = store.stubCalls([id], { now });
      stubbed += result.stubbed;
      alreadyStubbed += result.alreadyStubbed;
      if (onProgress) onProgress(id);
    }
  } finally {
    // Persist whatever got done, even on the way out of a failure. A crash that
    // discarded completed work would make the job non-resumable in the one case
    // resumability is for.
    if (stubbed > 0) await store.persist();
  }

  return {
    scanned: expired.length,
    stubbed,
    alreadyStubbed,
    cutoff: retentionDays > 0 ? cutoffFor(now, retentionDays).toISOString() : null,
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  RECORD_KIND_STUB,
  RECORD_KIND_CALL,
  isStub,
  toStub,
  actionsFor,
  cutoffFor,
  isPastRetention,
  selectExpired,
  runPrune,
};
