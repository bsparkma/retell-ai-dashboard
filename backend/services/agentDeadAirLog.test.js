'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { afterEach, beforeEach } = test;

const unifiedCallStore = require('./unifiedCallStore');

// Synthetic fixtures only: a 555 number and invented words.
const deadAirCall = (overrides = {}) => ({
  call_id: 'call_test_dead_air',
  agent_id: 'agent_test',
  from_number: '+15555550100',
  direction: 'inbound',
  disconnection_reason: 'inactivity',
  start_timestamp: 1793000000000,
  transcript_object: [
    { role: 'agent', content: 'Thanks for calling, how can I help?' },
    { role: 'user', content: 'I need to move my appointment.' },
  ],
  ...overrides,
});

let originalRequestPersist;
let originalLog;
let events;

beforeEach(() => {
  originalRequestPersist = unifiedCallStore.requestPersist;
  unifiedCallStore.requestPersist = () => {};
  unifiedCallStore.calls.clear();
  unifiedCallStore.bySource.retell.clear();
  unifiedCallStore.bySource.mango.clear();
  unifiedCallStore.byDate.clear();
  unifiedCallStore.byCallerNumber.clear();

  events = [];
  originalLog = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('"karen_dead_air"')) events.push(args[0]);
  };
});

afterEach(() => {
  console.log = originalLog;
  unifiedCallStore.requestPersist = originalRequestPersist;
});

test('logs karen_dead_air once, with call id and office only', () => {
  unifiedCallStore.addRetellCall(deadAirCall());

  assert.equal(events.length, 1);
  const parsed = JSON.parse(events[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ['call_id', 'event', 'office']);
  assert.equal(parsed.event, 'karen_dead_air');
  assert.equal(parsed.call_id, 'call_test_dead_air');
  assert.equal(typeof parsed.office, 'string');
  assert.ok(!events[0].includes('5555550100'), 'no phone number in the log line');
  assert.ok(!events[0].includes('appointment'), 'no transcript text in the log line');
});

test('a re-add of the same flagged call (webhook re-delivery / poller) does not log again', () => {
  unifiedCallStore.addRetellCall(deadAirCall());
  // The poller's payload carries no transcript; the store inherits it and the call stays flagged.
  unifiedCallStore.addRetellCall(deadAirCall({ transcript_object: undefined }));
  unifiedCallStore.addRetellCall(deadAirCall());

  assert.equal(events.length, 1);
});

test('a call that becomes flagged on a later payload logs at that point', () => {
  unifiedCallStore.addRetellCall(deadAirCall({ transcript_object: undefined }));
  assert.equal(events.length, 0, 'no transcript yet, so not judged');

  unifiedCallStore.addRetellCall(deadAirCall());
  assert.equal(events.length, 1);
});

test('caller abandonment (agent spoke last) never logs', () => {
  unifiedCallStore.addRetellCall(deadAirCall({
    transcript_object: [
      { role: 'agent', content: 'Thanks for calling, how can I help?' },
      { role: 'user', content: 'I need to move my appointment.' },
      { role: 'agent', content: 'Which appointment would you like to move?' },
    ],
  }));
  assert.equal(events.length, 0);
});
