'use strict';

/**
 * CO-5b — checkout cards from TODAY'S SCHEDULE.
 *
 *   lane       only a Complete appointment Open Dental marks NOT hygiene makes a
 *              card; hygiene AND unknown (null, missing, unparseable) are
 *              skipped; not-Complete, not-today, blockout / unattached
 *              (PatNum 0) rows are skipped
 *   dedupe     never a second card: not beside a hygiene card, a manual card,
 *              or an earlier schedule card; a DISMISSED schedule card is not
 *              re-made; two racing sweeps make one (the unique index, emulated)
 *   merge      a hygiene handoff arriving later merges onto the schedule card
 *   switch     OFF (either switch, or env=false over a stored true) = zero
 *              Open Dental reads, zero rows, zero audit rows — with completed
 *              appointments present
 *   window     one /appointments read per office per 60 s window, however
 *              often the page asks; Sync now forces one; every request paced
 *              ≥ 1200 ms with a timeout
 *   cap        at most TC_AUTO_CHECKOUT_MAX_PER_SWEEP cards per sweep; the rest
 *              come on the next; an unnamed patient waits (never "Unknown")
 *   honesty    a failed read → status `failed` with the last success kept, no
 *              card; `pending` before any read finishes
 *   trail      one CREATE audit row per card, as the system, source_ref
 *              apt_num:<AptNum>; the card stores its appointment
 *   isolation  each office reads only its own Open Dental; the same AptNum in
 *              the other office is a different appointment
 *
 * Open Dental is faked on each office's REAL client (apiGetRaw patched), so
 * the calls show which database was asked. Test patients only (roland 12827 /
 * 12828, valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { before, after, beforeEach, afterEach } = test;
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const tcAutoCheckout = require('../../config/tcAutoCheckout');
const tcOdSync = require('../../config/tcOdSync');
const odOffices = require('../../config/odOffices');
const odConfigCache = require('../../services/odConfigCache');
const odPatientCache = require('../../services/odPatientCache');
const engine = require('../../services/tc/autoCheckout');
const checkoutRoute = require('./checkout');
const odSyncRoute = require('./odSync');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows, FakeTenantDb } = require('./tcTestUtils');

// 2026-10-30 10:00 in America/Chicago.
const NOW = new Date('2026-10-30T15:00:00.000Z');
const TODAY = '2026-10-30';

const PATIENTS = {
  roland: {
    12827: { PatNum: 12827, LName: 'Test 2', FName: 'Stedi' },
    12828: { PatNum: 12828, LName: 'Test', FName: 'MangoTest' },
  },
  valley: {
    7115: { PatNum: 7115, LName: 'TestValley', FName: 'Stedi' },
  },
};

const LABELS = {
  '/appointmenttypes': [{ AppointmentTypeNum: 7, AppointmentTypeName: 'Crown Prep' }],
  '/providers': [{ ProvNum: 1, Abbr: 'DOC1' }],
  '/operatories': [{ OperatoryNum: 3, OpName: 'Op 3', IsHidden: false, ItemOrder: 1 }],
};

/** A day-list appointment, as GET /appointments?date= returns it. */
function apt(over) {
  return {
    AptNum: 5001,
    PatNum: 12827,
    AptStatus: 'Complete',
    IsHygiene: false,
    AptDateTime: `${TODAY} 09:00:00`,
    ProvNum: 1,
    Op: 3,
    AppointmentTypeNum: 7,
    Note: 'never leaves OD',
    ...over,
  };
}

const ENV = [
  'OPENDENTAL_CUSTOMER_KEY',
  'OPENDENTAL_CUSTOMER_KEY_VALLEY',
  'OPENDENTAL_ALLOW_MOCK',
  'TC_AUTO_CHECKOUT_ENABLED_ROLAND',
  'TC_AUTO_CHECKOUT_ENABLED_VALLEY',
  'TC_AUTO_CHECKOUT_MAX_PER_SWEEP',
  'TC_OD_SYNC_ENABLED_ROLAND',
];
const savedEnv = {};
let savedGetPlatformSetting;

/** What each office's Open Dental holds, and every call it was asked. */
let od;
let calls;
let patched = [];

before(() => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-roland-customer-key';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
  savedGetPlatformSetting = registry.getPlatformSetting;
});

after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  registry.getPlatformSetting = savedGetPlatformSetting;
  odOffices.resetOdOfficeCache();
  tcCheckout.resetCacheForTests();
  tcAutoCheckout.resetCacheForTests();
  tcOdSync.resetCacheForTests();
});

beforeEach(() => {
  for (const k of ENV.slice(3)) delete process.env[k];
  od = { roland: { schedule: [], failSchedule: false }, valley: { schedule: [], failSchedule: false } };
  calls = [];
  engine.resetForTests();
  odConfigCache.resetOdConfigCache();
  odPatientCache.resetOdPatientCache();
  checkoutRoute.setClockForTests(() => NOW);
  engine.setNowForTests(() => NOW.getTime());
  patched = [];
  for (const office of ['roland', 'valley']) {
    const { client } = odOffices.getOdOffice(office);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (p, params = {}, opts = {}) => {
      calls.push({ office, path: p, params, opts });
      if (p === '/appointments') {
        if (od[office].failSchedule) return { ok: false, status: 500, data: null, error: 'boom' };
        return { ok: true, status: 200, data: od[office].schedule.filter((r) => String(r.AptDateTime).startsWith(params.date)) };
      }
      if (LABELS[p]) return { ok: true, status: 200, data: LABELS[p] };
      const m = /^\/patients\/(\d+)$/.exec(p);
      const row = m ? PATIENTS[office][m[1]] : null;
      return row ? { ok: true, status: 200, data: row } : { ok: false, status: 404, data: null, error: 'not found' };
    };
  }
});

afterEach(async () => {
  await engine.waitForSweepsForTests();
  for (const { client, original } of patched) client.apiGetRaw = original;
  checkoutRoute.setClockForTests(null);
  engine.resetForTests();
});

/**
 * The control plane's rows: checkout on (both offices by default) and the
 * auto-checkout switch as given. No row for a key => the env fallback, then OFF.
 */
function switches(t, { auto = { roland: true }, checkout = { roland: true, valley: true }, odSync = null } = {}) {
  const rows = { tc_checkout_enabled: checkout, tc_auto_checkout_enabled: auto, tc_od_sync_enabled: odSync };
  registry.getPlatformSetting = async (key) =>
    rows[key] ? { key, value: rows[key], updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  tcAutoCheckout.resetCacheForTests();
  tcOdSync.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = savedGetPlatformSetting;
    tcCheckout.resetCacheForTests();
    tcAutoCheckout.resetCacheForTests();
    tcOdSync.resetCacheForTests();
  });
}

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

const CHECK = (office = 'roland') => `/api/tc/checkout/schedule-check?office=${office}`;

/** Ask the Checkout page's question and wait for the sweep it started. */
async function check(baseUrl, office = 'roland') {
  const first = await api(baseUrl, 'GET', CHECK(office));
  await engine.waitForSweepsForTests();
  return first;
}

/** The status after the sweep, without starting another. */
function status(office = 'roland') {
  return engine.statusOf(office, true);
}

const handoffs = (db) => db.table('tc_checkout_handoffs');
const scheduleCards = (db) => handoffs(db).filter((r) => r.source === 'schedule');
const scheduleAudits = (db) => auditRows(db).filter((a) => /^apt_num:/.test(String(a.source_ref || '')));
const scheduleReads = (office) => calls.filter((c) => c.office === office && c.path === '/appointments');

/**
 * The partial unique index the migration creates —
 * UNIQUE (office_id, origin_apt_num) WHERE origin_apt_num IS NOT NULL — on the
 * fake, which has none. Returns the count of inserts it refused.
 */
function emulateOriginIndex(db) {
  const refused = { count: 0 };
  db.onQuery(/^INSERT INTO tc_checkout_handoffs \(/, (text, params) => {
    const cols = text.match(/^INSERT INTO tc_checkout_handoffs \(([^)]+)\)/)[1].split(',').map((s) => s.trim());
    const row = {};
    cols.forEach((c, i) => {
      row[c] = c === 'payload' && typeof params[i] === 'string' ? JSON.parse(params[i]) : params[i];
    });
    if (
      row.origin_apt_num != null &&
      handoffs(db).some((r) => r.office_id === row.office_id && r.origin_apt_num === row.origin_apt_num)
    ) {
      refused.count += 1;
      const err = new Error('duplicate key value violates unique constraint "tc_checkout_handoffs_origin_apt_key"');
      err.code = '23505';
      throw err;
    }
    row.created_at = new Date();
    row.updated_at = new Date();
    handoffs(db).push(row);
    return { rows: [], rowCount: 1 };
  });
  return refused;
}

/** A hygiene checkout handoff, as the visit Send files it. */
function hygieneSubmit(over = {}) {
  return {
    kind: 'checkout',
    sourceKey: `hyg-visit:${randomUUID()}:checkout`,
    final: false,
    patientName: 'Test 2, Stedi',
    odPatientId: 12827,
    provider: 'HYG1',
    providerSeen: 'DOC1',
    operatory: 'Hyg 1',
    visitDate: TODAY,
    snapshot: {
      procedures: [
        { teeth: [3], code: 'Crown', category: 'Restorative', priority: 'urgent', status: 'proposed', surfaces: ['O'], scheduleNext: false, note: '' },
      ],
      priority: 'urgent',
      nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: false, rtc: '6 mo' },
      notesPending: true,
      frontDeskNote: '',
      financialNote: '',
      collectAtCheckout: [],
    },
    ...over,
  };
}

// ── 1. The lane: what makes a card ──────────────────────────────────────────

test('a Complete non-hygiene appointment makes ONE Waiting card: named from THIS office, its appointment kept, audited with the AptNum', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });

  const first = await check(baseUrl);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const parsed = contract.TcCheckoutScheduleCheck.parse(first.body);
  assert.equal(parsed.running, true, 'the first ask starts the read and answers at once');

  const cards = scheduleCards(db);
  assert.equal(cards.length, 1);
  const h = contract.TcCheckoutHandoff.parse(
    (await api(baseUrl, 'GET', '/api/tc/checkout?office=roland&view=waiting')).body.handoffs[0]
  );
  assert.deepEqual(
    [h.source, h.status, h.officeId, h.odPatientId, h.patientName, h.visitDate, h.submittedBy, h.hygieneMergedAt],
    ['schedule', 'open', 'roland', 12827, 'Test 2, Stedi', TODAY, 'system:auto_checkout', null]
  );
  assert.deepEqual(h.scheduleAppointment, {
    aptNum: 5001,
    dateTime: `${TODAY} 09:00:00`,
    appointmentType: 'Crown Prep',
    provider: 'DOC1',
    operatory: 'Op 3',
  });
  assert.equal(h.providerSeen, 'DOC1');
  assert.deepEqual(h.snapshot, contract.emptyCheckoutSnapshot(), 'no hygiene data is invented');
  assert.equal(contract.checkoutHasHygieneData(h), false);
  assert.equal(cards[0].origin_apt_num, 5001);
  assert.ok(!JSON.stringify(cards[0]).includes('never leaves OD'), 'the appointment note is never copied');

  const audits = scheduleAudits(db);
  assert.equal(audits.length, 1);
  assert.deepEqual(
    [audits[0].action, audits[0].resource_type, audits[0].resource_id, audits[0].office, audits[0].source_ref, audits[0].user_id],
    ['CREATE', 'tc_checkout_handoff', cards[0].handoff_id, 'roland', 'apt_num:5001', 'system:auto_checkout']
  );

  const after = contract.TcCheckoutScheduleCheck.parse((await api(baseUrl, 'GET', CHECK())).body);
  assert.equal(after.status, 'ok');
  assert.equal(after.running, false, 'inside the window: no second read');
  assert.equal(after.summary.created, 1);
  assert.ok(calls.every((c) => c.office === 'roland'), "only roland's Open Dental was asked");
});

test('hygiene AND unknown appointments are skipped — the appointment\'s own flag, never the chair\'s', async (t) => {
  switches(t);
  od.roland.schedule = [
    apt({ AptNum: 5001, PatNum: 12827, IsHygiene: true }),
    apt({ AptNum: 5002, PatNum: 12827, IsHygiene: null }),
    apt({ AptNum: 5003, PatNum: 12827, IsHygiene: undefined }),
    apt({ AptNum: 5004, PatNum: 12827, IsHygiene: 'true' }),
    apt({ AptNum: 5005, PatNum: 12827, IsHygiene: 'maybe' }),
    // Not hygiene, in a hygiene CHAIR: the appointment's flag decides.
    apt({ AptNum: 5006, PatNum: 12828, IsHygiene: 'false', Op: 9 }),
  ];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.deepEqual(scheduleCards(db).map((r) => r.origin_apt_num), [5006]);
  assert.equal(status().summary.skippedHygiene, 5);
  // No patient read was spent on a hygiene appointment's patient.
  assert.deepEqual(calls.filter((c) => /^\/patients\//.test(c.path)).map((c) => c.path), ['/patients/12828']);
});

test('only Complete, only today, only a real patient: blockouts and unattached rows (PatNum 0) are skipped', async (t) => {
  switches(t);
  od.roland.schedule = [
    apt({ AptNum: 5001, AptStatus: 'Scheduled' }),
    apt({ AptNum: 5002, AptStatus: 'Broken' }),
    apt({ AptNum: 5003, PatNum: 0 }),
    apt({ AptNum: 5004, PatNum: null }),
    apt({ AptNum: 0, PatNum: 12828 }),
  ];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.equal(handoffs(db).length, 0);
  assert.equal(status().summary.skippedNoPatient, 3);
  assert.equal(calls.filter((c) => /^\/patients\//.test(c.path)).length, 0, 'nobody to name, so nobody is read');

  // classify() also refuses a row from another day, whatever the list returned.
  const out = engine.classify([apt({ AptDateTime: '2026-10-29 09:00:00' })], TODAY);
  assert.equal(out.candidates.length, 0);
});

// ── 2. Dedupe ───────────────────────────────────────────────────────────────

test('dedupe: never beside a hygiene card for the same patient today', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const hyg = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', hygieneSubmit());
  assert.equal(hyg.status, 201, JSON.stringify(hyg.body));
  await check(baseUrl);
  assert.equal(handoffs(db).length, 1, 'still only the hygiene card');
  assert.equal(scheduleCards(db).length, 0);
  assert.equal(status().summary.alreadyCarded, 1);
  assert.equal(scheduleAudits(db).length, 0);
});

test('dedupe: never beside a manual card for the same patient today', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const added = await api(baseUrl, 'POST', '/api/tc/checkout/manual?office=roland', { patNum: 12827 });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  await check(baseUrl);
  assert.equal(handoffs(db).length, 1);
  assert.equal(handoffs(db)[0].source, 'manual');
});

test('dedupe: an earlier schedule card — and a DISMISSED one — is never re-made', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.equal(scheduleCards(db).length, 1);

  // Next window: the same appointment does not make a second card.
  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  assert.equal(scheduleCards(db).length, 1);

  // The desk dismisses it; a later sweep must not put it back.
  const id = scheduleCards(db)[0].handoff_id;
  const dismissed = await api(baseUrl, 'POST', `/api/tc/checkout/${id}/dismiss?office=roland`, { reason: 'Doctor saw them already' });
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  engine.setNowForTests(() => NOW.getTime() + 122_000);
  await check(baseUrl);
  assert.equal(scheduleCards(db).length, 1);
  assert.equal(scheduleCards(db)[0].status, 'dismissed');
  assert.equal(scheduleAudits(db).length, 1, 'one card, one creation, ever');
});

test('dedupe: a patient with two completed appointments today gets one card', async (t) => {
  switches(t);
  od.roland.schedule = [apt({ AptNum: 5001 }), apt({ AptNum: 5002, AptDateTime: `${TODAY} 13:00:00` })];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.deepEqual(scheduleCards(db).map((r) => r.origin_apt_num), [5001], 'the earlier appointment makes it');
  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  assert.equal(scheduleCards(db).length, 1, 'the second appointment finds the patient carded');
});

test('dedupe: two sweeps racing on one appointment make ONE card (the unique index is the arbiter)', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const db = new FakeTenantDb();
  const refused = emulateOriginIndex(db);
  const audits = [];
  const run = () =>
    engine.sweepOffice({ office: 'roland', today: TODAY, pool: db, audit: async (e) => audits.push(e) });
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(scheduleCards(db).length, 1);
  assert.equal(a.summary.created + b.summary.created, 1);
  assert.ok(refused.count <= 1);
  assert.equal(audits.length, 1);
});

// ── 3. Merge ────────────────────────────────────────────────────────────────

test('merge: a hygiene handoff that arrives later merges onto the schedule card (same id, the visit\'s data, the appointment kept)', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  const [card] = scheduleCards(db);

  const sent = await api(baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', hygieneSubmit());
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const merged = contract.TcCheckoutHandoff.parse(sent.body.handoff);
  assert.equal(merged.handoffId, card.handoff_id);
  assert.equal(merged.source, 'schedule');
  assert.ok(merged.hygieneMergedAt);
  assert.equal(merged.snapshot.procedures.length, 1);
  assert.equal(contract.checkoutHasHygieneData(merged), true);
  assert.equal(merged.scheduleAppointment.aptNum, 5001, 'the card still knows where it came from');
  assert.equal(handoffs(db).length, 1);

  // And the next sweep does not re-make a card from the same appointment.
  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  assert.equal(handoffs(db).length, 1);
});

// ── 4. The switch ───────────────────────────────────────────────────────────

test('switch OFF = zero activity: no Open Dental read, no row, no audit row — with completed appointments present', async (t) => {
  switches(t, { auto: null });
  od.roland.schedule = [apt({})];
  od.valley.schedule = [apt({ PatNum: 7115 })];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const r = await check(baseUrl);
  const parsed = contract.TcCheckoutScheduleCheck.parse(r.body);
  assert.deepEqual([parsed.status, parsed.running, parsed.lastSuccessAt, parsed.summary], ['off', false, null, null]);
  await check(baseUrl, 'valley');
  assert.equal(calls.length, 0);
  assert.equal(handoffs(db).length, 0);
  assert.equal(scheduleAudits(db).length, 0);

  // Called directly, the engine refuses too.
  const direct = await engine.sweepOffice({ office: 'roland', today: TODAY, pool: db, audit: async () => assert.fail('no audit') });
  assert.equal(direct.status, 'off');
  assert.equal(calls.length, 0);
});

test('switch: env =false beats a stored true (break-glass), and checkout OFF keeps it off too', async (t) => {
  od.roland.schedule = [apt({})];
  {
    switches(t, { auto: { roland: true } });
    process.env.TC_AUTO_CHECKOUT_ENABLED_ROLAND = 'false';
    tcAutoCheckout.resetCacheForTests();
    const db = new FakeTenantDb();
    const out = await engine.sweepOffice({ office: 'roland', today: TODAY, pool: db, audit: async () => {} });
    assert.equal(out.status, 'off');
    delete process.env.TC_AUTO_CHECKOUT_ENABLED_ROLAND;
  }
  {
    switches(t, { auto: { roland: true }, checkout: { roland: false } });
    const db = new FakeTenantDb();
    const out = await engine.sweepOffice({ office: 'roland', today: TODAY, pool: db, audit: async () => {} });
    assert.equal(out.status, 'off');
  }
  assert.equal(calls.length, 0);
});

// ── 5. The window, Sync now, pacing ─────────────────────────────────────────

test('cache window: one schedule read per office per 60 s, however often the page asks', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl } = await boot(t, { role: 'tc' });
  for (let i = 0; i < 5; i += 1) await check(baseUrl);
  assert.equal(scheduleReads('roland').length, 1);

  engine.setNowForTests(() => NOW.getTime() + 59_000);
  await check(baseUrl);
  assert.equal(scheduleReads('roland').length, 1, 'still inside the window');

  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  await check(baseUrl);
  assert.equal(scheduleReads('roland').length, 2, 'one more read once the window passed');

  // Concurrent asks share ONE read.
  engine.setNowForTests(() => NOW.getTime() + 200_000);
  await Promise.all([api(baseUrl, 'GET', CHECK()), api(baseUrl, 'GET', CHECK()), api(baseUrl, 'GET', CHECK())]);
  await engine.waitForSweepsForTests();
  assert.equal(scheduleReads('roland').length, 3);
});

test('every Open Dental request the sweep makes is paced (≥ 1200 ms) and has a timeout', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    assert.ok(c.opts.minIntervalMs >= 1200, `${c.path} paced`);
    assert.ok(c.opts.timeoutMs > 0, `${c.path} timed`);
    assert.equal(c.opts.module, 'tc');
  }
});

test('Sync now forces a schedule read inside the window (and says so)', async (t) => {
  switches(t, { odSync: { roland: true } });
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.equal(scheduleReads('roland').length, 1);
  od.roland.schedule.push(apt({ AptNum: 5002, PatNum: 12828 }));

  const r = await api(baseUrl, 'POST', '/api/tc/od-sync/run?office=roland');
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.scheduleCheck, 'started');
  await odSyncRoute.waitForRunsForTests();
  await engine.waitForSweepsForTests();
  assert.equal(scheduleReads('roland').length, 2);
  assert.deepEqual(scheduleCards(db).map((c) => c.origin_apt_num).sort(), [5001, 5002]);
});

test('Sync now with the schedule switch off reads no schedule', async (t) => {
  switches(t, { auto: null, odSync: { roland: true } });
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  const r = await api(baseUrl, 'POST', '/api/tc/od-sync/run?office=roland');
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.equal(r.body.scheduleCheck, 'off');
  await odSyncRoute.waitForRunsForTests();
  await engine.waitForSweepsForTests();
  assert.equal(scheduleReads('roland').length, 0);
  assert.equal(scheduleCards(db).length, 0);
});

// ── 6. The cap, rotation, an unnamed patient ────────────────────────────────

test('cap: at most TC_AUTO_CHECKOUT_MAX_PER_SWEEP cards per sweep; the rest come on the next', async (t) => {
  switches(t);
  process.env.TC_AUTO_CHECKOUT_MAX_PER_SWEEP = '1';
  od.roland.schedule = [apt({ AptNum: 5001, PatNum: 12827 }), apt({ AptNum: 5002, PatNum: 12828, AptDateTime: `${TODAY} 10:00:00` })];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.deepEqual(scheduleCards(db).map((c) => c.origin_apt_num), [5001]);
  assert.equal(status().summary.deferred, 1);
  assert.equal(calls.filter((c) => /^\/patients\//.test(c.path)).length, 1, 'only the capped patient was named');

  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  assert.deepEqual(scheduleCards(db).map((c) => c.origin_apt_num), [5001, 5002]);
});

test('an unnamed patient makes NO card ("Unknown" is never written) and goes to the back of the queue', async (t) => {
  switches(t);
  process.env.TC_AUTO_CHECKOUT_MAX_PER_SWEEP = '1';
  // 99999 has no record in roland's Open Dental.
  od.roland.schedule = [apt({ AptNum: 5001, PatNum: 99999 }), apt({ AptNum: 5002, PatNum: 12828, AptDateTime: `${TODAY} 10:00:00` })];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl);
  assert.equal(scheduleCards(db).length, 0);
  assert.equal(status().summary.deferred, 2);

  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  assert.deepEqual(scheduleCards(db).map((c) => c.origin_apt_num), [5002], 'the unreadable one did not hold the front');
});

// ── 7. Honest failure ───────────────────────────────────────────────────────

test('a failed schedule read: status failed, the last success kept, no card — never a silent stale list', async (t) => {
  switches(t);
  od.roland.schedule = [apt({})];
  const { baseUrl, db } = await boot(t, { role: 'tc' });

  assert.equal(status().status, 'pending', 'before any read finishes it is pending, not ok');

  await check(baseUrl);
  const okAt = status().lastSuccessAt;
  assert.ok(okAt);

  od.roland.failSchedule = true;
  od.roland.schedule.push(apt({ AptNum: 5002, PatNum: 12828 }));
  engine.setNowForTests(() => NOW.getTime() + 61_000);
  await check(baseUrl);
  const r = contract.TcCheckoutScheduleCheck.parse((await api(baseUrl, 'GET', CHECK())).body);
  assert.equal(r.status, 'failed');
  assert.equal(r.lastSuccessAt, okAt, 'the last SUCCESS, not the last attempt');
  assert.notEqual(r.lastAttemptAt, okAt);
  assert.equal(scheduleCards(db).length, 1, 'nothing made from a failed read');

  // A later good read clears it.
  od.roland.failSchedule = false;
  engine.setNowForTests(() => NOW.getTime() + 122_000);
  await check(baseUrl);
  assert.equal(status().status, 'ok');
  assert.equal(scheduleCards(db).length, 2);
});

test('an office whose Open Dental is not connected fails honestly (no fallback to the other office)', async (t) => {
  switches(t, { auto: { valley: true } });
  od.valley.schedule = [apt({ PatNum: 7115 })];
  const saved = process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
  odOffices.resetOdOfficeCache();
  t.after(() => {
    process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = saved;
    odOffices.resetOdOfficeCache();
  });
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl, 'valley');
  assert.equal(engine.statusOf('valley', true).status, 'failed');
  assert.equal(calls.length, 0, "roland's Open Dental is never asked for valley");
  assert.equal(handoffs(db).length, 0);
});

test('a failed audit write leaves no card behind (the audit is inside the transaction)', async () => {
  // The fake does not roll back, so this pins the ORDER: the audit is written
  // before the transaction commits, and its failure aborts the sweep.
  const db = new FakeTenantDb();
  const statements = [];
  const origConnect = db.connect.bind(db);
  db.connect = async () => {
    const c = await origConnect();
    return { ...c, query: (sql, params) => (statements.push(String(sql).split(/\s+/)[0]), c.query(sql, params)) };
  };
  od.roland.schedule = [apt({})];
  process.env.TC_AUTO_CHECKOUT_ENABLED_ROLAND = 'true';
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  tcAutoCheckout.resetCacheForTests();
  try {
    await assert.rejects(
      engine.sweepOffice({
        office: 'roland',
        today: TODAY,
        pool: db,
        audit: async () => {
          throw new Error('audit store down');
        },
      }),
      /audit store down/
    );
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.ok(!statements.includes('COMMIT'));
  } finally {
    registry.getPlatformSetting = savedGetPlatformSetting;
    tcCheckout.resetCacheForTests();
    tcAutoCheckout.resetCacheForTests();
  }
});

// ── 8. Office isolation ─────────────────────────────────────────────────────

test('office isolation: each office reads only its own Open Dental; the same AptNum in both is two appointments', async (t) => {
  switches(t, { auto: { roland: true, valley: true } });
  od.roland.schedule = [apt({ AptNum: 5001, PatNum: 12827 })];
  od.valley.schedule = [apt({ AptNum: 5001, PatNum: 7115 })];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl, 'roland');
  assert.ok(calls.every((c) => c.office === 'roland'));
  await check(baseUrl, 'valley');
  const cards = scheduleCards(db).map((c) => [c.office_id, c.origin_apt_num, c.od_patient_id, c.patient_name]);
  assert.deepEqual(cards, [
    ['roland', 5001, 12827, 'Test 2, Stedi'],
    ['valley', 5001, 7115, 'TestValley, Stedi'],
  ]);
  assert.ok(calls.filter((c) => c.office === 'valley').every((c) => c.path !== '/patients/12827'));
  assert.ok(calls.filter((c) => c.office === 'roland').every((c) => c.path !== '/patients/7115'));
});

test('office isolation: valley switched off reads nothing while roland runs', async (t) => {
  switches(t, { auto: { roland: true, valley: false } });
  od.roland.schedule = [apt({})];
  od.valley.schedule = [apt({ PatNum: 7115 })];
  const { baseUrl, db } = await boot(t, { role: 'tc' });
  await check(baseUrl, 'roland');
  await check(baseUrl, 'valley');
  assert.equal(calls.filter((c) => c.office === 'valley').length, 0);
  assert.deepEqual(scheduleCards(db).map((c) => c.office_id), ['roland']);
});

// ── 9. Gates ────────────────────────────────────────────────────────────────

test('schedule-check: checkout off answers CHECKOUT_DISABLED and reads nothing; a non-TC role is refused', async (t) => {
  switches(t, { checkout: { roland: false } });
  od.roland.schedule = [apt({})];
  {
    const { baseUrl } = await boot(t, { role: 'tc' });
    const r = await api(baseUrl, 'GET', CHECK());
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'CHECKOUT_DISABLED');
  }
  switches(t);
  {
    const { baseUrl } = await boot(t, { role: 'hygienist' });
    const r = await api(baseUrl, 'GET', CHECK());
    assert.equal(r.status, 403);
  }
  await engine.waitForSweepsForTests();
  assert.equal(calls.length, 0);
});

test('an old record with no source still reads as hygiene; a schedule card reads as schedule', () => {
  const store = require('./checkoutStore');
  const base = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    visit_date: TODAY,
    payload: contract.emptyCheckoutSnapshot(),
    is_final: false,
    revision: 1,
    submitted_by: 'x',
    created_at: NOW,
    updated_at: NOW,
  };
  assert.equal(store.toHandoff({ ...base, source: null }).source, 'hygiene');
  assert.equal(store.toHandoff({ ...base, source: null }).scheduleAppointment, null);
  const s = store.toHandoff({
    ...base,
    source: 'schedule',
    origin_apt_num: '5001',
    origin_appt: JSON.stringify({ dateTime: `${TODAY} 09:00:00`, appointmentType: 'Crown Prep', provider: 'DOC1', operatory: 'Op 3' }),
  });
  assert.equal(s.source, 'schedule');
  assert.equal(s.scheduleAppointment.aptNum, 5001);
  contract.TcCheckoutHandoff.parse(s);
});
