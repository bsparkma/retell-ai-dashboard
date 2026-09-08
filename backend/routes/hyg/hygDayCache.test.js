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
 *
 * Since progressive fill there are TWO endpoints and the claim splits with
 * them: `GET /day` discloses only the patients it can name from the cache and
 * audits exactly those; `GET /day/identities` audits each one at the moment it
 * sends the name. `loadDay` below drives both, the way the page does, so every
 * assertion here is still about the whole disclosure.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootHygApp, api, FakeOd, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

const DATE = '2026-09-08';
const DAY = '/api/hyg/day?office=roland&date=' + DATE;
const FILL = '/api/hyg/day/identities?office=roland&date=' + DATE;

/**
 * One day, loaded the way the page loads it: the schedule, then the names, a
 * batch at a time, until nothing is pending or nothing moves.
 *
 * The stop condition is the CLIENT's, restated here rather than assumed: a fill
 * that does not reduce `pending` will not reduce it next time either, and a
 * test harness that looped forever would hide exactly the bug the rule exists
 * to prevent.
 *
 * @param {string} base @param {string} dayUrl @param {string} fillUrl
 * @returns {Promise<{ day: any, fills: any[] }>}
 */
async function loadDay(base, dayUrl = DAY, fillUrl = FILL) {
  const day = await api(base, 'GET', dayUrl);
  const fills = [];
  if (day.status !== 200) return { day, fills };
  let pending = day.body.identitiesPending;
  while (pending > 0) {
    const fill = await api(base, 'GET', fillUrl);
    fills.push(fill);
    if (fill.status !== 200 || fill.body.pending >= pending) break;
    pending = fill.body.pending;
  }
  return { day, fills };
}

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
    const first = await loadDay(app.baseUrl);
    assert.equal(first.day.status, 200);

    const firstReads = patientReads(od);
    assert.deepEqual(
      firstReads.sort(),
      ['/patients/12827', '/patients/12828', '/patients/990111'],
      'three distinct patients, four appointments'
    );
    const firstRows = rowsOfType(app.db, 'hyg_day_patient');
    assert.equal(firstRows.length, 3);

    const second = await loadDay(app.baseUrl);
    assert.equal(second.day.status, 200);

    // Half one: the cache did its job.
    assert.deepEqual(
      patientReads(od),
      firstReads,
      'the second load must issue ZERO further patient reads'
    );
    assert.equal(second.day.body.stats.odPatientReads, 0);
    assert.equal(second.day.body.stats.patientCacheHits, 3);
    // AND THE SECOND LOAD NEEDS NO FILL AT ALL: everything came back named
    // from the cache, so `identitiesPending` was zero and the page never asked.
    assert.equal(second.day.body.identitiesPending, 0);
    assert.equal(second.fills.length, 0);

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

    // And the answer is the same answer, not a thinner one. The second load
    // came back fully named from the cache in ONE request, where the first
    // needed a fill to get there — same cards, same names, different cost.
    const named = (r) => r.body.appointments.map((a) => [a.aptNum, a.identity, a.patientName]);
    const fromFill = new Map(
      first.fills[0].body.patients.map((p) => [p.patNum, p.patientName])
    );
    assert.deepEqual(
      named(second.day),
      first.day.body.appointments.map((a) => [a.aptNum, 'resolved', fromFill.get(a.patNum)])
    );
  } finally {
    await app.close();
  }
});

test('THE SCHEDULE DOES NOT WAIT FOR THE NAMES', async () => {
  /*
   * The whole point of the slice. A cold day used to spend one Open Dental
   * request per distinct patient BEFORE it returned anything — one second each
   * on a shared, throttled credential — so a 40-patient day was forty seconds
   * of blank skeleton.
   *
   * Now `GET /day` spends its list reads and NOTHING ELSE. Every card is on
   * screen, in the right chair at the right time, saying honestly that it does
   * not know who is in it yet.
   */
  const od = dayOd();
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', DAY);
    assert.equal(res.status, 200);

    assert.deepEqual(patientReads(od), [], 'ZERO patient reads on the first paint');
    assert.equal(res.body.stats.odPatientReads, 0);
    assert.equal(res.body.stats.odListReads, 4, 'appointments, chairs, types, providers');
    assert.equal(res.body.appointments.length, 4, 'the whole schedule is here');
    assert.equal(res.body.identitiesPending, 3);

    for (const a of res.body.appointments) {
      assert.equal(a.identity, 'pending');
      assert.equal(a.patientName, null);
      // AND THE FLAGS ARE UNKNOWN, NOT ABSENT. A premed nobody has read is
      // null, which the card draws as "unknown" — never as "no".
      assert.equal(a.flags.premed, null);
      assert.equal(a.flags.medicalAlerts, null);
    }

    // NOTHING WAS DISCLOSED, SO NOTHING IS AUDITED. A card with a time, a
    // chair and no name says nothing about a person; a row claiming otherwise
    // would be a disclosure that did not happen.
    assert.equal(rowsOfType(app.db, 'hyg_day_patient').length, 0);
    assert.equal(rowsOfType(app.db, 'hyg_day').length, 1, 'the request itself is recorded');
  } finally {
    await app.close();
  }
});

test('the fill names them in batches, and audits each one as it is sent', async () => {
  const od = dayOd();
  const app = await bootHygApp({ od });
  try {
    await api(app.baseUrl, 'GET', DAY);
    assert.equal(rowsOfType(app.db, 'hyg_day_patient').length, 0);

    const fill = await api(app.baseUrl, 'GET', FILL);
    assert.equal(fill.status, 200);
    assert.equal(fill.body.pending, 0, 'three patients fit in one batch of eight');
    assert.deepEqual(fill.body.patients.map((p) => p.patNum).sort(), [12827, 12828, 990111]);
    assert.deepEqual(fill.body.unavailable, []);

    // ONE ROW PER PATIENT, AT THE MOMENT THE NAME IS SENT.
    const rows = rowsOfType(app.db, 'hyg_day_patient');
    assert.equal(rows.length, 3);
    // resource_id is stored as text — a PatNum is an identifier, not a number
    // anything adds up.
    assert.deepEqual(rows.map((r) => String(r.resource_id)).sort(), ['12827', '12828', '990111']);
    for (const row of rows) assert.equal(row.office, 'roland');

    // The identity carries the two flags the patient record answers, and NOT
    // the medical-alert note itself — its presence is the fact, its text is PHI
    // this screen has no reason to hold.
    const one = fill.body.patients.find((p) => p.patNum === 12827);
    assert.deepEqual(Object.keys(one).sort(), [
      'medicalAlerts',
      'patNum',
      'patientName',
      'premed',
    ]);
  } finally {
    await app.close();
  }
});

test('A PATIENT OPEN DENTAL WILL NOT ANSWER FOR STOPS THE LOOP', async () => {
  /*
   * The honest-state claim, and the one that keeps a spinner from being
   * permanent. A record the API refuses comes back in `unavailable` — NOT in
   * `pending` — so the card says "Name unavailable" and the page stops asking.
   *
   * `pending` reaching zero is what ends the loop; a failed patient that stayed
   * pending would make it run forever over a chart that is never coming.
   */
  const od = dayOd();
  od.routes['/patients/990111'] = { ok: false, status: 403, data: null, error: 'forbidden' };
  const app = await bootHygApp({ od });
  try {
    const { day, fills } = await loadDay(app.baseUrl);
    assert.equal(day.status, 200);
    assert.equal(fills.length, 1, 'one batch, and then nothing left to wait for');

    const fill = fills[0].body;
    assert.equal(fill.pending, 0);
    assert.deepEqual(fill.unavailable, [990111]);
    assert.deepEqual(fill.patients.map((p) => p.patNum).sort(), [12827, 12828]);

    // AND THE REFUSED PATIENT IS NOT AUDITED. Nothing about them was sent.
    const rows = rowsOfType(app.db, 'hyg_day_patient');
    assert.deepEqual(rows.map((r) => String(r.resource_id)).sort(), ['12827', '12828']);
  } finally {
    await app.close();
  }
});

test('the fill takes no PatNums — the set comes from the day', async () => {
  /*
   * ⚠️ THE DISCLOSURE SURFACE. ⚠️ A fill endpoint that accepted a list of
   * PatNums would be a name-and-medical-alert lookup for every patient number
   * in the practice, walkable one integer at a time. The server derives the set
   * from that day's own schedule instead, so a query param cannot widen it.
   *
   * 990222 is not booked. Asking for them by every spelling a caller might try
   * must name nobody but the three people who ARE on the day.
   */
  const od = dayOd();
  od.routes['/patients/990222'] = patientRow({ PatNum: 990222, LName: 'NotOn', FName: 'ThisDay' });
  const app = await bootHygApp({ od });
  try {
    await api(app.baseUrl, 'GET', DAY);
    const fill = await api(
      app.baseUrl,
      'GET',
      FILL + '&patNums=990222&patNum=990222&pat_nums=990222'
    );

    assert.equal(fill.status, 200);
    assert.deepEqual(fill.body.patients.map((p) => p.patNum).sort(), [12827, 12828, 990111]);
    assert.ok(
      !patientReads(od).includes('/patients/990222'),
      'a patient who is not on the day is never even read'
    );
    assert.ok(
      !rowsOfType(app.db, 'hyg_day_patient').some((r) => String(r.resource_id) === '990222'),
      'and never audited, because nothing about them was disclosed'
    );
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
    // The FILL is where the patients are disclosed now, so it is where the
    // batching claim lives. Forty patients was forty round trips to the control
    // plane in front of a response somebody was waiting on.
    await api(app.baseUrl, 'GET', DAY);
    await api(app.baseUrl, 'GET', FILL);

    const statements = app.db.statements.filter((sql) => /INSERT INTO audit_log/i.test(sql));
    // Two request rows (one per endpoint) and ONE statement carrying all three
    // patients — still one ROW each, which is what the trail is for.
    assert.equal(statements.length, 3, 'expected the patient rows to be batched');
    assert.equal(app.db.audit.length - before, 5);
    assert.equal(rowsOfType(app.db, 'hyg_day').length, 2);
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
      // WHERE THE TIME WENT, per phase. "It fails at times" and "it is slow"
      // are both unactionable; a number against the read that was slow is not.
      'phaseMs',
    ]);
    assert.equal(stats.odPatientReads, 0, 'the first paint pays for no identities');
    assert.equal(stats.patientsRequested, 3);
    // appointments, operatories, appointmenttypes, providers — one page each.
    assert.equal(stats.odListReads, 4);
    assert.ok(Number.isInteger(stats.durationMs) && stats.durationMs >= 0);
    assert.deepEqual(Object.keys(stats.phaseMs).sort(), [
      'appointments',
      'identities',
      'labels',
      'operatories',
    ]);
    for (const ms of Object.values(stats.phaseMs)) {
      assert.ok(Number.isInteger(ms) && ms >= 0);
    }

    // patientsRequested = hits + deduped + reads + STILL UNASKED. The identity
    // was the fourth term all along; before progressive fill it was always
    // zero, so the sum of three held by accident.
    assert.equal(
      stats.patientCacheHits + stats.patientCacheDeduped + stats.odPatientReads,
      stats.patientsRequested - res.body.identitiesPending
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
    await loadDay(app.baseUrl);
    const afterRoland = patientReads(od).length;
    assert.equal(afterRoland, 3);

    const valley = await loadDay(
      app.baseUrl,
      '/api/hyg/day?office=valley&date=' + DATE,
      '/api/hyg/day/identities?office=valley&date=' + DATE
    );
    assert.equal(valley.day.status, 200);

    assert.equal(
      patientReads(od).length,
      6,
      "valley must read its own patients — roland's 12827 is a different person"
    );
    assert.equal(valley.fills[0].body.stats.patientCacheHits, 0);
    assert.equal(valley.fills[0].body.stats.odPatientReads, 3);

    // The CONFIG lists are cached per office too, and for the same reason:
    // Operatory 4 is a different room in each practice.
    assert.equal(valley.day.body.stats.odListReads, 4, "valley reads its OWN chairs");

    for (const row of rowsOfType(app.db, 'hyg_day_patient').slice(3)) {
      assert.equal(row.office, 'valley');
    }
  } finally {
    await app.close();
  }
});
