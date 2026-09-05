'use strict';

/**
 * The visit workspace, end to end (H1 slice 2).
 *
 * Booted through the REAL /api/hyg stack — auth gate, tenantContext,
 * requireModule('hyg'), requireReadWrite, routes/hyg/index.js — so the mount
 * order and the office middleware are under test, not stubbed around.
 *
 * What these tests are about, in order of how much they would cost to get wrong:
 *
 *   1. A client never names the patient. `patNum` comes from Open Dental's own
 *      answer for the appointment, so a slip cannot be attached to somebody
 *      else by a request body.
 *   2. A GET does not create. Glancing at a card must not leave a visit behind.
 *   3. Re-opening an appointment finds the visit that is already there.
 *   4. Every body is parsed by the shared schema, and a rejection NAMES the
 *      field rather than saying "invalid body".
 *   5. A staged write is composed on the SERVER. The request carries a kind and
 *      nothing else.
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

/** A day with one appointment on it, for PatNum 12827 (a staging fixture). */
function dayOd(over = {}) {
  return new FakeOd({
    '/appointments': [
      apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    ...over,
  });
}

/** A whole, valid treatment item body. */
function itemBody(over = {}) {
  return {
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
    ...over,
  };
}

test('a GET on an appointment nobody has opened returns no visit, and CREATES none', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(res.status, 200);
    assert.equal(res.body.visit, null, 'nobody has started one');
    // The header a hygienist reads comes from the day payload, audited.
    assert.equal(res.body.appointment.aptNum, 900001);
    assert.equal(res.body.appointment.patNum, 12827);
    assert.ok(res.body.flagSources, 'the three-state flags say whether OD was asked');

    // Glancing at a card must not leave a visit behind for a patient nobody
    // worked on, or "which visits happened today" stops being answerable.
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('opening a visit takes the PatNum from Open Dental, never from the caller', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q, {
      // A caller trying to name a DIFFERENT patient. The route reads no body at
      // all on this path, so this can only be ignored.
      body: { patNum: 99999, office: 'valley' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.visit.patNum, 12827, "Open Dental's answer, not the body's");
    assert.equal(res.body.visit.office, 'roland');
    assert.equal(app.db.hyg_visit.length, 1);
    assert.equal(app.db.hyg_visit[0].pat_num, 12827);
  } finally {
    await app.close();
  }
});

test('re-opening the same appointment finds the visit already there', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    const first = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(first.status, 200);

    // Work happens.
    const withItem = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: itemBody(),
    });
    assert.equal(withItem.status, 201);

    // The app is backgrounded and the card is tapped again. A second row here
    // would mean a hygienist came back to an empty slip with her work in a
    // sibling row nothing renders.
    const second = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(second.status, 200);
    assert.equal(second.body.visit.visitId, first.body.visit.visitId);
    assert.equal(second.body.visit.items.length, 1, 'her work is still on it');
    assert.equal(app.db.hyg_visit.length, 1, 'one visit per appointment');
  } finally {
    await app.close();
  }
});

test('an appointment that is not on the date given is a refusal, not a blank visit', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/777777/open' + Q);
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'APPOINTMENT_NOT_ON_DAY');
    // Names WHICH thing is missing: guessing a PatNum is the one thing this
    // module may never do.
    assert.match(res.body.error, /777777/);
    assert.match(res.body.error, /2026-09-08/);
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('an appointment with no patient on it cannot become a visit', async () => {
  const od = dayOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 0, AptDateTime: DATE + ' 08:00:00' })],
  });
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'APPOINTMENT_HAS_NO_PATIENT');
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('a malformed body is a 400 that NAMES the field', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);

    // priority holds a CATEGORY value. The two vocabularies share the word
    // "cosmetic" and are different axes; this is the mix-up the whole schema
    // exists to refuse.
    const bad = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: itemBody({ priority: 'Restorative' }),
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_BODY');
    assert.equal(bad.body.field, 'priority');
    assert.match(bad.body.error, /^priority: /);

    // A slip with a key the contract does not know is a refusal, not a silent
    // drop: a form that quietly loses what somebody typed is worse than one
    // that will not save.
    const strict = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
      body: { slip: { ...emptySlip(), somethingNew: true } },
    });
    assert.equal(strict.status, 400);
    assert.equal(strict.body.field, 'slip.somethingNew');

    // Several bad fields come back together — three round trips to discover
    // three problems is three chances to give up.
    const many = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: itemBody({ priority: 'nope', category: 'nope', status: 'nope' }),
    });
    assert.equal(many.status, 400);
    assert.ok(many.body.issues.length >= 3);
    assert.deepEqual(
      many.body.issues.map((i) => i.field).sort(),
      ['category', 'priority', 'status']
    );

    assert.equal(app.db.hyg_treatment_item.length, 0, 'nothing was stored');
  } finally {
    await app.close();
  }
});

test('a mutation on an appointment nobody has opened is a 404, not an implicit create', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    const res = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, {
      body: { slip: emptySlip() },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'VISIT_NOT_FOUND');
    // A visit created here would have no appointment lookup behind it, and so
    // no Open-Dental-derived PatNum.
    assert.equal(app.db.hyg_visit.length, 0);
  } finally {
    await app.close();
  }
});

test('treatment items can be added, edited and removed, and keep their order', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);

    const one = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: itemBody({ teeth: [3], code: 'Crown' }),
    });
    const two = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: itemBody({ teeth: 'mouth', code: 'SRP', category: 'Perio', priority: 'preventative' }),
    });
    assert.equal(two.status, 201);
    assert.deepEqual(
      two.body.visit.items.map((i) => i.code),
      ['Crown', 'SRP'],
      'in the order she added them'
    );
    // "Whole mouth" survives the round trip as itself, not as an empty list.
    assert.equal(two.body.visit.items[1].teeth, 'mouth');

    // A PARTIAL edit: one field on the wire, whole-object validation on the
    // server. The rest of the item is untouched.
    const itemId = one.body.visit.items[0].id;
    const edited = await api(app.baseUrl, 'PUT', `/api/hyg/visit/900001/items/${itemId}` + Q, {
      body: { status: 'confirmed' },
    });
    assert.equal(edited.status, 200);
    const crown = edited.body.visit.items.find((i) => i.id === itemId);
    assert.equal(crown.status, 'confirmed');
    assert.equal(crown.code, 'Crown', 'the rest of the item is untouched');
    assert.deepEqual(crown.teeth, [3]);

    // A partial edit cannot assemble an item the create path would refuse.
    const badPatch = await api(app.baseUrl, 'PUT', `/api/hyg/visit/900001/items/${itemId}` + Q, {
      body: { priority: 'Cosmetic' },
    });
    assert.equal(badPatch.status, 400, 'the CATEGORY spelling is not a priority');

    const gone = await api(app.baseUrl, 'DELETE', `/api/hyg/visit/900001/items/${itemId}` + Q);
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.visit.items.map((i) => i.code), ['SRP']);

    const missing = await api(app.baseUrl, 'DELETE', `/api/hyg/visit/900001/items/${itemId}` + Q);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'ITEM_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('the records a treatment needs and the handoff category are computed, never stored', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: itemBody({ code: 'IMP', category: 'Prosth', teeth: [19] }),
    });
    assert.equal(res.status, 201);
    // RECORDS_MATRIX is the office's standard: changing it must change what
    // every open visit asks for, not only the ones saved since.
    assert.deepEqual(res.body.recordsNeeded, [
      'PA',
      'CT scan',
      'Perio chart',
      'Missing teeth note',
      'Surgical guide',
    ]);
    // deriveCategory has already been given the answer item by item; the
    // hygienist is not asked to classify the visit a second time.
    assert.equal(res.body.handoffCategory, 'Implant');
  } finally {
    await app.close();
  }
});

test('a staged write is composed on the SERVER; the request carries only a kind', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: itemBody() });

    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      // A caller trying to supply the words. Every one of these is ignored:
      // a payload the client supplied is a payload the client can change
      // between the preview and the send (RCM F3).
      body: {
        kind: 'router',
        title: 'Anything I like',
        preview: ['nothing to see here'],
        payload: { note: 'attacker' },
      },
    });
    assert.equal(res.status, 400, 'the stage body is strict — extra keys are refused outright');

    const ok = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });
    assert.equal(ok.status, 201);
    const staged = ok.body.visit.stagedWrites[0];
    assert.equal(staged.kind, 'router');
    assert.equal(staged.state, 'Staged');
    assert.equal(staged.title, 'Routing slip');
    assert.ok(staged.preview.some((line) => line.includes('Crown')), 'the slip lists her work');
    assert.equal(staged.stagedBy, 'hygienist@carein.ai');
    assert.equal(staged.sentAt, null, 'slice 2 sends nothing');
  } finally {
    await app.close();
  }
});

test('every visit read and write is audited, with the office on the row', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: itemBody() });

    const rows = app.db.audit;
    const byType = (t) => rows.filter((r) => r.resource_type === t);
    // The GET disclosed a patient's name and their chairside flags, so it is
    // audited like the disclosure it is — one row for the visit, one for the
    // patient.
    assert.equal(byType('hyg_visit').filter((r) => r.action === 'READ').length, 1);
    assert.equal(byType('hyg_visit_patient').length, 1);
    assert.equal(byType('hyg_visit_patient')[0].resource_id, '12827');
    assert.equal(byType('hyg_visit').find((r) => r.action === 'CREATE').office, 'roland');
    assert.equal(byType('hyg_treatment_item')[0].action, 'CREATE');
    for (const row of rows) {
      assert.equal(row.office, 'roland', 'a PatNum is meaningless without its office');
    }
  } finally {
    await app.close();
  }
});

test('an audit failure refuses the read rather than serving PHI with no trail', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    app.db.failAudit = true;
    const res = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'AUDIT_FAILED');
    assert.equal(res.body.visit, undefined, 'nothing was served');
  } finally {
    await app.close();
  }
});

test('an aptNum that is not a number is a 400 of its own, not a 404', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    for (const bad of ['abc', '-1', '0', '1.5']) {
      const res = await api(app.baseUrl, 'GET', `/api/hyg/visit/${bad}` + Q);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.code, 'INVALID_APT_NUM', bad);
    }
    // A 404 here would read as "that appointment does not exist", which is a
    // different and misleading claim.
    const noDate = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001?office=roland');
    assert.equal(noDate.status, 400);
    assert.equal(noDate.body.code, 'INVALID_DATE');
  } finally {
    await app.close();
  }
});
