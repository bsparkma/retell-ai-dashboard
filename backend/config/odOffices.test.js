'use strict';

// Unit tests for the office-keyed Open Dental connection registry.
// Runner: `node --test`.
//
// What these protect:
//   - fail-closed PER OFFICE (no key -> that office is disconnected, and it NEVER
//     borrows another office's credentials);
//   - each office resolves its OWN customer key and its OWN CareIN CommType DefNum
//     (Roland 486 / Riley 451 — verified live 2026-08-07);
//   - the cross-office guard refuses a mismatched (office, client) pair;
//   - 'unknown' can never obtain an OD connection at all.
//
// Credential values here are meaningless placeholder strings. Nothing in this file
// reaches a real Open Dental.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach, afterEach } = test;

const odOffices = require('./odOffices');
const { OFFICES } = require('./officeAgents');

const ROLAND_KEY = 'test-roland-customer-key';
const VALLEY_KEY = 'test-valley-customer-key';

let savedEnv;
let savedValleyConnected;

beforeEach(() => {
  savedEnv = {
    roland: process.env.OPENDENTAL_CUSTOMER_KEY,
    valley: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY,
    rolandDef: process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM,
    valleyDef: process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY,
  };
  // The banner flag is what Step 4 of this slice flips. These tests must assert the
  // MACHINERY, not whichever value the flag currently ships with, so they set it
  // explicitly and restore it afterwards.
  savedValleyConnected = OFFICES.valley.odConnected;

  process.env.OPENDENTAL_CUSTOMER_KEY = ROLAND_KEY;
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = VALLEY_KEY;
  delete process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM;
  delete process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY;
  OFFICES.valley.odConnected = true;
  odOffices.resetOdOfficeCache();
});

afterEach(() => {
  const set = (k, v) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('OPENDENTAL_CUSTOMER_KEY', savedEnv.roland);
  set('OPENDENTAL_CUSTOMER_KEY_VALLEY', savedEnv.valley);
  set('OPENDENTAL_CAREIN_COMMTYPE_DEFNUM', savedEnv.rolandDef);
  set('OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY', savedEnv.valleyDef);
  OFFICES.valley.odConnected = savedValleyConnected;
  odOffices.resetOdOfficeCache();
});

// ── Per-office credential resolution ────────────────────────────────────────

test('each office binds to its OWN customer key', () => {
  const roland = odOffices.getOdOffice('roland');
  const valley = odOffices.getOdOffice('valley');

  assert.equal(roland.officeKey, 'roland');
  assert.equal(valley.officeKey, 'valley');
  assert.equal(roland.client.customerKey, ROLAND_KEY);
  assert.equal(valley.client.customerKey, VALLEY_KEY);
  // The customer key is what selects the OD DATABASE. Two offices sharing one would
  // be the whole bug this slice exists to prevent.
  assert.notEqual(roland.client.customerKey, valley.client.customerKey);
});

test('the two offices get genuinely distinct clients', () => {
  assert.notEqual(odOffices.getOdOffice('roland').client, odOffices.getOdOffice('valley').client);
});

test('a per-office client does not start its own background sync loop', () => {
  // One 3-minute sync loop per connected office would multiply OD load for nothing.
  assert.equal(odOffices.getOdOffice('valley').client.syncInterval, null);
});

// ── Fail closed, per office ─────────────────────────────────────────────────

test('an office with no customer key is disconnected — it never borrows another key', () => {
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();

  assert.equal(odOffices.isOdReady('valley'), false);
  assert.equal(odOffices.odBlockReason('valley').code, 'OFFICE_OD_KEY_MISSING');
  assert.throws(() => odOffices.getOdOffice('valley'), /OFFICE_OD_KEY_MISSING|cannot reach/);

  // Roland is unaffected: one office losing its key does not disturb the other.
  assert.equal(odOffices.isOdReady('roland'), true);
  assert.equal(odOffices.getOdOffice('roland').client.customerKey, ROLAND_KEY);
});

test('flipping the banner on WITHOUT the key still reports the office as disconnected', () => {
  // The reversible switch alone must not be able to make an office look live.
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();

  const described = odOffices.describeOffice('valley');
  assert.equal(described.odConnected, false, 'effective connectivity is intent AND credentials');
  assert.match(described.odBlockedReason, /credentials/i);
});

test('an office switched OFF is disconnected even with a key present', () => {
  OFFICES.valley.odConnected = false;
  odOffices.resetOdOfficeCache();

  assert.equal(odOffices.isOdReady('valley'), false);
  assert.equal(odOffices.odBlockReason('valley').code, 'OFFICE_NOT_OD_CONNECTED');
  assert.throws(() => odOffices.getOdOffice('valley'));
});

// ── The 'unknown' bucket is never OD-reachable ──────────────────────────────

test("'unknown' can never obtain an OD connection", () => {
  assert.equal(odOffices.isOdReady('unknown'), false);
  assert.equal(odOffices.odBlockReason('unknown').code, 'OFFICE_UNKNOWN');
  assert.throws(() => odOffices.getOdOffice('unknown'), /OFFICE_UNKNOWN|cannot reach/);
  // The honest UI state the worklist renders.
  assert.match(odOffices.describeOffice('unknown').odBlockedReason, /office is unknown/i);
});

test('a garbage / empty office key is refused, not defaulted', () => {
  for (const bad of ['', '   ', 'not-an-office', null, undefined, 42]) {
    assert.equal(odOffices.isOdReady(bad), false, `"${bad}" must not be OD-ready`);
    assert.throws(() => odOffices.getOdOffice(bad), `"${bad}" must throw`);
  }
});

// ── Per-practice CommType DefNum ────────────────────────────────────────────

test('each office carries its OWN CareIN CommType DefNum', () => {
  // Verified live against both practices on 2026-08-07.
  assert.equal(odOffices.getOdOffice('roland').commTypeDefNum, 486);
  assert.equal(odOffices.getOdOffice('valley').commTypeDefNum, 451);
});

test("one practice's DefNum is never the other's", () => {
  const roland = odOffices.getOdOffice('roland').commTypeDefNum;
  const valley = odOffices.getOdOffice('valley').commTypeDefNum;
  assert.notEqual(roland, valley);
  // 486 is not a CommLogType in Riley's database at all — writing it there is a
  // corrupt row, not a cosmetic mismatch.
  assert.notEqual(valley, 486);
  assert.notEqual(roland, 451);
});

test('a per-office DefNum env override is honored', () => {
  process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY = '999';
  odOffices.resetOdOfficeCache();
  assert.equal(odOffices.getOdOffice('valley').commTypeDefNum, 999);
  // Overriding one office must not move the other.
  assert.equal(odOffices.getOdOffice('roland').commTypeDefNum, 486);
});

test('a non-numeric DefNum override falls back to the verified default, never NaN', () => {
  process.env.OPENDENTAL_CAREIN_COMMTYPE_DEFNUM_VALLEY = 'not-a-number';
  odOffices.resetOdOfficeCache();
  assert.equal(odOffices.getOdOffice('valley').commTypeDefNum, 451);
});

// ── The cross-office guard ──────────────────────────────────────────────────

test('assertOfficeMatch passes a correctly-paired office and client', () => {
  const valley = odOffices.getOdOffice('valley');
  assert.equal(odOffices.assertOfficeMatch('valley', valley), valley);
});

test('assertOfficeMatch REFUSES a client bound to a different office', () => {
  const roland = odOffices.getOdOffice('roland');
  const valley = odOffices.getOdOffice('valley');

  assert.throws(() => odOffices.assertOfficeMatch('valley', roland), (err) => {
    assert.equal(err.code, 'OFFICE_MISMATCH');
    return true;
  });
  assert.throws(() => odOffices.assertOfficeMatch('roland', valley), (err) => {
    assert.equal(err.code, 'OFFICE_MISMATCH');
    return true;
  });
});

test('assertOfficeMatch refuses a handle with no office at all', () => {
  assert.throws(() => odOffices.assertOfficeMatch('roland', {}), /OFFICE_MISMATCH|refused/);
  assert.throws(() => odOffices.assertOfficeMatch('roland', null), /OFFICE_MISMATCH|refused/);
});

// ── Diagnostics never leak values ───────────────────────────────────────────

test('describeOffice and secretNames expose names and state, never a credential', () => {
  const serialized = JSON.stringify({
    offices: ['roland', 'valley', 'unknown'].map((k) => odOffices.describeOffice(k)),
    secretNames: odOffices.secretNames,
  });
  assert.ok(!serialized.includes(ROLAND_KEY));
  assert.ok(!serialized.includes(VALLEY_KEY));
  assert.ok(odOffices.secretNames.includes('opendental-customer-key-valley'));
});
