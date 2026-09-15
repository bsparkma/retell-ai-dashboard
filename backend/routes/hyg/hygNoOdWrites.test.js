'use strict';

/**
 * NOTHING IN THE HYGIENE MODULE MAY WRITE TO OPEN DENTAL — enforced, not asserted
 * in prose.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE, AND WHAT IT WILL BECOME
 * ═════════════════════════════════════════════════════════════════════════════
 * H1 slice 1 was read-only in both senses: no Open Dental write, and no route
 * at all that was not a GET. **Slice 3 is where that ends**, and this file is
 * what stops it ending quietly.
 *
 * The flat invariant is REPLACED by an enumerated allow-list of ONE file, the
 * same move routes/rcm/rcmNoOdWrites.test.js made when the drain arrived:
 *
 *   `services/hyg/odWriter.js` may name `apiWriteRaw`. Nothing else may.
 *
 * A second writer is a second policy about when something lands in a patient's
 * chart, and the second one is always the one nobody reviewed. The list is
 * asserted to be NON-VACUOUS — the named file really does reach the transport —
 * so a rename that emptied it fails here rather than passing silently.
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

/** Source with comments removed, so a scan reads code rather than prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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
  // H4 slice 10's reader, named for the same reason.
  assert.ok(files.some((f) => f.endsWith('odPerio.js')));
});

/**
 * THE ALLOW-LIST. One file, and this constant is the whole of it.
 *
 * Adding a name here is the deliberate act. It should be hard to do by
 * accident, visible in a diff, and argued for in a PR body.
 */
const OD_WRITE_LAYER = Object.freeze([
  'odWriter.js',
  // H4 item 12: the perio send's writer — POST /perioexams (with the arch
  // strings), POST /periomeasures, and DELETE /perioexams/{n}, the undo. A
  // SIBLING rather than three more functions in odWriter.js so the file that
  // can delete an exam is small enough to read whole. Registered in the same
  // commit as the test below that proves it really reaches the transport.
  'odPerioWriter.js',
]);

/**
 * The transport's write verbs, by name. `apiDeleteRaw` joined in item 12: it can
 * delete one resource shape (a perio exam) and nothing else, and it is exactly
 * as reviewed a capability as a POST.
 */
const WRITE_TRANSPORT = /apiWriteRaw|apiDeleteRaw/;

test('only the allow-listed files name the Open Dental WRITE transport', () => {
  // `apiWriteRaw` (POST/PUT) and `apiDeleteRaw` (one DELETE) are the only
  // methods on config/openDental.js that change Open Dental. RCM names the
  // first in exactly one file; hyg names them in the files listed above.
  const offenders = [];
  for (const file of hygSources()) {
    const src = fs.readFileSync(file, 'utf8');
    // This test file and the harness both mention it BY DESIGN — the harness
    // defines the throwing stub, and this file explains why. Skipping them by
    // name rather than by a comment marker keeps the exemption enumerated.
    if (file.endsWith('hygNoOdWrites.test.js') || file.endsWith('hygTestUtils.js')) continue;
    // The perio writer's unit test hands the writer a fake client with both
    // methods on it, and asserts on what reached them. It can call nothing real.
    if (file.endsWith('odPerioWriter.test.js')) continue;
    if (OD_WRITE_LAYER.includes(path.basename(file))) continue;
    if (WRITE_TRANSPORT.test(src)) offenders.push(path.basename(file));
  }
  assert.deepEqual(offenders, [], 'these files reach an Open Dental write verb');
});

test('the perio writer is REAL: it reaches both verbs, and its endpoints live nowhere else', () => {
  const files = hygSources();
  const writer = files.find((f) => path.basename(f) === 'odPerioWriter.js');
  assert.ok(writer, 'services/hyg/odPerioWriter.js is on the allow-list but missing');
  const code = stripComments(fs.readFileSync(writer, 'utf8'));
  assert.match(code, /apiWriteRaw\('POST', '\/perioexams'/, 'the exam POST must live in the writer');
  assert.match(code, /apiWriteRaw\('POST', '\/periomeasures'/, 'the measurement POST must live in the writer');
  assert.match(code, /apiDeleteRaw\(`\/perioexams\/\$\{examNum\}`/, 'the exam DELETE must live in the writer');
  // No PUT: the jaw rule means no row is ever edited after it lands.
  assert.doesNotMatch(code, /apiWriteRaw\('PUT'/, 'the perio writer must not PUT');
  // The orchestration reaches it by function, never by verb.
  const send = stripComments(fs.readFileSync(files.find((f) => f.endsWith('perioSend.js')), 'utf8'));
  assert.doesNotMatch(send, WRITE_TRANSPORT);
  assert.match(send, /writer\.createPerioExam\(/);
  assert.match(send, /writer\.deletePerioExam\(/);
});

test('the allow-listed writer is REAL, and it is the only thing that can write', () => {
  // An allow-list is only a guarantee if the file it names actually exists and
  // actually reaches the transport. Otherwise the writes moved somewhere else
  // and this file is guarding an empty room.
  const files = hygSources();
  // By NAME: the list has two files now, and the slip/note endpoints belong to
  // this one. The perio writer is held to its own endpoints in the test above.
  const writer = files.find((f) => path.basename(f) === 'odWriter.js');
  assert.ok(writer, 'the allow-listed write layer odWriter.js is missing');

  const src = fs.readFileSync(writer, 'utf8');
  assert.match(src, /apiWriteRaw\(/, 'the allow-listed file does not reach the transport');

  // And the two endpoints slice 3 writes to live THERE, not in the orchestration
  // above it. A POST assembled in sendVisit.js and passed down as a string would
  // satisfy the grep above while putting the decision somewhere unreviewed.
  for (const endpoint of ['/procedurelogs/GroupNote', '/documents/Upload']) {
    assert.ok(src.includes(endpoint), `${endpoint} must live in the allow-listed writer`);
    const elsewhere = files.filter(
      (f) =>
        !OD_WRITE_LAYER.includes(path.basename(f)) &&
        // TESTS may name an endpoint: scripting one and asserting on the body
        // that reached it is how the writer is held to account, not a second
        // way to write. What they cannot do is call apiWriteRaw, which the
        // scan above covers for every file but the harness.
        !f.endsWith('.test.js') &&
        // CODE, not comments. sendVisit.js names both endpoints in its header
        // to say where the writes go — documenting the rule is not breaking it.
        stripComments(fs.readFileSync(f, 'utf8')).includes(endpoint)
    );
    assert.deepEqual(
      elsewhere.map((f) => path.basename(f)),
      [],
      `${endpoint} is named outside the allow-listed writer`
    );
  }
});

test('the guard would FAIL if a second file learned to write', () => {
  // The allow-list is a filter, and a filter is only as good as the thing it
  // filters. This drives the same scan over a synthetic file list containing a
  // second writer and asserts it is reported — so a future refactor that
  // widened the list to a directory (or dropped the check entirely) cannot pass
  // by simply having nothing to find.
  const pretendSources = ['odWriter.js', 'sendVisit.js'];
  const offenders = pretendSources.filter(
    (name) => !OD_WRITE_LAYER.includes(name) // both "contain" apiWriteRaw in this thought experiment
  );
  assert.deepEqual(offenders, ['sendVisit.js'], 'the allow-list must exclude everything else');
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

// ── 3. the perio chart (H4 slice 10): read, display, stage — ZERO writes ─────
//
// A perio row written into Open Dental is the one write in this module that
// cannot be taken back (only Mobility and SkipTooth measurements can be
// deleted). So slice 10 adds perio READS and a perio STAGE and nothing else,
// and these tests hold it to that in all three ways: behaviourally, by scanning
// the reader's source, and by proving the scan would catch a write.

/** The same receiver-capturing shape the client-call scan above uses. */
const WRITE_SHAPED_CALL = /([A-Za-z_$][\w$.]*)\.(post|put|patch|delete)\s*\(/g;

/** Write-shaped calls on anything that is not an Express router. */
function clientWriteCalls(src) {
  return [...stripComments(src).matchAll(WRITE_SHAPED_CALL)]
    .filter((hit) => hit[1] !== 'router' && hit[1] !== 'app')
    .map((hit) => hit[1] + '.' + hit[2]);
}

const PERIO_ENDPOINTS = ['/perioexams', '/periomeasures'];

test('the perio reader reaches Open Dental through odGet ONLY — and really does reach it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'services', 'hyg', 'odPerio.js'), 'utf8');
  const code = stripComments(src);
  assert.doesNotMatch(code, /apiWriteRaw/, 'the perio reader names the write transport');
  assert.deepEqual(clientWriteCalls(src), [], 'the perio reader issues a write-shaped call');
  // Non-vacuous: the file this guards is the one that reads perio, through the
  // paged GET helper. A reader that moved elsewhere would leave this guarding
  // an empty room.
  assert.match(code, /pagedList\(odGet, '\/perioexams'/);
  assert.match(code, /pagedList\(odGet, '\/periomeasures'/);
});

test('no perio endpoint is named in code anywhere but the reader and the perio writer', () => {
  const offenders = [];
  for (const file of hygSources()) {
    if (file.endsWith('.test.js') || file.endsWith('hygTestUtils.js')) continue;
    // Item 12 is where this changed, deliberately: the READER reads perio, the
    // PERIO WRITER writes it, and nothing else — least of all odWriter.js or the
    // send's orchestration — knows a perio endpoint exists.
    if (path.basename(file) === 'odPerio.js' || path.basename(file) === 'odPerioWriter.js') continue;
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const endpoint of PERIO_ENDPOINTS) {
      if (code.includes(endpoint)) offenders.push(path.basename(file) + ' -> ' + endpoint);
    }
  }
  // odWriter.js is the one file that MAY write; in slice 10 it must not know a
  // perio endpoint exists. The send slice is where that changes, deliberately.
  assert.deepEqual(offenders, [], 'a perio endpoint is named outside services/hyg/odPerio.js');
});

test('the perio scans would FAIL on a perio write, so passing them means something', () => {
  // Synthetic sources, run through the same helpers the two tests above use.
  assert.deepEqual(
    clientWriteCalls("await od.client.post('/periomeasures', row);"),
    ['od.client.post']
  );
  assert.deepEqual(clientWriteCalls("router.put('/:aptNum/perio', handler);"), []);
  assert.deepEqual(
    clientWriteCalls("// client.post('/perioexams') in prose is not a call\n"),
    [],
    'comments are prose, not code'
  );
});

test('driving EVERY perio path to success reaches no Open Dental write verb', async () => {
  // Past one page of measures, so the paging path is inside the claim too.
  const measures = [];
  for (let tooth = 1; tooth <= 32; tooth += 1) {
    for (const type of ['Probing', 'BleedSupPlaqCalc', 'GingMargin', 'Mobility']) {
      measures.push({
        PerioMeasureNum: measures.length + 1, PerioExamNum: 5001, SequenceType: type,
        IntTooth: tooth, ToothValue: -1,
        DBvalue: 1, Bvalue: 0, MBvalue: 3, DLvalue: 3, Lvalue: 2, MLvalue: 3,
      });
    }
  }
  const od = new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Perio Maint' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow(),
    '/perioexams': [{ PerioExamNum: 5001, PatNum: 12827, ExamDate: '2025-05-12', ProvNum: 7 }],
    '/periomeasures': measures.slice(0, 100),
    '/periomeasures?Offset=100': measures.slice(100),
  });

  const app = await bootHygApp({ od });
  const q = '?office=roland&date=' + DATE;
  const contract = require('../../hyg/contract.gen.cjs');
  let chart = contract.emptyPerioChart();
  for (const c of contract.chartingOrder(chart.sweep).slice(0, 30)) {
    chart = contract.withPerioSite(chart, c.tooth, c.surface, { depth: 4, bleeding: true });
  }
  try {
    assert.equal((await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/open' + q)).status, 200);
    assert.equal(
      (await api(app.baseUrl, 'PUT', '/api/hyg/visit/900001/perio' + q, { body: { chart } })).status,
      200
    );
    assert.equal((await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/perio' + q)).status, 200);
    const prior = await api(app.baseUrl, 'GET', '/api/hyg/visit/900001/perio/prior' + q);
    assert.equal(prior.status, 200);
    assert.equal(prior.body.prior.status, 'found', 'the read path must actually SUCCEED');
    assert.equal(prior.body.prior.counts.sitesCharted, 192, 'both measure pages were read');

    const staged = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/staged-writes' + q, {
      body: { kind: 'perio' },
    });
    assert.equal(staged.status, 201);
    const write = staged.body.visit.stagedWrites.find((w) => w.kind === 'perio');

    // And the one path that COULD write: the send, handed the staged chart.
    const sent = await api(app.baseUrl, 'POST', '/api/hyg/visit/900001/send' + q, {
      body: { confirm: [{ kind: 'perio', previewFingerprint: write.previewFingerprint }] },
    });
    assert.equal(sent.status, 422);
    assert.equal(sent.body.code, 'PERIO_SENDS_FROM_ITS_CHART');

    assert.deepEqual(od.writes, [], 'not one Open Dental write verb was reached');
    for (const c of od.calls) {
      assert.match(
        c.path,
        /^\/(appointments|operatories|appointmenttypes|providers|patients|perioexams|periomeasures)/,
        'unexpected Open Dental path: ' + c.path
      );
    }
    assert.ok(od.calls.some((c) => c.path === '/periomeasures' && c.params.Offset === 100));
  } finally {
    await app.close();
  }
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
