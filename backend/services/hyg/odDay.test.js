'use strict';

/**
 * The hygiene Day View's Open Dental reads.
 *
 * Four claims, in descending order of how much damage the bug would do:
 *
 *   1. A DAY BIGGER THAN ONE PAGE COMES BACK WHOLE. Open Dental caps every list
 *      at 100 rows and pages with `Offset`. The H0 spike caught this because
 *      `/scheduleops` returned exactly 100 — an answer that looks complete and
 *      is not. A hygienist whose last patient of the day silently vanished has
 *      no way to notice.
 *   2. NOTHING IS FABRICATED. An unknown flag is null, never false. An absent
 *      Pattern is a null duration, never a made-up 30 minutes. A patient record
 *      that could not be read is a null name, never "Unknown Patient".
 *   3. AN ERROR IS NOT AN EMPTY DAY. A first-page failure returns ok:false, so
 *      the route can refuse. A LATER-page failure returns what was read plus a
 *      warning — three quarters of a day beats an outage, and beats three
 *      quarters pretending to be all of it.
 *   4. ONE PULL FOR THE DAY. `/appointments` is requested with `date` and never
 *      with `Op`, because `Op` filters to exactly one operatory and a per-chair
 *      fan-out on a shared credential is what this design exists to avoid.
 *
 * NO REAL PATIENT DATA. Every PatNum below is a designated staging fixture or
 * an obviously synthetic number.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const odDay = require('./odDay');
const odPatientCache = require('../odPatientCache');

/*
 * The patient cache is process-wide and survives between tests, which is the
 * point of it — and which would make every "how many OD calls did this make"
 * assertion below depend on which test ran first. Cleared before each one so
 * each measures a cold read, the way the first load of a day actually is.
 */
test.beforeEach(() => odPatientCache.resetOdPatientCache());

/**
 * A scripted odGet. `routes` is keyed by path, or by `path?Offset=N` when a
 * test is exercising paging.
 */
function fakeGet(routes) {
  const calls = [];
  const get = async (path, params = {}, opts = {}) => {
    calls.push({ path, params, opts });
    const offset = params && params.Offset;
    const keyed = offset !== undefined ? path + '?Offset=' + offset : path;
    const scripted = Object.prototype.hasOwnProperty.call(routes, keyed)
      ? routes[keyed]
      : Object.prototype.hasOwnProperty.call(routes, path)
        ? routes[path]
        : undefined;
    if (scripted === undefined) return { ok: false, status: 404, data: null, error: 'not scripted' };
    if (scripted && typeof scripted === 'object' && !Array.isArray(scripted) && 'ok' in scripted) {
      return scripted;
    }
    return { ok: true, status: 200, data: scripted };
  };
  get.calls = calls;
  return get;
}

function appt(n, over = {}) {
  return {
    AptNum: 900000 + n,
    PatNum: 800000 + n,
    AptStatus: 'Scheduled',
    Pattern: 'XXXXXXXXXXXX',
    Op: 2,
    ProvNum: 1,
    ProvHyg: 7,
    IsHygiene: true,
    AptDateTime: '2026-09-08 ' + String(7 + (n % 10)).padStart(2, '0') + ':00:00',
    ...over,
  };
}

function patient(patNum, over = {}) {
  return { PatNum: patNum, LName: 'Synthetic', FName: 'Fixture', Premed: false, MedUrgNote: '', ...over };
}

// ── 1. paging ───────────────────────────────────────────────────────────────

test('a day with MORE than 100 appointments comes back whole', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => appt(i));
  const page2 = Array.from({ length: 37 }, (_, i) => appt(100 + i));

  const routes = {
    '/appointments': page1,
    '/appointments?Offset=100': page2,
    '/operatories': [],
    '/appointmenttypes': [],
    '/providers': [],
  };
  // Every patient read must resolve, or the fan-out cap would confound this.
  for (const a of [...page1, ...page2]) routes['/patients/' + a.PatNum] = patient(a.PatNum);

  const get = fakeGet(routes);
  const day = await odDay.readDay(get, { date: '2026-09-08', office: 'roland' });

  assert.equal(day.ok, true);
  assert.equal(day.appointments.length, 137, 'a second page must not be dropped');
  assert.equal(day.truncated, false, 'the SCHEDULE is complete, so it is not truncated');
  assert.equal(
    day.warnings.filter((w) => w.resource === 'appointments').length,
    0,
    'a whole day warns about nothing'
  );
  // 137 distinct patients is past the naming budget, and that is a SEPARATE
  // fact. These were one boolean briefly, and a complete 137-patient day
  // reported its own schedule as incomplete — the screen telling a hygienist
  // not to trust a day that was entirely correct.
  assert.equal(day.patientNamesTruncated, true, 'some cards carry no name');
  assert.ok(
    day.appointments.some((a) => a.aptNum === 900136),
    'and the last appointment of the second page is still here'
  );

  // The second request is the one this test exists for.
  const apptCalls = get.calls.filter((c) => c.path === '/appointments');
  assert.equal(apptCalls.length, 2);
  assert.equal(apptCalls[0].params.Offset, undefined, 'the first page sends no Offset');
  assert.equal(apptCalls[1].params.Offset, 100);
});

test('a page budget exhausted on a FULL page reports truncation rather than a short day', async () => {
  const full = Array.from({ length: 100 }, (_, i) => appt(i));

  // Every offset the budget can reach answers a FULL page, so the walk can only
  // end at the budget — which is the one case where "what I have" and "all
  // there is" are different and indistinguishable from the outside.
  const routes = { '/operatories': [], '/appointmenttypes': [], '/providers': [] };
  routes['/appointments'] = full;
  for (let page = 1; page <= 30; page += 1) {
    routes['/appointments?Offset=' + page * 100] = full;
  }
  for (const a of full) routes['/patients/' + a.PatNum] = patient(a.PatNum);

  const day = await odDay.readDay(fakeGet(routes), { date: '2026-09-08', office: 'roland' });

  assert.equal(day.ok, true);
  assert.equal(day.truncated, true, 'a budget exhausted mid-list must SAY so');
  assert.ok(
    day.warnings.some((w) => w.resource === 'appointments' && /missing/i.test(w.message)),
    'and must say so in words the screen can render'
  );
});

test('the day is pulled ONCE — never one request per operatory', async () => {
  const rows = [appt(1, { Op: 1 }), appt(2, { Op: 2 }), appt(3, { Op: 3 }), appt(4, { Op: 4 })];
  const routes = { '/appointments': rows, '/operatories': [], '/appointmenttypes': [], '/providers': [] };
  for (const a of rows) routes['/patients/' + a.PatNum] = patient(a.PatNum);

  const get = fakeGet(routes);
  await odDay.readDay(get, { date: '2026-09-08', office: 'roland' });

  const apptCalls = get.calls.filter((c) => c.path === '/appointments');
  assert.equal(apptCalls.length, 1, 'four chairs, one request');
  for (const c of apptCalls) {
    assert.equal(c.params.Op, undefined, "`Op` filters to ONE operatory - it must never be sent here");
  }
});

// ── 2. nothing is fabricated ────────────────────────────────────────────────

test('an unread flag is null, never false', async () => {
  const rows = [appt(1)];
  const day = await odDay.readDay(
    fakeGet({
      '/appointments': rows,
      '/operatories': [],
      '/appointmenttypes': [],
      '/providers': [],
      '/patients/800001': patient(800001, { Premed: true, MedUrgNote: 'Latex' }),
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  const flags = day.appointments[0].flags;
  // Read from Open Dental, so these carry real answers.
  assert.equal(flags.premed, true);
  assert.equal(flags.medicalAlerts, true);
  // NOT read by this slice. `false` here would say "this patient has no
  // allergies", which we have not asked and do not know.
  for (const unread of ['allergies', 'lastPerioDate', 'xraysDue', 'examNeeded', 'openTcCase']) {
    assert.equal(flags[unread], null, unread + ' is not read in slice 1 and must be null');
    assert.equal(day.flagSources[unread], 'not_read', 'and the payload must say why');
  }
  assert.equal(day.flagSources.premed, 'od');
});

test('an empty medical-alert note is a measured false, and an unreadable patient is null', async () => {
  const rows = [appt(1), appt(2)];
  const day = await odDay.readDay(
    fakeGet({
      '/appointments': rows,
      '/operatories': [],
      '/appointmenttypes': [],
      '/providers': [],
      '/patients/800001': patient(800001, { MedUrgNote: '   ' }),
      // 800002 is not scripted -> a 404 -> an unreadable patient.
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  const [a, b] = day.appointments;
  assert.equal(a.flags.medicalAlerts, false, 'OD said the note is empty: that is a real false');
  assert.equal(a.patientName, 'Synthetic, Fixture');

  assert.equal(b.patientName, null, 'a patient we could not read has NO name, not a fake one');
  assert.equal(b.flags.premed, null);
  assert.equal(b.flags.medicalAlerts, null);
  assert.ok(
    day.warnings.some((w) => w.resource === 'patients'),
    'and the day says a record could not be read'
  );
  // The appointment itself survives: losing a name must not lose a patient.
  assert.equal(b.aptNum, 900002);
});

test('duration comes from Pattern at five minutes a character, and is null without one', () => {
  assert.equal(odDay.minutesFromPattern('XXXXXXXXXXXX'), 60);
  assert.equal(odDay.minutesFromPattern('//XXXX//'), 40, 'assistant time is still time in the chair');
  assert.equal(odDay.minutesFromPattern('XXXXXX'), 30);
  // The failures that matter: none of these may become a plausible-looking 30.
  assert.equal(odDay.minutesFromPattern(''), null);
  assert.equal(odDay.minutesFromPattern('   '), null);
  assert.equal(odDay.minutesFromPattern(undefined), null);
  assert.equal(odDay.minutesFromPattern(null), null);
  assert.equal(odDay.minutesFromPattern(60), null);
});

test("Open Dental's string booleans are parsed, and anything else is null", () => {
  assert.equal(odDay.odBool(true), true);
  assert.equal(odDay.odBool('true'), true);
  assert.equal(odDay.odBool('False'), false);
  assert.equal(odDay.odBool(false), false);
  // The trap: 'IsHidden' arrives as the STRING "false" on /definitions, and a
  // truthiness check on it hides every row. Anything unrecognised is unknown.
  assert.equal(odDay.odBool('yes'), null);
  assert.equal(odDay.odBool(1), null);
  assert.equal(odDay.odBool(undefined), null);
});

test('the raw per-office Confirmed DefNum is never returned, only the resolved string', async () => {
  const day = await odDay.readDay(
    fakeGet({
      '/appointments': [appt(1, { Confirmed: 244, confirmed: 'In Treatment Room' })],
      '/operatories': [],
      '/appointmenttypes': [],
      '/providers': [],
      '/patients/800001': patient(800001),
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  const a = day.appointments[0];
  assert.equal(a.confirmedStatus, 'In Treatment Room');
  // A DefNum means different things in each practice's database (486 vs 451 for
  // the commlog type is the same trap). Not returning it is how nothing
  // downstream can compare one across offices.
  assert.equal(a.Confirmed, undefined);
  assert.equal(JSON.stringify(a).includes('244'), false);
});

// ── 3. errors are not empty days ────────────────────────────────────────────

test('a first-page appointments failure is NOT a day', async () => {
  const day = await odDay.readDay(
    fakeGet({
      '/appointments': { ok: false, status: 503, data: null, error: 'upstream unavailable' },
      '/operatories': [],
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  assert.equal(day.ok, false, 'the route must be able to refuse rather than render nothing');
  assert.match(day.error, /upstream unavailable/);
});

test('a LATER-page failure returns what was read, and says it is partial', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => appt(i));
  const routes = {
    '/appointments': page1,
    '/appointments?Offset=100': { ok: false, status: 500, data: null, error: 'boom' },
    '/operatories': [],
    '/appointmenttypes': [],
    '/providers': [],
  };
  for (const a of page1) routes['/patients/' + a.PatNum] = patient(a.PatNum);

  const day = await odDay.readDay(fakeGet(routes), { date: '2026-09-08', office: 'roland' });

  assert.equal(day.ok, true, 'a hundred real appointments beat an outage');
  assert.equal(day.appointments.length, 100);
  assert.ok(day.warnings.some((w) => w.resource === 'appointments' && /part of the day/i.test(w.message)));
});

test('losing chair NAMES does not lose the chairs', async () => {
  const day = await odDay.readDay(
    fakeGet({
      '/appointments': [appt(1, { Op: 5 })],
      '/operatories': { ok: false, status: 500, data: null, error: 'boom' },
      '/appointmenttypes': [],
      '/providers': [],
      '/patients/800001': patient(800001),
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  assert.equal(day.ok, true);
  assert.equal(day.appointments[0].opNum, 5, 'the chair is still known by number');
  assert.equal(day.appointments[0].opName, null, 'its name is honestly absent');
  assert.ok(day.warnings.some((w) => w.resource === 'operatories'));
});

// ── 4. what belongs on a day, and what does not ─────────────────────────────

test('broken / unscheduled / planned rows are excluded and COUNTED, not silently dropped', async () => {
  const rows = [
    appt(1),
    appt(2, { AptStatus: 'Broken' }),
    appt(3, { AptStatus: 'UnschedList' }),
    appt(4, { AptStatus: 'Planned' }),
    appt(5, { AptStatus: 'Complete' }),
  ];
  const routes = { '/appointments': rows, '/operatories': [], '/appointmenttypes': [], '/providers': [] };
  for (const a of rows) routes['/patients/' + a.PatNum] = patient(a.PatNum);

  const day = await odDay.readDay(fakeGet(routes), { date: '2026-09-08', office: 'roland' });

  assert.deepEqual(
    day.appointments.map((a) => a.aptNum).sort(),
    [900001, 900005],
    'Scheduled and Complete are the day; the rest are not visits'
  );
  assert.equal(day.excludedByStatus, 3, '"my 2pm is missing" must have an answer');
});

test('an UNRECOGNISED status is kept, not dropped', async () => {
  const rows = [appt(1, { AptStatus: 'SomeNewOdStatus' })];
  const day = await odDay.readDay(
    fakeGet({
      '/appointments': rows,
      '/operatories': [],
      '/appointmenttypes': [],
      '/providers': [],
      '/patients/800001': patient(800001),
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  // Open Dental can add a status. Losing a patient because this list is stale
  // is a worse failure than a card with an unfamiliar chip on it.
  assert.equal(day.appointments.length, 1);
  assert.equal(day.appointments[0].aptStatus, 'SomeNewOdStatus');
  assert.equal(day.excludedByStatus, 0);
});

test('the appointment flag and the CHAIR flag are both carried, because they can disagree', async () => {
  const day = await odDay.readDay(
    fakeGet({
      // A hygiene appointment sitting in a non-hygiene chair. The H0 spike found
      // these two can disagree; collapsing them makes one question unanswerable.
      '/appointments': [appt(1, { Op: 9, IsHygiene: true })],
      '/operatories': [{ OperatoryNum: 9, OpName: 'Doctor 1', ItemOrder: 4, IsHidden: 'false', IsHygiene: 'false' }],
      '/appointmenttypes': [],
      '/providers': [],
      '/patients/800001': patient(800001),
    }),
    { date: '2026-09-08', office: 'roland' }
  );

  assert.equal(day.appointments[0].isHygiene, true, "the APPOINTMENT's flag is authoritative");
  assert.equal(day.appointments[0].opIsHygiene, false, "the CHAIR's flag is a layout fact");
});

test('hidden operatories are dropped, and one with an UNKNOWN IsHidden is kept', async () => {
  const { operatories } = await odDay.readOperatories(
    fakeGet({
      '/operatories': [
        { OperatoryNum: 1, OpName: 'Hyg 1', ItemOrder: 2, IsHidden: 'false', IsHygiene: 'true' },
        { OperatoryNum: 2, OpName: 'Retired', ItemOrder: 1, IsHidden: 'true', IsHygiene: 'true' },
        // No IsHidden at all. Dropping this chair would drop every appointment
        // in it; an extra empty column is the cheaper mistake.
        { OperatoryNum: 3, OpName: 'Hyg 2', ItemOrder: 3, IsHygiene: 'true' },
      ],
    })
  );

  assert.deepEqual(operatories.map((o) => o.opNum), [1, 3]);
  assert.deepEqual(operatories.map((o) => o.itemOrder), [2, 3], "ordered by Open Dental's own ItemOrder");
});

test('the per-patient fan-out is deduplicated and bounded', async () => {
  // Same patient, three appointments. One read, not three.
  const rows = [appt(1), appt(2, { PatNum: 800001 }), appt(3, { PatNum: 800001 })];
  const routes = { '/appointments': rows, '/operatories': [], '/appointmenttypes': [], '/providers': [] };
  routes['/patients/800001'] = patient(800001);

  const get = fakeGet(routes);
  await odDay.readDay(get, { date: '2026-09-08', office: 'roland' });

  const patientCalls = get.calls.filter((c) => c.path.startsWith('/patients/'));
  assert.equal(patientCalls.length, 1, 'three appointments, one patient, one read');
});
