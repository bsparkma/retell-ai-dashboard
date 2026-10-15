'use strict';

/**
 * /api/tc/hygiene-intakes — the intake kinds and the source key (queue item 49).
 *
 *   - A repeat `sourceKey` returns the case it already made, for the treatment
 *     AND the ortho kind: a lost response plus a resend opens one case, not two.
 *   - A racing duplicate that only the unique index catches (23505) answers
 *     with the winner's case.
 *   - `kind: 'checkout'` stores a handoff and opens NO case; a repeat key
 *     updates the snapshot; a final snapshot is never rolled back by a
 *     non-final one; a key that comes back with another PatNum is refused.
 *   - Off for the office → 403 CHECKOUT_DISABLED, nothing stored.
 *   - Office-scoped: the same key in another office is another handoff.
 *
 * Test patients only (roland 12827 / 12828). The patient names below are
 * synthetic.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../../platform/registry');
const tcCheckout = require('../../config/tcCheckout');
const hygContract = require('../../hyg/contract.gen.cjs');
const { bootTcApp, api, auditRows } = require('./tcTestUtils');

const POST = (office) => `/api/tc/hygiene-intakes?office=${office}`;

const INTAKE = {
  patientName: 'Test, MangoTest',
  odPatientId: 12828,
  diagnosingProvider: 'DOC1',
  category: 'single_tooth',
  urgency: 'medium',
  perioStatus: 'gingivitis',
  recallType: 'prophy',
  radiographs: ['BWX'],
  intraoralPhotosTaken: false,
  patientInterestLevel: 'unknown',
  flagUrgent: false,
};

const SNAPSHOT = {
  procedures: [
    {
      teeth: [3],
      code: 'Crown',
      category: 'Restorative',
      priority: 'urgent',
      status: 'proposed',
      surfaces: ['O'],
      scheduleNext: true,
      note: '',
    },
  ],
  priority: 'urgent',
  nextVisit: { type: 'Prophy', intervalMonths: 6, lengthMin: 60, withDoctor: true, rtc: '6 mo' },
  notesPending: true,
  frontDeskNote: '',
  financialNote: '',
};

function checkoutBody(over = {}) {
  return {
    kind: 'checkout',
    sourceKey: 'hyg-visit:visit-0001:checkout',
    final: false,
    patientName: 'Test 2, Stedi',
    odPatientId: 12827,
    provider: 'DOC1',
    providerSeen: 'HYG1',
    operatory: 'Hyg 1',
    visitDate: '2026-09-08',
    snapshot: SNAPSHOT,
    ...over,
  };
}

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

async function boot(t, opts) {
  const app = await bootTcApp(opts);
  t.after(() => app.close());
  return app;
}

/** A jsonb cell: real pg returns an object; the fake keeps an UPDATE's string. */
function jsonb(v) {
  return typeof v === 'string' ? JSON.parse(v) : v;
}

// ── the source key on case-creating intakes ────────────────────────────────

test('a resend with the same sourceKey returns the SAME case — treatment kind', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const body = { ...INTAKE, kind: 'hygiene', sourceKey: 'hyg-visit:visit-0001:handoff' };

  const first = await api(baseUrl, 'POST', POST('roland'), body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.replayed, false);

  // The response was "lost"; the caller sends again.
  const again = await api(baseUrl, 'POST', POST('roland'), body);
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.case.caseId, first.body.case.caseId);

  assert.equal(db.table('tc_cases').length, 1, 'ONE case, not two');
  assert.equal(db.table('tc_hygiene_intakes').length, 1);
  assert.equal(db.table('tc_hygiene_intakes')[0].source_key, 'hyg-visit:visit-0001:handoff');
  const creates = auditRows(db).filter((r) => r.action === 'CREATE' && r.resource_type === 'tc_hygiene_intake');
  assert.equal(creates.length, 1, 'a replay is not a second create');
});

test('a resend with the same sourceKey returns the SAME case — ortho kind', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const screening = { ...hygContract.emptyOrthoScreening(), interest: 'yes' };
  const body = {
    ...INTAKE,
    category: 'ortho',
    urgency: 'elective',
    caseType: 'Ortho screening',
    orthoScreening: screening,
    kind: 'ortho',
    sourceKey: 'hyg-visit:visit-0001:ortho',
  };
  const first = await api(baseUrl, 'POST', POST('roland'), body);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const again = await api(baseUrl, 'POST', POST('roland'), body);
  assert.equal(again.status, 200);
  assert.equal(again.body.case.caseId, first.body.case.caseId);
  assert.equal(db.table('tc_cases').length, 1);
});

test('the same key in ANOTHER office is another intake (keys are per office)', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const body = { ...INTAKE, sourceKey: 'hyg-visit:visit-0001:handoff' };
  assert.equal((await api(baseUrl, 'POST', POST('roland'), body)).status, 201);
  assert.equal((await api(baseUrl, 'POST', POST('valley'), body)).status, 201);
  assert.equal(db.table('tc_cases').length, 2);
});

test('no sourceKey: the pre-item-49 behaviour, unchanged (each submit is a case)', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), INTAKE)).status, 201);
  assert.equal((await api(baseUrl, 'POST', POST('roland'), INTAKE)).status, 201);
  assert.equal(db.table('tc_cases').length, 2);
});

test('a race only the unique index catches (23505) answers with the winner', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const key = 'hyg-visit:visit-0002:handoff';
  const winner = await api(baseUrl, 'POST', POST('roland'), { ...INTAKE, sourceKey: key });
  assert.equal(winner.status, 201);

  // Stand in for a second request that read "no such key" before the winner
  // committed: its fast-path read misses once, and the index refuses its write.
  let misses = 1;
  db.onQuery(/^SELECT case_id FROM tc_hygiene_intakes WHERE office_id = \$1 AND source_key = \$2$/, (text, params) => {
    if (misses > 0) {
      misses -= 1;
      return { rows: [] };
    }
    const rows = db
      .table('tc_hygiene_intakes')
      .filter((r) => r.office_id === params[0] && r.source_key === params[1])
      .map((r) => ({ case_id: r.case_id }));
    return { rows };
  });
  db.onQuery(/^UPDATE tc_hygiene_intakes SET source_key/, () => {
    const err = /** @type {Error & { code?: string }} */ (new Error('duplicate key value'));
    err.code = '23505';
    throw err;
  });

  const loser = await api(baseUrl, 'POST', POST('roland'), { ...INTAKE, sourceKey: key });
  assert.equal(loser.status, 200, JSON.stringify(loser.body));
  assert.equal(loser.body.replayed, true);
  assert.equal(loser.body.case.caseId, winner.body.case.caseId);
});

test('a declared kind must match what rides along', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const ortho = await api(baseUrl, 'POST', POST('roland'), { ...INTAKE, kind: 'ortho' });
  assert.equal(ortho.status, 400);
  assert.equal(ortho.body.code, 'INTAKE_KIND_MISMATCH');
  const screening = { ...hygContract.emptyOrthoScreening(), interest: 'yes' };
  const treatment = await api(baseUrl, 'POST', POST('roland'), {
    ...INTAKE,
    kind: 'hygiene',
    orthoScreening: screening,
  });
  assert.equal(treatment.status, 400);
  assert.equal(db.table('tc_cases').length, 0);
});

test('a malformed sourceKey is a 400, not a stored identifier', async (t) => {
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const res = await api(baseUrl, 'POST', POST('roland'), { ...INTAKE, sourceKey: 'has spaces in it' });
  assert.equal(res.status, 400);
  assert.equal(db.table('tc_cases').length, 0);
});

// ── kind: 'checkout' ───────────────────────────────────────────────────────

test('checkout OFF for the office → 403 CHECKOUT_DISABLED, nothing stored', async (t) => {
  switchCheckout(t, { roland: false, valley: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const res = await api(baseUrl, 'POST', POST('roland'), checkoutBody());
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'CHECKOUT_DISABLED');
  assert.equal(db.table('tc_checkout_handoffs').length, 0);
  assert.equal(db.table('tc_cases').length, 0);
});

test('checkout with NO stored row is OFF (the floor)', async (t) => {
  switchCheckout(t, null);
  const { baseUrl } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), checkoutBody())).status, 403);
});

test('checkout stores a handoff and opens NO case; a repeat key updates it; final is never rolled back', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });

  const first = await api(baseUrl, 'POST', POST('roland'), checkoutBody());
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.kind, 'checkout');
  assert.equal(first.body.replayed, false);
  const h = first.body.handoff;
  assert.equal(h.officeId, 'roland');
  assert.equal(h.odPatientId, 12827);
  assert.equal(h.final, false);
  assert.equal(h.revision, 1);
  assert.equal(h.submittedBy, 'tc@carein.ai', 'identity from the session');
  assert.equal(db.table('tc_cases').length, 0, 'a checkout opens NO case');

  // The visit Send's final snapshot: the SAME handoff, revised.
  const final = await api(
    baseUrl,
    'POST',
    POST('roland'),
    checkoutBody({ final: true, snapshot: { ...SNAPSHOT, notesPending: false, frontDeskNote: 'Afternoons.' } })
  );
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.handoff.handoffId, h.handoffId);
  assert.equal(final.body.handoff.revision, 2);
  assert.equal(final.body.handoff.final, true);
  assert.equal(final.body.handoff.snapshot.frontDeskNote, 'Afternoons.');

  // A late non-final resend cannot roll it back.
  const late = await api(baseUrl, 'POST', POST('roland'), checkoutBody());
  assert.equal(late.status, 200);
  assert.equal(late.body.replayed, true);
  assert.equal(late.body.handoff.revision, 2);
  const rows = db.table('tc_checkout_handoffs');
  assert.equal(rows.length, 1);
  assert.equal(jsonb(rows[0].payload).frontDeskNote, 'Afternoons.');

  const audits = auditRows(db).filter((r) => r.resource_type === 'tc_checkout_handoff');
  assert.deepEqual(
    audits.map((r) => r.action),
    ['CREATE', 'UPDATE'],
    'a create, an update, and no row for the replay'
  );
});

test('checkout: the same key carrying ANOTHER PatNum is refused, nothing changes', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), checkoutBody())).status, 201);
  const other = await api(baseUrl, 'POST', POST('roland'), checkoutBody({ odPatientId: 12828, final: true }));
  assert.equal(other.status, 409);
  assert.equal(other.body.code, 'SOURCE_KEY_CONFLICT');
  assert.equal(Number(db.table('tc_checkout_handoffs')[0].od_patient_id), 12827);
  assert.equal(db.table('tc_checkout_handoffs')[0].revision, 1);
});

test('checkout is office-scoped: the same key in another office is another handoff', async (t) => {
  switchCheckout(t, { roland: true, valley: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), checkoutBody())).status, 201);
  assert.equal((await api(baseUrl, 'POST', POST('valley'), checkoutBody({ odPatientId: 7115 }))).status, 201);
  const rows = db.table('tc_checkout_handoffs');
  assert.deepEqual(rows.map((r) => r.office_id).sort(), ['roland', 'valley']);
});

test('checkout bodies are strict: an unknown field is a 400', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  const res = await api(baseUrl, 'POST', POST('roland'), { ...checkoutBody(), officeId: 'valley' });
  assert.equal(res.status, 400);
  assert.equal(db.table('tc_checkout_handoffs').length, 0);
});

// ── the final update's revision swap (review round 1) ──────────────────────

/**
 * Make the next `n` revision swaps LOSE: before the UPDATE runs, a concurrent
 * non-final writer bumps the row's revision, so `revision = $11` matches
 * nothing — exactly what Postgres would answer after somebody else's commit.
 */
function loseSwaps(db, n) {
  let left = n;
  db.onQuery(/^UPDATE tc_checkout_handoffs SET/, (_text, params) => {
    const rows = db.table('tc_checkout_handoffs').filter((r) => r.office_id === params[0] && r.handoff_id === params[1]);
    if (left > 0) {
      left -= 1;
      for (const r of rows) r.revision = Number(r.revision) + 1; // the other writer's commit
      return { rows: [], rowCount: 0 };
    }
    const hit = rows.filter((r) => Number(r.revision) === Number(params[10]));
    for (const r of hit) {
      r.payload = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
      r.is_final = params[3];
      r.revision = params[4];
      r.updated_at = new Date();
    }
    return { rows: [], rowCount: hit.length };
  });
}

test('a FINAL submit that loses the revision swap re-reads and still lands as final', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), checkoutBody())).status, 201);

  loseSwaps(db, 2);
  const final = await api(
    baseUrl,
    'POST',
    POST('roland'),
    checkoutBody({ final: true, snapshot: { ...SNAPSHOT, notesPending: false } })
  );
  assert.equal(final.status, 200, JSON.stringify(final.body));
  assert.equal(final.body.replayed, false);
  assert.equal(final.body.handoff.final, true, 'TC holds the FINAL snapshot');
  assert.equal(final.body.handoff.snapshot.notesPending, false);
});

test('a FINAL submit that never wins the swap is REFUSED, never replayed as if final', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), checkoutBody())).status, 201);

  loseSwaps(db, 100);
  const final = await api(baseUrl, 'POST', POST('roland'), checkoutBody({ final: true }));
  assert.equal(final.status, 409);
  assert.equal(final.body.code, 'CHECKOUT_UPDATE_CONFLICT');
  assert.equal(db.table('tc_checkout_handoffs')[0].is_final, false, 'nothing claims final');
});

test('a NON-final submit that loses the swap simply yields to the winner', async (t) => {
  switchCheckout(t, { roland: true });
  const { baseUrl, db } = await boot(t, { role: 'hygiene' });
  assert.equal((await api(baseUrl, 'POST', POST('roland'), checkoutBody())).status, 201);
  loseSwaps(db, 1);
  const res = await api(baseUrl, 'POST', POST('roland'), checkoutBody());
  assert.equal(res.status, 200);
  assert.equal(res.body.replayed, true);
});
