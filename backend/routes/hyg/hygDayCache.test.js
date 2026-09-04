'use strict';

/**
 * GET /api/hyg/day, over the shared patient cache.
 *
 * The claim under test is not "the cache works" — services/odPatientCache.test.js
 * covers that. It is that CACHING DID NOT COST US THE AUDIT TRAIL.
 *
 * A HIPAA audit row records that a patient's information was shown to a user.
 * A cache hit shows it just the same, so the second load of a day must write
 * exactly as many `hyg_day_patient` rows as the first while issuing none of the
 * Open Dental requests. Those two assertions live in one test on purpose: taken
 * apart, each of them passes under the bug the pair exists to catch.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, FakeOd, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

const DATE = '2026-09-08';
const DAY = '/api/hyg/day?office=roland&date=' + DATE;

/**
 * A day with three synthetic patients on it. Staging fixtures only — roland
 * 12827 / 12828, plus one obviously-synthetic number.
 */
function dayOd() {
  return new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' }),
      apptRow({ AptNum: 900002, PatNum: 12828, AptDateTime: DATE + ' 09:00:00' }),
      apptRow({ AptNum: 900003, PatNum: 990111, AptDateTime: DATE + ' 10:00:00' }),
      // The same patient twice: a hygiene visit and a later exam. Two
      // appointments, ONE patient — one read and one audit row.
      apptRow({ AptNum: 900004, PatNum: 12827, AptDateTime: DATE + ' 14:00:00' }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow({ PatNum: 12827 }),
    '/patients/12828': patientRow({ PatNum: 12828, LName: 'Test', FName: 'MangoTest' }),
    '/patients/990111': patientRow({ PatNum: 990111, LName: 'Synthetic', FName: 'Three' }),
  });
}

/** Every `GET /patients/{PatNum}` this client was asked for. */
function patientReads(od) {
  return od.calls.filter((c) => c.path.startsWith('/patients/')).map((c) => c.path);
}

/** Audit rows of one resource type. */
function rowsOfType(db, resourceType) {
  return db.audit.filter((r) => r.resource_type === resourceType);
}

test('the second load of a day reads nothing, and audits everybody all over again', async () => {
  /*
   * THE TRAP THIS PINS.
   *
   * It is natural to write the audit row next to the fetch — you have the
   * PatNum right there. Do that and the better the cache gets, the emptier the
   * trail gets: the second hygienist to open Tuesday would be recorded as
   * having seen nobody.
   *
   * So routes/hyg/day.js builds its rows from `day.appointments` — what it is
   * about to SEND — and services/odPatientCache.js has no audit call in it at
   * all. Both halves are asserted here, together.
   */
  const od = dayOd();
  const app = await bootHygApp({ od });
  try {
    const first = await api(app.baseUrl, 'GET', DAY);
    assert.equal(first.status, 200);

    const firstReads = patientReads(od);
    assert.deepEqual(
      firstReads.sort(),
      ['/patients/12827', '/patients/12828', '/patients/990111'],
      'three distinct patients, four appointments'
    );
    const firstRows = rowsOfType(app.db, 'hyg_day_patient');
    assert.equal(firstRows.length, 3);

    const second = await api(app.baseUrl, 'GET', DAY);
    assert.equal(second.status, 200);

    // Half one: the cache did its job.
    assert.deepEqual(
      patientReads(od),
      firstReads,
      'the second load must issue ZERO further patient reads'
    );
    assert.equal(second.body.stats.odPatientReads, 0);
    assert.equal(second.body.stats.patientCacheHits, 3);

    // Half two: and it cost us nothing in the trail.
    const secondRows = rowsOfType(app.db, 'hyg_day_patient');
    assert.equal(
      secondRows.length,
      firstRows.length * 2,
      'the second disclosure must be recorded as fully as the first'
    );
    assert.deepEqual(
      secondRows.slice(3).map((r) => r.resource_id).sort(),
      firstRows.map((r) => r.resource_id).sort()
    );
    // Every row still carries its office: a PatNum without one identifies nobody.
    for (const row of secondRows) assert.equal(row.office, 'roland');

    // And the answer is the same answer, not a thinner one.
    assert.deepEqual(second.body.appointments, first.body.appointments);
  } finally {
    await app.close();
  }
});

test('the patients are audited in ONE statement, one row each', async () => {
  // Forty patients was forty round trips to the control plane in front of a
  // response somebody was waiting on. Still one ROW per patient — a summary
  // row is what the per-patient trail exists to prevent.
  const od = dayOd();
  const app = await bootHygApp({ od });
  try {
    const before = app.db.audit.length;
    await api(app.baseUrl, 'GET', DAY);

    const statements = app.db.statements.filter((sql) => /INSERT INTO audit_log/i.test(sql));
    // One for the `hyg_day` request row, one carrying all three patients.
    assert.equal(statements.length, 2, 'expected the patient rows to be batched');
    assert.equal(app.db.audit.length - before, 4);
    assert.equal(rowsOfType(app.db, 'hyg_day').length, 1);
    assert.equal(rowsOfType(app.db, 'hyg_day_patient').length, 3);
  } finally {
    await app.close();
  }
});

test('a failed audit still 500s rather than serving a cached day untracked', async () => {
  // Hard rule 5, and the cache does not get to opt out of it: a day served from
  // memory is a disclosure exactly like one served from Open Dental.
  const od = dayOd();
  const app = await bootHygApp({ od });
  try {
    const warm = await api(app.baseUrl, 'GET', DAY);
    assert.equal(warm.status, 200);

    app.db.failAudit = true;
    const denied = await api(app.baseUrl, 'GET', DAY);
    assert.equal(denied.status, 500);
    assert.equal(denied.body.code, 'AUDIT_FAILED');
  } finally {
    await app.close();
  }
});

test('a day with nobody on it audits nobody, and does not send an empty INSERT', async () => {
  const od = new FakeOd({
    '/appointments': [],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [],
    '/providers': [],
  });
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', DAY);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.appointments, []);
    assert.equal(rowsOfType(app.db, 'hyg_day').length, 1, 'the request itself is still recorded');
    assert.equal(rowsOfType(app.db, 'hyg_day_patient').length, 0);
    assert.equal(res.body.stats.odPatientReads, 0);
  } finally {
    await app.close();
  }
});

test('the response reports what the read cost, in counts and never in names', async () => {
  // "It should be faster" is not a result. These are the numbers the PR body's
  // before/after is measured with.
  const od = dayOd();
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', DAY);
    const stats = res.body.stats;

    assert.deepEqual(Object.keys(stats).sort(), [
      'durationMs',
      'odListReads',
      'odPatientReads',
      'patientCacheDeduped',
      'patientCacheHits',
      'patientsRequested',
    ]);
    assert.equal(stats.odPatientReads, 3);
    assert.equal(stats.patientsRequested, 3);
    // appointments, operatories, appointmenttypes, providers — one page each.
    assert.equal(stats.odListReads, 4);
    assert.ok(Number.isInteger(stats.durationMs) && stats.durationMs >= 0);

    // patientsRequested = hits + deduped + reads, always.
    assert.equal(
      stats.patientCacheHits + stats.patientCacheDeduped + stats.odPatientReads,
      stats.patientsRequested
    );

    // A cost summary must never become a list of who was seen.
    const serialised = JSON.stringify(stats);
    assert.ok(!serialised.includes('12827'));
    assert.ok(!/[A-Za-z]{3,}/.test(serialised.replace(/"[a-zA-Z]+":/g, '')));
  } finally {
    await app.close();
  }
});

test('one office\'s warm day is never served for the other office', async () => {
  /*
   * The route-level half of the cross-office claim. PatNum numbering restarts in
   * every Open Dental database, so a cache that leaked across offices would put
   * one practice's patient on the other practice's schedule under a name that
   * looked entirely plausible.
   *
   * Both offices are switched on here, and both are asked for the SAME PatNums
   * on the same date. Valley must issue its own reads.
   */
  const od = dayOd();
  const app = await bootHygApp({ od, hygOffices: ['roland', 'valley'] });
  try {
    await api(app.baseUrl, 'GET', DAY);
    const afterRoland = patientReads(od).length;
    assert.equal(afterRoland, 3);

    const valley = await api(app.baseUrl, 'GET', '/api/hyg/day?office=valley&date=' + DATE);
    assert.equal(valley.status, 200);

    assert.equal(
      patientReads(od).length,
      6,
      "valley must read its own patients — roland's 12827 is a different person"
    );
    assert.equal(valley.body.stats.patientCacheHits, 0);
    assert.equal(valley.body.stats.odPatientReads, 3);

    for (const row of rowsOfType(app.db, 'hyg_day_patient').slice(3)) {
      assert.equal(row.office, 'valley');
    }
  } finally {
    await app.close();
  }
});
