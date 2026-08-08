const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach, beforeEach } = test;

const unifiedCallStore = require('./unifiedCallStore');

let originalRequestPersist;

beforeEach(() => {
  originalRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();
});

afterEach(() => {
  unifiedCallStore.requestPersist = originalRequestPersist;
});

test('addRetellCall accepts Retell millisecond timestamps', () => {
  const startTimestamp = 1777908187899;

  const stored = unifiedCallStore.addRetellCall({
    call_id: 'call_test_numeric_timestamp',
    agent_id: 'agent_test',
    from_number: '+14798832912',
    start_timestamp: startTimestamp,
    transcript: 'Agent: hello\nUser: hi\n',
  });

  assert.equal(stored.call_date, new Date(startTimestamp).toISOString());
  assert.equal(stored.source, 'retell');
  assert.equal(stored.caller_number, '+14798832912');
});

test('addRetellCall extracts caller name from Retell summary', () => {
  const stored = unifiedCallStore.addRetellCall({
    call_id: 'call_test_caller_name',
    from_number: '+14795551212',
    start_timestamp: 1777908187899,
    call_analysis: {
      call_summary: 'The caller, Sarah Cuedo, requested to change her appointment plan at checkout.',
    },
  });

  assert.equal(stored.caller_name, 'Sarah Cuedo');
});

test('new Retell call defaults to triage_status "new" with clean triage state', () => {
  const stored = unifiedCallStore.addRetellCall({
    call_id: 'call_triage_defaults',
    from_number: '+14795550000',
    start_timestamp: 1777908187899,
  });

  assert.equal(stored.triage_status, 'new');
  assert.equal(stored.not_a_patient, false);
  assert.equal(stored.triage_outcome, null);
  assert.equal(stored.triage_by, null);
  assert.equal(stored.resolved_by, null);
});

test('Slice-B triage/resolve state survives a Retell re-add (regression)', () => {
  // 1. Call arrives.
  unifiedCallStore.addRetellCall({
    call_id: 'call_triage_preserve',
    from_number: '+14795551313',
    start_timestamp: 1777908187899,
  });

  // 2. Front desk triages it + it gets resolved to a patient (what the new
  //    /triage and /resolve-patient endpoints persist via updateCall).
  unifiedCallStore.updateCall('call_triage_preserve', {
    triage_status: 'done',
    triage_outcome: 'scheduled',
    triage_by: { name: 'Sarah Front', email: 'sarah@carein.ai' },
    triage_at: '2026-07-20T15:14:00.000Z',
    triage_note: 'Booked hygiene',
    od_sync_status: 'synced',
    od_patient_id: 12827,
    resolved_by: { name: 'Sarah Front', email: 'sarah@carein.ai' },
    resolved_at: '2026-07-20T15:14:05.000Z',
  });

  // 3. The 15-min poller re-adds the same call with a bare Retell payload
  //    (no triage_* / od_* fields).
  const readded = unifiedCallStore.addRetellCall({
    call_id: 'call_triage_preserve',
    from_number: '+14795551313',
    start_timestamp: 1777908187899,
  });

  // Triage + resolve state must be intact, not reset to "new".
  assert.equal(readded.triage_status, 'done');
  assert.equal(readded.triage_outcome, 'scheduled');
  assert.deepEqual(readded.triage_by, { name: 'Sarah Front', email: 'sarah@carein.ai' });
  assert.equal(readded.triage_at, '2026-07-20T15:14:00.000Z');
  assert.equal(readded.triage_note, 'Booked hygiene');
  assert.equal(readded.od_sync_status, 'synced');
  assert.equal(readded.od_patient_id, 12827);
  assert.deepEqual(readded.resolved_by, { name: 'Sarah Front', email: 'sarah@carein.ai' });
  assert.equal(readded.resolved_at, '2026-07-20T15:14:05.000Z');
});

test('Mango match/triage state survives an addMangoCalls re-scrape upsert (regression)', () => {
  // 1. A Mango call is ingested by the scraper (raw shape — no od_*/triage fields).
  const rawMango = {
    source: 'mango',
    external_id: 'mango_call_4637427643',
    mango_call_id: '4637427643',
    mango_detail_url: 'https://app.mangovoice.com/calls/4637427643',
    call_date: '2026-07-20T15:00:00.000Z',
    caller_number: '+14795551414',
    called_number: '+14795550000',
    duration_seconds: 185,
    outcome: 'answered',
  };
  const [added] = unifiedCallStore.addMangoCalls([rawMango]);
  const id = added.id;

  // 2. It flows through matchAndSetStatus + a human works it (what updateCall persists).
  unifiedCallStore.updateCall(id, {
    od_sync_status: 'matched',
    od_patient_id: 11373,
    od_patient_name: 'Test Patient',
    od_match_confidence: 0.95,
    triage_status: 'done',
    triage_outcome: 'scheduled',
    triage_by: { name: 'Sarah Front', email: 'sarah@carein.ai' },
  });

  // 3. The next ~15-min Mango sync re-scrapes the SAME call (bare raw payload again).
  unifiedCallStore.addMangoCalls([rawMango]);
  const stored = unifiedCallStore.getCall(id);

  // Match + triage state must NOT be wiped by the re-scrape upsert.
  assert.equal(stored.od_sync_status, 'matched');
  assert.equal(stored.od_patient_id, 11373);
  assert.equal(stored.od_patient_name, 'Test Patient');
  assert.equal(stored.od_match_confidence, 0.95);
  assert.equal(stored.triage_status, 'done');
  assert.equal(stored.triage_outcome, 'scheduled');
  assert.deepEqual(stored.triage_by, { name: 'Sarah Front', email: 'sarah@carein.ai' });
  // And the newly-scraped fields are still applied.
  assert.equal(stored.source, 'mango');
  assert.equal(stored.duration_seconds, 185);
});

test('TC handoff linkage survives an addMangoCalls re-ingest (M6 regression)', () => {
  // The exact bug class that hit triage fields in Slice B and no_speech in M4: the
  // hourly sync re-ingests inside the watermark overlap, addMangoCalls rebuilds the
  // record through normalizeCall, and any field not on the preservation list is gone.
  // Here that would mean a call handed to TC silently losing its case within the hour —
  // the "In TC" chip vanishes and the row invites a second send.
  const rawMango = {
    source: 'mango',
    external_id: 'mango_call_tc_handoff',
    mango_call_id: 'tc_handoff',
    call_date: '2026-08-07T15:00:00.000Z',
    caller_number: '+14795551414',
    called_number: '+14795550000',
    duration_seconds: 210,
    outcome: 'answered',
  };
  const [added] = unifiedCallStore.addMangoCalls([rawMango]);
  const id = added.id;

  unifiedCallStore.updateCall(id, {
    od_sync_status: 'matched',
    od_patient_id: 7115,
    od_patient_name: 'Stedi TestValley',
    tc_case_id: 'case_abc123',
    tc_case_url: '/tc/cases/case_abc123',
    tc_sent_at: '2026-08-07T16:00:00.000Z',
    tc_sent_by: { name: 'Sarah Front', email: 'sarah@carein.ai' },
  });

  // The next hourly Mango sync re-ingests the SAME call with the bare raw payload.
  unifiedCallStore.addMangoCalls([rawMango]);
  const stored = unifiedCallStore.getCall(id);

  assert.equal(stored.tc_case_id, 'case_abc123');
  assert.equal(stored.tc_case_url, '/tc/cases/case_abc123');
  assert.equal(stored.tc_sent_at, '2026-08-07T16:00:00.000Z');
  assert.deepEqual(stored.tc_sent_by, { name: 'Sarah Front', email: 'sarah@carein.ai' });
  // And the re-ingested fields still apply.
  assert.equal(stored.duration_seconds, 210);
});

test('TC handoff linkage survives a Retell re-add (M6 regression)', () => {
  unifiedCallStore.addRetellCall({
    call_id: 'call_tc_preserve',
    agent_id: 'agent_test',
    from_number: '+14795551515',
    start_timestamp: '2026-08-07T15:00:00.000Z',
  });

  unifiedCallStore.updateCall('call_tc_preserve', {
    od_patient_id: 7115,
    od_patient_name: 'Stedi TestValley',
    tc_case_id: 'case_xyz789',
    tc_case_url: '/tc/cases/case_xyz789',
    tc_sent_at: '2026-08-07T16:30:00.000Z',
    tc_sent_by: { name: 'Sarah Front', email: 'sarah@carein.ai' },
  });

  // A webhook re-delivery / the 15-min poller re-adds the call with a bare payload.
  unifiedCallStore.addRetellCall({
    call_id: 'call_tc_preserve',
    agent_id: 'agent_test',
    from_number: '+14795551515',
    start_timestamp: '2026-08-07T15:00:00.000Z',
  });
  const stored = unifiedCallStore.getCall('call_tc_preserve');

  assert.equal(stored.tc_case_id, 'case_xyz789');
  assert.equal(stored.tc_case_url, '/tc/cases/case_xyz789');
  assert.equal(stored.tc_sent_at, '2026-08-07T16:30:00.000Z');
  assert.deepEqual(stored.tc_sent_by, { name: 'Sarah Front', email: 'sarah@carein.ai' });
});

test('a call never handed to TC has null tc_* fields (no phantom linkage)', () => {
  const stored = unifiedCallStore.addRetellCall({
    call_id: 'call_no_tc',
    agent_id: 'agent_test',
    from_number: '+14795551616',
    start_timestamp: '2026-08-07T15:00:00.000Z',
  });
  assert.equal(stored.tc_case_id, null);
  assert.equal(stored.tc_case_url, null);
  assert.equal(stored.tc_sent_at, null);
  assert.equal(stored.tc_sent_by, null);
});

test('Mango called_number (office DID) survives store normalization → correct office attribution (day-1 bug)', () => {
  const { getOfficeForCall } = require('../config/officeAgents');
  // RAW format Mango actually returns for the office party (see live diagnostic):
  // formatted "(918) 503-6262" — NOT pre-normalized E.164.
  const [added] = unifiedCallStore.addMangoCalls([{
    source: 'mango',
    external_id: 'mango_call_office_did',
    mango_call_id: 'office_did',
    call_date: '2026-07-23T20:00:00.000Z',
    caller_number: '+14795554557',
    called_number: '(918) 503-6262', // Roland main, un-normalized
    direction: 'inbound',
    action_needed: 'Call back to confirm',
    callback_number: '4795554557',
    duration_seconds: 120,
    outcome: 'answered',
  }]);
  const stored = unifiedCallStore.getCall(added.id);
  // The bug: normalizeCall dropped called_number → getOfficeForCall saw undefined → 'unknown'.
  assert.equal(stored.called_number, '(918) 503-6262', 'called_number must survive normalization');
  assert.equal(stored.direction, 'inbound');
  assert.equal(getOfficeForCall(stored), 'roland', 'stored Mango call attributes to its office, not unknown');
  // Item-2 compact-summary fields also survive.
  assert.equal(stored.action_needed, 'Call back to confirm');
  assert.equal(stored.callback_number, '4795554557');
});
