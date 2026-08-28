'use strict';

/**
 * /api/rcm/office-settings — the toggle, and who may touch it.
 *
 * Booted through the assembled mount, like every other RCM route suite: the
 * claim worth testing is that `rcm.settings` really is narrower than the
 * `rcm.write` the mount already demands, and a test that called the handler
 * directly would pass with the narrowing gate deleted.
 */

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FakeRcmDb,
  bootRcmApp,
  api,
  auditRows,
  seedOfficeSettings,
} = require('./rcmTestUtils');

/** The crosswalk row every attributed write in this module needs. */
function seedActor(db) {
  db.seed('rcm_user_map', [
    {
      user_key: 'user-1',
      platform_email: 'billing@carein.ai',
      display_name: 'Billing User',
      active: true,
    },
  ]);
  return db;
}

const get = (app, office = 'roland', query = `?office=${office}`) =>
  api(app.baseUrl, 'GET', `/api/rcm/office-settings/${office}${query}`);

const put = (app, body, office = 'roland', query = `?office=${office}`) =>
  api(app.baseUrl, 'PUT', `/api/rcm/office-settings/${office}${query}`, {
    body: JSON.stringify(body),
    json: true,
  });

// ─── Reading ────────────────────────────────────────────────────────────────

test('GET: an admin sees the switch, the ceiling, and no change evidence yet', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await get(app);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.settings, {
      office: 'roland',
      drainEnabled: false,
      updatedAt: null,
      updatedBy: null,
      // The CODE ceiling, reported beside the switch: an admin switching an
      // office on wants to know at once if the other condition is still false,
      // or the toggle reads as broken.
      postingEnabled: true,
      rowMissing: false,
    });
  } finally {
    await app.close();
  }
});

test('GET: valley reports the ceiling still shut, whatever the switch says', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb(), { valley: true }));
  const app = await bootRcmApp({ db });
  try {
    const res = await get(app, 'valley');
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.drainEnabled, true, 'the switch is on…');
    assert.equal(res.body.settings.postingEnabled, false, '…and valley still cannot post (D-7)');
  } finally {
    await app.close();
  }
});

test('GET: a missing row reads OFF and says which problem it is', async () => {
  const db = seedActor(new FakeRcmDb());
  const app = await bootRcmApp({ db });
  try {
    const res = await get(app);
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.drainEnabled, false);
    assert.equal(res.body.settings.rowMissing, true, 'so the screen can name the migration');
  } finally {
    await app.close();
  }
});

test('GET writes NO audit row — an office key and a boolean are not PHI', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    await get(app);
    assert.deepEqual(
      auditRows(db).filter((r) => r.resource_type === 'rcm_office_settings'),
      [],
      'hard rule 5 audits PHI reads; filling the trail with config reads hides them'
    );
  } finally {
    await app.close();
  }
});

// ─── Writing ────────────────────────────────────────────────────────────────

test('PUT: an admin flips it on, and the row records who and when', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await put(app, { drainEnabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.drainEnabled, true);
    assert.equal(res.body.settings.updatedBy, 'user-1', 'the D-5 crosswalk key, not an email');
    assert.equal(typeof res.body.settings.updatedAt, 'string');

    const row = db.table('rcm_office_settings').find((r) => r.office_id === 'roland');
    assert.equal(row.drain_enabled, true);
    assert.equal(row.drain_updated_by, 'user-1');
    assert.ok(row.drain_updated_at != null, 'the SWITCH has its own instant…');
    assert.ok(row.updated_at != null, "…and the row's own mtime moved too");
    assert.equal(
      db.table('rcm_office_settings').find((r) => r.office_id === 'valley').drain_enabled,
      false,
      'and the other practice was not touched'
    );
  } finally {
    await app.close();
  }
});

test('PUT: the flip is audited as an UPDATE of rcm_office_settings', async () => {
  /*
   * One row per flip, and that append-only sequence IS the history of every
   * time posting was switched on or off. The before and after live in the
   * settings row itself (`updated_by` / `updated_at` and the boolean), which is
   * why `audit_log` gains no columns for this.
   */
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    await put(app, { drainEnabled: true });
    const rows = auditRows(db).filter((r) => r.resource_type === 'rcm_office_settings');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'UPDATE');
    assert.equal(rows[0].resource_id, 'roland');
    assert.equal(rows[0].result, 'SUCCESS');
    assert.equal(rows[0].office, 'roland');

    await put(app, { drainEnabled: false });
    const after = auditRows(db).filter((r) => r.resource_type === 'rcm_office_settings');
    assert.equal(after.length, 2, 'switching it back off is its own recorded decision');
  } finally {
    await app.close();
  }
});

test('PUT: a non-boolean is a 400, never a coercion', async () => {
  /*
   * `"false"` is a truthy string. A switch that turned posting ON because
   * somebody sent the word "false" would be the worst possible way to learn
   * that JavaScript coerces.
   */
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    for (const value of ['false', 'true', 1, 0, null, undefined]) {
      const res = await put(app, { drainEnabled: value });
      assert.equal(res.status, 400, `${JSON.stringify(value)} must be refused`);
      assert.equal(res.body.code, 'INVALID_SETTING');
    }
    assert.equal(
      db.table('rcm_office_settings').find((r) => r.office_id === 'roland').drain_enabled,
      false,
      'and nothing moved'
    );
  } finally {
    await app.close();
  }
});

test('PUT: a missing row is a 409 that names the fix, never an insert', async () => {
  /*
   * The office set is a migration everywhere else in this schema. A route that
   * upserted here would quietly create a settings row for whatever office key
   * reached it, and would answer a database whose migrations had not run by
   * writing one rather than by saying so.
   */
  const db = seedActor(new FakeRcmDb());
  const app = await bootRcmApp({ db });
  try {
    const res = await put(app, { drainEnabled: true });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'OFFICE_SETTINGS_MISSING');
    assert.match(res.body.error, /run migrations/i);
    assert.deepEqual(db.table('rcm_office_settings'), [], 'no row was conjured');
    assert.ok(
      !db.log.some((e) => /INSERT INTO rcm_office_settings/i.test(e.sql)),
      'and no INSERT was even attempted'
    );
  } finally {
    await app.close();
  }
});

// ─── Office assertions — refuse-only, never a redirect ──────────────────────

test('a path office that disagrees with the query is OFFICE_MISMATCH, and changes nothing', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await api(app.baseUrl, 'PUT', '/api/rcm/office-settings/valley?office=roland', {
      body: JSON.stringify({ drainEnabled: true }),
      json: true,
    });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'OFFICE_MISMATCH');
    for (const row of db.table('rcm_office_settings')) {
      assert.equal(row.drain_enabled, false, `${row.office_id} must be untouched`);
    }
  } finally {
    await app.close();
  }
});

test('a body office that disagrees is OFFICE_MISMATCH too — a body can only refuse', async () => {
  // Same property `send-to-TC` has: there is nothing a request body can say that
  // changes WHICH practice is written to. It can only cause a refusal.
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await put(app, { drainEnabled: true, office: 'valley' });
    assert.equal(res.status, 409);
    assert.equal(res.body.code, 'OFFICE_MISMATCH');
    assert.equal(
      db.table('rcm_office_settings').find((r) => r.office_id === 'roland').drain_enabled,
      false
    );
  } finally {
    await app.close();
  }
});

test('a body office that AGREES is simply accepted', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await put(app, { drainEnabled: true, office: 'roland' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.drainEnabled, true);
  } finally {
    await app.close();
  }
});

test('a path segment that is not an office at all is a 400', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/office-settings/nowhere?office=roland');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_OFFICE');
  } finally {
    await app.close();
  }
});

test('the router-wide office param is still required', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db });
  try {
    const res = await api(app.baseUrl, 'GET', '/api/rcm/office-settings/roland');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_OFFICE');
  } finally {
    await app.close();
  }
});

// ─── Permission: admin, and nobody else ─────────────────────────────────────

test('only an admin may read or flip the switch', async () => {
  /*
   * `rcm.settings` is deliberately narrower than `rcm.post`. An `office` user
   * runs the day — they press Drain; an `admin` decides whether pressing it may
   * reach a chart at all.
   *
   * `office` and `rcm_biller` are refused by the route's own gate (they clear
   * the mount's `rcm.write`); `reviewer` and `tc` are refused one tier earlier,
   * by the mount. Both are 403s, and the ladder is the point.
   */
  for (const role of ['office', 'rcm_biller', 'reviewer', 'tc']) {
    const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
    const app = await bootRcmApp({ db, role });
    try {
      const read = await get(app);
      assert.equal(read.status, 403, `${role} must not read the switch`);

      const write = await put(app, { drainEnabled: true });
      assert.equal(write.status, 403, `${role} must not flip the switch`);
      assert.equal(
        db.table('rcm_office_settings').find((r) => r.office_id === 'roland').drain_enabled,
        false,
        `${role} changed nothing`
      );
    } finally {
      await app.close();
    }
  }
});

test('office and rcm_biller are refused by the route, naming rcm.settings', async () => {
  // The narrowing gate, visible: these two hold `rcm.write`, so the mount lets
  // them through and the route's own tier is what stops them.
  for (const role of ['office', 'rcm_biller']) {
    const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
    const app = await bootRcmApp({ db, role });
    try {
      const res = await put(app, { drainEnabled: true });
      assert.equal(res.status, 403);
      assert.equal(res.body.action, 'rcm.settings', role);
    } finally {
      await app.close();
    }
  }
});

test('a super_admin may flip it — the platform tier passes every check', async () => {
  const db = seedActor(seedOfficeSettings(new FakeRcmDb()));
  const app = await bootRcmApp({ db, role: 'reviewer', superAdmin: true });
  try {
    const res = await put(app, { drainEnabled: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.settings.drainEnabled, true);
  } finally {
    await app.close();
  }
});
