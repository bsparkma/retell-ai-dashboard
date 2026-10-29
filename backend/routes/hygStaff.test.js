'use strict';

/**
 * /api/platform/hyg-staff — the Practice staff page — and the note line it
 * feeds, through the assembled app (the Users page's admin.all gate, mounted
 * as server.js mounts it).
 *
 *   - the gate: an admin edits; a hygienist or the front office gets 403
 *   - office isolation: a row is only ever seen or changed under its office
 *   - sign-in ids are unique per office (409), and free across offices
 *   - one audit row per write, refusals included, with what changed
 *   - honest states: a write that cannot be read back is not a success
 *   - the note: config fallback while the table is empty; a deactivated row is
 *     not matched; a missing licence prints the name alone; two staff sharing a
 *     name each get their own licence, matched on sign-in
 *
 * Synthetic staff only (Avery / Jamie Example). Roland 12827 is the fixture
 * patient for the note.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { FakeHygDb, FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hyg/hygTestUtils');
const { useSyntheticStaff } = require('../config/hygStaff.fixture');

useSyntheticStaff();

const DATE = '2026-09-08';
const BASE = '/api/platform/hyg-staff';
const ADMIN = { email: 'om@carein.ai', name: 'Office Manager', tenantId: 'x' };

const AVERY = { fullName: 'Avery Example', license: '9101', signInIds: ['Avery.Example@carein.ai'] };
const JAMIE = { fullName: 'Jamie Example', license: null, signInIds: ['jamie.example@carein.ai', 'Jamie E'] };

function od() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/procedurelogs': [],
    '/procedurelogs/GroupNotes': [],
    '/definitions': [{ DefNum: 473, ItemName: 'Routers' }],
  });
}

function admin(db = new FakeHygDb()) {
  return bootHygApp({ db, user: ADMIN, role: 'admin', hygOffices: ['roland', 'valley'] });
}

const staffAudit = (db) => db.audit.filter((r) => r.resource_type === 'hyg_staff');

/** Stage the note as `user` (a hygienist) and return its typed-name lines. */
async function noteLines(db, user) {
  const app = await bootHygApp({ db, od: od(), user: { ...user, tenantId: 'x' }, role: 'hygiene' });
  try {
    const q = '?office=roland&date=' + DATE;
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + q)).status, 200);
    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + q, { body: { kind: 'note' } });
    assert.equal(staged.status, 201, JSON.stringify(staged.body));
    const preview = staged.body.visit.stagedWrites.find((w) => w.kind === 'note').preview;
    // The typed-name line sits directly above the "Unsigned." line.
    const unsigned = preview.findIndex((l) => /Unsigned\./.test(l));
    return { preview, nameLine: preview[unsigned - 1] };
  } finally {
    await app.close();
  }
}

// ── the gate ────────────────────────────────────────────────────────────────

test('role gate: an admin lists the office; a hygienist and the front office are refused 403', async () => {
  const db = new FakeHygDb();
  for (const role of ['hygiene', 'office']) {
    const app = await bootHygApp({ db, role, hygOffices: ['roland'] });
    try {
      const list = await api(app.baseUrl, 'GET', BASE + '?office=roland');
      assert.equal(list.status, 403, role);
      const add = await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY });
      assert.equal(add.status, 403, role);
    } finally {
      await app.close();
    }
  }
  assert.equal(db.hyg_staff.length, 0, 'nothing was written by a refused role');

  const app = await admin(db);
  try {
    const list = await api(app.baseUrl, 'GET', BASE + '?office=roland');
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.deepEqual(list.body, { success: true, office: 'roland', staff: [], usingBuiltInList: true });
  } finally {
    await app.close();
  }
});

test('the office is validated against the frozen keys, never free text', async () => {
  const app = await admin();
  try {
    for (const q of ['', '?office=unknown', '?office=Roland', '?office=riley']) {
      const res = await api(app.baseUrl, 'GET', BASE + q);
      assert.equal(res.status, 400, q);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
  } finally {
    await app.close();
  }
});

// ── create, edit, deactivate ────────────────────────────────────────────────

test('add: the row comes back as read, normalised, with no placeholder licence', async () => {
  const app = await admin();
  try {
    const res = await api(app.baseUrl, 'POST', BASE + '?office=roland', {
      body: { fullName: '  Jamie   Example ', license: '   ', signInIds: ['Jamie.Example@CareIN.ai', ' jamie.example@carein.ai '] },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const s = res.body.staff;
    assert.equal(s.fullName, 'Jamie Example');
    assert.equal(s.license, null, 'a blank licence is none on file, never ""');
    assert.deepEqual(s.signInIds, ['jamie.example@carein.ai'], 'lowercased and de-duplicated');
    assert.equal(s.active, true);
    assert.equal(s.office, 'roland');
    assert.equal(s.createdBy, 'om@carein.ai');

    const list = await api(app.baseUrl, 'GET', BASE + '?office=roland');
    assert.equal(list.body.usingBuiltInList, false);
    assert.equal(list.body.staff.length, 1);
  } finally {
    await app.close();
  }
});

test('add: a name and at least one sign-in are required; the body cannot name an office', async () => {
  const app = await admin();
  try {
    for (const [body, field] of [
      [{ ...AVERY, fullName: '   ' }, 'fullName'],
      [{ ...AVERY, signInIds: [] }, 'signInIds'],
      [{ ...AVERY, signInIds: ['  '] }, 'signInIds'],
      [{ ...AVERY, office: 'valley' }, 'body'],
    ]) {
      const res = await api(app.baseUrl, 'POST', BASE + '?office=roland', { body });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, 'INVALID_BODY');
      if (field !== 'body') assert.equal(res.body.field, field);
    }
    assert.equal(app.db.hyg_staff.length, 0);
  } finally {
    await app.close();
  }
});

test('edit, deactivate and reactivate — each audited with what it replaced; there is no delete', async () => {
  const app = await admin();
  try {
    const created = (await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY })).body.staff;
    const edited = await api(app.baseUrl, 'PUT', `${BASE}/${created.id}?office=roland`, {
      body: { ...AVERY, license: null, signInIds: ['avery.example@carein.ai', 'avery@carein.ai'] },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.staff.license, null);
    assert.deepEqual(edited.body.staff.signInIds, ['avery.example@carein.ai', 'avery@carein.ai']);

    const off = await api(app.baseUrl, 'POST', `${BASE}/${created.id}/deactivate?office=roland`);
    assert.equal(off.status, 200);
    assert.equal(off.body.staff.active, false);
    const on = await api(app.baseUrl, 'POST', `${BASE}/${created.id}/reactivate?office=roland`);
    assert.equal(on.body.staff.active, true);

    const del = await api(app.baseUrl, 'DELETE', `${BASE}/${created.id}?office=roland`);
    assert.ok(del.status === 404 || del.status === 403, 'no delete route: ' + del.status);
    assert.equal(app.db.hyg_staff.length, 1, 'the row is still there');

    // ONE AUDIT ROW PER WRITE, with what it replaced — and never the typed text.
    const rows = staffAudit(app.db);
    assert.deepEqual(
      rows.map((r) => [r.action, r.result, r.office, r.resource_id, r.prior_state]),
      [
        ['CREATE', 'SUCCESS', 'roland', created.id, null],
        ['UPDATE', 'SUCCESS', 'roland', created.id, 'edited:licence_sign_ins'],
        ['UPDATE', 'SUCCESS', 'roland', created.id, 'active'],
        ['UPDATE', 'SUCCESS', 'roland', created.id, 'inactive'],
      ]
    );
    const trail = JSON.stringify(rows);
    assert.ok(!trail.includes('Avery'), 'no name in the trail');
    assert.ok(!trail.toLowerCase().includes('avery'), 'no sign-in in the trail');
    assert.ok(!trail.includes('9101'), 'no licence in the trail');
    for (const r of rows) assert.match(String(r.prior_state ?? 'x'), /^[a-z0-9_]{1,32}(:[a-z0-9_]{1,31})?$/);
  } finally {
    await app.close();
  }
});

// ── uniqueness and isolation ────────────────────────────────────────────────

test('a sign-in id is unique per office (409, audited), and free in the other office', async () => {
  const app = await admin();
  try {
    const avery = (await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY })).body.staff;
    const clash = await api(app.baseUrl, 'POST', BASE + '?office=roland', {
      body: { fullName: 'Someone Else', license: null, signInIds: ['AVERY.EXAMPLE@carein.ai', 'new@carein.ai'] },
    });
    assert.equal(clash.status, 409, JSON.stringify(clash.body));
    assert.equal(clash.body.code, 'SIGN_IN_TAKEN');
    assert.deepEqual(clash.body.taken, ['avery.example@carein.ai']);

    // An edit that would take another row's id is refused the same way.
    const jamie = (await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: JAMIE })).body.staff;
    const steal = await api(app.baseUrl, 'PUT', `${BASE}/${jamie.id}?office=roland`, {
      body: { ...JAMIE, signInIds: [...JAMIE.signInIds, 'avery.example@carein.ai'] },
    });
    assert.equal(steal.status, 409);
    assert.equal(app.db.hyg_staff.find((s) => s.id === jamie.id).sign_in_ids.length, 2, 'unchanged');

    // A DEACTIVATED row still holds its sign-ins.
    await api(app.baseUrl, 'POST', `${BASE}/${avery.id}/deactivate?office=roland`);
    const again = await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: { ...AVERY, fullName: 'Avery Again' } });
    assert.equal(again.status, 409);

    // The other office is its own namespace.
    const valley = await api(app.baseUrl, 'POST', BASE + '?office=valley', { body: AVERY });
    assert.equal(valley.status, 201, JSON.stringify(valley.body));

    const refused = staffAudit(app.db).filter((r) => r.result === 'ERROR');
    assert.equal(refused.length, 3, 'every refused write has its audit row');
  } finally {
    await app.close();
  }
});

test('the database backstop: a racing save that slips past the check is still a 409', async () => {
  const app = await admin();
  try {
    await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY });
    // Make the statement's own NOT EXISTS miss, as a concurrent insert would:
    // only the table's trigger (FakeHygDb.checkStaff) can refuse it now.
    const real = app.db.staffOverlap.bind(app.db);
    app.db.staffOverlap = () => false;
    const res = await api(app.baseUrl, 'POST', BASE + '?office=roland', {
      body: { fullName: 'Racing Save', license: null, signInIds: ['avery.example@carein.ai'] },
    });
    app.db.staffOverlap = real;
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'SIGN_IN_TAKEN');
    assert.equal(app.db.hyg_staff.length, 1);
  } finally {
    await app.close();
  }
});

test('office isolation: a roland row is not seen, edited or deactivated under valley', async () => {
  const app = await admin();
  try {
    const avery = (await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY })).body.staff;
    const list = await api(app.baseUrl, 'GET', BASE + '?office=valley');
    assert.deepEqual(list.body.staff, []);
    assert.equal(list.body.usingBuiltInList, true);

    const put = await api(app.baseUrl, 'PUT', `${BASE}/${avery.id}?office=valley`, { body: { ...AVERY, fullName: 'Changed' } });
    assert.equal(put.status, 404);
    const off = await api(app.baseUrl, 'POST', `${BASE}/${avery.id}/deactivate?office=valley`);
    assert.equal(off.status, 404);
    const row = app.db.hyg_staff[0];
    assert.equal(row.full_name, 'Avery Example');
    assert.equal(row.active, true);

    const bad = await api(app.baseUrl, 'PUT', `${BASE}/not-a-uuid?office=roland`, { body: AVERY });
    assert.equal(bad.status, 404, 'a malformed id names no row');
  } finally {
    await app.close();
  }
});

test('honest states: a write whose row cannot be read back is SAVE_NOT_CONFIRMED, not success', async () => {
  const app = await admin();
  try {
    const real = app.db.queryStaff.bind(app.db);
    let inserted = false;
    app.db.queryStaff = (text, params) => {
      if (/^\s*INSERT INTO hyg_staff/i.test(text)) inserted = true;
      else if (inserted && /WHERE office = \$1 AND id = \$2\s*$/i.test(text)) return { rows: [], rowCount: 0 };
      return real(text, params);
    };
    const res = await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'SAVE_NOT_CONFIRMED');
    assert.equal(res.body.success, false);
    assert.equal(staffAudit(app.db).at(-1).result, 'ERROR');
  } finally {
    await app.close();
  }
});

// ── the note ────────────────────────────────────────────────────────────────

test('fallback: an office with NO rows prints from the config list (synthetic here)', async () => {
  const { nameLine } = await noteLines(new FakeHygDb(), { email: 'someone@carein.ai', name: 'Avery Example' });
  assert.equal(nameLine, 'Avery Example RDH #9101');
});

test('the table, once it has rows, is the whole answer: matched on sign-in, deactivation unmatches', async () => {
  const db = new FakeHygDb();
  const app = await admin(db);
  let avery;
  try {
    avery = (await api(app.baseUrl, 'POST', BASE + '?office=roland', {
      body: { fullName: 'Avery Example', license: '7777', signInIds: ['avery.example@carein.ai'] },
    })).body.staff;
  } finally {
    await app.close();
  }

  // Signed in with the listed email, under a display name the table never saw.
  const signedIn = { email: 'Avery.Example@carein.ai', name: 'A. E.' };
  assert.equal((await noteLines(db, signedIn)).nameLine, 'Avery Example RDH #7777', 'the TABLE licence, not config');

  // The name alone does not match a table row: the config list is not
  // consulted once the office has rows, so this prints what she signed in as.
  const nameOnly = await noteLines(db, { email: 'other@carein.ai', name: 'Avery Example' });
  assert.equal(nameOnly.nameLine, 'Avery Example');
  assert.ok(!nameOnly.preview.join('\n').includes('#9101'), 'no config licence leaks in');

  // Deactivated: no longer matched — the sign-in prints as the bare name.
  const again = await admin(db);
  try {
    assert.equal((await api(again.baseUrl, 'POST', `${BASE}/${avery.id}/deactivate?office=roland`)).status, 200);
  } finally {
    await again.close();
  }
  const after = await noteLines(db, signedIn);
  assert.equal(after.nameLine, 'A. E.');
  assert.ok(!after.preview.join('\n').includes('7777'));
});

test('a licence missing on the row prints the full name ONLY — never a placeholder', async () => {
  const db = new FakeHygDb();
  const app = await admin(db);
  try {
    await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: JAMIE });
  } finally {
    await app.close();
  }
  const { nameLine } = await noteLines(db, { email: 'jamie.example@carein.ai', name: 'J' });
  assert.equal(nameLine, 'Jamie Example');
  assert.doesNotMatch(nameLine, /#|RDH|TBD|XXXX/);
});

test('two staff may share a name; each is told apart by sign-in and prints her own licence', async () => {
  const db = new FakeHygDb();
  const app = await admin(db);
  try {
    for (const [email, license] of [['first@carein.ai', '1111'], ['second@carein.ai', '2222']]) {
      const res = await api(app.baseUrl, 'POST', BASE + '?office=roland', {
        body: { fullName: 'Casey Example', license, signInIds: [email] },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
  } finally {
    await app.close();
  }
  assert.equal((await noteLines(db, { email: 'first@carein.ai', name: 'C' })).nameLine, 'Casey Example RDH #1111');
  assert.equal((await noteLines(db, { email: 'second@carein.ai', name: 'C' })).nameLine, 'Casey Example RDH #2222');
});

test('a roland row never prints on a note for the other office', async () => {
  // The roster is read with the note's own office; a valley row is not in it.
  const db = new FakeHygDb();
  const app = await admin(db);
  try {
    await api(app.baseUrl, 'POST', BASE + '?office=valley', {
      body: { fullName: 'Valley Only', license: '3333', signInIds: ['valley.only@carein.ai'] },
    });
  } finally {
    await app.close();
  }
  // Roland has no rows: the config fallback, and the valley row is not matched.
  const { preview, nameLine } = await noteLines(db, { email: 'valley.only@carein.ai', name: 'V' });
  assert.equal(nameLine, 'V');
  assert.ok(!preview.join('\n').includes('3333'));
});

// ── review round 1 ──────────────────────────────────────────────────────────

test('a save whose audit row then fails says it WAS saved, not that nothing happened', async () => {
  const app = await admin();
  try {
    app.db.failAudit = true;
    const res = await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY });
    assert.equal(res.status, 500);
    assert.equal(res.body.code, 'SAVED_AUDIT_FAILED');
    assert.match(res.body.error, /was saved/);
    assert.equal(app.db.hyg_staff.length, 1, 'the row did land');
  } finally {
    await app.close();
  }
});

test('the test seam refuses to run in production', () => {
  const hygStaff = require('../config/hygStaff');
  const was = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => hygStaff.setRosterForTests(null), /refuses to run in production/);
  } finally {
    if (was === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = was;
  }
});

test('a session email with stray case and padding still matches its stored sign-in', async () => {
  const db = new FakeHygDb();
  const app = await admin(db);
  try {
    await api(app.baseUrl, 'POST', BASE + '?office=roland', { body: AVERY });
  } finally {
    await app.close();
  }
  const { nameLine } = await noteLines(db, { email: '  AVERY.example@CareIN.ai ', name: 'A' });
  assert.equal(nameLine, 'Avery Example RDH #9101');
});
