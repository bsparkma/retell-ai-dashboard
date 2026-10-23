'use strict';

/**
 * The checkout alert, end to end on the hygiene side (queue item 49).
 *
 * What is under test, by acceptance row:
 *   1  a double-click of "Alert checkout" is ONE handoff: two racing presses
 *      reach TC once, and a later press answers alreadySent and sends nothing.
 *   2  an early alert and then the visit Send are ONE handoff, whose payload
 *      the Send updates to the final snapshot — proven against a recording
 *      submitter AND by replaying the captured bodies into the REAL TC route.
 *   4  a TC refusal releases the claim and claims nothing; the next press
 *      succeeds; a stale claim is taken over.
 *   5  the body is ignored: a forged office, PatNum, name and provider are
 *      discarded and the handoff is built from the visit.
 *   6  ZERO Open Dental calls on the alert path (the fake's call log).
 *   +  switched off for the office: the page hides it, the route 403s, the
 *      visit Send sends nothing and says `checkout: null`.
 *   +  the visit Send's handoff can never fail the Send: TC down leaves the
 *      chart writes Written and reports `not_delivered`, which /finalize retries.
 *
 * Test patients only: roland 12827 (named by the fixture as "Test 2, Stedi").
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');
const tcUtils = require('../tc/tcTestUtils');

const DATE = '2026-09-08';
const Q = '?office=roland&date=' + DATE;
const ALERT = '/api/hyg/visit/900001/checkout/alert?office=roland';
const FINALIZE = '/api/hyg/visit/900001/checkout/finalize?office=roland';
const SEND = '/api/hyg/visit/900001/send' + Q;
const HANDOFF_ID = '5d2a7e10-0000-4000-8000-0000000000c1';

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

/** One roland appointment for test patient 12827, doctor ProvNum 1, hygienist 7. */
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
  // The note lands and reads back, exactly as hygSend.test.js's helper does.
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
  };
  return client;
}

/**
 * Switch the checkout handoff on (or off) for a test, through the REAL
 * precedence: the stored platform_setting row.
 */
function switchCheckout(t, byOffice) {
  const orig = registry.getPlatformSetting;
  registry.getPlatformSetting = async (key) =>
    key === 'tc_checkout_enabled' && byOffice ? { key, value: byOffice, updated_at: new Date(), updated_by: null } : null;
  tcCheckout.resetCacheForTests();
  t.after(() => {
    registry.getPlatformSetting = orig;
    tcCheckout.resetCacheForTests();
  });
}

/** A checkout submitter that records what it was handed and answers with a handoff. */
function recordingTc({ delayMs = 0, fail = null } = {}) {
  /** @type {Array<{ office: string, body: any }>} */
  const calls = [];
  const tc = {
    calls,
    /** @type {null | { ok: false, code: string, error: string }} */
    fail,
    submit: async (_req, { office, body }) => {
      calls.push({ office, body });
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (tc.fail) return tc.fail;
      return { ok: true, handoffId: HANDOFF_ID, replayed: calls.length > 1, final: body.final === true };
    },
  };
  return tc;
}

/**
 * Open the visit, add a crown, and GET it once more so the appointment
 * snapshot is recorded (the only source of the name the handoff carries).
 */
async function preparedVisit(app) {
  const opened = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  const added = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const page = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
  assert.equal(page.status, 200, JSON.stringify(page.body));
  return page.body;
}

// ── switched off ───────────────────────────────────────────────────────────

test('OFF for the office: the page hides it, the alert 403s, the Send sends nothing', async (t) => {
  switchCheckout(t, { roland: false });
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());

  const page = await preparedVisit(app);
  assert.equal(page.checkoutEnabled, false);

  const res = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CHECKOUT_DISABLED');

  const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
    body: { kind: 'note' },
  });
  const sent = await api(app.baseUrl, 'POST', SEND, {
    body: {
      confirm: staged.body.visit.stagedWrites.map((w) => ({
        kind: w.kind,
        previewFingerprint: w.previewFingerprint,
      })),
    },
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.checkout, null);
  assert.equal(tc.calls.length, 0, 'TC was never asked');
  assert.equal(app.db.hyg_visit[0].checkout_handoff_id, null);
});

test('no stored row and no env var: OFF (the floor)', async (t) => {
  switchCheckout(t, null);
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  const page = await preparedVisit(app);
  assert.equal(page.checkoutEnabled, false);
  assert.equal((await api(app.baseUrl, 'POST', ALERT, { body: {} })).status, 403);
});

test('the env break-glass =false beats a stored true', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'false';
  t.after(() => delete process.env.TC_CHECKOUT_ENABLED_ROLAND);
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  await preparedVisit(app);
  assert.equal((await api(app.baseUrl, 'POST', ALERT, { body: {} })).status, 403);
});

test('an env =true cannot override a stored false', async (t) => {
  switchCheckout(t, { roland: false });
  const tc = recordingTc();
  process.env.TC_CHECKOUT_ENABLED_ROLAND = 'true';
  t.after(() => delete process.env.TC_CHECKOUT_ENABLED_ROLAND);
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  const page = await preparedVisit(app);
  assert.equal(page.checkoutEnabled, false);
});

// ── 1, 5, 6: one press, one handoff, built from the visit, no Open Dental ──

test('1/5/6: a double-click is ONE handoff, built from the visit, with zero Open Dental calls', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc({ delayMs: 60 });
  const client = od();
  const app = await bootHygApp({ od: client, checkoutSubmit: tc.submit });
  t.after(() => app.close());

  const page = await preparedVisit(app);
  assert.equal(page.checkoutEnabled, true);

  const before = client.calls.length;
  const forged = { office: 'valley', patNum: 7115, patientName: 'Forged Name', provider: 'NOPE' };
  const [a, b] = await Promise.all([
    api(app.baseUrl, 'POST', ALERT, { body: forged }),
    api(app.baseUrl, 'POST', ALERT, { body: forged }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], 'one press sends, the other is told it is in progress');
  const loser = a.status === 409 ? a : b;
  assert.equal(loser.body.code, 'CHECKOUT_SEND_IN_PROGRESS');
  assert.equal(tc.calls.length, 1, 'TC was asked ONCE');

  // ZERO Open Dental calls on the alert path.
  assert.deepEqual(client.calls.slice(before), [], 'not one Open Dental read');
  assert.deepEqual(client.writes, [], 'not one Open Dental write');

  // Built from the visit — every forged value discarded.
  const { office, body } = tc.calls[0];
  assert.equal(office, 'roland');
  assert.equal(body.kind, 'checkout');
  assert.equal(body.final, false);
  assert.equal(body.odPatientId, 12827);
  assert.equal(body.patientName, 'Test 2, Stedi');
  assert.equal(body.provider, 'DOC1', "the appointment's provider");
  assert.equal(body.providerSeen, 'HYG1');
  assert.match(body.sourceKey, /^hyg-visit:visit-\d{4}:checkout$/);
  assert.equal(body.snapshot.priority, 'urgent');
  assert.equal(body.snapshot.procedures.length, 1);
  assert.equal(body.snapshot.procedures[0].code, 'Crown');
  assert.equal(body.snapshot.procedures[0].scheduleNext, true);
  assert.equal(body.snapshot.notesPending, true, 'the note has not reached the chart');

  // Recorded on the visit, ONLY after TC answered.
  const row = app.db.hyg_visit[0];
  assert.equal(row.checkout_handoff_id, HANDOFF_ID);
  assert.equal(row.checkout_sent_by, 'hygienist@carein.ai');
  assert.equal(row.checkout_final_at, null);
  assert.equal(row.checkout_send_claimed_at, null, 'the claim is released');

  // A third press: alreadySent, nothing sent.
  const third = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(third.status, 200);
  assert.equal(third.body.alreadySent, true);
  assert.equal(third.body.visit.checkoutSend.handoffId, HANDOFF_ID);
  assert.equal(tc.calls.length, 1);
});

// ── 4: TC refusals and the claim ───────────────────────────────────────────

test('4: TC down → 502, the claim is released, nothing is claimed; the next press succeeds', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc({ fail: { ok: false, code: 'TC_UNREACHABLE', error: 'The TC app did not respond' } });
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  await preparedVisit(app);

  const res = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(res.status, 502);
  assert.equal(res.body.code, 'TC_UNREACHABLE');
  assert.match(res.body.error, /NOT sent/);
  const row = app.db.hyg_visit[0];
  assert.equal(row.checkout_handoff_id, null, 'nothing claims it was sent');
  assert.equal(row.checkout_send_claimed_at, null, 'the claim was released');

  tc.fail = null;
  const retry = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.visit.checkoutSend.handoffId, HANDOFF_ID);
});

test('4: a stale claim (older than two minutes) is taken over', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  await preparedVisit(app);

  // A fresh claim blocks…
  app.db.hyg_visit[0].checkout_send_claimed_at = new Date();
  const blocked = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(blocked.status, 409);
  assert.equal(tc.calls.length, 0);

  // …a dead one does not.
  app.db.hyg_visit[0].checkout_send_claimed_at = new Date(Date.now() - 3 * 60 * 1000);
  const taken = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(tc.calls.length, 1);
});

test('a visit nobody started is a 404, and TC is not asked', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  const res = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(res.status, 404);
  assert.equal(tc.calls.length, 0);
});

// ── 2: early alert, then the visit Send ────────────────────────────────────

/** Stage the note and run the visit Send. */
async function sendNote(app) {
  const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
    body: { kind: 'note' },
  });
  assert.equal(staged.status, 201, JSON.stringify(staged.body));
  return api(app.baseUrl, 'POST', SEND, {
    body: {
      confirm: staged.body.visit.stagedWrites.map((w) => ({
        kind: w.kind,
        previewFingerprint: w.previewFingerprint,
      })),
    },
  });
}

test('2: early alert then the visit Send = ONE handoff, updated to the final snapshot', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  await preparedVisit(app);

  const early = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(early.status, 200, JSON.stringify(early.body));

  // The hygienist keeps working: a front-desk note after the alert.
  const slip = early.body.visit.slip;
  const saved = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
    body: { slip: { ...slip, frontDeskNote: 'Wants afternoons.' } },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const sent = await sendNote(app);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.outcomes[0].state, 'Written', 'the chart write is unaffected');
  assert.deepEqual(sent.body.checkout, { state: 'delivered', code: null, message: null });

  assert.equal(tc.calls.length, 2, 'the early alert and the Send');
  const [first, second] = tc.calls.map((c) => c.body);
  assert.equal(first.sourceKey, second.sourceKey, 'the SAME handoff, by key');
  assert.equal(first.final, false);
  assert.equal(second.final, true);
  assert.equal(second.snapshot.frontDeskNote, 'Wants afternoons.', 'final notes supersede');
  assert.equal(second.snapshot.notesPending, false, 'the note reached the chart');

  assert.equal(sent.body.visit.checkoutSend.handoffId, HANDOFF_ID);
  assert.ok(sent.body.visit.checkoutSend.finalAt, 'finalAt stamped');
});

test('2: the visit Send creates the handoff when nobody pressed Alert checkout', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  await preparedVisit(app);

  const sent = await sendNote(app);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.checkout.state, 'delivered');
  assert.equal(tc.calls.length, 1);
  assert.equal(tc.calls[0].body.final, true);
  assert.equal(sent.body.visit.checkoutSend.handoffId, HANDOFF_ID);
});

test('the Send never fails because of the handoff: TC down → Written + not_delivered; /finalize retries', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc({ fail: { ok: false, code: 'TC_ERROR', error: 'TC responded 500' } });
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  t.after(() => app.close());
  await preparedVisit(app);

  const sent = await sendNote(app);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.outcomes[0].state, 'Written', 'the note landed regardless');
  assert.equal(sent.body.checkout.state, 'not_delivered');
  assert.equal(sent.body.checkout.code, 'TC_ERROR');
  assert.equal(sent.body.visit.checkoutSend, null, 'nothing claims it was delivered');

  tc.fail = null;
  const retry = await api(app.baseUrl, 'POST', FINALIZE, { body: {} });
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.ok(retry.body.visit.checkoutSend.finalAt);
  assert.equal(tc.calls.at(-1).body.final, true);
});

// ── 2 again, through the REAL TC route ─────────────────────────────────────

/** A jsonb cell: real pg returns an object; the TC fake keeps an UPDATE's string. */
function jsonb(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

test('2: the captured bodies, replayed into the REAL TC intake, make ONE handoff and NO case', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  const app = await bootHygApp({ od: od(), checkoutSubmit: tc.submit });
  await preparedVisit(app);
  const early = await api(app.baseUrl, 'POST', ALERT, { body: {} });
  assert.equal(early.status, 200);
  const sent = await sendNote(app);
  assert.equal(sent.status, 200);
  await app.close();
  assert.equal(tc.calls.length, 2);

  // The two harnesses patch the same process-wide seams, so they run one
  // after the other rather than side by side.
  const tcApp = await tcUtils.bootTcApp({ role: 'hygiene' });
  t.after(() => tcApp.close());
  const results = [];
  for (const call of tc.calls) {
    results.push(
      await tcUtils.api(tcApp.baseUrl, 'POST', `/api/tc/hygiene-intakes?office=${call.office}`, call.body)
    );
  }
  assert.equal(results[0].status, 201, JSON.stringify(results[0].body));
  assert.equal(results[1].status, 200, JSON.stringify(results[1].body));
  assert.equal(results[1].body.handoff.handoffId, results[0].body.handoff.handoffId);

  const rows = tcApp.db.table('tc_checkout_handoffs');
  assert.equal(rows.length, 1, 'exactly one handoff');
  assert.equal(rows[0].office_id, 'roland');
  assert.equal(rows[0].is_final, true);
  assert.equal(rows[0].revision, 2);
  assert.equal(jsonb(rows[0].payload).notesPending, false, 'the final snapshot stands');
  assert.equal(tcApp.db.table('tc_cases').length, 0, 'a checkout opens NO case');

  // A late replay of the EARLY body cannot roll the final snapshot back.
  const late = await tcUtils.api(tcApp.baseUrl, 'POST', '/api/tc/hygiene-intakes?office=roland', tc.calls[0].body);
  assert.equal(late.status, 200);
  assert.equal(late.body.replayed, true);
  assert.equal(tcApp.db.table('tc_checkout_handoffs')[0].revision, 2);
  assert.equal(jsonb(tcApp.db.table('tc_checkout_handoffs')[0].payload).notesPending, false);
});

// ── review round 1: a final send TC did not take as final ──────────────────

test('a final update TC answers with a NON-final snapshot is not_delivered, and finalAt stays empty', async (t) => {
  switchCheckout(t, { roland: true });
  const tc = recordingTc();
  // TC answered 200 with a handoff — but the snapshot it holds is not final
  // (a concurrent non-final write won). That is not a delivery.
  const submit = async (req, args) => {
    const r = await tc.submit(req, args);
    return r.ok ? { ...r, final: false } : r;
  };
  const app = await bootHygApp({ od: od(), checkoutSubmit: submit });
  t.after(() => app.close());
  await preparedVisit(app);

  const sent = await sendNote(app);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.outcomes[0].state, 'Written');
  assert.equal(sent.body.checkout.state, 'not_delivered');
  assert.equal(sent.body.checkout.code, 'CHECKOUT_NOT_FINAL');
  assert.equal(app.db.hyg_visit[0].checkout_final_at, null, 'never stamped for notes TC does not hold');
});
