'use strict';

/**
 * CO-4a — the "Scheduled" appointment anchor.
 *
 *   picker     GET /api/tc/checkout/:id/appointments lists ONLY the stored
 *              patient's upcoming, booked (Scheduled) appointments, soonest
 *              first, from ONE /appointments request to the record's own
 *              office — AptNum, date/time, provider, type, operatory; no notes
 *   failure    a failed read is a 502 the picker can say, never an empty list;
 *              "Not in Open Dental yet" (Scheduled with no AptNum) still works
 *   anchor     Scheduled + a picked AptNum stores the anchor in the same action,
 *              re-read from OD first; audited as its own event; shown on the
 *              card and on the case's panel
 *   isolation  an AptNum from another office's Open Dental is never accepted
 *   later      "Link appointment" on a Scheduled card while its case is open;
 *              change and clear are audited; a closed case refuses
 *   old rows   a record with no anchor columns reads as unanchored
 *
 * Open Dental is faked on each office's REAL client (apiGetRaw patched), so the
 * calls show which database was asked. Test patients only (roland 12827,
 * valley 7115); names synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const { randomUUID } = require('node:crypto');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const odOffices = require('../../config/odOffices');
const odConfigCache = require('../../services/odConfigCache');
const checkoutRoute = require('./checkout');
const checkoutStore = require('./checkoutStore');
const contract = require('../../tc/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

// 2026-10-30 10:00 in America/Chicago.
const NOW = new Date('2026-10-30T15:00:00.000Z');
const TODAY = '2026-10-30';

const OD_KEY_ENV = { roland: 'OPENDENTAL_CUSTOMER_KEY', valley: 'OPENDENTAL_CUSTOMER_KEY_VALLEY' };
const savedEnv = {};

test.before(() => {
  for (const k of [...Object.values(OD_KEY_ENV), 'OPENDENTAL_ALLOW_MOCK']) savedEnv[k] = process.env[k];
  process.env[OD_KEY_ENV.roland] = 'test-roland-customer-key';
  process.env[OD_KEY_ENV.valley] = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
});
test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
});

/** An OD appointment row, as GET /appointments returns it. */
function apt(over) {
  return {
    AptNum: 5001,
    PatNum: 12827,
    AptStatus: 'Scheduled',
    AptDateTime: '2026-11-04 09:00:00',
    provAbbr: 'DOC1',
    AppointmentTypeNum: 3,
    Op: 4,
    ProcDescript: 'Crn',
    Note: 'Front desk note that must never leave Open Dental',
    ...over,
  };
}

/** What each office's Open Dental holds. */
const OD = {
  roland: {
    appointments: [
      apt({ AptNum: 5002, AptDateTime: '2026-11-10 14:30:00', AppointmentTypeNum: 0, ProcDescript: 'Comp', Op: 9 }),
      apt({ AptNum: 5001 }),
      apt({ AptNum: 4999, AptDateTime: '2026-10-01 09:00:00' }), // past
      apt({ AptNum: 5003, AptStatus: 'Broken' }),
      apt({ AptNum: 5004, AptStatus: 'Planned' }),
      apt({ AptNum: 5005, AptStatus: 'Complete', AptDateTime: '2026-10-30 08:00:00' }),
      apt({ AptNum: 5006, PatNum: 12828 }), // another patient
    ],
    types: [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Crown prep' }],
    ops: [{ OperatoryNum: 4, OpName: 'Op 4 - Doctor', Abbrev: 'D4', IsHidden: 'false', ItemOrder: 1 }],
  },
  valley: {
    appointments: [apt({ AptNum: 7001, PatNum: 7115, AptDateTime: '2026-11-05 10:00:00', provAbbr: 'DOC2', Op: 2 })],
    types: [],
    ops: [{ OperatoryNum: 2, OpName: 'Hyg 2', Abbrev: 'H2', IsHidden: 'false', ItemOrder: 1 }],
  },
};

/**
 * Patch each office's own client. `fail.appointments` makes that office's
 * appointment read fail. Every call is recorded with its office.
 */
async function withOd(fn, { fail = {} } = {}) {
  odConfigCache.resetOdConfigCache();
  const calls = [];
  const patched = [];
  for (const office of Object.keys(OD_KEY_ENV)) {
    const { client } = odOffices.getOdOffice(office);
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (path, params = {}) => {
      calls.push({ office, path, params });
      if (path === '/appointments') {
        if (fail[office]) return { ok: false, status: 500, data: null, error: 'boom' };
        // Open Dental's own filters, as documented: PatNum, AptStatus, dateStart.
        return {
          ok: true,
          status: 200,
          data: OD[office].appointments.filter(
            (a) =>
              a.PatNum === params.PatNum &&
              (!params.AptStatus || a.AptStatus === params.AptStatus) &&
              (!params.dateStart || a.AptDateTime.slice(0, 10) >= params.dateStart)
          ),
        };
      }
      if (path === '/appointmenttypes') return { ok: true, status: 200, data: OD[office].types };
      if (path === '/operatories') return { ok: true, status: 200, data: OD[office].ops };
      return { ok: false, status: 404, data: null, error: 'not a valid resource' };
    };
  }
  try {
    return await fn({ calls });
  } finally {
    for (const { client, original } of patched) client.apiGetRaw = original;
    odConfigCache.resetOdConfigCache();
  }
}

function switchCheckout(t) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' ? { key, value: { roland: true, valley: true }, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  checkoutRoute.setClockForTests(() => NOW);
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
    checkoutRoute.setClockForTests(null);
  });
}

async function boot(t, opts = { role: 'tc' }) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

/** A waiting checkout row, like a hygiene visit filed it (no CO-4a columns at all). */
function seed(db, over = {}) {
  const row = {
    handoff_id: randomUUID(),
    office_id: 'roland',
    source_key: `hyg-visit:${randomUUID()}:checkout`,
    od_patient_id: 12827,
    patient_name: 'Test 2, Stedi',
    provider: 'DOC1',
    provider_seen: 'HYG1',
    operatory: 'Hyg 1',
    visit_date: TODAY,
    payload: contract.emptyCheckoutSnapshot(),
    is_final: true,
    revision: 1,
    submitted_by: 'hygienist@carein.ai',
    updated_by: 'hygienist@carein.ai',
    status: 'open',
    source: 'hygiene',
    created_at: new Date(NOW.getTime() - 60000),
    updated_at: new Date(NOW.getTime() - 60000),
    ...over,
  };
  db.table('tc_checkout_handoffs').push(row);
  return row;
}

const URL = (id, office = 'roland') => `/api/tc/checkout/${id}/appointments?office=${office}`;
const OUTCOME = (id, office = 'roland') => `/api/tc/checkout/${id}/outcome?office=${office}`;
const LINK = (id, office = 'roland') => `/api/tc/checkout/${id}/appointment?office=${office}`;
const anchorAudits = (db) => auditRows(db).filter((a) => /^checkout_appointment_/.test(String(a.source_ref || '')));

// ── the picker ──────────────────────────────────────────────────────────────

test('picker: only the stored patient\'s upcoming, booked appointments, soonest first, from ONE request to the record\'s office', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  await withOd(async ({ calls }) => {
    const r = await api(baseUrl, 'GET', URL(row.handoff_id));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const parsed = contract.TcCheckoutAppointmentsResponse.parse(r.body);
    assert.deepEqual(parsed.appointments, [
      { aptNum: 5001, dateTime: '2026-11-04 09:00:00', provider: 'DOC1', appointmentType: 'Crown prep', operatory: 'Op 4 - Doctor' },
      { aptNum: 5002, dateTime: '2026-11-10 14:30:00', provider: 'DOC1', appointmentType: 'Comp', operatory: 'Op 9' },
    ]);
    // Exactly these five fields: no note, no PatNum, nothing else.
    for (const a of r.body.appointments) assert.deepEqual(Object.keys(a).sort(), ['appointmentType', 'aptNum', 'dateTime', 'operatory', 'provider']);
    assert.doesNotMatch(JSON.stringify(r.body), /Front desk note/);

    const aptCalls = calls.filter((c) => c.path === '/appointments');
    assert.equal(aptCalls.length, 1, 'one appointment request');
    assert.deepEqual(aptCalls[0], { office: 'roland', path: '/appointments', params: { PatNum: 12827, AptStatus: 'Scheduled', dateStart: TODAY } });
    assert.ok(calls.every((c) => c.office === 'roland'), "only roland's Open Dental");
  });
  const reads = auditRows(db).filter((a) => a.resource_type === 'od_appointment');
  assert.deepEqual(reads.map((a) => [a.action, a.resource_id, a.source_ref]), [['READ', '12827', `checkout:${row.handoff_id}`]]);
});

test('picker: the re-filter holds even when Open Dental ignores the filters (no broken, past, or other patient\'s rows)', async () => {
  const rows = [
    apt({ AptNum: 1, AptStatus: 'Broken' }),
    apt({ AptNum: 2, AptDateTime: '2026-10-29 16:00:00' }),
    apt({ AptNum: 3, PatNum: 99 }),
    apt({ AptNum: 4, AptDateTime: '0001-01-01 00:00:00' }),
    apt({ AptNum: 5, AptDateTime: `${TODAY} 16:00:00` }),
  ];
  const odReads = require('./odReads');
  const out = await odReads.listUpcomingAppointments(async () => ({ ok: true, status: 200, data: rows }), 12827, { from: TODAY });
  assert.deepEqual(out.map((a) => a.aptNum), [5], 'today counts as upcoming; nothing else survives');
});

test('picker: a failed read is a 502 with words the picker shows — never an empty list — and "Not in Open Dental yet" still works', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  await withOd(
    async () => {
      const r = await api(baseUrl, 'GET', URL(row.handoff_id));
      assert.equal(r.status, 502);
      assert.deepEqual([r.body.code, r.body.error], ['OD_APPOINTMENTS_UNAVAILABLE', "Couldn't load appointments from Open Dental"]);
      assert.equal(r.body.appointments, undefined);

      // Picking one while Open Dental is down records NOTHING...
      const picked = await api(baseUrl, 'POST', OUTCOME(row.handoff_id), { outcome: 'scheduled', aptNum: 5001 });
      assert.equal(picked.status, 502);
      assert.equal(db.table('tc_checkout_handoffs')[0].status, 'open');
      assert.equal(db.table('tc_cases').length, 0);

      // ...and "Not in Open Dental yet" answers Scheduled without asking it at all.
      const notYet = await api(baseUrl, 'POST', OUTCOME(row.handoff_id), { outcome: 'scheduled', aptNum: null });
      assert.equal(notYet.status, 200, JSON.stringify(notYet.body));
      assert.equal(notYet.body.handoff.status, 'scheduled');
      assert.equal(notYet.body.handoff.appointment, null);
    },
    { fail: { roland: true } }
  );
  assert.equal(anchorAudits(db).length, 0);
});

// ── the anchor ──────────────────────────────────────────────────────────────

test('anchor: Scheduled + a picked appointment stores the anchor in the same action, audited, shown on the card and the case panel', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  await withOd(async ({ calls }) => {
    const r = await api(baseUrl, 'POST', OUTCOME(row.handoff_id), { outcome: 'scheduled', aptNum: 5002 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const h = contract.TcCheckoutHandoff.parse(r.body.handoff);
    assert.equal(h.status, 'scheduled');
    assert.deepEqual(
      { ...h.appointment, linkedAt: typeof h.appointment.linkedAt },
      { aptNum: 5002, dateTime: '2026-11-10 14:30:00', provider: 'DOC1', appointmentType: 'Comp', operatory: 'Op 9', linkedBy: 'tc@carein.ai', linkedAt: 'string' }
    );
    assert.equal(contract.appointmentWhenLabel(h.appointment.dateTime), 'Tue, Nov 10, 2:30 PM');
    // Re-read from Open Dental for this request, the record's own office.
    assert.deepEqual(calls.filter((c) => c.path === '/appointments').map((c) => [c.office, c.params.PatNum]), [['roland', 12827]]);

    // Stored on the row, the row's office, and only on a Scheduled one.
    const [stored] = db.table('tc_checkout_handoffs');
    assert.deepEqual([stored.office_id, stored.appt_num, stored.appt_at_local, stored.appt_linked_by], ['roland', 5002, '2026-11-10 14:30:00', 'tc@carein.ai']);

    // Its own audit event, besides the outcome's.
    assert.deepEqual(anchorAudits(db).map((a) => [a.action, a.resource_id, a.source_ref, a.prior_state]), [
      ['UPDATE', row.handoff_id, 'checkout_appointment_link', 'unanchored'],
    ]);
    assert.ok(auditRows(db).some((a) => a.resource_type === 'tc_checkout_handoff' && a.prior_state === 'open' && !a.source_ref));

    // The case shows it: the case's checkout panel carries the anchor, and may relink.
    db.onQuery(/FROM tc_checkout_attestations/, () => ({ rows: [] }));
    const panel = await api(baseUrl, 'GET', `/api/tc/checkout/by-case/${h.caseId}?office=roland`);
    assert.equal(panel.status, 200, JSON.stringify(panel.body));
    const parsed = contract.TcCheckoutCaseTreatment.parse(panel.body);
    assert.equal(parsed.visits[0].handoff.appointment.aptNum, 5002);
    assert.equal(parsed.visits[0].canLinkAppointment, true);
  });
});

test('anchor: an AptNum that is not this patient\'s upcoming booked appointment is refused, and nothing is recorded', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  await withOd(async () => {
    for (const aptNum of [5003 /* broken */, 4999 /* past */, 5006 /* another patient */, 424242 /* made up */]) {
      const r = await api(baseUrl, 'POST', OUTCOME(row.handoff_id), { outcome: 'scheduled', aptNum });
      assert.equal(r.status, 409, `${aptNum}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.code, 'APPOINTMENT_NOT_UPCOMING');
    }
  });
  assert.equal(db.table('tc_checkout_handoffs')[0].status, 'open');
  assert.equal(db.table('tc_cases').length, 0);
  assert.equal(anchorAudits(db).length, 0);
});

test('anchor: only with Scheduled — an AptNum on Not scheduled / Nothing needed is a 400 that never asks Open Dental', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  await withOd(async ({ calls }) => {
    for (const outcome of ['not_scheduled', 'nothing_needed']) {
      const r = await api(baseUrl, 'POST', OUTCOME(row.handoff_id), { outcome, aptNum: 5001 });
      assert.equal(r.status, 400, outcome);
    }
    assert.deepEqual(calls, []);
  });
  assert.equal(db.table('tc_checkout_handoffs')[0].status, 'open');
});

// ── office isolation ────────────────────────────────────────────────────────

test('office isolation: a valley card reads only valley\'s Open Dental; roland\'s AptNum is never accepted; roland cannot reach the card', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db, { office_id: 'valley', od_patient_id: 7115, patient_name: 'TestValley, Stedi' });
  await withOd(async ({ calls }) => {
    const list = await api(baseUrl, 'GET', URL(row.handoff_id, 'valley'));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body.appointments.map((a) => a.aptNum), [7001]);

    // 5001 is a real, upcoming appointment — in ROLAND's database. Not this one.
    const cross = await api(baseUrl, 'POST', OUTCOME(row.handoff_id, 'valley'), { outcome: 'scheduled', aptNum: 5001 });
    assert.equal(cross.status, 409);
    assert.equal(cross.body.code, 'APPOINTMENT_NOT_UPCOMING');
    assert.ok(calls.every((c) => c.office === 'valley'), "roland's Open Dental is never asked");

    // The roland side cannot see the card at all.
    const fromRoland = await api(baseUrl, 'GET', URL(row.handoff_id, 'roland'));
    assert.equal(fromRoland.status, 404);

    const ok = await api(baseUrl, 'POST', OUTCOME(row.handoff_id, 'valley'), { outcome: 'scheduled', aptNum: 7001 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual([ok.body.handoff.officeId, ok.body.handoff.appointment.aptNum, ok.body.handoff.appointment.operatory], ['valley', 7001, 'Hyg 2']);
  });
});

// ── "Link appointment" later ────────────────────────────────────────────────

test('later: an unanchored Scheduled card links, changes and clears its appointment while the case is open — each audited', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const row = seed(db);
  await withOd(async () => {
    const notYet = await api(baseUrl, 'POST', OUTCOME(row.handoff_id), { outcome: 'scheduled' });
    assert.equal(notYet.status, 200, JSON.stringify(notYet.body));
    assert.equal(notYet.body.handoff.appointment, null, '"Not in Open Dental yet"');

    const list = await api(baseUrl, 'GET', URL(row.handoff_id));
    assert.equal(list.status, 200, 'the same picker, on a Scheduled card');

    const linked = await api(baseUrl, 'POST', LINK(row.handoff_id), { aptNum: 5001 });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.handoff.appointment.aptNum, 5001);

    const same = await api(baseUrl, 'POST', LINK(row.handoff_id), { aptNum: 5001 });
    assert.equal(same.body.unchanged, true);

    const changed = await api(baseUrl, 'POST', LINK(row.handoff_id), { aptNum: 5002 });
    assert.equal(changed.body.handoff.appointment.aptNum, 5002);

    const cleared = await api(baseUrl, 'POST', LINK(row.handoff_id), { aptNum: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.handoff.appointment, null);
    assert.equal(db.table('tc_checkout_handoffs')[0].appt_num, null);
  });
  assert.deepEqual(anchorAudits(db).map((a) => [a.source_ref, a.prior_state]), [
    ['checkout_appointment_link', 'unanchored'],
    ['checkout_appointment_link', 'anchored'],
    ['checkout_appointment_unlink', 'anchored'],
  ]);
});

test('later: refused on a card that is not Scheduled, and once the case is closed', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t);
  const waiting = seed(db);
  await withOd(async () => {
    const r = await api(baseUrl, 'POST', LINK(waiting.handoff_id), { aptNum: 5001 });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, 'CHECKOUT_NOT_SCHEDULED');

    const done = await api(baseUrl, 'POST', OUTCOME(waiting.handoff_id), { outcome: 'scheduled' });
    const caseRow = db.table('tc_cases').find((c) => c.case_id === done.body.caseId);
    // The case a Scheduled checkout makes sits AT `scheduled` and still takes a
    // link; one that is completed or lost no longer does.
    for (const status of ['completed', 'lost']) {
      caseRow.status = status;
      const late = await api(baseUrl, 'POST', LINK(waiting.handoff_id), { aptNum: 5001 });
      assert.equal(late.status, 409, status);
      assert.equal(late.body.code, 'CASE_NOT_OPEN');
    }
    caseRow.status = 'completed';
    const late = await api(baseUrl, 'POST', LINK(waiting.handoff_id), { aptNum: 5001 });
    assert.equal(late.status, 409);
    assert.equal(late.body.code, 'CASE_NOT_OPEN');

    // A Nothing-needed card has no picker at all.
    const other = seed(db, { od_patient_id: 12828, patient_name: 'Test, MangoTest' });
    await api(baseUrl, 'POST', OUTCOME(other.handoff_id), { outcome: 'nothing_needed' });
    const none = await api(baseUrl, 'GET', URL(other.handoff_id));
    assert.equal(none.status, 409);
  });
  assert.equal(anchorAudits(db).length, 0);
});

test('role gate: the picker and the link are tc.full — a hygienist is refused before Open Dental is asked', async (t) => {
  switchCheckout(t);
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const row = seed(db);
  await withOd(async ({ calls }) => {
    assert.equal((await api(baseUrl, 'GET', URL(row.handoff_id))).status, 403);
    assert.equal((await api(baseUrl, 'POST', LINK(row.handoff_id), { aptNum: 5001 })).status, 403);
    assert.deepEqual(calls, []);
  });
});

// ── old rows, and the CO-5a reopen ──────────────────────────────────────────

test('old cards: a record with no anchor columns reads as unanchored; a reopen (CO-5a) clears the anchor and keeps it in the history', () => {
  const old = seed(new (require('./tcTestUtils').FakeTenantDb)(), { status: 'scheduled', outcome_by: 'tc@carein.ai', outcome_at: NOW });
  const h = contract.TcCheckoutHandoff.parse(checkoutStore.toHandoff(old));
  assert.equal(h.appointment, null);
  const { appointment, ...legacy } = h;
  assert.equal(contract.TcCheckoutHandoff.parse(legacy).appointment, null, 'a reader that predates the field defaults it too');
  assert.equal(appointment, null);
});

test('reopen (CO-5a) on an anchored Scheduled card: the anchor is cleared with the outcome and kept in the history', async () => {
  const calls = [];
  const q = { query: async (sql, params) => (calls.push({ sql, params }), { rowCount: 1, rows: [] }) };
  const row = {
    status: 'scheduled',
    outcome_by: 'tc@carein.ai',
    outcome_at: NOW,
    appt_num: 5001,
    appt_at_local: '2026-11-04 09:00:00',
    appt_snapshot: { provider: 'DOC1', appointmentType: 'Crown prep', operatory: 'Op 4 - Doctor' },
    appt_linked_by: 'tc@carein.ai',
    appt_linked_at: NOW,
  };
  const history = await checkoutStore.reopenAnswered(q, { office: 'roland', handoffId: randomUUID(), row, at: NOW.toISOString() });
  assert.equal(history.appointment.aptNum, 5001);
  assert.match(calls[0].sql, /appt_num = \$11, appt_at_local = \$12, appt_snapshot = \$13, appt_linked_by = \$14, appt_linked_at = \$15/);
  assert.deepEqual(calls[0].params.slice(10), [null, null, null, null, null]);
});
