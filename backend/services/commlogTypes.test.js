'use strict';

// Per-office commlog-type catalogue + the validation that replaces the 486/451
// never-cross CONVENTION with an enforced check. Runner: `node --test`.
//
// The fixtures below are the REAL lists, read live from both practices'
// `GET /definitions?Category=27` on 2026-08-13. They are practice configuration,
// not patient data, and using the real ones is the point: they contain the two
// facts the whole design rests on.
//
//   1. 486 ("CareIN AI Call" in Roland) does not appear in Riley/valley's list AT
//      ALL, and 451 ("CareIN AI Call" in Riley) does not appear in Roland's. List
//      membership therefore IS the cross-office check.
//   2. DefNum 401 is a valid, selectable type in BOTH — "ODHQ" in Roland,
//      "Crown by Moolah" in Riley. So there is no global allowlist to check a
//      DefNum against, and a number being "reasonable" proves nothing. The only
//      answerable question is membership in ONE office's list.

const test = require('node:test');
const assert = require('node:assert/strict');
const { beforeEach } = test;

const commlogTypes = require('./commlogTypes');

/** Roland's commlog types, as OD returns them (Category 27, isHidden a STRING). */
const ROLAND_DEFS = [
  [224, 'ApptRelated'], [225, 'Insurance'], [226, 'Financial'], [478, 'Treatment Coordinator'],
  [228, 'Misc'], [476, 'Lab Cases'], [401, 'ODHQ'], [465, 'Crown by Moolah'],
  [227, 'Recall'], [441, 'Text'], [427, 'FHIR'], [486, 'CareIN AI Call'],
].map(([DefNum, ItemName]) => ({ DefNum, ItemName, ItemValue: '', Category: 27, category: 'CommLogTypes', isHidden: 'false' }));

/** Riley/valley's. Same twelve concepts, twelve DIFFERENT numbers. */
const VALLEY_DEFS = [
  [235, 'ApptRelated'], [236, 'Insurance'], [237, 'Financial'], [436, 'Treatment Coordinator'],
  [239, 'Misc'], [437, 'Lab Cases'], [298, 'ODHQ'], [401, 'Crown by Moolah'],
  [238, 'Recall'], [375, 'Text'], [360, 'FHIR'], [451, 'CareIN AI Call'],
].map(([DefNum, ItemName]) => ({ DefNum, ItemName, ItemValue: '', Category: 27, category: 'CommLogTypes', isHidden: 'false' }));

/**
 * A stand-in for an office-bound OD handle. Records every definitions read so a
 * test can prove the cache spared OD a round trip — or that a validation never
 * needed one at all.
 * @param {{ officeKey: string, commTypeDefNum: number, defs?: unknown, ok?: boolean, status?: number }} spec
 */
function fakeOd(spec) {
  const handle = {
    officeKey: spec.officeKey,
    officeName: spec.officeKey,
    commTypeDefNum: spec.commTypeDefNum,
    reads: 0,
    /** Flip mid-test to simulate OD going away. */
    ok: spec.ok !== false,
    defs: spec.defs,
    client: {
      async apiGetRaw(path, params) {
        handle.reads += 1;
        handle.lastPath = path;
        handle.lastParams = params;
        if (!handle.ok) return { ok: false, status: spec.status || 503, data: null, error: 'OD unreachable' };
        return { ok: true, status: 200, data: handle.defs };
      },
    },
  };
  return handle;
}

const roland = () => fakeOd({ officeKey: 'roland', commTypeDefNum: 486, defs: ROLAND_DEFS });
const valley = () => fakeOd({ officeKey: 'valley', commTypeDefNum: 451, defs: VALLEY_DEFS });

beforeEach(() => {
  commlogTypes.resetCommlogTypeCache();
});

// ── The category is not a guess ──────────────────────────────────────────────

test('reads definitions Category 27 — the category OD documents for CommType', async () => {
  const od = roland();
  await commlogTypes.listForOffice(od);

  assert.equal(commlogTypes.COMMLOG_TYPES_CATEGORY, 27);
  assert.equal(od.lastPath, '/definitions');
  assert.deepEqual(od.lastParams, { Category: 27 });
  // includeHidden is deliberately absent: OD defaults it to false, so retired
  // types never even reach us.
  assert.equal('includeHidden' in od.lastParams, false);
});

// ── What gets offered ────────────────────────────────────────────────────────

test('offers the office its own list, with its own default named', async () => {
  const result = await commlogTypes.listForOffice(roland());

  assert.equal(result.available, true);
  assert.equal(result.defaultDefNum, 486);
  assert.equal(result.defaultName, 'CareIN AI Call');
  assert.equal(result.options.length, 12);
  assert.deepEqual(
    result.options.find((o) => o.defNum === 486),
    { defNum: 486, name: 'CareIN AI Call' }
  );
});

test("one office's list never contains the other's CareIN DefNum", async () => {
  const r = await commlogTypes.listForOffice(roland());
  commlogTypes.resetCommlogTypeCache();
  const v = await commlogTypes.listForOffice(valley());

  assert.equal(r.options.some((o) => o.defNum === 451), false, "451 is not a commlog type in Roland's database");
  assert.equal(v.options.some((o) => o.defNum === 486), false, "486 is not a commlog type in Riley's database");
});

test('the same DefNum names different things in different practices', async () => {
  const r = await commlogTypes.listForOffice(roland());
  commlogTypes.resetCommlogTypeCache();
  const v = await commlogTypes.listForOffice(valley());

  assert.equal(r.options.find((o) => o.defNum === 401).name, 'ODHQ');
  assert.equal(v.options.find((o) => o.defNum === 401).name, 'Crown by Moolah');
});

test('options are sorted by name so the dropdown order is stable', async () => {
  const { options } = await commlogTypes.listForOffice(roland());
  const names = options.map((o) => o.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
});

// ── Hidden definitions ───────────────────────────────────────────────────────
//
// OD's own includeHidden=false already drops these; we filter again because the
// published doc says `IsHidden` (boolean) and the live API returns `isHidden`
// (string). Code written from either spelling alone gets it wrong in one
// direction or the other.

test('hidden definitions are never offered — string "true", the live shape', async () => {
  const od = fakeOd({
    officeKey: 'roland',
    commTypeDefNum: 486,
    defs: [...ROLAND_DEFS, { DefNum: 999, ItemName: 'Retired Type', Category: 27, isHidden: 'true' }],
  });
  const { options } = await commlogTypes.listForOffice(od);
  assert.equal(options.some((o) => o.defNum === 999), false);
});

test('hidden definitions are never offered — boolean true and PascalCase IsHidden', async () => {
  const od = fakeOd({
    officeKey: 'roland',
    commTypeDefNum: 486,
    defs: [
      ...ROLAND_DEFS,
      { DefNum: 998, ItemName: 'Hidden Bool', Category: 27, isHidden: true },
      { DefNum: 997, ItemName: 'Hidden Doc Spelling', Category: 27, IsHidden: true },
    ],
  });
  const { options } = await commlogTypes.listForOffice(od);
  assert.equal(options.some((o) => o.defNum === 998), false);
  assert.equal(options.some((o) => o.defNum === 997), false);
});

test('the live string "false" is NOT read as hidden — the whole list survives', async () => {
  const { options } = await commlogTypes.listForOffice(roland());
  assert.equal(options.length, 12, 'a truthy-string bug here would empty every dropdown');
});

test('a hidden DefNum is refused at send, not merely hidden from the picker', async () => {
  const od = fakeOd({
    officeKey: 'roland',
    commTypeDefNum: 486,
    defs: [...ROLAND_DEFS, { DefNum: 999, ItemName: 'Retired Type', Category: 27, isHidden: 'true' }],
  });
  await assert.rejects(
    () => commlogTypes.assertAllowed(od, 999),
    (err) => { assert.equal(err.code, 'COMMLOG_TYPE_INVALID'); return true; }
  );
});

// ── Rows that are not commlog types ──────────────────────────────────────────

test('rows from another definition category are dropped', () => {
  const options = commlogTypes.normalizeDefinitions([
    { DefNum: 486, ItemName: 'CareIN AI Call', Category: 27 },
    { DefNum: 12, ItemName: 'Blockout', Category: 6 },
  ]);
  assert.deepEqual(options, [{ defNum: 486, name: 'CareIN AI Call' }]);
});

test('unusable rows are dropped rather than offered as blanks', () => {
  const options = commlogTypes.normalizeDefinitions([
    { DefNum: 486, ItemName: 'CareIN AI Call', Category: 27 },
    { DefNum: 'nope', ItemName: 'Bad Num', Category: 27 },
    { DefNum: 487, ItemName: '   ', Category: 27 },
    { DefNum: 486, ItemName: 'Duplicate', Category: 27 },
    null,
  ]);
  assert.deepEqual(options, [{ defNum: 486, name: 'CareIN AI Call' }]);
});

test('a non-array body is no catalogue at all', () => {
  assert.deepEqual(commlogTypes.normalizeDefinitions({ error: 'nope' }), []);
  assert.deepEqual(commlogTypes.normalizeDefinitions(null), []);
});

// ── Validation: the enforcement point ────────────────────────────────────────

test("a type from the office's own list is accepted", async () => {
  assert.equal(await commlogTypes.assertAllowed(roland(), 227), 227); // Roland's "Recall"
  commlogTypes.resetCommlogTypeCache();
  assert.equal(await commlogTypes.assertAllowed(valley(), 238), 238); // Riley's "Recall"
});

test("the OTHER office's CareIN DefNum is refused — 451 on a roland call", async () => {
  await assert.rejects(
    () => commlogTypes.assertAllowed(roland(), 451),
    (err) => {
      assert.equal(err.name, 'CommlogTypeError');
      assert.equal(err.code, 'COMMLOG_TYPE_INVALID');
      assert.equal(commlogTypes.httpStatusFor(err), 400);
      return true;
    }
  );
});

test("the OTHER office's CareIN DefNum is refused — 486 on a valley call", async () => {
  await assert.rejects(
    () => commlogTypes.assertAllowed(valley(), 486),
    (err) => {
      assert.equal(err.code, 'COMMLOG_TYPE_INVALID');
      assert.equal(commlogTypes.httpStatusFor(err), 400);
      return true;
    }
  );
});

test('a DefNum that exists in no list at all is refused', async () => {
  await assert.rejects(
    () => commlogTypes.assertAllowed(roland(), 99999),
    (err) => { assert.equal(err.code, 'COMMLOG_TYPE_INVALID'); return true; }
  );
});

test('non-integer, zero and negative values are refused without asking OD', async () => {
  const od = roland();
  for (const bad of ['abc', '', 1.5, 0, -486, {}, []]) {
    await assert.rejects(
      () => commlogTypes.assertAllowed(od, bad),
      (err) => { assert.equal(err.code, 'COMMLOG_TYPE_INVALID'); return true; },
      `expected ${JSON.stringify(bad)} to be refused`
    );
  }
  assert.equal(od.reads, 0, 'a malformed value is not worth an OD round trip');
});

test('a numeric string of a valid type is accepted (query/JSON coercion)', async () => {
  assert.equal(await commlogTypes.assertAllowed(roland(), '227'), 227);
});

// ── Availability must never gate a chart write ───────────────────────────────

test("the office's OWN default is accepted without reading definitions at all", async () => {
  const od = roland();
  assert.equal(await commlogTypes.assertAllowed(od, 486), 486);
  assert.equal(od.reads, 0, 'a definitions outage must not be able to block a default send');
});

test('with OD unreachable, the default still sends and a non-default is refused honestly', async () => {
  const od = fakeOd({ officeKey: 'roland', commTypeDefNum: 486, ok: false });

  assert.equal(await commlogTypes.assertAllowed(od, 486), 486);

  await assert.rejects(
    () => commlogTypes.assertAllowed(od, 227),
    (err) => {
      // NOT "invalid" — 227 may well be perfectly valid; we cannot tell right now.
      assert.equal(err.code, 'COMMLOG_TYPE_UNVERIFIABLE');
      assert.equal(commlogTypes.httpStatusFor(err), 503);
      return true;
    }
  );
});

test('an unreachable OD reports no catalogue rather than throwing at the UI', async () => {
  const result = await commlogTypes.listForOffice(fakeOd({ officeKey: 'roland', commTypeDefNum: 486, ok: false }));
  assert.deepEqual(result, {
    available: false, options: [], defaultDefNum: 486, defaultName: null, stale: false,
  });
});

test('a 200 carrying nothing usable is not treated as an empty catalogue', async () => {
  const result = await commlogTypes.listForOffice(fakeOd({ officeKey: 'roland', commTypeDefNum: 486, defs: [] }));
  assert.equal(result.available, false);
});

test('a default that is not in the office list is offered, unnamed rather than mislabelled', async () => {
  const od = fakeOd({ officeKey: 'roland', commTypeDefNum: 12345, defs: ROLAND_DEFS });
  const result = await commlogTypes.listForOffice(od);

  assert.equal(result.available, true);
  assert.equal(result.defaultDefNum, 12345);
  assert.equal(result.defaultName, null);
  assert.equal(await commlogTypes.assertAllowed(od, 12345), 12345);
});

// ── Cache ────────────────────────────────────────────────────────────────────

test('the catalogue is read once per office and reused', async () => {
  const od = roland();
  await commlogTypes.listForOffice(od);
  await commlogTypes.listForOffice(od);
  await commlogTypes.assertAllowed(od, 227);

  assert.equal(od.reads, 1);
});

test('concurrent callers share one read', async () => {
  const od = roland();
  await Promise.all([
    commlogTypes.listForOffice(od),
    commlogTypes.listForOffice(od),
    commlogTypes.listForOffice(od),
  ]);
  assert.equal(od.reads, 1);
});

test('each office is cached separately — one never answers for the other', async () => {
  const r = roland();
  const v = valley();
  await commlogTypes.listForOffice(r);
  const result = await commlogTypes.listForOffice(v);

  assert.equal(v.reads, 1, "valley must read its own definitions, not inherit Roland's");
  assert.equal(result.defaultDefNum, 451);
  assert.equal(result.options.some((o) => o.defNum === 486), false);
});

test('a failed refresh serves the last good list rather than erroring the UI', async () => {
  const od = roland();
  await commlogTypes.listForOffice(od);

  // Expire the entry and take OD away.
  const realNow = Date.now;
  Date.now = () => realNow() + commlogTypes.CACHE_TTL_MS + 1;
  od.ok = false;
  try {
    const result = await commlogTypes.listForOffice(od);
    assert.equal(result.available, true);
    assert.equal(result.stale, true, 'the UI is told the list may be out of date');
    assert.equal(result.options.length, 12);

    // And a stale list is still a real answer, so validation keeps working.
    assert.equal(await commlogTypes.assertAllowed(od, 227), 227);
    await assert.rejects(
      () => commlogTypes.assertAllowed(od, 451),
      (err) => { assert.equal(err.code, 'COMMLOG_TYPE_INVALID'); return true; }
    );
  } finally {
    Date.now = realNow;
  }
});

test('the cache expires and re-reads once the TTL passes', async () => {
  const od = roland();
  await commlogTypes.listForOffice(od);

  const realNow = Date.now;
  Date.now = () => realNow() + commlogTypes.CACHE_TTL_MS + 1;
  try {
    await commlogTypes.listForOffice(od);
    assert.equal(od.reads, 2);
  } finally {
    Date.now = realNow;
  }
});

// ── The key-taking wrapper ───────────────────────────────────────────────────

test('an office with no Open Dental reports no catalogue instead of an error', async () => {
  const result = await commlogTypes.listForOfficeKey('unknown');
  assert.deepEqual(result, {
    available: false, options: [], defaultDefNum: null, defaultName: null, stale: false,
  });
});
