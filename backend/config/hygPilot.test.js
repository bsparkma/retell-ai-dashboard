'use strict';

/**
 * The hygiene pilot switch's precedence chain, and the one property that makes
 * it safe to have at all: **it can only ever NARROW what the voice path allows.**
 *
 * The end-to-end walk (console write → refused request, no restart) is in
 * routes/hygPilotSwitch.test.js. This file is the layer arithmetic underneath it.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const registry = require('../platform/registry');
const hygPilot = require('./hygPilot');
const odOffices = require('./odOffices');

const KEY = hygPilot.SETTING_KEY;

/** Stub the control plane for one test, restoring everything afterwards. */
async function withControlPlane({ row = null, fail = false, env = {} }, fn) {
  const originals = {
    getPlatformSetting: registry.getPlatformSetting,
    setPlatformSetting: registry.setPlatformSetting,
    env: Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]])),
    roland: process.env.HYG_OD_ENABLED_ROLAND,
    valley: process.env.HYG_OD_ENABLED_VALLEY,
  };
  delete process.env.HYG_OD_ENABLED_ROLAND;
  delete process.env.HYG_OD_ENABLED_VALLEY;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const store = { row, writes: [] };
  registry.getPlatformSetting = async (key) => {
    if (fail) throw new Error('control plane unreachable');
    return key === KEY ? store.row : null;
  };
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    if (fail) throw new Error('control plane unreachable');
    store.writes.push({ key, value, updatedBy });
    store.row = { key, value, updated_at: new Date('2026-09-04T12:00:00Z'), updated_by: updatedBy };
    return store.row;
  };

  hygPilot.resetCacheForTests();
  try {
    await fn(store);
  } finally {
    registry.getPlatformSetting = originals.getPlatformSetting;
    registry.setPlatformSetting = originals.setPlatformSetting;
    for (const [k, v] of Object.entries(originals.env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (originals.roland === undefined) delete process.env.HYG_OD_ENABLED_ROLAND;
    else process.env.HYG_OD_ENABLED_ROLAND = originals.roland;
    if (originals.valley === undefined) delete process.env.HYG_OD_ENABLED_VALLEY;
    else process.env.HYG_OD_ENABLED_VALLEY = originals.valley;
    hygPilot.resetCacheForTests();
  }
}

/**
 * Run `fn` with console.warn captured, so a test can assert on a line the app
 * PRINTS. The boot warning about an inert env var is a deliverable here, not
 * decoration: a variable that quietly does nothing is its own incident.
 *
 * @param {(warnings: string[]) => void} fn
 */
function withWarnings(fn) {
  const saved = console.warn;
  /** @type {string[]} */
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    fn(warnings);
  } finally {
    console.warn = saved;
  }
  return warnings;
}

/** A stored row wrapping `value`. */
function row(value) {
  return { key: KEY, value, updated_at: new Date('2026-09-04T12:00:00Z'), updated_by: 'boss@carein.ai' };
}

// ─── the precedence chain, layer by layer ────────────────────────────────────

test('nothing stored, nothing in the environment: OFF, from the hardcoded floor', () =>
  withControlPlane({}, async () => {
    await hygPilot.refreshFromDb();
    assert.equal(hygPilot.hygEnabledFor('roland', false), false);
    assert.equal(hygPilot.sourceFor('roland'), 'default');
  }));

test('an app setting that says ON cannot switch an office on, and says so once', () =>
  withControlPlane({ env: { HYG_OD_ENABLED_ROLAND: '  TRUE  ' } }, async () => {
    await hygPilot.refreshFromDb();
    // There is no incident whose correct response is turning a module ON while
    // the control plane is down, so break-glass points one way only.
    assert.equal(hygPilot.hygEnabledFor('roland', false), false);
    // ...and the console must not report `env` for a value that does nothing.
    assert.equal(hygPilot.sourceFor('roland'), 'default');

    // It IS parsed (whitespace and case are not typos) and IS surfaced, because
    // silently ignoring it is the worse failure: somebody set it expecting an
    // effect, and would be left watching the module stay dark with no reason.
    assert.equal(hygPilot.envOverrideFor('roland'), true);
    const state = hygPilot.officeState('roland', false);
    assert.equal(state.envEffect, 'inert');
    assert.equal(state.envRaw, '  TRUE  ');

    withWarnings((warn) => {
      assert.deepEqual(hygPilot.warnAboutInertEnvOverrides(), ['roland']);
      assert.equal(warn.length, 1);
      assert.match(warn[0], /HYG_OD_ENABLED_ROLAND=true is set, and it is doing nothing/);
      assert.match(warn[0], /can only DISABLE an office/);
    });

    // Once per process. This must never become a line a timer prints.
    withWarnings((warn) => {
      assert.deepEqual(hygPilot.warnAboutInertEnvOverrides(), []);
      assert.equal(warn.length, 0);
    });
  }));

test('an app setting that says OFF switches the office off — the only direction it points', () =>
  withControlPlane({ env: { HYG_OD_ENABLED_ROLAND: 'false' } }, async () => {
    await hygPilot.refreshFromDb();
    assert.equal(hygPilot.hygEnabledFor('roland', true), false, 'it narrows the floor');
    assert.equal(hygPilot.sourceFor('roland'), 'env');
    assert.equal(hygPilot.officeState('roland', true).envEffect, 'disables');
    // Per office, not a blanket switch.
    assert.equal(hygPilot.hygEnabledFor('valley', true), true);
  }));

test('an office killed from the environment stays killed, though the console says on', () =>
  withControlPlane(
    { row: row({ roland: true }), env: { HYG_OD_ENABLED_ROLAND: 'false' } },
    async () => {
      await hygPilot.refreshFromDb();
      // Break-glass only ever narrows, the same way hygOdBlockReason narrows
      // odBlockReason. Somebody who could not reach the console pulled this
      // lever; a control plane coming back must not undo it under them.
      assert.equal(hygPilot.hygEnabledFor('roland', false), false);
      assert.equal(hygPilot.sourceFor('roland'), 'env');

      // Both layers stay visible, because "the database says on and
      // HYG_OD_ENABLED_ROLAND says off" is exactly what an operator needs.
      const state = hygPilot.officeState('roland', false);
      assert.equal(state.disagreesWithEnv, true);
      assert.equal(state.envEffect, 'disables');
      assert.equal(state.db, true, 'what the console holds is still reported');
      assert.equal(state.env, false);
      assert.equal(state.envVar, 'HYG_OD_ENABLED_ROLAND');
      assert.equal(state.envRaw, 'false');
    }
  ));

test('agreement is not reported as disagreement', () =>
  withControlPlane(
    { row: row({ roland: true }), env: { HYG_OD_ENABLED_ROLAND: 'true' } },
    async () => {
      await hygPilot.refreshFromDb();
      assert.equal(hygPilot.officeState('roland', false).disagreesWithEnv, false);
    }
  ));

test('only a plain true/false is an env override — "yes" is not a decision', () =>
  withControlPlane(
    { env: { HYG_OD_ENABLED_ROLAND: 'yes', HYG_OD_ENABLED_VALLEY: '  FALSE  ' } },
    async () => {
      await hygPilot.refreshFromDb();
      // A switch over a real practice's chart data does not get to interpret.
      // Unparseable is not a kill signal either: it falls through entirely.
      assert.equal(hygPilot.hygEnabledFor('roland', true), true);
      assert.equal(hygPilot.sourceFor('roland'), 'default');
      assert.equal(hygPilot.officeState('roland', true).envEffect, null);
      // ...but whitespace and case are not typos.
      assert.equal(hygPilot.hygEnabledFor('valley', true), false);

      // The raw string is still surfaced, so the console can show that somebody
      // tried and that it did nothing.
      assert.equal(hygPilot.officeState('roland', false).envRaw, 'yes');
    }
  ));

// ─── the stored row's own vocabulary ─────────────────────────────────────────

test('a row that exists answers for EVERY office: absent means false, not inherit', () =>
  withControlPlane(
    { row: row({ roland: true }), env: { HYG_OD_ENABLED_VALLEY: 'true' } },
    async () => {
      await hygPilot.refreshFromDb();
      // valley is not named in the row. That is a FALSE, and the env override
      // does not rescue it: nothing in the environment can ENABLE an office.
      assert.equal(hygPilot.hygEnabledFor('valley', false), false);
      assert.equal(hygPilot.sourceFor('valley'), 'db');
      assert.equal(hygPilot.officeState('valley', false).disagreesWithEnv, true);
    }
  ));

test('an EMPTY stored map is a decision — every office off, and the db said so', () =>
  withControlPlane({ row: row({}), env: { HYG_OD_ENABLED_ROLAND: 'true' } }, async () => {
    await hygPilot.refreshFromDb();
    assert.equal(hygPilot.hygEnabledFor('roland', false), false);
    assert.equal(hygPilot.sourceFor('roland'), 'db', '{} is not the same as no row');
  }));

test('an unknown office key is ignored, and does not poison the rest of the map', () =>
  withControlPlane({ row: row({ roland: true, springfield: true }) }, async () => {
    const res = await hygPilot.refreshFromDb();
    assert.equal(res.ok, true);
    // One typo must not make the whole switch unreadable and take a live pilot
    // office down with it.
    assert.equal(hygPilot.hygEnabledFor('roland', false), true);
    assert.equal(hygPilot.hygEnabledFor('springfield', false), false);
  }));

test('an office whose value is not a boolean is treated as ABSENT, which means off', () =>
  withControlPlane({ row: row({ roland: 'true', valley: true }) }, async () => {
    await hygPilot.refreshFromDb();
    assert.equal(hygPilot.hygEnabledFor('roland', false), false, "the STRING 'true' is not a decision");
    assert.equal(hygPilot.hygEnabledFor('valley', false), true);
  }));

test('a stored value that is not a map at all falls back, and is not an error', () =>
  withControlPlane({ row: row([1, 2, 3]) }, async () => {
    const res = await hygPilot.refreshFromDb();
    assert.equal(res.ok, true, 'unusable is a fallback, not a failure');
    assert.equal(res.byOffice, null);
    // Treated exactly like an absent row: the floor answers, and the console is
    // told nobody has chosen rather than shown a value nothing produced.
    assert.equal(hygPilot.hygEnabledFor('roland', false), false);
    assert.equal(hygPilot.sourceFor('roland'), 'default');
    assert.equal(hygPilot.policyKnown(), true, 'we DID read the control plane');
  }));

// ─── failure directions ──────────────────────────────────────────────────────

test('never read since boot, and nothing in the environment: every office OFF', () =>
  withControlPlane({ fail: true }, async () => {
    const res = await hygPilot.refreshFromDb();
    assert.equal(res.ok, false);
    assert.equal(hygPilot.policyKnown(), false);
    // We do not assume the last thing we saw, because we have seen nothing.
    assert.equal(hygPilot.hygEnabledFor('roland', false), false);
    assert.equal(hygPilot.hygEnabledFor('valley', false), false);
  }));

test('a leftover app setting cannot re-open an office somebody shut down', () =>
  withControlPlane(
    // The control DB holds the decision: roland is OFF, somebody turned it off.
    // An earlier incident left HYG_OD_ENABLED_ROLAND=true behind. Now the
    // container restarts while the control plane happens to be unreachable, so
    // nothing is cached and the stored row cannot be consulted at all.
    { row: row({ roland: false }), fail: true, env: { HYG_OD_ENABLED_ROLAND: 'true' } },
    async () => {
      const res = await hygPilot.refreshFromDb();
      assert.equal(res.ok, false);
      assert.equal(hygPilot.policyKnown(), false);

      // A restart during an outage must not re-enable a practice. This is the
      // whole reason the override is one-directional: the fast, always-available
      // path is the SAFE one.
      assert.equal(hygPilot.hygEnabledFor('roland', false), false);
      assert.equal(hygPilot.sourceFor('roland'), 'default');
      assert.equal(hygPilot.officeState('roland', false).envEffect, 'inert');
    }
  ));

test('read once and then unreachable: the last known value STAYS', () =>
  withControlPlane({ row: row({ roland: true }) }, async (store) => {
    await hygPilot.refreshFromDb();
    assert.equal(hygPilot.hygEnabledFor('roland', false), true);

    // A database blip must not switch a practice's chairside screen off
    // mid-morning any more than it should switch one on.
    registry.getPlatformSetting = async () => {
      throw new Error('control plane unreachable');
    };
    const res = await hygPilot.refreshFromDb();
    assert.equal(res.ok, false);
    assert.equal(hygPilot.hygEnabledFor('roland', false), true);
    assert.equal(hygPilot.policyKnown(), true);
    assert.equal(store.writes.length, 0);
  }));

test('refreshFromDb never throws — it is called from a timer and a cron handler', () =>
  withControlPlane({ fail: true }, async () => {
    const res = await hygPilot.refreshFromDb();
    assert.equal(res.ok, false);
    assert.match(String(res.error), /unreachable/);
  }));

// ─── the write path ──────────────────────────────────────────────────────────

test('a write merges into what the DATABASE holds, not into this cache', () =>
  withControlPlane({ row: row({ valley: true }) }, async (store) => {
    await hygPilot.refreshFromDb();

    // A runbook writes the row directly, behind this module's back.
    store.row = row({ valley: true, roland: true });

    // Flipping valley must not revert roland to whatever we last saw.
    await hygPilot.persistHygEnabled('valley', false, 'boss@carein.ai');
    assert.deepEqual(store.writes.at(-1).value, { valley: false, roland: true });
  }));

test('a write refuses an unknown office and a non-boolean before storing anything', () =>
  withControlPlane({}, async (store) => {
    await assert.rejects(() => hygPilot.persistHygEnabled('springfield', true), /not an office/);
    await assert.rejects(() => hygPilot.persistHygEnabled('roland', 'true'), /true or false/);
    assert.equal(store.writes.length, 0);
  }));

test('a write that cannot be read back is a failure, not a silent success', () =>
  withControlPlane({}, async () => {
    const realGet = registry.getPlatformSetting;
    let calls = 0;
    registry.getPlatformSetting = async (key) => {
      calls += 1;
      // The read-modify-write read succeeds; the readback after the write does not.
      if (calls > 1) throw new Error('control plane unreachable');
      return realGet(key);
    };
    await assert.rejects(
      () => hygPilot.persistHygEnabled('roland', true, 'boss@carein.ai'),
      /could not read it back/
    );
  }));

// ─── the narrowing property ──────────────────────────────────────────────────

test('the switch can only NARROW what the voice path allows, never widen it', () =>
  withControlPlane({ row: row({ roland: true, valley: true }) }, async () => {
    /*
     * The property that makes a second per-office flag safe at all. The LAST
     * second flag — officeAgents.odConnected — was retired because it gated
     * routes while the module reached Open Dental through another office's
     * client; the flag and the credential it claimed to describe were not
     * connected to each other.
     *
     * hygOdBlockReason() asks odBlockReason() FIRST, so there is no value of
     * this setting that reaches an office the voice module could not. Here the
     * switch is ON for both offices and NEITHER has a customer key.
     */
    await hygPilot.refreshFromDb();

    const savedKeys = {
      roland: process.env.OPENDENTAL_CUSTOMER_KEY,
      valley: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY,
    };
    delete process.env.OPENDENTAL_CUSTOMER_KEY;
    delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
    odOffices.resetOdOfficeCache();
    try {
      for (const office of ['roland', 'valley']) {
        assert.equal(hygPilot.hygEnabledFor(office, false), true, 'the switch is on');
        const blocked = odOffices.hygOdBlockReason(office);
        assert.ok(blocked, `${office} must still be refused`);
        // The VOICE path's own code, not the hygiene one — the hygiene switch
        // never gets to answer, because the base question already refused.
        assert.equal(blocked.code, 'OFFICE_OD_KEY_MISSING');
        assert.equal(odOffices.isHygOdReady(office), false);
      }
    } finally {
      if (savedKeys.roland === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY;
      else process.env.OPENDENTAL_CUSTOMER_KEY = savedKeys.roland;
      if (savedKeys.valley === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY;
      else process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = savedKeys.valley;
      odOffices.resetOdOfficeCache();
    }
  }));

test('an office the voice path has switched off cannot be reached by turning hygiene on', () =>
  withControlPlane({ row: row({ roland: true }) }, async () => {
    await hygPilot.refreshFromDb();

    const settings = odOffices.OFFICE_OD_SETTINGS.roland;
    const savedOdEnabled = settings.odEnabled;
    const savedKey = process.env.OPENDENTAL_CUSTOMER_KEY;
    process.env.OPENDENTAL_CUSTOMER_KEY = 'test-customer-key-roland';
    settings.odEnabled = false;
    odOffices.resetOdOfficeCache();
    try {
      const blocked = odOffices.hygOdBlockReason('roland');
      assert.equal(blocked.code, 'OFFICE_NOT_OD_CONNECTED');
    } finally {
      settings.odEnabled = savedOdEnabled;
      if (savedKey === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY;
      else process.env.OPENDENTAL_CUSTOMER_KEY = savedKey;
      odOffices.resetOdOfficeCache();
    }
  }));

test('the composed state names both the switch AND what still blocks the office', () =>
  withControlPlane({ row: row({ roland: true }) }, async () => {
    await hygPilot.refreshFromDb();
    const savedKey = process.env.OPENDENTAL_CUSTOMER_KEY;
    delete process.env.OPENDENTAL_CUSTOMER_KEY;
    odOffices.resetOdOfficeCache();
    try {
      const roland = odOffices.hygSwitchState().find((o) => o.officeKey === 'roland');
      // A green toggle over a 503 is the thing the console must not show.
      assert.equal(roland.enabled, true, 'the switch is on');
      assert.equal(roland.ready, false, 'and the office still cannot serve a day');
      assert.equal(roland.blockedBy.code, 'OFFICE_OD_KEY_MISSING');
    } finally {
      if (savedKey === undefined) delete process.env.OPENDENTAL_CUSTOMER_KEY;
      else process.env.OPENDENTAL_CUSTOMER_KEY = savedKey;
      odOffices.resetOdOfficeCache();
    }
  }));

// ─── the hardcoded floor ─────────────────────────────────────────────────────

test('the hardcoded floor ships FALSE for every office, and stays that way', () => {
  // It is the bottom of the precedence chain, not a configuration point.
  // Flipping it here would mean the OFF direction needs a deploy again, which
  // is the whole thing this module exists to fix.
  for (const [officeKey, settings] of Object.entries(odOffices.OFFICE_OD_SETTINGS)) {
    assert.equal(settings.hygOdEnabled, false, `${officeKey} must ship with hygiene off`);
  }
});

// ─── the background refresh ──────────────────────────────────────────────────

test('the refresh timer arms once, disarms, and never holds the process open', () => {
  hygPilot.resetCacheForTests();
  try {
    assert.equal(hygPilot.startRefreshTimer(), true);
    assert.equal(hygPilot.startRefreshTimer(), false, 'arming twice is a no-op');
  } finally {
    hygPilot.stopRefreshTimer();
    hygPilot.resetCacheForTests();
  }
});

test('a garbage refresh interval falls back to the default rather than busy-looping', () => {
  const saved = process.env.HYG_PILOT_REFRESH_MINUTES;
  try {
    process.env.HYG_PILOT_REFRESH_MINUTES = '0';
    assert.equal(hygPilot.refreshMinutes(), 5);
    process.env.HYG_PILOT_REFRESH_MINUTES = 'soon';
    assert.equal(hygPilot.refreshMinutes(), 5);
    process.env.HYG_PILOT_REFRESH_MINUTES = '2';
    assert.equal(hygPilot.refreshMinutes(), 2);
  } finally {
    if (saved === undefined) delete process.env.HYG_PILOT_REFRESH_MINUTES;
    else process.env.HYG_PILOT_REFRESH_MINUTES = saved;
  }
});
