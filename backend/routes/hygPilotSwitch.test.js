'use strict';

/**
 * The hygiene pilot switch, end to end: the console writes it, the request path
 * obeys it, and nothing in between waits for a tick.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS AND WHY BOTH MOUNTS ARE IN ONE APP
 * ═════════════════════════════════════════════════════════════════════════════
 * The switch's whole reason for being is that turning hygiene OFF for an office
 * must take under a minute, from a click, with a patient in the chair. A test
 * that exercised the console and the day view in separate processes — or that
 * called `resetCacheForTests()` between them — would prove nothing about that,
 * because a restart is exactly what the switch exists to avoid.
 *
 * So `/api/platform` and `/api/hyg` are mounted over ONE express app, in the
 * same order and shape server.js mounts them, and the central test walks:
 *
 *     turn ON → GET the day → 200
 *     turn OFF → GET the same day → refused
 *
 * with **no restart, no sleep, and no cache reset** anywhere between the steps.
 * If that test ever needs one of those to pass, the switch is not a kill switch
 * and the design is wrong — that is the sentence to read before "fixing" it.
 *
 * NO REAL PATIENT DATA. Every PatNum here is a designated staging fixture
 * (roland 12827 / 12828) or an obviously synthetic number.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const express = require('express');

const registry = require('../platform/registry');
const tenantDb = require('../platform/tenantDb');
const userContext = require('../platform/userContext');
const odOffices = require('../config/odOffices');
const hygPilot = require('../config/hygPilot');
const { tenantContext, requireModule } = require('../middleware/tenantContext');
const { requireReadWrite, requireSuperAdmin } = require('../config/permissions');
const { requireDashboardAuth } = require('../middleware/auth');
const { FakeAuditDb, FakeOd, api, apptRow, patientRow, operatoryRow } = require('./hyg/hygTestUtils');

const DATE = '2026-09-08';
const DAY = '/api/hyg/day?office=roland&date=' + DATE;
const SWITCH = '/api/platform/hyg-offices';

const REGISTRY_KEYS = [
  'getUserByEmail',
  'getTenantById',
  'getTenantClinics',
  'getEnabledModules',
  'getPlatformAdminByEmail',
  'touchUserLogin',
  'getPlatformSetting',
  'setPlatformSetting',
];

/** A day with one synthetic patient on it. */
function dayOd() {
  return new FakeOd({
    '/appointments': [apptRow({ AptNum: 900001, PatNum: 12827, AptDateTime: DATE + ' 08:00:00' })],
    '/operatories': [operatoryRow()],
    '/appointmenttypes': [{ AppointmentTypeNum: 3, AppointmentTypeName: 'Prophy Adult' }],
    '/providers': [{ ProvNum: 7, Abbr: 'HYG1' }],
    '/patients/12827': patientRow({ PatNum: 12827 }),
  });
}

/**
 * Boot the REAL platform console and the REAL hygiene day route over one app,
 * against an in-memory control plane.
 *
 * `superAdmin` and `role` are separate on purpose: the OFF-is-instant walk needs
 * one identity that can both flip the switch (platform tier) and read a day
 * (`hyg.read`), while the authorisation tests need identities that hold only one
 * of those.
 *
 * @param {{ superAdmin?: boolean, role?: string, modules?: string[], od?: object,
 *           setting?: unknown, hasSettingRow?: boolean }} [opts]
 */
async function bootBoth({
  superAdmin = true,
  role = 'admin',
  modules = ['hyg'],
  od = dayOd(),
  setting = undefined,
  hasSettingRow = false,
} = {}) {
  const originals = {
    registry: Object.fromEntries(REGISTRY_KEYS.map((k) => [k, registry[k]])),
    withTenantDb: tenantDb.withTenantDb,
    getOdOffice: odOffices.getOdOffice,
    keys: {
      OPENDENTAL_CUSTOMER_KEY: process.env.OPENDENTAL_CUSTOMER_KEY,
      OPENDENTAL_CUSTOMER_KEY_VALLEY: process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY,
    },
    token: process.env.DASHBOARD_API_TOKEN,
    env: {
      HYG_OD_ENABLED_ROLAND: process.env.HYG_OD_ENABLED_ROLAND,
      HYG_OD_ENABLED_VALLEY: process.env.HYG_OD_ENABLED_VALLEY,
    },
  };

  // Placeholder customer keys so `odBlockReason` runs FOR REAL rather than
  // short-circuiting every office to OFFICE_OD_KEY_MISSING on a test box. The
  // values are never used — getOdOffice is stubbed below.
  process.env.OPENDENTAL_CUSTOMER_KEY = 'test-customer-key-roland';
  process.env.OPENDENTAL_CUSTOMER_KEY_VALLEY = 'test-customer-key-valley';
  delete process.env.HYG_OD_ENABLED_ROLAND;
  delete process.env.HYG_OD_ENABLED_VALLEY;
  odOffices.resetOdOfficeCache();
  hygPilot.resetCacheForTests();

  /** The one platform_setting row, in memory. */
  const store = new Map();
  if (hasSettingRow) {
    store.set(hygPilot.SETTING_KEY, {
      key: hygPilot.SETTING_KEY,
      value: setting,
      updated_at: new Date('2026-09-04T12:00:00Z'),
      updated_by: 'seed@carein.ai',
    });
  }
  /** Set true by a test to make the control plane unreachable. */
  const control = { down: false, writes: 0 };

  odOffices.getOdOffice = (key) =>
    Object.freeze({
      officeKey: key,
      officeName: key === 'valley' ? 'Riley Family Dental' : 'Roland Family Dental',
      commTypeDefNum: key === 'valley' ? 451 : 486,
      client: od,
    });

  registry.getUserByEmail = async () => ({
    user_id: 'U1',
    tenant_id: 'T1',
    email: 'boss@carein.ai',
    role,
    status: 'active',
  });
  registry.getTenantById = async () => ({
    tenant_id: 'T1',
    slug: 'carein',
    display_name: 'CareIN',
    status: 'active',
  });
  registry.getTenantClinics = async () => [];
  registry.getEnabledModules = async () => modules;
  registry.getPlatformAdminByEmail = async () =>
    superAdmin ? { email: 'boss@carein.ai', status: 'active', created_at: new Date() } : null;
  registry.touchUserLogin = async () => {};
  registry.getPlatformSetting = async (key) => {
    if (control.down) throw new Error('control plane unreachable');
    return store.get(key) || null;
  };
  registry.setPlatformSetting = async (key, value, updatedBy) => {
    if (control.down) throw new Error('control plane unreachable');
    control.writes += 1;
    const row = { key, value, updated_at: new Date('2026-09-04T12:00:00Z'), updated_by: updatedBy };
    store.set(key, row);
    return row;
  };

  userContext.clearCache();
  const db = new FakeAuditDb();
  tenantDb.withTenantDb = async (_req, fn) => fn(db);
  process.env.DASHBOARD_API_TOKEN = 'test-token';

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', requireDashboardAuth());
  app.use('/api', (req, _res, next) => {
    req.user = { email: 'boss@carein.ai', name: 'Boss', tenantId: 'T1' };
    req.authMethod = 'session';
    next();
  });
  app.use('/api', tenantContext());
  // Both mounts, exactly as server.js assembles them.
  app.use('/api/platform', requireSuperAdmin(), require('./platform'));
  app.use(
    '/api/hyg',
    requireModule('hyg'),
    requireReadWrite('hyg.read', 'hyg.write'),
    require('./hyg')
  );

  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        baseUrl: 'http://127.0.0.1:' + port,
        db,
        od,
        store,
        control,
        close: () =>
          new Promise((r) => {
            for (const k of REGISTRY_KEYS) registry[k] = originals.registry[k];
            tenantDb.withTenantDb = originals.withTenantDb;
            odOffices.getOdOffice = originals.getOdOffice;
            for (const [k, v] of Object.entries(originals.keys)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
            for (const [k, v] of Object.entries(originals.env)) {
              if (v === undefined) delete process.env[k];
              else process.env[k] = v;
            }
            if (originals.token === undefined) delete process.env.DASHBOARD_API_TOKEN;
            else process.env.DASHBOARD_API_TOKEN = originals.token;
            odOffices.resetOdOfficeCache();
            hygPilot.resetCacheForTests();
            server.close(r);
          }),
      });
    });
  });
}

// ═══ THE ACCEPTANCE TEST ═════════════════════════════════════════════════════

test('OFF is instant: the very next request is refused, with no restart', async () => {
  /*
   * THE test. 9am, pilot morning, a hygienist hits a problem with a patient in
   * the chair. Everything below happens in ONE process, in order, with nothing
   * between the steps — no restart, no sleep, no `resetCacheForTests()`.
   *
   * If a future change makes this need any of those, do not add them. The
   * switch would have stopped being a kill switch and become a deployment
   * again, which is the exact problem this slice was written to remove.
   */
  const app = await bootBoth();
  try {
    // 1. Turn roland ON via the console path.
    const on = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.equal(on.body.offices.find((o) => o.officeKey === 'roland').enabled, true);

    // 2. The day loads.
    const served = await api(app.baseUrl, 'GET', DAY);
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.equal(served.body.appointments.length, 1);

    // 3. Turn roland OFF via the console path.
    const off = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.offices.find((o) => o.officeKey === 'roland').enabled, false);

    // 4. The SAME request is now refused — honestly, and not as an empty day.
    const refused = await api(app.baseUrl, 'GET', DAY);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.success, false);
    assert.equal(refused.body.code, 'OFFICE_NOT_READY');
    assert.equal(refused.body.reason, 'OFFICE_HYG_NOT_ENABLED');
    assert.equal(refused.body.appointments, undefined, 'a refusal must never look like an empty day');
  } finally {
    await app.close();
  }
});

test('both directions of the flip are audited, with the actor and what it replaced', async () => {
  const app = await bootBoth();
  try {
    await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: false } });

    const rows = app.db.audit.filter((r) => r.resource_id === hygPilot.SETTING_KEY);
    assert.equal(rows.length, 2, 'turning OFF is as auditable as turning ON');
    for (const row of rows) {
      assert.equal(row.action, 'UPDATE');
      assert.equal(row.resource_type, 'platform_setting');
      assert.equal(row.result, 'SUCCESS');
      assert.equal(row.user_id, 'boss@carein.ai');
      assert.equal(row.office, 'roland', 'which LOCATION moved');
    }
    // What it moved FROM. "Turned off at 09:14" and "was already off" are
    // different facts, and only one of them explains an incident.
    assert.equal(rows[0].prior_state, 'off');
    assert.equal(rows[1].prior_state, 'on');
  } finally {
    await app.close();
  }
});

// ═══ Authorisation ═══════════════════════════════════════════════════════════

test('a tenant admin who is not a platform admin can neither read nor write the switch', async () => {
  // `admin` holds admin.all and reaches every other admin surface in the
  // product. The platform tier is a different boundary and must still refuse.
  const app = await bootBoth({ superAdmin: false, role: 'admin' });
  try {
    const read = await api(app.baseUrl, 'GET', SWITCH);
    assert.equal(read.status, 403);
    assert.equal(read.body.code, 'FORBIDDEN');

    const write = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    assert.equal(write.status, 403);
    assert.equal(write.body.code, 'FORBIDDEN');

    assert.equal(app.control.writes, 0, 'a refused write must not have reached the control plane');
  } finally {
    await app.close();
  }
});

test('a hygienist cannot turn their own office on', async () => {
  const app = await bootBoth({ superAdmin: false, role: 'hygiene' });
  try {
    const write = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    assert.equal(write.status, 403);
    assert.equal(app.control.writes, 0);
  } finally {
    await app.close();
  }
});

// ═══ The write path ══════════════════════════════════════════════════════════

test('the switch reports what the DATABASE holds, not what the request sent', async () => {
  const app = await bootBoth();
  try {
    const res = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    assert.equal(res.status, 200);

    // The response is composed from a re-read, so it can only say "on" if the
    // row actually says so. A write that succeeded and a write we merely
    // believe succeeded must not look the same.
    assert.deepEqual(app.store.get(hygPilot.SETTING_KEY).value, { roland: true });
    assert.equal(res.body.setting.hasRow, true);
    assert.equal(res.body.setting.updatedBy, 'boss@carein.ai');
    assert.equal(res.body.offices.find((o) => o.officeKey === 'roland').source, 'db');
  } finally {
    await app.close();
  }
});

test('flipping one office does not disturb the other', async () => {
  // The single-row storage is a read-modify-write, so this is the property that
  // would break first if it ever adopted its own cache instead of the database.
  const app = await bootBoth();
  try {
    await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    await api(app.baseUrl, 'PUT', SWITCH + '/valley', { body: { enabled: true } });
    const res = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: false } });

    assert.deepEqual(app.store.get(hygPilot.SETTING_KEY).value, { roland: false, valley: true });
    const byKey = Object.fromEntries(res.body.offices.map((o) => [o.officeKey, o.enabled]));
    assert.deepEqual(byKey, { roland: false, valley: true });
  } finally {
    await app.close();
  }
});

test('an unknown office is a 404 and writes nothing', async () => {
  const app = await bootBoth();
  try {
    const res = await api(app.baseUrl, 'PUT', SWITCH + '/springfield', { body: { enabled: true } });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'INVALID_OFFICE');
    assert.equal(app.control.writes, 0);
  } finally {
    await app.close();
  }
});

test('a non-boolean is refused before anything is stored', async () => {
  const app = await bootBoth();
  try {
    for (const enabled of ['true', 1, null, undefined]) {
      const res = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled } });
      assert.equal(res.status, 400, JSON.stringify(enabled));
      assert.equal(res.body.code, 'INVALID_HYG_ENABLED');
    }
    assert.equal(app.control.writes, 0);
  } finally {
    await app.close();
  }
});

// ═══ Honest reporting ════════════════════════════════════════════════════════

test('the panel says WHICH LAYER answered, and names what still blocks an office', async () => {
  const app = await bootBoth();
  try {
    const before = await api(app.baseUrl, 'GET', SWITCH);
    assert.equal(before.status, 200);
    const roland = before.body.offices.find((o) => o.officeKey === 'roland');
    // Nobody has chosen, and no env override — so the hardcoded floor answers.
    assert.equal(roland.source, 'default');
    assert.equal(roland.enabled, false);
    assert.equal(roland.db, null);
    assert.equal(before.body.setting.hasRow, false);
    assert.equal(before.body.setting.policyKnown, true);

    await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    const after = await api(app.baseUrl, 'GET', SWITCH);
    const on = after.body.offices.find((o) => o.officeKey === 'roland');
    assert.equal(on.source, 'db');
    assert.equal(on.db, true);
    // Switched ON and genuinely reachable — nothing on the voice path refuses it.
    assert.equal(on.ready, true);
    assert.equal(on.blockedBy, null);
  } finally {
    await app.close();
  }
});

test('a control plane that cannot be read is REPORTED, not presented as policy', async () => {
  const app = await bootBoth();
  try {
    app.control.down = true;
    const res = await api(app.baseUrl, 'GET', SWITCH);
    assert.equal(res.status, 200, 'the panel is still useful when the control plane is down');
    assert.match(String(res.body.controlPlaneError), /unreachable/);
    // Never read successfully since this boot ⇒ every office OFF. We do not
    // assume the last thing we saw, because we have seen nothing.
    assert.equal(res.body.setting.policyKnown, false);
    for (const office of res.body.offices) assert.equal(office.enabled, false);
  } finally {
    await app.close();
  }
});

test('a failed write is a refusal, not a switch that half-moved', async () => {
  const app = await bootBoth();
  try {
    await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    app.control.down = true;

    const res = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: false } });
    assert.equal(res.status, 500);
    assert.equal(res.body.success, false);

    // And the day is still served, because the stored value we DID read has not
    // changed. A control-plane blip must not switch a practice off mid-morning.
    app.control.down = false;
    const served = await api(app.baseUrl, 'GET', DAY);
    assert.equal(served.status, 200);
  } finally {
    await app.close();
  }
});

// ═══ The stored row's own vocabulary ═════════════════════════════════════════

test('a row that exists answers for EVERY office — absent means off, not inherit', async () => {
  const app = await bootBoth({ hasSettingRow: true, setting: { roland: true } });
  try {
    const res = await api(app.baseUrl, 'GET', SWITCH);
    const byKey = Object.fromEntries(res.body.offices.map((o) => [o.officeKey, o]));
    assert.equal(byKey.roland.enabled, true);
    // valley is not named in the row at all. That is FALSE, and its source is
    // still 'db' — the row answered, and its answer for valley was silence.
    assert.equal(byKey.valley.enabled, false);
    assert.equal(byKey.valley.source, 'db');
    assert.equal(byKey.valley.db, false);
    // ...and `inRow` is what lets the console tell "nobody named this office"
    // apart from "somebody set it to false". Same value, different sentence,
    // and only one of them has a person's name in it.
    assert.equal(byKey.valley.inRow, false);
    assert.equal(byKey.roland.inRow, true);
  } finally {
    await app.close();
  }
});

test('an unknown office key in the row is ignored and does not poison the rest', async () => {
  const app = await bootBoth({
    hasSettingRow: true,
    setting: { roland: true, springfield: true, valley: 'yes' },
  });
  try {
    const res = await api(app.baseUrl, 'GET', SWITCH);
    assert.equal(res.status, 200);
    const byKey = Object.fromEntries(res.body.offices.map((o) => [o.officeKey, o]));
    // One bad entry must never be able to make the whole switch unreadable and
    // take a live pilot office down with it.
    assert.equal(byKey.roland.enabled, true);
    // A non-boolean is treated as ABSENT, which means off.
    assert.equal(byKey.valley.enabled, false);
    assert.deepEqual(res.body.offices.map((o) => o.officeKey), ['roland', 'valley']);
  } finally {
    await app.close();
  }
});

test('a row that is not an object at all falls back rather than erroring', async () => {
  const app = await bootBoth({ hasSettingRow: true, setting: 'on' });
  try {
    const res = await api(app.baseUrl, 'GET', SWITCH);
    assert.equal(res.status, 200);
    // Unusable ⇒ treated exactly like an absent row: the environment, then the
    // floor. Falling back is defined behaviour; guessing is not.
    for (const office of res.body.offices) {
      assert.equal(office.enabled, false);
      assert.equal(office.source, 'default');
      assert.equal(office.db, null);
    }
  } finally {
    await app.close();
  }
});

test('a write on top of an unusable row replaces it rather than merging into junk', async () => {
  const app = await bootBoth({ hasSettingRow: true, setting: 'on' });
  try {
    const res = await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    assert.equal(res.status, 200);
    assert.deepEqual(app.store.get(hygPilot.SETTING_KEY).value, { roland: true });
  } finally {
    await app.close();
  }
});

test('an unrecognised office key already in the row is PRESERVED by a write', async () => {
  // This module ignores a key it does not recognise. That is not the same as
  // being entitled to delete somebody's data — an office added later must not
  // find its setting silently dropped by an unrelated flip.
  const app = await bootBoth({ hasSettingRow: true, setting: { springfield: true } });
  try {
    await api(app.baseUrl, 'PUT', SWITCH + '/roland', { body: { enabled: true } });
    assert.deepEqual(app.store.get(hygPilot.SETTING_KEY).value, {
      springfield: true,
      roland: true,
    });
  } finally {
    await app.close();
  }
});
