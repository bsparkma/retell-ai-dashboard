'use strict';

/**
 * A CROSS-OFFICE READ OR WRITE IS IMPOSSIBLE BY CONSTRUCTION.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS SEPARATELY FROM THE REST OF THE VISIT TESTS
 * ═════════════════════════════════════════════════════════════════════════════
 * PatNum numbering restarts in every Open Dental database. 7115 is the valley
 * test patient AND a different, real person in roland. A visit fetched by its
 * uuid alone, or an item edited by its uuid alone, would be a row from one
 * practice rendered beside the other practice's patient — the worst defect
 * available in this codebase, and one that would look completely normal on
 * screen.
 *
 * Three separate things stop it, and this file exercises all three rather than
 * trusting any one of them:
 *
 *   1. THE SCHEMA. `office` is NOT NULL on all three tables, and the children
 *      carry a COMPOSITE FK back to (visit_id, office) — so a child whose
 *      office disagrees with its parent cannot be stored at all.
 *   2. THE QUERIES. Every statement in services/hyg/visitStore.js filters on
 *      office as well as on the id. There is no function there that takes an id
 *      without an office beside it.
 *   3. THE ROUTE. `office` comes from the validated `?office=` query param via
 *      the router-wide `requireOffice`, and the office's Open Dental handle is
 *      re-asserted with `assertOfficeMatch` before the appointment is read.
 *
 * "By construction, not by convention" is the acceptance criterion, so the
 * tests below try to BREAK it rather than merely observing that it holds.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeHygDb,
  FakeOd,
  bootHygApp,
  api,
  apptRow,
  patientRow,
  operatoryRow,
} = require('./hygTestUtils');
const visitStore = require('../../services/hyg/visitStore');

const DATE = '2026-09-08';

/**
 * A FakeOd that answers BOTH offices' days — because the harness gives every
 * office the same client, which is exactly the condition under which an office
 * mix-up would go unnoticed.
 */
function bothOfficesOd() {
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

test('a valley request cannot read a roland visit, even with the right aptNum', async () => {
  const app = await bootHygApp({ od: bothOfficesOd(), hygOffices: ['roland', 'valley'] });
  try {
    const opened = await api(
      app.baseUrl,
      'POST',
      '/api/hyg/visit/900001/open?office=roland&date=' + DATE
    );
    assert.equal(opened.status, 200);
    const rolandVisitId = opened.body.visit.visitId;

    // The SAME appointment number, asked for as valley. AptNum numbering also
    // restarts per database, so this is not a hypothetical collision.
    const asValley = await api(
      app.baseUrl,
      'GET',
      '/api/hyg/visit/900001?office=valley&date=' + DATE
    );
    assert.equal(asValley.status, 200);
    assert.equal(asValley.body.visit, null, 'roland’s visit is not valley’s to see');
    assert.notEqual(asValley.body.visit, rolandVisitId);

    // And a valley mutation cannot reach it either.
    const asValleyWrite = await api(
      app.baseUrl,
      'PUT',
      '/api/hyg/visit/900001?office=valley&date=' + DATE,
      { body: { slip: require('../../hyg/contract.gen.cjs').emptySlip() } }
    );
    assert.equal(asValleyWrite.status, 404);
    assert.equal(asValleyWrite.body.code, 'VISIT_NOT_FOUND');

    // The roland row is untouched, and still says roland.
    assert.equal(app.db.hyg_visit.length, 1);
    assert.equal(app.db.hyg_visit[0].office, 'roland');
  } finally {
    await app.close();
  }
});

test('a valley request cannot edit or delete a roland treatment item by its id', async () => {
  const app = await bootHygApp({ od: bothOfficesOd(), hygOffices: ['roland', 'valley'] });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open?office=roland&date=' + DATE);
    const added = await api(
      app.baseUrl,
      'POST',
      '/api/hyg/visit/900001/items?office=roland&date=' + DATE,
      {
        body: {
          teeth: [3],
          code: 'Crown',
          category: 'Restorative',
          dx: ['D'],
          priority: 'urgent',
          motivation: [],
          status: 'proposed',
          scheduleNext: false,
          photos: [],
        },
      }
    );
    const itemId = added.body.visit.items[0].id;

    // Valley opens its OWN visit on the same appointment number, then tries to
    // reach roland's item by the uuid it somehow learned.
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open?office=valley&date=' + DATE);

    const edit = await api(
      app.baseUrl,
      'PUT',
      `/api/hyg/visit/900001/items/${itemId}?office=valley&date=` + DATE,
      { body: { status: 'confirmed' } }
    );
    assert.equal(edit.status, 404);
    assert.equal(edit.body.code, 'ITEM_NOT_FOUND');

    const del = await api(
      app.baseUrl,
      'DELETE',
      `/api/hyg/visit/900001/items/${itemId}?office=valley&date=` + DATE
    );
    assert.equal(del.status, 404);

    // The roland item is still there, unchanged. A cross-office delete that
    // reported success would be the same defect wearing a 200.
    assert.equal(app.db.hyg_treatment_item.length, 1);
    assert.equal(app.db.hyg_treatment_item[0].status, 'proposed');
    assert.equal(app.db.hyg_treatment_item[0].office, 'roland');
  } finally {
    await app.close();
  }
});

test('the DATABASE refuses a child row whose office disagrees with its parent', async () => {
  // Below the routes, at the store, with the fake enforcing the composite FK
  // the migration declares. This is the statement that survives somebody
  // writing a new route and forgetting the office in a WHERE clause.
  const db = new FakeHygDb();
  const visit = await visitStore.openVisit(db, {
    office: 'roland',
    aptNum: 900001,
    patNum: 12827,
    visitDate: DATE,
    actor: 'hygienist@carein.ai',
  });

  await assert.rejects(
    () =>
      visitStore.addItem(db, {
        office: 'valley',
        visitId: visit.visitId,
        input: {
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
        actor: 'hygienist@carein.ai',
      }),
    /hyg_treatment_item_visit_fk/,
    'the composite FK is what makes the denormalised office column safe'
  );
  assert.equal(db.hyg_treatment_item.length, 0);
});

test('the store has no function that takes an id without an office', () => {
  // A grep, deliberately: the property being defended is about the SHAPE of the
  // module's surface, and a new function that broke it would otherwise only be
  // caught by whoever happened to review it.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'services', 'hyg', 'visitStore.js'),
    'utf8'
  );

  // Every exported function's destructured argument list must name `office`.
  const signatures = [...src.matchAll(/^async function (\w+)\(pool, \{([^}]*)\}/gm)];
  assert.ok(signatures.length >= 6, 'expected the store to export several pool functions');
  for (const [, name, args] of signatures) {
    assert.ok(
      /\boffice\b/.test(args),
      `visitStore.${name}() takes no office — a PatNum alone identifies nobody`
    );
  }

  // And every SQL WHERE clause names office.
  //
  // Comments are stripped FIRST. This file's own header says the word "WHERE"
  // in prose, and a scan that matched that would report a defect in the
  // documentation of the rule it is checking.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const wheres = [...code.matchAll(/\bWHERE ([^`]+?)(?=`)/g)].map((m) =>
    m[1].replace(/\s+/g, ' '),
  );
  assert.ok(wheres.length >= 6, 'expected several WHERE clauses, found ' + wheres.length);
  for (const clause of wheres) {
    assert.ok(/office/.test(clause), 'a WHERE clause with no office in it: ' + clause);
  }
});
