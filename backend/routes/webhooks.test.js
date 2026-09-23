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
const odOffices = require('../config/odOffices');
const callAnalyzer = require('../services/callAnalyzer');

let originalRequestPersist;

// Since the per-location slice the webhook path resolves the call's OFFICE before it
// matches anything, and an office with no customer key is refused (fail closed, per
// office). Retell calls with no mapped agent attribute to Roland, so Roland needs a
// key here. The value is a meaningless string — nothing here reaches a real OD.
function giveOfficesTestCredentials() {
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  odOffices.resetOdOfficeCache();
}

beforeEach(() => {
  giveOfficesTestCredentials();
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
  // `od` is the office-bound connection the write is going through — captured so
  // tests can assert WHICH practice's database a chart note was aimed at.
  openDentalSyncService.createCommLog = async (patientId, entry, od) => {
    createCalls.push({ patientId, entry, officeKey: od && od.officeKey });
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

// ─────────────────────────────────────────────────────────────────────────────
// Post-call analysis field names
//
// The commlog builder read "new_patient or existing_patient" and `dental_insurance`.
// The agent emits `patient_status` and `insurance_name`, and has for a long time —
// so every auto-written note said "Patient Type: unknown" and "Insurance: not
// provided" regardless of what the caller actually said. These pin the mapping in
// both directions: the names emitted today, and the old names still sitting on
// calls already in the store.
//
// Read-mapping only. Nothing below asserts a change in WHAT gets written or when —
// the note format, the write behaviour and the review-then-send default are
// untouched, and are pinned by the tests above.
// ─────────────────────────────────────────────────────────────────────────────

/** Run one call through the legacy auto-write path and hand back the note text. */
async function noteFor(id, analysis) {
  process.env.COMMLOG_AUTO_WRITE = 'true';
  const payload = { ...baseCall(id), call_analysis: { ...baseCall(id).call_analysis, ...analysis } };
  unifiedCallStore.addRetellCall(payload);
  const od = stubOD({ match: confidentMatch });
  try {
    await webhooks.writeCommlogForAnalyzedCall(payload);
    assert.equal(od.createCalls.length, 1, 'expected exactly one commlog write');
    return od.createCalls[0].entry.Note;
  } finally { od.restore(); }
}

const lineOf = (note, label) => (note.split('\n').find((l) => l.startsWith(`${label}:`)) || '').trim();

test('analysis fields: the names the agent emits today are read', async () => {
  const note = await noteFor('wh-fields-new', {
    patient_status: 'existing_patient',
    insurance_name: 'Humana',
  });
  assert.equal(lineOf(note, 'Patient Type'), 'Patient Type: existing_patient');
  assert.equal(lineOf(note, 'Insurance'), 'Insurance: Humana');
});

test('analysis fields: the OLD names still render for calls captured under them', async () => {
  const note = await noteFor('wh-fields-old', {
    'new_patient or existing_patient': 'new_patient',
    dental_insurance: 'Delta Dental Premier',
  });
  assert.equal(lineOf(note, 'Patient Type'), 'Patient Type: new_patient');
  assert.equal(lineOf(note, 'Insurance'), 'Insurance: Delta Dental Premier');
});

test('analysis fields: the new name wins when a call carries both', async () => {
  const note = await noteFor('wh-fields-both', {
    patient_status: 'existing_patient',
    'new_patient or existing_patient': 'new_patient',
    insurance_name: 'Aetna',
    dental_insurance: 'Cigna',
  });
  assert.equal(lineOf(note, 'Patient Type'), 'Patient Type: existing_patient');
  assert.equal(lineOf(note, 'Insurance'), 'Insurance: Aetna');
});

test('analysis fields: both absent falls back to the honest defaults', async () => {
  const note = await noteFor('wh-fields-absent', {});
  assert.equal(lineOf(note, 'Patient Type'), 'Patient Type: unknown');
  assert.equal(lineOf(note, 'Insurance'), 'Insurance: not provided');
});

test('analysis fields: an empty value is not an answer — it falls through', async () => {
  // An empty string must not print a blank line into a chart note, and must not
  // stop the older name from being read.
  const note = await noteFor('wh-fields-empty', {
    patient_status: '',
    insurance_name: '',
    dental_insurance: 'Guardian',
  });
  assert.equal(lineOf(note, 'Patient Type'), 'Patient Type: unknown');
  assert.equal(lineOf(note, 'Insurance'), 'Insurance: Guardian');
});

test('analysis fields: the rest of the note is unchanged by the mapping', async () => {
  const note = await noteFor('wh-fields-shape', {
    patient_status: 'existing_patient',
    insurance_name: 'MetLife',
  });
  assert.match(note, /^\[CareIN AI — Inbound Call\] Duration: \d+s/);
  assert.ok(note.includes('--- Full Transcript ---'), 'transcript section still present');
  assert.equal(lineOf(note, 'Appointment Booked'), 'Appointment Booked: no');
  assert.equal(lineOf(note, 'Emergency'), 'Emergency: no');
});
