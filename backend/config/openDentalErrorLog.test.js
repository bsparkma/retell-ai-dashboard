'use strict';

/**
 * The OD "Response Error" log line (post-incident, 2026-10-26).
 *
 * During the Roland outage the line printed only Open Dental's body ("An
 * unexpected error occurred..."), so whether OD refused the key (401/403) or
 * fell over (5xx), and for which office and call, had to be inferred. The line
 * now carries status, path and office — and the path NEVER carries the query
 * string, because OD search parameters can hold patient identifiers.
 *
 * Driven end to end: a real OpenDentalService (real axios + interceptors)
 * against a throwaway local HTTP server. Synthetic values only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { OpenDentalService, odRequestPath } = require('./openDental');

const ENV_KEYS = ['OD_API_URL', 'OPENDENTAL_DEVELOPER_KEY', 'OPENDENTAL_CUSTOMER_KEY', 'OPENDENTAL_INTEGRATION_MODE'];

/** Start a server that answers every request with `status` and `body`. */
function fakeOd(status, body) {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

/** Run `fn` with env pointed at `base` and console.error captured. */
async function withClient(base, officeKey, fn) {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.OD_API_URL = base;
  process.env.OPENDENTAL_DEVELOPER_KEY = 'dev-key-synthetic';
  process.env.OPENDENTAL_CUSTOMER_KEY = 'customer-key-synthetic';
  process.env.OPENDENTAL_INTEGRATION_MODE = 'api';

  /** @type {string[]} */
  const lines = [];
  const realError = console.error;
  const realLog = console.log;
  console.error = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = () => {};
  try {
    const svc = new OpenDentalService({ customerKey: 'customer-key-synthetic', officeKey });
    await fn(svc);
  } finally {
    console.error = realError;
    console.log = realLog;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
  return lines.filter((l) => l.startsWith('[OD API] Response Error'));
}

test('odRequestPath drops the query string and fragment, and reduces an absolute URL to its path', () => {
  assert.equal(odRequestPath('/patients?LName=Synthetic&Phone=5550100'), '/patients');
  assert.equal(odRequestPath('/appointments?dateStart=2026-10-26#x'), '/appointments');
  assert.equal(odRequestPath('/patients/Simple'), '/patients/Simple');
  assert.equal(odRequestPath('https://od.example.test/api/v1/patients?LName=Synthetic'), '/api/v1/patients');
  assert.equal(odRequestPath(''), '(unknown)');
  assert.equal(odRequestPath(undefined), '(unknown)');
});

test('a 5xx from OD logs status, path (no query) and office, plus the same body detail as before', async () => {
  const od = await fakeOd(500, 'An unexpected error occurred while processing your request.');
  try {
    const lines = await withClient(od.base, 'roland', async (svc) => {
      await assert.rejects(svc.client.get('/appointments?dateStart=2026-10-26&dateEnd=2026-10-26'));
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[OD API\] Response Error: status=500 path=\/appointments office=roland /);
    assert.match(lines[0], /An unexpected error occurred while processing your request\./);
    assert.ok(!lines[0].includes('dateStart'), 'the query string is never logged');
  } finally {
    await od.close();
  }
});

test('a 401 is distinguishable from an outage, and a search query never reaches the log', async () => {
  const od = await fakeOd(401, 'Invalid authorization');
  try {
    const lines = await withClient(od.base, 'valley', async (svc) => {
      await assert.rejects(svc.client.get('/patients?LName=Synthetic&Phone=5550100'));
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /status=401 path=\/patients office=valley/);
    assert.ok(!/Synthetic|5550100|LName|Phone/.test(lines[0]), 'search parameters stay out of the log');
  } finally {
    await od.close();
  }
});

test('no response at all (connection refused) logs status=none, and the singleton logs office=default', async () => {
  const od = await fakeOd(200, []);
  const deadBase = od.base;
  await od.close(); // nothing listens there now
  const lines = await withClient(deadBase, null, async (svc) => {
    await assert.rejects(svc.client.get('/providers'));
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /status=none path=\/providers office=default/);
});
