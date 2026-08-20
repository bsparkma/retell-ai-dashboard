'use strict';

/**
 * RCM Slice 6c — the per-office posting configuration registry.
 *
 * The fixtures below are Roland's REAL definition rows, as
 * `GET /definitions?Category=32|1|18` returned them live on 2026-08-13
 * (RCM_OD_WRITES §Probe C). They are practice configuration — DefNums and names
 * — and carry no patient data.
 *
 * The point of this suite is that **a plausible wrong answer is the failure mode
 * to design against**. Open Dental silently ignores list filters it does not
 * implement, so a 200 carrying the wrong rows is indistinguishable from a 200
 * carrying the right ones unless something checks. Half these tests are about
 * that.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const odOfficeConfig = require('./odOfficeConfig');

/** Roland, live. Categories 32, 1 and 18. */
const ROLAND_ROWS = [
  { DefNum: 296, Category: 32, category: 'InsurancePaymentType', ItemName: 'Check', isHidden: 'false' },
  { DefNum: 297, Category: 32, category: 'InsurancePaymentType', ItemName: 'EFT', isHidden: 'false' },
  { DefNum: 404, Category: 32, category: 'InsurancePaymentType', ItemName: 'Credit Card', isHidden: 'false' },
  { DefNum: 472, Category: 32, category: 'InsurancePaymentType', ItemName: 'Insurance Check', isHidden: 'false' },
  { DefNum: 12, Category: 1, ItemName: 'Insurance Write-off', ItemValue: '-', isHidden: 'false' },
  { DefNum: 10, Category: 1, ItemName: 'Write-off', ItemValue: '-', isHidden: 'false' },
  { DefNum: 262, Category: 1, ItemName: 'PPO Adjustment', ItemValue: '+', isHidden: 'false' },
  { DefNum: 260, Category: 1, ItemName: 'Insurance Adjustment', ItemValue: '+', isHidden: 'false' },
  { DefNum: 131, Category: 18, ItemName: 'Insurance', isHidden: 'false' },
  { DefNum: 134, Category: 18, ItemName: 'Financial', isHidden: 'false' },
];

const ROLAND_PREFS = [
  { PrefName: 'ClaimPaymentBatchOnly', ValueString: '0' },
  { PrefName: 'ShowAutoDeposit', ValueString: '0' },
  { PrefName: 'ApiPaymentType', ValueString: '69' },
];

/**
 * A transport that honours the NUMERIC `Category=` filter and ignores every
 * other filter — which is exactly what the live API does.
 */
function honestOdGet(rows = ROLAND_ROWS, prefs = ROLAND_PREFS) {
  const calls = [];
  const fn = async (path, params = {}) => {
    calls.push({ path, params });
    if (path === '/definitions') {
      if (params.Category !== undefined) {
        return { ok: true, status: 200, data: rows.filter((r) => Number(r.Category) === Number(params.Category)) };
      }
      return { ok: true, status: 200, data: rows };
    }
    if (path === '/preferences') return { ok: true, status: 200, data: prefs };
    return { ok: false, status: 404, data: null, error: `${path} is not a valid resource.` };
  };
  fn.calls = calls;
  return fn;
}

test.beforeEach(() => odOfficeConfig._resetForTests());

test('the numeric Category filter is what gets sent, and only that', async () => {
  const odGet = honestOdGet();
  await odOfficeConfig.resolvePostingConfig(odGet, 'roland');

  const defCalls = odGet.calls.filter((c) => c.path === '/definitions');
  assert.equal(defCalls.length, 3, 'three categories: PayType, AdjType, DocCategory');
  for (const call of defCalls) {
    assert.equal(typeof call.params.Category, 'number', 'the filter must be NUMERIC');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(call.params, 'category'),
      'the lowercase string form is silently ignored by Open Dental and must never be sent'
    );
  }
  assert.deepEqual(
    defCalls.map((c) => c.params.Category).sort((a, b) => a - b),
    [1, 18, 32]
  );
});

test('a STRING category filter is shown to be ignored — which is why it is never used', async () => {
  /*
   * The live evidence: `?category=InsurancePaymentType` and
   * `?category=NotARealCategory` both returned the SAME unfiltered 100-row page
   * spanning Categories 0–6. This test drives that behaviour explicitly, so the
   * reason the numeric form is mandatory is a demonstrated fact in the suite
   * rather than a claim in a comment.
   */
  const odGet = honestOdGet();

  const asString = await odGet('/definitions', { category: 'InsurancePaymentType' });
  const asNonsense = await odGet('/definitions', { category: 'NotARealCategory' });
  const unfiltered = await odGet('/definitions', {});

  assert.deepEqual(asString.data, unfiltered.data, 'the string filter did nothing');
  assert.deepEqual(asNonsense.data, unfiltered.data, 'and neither did a nonsense one');
  assert.ok(
    asString.data.some((r) => Number(r.Category) !== 32),
    'so the caller would receive rows from other categories with a 200 on them'
  );

  // And the numeric form does filter.
  const numeric = await odGet('/definitions', { Category: 32 });
  assert.ok(numeric.data.every((r) => Number(r.Category) === 32));
  assert.equal(numeric.data.length, 4);
});

test('a server that IGNORED our numeric filter yields a correct set, not a wrong one', async () => {
  /*
   * The client-side re-filter, under test. If Open Dental ever stopped honouring
   * `Category=` the way it already fails to honour `category=`, the registry must
   * still produce only Category-32 rows — and must say the filter was not
   * honoured rather than quietly returning a list that includes adjustment types
   * as payment types.
   */
  const ignoring = async (path) => {
    if (path === '/definitions') return { ok: true, status: 200, data: ROLAND_ROWS };
    if (path === '/preferences') return { ok: true, status: 200, data: ROLAND_PREFS };
    return { ok: false, status: 404, data: null, error: 'no' };
  };

  const { config } = await odOfficeConfig.resolvePostingConfig(ignoring, 'roland');
  assert.deepEqual(config.payTypes.map((p) => p.defNum).sort((a, b) => a - b), [296, 297, 404, 472]);
  assert.equal(config.filterHonored.payTypes, false, 'and it says so');
});

test("Roland's live DefNums resolve, with the AdjType signs carried", async () => {
  const { config } = await odOfficeConfig.resolvePostingConfig(honestOdGet(), 'roland');
  assert.equal(config.officeKey, 'roland');
  assert.deepEqual(
    config.payTypes.map((p) => [p.defNum, p.name]),
    [[296, 'Check'], [297, 'EFT'], [404, 'Credit Card'], [472, 'Insurance Check']]
  );
  // `AdjAmt`'s sign must agree with `ItemValue` or Open Dental refuses with a
  // 400 (test 8) — so the sign travels with the definition.
  assert.equal(config.adjTypes.find((a) => a.defNum === 12).sign, '-');
  assert.equal(config.adjTypes.find((a) => a.defNum === 260).sign, '+');
  assert.equal(config.docCategories.find((d) => d.defNum === 131).name, 'Insurance');
});

test('an insurance check prefers the INSURANCE-specific type over the generic one', async () => {
  /*
   * Roland carries both 296 "Check" and 472 "Insurance Check". Order in
   * PAY_TYPE_NAMES is what decides, and a substring rule would have made the
   * answer depend on which row Open Dental happened to return first.
   */
  const { config } = await odOfficeConfig.resolvePostingConfig(honestOdGet(), 'roland');
  assert.equal(odOfficeConfig.pickPayType(config, 'check').defNum, 472);
  assert.equal(odOfficeConfig.pickPayType(config, 'eft').defNum, 297);
});

test('an office whose list carries nothing recognisable gets NULL, never a fallback', async () => {
  const odd = honestOdGet([{ DefNum: 900, Category: 32, ItemName: 'Something Else', isHidden: 'false' }]);
  const { config } = await odOfficeConfig.resolvePostingConfig(odd, 'valley');
  assert.equal(odOfficeConfig.pickPayType(config, 'check'), null);
  assert.equal(odOfficeConfig.pickPayType(config, 'eft'), null);
  // Never Roland's 296: a DefNum from another practice's database means
  // something else there, or nothing at all.
});

test('hidden rows are dropped — including the STRING "true" Open Dental returns', async () => {
  const withHidden = honestOdGet([
    ...ROLAND_ROWS,
    { DefNum: 999, Category: 32, ItemName: 'Retired Type', isHidden: 'true' },
    { DefNum: 998, Category: 32, ItemName: 'Also Retired', IsHidden: true },
  ]);
  const { config } = await odOfficeConfig.resolvePostingConfig(withHidden, 'roland');
  assert.ok(!config.payTypes.some((p) => p.defNum === 999));
  assert.ok(!config.payTypes.some((p) => p.defNum === 998));
  // And the STRING "false" must not read as truthy — the trap the commlog-type
  // picker hit.
  assert.equal(config.payTypes.length, 4);
  assert.equal(odOfficeConfig.isHiddenRow({ isHidden: 'false' }), false);
  assert.equal(odOfficeConfig.isHiddenRow({ isHidden: 'true' }), true);
});

test('preferences are matched BY NAME, not taken from the first row', async () => {
  /*
   * `?PrefName=` is another filter we have not proven Open Dental honours, so
   * this transport returns the whole list. Reading `[0].ValueString` would give
   * whichever preference happened to sort first — here `ApiPaymentType = 69`,
   * which would read as a truthy `ClaimPaymentBatchOnly`.
   */
  const shuffled = honestOdGet(ROLAND_ROWS, [
    { PrefName: 'ApiPaymentType', ValueString: '69' },
    { PrefName: 'ShowAutoDeposit', ValueString: '1' },
    { PrefName: 'ClaimPaymentBatchOnly', ValueString: '0' },
  ]);
  const { config } = await odOfficeConfig.resolvePostingConfig(shuffled, 'roland');
  assert.equal(config.prefs.claimPaymentBatchOnly, false);
  assert.equal(config.prefs.showAutoDeposit, true);
});

test('an UNREADABLE preference is null, and null does not resolve to the risky endpoint', async () => {
  const noPrefs = honestOdGet(ROLAND_ROWS, []);
  const { config } = await odOfficeConfig.resolvePostingConfig(noPrefs, 'roland');
  assert.equal(config.prefs.claimPaymentBatchOnly, null);
  /*
   * Unknown resolves to `batch`, which is legal on a practice that permits both.
   * Guessing `single` would be a coin flip whose losing side is a 400 in the
   * middle of the posting sequence.
   */
  assert.equal(odOfficeConfig.resolveCheckEndpoint(config, 1), 'batch');
});

test('ClaimPaymentBatchOnly = true makes Batch mandatory even for one claim', async () => {
  const batchOnly = honestOdGet(ROLAND_ROWS, [
    { PrefName: 'ClaimPaymentBatchOnly', ValueString: '1' },
    { PrefName: 'ShowAutoDeposit', ValueString: '0' },
  ]);
  const { config } = await odOfficeConfig.resolvePostingConfig(batchOnly, 'roland');
  assert.equal(odOfficeConfig.resolveCheckEndpoint(config, 1), 'batch');
});

test('Roland today permits the single endpoint for one claim, and Batch for many', async () => {
  const { config } = await odOfficeConfig.resolvePostingConfig(honestOdGet(), 'roland');
  assert.equal(odOfficeConfig.resolveCheckEndpoint(config, 1), 'single');
  assert.equal(odOfficeConfig.resolveCheckEndpoint(config, 2), 'batch');
});

test('a failed DEFINITIONS read throws — it must never resolve to an empty configuration', async () => {
  const down = async (path) => {
    if (path === '/definitions') return { ok: false, status: 503, data: null, error: 'unreachable' };
    return { ok: true, status: 200, data: [] };
  };
  await assert.rejects(
    () => odOfficeConfig.resolvePostingConfig(down, 'roland'),
    (err) => err.name === 'OdConfigError' && err.code === 'OD_CONFIG_READ_FAILED'
  );
});

test('a 200 carrying no usable payment type is a refusal, not a configuration', async () => {
  /*
   * The dangerous shape: a successful read with nothing in it. Accepting it
   * would leave `pickPayType` with nothing to pick and the drain omitting
   * `PayType` entirely, posting the check under whatever default the practice
   * happens to have — money filed under the wrong payment method, silently.
   */
  const empty = honestOdGet([{ DefNum: 12, Category: 1, ItemName: 'Insurance Write-off', ItemValue: '-' }]);
  await assert.rejects(
    () => odOfficeConfig.resolvePostingConfig(empty, 'roland'),
    (err) => err.code === 'OD_CONFIG_EMPTY'
  );
});

test('the cache is PER OFFICE — roland\'s answer is never valley\'s', async () => {
  const roland = honestOdGet();
  const valley = honestOdGet([
    // Riley's numbers are different, and this fixture is a REMINDER rather than a
    // measurement: they have not been read from Riley's database yet (D-7).
    { DefNum: 501, Category: 32, ItemName: 'Insurance Check', isHidden: 'false' },
    { DefNum: 502, Category: 32, ItemName: 'EFT', isHidden: 'false' },
    { DefNum: 20, Category: 1, ItemName: 'Insurance Write-off', ItemValue: '-' },
    { DefNum: 429, Category: 18, ItemName: 'Insurance' },
  ]);

  const a = await odOfficeConfig.resolvePostingConfig(roland, 'roland');
  const b = await odOfficeConfig.resolvePostingConfig(valley, 'valley');

  assert.equal(odOfficeConfig.pickPayType(a.config, 'check').defNum, 472);
  assert.equal(odOfficeConfig.pickPayType(b.config, 'check').defNum, 501);
  assert.notEqual(
    odOfficeConfig.pickPayType(a.config, 'check').defNum,
    odOfficeConfig.pickPayType(b.config, 'check').defNum
  );
});

test('a second resolve inside the TTL reuses the cache rather than re-reading', async () => {
  const odGet = honestOdGet();
  const first = await odOfficeConfig.resolvePostingConfig(odGet, 'roland');
  const callsAfterFirst = odGet.calls.length;
  const second = await odOfficeConfig.resolvePostingConfig(odGet, 'roland');

  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(odGet.calls.length, callsAfterFirst, 'no further Open Dental traffic');

  // …and `force` goes back to the database.
  await odOfficeConfig.resolvePostingConfig(odGet, 'roland', { force: true });
  assert.ok(odGet.calls.length > callsAfterFirst);
});
