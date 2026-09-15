'use strict';

/**
 * `apiDeleteRaw` — the ONE delete the Open Dental transport issues (item 12).
 *
 * It exists for the perio undo, and the path is checked in the transport itself,
 * so these tests call the real method against a stand-in axios instance and
 * prove three things: it deletes a perio exam, it refuses every other path
 * without making a request, and OPENDENTAL_WRITE_DISABLED stops it the way it
 * stops `apiWriteRaw`.
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
  'refuses every path that is not exactly /perioexams/<n>, without a request',
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
      undefined,
    ]) {
      const s = service();
      const res = await s.call(path);
      assert.equal(res.ok, false, String(path));
      assert.match(res.error, /deletes a perio exam and nothing else/);
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
