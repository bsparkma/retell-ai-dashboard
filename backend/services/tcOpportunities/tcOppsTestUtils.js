'use strict';

/**
 * Shared fakes for the TC Opportunities tests. NOT a test file.
 *
 * Synthetic data only. PatNums are the designated fixtures (roland 12827 /
 * 12828, valley 7115) plus obviously-synthetic high numbers; names are
 * "Test, …" fixtures. No real patient appears anywhere.
 */

/** One /procedurelogs row in Open Dental's API shape. */
function odProc({
  procNum,
  patNum,
  code = 'D2740',
  fee = '1200.00',
  dateTP = '2026-09-01',
  aptNum = 0,
  status = 'TP',
  tooth = '3',
  descript = 'crown - porcelain/ceramic',
}) {
  return {
    ProcNum: procNum,
    PatNum: patNum,
    AptNum: aptNum,
    ProcStatus: status,
    ProcFee: fee,
    procCode: code,
    descript,
    ToothNum: tooth,
    Surf: '',
    DateTP: dateTP,
    DateTStamp: '2026-10-01 10:00:00',
    ClinicNum: 0,
    serverDateTime: '2026-10-08 02:30:01',
  };
}

/** Synthetic patient records, keyed by PatNum. */
const PATIENTS = Object.freeze({
  12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi', WirelessPhone: '(555) 010-0001', PatStatus: 'Patient' },
  12828: { PatNum: 12828, LName: 'Test', FName: 'MangoTest', WirelessPhone: '(555) 010-0002', PatStatus: 'Patient' },
  7115: { PatNum: 7115, LName: 'TestValley', FName: 'Stedi', WirelessPhone: '(555) 010-0003', PatStatus: 'Patient' },
  990001: { PatNum: 990001, LName: 'Test', FName: 'Inactive', PatStatus: 'Inactive' },
});

/**
 * A fake office client. `procs` is the practice's TP list (paged at 100);
 * every call is recorded with its opts so throttle discipline is assertable.
 * @param {{ procs?: any[], failPage?: number, ignoreFilter?: boolean, patients?: Record<string, any> }} [o]
 */
function fakeOdClient(o = {}) {
  const calls = [];
  const state = { procs: o.procs || [], failPage: o.failPage, ignoreFilter: Boolean(o.ignoreFilter) };
  const patients = o.patients || PATIENTS;
  const client = {
    calls,
    state,
    async apiGetRaw(path, params, opts) {
      calls.push({ path, params: { ...(params || {}) }, opts: { ...(opts || {}) } });
      if (path === '/procedurelogs') {
        const offset = Number(params.Offset || 0);
        const page = offset / 100;
        if (state.failPage !== undefined && page === state.failPage) {
          return { ok: false, status: 503, data: null, error: 'unavailable' };
        }
        const pool = state.ignoreFilter
          ? state.procs
          : state.procs.filter((p) => !params.ProcStatus || p.ProcStatus === params.ProcStatus);
        return { ok: true, status: 200, data: pool.slice(offset, offset + 100) };
      }
      const m = /^\/patients\/(\d+)$/.exec(path);
      if (m) {
        const rec = patients[m[1]];
        return rec ? { ok: true, status: 200, data: { ...rec } } : { ok: false, status: 404, data: null, error: 'not found' };
      }
      return { ok: false, status: 404, data: null, error: `${path} is not a valid resource.` };
    },
  };
  return client;
}

/** An odOffices stand-in with the REAL assertion semantics. */
function fakeOdOffices(clientsByOffice) {
  return {
    getOdOffice(officeKey) {
      const client = clientsByOffice[officeKey];
      if (!client) {
        const err = new Error('not connected');
        err.code = 'OFFICE_NOT_OD_CONNECTED';
        throw err;
      }
      return Object.freeze({ officeKey, officeName: officeKey, commTypeDefNum: 0, client });
    },
    assertOfficeMatch(expected, handle) {
      if (!handle || handle.officeKey !== expected) {
        const err = new Error('BLOCKED cross-office Open Dental operation');
        err.code = 'OFFICE_MISMATCH';
        throw err;
      }
      return handle;
    },
    isOdReady(officeKey) {
      return Boolean(clientsByOffice[officeKey]);
    },
  };
}

/** Sync tunables for tests — the real floor, small caps. */
function testConfig(over = {}) {
  return {
    minIntervalMs: () => 1200,
    maxPages: () => 50,
    lookbackDays: () => 0,
    budgetMs: () => 60 * 60 * 1000,
    maxNameReads: () => 500,
    callTimeoutMs: () => 30000,
    timezone: () => 'America/Chicago',
    ...over,
  };
}

module.exports = { odProc, PATIENTS, fakeOdClient, fakeOdOffices, testConfig };
