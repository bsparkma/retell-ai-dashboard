'use strict';

/**
 * MT-2a seed equivalence: for every key x office, each LIVE reader's answer
 * from platform_setting equals its answer from office_setting as the backfill
 * (migrations/1789600000001_backfill_office_setting.js planBackfill) would
 * write it, on a fixture full of entries the readers ignore. That proves the
 * ignorable entries are not copied, and that the migration's FROZEN validation
 * still matches the live readers'.
 *
 * Also pins the closed vocabulary: the migration's CHECK literal, the
 * backfill's key list and platform/officeSettingKeys.js are the same ten keys.
 *
 * Every value is synthetic (example.test addresses, no real practice data).
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('./registry');
const parity = require('./officeSettingsParity');
const officeSettings = require('./officeSettings');
const keys = require('./officeSettingKeys');
const { FakeControlPlane, TENANT_ID } = require('./officeSettingsTestUtils');
const backfillMigration = require('../migrations/1789600000001_backfill_office_setting');
const schemaMigration = require('../migrations/1789600000000_office_setting');

const SWITCHES = [
  require('../config/tcCheckout'),
  require('../config/tcOdSync'),
  require('../config/tcAutoCheckout'),
  require('../config/tcReferrals'),
  require('../config/tcReferralEmail'),
  require('../config/tcReferralPatientEmail'),
];
const hygPilot = require('../config/hygPilot');
const emailIdentity = require('../config/emailIdentity');
const tcNurture = require('../config/tcNurture');
const tcOpportunities = require('../config/tcOpportunities');

const ENV = ['TC_NURTURE_ENABLED', 'TC_OPPS_SYNC_DISABLED'];

/** A fixture where nearly every entry is one some reader ignores. */
const JUNK_FIXTURE = Object.freeze({
  tc_checkout_enabled: { roland: true, valley: 'yes', unknown: true, main: true },
  tc_od_sync_enabled: { valley: false, roland: 1 },
  tc_auto_checkout_enabled: ['roland'],
  tc_referrals_enabled: { roland: false, valley: true },
  tc_referral_email_enabled: {},
  tc_referral_patient_email_enabled: { roland: null, Valley: true },
  hyg_od_enabled: { roland: true, unknown: true, valley: 'true' },
  tc_nurture_enabled: { roland: true, valley: false, bogus: true },
  tc_opportunities_sync: { valley: true, roland: 'true' },
  tc_email_identity: {
    roland: {
      replyTo: '  FrontDesk@Roland.Example.Test ',
      practiceName: 'Example Dental',
      practicePhone: 'x'.repeat(41),
      referralBcc: 'not-an-email',
      from: 'sneaky@example.test',
    },
    valley: 'not-a-map',
    unknown: { replyTo: 'nobody@example.test' },
  },
});

/** A second fixture: different shapes of the same keys. */
const SECOND_FIXTURE = Object.freeze({
  tc_checkout_enabled: 'on',
  tc_od_sync_enabled: { roland: true, valley: true },
  tc_referrals_enabled: null,
  hyg_od_enabled: { valley: false },
  tc_nurture_enabled: [],
  tc_opportunities_sync: { roland: false },
  tc_email_identity: {
    valley: { replyTo: null, practiceName: '  Valley Example  ', practicePhone: '(479) 555-0100', referralBcc: 'Copies@Valley.Example.Test' },
    roland: {},
  },
});

/**
 * Seed `fixture` into platform_setting and the planned backfill into
 * office_setting, read every reader, and return each key's divergences.
 * @param {Record<string, unknown>} fixture
 * @param {(rows: ReturnType<typeof backfillMigration.planBackfill>) => typeof rows} [mutate]
 */
async function runAll(t, fixture, mutate = (r) => r) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  const cp = new FakeControlPlane();
  for (const [k, v] of Object.entries(fixture)) {
    if (v !== null) cp.seedPlatform(k, v);
  }
  const planned = mutate(
    backfillMigration.planBackfill(
      [...cp.platform.values()].map((r) => ({ key: r.key, value: r.value })),
      ['roland', 'valley']
    )
  );
  for (const r of planned) cp.seedOffice(r.office_key, r.setting_key, r.value);

  registry.setPoolForTests(cp.pool());
  parity.resetForTests();
  officeSettings.resetCacheForTests();
  for (const sw of SWITCHES) sw.resetCacheForTests();
  hygPilot.resetCacheForTests();
  emailIdentity.resetCacheForTests();
  parity.arm();
  t.after(() => {
    registry.setPoolForTests(null);
    parity.resetForTests();
    officeSettings.resetCacheForTests();
    for (const sw of SWITCHES) sw.resetCacheForTests();
    hygPilot.resetCacheForTests();
    emailIdentity.resetCacheForTests();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const warn = t.mock.method(console, 'warn', () => {});
  const log = t.mock.method(console, 'log', () => {});
  for (const sw of SWITCHES) assert.equal((await sw.refreshFromDb()).ok, true);
  assert.equal((await hygPilot.refreshFromDb()).ok, true);
  assert.equal((await emailIdentity.refreshFromDb()).ok, true);
  await tcNurture.switchedOnOffices(registry);
  await tcOpportunities.switchedOnOffices(registry);
  await parity.settled();

  return {
    planned,
    results: Object.fromEntries(keys.OFFICE_SETTING_KEYS.map((k) => [k, parity.lastResult(k)])),
    warnLines: warn.mock.calls.map((c) => String(c.arguments[0])),
    logLines: log.mock.calls.map((c) => String(c.arguments[0])),
  };
}

for (const [name, fixture] of [
  ['the junk fixture', JUNK_FIXTURE],
  ['the second fixture', SECOND_FIXTURE],
  ['no rows at all', {}],
]) {
  test(`seed equivalence on ${name}: every key x office answers the same from both tables`, async (t) => {
    const { results, warnLines, logLines } = await runAll(t, fixture);
    for (const k of keys.OFFICE_SETTING_KEYS) {
      assert.deepEqual(results[k], [], `${k} diverged: ${JSON.stringify(results[k])}`);
    }
    assert.equal(warnLines.filter((l) => l.includes('office settings parity')).length, 0);
    assert.equal(
      logLines.filter((l) => l.includes('office settings parity OK — 2 office(s), 10 setting(s)')).length,
      1
    );
  });
}

test('the junk fixture copies ONLY entries the readers honour, for existing offices', async (t) => {
  const { planned } = await runAll(t, JUNK_FIXTURE);
  const byKey = (k) =>
    Object.fromEntries(planned.filter((r) => r.setting_key === k).map((r) => [r.office_key, r.value]));
  assert.deepEqual(byKey('tc_checkout_enabled'), { roland: true });
  assert.deepEqual(byKey('tc_od_sync_enabled'), { valley: false });
  assert.deepEqual(byKey('tc_auto_checkout_enabled'), {});
  assert.deepEqual(byKey('tc_referrals_enabled'), { roland: false, valley: true });
  assert.deepEqual(byKey('tc_referral_email_enabled'), {});
  assert.deepEqual(byKey('tc_referral_patient_email_enabled'), {});
  assert.deepEqual(byKey('hyg_od_enabled'), { roland: true });
  assert.deepEqual(byKey('tc_nurture_enabled'), { roland: true, valley: false });
  assert.deepEqual(byKey('tc_opportunities_sync'), { valley: true });
  assert.deepEqual(byKey('tc_email_identity'), {
    roland: { replyTo: 'frontdesk@roland.example.test', practiceName: 'Example Dental' },
  });
  assert.equal(planned.some((r) => r.office_key === 'unknown'), false, "'unknown' never holds a setting");
});

test('an office with no office row is not copied', () => {
  const rows = backfillMigration.planBackfill(
    [{ key: 'tc_referrals_enabled', value: { roland: true, valley: true } }],
    ['roland']
  );
  assert.deepEqual(rows, [{ office_key: 'roland', setting_key: 'tc_referrals_enabled', value: true }]);
});

test('the check bites: copying an ignored entry IS reported as a divergence', async (t) => {
  const { results } = await runAll(t, JUNK_FIXTURE, (rows) => [
    ...rows,
    // valley: 'yes' is ignored by the checkout switch; a naive copy would store true.
    { office_key: 'valley', setting_key: 'tc_checkout_enabled', value: true },
    // valley's identity is 'not-a-map'; a naive copy would give it a reply-to.
    { office_key: 'valley', setting_key: 'tc_email_identity', value: { replyTo: 'x@example.test' } },
  ]);
  assert.deepEqual(
    results.tc_checkout_enabled.map((d) => [d.officeKey, d.platform, d.office]),
    [['valley', null, true]]
  );
  assert.deepEqual(
    results.tc_email_identity.map((d) => [d.officeKey, d.fields]),
    [['valley', ['replyTo']]]
  );
});

test('KNOWN, DISCLOSED: a usable hyg_od_enabled map with no valid entry reads false; with no rows office_setting reads null', async (t) => {
  // hygPilot: a usable row answers for every office, so {"bogus": true} is
  // "every office OFF, by decision". The backfill copies nothing (there is no
  // honoured entry), and with no rows office_setting means "nobody chose". The
  // EFFECTIVE answer is the same (the hardcoded floor is false), but the layer
  // differs, and the tripwire says so rather than hiding it.
  const { results } = await runAll(t, { hyg_od_enabled: { bogus: true } });
  assert.deepEqual(
    results.hyg_od_enabled.map((d) => [d.officeKey, d.platform, d.office]),
    [
      ['roland', false, null],
      ['valley', false, null],
    ]
  );
});

test('the frozen backfill and the live mirror judge every fixture entry identically', () => {
  for (const fixture of [JUNK_FIXTURE, SECOND_FIXTURE]) {
    for (const [key, value] of Object.entries(fixture)) {
      const frozen = backfillMigration
        .planBackfill([{ key, value }], ['roland', 'valley'])
        .map((r) => [r.office_key, r.value]);
      const live = keys.mirrorEntries(key, value).map((e) => [e.officeKey, e.value]);
      assert.deepEqual(live, frozen, key);
    }
  }
});

test('the closed vocabulary: the CHECK literal, the backfill and officeSettingKeys name the same ten keys', () => {
  /** @type {Record<string, { check?: string }>} */
  const constraints = {};
  const pgm = {
    func: (s) => s,
    createTable: () => {},
    addConstraint: (_table, name, spec) => {
      constraints[name] = spec;
    },
  };
  schemaMigration.up(pgm);
  const literal = [...constraints.office_setting_key_vocabulary.check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...literal].sort(), [...keys.OFFICE_SETTING_KEYS].sort());
  assert.deepEqual([...backfillMigration.ALL_KEYS].sort(), [...keys.OFFICE_SETTING_KEYS].sort());
  assert.equal(keys.OFFICE_SETTING_KEYS.length, 10);
  for (const stays of ['tc_email_enabled', 'tc_sms_enabled', 'call_retention_days']) {
    assert.equal(keys.isOfficeSettingKey(stays), false, `${stays} stays global`);
  }
  assert.deepEqual([...backfillMigration.REAL_OFFICES], keys.realOffices());
  assert.equal(backfillMigration.TENANT_SLUG, keys.MT2A_TENANT_SLUG);
  assert.ok(TENANT_ID);
});
