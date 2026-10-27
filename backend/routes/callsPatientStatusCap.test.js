'use strict';

/**
 * The calls list's patient-status lookups are capped at 5 concurrent Open
 * Dental requests, process-wide (post-incident, 2026-10-26: one Promise.all
 * over ~150 calls opened ~150 OD requests at once and the tail timed out).
 *
 * odAccess is replaced at the module seam; nothing leaves the process.
 * Synthetic numbers and names only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const odAccess = require('../platform/odAccess');
const calls = require('./calls');

const saved = {
  searchPatients: odAccess.searchPatients,
  verifyPatientAppointments: odAccess.verifyPatientAppointments,
};

test.afterEach(() => {
  odAccess.searchPatients = saved.searchPatients;
  odAccess.verifyPatientAppointments = saved.verifyPatientAppointments;
});

/** Fake OD: counts requests in flight; every 2nd caller is an existing patient. */
function fakeOd() {
  const state = { inFlight: 0, peak: 0, requests: 0 };
  const call = async (/** @type {() => unknown} */ answer) => {
    state.requests += 1;
    state.inFlight += 1;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      await new Promise((r) => setTimeout(r, 2));
      return answer();
    } finally {
      state.inFlight -= 1;
    }
  };
  odAccess.searchPatients = async (_req, query) =>
    call(() => (Number(String(query).slice(-1)) % 2 === 0 ? [{ id: 9000, fullName: 'Synthetic Person' }] : []));
  odAccess.verifyPatientAppointments = async () =>
    call(() => ({ recentAppointments: [], hasUpcoming: true }));
  return state;
}

test('the cap is 5', () => {
  assert.equal(calls._OD_PATIENT_STATUS_CONCURRENCY, 5);
});

test('150 simultaneous lookups (the incident fan-out) never put more than 5 OD requests in flight', async () => {
  const od = fakeOd();
  const N = 150;
  const numbers = Array.from({ length: N }, (_, i) => `+1555010${String(i).padStart(4, '0')}`);
  const results = await Promise.all(numbers.map((n) => calls._determinePatientStatus({}, 'Synthetic Caller', n)));

  assert.ok(od.peak <= 5, `peak in flight was ${od.peak}`);
  assert.equal(od.peak, 5, 'and the pool is actually used, not serialized');
  // Behavior unchanged: every lookup answered, in order, with the same shape.
  assert.equal(results.length, N);
  results.forEach((r, i) => {
    const existing = Number(numbers[i].slice(-1)) % 2 === 0;
    assert.equal(r.isNewPatient, !existing, `lookup ${i}`);
    if (existing) {
      assert.deepEqual(r, {
        isNewPatient: false,
        patientId: 9000,
        patientName: 'Synthetic Person',
        hasAppointmentHistory: true,
        matchedBy: 'phone',
      });
    }
  });
});

test('the cap holds ACROSS concurrent page loads, not just within one', async () => {
  const od = fakeOd();
  const page = () =>
    Promise.all(Array.from({ length: 30 }, (_, i) => calls._determinePatientStatus({}, null, `+1555020${String(i).padStart(4, '0')}`)));
  await Promise.all([page(), page(), page()]);
  assert.ok(od.peak <= 5, `peak in flight was ${od.peak}`);
});

test('an OD failure still degrades to "new patient" exactly as before, and frees its slot', async () => {
  odAccess.searchPatients = async () => {
    throw new Error('timeout of 30000ms exceeded');
  };
  const realError = console.error;
  console.error = () => {};
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => calls._determinePatientStatus({}, 'Synthetic Caller', '+15550100000'))
    );
    for (const r of results) {
      assert.deepEqual(r, {
        isNewPatient: true,
        patientId: null,
        patientName: 'Synthetic Caller',
        hasAppointmentHistory: false,
        matchedBy: null,
        error: 'timeout of 30000ms exceeded',
      });
    }
  } finally {
    console.error = realError;
  }
});
