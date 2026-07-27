'use strict';

// Unit tests for the OD cloud client remediation (feature/od-client-port).
// Runner: Node's built-in test runner — `node --test` (matches the CI build-test gate).
// These assert the real api.opendental.com contract: string AptStatus enums, correct
// query-param names, and that api-mode errors SURFACE (no silent mock). See
// docs/OD_API_CONTRACT.md and docs/SLICE_OD_CLIENT_REMEDIATION_PRD.md.

const test = require('node:test');
const assert = require('node:assert/strict');

const { OpenDentalService } = require('./openDental');

// A disabled, freshly-constructed instance (no env → enabled=false → no timers/axios).
// We drive it directly and stub `this.client` to assert request construction.
function makeService(overrides = {}) {
  const svc = new OpenDentalService();
  svc.enabled = true;
  svc.useDatabase = false;
  // Force strict (no-mock) mode regardless of the runner's env.
  svc.allowMock = () => false;
  // Neutralize the post-write `setTimeout(() => performSync(), 1000)` so write tests
  // don't leave a deferred timer firing against the stub after the test ends.
  svc.performSync = async () => {};
  Object.assign(svc, overrides);
  return svc;
}

// A client stub that records calls and returns a canned payload (or throws).
function recordingClient({ data = [], reject = null } = {}) {
  const calls = [];
  const handler = (method) => async (url, arg) => {
    calls.push({ method, url, arg });
    if (reject) throw reject;
    return { data, status: 200 };
  };
  return { calls, get: handler('get'), post: handler('post'), put: handler('put') };
}

// ---------------------------------------------------------------------------
// 1) AptStatus enum mapping (writes → string, reads → both string + legacy int)
// ---------------------------------------------------------------------------
test('mapStatusToOD emits string AptStatus enums (never integers)', () => {
  const s = makeService();
  assert.equal(s.mapStatusToOD('scheduled'), 'Scheduled');
  assert.equal(s.mapStatusToOD('completed'), 'Complete');
  assert.equal(s.mapStatusToOD('cancelled'), 'Broken'); // OD has no "Cancelled"
  assert.equal(s.mapStatusToOD('no_show'), 'Broken');
  assert.equal(s.mapStatusToOD('broken'), 'Broken');
  assert.equal(s.mapStatusToOD('confirmed'), 'Scheduled'); // confirmation is a DefNum, not a status
  assert.equal(s.mapStatusToOD('arrived'), 'Scheduled');
  assert.equal(s.mapStatusToOD('whatever-unknown'), 'Scheduled');
  // No mapping value may be a number.
  for (const v of ['scheduled', 'cancelled', 'completed', 'no_show']) {
    assert.equal(typeof s.mapStatusToOD(v), 'string');
  }
});

test('mapAppointmentStatus maps OD string enums back, and still handles legacy DB ints', () => {
  const s = makeService();
  assert.equal(s.mapAppointmentStatus('Scheduled'), 'scheduled');
  assert.equal(s.mapAppointmentStatus('Complete'), 'completed');
  assert.equal(s.mapAppointmentStatus('Broken'), 'cancelled'); // collapses cancel + no-show
  assert.equal(s.mapAppointmentStatus('UnschedList'), 'unscheduled');
  // Legacy direct-DB integer path preserved.
  assert.equal(s.mapAppointmentStatus(1), 'scheduled');
  assert.equal(s.mapAppointmentStatus(7), 'completed');
});

test('status round-trips through the OD string enum', () => {
  const s = makeService();
  assert.equal(s.mapAppointmentStatus(s.mapStatusToOD('cancelled')), 'cancelled');
  assert.equal(s.mapAppointmentStatus(s.mapStatusToOD('scheduled')), 'scheduled');
  assert.equal(s.mapAppointmentStatus(s.mapStatusToOD('completed')), 'completed');
});

// ---------------------------------------------------------------------------
// 2) AptDateTime formatting + create/cancel payload shapes
// ---------------------------------------------------------------------------
test('formatODDateTime produces "yyyy-MM-dd HH:mm:ss" without TZ shift', () => {
  const s = makeService();
  assert.equal(s.formatODDateTime('2026-12-13T14:00:00.000Z'), '2026-12-13 14:00:00');
  assert.equal(s.formatODDateTime('2026-12-13 14:00'), '2026-12-13 14:00:00');
  assert.equal(s.formatODDateTime('2026-12-13 14:00:00'), '2026-12-13 14:00:00');
});

test('prepareAppointmentForOD: string AptStatus, formatted date, string booleans, no boolean Confirmed', () => {
  const s = makeService();
  const payload = s.prepareAppointmentForOD({
    patientId: 1, operatoryId: 9, providerId: 1,
    dateTime: '2026-12-13T14:00:00Z', duration: 60, type: 'Exam',
    notes: 'CAREIN STEP4 RETEST — DELETE', isNew: true, confirmed: true
  });
  assert.equal(payload.AptStatus, 'Scheduled');
  assert.equal(typeof payload.AptStatus, 'string');
  assert.equal(payload.AptDateTime, '2026-12-13 14:00:00');
  assert.equal(payload.PatNum, 1);
  assert.equal(payload.Op, 9);
  assert.equal(payload.IsNewPatient, 'true');
  // `confirmed: true` must NOT become a boolean Confirmed (it's a DefNum).
  assert.ok(!('Confirmed' in payload), 'boolean confirmed must not be sent');
});

test('prepareAppointmentForOD only sends Confirmed when a real DefNum is supplied', () => {
  const s = makeService();
  const payload = s.prepareAppointmentForOD({
    patientId: 1, operatoryId: 9, providerId: 1, dateTime: '2026-12-13 14:00:00',
    duration: 60, confirmedDefNum: 512
  });
  assert.equal(payload.Confirmed, 512);
});

test('cancelAppointment issues a PUT with AptStatus "Broken" (status update, never delete)', async () => {
  const client = recordingClient({ data: { AptNum: 42 } });
  const s = makeService({ client });
  await s.cancelAppointment(42, 'patient request');
  const call = client.calls.find((c) => c.method === 'put');
  assert.ok(call, 'expected a PUT');
  assert.equal(call.url, '/appointments/42');
  assert.equal(call.arg.AptStatus, 'Broken');
  assert.equal(typeof call.arg.AptStatus, 'string');
});

// ---------------------------------------------------------------------------
// 3) Read query-param construction (real OD names)
// ---------------------------------------------------------------------------
test('getAppointmentsForDateRange uses dateStart/dateEnd (not startDate/endDate)', async () => {
  const client = recordingClient({ data: [] });
  const s = makeService({ client });
  // Local-midnight dates so the assertion is TZ-independent (the client formats the
  // Date's calendar day in server-local time, consistent with getCalendarAppointments).
  await s.getAppointmentsForDateRange(new Date(2026, 5, 1), new Date(2026, 5, 2));
  const { arg } = client.calls[0];
  assert.deepEqual(Object.keys(arg.params).sort(), ['dateEnd', 'dateStart']);
  assert.equal(arg.params.dateStart, '2026-06-01');
  assert.equal(arg.params.dateEnd, '2026-06-02');
  assert.ok(!('startDate' in arg.params) && !('endDate' in arg.params));
  assert.ok(!('includePatientInfo' in arg.params), 'fabricated include* params must be gone');
});

test('getCalendarAppointments keeps space-separated OD datetimes for the target date (regression)', async () => {
  // OD returns "yyyy-MM-dd HH:mm:ss" (space, not 'T'). The day filter must not drop them.
  const client = recordingClient({ data: [
    { AptNum: 1, PatNum: 5, FName: 'A', LName: 'B', AptDateTime: '2026-06-04 08:00:00', AptStatus: 'Scheduled', ProvNum: 1, Op: 2 },
    { AptNum: 2, PatNum: 6, FName: 'C', LName: 'D', AptDateTime: '2026-06-05 09:00:00', AptStatus: 'Scheduled', ProvNum: 1, Op: 2 }
  ]});
  const s = makeService({ client });
  const out = await s.getCalendarAppointments({ date: '2026-06-04' });
  assert.equal(out.length, 1, 'space-separated same-day appt must be kept');
  assert.equal(out[0].id, 1);
  assert.equal(out[0].dateTime, '2026-06-04 08:00:00');
});

test('buildPatientSearchParams routes the query to real OD fields (no search/searchType)', () => {
  const s = makeService();
  assert.deepEqual(s.buildPatientSearchParams('5551234567'), { Phone: '5551234567' });
  assert.deepEqual(s.buildPatientSearchParams('(555) 123-4567'), { Phone: '5551234567' });
  assert.deepEqual(s.buildPatientSearchParams('01/15/1980'), { Birthdate: '1980-01-15' });
  assert.deepEqual(s.buildPatientSearchParams('1980-01-15'), { Birthdate: '1980-01-15' });
  assert.deepEqual(s.buildPatientSearchParams('Smith, John'), { LName: 'Smith', FName: 'John' });
  assert.deepEqual(s.buildPatientSearchParams('John Smith'), { FName: 'John', LName: 'Smith' });
  assert.deepEqual(s.buildPatientSearchParams('Smith'), { LName: 'Smith' });
  for (const q of ['Smith', '5551234567', '01/15/1980']) {
    const p = s.buildPatientSearchParams(q);
    assert.ok(!('search' in p) && !('searchType' in p), 'no generic search params');
  }
});

test('searchPatients hits GET /patients with field params', async () => {
  const client = recordingClient({ data: [] });
  const s = makeService({ client });
  await s.searchPatients('Davenport');
  assert.equal(client.calls[0].url, '/patients');
  assert.deepEqual(client.calls[0].arg.params, { LName: 'Davenport' });
});

// ---------------------------------------------------------------------------
// 4) Safety — api-mode errors SURFACE (no silent mock)
// ---------------------------------------------------------------------------
test('searchPatients throws on API error in api mode (does not return mock)', async () => {
  const client = recordingClient({ reject: new Error('OD 400 boom') });
  const s = makeService({ client });
  await assert.rejects(() => s.searchPatients('Davenport'), /boom/);
});

test('getProviders throws on API error in api mode (does not return mock)', async () => {
  const client = recordingClient({ reject: new Error('OD 500 boom') });
  const s = makeService({ client });
  await assert.rejects(() => s.getProviders(), /boom/);
});

test('getCalendarAppointments throws on API error in api mode (does not return mock)', async () => {
  const client = recordingClient({ reject: new Error('OD 503 boom') });
  const s = makeService({ client });
  await assert.rejects(() => s.getCalendarAppointments({ date: '2026-06-04' }), /boom/);
});

test('mock IS allowed when allowMock() is true (dev escape hatch still works)', async () => {
  const client = recordingClient({ reject: new Error('boom') });
  const s = makeService({ client });
  s.allowMock = () => true;
  const providers = await s.getProviders();
  assert.ok(Array.isArray(providers) && providers.length > 0, 'dev mock fallback preserved');
});

// ── OD 429 backoff (day-1 item 7) ────────────────────────────────────────────

const { computeOdBackoffMs } = require('./openDental');

test('computeOdBackoffMs: honors numeric Retry-After (seconds -> ms)', () => {
  assert.equal(computeOdBackoffMs(1, 5), 5000);
  assert.equal(computeOdBackoffMs(3, 0), 0);
});

test('computeOdBackoffMs: exponential 500·2^(n-1) capped at 8s when no header', () => {
  assert.equal(computeOdBackoffMs(1, NaN), 500);
  assert.equal(computeOdBackoffMs(2, undefined), 1000);
  assert.equal(computeOdBackoffMs(3), 2000);
  assert.equal(computeOdBackoffMs(4), 4000);
  assert.equal(computeOdBackoffMs(5), 8000);
  assert.equal(computeOdBackoffMs(9), 8000); // capped
});
