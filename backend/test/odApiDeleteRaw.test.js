'use strict';

/**
 * `apiDeleteRaw` — the ONLY deletes the Open Dental transport issues.
 *
 * It began as exactly one (the perio undo, item 12) and is now an enumerated
 * allow-list of two: the fee schedule rollback needs `DELETE /fees/{FeeNum}`,
 * because Open Dental offers no delete for /feescheds at all and removing the
 * fees is therefore the only rollback the API makes possible. That widening is
 * the "second, reviewed edit" the method's own header asked for, and the shape
 * of the guard did not change — it is still a list of exact patterns checked in
 * the transport, not a parameter any caller can influence.
 *
 * The path is checked in the transport itself, so these tests call the real
 * method against a stand-in axios instance and prove four things: it deletes a
 * perio exam, it deletes a fee, it refuses every other path without making a
 * request, and OPENDENTAL_WRITE_DISABLED stops it the way it stops
 * `apiWriteRaw`.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { OpenDentalService } = require('../config/openDental');

function service({ answer = { status: 200, data: '' }, error = null } = {}) {
  const requests = [];
  const self = {
    enabled: true,
    useDatabase: false,
    client: {
      delete: async (path, config) => {
        requests.push({ path, config });
        if (error) throw error;
        return answer;
      },
    },
  };
  return { requests, call: (path, opts) => OpenDentalService.prototype.apiDeleteRaw.call(self, path, opts) };
}

function withEnv(key, value, fn) {
  return async () => {
    const saved = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
      await fn();
    } finally {
      if (saved === undefined) delete process.env[key];
      else process.env[key] = saved;
    }
  };
}

test(
  'deletes a perio exam, carrying the module attribution and timeout',
  withEnv('OPENDENTAL_WRITE_DISABLED', undefined, async () => {
    const s = service();
    const res = await s.call('/perioexams/7001', { module: 'hyg', timeoutMs: 30000 });
    assert.deepEqual(res, { ok: true, status: 200, data: '' });
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].path, '/perioexams/7001');
    assert.equal(s.requests[0].config.__odModule, 'hyg');
    assert.equal(s.requests[0].config.timeout, 30000);
  })
);

test(
  'deletes a fee, carrying the fees module attribution',
  withEnv('OPENDENTAL_WRITE_DISABLED', undefined, async () => {
    // The second allow-listed shape. Its only caller is
    // services/fees/odFeesWrites.js, held there by feesNoOdAccess.test.js.
    const s = service();
    const res = await s.call('/fees/880042', { module: 'fees', minIntervalMs: 1200 });
    assert.deepEqual(res, { ok: true, status: 200, data: '' });
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].path, '/fees/880042');
    assert.equal(s.requests[0].config.__odModule, 'fees');
  })
);

test(
  'refuses every path outside the two allow-listed shapes, without a request',
  withEnv('OPENDENTAL_WRITE_DISABLED', undefined, async () => {
    for (const path of [
      '/periomeasures/90001',
      '/claimpayments/5',
      '/patients/12827',
      '/perioexams',
      '/perioexams/',
      '/perioexams/0',
      '/perioexams/-1',
      '/perioexams/7001/periomeasures',
      '/perioexams/7001?force=true',
      '/perioexams/../patients/1',
      'perioexams/7001',
      // The fee shape is exactly as narrow as the perio one. In particular
      // /feescheds/<n> is NOT deletable — the API has no such endpoint, and a
      // guard that admitted it would let a rollback attempt something that can
      // only ever 404 while looking like it might have worked.
      '/feescheds/12',
      '/fees',
      '/fees/',
      '/fees/0',
      '/fees/-1',
      '/fees/880042?force=true',
      '/fees/880042/history',
      'fees/880042',
      undefined,
    ]) {
      const s = service();
      const res = await s.call(path);
      assert.equal(res.ok, false, String(path));
      assert.match(res.error, /deletes a perio exam or a fee and nothing else/);
      assert.equal(s.requests.length, 0, 'no request for ' + String(path));
    }
  })
);

test(
  'OPENDENTAL_WRITE_DISABLED refuses it, as it refuses apiWriteRaw',
  withEnv('OPENDENTAL_WRITE_DISABLED', 'true', async () => {
    const s = service();
    const res = await s.call('/perioexams/7001');
    assert.equal(res.ok, false);
    assert.equal(res.status, 403);
    assert.match(res.error, /^OD_WRITE_DISABLED/);
    assert.equal(s.requests.length, 0);
  })
);

test(
  "a refusal comes back with Open Dental's own words and status, not a throw",
  withEnv('OPENDENTAL_WRITE_DISABLED', undefined, async () => {
    const err = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: 'PerioExam not found.' },
    });
    const res = await service({ error: err }).call('/perioexams/7001');
    assert.deepEqual(res, { ok: false, status: 400, data: 'PerioExam not found.', error: 'PerioExam not found.' });

    const lost = await service({ error: new Error('socket hang up') }).call('/perioexams/7001');
    assert.equal(lost.ok, false);
    assert.equal(lost.status, 0);
  })
);
