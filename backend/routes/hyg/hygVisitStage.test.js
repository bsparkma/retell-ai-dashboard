'use strict';

/**
 * STAGING: the state machine lives on the server, and NOTHING gates a send.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. NOTHING IS GATED ON COMPLETENESS. THIS IS A RULING, NOT A PREFERENCE.
 * ═════════════════════════════════════════════════════════════════════════════
 * Beau, verbatim: *"the hygienist should be able to send the treatment to the
 * tc app."*
 *
 * The prototype's Finish tab disabled "Send all to Open Dental" until both
 * "Recare scheduled" and "TX entered in OD" were answered. Both describe work
 * the FRONT DESK does after the hygienist has finished, so gating on them makes
 * a hygienist wait on somebody else's task with a patient in the chair. The
 * RECORDS_MATRIX is the same shape of thing: it produces a list a screen shows,
 * and it refuses nothing.
 *
 * These tests stage everything from a COMPLETELY unanswered slip. If a
 * completeness check ever creeps in — here, or in a later slice's send — this
 * file goes red.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 2. A CLIENT CANNOT MOVE A ROW TO `Written`
 * ═════════════════════════════════════════════════════════════════════════════
 * Draft → Staged → Sending → Written | Failed. Slice 2 owns the first two.
 * `Sending`, `Written` and `Failed` are set by the SERVER in slice 3, around a
 * real Open Dental call, after a read-back.
 *
 * There is no `state` field in any request schema in shared/hyg/contract.ts, so
 * a client cannot ask for one — and the stage body is `.strict()`, so trying
 * is a 400 rather than a silently ignored key. A row that has left Draft/Staged
 * is immutable to this slice: re-staging one is refused rather than quietly
 * resetting the record of a write that already reached a chart.
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
      apptRow({ AptNum: 900001, PatNum: 12828, AptDateTime: DATE + ' 09:00:00' }),
    ],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12828': patientRow({ PatNum: 12828, LName: 'Test', FName: 'MangoTest' }),
  });
}

const CROWN = {
  teeth: [3],
  code: 'Crown',
  category: 'Restorative',
  surfaces: [],
  dx: ['D'],
  priority: 'urgent',
  motivation: ['pain'],
  status: 'proposed',
  scheduleNext: true,
  photos: [],
};

/** Open a visit with one item and an ENTIRELY unanswered slip. */
async function visitWithNothingAnswered(app) {
  await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
  await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + Q, { body: { slip: emptySlip() } });
  const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, { body: CROWN });
  assert.equal(res.status, 201);
  return res.body;
}

test('an unanswered "recare scheduled" does not stop anything being staged', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    const before = await visitWithNothingAnswered(app);
    assert.equal(before.visit.slip.recareScheduled, null, 'nobody answered it');
    assert.equal(before.visit.slip.txEnteredInOd, null);
    // The crown needs records nobody has taken. Also not a gate.
    assert.ok(before.recordsNeeded.length > 0);

    for (const kind of ['router', 'note', 'tc-handoff']) {
      const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
        body: { kind },
      });
      assert.equal(res.status, 201, `${kind} must stage with an unanswered slip`);
    }

    const final = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001' + Q);
    assert.deepEqual(
      final.body.visit.stagedWrites.map((w) => w.kind).sort(),
      ['note', 'router', 'tc-handoff']
    );
    for (const w of final.body.visit.stagedWrites) assert.equal(w.state, 'Staged');
  } finally {
    await app.close();
  }
});

test('the slip SAYS what was not answered rather than refusing to print', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await visitWithNothingAnswered(app);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });
    const preview = res.body.visit.stagedWrites[0].preview;
    // "not answered" and "No" are different sentences, and the front desk acts
    // on the difference.
    assert.ok(preview.includes('Recare scheduled: not answered'));
    assert.ok(preview.includes('Treatment entered in Open Dental: not answered'));
  } finally {
    await app.close();
  }
});

test('a client cannot ask for a state, and cannot supply the words either', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await visitWithNothingAnswered(app);

    for (const body of [
      { kind: 'router', state: 'Written' },
      { kind: 'router', sentBy: 'somebody@carein.ai' },
      { kind: 'router', preview: ['whatever I like'] },
    ]) {
      const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
        body,
      });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_BODY');
    }

    // And nothing was stored by any of them.
    assert.equal(app.db.hyg_staged_write.length, 0);
  } finally {
    await app.close();
  }
});

test('a write that has left Draft/Staged is immutable to this slice', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await visitWithNothingAnswered(app);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });

    // Stand in for slice 3 having sent it. Reaching into the row is the only
    // way to reach these states, which is the property under test.
    app.db.hyg_staged_write[0].state = 'Written';
    app.db.hyg_staged_write[0].sent_by = 'hygienist@carein.ai';
    app.db.hyg_staged_write[0].sent_at = new Date();

    const restage = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });
    assert.equal(restage.status, 409);
    assert.equal(restage.body.code, 'STAGED_WRITE_IMMUTABLE');

    const unstage = await api(
      app.baseUrl,
      'DELETE',
      '/api/hyg/visit/900001/staged-writes/router' + Q
    );
    assert.equal(unstage.status, 409);
    assert.equal(unstage.body.code, 'STAGED_WRITE_IMMUTABLE');

    // The record of what went to a chart is intact.
    assert.equal(app.db.hyg_staged_write.length, 1);
    assert.equal(app.db.hyg_staged_write[0].state, 'Written');
    assert.equal(app.db.hyg_staged_write[0].sent_by, 'hygienist@carein.ai');
  } finally {
    await app.close();
  }
});

test('re-staging while Staged REPLACES what will be sent, rather than adding a second one', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await visitWithNothingAnswered(app);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });

    // She adds another item and stages again. Staging the router twice is an
    // EDIT of what will be sent, not a second thing to send.
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + Q, {
      body: { ...CROWN, teeth: [14], code: 'Comp' },
    });
    const again = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });
    assert.equal(again.status, 201);
    assert.equal(again.body.visit.stagedWrites.length, 1);
    assert.ok(
      again.body.visit.stagedWrites[0].preview.some((l) => l.includes('Comp')),
      'the newer item is on the slip'
    );
    assert.equal(app.db.hyg_staged_write.length, 1);
  } finally {
    await app.close();
  }
});

test('a handoff with no treatment on it is refused, not sent empty', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + Q);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'tc-handoff' },
    });
    // An empty case in a treatment coordinator's queue is worse than no case.
    // Note this is the ONLY refusal on the staging path, and it is about there
    // being nothing to send — not about a form being incomplete.
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'NOTHING_TO_STAGE');

    // The router and the note DO stage from the same empty visit: they are
    // records of an appointment that happened, which it did.
    const router = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });
    assert.equal(router.status, 201);
  } finally {
    await app.close();
  }
});

test('perio refuses honestly instead of staging an empty envelope', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await visitWithNothingAnswered(app);
    const res = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'perio' },
    });
    assert.equal(res.status, 422);
    assert.equal(res.body.code, 'STAGED_WRITE_KIND_UNAVAILABLE');
    // Says WHY, and the why is the contingency: a perio measurement written
    // into Open Dental cannot be deleted.
    assert.match(res.body.error, /cannot be deleted/);
    assert.equal(app.db.hyg_staged_write.length, 0);
  } finally {
    await app.close();
  }
});

test('un-staging a Staged write removes it, and un-staging nothing is a 404', async () => {
  const app = await bootHygApp({ od: dayOd() });
  try {
    await visitWithNothingAnswered(app);
    await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + Q, {
      body: { kind: 'router' },
    });

    const gone = await api(app.baseUrl, 'DELETE', '/api/hyg/visit/900001/staged-writes/router' + Q);
    assert.equal(gone.status, 200);
    assert.deepEqual(gone.body.visit.stagedWrites, []);

    const again = await api(app.baseUrl, 'DELETE', '/api/hyg/visit/900001/staged-writes/router' + Q);
    assert.equal(again.status, 404);
    assert.equal(again.body.code, 'STAGED_WRITE_NOT_FOUND');

    // A kind off the path is validated the same way a body would be, rather
    // than trusted because it is shorter.
    const bogus = await api(app.baseUrl, 'DELETE', '/api/hyg/visit/900001/staged-writes/nope' + Q);
    assert.equal(bogus.status, 400);
  } finally {
    await app.close();
  }
});
