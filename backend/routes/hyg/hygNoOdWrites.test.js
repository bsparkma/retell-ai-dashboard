'use strict';

/**
 * NOTHING IN THE HYGIENE MODULE MAY WRITE TO OPEN DENTAL — enforced, not asserted
 * in prose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE, AND WHAT IT WILL BECOME
 * ═════════════════════════════════════════════════════════════════════════════
 * H1 slice 1 is read-only. Slice 3 introduces the module's first Open Dental
 * write — the routing slip as a PDF into the patient's images — and when it
 * does, this flat invariant must be REPLACED by an enumerated allow-list of one
 * file, exactly as routes/rcm/rcmNoOdWrites.test.js was when the drain arrived.
 * It must not be deleted. Deleting the guard is how a guard quietly stops
 * guarding, and the second writer is always the one nobody reviewed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * TWO STATEMENTS, AND WHY BOTH ARE NEEDED
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. BEHAVIOURAL. Driving the day route to SUCCESS against an Open Dental
 *    client whose every write verb THROWS proves no write verb was reached,
 *    because reaching one would have failed the request. This is the statement
 *    that survives refactoring: it does not care what the code looks like.
 *
 * 2. SOURCE SCAN. The behavioural claim only covers the paths a test drives. A
 *    write on a branch no test reaches — a slice-2 handler added next month, an
 *    error path — would pass it. So every source file in the module is also
 *    scanned for the transport's write verb by NAME.
 *
 * Neither is sufficient alone, which is why RCM's equivalent carries both.
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { FakeOd, bootHygApp, api, apptRow, patientRow, operatoryRow } = require('./hygTestUtils');

const DATE = '2026-09-08';

// ── 1. behavioural ──────────────────────────────────────────────────────────

test('driving the day route to SUCCESS reaches no Open Dental write verb', async () => {
  const od = new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
  });

  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 200, 'the route must actually SUCCEED, or this proves nothing');
    assert.equal(res.body.appointments.length, 1);

    // FakeOd's apiWriteRaw / post / put / patch / delete all record and throw.
    assert.deepEqual(od.writes, [], 'not one write verb was reached');
    // And every call that WAS made is a GET on a read-only path.
    assert.ok(od.calls.length > 0, 'the route did read Open Dental');
    for (const c of od.calls) {
      assert.match(
        c.path,
        /^\/(appointments|operatories|appointmenttypes|providers|patients)/,
        'unexpected Open Dental path: ' + c.path
      );
    }
  } finally {
    await app.close();
  }
});

test('every refusal path also reaches no Open Dental write verb', async () => {
  // The error branches are where a write is most likely to be added carelessly
  // ("record the failure back into the chart"), and least likely to be covered
  // by a happy-path test.
  const cases = [
    { qs: '?office=nope&date=' + DATE, status: 400 },
    { qs: '?office=roland&date=2026-02-31', status: 400 },
    { qs: '?office=valley&date=' + DATE, status: 409 },
  ];

  for (const c of cases) {
    const od = new FakeOd({});
    const app = await bootHygApp({ od, hygOffices: ['roland'] });
    try {
      const res = await api(app.baseUrl, 'GET', '/api/hyg/day' + c.qs);
      assert.equal(res.status, c.status, c.qs);
      assert.deepEqual(od.writes, [], 'no write verb on the refusal path ' + c.qs);
    } finally {
      await app.close();
    }
  }

  // And the outage path, which DOES reach Open Dental.
  const od = new FakeOd({
    '/appointments': { ok: false, status: 503, data: null, error: 'down' },
  });
  const app = await bootHygApp({ od });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/hyg/day?office=roland&date=' + DATE);
    assert.equal(res.status, 502);
    assert.deepEqual(od.writes, [], 'an outage must not provoke a write either');
  } finally {
    await app.close();
  }
});

// ── 2. source scan ──────────────────────────────────────────────────────────

/** Every .js file in the hygiene module, routes and services alike. */
function hygSources() {
  const roots = [
    path.join(__dirname),
    path.join(__dirname, '..', '..', 'services', 'hyg'),
  ];
  /** @type {string[]} */
  const files = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.js')) continue;
      files.push(path.join(root, name));
    }
  }
  return files;
}

test('the module owns source files, so the scan below is scanning something', () => {
  // A scan over an empty file list passes vacuously and would keep passing if
  // the module were renamed out from under it.
  const files = hygSources();
  assert.ok(files.length >= 4, 'expected the hyg routes and services, found ' + files.length);
  assert.ok(files.some((f) => f.endsWith('day.js')));
  assert.ok(files.some((f) => f.endsWith('odDay.js')));
});

test('no hyg source names the Open Dental WRITE transport', () => {
  // `apiWriteRaw` is the ONE method on config/openDental.js that can POST or PUT
  // to Open Dental (there is deliberately no DELETE). RCM names it in exactly
  // one file and fails the build if a second one does; hyg names it in none.
  const offenders = [];
  for (const file of hygSources()) {
    const src = fs.readFileSync(file, 'utf8');
    // This test file and the harness both mention it BY DESIGN — the harness
    // defines the throwing stub, and this file explains why. Skipping them by
    // name rather than by a comment marker keeps the exemption enumerated.
    if (file.endsWith('hygNoOdWrites.test.js') || file.endsWith('hygTestUtils.js')) continue;
    if (/apiWriteRaw/.test(src)) offenders.push(path.basename(file));
  }
  assert.deepEqual(offenders, [], 'these files reach an Open Dental write verb');
});

test('no hyg source issues a POST, PUT or PATCH through any client', () => {
  // Broader than the verb name: `client.post(...)`, `client.put(...)` and
  // `axios.patch(...)` bypass apiWriteRaw entirely, which is exactly how
  // config/openDental.js's own bookAppointment reaches Open Dental today.
  const offenders = [];
  for (const file of hygSources()) {
    if (file.endsWith('hygNoOdWrites.test.js') || file.endsWith('hygTestUtils.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    const hit = src.match(/\.(post|put|patch)\s*\(/);
    if (hit) offenders.push(path.basename(file) + ' -> ' + hit[0]);
  }
  assert.deepEqual(offenders, [], 'these files issue a write-shaped call');
});

test('no hyg ROUTE is registered on a non-GET method', () => {
  // The module has no mutation in slice 1, so the mount's
  // requireReadWrite('hyg.read','hyg.write') is currently unexercised — which
  // means a POST added without a permission gate would inherit hyg.write by
  // construction and nobody would notice the tier had arrived. This makes
  // slice 2's first mutation a deliberate edit to this test.
  const offenders = [];
  for (const file of hygSources()) {
    if (file.endsWith('.test.js') || file.endsWith('hygTestUtils.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    const hits = [...src.matchAll(/router\.(post|put|patch|delete)\s*\(/g)];
    for (const hit of hits) offenders.push(path.basename(file) + ' -> router.' + hit[1]);
  }
  assert.deepEqual(offenders, [], 'slice 1 is read-only; a mutation belongs to slice 2');
});
