'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const oa = require('./officeAgents');

// A known real agent id mapped to Roland (see AGENT_OFFICE).
const ROLAND_AGENT = 'agent_063d7e3077f6dc708c54a19d20';

test('mapped agent routes to its office (handler_id)', () => {
  assert.equal(oa.getOfficeForCall({ handler_id: ROLAND_AGENT }), 'roland');
});

test('raw agent_id shape is tolerated too', () => {
  assert.equal(oa.getOfficeForCall({ agent_id: ROLAND_AGENT }), 'roland');
});

test('unmapped agent falls back to Roland', () => {
  assert.equal(oa.getOfficeForCall({ handler_id: 'agent_not_in_map_xyz' }), 'roland');
});

test('agent-less call falls back to Roland', () => {
  assert.equal(oa.getOfficeForCall({}), 'roland');
});

test('filterCallsForOffice: roland returns every current call, valley returns none', () => {
  const calls = [
    { id: 'a', handler_id: ROLAND_AGENT },
    { id: 'b', handler_id: 'agent_3a7042b50e7c4775cd350f02b4' },
    { id: 'c' }, // agent-less → Roland fallback
  ];
  assert.equal(oa.filterCallsForOffice(calls, 'roland').length, 3);
  assert.equal(oa.filterCallsForOffice(calls, 'valley').length, 0);
});

test('filterCallsForOffice: all/default/empty is a passthrough', () => {
  const calls = [{ id: 'a', handler_id: ROLAND_AGENT }, { id: 'b' }];
  assert.equal(oa.filterCallsForOffice(calls, 'all').length, 2);
  assert.equal(oa.filterCallsForOffice(calls, 'default').length, 2);
  assert.equal(oa.filterCallsForOffice(calls, undefined).length, 2);
});

test('getOfficeConfig reflects OD-connection state per office', () => {
  assert.equal(oa.getOfficeConfig('roland').odConnected, true);
  assert.equal(oa.getOfficeConfig('valley').odConnected, false);
  // "all"/"default"/unknown → null (no office scoping)
  assert.equal(oa.getOfficeConfig('all'), null);
  assert.equal(oa.getOfficeConfig('default'), null);
  assert.equal(oa.getOfficeConfig('nope'), null);
});

test('getAllOfficeConfigs powers the selector: Roland then Valley', () => {
  const offices = oa.getAllOfficeConfigs();
  assert.deepEqual(
    offices.map((o) => o.officeId),
    ['roland', 'valley']
  );
  assert.equal(offices.find((o) => o.officeId === 'valley').officeName, 'Valley Fort Smith');
});

test('adding a Valley agent later is one entry: valley would then match it', () => {
  // Simulate the future one-line change without mutating shared state:
  // once an agent maps to 'valley', isAgentAllowedForOffice honors it.
  oa.AGENT_OFFICE.agent_future_valley_test = 'valley';
  try {
    assert.equal(oa.getOfficeForCall({ handler_id: 'agent_future_valley_test' }), 'valley');
    assert.equal(
      oa.filterCallsForOffice([{ handler_id: 'agent_future_valley_test' }], 'valley').length,
      1
    );
  } finally {
    delete oa.AGENT_OFFICE.agent_future_valley_test;
  }
});

// ── Mango (staff) line → office attribution ──────────────────────────────────

test('normalizeE164 canonicalizes NANP numbers and rejects short input', () => {
  assert.equal(oa.normalizeE164('(479) 555-0000'), '+14795550000');
  assert.equal(oa.normalizeE164('4795550000'), '+14795550000');
  assert.equal(oa.normalizeE164('14795550000'), '+14795550000');
  assert.equal(oa.normalizeE164('+1 479-555-0000'), '+14795550000');
  assert.equal(oa.normalizeE164('555'), null);
  assert.equal(oa.normalizeE164(null), null);
});

test('Mango call: unmapped line attributes to "unknown" (NEVER Roland)', () => {
  // A Mango call carries no Retell agent id; an unmapped/absent DID → 'unknown',
  // so it is never silently miscounted as a Roland call.
  assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '(918) 555-9999' }), 'unknown');
  assert.equal(oa.getOfficeForCall({ source: 'mango' }), 'unknown');
  assert.equal(oa.UNMAPPED_OFFICE, 'unknown');
});

test('unknown bucket: is a valid office config but NOT in the selector', () => {
  // getOfficeConfig resolves it (for odConnected checks etc.)...
  assert.equal(oa.getOfficeConfig('unknown').odConnected, false);
  // ...but it must not appear as a selectable office tab.
  assert.ok(!oa.getAllOfficeConfigs().some((o) => o.officeId === 'unknown'));
});

test('unmapped Mango calls are excluded from real office views, land only in "all"', () => {
  const calls = [
    { id: 'm1', source: 'mango', called_number: '+19185036262' }, // roland
    { id: 'm2', source: 'mango', called_number: '+19995550000' }, // unmapped → unknown
  ];
  assert.equal(oa.filterCallsForOffice(calls, 'roland').length, 1); // only m1, NOT the unmapped one
  assert.equal(oa.filterCallsForOffice(calls, 'valley').length, 0);
  assert.equal(oa.filterCallsForOffice(calls, 'unknown').length, 1); // m2 findable in the bucket
  assert.equal(oa.filterCallsForOffice(calls, 'all').length, 2); // both visible in all-calls
});

test('Mango call: real office DIDs attribute correctly (Roland + Valley), any formatting', () => {
  // Roland Family Dental main line.
  assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '+19185036262' }), 'roland');
  assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '(918) 503-6262' }), 'roland');
  // Valley Family Dental — attribution only (OFFICES.valley is odConnected:false).
  assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '+14792263500' }), 'valley');
  assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '479-226-3500' }), 'valley');
  assert.equal(oa.getOfficeConfig('valley').odConnected, false);
});

test('Mango call: a mapped DID routes to its office, regardless of number formatting', () => {
  // Simulate Beau supplying a Valley DID — one entry, exactly like AGENT_OFFICE.
  oa.MANGO_LINE_OFFICE['+14795551234'] = 'valley';
  try {
    assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '479-555-1234' }), 'valley');
    assert.equal(oa.getOfficeForCall({ source: 'mango', called_number: '(479) 555-1234' }), 'valley');
    assert.equal(
      oa.filterCallsForOffice(
        [
          { id: 'm1', source: 'mango', called_number: '+14795551234' }, // → valley
          { id: 'm2', source: 'mango', called_number: '+19185550000' }, // unmapped → unknown
        ],
        'valley'
      ).length,
      1
    );
  } finally {
    delete oa.MANGO_LINE_OFFICE['+14795551234'];
  }
});
