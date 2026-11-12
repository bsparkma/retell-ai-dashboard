'use strict';

/**
 * "Prescriptions needed" + "Pharmacy" on a hygiene visit (Beau's ruling:
 * IN-APP ONLY), and the chairside referral-template read.
 *
 *   - save / load, read back, audited; bounds and the single-line pharmacy
 *     refused 400; a body cannot name an office or a PatNum
 *   - CROSS-OFFICE: another office's request for the same appointment number
 *     is a 404 and reads nothing; a visit not yet opened is a 404
 *   - the checkout handoff carries them (shown on the checkout card), and
 *     carries NOTHING new when both are blank
 *   - THE PIN: a full visit — note and router staged, previewed and SENT —
 *     with both fields filled: neither value appears in the visit as served,
 *     in any staged write's preview / payload / summary, in the composer's
 *     output, or in any Open Dental request at all
 *   - the chairside template read is the office's, never the other's
 *
 * The hyg suite's database is a fake; the one statement this feature adds
 * (`UPDATE hyg_visit SET rx_needed ...`) is answered here, and TC's referral
 * SQL goes to the TC fake — the CompositeDb shape hygReferral.test.js uses, so
 * no shared test utility is edited.
 *
 * Test patients only: roland 12827 ("Test 2, Stedi").
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const tcReferrals = require('../../config/tcReferrals');
const composer = require('../../services/hyg/stagedWriteComposer');
const { FakeOd, FakeHygDb, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const { FakeTenantDb } = require('../tc/tcTestUtils');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const RX = (office = 'roland') => `/api/hyg/visit/900001/prescriptions?office=${office}`;
const HANDOFF_ID = '5d2a7e10-0000-4000-8000-0000000000d1';

// Distinctive, so a hit anywhere is unambiguous.
const RX_TEXT = 'RXPIN Amoxicillin 2 g premed\nRXPIN-LINE2 one hour before';
const PHARMACY_TEXT = 'PHARMPIN Corner Drug, Main St';
const NEEDLES = ['RXPIN', 'PHARMPIN', 'Amoxicillin', 'Corner Drug'];

const CROWN = {
  teeth: [3],
  code: 'Crown',
  category: 'Restorative',
  surfaces: ['O'],
  dx: ['D'],
  priority: 'urgent',
  motivation: ['pain'],
  status: 'proposed',
  scheduleNext: true,
  photos: [],
};

/** Hyg SQL to the hyg fake (plus the one new statement); TC referral SQL to the TC fake. */
class RxDb extends FakeHygDb {
  constructor() {
    super();
    this.tc = new FakeTenantDb();
  }

  async query(sql, params = []) {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/^UPDATE hyg_visit SET rx_needed = \$3, pharmacy = \$4, updated_by = \$5, updated_at = now\(\) WHERE office = \$1 AND apt_num = \$2 RETURNING/i.test(text)) {
      this.statements.push(text);
      const [office, aptNum, rxNeeded, pharmacy, actor] = params;
      // As the CHECKs (1794500000000) would refuse.
      if (rxNeeded.length > 1000 || pharmacy.length > 200 || /[\r\n]/.test(pharmacy)) {
        throw new Error('hyg_visit rx CHECK violated');
      }
      const row = this.hyg_visit.find((v) => v.office === office && Number(v.apt_num) === Number(aptNum));
      if (!row) return { rows: [], rowCount: 0 };
      Object.assign(row, { rx_needed: rxNeeded, pharmacy, updated_by: actor, updated_at: new Date() });
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (/\btc_referral/i.test(text)) return this.tc.query(sql, params);
    return super.query(sql, params);
  }

  async connect() {
    return { query: (sql, params) => this.query(sql, params), release() {} };
  }
}

function od() {
  const client = new FakeOd(
    {
      '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
      '/operatories': [operatoryRow()],
      '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
      '/providers': [
        { ProvNum: 1, Abbr: 'DOC1' },
        { ProvNum: 7, Abbr: 'HYG1' },
      ],
      '/patients/12827': patientRow(),
      '/procedurelogs': [{ ProcNum: 5001 }],
      '/procedurelogs/GroupNotes': [],
      '/definitions': [
        { DefNum: 401, ItemName: 'ODHQ' },
        { DefNum: 473, ItemName: 'Routers' },
      ],
    },
    { writes: {} }
  );
  let nextProcNum = 60001;
  client.writeRoutes = {
    '/procedurelogs/GroupNote': (body) => {
      const procNum = nextProcNum++;
      client.routes['/procedurelogs/GroupNotes'] = [
        ...client.routes['/procedurelogs/GroupNotes'],
        {
          ProcNum: procNum,
          PatNum: body.PatNum,
          ProcNums: body.ProcNums,
          ProvNum: body.ProvNum,
          isSigned: false,
          Note: String(body.Note).replace(/\n/g, '\r\n'),
        },
      ];
      return { ok: true, status: 200, data: { ProcNum: procNum } };
    },
    '/documents/Upload': { ok: true, status: 200, data: { DocNum: 4711 } },
  };
  return client;
}

function switchSetting(t, key, byOffice, cache) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (k) =>
    k === key && byOffice ? { key: k, value: byOffice, updated_at: new Date(), updated_by: null } : orig(k);
  cache.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    cache.resetCacheForTests();
  });
}

function recordingTc() {
  const calls = [];
  return {
    calls,
    submit: async (_req, { office, body }) => {
      calls.push({ office, body });
      return { ok: true, handoffId: HANDOFF_ID, replayed: calls.length > 1, final: body.final === true };
    },
  };
}

async function boot(t, opts = {}) {
  const db = new RxDb();
  const client = opts.od || od();
  const app = await bootHygApp({ db, od: client, ...opts });
  t.after(() => app.close());
  return { ...app, db, client };
}

/** Open the visit, add a crown, read it once (the appointment snapshot carries the name). */
async function openVisit(app, office = 'roland') {
  const q = `?office=${office}&date=${DATE}`;
  const opened = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + q);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const added = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + q, { body: CROWN });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const page = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + q);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return page.body;
}

function assertNoNeedle(haystack, where) {
  const text = typeof haystack === 'string' ? haystack : JSON.stringify(haystack);
  for (const n of NEEDLES) assert.ok(!text.includes(n), `${where} must not carry "${n}"`);
}

// ── save / load ─────────────────────────────────────────────────────────────

test('save / load: blank until saved, then read back trimmed, audited', async (t) => {
  const app = await boot(t);
  await openVisit(app);

  let res = await api(app.baseUrl, 'GET', RX());
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.prescriptions, { rxNeeded: '', pharmacy: '' });

  const put = await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: `  ${RX_TEXT}  `, pharmacy: ` ${PHARMACY_TEXT} ` } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.prescriptions, { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT });
  assert.equal(put.body.office, 'roland');
  assert.equal(put.body.aptNum, 900001);

  res = await api(app.baseUrl, 'GET', RX());
  assert.deepEqual(res.body.prescriptions, { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT });

  // Clearing is a save of blanks.
  const cleared = await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: '', pharmacy: '' } });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.prescriptions, { rxNeeded: '', pharmacy: '' });

  const audits = app.db.audit.filter((a) => a.resource_type === 'hyg_visit_prescriptions');
  assert.deepEqual(
    audits.map((a) => a.action),
    ['READ', 'UPDATE', 'READ', 'UPDATE']
  );
  for (const a of audits) assertNoNeedle(a, 'an audit row');
});

test('bounds: too long, a multi-line pharmacy, a missing field or an extra one is refused 400 and nothing changes', async (t) => {
  const app = await boot(t);
  await openVisit(app);
  await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: 'kept', pharmacy: 'kept' } });

  for (const body of [
    { rxNeeded: 'x'.repeat(1001), pharmacy: '' },
    { rxNeeded: '', pharmacy: 'x'.repeat(201) },
    { rxNeeded: '', pharmacy: 'line one\nline two' },
    { rxNeeded: 'only one field' },
    { rxNeeded: '', pharmacy: '', office: 'valley' },
    { rxNeeded: '', pharmacy: '', patNum: 7115 },
  ]) {
    const res = await api(app.baseUrl, 'PUT', RX(), { body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.deepEqual((await api(app.baseUrl, 'GET', RX())).body.prescriptions, { rxNeeded: 'kept', pharmacy: 'kept' });

  // The exact caps are accepted.
  const max = await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: 'x'.repeat(1000), pharmacy: 'y'.repeat(200) } });
  assert.equal(max.status, 200, JSON.stringify(max.body));
});

test('cross-office: the other office reads and writes nothing for this appointment (404)', async (t) => {
  const app = await boot(t, { hygOffices: ['roland', 'valley'] });
  await openVisit(app, 'roland');
  await api(app.baseUrl, 'PUT', RX('roland'), { body: { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT } });

  const read = await api(app.baseUrl, 'GET', RX('valley'));
  assert.equal(read.status, 404);
  assert.equal(read.body.code, 'VISIT_NOT_FOUND');
  assertNoNeedle(read.body, "valley's answer");

  const write = await api(app.baseUrl, 'PUT', RX('valley'), { body: { rxNeeded: 'valley wrote this', pharmacy: '' } });
  assert.equal(write.status, 404);
  assert.deepEqual((await api(app.baseUrl, 'GET', RX('roland'))).body.prescriptions, { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT });
});

test('a visit not yet opened is a 404, and a bad aptNum a 400', async (t) => {
  const app = await boot(t);
  assert.equal((await api(app.baseUrl, 'GET', RX())).status, 404);
  assert.equal((await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: 'x', pharmacy: '' } })).status, 404);
  assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/abc/prescriptions?office=roland')).status, 400);
});

// ── the checkout card ──────────────────────────────────────────────────────

test('the checkout handoff carries them for the card; blank carries nothing new', async (t) => {
  switchSetting(t, 'tc_checkout_enabled', { roland: true }, tcCheckout);
  const tc = recordingTc();
  const app = await boot(t, { checkoutSubmit: tc.submit });
  await openVisit(app);

  // Blank: the snapshot has no `prescriptions` key at all.
  const first = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout/alert?office=roland', { body: {} });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(tc.calls.length, 1);
  assert.ok(!('prescriptions' in tc.calls[0].body.snapshot), 'a visit without them sends the snapshot it always did');

  // Filled, then the visit's final update: they ride along.
  await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT } });
  const fin = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/checkout/finalize?office=roland', { body: {} });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  const last = tc.calls[tc.calls.length - 1];
  assert.equal(last.office, 'roland');
  assert.deepEqual(last.body.snapshot.prescriptions, { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT });

  // And the TC contract accepts that snapshot (the card reads it back).
  const contract = require('../../tc/contract.gen.cjs');
  const parsed = contract.TcCheckoutSubmit.safeParse(last.body);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error && parsed.error.issues));
  assert.deepEqual(parsed.data.snapshot.prescriptions, { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT });
});

// ── THE PIN: never in Open Dental ──────────────────────────────────────────

test('PIN: a full visit sent with both fields filled — neither value reaches the composer, a staged write, or Open Dental', async (t) => {
  switchSetting(t, 'tc_checkout_enabled', { roland: true }, tcCheckout);
  const tc = recordingTc();
  const client = od();
  const app = await boot(t, { od: client, checkoutSubmit: tc.submit });
  await openVisit(app);

  // A filled-in slip too, so the note has real content beside the fields.
  const page = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
  const slip = { ...page.body.visit.slip, frontDeskNote: 'Schedule crown consult', financialNote: 'Estimate given' };
  const savedSlip = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip } });
  assert.equal(savedSlip.status, 200, JSON.stringify(savedSlip.body));

  const put = await api(app.baseUrl, 'PUT', RX(), { body: { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT } });
  assert.equal(put.status, 200, JSON.stringify(put.body));

  // 1. The visit as served — what the composer and the Send read — has no trace.
  const served = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
  assertNoNeedle(served.body.visit, 'the HygVisit');

  // 2. Every chart write this visit can stage.
  let staged = null;
  for (const kind of ['note', 'router']) {
    staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, { body: { kind } });
    assert.equal(staged.status, 201, `${kind}: ${JSON.stringify(staged.body)}`);
  }
  for (const w of staged.body.visit.stagedWrites) assertNoNeedle(w, `the ${w.kind} staged write`);
  for (const row of app.db.hyg_staged_write) {
    assertNoNeedle({ preview: row.preview, payload: row.payload, summary: row.summary, title: row.title }, `the stored ${row.kind} row`);
  }

  // 3. The composer, run directly on the stored visit, for every kind.
  for (const kind of ['note', 'router']) {
    const out = composer.compose(kind, { visit: served.body.visit, items: served.body.visit.items, actor: 'hygienist@carein.ai' });
    assertNoNeedle(out, `composer(${kind})`);
  }

  // 4. Send it all, for real, through the fake Open Dental.
  const confirm = staged.body.visit.stagedWrites.map((w) => ({ kind: w.kind, previewFingerprint: w.previewFingerprint }));
  const sent = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + Q, { body: { confirm } });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.ok(client.writes.length >= 2, 'the note and the router really were written');
  assertNoNeedle(client.writes, 'an Open Dental write');
  assertNoNeedle(client.calls, 'an Open Dental read');
  // The router PDF goes up as base64: decode every long base64 string and look inside too.
  for (const w of client.writes) {
    for (const v of Object.values(w[3] || {})) {
      if (typeof v === 'string' && v.length > 200 && /^[A-Za-z0-9+/=\s]+$/.test(v)) {
        assertNoNeedle(Buffer.from(v, 'base64').toString('latin1'), 'the uploaded router document');
      }
    }
  }

  // Positive control: the values WERE in play — they went to the checkout card.
  const last = tc.calls[tc.calls.length - 1];
  assert.ok(last, 'the Send updated the checkout handoff');
  assert.deepEqual(last.body.snapshot.prescriptions, { rxNeeded: RX_TEXT, pharmacy: PHARMACY_TEXT });
});

test('PIN (static): nothing on the chart-write path names the fields', () => {
  for (const rel of [
    '../../services/hyg/stagedWriteComposer.js',
    '../../services/hyg/sendVisit.js',
    '../../services/hyg/odWriter.js',
    '../../services/hyg/perioSend.js',
  ]) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!/rx_needed|rxNeeded|pharmacy|prescription/i.test(src), `${rel} must not name the Rx fields`);
  }
  // And the contract's HygVisit has no such field for anything to read.
  const contract = require('../../hyg/contract.gen.cjs');
  const keys = Object.keys(contract.HygVisitSchema.shape);
  assert.ok(!keys.some((k) => /rx|pharmacy|prescription/i.test(k)), keys.join(','));
});

// ── the chairside referral-template read ───────────────────────────────────

test("chairside: the referral form's templates are the visit office's own, read-only", async (t) => {
  switchSetting(t, 'tc_referrals_enabled', { roland: true, valley: true }, tcReferrals);
  const app = await boot(t, { modules: ['hyg', 'tc'], hygOffices: ['roland', 'valley'] });
  app.db.tc.table('tc_referral_templates').push(
    { office_id: 'roland', template_kind: 'specialist_message', body: 'Roland: {reason}', updated_by: 'admin@x', updated_at: new Date(), created_at: new Date() },
    { office_id: 'valley', template_kind: 'specialist_message', body: 'Valley: {teeth}', updated_by: 'admin@x', updated_at: new Date(), created_at: new Date() }
  );

  const roland = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/referral-templates?office=roland');
  assert.equal(roland.status, 200, JSON.stringify(roland.body));
  assert.equal(roland.body.canEdit, false);
  assert.deepEqual(
    roland.body.templates.map((x) => [x.kind, x.body]),
    [
      ['specialist_message', 'Roland: {reason}'],
      ['correspondence_note', ''],
    ]
  );
  const valley = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/referral-templates?office=valley');
  assert.equal(valley.status, 200);
  assert.equal(valley.body.templates[0].body, 'Valley: {teeth}');
});
