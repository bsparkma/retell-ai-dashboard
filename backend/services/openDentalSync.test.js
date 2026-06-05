'use strict';

// Unit tests for the OD commlog write remediation (PRD §4).
// Runner: `node --test` (CI build-test gate). Asserts the real POST /commlogs contract:
// string Mode_/SentOrReceived enums, formatted CommDateTime, a configured CommType
// DefNum, and that createCommLog actually uses the API in api mode (the old webhook path
// silently no-opped without a DB pool). See docs/OD_API_CONTRACT.md §10.

const test = require('node:test');
const assert = require('node:assert/strict');

const sync = require('./openDentalSync');
const openDentalService = require('../config/openDental');

test('buildCommLogApiPayload maps DB-shaped entry to the real OD /commlogs contract', () => {
  const payload = sync.buildCommLogApiPayload(1001, {
    CommDateTime: '2026-06-04T15:30:00.000Z',
    Mode_: 3,            // DB int -> "Phone"
    SentOrReceived: 1,   // inbound -> "Received"
    Note: 'CareIN call summary',
    CommType: 2          // ignored on the API path; replaced by the configured DefNum
  });

  assert.equal(payload.PatNum, 1001);
  assert.equal(payload.Note, 'CareIN call summary');
  assert.equal(payload.CommDateTime, '2026-06-04 15:30:00'); // no T/Z, OD format
  assert.equal(payload.Mode_, 'Phone');                      // string enum, not 3
  assert.equal(payload.SentOrReceived, 'Received');          // string enum, not 1
  assert.equal(typeof payload.Mode_, 'string');
  assert.equal(typeof payload.SentOrReceived, 'string');
  assert.equal(payload.CommType, sync.careinCommType);       // configured DefNum (default 486)
});

test('careinCommType defaults to the CareIN convention DefNum 486', () => {
  // (Unless OPENDENTAL_CAREIN_COMMTYPE_DEFNUM overrides it in the environment.)
  if (!process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM) {
    assert.equal(sync.careinCommType, 486);
  }
});

test('createCommLog POSTs /commlogs with the API payload when in api mode', async () => {
  const prev = { useDatabase: openDentalService.useDatabase, pool: openDentalService.pool, client: openDentalService.client };
  const calls = [];
  openDentalService.useDatabase = false;
  openDentalService.pool = null;
  openDentalService.client = {
    post: async (url, body) => { calls.push({ url, body }); return { data: { CommlogNum: 7777 } }; }
  };

  try {
    const result = await sync.createCommLog(1001, {
      CommDateTime: '2026-06-04 15:30:00', Mode_: 3, SentOrReceived: 1, Note: 'hi', CommType: 1
    });
    assert.equal(result.success, true);
    assert.equal(result.commLogNum, 7777);
    assert.equal(calls[0].url, '/commlogs');
    assert.equal(calls[0].body.Mode_, 'Phone');
    assert.equal(calls[0].body.SentOrReceived, 'Received');
    assert.equal(calls[0].body.PatNum, 1001);
  } finally {
    Object.assign(openDentalService, prev);
  }
});

test('createCommLog reports failure (not a throw) when no OD connection is available', async () => {
  const prev = { useDatabase: openDentalService.useDatabase, pool: openDentalService.pool, client: openDentalService.client };
  openDentalService.useDatabase = false;
  openDentalService.pool = null;
  openDentalService.client = null;
  try {
    const result = await sync.createCommLog(1001, { Note: 'x', CommDateTime: '2026-06-04 15:30:00' });
    assert.equal(result.success, false);
    assert.match(result.error, /No Open Dental connection/);
  } finally {
    Object.assign(openDentalService, prev);
  }
});
