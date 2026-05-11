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
