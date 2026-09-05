'use strict';

/**
 * The mount's permission pair, now that the module has mutations to gate.
 *
 * `requireReadWrite('hyg.read', 'hyg.write')` applies BY HTTP METHOD: a GET
 * needs hyg.read, everything else needs hyg.write. Slice 1 had no non-GET
 * route, so the write half of that pair was never exercised — which meant a
 * mutation added without a permission gate would have inherited hyg.write by
 * construction and nobody would have noticed the tier had arrived.
 *
 * These tests are what turn that from a construction into a claim. They boot
 * the REAL stack, so the mount order in routes/hyg/index.js and server.js is
 * what answers, not a stubbed middleware.
 *
 * `hygGuard.test.js` already covers the module-entitlement and role denials for
 * the day route. This file is only about the mutations.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeOd,
  bootHygApp,
  api,
  apptRow,
  patientRow,
  operatoryRow,
} = require('./hygTestUtils');
const { emptySlip } = require('../../hyg/contract.gen.cjs');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;

function dayOd() {
  return new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
  });
}

/** Every mutation this slice owns, as `[method, path, body]`. */
const MUTATIONS = [
  ['POST', '/api/hyg/visit/900001/open' + Q, undefined],
  ['PUT', '/api/hyg/visit/900001' + Q, { slip: emptySlip() }],
  [
    'POST',
    '/api/hyg/visit/900001/items' + Q,
    {
      teeth: [3],
      code: 'Crown',
      category: 'Restorative',
      dx: [],
      priority: 'urgent',
      motivation: [],
      status: 'proposed',
      scheduleNext: false,
      photos: [],
    },
  ],
  ['PUT', '/api/hyg/visit/900001/items/item-0001' + Q, { status: 'watch' }],
  ['DELETE', '/api/hyg/visit/900001/items/item-0001' + Q, undefined],
  ['POST', '/api/hyg/visit/900001/staged-writes' + Q, { kind: 'router' }],
  ['DELETE', '/api/hyg/visit/900001/staged-writes/router' + Q, undefined],
];

test('a role with hyg.read but not hyg.write is refused EVERY mutation', async () => {
  // `reviewer` is the platform's read-only tenant role. It can see, and it
  // cannot change — which is the whole point of having the tier.
  const app = await bootHygApp({ od: dayOd(), role: 'reviewer' });
  try {
    for (const [method, path, body] of MUTATIONS) {
      const res = await api(app.baseUrl, method, path, body === undefined ? {} : { body });
      assert.equal(res.status, 403, `${method} ${path}`);
      // And not one of them wrote anything.
    }
    assert.equal(app.db.hyg_visit.length, 0);
    assert.equal(app.db.hyg_treatment_item.length, 0);
    assert.equal(app.db.hyg_staged_write.length, 0);
  } finally {
    await app.close();
  }
});

test('a practice that is not entitled to hyg reaches no mutation either', async () => {
  const app = await bootHygApp({ od: dayOd(), modules: ['voice', 'tc'] });
  try {
    for (const [method, path, body] of MUTATIONS) {
      const res = await api(app.baseUrl, method, path, body === undefined ? {} : { body });
      assert.equal(res.status, 403, `${method} ${path}`);
      // The platform's own denial shape: the code arrives in `error`.
      assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
    }
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('an anonymous request reaches no mutation', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    for (const [method, path, body] of MUTATIONS) {
      const res = await api(app.baseUrl, method, path, {
        anon: true,
        ...(body === undefined ? {} : { body }),
      });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('every mutation is office-scoped by the router-wide middleware, before its handler', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    for (const [method, path, body] of MUTATIONS) {
      // Strip the office, keep everything else.
      const noOffice = path.replace('office=roland&', '');
      const res = await api(app.baseUrl, method, noOffice, body === undefined ? {} : { body });
      assert.equal(res.status, 400, `${method} ${noOffice}`);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }

    // And an office that is not one of ours, which is a different mistake.
    const bogus = await api(
      app.baseUrl,
      'POST',
      '/api/hyg/visit/900001/open?office=springfield&date=' + DATE
    );
    assert.equal(bogus.status, 400);
    assert.equal(bogus.body.code, 'INVALID_OFFICE');
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('an office whose hygiene switch is off reaches no mutation', async () => {
  // The per-office pilot switch (#146) narrows the module, and it must narrow
  // the mutations too — not only the read the day view makes.
  const app = await bootHygApp({ od: dayOd(), hygOffices: [] });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'OFFICE_NOT_READY');
    assert.equal(res.body.reason, 'OFFICE_HYG_NOT_ENABLED');
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});
