'use strict';

// Unit tests for Slice A — webhook commlog hardening.
// Runner: `node --test`. Covers:
//   - dedup by call_id: a re-sent identical call_analyzed writes only ONE commlog;
//   - ambiguous match (number on >1 record) -> needs_review, NO write, candidates stored;
//   - non-string transcript doesn't throw on the persist / fallback-analysis path;
//   - the unified store preserves od_* sync state across re-add (the dedup-enabling fix).
// See docs/SLICE_WEBHOOK_COMMLOG_HARDENING_PRD.md.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;

const webhooks = require('./webhooks');
const openDentalSyncService = require('../services/openDentalSync');
const unifiedCallStore = require('../services/unifiedCallStore');
const callAnalyzer = require('../services/callAnalyzer');

let originalRequestPersist;

beforeEach(() => {
  // Don't touch disk and isolate state between tests (mirrors unifiedCallStore.test.js).
  originalRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
  webhooks._commlogInFlight.clear();
});

afterEach(() => {
  unifiedCallStore.requestPersist = originalRequestPersist;
  delete process.env.COMMLOG_AUTO_WRITE; // back to the review-then-send default (off)
});

// Swap the OD singleton's match + write for stubs; returns a record of createCommLog calls.
function stubOD({ match, create }) {
  const prev = {
    matchCallToPatient: openDentalSyncService.matchCallToPatient,
    createCommLog: openDentalSyncService.createCommLog,
  };
  const createCalls = [];
  openDentalSyncService.matchCallToPatient = async () => match;
  openDentalSyncService.createCommLog = async (patientId, entry) => {
    createCalls.push({ patientId, entry });
    return create ? create(patientId, entry) : { success: true, commLogNum: 1000 + createCalls.length };
  };
  return { createCalls, restore: () => Object.assign(openDentalSyncService, prev) };
}

const baseCall = (id) => ({
  call_id: id,
  from_number: '+15551234567',
  start_timestamp: '2026-06-06T20:00:00.000Z',
  end_timestamp: '2026-06-06T20:02:00.000Z',
  transcript: 'Agent: hello. User: hi, this is Stedi Test.',
  call_analysis: { caller_name: 'Stedi Test', call_summary: 'test call', appointment_booked: false },
});

const confidentMatch = {
  patient: { id: 555, firstName: 'Stedi', lastName: 'Test', fullName: 'Stedi Test' },
  confidence: 0.95,
  method: 'phone_exact',
};

test('flag OFF (default): confident match holds as "matched" — NO auto-write', async () => {
  const id = 'wh-matched-1';
  unifiedCallStore.addRetellCall(baseCall(id));
  const od = stubOD({ match: confidentMatch });
  try {
    const r = await webhooks.writeCommlogForAnalyzedCall(baseCall(id));
    assert.equal(r.matched, true);
    assert.equal(r.autoWrite, false);
    assert.equal(od.createCalls.length, 0, 'review-then-send must NOT write a commlog');
    const stored = unifiedCallStore.getCall(id);
    assert.equal(stored.od_sync_status, 'matched');
    assert.equal(stored.od_patient_id, 555);
    assert.equal(stored.od_patient_name, 'Stedi Test');
    assert.equal(stored.od_commlog_num ?? null, null);
  } finally { od.restore(); }
});

test('matched state survives a Retell re-add (regression)', () => {
  const id = 'wh-matched-preserve';
  unifiedCallStore.addRetellCall(baseCall(id));
  unifiedCallStore.updateCall(id, {
    od_sync_status: 'matched', od_patient_id: 555, od_patient_name: 'Stedi Test', od_match_confidence: 0.95,
  });
  unifiedCallStore.addRetellCall(baseCall(id)); // bare re-add, no od_* fields
  const stored = unifiedCallStore.getCall(id);
  assert.equal(stored.od_sync_status, 'matched');
  assert.equal(stored.od_patient_id, 555);
  assert.equal(stored.od_patient_name, 'Stedi Test');
});

test('flag ON: confident match auto-writes the commlog and marks synced (legacy)', async () => {
  process.env.COMMLOG_AUTO_WRITE = 'true';
  const id = 'wh-confident-1';
  unifiedCallStore.addRetellCall(baseCall(id));
  const od = stubOD({ match: confidentMatch });
  try {
    const r = await webhooks.writeCommlogForAnalyzedCall(baseCall(id));
    assert.equal(r.written, true);
    assert.equal(od.createCalls.length, 1);
    // Preserves the [CareIN AI — Inbound Call] note format.
    assert.match(od.createCalls[0].entry.Note, /^\[CareIN AI — Inbound Call\]/);
    const stored = unifiedCallStore.getCall(id);
    assert.equal(stored.od_sync_status, 'synced');
    assert.equal(stored.od_patient_id, 555);
    assert.ok(stored.od_commlog_num);
  } finally { od.restore(); }
});

test('flag ON dedup: a re-sent identical call_analyzed writes only ONE commlog', async () => {
  process.env.COMMLOG_AUTO_WRITE = 'true';
  const id = 'wh-dedup-1';
  unifiedCallStore.addRetellCall(baseCall(id));
  const od = stubOD({ match: confidentMatch });
  try {
    const r1 = await webhooks.writeCommlogForAnalyzedCall(baseCall(id));
    // Simulate the retry's handleCallAnalyzed re-persisting the raw payload (no od_* fields).
    unifiedCallStore.addRetellCall(baseCall(id));
    const r2 = await webhooks.writeCommlogForAnalyzedCall(baseCall(id));

    assert.equal(r1.written, true);
    assert.equal(r2.skipped, true);
    assert.equal(r2.reason, 'already_synced');
    assert.equal(od.createCalls.length, 1, 'createCommLog must be called exactly once across the retry');
  } finally { od.restore(); }
});

test('ambiguous match (number on multiple records) -> needs_review, NO write, candidates stored', async () => {
  const id = 'wh-ambiguous-1';
  unifiedCallStore.addRetellCall(baseCall(id));
  const od = stubOD({
    match: {
      patient: { id: 12447, fullName: 'John Doe' },
      confidence: 0.75,
      alternatives: [{ id: 1, fullName: 'Patient Test' }],
      method: 'phone_exact',
    },
  });
  try {
    const r = await webhooks.writeCommlogForAnalyzedCall(baseCall(id));
    assert.equal(r.needsReview, true);
    assert.equal(od.createCalls.length, 0, 'must NOT auto-write on an ambiguous (multi-record) match');
    const stored = unifiedCallStore.getCall(id);
    assert.equal(stored.od_sync_status, 'needs_review');
    assert.deepEqual(stored.od_match_candidates, [
      { id: 12447, name: 'John Doe' },
      { id: 1, name: 'Patient Test' },
    ]);
  } finally { od.restore(); }
});

test('no match -> needs_review, no write', async () => {
  const id = 'wh-nomatch-1';
  unifiedCallStore.addRetellCall(baseCall(id));
  const od = stubOD({ match: { patient: null, confidence: 0, method: 'no_match' } });
  try {
    const r = await webhooks.writeCommlogForAnalyzedCall(baseCall(id));
    assert.equal(r.needsReview, true);
    assert.equal(od.createCalls.length, 0);
    assert.equal(unifiedCallStore.getCall(id).od_sync_status, 'needs_review');
  } finally { od.restore(); }
});

test('isConfidentUnambiguousMatch: confident+unambiguous only', () => {
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.95 }), true); // phone single
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.85 }), true); // name+phone
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.80 }), true); // strong name-only (Stedi Test protocol)
  // ambiguous: number/name on multiple records -> never auto-write, regardless of confidence
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.95, alternatives: [{ id: 2 }] }), false);
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.75, alternatives: [{ id: 2 }] }), false);
  // fuzzy band, no alternatives: phone matched but name didn't (0.70), weak fuzzy name (<0.80)
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.70 }), false);
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: { id: 1 }, confidence: 0.79 }), false);
  // no patient
  assert.equal(webhooks.isConfidentUnambiguousMatch({ patient: null, confidence: 0 }), false);
});

test('unified store preserves od_sync_status across re-add (dedup-enabling fix)', () => {
  const id = 'store-preserve-1';
  unifiedCallStore.addRetellCall(baseCall(id));
  unifiedCallStore.updateCall(id, { od_sync_status: 'synced', od_commlog_num: 9999, od_patient_id: 7 });
  // A later poller/webhook re-add carries the raw payload (no od_* fields).
  unifiedCallStore.addRetellCall(baseCall(id));
  const stored = unifiedCallStore.getCall(id);
  assert.equal(stored.od_sync_status, 'synced');
  assert.equal(stored.od_commlog_num, 9999);
  assert.equal(stored.od_patient_id, 7);
});

test('non-string transcript does not throw on persist path or fallback analysis', () => {
  const transcriptObject = [
    { role: 'agent', content: 'thanks John' },
    { role: 'user', content: 'hi' },
  ];
  assert.doesNotThrow(() =>
    unifiedCallStore.addRetellCall({ call_id: 'ts-1', from_number: '+15550000000', transcript: transcriptObject })
  );
  assert.doesNotThrow(() => callAnalyzer.fallbackAnalysis({ transcript: transcriptObject }));
});
