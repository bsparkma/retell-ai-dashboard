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
