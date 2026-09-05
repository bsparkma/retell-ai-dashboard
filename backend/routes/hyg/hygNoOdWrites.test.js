'use strict';

/**
 * NOTHING IN THE HYGIENE MODULE MAY WRITE TO OPEN DENTAL — enforced, not asserted
 * in prose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE, AND WHAT IT WILL BECOME
 * ═════════════════════════════════════════════════════════════════════════════
 * H1 slice 1 was read-only in both senses: no Open Dental write, and no route
 * at all that was not a GET. Slice 3 introduces the module's first Open Dental
 * write — the routing slip as a PDF into the patient's images — and when it
 * does, this flat invariant must be REPLACED by an enumerated allow-list of one
 * file, exactly as routes/rcm/rcmNoOdWrites.test.js was when the drain arrived.
 * It must not be deleted. Deleting the guard is how a guard quietly stops
 * guarding, and the second writer is always the one nobody reviewed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT SLICE 2 CHANGED HERE, AND WHY IT HAD TO
 * ═════════════════════════════════════════════════════════════════════════════
 * Slice 2 adds the visit workspace, which MUTATES — POST, PUT and DELETE — in
 * this platform's own Postgres. Two of the statements below could not tell that
 * apart from an Open Dental write and had to be sharpened:
 *
 *   - `no hyg source issues a POST, PUT or PATCH through any client` matched
 *     `\.(post|put|patch)\s*\(` anywhere, which `router.post(` satisfies. It now
 *     captures the RECEIVER of every such call and asserts the receiver set is
 *     exactly {router, app}. That is STRICTER in the direction that matters:
 *     the old regex could not have distinguished `client.post` from
 *     `this.od.client.put`, and this one names whatever it finds.
 *
 *   - `no hyg ROUTE is registered on a non-GET method` was written with the
 *     comment "slice 2's first mutation is a deliberate edit to this test", and
 *     this is that edit. It becomes a ONE-FILE ALLOW-LIST for mutations, the
 *     same shape slice 3 will give the Open Dental write: routes/hyg/visit.js
 *     may register non-GET routes and no other file may, so a second file
 *     learning to mutate is a red build.
 *
 * WHAT DID NOT CHANGE: the behavioural statement and the `apiWriteRaw` scan —
 * the two that are actually about Open Dental — are byte-identical, and slice 2
 * ADDS a behavioural case that drives the new mutations to success against the
 * throwing client.
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
// The SAME contract the routes run, so a slip this test builds is a slip they accept.
const { emptySlip } = require('../../hyg/contract.gen.cjs');

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
  assert.ok(files.length >= 6, 'expected the hyg routes and services, found ' + files.length);
  assert.ok(files.some((f) => f.endsWith('day.js')));
  assert.ok(files.some((f) => f.endsWith('odDay.js')));
  // Slice 2's files, named — so a scan that stopped covering them fails here
  // rather than passing over a module that quietly moved.
  assert.ok(files.some((f) => f.endsWith('visit.js')));
  assert.ok(files.some((f) => f.endsWith('visitStore.js')));
  assert.ok(files.some((f) => f.endsWith('stagedWriteComposer.js')));
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

test('every write-shaped call in the module is an EXPRESS ROUTE, not a client call', () => {
  // Broader than the verb name: `client.post(...)`, `client.put(...)` and
  // `axios.patch(...)` bypass apiWriteRaw entirely, which is exactly how
  // config/openDental.js's own bookAppointment reaches Open Dental today.
  //
  // So this captures the RECEIVER of every write-shaped call and requires it to
  // be an Express router. `router.post('/x', ...)` registers a route on OUR api;
  // `client.post(...)` sends one to somebody else's, and only one of those two
  // can reach a patient's chart.
  const allowedReceivers = new Set(['router', 'app']);
  const offenders = [];
  for (const file of hygSources()) {
    if (file.endsWith('hygNoOdWrites.test.js') || file.endsWith('hygTestUtils.js')) continue;
    const src = fs.readFileSync(file, 'utf8');
    // The receiver is the dotted expression immediately before the verb, so
    // `this.od.client.put(` reports `this.od.client` rather than slipping
    // through on the last segment.
    for (const hit of src.matchAll(/([A-Za-z_$][\w$.]*)\.(post|put|patch|delete)\s*\(/g)) {
      if (allowedReceivers.has(hit[1])) continue;
      offenders.push(path.basename(file) + ' -> ' + hit[1] + '.' + hit[2]);
    }
  }
  assert.deepEqual(offenders, [], 'these files issue a write-shaped call to a CLIENT');
});

test('exactly ONE file registers non-GET hyg routes, and it is the named one', () => {
  // The one-file allow-list, the same shape slice 3 will give the Open Dental
  // write itself. Slice 2 owns the module's first mutations; they all live in
  // routes/hyg/visit.js, behind the mount's requireReadWrite('hyg.read',
  // 'hyg.write'), which applies BY HTTP METHOD — so every one of them demands
  // hyg.write by construction rather than by whoever wrote it remembering.
  //
  // A second file learning to mutate is a red build. That is the whole value:
  // the second writer is always the one nobody reviewed.
  const ALLOWED = ['visit.js'];
  const offenders = [];
  for (const file of hygSources()) {
    if (file.endsWith('.test.js') || file.endsWith('hygTestUtils.js')) continue;
    if (ALLOWED.includes(path.basename(file))) continue;
    const hits = [...fs.readFileSync(file, 'utf8').matchAll(/router\.(post|put|patch|delete)\s*\(/g)];
    for (const hit of hits) offenders.push(path.basename(file) + ' -> router.' + hit[1]);
  }
  assert.deepEqual(offenders, [], 'only routes/hyg/visit.js may register a mutation');

  // And the allow-list is not vacuous: the named file really does mutate, so a
  // rename that emptied it would not pass this quietly.
  const visitSrc = fs.readFileSync(path.join(__dirname, 'visit.js'), 'utf8');
  assert.match(visitSrc, /router\.post\s*\(/, 'routes/hyg/visit.js should own the mutations');
});

test('driving the visit MUTATIONS to success reaches no Open Dental write verb', async () => {
  // The module's first mutations, against the throwing client. Slice 1 could
  // only make this claim about a GET; the interesting question now is whether
  // composing and staging a visit — the paths that will BECOME chart writes one
  // slice later — reach one today. They must not.
  const od = new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
  });

  const app = await bootHygApp({ od });
  const q = '?office=roland&date=' + DATE;
  try {
    const opened = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + q);
    assert.equal(opened.status, 200);

    const item = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/items' + q, {
      body: {
        teeth: [3],
        code: 'Comp',
        category: 'Restorative',
        surfaces: ['O'],
        dx: ['D'],
        priority: 'urgent',
        motivation: ['pain'],
        status: 'proposed',
        scheduleNext: true,
        photos: [],
      },
    });
    assert.equal(item.status, 201);

    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + q, {
      body: { kind: 'router' },
    });
    assert.equal(staged.status, 201, 'the mutations must actually SUCCEED, or this proves nothing');

    const slip = await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001' + q, {
      body: { slip: emptySlip() },
    });
    assert.equal(slip.status, 200);

    assert.deepEqual(od.writes, [], 'not one Open Dental write verb was reached');
  } finally {
    await app.close();
  }
});
