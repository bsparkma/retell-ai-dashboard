'use strict';

/**
 * The Open Dental read shell, against a recorded-shape fake.
 *
 * The shell's contract is `odGet(path, params, opts) -> {ok,status,data,error}`
 * — a plain function passed in, which is what makes this file possible without
 * a live practice database and what makes reaching for a write verb impossible
 * in the code under test.
 *
 * The behaviours pinned here are the ones measured live against Roland's Open
 * Dental (docs/TC_OD_READS.md, docs/RCM_OD_WRITES.md), plus the one the write
 * spike found the hard way: **Open Dental silently ignores list filters it does
 * not implement.** Every list read is therefore re-filtered client-side, and
 * this file is what proves it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const reads = require('./odClaimReads');

// ─── A scriptable odGet ──────────────────────────────────────────────────────

/**
 * @param {(path:string, params:object) => {ok?:boolean,status?:number,data?:unknown,error?:string}} handler
 */
function odGetOf(handler) {
  const calls = [];
  const fn = async (path, params = {}, opts = {}) => {
    calls.push({ path, params, opts });
    const res = handler(path, params) || {};
    return { ok: res.ok !== false, status: res.status || 200, data: res.data ?? [], error: res.error };
  };
  fn.calls = calls;
  fn.paths = () => calls.map((c) => c.path);
  return fn;
}

const PATIENT = { PatNum: 12828, LName: 'Test', FName: 'MangoTest', Birthdate: '1990-01-01' };
const CLAIM = { ClaimNum: 53648, PatNum: 12828, DateService: '2026-03-02', ClaimFee: 210.0, ClaimStatus: 'S' };
const CLAIMPROC = {
  ClaimProcNum: 99001,
  ClaimNum: 53648,
  ProcNum: 8801,
  Status: 'NotReceived',
  FeeBilled: 210.0,
  InsPayAmt: 0,
  WriteOff: 0,
  DedApplied: 0,
  IsTransfer: false,
  ClaimPaymentNum: 0,
};
const PROCEDURE = { ProcNum: 8801, PatNum: 12828, procCode: 'D0150', ProcStatus: 'C', ProcFee: 210.0 };

/** The happy path: one patient, one claim, one line. */
function happyOd(over = {}) {
  return odGetOf((path, params) => {
    if (over[path]) return over[path](params);
    if (path === '/patients') {
      const field = params.LName ? 'LName' : 'FName';
      const value = params.LName || params.FName;
      return {
        data: [PATIENT].filter((p) =>
          String(p[field]).toUpperCase().startsWith(String(value).toUpperCase())
        ),
      };
    }
    if (path === '/patients/12828') return { data: PATIENT };
    if (path === '/claims') return { data: [CLAIM] };
    if (path === '/claimprocs') return { data: [CLAIMPROC] };
    if (path === '/procedurelogs') return { data: [PROCEDURE] };
    return { ok: false, status: 404, error: `${path} is not a valid resource.` };
  });
}

const PROPOSAL = {
  patientName: 'Test, MangoTest',
  odPatientId: null,
  claimNumber: '53648',
  serviceDate: '2026-03-02',
  totalBilledCents: 21000,
  lines: [{ lineId: 'pl-1', billedCode: 'D0150', billedCents: 21000 }],
};

// ─── Name interpretation ─────────────────────────────────────────────────────

test('a comma name is read as LAST, FIRST — the shape the ERA parser writes', () => {
  assert.deepEqual(reads.nameInterpretations('Fixture, Synthetic'), [
    { last: 'Fixture', first: 'Synthetic' },
  ]);
});

test('a name with no comma is tried BOTH ways round', () => {
  // An EOB extraction can produce "First Last". Guessing wrong means searching
  // for a forename in the surname lane and concluding the patient is not there.
  assert.deepEqual(reads.nameInterpretations('Synthetic Fixture'), [
    { last: 'Fixture', first: 'Synthetic' },
    { last: 'Synthetic', first: 'Fixture' },
  ]);
});

test('a single-token name searches the surname lane only', () => {
  assert.deepEqual(reads.nameInterpretations('Fixture'), [{ last: 'Fixture', first: '' }]);
});

test('a missing or empty name yields nothing to search', () => {
  assert.deepEqual(reads.nameInterpretations(''), []);
  assert.deepEqual(reads.nameInterpretations(null), []);
});

// ─── Patient search — the dual lane, and the prefix trap ─────────────────────

test('the search runs BOTH lanes, which is what finds the LName:"Test" fixture', () => {
  // PatNum 12828 is LName "Test", FName "MangoTest": a surname-only search for
  // "MangoTest" misses it entirely. TC documents the same merge as not optional.
  const odGet = happyOd();
  return reads.searchPatientsByName(odGet, 'MangoTest Test').then((found) => {
    assert.equal(found.patients.length, 1);
    assert.equal(found.patients[0].PatNum, 12828);
  });
});

test('a name search with nothing to search by makes no Open Dental call', async () => {
  const odGet = happyOd();
  const found = await reads.searchPatientsByName(odGet, '');
  assert.deepEqual(found.patients, []);
  assert.equal(odGet.calls.length, 0);
  assert.match(found.notes.join(' '), /No patient name/);
});

test('a one-character token is not sent — OD prefix-matches and would return the world', async () => {
  const odGet = happyOd();
  await reads.searchPatientsByName(odGet, 'A B');
  assert.equal(odGet.calls.length, 0);
});

test('too many prefix hits are capped, and the cap SAYS so', async () => {
  // `LName=Spark` returned 18 rows live, the first being "Sparkman". Reading
  // eighteen patients' whole claim histories to rank one remittance line is
  // neither affordable nor proportionate.
  const many = Array.from({ length: 18 }, (_, i) => ({
    PatNum: 1000 + i,
    LName: 'Sparkman',
    FName: `Person${i}`,
  }));
  const odGet = odGetOf((path) => (path === '/patients' ? { data: many } : { data: [] }));
  const found = await reads.searchPatientsByName(odGet, 'Sparkman');
  assert.equal(found.patients.length, reads.MAX_CANDIDATE_PATIENTS);
  assert.equal(found.truncated, true);
  assert.match(found.notes.join(' '), /matched 18 patients by name prefix/);
});

test('prefix hits are ranked by how much of the name the chart actually shares', async () => {
  const odGet = odGetOf((path, params) =>
    path === '/patients' && params.LName
      ? {
          data: [
            { PatNum: 1, LName: 'Sparkman', FName: 'Stranger' },
            { PatNum: 2, LName: 'Sparkman', FName: 'Synthetic' },
          ],
        }
      : { data: [] }
  );
  const found = await reads.searchPatientsByName(odGet, 'Sparkman, Synthetic');
  assert.equal(found.patients[0].PatNum, 2, 'the closer name should be searched first');
});

test('an IGNORED name filter is re-filtered client-side, and SAID', async () => {
  // The mirror of the /claims test below, and the one that was missing.
  // If `?LName=` is ever non-functional, OD returns page 1 of the PATIENT TABLE
  // with a 200 — 100 real people. Trusting it would read every one of them in
  // full and offer strangers' claims for a biller to attach a PatNum to.
  const roster = [
    PATIENT,
    { PatNum: 4242, LName: 'Unrelated', FName: 'Person', Birthdate: '1970-01-01' },
    { PatNum: 4243, LName: 'Someone', FName: 'Else', Birthdate: '1980-01-01' },
  ];
  const odGet = odGetOf((path) => (path === '/patients' ? { data: roster } : { data: [] }));

  const found = await reads.searchPatientsByName(odGet, 'Test, MangoTest');
  assert.deepEqual(
    found.patients.map((p) => p.PatNum),
    [12828]
  );
  assert.match(found.notes.join(' '), /ignored the name filter on \/patients/);
});

test('a prefix match is kept — the client-side pass is a no-op when OD behaves', async () => {
  // `LName=Spark` legitimately returns "Sparkman": the filter is a PREFIX, and
  // re-filtering must use the same predicate or it would drop real matches.
  const odGet = odGetOf((path, params) =>
    path === '/patients' && params.LName
      ? { data: [{ PatNum: 8305, LName: 'Sparkman', FName: 'Aiden' }] }
      : { data: [] }
  );
  const found = await reads.searchPatientsByName(odGet, 'Spark');
  assert.equal(found.patients.length, 1);
  assert.ok(!found.notes.join(' ').includes('ignored'));
});

test('a full page of name matches is reported, not silently under-counted', async () => {
  const page = Array.from({ length: reads.OD_PAGE_SIZE }, (_, i) => ({
    PatNum: 5000 + i,
    LName: 'Sparkman',
    FName: `Person${i}`,
  }));
  const odGet = odGetOf((path) => (path === '/patients' ? { data: page } : { data: [] }));
  const found = await reads.searchPatientsByName(odGet, 'Sparkman');
  assert.equal(found.truncated, true);
  assert.match(found.notes.join(' '), /full page of \d+ name matches/);
});

test('a refused /procedurelogs is REPORTED — a soft delete cannot be ruled out without it', async () => {
  // This was silent, and the silence was the bug: with no procedure rows every
  // line read as not-deleted, which inflated the chart totals, hid the
  // exclusion blocker, and let a deleted line be paired for Slice 6c to post
  // against.
  const odGet = happyOd({
    '/procedurelogs': () => ({
      ok: false,
      status: 404,
      error: 'procedurelogs is not a valid resource.',
    }),
  });
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.match(found.notes.join(' '), /enable the \/procedurelogs resource/);
  assert.equal(found.truncated, true);
});

test('a capability miss on /patients is a NOTE, not an outage', async () => {
  const odGet = odGetOf(() => ({ ok: false, status: 404, error: 'patients is not a valid resource.' }));
  const found = await reads.searchPatientsByName(odGet, 'Fixture, Synthetic');
  assert.deepEqual(found.patients, []);
  assert.match(found.notes.join(' '), /enable the \/patients resource/);
});

test('a 500 from Open Dental THROWS rather than reading as "no such patient"', async () => {
  // The distinction the whole slice rests on: an empty candidate list must
  // never be produced by an outage, because `no_candidate` is a claim we make
  // only after a read succeeded.
  const odGet = odGetOf(() => ({ ok: false, status: 500, error: 'upstream exploded' }));
  await assert.rejects(() => reads.searchPatientsByName(odGet, 'Fixture, Synthetic'), reads.OdReadError);
});

// ─── The candidate fetch ─────────────────────────────────────────────────────

test('the happy path returns one scoreable candidate and stamps when it looked', async () => {
  const odGet = happyOd();
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);

  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].claim.ClaimNum, 53648);
  assert.equal(found.candidates[0].claimProcs.length, 1);
  assert.equal(found.candidates[0].procedures.get(8801).procCode, 'D0150');
  assert.deepEqual(found.patientsConsidered, [{ patNum: 12828, name: 'Test, MangoTest' }]);
  assert.ok(found.odCalls > 0);
  // fetchedAt is what Slice 6c re-verifies against, so it is data, not decoration.
  assert.match(found.fetchedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('an already-linked PatNum skips the name search entirely', async () => {
  const odGet = happyOd();
  await reads.findClaimCandidates(odGet, { ...PROPOSAL, odPatientId: 12828 });
  assert.ok(odGet.paths().includes('/patients/12828'));
  assert.ok(!odGet.paths().includes('/patients'), 'no prefix search should be needed');
});

test('a stored link to a patient Open Dental does not have is REPORTED, not ignored', async () => {
  // A PatNum belonging to another practice's database is exactly the hazard the
  // per-office registry exists for, and saying so beats an empty screen.
  const odGet = odGetOf((path) =>
    path === '/patients/7115' ? { ok: false, status: 404, error: 'not found' } : { data: [] }
  );
  const found = await reads.findClaimCandidates(odGet, { ...PROPOSAL, odPatientId: 7115 });
  assert.deepEqual(found.candidates, []);
  assert.match(found.notes.join(' '), /no patient 7115.*another practice/i);
});

test('no patient found means no claim read is attempted at all', async () => {
  const odGet = odGetOf((path) => (path === '/patients' ? { data: [] } : { data: [] }));
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.deepEqual(found.candidates, []);
  assert.ok(!odGet.paths().includes('/claims'));
});

// ─── The silently-ignored-filter trap ────────────────────────────────────────

test("another patient's claims are DISCARDED when OD ignores the PatNum filter", async () => {
  // Measured behaviour: OD returns the unfiltered page and the request succeeds,
  // so a caller that trusts the filter cannot tell. Re-filtering client-side is
  // the difference between a correct candidate set and another patient's claims
  // on the screen.
  const odGet = happyOd({
    '/claims': () => ({
      data: [CLAIM, { ClaimNum: 99999, PatNum: 4242, DateService: '2026-03-02', ClaimFee: 1.0, ClaimStatus: 'S' }],
    }),
  });
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.deepEqual(
    found.candidates.map((c) => c.claim.ClaimNum),
    [53648]
  );
  assert.match(found.notes.join(' '), /ignored the PatNum filter on \/claims/);
});

test("another claim's lines are DISCARDED when OD ignores the ClaimNum filter", async () => {
  const odGet = happyOd({
    '/claimprocs': () => ({ data: [CLAIMPROC, { ...CLAIMPROC, ClaimProcNum: 99002, ClaimNum: 70000 }] }),
  });
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.deepEqual(
    found.candidates[0].claimProcs.map((c) => c.ClaimProcNum),
    [99001]
  );
  assert.match(found.notes.join(' '), /ignored the ClaimNum filter on \/claimprocs/);
});

test('a filter that IS honoured produces no note — the mitigation is silent when unneeded', async () => {
  const found = await reads.findClaimCandidates(happyOd(), PROPOSAL);
  assert.ok(!found.notes.join(' ').includes('ignored'));
});

// ─── Bounds, and being honest about them ─────────────────────────────────────

test('a full page means more behind it — the scan stops at the cap and says truncated', async () => {
  const page = Array.from({ length: reads.OD_PAGE_SIZE }, (_, i) => ({
    ClaimNum: 1000 + i,
    PatNum: 12828,
    DateService: '2026-03-02',
    ClaimFee: 1,
    ClaimStatus: 'S',
  }));
  const odGet = odGetOf((path) => {
    if (path === '/patients') return { data: [PATIENT] };
    if (path === '/claims') return { data: page };
    return { data: [] };
  });
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.equal(found.truncated, true);
  assert.match(found.notes.join(' '), /more claims than the .* scan reads/);
});

test('the claims scan honours Offset paging rather than re-reading page one', async () => {
  const offsets = [];
  const odGet = odGetOf((path, params) => {
    if (path === '/patients') return { data: [PATIENT] };
    if (path === '/claims') {
      offsets.push(params.Offset ?? 0);
      return {
        data: Array.from({ length: reads.OD_PAGE_SIZE }, (_, i) => ({
          ClaimNum: 1000 + (params.Offset || 0) + i,
          PatNum: 12828,
          DateService: '2026-03-02',
          ClaimFee: 1,
          ClaimStatus: 'S',
        })),
      };
    }
    return { data: [] };
  });
  await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.deepEqual(offsets, [0, reads.OD_PAGE_SIZE, reads.OD_PAGE_SIZE * 2]);
});

test('more candidate claims than the cap are examined newest-first, and the cap is stated', async () => {
  const claims = Array.from({ length: reads.MAX_CANDIDATE_CLAIMS + 4 }, (_, i) => ({
    ClaimNum: 1000 + i,
    PatNum: 12828,
    // Ascending dates, so "newest first" is a visible reordering rather than
    // the order they arrived in.
    DateService: `2026-01-${String(i + 1).padStart(2, '0')}`,
    ClaimFee: 1,
    ClaimStatus: 'S',
  }));
  const odGet = odGetOf((path) => {
    if (path === '/patients') return { data: [PATIENT] };
    if (path === '/claims') return { data: claims };
    return { data: [] };
  });
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.equal(found.candidates.length, reads.MAX_CANDIDATE_CLAIMS);
  assert.equal(found.candidates[0].claim.ClaimNum, 1000 + claims.length - 1, 'newest first');
  assert.equal(found.truncated, true);
  assert.match(found.notes.join(' '), /most recent were examined in detail/);
});

test('the procedure scan is ONE read per patient, not one per line', async () => {
  // Per-claimproc `GET /procedurelogs/{n}` would be one call per line per claim
  // — twenty calls on a patient with four candidate claims of five lines each.
  const claims = [CLAIM, { ...CLAIM, ClaimNum: 53649 }, { ...CLAIM, ClaimNum: 53650 }];
  const odGet = odGetOf((path) => {
    if (path === '/patients') return { data: [PATIENT] };
    if (path === '/claims') return { data: claims };
    if (path === '/claimprocs') return { data: [CLAIMPROC] };
    if (path === '/procedurelogs') return { data: [PROCEDURE] };
    return { data: [] };
  });
  await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.equal(odGet.paths().filter((p) => p === '/procedurelogs').length, 1);
});

test('a capability miss on /claims is a note and skips the patient, not an exception', async () => {
  const odGet = happyOd({
    '/claims': () => ({ ok: false, status: 404, error: 'claims is not a valid resource.' }),
  });
  const found = await reads.findClaimCandidates(odGet, PROPOSAL);
  assert.deepEqual(found.candidates, []);
  assert.match(found.notes.join(' '), /enable the \/claims resource/);
});

test('an outage mid-scan throws rather than returning a short, silent list', async () => {
  const odGet = happyOd({ '/claims': () => ({ ok: false, status: 503, error: 'gateway' }) });
  await assert.rejects(() => reads.findClaimCandidates(odGet, PROPOSAL), reads.OdReadError);
});

test('every Open Dental call carries the configured timeout', async () => {
  const odGet = happyOd();
  await reads.findClaimCandidates(odGet, PROPOSAL);
  for (const call of odGet.calls) {
    assert.equal(call.opts.timeoutMs, reads.OD_CALL_TIMEOUT_MS);
  }
});

test('only proven filters and Offset are ever sent to Open Dental', () => {
  // The hard rule: proven filters only. Anything else is fetched and filtered
  // client-side, which is what the scans above do.
  const ALLOWED = new Set(['PatNum', 'ClaimNum', 'LName', 'FName', 'Offset']);
  const odGet = happyOd();
  return reads.findClaimCandidates(odGet, PROPOSAL).then(() => {
    for (const call of odGet.calls) {
      for (const key of Object.keys(call.params || {})) {
        assert.ok(ALLOWED.has(key), `unproven OD filter sent: ${key} on ${call.path}`);
      }
    }
  });
});

test('isCapabilityMiss separates "enable the resource" from "it is down"', () => {
  assert.equal(reads.isCapabilityMiss({ ok: false, status: 404, error: 'x is not a valid resource.' }), true);
  assert.equal(reads.isCapabilityMiss({ ok: false, status: 403, error: 'permission' }), true);
  assert.equal(reads.isCapabilityMiss({ ok: false, status: 500, error: 'boom' }), false);
  assert.equal(reads.isCapabilityMiss({ ok: false, status: 0, error: 'ECONNRESET' }), false);
  assert.equal(reads.isCapabilityMiss({ ok: true, status: 200 }), false);
});


// --- Configuration refuses to be wrong quietly -------------------------------

test('a non-integer cap REFUSES TO START rather than reporting "no matching claim"', () => {
  /*
   * `Number(process.env.X || default)` turns a typo into NaN, and NaN into
   * silence: `slice(0, NaN)` returns [], no patients are searched, and the
   * workbench states as a FACT that Open Dental has no such claim. A
   * misconfiguration that produces a confident wrong answer is worse than one
   * that fails to boot.
   *
   * Untested until this review round, which is its own small lesson: the throw
   * was written for a failure mode nobody had made fire.
   */
  const NAME = 'RCM_OD_TEST_CAP';
  const original = process.env[NAME];
  try {
    for (const bad of ['three', '0', '-1', '2.5', 'NaN', '1e3x']) {
      process.env[NAME] = bad;
      assert.throws(
        () => reads.intEnv(NAME, 3),
        /is not a positive integer/,
        `${JSON.stringify(bad)} must be refused`
      );
    }

    // Absent and empty both fall back — an unset variable is not a typo.
    delete process.env[NAME];
    assert.equal(reads.intEnv(NAME, 3), 3);
    process.env[NAME] = '';
    assert.equal(reads.intEnv(NAME, 3), 3);

    process.env[NAME] = '7';
    assert.equal(reads.intEnv(NAME, 3), 7);
  } finally {
    if (original === undefined) delete process.env[NAME];
    else process.env[NAME] = original;
  }
});

test('findClaimCandidates reports WHICH LANE resolved the patient', () => {
  // The ranker turns its name-mismatch disqualifier off on the linked lane -
  // there are no strangers to defend against when the claims came from that
  // patient's own PatNum, and a married-name change would otherwise disqualify
  // every claim on the right patient.
  const byName = happyOd();
  return reads
    .findClaimCandidates(byName, PROPOSAL)
    .then((found) => {
      assert.equal(found.patientResolvedByLink, false);
      const linked = happyOd();
      return reads.findClaimCandidates(linked, { ...PROPOSAL, odPatientId: 12828 });
    })
    .then((found) => {
      assert.equal(found.patientResolvedByLink, true);
    });
});
