'use strict';

/**
 * /api/tc/od — Open Dental reads, per office.
 *
 * Each office's REAL client instance (config/odOffices) is stubbed with a scripted
 * fake OD, so the suite exercises the REAL routers, the REAL office resolution,
 * the REAL audit writes and the REAL multi-call composition — without touching a
 * live practice. Stubbing the CLIENT rather than the registry is deliberate: the
 * handle is frozen on purpose (an office must not be re-pointed at another
 * practice at runtime), and it leaves the office→client wiring under test.
 *
 * What is asserted, in the order the slice's risks run:
 *   1. office law   — each office reads its OWN database and only its own; an
 *                     office that is unknown, switched off or unkeyed is refused
 *                     and NEVER falls back to Roland
 *   2. input        — a non-numeric PatNum never reaches an OD URL
 *   3. read-only    — no route issues a non-GET OD call
 *   4. shapes       — treatment plan Saved / Active / alias-fallback / PARTIAL
 *   5. honesty      — coverage rows carry the claimproc GAP; truncation is stated
 *   6. failure      — timeouts and capability misses map to structured errors
 *   7. PHI          — the search term never reaches the audit trail
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const { bootTcApp, api, auditRows } = require('./tcTestUtils');
const odOffices = require('../../config/odOffices');
const odReads = require('./odReads');

// ── Per-office fake OD ──────────────────────────────────────────────────────

const savedEnv = {};
const OD_KEY_ENV = {
  roland: 'OPENDENTAL_CUSTOMER_KEY',
  valley: 'OPENDENTAL_CUSTOMER_KEY_VALLEY',
};

test.before(() => {
  for (const k of [...Object.values(OD_KEY_ENV), 'OPENDENTAL_ALLOW_MOCK']) {
    savedEnv[k] = process.env[k];
  }
  // Distinct per office so an assertion can prove WHICH credential was used.
  process.env[OD_KEY_ENV.roland] = 'test-roland-customer-key';
  process.env[OD_KEY_ENV.valley] = 'test-valley-customer-key';
  delete process.env.OPENDENTAL_ALLOW_MOCK;
  odOffices.resetOdOfficeCache();
});

test.after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  odOffices.resetOdOfficeCache();
});

/**
 * Script OD by path prefix. Each handler gets (path, params) and returns either
 * a raw array/object (→ 200) or an explicit {ok,status,error} outcome.
 *
 * `routes` is either a flat path map, which every office answers identically, or
 * an office-keyed map ({ roland: {...}, valley: {...} }) when a test needs the two
 * practices to hold DIFFERENT records — which is the only way to prove which
 * database a request actually reached.
 */
function routesByOffice(routes) {
  const flat = Object.keys(routes).every((k) => k.startsWith('/'));
  return flat ? { roland: routes, valley: routes } : routes;
}

/**
 * Install the fake on every office's own client for the duration of `fn`.
 * Recorded calls carry the office, so "a valley request never touched Roland's
 * client" is a fact the suite can read off rather than infer.
 */
async function withOd(routes, fn) {
  const table = routesByOffice(routes);
  const calls = [];
  const patched = [];

  for (const officeKey of Object.keys(OD_KEY_ENV)) {
    const { client } = odOffices.getOdOffice(officeKey);
    assert.ok(
      !patched.some((x) => x.client === client),
      'each office must hold its OWN client instance, or nothing here proves anything'
    );
    patched.push({ client, original: client.apiGetRaw });
    client.apiGetRaw = async (path, params = {}, opts = {}) => {
      calls.push({ office: officeKey, path, params, opts });
      const office = table[officeKey] || {};
      const key = Object.keys(office)
        .filter((k) => path === k || path.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (!key) {
        return { ok: false, status: 404, data: 'not a valid resource', error: 'not a valid resource' };
      }
      const out = await office[key](path, params);
      if (out && typeof out === 'object' && 'ok' in out) return out;
      return { ok: true, status: 200, data: out };
    };
  }

  try {
    return await fn({ calls });
  } finally {
    for (const { client, original } of patched) client.apiGetRaw = original;
  }
}

const PATIENT = {
  PatNum: 12828,
  FName: 'Mango',
  LName: 'MangoTest',
  Birthdate: '1990-04-01',
  WirelessPhone: '9185550100',
  Email: 'mango@example.test',
  PatStatus: 'Patient',
};

// ── 1. Office law ───────────────────────────────────────────────────────────

/**
 * The two practices' fixtures. PatNum 7115 is the point of the whole slice: it is
 * "Stedi TestValley" in Riley/valley and a DIFFERENT, REAL person in Roland, so a
 * read that ignored the office would print one practice's chart under the other's
 * selector. Roland's row here is the synthetic 12827 fixture, never that person.
 */
const ROLAND_ONLY = { PatNum: 12827, FName: 'Stedi', LName: 'Test 2', Birthdate: '1990-01-01', PatStatus: 'Patient' };
const VALLEY_ONLY = { PatNum: 7115, FName: 'Stedi', LName: 'TestValley', Birthdate: '1985-02-02', PatStatus: 'Patient' };

/** Each office answers only for its OWN PatNum; the other one is a 404. */
const PER_OFFICE_PATIENTS = {
  roland: {
    '/patients/12827': () => ROLAND_ONLY,
    '/patients': (_p, params) =>
      String(params.LName || params.FName || '').length ? [ROLAND_ONLY] : [],
  },
  valley: {
    '/patients/7115': () => VALLEY_ONLY,
    '/patients': (_p, params) =>
      String(params.LName || params.FName || '').length ? [VALLEY_ONLY] : [],
  },
};

test('valley reads VALLEY\'s Open Dental — the office selects the database', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(PER_OFFICE_PATIENTS, async (od) => {
      const res = await api(baseUrl, 'GET', '/api/tc/od/patients/7115?office=valley');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.patient.patNum, 7115);
      assert.equal(res.body.patient.lastName, 'TestValley');
      assert.ok(od.calls.length > 0);
      assert.deepEqual(
        [...new Set(od.calls.map((c) => c.office))],
        ['valley'],
        "a valley read must never touch Roland's client"
      );
    });
  } finally {
    await close();
  }
});

test('a Roland PatNum asked for under valley reaches valley and 404s — it never crosses', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(PER_OFFICE_PATIENTS, async (od) => {
      // 12827 exists in Roland. Under ?office=valley the honest answer is "not
      // here" — NOT Roland's record wearing a Riley label.
      const res = await api(baseUrl, 'GET', '/api/tc/od/patients/12827?office=valley');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NOT_FOUND');
      assert.deepEqual([...new Set(od.calls.map((c) => c.office))], ['valley']);
    });
  } finally {
    await close();
  }
});

test('and the mirror: a valley PatNum asked for under roland stays in Roland', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(PER_OFFICE_PATIENTS, async (od) => {
      const res = await api(baseUrl, 'GET', '/api/tc/od/patients/7115?office=roland');
      assert.equal(res.status, 404);
      assert.deepEqual([...new Set(od.calls.map((c) => c.office))], ['roland']);
    });
  } finally {
    await close();
  }
});

test('every OD route is office-scoped, not just the patient read', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd({ '/': () => [] }, async (od) => {
      const paths = [
        '/api/tc/od/status',
        '/api/tc/od/patients?q=test',
        '/api/tc/od/patients/7115',
        '/api/tc/od/treatment-plan/7115',
        '/api/tc/od/unaccepted',
        '/api/tc/od/cob-procedures/7115',
        '/api/tc/od/insurance/7115',
        '/api/tc/od/next-appointment/7115',
      ];
      for (const p of paths) {
        const url = p.includes('?') ? `${p}&office=valley` : `${p}?office=valley`;
        const res = await api(baseUrl, 'GET', url);
        assert.ok(res.status < 500, `${p} should be served for valley (got ${res.status})`);
      }
      assert.ok(od.calls.length > 0);
      assert.deepEqual(
        [...new Set(od.calls.map((c) => c.office))],
        ['valley'],
        'not one OD call from a valley request may land on another practice'
      );
    });
  } finally {
    await close();
  }
});

test("TC tags its OD calls so the credential's 429s can be attributed", async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd({ '/patients': () => [ROLAND_ONLY] }, async (od) => {
      await api(baseUrl, 'GET', '/api/tc/od/patients?q=Test&office=roland');
      assert.ok(od.calls.length > 0);
      // Attribution only — it buys no priority, and TC deliberately does NOT
      // join RCM's serialized 1200ms queue (see the PACING note in od.js).
      assert.ok(
        od.calls.every((c) => c.opts && c.opts.module === 'tc'),
        'every TC OD call must carry module:\'tc\''
      );
      assert.ok(
        od.calls.every((c) => !c.opts || c.opts.minIntervalMs === undefined),
        'TC must not raise the shared slot to a batch interval'
      );
    });
  } finally {
    await close();
  }
});

test('an office with no customer key is refused, and NEVER falls back to Roland', async () => {
  const saved = process.env[OD_KEY_ENV.valley];
  delete process.env[OD_KEY_ENV.valley];
  odOffices.resetOdOfficeCache();

  const { baseUrl, close } = await bootTcApp();
  try {
    // Only Roland has a client to stub now, so any leak would show up as a call
    // on it. Patch it directly rather than through withOd, which expects both.
    const roland = odOffices.getOdOffice('roland').client;
    const original = roland.apiGetRaw;
    const leaked = [];
    roland.apiGetRaw = async (path, params) => {
      leaked.push({ path, params });
      return { ok: true, status: 200, data: [ROLAND_ONLY] };
    };
    try {
      const res = await api(baseUrl, 'GET', '/api/tc/od/patients/7115?office=valley');
      assert.equal(res.status, 503);
      // OFFICE_NOT_CONNECTED is what the shared OD UI renders as the honest
      // "OD not connected for this office yet" state; `reason` says which of the
      // three refusals it was without anyone having to guess.
      assert.equal(res.body.code, 'OFFICE_NOT_CONNECTED');
      assert.equal(res.body.reason, 'OFFICE_OD_KEY_MISSING');
      assert.equal(res.body.office, 'valley');
      assert.equal(leaked.length, 0, "a missing valley key must never borrow Roland's client");
    } finally {
      roland.apiGetRaw = original;
    }
  } finally {
    await close();
    if (saved === undefined) delete process.env[OD_KEY_ENV.valley];
    else process.env[OD_KEY_ENV.valley] = saved;
    odOffices.resetOdOfficeCache();
  }
});

test('an office switched off is refused with the switched-off reason', async () => {
  const settings = odOffices.OFFICE_OD_SETTINGS.valley;
  const saved = settings.odEnabled;
  settings.odEnabled = false;
  odOffices.resetOdOfficeCache();

  const { baseUrl, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/od/patients/7115?office=valley');
    assert.equal(res.status, 503);
    assert.equal(res.body.code, 'OFFICE_NOT_CONNECTED');
    assert.equal(res.body.reason, 'OFFICE_NOT_OD_CONNECTED');
  } finally {
    await close();
    settings.odEnabled = saved;
    odOffices.resetOdOfficeCache();
  }
});

test('the unmapped office bucket has no Open Dental path at all', async () => {
  // Two layers, and both matter. At the ROUTE, 'unknown' is not a TC office, so
  // requireOffice 400s before any OD resolution happens.
  const { baseUrl, close } = await bootTcApp();
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/od/patients/1?office=unknown');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_OFFICE');
  } finally {
    await close();
  }

  // At the REGISTRY, which is the layer that would have to hold if a future
  // route ever accepted a wider office set, it is a 409 OFFICE_UNKNOWN.
  assert.throws(
    () => odOffices.getOdOffice('unknown'),
    (err) => err.name === 'OdOfficeError' && err.code === 'OFFICE_UNKNOWN'
  );
  try {
    odOffices.getOdOffice('unknown');
  } catch (err) {
    assert.equal(odOffices.httpStatusFor(err), 409);
  }
});

test('OD routes still enforce the shared office param rules', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    for (const qs of ['', '?office=riley']) {
      const res = await api(baseUrl, 'GET', `/api/tc/od/patients${qs}`);
      assert.equal(res.status, 400);
      assert.equal(res.body.code, 'INVALID_OFFICE');
    }
  } finally {
    await close();
  }
});

test('unentitled tenant cannot reach OD reads', async () => {
  const { baseUrl, close } = await bootTcApp({ modules: ['voice'] });
  try {
    const res = await api(baseUrl, 'GET', '/api/tc/od/patients?q=test&office=roland');
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'MODULE_NOT_ENTITLED');
  } finally {
    await close();
  }
});

// ── 2. Input validation ─────────────────────────────────────────────────────

test('a non-numeric PatNum is rejected before any OD call', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd({ '/': () => [] }, async (od) => {
      for (const bad of ['abc', '1;DROP', '../patients/1', '-5', '0', '1.5']) {
        const res = await api(
          baseUrl,
          'GET',
          `/api/tc/od/patients/${encodeURIComponent(bad)}?office=roland`
        );
        assert.equal(res.status, 400, `PatNum '${bad}' must 400`);
        assert.equal(res.body.code, 'INVALID_PATNUM');
      }
      assert.equal(od.calls.length, 0, 'a rejected PatNum must never reach Open Dental');
    });
  } finally {
    await close();
  }
});

// ── 3. Patient search ───────────────────────────────────────────────────────

test('patient search merges name lanes, drops non-patients, reports prefix matching', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/patients': (_p, params) => {
          if (params.LName) {
            return [
              PATIENT,
              { ...PATIENT, PatNum: 12827, FName: 'Stedi', LName: 'Test 2' },
              { ...PATIENT, PatNum: 999, FName: 'Gone', LName: 'Testerson', PatStatus: 'Deceased' },
            ];
          }
          // First-name lane repeats one patient — dedupe must hold.
          return [PATIENT, { ...PATIENT, PatNum: 4242, FName: 'Test', LName: 'Ing' }];
        },
      },
      async (od) => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/patients?q=Test&office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.matchMode, 'prefix', 'the UI must be told this is a starts-with match');

        const nums = res.body.patients.map((p) => p.patNum);
        assert.deepEqual(nums, [12828, 12827, 4242], 'merged, de-duplicated, in lane order');
        assert.ok(!nums.includes(999), 'deceased patients are excluded');

        const first = res.body.patients[0];
        assert.equal(first.birthdate, '1990-04-01', 'DOB is returned for disambiguation');
        assert.equal(first.phone, '9185550100', 'the cell number is preferred, as in the legacy app');
        assert.equal(first.displayName, 'MangoTest, Mango');

        // Both lanes ran because the last-name lane returned fewer than 5 rows.
        assert.equal(od.calls.filter((c) => c.path === '/patients').length, 2);
      }
    );
  } finally {
    await close();
  }
});

test('a short search never calls OD and is not an error', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd({ '/patients': () => [PATIENT] }, async (od) => {
      const res = await api(baseUrl, 'GET', '/api/tc/od/patients?q=T&office=roland');
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.patients, []);
      assert.equal(od.calls.length, 0);
    });
  } finally {
    await close();
  }
});

test('the search term is never written to the audit trail', async () => {
  const { baseUrl, db, close } = await bootTcApp();
  try {
    await withOd({ '/patients': () => [PATIENT] }, async () => {
      await api(baseUrl, 'GET', '/api/tc/od/patients?q=Sparkman&office=roland');
    });
    const rows = auditRows(db);
    assert.equal(rows.length, 1, 'exactly one audit row per PHI read');
    assert.equal(rows[0].action, 'READ');
    assert.equal(rows[0].resource_type, 'od_patient_search');
    assert.equal(rows[0].resource_id, null, 'the query is PHI — it must not be recorded');
    assert.ok(
      !JSON.stringify(rows[0]).includes('Sparkman'),
      'no part of the audit row may contain the search term'
    );
  } finally {
    await close();
  }
});

// ── 4. Treatment plan ───────────────────────────────────────────────────────

const SAVED_PLAN = { TreatPlanNum: 77, PatNum: 12828, TPStatus: 'Saved', Heading: 'Saved TP', SecDateTEdit: '2026-07-01 10:00:00' };
const ACTIVE_PLAN = { TreatPlanNum: 88, PatNum: 12828, TPStatus: 'Active', Heading: 'Active TP' };

test('treatment plan reads Saved plans through proctps', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/treatplans': () => [SAVED_PLAN, ACTIVE_PLAN],
        '/proctps': () => [
          { ProcTPNum: 1, ProcNumOrig: 501, ProcCode: 'D2750', Descript: 'Crown', FeeAmt: 1300, PriInsAmt: 650, ToothNumTP: '19' },
          { ProcTPNum: 2, ProcNumOrig: 502, ProcCode: 'D0150', Descript: 'Exam', FeeAmt: 0 },
        ],
      },
      async (od) => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/treatment-plan/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.source.status, 'Saved');
        assert.equal(res.body.procedures.length, 1, 'the zero-fee procedure is not billable');

        const crown = res.body.procedures[0];
        assert.equal(crown.procCode, 'D2750');
        assert.equal(crown.fee, 1300);
        assert.equal(crown.insEst, 650);
        assert.equal(crown.patAmt, 650, 'patient portion = fee − insurance estimate');
        assert.equal(crown.toothNum, '19', 'proctp stores the tooth in ToothNumTP');

        assert.equal(res.body.partial, false);
        assert.ok(!od.calls.some((c) => c.path.startsWith('/treatplanattach')), 'a Saved plan short-circuits the Active path');
      }
    );
  } finally {
    await close();
  }
});

test('treatment plan falls back to the Active path and to legacy singular resource names', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/treatplans': () => [ACTIVE_PLAN],
        // This OD build exposes neither plural alias — exercise both fallbacks.
        '/treatplanattaches': () => ({ ok: false, status: 404, data: 'not a valid resource', error: 'not a valid resource' }),
        '/treatplanattach': () => [{ TreatPlanAttachNum: 1, ProcNum: 601 }, { TreatPlanAttachNum: 2, ProcNum: 602 }],
        '/procedurelogs/601': () => ({ ProcNum: 601, procCode: 'D2740', descript: 'Crown', ProcFee: 1200, ToothNum: '3', PriInsEst: 600 }),
        '/procedurelogs/602': () => ({ ok: false, status: 500, data: null, error: 'upstream blew up' }),
      },
      async (od) => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/treatment-plan/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.source.status, 'Active');
        assert.equal(res.body.procedures.length, 1);
        assert.equal(res.body.procedures[0].procCode, 'D2740');

        // PARTIAL, not all-or-nothing: the good procedure survives, the bad one is named.
        assert.equal(res.body.partial, true, 'a failed procedure makes the result partial');
        assert.equal(res.body.unreadable.length, 1);
        assert.equal(res.body.unreadable[0].procNum, 602);
        assert.ok(
          res.body.notes.some((n) => n.includes('could not be read')),
          'the user is told procedures are missing from the totals'
        );
        assert.ok(od.calls.some((c) => c.path === '/treatplanattaches'), 'plural is tried first');
        assert.ok(od.calls.some((c) => c.path === '/treatplanattach'), 'the legacy singular alias is the fallback');
      }
    );
  } finally {
    await close();
  }
});

test('a treatment plan larger than the cap reports truncation instead of short-paying silently', async () => {
  const { baseUrl, close } = await bootTcApp();
  const attachments = Array.from({ length: odReads.TP_ATTACH_CAP + 5 }, (_, i) => ({ ProcNum: 700 + i }));
  try {
    await withOd(
      {
        '/treatplans': () => [ACTIVE_PLAN],
        '/treatplanattaches': () => attachments,
        '/procedurelogs/': (path) => ({
          ProcNum: Number(path.split('/').pop()),
          procCode: 'D2750',
          descript: 'Crown',
          ProcFee: 100,
          ToothNum: '1',
        }),
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/treatment-plan/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.truncated, true);
        assert.equal(res.body.procedures.length, odReads.TP_ATTACH_CAP);
        assert.ok(res.body.notes.some((n) => n.includes(String(odReads.TP_ATTACH_CAP))));
      }
    );
  } finally {
    await close();
  }
});

test('a blocked procedure resource produces an actionable note, not an empty plan', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/treatplans': () => [SAVED_PLAN],
        '/proctps': () => ({ ok: false, status: 404, data: 'not a valid resource', error: 'not a valid resource' }),
        '/proctp': () => ({ ok: false, status: 404, data: 'not a valid resource', error: 'not a valid resource' }),
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/treatment-plan/12828?office=roland');
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.procedures, []);
        assert.ok(
          res.body.notes.some((n) => n.includes('developer portal')),
          'the note tells the user how to fix it'
        );
        assert.equal(res.body.plans.length, 1, 'the plans that DO exist are still reported');
      }
    );
  } finally {
    await close();
  }
});

test('a treatment plan read that fails outright is a structured 502, never a fake empty plan', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      { '/treatplans': () => ({ ok: false, status: 500, data: null, error: 'OD down' }) },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/treatment-plan/12828?office=roland');
        assert.equal(res.status, 502);
        assert.equal(res.body.code, 'OD_READ_FAILED');
        assert.equal(res.body.success, false);
      }
    );
  } finally {
    await close();
  }
});

// ── 5. Unaccepted finder (the ex-MySQL read) ────────────────────────────────

test('the unaccepted finder groups, filters and ranks the way the legacy SQL did', async () => {
  const { baseUrl, close } = await bootTcApp();
  const recent = new Date();
  recent.setDate(recent.getDate() - 10);
  const recentStr = recent.toISOString().slice(0, 10);

  try {
    await withOd(
      {
        '/procedurelogs': (_p, params) => {
          if (Number(params.Offset) > 0) return [];
          return [
            { ProcNum: 1, PatNum: 12828, ProcFee: 900, DateTP: recentStr, ProcStatus: 'TP' },
            { ProcNum: 2, PatNum: 12828, ProcFee: 700, DateTP: recentStr, ProcStatus: 'TP' },
            // Below the fee floor once grouped.
            { ProcNum: 3, PatNum: 12827, ProcFee: 100, DateTP: recentStr, ProcStatus: 'TP' },
            // Outside the date window.
            { ProcNum: 4, PatNum: 4242, ProcFee: 5000, DateTP: '2019-01-01', ProcStatus: 'TP' },
            // Zero fee.
            { ProcNum: 5, PatNum: 4242, ProcFee: 0, DateTP: recentStr, ProcStatus: 'TP' },
          ];
        },
        '/patients/12828': () => PATIENT,
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/unaccepted?minFee=500&days=90&office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.patients.length, 1, 'only the patient clearing the fee floor inside the window');

        const row = res.body.patients[0];
        assert.equal(row.patNum, 12828);
        assert.equal(row.procCount, 2);
        assert.equal(row.totalFee, 1600);
        assert.equal(row.displayName, 'MangoTest, Mango');
        assert.equal(row.earliestTP, recentStr);
        assert.equal(res.body.truncated, false);

        // The coverage table is the deliverable — it must name the client-side work.
        const byElement = Object.fromEntries(res.body.coverage.map((c) => [c.element, c]));
        assert.equal(byElement['Procedure fee (ProcFee)'].status, 'confirmed');
        assert.equal(byElement['TP date window (DateTP)'].status, 'partial');
        assert.equal(byElement['Fee floor / total per patient (HAVING SUM)'].status, 'partial');
        assert.equal(byElement['Patient name / DOB / phone / email'].status, 'partial');
      }
    );
  } finally {
    await close();
  }
});

test('a patient whose record cannot be read keeps its money and says the name is missing', async () => {
  const { baseUrl, close } = await bootTcApp();
  const today = new Date().toISOString().slice(0, 10);
  try {
    await withOd(
      {
        '/procedurelogs': (_p, params) =>
          Number(params.Offset) > 0 ? [] : [{ ProcNum: 1, PatNum: 12828, ProcFee: 900, DateTP: today, ProcStatus: 'TP' }],
        '/patients/12828': () => ({ ok: false, status: 500, data: null, error: 'boom' }),
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/unaccepted?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.patients.length, 1, 'the row is not silently dropped');
        assert.equal(res.body.patients[0].demographicsUnavailable, true);
        assert.equal(res.body.patients[0].displayName, 'PatNum 12828');
        assert.ok(res.body.notes.some((n) => n.includes('could not be read')));
      }
    );
  } finally {
    await close();
  }
});

test('an OD build without the ProcStatus filter degrades to a client-side scan and says so', async () => {
  const { baseUrl, close } = await bootTcApp();
  const today = new Date().toISOString().slice(0, 10);
  try {
    await withOd(
      {
        '/procedurelogs': (_p, params) => {
          if (params.ProcStatus) {
            return { ok: false, status: 400, data: "'ProcStatus' is not a valid parameter", error: "'ProcStatus' is not a valid parameter" };
          }
          if (Number(params.Offset) > 0) return [];
          return [
            { ProcNum: 1, PatNum: 12828, ProcFee: 900, DateTP: today, ProcStatus: 'TP' },
            { ProcNum: 2, PatNum: 12828, ProcFee: 5000, DateTP: today, ProcStatus: 'C' },
          ];
        },
        '/patients/12828': () => PATIENT,
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/unaccepted?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.patients[0].totalFee, 900, 'completed procedures are excluded client-side');
        assert.ok(res.body.notes.some((n) => n.includes('ProcStatus')));
        const covRow = res.body.coverage.find((c) => c.element.includes('ProcStatus=TP'));
        assert.equal(covRow.status, 'partial');
      }
    );
  } finally {
    await close();
  }
});

test('a scan that hits the page cap reports a partial sweep', async () => {
  const { baseUrl, close } = await bootTcApp();
  const today = new Date().toISOString().slice(0, 10);
  const fullPage = Array.from({ length: 100 }, (_, i) => ({
    ProcNum: i,
    PatNum: 12828,
    ProcFee: 10,
    DateTP: today,
    ProcStatus: 'TP',
  }));
  try {
    await withOd(
      { '/procedurelogs': () => fullPage, '/patients/12828': () => PATIENT },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/unaccepted?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.truncated, true);
        assert.ok(res.body.notes.some((n) => n.includes('the practice has more')));
        const covRow = res.body.coverage.find((c) => c.element === 'Full-practice completeness');
        assert.equal(covRow.status, 'gap');
      }
    );
  } finally {
    await close();
  }
});

// ── 6. COB + insurance (the other ex-MySQL read) ────────────────────────────

/** Two plans on one patient, as the live Roland probe found for PatNum 12828. */
const PATPLANS = [
  { PatPlanNum: 10, PatNum: 12828, Ordinal: 1, InsSubNum: 100 },
  { PatPlanNum: 11, PatNum: 12828, Ordinal: 2, InsSubNum: 101 },
];
const INSSUBS = { '/inssubs/100': () => ({ InsSubNum: 100, PlanNum: 900 }), '/inssubs/101': () => ({ InsSubNum: 101, PlanNum: 901 }) };

test('COB procedures derive the contracted allowed amount from claimproc', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/procedurelogs': () => [
          { ProcNum: 501, PatNum: 12828, ProcFee: 1300, ProcStatus: 'TP', procCode: 'D2750', descript: 'Crown', ToothNum: '19', Surf: '' },
        ],
        '/patplans': () => PATPLANS,
        ...INSSUBS,
        '/claimprocs': (_p, params) =>
          Number(params.Offset) > 0
            ? []
            : [
                // Primary estimate: allowed = 1300 − 300.
                { ProcNum: 501, InsSubNum: 100, PlanNum: 900, Status: 'Estimate', WriteOffEst: 300, InsEstTotal: 650, DedEst: 50 },
                // Secondary estimate: allowed = 1300 − 200.
                { ProcNum: 501, InsSubNum: 101, PlanNum: 901, Status: 'Estimate', WriteOffEst: 200, InsEstTotal: 200, DedEst: 0 },
                // A Received row on the SAME procedure — money already paid, not
                // an estimate. Counting it would double the insurance estimate.
                { ProcNum: 501, InsSubNum: 100, PlanNum: 900, Status: 'Received', InsPayAmt: 900, InsEstTotal: 900, WriteOffEst: 0 },
              ],
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/cob-procedures/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.procs.length, 1);

        const p = res.body.procs[0];
        assert.equal(p.fee, 1300);
        assert.equal(p.primaryAllowed, 1000, 'allowed = fee − WriteOffEst, exactly as the legacy SQL');
        assert.equal(p.secondaryAllowed, 1100);
        assert.equal(p.primaryInsEst, 650, 'the Received row must not inflate the estimate');
        assert.equal(p.secondaryInsEst, 200);
        assert.equal(p.primaryDedEst, 50);
        assert.equal(p.allowedIsBilledFee, false);
        assert.equal(p.estimateSource, 'claimproc');

        const allowed = res.body.coverage.find((c) => c.element.includes('contracted allowed amount'));
        assert.equal(allowed.status, 'confirmed');
        assert.equal(res.body.fallbackLines, 0);
      }
    );
  } finally {
    await close();
  }
});

test("Open Dental's -1 'not calculated' sentinel never becomes a dollar amount", async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/procedurelogs': () => [{ ProcNum: 501, PatNum: 12828, ProcFee: 86, ProcStatus: 'TP', procCode: 'D0140' }],
        '/patplans': () => PATPLANS,
        ...INSSUBS,
        '/claimprocs': (_p, params) =>
          Number(params.Offset) > 0
            ? []
            : [{ ProcNum: 501, InsSubNum: 100, PlanNum: 900, Status: 'Estimate', WriteOffEst: -1, InsEstTotal: 86, DedEst: -1 }],
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/cob-procedures/12828?office=roland');
        const p = res.body.procs[0];
        // The legacy COALESCE(WriteOffEst, 0) would have produced 86 − (−1) = 87.
        assert.equal(p.primaryAllowed, 86, 'a -1 write-off means "no estimate", not a $1 discount');
        assert.equal(p.allowedIsBilledFee, true);
        assert.equal(p.primaryDedEst, null, 'an uncalculated deductible stays null, never 0');
        assert.equal(res.body.fallbackLines, 1);
        assert.ok(res.body.notes.some((n) => n.includes('no contracted allowed amount')));
      }
    );
  } finally {
    await close();
  }
});

test("OD's *Override columns win, so the panel agrees with the Open Dental screen", async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/procedurelogs': () => [{ ProcNum: 501, PatNum: 12828, ProcFee: 1000, ProcStatus: 'TP', procCode: 'D2750' }],
        '/patplans': () => PATPLANS,
        ...INSSUBS,
        '/claimprocs': (_p, params) =>
          Number(params.Offset) > 0
            ? []
            : [
                {
                  ProcNum: 501, InsSubNum: 100, PlanNum: 900, Status: 'Estimate',
                  WriteOffEst: 100, WriteOffEstOverride: 250,
                  InsEstTotal: 400, InsEstTotalOverride: 500,
                },
              ],
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/cob-procedures/12828?office=roland');
        const p = res.body.procs[0];
        assert.equal(p.primaryAllowed, 750, 'the override write-off is used, not the computed one');
        assert.equal(p.primaryInsEst, 500);
      }
    );
  } finally {
    await close();
  }
});

test('a claimproc read that fails degrades the estimates without losing the fee list', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/procedurelogs': () => [{ ProcNum: 501, PatNum: 12828, ProcFee: 1300, ProcStatus: 'TP', procCode: 'D2750' }],
        '/patplans': () => PATPLANS,
        ...INSSUBS,
        '/claimprocs': () => ({ ok: false, status: 404, data: 'not a valid resource', error: 'not a valid resource' }),
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/cob-procedures/12828?office=roland');
        assert.equal(res.status, 200, 'the procedure list still comes back');
        assert.equal(res.body.procs.length, 1);
        assert.equal(res.body.procs[0].primaryAllowed, 1300);
        assert.equal(res.body.claimProcsAvailable, false);
        const allowed = res.body.coverage.find((c) => c.element.includes('contracted allowed amount'));
        assert.equal(allowed.status, 'gap');
        assert.ok(res.body.notes.some((n) => n.includes('billed fee')));
      }
    );
  } finally {
    await close();
  }
});

test('the insurance snapshot builds the plan chain and sums YTD from paid claimprocs', async () => {
  const { baseUrl, close } = await bootTcApp();
  const year = new Date().getFullYear();
  try {
    await withOd(
      {
        '/patplans': () => [
          { PatPlanNum: 10, PatNum: 12828, Ordinal: 1, InsSubNum: 100, Relationship: 'Self' },
          { PatPlanNum: 11, PatNum: 12828, Ordinal: 2, InsSubNum: 101, Relationship: 'Spouse' },
        ],
        '/inssubs/100': () => ({ InsSubNum: 100, PlanNum: 900, DateEffective: '2020-01-01', DateTerm: '0001-01-01' }),
        '/inssubs/101': () => ({ InsSubNum: 101, PlanNum: 901, DateEffective: '2021-06-01' }),
        '/insplans/900': () => ({ PlanNum: 900, GroupName: 'ACME', GroupNum: 'G1', CarrierNum: 5, PlanType: 'p', CobRule: 'Standard', MonthRenew: 0 }),
        '/insplans/901': () => ({ PlanNum: 901, GroupName: 'OTHER', CarrierNum: 6, PlanType: '', CobRule: 'CarveOut', MonthRenew: 7 }),
        '/carriers/5': () => ({ CarrierNum: 5, CarrierName: 'Delta Dental' }),
        '/carriers/6': () => ({ CarrierNum: 6, CarrierName: 'BCBS' }),
        '/benefits': (_p, params) =>
          Number(params.PlanNum) === 900
            ? [
                { BenefitType: 'Limitations', MonetaryAmt: 1500, CoverageLevel: 'Individual' },
                { BenefitType: 'Deductible', MonetaryAmt: 50 },
                { BenefitType: 'CoInsurance', Percent: 80, CovCatNum: 2 },
              ]
            : [],
        '/claimprocs': (_p, params) =>
          Number(params.Offset) > 0
            ? []
            : [
                { InsSubNum: 100, PlanNum: 900, Status: 'Received', DateCP: `${year}-03-01`, InsPayAmt: 300, DedApplied: 50 },
                { InsSubNum: 100, PlanNum: 900, Status: 'Supplemental', DateCP: `${year}-04-01`, InsPayAmt: 100, DedApplied: 0 },
                // Prior benefit year — must not count.
                { InsSubNum: 100, PlanNum: 900, Status: 'Received', DateCP: `${year - 2}-03-01`, InsPayAmt: 9999, DedApplied: 50 },
                // An ESTIMATE for planned work must never count against the max.
                { InsSubNum: 100, PlanNum: 900, Status: 'Estimate', DateCP: `${year}-05-01`, InsPayAmt: 5000, DedApplied: 0 },
              ],
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/insurance/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.plans.length, 2);

        const primary = res.body.plans[0];
        assert.equal(primary.role, 'primary');
        assert.equal(primary.carrierName, 'Delta Dental');
        assert.equal(primary.annualMax, 1500);
        assert.equal(primary.deductible, 50);
        assert.deepEqual(primary.coinsurance, [{ percent: 80, category: 2, procCode: null }]);
        assert.equal(
          primary.usage.paidYTD,
          400,
          'Received + Supplemental inside the benefit year; the prior-year row and the Estimate are excluded'
        );
        assert.equal(primary.usage.dedAppliedYTD, 50);
        assert.equal(primary.usage.benefitYearStart, `${year}-01-01`);
        assert.equal(primary.remainingMax, 1100);
        assert.equal(primary.remainingDeductible, 0);

        const secondary = res.body.plans[1];
        assert.equal(secondary.role, 'secondary');
        assert.equal(secondary.usage.basis, 'plan year starting 07/01', 'the plan renewal month drives the basis');
        assert.equal(secondary.usage.paidYTD, 0, 'the secondary plan has no paid claimprocs');
        assert.equal(secondary.remainingMax, null, 'no annual maximum on file stays null, never 0');

        assert.equal(res.body.ytdAvailable, true);
        assert.match(res.body.ytdBasis, /paid claims since/i);
        assert.match(res.body.ytdBasis, /not yet paid are not subtracted/i);
        const ytd = res.body.coverage.find((c) => c.element.includes('YTD paid'));
        assert.equal(ytd.status, 'confirmed');
        assert.match(ytd.note, /DateCP/);
      }
    );
  } finally {
    await close();
  }
});

test('an unreadable plan leg degrades that plan, not the whole snapshot', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd(
      {
        '/patplans': () => [{ PatPlanNum: 10, PatNum: 12828, Ordinal: 1, InsSubNum: 100 }],
        '/inssubs/100': () => ({ ok: false, status: 500, data: null, error: 'boom' }),
        '/claimprocs': () => [],
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/insurance/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.plans.length, 1);
        assert.deepEqual(res.body.plans[0].unreadable, ['subscription']);
        assert.equal(res.body.plans[0].annualMax, null, 'an unknown maximum stays null, never 0');
      }
    );
  } finally {
    await close();
  }
});

// ── 7. Next appointment ─────────────────────────────────────────────────────

test('next appointment returns the soonest future scheduled visit', async () => {
  const { baseUrl, close } = await bootTcApp();
  const soon = new Date();
  soon.setDate(soon.getDate() + 3);
  const later = new Date();
  later.setDate(later.getDate() + 30);
  const fmt = (d) => `${d.toISOString().slice(0, 10)} 09:00:00`;
  try {
    await withOd(
      {
        '/appointments': () => [
          { AptNum: 2, AptDateTime: fmt(later), AptStatus: 'Scheduled', ProcDescript: 'Crown seat', provAbbr: 'BS' },
          { AptNum: 1, AptDateTime: fmt(soon), AptStatus: 'Scheduled', ProcDescript: 'Prep', provAbbr: 'BS', IsHygiene: false },
          { AptNum: 3, AptDateTime: fmt(soon), AptStatus: 'Broken', ProcDescript: 'Old' },
        ],
      },
      async () => {
        const res = await api(baseUrl, 'GET', '/api/tc/od/next-appointment/12828?office=roland');
        assert.equal(res.status, 200);
        assert.equal(res.body.appointment.aptNum, 1, 'soonest first');
        assert.equal(res.body.appointment.description, 'Prep');
        assert.equal(res.body.appointment.providerName, 'BS');
      }
    );
  } finally {
    await close();
  }
});

test('no upcoming appointment is a null result, not an error', async () => {
  const { baseUrl, close } = await bootTcApp();
  try {
    await withOd({ '/appointments': () => [] }, async () => {
      const res = await api(baseUrl, 'GET', '/api/tc/od/next-appointment/12828?office=roland');
      assert.equal(res.status, 200);
      assert.equal(res.body.appointment, null);
    });
  } finally {
    await close();
  }
});

// ── 8. Read-only guarantee ──────────────────────────────────────────────────

test('no OD route reaches a write method — the transport is GET-only by construction', async () => {
  const fs = require('node:fs');
  const path = require('node:path');

  for (const file of ['od.js', 'odReads.js', 'odPatientSearch.js']) {
    const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.ok(!/router\.(post|put|patch|delete)\s*\(/.test(src), `${file} must expose only GET routes`);
    assert.ok(
      !/(bookAppointment|updateAppointment|cancelAppointment|createCommLog|apiPost|apiPut|apiDelete)/.test(src),
      `${file} must not name an Open Dental write method`
    );

    // The office handle carries a FULL OpenDentalService, writes included — which
    // is exactly why it must never escape the transport closure. Every member
    // these files touch on it has to be apiGetRaw, and nothing else.
    const members = [...src.matchAll(/\.client\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    for (const m of members) {
      assert.equal(m, 'apiGetRaw', `${file} reached client.${m} — only apiGetRaw is allowed`);
    }
  }
});

// ── 9. Pure helpers ─────────────────────────────────────────────────────────

test('mapLimit bounds concurrency and isolates failures', async () => {
  let inFlight = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await odReads.mapLimit(items, 3, async (i) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    if (i === 4) throw new Error('nope');
    return i * 2;
  });
  assert.ok(peak <= 3, `expected at most 3 in flight, saw ${peak}`);
  assert.equal(out.length, 12);
  assert.equal(out[4].ok, false);
  assert.equal(out[5].value, 10, 'a failure does not disturb its neighbours');
});

test('benefitYearStart honours the plan renewal month', () => {
  const year = new Date().getFullYear();
  assert.deepEqual(odReads.benefitYearStart(0), { start: `${year}-01-01`, basis: 'calendar year' });
  const july = odReads.benefitYearStart(7);
  assert.match(july.start, /-07-01$/);
  assert.equal(july.basis, 'plan year starting 07/01');
  // A month that has not arrived yet rolls back to last year's renewal.
  const jan = odReads.benefitYearStart(1);
  assert.equal(jan.start, `${year}-01-01`);
});

test('odDate never renders the Open Dental null date as a real date', () => {
  assert.equal(odReads.odDate('0001-01-01 00:00:00'), '');
  assert.equal(odReads.odDate('0001-01-01'), '');
  assert.equal(odReads.odDate('2026-08-04 09:00:00'), '2026-08-04');
  assert.equal(odReads.odDate(''), '');
  assert.equal(odReads.odDate(null), '');
});

test('normalizeProc reads both the proctp and procedurelog shapes', () => {
  const fromProcTp = odReads.normalizeProc({ ProcTPNum: 9, ToothNumTP: '30', ProcCode: 'd2750', FeeAmt: 1000, PriInsAmt: 400, SecInsAmt: 100 });
  assert.equal(fromProcTp.procNum, 9);
  assert.equal(fromProcTp.toothNum, '30');
  assert.equal(fromProcTp.procCode, 'D2750');
  assert.equal(fromProcTp.insEst, 500);
  assert.equal(fromProcTp.patAmt, 500);

  const fromProcLog = odReads.normalizeProc({ ProcNum: 7, ToothNum: '3', procCode: 'D2740', ProcFee: 800 });
  assert.equal(fromProcLog.procNum, 7);
  assert.equal(fromProcLog.patAmt, 800, 'with no estimate the patient owes the fee');
  assert.equal(fromProcLog.toothNum, '3');

  const noTooth = odReads.normalizeProc({ ProcNum: 1, ProcFee: 50, procCode: 'D0220' });
  assert.equal(noTooth.toothNum, 'N/A');
});

test('isCapabilityMiss separates a blocked resource from an outage', () => {
  assert.equal(odReads.isCapabilityMiss({ ok: false, status: 404, error: 'not a valid resource' }), true);
  assert.equal(odReads.isCapabilityMiss({ ok: false, status: 400, error: "'ProcStatus' is not a valid parameter" }), true);
  assert.equal(odReads.isCapabilityMiss({ ok: false, status: 500, error: 'internal error' }), false);
  assert.equal(odReads.isCapabilityMiss({ ok: false, status: 0, error: 'timeout' }), false);
  assert.equal(odReads.isCapabilityMiss({ ok: true, status: 200 }), false);
});
