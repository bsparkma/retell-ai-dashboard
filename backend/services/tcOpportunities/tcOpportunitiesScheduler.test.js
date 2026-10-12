'use strict';

/**
 * The scheduler ships DARK: every gate is read at run time and fails closed.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const realConfig = require('../../config/tcOpportunities');
const { TcOpportunitiesScheduler } = require('./scheduler');
const { fakeOdOffices } = require('./tcOppsTestUtils');

function makeScheduler({ setting, tenants, modules, offices = { roland: {} }, getSettingThrows = false } = {}) {
  const ran = [];
  const s = new TcOpportunitiesScheduler({
    registry: {
      getPlatformSetting: async () => {
        if (getSettingThrows) throw new Error('control db down');
        return setting === undefined ? null : { value: setting };
      },
      listTenants: async () => tenants || [{ tenant_id: 'T1', slug: 'carein', status: 'active' }],
      getEnabledModules: async (id) => (modules ? modules[id] || [] : ['tc']),
    },
    tenantDb: { getTenantPool: async () => ({ query: async () => ({ rows: [] }) }) },
    odOffices: fakeOdOffices(offices),
    syncOffice: async (d) => {
      ran.push(d.office);
      return { office: d.office, status: 'ok', pages: 0, proceduresScanned: 0, patients: 0, inserted: 0, refreshed: 0, cleared: 0, resurrected: 0, nameReads: 0, namesPending: 0, odRequests: 0, durationMs: 0, error: null };
    },
  });
  return { s, ran };
}

test('no platform_setting row → nothing runs (the shipped state)', async () => {
  const { s, ran } = makeScheduler();
  const r = await s.runNow();
  assert.equal(r.skipped, 'NO_SETTING_ROW');
  assert.deepEqual(ran, []);
});

test('only offices mapped to literal true run; junk and absent offices are off', async () => {
  const { s, ran } = makeScheduler({ setting: { roland: true, valley: 'yes', atlantis: true }, offices: { roland: {}, valley: {} } });
  await s.runNow();
  assert.deepEqual(ran, ['roland']);
});

test('control plane unreadable → off', async () => {
  const { s, ran } = makeScheduler({ getSettingThrows: true, setting: { roland: true } });
  const r = await s.runNow();
  assert.match(r.skipped, /^CONTROL_PLANE_UNREADABLE/);
  assert.deepEqual(ran, []);
});

test('TC_OPPS_SYNC_DISABLED=true kills it whatever the row says', async () => {
  process.env.TC_OPPS_SYNC_DISABLED = 'true';
  try {
    const { s, ran } = makeScheduler({ setting: { roland: true } });
    const r = await s.runNow();
    assert.equal(r.skipped, 'KILLED_BY_ENV');
    assert.deepEqual(ran, []);
    assert.equal(s.start(), false, 'not even armed');
  } finally {
    delete process.env.TC_OPPS_SYNC_DISABLED;
  }
});

test('no entitled tenant → skipped; TWO entitled tenants → refused (office handles are process-wide)', async () => {
  let { s, ran } = makeScheduler({ setting: { roland: true }, modules: { T1: ['voice'] } });
  assert.equal((await s.runNow()).skipped, 'NO_TC_TENANT');
  ({ s, ran } = makeScheduler({
    setting: { roland: true },
    tenants: [
      { tenant_id: 'T1', slug: 'a', status: 'active' },
      { tenant_id: 'T2', slug: 'b', status: 'active' },
    ],
  }));
  assert.equal((await s.runNow()).skipped, 'AMBIGUOUS_TC_TENANT');
  assert.deepEqual(ran, []);
});

test('a switched-on office that is not OD-ready is reported, not read', async () => {
  const { s, ran } = makeScheduler({ setting: { roland: true, valley: true }, offices: { roland: {} } });
  const r = await s.runNow();
  assert.deepEqual(ran, ['roland']);
  assert.ok(r.offices.some((o) => o.office === 'valley' && o.error === 'OFFICE_NOT_OD_READY'));
});

test('re-entrancy: a second pass while one runs is skipped', async () => {
  const { s } = makeScheduler({ setting: { roland: true } });
  s.running = true;
  assert.equal((await s.runNow()).skipped, 'ALREADY_RUNNING');
});

test('start() arms the default 02:30 cron in the practice zone and never runs a pass at boot', () => {
  const { s, ran } = makeScheduler({ setting: { roland: true } });
  const armed = [];
  s.createJob = (schedule, tz) => {
    armed.push([schedule, tz]);
    return { stop() {} };
  };
  assert.equal(s.start(), true);
  assert.deepEqual(armed, [[realConfig.DEFAULT_SCHEDULE, 'America/Chicago']]);
  assert.equal(realConfig.DEFAULT_SCHEDULE, '30 2 * * *');
  assert.deepEqual(ran, []);
  s.stop();
});
